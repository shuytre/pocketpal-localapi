import {NativeEventEmitter, NativeModules, Platform} from 'react-native';

import NativeLocalApiServer from '../../specs/NativeLocalApiServer';
import type {
  LocalApiServerConfig,
  LocalApiServerStatus,
} from '../../specs/NativeLocalApiServer';

import {executeChatCompletion} from './requestExecutor';
import type {ExecutionOptions} from './requestExecutor';
import type {ApiRequestEvent, CallRecord, CallStats} from './types';

/** Android-only：这两个 TurboModule 没有 iOS 实现，get() 在 iOS 返回 null。 */
export const localApiSupported = Platform.OS === 'android';

let emitter: NativeEventEmitter | null = null;

/**
 * 事件订阅源。
 *
 * 不能依赖 `NativeModules.LocalApiServer` 一定存在：在新架构下 TurboModule 是
 * 按 JSI 惰性创建的，通常不在 NativeModules 注册表里。不带参数构造时
 * NativeEventEmitter 会直接订阅 RCTDeviceEventEmitter —— 而原生侧正是用
 * `getJSModule(RCTDeviceEventEmitter).emit(...)` 发事件的，两边正好对上。
 */
const getEmitter = (): NativeEventEmitter | null => {
  if (!localApiSupported) {
    return null;
  }
  if (emitter === null) {
    const moduleRef = NativeModules?.LocalApiServer;
    emitter = moduleRef ? new NativeEventEmitter(moduleRef) : new NativeEventEmitter();
  }
  return emitter;
};

const CALL_LOG_LIMIT = 200;

export interface LocalApiRecordSink {
  /** 调用开始：用于在列表里先占一个「进行中」的位置 */
  onRequestStart(event: ApiRequestEvent): void;
  onRequestEnd(record: CallRecord): void;
  getExecutionOptions(): ExecutionOptions;
}

/**
 * 服务的启停与请求调度。
 *
 * 这里是唯一订阅原生事件的地方 —— 订阅一次、常驻，避免每个请求都 addListener
 * （那样不仅慢，还会漏：事件在 try/catch 之外到达时就没人接了）。
 */
class LocalApiBridge {
  private subscription: {remove(): void} | null = null;
  private sink: LocalApiRecordSink | null = null;
  private active = new Map<string, ApiRequestEvent>();

  attachSink(sink: LocalApiRecordSink): void {
    this.sink = sink;
  }

  isListening(): boolean {
    return this.subscription !== null;
  }

  startListening(): void {
    if (this.subscription !== null) {
      return;
    }
    const nativeEmitter = getEmitter();
    if (!nativeEmitter) {
      return;
    }
    this.subscription = nativeEmitter.addListener(
      'LocalApiServerRequest',
      (event: ApiRequestEvent) => {
        void this.handle(event);
      },
    );
  }

  stopListening(): void {
    this.subscription?.remove();
    this.subscription = null;
  }

  private async handle(event: ApiRequestEvent): Promise<void> {
    const sink = this.sink;
    const startedAt = Date.now();
    this.active.set(event.requestId, event);
    sink?.onRequestStart(event);
    // 访问日志：控制台是最省事又可查的地方，不需要额外的日志基础设施。
    console.log(
      `[LocalApi] ${event.method} ${event.path} from ${event.remoteIp} stream=${event.stream}`,
    );

    const outcome = await executeChatCompletion(
      event,
      sink?.getExecutionOptions() ?? {
        defaultMaxTokens: 1024,
        defaultTemperature: 0.7,
      },
    );

    const preview = extractPreview(event.body);
    const record: CallRecord = {
      id: `${event.requestId}-${startedAt}`,
      requestId: event.requestId,
      startedAt,
      endedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      model: event.model,
      remoteIp: event.remoteIp,
      stream: event.stream,
      status: outcome.status,
      promptTokens: outcome.promptTokens,
      completionTokens: outcome.completionTokens,
      droppedTokens: 0,
      error: outcome.error,
      preview,
    };
    this.active.delete(event.requestId);
    sink?.onRequestEnd(record);
  }

  async start(config: LocalApiServerConfig): Promise<LocalApiServerStatus | null> {
    if (!NativeLocalApiServer) {
      return null;
    }
    this.startListening();
    return await NativeLocalApiServer.start(config);
  }

  async stop(): Promise<boolean> {
    if (!NativeLocalApiServer) {
      return false;
    }
    const ok = await NativeLocalApiServer.stop();
    this.stopListening();
    return ok;
  }

  async refreshStatus(): Promise<LocalApiServerStatus | null> {
    if (!NativeLocalApiServer) {
      return null;
    }
    try {
      return await NativeLocalApiServer.getStatus();
    } catch {
      return null;
    }
  }

  async setModelReady(ready: boolean, modelName: string): Promise<void> {
    try {
      await NativeLocalApiServer?.setModelReady(ready, modelName);
    } catch {
      // 模型就绪只是让 503 变 200 的开关，失败不影响别的东西。
    }
  }

  async getLanIpAddresses(): Promise<string[]> {
    try {
      return (await NativeLocalApiServer?.getLanIpAddresses()) ?? [];
    } catch {
      return [];
    }
  }

  /** 当前 JS 侧已知在处理多少请求 —— UI 上的「进行中」计数。 */
  inFlightCount(): number {
    return this.active.size;
  }
}

function extractPreview(body: string): string {
  try {
    const parsed = JSON.parse(body || '{}');
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const content = messages[i]?.content;
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.map((part: {text?: string}) => part?.text ?? '').join(' ')
            : '';
      if (text.trim().length > 0) {
        return text.trim().slice(0, 120);
      }
    }
  } catch {
    return '';
  }
  return '';
}

export const summarizeCalls = (records: CallRecord[]): CallStats => {
  const completed = records.filter(record => record.durationMs > 0);
  const failed = records.filter(record => record.status >= 400);
  const totalDuration = records.reduce((sum, record) => sum + record.durationMs, 0);
  return {
    total: records.length,
    streaming: records.filter(record => record.stream).length,
    failed: failed.length,
    completionTokens: records.reduce((sum, record) => sum + record.completionTokens, 0),
    promptTokens: records.reduce((sum, record) => sum + record.promptTokens, 0),
    droppedTokens: records.reduce((sum, record) => sum + record.droppedTokens, 0),
    rejectedByServer: records.filter(record => record.status === 503).length,
    averageDurationMs: completed.length > 0 ? Math.round(totalDuration / completed.length) : 0,
    lastCallAt: records.length > 0 ? records[0].endedAt : undefined,
  };
};

export const localApiBridge = new LocalApiBridge();
export {CALL_LOG_LIMIT};
export type {LocalApiServerConfig, LocalApiServerStatus};
