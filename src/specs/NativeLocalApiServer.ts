import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

/**
 * native 侧 HTTP 服务的全部参数。每个字段都对应 UI 上一项可调设置或
 * 一处性能阈值 —— 没有藏在实现里的魔法数字。
 */
export type LocalApiServerConfig = {
  port: number;
  apiKey: string;
  requireApiKey: boolean;
  allowCors: boolean;
  corsAllowOrigin: string;
  /** 有界线程池大小：按「在传输的请求」计，不是并发连接数 */
  workerThreads: number;
  requestQueueSize: number;
  /** 同时决定请求体读取上限与 keep-alive 空闲读超时（双重身份，见实现注释） */
  socketReadTimeoutMs: number;
  maxBodyBytes: number;
  /** 有界等待位：超出直接 503 */
  maxWaiting: number;
  permitTimeoutMs: number;
  /** 增量队列容量。满时丢弃（不做阻塞），丢弃数会计入状态 */
  tokenQueueCapacity: number;
  drainWindowMs: number;
  sseMinChars: number;
  sseMaxLatencyMs: number;
  sseHeartbeatMs: number;
  requestTimeoutMs: number;
};

export type LocalApiServerStatus = {
  running: boolean;
  port: number;
  host: string;
  baseUrls: string[];
  modelReady: boolean;
  modelName: string;
  uptimeMs: number;
  // 排查「为什么一直 503」时，这几个数字比任何日志都直接。
  inferenceBusy: boolean;
  inferenceWaiting: number;
  inferenceRejected: number;
  httpConnections: number;
  httpThreads: number;
  httpThreadsActive: number;
  requestsServed: number;
  streamingRequests: number;
  failedRequests: number;
  /** 增量队列满而丢弃的 token 累计 —— 必须可观测 */
  droppedTokens: number;
  /** 64KB 管道溢出而丢弃的帧数（客户端读得太慢时才会发生） */
  pipeDroppedFrames: number;
  /** 管道中尚未写出的字节数 */
  pipePendingBytes: number;
  lastError: string;
};

export interface Spec extends TurboModule {
  start(config: LocalApiServerConfig): Promise<LocalApiServerStatus>;
  stop(): Promise<boolean>;
  getStatus(): Promise<LocalApiServerStatus>;
  /** JS 侧在模型加载/卸载时同步，用于决定 200 还是 503 */
  setModelReady(ready: boolean, modelName: string): Promise<boolean>;
  /** 推理航路的一个 token 增量 */
  pushToken(requestId: string, text: string): Promise<boolean>;
  pushFinish(
    requestId: string,
    finishReason: string,
    promptTokens: number,
    completionTokens: number,
  ): Promise<boolean>;
  pushError(
    requestId: string,
    status: number,
    message: string,
  ): Promise<boolean>;
  getLanIpAddresses(): Promise<string[]>;
}

export default TurboModuleRegistry.get<Spec>('LocalApiServer');
