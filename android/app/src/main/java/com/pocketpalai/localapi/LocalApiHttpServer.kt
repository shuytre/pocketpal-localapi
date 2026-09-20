package com.pocketpal.localapi

import java.io.BufferedInputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.util.Locale
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * 极小的 HTTP/1.1 引擎，专门为「一个模型 + 一串 SSE」的场景手写。
 *
 * 为什么不用现成的轻量 Java HTTP 服务器（NanoHTTPD 之类）：
 *
 * 1. **SSE 会被 gzip 吃掉。** 那些实现的判断大致是
 *    `mimeType.contains("text/") || mimeType.contains("/json")` → 套
 *    GZIPOutputStream。而 `text/event-stream` 恰好含 `text/`。Deflater 在缓冲
 *    填满或 finish() 之前不吐字节，而流式响应永远不会 finish —— 于是「看起来
 *    在流式，其实一个 token 都收不到」，直到推理结束才一次性吐出。
 *    更麻烦的是：不带 Accept-Encoding 的裸 curl 一切正常，自动化测试全绿，
 *    而真实 SDK（Python httpx 默认就带 gzip）全部静默退化 —— 现象极难归因。
 *    这里从不 gzip，并对流式响应强制
 *    `Cache-Control: no-cache, no-transform`（部分企业代理只看到 no-cache 时
 *    仍然会做 gzip 转码，no-transform 是必要的）。
 *
 * 2. **每连接一线程 + keep-alive = 资源泄漏。** 默认 AsyncRunner 是每个连接
 *    new Thread 且不设上限。客户端用连接池开 20 条长连接、每条空闲几分钟，
 *    手机上就多出 20 个常驻线程 —— 而我们的目标恰恰是让模型常驻内存，被
 *    lowmemorykiller 盯上是致命的。这里改成有界线程池，并且线程数按「在传输
 *    的请求」计，空闲的 keep-alive 连接不占线程。
 *
 * 3. **读超时的双重身份。** 很多实现的 start(timeout) 同时决定请求体读取上限
 *    和 keep-alive 空闲阻塞时长；传 300 秒意味着一条闲置长连接占住一个工作
 *    线程整整五分钟。这里默认降到 60 秒且可配置。
 */
