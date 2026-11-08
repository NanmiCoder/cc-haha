package app.cchaha.network

import android.content.Context
import android.util.Log
import com.facebook.react.modules.network.OkHttpClientProvider
import okhttp3.Cache
import okhttp3.Dns
import okhttp3.OkHttpClient
import java.io.File
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketAddress
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory

/**
 * Routes React Native's and Expo's OkHttp clients through [CloudflareEdgeRace].
 * The generated `MainApplication.onCreate` calls [install] and applies
 * [configureWebSocket] to React Native's WebSocket client before React starts
 * (see `plugins/withPinnedWebSockets.js`).
 */
object CloudflareEdge {
  private const val TAG = "CCHahaEdge"

  /** Long enough for a slow handshake, short enough that OkHttp reaches the next address. */
  private const val CONNECT_TIMEOUT_SECONDS = 5L

  /** React Native's own HTTP cache: same directory and size as `OkHttpClientProvider.createClientBuilder(context)`. */
  private const val HTTP_CACHE_BYTES = 10L * 1024 * 1024

  private val race = CloudflareEdgeRace(
    systemLookup = Dns.SYSTEM::lookup,
    connector = { address, timeoutMillis ->
      Socket().use { it.connect(InetSocketAddress(address, 443), timeoutMillis) }
    },
    executor = Executors.newCachedThreadPool { task ->
      Thread(task, "cc-haha-edge-probe").apply { isDaemon = true }
    },
    onRaced = { hostname, winner, elapsedMillis ->
      Log.i(TAG, "$hostname -> ${winner?.hostAddress ?: "no edge connected"} in ${elapsedMillis}ms")
    },
  )

  private val dns = object : Dns {
    override fun lookup(hostname: String): List<InetAddress> = race.lookup(hostname)
  }

  private val sockets = ReportingSocketFactory(race::connectFailed)

  /**
   * Every client created through `OkHttpClientProvider`: `expo/fetch`, XHR,
   * images. A factory replaces React Native's whole default client, so this
   * rebuilds it: the default builder (cookie jar container, no read or write
   * timeout) plus the HTTP cache, now one shared instance.
   */
  @JvmStatic
  fun install(context: Context) {
    val application = context.applicationContext
    val cache by lazy { Cache(File(application.cacheDir, "http-cache"), HTTP_CACHE_BYTES) }
    OkHttpClientProvider.setOkHttpClientFactory {
      configure(OkHttpClientProvider.createClientBuilder().cache(cache)).build()
    }
  }

  /**
   * React Native builds each WebSocket client from `getOkHttpClient()`, which
   * now carries the HTTP cache; an upgrade request never used one.
   */
  @JvmStatic
  fun configureWebSocket(builder: OkHttpClient.Builder): OkHttpClient.Builder =
    configure(builder).cache(null)

  private fun configure(builder: OkHttpClient.Builder): OkHttpClient.Builder =
    builder
      .dns(dns)
      .socketFactory(sockets)
      .connectTimeout(CONNECT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
}

/** Reports failed connects so a stale edge choice is raced again before it expires. */
private class ReportingSocketFactory(
  private val connectFailed: (InetAddress) -> Unit
) : SocketFactory() {
  private val system = getDefault()

  override fun createSocket(): Socket = ReportingSocket(connectFailed)

  override fun createSocket(host: String?, port: Int): Socket = system.createSocket(host, port)

  override fun createSocket(host: String?, port: Int, localHost: InetAddress?, localPort: Int): Socket =
    system.createSocket(host, port, localHost, localPort)

  override fun createSocket(host: InetAddress?, port: Int): Socket = system.createSocket(host, port)

  override fun createSocket(address: InetAddress?, port: Int, localAddress: InetAddress?, localPort: Int): Socket =
    system.createSocket(address, port, localAddress, localPort)
}

private class ReportingSocket(private val connectFailed: (InetAddress) -> Unit) : Socket() {
  override fun connect(endpoint: SocketAddress?, timeout: Int) {
    try {
      super.connect(endpoint, timeout)
    } catch (e: IOException) {
      // OkHttp cancels a call by closing its socket; that says nothing about the edge.
      if (!isClosed) (endpoint as? InetSocketAddress)?.address?.let(connectFailed)
      throw e
    }
  }
}
