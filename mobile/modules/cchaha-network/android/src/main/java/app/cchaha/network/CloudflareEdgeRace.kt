package app.cchaha.network

import java.io.IOException
import java.net.Inet6Address
import java.net.InetAddress
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executor
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit

/**
 * Chooses a reachable Cloudflare edge for hostnames that Cloudflare serves.
 *
 * Some carriers silently drop connections to individual Cloudflare anycast
 * addresses for minutes at a time, and which addresses they drop rotates. Any
 * Cloudflare address serves any proxied hostname (TLS SNI and the Host header
 * pick the site), so when the system resolver answers only with Cloudflare
 * addresses, this races TCP connects to port 443 across that answer and a few
 * alternates, and returns the first address that connected followed by the
 * rest, for OkHttp to fall back on. The choice is cached per hostname for a
 * short time. Every other hostname resolves exactly as the system says,
 * without probing.
 */
class CloudflareEdgeRace(
  private val systemLookup: (String) -> List<InetAddress>,
  private val connector: Connector,
  private val executor: Executor,
  private val alternates: () -> List<InetAddress> = { CloudflareEdges.alternates },
  private val nowMillis: () -> Long = { System.nanoTime() / 1_000_000 },
  private val staggerMillis: Long = 200,
  private val attemptTimeoutMillis: Int = 3_000,
  private val cacheMillis: Long = 120_000,
  private val onRaced: (hostname: String, winner: InetAddress?, elapsedMillis: Long) -> Unit = { _, _, _ -> },
) {
  /** Opens and closes a TCP connection to port 443; throws when none is established within the timeout. */
  fun interface Connector {
    @Throws(IOException::class)
    fun connect(address: InetAddress, timeoutMillis: Int)
  }

  private class Choice(val addresses: List<InetAddress>, val expiresAt: Long)

  private val choices = ConcurrentHashMap<String, Choice>()
  private val locks = ConcurrentHashMap<String, Any>()

  fun lookup(hostname: String): List<InetAddress> {
    val key = hostname.lowercase(Locale.ROOT)
    cached(key)?.let { return it }
    val resolved = systemLookup(hostname)
    if (isIpLiteral(hostname) || resolved.isEmpty() || !resolved.all(CloudflareEdges::contains)) return resolved
    // One race per hostname at a time; lookups that arrive meanwhile take its result.
    synchronized(locks.getOrPut(key) { Any() }) {
      cached(key)?.let { return it }
      val candidates = (resolved.ipv6First() + alternates().ipv6First()).distinct()
      val started = nowMillis()
      val (winner, failed) = race(candidates)
      onRaced(hostname, winner, nowMillis() - started)
      // Nothing connected: answer as the system resolver did, and race again next time.
      if (winner == null) return resolved
      val rest = candidates.filter { it != winner }
      val ordered = listOf(winner) + rest.filterNot(failed::contains) + rest.filter(failed::contains)
      choices[key] = Choice(ordered, nowMillis() + cacheMillis)
      return ordered
    }
  }

  /** A connection to [address] failed: any hostname whose chosen edge it was races again. */
  fun connectFailed(address: InetAddress) {
    choices.entries.removeAll { it.value.addresses.first() == address }
  }

  private fun cached(key: String): List<InetAddress>? {
    val choice = choices[key] ?: return null
    if (nowMillis() < choice.expiresAt) return choice.addresses
    choices.remove(key, choice)
    return null
  }

  /**
   * Happy Eyeballs style: the next attempt starts after [staggerMillis], or as
   * soon as the previous one fails. The first connection wins; attempts still
   * in flight finish on their own within [attemptTimeoutMillis].
   */
  private fun race(candidates: List<InetAddress>): Pair<InetAddress?, Set<InetAddress>> {
    val outcomes = LinkedBlockingQueue<Pair<InetAddress, Boolean>>()
    val failed = HashSet<InetAddress>()
    var started = 0
    var settled = 0
    fun startNext() {
      val address = candidates[started++]
      executor.execute {
        val connected = try {
          connector.connect(address, attemptTimeoutMillis)
          true
        } catch (e: Exception) {
          false
        }
        outcomes.put(address to connected)
      }
    }
    try {
      startNext()
      while (settled < started) {
        val more = started < candidates.size
        val outcome = outcomes.poll(
          if (more) staggerMillis else attemptTimeoutMillis + GRACE_MILLIS,
          TimeUnit.MILLISECONDS
        )
        if (outcome == null) {
          if (!more) break
          startNext()
          continue
        }
        settled++
        if (outcome.second) return outcome.first to failed
        failed += outcome.first
        if (more) startNext()
      }
    } catch (e: InterruptedException) {
      Thread.currentThread().interrupt()
    } catch (e: RejectedExecutionException) {
      // No thread for another attempt: fall back to the resolver's answer.
    }
    return null to failed
  }

  private companion object {
    const val GRACE_MILLIS = 250L

    fun List<InetAddress>.ipv6First() = filterIsInstance<Inet6Address>() + filterNot { it is Inet6Address }

    /** OkHttp 4.9 hands IP literals to its Dns as well; those are never rerouted. */
    fun isIpLiteral(hostname: String) = hostname.contains(':') || hostname.all { it.isDigit() || it == '.' }
  }
}

