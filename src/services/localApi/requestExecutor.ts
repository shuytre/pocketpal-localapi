import {toJS} from 'mobx';

import {modelStore} from '../../store/ModelStore';
import {toApiCompletionParams} from '../../utils/completionTypes';
import type {CompletionParams} from '../../utils/completionTypes';
import NativeLocalApiServer from '../../specs/NativeLocalApiServer';
import NativePerfTune from '../../specs/NativePerfTune';

import {ThrottledDeltaEmitter} from './deltaEmitter';
import type {
  ApiRequestEvent,
  ChatCompletionBody,
  LocalApiContent,
  LocalApiMessage,
} from './types';

const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TEMPERATURE = 0.7;

export interface ExecutionOptions {
  defaultMaxTokens: number;
  defaultTemperature: number;
}

export interface ExecutionOutcome {
  status: number;
  promptTokens: number;
  completionTokens: number;
  content: string;
  error?: string;
}

/**
 * OpenAI 的 content 允许是分片数组，llama.rn 只要纯文本。
 * 非文本分片（图片等）直接忽略 —— 这条路本就只做文本补全。
 */
function normalizeContent(content: LocalApiContent): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map(part => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}

function toCompletionMessages(messages: LocalApiMessage[]) {
  return messages
    .map(message => ({
      role: message.role,
      content: normalizeContent(message.content),
    }))
    .filter(message => message.content.length > 0);
}

function normalizeStop(stop?: string | string[]): string[] | undefined {
  if (!stop) {
    return undefined;
  }
  return Array.isArray(stop) ? stop : [stop];
}

/**
 * 处理一条 /v1/chat/completions 请求。
 *
 * 推理完全复用 ModelStore 已加载的 llama.rn 上下文 —— 不新建第二个 llama.cpp
 * 实例（8GB 机型上两份实例会直接把内存打穿），也不重复实现任何推理逻辑。
 */
export async function executeChatCompletion(
  event: ApiRequestEvent,
  options: ExecutionOptions,
): Promise<ExecutionOutcome> {
  const context = modelStore.context;
  const activeModel = modelStore.activeModel;

  const finishLater = async (
    status: number,
    content: string,
    promptTokens = 0,
    completionTokens = 0,
    error?: string,
  ): Promise<ExecutionOutcome> => {
    try {
      await NativeLocalApiServer?.pushFinish(
        event.requestId,
        error ? 'error' : 'stop',
        promptTokens,
        completionTokens,
      );
    } catch {
      // native 已经不在（服务刚被关掉）—— 调用方的记账仍然继续。
    }
    try {
      await NativePerfTune?.setBusy(false);
    } catch {
      // 同上：旁路状态，失败不值钱。
    }
    return {status, promptTokens, completionTokens, content, error};
  };

  const failWith = async (status: number, message: string) => {
    try {
      await NativeLocalApiServer?.pushError(event.requestId, status, message);
    } catch {
      // ignore
    }
    try {
      await NativePerfTune?.setBusy(false);
    } catch {
      // ignore
    }
    return {status, promptTokens: 0, completionTokens: 0, content: '', error: message};
  };

  if (!context || !activeModel) {
    return failWith(503, 'Model is not loaded. Load a model in PocketPal first.');
  }

  let body: ChatCompletionBody;
  try {
    body = JSON.parse(event.body || '{}') as ChatCompletionBody;
  } catch {
    return failWith(400, 'Invalid JSON body.');
  }

  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  if (rawMessages.length === 0) {
    return failWith(400, 'Field "messages" is required and must not be empty.');
  }

  const messages = toCompletionMessages(rawMessages);
  if (messages.length === 0) {
    return failWith(400, 'Every message needs non-empty text content.');
  }

  const stopWords = toJS(activeModel.stopWords);
  const modelStop =
    Array.isArray(stopWords) && stopWords.length > 0 ? stopWords : undefined;
  const nPredict =
    body.max_tokens ?? body.n_predict ?? options.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;

  // 请求带的 stop 优先于模型自带的 stop words：客户端的意图更具体。
  const stop = normalizeStop(body.stop) ?? modelStop;

  // llama.rn 的 role 联合类型比 OpenAI 的窄（没有 developer 之类），
  // 这里一次性收敛到原生参数类型，避免逐字段断言。
  const params = {
    messages: messages.map(message => ({
      role: message.role,
      content: message.content,
    })),
    n_predict: nPredict,
    temperature: body.temperature ?? options.defaultTemperature ?? DEFAULT_TEMPERATURE,
    ...(body.top_p !== undefined ? {top_p: body.top_p} : {}),
    ...(body.top_k !== undefined ? {top_k: body.top_k} : {}),
    ...(stop ? {stop} : {}),
  } as unknown as CompletionParams;

  try {
    await NativePerfTune?.setBusy(true);
  } catch {
    // 调优遥不可达时照常服务。
  }

  // 桥调用的第一层削减：20 字符 / 30ms，命中任一即发。
  const emitter = new ThrottledDeltaEmitter(chunk => {
    void NativeLocalApiServer?.pushToken(event.requestId, chunk);
  });

  try {
    const result = await context.completion(
      toApiCompletionParams(params),
      data => {
        // llama.rn 会把推理过程也吐到这里；对外只发正文。
        const token = data.token ?? data.content;
        if (token) {
          emitter.push(token);
        }
      },
    );

    emitter.close();

    const completionTokens =
      result?.tokens_predicted ?? result?.timings?.predicted_n ?? 0;
    const promptTokens = result?.tokens_evaluated ?? result?.timings?.prompt_n ?? 0;

    return await finishLater(
      200,
      result?.content ?? result?.text ?? '',
      promptTokens,
      completionTokens,
    );
  } catch (error) {
    emitter.close();
    const message = error instanceof Error ? error.message : String(error);
    // 推理异常也要给出明确错误码，而不是让连接的另一端挂住等超时。
    return failWith(500, `inference failed: ${message}`);
  }
}
