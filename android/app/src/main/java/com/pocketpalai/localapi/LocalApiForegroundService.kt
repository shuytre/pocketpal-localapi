package com.pocketpal.localapi

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * 服务常驻的前台通知（需求 4 的「最低优先级实现」，但仍然要做）。
 *
 * 为什么需要它：Android 10 上后台进程会被系统回收，而我们的 HTTP 服务跑在
 * 应用进程里 —— 一旦进程被回收，端口还在用户的客户端配置里，但没人应答了。
 * 前台服务是未 root 设备上唯一能让进程在后台保持存活的合规手段。
 *
 * 为什么是「可选」：即便不做，App 在前台时服务也完全可用；这里加上只是为了
 * 让「手机放在一边、电脑连续调用」这个真实场景能一直成立。
 */
class LocalApiForegroundService : Service() {

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val port = intent?.getIntExtra(EXTRA_PORT, 0) ?: 0
    createChannel()
    startForeground(NOTIFICATION_ID, buildNotification(port))
    // START_STICKY：进程被杀后系统会尽量重建，端口由上层重新绑定。
    return START_STICKY
  }

  override fun onDestroy() {
    stopForeground(true)
    super.onDestroy()
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return
    }
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
    if (manager?.getNotificationChannel(CHANNEL_ID) != null) {
      return
    }
    val channel =
        NotificationChannel(
            CHANNEL_ID,
            "Local API service",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
          description = "Keeps the local OpenAI-compatible server running while PocketPal is in the background."
          setShowBadge(false)
        }
    manager?.createNotificationChannel(channel)
  }

  private fun buildNotification(port: Int): Notification {
    val text =
        if (port > 0) {
          "Listening on port $port — for academic research only"
        } else {
          "Local API service running — for academic research only"
        }
    return NotificationCompat.Builder(this, CHANNEL_ID)
        .setContentTitle("PocketPal local API")
        .setContentText(text)
        .setSmallIcon(android.R.drawable.stat_sys_download)
        .setOngoing(true)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .build()
  }

  companion object {
    private const val CHANNEL_ID = "pocketpal_local_api"
    private const val NOTIFICATION_ID = 0x5A17
    private const val EXTRA_PORT = "port"

    fun start(context: Context, port: Int) {
      try {
        val intent = Intent(context, LocalApiForegroundService::class.java)
        intent.putExtra(EXTRA_PORT, port)
        ContextCompat.startForegroundService(context, intent)
      } catch (t: Throwable) {
        // 前台服务启动失败（部分 ROM 限制）不应影响 HTTP 服务本身。
      }
    }

    fun stop(context: Context) {
      try {
        context.stopService(Intent(context, LocalApiForegroundService::class.java))
      } catch (t: Throwable) {
        // 同上。
      }
    }
  }
}
