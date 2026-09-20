/**
 * 本地局域网 API 服务的对外数据结构。
 *
 * 与原生侧（android/.../localapi/*.kt）的字段一一对应：原生负责 HTTP 语义，
 * JS 负责语义之外的记账与展示。改名时必须两侧同步，否则会出现「UI 上永远 0 调用」
 * 这种最难查的问题。
 */

export type LocalApiRole =
  | 'system'
  | 'user'
  | 'assistant'
  | 'tool'
  | 'developer';

/** OpenAI 的 content 既可以是纯字符串，也可以是多模态分片数组。 */
export type LocalApiContent =
  | string
  | Array<{type: string; text?: string; image_url?: {url?: string}}>;

export interface LocalApiMessage {
  role: LocalApiRole;
  content: LocalApiContent;
  name?: string;
}

/** /v1/chat/completions 的请求体。未知字段一律忽略，不报错。 */
export interface ChatCompletionBody {
  model?: string;
  messages?: LocalApiMessage[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
  n_predict?: number;
  stop?: string | string[];
  stream?: boolean;
  presence_penalty?: number;
  frequency_penalty?: number;
}

/** 原生模块下发到 JS 的请求事件。 */
export interface ApiRequestEvent {
  requestId: string;
  method: string;
  path: string;
  body: string;
  remoteIp: string;
  stream: boolean;
  model: string;
}

/**
 * 一条调用记录 —— 管理界面就靠它回答「什么时候被调了、调了多少、有没有出错」。
 */
export interface CallRecord {
  id: string;
  requestId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  model: string;
  remoteIp: string;
  stream: boolean;
  status: number;
  promptTokens: number;
  completionTokens: number;
  droppedTokens: number;
  error?: string;
  /** 请求预览：最后一条 user 消息的前若干字符 */
  preview: string;
}

export interface CallStats {
  total: number;
  streaming: number;
  failed: number;
  completionTokens: number;
  promptTokens: number;
  droppedTokens: number;
  rejectedByServer: number;
  averageDurationMs: number;
  lastCallAt?: number;
}
