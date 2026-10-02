package com.pocketpal

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.IBinder
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.module.annotations.ReactModule
import com.pocketpal.specs.NativeTwinCorePerfSpec
// 注意：本文件 package 是 com.pocketpal，而 AIDL 生成类在 com.pocketpalai 包下，
// 不显式 import 会直接 Unresolved reference（CI 上就是这种错误最耗时）。
import com.pocketpalai.ITwinCoreShell
import com.pocketpalai.TwinCoreShellService
import org.json.JSONObject
import rikka.shizuku.Shizuku
import java.io.File
import java.io.InputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

private const val TAG = "TwinCorePerf"
private const val CPU_BASE = "/sys/devices/system/cpu/"

/** UserService 绑定等待上限。冷启动时 Shizuku 拉起子进程通常 <1s。 */
private const val USER_SERVICE_TIMEOUT_MS = 8_000L

/**
 * TwinCore 三档性能模式 + Shizuku 状态面板。
 *
 * 权限来源优先级：Shizuku（ADB / Root 起的 Binder 代理） → 直接 su（Root 兜底）。
 * 两条路都拿不到时，只返回状态、不改任何东西，绝不假装成功。
 *
 * 两条硬规则：
 *  1. **写完必须读回校验**。高通机型上 `echo x > /sys/.../scaling_min_freq` 即使被
 *     SELinux / 权限拦掉，shell 也往往不报错（重定向失败在部分 shell 实现里是静默的），
 *     只看出退出码会给出假的「已生效」。每个写入项单独判定，成功项进 `applied`，
 *     失败项进 `failures`，单项失败绝不中断整个档位切换。
 *  2. **本模块只调用 Shizuku 客户端 API，不修改 Shizuku 本身**。调频是系统级的
 *     （整机生效，不是「只对 TwinCore 生效」），也不会影响其他已授权应用。
 */
