package app.cchaha.duty

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * Keeps one long poll open to every paired computer that registered this phone for
 * `desktop` push, and turns what they send into ordinary notifications. This is the
 * Android channel that needs neither Google services nor a store listing; Chinese
 * ROMs may still stop it unless the user exempts the app from battery limits.
 */
class DutyService : Service() {
  companion object {
    private const val DUTY_CHANNEL = "cc-haha-duty"
    private const val FALLBACK_CHANNEL = "cc-haha"
    private const val ONGOING_ID = 7301
    private const val PULL_PATH = "/api/sessions/mobile-push/pull"
    // Bounds how late the first alert can be after a short outage (desktop restart, Wi-Fi hop).
    private const val MAX_BACKOFF_MS = 30_000L
    // A computer unreachable this long is likely away (another network, laptop closed):
    // try it rarely. Opening the app or a network change still retries at once.
    private const val UNREACHABLE_AFTER_MS = 5 * 60_000L
    private const val UNREACHABLE_BACKOFF_MS = 5 * 60_000L
    // The computer answers a pull within 25 s; longer means a half-open connection.
    private const val STALE_REQUEST_MS = 40_000L
    // Sleeping CPUs do not advance thread timers; this system alarm checks on the workers.
    private const val WATCHDOG_MS = 60_000L
    // Keeps the CPU up from a wake-up until the next pull is on the wire, no longer.
    private const val RETRY_WAKE_MS = 20_000L

    @Volatile private var instance: DutyService? = null
    /** While the app is on screen, alerts go to the shade without a heads-up, like iOS. */
    @Volatile var appActive = false

    val running get() = instance != null
    val connected get() = instance?.anyConnected() == true

    internal fun setHost(context: Context, host: DutyHost) =
      sync(context, DutyStore.update(context) { hosts -> hosts.filter { it.hostId != host.hostId } + host })

    fun removeHost(context: Context, hostId: String) =
      sync(context, DutyStore.update(context) { hosts -> hosts.filter { it.hostId != hostId } })

    fun retainHosts(context: Context, hostIds: Set<String>) =
      sync(context, DutyStore.update(context) { hosts -> hosts.filter { it.hostId in hostIds } })

    /** Start, reload or stop the service to match the stored list. */
    private fun sync(context: Context, hosts: List<DutyHost>) {
      val current = instance
      when {
        hosts.isEmpty() -> context.stopService(Intent(context, DutyService::class.java))
        current != null -> current.reload()
        else -> start(context)
      }
    }

    fun setAppActive(context: Context, active: Boolean) {
      appActive = active
      if (!active) return
      // The user is looking: reconnect computers now instead of at their next slow retry.
      instance?.retryAll()
      // Android only lets a foreground service start from the foreground; catch up here.
      if (instance == null && DutyStore.load(context).isNotEmpty()) start(context)
    }

    fun start(context: Context): Boolean = try {
      ContextCompat.startForegroundService(context, Intent(context, DutyService::class.java))
      true
    } catch (_: Exception) {
      // ForegroundServiceStartNotAllowedException in the background; the app retries when shown.
      false
    }

    fun watchdog() = instance?.checkWorkers()
  }

  private val workers = mutableMapOf<String, Worker>()
  private var networkCallback: ConnectivityManager.NetworkCallback? = null
  @Volatile private var destroyed = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
    ensureChannels()
    val notification = ongoing(false)
    if (Build.VERSION.SDK_INT >= 34) startForeground(ONGOING_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    else startForeground(ONGOING_ID, notification)
    watchNetwork()
    armWatchdog()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    reload()
    return START_STICKY
  }

