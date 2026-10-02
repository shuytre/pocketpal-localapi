import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

/**
 * TwinCore 性能模式 + Shizuku 状态面板的原生桥。
 *
 * 只在 Android 上有实现（iOS 不注册该模块），所以用 `get` 而不是
 * `getEnforcing` —— 后者在模块缺失时会直接抛异常，把整个设置页带崩。
 */

// ---------------------------------------------------------------------------
// 授权状态枚举（与原生 TwinCorePerfModule.AuthResult 的 status 一一对应）
// ---------------------------------------------------------------------------

/** 三档性能模式。 */
export type TwinCorePerfMode = 'powersave' | 'balanced' | 'performance';

export type TwinCoreShizukuAuthStatus =
  /** 已授权 */
  | 'granted'
  /** 只读检测专用：服务在跑但本应用未授权 */
  | 'not_granted'
  /** 用户本次拒绝 */
  | 'denied'
  /** 120 秒内未收到授权结果 */
  | 'timeout'
  /**
   * shouldShowRequestPermissionRationale()==true：用户此前拒绝过，
   * Shizuku 不再弹窗，需要去 Shizuku Manager 手动勾选。
   */
  | 'rejected_manual'
  /** Shizuku 服务未运行（pingBinder()==false） */
  | 'binder_dead';

/** Shizuku 状态（面板显示 + 授权流程共用一个结构）。 */
export interface TwinCoreShizukuStatus {
  status: TwinCoreShizukuAuthStatus;
  /** Shizuku 服务进程是否在跑（pingBinder） */
  binderAlive: boolean;
  /** 本应用是否已被授权 */
  granted: boolean;
  /** Shizuku app（moe.shizuku.privileged.api）是否已安装 */
  serviceInstalled: boolean;
  /** Shizuku Manager（moe.shizuku.manager）是否已安装 */
  managerInstalled: boolean;
  /** 给人看的结果说明（可以为空串） */
  message: string;
}

/**
 * 一次调频操作的完整报告。
 *
 * 关键约定：**每个写入项单独判定**。成功项进 `applied`（如 "cpu6_min_freq"），
 * 失败项进 `failures`，单项失败绝不中断整个档位切换。
 * `fullyApplied` 只在 `failures` 为空且至少一项成功时为 true ——
 * 写完必须读回、值确实等于目标才算成功（SELinux 拦截时 echo 不报错，
 * 只看 shell 退出码会给出假的「已生效」）。
 */
export interface TwinCorePerfReport {
  /** 实际请求的档位 */
  mode: string;
  /** 读回校验通过的项，命名如 "cpu6_min_freq" / "cpu0_governor" */
  applied: string[];
  /** 读回校验失败的项（含原因描述） */
  failures: string[];
  /**
   * 底层错误明细（可选）：shell stderr、逐项写入的 rc/errno、重试结果。
   * 用于回答「为什么写不进去」（Permission denied / Read-only fs / EINVAL /
   * perfd 覆写），比只有「期望/实际」可诊断得多。原生可能不返回该字段。
   */
  rawErrors?: string[];
  /** applied 非空且 failures 为空 */
  fullyApplied: boolean;
  binderAlive: boolean;
  granted: boolean;
  /** 运行时探测到的大核 CPU 编号（按最高频聚簇，不硬编码） */
  bigClusterCpus: number[];
  /** 其余核心 */
  smallClusterCpus: number[];
  /** 大核实测最高频（kHz），0 表示读不到频点 */
  maxFreqKhz: number;
  /** 实际执行过的 shell 命令，便于排查 */
  commands: string[];
  message: string;
}

/**
 * 需求 7：智能模式（杀后台）的执行报告。
 *
 * 与调频报告同风格：成功项进 killed、失败项进 failures，绝不粉饰。
 * `ok` 只在「已授权 + 无失败」时为 true。
 */
export interface TwinCoreKillReport {
  ok: boolean;
  binderAlive: boolean;
  granted: boolean;
  /** 被 force-stop 的第三方包数量 */
  killedCount: number;
  /** 被 force-stop 的第三方包名（白名单外的，系统包与 Shizuku 不在其中） */
  killed: string[];
  /** 实际执行过的 shell 命令，便于排查 */
  commands: string[];
  failures: string[];
  message: string;
}

export interface Spec extends TurboModule {
  /**
   * 只读检测 Shizuku 状态，不弹任何窗。
   * status 只会是 granted / not_granted / binder_dead。
   */
  getShizukuStatus(): Promise<TwinCoreShizukuStatus>;

  /**
   * 完整授权流程。内部等待最多 120 秒，然后按
   * granted / denied / timeout / rejected_manual / binder_dead 五种终态返回，
   * 绝不永久挂起。
   */
  requestShizukuPermission(): Promise<TwinCoreShizukuStatus>;

  /**
   * 拉起 Shizuku Manager / Shizuku app（rejected_manual 场景手动勾选用）。
   * 返回实际拉起的包名；空串表示没找到可拉起的 Shizuku 应用。
   */
  openShizukuManager(): Promise<string>;

  /**
   * 应用一档性能模式。会先探测拓扑、备份原始值，再写入并逐项读回校验。
   */
  setPerformanceMode(mode: string): Promise<TwinCorePerfReport>;

  /** 回读当前状态（不修改任何系统设置）。 */
  getPerformanceMode(): Promise<TwinCorePerfReport>;

  /** 恢复到首次调频前的 governor / scaling_min_freq。 */
  restorePerformanceMode(): Promise<TwinCorePerfReport>;

  /**
   * 需求 7：智能模式 —— 杀掉非系统后台进程（只保留 Shizuku 与本应用）。
   *
   * 原生侧用 `am kill-all` 作主命令（系统进程/前台/persistent 由系统保护），
   * 再对白名单外的第三方包逐个 `am force-stop`，绝不使用 kill -9，
   * 也绝不 force-stop 系统包。未授权时只回报告、不执行任何操作。
   */
  killBackgroundProcesses(): Promise<TwinCoreKillReport>;
}

export default TurboModuleRegistry.get<Spec>('TwinCorePerfModule');
