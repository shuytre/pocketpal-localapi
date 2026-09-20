package com.pocketpal.perf

import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.locks.LockSupport

/**
 * 常驻推理线程 —— 需求 4 的「独立 Native 推理线程」的宿主。
 *
 * 为什么不用 ThreadPoolExecutor / ScheduledExecutorService：
 *  1. 线程标识必须稳定。绑大核和 nice 都是按 tid 生效的，池子在空闲时会换线程，
 *     于是「调优过的线程」和「真正在干活的线程」会慢慢变成两个。
 *  2. 交错的循环任务是这里的常态：周期性排空 token 队列要一直跑，
 *     而「应用一次调优」「标记忙/闲」这些控制任务是零星到达的。用带阻塞 sleep
 *     的事件循环比线程池更可控，也不会因为队列空就让线程退回去休眠时被调度器
 *     迁到小核上。
 *
 * 这是一个线程 = 一个事件循环：控制任务走内部队列，每次迭代的空档还有一个
 * 由 API 服务注册的「排空钩子」（token 增量排空），两者解耦。
 */
object InferenceLoop {
  private val tasks = ConcurrentLinkedQueue<Runnable>()

  @Volatile private var started = false

  @Volatile private var alive = true

  /** 每次迭代执行的钩子：由本地 API 服务注册为「批量排空 + SSE 节流」。 */
  @Volatile private var iterationHook: (() -> Unit)? = null

  /** 迭代之间的停顿。20ms 是延迟预算的一部分，比固定 40ms 轮询更平滑。 */
  private const val IDLE_PARK_NANOS = 20L * 1_000_000L

  val thread: Thread =
      object : Thread("pocketpal-inference-core") {
        override fun run() {
          loop()
        }
      }.apply { isDaemon = true }

  fun start() {
    if (started) return
    started = true
    alive = true
    thread.start()
  }

  /** 在推理线程上执行一次性任务（调优、忙闲切换等）。 */
  fun post(task: Runnable) {
    start()
    tasks.add(task)
    LockSupport.unpark(thread)
  }

  /** 注册/注销每迭代钩子。 */
  fun setIterationHook(hook: (() -> Unit)?) {
    iterationHook = hook
  }

  private fun loop() {
    while (alive) {
      // 1) 控制任务全部清空，保证「原子应用调优」不会被排间隔断。
      while (true) {
        val task = tasks.poll() ?: break
        try {
          task.run()
        } catch (t: Throwable) {
          // 旁路任务失败不能让出 推理线程：一条日志继续跑。
        }
      }
      // 2) 每迭代钩子：token 增量排空 / SSE 节流。
      try {
        iterationHook?.invoke()
      } catch (t: Throwable) {
        // 同上。
      }
      // 3) 没有任务时短暂挂起；有任务时上层会用 unpark 唤醒。
      LockSupport.parkNanos(IDLE_PARK_NANOS)
    }
  }

  fun stop() {
    alive = false
    iterationHook = null
    LockSupport.unpark(thread)
  }

  /** 该线程是否就是当前线程 —— 用于断言调优确实落在了推理线程上。 */
  fun isOnLoopThread(): Boolean = Thread.currentThread() === thread

  fun threadId(): Long = thread.id
}
