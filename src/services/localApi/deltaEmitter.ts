/**
 * JS 侧聚合 —— 三层削减的第一层，削减对象是 **RN 桥调用次数**。
 *
 * 为什么需要这一层：每次把增量送过桥都是一趟完整的 JNI → Java → 队列写入，
 * 固定开销亚毫秒级；而 token 回调约 30~60ms 一次，逐 token 调用会让固定开销
 * 占掉可观比例。
 *
 * 为什么用 setTimeout 而不是定时轮询：定时轮询会在整个请求生命周期内（长回答
 * 可能几分钟）持续唤醒 JS 线程；setTimeout 只在「有尚未发送的内容」时存在。
 *
 * 为什么只在没有待发内容时才挂定时器：连续 push 会不断刷新缓冲，重复挂定时器
 * 会导致同一批内容被多次下发。
 */
export const JS_FLUSH_MIN_CHARS = 20;
export const JS_FLUSH_MAX_LATENCY_MS = 30;

export class ThrottledDeltaEmitter {
  private buffer = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  private readonly minChars: number;
  private readonly maxLatencyMs: number;

  constructor(
    private readonly onFlush: (chunk: string) => void,
    minChars: number = JS_FLUSH_MIN_CHARS,
    maxLatencyMs: number = JS_FLUSH_MAX_LATENCY_MS,
  ) {
    this.minChars = minChars;
    this.maxLatencyMs = maxLatencyMs;
  }

  push(delta: string): void {
    if (this.closed || !delta) {
      return;
    }
    this.buffer += delta;
    if (this.buffer.length >= this.minChars) {
      this.flushNow();
      return;
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flushNow();
      }, this.maxLatencyMs);
    }
  }

  flushNow(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) {
      return;
    }
    const chunk = this.buffer;
    // 复用同一个缓冲：每次新建字符串会让 GC 在 token 级频率下持续被打扰。
    this.buffer = '';
    try {
      this.onFlush(chunk);
    } catch {
      // 桥另一侧的失败不能影响推理本身 —— 已发生的就是丢了一块内容，
      // 后端仍在继续吐句子，继续跑比崩掉好。
    }
  }

  close(): void {
    this.flushNow();
    this.closed = true;
  }
}
