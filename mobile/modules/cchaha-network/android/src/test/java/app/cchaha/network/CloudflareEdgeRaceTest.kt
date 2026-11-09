package app.cchaha.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.ConnectException
import java.net.Inet6Address
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.Collections
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

class CloudflareEdgeRaceTest {
  private val executor = Executors.newCachedThreadPool { task -> Thread(task).apply { isDaemon = true } }

  private fun ip(literal: String): InetAddress = InetAddress.getByName(literal)

  private val tunnelHost = "quick-fixture.trycloudflare.com"
  private val tunnelAnswer = listOf(ip("104.16.230.132"), ip("104.16.231.132"))
  private val alternates = listOf(ip("2606:4700::6810:e684"), ip("104.16.0.1"), ip("172.66.0.1"))

  /** Reachable edges connect at once, refused ones fail at once, and every other address is blackholed. */
  private class Edges(
    private val reachable: Set<InetAddress>,
    private val refused: Set<InetAddress> = emptySet(),
  ) : CloudflareEdgeRace.Connector {
    val attempts: MutableList<InetAddress> = Collections.synchronizedList(mutableListOf())

    override fun connect(address: InetAddress, timeoutMillis: Int) {
      attempts += address
      when (address) {
        in reachable -> return
        in refused -> throw ConnectException("Network is unreachable")
        else -> {
          Thread.sleep(timeoutMillis.toLong())
          throw SocketTimeoutException("blackholed")
        }
      }
    }
  }

  private var now = 0L
  private val systemLookups = AtomicInteger()

  private fun race(edges: Edges, answers: Map<String, List<InetAddress>>) = CloudflareEdgeRace(
    systemLookup = { hostname ->
      systemLookups.incrementAndGet()
      answers[hostname] ?: throw UnknownHostException(hostname)
    },
    connector = edges,
    executor = executor,
    alternates = { alternates },
    nowMillis = { now },
    staggerMillis = 40,
    attemptTimeoutMillis = 1_000,
    cacheMillis = 120_000,
  )

  @Test
  fun blackholedResolverAnswerFallsThroughToAWorkingAlternateWithoutWaitingForTimeouts() {
    // IPv4-only network: IPv6 fails at once; the resolver's two addresses are dropped.
    val edges = Edges(reachable = setOf(ip("104.16.0.1"), ip("172.66.0.1")), refused = setOf(ip("2606:4700::6810:e684")))
    val race = race(edges, mapOf(tunnelHost to tunnelAnswer))

    val started = System.nanoTime()
    val addresses = race.lookup(tunnelHost)
    val elapsedMillis = (System.nanoTime() - started) / 1_000_000

    assertEquals(
      listOf(ip("104.16.0.1"), ip("104.16.230.132"), ip("104.16.231.132"), ip("172.66.0.1"), ip("2606:4700::6810:e684")),
      addresses,
    )
    assertTrue("returned after ${elapsedMillis}ms, before the blackholed attempts timed out", elapsedMillis < 600)
    assertEquals(
      listOf(ip("104.16.230.132"), ip("104.16.231.132"), ip("2606:4700::6810:e684"), ip("104.16.0.1")),
      edges.attempts.toList(),
    )
  }

  @Test
  fun resolverIpv6GoesFirstThenItsIpv4ThenAlternatesAndAFailedRaceIsNotCached() {
    val dualStack = listOf(ip("104.16.230.132"), ip("2606:4700::6810:e784"))
    val everything = (dualStack + alternates).toSet()
    val edges = Edges(reachable = emptySet(), refused = everything)
    val race = race(edges, mapOf(tunnelHost to dualStack))

    assertSame(dualStack, race.lookup(tunnelHost))
    assertEquals(
      listOf(ip("2606:4700::6810:e784"), ip("104.16.230.132"), ip("2606:4700::6810:e684"), ip("104.16.0.1"), ip("172.66.0.1")),
      edges.attempts.toList(),
    )

    race.lookup(tunnelHost)
    assertEquals(10, edges.attempts.size)
  }

  @Test
  fun hostnamesOutsideCloudflareResolveExactlyAsTheSystemSaysWithoutProbing() {
    val lan = listOf(ip("192.168.1.20"))
    val partlyCloudflare = listOf(ip("104.16.0.1"), ip("203.0.113.5"))
    val cloudflareLiteral = listOf(ip("104.16.0.1"))
    val edges = Edges(reachable = alternates.toSet())
    val race = race(
      edges,
      mapOf("desk.local" to lan, "mixed.example" to partlyCloudflare, "104.16.0.1" to cloudflareLiteral, "localhost" to listOf(ip("127.0.0.1"))),
    )

    assertSame(lan, race.lookup("desk.local"))
    assertSame(partlyCloudflare, race.lookup("mixed.example"))
    assertSame(cloudflareLiteral, race.lookup("104.16.0.1"))
    assertEquals(listOf(ip("127.0.0.1")), race.lookup("localhost"))
    assertTrue(edges.attempts.isEmpty())
  }

  @Test
  fun theChoiceIsReusedUntilItExpiresThenRacedAgain() {
    val edges = Edges(reachable = tunnelAnswer.toSet())
    val race = race(edges, mapOf(tunnelHost to tunnelAnswer))

    val first = race.lookup(tunnelHost)
    assertEquals(ip("104.16.230.132"), first.first())
    assertEquals(1, edges.attempts.size)

    now += 119_999
    assertEquals(first, race.lookup(tunnelHost.uppercase()))
    assertEquals(1, edges.attempts.size)
    assertEquals(1, systemLookups.get())

    now += 1
    race.lookup(tunnelHost)
    assertEquals(2, edges.attempts.size)
    assertEquals(2, systemLookups.get())
  }

  @Test
  fun aFailedConnectionToTheChosenEdgeRacesAgainBeforeItExpires() {
    val edges = Edges(reachable = tunnelAnswer.toSet())
    val race = race(edges, mapOf(tunnelHost to tunnelAnswer))
    val winner = race.lookup(tunnelHost).first()

    race.connectFailed(ip("172.66.0.1"))
    race.lookup(tunnelHost)
    assertEquals(1, edges.attempts.size)

    race.connectFailed(winner)
    race.lookup(tunnelHost)
    assertEquals(2, edges.attempts.size)
  }

  @Test
  fun publishedRangesMatchOnPrefixBoundariesAndCoverEveryAlternate() {
    for (inside in listOf("104.16.0.0", "104.23.255.255", "104.27.255.255", "172.71.255.255", "2606:4700::1", "2a06:98c7:ffff::1"))
      assertTrue(inside, CloudflareEdges.contains(ip(inside)))
    for (outside in listOf("1.1.1.1", "104.15.255.255", "104.28.0.0", "172.72.0.0", "192.168.1.20", "2606:4701::1", "2a06:98c8::1", "2001:db8::1"))
      assertFalse(outside, CloudflareEdges.contains(ip(outside)))

    val builtIn = CloudflareEdges.alternates
    assertEquals(CloudflareEdges.alternateLiterals.size, builtIn.toSet().size)
    for (address in builtIn) assertTrue(address.hostAddress, CloudflareEdges.contains(address))
    assertTrue(builtIn.any { it is Inet6Address })
    assertTrue(builtIn.any { it !is Inet6Address })
  }
}