  override fun onDestroy() {
    destroyed = true
    instance = null
    synchronized(workers) {
      workers.values.forEach { it.halt() }
      workers.clear()
    }
    networkCallback?.let {
      try { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) } catch (_: Exception) {}
    }
    getSystemService(AlarmManager::class.java)?.cancel(watchdogIntent())
    super.onDestroy()
  }

  /** Re-read the stored host list; workers whose host or credentials changed restart. */
  fun reload() {
    val hosts = DutyStore.load(this)
    if (hosts.isEmpty()) {
      stopSelf()
      return
    }
    synchronized(workers) {
      if (destroyed) return
      val wanted = hosts.associateBy { it.hostId }
      workers.entries.removeAll { (id, worker) ->
        val stale = wanted[id] != worker.host
        if (stale) worker.halt()
        stale
      }
      for (host in hosts) if (host.hostId !in workers) workers[host.hostId] = Worker(host).also { it.start() }
    }
    refreshOngoing()
  }

  private fun anyConnected() = synchronized(workers) { workers.values.any { it.connected } }

  /**
   * The computer says it no longer knows this phone. Remove exactly that host;
   * if the app re-registered it meanwhile (a new token or credential), keep it.
   */
  private fun forget(host: DutyHost) {
    synchronized(workers) {
      if (workers[host.hostId]?.host == host) workers.remove(host.hostId)
    }
    val remaining = DutyStore.update(this) { hosts -> hosts.filter { it != host } }
    if (remaining.isEmpty()) stopSelf() else refreshOngoing()
  }

  private fun watchNetwork() {
    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        synchronized(workers) { workers.values.forEach { it.retryNow() } }
      }
    }
    try {
      getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(callback)
      networkCallback = callback
    } catch (_: Exception) {}
  }

  private fun watchdogIntent(): PendingIntent = PendingIntent.getBroadcast(
    this, 0, Intent(this, DutyWatchdogReceiver::class.java),
    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
  )

  /** Inexact and Doze-tolerant: needs no exact-alarm permission; Doze may stretch it to minutes. */
  private fun armWatchdog() {
    if (destroyed) return
    val alarms = getSystemService(AlarmManager::class.java) ?: return
    alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + WATCHDOG_MS, watchdogIntent())
  }

  /**
   * Runs on the alarm, which itself keeps the CPU up only for this call. Healthy
   * workers cost nothing; a worker that is due takes its own short wake lock.
   */
  private fun checkWorkers() {
    val now = SystemClock.elapsedRealtime()
    synchronized(workers) { workers.values.forEach { it.check(now) } }
    armWatchdog()
  }

  private fun retryAll() = synchronized(workers) { workers.values.forEach { it.retryNow() } }

  private fun ensureChannels() {
    if (Build.VERSION.SDK_INT < 26) return
    val manager = getSystemService(NotificationManager::class.java)
    if (manager.getNotificationChannel(DUTY_CHANNEL) == null) {
      manager.createNotificationChannel(NotificationChannel(DUTY_CHANNEL, "后台连接", NotificationManager.IMPORTANCE_LOW).apply {
        description = "保持与电脑的连接，用来在后台接收提醒"
        setShowBadge(false)
      })
    }
    // The app creates the real channels; this only covers a service started before the app ran.
    if (manager.getNotificationChannel(FALLBACK_CHANNEL) == null) {
      manager.createNotificationChannel(NotificationChannel(FALLBACK_CHANNEL, "任务与审批", NotificationManager.IMPORTANCE_HIGH))
    }
  }

  private fun launchIntent(uri: String?): PendingIntent {
    val intent = if (uri != null) Intent(Intent.ACTION_VIEW, Uri.parse(uri)).setPackage(packageName)
    else packageManager.getLaunchIntentForPackage(packageName) ?: Intent().setPackage(packageName)
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(this, uri?.hashCode() ?: 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun ongoing(connected: Boolean): Notification = NotificationCompat.Builder(this, DUTY_CHANNEL)
    .setSmallIcon(R.drawable.cchaha_duty_icon)
    .setContentTitle(if (connected) "正在值守" else "正在连接电脑…")
    .setContentText(if (connected) "电脑需要你决定或任务结束时，会马上提醒你" else "连上后，电脑的审批和任务提醒会出现在这里")
    .setOngoing(true)
    .setSilent(true)
    .setShowWhen(false)
    .setPriority(NotificationCompat.PRIORITY_LOW)
    .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
    .setContentIntent(launchIntent(null))
    .build()

  private var shownConnected: Boolean? = null
  @Synchronized private fun refreshOngoing() {
    if (instance !== this) return
    val connected = anyConnected()
    if (shownConnected == connected) return
    shownConnected = connected
    try { NotificationManagerCompat.from(this).notify(ONGOING_ID, ongoing(connected)) } catch (_: SecurityException) {}
  }

  private fun post(host: DutyHost, item: JSONObject) {
    val manager = NotificationManagerCompat.from(this)
    if (!manager.areNotificationsEnabled()) return
    val data = item.optJSONObject("data") ?: JSONObject()
    val sessionId = data.optString("sessionId").ifEmpty { null }
    val requestId = data.optString("requestId").ifEmpty { null }
    val base = sessionId?.let { "cchaha:///chat/${enc(it)}?host=${enc(host.hostId)}" + (requestId?.let { id -> "&requestId=${enc(id)}" } ?: "") }
    val requested = item.optString("channelId")
    val channel = if (requested.isNotEmpty() && (Build.VERSION.SDK_INT < 26 || getSystemService(NotificationManager::class.java).getNotificationChannel(requested) != null)) requested else FALLBACK_CHANNEL
    val body = item.optString("body")
    // The settings test is tapped inside the app and exists to show a banner, so the
    // in-app quiet below does not apply to it.
    val test = data.optString("eventType") == "test"
    val builder = NotificationCompat.Builder(this, channel)
      .setSmallIcon(R.drawable.cchaha_duty_icon)
      .setContentTitle(item.optString("title").ifEmpty { host.hostName })
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setSubText(host.hostName)
      .setAutoCancel(true)
      .setCategory(if (item.optString("category") == "cchahaResult") NotificationCompat.CATEGORY_STATUS else NotificationCompat.CATEGORY_REMINDER)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setContentIntent(launchIntent(base))
      .setSilent(appActive && !test)
    // Like the iOS category: the app opens, re-checks the exact pending request, then answers it.
    if (item.optString("category") == "cchahaTool" && base != null && requestId != null) {
      builder.addAction(0, "拒绝", launchIntent("$base&notificationAction=deny"))
      builder.addAction(0, "允许", launchIntent("$base&notificationAction=allow"))
    }
    // A newer alert for the same session replaces the older one instead of stacking.
    try { manager.notify("cchaha:${host.hostId}:${sessionId ?: "test"}", 1, builder.build()) } catch (_: SecurityException) {}
  }

  private fun enc(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")

  private sealed interface Pulled
  private object Gone : Pulled
  private object Delivered : Pulled

  /**
   * One computer. The CPU is held awake only from a wake-up (a reply arriving, a due
   * retry, a dropped half-open pull) until the next pull is on the wire; while the
   * computer holds the pull, its reply is what wakes the phone again.
   */
  private inner class Worker(val host: DutyHost) : Thread("cchaha-duty") {
    @Volatile private var stopped = false
    @Volatile private var connection: HttpURLConnection? = null
    /** `elapsedRealtime` when the current pull started, which keeps counting while asleep; 0 when idle. */
    @Volatile private var requestStartedAt = 0L
    /** `elapsedRealtime` when the current retry wait ends; 0 when not waiting. */
    @Volatile private var retryAt = 0L
    /** The watchdog dropped a half-open pull: reconnect at once, not after a backoff. */
    @Volatile private var abandoned = false
    @Volatile var connected = false
    private var ack: String? = null
    private val seen = ArrayDeque<String>()
    private val waking = getSystemService(PowerManager::class.java)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "cchaha:duty-pull")
      .apply { setReferenceCounted(false) }

    fun halt() {
      stopped = true
      interrupt()
      connection?.disconnect()
      release()
    }

    /** The network came back or the user opened the app: end any retry wait now. */
    fun retryNow() {
      if (retryAt != 0L) wake()
    }

    /** From the watchdog alarm: acts only when this worker is overdue. */
    fun check(now: Long) {
      if (retryAt != 0L && now >= retryAt) wake()
      else if (requestStartedAt != 0L && now - requestStartedAt > STALE_REQUEST_MS) {
        abandoned = true
        hold()
        connection?.disconnect()
      }
    }

    private fun wake() {
      hold()
      interrupt()
    }

    private fun hold() = waking.acquire(RETRY_WAKE_MS)

    private fun release() {
      if (waking.isHeld) waking.release()
    }

    override fun run() {
      var backoff = 2_000L
      var failingSince = 0L
      hold()
      try {
        while (!stopped) {
          try {
            if (pull() == Gone) {
              if (!stopped) forget(host)
              return
            }
            backoff = 2_000L
            failingSince = 0L
            markConnected(true)
          } catch (_: Exception) {
            if (stopped) return
            if (abandoned) {
              abandoned = false
              continue
            }
            release()
            markConnected(false)
            val now = SystemClock.elapsedRealtime()
            if (failingSince == 0L) failingSince = now
            val wait = if (now - failingSince >= UNREACHABLE_AFTER_MS) UNREACHABLE_BACKOFF_MS else backoff
            // The sleep stops counting while the CPU is suspended; the watchdog ends it when due.
            retryAt = now + wait
            try { Thread.sleep(wait) } catch (_: InterruptedException) {}
            retryAt = 0L
            backoff = (backoff * 2).coerceAtMost(MAX_BACKOFF_MS)
          }
        }
      } finally {
        release()
      }
    }

    private fun markConnected(value: Boolean) {
      if (connected == value) return
      connected = value
      refreshOngoing()
    }

    private fun pull(): Pulled {
      val request = URL(host.origin + PULL_PATH).openConnection() as HttpURLConnection
      connection = request
      requestStartedAt = SystemClock.elapsedRealtime()
      try {
        request.instanceFollowRedirects = false
        request.connectTimeout = 10_000
        request.readTimeout = 45_000
        request.requestMethod = "POST"
        request.doOutput = true
        request.setRequestProperty("Content-Type", "application/json")
        request.setRequestProperty("Accept", "application/json")
        for ((name, value) in host.headers) if (value.isNotEmpty()) request.setRequestProperty(name, value)
        val body = JSONObject().put("token", host.token)
        ack?.let { body.put("ack", it) }
        request.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
        // On the wire: the computer holds it, and its reply wakes the phone.
        release()
        val status = request.responseCode
        // Awake again; stay up through posting alerts and sending the next pull.
        hold()
        // Only this computer's own answers end the duty: the pairing credential was
        // rejected, or it no longer has this phone's registration. Proxies, tunnels and
        // firewalls answer 403/5xx for passing reasons; those are retried.
        if (status == 401) return Gone
        if (status == 404 && errorBody(request).contains("NO_REGISTRATION")) return Gone
        if (status != 200) throw IOException("HTTP $status")
        val text = request.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
        val notifications = JSONObject(text).optJSONArray("notifications") ?: JSONArray()
        if (notifications.length() > 0) deliver(notifications)
        return Delivered
      } finally {
        requestStartedAt = 0L
        connection = null
        request.disconnect()
      }
    }

    private fun errorBody(request: HttpURLConnection) = try {
      request.errorStream?.bufferedReader(Charsets.UTF_8)?.use { it.readText().take(4096) } ?: ""
    } catch (_: Exception) {
      ""
    }

    /** Runs under the pull's wake lock, taken when the reply arrived. */
    private fun deliver(notifications: JSONArray) {
      for (index in 0 until notifications.length()) {
        val item = notifications.optJSONObject(index) ?: continue
        val id = item.optString("id")
        if (id.isEmpty()) continue
        if (id !in seen) {
          post(host, item)
          seen.addLast(id)
          if (seen.size > 64) seen.removeFirst()
        }
        ack = id
      }
    }
  }
}
