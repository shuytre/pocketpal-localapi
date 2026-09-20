import {makeAutoObservable, runInAction, reaction} from 'mobx';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {makePersistable} from 'mobx-persist-store';

import {modelStore} from './ModelStore';
import NativePerfTune from '../specs/NativePerfTune';
import type {
  TopologyInfo,
  TuningConfig,
  TuningReport,
  MlockReport,
} from '../specs/NativePerfTune';
import type {LocalApiServerStatus} from '../specs/NativeLocalApiServer';

import {
  localApiBridge,
  CALL_LOG_LIMIT,
  type LocalApiServerConfig,
} from '../services/localApi/localApiBridge';
import {setModelResident} from '../services/localApi/residencyGuard';
import type {ApiRequestEvent, CallRecord, CallStats} from '../services/localApi/types';
import {summarizeCalls} from '../services/localApi/localApiBridge';

/** 默认值集中在这里；UI 与推荐 profile 都以它为基准改。 */
const DEFAULTS = {
  port: 8080,
  apiKey: '',
  requireApiKey: false,
  allowCors: true,
  corsAllowOrigin: '*',
  workerThreads: 4,
  requestQueueSize: 64,
  socketReadTimeoutMs: 60_000,
  maxBodyBytes: 8 * 1024 * 1024,
  maxWaiting: 4,
  permitTimeoutMs: 120_000,
  tokenQueueCapacity: 256,
  drainWindowMs: 40,
  sseMinChars: 12,
  sseMaxLatencyMs: 60,
  sseHeartbeatMs: 15_000,
  requestTimeoutMs: 600_000,
  forceCoreCount: 2,
  bindBigCores: true,
  enablePriority: true,
  niceTarget: -20,
  enableRealTime: false,
  rtPriority: 1,
  yieldBackground: true,
  backgroundNice: 10,
  rebindIntervalMs: 250,
  raiseNiceRlimit: true,
  raiseMemlockRlimit: true,
  applyOomAdj: true,
  oomAdjTarget: -100,
  defaultMaxTokens: 1024,
  defaultTemperature: 0.7,
};

class LocalApiStore {
  // ── 持久化配置 ────────────────────────────────────────────────────────
  /**
   * 开关：手动启停 HTTP 服务。
   *
   * 默认开 —— 需求 8 要求打开 App 就自动进入最佳性能模式，不该要求用户先去
   * 找到开关再点一次。用户仍然可以关掉，关掉后一切回到改造前的状态。
   */
  serviceEnabled = true;
  autoStartOnBoot = true;
  keepModelResident = true;
  mlockEnabled = true;
  port = DEFAULTS.port;
  apiKey = DEFAULTS.apiKey;
  requireApiKey = DEFAULTS.requireApiKey;
  allowCors = DEFAULTS.allowCors;
  corsAllowOrigin = DEFAULTS.corsAllowOrigin;
  defaultMaxTokens = DEFAULTS.defaultMaxTokens;
  defaultTemperature = DEFAULTS.defaultTemperature;

  /** HTTP 层高级参数 */
  workerThreads = DEFAULTS.workerThreads;
  requestQueueSize = DEFAULTS.requestQueueSize;
  socketReadTimeoutMs = DEFAULTS.socketReadTimeoutMs;
  maxBodyBytes = DEFAULTS.maxBodyBytes;
  maxWaiting = DEFAULTS.maxWaiting;
  permitTimeoutMs = DEFAULTS.permitTimeoutMs;
  tokenQueueCapacity = DEFAULTS.tokenQueueCapacity;
  drainWindowMs = DEFAULTS.drainWindowMs;
  sseMinChars = DEFAULTS.sseMinChars;
  sseMaxLatencyMs = DEFAULTS.sseMaxLatencyMs;
  sseHeartbeatMs = DEFAULTS.sseHeartbeatMs;
  requestTimeoutMs = DEFAULTS.requestTimeoutMs;

  /** 调度调优参数 */
  forceCoreCount = DEFAULTS.forceCoreCount;
  bindBigCores = DEFAULTS.bindBigCores;
  enablePriority = DEFAULTS.enablePriority;
  niceTarget = DEFAULTS.niceTarget;
  enableRealTime = DEFAULTS.enableRealTime;
  rtPriority = DEFAULTS.rtPriority;
  yieldBackground = DEFAULTS.yieldBackground;
  backgroundNice = DEFAULTS.backgroundNice;
  rebindIntervalMs = DEFAULTS.rebindIntervalMs;
  raiseNiceRlimit = DEFAULTS.raiseNiceRlimit;
  raiseMemlockRlimit = DEFAULTS.raiseMemlockRlimit;
  applyOomAdj = DEFAULTS.applyOomAdj;
  oomAdjTarget = DEFAULTS.oomAdjTarget;