class LocalApiHttpServer(
    private val params: ServerParams,
    private val handler: RequestHandler,
    private val sink: ServerActivity,
) {

  interface RequestHandler {
    fun handle(request: HttpRequestCtx, connection: HttpConnection)
  }

  interface ServerActivity {
    fun onRequestStart()
    fun onRequestEnd(statusCode: Int)
    fun onConnectionOpened()
    fun onConnectionClosed()
  }

  private var serverSocket: ServerSocket? = null
  private var acceptThread: Thread? = null

  /** 在途连接：停机时先关它们，再收线程池。 */
  private val openSockets: MutableSet<Socket> = mutableSetOf()

  @Volatile private var running = false

  private val activeConnections = AtomicInteger(0)
  private val requestsServed = AtomicLong(0)
  private val rejectedCount = AtomicLong(0)

  /**
   * 有界线程池。队列满时用 CallerRunsPolicy 反压到 accept 循环：
   * 丢弃连接或抛 RejectedExecutionException 会让客户端看到莫名其妙的
   * connection reset，而「让 accept 慢下来」是能被 HTTP 客户端正确感知的背压。
   */
  private val pool: ThreadPoolExecutor by lazy {
    val threads = params.workerThreads.coerceIn(1, 16)
    ThreadPoolExecutor(
        threads,
        threads,
        30L,
        TimeUnit.SECONDS,
        ArrayBlockingQueue<Runnable>(params.requestQueueSize.coerceIn(1, 256)),
    ) { runnable ->
      Thread(runnable, "pp-api-worker-${WORKER_ID.incrementAndGet()}").apply {
        isDaemon = true
      }
    }.apply { rejectedExecutionHandler = ThreadPoolExecutor.CallerRunsPolicy() }
  }

  fun start(): Int {
    if (running) return params.port
    val socket = ServerSocket(params.port, 64, null) // null = 0.0.0.0，允许局域网访问
    socket.reuseAddress = true
    socket.soTimeout = params.socketReadTimeoutMs.toInt().coerceAtLeast(1000)
    serverSocket = socket
    running = true

    acceptThread =
        Thread({
          while (running) {
            val client =
                try {
                  socket.accept()
                } catch (e: SocketException) {
                  if (!running) break else continue
                } catch (e: IOException) {
                  if (!running) break else continue
                }
            client.tcpNoDelay = true
            client.soTimeout = params.socketReadTimeoutMs.toInt().coerceAtLeast(1000)
            try {
              pool.execute { serveConnection(client) }
            } catch (t: Throwable) {
              try {
                client.close()
              } catch (_: Throwable) {
              }
            }
          }
        }, "pp-api-accept").apply { isDaemon = true }
    acceptThread?.start()
    return socket.localPort
  }

  /**
   * 停机顺序必须是「先关在途连接再关池」：直接 shutdownNow 会打断正在写响应的
   * 工作线程，客户端收到的是截断在半帧上的 SSE（甚至是半个 chunk 头），而不是
   * 一个干净的连接关闭。先关 socket，读循环自然退出，再收池。
   */
  fun stop() {
    running = false
    try {
      serverSocket?.close()
    } catch (_: Throwable) {
    }
    serverSocket = null

    val sockets = synchronized(openSockets) { openSockets.toList() }
    for (socket in sockets) {
      try {
        socket.close()
      } catch (_: Throwable) {
      }
    }

    pool.shutdownNow()
    try {
      pool.awaitTermination(2, TimeUnit.SECONDS)
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
    }
  }

  fun activeConnections(): Int = activeConnections.get()
  fun poolActiveCount(): Int = pool.activeCount
  fun poolThreadCount(): Int = pool.poolSize
  fun requestsServed(): Long = requestsServed.get()
  fun rejectedCount(): Long = rejectedCount.get()
  fun isRunning(): Boolean = running
  fun boundPort(): Int = serverSocket?.localPort ?: params.port

  // ── 连接循环 ──────────────────────────────────────────────────────────

  private fun serveConnection(client: Socket) {
    activeConnections.incrementAndGet()
    synchronized(openSockets) { openSockets.add(client) }
    sink.onConnectionOpened()
    val connection = HttpConnection(client, params)
    try {
      while (running && !client.isClosed) {
        val request =
            try {
              connection.readNextRequest()
            } catch (abort: HttpAbort) {
              // 请求行/头/体本身就不合法：给一个明确的状态码再关连接，
              // 比直接断连更容易让调用方定位问题。
              connection.sendPlainText(abort.statusCode, abort.statusText, abort.message)
              break
            } ?: break
        requestsServed.incrementAndGet()
        sink.onRequestStart()
        val status = intArrayOf(200)
        try {
          handler.handle(request, connection)
        } catch (e: HttpAbort) {
          status[0] = e.statusCode
          connection.sendPlainText(e.statusCode, e.statusText, e.message)
        } catch (t: Throwable) {
          status[0] = 500
          connection.sendPlainText(500, "Internal Server Error", "internal error")
        }
        sink.onRequestEnd(status[0])
        if (!connection.shouldKeepAlive()) break
      }
    } catch (_: SocketException) {
      // 客户端断开 —— 正常，不需要处理。
    } catch (t: Throwable) {
      // 单个连接的异常不能影响 accept 循环。
    } finally {
      sink.onConnectionClosed()
      activeConnections.decrementAndGet()
      synchronized(openSockets) { openSockets.remove(client) }
      try {
        client.close()
      } catch (_: Throwable) {
      }
    }
  }

  companion object {
    private val WORKER_ID = AtomicInteger(0)
  }
}

/** handler 主动终止响应时使用。 */
class HttpAbort(val statusCode: Int, val statusText: String, override val message: String) :
    RuntimeException(message)

/**
 * 一个连接上的请求/响应读写。所有写操作都由「处理这条请求的 HTTP 工作线程」
 * 完成 —— 这是写 socket 的唯一安全位置。
 */
