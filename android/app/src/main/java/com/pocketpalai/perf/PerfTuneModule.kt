package com.pocketpal.perf

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.module.annotations.ReactModule
import com.pocketpal.specs.NativePerfTuneSpec
import java.io.File
import java.net.NetworkInterface
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * 调度与内存驻留调优。
 *
 * 三条贯穿全文件的原则：
 *
 * 1. 请求值 ≠ 生效值。所有 setter 之后必须回读，并把「内核返回的真实值」上报。
 *    未 root 设备上 raise rlimit 之外的提权基本必然失败 —— 失败要写明原因，
 *    绝不显示一个笼统的「已开启」。
 * 2. 调优是旁路增强。每个 native 调用都包 catch (Throwable)：UnsatisfiedLinkError
 *    是 Error 不是 Exception，只 catch Exception 会漏，而原生库缺失时应退化为
 *    「未调优」而不是崩溃。
 * 3. 绑定用「测量 + 白名单」，不硬编码核号、不讲「大致对了」。
 */
@ReactModule(name = NativePerfTuneSpec.NAME)
class PerfTuneModule(reactContext: ReactApplicationContext) :
    NativePerfTuneSpec(reactContext) {

  // JNI 实现在 jni/src/perf_tune.cpp，已链接进 libappmodules.so。
  private external fun nativeSetThreadAffinity(cpus: IntArray, targetTid: Int): Int
  private external fun nativeGetThreadAffinity(targetTid: Int): IntArray
  private external fun nativeSetThreadNice(targetTid: Int, niceValue: Int): Int
  private external fun nativeGetThreadNice(targetTid: Int): Int
  private external fun nativeSetThreadScheduler(
      targetTid: Int,
      policy: Int,
      priority: Int,
  ): Int
  private external fun nativeGetThreadScheduler(targetTid: Int): Int
  private external fun nativeGetThreadRtPriority(targetTid: Int): Int
  private external fun nativeGetRlimit(resource: Int): DoubleArray
  private external fun nativeRaiseRlimit(resource: Int): DoubleArray
  private external fun nativeSetOomScoreAdj(adj: Int): DoubleArray
  private external fun nativeListThreads(): Array<String>
  private external fun nativeBindThreadsByPrefix(
      prefixes: Array<String>,
      cpus: IntArray,
  ): IntArray
  private external fun nativeYieldThreadsByPrefix(
      prefixes: Array<String>,
      niceValue: Int,
  ): IntArray
  private external fun nativeLockModelFile(path: String, chunkBytes: Int): DoubleArray
  private external fun nativeUnlockModelFile(path: String): Int
  private external fun nativeUnlockAllModelFiles(): Int

  override fun getName(): String = NativePerfTuneSpec.NAME

  // ── 常量 ──────────────────────────────────────────────────────────────
  companion object {
    // bionic 的 <sys/resource.h> 常量；与 perf_tune.cpp 保持一致。
    private const val RLIMIT_NICE = 13
    private const val RLIMIT_MEMLOCK = 8

    private const val ERR = -1000

    private const val TID_SELF = 0

    // nice 阶梯下探序列。
    //
    // 为什么不能只设一次 -20：不同 ROM 对 RLIMIT_NICE 与 sched 组的放行程度不同，
    // 有的允许 -5 却不允许 -20。一次到位只能拿到「全有或全无」，阶梯能拿到该
    // 设备实际能给到的最好值。命中即停。
    private val NICE_LADDER = intArrayOf(-20, -19, -16, -12, -10, -8, -5, -4, -2)

    // 推理工作线程名前缀白名单。llama.cpp 各版本命名不一致，多列几个无害 ——
    // 关键是「不匹配就漏绑」，匹配错才有害。
    //
    // 绝对不要出现 "mqt_js" / "mqt_native" / "RenderThread" / "hwuiTask"：
    // 推理本身跑在 JS 线程上，把 UI/渲染线程拉到大核会和推理抢同一簇，更糟。
    val DEFAULT_WORKER_PREFIXES =
        listOf("ggml", "llama", "Llama", "gguf", "llama.cpp", "llama-embed",
               "llama-bench", "cpu-model", "sampling")

    // 后台线程让路的前缀白名单（只给明确属于下载/网络/协程的一类）。
    val DEFAULT_BACKGROUND_PREFIXES =
        listOf("OkHttp", "okhttp", "DownloadWorker", "download", "pool-",
               "AsyncTask", "DefaultDispatcher", "Retrofit", "firebase",
               "grpc", "ProfileInstaller")

    /**
     * 未 root 设备上的能力边界。
     *
     * 这一条必须常驻在报告里，而不是只在失败时出现：用户会照着界面判断调优
     * 有没有用，如果这里只写「已开启 nice」，用户会以为优先级真的提上去了。
     * 宁可显示「未生效 + 原因」。
     */
    val BOUNDARY_NOTES =
        listOf(
            "有效（未 root 即可）：sched_setaffinity 绑大核、n_threads 对齐到大核数、" +
                "专用推理线程、后台线程让路（正 nice 永远允许）",
            "通常无效：nice 降到 0 以下与 SCHED_FIFO 需 CAP_SYS_NICE；" +
                "改 CPU governor 需 root 写 sysfs；关系统省电需用户在系统设置里手动改",
            "部分：oom_score_adj 通常只能上调（更早被杀），下调会被内核拒绝",
        )
  }

  // ── 状态 ──────────────────────────────────────────────────────────────
  private val busy = AtomicBoolean(false)
  private val rejected = AtomicInteger(0)

  private var lastTopology: WritableMap? = null
  private var lastTargetCpus: IntArray = IntArray(0)
  private var lastForceCoreCount: Int = 0
  private var lastWorkerPrefixes: Array<String> = DEFAULT_WORKER_PREFIXES.toTypedArray()
  private var lastRebindMs: Long = 250L
  private var lastErrors: WritableArray = Arguments.createArray()
  private var lastNotes: WritableArray = Arguments.createArray()

  private val rebindScheduler = ScheduledThreadPoolExecutor(1) { runnable ->
    Thread(runnable, "pocketpal-perf-rebind").apply { isDaemon = true }
  }
  private var rebindTask: ScheduledFuture<*>? = null

  // 常驻推理线程（需求 4）由 InferenceLoop 提供：线程标识必须稳定，绑核和 nice
  // 都是按 tid 生效的，线程池在空闲时会换线程，会让「调优过的线程」和「真正干活
  // 的线程」慢慢变成两个。这里只是一个必须独占的事件循环线程。

  // ── 拓扑探测 ──────────────────────────────────────────────────────────

  /**
   * 读 /sys/devices/system/cpu/possible → 内核实际放行了哪些 CPU。
   * 格式可能是 "0-7"，也可能是 "0,2-4" 这类带空洞的形式。
   */
  private fun readPossibleCpus(): List<Int> {
    val out = mutableListOf<Int>()
    try {
      val raw = File("/sys/devices/system/cpu/possible").readText().trim()
      if (raw.isNotEmpty()) {
        for (part in raw.split(",")) {
          val range = part.trim()
          if (range.isEmpty()) continue
          if (range.contains("-")) {
            val bounds = range.split("-")
            val from = bounds[0].trim().toIntOrNull() ?: continue
            val to = bounds.getOrNull(1)?.trim()?.toIntOrNull() ?: from
            for (cpu in from..to) out.add(cpu)
          } else {
            range.toIntOrNull()?.let { out.add(it) }
          }
        }
      }
    } catch (t: Throwable) {
      // 连 possible 都读不到（极少数厂商限制）→ 退回 Runtime 的核心数。
    }
    if (out.isEmpty()) {
      val cores = Runtime.getRuntime().availableProcessors().coerceIn(1, 16)
      for (cpu in 0 until cores) out.add(cpu)
    }
    return out.distinct().sorted()
  }

  /**
   * 每个 CPU 的最高频点（kHz）。离线核没有 cpufreq 节点 —— 必须跳过空缺而不是
   * 在第一个缺失处停下：核心是否 offline 与编号顺序无关。
   */
  private fun readMaxFreqKhz(cpus: List<Int>): List<Long> {
    return cpus.map { cpu ->
      try {
        val node = File("/sys/devices/system/cpu/cpu$cpu/cpufreq/cpuinfo_max_freq")
        if (node.exists()) node.readText().trim().toLongOrNull() ?: 0L else 0L
      } catch (t: Throwable) {
        0L
      }
    }
  }

  private fun readMemTotalMb(): Int {
    return try {
      File("/proc/meminfo").useLines { lines ->
        for (line in lines) {
          if (line.startsWith("MemTotal:")) {
            val kb = line.substringAfter("MemTotal:").trim().substringBefore(" ").toLongOrNull()
            if (kb != null) return (kb / 1024.0).let { Math.ceil(it).toInt() }
          }
        }
        0
      }
    } catch (t: Throwable) {
      0
    }
  }

  private fun readHardware(): String {
    return try {
      File("/proc/cpuinfo").useLines { lines ->
        for (line in lines) {
          if (line.startsWith("Hardware")) {
            return line.substringAfter(":").trim()
          }
        }
        ""
      }
    } catch (t: Throwable) {
      ""
    }
  }

  private fun buildTopologyMap(): WritableMap {
    val possible = readPossibleCpus()
    val freqs = readMaxFreqKhz(possible)
    val positive = freqs.filter { it > 0L }
    val maxFreq = positive.maxOrNull() ?: 0L
    val reliable = possible.isNotEmpty() && positive.isNotEmpty()

    // 单一频簇 → bigClusterCpus 返回空数组，语义是「无需绑定」而不是「绑定失败」。
    // UI 文案必须区分这两者，否则用户会以为功能坏了。
    val singleCluster = positive.size <= 1 || (positive.toSet().size == 1)
    val bigCpus = mutableListOf<Int>()
    if (!singleCluster && maxFreq > 0L) {
      possible.indices.forEach { i ->
        if (freqs[i] == maxFreq) bigCpus.add(possible[i])
      }
    }

    val map = Arguments.createMap()
    map.putInt("totalCores", possible.size)
    map.putArray("possibleCpus", Arguments.fromList(possible))
    map.putArray("maxFreqKhz", Arguments.fromList(freqs.map { it }))
    map.putInt("clusterCount", if (reliable) positive.toSet().size else 0)
    map.putDouble("bigClusterFreqKhz", maxFreq.toDouble())
    map.putArray("bigClusterCpus", Arguments.fromList(bigCpus))
    map.putInt("smallCoreCount", (possible.size - bigCpus.size).coerceAtLeast(0))
    map.putBoolean("singleCluster", singleCluster)
    map.putInt("memTotalMb", readMemTotalMb())
    map.putString("hardware", readHardware())
    map.putBoolean("reliable", reliable)
    return map
  }

  // ── 对外 API ──────────────────────────────────────────────────────────

  override fun detectTopology(promise: Promise) {
    try {
      val map = buildTopologyMap()
      lastTopology = map
      promise.resolve(map)
    } catch (t: Throwable) {
      promise.reject("PERF_TUNE_ERROR", t.message ?: "topology detection failed")
    }
  }

  /**
   * 原子应用。返回的报告里每个字段都是回读值。
   *
   * 为什么整个流程在 inferenceExecutor 上执行：sched_setaffinity(0) 只作用于
   * 调用线程，nicer 也是按 tid 设置的。所以「专用推理线程必须是发起者」，
   * 不能由 JS 线程代劳。
   */
  override fun applyTuning(config: ReadableMap, promise: Promise) {
    val latch = CountDownLatch(1)
    var result: WritableMap? = null
    var failure: Throwable? = null

    InferenceLoop.post {
      try {
        result = applyTuningOnThread(config)
      } catch (t: Throwable) {
        failure = t
      } finally {
        latch.countDown()
      }
    }

    if (!latch.await(8, TimeUnit.SECONDS)) {
      // 旁路增强超时也要有出口：让调用方看到「未生效」而不是永久挂起。
      promise.resolve(reportWithError("applyTuning timed out after 8s"))
      return
    }
    failure?.let {
      promise.reject("PERF_TUNE_ERROR", it.message ?: "applyTuning failed")
      return
    }
    promise.resolve(result)
  }

  private fun applyTuningOnThread(config: ReadableMap): WritableMap {
    val errors = mutableListOf<String>()
    val notes = mutableListOf<String>()

    val topology = buildTopologyMap()
    lastTopology = topology

    val possible = topology.getArray("possibleCpus")!!.toArrayList().map { (it as Number).toInt() }
    val freqs = topology.getArray("maxFreqKhz")!!.toArrayList().map { (it as Number).toLong() }
    val bigCpus = topology.getArray("bigClusterCpus")!!.toArrayList().map { (it as Number).toInt() }
    val singleCluster = topology.getBoolean("singleCluster")

    val forceCoreCount = getInt(config, "forceCoreCount", 0)
    val bindBigCores = getBoolean(config, "bindBigCores", true)
    val enablePriority = getBoolean(config, "enablePriority", true)
    val niceTarget = getInt(config, "niceTarget", -20)
    val enableRealTime = getBoolean(config, "enableRealTime", false)
    val rtPriority = getInt(config, "rtPriority", 1)
    val yieldBackground = getBoolean(config, "yieldBackground", true)
    val backgroundNice = getInt(config, "backgroundNice", 10)
    val backgroundPrefixes = toStringList(config, "backgroundPrefixes")
        .ifEmpty { DEFAULT_BACKGROUND_PREFIXES }
    val workerPrefixes = toStringList(config, "workerPrefixes")
        .ifEmpty { DEFAULT_WORKER_PREFIXES }
    val rebindIntervalMs = getInt(config, "rebindIntervalMs", 250).toLong().coerceIn(50L, 5000L)
    val applyOomAdj = getBoolean(config, "applyOomAdj", true)
    val oomAdjTarget = getInt(config, "oomAdjTarget", -100)

    lastForceCoreCount = forceCoreCount
    lastWorkerPrefixes = workerPrefixes.toTypedArray()
    lastRebindMs = rebindIntervalMs

    // ── 目标核：按频点降序取前 N（同频按 CPU 编号升序，保证结果可复现）──
    //
    // 为什么是「最高频的前 N 个」而不是「整个高频簇」：换成「4 大核」的机型
    // （部分骁龙 7 系），整簇绑定会得到 4 个线程，而用户要的是 2 个。更关键的
    // 是线程数超过物理大核数时吞吐反而下降 —— matmul 有同步屏障，慢线程拖住快线程。
    val ranked = possible.indices
        .sortedWith(compareByDescending<Int> { freqs.getOrElse(it) { 0L } }.thenBy { possible[it] })
        .map { possible[it] }
    val targetCpus: List<Int> = when {
      !bindBigCores || singleCluster -> emptyList()  // 单簇即「无需绑定」
      forceCoreCount > 0 -> ranked.take(forceCoreCount)
      else -> bigCpus
    }
    lastTargetCpus = targetCpus.toIntArray()

    val tid = android.os.Process.myTid()
    val threadName = Thread.currentThread().name

    // ── ① 先把 RLIMIT_NICE / RLIMIT_MEMLOCK 软限抬到硬限 ────────────────
    // 这是整个过程中唯一「不需要特权」的提操作，必须在尝试 nice / mlock 之前做，
    // 否则会把「rlimit 太矮」误判成「系统调用不支持」。
    val niceRlimitBefore = readRlimit(RLIMIT_NICE)
    val niceRlimitAfter: RlimitState
    var niceRlimitRaised = false
    if (getBoolean(config, "raiseNiceRlimit", true)) {
      val raised = safe { nativeRaiseRlimit(RLIMIT_NICE) }
      if (raised != null && raised[4] > 0.5) {
        niceRlimitRaised = true
        niceRlimitAfter = RlimitState(raised[2].toLong(), raised[3].toLong(), true)
      } else {
        niceRlimitAfter = readRlimit(RLIMIT_NICE)
      }
    } else {
      niceRlimitAfter = readRlimit(RLIMIT_NICE)
    }

    val memlockRlimitBefore = readRlimit(RLIMIT_MEMLOCK)
    val memlockRlimitAfter: RlimitState
    var memlockRlimitRaised = false
    if (getBoolean(config, "raiseMemlockRlimit", true)) {
      val raised = safe { nativeRaiseRlimit(RLIMIT_MEMLOCK) }
      if (raised != null && raised[4] > 0.5) {
        memlockRlimitRaised = true
        memlockRlimitAfter = RlimitState(raised[2].toLong(), raised[3].toLong(), true)
      } else {
        memlockRlimitAfter = readRlimit(RLIMIT_MEMLOCK)
      }
    } else {
      memlockRlimitAfter = readRlimit(RLIMIT_MEMLOCK)
    }

    // ── ② 绑大核 ───────────────────────────────────────────────────────
    var affinityActual = intArrayOf()
    if (targetCpus.isNotEmpty()) {
      val rc = safe { nativeSetThreadAffinity(targetCpus.toIntArray(), TID_SELF) } ?: ERR
      if (rc != 0) {
        errors.add("sched_setaffinity 失败 rc=$rc（返回 EINVAL 多为目标核不存在）")
      }
      affinityActual = safe { nativeGetThreadAffinity(TID_SELF) } ?: intArrayOf()
      if (affinityActual.isEmpty()) {
        notes.add("亲和掩码回读为空：内核未返回该线程的 cpumask")
      }
    } else {
      notes.add(
          if (singleCluster) "设备只有单一频簇，无大小核之分 → 不做绑定（非失败）"
          else "未启用大核绑定"
      )
      affinityActual = safe { nativeGetThreadAffinity(TID_SELF) } ?: intArrayOf()
    }

    // ── ③ nice 阶梯下探 ────────────────────────────────────────────────
    // 权威判据：允许的最低 nice = 20 - RLIMIT_NICE_cur
    //   cur = 0  → 最低 nice 20（连默认的 0 都提不上去，Android 应用常态）
    //   cur = 20 → 最低 nice 0
    //   cur = 40 → 最低 nice -20（完整提权，需 CAP_SYS_NICE 或 root）
    var niceActual = safe { nativeGetThreadNice(TID_SELF) } ?: ERR
    var niceLadderStep = -1
    // 从用户目标出发逐级放宽；命中的第一档就是这台设备能给到的最好值。
    val ladder = (listOf(niceTarget) + NICE_LADDER.filter { it > niceTarget })
        .distinct()
        .sortedDescending()
        .toMutableList()
    if (enablePriority) {
      for ((index, candidate) in ladder.withIndex()) {
        val rc = safe { nativeSetThreadNice(TID_SELF, candidate) } ?: ERR
        val readback = safe { nativeGetThreadNice(TID_SELF) } ?: ERR
        if (rc == 0 && readback == candidate) {
          niceActual = readback
          niceLadderStep = index
          break  // 命中即停
        }
      }
      if (niceActual == 0) {
        notes.add(
            "nice 未能下调（RLIMIT_NICE=${niceRlimitAfter.soft}/${niceRlimitAfter.hard}）：" +
                "未 root 无 CAP_SYS_NICE，这是预期结果而非缺陷"
        )
      }
    } else {
      notes.add("未启用优先级提升")
    }

    // ── ④ 实时调度类（默认关闭）────────────────────────────────────────
    var schedPolicy = safe { nativeGetThreadScheduler(TID_SELF) } ?: ERR
    var rtPriorityActual = 0
    if (enableRealTime) {
      val rc = safe { nativeSetThreadScheduler(TID_SELF, SCHED_FIFO_VALUE, rtPriority) } ?: ERR
      if (rc != 0) {
        errors.add("SCHED_FIFO 设置失败 rc=$rc（需 CAP_SYS_NICE，未 root 必然失败）")
      }
      schedPolicy = safe { nativeGetThreadScheduler(TID_SELF) } ?: ERR
      rtPriorityActual = safe { nativeGetThreadRtPriority(TID_SELF) } ?: 0
    }

    // ── ⑤ 推理 worker 线程白名单绑定（首次立即执行）────────────────────
    var matched = 0
    var bound = 0
    var failedThreads = 0
    if (targetCpus.isNotEmpty()) {
      val res = safe { nativeBindThreadsByPrefix(lastWorkerPrefixes, targetCpus.toIntArray()) }
      if (res != null && res.size >= 3) {
        matched = res[0]
        bound = res[1]
        failedThreads = res[2]
      }
      if (matched == 0) {
        notes.add(
            "没有按前缀匹配到 llama/ggml 工作线程 —— 可能是尚未开始推理，" +
                "或该 llama.cpp 版本的线程命名不在白名单内（见线程明细）"
        )
      }
      // 推理进行中周期性重绑：worker 按需创建又回收，只绑一次会漏掉后续新建的。
      startRebindLoopIfBusy()
    }

    // ── ⑥ 后台线程让路 ─────────────────────────────────────────────────
    var backgroundMatched = 0
    var backgroundChanged = 0
    if (yieldBackground) {
      val res = safe {
        nativeYieldThreadsByPrefix(backgroundPrefixes.toTypedArray(), backgroundNice)
      }
      if (res != null && res.size >= 2) {
        backgroundMatched = res[0]
        backgroundChanged = res[1]
      }
    }

    // ── ⑦ oom_score_adj ────────────────────────────────────────────────
    var oomRequested = 0
    var oomBefore = ERR
    var oomAfter = ERR
    var oomApplied = false
    if (applyOomAdj) {
      oomRequested = oomAdjTarget
      val res = safe { nativeSetOomScoreAdj(oomAdjTarget) }
      if (res != null && res.size >= 4) {
        oomBefore = res[1].toInt()
        oomAfter = res[2].toInt()
        oomApplied = res[3] > 0.5
        if (!oomApplied) {
          notes.add(
              "oom_score_adj 未生效（请求 $oomRequested / 实际 $oomAfter）：" +
                  "非 root 进程通常只能上调，下调会被内核拒绝"
          )
        }
      } else {
        notes.add("oom_score_adj 读写失败（不可读 /proc/self/oom_score_adj）")
      }
    }

    // 能力边界常驻显示：不是失败时才说明，而是每次都摆在报告里。
    notes.addAll(0, BOUNDARY_NOTES)

    lastErrors = Arguments.fromList(errors)
    lastNotes = Arguments.fromList(notes)

    return buildReport(
        applied = true,
        topology = topology,
        targetCpus = targetCpus.toIntArray(),
        affinityActual = affinityActual,
        matched = matched,
        bound = bound,
        failedThreads = failedThreads,
        niceRequested = niceTarget,
        niceActual = niceActual,
        ladder = ladder.toIntArray(),
        ladderStep = niceLadderStep,
        niceBefore = niceRlimitBefore,
        niceAfter = niceRlimitAfter,
        niceRaised = niceRlimitRaised,
        memlockBefore = memlockRlimitBefore,
        memlockAfter = memlockRlimitAfter,
        memlockRaised = memlockRlimitRaised,
        schedPolicy = schedPolicy,
        rtPriority = rtPriorityActual,
        oomRequested = oomRequested,
        oomBefore = oomBefore,
        oomAfter = oomAfter,
        oomApplied = oomApplied,
        backgroundMatched = backgroundMatched,
        backgroundChanged = backgroundChanged,
        tid = tid,
        threadName = threadName,
        errors = errors,
        notes = notes,
    )
  }

  override fun rebindWorkers(prefixes: ReadableArray, cpus: ReadableArray, promise: Promise) {
    try {
      val prefixList = readableArrayToList(prefixes).ifEmpty { DEFAULT_WORKER_PREFIXES }
      val cpuList = readableArrayToIntList(cpus)
      val result = Arguments.createMap()
      if (cpuList.isEmpty()) {
        result.putInt("matched", 0)
        result.putInt("bound", 0)
        result.putInt("failed", 0)
        promise.resolve(result)
        return
      }
      val res = try {
        nativeBindThreadsByPrefix(prefixList.toTypedArray(), cpuList.toIntArray())
      } catch (t: Throwable) {
        intArrayOf(0, 0, 0)
      }
      result.putInt("matched", if (res.isNotEmpty()) res[0] else 0)
      result.putInt("bound", if (res.size > 1) res[1] else 0)
      result.putInt("failed", if (res.size > 2) res[2] else 0)
      promise.resolve(result)
    } catch (t: Throwable) {
      promise.reject("PERF_TUNE_ERROR", t.message ?: "rebind failed")
    }
  }

  override fun getTuningReport(promise: Promise) {
    val latch = CountDownLatch(1)
    var result: WritableMap? = null
    var failure: Throwable? = null
    InferenceLoop.post {
      try {
        result = collectReport()
      } catch (t: Throwable) {
        failure = t
      } finally {
        latch.countDown()
      }
    }
    if (!latch.await(5, TimeUnit.SECONDS)) {
      promise.resolve(reportWithError("getTuningReport timed out"))
      return
    }
    failure?.let {
      promise.reject("PERF_TUNE_ERROR", it.message ?: "report failed")
      return
    }
    promise.resolve(result)
  }

  /** 纯回读，不做任何修改。UI 上的「调优报告」就是靠它保持与实况一致。 */
  private fun collectReport(): WritableMap {
    val topology = lastTopology ?: buildTopologyMap()
    val tid = android.os.Process.myTid()
    val affinity = safe { nativeGetThreadAffinity(TID_SELF) } ?: intArrayOf()
    val niceActual = safe { nativeGetThreadNice(TID_SELF) } ?: ERR
    val policy = safe { nativeGetThreadScheduler(TID_SELF) } ?: ERR
    val rt = safe { nativeGetThreadRtPriority(TID_SELF) } ?: 0
    val niceBefore = readRlimit(RLIMIT_NICE)
    val memlockBefore = readRlimit(RLIMIT_MEMLOCK)
    val oom = readOomAdj()

    return buildReport(
        applied = true,
        topology = topology,
        targetCpus = lastTargetCpus,
        affinityActual = affinity,
        matched = 0,
        bound = 0,
        failedThreads = 0,
        niceRequested = NICE_LADDER.firstOrNull() ?: -20,
        niceActual = niceActual,
        ladder = NICE_LADDER,
        ladderStep = NICE_LADDER.indexOf(niceActual),
        niceBefore = niceBefore,
        niceAfter = niceBefore,
        niceRaised = false,
        memlockBefore = memlockBefore,
        memlockAfter = memlockBefore,
        memlockRaised = false,
        schedPolicy = policy,
        rtPriority = rt,
        oomRequested = oom,
        oomBefore = oom,
        oomAfter = oom,
        oomApplied = false,
        backgroundMatched = 0,
        backgroundChanged = 0,
        tid = tid,
        threadName = Thread.currentThread().name,
        errors = readableArrayToStrings(lastErrors),
        notes = readableArrayToStrings(lastNotes),
    )
  }

  override fun setBusy(busyValue: Boolean, promise: Promise) {
    busy.set(busyValue)
    try {
      if (busyValue) startRebindLoopIfBusy() else stopRebindLoop()
      promise.resolve(true)
    } catch (t: Throwable) {
      promise.resolve(false)
    }
  }

  /**
   * 模型权重锁定。
   *
   * 为什么这一半由我们自己补：llama.cpp 只有 use_mlock 这个上下文参数，
   * 而它底层的 mlock 走进程级 RLIMIT_MEMLOCK —— Android 应用默认常为 64KB，
   * 于是它在几毫秒内因 ENOMEM 失败，并且只往 stderr 打一行警告，App 内完全
   * 看不见。这就是「看起来开了 mlock，实际一点没锁住」的根因。
   *
   * 我们做的事情：抬 RLIMIT_MEMLOCK 软限 → MAP_SHARED mmap（与 llama.cpp 自己
   * 的映射指向同一批物理页，不额外占内存）→ 1MB 分片 mlock → 锁不住的退化为
   * madvise(MADV_WILLNEED) 预取。报告里给出「已锁定 / 仅预取」的具体字节数，
   * 而不是一个笼统的「已开启常驻」。
   */
  override fun lockModel(path: String, promise: Promise) {
    try {
      val before = readRlimit(RLIMIT_MEMLOCK)
      val raised = safe { nativeRaiseRlimit(RLIMIT_MEMLOCK) }
      val after = if (raised != null && raised[4] > 0.5) {
        RlimitState(raised[2].toLong(), raised[3].toLong(), true)
      } else {
        readRlimit(RLIMIT_MEMLOCK)
      }

      val res = try {
        nativeLockModelFile(path, 1024 * 1024)
      } catch (t: Throwable) {
        null
      }

      val map = Arguments.createMap()
      map.putString("path", path)
      if (res == null) {
        map.putDouble("fileSizeBytes", 0.0)
        map.putDouble("lockedBytes", 0.0)
        map.putDouble("prefetchedBytes", 0.0)
        map.putBoolean("fullyLocked", false)
        map.putBoolean("mapped", false)
        map.putInt("errnoCode", ERR)
        map.putString(
            "note",
            "mlock 原生能力不可用（UnsatisfiedLinkError）→ 未调优，App 继续可用"
        )
      } else {
        map.putDouble("fileSizeBytes", res[0])
        map.putDouble("lockedBytes", res[1])
        map.putDouble("prefetchedBytes", res[2])
        map.putBoolean("fullyLocked", res[3] > 0.5)
        map.putBoolean("mapped", res[4] > 0.5)
        map.putInt("errnoCode", res[5].toInt())
        map.putString("note", buildMlockNote(res[0], res[1], res[2], before, after))
      }
      map.putMap("before", before.toMap())
      map.putMap("after", after.toMap())
      promise.resolve(map)
    } catch (t: Throwable) {
      promise.reject("PERF_TUNE_ERROR", t.message ?: "lock failed")
    }
  }

  private fun buildMlockNote(
      fileSize: Double,
      locked: Double,
      prefetched: Double,
      before: RlimitState,
      after: RlimitState,
  ): String {
    val mb = { v: Double -> "%.1fMB".format(v / (1024.0 * 1024.0)) }
    return when {
      fileSize <= 0.0 -> "模型文件大小读取失败，未做任何锁定"
      locked >= fileSize -> "已锁定 ${mb(locked)} 到物理内存"
      locked > 0.0 ->
          "已锁定 ${mb(locked)}，其余 ${mb(prefetched)} 仅预取到页缓存"
      else ->
          "mlock 受限（RLIMIT_MEMLOCK=${before.soft}→${after.soft}），已预取 ${mb(prefetched)}"
    }
  }

  override fun unlockModel(path: String, promise: Promise) {
    try {
      val res = try {
        nativeUnlockModelFile(path)
      } catch (t: Throwable) {
        0
      }
      promise.resolve(res == 1)
    } catch (t: Throwable) {
      promise.resolve(false)
    }
  }

  override fun unlockAllModels(promise: Promise) {
    try {
      val count = try {
        nativeUnlockAllModelFiles()
      } catch (t: Throwable) {
        0
      }
      promise.resolve(count)
    } catch (t: Throwable) {
      promise.resolve(0)
    }
  }

  override fun getLanIpAddresses(promise: Promise) {
    try {
      val addresses = mutableListOf<String>()
      val interfaces = NetworkInterface.getNetworkInterfaces()
      while (interfaces.hasMoreElements()) {
        val netInterface = interfaces.nextElement()
        val addrs = netInterface.inetAddresses
        while (addrs.hasMoreElements()) {
          val addr = addrs.nextElement()
          if (addr.isLoopbackAddress || addr !is java.net.Inet4Address) continue
          val host = addr.hostAddress ?: continue
          // 169.254.x 是 APIPA（没拿到 DHCP 的地址），对客户端不可用。
          if (host.startsWith("169.254.")) continue
          addresses.add(host)
        }
      }
      promise.resolve(Arguments.fromList(addresses.distinct()))
    } catch (t: Throwable) {
      promise.resolve(Arguments.fromList(emptyList<String>()))
    }
  }

  // ── 内部工具 ──────────────────────────────────────────────────────────

  private data class RlimitState(val soft: Long, val hard: Long, val ok: Boolean) {
    fun toMap(): WritableMap {
      val map = Arguments.createMap()
      map.putDouble("soft", soft.toDouble())
      map.putDouble("hard", hard.toDouble())
      map.putBoolean("ok", ok)
      return map
    }
  }

  private fun readRlimit(resource: Int): RlimitState {
    val res = safe { nativeGetRlimit(resource) }
    return if (res != null && res.size >= 3 && res[2] > 0.5) {
      RlimitState(res[0].toLong(), res[1].toLong(), true)
    } else {
      RlimitState(ERR.toLong(), ERR.toLong(), false)
    }
  }

  private fun readOomAdj(): Int {
    return try {
      File("/proc/self/oom_score_adj").readText().trim().toIntOrNull() ?: ERR
    } catch (t: Throwable) {
      ERR
    }
  }

  /**
   * 所有 native 调用的统一收敛。
   *
   * 必须是 Throwable 而不是 Exception：原生库缺失时抛的是 UnsatisfiedLinkError
   * （Error 子类），只 catch Exception 会让整个 App 挂掉 —— 而「调优失败」本该
   * 退化成「未调优」。
   */
  private inline fun <T> safe(block: () -> T): T? {
    return try {
      block()
    } catch (t: Throwable) {
      null
    }
  }

  private fun startRebindLoopIfBusy() {
    if (!busy.get() || lastTargetCpus.isEmpty()) return
    if (rebindTask != null && rebindTask?.isCancelled == false) return
    rebindTask = rebindScheduler.scheduleAtFixedRate({
      if (!busy.get()) {
        return@scheduleAtFixedRate
      }
      try {
        nativeBindThreadsByPrefix(lastWorkerPrefixes, lastTargetCpus)
      } catch (t: Throwable) {
        // 限流后的重绑失败不改任何状态：下一轮会再试。
      }
    }, lastRebindMs, lastRebindMs, TimeUnit.MILLISECONDS)
  }

  private fun stopRebindLoop() {
    rebindTask?.cancel(false)
    rebindTask = null
  }

  private fun getInt(map: ReadableMap, key: String, fallback: Int): Int {
    return if (map.hasKey(key) && !map.isNull(key)) map.getInt(key) else fallback
  }

  private fun getBoolean(map: ReadableMap, key: String, fallback: Boolean): Boolean {
    return if (map.hasKey(key) && !map.isNull(key)) map.getBoolean(key) else fallback
  }

  private fun toStringList(map: ReadableMap, key: String): List<String> {
    if (!map.hasKey(key) || map.isNull(key)) return emptyList()
    return readableArrayToList(map.getArray(key))
  }

  private fun readableArrayToList(array: ReadableArray?): List<String> {
    if (array == null) return emptyList()
    val out = mutableListOf<String>()
    for (i in 0 until array.size()) {
      when (array.getType(i).name) {
        // getString 返回 String?，直接 add 会报 nullable 不匹配。
        "String" -> {
          val value = array.getString(i)
          if (value != null) out.add(value)
        }
        else -> Unit
      }
    }
    return out
  }

  private fun readableArrayToStrings(array: ReadableArray?): List<String> {
    return readableArrayToList(array)
  }

  private fun readableArrayToIntList(array: ReadableArray?): List<Int> {
    if (array == null) return emptyList()
    val out = mutableListOf<Int>()
    for (i in 0 until array.size()) {
      if (array.getType(i).name == "Number") {
        out.add(array.getDouble(i).toInt())
      }
    }
    return out
  }

  private fun buildReport(
      applied: Boolean,
      topology: WritableMap,
      targetCpus: IntArray,
      affinityActual: IntArray,
      matched: Int,
      bound: Int,
      failedThreads: Int,
      niceRequested: Int,
      niceActual: Int,
      ladder: IntArray,
      ladderStep: Int,
      niceBefore: RlimitState,
      niceAfter: RlimitState,
      niceRaised: Boolean,
      memlockBefore: RlimitState,
      memlockAfter: RlimitState,
      memlockRaised: Boolean,
      schedPolicy: Int,
      rtPriority: Int,
      oomRequested: Int,
      oomBefore: Int,
      oomAfter: Int,
      oomApplied: Boolean,
      backgroundMatched: Int,
      backgroundChanged: Int,
      tid: Int,
      threadName: String,
      errors: List<String>,
      notes: List<String>,
  ): WritableMap {
    val map = Arguments.createMap()
    map.putBoolean("applied", applied)
    map.putDouble("timestampMs", System.currentTimeMillis().toDouble())
    map.putMap("topology", topology)
    map.putInt("requestedForceCoreCount", lastForceCoreCount)
    map.putArray("targetCpus", Arguments.fromList(targetCpus.toList()))
    map.putInt("effectiveCoreCount", targetCpus.size)
    map.putArray("affinityRequested", Arguments.fromList(targetCpus.toList()))
    map.putArray("affinityActual", Arguments.fromList(affinityActual.toList()))
    map.putInt("affinityMatchedWorkerThreads", matched)
    map.putInt("affinityBoundWorkerThreads", bound)
    map.putInt("affinityFailedWorkerThreads", failedThreads)
    map.putInt("niceRequested", niceRequested)
    map.putInt("niceActual", niceActual)
    map.putArray("niceLadder", Arguments.fromList(ladder.toList()))
    map.putInt("niceLadderStep", ladderStep)
    map.putMap("niceRlimitBefore", niceBefore.toMap())
    map.putMap("niceRlimitAfter", niceAfter.toMap())
    map.putBoolean("niceRlimitRaised", niceRaised)
    map.putMap("memlockRlimitBefore", memlockBefore.toMap())
    map.putMap("memlockRlimitAfter", memlockAfter.toMap())
    map.putBoolean("memlockRlimitRaised", memlockRaised)
    map.putInt("schedPolicy", schedPolicy)
    map.putString("schedPolicyName", policyName(schedPolicy))
    map.putInt("rtPriority", rtPriority)
    map.putInt("oomRequested", oomRequested)
    map.putInt("oomBefore", oomBefore)
    map.putInt("oomAfter", oomAfter)
    map.putBoolean("oomApplied", oomApplied)
    map.putInt("backgroundMatched", backgroundMatched)
    map.putInt("backgroundChanged", backgroundChanged)
    map.putInt("appliedOnTid", tid)
    map.putString("appliedOnThreadName", threadName)
    map.putArray("errors", Arguments.fromList(errors))
    map.putArray("notes", Arguments.fromList(notes))
    // 线程明细：llama.cpp 各版本命名不一致，前缀匹配不到时这是唯一的排查依据。
    val threads = safe { nativeListThreads() } ?: emptyArray()
    map.putArray("threads", Arguments.fromList(threads.toList()))
    return map
  }

  private fun policyName(policy: Int): String = when (policy) {
    0 -> "SCHED_NORMAL"
    1 -> "SCHED_FIFO"
    2 -> "SCHED_RR"
    3 -> "SCHED_BATCH"
    5 -> "SCHED_IDLE"
    6 -> "SCHED_DEADLINE"
    else -> if (policy == ERR) "unknown" else "policy-$policy"
  }

  private fun reportWithError(message: String): WritableMap {
    val map = Arguments.createMap()
    map.putBoolean("applied", false)
    map.putDouble("timestampMs", System.currentTimeMillis().toDouble())
    map.putMap("topology", lastTopology ?: Arguments.createMap())
    map.putArray("targetCpus", Arguments.createArray())
    map.putArray("affinityRequested", Arguments.createArray())
    map.putArray("affinityActual", Arguments.createArray())
    map.putArray("niceLadder", Arguments.createArray())
    map.putArray("threads", Arguments.createArray())
    map.putArray("errors", Arguments.fromList(listOf(message)))
    map.putArray("notes", Arguments.createArray())
    return map
  }

  // bionic 的调度类常量（缺 asm-generic 头时也能编译）。
  private val SCHED_FIFO_VALUE: Int = 1
}
