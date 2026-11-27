package app.cchaha.updater

import com.sun.net.httpserver.HttpServer
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.net.InetSocketAddress
import java.nio.file.Files
import java.security.MessageDigest

class ApkDownloaderTest {
  private lateinit var server: HttpServer
  private lateinit var tempDir: File
  private lateinit var baseUrl: String

  private val client = OkHttpClient.Builder()
    .followRedirects(false)
    .followSslRedirects(false)
    .build()

  @Before
  fun setUp() {
    tempDir = Files.createTempDirectory("cchaha-updater-test-").toFile()
    server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    server.start()
    baseUrl = "http://127.0.0.1:${server.address.port}"
  }

  @After
  fun tearDown() {
    server.stop(0)
    tempDir.deleteRecursively()
  }

  private fun loopbackPolicy(): UrlPolicy = object : UrlPolicy {
    override fun validateGitHubManifestUrl(rawUrl: String): HttpUrl = rawUrl.toHttpUrl()
    override fun validateGitHubApkUrl(rawUrl: String): HttpUrl = rawUrl.toHttpUrl()
    override fun validateGitHubRedirectUrl(url: HttpUrl): HttpUrl {
      if (url.host != "127.0.0.1") throw UpdaterException("REDIRECT_BLOCKED", "Blocked redirect")
      return url
    }
    override fun validateRelayApkUrl(rawUrl: String, relayOrigin: String): HttpUrl =
      UpdaterUrlPolicy.validateRelayApkUrl(rawUrl, relayOrigin)
    override fun sanitizeRelayHeaders(headers: Map<String, String>?, relayOrigin: String): Map<String, String> =
      UpdaterUrlPolicy.sanitizeRelayHeaders(headers, relayOrigin)
  }

  private fun sha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

  @Test
  fun cacheStatusExcludesFilesThatStartupCleanupExpires() {
    val bytes = "fixture APK".toByteArray()
    val digest = sha256(bytes)
    // Align to whole seconds so setLastModified assertions are deterministic on 1s-resolution filesystems.
    var now = (System.currentTimeMillis() / 1000L) * 1000L
    val cutoff = now - ApkDownloader.MAX_CACHE_AGE_MS
    val downloader = ApkDownloader(
      client = client,
      updatesDir = tempDir,
      apkValidator = { _, _ -> VerifiedApkInfo("app.cchaha.mobile", "0.1.7", 12L) },
      nowMillis = { now },
    )
    val apk = File(tempDir, "$digest.apk")
    apk.writeBytes(bytes)
    assertTrue(apk.setLastModified(cutoff))
    assertTrue(downloader.getCachedApk(digest, "0.1.7").ready)
    now += 1000L
    val orphan = File(tempDir, "other.apk").apply { writeBytes(bytes) }
    downloader.cleanupCachedApks(digest)
    assertTrue(apk.isFile)
    assertFalse(orphan.exists())

    assertTrue(apk.setLastModified(cutoff - 1000L))
    val part = File(tempDir, "$digest.apk.part")
    part.writeBytes(bytes)
    assertTrue(part.setLastModified(cutoff - 1000L))
    val meta = File(tempDir, "$digest.apk.meta").apply { writeText("totalBytes=64") }

    val result = downloader.getCachedApk(digest, "0.1.7")
    assertFalse(result.ready)
    assertEquals(0L, result.partialBytes)
    assertEquals(null, result.totalBytes)
    assertFalse(apk.exists())
    assertFalse(part.exists())
    assertFalse(meta.exists())
  }

  @Test
  fun downloadsResumesAndVerifiesApk() {
    val payload = ByteArray(128 * 1024) { index -> (index % 251).toByte() }
    val digest = sha256(payload)
    val etag = "\"$digest\""
    var requests = 0

    server.createContext("/api/mobile-update/android/apk") { exchange ->
      requests++
      val range = exchange.requestHeaders.getFirst("Range")
      exchange.responseHeaders.add("X-CC-Haha-Mobile-Update", "1")
      exchange.responseHeaders.add("ETag", etag)
      if (range != null && range.startsWith("bytes=")) {
        val start = range.removePrefix("bytes=").removeSuffix("-").toInt()
        val slice = payload.copyOfRange(start, payload.size)
        exchange.responseHeaders.add("Content-Range", "bytes $start-${payload.size - 1}/${payload.size}")
        exchange.sendResponseHeaders(206, slice.size.toLong())
        exchange.responseBody.use { it.write(slice) }
      } else {
        exchange.sendResponseHeaders(200, payload.size.toLong())
        exchange.responseBody.use { it.write(payload) }
      }
    }

    // Seed a partial download of the first 32 KiB.
    val part = File(tempDir, "$digest.apk.part")
    part.writeBytes(payload.copyOfRange(0, 32 * 1024))
    File(tempDir, "$digest.apk.meta").writeText("etag=$etag\ntotalBytes=${payload.size}")

    val downloader = ApkDownloader(
      client = client,
      updatesDir = tempDir,
      urlPolicy = loopbackPolicy(),
      availableBytes = { 1024L * 1024L * 1024L },
      apkValidator = { _, version -> VerifiedApkInfo("app.cchaha.mobile", version ?: "0.1.7", 12L) },
    )

    val phases = mutableListOf<String>()
    val result = downloader.download(
      DownloadRequest(
        downloadId = "dl-1",
        source = "relay",
        url = "$baseUrl/api/mobile-update/android/apk?sha256=$digest",
        expectedSha256 = digest,
        expectedVersion = "0.1.7",
        relayOrigin = baseUrl,
        headers = mapOf("Authorization" to "Bearer tok"),
      ),
    ) { phases.add(it.phase) }

    assertEquals(1, requests)
    assertEquals(digest, result.sha256)
    assertEquals(payload.size.toLong(), result.sizeBytes)
    assertTrue("verifying" in phases)
    assertTrue(File(tempDir, "$digest.apk").isFile)
    assertFalse(part.exists())
  }