  // ── 运行时状态（不持久化）────────────────────────────────────────────
  running = false;
  status: LocalApiServerStatus | null = null;
  ipAddresses: string[] = [];
  lastError: string | null = null;
  tuningReport: TuningReport | null = null;
  topology: TopologyInfo | null = null;
  mlockReport: MlockReport | null = null;
  profileLabel = '未识别';
  profileConfidence: 'high' | 'medium' | 'low' = 'low';
  profileReasons: string[] = [];
  bootstrapped = false;

  callRecords: CallRecord[] = [];
  inFlight: ApiRequestEvent[] = [];

  private lifecycleDisposer: (() => void) | null = null;

  constructor() {
    makeAutoObservable(this, {}, {autoBind: true});

    makePersistable(this, {
      name: 'LocalApiStore',
      properties: [
        'serviceEnabled',
        'autoStartOnBoot',
        'keepModelResident',
        'mlockEnabled',
        'port',
        'apiKey',
        'requireApiKey',
        'allowCors',
        'corsAllowOrigin',
        'defaultMaxTokens',
        'defaultTemperature',
        'workerThreads',
        'requestQueueSize',
        'socketReadTimeoutMs',
        'maxBodyBytes',
        'maxWaiting',
        'permitTimeoutMs',
        'tokenQueueCapacity',
        'drainWindowMs',
        'sseMinChars',
        'sseMaxLatencyMs',
        'sseHeartbeatMs',
        'requestTimeoutMs',
        'forceCoreCount',
        'bindBigCores',
        'enablePriority',
        'niceTarget',
        'enableRealTime',
        'rtPriority',
        'yieldBackground',
        'backgroundNice',
        'rebindIntervalMs',
        'raiseNiceRlimit',
        'raiseMemlockRlimit',
        'applyOomAdj',
        'oomAdjTarget',
        'callRecords',
      ],
      storage: AsyncStorage,
    });

    localApiBridge.attachSink({
      onRequestStart: this.handleRequestStart,
      onRequestEnd: this.handleRequestEnd,
      getExecutionOptions: () => ({
        defaultMaxTokens: this.defaultMaxTokens,
        defaultTemperature: this.defaultTemperature,
      }),
    });
  }

  // ── 派生数据 ──────────────────────────────────────────────────────────

  /** Base URL —— UI 必须展示它，因为用户要原样填到客户端里。 */
  get baseUrls(): string[] {
    const port = this.status?.port ?? this.port;
    return this.ipAddresses.map(ip => `http://${ip}:${port}/v1`);
  }

  get callStats(): CallStats {
    return summarizeCalls(this.callRecords);
  }

  /**
   * 丢弃的 token 数。
   *
   * 必须可观测：丢字表现为「回答中间少了几个字」，用户无从判断是模型问题还是
   * 服务问题。权威数字在 native（增量队列满时 offer 失败的累计次数），
   * 这里以它为准。
   */
  get droppedTokens(): number {
    return this.status?.droppedTokens ?? 0;
  }

  get tuningConfig(): TuningConfig {
    return {
      forceCoreCount: this.forceCoreCount,
      bindBigCores: this.bindBigCores,
      enablePriority: this.enablePriority,
      niceTarget: this.niceTarget,
      enableRealTime: this.enableRealTime,
      rtPriority: this.rtPriority,
      yieldBackground: this.yieldBackground,
      backgroundNice: this.backgroundNice,
      backgroundPrefixes: DEFAULT_BACKGROUND_PREFIXES,
      workerPrefixes: DEFAULT_WORKER_PREFIXES,
      rebindIntervalMs: this.rebindIntervalMs,
      raiseNiceRlimit: this.raiseNiceRlimit,
      raiseMemlockRlimit: this.raiseMemlockRlimit,
      applyOomAdj: this.applyOomAdj,
      oomAdjTarget: this.oomAdjTarget,
    };
  }