@ReactModule(name = NativeTwinCorePerfSpec.NAME)
class TwinCorePerfModule(reactContext: ReactApplicationContext) :
    NativeTwinCorePerfSpec(reactContext) {

  // ---------------------------------------------------------------------------
  // 数据模型
  // ---------------------------------------------------------------------------

  /** 一个 cpufreq 调度域（policy）。K20 上就是 cpu0(0-5) 与 cpu6(6-7) 两个。 */
  private data class CpuPolicy(
      val leader: Int,
      val related: List<Int>,
      val cpuinfoMin: Int,
      val cpuinfoMax: Int,
      val availableFreqs: List<Int>,
      val availableGovernors: List<String>,
      val governor: String,
      val scalingMin: Int,
      val scalingMax: Int,
  ) {
    val base: String get() = CPU_BASE + "cpu" + leader + "/cpufreq"
  }

  /** 一次写入操作，同时用于「生成命令」和「读回校验」。 */
  private data class WriteOp(val path: String, val value: String)

  private data class ShellResult(
      val exitCode: Int,
      val stdout: String,
      val stderr: String,
      val transport: String,
      val error: String?,
  )

  /**
   * 一次授权流程的结论。
   *
   * status 取值（与 RN 侧 Spec 里的 TwinCoreShizukuAuthStatus 一一对应）：
   *  - `granted`         已授权
   *  - `denied`          用户本次拒绝
   *  - `timeout`         120 秒内未收到授权结果
   *  - `rejected_manual` shouldShowRequestPermissionRationale()==true，
   *                      用户此前拒绝过、Shizuku 不再弹窗，需要去 Manager 手动勾选
   *  - `binder_dead`     Shizuku 服务未运行（pingBinder()==false）
   *  - `not_granted`     只读检测（getShizukuStatus）专用：在运行但未授权
   */
  private data class AuthResult(val status: String, val granted: Boolean)

  // ---------------------------------------------------------------------------
  // 常量
  // ---------------------------------------------------------------------------

  companion object {

    private const val PREFS = "twincore_perf"
    private const val KEY_BACKUP = "backup_json"
    private const val KEY_MODE = "last_mode"

    /** 授权等待窗口。用户在 Shizuku Manager 里点「允许」的时间，给足 2 分钟。 */
    private const val PERMISSION_TIMEOUT_MS = 120_000L

    /** 省电档把频率上限压到最高频的这个比例。 */
    private const val POWERSAVE_BIG_RATIO = 0.70f
    private const val POWERSAVE_SMALL_RATIO = 0.60f

    /** 性能档把小核的下限抬到最高频的这个比例（大核直接锁顶）。 */
    private const val PERF_SMALL_MIN_RATIO = 0.60f

    /** 单项写入读回不通过时的补写次数与间隔（MIUI perfd 偶尔会瞬时覆写）。 */
    private const val RETRY_COUNT = 3
    private const val RETRY_INTERVAL_MS = 120L

    /** Shizuku 相关包名。老版本 Manager 与现行 Shizuku app 的包名不同，两个都探测。 */
    private const val SERVICE_PACKAGE = "moe.shizuku.privileged.api"
    private const val MANAGER_PACKAGE = "moe.shizuku.manager"
    private val SHIZUKU_PACKAGES = listOf(SERVICE_PACKAGE, MANAGER_PACKAGE)

    /** governor 的偏好顺序，取机器上真正可用的第一个。 */
    private val GOV_PREF_PERF = listOf("performance", "schedutil")
    private val GOV_PREF_SAVE = listOf("conservative", "schedutil", "powersave", "ondemand")
    private val GOV_PREF_BALANCED = listOf("schedutil", "interactive", "ondemand")

    private fun normalize(mode: String?): String {
      val m = (mode ?: "").trim().lowercase()
      return when {
        m.startsWith("power") && m.contains("save") -> "powersave"
        m.startsWith("perf") -> "performance"
        m.startsWith("bal") -> "balanced"
        m == "省电" -> "powersave"
        m == "性能" -> "performance"
        m == "均衡" -> "balanced"
        else -> "balanced"
      }
    }
  }

  private val executor = Executors.newSingleThreadExecutor { r ->
    Thread(r, "twincore-perf").apply { isDaemon = true }
  }

  override fun invalidate() {
    super.invalidate()
    executor.shutdown()
  }

  private val prefs by lazy {
    reactApplicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
  }

  // ---------------------------------------------------------------------------
  // TurboModule 方法：Shizuku 状态与授权
  // ---------------------------------------------------------------------------

  /**
   * 只读检测，不弹任何窗。状态面板的「重新检测」按钮就是它。
   * status 只会是 granted / not_granted / binder_dead 三种 —— denied/timeout/
   * rejected_manual 只在一次完整的授权流程里有意义，这里不猜。
   */
  override fun getShizukuStatus(promise: Promise) {
    executor.execute {
      try {
        val alive = binderAliveSafe()
        val granted = alive && hasPermissionSafe()
        val status =
            when {
              granted -> "granted"
              !alive -> "binder_dead"
              else -> "not_granted"
            }
        promise.resolve(shizukuStatusMap(status, granted, alive, ""))
      } catch (t: Throwable) {
        Log.e(TAG, "getShizukuStatus failed", t)
        promise.resolve(
            shizukuStatusMap("binder_dead", false, false, "状态检测异常：${t.message}"),
        )
      }
    }
  }

  /**
   * 完整授权流程。按「granted / denied / timeout / rejected_manual / binder_dead」
   * 五种终态返回，绝不永久挂起 Promise。
   */
  override fun requestShizukuPermission(promise: Promise) {
    executor.execute {
      try {
        val alive = binderAliveSafe()
        if (!alive) {
          promise.resolve(
              shizukuStatusMap(
                  "binder_dead",
                  false,
                  false,
                  "Shizuku 服务未运行。请通过无线调试（或 Root）重新激活 Shizuku。",
              ),
          )
          return@execute
        }
        val outcome = ensurePermission()
        val message =
            when (outcome.status) {
              "granted" -> "已获得 Shizuku 授权，可以调节 CPU 频率。"
              "denied" -> "本次授权被拒绝，可以再点一次「请求授权」重试。"
              "timeout" -> "等待授权超时（120 秒）。请留意 Shizuku Manager 的弹窗后重试。"
              "rejected_manual" ->
                  "此前拒绝过授权，Shizuku 不再弹窗。请打开 Shizuku Manager 手动勾选 TwinCore。"
              else -> "Shizuku 服务未运行。"
            }
        promise.resolve(shizukuStatusMap(outcome.status, outcome.granted, true, message))
      } catch (t: Throwable) {
        Log.e(TAG, "requestShizukuPermission failed", t)
        promise.resolve(shizukuStatusMap("binder_dead", false, false, "授权流程异常：${t.message}"))
      }
    }
  }

  /** 拉起 Shizuku Manager（或 Shizuku app），给 rejected_manual 场景手动勾选用。返回实际拉起的包名，空串=失败。 */
  override fun openShizukuManager(promise: Promise) {
    for (pkg in SHIZUKU_PACKAGES) {
      try {
        val intent = reactApplicationContext.packageManager.getLaunchIntentForPackage(pkg) ?: continue
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        reactApplicationContext.startActivity(intent)
        promise.resolve(pkg)
        return
      } catch (t: Throwable) {
        Log.w(TAG, "无法拉起 $pkg：${t.message}")
      }
    }
    promise.resolve("")
  }

  // ---------------------------------------------------------------------------
  // TurboModule 方法：三档调频
  // ---------------------------------------------------------------------------

  override fun setPerformanceMode(mode: String, promise: Promise) {
    executor.execute {
      val target = normalize(mode)
      try {
        // 无论如何先把原始值备份下来（只在第一次备份，避免把上一档的值当成「原始」）。
        val policies = scanPolicies()
        if (policies.isEmpty()) {
          promise.resolve(
              emptyReport(target, "读不到 /sys/devices/system/cpu/*/cpufreq，无法调频。"),
          )
          return@execute
        }
        backupIfNeeded(policies)

        val alive = binderAliveSafe()
        val granted = alive && hasPermissionSafe()
        if (!granted) {
          promise.resolve(
              report(
                  mode = target,
                  appliedItems = emptyList(),
                  binderAlive = alive,
                  granted = granted,
                  policies = policies,
                  commands = emptyList(),
                  failures = listOf("没有 Shizuku 授权（也没有可用的 su），未修改任何系统设置。"),
                  message = "未授权：请先在 Shizuku 状态卡片里完成授权。",
              ),
          )
          return@execute
        }

        val (commands, targets) = buildPlan(target, policies)
        val result = runPrivilegedShell(commands)
        val failures = mutableListOf<String>()
        val appliedItems = mutableListOf<String>()
        // 底层原因累积：把 shell stderr 与逐项 errno 都攒下来，随 report 透出。
        val rawErrors = mutableListOf<String>()
        if (result.error != null) {
          failures.add("shell 执行失败（${result.transport}）：${result.error}")
        }
        if (result.stderr.isNotBlank()) {
          rawErrors.add("stderr: ${result.stderr.trim().take(600)}")
        }

        // 逐项读回校验 + 失败重试。单项彻底失败也不中断整体
        // —— MIUI perfd 经常只覆写其中几项。
        for (op in targets) {
          val label = opLabel(op.path)
          var actual = readText(op.path)
          var attempts = 0
          // 首次已由批量脚本写过；这里最多再补写 RETRY_COUNT 次。
          while (actual != op.value && attempts < RETRY_COUNT) {
            if (attempts > 0) {
              Thread.sleep(RETRY_INTERVAL_MS)
            }
            attempts++
            val retry = runPrivilegedShell(listOf(write(op.path, op.value)))
            if (retry.stderr.isNotBlank()) {
              rawErrors.add("$label 重试 stderr: ${retry.stderr.trim().take(300)}")
            }
            val why = parseWriteResult(retry.stdout, op.path)
            if (why != null) {
              rawErrors.add("$label 写入结果 $why")
            }
            actual = readText(op.path)
          }
          if (actual == op.value) {
            appliedItems.add(label)
          } else {
            failures.add(
                "写入未生效 $label：期望 ${op.value}，实际 ${actual.ifEmpty { "<读不到>" }}" +
                    (if (attempts > 0) "（已重试 $attempts 次）" else ""),
            )
          }
        }

        if (failures.isEmpty() && appliedItems.isNotEmpty()) {
          prefs.edit().putString(KEY_MODE, target).apply()
        }

        promise.resolve(
            report(
                mode = target,
                appliedItems = appliedItems,
                binderAlive = alive,
                granted = granted,
                policies = policies,
                commands = commands,
                failures = failures,
                rawErrors = rawErrors,
                message =
                    when {
                      failures.isEmpty() && appliedItems.isNotEmpty() ->
                          "已切换到「${labelOf(target)}」，全部写入读回校验通过。"
                      appliedItems.isEmpty() ->
                          "「${labelOf(target)}」全部写入失败（多为 SELinux 限制）。"
                      else ->
                          "「${labelOf(target)}」部分生效：${appliedItems.size} 项成功，" +
                              "${failures.size} 项未写入。"
                    },
            ),
        )
      } catch (t: Throwable) {
        Log.e(TAG, "setPerformanceMode($target) failed", t)
        promise.resolve(emptyReport(target, "调频异常：${t.message}"))
      }
    }
  }

  override fun getPerformanceMode(promise: Promise) {
    executor.execute {
      try {
        val policies = scanPolicies()
        if (policies.isEmpty()) {
          promise.resolve(emptyReport("balanced", "读不到 cpufreq 节点。"))
          return@execute
        }
        val big = biggest(policies)
        val smalls = policies.filter { it !== big }
        val failure = mutableListOf<String>()

        // 依据「大核当前的实际状态」反推档位，而不是读我们自己的记忆。
        val curGov = readText("${big.base}/scaling_governor")
        val curMin = readInt("${big.base}/scaling_min_freq")
        val curMax = readInt("${big.base}/scaling_max_freq")
        val detected =
            when {
              curMax < big.cpuinfoMax -> "powersave"
              curGov == "performance" || curMin >= big.cpuinfoMax -> "performance"
              else -> "balanced"
            }

        if (curGov.isEmpty()) failure.add("读不到 ${big.base}/scaling_governor")

        promise.resolve(
            report(
                mode = detected,
                appliedItems = emptyList(), // 本方法不改任何东西
                binderAlive = binderAliveSafe(),
                granted = hasPermissionSafe(),
                policies = policies,
                commands = emptyList(),
                failures = failure,
                message =
                    "当前大核 cpu${big.leader}：governor=$curGov，${fmtKhz(curMin)}–${fmtKhz(curMax)}" +
                        "（硬件范围 ${fmtKhz(big.cpuinfoMin)}–${fmtKhz(big.cpuinfoMax)}）；小核 ${smalls.size} 个域。",
            ),
        )
      } catch (t: Throwable) {
        Log.e(TAG, "getPerformanceMode failed", t)
        promise.resolve(emptyReport("balanced", "读取异常：${t.message}"))
      }
    }
  }

  override fun restorePerformanceMode(promise: Promise) {
    executor.execute {
      try {
        val policies = scanPolicies()
        if (policies.isEmpty()) {
          promise.resolve(emptyReport("balanced", "读不到 cpufreq 节点。"))
          return@execute
        }
        val raw = prefs.getString(KEY_BACKUP, null)
        if (raw.isNullOrEmpty()) {
          // 没有备份就退化成「均衡」：放开频率上限、回到默认 governor。
          return@execute setPerformanceMode("balanced", promise)
        }

        val alive = binderAliveSafe()
        val granted = alive && hasPermissionSafe()
        if (!granted) {
          promise.resolve(
              report(
                  mode = "balanced",
                  appliedItems = emptyList(),
                  binderAlive = alive,
                  granted = granted,
                  policies = policies,
                  commands = emptyList(),
                  failures = listOf("没有 Shizuku 授权，无法恢复。"),
                  message = "未授权，无法恢复原始调频设置。",
              ),
          )
          return@execute
        }

        val json = JSONObject(raw)
        val commands = mutableListOf<String>()
        val targets = mutableListOf<WriteOp>()
        for (p in policies) {
          val gov = json.optString("gov_${p.leader}", "")
          val min = json.optInt("min_${p.leader}", -1)
          val max = json.optInt("max_${p.leader}", -1)
          // 顺序很关键：先把 min 压到最低，再写 max，最后写回 min，
          // 否则「当前 min > 目标 max」时内核会拒绝。
          if (min > 0) {
            commands.add(writePlain("${p.base}/scaling_min_freq", p.cpuinfoMin.toString()))
          }
          if (max > 0) {
            val op = WriteOp("${p.base}/scaling_max_freq", max.toString())
            commands.add(write(op.path, op.value))
            targets.add(op)
          }
          if (gov.isNotEmpty()) {
            val op = WriteOp("${p.base}/scaling_governor", gov)
            commands.add(write(op.path, op.value))
            targets.add(op)
          }
          if (min > 0) {
            val op = WriteOp("${p.base}/scaling_min_freq", min.toString())
            commands.add(write(op.path, op.value))
            targets.add(op)
          }
        }

        val result = runPrivilegedShell(commands)
        val failures = mutableListOf<String>()
        val appliedItems = mutableListOf<String>()
        val rawErrors = mutableListOf<String>()
        if (result.error != null) failures.add("shell 执行失败：${result.error}")
        if (result.stderr.isNotBlank()) {
          rawErrors.add("stderr: ${result.stderr.trim().take(600)}")
        }
        for (op in targets) {
          val label = opLabel(op.path)
          var actual = readText(op.path)
          var attempts = 0
          while (actual != op.value && attempts < RETRY_COUNT) {
            if (attempts > 0) {
              Thread.sleep(RETRY_INTERVAL_MS)
            }
            attempts++
            val retry = runPrivilegedShell(listOf(write(op.path, op.value)))
            parseWriteResult(retry.stdout, op.path)?.let { rawErrors.add("$label 写入结果 $it") }
            actual = readText(op.path)
          }
          if (actual == op.value) {
            appliedItems.add(label)
          } else {
            failures.add(
                "恢复未生效 $label：期望 ${op.value}，实际 ${actual.ifEmpty { "<读不到>" }}" +
                    (if (attempts > 0) "（已重试 $attempts 次）" else ""),
            )
          }
        }
        if (failures.isEmpty() && appliedItems.isNotEmpty()) {
          prefs.edit().remove(KEY_BACKUP).remove(KEY_MODE).apply()
        }
        promise.resolve(
            report(
                mode = "balanced",
                appliedItems = appliedItems,
                binderAlive = alive,
                granted = granted,
                policies = policies,
                commands = commands,
                failures = failures,
                rawErrors = rawErrors,
                message =
                    if (failures.isEmpty()) "已恢复原始调频设置。"
                    else "恢复不完整：${appliedItems.size} 项成功，${failures.size} 项未写入。",
            ),
        )
      } catch (t: Throwable) {
        Log.e(TAG, "restorePerformanceMode failed", t)
        promise.resolve(emptyReport("balanced", "恢复异常：${t.message}"))
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 需求 7：智能模式 —— 杀非系统后台进程
  // ---------------------------------------------------------------------------

  /**
   * 智能模式：杀掉所有非系统后台进程，只保留 Shizuku 与本应用。
   *
   * 安全策略（无 root，走已有 Shizuku UserService）：
   *  1. 主命令用 `am kill-all` —— ActivityManager 只杀「可杀的」后台进程，
   *     系统进程、前台进程、persistent 进程由系统自动保护，绝不使用 kill -9。
   *  2. 再对第三方包（`pm list packages -3`）逐个 `am force-stop`，
   *     但白名单（本应用 / Shizuku app / Shizuku Manager）永不触碰。
   *     不用 `pm list packages -s`（系统包），从源头避免误杀系统进程。
   *  3. 整个过程 try/catch，任何异常都只回一个失败报告，绝不崩。
   */
  override fun killBackgroundProcesses(promise: Promise) {
    executor.execute {
      try {
        val alive = binderAliveSafe()
        val granted = alive && hasPermissionSafe()
        if (!granted) {
          promise.resolve(
              killReport(
                  killed = emptyList(),
                  alive = alive,
                  granted = false,
                  commands = emptyList(),
                  failures = listOf("没有 Shizuku 授权，未执行任何杀后台操作。"),
                  message = "未授权：请先在 Shizuku 状态卡片里完成授权。",
              ),
          )
          return@execute
        }

        val whitelist = mutableSetOf(
            SERVICE_PACKAGE,
            MANAGER_PACKAGE,
            reactApplicationContext.packageName,
            "com.twincore",
            "com.pocketpal",
        )
        // 白名单里放本应用自身包名（含 e2e 后缀变体）与 Shizuku 两个包。
        SHIZUKU_PACKAGES.forEach { whitelist.add(it) }

        // 先枚举第三方包，过滤白名单。命令本身不报错时 stdout 为逐行包名。
        val listRes = runPrivilegedShell(listOf("pm list packages -3"))
        val thirdParty =
            listRes.stdout
                .split("\n")
                .map { it.trim() }
                .filter { it.startsWith("package:") }
                .map { it.removePrefix("package:").trim() }
                .filter { it.isNotEmpty() && !whitelist.contains(it) }
                .distinct()

        val commands = mutableListOf<String>()
        // 1) 安全主命令：只杀后台，系统进程/前台/persistent 由系统保护。
        commands.add("am kill-all")
        // 2) 第三方包逐个 force-stop（已在白名单外，绝不碰系统包与 Shizuku）。
        //    加 `|| true`：某个包正被系统占用时 force-stop 会失败，不应中断整批。
        thirdParty.forEach { pkg -> commands.add("am force-stop $pkg || true") }

        val result = runPrivilegedShell(commands)
        val failures = mutableListOf<String>()
        if (result.error != null) {
          failures.add("shell 执行失败（${result.transport}）：${result.error}")
        }

        promise.resolve(
            killReport(
                killed = thirdParty,
                alive = alive,
                granted = true,
                commands = commands,
                failures = failures,
                message =
                    if (failures.isEmpty())
                        "已杀后台：${thirdParty.size} 个第三方应用（系统进程与 Shizuku 未触碰）。"
                    else "部分完成：${thirdParty.size} 个第三方应用，${failures.size} 条失败。",
            ),
        )
      } catch (t: Throwable) {
        Log.e(TAG, "killBackgroundProcesses failed", t)
        promise.resolve(
            killReport(
                killed = emptyList(),
                alive = binderAliveSafe(),
                granted = false,
                commands = emptyList(),
                failures = listOf("杀后台异常：${t.message}"),
                message = "杀后台异常，已中止（未执行破坏性操作）。",
            ),
        )
      }
    }
  }

  private fun killReport(
      killed: List<String>,
      alive: Boolean,
      granted: Boolean,
      commands: List<String>,
      failures: List<String>,
      message: String,
  ): WritableMap = Arguments.createMap().apply {
    putBoolean("ok", granted && failures.isEmpty())
    putBoolean("binderAlive", alive)
    putBoolean("granted", granted)
    putInt("killedCount", killed.size)
    putArray(
        "killed",
        Arguments.createArray().apply {
          killed.forEach { pushString(it) }
        },
    )
    putArray(
        "commands",
        Arguments.createArray().apply {
          commands.forEach { pushString(it) }
        },
    )
    putArray(
        "failures",
        Arguments.createArray().apply {
          failures.forEach { pushString(it) }
        },
    )
    putString("message", message)
  }

  // ---------------------------------------------------------------------------
  // 拓扑探测（只读 /sys，普通权限即可，不需要 Shizuku）
  // ---------------------------------------------------------------------------

  private fun scanPolicies(): List<CpuPolicy> {
    val cpuRoot = File(CPU_BASE)
    val dirs = (cpuRoot.listFiles() ?: emptyArray())
        .filter { it.isDirectory && it.name.matches(Regex("cpu\\d+")) }
        .sortedBy { it.name.removePrefix("cpu").toIntOrNull() ?: 0 }

    val out = ArrayList<CpuPolicy>()
    val seenLeaders = HashSet<Int>()

    for (dir in dirs) {
      val idx = dir.name.removePrefix("cpu").toIntOrNull() ?: continue
      val freqDir = File(dir, "cpufreq")
      if (!freqDir.exists()) continue // 离线核或虚拟化 CPU，跳过

      val relatedRaw = readText(File(freqDir, "related_cpus").path)
      val related = relatedRaw.split(Regex("\\s+")).mapNotNull { it.trim().toIntOrNull() }
      val list = if (related.isEmpty()) listOf(idx) else related
      val leader = list.first()
      if (!seenLeaders.add(leader)) continue // 同一个 policy 的其它成员

      val cpuinfoMin = readInt(File(freqDir, "cpuinfo_min_freq").path)
      val cpuinfoMax = readInt(File(freqDir, "cpuinfo_max_freq").path)
      val availFreqs = readText(File(freqDir, "scaling_available_frequencies").path)
          .split(Regex("\\s+")).mapNotNull { it.trim().toIntOrNull() }.sorted()
      val availGovs = readText(File(freqDir, "scaling_available_governors").path)
          .split(Regex("\\s+")).map { it.trim() }.filter { it.isNotEmpty() }

      out.add(
          CpuPolicy(
              leader = leader,
              related = list,
              cpuinfoMin = if (cpuinfoMin > 0) cpuinfoMin else (availFreqs.firstOrNull() ?: 0),
              cpuinfoMax = if (cpuinfoMax > 0) cpuinfoMax else (availFreqs.lastOrNull() ?: 0),
              availableFreqs = availFreqs,
              availableGovernors = availGovs,
              governor = readText(File(freqDir, "scaling_governor").path),
              scalingMin = readInt(File(freqDir, "scaling_min_freq").path),
              scalingMax = readInt(File(freqDir, "scaling_max_freq").path),
          ),
      )
    }
    return out
  }

  private fun biggest(policies: List<CpuPolicy>): CpuPolicy =
      policies.maxByOrNull { it.cpuinfoMax } ?: policies.first()

  // ---------------------------------------------------------------------------
  // 三档策略
  // ---------------------------------------------------------------------------

  /**
   * 生成有序命令 + 读回校验目标。
   *
   * 写入顺序（v2，按内核约束重排，这是本次修复的核心）：
   *   1) scaling_max_freq = targetMax   —— 先把上限抬到位。若先抬 min 会被内核
   *      以 EINVAL 拒绝（min > 当前 max），这是用户实测 min_freq 写不进去的主因之一。
   *   2) scaling_governor = gov         —— 切 governor。performance governor 本身
   *      会尝试把频率拉到最高，放在 max 已放宽之后才不会被 max 钳住。
   *   3) scaling_min_freq = targetMin   —— 最后锁下限（此时 max 已 >= targetMin）。
   *
   * 恢复走 restorePerformanceMode 的逆序，同样满足「任意时刻 min <= max」。
   */
  private fun buildPlan(mode: String, policies: List<CpuPolicy>): Pair<List<String>, List<WriteOp>> {
    val commands = mutableListOf<String>()
    val targets = mutableListOf<WriteOp>()
    val big = biggest(policies)

    if (mode == "performance") {
      // 尽量把所有核心拉上线（离线核写不进 cpufreq，静默失败即可）。
      for (p in policies) {
        for (cpu in p.related) {
          commands.add("echo 1 > ${CPU_BASE}cpu$cpu/online 2>/dev/null || true")
        }
      }
      // 后台进程数限制。Android 8+ 上这条基本是 no-op（hidden API 已废弃），
      // 因此不参与读回校验，失败也不算错误。
      commands.add("am set-process-limit 0 >/dev/null 2>&1 || true")
    }

    for (p in policies) {
      val isBig = p.leader == big.leader
      val govPref = when (mode) {
        "performance" -> GOV_PREF_PERF
        "powersave" -> GOV_PREF_SAVE
        else -> GOV_PREF_BALANCED
      }
      val gov = pickGovernor(p, govPref)

      val targetMax: Int
      val targetMin: Int
      when (mode) {
        "performance" -> {
          targetMax = p.cpuinfoMax
          targetMin = if (isBig) p.cpuinfoMax
          else pickFreq(p, (p.cpuinfoMax * PERF_SMALL_MIN_RATIO).toInt(), floor = false)
        }
        "powersave" -> {
          val ratio = if (isBig) POWERSAVE_BIG_RATIO else POWERSAVE_SMALL_RATIO
          targetMax = pickFreq(p, (p.cpuinfoMax * ratio).toInt(), floor = true)
          targetMin = p.cpuinfoMin
        }
        else -> {
          targetMax = p.cpuinfoMax
          targetMin = p.cpuinfoMin
        }
      }

      // 1) 上限先抬到位（可能低于当前上限则等于压频，同样先写 max 最安全）
      val maxOp = WriteOp("${p.base}/scaling_max_freq", targetMax.toString())
      commands.add(write(maxOp.path, maxOp.value))
      targets.add(maxOp)

      // 2) governor
      val govOp = WriteOp("${p.base}/scaling_governor", gov)
      commands.add(write(govOp.path, govOp.value))
      targets.add(govOp)

      // 3) 目标下限（此时 max 已 >= targetMin，不会被内核拒）
      val minOp = WriteOp("${p.base}/scaling_min_freq", targetMin.toString())
      commands.add(write(minOp.path, minOp.value))
      targets.add(minOp)
    }

    return commands to targets
  }

  /**
   * 需要读回校验的写入。
   *
   * 关键改动（v2）：**不再把 stderr 丢进 /dev/null**。
   * 旧写法 `echo x > p 2>/dev/null` 会把「Permission denied / Read-only file
   * system / Invalid argument(EINVAL)」这类内核/内核态 SELinux 的拒绝理由全部
   * 吃掉，导致 failures 里只有「期望/实际」，用户和我们都看不到真因（正是本次
   * 要修的 bug）。现在用命令替换把重定向的 stderr 与退出码一并带回 stdout，
   * 由 Kotlin 侧解析成 errno 文本。
   *
   * 输出固定格式（单行，便于 grep）：
   *   TWINCORE_WRITE rc=<0|非0> path=<节点> err=<错误文本或 write-ok>
   */
  private fun write(path: String, value: String): String =
      "o=\$({ echo '$value' > $path; } 2>&1); " +
          "echo \"TWINCORE_WRITE rc=\$? path=$path err=\${o:-write-ok}\""

  /** 不需要校验的辅助写入（如放宽 min 上限），仅尽力而为，静默失败即可。 */
  private fun writePlain(path: String, value: String): String =
      "echo '$value' > $path 2>/dev/null || true"

  /**
   * 从 write() 的输出行里抠出「rc + errno 文本」。
   * 解析不到（旧固件 / shell 行为差异）时返回 null，不臆造原因。
   */
  private fun parseWriteResult(stdout: String, path: String): String? {
    val line = stdout.lineSequence().firstOrNull { it.contains("TWINCORE_WRITE") && it.contains(path) }
        ?: return null
    val rc = Regex("rc=(\\d+)").find(line)?.groupValues?.get(1)?.toIntOrNull()
    val err = Regex("err=(.*)$").find(line)?.groupValues?.get(1)?.trim().orEmpty()
    val detail = if (err.isEmpty() || err == "write-ok") "" else "，底层：$err"
    return "rc=${rc ?: "?"}$detail"
  }

  /** "/sys/.../cpu6/cpufreq/scaling_min_freq" -> "cpu6_min_freq"，applied/failures 列表统一用这个名字。 */
  private fun opLabel(path: String): String {
    val m = Regex("cpu(\\d+)/cpufreq/(\\w+)").find(path) ?: return path
    val (cpu, field) = m.destructured
    return "cpu${cpu}_${field.removePrefix("scaling_")}"
  }

  /** 从可用频点里挑一个：floor=true 取 <= target 的最大值，false 取 >= target 的最小值。 */
  private fun pickFreq(p: CpuPolicy, target: Int, floor: Boolean): Int {
    if (p.availableFreqs.isEmpty()) return target
    return if (floor) {
      p.availableFreqs.filter { it <= target }.maxOrNull() ?: p.availableFreqs.first()
    } else {
      p.availableFreqs.filter { it >= target }.minOrNull() ?: p.availableFreqs.last()
    }
  }

  /** 从机器实际支持的 governor 里按偏好顺序挑第一个可用的。 */
  private fun pickGovernor(p: CpuPolicy, pref: List<String>): String {
    if (p.availableGovernors.isEmpty()) return pref.first()
    for (g in pref) {
      if (p.availableGovernors.contains(g)) return g
    }
    // 偏好里一个都没有（罕见），退到当前 governor，实在不行退 schedutil
    return if (p.governor.isNotEmpty()) p.governor else (p.availableGovernors.firstOrNull() ?: "schedutil")
  }

  // ---------------------------------------------------------------------------
  // 备份
  // ---------------------------------------------------------------------------

  private fun backupIfNeeded(policies: List<CpuPolicy>) {
    if (prefs.getString(KEY_BACKUP, null) != null) return
    val json = JSONObject()
    for (p in policies) {
      json.put("gov_${p.leader}", p.governor)
      json.put("min_${p.leader}", if (p.scalingMin > 0) p.scalingMin else p.cpuinfoMin)
      json.put("max_${p.leader}", if (p.scalingMax > 0) p.scalingMax else p.cpuinfoMax)
    }
    prefs.edit().putString(KEY_BACKUP, json.toString()).apply()
    Log.i(TAG, "backed up stock cpufreq: $json")
  }

  // ---------------------------------------------------------------------------
  // Shizuku 授权
  // ---------------------------------------------------------------------------

  private fun ensurePermission(): AuthResult {
    if (hasPermissionSafe()) return AuthResult("granted", true)

    // 用户此前拒绝过：部分 Shizuku 版本不再弹窗，直接引导去 Manager 手动勾选。
    val rationale =
        try {
          Shizuku.shouldShowRequestPermissionRationale()
        } catch (t: Throwable) {
          Log.d(TAG, "shouldShowRequestPermissionRationale 不可用：${t.message}")
          false
        }
    if (rationale) return AuthResult("rejected_manual", false)

    val requestCode = (System.nanoTime() % 100_000).toInt() + 1
    var granted = false
    val latch = CountDownLatch(1)
    val listener = Shizuku.OnRequestPermissionResultListener { code, result ->
      if (code == requestCode) {
        granted = result == PackageManager.PERMISSION_GRANTED
        latch.countDown()
      }
    }

    Shizuku.addRequestPermissionResultListener(listener)
    return try {
      Shizuku.requestPermission(requestCode)
      val answeredInTime = latch.await(PERMISSION_TIMEOUT_MS, TimeUnit.MILLISECONDS)
      when {
        !answeredInTime -> AuthResult("timeout", false)
        granted -> AuthResult("granted", true)
        else -> AuthResult("denied", false)
      }
    } catch (t: Throwable) {
      Log.e(TAG, "requestPermission 异常", t)
      AuthResult("binder_dead", false)
    } finally {
      try {
        Shizuku.removeRequestPermissionResultListener(listener)
      } catch (t: Throwable) {
        // ignore
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 提权 shell
  // ---------------------------------------------------------------------------

  /** Shizuku 优先，失败或不可用则尝试 su。 */
  private fun runPrivilegedShell(commands: List<String>): ShellResult {
    if (hasPermissionSafe()) {
      try {
        return shizukuShell(commands)
      } catch (t: Throwable) {
        Log.w(TAG, "Shizuku shell 失败，尝试 su 兜底", t)
        return suShell(commands) ?: ShellResult(-1, "", "", "shizuku", "Shizuku：${t.message}")
      }
    }
    return suShell(commands)
        ?: ShellResult(-1, "", "", "none", "Shizuku 未授权，且设备上没有可用的 su（未 Root）")
  }

  /**
   * 以 shell 身份执行脚本。
   *
   * Shizuku 13.1.1 起 `Shizuku#newProcess` 已变为 private 且计划移除，
   * 官方指定的替代是 UserService —— 在独立进程里以 UID 2000(root 模式下为 0)
   * 运行我们自己的代码。因此这里改成 bindUserService 的同步封装：
   *
   *   bindUserService(args, conn) → onServiceConnected 拿到 IBinder
   *   → ITwinCoreShell.Stub.asInterface → exec(script) → 取 stdout/stderr/exit
   *
   * 每次调用都重新绑定再解绑，避免长期持有 binder；调频本身是低频操作
   * （用户切档位时触发一次 + 每 60s 重应用一次），这点开销可以忽略。
   */
  private fun shizukuShell(commands: List<String>): ShellResult {
    val script = commands.joinToString("\n") + "\nexit 0\n"
    val latch = CountDownLatch(1)
    val holder = arrayOfNulls<ITwinCoreShell>(1)

    val args = Shizuku.UserServiceArgs(
            ComponentName(reactApplicationContext.packageName, TwinCoreShellService::class.java.name))
        .daemon(false)
        .processNameSuffix("shell")
        .debuggable(false)
        .version(1)

    val connection = object : ServiceConnection {
      override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
        holder[0] = if (binder != null && binder.pingBinder()) {
          ITwinCoreShell.Stub.asInterface(binder)
        } else {
          null
        }
        latch.countDown()
      }

      override fun onServiceDisconnected(name: ComponentName?) {
        holder[0] = null
        latch.countDown()
      }
    }

    return try {
      Shizuku.bindUserService(args, connection)
      if (!latch.await(USER_SERVICE_TIMEOUT_MS, TimeUnit.MILLISECONDS) || holder[0] == null) {
        ShellResult(-1, "", "", "shizuku", "UserService 连接超时或失败")
      } else {
        val svc = holder[0]!!
        val code = svc.exec(script)
        val stdout = svc.execOut() ?: ""
        val stderr = svc.execErr() ?: ""
        Log.d(TAG, "shizuku us exit=$code out=${stdout.take(2000)}")
        ShellResult(code, stdout, stderr, "shizuku", null)
      }
    } catch (t: Throwable) {
      Log.w(TAG, "shizuku UserService 调用失败", t)
      ShellResult(-1, "", "", "shizuku", "UserService：${t.message}")
    } finally {
      try {
        Shizuku.unbindUserService(args, connection, true)
      } catch (t: Throwable) {
        // ignore
      }
    }
  }

  private fun suShell(commands: List<String>): ShellResult? {
    val script = commands.joinToString("\n")
    return try {
      val p = Runtime.getRuntime().exec(arrayOf("su", "-c", script))
      val stdout = readFully(p.inputStream)
      val stderr = readFully(p.errorStream)
      val code = p.waitFor()
      if (code == 0 || stdout.isNotEmpty()) {
        ShellResult(code, stdout, stderr, "su", null)
      } else {
        null
      }
    } catch (t: Throwable) {
      Log.d(TAG, "su 不可用：${t.message}")
      null
    }
  }

  /**
   * Shizuku 的静态方法在 Provider 尚未拿到 binder 时行为不完全可控，
   * 而「用户没装 Shizuku」是这个模块最常见的运行场景 —— 不能在那时崩掉。
   * 所以所有 Shizuku 调用都套一层 try。
   */
  private fun binderAliveSafe(): Boolean =
      try {
        Shizuku.pingBinder()
      } catch (t: Throwable) {
        Log.d(TAG, "pingBinder 不可用：${t.message}")
        false
      }

  private fun hasPermissionSafe(): Boolean =
      try {
        binderAliveSafe() &&
            Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED
      } catch (t: Throwable) {
        Log.d(TAG, "checkSelfPermission 不可用：${t.message}")
        false
      }

  private fun readFully(stream: InputStream): String = try {
    stream.bufferedReader().readText()
  } catch (t: Throwable) {
    ""
  }

  private fun isPackageInstalled(pkg: String): Boolean = try {
    reactApplicationContext.packageManager.getPackageInfo(pkg, 0)
    true
  } catch (t: Throwable) {
    false
  }

  // ---------------------------------------------------------------------------
  // 结果组装 / 小工具
  // ---------------------------------------------------------------------------

  private fun shizukuStatusMap(
      status: String,
      granted: Boolean,
      binderAlive: Boolean,
      message: String,
  ): WritableMap = Arguments.createMap().apply {
    putString("status", status)
    putBoolean("binderAlive", binderAlive)
    putBoolean("granted", granted)
    putBoolean("serviceInstalled", isPackageInstalled(SERVICE_PACKAGE))
    putBoolean("managerInstalled", isPackageInstalled(MANAGER_PACKAGE))
    putString("message", message)
  }

  private fun report(
      mode: String,
      appliedItems: List<String>,
      binderAlive: Boolean,
      granted: Boolean,
      policies: List<CpuPolicy>,
      commands: List<String>,
      failures: List<String>,
      message: String,
      rawErrors: List<String> = emptyList(),
  ): WritableMap {
    val big = if (policies.isEmpty()) null else biggest(policies)
    val smalls = if (big == null) emptyList() else policies.filter { it !== big }
    return Arguments.createMap().apply {
      putString("mode", mode)
      putBoolean("fullyApplied", failures.isEmpty() && appliedItems.isNotEmpty())
      putBoolean("binderAlive", binderAlive)
      putBoolean("granted", granted)
      putInt("maxFreqKhz", big?.cpuinfoMax ?: 0)
      putArray(
          "applied",
          Arguments.createArray().apply {
            appliedItems.forEach { pushString(it) }
          },
      )
      putArray(
          "bigClusterCpus",
          Arguments.createArray().apply {
            big?.related?.forEach { pushInt(it) }
          },
      )
      putArray(
          "smallClusterCpus",
          Arguments.createArray().apply {
            smalls.flatMap { it.related }.forEach { pushInt(it) }
          },
      )
      putArray(
          "commands",
          Arguments.createArray().apply {
            commands.forEach { pushString(it) }
          },
      )
      putArray(
          "failures",
          Arguments.createArray().apply {
            failures.forEach { pushString(it) }
          },
      )
      putArray(
          "rawErrors",
          Arguments.createArray().apply {
            rawErrors.forEach { pushString(it) }
          },
      )
      putString("message", message)
    }
  }

  private fun emptyReport(mode: String, message: String): WritableMap =
      report(
          mode = mode,
          appliedItems = emptyList(),
          binderAlive = binderAliveSafe(),
          granted = false,
          policies = emptyList(),
          commands = emptyList(),
          failures = emptyList(),
          message = message,
      )

  private fun labelOf(mode: String): String = when (mode) {
    "powersave" -> "省电"
    "performance" -> "性能"
    else -> "均衡"
  }

  private fun fmtKhz(khz: Int): String =
      if (khz <= 0) "?" else String.format("%.2f GHz", khz / 1_000_000.0)

  private fun readText(path: String): String = try {
    File(path).readText().trim()
  } catch (t: Throwable) {
    ""
  }

  private fun readInt(path: String): Int = readText(path).toIntOrNull() ?: 0
}