/** Cloudflare's published ranges, and the alternates raced for hostnames inside them. */
object CloudflareEdges {
  /** https://www.cloudflare.com/ips/ (ips-v4 and ips-v6), as published on 2026-11-08. */
  val ranges = listOf(
    "173.245.48.0/20",
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "141.101.64.0/18",
    "108.162.192.0/18",
    "190.93.240.0/20",
    "188.114.96.0/20",
    "197.234.240.0/22",
    "198.41.128.0/17",
    "162.158.0.0/15",
    "104.16.0.0/13",
    "104.24.0.0/14",
    "172.64.0.0/13",
    "131.0.72.0/22",
    "2400:cb00::/32",
    "2606:4700::/32",
    "2803:f800::/32",
    "2405:b500::/32",
    "2405:8100::/32",
    "2a06:98c0::/29",
    "2c0f:f248::/32",
  )

  /**
   * Anycast addresses that served a live Quick Tunnel hostname, and a
   * third-party Cloudflare zone, by SNI on 2026-11-08. Carriers drop single
   * addresses rather than whole ranges, so they are spread across ranges.
   */
  val alternateLiterals = listOf(
    "2606:4700::6810:e684",
    "2606:4700::6810:e784",
    "2606:4700:3030::6815:1",
    "2a06:98c1:3120::3",
    "2400:cb00:2049::1",
    "2803:f800:50::6ca2:c0d8",
    "104.16.230.132",
    "104.16.231.132",
    "104.16.0.1",
    "172.66.0.1",
    "162.159.192.1",
    "188.114.96.1",
    "104.24.0.1",
    "190.93.244.1",
    "108.162.198.1",
    "103.21.244.1",
  )

  /** Parsed on first use, on a network thread; numeric literals never touch DNS. */
  val alternates: List<InetAddress> by lazy { alternateLiterals.map(InetAddress::getByName) }

  private val blocks by lazy { ranges.map(::Block) }

  fun contains(address: InetAddress): Boolean = blocks.any { it.contains(address.address) }

  private class Block(cidr: String) {
    private val network = InetAddress.getByName(cidr.substringBefore('/')).address
    private val prefix = cidr.substringAfter('/').toInt()

    fun contains(address: ByteArray): Boolean {
      if (address.size != network.size) return false
      var bits = prefix
      var index = 0
      while (bits > 0) {
        val mask = if (bits >= 8) 0xFF else (0xFF shl (8 - bits)) and 0xFF
        if (((address[index].toInt() xor network[index].toInt()) and mask) != 0) return false
        bits -= 8
        index++
      }
      return true
    }
  }
}