  get serverConfig(): LocalApiServerConfig {
    return {
      port: this.port,
      apiKey: this.apiKey,
      requireApiKey: this.requireApiKey,
      allowCors: this.allowCors,
      corsAllowOrigin: this.corsAllowOrigin,
      workerThreads: this.workerThreads,
      requestQueueSize: this.requestQueueSize,
      socketReadTimeoutMs: this.socketReadTimeoutMs,
      maxBodyBytes: this.maxBodyBytes,
      maxWaiting: this.maxWaiting,
      permitTimeoutMs: this.permitTimeoutMs,
      tokenQueueCapacity: this.tokenQueueCapacity,
      drainWindowMs: this.drainWindowMs,
      sseMinChars: this.sseMinChars,
      sseMaxLatencyMs: this.sseMaxLatencyMs,
      sseHeartbeatMs: this.sseHeartbeatMs,
      requestTimeoutMs: this.requestTimeoutMs,
    };
  }

  // ── 服务启停 ──────────────────────────────────────────────────────────

  async startService(): Promise<boolean> {
    try {
      const status = await localApiBridge.start(this.serverConfig);
      const ips = await localApiBridge.getLanIpAddresses();
      runInAction(() => {
        this.status = status;
        this.running = status?.running ?? false;
        this.ipAddresses = ips;
        this.lastError = status?.lastError || null;
      });
      await localApiBridge.setModelReady(
        Boolean(modelStore.context),
        modelStore.activeModel?.name ?? 'unknown',
      );
      return this.running;
    } catch (error) {
      runInAction(() => {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.running = false;
      });
      return false;
    }
  }

  async stopService(): Promise<boolean> {
    const ok = await localApiBridge.stop();
    runInAction(() => {
      this.running = false;
      this.status = null;
    });
    return ok;
  }

  async refresh(): Promise<void> {
    const status = await localApiBridge.refreshStatus();
    const ips = await localApiBridge.getLanIpAddresses();
    runInAction(() => {
      this.status = status;
      this.running = status?.running ?? false;
      this.ipAddresses = ips;
      if (status?.lastError) {
        this.lastError = status.lastError;
      }
    });
  }

  async applyRuntimeConfig(): Promise<void> {
    // 端口 / 鉴权 / SSE 参数变更都靠重启生效：HTTP 监听 socket 不能热改。
    if (this.running) {
      await this.startService();
      return;
    }
    await this.refresh();
  }

  // ── 调优 ──────────────────────────────────────────────────────────────

  /**
   * 原子应用调优。
   *
   * 必须一次调用完成整套：中间态「已绑 2 个大核但 n_threads 还是 8」比完全不
   * 调优更慢（ggml 的 matmul 有同步屏障，慢线程拖住快线程）。
   */
  async applyTuning(): Promise<TuningReport | null> {
    if (!NativePerfTune) {
      return null;
    }
    try {
      const topology = await NativePerfTune.detectTopology();
      const report = await NativePerfTune.applyTuning(this.tuningConfig);
      runInAction(() => {
        this.topology = topology;
        this.tuningReport = report;
      });
      return report;
    } catch (error) {
      runInAction(() => {
        this.lastError = error instanceof Error ? error.message : String(error);
      });
      return null;
    }
  }

  async refreshTuningReport(): Promise<void> {
    if (!NativePerfTune) {
      return;
    }
    try {
      const report = await NativePerfTune.getTuningReport();
      runInAction(() => {
        this.tuningReport = report;
      });
    } catch {
      // 旁路：报告刷新失败不影响服务。
    }
  }

  /**
   * n_threads 必须与实际被绑定的核数对齐 —— 不是高频簇的大小。
   *
   * 两者必须来自同一个数字，否则会出现「绑了 2 个核但起了 8 个线程」，
   * 那比完全不调优更慢。对齐时取 min(用户设置的线程数, 目标核数)，
   * 尊重用户设的更小值。
   */
  alignThreadCount(targetCoreCount: number): number {
    if (targetCoreCount <= 0) {
      return modelStore.contextInitParams.n_threads;
    }
    const requested = modelStore.contextInitParams.n_threads ?? targetCoreCount;
    const aligned = Math.min(requested, targetCoreCount);
    if (aligned !== requested) {
      modelStore.setNThreads(aligned);
    }
    return aligned;
  }

  // ── 模型生命周期联动 ──────────────────────────────────────────────────