  @Test
  fun deletesCorruptFileOnSha256Mismatch() {
    val payload = "not-matching-apk".toByteArray()
    val expected = "b".repeat(64)

    server.createContext("/apk") { exchange ->
      exchange.sendResponseHeaders(200, payload.size.toLong())
      exchange.responseBody.use { it.write(payload) }
    }

    val downloader = ApkDownloader(
      client = client,
      updatesDir = tempDir,
      urlPolicy = loopbackPolicy(),
      availableBytes = { 1024L * 1024L * 1024L },
      apkValidator = { _, version -> VerifiedApkInfo("app.cchaha.mobile", version ?: "0.1.7", 12L) },
    )

    var code = ""
    try {
      downloader.download(
        DownloadRequest(
          downloadId = "dl-bad",
          source = "github",
          url = "$baseUrl/apk",
          expectedSha256 = expected,
          expectedVersion = "0.1.7",
        ),
      ) {}
    } catch (e: UpdaterException) {
      code = e.code
    }

    assertEquals("SHA256_MISMATCH", code)
    assertFalse(File(tempDir, "$expected.apk.part").exists())
    assertFalse(File(tempDir, "$expected.apk").exists())
  }

  @Test
  fun rejectsRedirectsOnRelayDownloads() {
    val expected = "c".repeat(64)
    server.createContext("/api/mobile-update/android/apk") { exchange ->
      exchange.responseHeaders.add("Location", "https://evil.example.com/steal")
      exchange.sendResponseHeaders(302, -1)
      exchange.close()
    }

    val downloader = ApkDownloader(
      client = client,
      updatesDir = tempDir,
      urlPolicy = loopbackPolicy(),
      availableBytes = { 1024L * 1024L * 1024L },
      apkValidator = { _, version -> VerifiedApkInfo("app.cchaha.mobile", version ?: "0.1.7", 12L) },
    )

    var code = ""
    try {
      downloader.download(
        DownloadRequest(
          downloadId = "dl-redir",
          source = "relay",
          url = "$baseUrl/api/mobile-update/android/apk?sha256=$expected",
          expectedSha256 = expected,
          expectedVersion = "0.1.7",
          relayOrigin = baseUrl,
          headers = mapOf("Authorization" to "Bearer secret"),
        ),
      ) {}
    } catch (e: UpdaterException) {
      code = e.code
    }

    assertEquals("REDIRECT_BLOCKED", code)
  }

  @Test
  fun classifiesOlderDesktopWithoutRelayHeaderAsRelayUnsupported() {
    val expected = "d".repeat(64)
    server.createContext("/api/mobile-update/android/apk") { exchange ->
      val body = """{"error":"Not Found"}""".toByteArray()
      exchange.sendResponseHeaders(404, body.size.toLong())
      exchange.responseBody.use { it.write(body) }
    }

    val downloader = ApkDownloader(
      client = client,
      updatesDir = tempDir,
      urlPolicy = loopbackPolicy(),
      availableBytes = { 1024L * 1024L * 1024L },
      apkValidator = { _, version -> VerifiedApkInfo("app.cchaha.mobile", version ?: "0.1.7", 12L) },
    )

    var code = ""
    try {
      downloader.download(
        DownloadRequest(
          downloadId = "dl-old-desktop",
          source = "relay",
          url = "$baseUrl/api/mobile-update/android/apk?sha256=$expected",
          expectedSha256 = expected,
          expectedVersion = "0.1.7",
          relayOrigin = baseUrl,
        ),
      ) {}
    } catch (e: UpdaterException) {
      code = e.code
    }

    assertEquals("RELAY_UNSUPPORTED", code)
  }
}