class HttpConnection(
    private val socket: Socket,
    private val params: ServerParams,
) {
  private val input: BufferedInputStream = BufferedInputStream(socket.getInputStream(), 8192)
  private val output: OutputStream = socket.getOutputStream()

  private var keepAlive = false
  // true 表示本连接的响应还在 chunked 帧里，没写终止块前不允许继续复用连接。
  private var chunkedActive = false

  fun remoteIp(): String = socket.inetAddress?.hostAddress ?: "unknown"

  fun shouldKeepAlive(): Boolean = keepAlive && !socket.isClosed && !chunkedActive

  fun readNextRequest(): HttpRequestCtx? {
    val requestLine = readLineCrLf() ?: return null
    if (requestLine.isEmpty()) return null
    val parts = requestLine.split(" ")
    if (parts.size < 2) return null
    val method = parts[0].uppercase(Locale.ROOT)
    val target = parts[1]
    val headers = readHeaders()
    keepAlive = shouldHoldConnection(headers)
    val body = readBody(headers)
    val (path, query) = splitTarget(target)
    return HttpRequestCtx(
        id = java.util.UUID.randomUUID().toString(),
        method = method,
        path = path,
        query = query,
        headers = headers,
        body = body,
        remoteIp = remoteIp(),
    )
  }

  private fun splitTarget(target: String): Pair<String, String?> {
    val idx = target.indexOf('?')
    return if (idx < 0) target to null else target.substring(0, idx) to target.substring(idx + 1)
  }

  private fun readHeaders(): Map<String, String> {
    val out = HashMap<String, String>()
    while (true) {
      val line = readLineCrLf() ?: break
      if (line.isEmpty()) break
      val idx = line.indexOf(':')
      if (idx <= 0) continue
      val key = line.substring(0, idx).trim().lowercase(Locale.ROOT)
      val value = line.substring(idx + 1).trim()
      val existing = out[key]
      out[key] = if (existing == null) value else "$existing, $value"
    }
    return out
  }

  private fun readBody(headers: Map<String, String>): String {
    val chunked = headers["transfer-encoding"]?.contains("chunked") == true
    return if (chunked) {
      readChunkedBody()
    } else {
      val len = headers["content-length"]?.toLongOrNull() ?: 0L
      if (len <= 0L) return ""
      if (len > params.maxBodyBytes) {
        throw HttpAbort(413, "Payload Too Large", "body exceeds ${params.maxBodyBytes} bytes")
      }
      val buffer = ByteArray(len.toInt())
      var offset = 0
      while (offset < buffer.size) {
        val n = input.read(buffer, offset, buffer.size - offset)
        if (n < 0) break
        offset += n
      }
      String(buffer, 0, offset, Charsets.UTF_8)
    }
  }

  private fun readChunkedBody(): String {
    val builder = StringBuilder()
    var total = 0
    while (true) {
      val sizeLine = readLineCrLf() ?: break
      val size = sizeLine.trim().split(";").firstOrNull()?.toIntOrNull(16) ?: 0
      if (size == 0) {
        // 尾随 trailer：读到空行结束。
        while (true) {
          val trailer = readLineCrLf() ?: break
          if (trailer.isEmpty()) break
        }
        break
      }
      total += size
      if (total > params.maxBodyBytes) {
        throw HttpAbort(413, "Payload Too Large", "chunked body exceeds ${params.maxBodyBytes} bytes")
      }
      val buffer = ByteArray(size)
      var offset = 0
      while (offset < size) {
        val n = input.read(buffer, offset, size - offset)
        if (n < 0) break
        offset += n
      }
      builder.append(String(buffer, 0, offset, Charsets.UTF_8))
      readLineCrLf() // chunk 后的 CRLF
    }
    return builder.toString()
  }

  private fun readLineCrLf(): String? {
    val builder = StringBuilder(128)
    while (true) {
      val c = input.read()
      if (c < 0) {
        return if (builder.isEmpty()) null else builder.toString()
      }
      if (c == '\r'.code) {
        val next = input.read()
        if (next == '\n'.code) break
        builder.append(c.toChar())
        if (next >= 0 && next != '\n'.code) builder.append(next.toChar())
        continue
      }
      if (c == '\n'.code) break
      builder.append(c.toChar())
      if (builder.length > 16 * 1024) {
        throw HttpAbort(431, "Request Header Fields Too Large", "header line too long")
      }
    }
    return builder.toString()
  }

  private fun shouldHoldConnection(headers: Map<String, String>): Boolean {
    val connectionHeader = headers["connection"]?.lowercase(Locale.ROOT) ?: ""
    if (connectionHeader.contains("close")) return false
    // HTTP/1.1 默认 keep-alive。
    return true
  }

  // ── 响应 ──────────────────────────────────────────────────────────────

  private fun writeHead(statusCode: Int, statusText: String, headers: Map<String, String>) {
    val builder = StringBuilder(256)
    builder.append("HTTP/1.1 ").append(statusCode).append(' ').append(statusText).append("\r\n")
    for ((key, value) in headers) {
      builder.append(key).append(": ").append(value).append("\r\n")
    }
    builder.append("\r\n")
    output.write(builder.toString().toByteArray(Charsets.ISO_8859_1))
  }

  fun sendPlainText(statusCode: Int, statusText: String, message: String) {
    val body = message.toByteArray(Charsets.UTF_8)
    val headers = baseHeaders()
    headers["Content-Type"] = "text/plain; charset=utf-8"
    headers["Content-Length"] = body.size.toString()
    headers["Connection"] = if (keepAlive) "keep-alive" else "close"
    writeHead(statusCode, statusText, headers)
    output.write(body)
    output.flush()
  }

  fun sendJson(statusCode: Int, statusText: String, json: String, extra: Map<String, String> = emptyMap()) {
    val body = json.toByteArray(Charsets.UTF_8)
    val headers = baseHeaders()
    headers["Content-Type"] = "application/json; charset=utf-8"
    headers["Content-Length"] = body.size.toString()
    headers["Connection"] = if (keepAlive) "keep-alive" else "close"
    headers.putAll(extra)
    writeHead(statusCode, statusText, headers)
    output.write(body)
    output.flush()
  }

  /**
   * 开始一个 SSE 响应。
   *
   * `Cache-Control: no-cache, no-transform` + `X-Accel-Buffering: no` +
   * `Content-Type: text/event-stream` 三件套是必须的：它们分别挡住「浏览器/代理
   * 缓存」「nginx 缓冲」「反向代理 gzip 转码」。少任何一个都会在某些客户端上
   * 退化成「全部内容最后一次性到达」。
   */
  fun startSse(extra: Map<String, String> = emptyMap()) {
    val headers = baseHeaders()
    headers["Content-Type"] = "text/event-stream; charset=utf-8"
    headers["Cache-Control"] = "no-cache, no-transform"
    headers["Connection"] = if (keepAlive) "keep-alive" else "close"
    headers["X-Accel-Buffering"] = "no"
    headers["Transfer-Encoding"] = "chunked"
    headers.putAll(extra)
    writeHead(200, "OK", headers)
    output.flush()
    chunkedActive = true
  }

  /** 先发一帧前导注释，让客户端立刻确认流已建立。 */
  fun writeSsePrelude() {
    writeChunk(": ok\n\n".toByteArray(Charsets.UTF_8))
  }

  fun writeSseComment(comment: String) {
    writeChunk(comment.toByteArray(Charsets.UTF_8))
  }

  fun writeSseFrame(payload: String) {
    writeFrameBytes(payload.toByteArray(Charsets.UTF_8))
  }

  /**
   * 直接写 UTF-8 字节，不要 BufferedWriter(OutputStreamWriter(...))：
   * 后者一次增量要经过字符编码器 + 8192 字符缓冲两层，而缓冲区不满时 flush()
   * 会强制推一次 —— 等于每帧都在做「编码 → 缓冲 → 立刻清空」的无用功。
   * 帧本身已经是完整的 UTF-8 字符串，toByteArray 一次到位更直接。
   */
  fun writeFrameBytes(bytes: ByteArray) {
    writeChunk(bytes)
  }

  /** 直接写 UTF-8 字节：帧本身已经是完整字符串，toByteArray 一次到位。 */
  private fun writeChunk(bytes: ByteArray) {
    output.write(Integer.toHexString(bytes.size).toByteArray(Charsets.ISO_8859_1))
    output.write(CRLF)
    output.write(bytes)
    output.write(CRLF)
    output.flush()
  }

  fun endChunked() {
    try {
      output.write("0\r\n\r\n".toByteArray(Charsets.ISO_8859_1))
      output.flush()
      chunkedActive = false
    } catch (_: Throwable) {
    }
  }

  private fun baseHeaders(): LinkedHashMap<String, String> {
    val headers = LinkedHashMap<String, String>()
    headers["Server"] = "PocketPalLocalApi/1.0"
    headers["Date"] = java.text.SimpleDateFormat(
        "EEE, dd MMM yyyy HH:mm:ss 'GMT'",
        Locale.US,
    ).apply { timeZone = java.util.TimeZone.getTimeZone("GMT") }.format(java.util.Date())
    if (params.allowCors) {
      headers["Access-Control-Allow-Origin"] = params.corsAllowOrigin
      headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
      headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type, Accept"
      headers["Access-Control-Max-Age"] = "86400"
    }
    return headers
  }

  companion object {
    private val CRLF = byteArrayOf(13, 10)
  }
}

data class HttpRequestCtx(
    val id: String,
    val method: String,
    val path: String,
    val query: String?,
    val headers: Map<String, String>,
    val body: String,
    val remoteIp: String,
)

/** 引擎的全部可调参数，集中在这里便于 UI 一一对应。 */
data class ServerParams(
    val port: Int,
    val workerThreads: Int,
    val requestQueueSize: Int,
    val socketReadTimeoutMs: Long,
    val maxBodyBytes: Int,
    val allowCors: Boolean,
    val corsAllowOrigin: String,
)

/** handler 抛出的「已知 HTTP 错误」，语义化错误码。 */
object ApiErrors {
  val modelNotReady = Pair(503, "Model Not Loaded")
  val serverBusy = Pair(503, "Service Unavailable")
  val unauthorized = Pair(401, "Unauthorized")
  val badRequest = Pair(400, "Bad Request")
  val notFound = Pair(404, "Not Found")
  val internal = Pair(500, "Internal Server Error")
}

/** 用于 UI 展示的连接计数快照。 */
data class HttpRuntimeStats(
    val connections: Int,
    val threads: Int,
    val activeThreads: Int,
    val requestsServed: Long,
    val rejected: Long,
    val running: Boolean,
)