  /**
   * 两个联动都在这里：
   *
   * 1. 模型加载/卸载要同步给 native 的 503 判定 —— 否则外部客户端会拿到一个
   *    200 但空内容的回答。
   * 2. 内存锁定跟随模型：加载后锁定权重页，卸载时同步解锁，否则换模型后旧模型
   *    的页会被一直钉住，内存只增不减。
   */
  startModelLifecycleWatch(): void {
    if (this.lifecycleDisposer) {
      return;
    }
    this.lifecycleDisposer = reaction(
      () => ({
        contextId: modelStore.context?.id,
        modelId: modelStore.activeModelId,
        modelName: modelStore.activeModel?.name ?? '',
        hasContext: Boolean(modelStore.context),
      }),
      async data => {
        await localApiBridge.setModelReady(
          data.hasContext,
          data.modelName || 'unknown',
        );
        await this.syncMemoryLock(data.hasContext, data.modelId, data.modelName);
      },
      {fireImmediately: true},
    );
  }

  stopModelLifecycleWatch(): void {
    this.lifecycleDisposer?.();
    this.lifecycleDisposer = null;
  }

  private async syncMemoryLock(
    hasContext: boolean,
    modelId?: string,
    modelName: string = '',
  ): Promise<void> {
    if (!NativePerfTune) {
      return;
    }
    if (!hasContext || !modelId) {
      // 卸载时必须释放 —— 否则旧模型的页会被一直钉住。
      try {
        await NativePerfTune.unlockAllModels();
        runInAction(() => {
          this.mlockReport = null;
        });
      } catch {
        // ignore
      }
      return;
    }
    if (!this.mlockEnabled) {
      return;
    }
    try {
      const model = modelStore.models.find(item => item.id === modelId);
      if (!model) {
        return;
      }
      const path = await modelStore.getModelFullPath(model);
      if (!path) {
        return;
      }
      const report = await NativePerfTune.lockModel(path);
      runInAction(() => {
        this.mlockReport = report;
      });
      console.log(`[LocalApi] mlock ${modelName}: ${report.note}`);
    } catch (error) {
      console.warn('[LocalApi] mlock failed:', error);
    }
  }

  /**
   * UI 手动切换 mlock 时的两条入口。
   *
   * 锁定/解锁必须成对：munmap 会连带释放 mlock 计数，反过来，只在关闭时
   * 「不再调用」而不显式解锁，旧模型的页会被一直钉住 —— 换模型后内存只增不减。
   */
  async syncMemoryLockForActiveModel(): Promise<void> {
    const model = modelStore.activeModel;
    if (!model || !modelStore.context) {
      return;
    }
    await this.syncMemoryLock(true, model.id, model.name);
  }

  async releaseMemoryLock(): Promise<void> {
    if (!NativePerfTune) {
      return;
    }
    try {
      await NativePerfTune.unlockAllModels();
      runInAction(() => {
        this.mlockReport = null;
      });
    } catch {
      // 解锁失败不阻断任何主流程。
    }
  }

  // ── 调用记账 ──────────────────────────────────────────────────────────

  handleRequestStart = (event: ApiRequestEvent): void => {
    runInAction(() => {
      this.inFlight.unshift(event);
      if (this.inFlight.length > 16) {
        this.inFlight.length = 16;
      }
    });
  };

  handleRequestEnd = (record: CallRecord): void => {
    runInAction(() => {
      this.inFlight = this.inFlight.filter(
        item => item.requestId !== record.requestId,
      );
      this.callRecords.unshift(record);
      if (this.callRecords.length > CALL_LOG_LIMIT) {
        this.callRecords.length = CALL_LOG_LIMIT;
      }
    });
  };

  clearCallLog = (): void => {
    runInAction(() => {
      this.callRecords = [];
    });
  };

  // ── 配置写入 ──────────────────────────────────────────────────────────

  setKeepModelResident = (value: boolean): void => {
    this.keepModelResident = value;
    setModelResident(value && this.serviceEnabled);
  };

  setServiceEnabled = (value: boolean): void => {
    this.serviceEnabled = value;
    setModelResident(value && this.keepModelResident);
  };
}

export const DEFAULT_WORKER_PREFIXES = [
  'ggml',
  'llama',
  'Llama',
  'gguf',
  'llama.cpp',
  'llama-embed',
];

export const DEFAULT_BACKGROUND_PREFIXES = [
  'OkHttp',
  'okhttp',
  'DownloadWorker',
  'download',
  'pool-',
  'AsyncTask',
  'DefaultDispatcher',
];

export const LOCAL_API_DEFAULTS = DEFAULTS;

export const localApiStore = new LocalApiStore();
