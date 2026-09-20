package com.pocketpal.localapi

import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.Semaphore
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

data class ResponseSummary(
    val status: Int,
    val finishReason: String?,
    val promptTokens: Int,
    val completionTokens: Int,
    val errorMessage: String?,
)

/**
 * 一条正在服务的请求。
 *
 * 两条路径在这里汇合：
 *  - JS → native：token 增量进 `tokenQueue`（满则丢弃并计数 —— 阻塞 JS 线程会
 *    连带卡住整个 UI，所以必须 offer 而不是 put；丢弃数要上报，因为「回答中间
 *    少了几个字」用户根本无从判断是模型问题还是服务问题）。
 *  - native → socket：成型帧进 `frames`，由唯一写者（HTTP 工作线程）顺序写出。
 *
 * 队列衔接的意义：排空跑在被调优的专用线程上，而写 socket 必须一直在 HTTP 工作
 * 线程上完成 —— 两边靠这些队列解耦，谁也不阻塞谁。
 */
class RequestContext(
    val id: String,
    val stream: Boolean,
    val modelName: String,
    val tokenQueueCapacity: Int,
) {
  val tokenQueue = ArrayBlockingQueue<String>(tokenQueueCapacity)
  val frames = LinkedBlockingQueue<ByteArray>()
  val finishLatch = CountDownLatch(1)

  // 批次缓冲：每批次新建 StringBuilder 会让 GC 在 token 级频率下持续被打扰。
  val batch = StringBuilder(256)
  val accumulated = StringBuilder(4096)

  @Volatile var batchStartMs = 0L

  @Volatile var lastActivityMs = System.currentTimeMillis()

  @Volatile var finished = false

  @Volatile var summary: ResponseSummary? = null

  @Volatile var droppedTokens = 0L

  @Volatile var pushedTokens = 0

  /**
   * 成型帧的字节数预算 —— 需求 4 要求的「64KB 缓冲管道」。
   *
   * 为什么必须是有界的：排空侧（专用推理线程）和写 socket 侧（HTTP 工作线程）
   * 是两条线程。若帧队列无界，一旦客户端读得慢（慢速代理、笔记本休眠唤醒），
   * 内存里就会堆起整个回答的帧 —— 而我们的目标恰恰是让模型常驻内存。
   * 有界之后，超出预算的帧会被丢弃并计数上报（客户端读得慢本来就会丢内容，
   * 但至少是「可观测的丢」而不是「不知情的 OOM」）。
   */
  private val pipePendingBytes = AtomicInteger(0)

  @Volatile var pipeDroppedFrames = 0L

  fun pendingPipeBytes(): Int = pipePendingBytes.get()

  fun enqueueFrame(bytes: ByteArray, budgetBytes: Int): Boolean {
    if (budgetBytes > 0 &&
        pipePendingBytes.get() + bytes.size > budgetBytes &&
        frames.size >= 8
    ) {
      pipeDroppedFrames++
      return false
    }
    pipePendingBytes.addAndGet(bytes.size)
    frames.add(bytes)
    return true
  }

  /** 终止哨兵永远放行：丢了它工作线程会一直等到截止时间。 */
  fun enqueueEndOfStream() {
    frames.add(RequestContext.EOS)
  }

  /** 由唯一的写者（HTTP 工作线程）在写完一帧后调用，释放预算。 */
  fun releaseFrameBytes(size: Int) {
    pipePendingBytes.addAndGet(-size)
  }

  fun offerToken(text: String): Boolean {
    val ok = tokenQueue.offer(text)
    if (ok) {
      pushedTokens++
      if (batchStartMs == 0L) batchStartMs = System.currentTimeMillis()
      lastActivityMs = System.currentTimeMillis()
    } else {
      droppedTokens++
    }
    return ok
  }

  companion object {
    /** 帧队列的终止哨兵。必须是 bytes 类型以便与普通帧共享同一队列。 */
    val EOS: ByteArray = ByteArray(0)
  }
}

/**
 * 请求编排：单并发许可 + 有界等待 + SSE 三层削减中的后两层。
 *
 * 第三层（本机批量排空 + 帧节流）与 JS 侧的第一层（20 字符 / 30ms 聚合）
 * 作用对象不同，不是同一件事的重复：
 *   第一层削减 **RN 桥调用次数** —— emitDelta 每次都是一趟完整的
 *   JNI → Java → 队列写入，逐 token 调用会让固定开销占掉可观比例；
 *   第二层削减 **SSE 帧数** —— 一个轮询窗口内到达的所有分片合成一批；
 *   第三层削减 **socket 写次数** —— 攒够字符立即发，攒不够由延迟上限兜底。
 */
