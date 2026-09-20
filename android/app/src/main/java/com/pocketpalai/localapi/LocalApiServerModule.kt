package com.pocketpal.localapi

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.pocketpal.perf.InferenceLoop
import com.pocketpal.specs.NativeLocalApiServerSpec
import java.net.NetworkInterface
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 本地 OpenAI 兼容服务的宿主模块。
 *
 * 职责边界（这条边界是刻意保留的）：
 *  - **推理**：js 侧调用已加载的 llama.rn 上下文。这里不重复实现任何推理逻辑，
 *    也不持有模型 —— 复用 App 现有能力，避免两份 llama.cpp 实例抢内存。
 *  - **网络**：这里。Socket、keep-alive、SSE 帧、单并发排队都在 native，
 *    因为它们对延迟敏感且不应该反复跨 RN 桥。
 *  - **桥接缝**：一个 request 事件下发 + 三个 push 回传，跨桥内容被 JS 侧
 *    按「20 字符 / 30ms」聚合，跨桥次数下降接近一个数量级。
 */
@ReactModule(name = NativeLocalApiServerSpec.NAME)
class LocalApiServerModule(reactContext: ReactApplicationContext) :
    NativeLocalApiServerSpec(reactContext), LocalApiHttpServer.RequestHandler {

  override fun getName(): String = NativeLocalApiServerSpec.NAME

  private var httpServer: LocalApiHttpServer? = null
  private var pipeline: RequestPipeline? = null
  private var serverParams: ServerParams? = null
  private var pipelineParams: PipelineParams? = null

  @Volatile private var modelReady = false

  @Volatile private var modelName = "pocketpal-local"

  @Volatile private var apiKey = ""

  @Volatile private var requireApiKey = false

  @Volatile private var requestTimeoutMs = 600_000L

  @Volatile private var lastError = ""

  @Volatile private var startedAtMs = 0L

  private val stopping = AtomicBoolean(false)

  // ── 生命周期 ──────────────────────────────────────────────────────────

  override fun start(config: ReadableMap, promise: Promise) {
    try {
      stopInternal()

      val params = ServerParams(
          port = readInt(config, "port", 8080),
          workerThreads = readInt(config, "workerThreads", 4),
          requestQueueSize = readInt(config, "requestQueueSize", 64),
          socketReadTimeoutMs = readLong(config, "socketReadTimeoutMs", 60_000L),
          maxBodyBytes = readInt(config, "maxBodyBytes", 8 * 1024 * 1024),
          allowCors = readBool(config, "allowCors", true),
          corsAllowOrigin = readString(config, "corsAllowOrigin", "*"),
      )
      val pParams = PipelineParams(
          maxWaiting = readInt(config, "maxWaiting", 4),
          permitTimeoutMs = readLong(config, "permitTimeoutMs", 120_000L),
          tokenQueueCapacity = readInt(config, "tokenQueueCapacity", 256),
          drainWindowMs = readLong(config, "drainWindowMs", 40L),
          sseMinChars = readInt(config, "sseMinChars", 12),
          sseMaxLatencyMs = readLong(config, "sseMaxLatencyMs", 60L),
          sseHeartbeatMs = readLong(config, "sseHeartbeatMs", 15_000L),
      )

      apiKey = readString(config, "apiKey", "")
      requireApiKey = readBool(config, "requireApiKey", false)
      requestTimeoutMs = readLong(config, "requestTimeoutMs", 600_000L)

      val activePipeline = RequestPipeline(pParams)
      val server = LocalApiHttpServer(params, this, ActivitySink(activePipeline))

      // 排空钩子挂在被调优的专用线程上： cross-thread 调度与增量排空由它承担，
      // 写 socket 仍由 HTTP 工作线程负责，两边通过队列解耦。
      InferenceLoop.setIterationHook { activePipeline.drain() }
      InferenceLoop.start()

      val boundPort = server.start()

      // 可选的前台通知：让 App 退到后台后进程不被系统回收。
      // 失败只记录 —— 服务本身仍然可用。
      try {
        LocalApiForegroundService.start(reactApplicationContext, boundPort)
      } catch (t: Throwable) {
        lastError = "foreground service unavailable: ${t.message}"
      }

      httpServer = server
      pipeline = activePipeline
      serverParams = params
      pipelineParams = pParams
      startedAtMs = System.currentTimeMillis()
      lastError = ""
      stopping.set(false)

      promise.resolve(buildStatus())
    } catch (t: Throwable) {
      lastError = t.message ?: "start failed"
      InferenceLoop.setIterationHook(null)
      promise.reject("LOCAL_API_START_FAILED", lastError)
    }
  }

  override fun stop(promise: Promise) {
    try {
      stopInternal()
      promise.resolve(true)
    } catch (t: Throwable) {
      promise.resolve(false)
    }
  }

  private fun stopInternal() {
    stopping.set(true)
    LocalApiForegroundService.stop(reactApplicationContext)
    // 顺序不能反：先停止排空 → 再给在途请求一个收尾信号 → 关在途连接 →
    // 最后关线程池。先把池关掉会让正在写的响应被截断在半帧上。
    InferenceLoop.setIterationHook(null)
    pipeline?.pending()?.forEach { ctx ->
      try {
        ctx.enqueueEndOfStream()
      } catch (t: Throwable) {
      }
    }
    httpServer?.stop()
    httpServer = null
    pipeline = null
    startedAtMs = 0L
  }

  override fun getStatus(promise: Promise) {
    promise.resolve(buildStatus())
  }

  override fun setModelReady(ready: Boolean, name: String, promise: Promise) {
    modelReady = ready
    if (name.isNotBlank()) {
      modelName = name
    }
    promise.resolve(true)
  }

  // ── JS → native 回传 ──────────────────────────────────────────────────

  override fun pushToken(requestId: String, text: String, promise: Promise) {
    val ok = pipeline?.pushToken(requestId, text) ?: false
    promise.resolve(ok)
    // 通知排空线程立刻醒来处理这批增量（否则最多再等一个 20ms 迭代）。
    if (ok) {
      InferenceLoop.post {}
    }
  }

  /**
   * 注意签名：codegen 把 TS 的 number 映射成 Java 的 double，不是 int。
   * 写成 Int 会编译报「overrides nothing」，所以这里收 double、内部转 Int。
   */
  override fun pushFinish(
      requestId: String,
      finishReason: String,
      promptTokens: Double,
      completionTokens: Double,
      promise: Promise,
  ) {
    val current = pipeline
    if (current == null) {
      promise.resolve(false)
      return
    }
    val ctx = current.get(requestId)
    val ok =
        current.finish(
            requestId,
            finishReason,
            promptTokens.toInt(),
            completionTokens.toInt(),
        )
    if (ok && ctx != null && ctx.stream) {
      current.emitTerminalFrames(ctx, ctx.summary!!)
    }
    promise.resolve(ok)
  }

  override fun pushError(
      requestId: String,
      status: Double,
      message: String,
      promise: Promise,
  ) {
    val ok = pipeline?.fail(requestId, status.toInt(), message) ?: false
    promise.resolve(ok)
  }

  override fun getLanIpAddresses(promise: Promise) {
    promise.resolve(Arguments.fromList(readLanIpAddresses()))
  }

  // ── 路由 ──────────────────────────────────────────────────────────────

  override fun handle(request: HttpRequestCtx, connection: HttpConnection) {
    // 预检必须先于鉴权：浏览器的 CORS preflight 不带 Authorization，
    // 先查鉴权的话 preflight 会被 401，浏览器随后会报一个看起来完全无关的
    // 「CORS 失败」。
    if (request.method == "OPTIONS") {
      connection.sendJson(204, "No Content", "", mapOf("Content-Length" to "0"))
      return
    }

    if (!checkAuth(request)) {
      val body = pipeline?.buildErrorBody(
          "Invalid API key. Provide Authorization: Bearer <key>.",
          401,
      ) ?: "{\"error\":{\"message\":\"Unauthorized\"}}"
      connection.sendJson(401, "Unauthorized", body, mapOf("WWW-Authenticate" to "Bearer"))
      return
    }

    when (request.path) {
      "/health", "/v1/health" -> handleHealth(connection)
      "/v1/models" -> handleModels(connection)
      "/v1/chat/completions" -> handleChatCompletion(request, connection)
      else -> connection.sendPlainText(404, "Not Found", "not found: ${request.path}")
    }
  }

  private fun checkAuth(request: HttpRequestCtx): Boolean {
    if (!requireApiKey || apiKey.isEmpty()) return true
    val header = request.headers["authorization"] ?: return false
    val token = header.removePrefix("Bearer ").trim()
    // 允许 x-api-key 作为兼容路径（部分工具用它）。
    val fallback = request.headers["x-api-key"]?.trim()
    return token == apiKey || fallback == apiKey
  }

  private fun handleHealth(connection: HttpConnection) {
    // 健康检查刻意不申请推理许可：否则在排队高峰时连「为什么在排队」都查不到。
    connection.sendJson(200, "OK", buildHealthBody())
  }

  private fun handleModels(connection: HttpConnection) {
    val current = pipeline
    if (current == null) {
      connection.sendPlainText(503, "Service Unavailable", "server not running")
      return
    }
    connection.sendJson(200, "OK", current.buildModelsBody(modelName, modelReady))
  }

  private fun handleChatCompletion(request: HttpRequestCtx, connection: HttpConnection) {
    val current = pipeline ?: run {
      connection.sendPlainText(503, "Service Unavailable", "server not running")
      return
    }
    if (request.method != "POST") {
      connection.sendPlainText(405, "Method Not Allowed", "use POST")
      return
    }
    if (!modelReady) {
      // 模型加载中/未加载必须有明确的 503，而不是崩溃或空响应。
      val body = current.buildErrorBody(
          "No model is loaded yet. Load a GGUF model in PocketPal, then retry.",
          503,
      )
      connection.sendJson(503, "Service Unavailable", body)
      return
    }

    val stream = parseStream(request.body)
    if (stream) {
      // 流式响应要先建流再申请许可：客户端应当在等待期间就已经连上 SSE，
      // 而不是在队列里干等到 HTTP 超时。
      connection.startSse()
      connection.writeSsePrelude()
    }

    when (current.tryAcquirePermit()) {
      RequestPipeline.AcquireResult.Granted -> Unit
      RequestPipeline.AcquireResult.Rejected -> {
        val body = current.buildErrorBody(
            "Server busy: too many waiting requests (bounded queue). Retry shortly.",
            503,
        )
        if (stream) {
          connection.writeSseFrame("data: $body\n\n")
          connection.writeSseFrame("data: [DONE]\n\n")
          connection.endChunked()
        } else {
          connection.sendJson(503, "Service Unavailable", body, mapOf("Retry-After" to "2"))
        }
        return
      }
    }

    val ctx = RequestContext(
        id = request.id,
        stream = stream,
        modelName = modelName,
        tokenQueueCapacity = pipelineParams?.tokenQueueCapacity ?: 256,
    )
    current.register(ctx)

    try {
      emitRequestEvent(request, ctx, stream)
    } catch (t: Throwable) {
      current.fail(ctx.id, 500, "failed to dispatch request to JS: ${t.message}")
    }

    try {
      if (stream) {
        writeStreamLoop(connection, ctx, current)
      } else {
        writeBuffered(connection, ctx, current)
      }
    } finally {
      current.unregister(ctx.id)
      current.releasePermit()
    }
  }

  private fun writeStreamLoop(
      connection: HttpConnection,
      ctx: RequestContext,
      pipeline: RequestPipeline,
  ) {
    // 唯一的写者：HTTP 工作线程。所有帧都从这里顺序写出。
    //
    // 仍然要有截止时间：JS 侧若始终没有回推任何内容（事件没送达、推理卡死），
    // 这条线程会永久占住一个池位置，最终拖垮整个服务。
    val deadline = System.currentTimeMillis() + requestTimeoutMs
    while (true) {
      if (stopping.get() || System.currentTimeMillis() > deadline) {
        break
      }
      val frame = ctx.frames.poll(500, TimeUnit.MILLISECONDS) ?: continue
      if (frame === RequestContext.EOS || frame.isEmpty()) {
        break
      }
      try {
        connection.writeFrameBytes(frame)
        // 写完后释放字节预算 —— 排空侧依赖它判断还能不能往管道里放帧。
        ctx.releaseFrameBytes(frame.size)
      } catch (t: Throwable) {
        // 客户端断开：直接退出，剩余帧自然被丢弃。
        break
      }
    }
    if (!ctx.finished) {
      pipeline.fail(ctx.id, 504, "streaming inference exceeded ${requestTimeoutMs}ms")
    }
    connection.endChunked()
  }

  private fun writeBuffered(
      connection: HttpConnection,
      ctx: RequestContext,
      pipeline: RequestPipeline,
  ) {
    val settled = ctx.finishLatch.await(requestTimeoutMs, TimeUnit.MILLISECONDS)
    if (!settled) {
      pipeline.fail(ctx.id, 504, "inference timed out after ${requestTimeoutMs}ms")
    }
    // 收尾排空：把 JS 最后几步推过来、排空线程还没来得及处理的 token 补齐。
    pipeline.flushRemaining(ctx)
    val summary = ctx.summary ?: ResponseSummary(500, "error", 0, 0, "inference did not complete")
    if (summary.status != 200) {
      connection.sendJson(
          summary.status,
          if (summary.status == 503) "Service Unavailable" else "Bad Request",
          pipeline.buildErrorBody(summary.errorMessage ?: "request failed", summary.status),
      )
      return
    }
    val body = pipeline.buildNonStreamBody(ctx, summary)
    connection.sendJson(200, "OK", body)
  }

  // ── 事件下发 ──────────────────────────────────────────────────────────

  private fun emitRequestEvent(request: HttpRequestCtx, ctx: RequestContext, stream: Boolean) {
    val payload = Arguments.createMap().apply {
      putString("requestId", ctx.id)
      putString("method", request.method)
      putString("path", request.path)
      putString("body", request.body)
      putString("remoteIp", request.remoteIp)
      putBoolean("stream", stream)
      putString("model", modelName)
    }
    reactApplicationContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(EVENT_REQUEST, payload)
  }

  // ── 状态 ──────────────────────────────────────────────────────────────

  private fun buildHealthBody(): String {
    val snap = pipeline?.stats()
    return buildString(512) {
      append('{')
      append("\"status\":\"ok\",")
      append("\"server_running\":").append(httpServer?.isRunning() ?: false).append(',')
      append("\"model_ready\":").append(modelReady).append(',')
      append("\"model\":\"").append(modelName).append("\",")
      append("\"inference_busy\":").append(snap?.inferenceBusy ?: false).append(',')
      append("\"inference_waiting\":").append(snap?.inferenceWaiting ?: 0).append(',')
      append("\"inference_rejected\":").append(snap?.inferenceRejected ?: 0L).append(',')
      append("\"http_connections\":").append(httpServer?.activeConnections() ?: 0).append(',')
      append("\"http_threads\":").append(httpServer?.poolThreadCount() ?: 0).append(',')
      append("\"http_threads_active\":").append(httpServer?.poolActiveCount() ?: 0).append(',')
      append("\"dropped_tokens\":").append(snap?.droppedTokens ?: 0L).append(',')
      append("\"pipe_dropped_frames\":").append(snap?.pipeDroppedFrames ?: 0L).append(',')
      append("\"pipe_pending_bytes\":").append(snap?.pipePendingBytes ?: 0).append(',')
      append("\"uptime_ms\":").append(if (startedAtMs == 0L) 0L else System.currentTimeMillis() - startedAtMs)
      append('}')
    }
  }

  private fun buildStatus(): WritableMap {
    val snap = pipeline?.stats()
    val ipList = readLanIpAddresses()
    val map = Arguments.createMap()
    map.putBoolean("running", httpServer?.isRunning() ?: false)
    map.putInt("port", httpServer?.boundPort() ?: serverParams?.port ?: 0)
    map.putString("host", "0.0.0.0")
    map.putArray("baseUrls", Arguments.fromList(ipList.map { "http://$it:${httpServer?.boundPort() ?: serverParams?.port ?: 0}/v1" }))
    map.putBoolean("modelReady", modelReady)
    map.putString("modelName", modelName)
    map.putDouble("uptimeMs", if (startedAtMs == 0L) 0.0 else (System.currentTimeMillis() - startedAtMs).toDouble())
    map.putBoolean("inferenceBusy", snap?.inferenceBusy ?: false)
    map.putInt("inferenceWaiting", snap?.inferenceWaiting ?: 0)
    map.putDouble("inferenceRejected", (snap?.inferenceRejected ?: 0L).toDouble())
    map.putInt("httpConnections", httpServer?.activeConnections() ?: 0)
    map.putInt("httpThreads", httpServer?.poolThreadCount() ?: 0)
    map.putInt("httpThreadsActive", httpServer?.poolActiveCount() ?: 0)
    map.putDouble("requestsServed", (snap?.served ?: 0L).toDouble())
    map.putDouble("streamingRequests", (snap?.streaming ?: 0L).toDouble())
    map.putDouble("failedRequests", (snap?.failed ?: 0L).toDouble())
    map.putDouble("droppedTokens", (snap?.droppedTokens ?: 0L).toDouble())
    map.putDouble("pipeDroppedFrames", (snap?.pipeDroppedFrames ?: 0L).toDouble())
    map.putInt("pipePendingBytes", snap?.pipePendingBytes ?: 0)
    map.putString("lastError", lastError)
    return map
  }

  private fun parseStream(body: String): Boolean {
    if (body.isEmpty()) return false
    // 朴素 HTTP 服务器没有引入 JSON 解析器（省一层依赖与分配）；stream 是
    // 布尔字面量，局部扫描足够，且失败时按非流式处理是安全的回退方向。
    return STREAM_TRUE.containsMatchIn(body)
  }

  companion object {
    const val EVENT_REQUEST = "LocalApiServerRequest"
    private val STREAM_TRUE = Regex("\"stream\"\\s*:\\s*true")
  }

  private fun readLanIpAddresses(): List<String> {
    val addresses = mutableListOf<String>()
    return try {
      val interfaces = NetworkInterface.getNetworkInterfaces()
      while (interfaces.hasMoreElements()) {
        val netInterface = interfaces.nextElement()
        val addrs = netInterface.inetAddresses
        while (addrs.hasMoreElements()) {
          val addr = addrs.nextElement()
          if (addr.isLoopbackAddress || addr !is java.net.Inet4Address) continue
          val host = addr.hostAddress ?: continue
          // 169.254.* 是没拿到 DHCP 的自动地址，客户端连不上。
          if (host.startsWith("169.254.")) continue
          addresses.add(host)
        }
      }
      addresses.distinct()
    } catch (t: Throwable) {
      addresses
    }
  }

  // 连接活动回调目前只做「让排空立刻跑一轮」这一种事：连接刚建立时可能已经有
  // token 在队列里等着成型。
  inner class ActivitySink(private val sinkPipeline: RequestPipeline) :
      LocalApiHttpServer.ServerActivity {
    override fun onRequestStart() {
      sinkPipeline.drain()
    }

    override fun onRequestEnd(statusCode: Int) = Unit

    override fun onConnectionOpened() = Unit

    override fun onConnectionClosed() = Unit
  }

  private fun readInt(map: ReadableMap, key: String, fallback: Int): Int =
      if (map.hasKey(key) && !map.isNull(key)) map.getInt(key) else fallback

  private fun readLong(map: ReadableMap, key: String, fallback: Long): Long =
      if (map.hasKey(key) && !map.isNull(key)) map.getDouble(key).toLong() else fallback

  private fun readBool(map: ReadableMap, key: String, fallback: Boolean): Boolean =
      if (map.hasKey(key) && !map.isNull(key)) map.getBoolean(key) else fallback

  private fun readString(map: ReadableMap, key: String, fallback: String): String =
      if (map.hasKey(key) && !map.isNull(key)) map.getString(key) ?: fallback else fallback
}
