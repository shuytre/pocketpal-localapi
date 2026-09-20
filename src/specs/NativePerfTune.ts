import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

/**
 * CPU 拓扑 —— 全部为「测量值」，没有任何硬编码的核编号。
 *
 * 为什么必须这么做而不是直接写 cpu6,cpu7：同代 SoC 的簇布局在 6 核 / 8 核 /
 * 带热插拔的机型上并不一致，硬编码会把线程绑到错误的核、甚至不存在的核上
 * （sched_setaffinity 返回 EINVAL）。bigClusterCpus 由「按最高频点聚簇」得到，
 * 即设备上真实存在的那个最高频簇。
 */
export interface TopologyInfo {
  /** 内核放行给我的 CPU 列表（/sys/devices/system/cpu/possible） */
  totalCores: number;
  possibleCpus: number[];
  /** 每个 possible CPU 的最高频点（kHz），与 possibleCpus 一一对应 */
  maxFreqKhz: number[];
  /** 频点不同的簇数量 */
  clusterCount: number;
  /** 最高频点（kHz）。单一频簇时 bigClusterCpus 为空 —— 语义是「无需绑定」 */
  bigClusterFreqKhz: number;
  bigClusterCpus: number[];
  smallCoreCount: number;
  /** true = 所有核心同频，不存在大小核结构，此时不应绑定任何核心 */
  singleCluster: boolean;
  memTotalMb: number;
  /** /proc/cpuinfo 的 Hardware 行，可能读不到 */
  hardware: string;
  /** 拓扑探测是否可信：possible 与 cpufreq 都读到了才算 */
  reliable: boolean;
}

export interface RlimitState {
  soft: number;
  hard: number;
  ok: boolean;
}

export type TuningConfig = {
  /** 0 = 跟随最高频簇（不强制）；>0 = 取最高频的前 N 个核 */
  forceCoreCount: number;
  bindBigCores: boolean;
  /** 是否执行 nice 阶梯下探。需要 CAP_SYS_NICE，未 root 通常失败并被如实上报 */
  enablePriority: boolean;
  /** 阶梯起点（通常 -20） */
  niceTarget: number;
  /** SCHED_FIFO。默认关闭：RT 线程会抢占整个核，网络+UI 并发下反而增加输入延迟 */
  enableRealTime: boolean;
  rtPriority: number;
  /** 让后台（下载/网络/协程）线程让路 —— 上调 nice 永远允许 */
  yieldBackground: boolean;
  backgroundNice: number;
  backgroundPrefixes: string[];
  /** 推理工作线程名前缀白名单（llama/ggml 等）。白名单而非黑名单：绑错线程比漏绑更糟 */
  workerPrefixes: string[];
  /** 推理进行中周期性重绑的间隔。建议 250ms，限流以避免每条 token 都扫一遍 /proc */
  rebindIntervalMs: number;
  raiseNiceRlimit: boolean;
  raiseMemlockRlimit: boolean;
  applyOomAdj: boolean;
  oomAdjTarget: number;
};

export type TuningReport = {
  applied: boolean;
  timestampMs: number;
  topology: TopologyInfo;
  /** 用户意图：强制核数 */
  requestedForceCoreCount: number;
  /** 设备实际给出的目标 CPU（最高频前 N）。两者分开显示，才能在
   *  「要 2 个但设备只有 1 个大核」时如实说明 */
  targetCpus: number[];
  effectiveCoreCount: number;
  affinityRequested: number[];
  /** 由 sched_getaffinity 回读的真实掩码 */
  affinityActual: number[];
  affinityMatchedWorkerThreads: number;
  affinityBoundWorkerThreads: number;
  affinityFailedWorkerThreads: number;
  niceRequested: number;
  niceActual: number;
  niceLadder: number[];
  niceLadderStep: number;
  niceRlimitBefore: RlimitState;
  niceRlimitAfter: RlimitState;
  niceRlimitRaised: boolean;
  memlockRlimitBefore: RlimitState;
  memlockRlimitAfter: RlimitState;
  memlockRlimitRaised: boolean;
  schedPolicy: number;
  schedPolicyName: string;
  rtPriority: number;
  oomRequested: number;
  oomBefore: number;
  oomAfter: number;
  oomApplied: boolean;
  backgroundMatched: number;
  backgroundChanged: number;
  appliedOnTid: number;
  appliedOnThreadName: string;
  errors: string[];
  notes: string[];
  /** "tid:name" 快照，用于核对「到底绑到了谁」 */
  threads: string[];
};

export type RebindResult = {
  matched: number;
  bound: number;
  failed: number;
};

export type MlockReport = {
  path: string;
  fileSizeBytes: number;
  lockedBytes: number;
  prefetchedBytes: number;
  fullyLocked: boolean;
  mapped: boolean;
  errnoCode: number;
  before: RlimitState;
  after: RlimitState;
  note: string;
};

export interface Spec extends TurboModule {
  /**
   * 测量 CPU 拓扑与内存。返回的是内核实际值，不是请求值。
   */
  detectTopology(): Promise<TopologyInfo>;
  /**
   * 原子应用一整套调优。
   *
   * 为什么必须是一次调用：中间态「已绑 2 个大核但 n_threads 还是 8」比完全不
   * 调优更慢（ggml 的 matmul 有同步屏障，计算耗时由最慢的那个线程决定）。
   * 所以「定目标核 → 绑大核 → 提优先级 → 压后台线程 → 抬 rlimit → 降 oom
   * 被杀概率」必须在一次调用里做完。
   */
  applyTuning(config: TuningConfig): Promise<TuningReport>;
  /**
   * 只按前缀白名单重新绑定推理工作线程（pidInside/tid 扫描），不做别的。
   * 由 native 侧以 rebindIntervalMs 限流调用。
   */
  rebindWorkers(prefixes: string[], cpus: number[]): Promise<RebindResult>;
  /** 回读当前所有调度相关值的真实状态 */
  getTuningReport(): Promise<TuningReport>;
  /**
   * 标记推理忙 / 闲。忙时才周期性重绑 worker —— worker 按需创建又回收，
   * 只在启动时绑一次会漏掉后续新建的。
   */
  setBusy(busy: boolean): Promise<boolean>;
  lockModel(path: string): Promise<MlockReport>;
  unlockModel(path: string): Promise<boolean>;
  unlockAllModels(): Promise<number>;
  /** 本机所有 IPv4 地址（含热点/以太网/APIPA 过滤） */
  getLanIpAddresses(): Promise<string[]>;
}

export default TurboModuleRegistry.get<Spec>('PerfTune');