class RequestPipeline(private val params: PipelineParams) {

  private val active = ConcurrentHashMap<String, RequestContext>()
  private val permit = Semaphore(1, true)

  private val waiting = AtomicInteger(0)
  private val rejectedRequests = AtomicLong(0)
  private val servedRequests = AtomicLong(0)
  private val streamingRequests = AtomicLong(0)
  private val failedRequests = AtomicLong(0)
  private val droppedTokens = AtomicLong(0)
  private val pipeDroppedFrames = AtomicLong(0)

  /** 上次排空的时间戳：用于实现 drainWindowMs 轮询窗口。 */
  @Volatile private var lastDrainMs = 0L

  // ── 单并发 ────────────────────────────────────────────────────────────
  /**
   * 同一时刻只允许一个推理在跑 —— 这是刻意约束而非权宜之计：单模型场景下两个
   * 请求同时调用 llama 上下文会触发原生层竞态；8GB 机型上双份 KV cache 会直接
   * OOM。
   *
   * 等待计数用原子计数器而不是阻塞队列：队列的 poll() 取到的是任意一个元素
   * 而不是本次放入的那个 —— 元素没有身份时计数上不会出错，但回答不了「当前有
   * 几个请求在等」，而这正是排查 503 时最需要的数字。
   */
  fun tryAcquirePermit(): AcquireResult {
    if (permit.tryAcquire()) {
      return AcquireResult.Granted
    }
    if (waiting.get() >= params.maxWaiting) {
      rejectedRequests.incrementAndGet()
      return AcquireResult.Rejected
    }
    val slot = waiting.incrementAndGet()
    return try {
      // 为什么取许可要有超时：客户端早已断开时，无限等待会让这个工作线程
      // 永久占住，最终拖垮整个线程池。
      val granted = permit.tryAcquire(params.permitTimeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
      waiting.decrementAndGet()
      if (granted) AcquireResult.Granted else {
        rejectedRequests.incrementAndGet()
        AcquireResult.Rejected
      }
    } catch (e: InterruptedException) {
      waiting.decrementAndGet()
      Thread.currentThread().interrupt()
      rejectedRequests.incrementAndGet()
      AcquireResult.Rejected
    }
  }

  fun releasePermit() {
    if (permit.availablePermits() == 0) {
      permit.release()
    }
  }

  sealed class AcquireResult {
    object Granted : AcquireResult()
    object Rejected : AcquireResult()
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────

  fun register(ctx: RequestContext) {
    active[ctx.id] = ctx
    servedRequests.incrementAndGet()
    if (ctx.stream) streamingRequests.incrementAndGet()
  }

  fun unregister(id: String) {
    val ctx = active.remove(id)
    if (ctx != null) {
      droppedTokens.addAndGet(ctx.droppedTokens)
      pipeDroppedFrames.addAndGet(ctx.pipeDroppedFrames)
    }
  }

  fun get(id: String): RequestContext? = active[id]

  fun pending(): List<RequestContext> = active.values.toList()

  fun count(): Int = active.size

  /**
   * JS 侧推过来的一个 token 增量。
   *
   * 这里刻意不做任何阻塞等待：桥的另一侧是 JS 线程，一旦卡住会把整个 UI 连带
   * 拖住。队列满就丢弃并计数（见 RequestContext.offerToken）。
   */
  fun pushToken(id: String, text: String): Boolean {
    val ctx = active[id] ?: return false
    return ctx.offerToken(text)
  }

  fun finish(
      id: String,
      finishReason: String,
      promptTokens: Int,
      completionTokens: Int,
  ): Boolean {
    val ctx = active[id] ?: return false
    ctx.summary = ResponseSummary(200, finishReason, promptTokens, completionTokens, null)
    return settle(ctx)
  }

  fun fail(id: String, status: Int, message: String): Boolean {
    val ctx = active[id] ?: return false
    failedRequests.incrementAndGet()
    ctx.summary = ResponseSummary(status, null, 0, 0, message)
    return settle(ctx)
  }

  private fun settle(ctx: RequestContext): Boolean {
    if (ctx.finished) return false
    ctx.finished = true
    ctx.finishLatch.countDown()
    return true
  }

  /**
   * 每迭代钩子 —— 由被调优的专用推理线程调用。
   *
   * 做两件事：
   *  1. 批量排空：把这个 `drainWindowMs` 内到达的所有 token 增量合成一批；
   *  2. 双阈值帧节流：攒够 `sseMinChars` 立刻发，攒不够则由 `sseMaxLatencyMs`
   *     兜底；模型中途停顿（思考、长 token）时，没有这个延迟上限用户看到的
   *     就是「卡住」。
   */
  fun drain() {
    val now = System.currentTimeMillis()
    // 轮询窗口：一次窗口内到达的所有分片合成一批。不做这个节流的话，
    // 每个 token 增量都会单独成一帧，帧数与 socket 写次数都回到未优化的水平。
    if (now - lastDrainMs < params.drainWindowMs) {
      return
    }
    lastDrainMs = now
    for (ctx in active.values) {
      try {
        drainOne(ctx, now)
      } catch (t: Throwable) {
        // 单条请求排空失败不影响其它请求。
      }
    }
  }

  private fun drainOne(ctx: RequestContext, now: Long) {
    // 1) 把窗口内所有已到达的分片全部取出 —— 这是「原生批量排空」，
    //    下游拿到的是「约一个大块」而不是「每 token 一个小块」。
    while (true) {
      val token = ctx.tokenQueue.poll() ?: break
      ctx.batch.append(token)
      ctx.accumulated.append(token)
    }

    val hasBatch = ctx.batch.isNotEmpty()
    val batchAge = if (ctx.batchStartMs == 0L) 0L else now - ctx.batchStartMs

    if (hasBatch && (ctx.batch.length >= params.sseMinChars || batchAge >= params.sseMaxLatencyMs)) {
      emitDeltaFrame(ctx)
      ctx.batch.setLength(0)
      ctx.batchStartMs = 0L
      ctx.lastActivityMs = now
      return
    }

    // 2) 保活注释帧。移动网络的 NAT/代理会掐掉长时间无数据的连接，而长思考
    //    （推理中间停顿十几秒）恰好会踩中。SSE 规范要求客户端忽略以 `:` 开头
    //    的内容，它只用来刷新链路活跃度。
    if (now - ctx.lastActivityMs >= params.sseHeartbeatMs) {
      ctx.enqueueFrame(
          ": keep-alive\n\n".toByteArray(Charsets.UTF_8),
          params.pipeBufferBytes,
      )
      ctx.lastActivityMs = now
    }
  }

  private fun emitDeltaFrame(ctx: RequestContext) {
    val payload = ctx.batch.toString()
    if (payload.isEmpty()) return
    val frame = buildChunk(ctx.id, ctx.modelName, payload, null, null)
    ctx.enqueueFrame(frame.toByteArray(Charsets.UTF_8), params.pipeBufferBytes)
  }

  // ── 结束帧 ────────────────────────────────────────────────────────────

  /**
   * 把队列里剩下的 token 全部取出并成帧。
   *
   * 用于收尾（流式的终止帧之前、非流式拼完整响应之前）：JS 推完最后一个 token
   * 到调用 pushFinish 之间是异步的，排空线程不一定赶在那之前跑过一轮。
   */
  fun flushRemaining(ctx: RequestContext) {
    while (true) {
      val token = ctx.tokenQueue.poll() ?: break
      ctx.batch.append(token)
      ctx.accumulated.append(token)
    }
    if (ctx.batch.isNotEmpty()) {
      emitDeltaFrame(ctx)
      ctx.batch.setLength(0)
      ctx.batchStartMs = 0L
    }
  }

  fun emitTerminalFrames(ctx: RequestContext, summary: ResponseSummary) {
    // 收尾前必须先把还没排空的分片发出去：最后一个 token 推入到 pushFinish
    // 之间可能只有一个迭代的一瞬之差，漏掉就是「回答最后少了几个字」。
    flushRemaining(ctx)
    val finishReason = summary.finishReason ?: "stop"
    val frame =
        buildChunk(ctx.id, ctx.modelName, "", finishReason, summary)
    // 终止帧与 [DONE] 不受字节预算限制：它们一帧都丢不得，
    // 丢了客户端就永远等不到收尾。
    ctx.frames.add(frame.toByteArray(Charsets.UTF_8))
    ctx.frames.add("data: [DONE]\n\n".toByteArray(Charsets.UTF_8))
    ctx.enqueueEndOfStream()
  }

  // ── OpenAI 兼容的 JSON ────────────────────────────────────────────────

  fun buildNonStreamBody(ctx: RequestContext, summary: ResponseSummary): String {
    val createdAt = System.currentTimeMillis() / 1000
    val content = ctx.accumulated.toString()
    val finishReason = summary.finishReason ?: "stop"
    return buildString(512) {
      append('{')
      append("\"id\":\"chatcmpl-").append(ctx.id).append("\",")
      append("\"object\":\"chat.completion\",")
      append("\"created\":").append(createdAt).append(',')
      append("\"model\":\"").append(escape(ctx.modelName)).append("\",")
      append("\"choices\":[{")
      append("\"index\":0,")
      append("\"message\":{\"role\":\"assistant\",\"content\":\"").append(escape(content)).append("\"},")
      append("\"finish_reason\":\"").append(escape(finishReason)).append('"')
      append("}],")
      append("\"usage\":{")
      append("\"prompt_tokens\":").append(summary.promptTokens).append(',')
      append("\"completion_tokens\":").append(summary.completionTokens).append(',')
      append("\"total_tokens\":").append(summary.promptTokens + summary.completionTokens)
      append("}}")
    }
  }

  fun buildErrorBody(message: String, status: Int): String {
    return buildString(256) {
      append('{')
      append("\"error\":{")
      append("\"message\":\"").append(escape(message)).append("\",")
      append("\"type\":\"invalid_request_error\",")
      append("\"code\":").append(status)
      append("}}")
    }
  }

  private fun buildChunk(
      id: String,
      model: String,
      content: String?,
      finishReason: String?,
      usage: ResponseSummary?,
  ): String {
    val createdAt = System.currentTimeMillis() / 1000
    return buildString(320) {
      append("data: {")
      append("\"id\":\"chatcmpl-").append(id).append("\",")
      append("\"object\":\"chat.completion.chunk\",")
      append("\"created\":").append(createdAt).append(',')
      append("\"model\":\"").append(escape(model)).append("\",")
      append("\"choices\":[{")
      append("\"index\":0,")
      if (content == null) {
        append("\"delta\":{},")
      } else {
        append("\"delta\":{\"content\":\"").append(escape(content)).append("\"},")
      }
      if (finishReason == null) {
        append("\"finish_reason\":null")
      } else {
        append("\"finish_reason\":\"").append(escape(finishReason)).append('"')
      }
      append("}]")
      if (usage != null) {
        append(",\"usage\":{")
        append("\"prompt_tokens\":").append(usage.promptTokens).append(',')
        append("\"completion_tokens\":").append(usage.completionTokens).append(',')
        append("\"total_tokens\":").append(usage.promptTokens + usage.completionTokens)
        append('}')
      }
      append("}\n\n")
    }
  }

  fun buildModelsBody(modelId: String, ready: Boolean): String {
    return buildString(256) {
      append("{\"object\":\"list\",\"data\":[{")
      append("\"id\":\"").append(escape(modelId)).append("\",")
      append("\"object\":\"model\",")
      append("\"created\":").append(System.currentTimeMillis() / 1000).append(',')
      append("\"owned_by\":\"pocketpal\",")
      append("\"ready\":").append(ready)
      append("}]}")
    }
  }

  private fun escape(value: String): String {
    val builder = StringBuilder(value.length + 16)
    for (char in value) {
      when (char) {
        '"' -> builder.append("\\\"")
        '\\' -> builder.append("\\\\")
        '\n' -> builder.append("\\n")
        '\r' -> builder.append("\\r")
        '\t' -> builder.append("\\t")
        '\b' -> builder.append("\\b")
        '\u000C' -> builder.append("\\f")
        else -> if (char < ' ') {
          builder.append(String.format("\\u%04x", char.code))
        } else {
          builder.append(char)
        }
      }
    }
    return builder.toString()
  }

  // ── 健康检查快照 ──────────────────────────────────────────────────────

  fun stats(): PipelineSnapshot {
    var pending = 0
    for (ctx in active.values) {
      pending += ctx.pendingPipeBytes()
    }
    return PipelineSnapshot(
        inferenceBusy = permit.availablePermits() == 0,
        inferenceWaiting = waiting.get(),
        inferenceRejected = rejectedRequests.get(),
        served = servedRequests.get(),
        streaming = streamingRequests.get(),
        failed = failedRequests.get(),
        droppedTokens = droppedTokens.get(),
        pipeDroppedFrames = pipeDroppedFrames.get(),
        pipePendingBytes = pending,
        inFlight = active.size,
    )
  }
}

data class PipelineSnapshot(
    val inferenceBusy: Boolean,
    val inferenceWaiting: Int,
    val inferenceRejected: Long,
    val served: Long,
    val streaming: Long,
    val failed: Long,
    val droppedTokens: Long,
    val pipeDroppedFrames: Long = 0,
    val pipePendingBytes: Int = 0,
    val inFlight: Int,
)

data class PipelineParams(
    /** 有界等待位：超出直接 503，不要无限堆积 */
    val maxWaiting: Int = 4,
    val permitTimeoutMs: Long = 120_000L,
    val tokenQueueCapacity: Int = 256,
    val drainWindowMs: Long = 40L,
    val sseMinChars: Int = 12,
    val sseMaxLatencyMs: Long = 60L,
    val sseHeartbeatMs: Long = 15_000L,
    val pipeBufferBytes: Int = 64 * 1024,
)
