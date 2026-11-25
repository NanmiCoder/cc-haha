package app.cchaha.updater

import okhttp3.Call
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

data class DownloadRequest(
  val downloadId: String,
  val source: String,
  val url: String,
  val expectedSha256: String,
  val expectedVersion: String,
  val relayOrigin: String? = null,
  val headers: Map<String, String>? = null,
)

data class DownloadProgress(
  val downloadId: String,
  val phase: String,
  val bytesWritten: Long,
  val totalBytes: Long?,
  val resumedFromBytes: Long,
)

data class DownloadResult(
  val sha256: String,
  val versionName: String,
  val versionCode: Long,
  val sizeBytes: Long,
)

data class CachedApkStatus(
  val ready: Boolean,
  val verified: Boolean,
  val partialBytes: Long,
  val totalBytes: Long?,
  val sizeBytes: Long?,
  val versionName: String?,
  val versionCode: Long?,
)

class ApkDownloader(
  private val client: OkHttpClient,
  private val updatesDir: File,
  private val urlPolicy: UrlPolicy = UpdaterUrlPolicy,
  private val availableBytes: (File) -> Long = { dir -> dir.usableSpace },
  private val apkValidator: (File, String?) -> VerifiedApkInfo,
  private val nowMillis: () -> Long = { System.currentTimeMillis() },
) {
  companion object {
    const val MAX_MANIFEST_BYTES = 64L * 1024L
    const val MAX_APK_BYTES = 250L * 1024L * 1024L
    const val DISK_HEADROOM_BYTES = 64L * 1024L * 1024L
    const val UNKNOWN_SIZE_REQUIRED_BYTES = 200L * 1024L * 1024L
    const val MAX_REDIRECTS = 5
    const val MAX_CACHE_AGE_MS = 7L * 24L * 60L * 60L * 1000L
    private const val PROGRESS_MIN_INTERVAL_MS = 150L
    private const val PROGRESS_MIN_BYTES = 256L * 1024L
    private const val BUFFER_BYTES = 64 * 1024
    private const val RELAY_HEADER = "X-CC-Haha-Mobile-Update"

    private val SHA256_REGEX = Regex("^[a-f0-9]{64}$")
    private val SEMVER_REGEX = Regex("^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$")
    private val CONTENT_RANGE_REGEX = Regex("^bytes\\s+(\\d+)-(\\d+)/(\\d+)$")
  }

  private class ActiveDownload(
    val downloadId: String,
    val partFile: File,
    val metaFile: File,
  ) {
    val cancelled = AtomicBoolean(false)
    val deletePartial = AtomicBoolean(false)
    val currentCall = AtomicReference<Call?>(null)
  }

  private val active = AtomicReference<ActiveDownload?>(null)

  fun fetchManifest(rawUrl: String = UpdaterUrlPolicy.GITHUB_MANIFEST_URL): String {
    val initialUrl = urlPolicy.validateGitHubManifestUrl(rawUrl)
    try {
      executeWithValidatedRedirects(
        initialUrl = initialUrl,
        allowRedirects = true,
        headers = mapOf("Accept" to "application/json"),
        activeDownload = null,
      ).use { response ->
        val status = response.code
        if (status == 404) throw UpdaterException("MANIFEST_NOT_FOUND", "Release manifest not found")
        if (status == 403 || status == 429) throw UpdaterException("RATE_LIMITED", "GitHub rate limited request ($status)")
        if (status != 200) throw UpdaterException("HTTP_ERROR", "Manifest request failed with HTTP $status")
        val contentLength = response.body?.contentLength() ?: -1L
        if (contentLength > MAX_MANIFEST_BYTES) {
          throw UpdaterException("INVALID_MANIFEST", "Manifest exceeds size limit")
        }
        val stream = response.body?.byteStream()
          ?: throw UpdaterException("INVALID_MANIFEST", "Empty manifest body")
        val bytes = readBounded(stream, MAX_MANIFEST_BYTES)
        return bytes.toString(Charsets.UTF_8)
      }
    } catch (e: Throwable) {
      throw mapNetworkException(e, false)
    }
  }

  fun cancel(downloadId: String?, deletePartial: Boolean): Boolean {
    val current = active.get() ?: return false
    if (!downloadId.isNullOrEmpty() && current.downloadId != downloadId) return false
    current.deletePartial.set(deletePartial)
    current.cancelled.set(true)
    current.currentCall.get()?.cancel()
    return true
  }

  fun getCachedApk(expectedSha256: String, expectedVersion: String?): CachedApkStatus {
    val sha = validateSha256(expectedSha256)
    ensureUpdatesDir()
    val finalFile = apkFile(sha)
    if (finalFile.isFile) {
      val verified = tryVerifyExisting(finalFile, sha, expectedVersion)
      if (verified != null) {
        return CachedApkStatus(
          ready = true,
          verified = true,
          partialBytes = finalFile.length(),
          totalBytes = finalFile.length(),
          sizeBytes = finalFile.length(),
          versionName = verified.versionName,
          versionCode = verified.versionCode,
        )
      }
      finalFile.delete()
    }
    val part = partFile(sha)
    val partialBytes = if (part.isFile) part.length() else 0L
    val meta = readMeta(metaFile(sha))
    return CachedApkStatus(
      ready = false,
      verified = false,
      partialBytes = partialBytes,
      totalBytes = meta?.totalBytes,
      sizeBytes = null,
      versionName = null,
      versionCode = null,
    )
  }

  fun cleanupCachedApks(keepSha256: String? = null): Int {
    if (!updatesDir.isDirectory) return 0
    val keep = keepSha256?.takeIf { SHA256_REGEX.matches(it) }
    val activeFiles = active.get()?.let { setOf(it.partFile.name, it.metaFile.name) } ?: emptySet()
    val cutoff = nowMillis() - MAX_CACHE_AGE_MS
    var removed = 0
    for (file in updatesDir.listFiles().orEmpty()) {
      if (!file.isFile) continue
      if (file.name in activeFiles) continue
      val isKept = keep != null && (
        file.name == "$keep.apk" ||
          file.name == "$keep.apk.part" ||
          file.name == "$keep.apk.meta"
        )
      if (isKept && file.lastModified() >= cutoff) continue
      if (file.delete()) removed++
    }
    return removed
  }

  fun resolveVerifiedApkFile(expectedSha256: String, expectedVersion: String): File {
    val sha = validateSha256(expectedSha256)
    val version = validateSemver(expectedVersion)
    ensureUpdatesDir()
    val file = apkFile(sha)
    if (!file.isFile) {
      throw UpdaterException("APK_NOT_FOUND", "Downloaded APK not found")
    }
    val actualSha = computeFileSha256(file)
    if (actualSha != sha) {
      file.delete()
      throw UpdaterException("SHA256_MISMATCH", "Cached APK checksum mismatch")
    }
    try {
      apkValidator(file, version)
    } catch (e: UpdaterException) {
      if (e.code != "SIGNATURE_MISMATCH") file.delete()
      throw e
    }
    return file
  }

  fun download(
    request: DownloadRequest,
    onProgress: (DownloadProgress) -> Unit,
  ): DownloadResult {
    val sha = validateSha256(request.expectedSha256)
    val version = validateSemver(request.expectedVersion)
    if (request.downloadId.isBlank()) {
      throw UpdaterException("INVALID_ARGUMENT", "downloadId is required")
    }
    val isRelay = when (request.source) {
      "github" -> false
      "relay" -> true
      else -> throw UpdaterException("INVALID_ARGUMENT", "Unsupported download source")
    }
    val initialUrl = if (isRelay) {
      val origin = request.relayOrigin
        ?: throw UpdaterException("INVALID_URL", "relayOrigin is required for relay downloads")
      urlPolicy.validateRelayApkUrl(request.url, origin)
    } else {
      urlPolicy.validateGitHubApkUrl(request.url)
    }
    val headers = if (isRelay) {
      urlPolicy.sanitizeRelayHeaders(request.headers, request.relayOrigin!!)
    } else {
      emptyMap()
    }

    ensureUpdatesDir()
    val finalFile = apkFile(sha)
    val part = partFile(sha)
    val meta = metaFile(sha)
    val state = ActiveDownload(request.downloadId, part, meta)
    if (!active.compareAndSet(null, state)) {
      throw UpdaterException("DOWNLOAD_IN_PROGRESS", "Another APK download is already running")
    }

    try {
      // Short-circuit if the exact verified APK is already cached.
      if (finalFile.isFile) {
        val verified = tryVerifyExisting(finalFile, sha, version)
        if (verified != null) {
          cleanupOtherFiles(sha)
          return DownloadResult(
            sha256 = sha,
            versionName = verified.versionName,
            versionCode = verified.versionCode,
            sizeBytes = finalFile.length(),
          )
        }
        finalFile.delete()
      }

      // Drop stale artifacts from other versions while preserving exact-hash `.part` for resume.
      cleanupOtherFiles(sha)

      var attempt = 0
      while (true) {
        attempt++
        val existingBytes = if (part.isFile) part.length() else 0L
        val savedMeta = readMeta(meta)
        val reqHeaders = linkedMapOf<String, String>()
        reqHeaders.putAll(headers)
        reqHeaders["Accept"] = "application/vnd.android.package-archive, application/octet-stream"
        if (existingBytes > 0L) {
          reqHeaders["Range"] = "bytes=$existingBytes-"
          savedMeta?.etag?.takeIf { it.isNotBlank() }?.let { reqHeaders["If-Range"] = it }
        }

        onProgress(
          DownloadProgress(
            downloadId = request.downloadId,
            phase = "connecting",
            bytesWritten = existingBytes,
            totalBytes = savedMeta?.totalBytes,
            resumedFromBytes = existingBytes,
          ),
        )

        val retryFromZero = executeWithValidatedRedirects(
          initialUrl = initialUrl,
          allowRedirects = !isRelay,
          headers = reqHeaders,
          activeDownload = state,
        ).use { response ->
          val status = response.code
          if (status == 416 && existingBytes > 0L && attempt == 1) {
            part.delete()
            meta.delete()
            return@use true
          }
          if (status != 200 && status != 206) {
            throw mapHttpFailure(response, isRelay, part, meta)
          }

          val isPartial = status == 206 && existingBytes > 0L
          val totalBytes: Long?
          val startOffset: Long
          if (isPartial) {
            val contentRange = response.header("Content-Range")
            val match = contentRange?.let { CONTENT_RANGE_REGEX.matchEntire(it.trim()) }
              ?: throw UpdaterException("HTTP_ERROR", "Invalid Content-Range header on 206 response")
            val rangeStart = match.groupValues[1].toLong()
            val rangeEnd = match.groupValues[2].toLong()
            val rangeTotal = match.groupValues[3].toLong()
            if (rangeStart != existingBytes || rangeEnd < rangeStart || rangeTotal > MAX_APK_BYTES) {
              part.delete()
              meta.delete()
              if (attempt == 1) return@use true
              throw UpdaterException("HTTP_ERROR", "Incompatible Content-Range response")
            }
            if (savedMeta?.totalBytes != null && savedMeta.totalBytes != rangeTotal) {
              part.delete()
              meta.delete()
              if (attempt == 1) return@use true
              throw UpdaterException("HTTP_ERROR", "Remote APK size changed during resume")
            }
            totalBytes = rangeTotal
            startOffset = existingBytes
          } else {
            val contentLength = response.body?.contentLength()?.takeIf { it > 0L }
            if (contentLength != null && contentLength > MAX_APK_BYTES) {
              throw UpdaterException("APK_TOO_LARGE", "APK exceeds 250 MiB limit")
            }
            totalBytes = contentLength
            startOffset = 0L
          }

          val remainingBytes = if (totalBytes != null) (totalBytes - startOffset).coerceAtLeast(0L) else null
          val requiredSpace = if (remainingBytes != null) {
            remainingBytes + DISK_HEADROOM_BYTES
          } else {
            UNKNOWN_SIZE_REQUIRED_BYTES
          }
          val freeSpace = availableBytes(updatesDir)
          if (freeSpace < requiredSpace) {
            throw UpdaterException("INSUFFICIENT_STORAGE", "Insufficient free storage for APK update")
          }

          val etag = response.header("ETag")
          writeMeta(meta, DownloadMeta(etag = etag, totalBytes = totalBytes))

          val bodyStream = response.body?.byteStream()
            ?: throw UpdaterException("HTTP_ERROR", "Empty APK response body")

          var written = startOffset
          var lastEmitTime = 0L
          var lastEmitBytes = startOffset

          onProgress(
            DownloadProgress(
              downloadId = request.downloadId,
              phase = "downloading",
              bytesWritten = written,
              totalBytes = totalBytes,
              resumedFromBytes = startOffset,
            ),
          )

          FileOutputStream(part, isPartial).use { output ->
            val buffer = ByteArray(BUFFER_BYTES)
            while (true) {
              if (state.cancelled.get()) {
                throw UpdaterException("CANCELLED", "Download cancelled")
              }
              val read = bodyStream.read(buffer)
              if (read < 0) break
              if (read == 0) continue
              written += read
              if (written > MAX_APK_BYTES) {
                throw UpdaterException("APK_TOO_LARGE", "APK stream exceeded 250 MiB limit")
              }
              output.write(buffer, 0, read)
              val now = nowMillis()
              if (now - lastEmitTime >= PROGRESS_MIN_INTERVAL_MS || written - lastEmitBytes >= PROGRESS_MIN_BYTES) {
                lastEmitTime = now
                lastEmitBytes = written
                onProgress(
                  DownloadProgress(
                    downloadId = request.downloadId,
                    phase = "downloading",
                    bytesWritten = written,
                    totalBytes = totalBytes,
                    resumedFromBytes = startOffset,
                  ),
                )
              }
            }
            output.flush()
            output.fd.sync()
          }

          if (totalBytes != null && written != totalBytes) {
            throw UpdaterException("DOWNLOAD_INTERRUPTED", "Download ended prematurely ($written/$totalBytes)")
          }
          false
        }

        if (retryFromZero) continue

        if (state.cancelled.get()) {
          throw UpdaterException("CANCELLED", "Download cancelled")
        }

        onProgress(
          DownloadProgress(
            downloadId = request.downloadId,
            phase = "verifying",
            bytesWritten = part.length(),
            totalBytes = part.length(),
            resumedFromBytes = 0L,
          ),
        )

        val actualSha = computeFileSha256(part) { state.cancelled.get() }
        if (state.cancelled.get()) {
          throw UpdaterException("CANCELLED", "Download cancelled")
        }
        if (actualSha != sha) {
          part.delete()
          meta.delete()
          throw UpdaterException("SHA256_MISMATCH", "Downloaded APK checksum mismatch")
        }

        val verified = try {
          apkValidator(part, version)
        } catch (e: Throwable) {
          part.delete()
          meta.delete()
          throw e
        }

        if (state.cancelled.get()) {
          throw UpdaterException("CANCELLED", "Download cancelled")
        }

        promoteAtomically(part, finalFile)
        meta.delete()
        cleanupOtherFiles(sha)

        return DownloadResult(
          sha256 = sha,
          versionName = verified.versionName,
          versionCode = verified.versionCode,
          sizeBytes = finalFile.length(),
        )
      }
    } catch (e: Throwable) {
      if (state.cancelled.get() && state.deletePartial.get()) {
        part.delete()
        meta.delete()
      }
      throw mapNetworkException(e, state.cancelled.get())
    } finally {
      state.currentCall.set(null)
      active.compareAndSet(state, null)
    }
  }

  private fun executeWithValidatedRedirects(
    initialUrl: HttpUrl,
    allowRedirects: Boolean,
    headers: Map<String, String>,
    activeDownload: ActiveDownload?,
  ): Response {
    var currentUrl = initialUrl
    var hops = 0
    while (true) {
      if (activeDownload?.cancelled?.get() == true) {
        throw UpdaterException("CANCELLED", "Download cancelled")
      }
      val builder = Request.Builder().url(currentUrl).get()
      for ((name, value) in headers) {
        builder.header(name, value)
      }
      val call = client.newCall(builder.build())
      activeDownload?.currentCall?.set(call)
      val response = call.execute()
      if (response.code in setOf(301, 302, 303, 307, 308)) {
        val location = response.header("Location")
        response.close()
        if (!allowRedirects) {
          throw UpdaterException("REDIRECT_BLOCKED", "Redirects are forbidden on relay downloads")
        }
        if (location.isNullOrBlank()) {
          throw UpdaterException("REDIRECT_BLOCKED", "Redirect response missing Location header")
        }
        hops++
        if (hops > MAX_REDIRECTS) {
          throw UpdaterException("REDIRECT_BLOCKED", "Too many redirects")
        }
        val resolved = currentUrl.resolve(location)
          ?: throw UpdaterException("REDIRECT_BLOCKED", "Invalid redirect target")
        currentUrl = urlPolicy.validateGitHubRedirectUrl(resolved)
        continue
      }
      return response
    }
  }

  private fun mapHttpFailure(
    response: Response,
    isRelay: Boolean,
    part: File,
    meta: File,
  ): UpdaterException {
    val status = response.code
    val hasRelayMarker = response.header(RELAY_HEADER) == "1"
    val bodyCode = readErrorCode(response)

    if (isRelay) {
      if ((status == 403 || status == 404 || status == 405) && !hasRelayMarker) {
        return UpdaterException("RELAY_UNSUPPORTED", "Connected desktop does not support mobile update relay")
      }
      if (status == 401) return UpdaterException("RELAY_UNAUTHORIZED", "Desktop connection authorization failed")
      if (status == 409 || bodyCode == "RELEASE_CHANGED") {
        part.delete()
        meta.delete()
        return UpdaterException("RELEASE_CHANGED", "A newer Android release is available on desktop")
      }
      if (status == 404 && bodyCode == "MANIFEST_NOT_PUBLISHED") {
        return UpdaterException("MANIFEST_NOT_FOUND", "Android release not published yet")
      }
      if (status == 429 || bodyCode == "RATE_LIMITED") {
        return UpdaterException("RATE_LIMITED", "Desktop update relay rate limited")
      }
      if (!bodyCode.isNullOrBlank()) {
        return UpdaterException(bodyCode, "Desktop relay failed ($bodyCode)")
      }
      return UpdaterException("RELAY_ERROR", "Desktop relay returned HTTP $status")
    }

    if (status == 404) return UpdaterException("MANIFEST_NOT_FOUND", "Release APK not found")
    if (status == 403 || status == 429) return UpdaterException("RATE_LIMITED", "GitHub rate limited request ($status)")
    return UpdaterException("HTTP_ERROR", "Download failed with HTTP $status")
  }

  private fun readErrorCode(response: Response): String? {
    val body = response.body ?: return null
    return try {
      val text = readBounded(body.byteStream(), 4096L).toString(Charsets.UTF_8)
      Regex("\"code\"\\s*:\\s*\"([A-Z0-9_]+)\"").find(text)?.groupValues?.get(1)
    } catch (_: Exception) {
      null
    }
  }

  private fun tryVerifyExisting(file: File, expectedSha256: String, expectedVersion: String?): VerifiedApkInfo? {
    return try {
      if (computeFileSha256(file) != expectedSha256) return null
      apkValidator(file, expectedVersion)
    } catch (_: Throwable) {
      null
    }
  }

  private fun promoteAtomically(part: File, target: File) {
    if (target.exists()) target.delete()
    if (!part.renameTo(target)) {
      part.copyTo(target, overwrite = true)
      part.delete()
    }
  }

  private fun cleanupOtherFiles(keepSha256: String) {
    val kept = setOf("$keepSha256.apk", "$keepSha256.apk.part", "$keepSha256.apk.meta")
    for (file in updatesDir.listFiles().orEmpty()) {
      if (file.isFile && file.name !in kept) {
        file.delete()
      }
    }
  }

  private fun ensureUpdatesDir() {
    if (!updatesDir.exists() && !updatesDir.mkdirs()) {
      throw UpdaterException("STORAGE_ERROR", "Failed to create APK updates cache directory")
    }
  }

  private fun apkFile(sha: String) = File(updatesDir, "$sha.apk")
  private fun partFile(sha: String) = File(updatesDir, "$sha.apk.part")
  private fun metaFile(sha: String) = File(updatesDir, "$sha.apk.meta")

  private fun validateSha256(value: String): String {
    val normalized = value.trim().lowercase()
    if (!SHA256_REGEX.matches(normalized)) {
      throw UpdaterException("INVALID_ARGUMENT", "Invalid expectedSha256")
    }
    return normalized
  }

  private fun validateSemver(value: String): String {
    val normalized = value.trim()
    if (!SEMVER_REGEX.matches(normalized)) {
      throw UpdaterException("INVALID_ARGUMENT", "Invalid expectedVersion")
    }
    return normalized
  }

  private data class DownloadMeta(val etag: String?, val totalBytes: Long?)

  private fun readMeta(file: File): DownloadMeta? {
    if (!file.isFile) return null
    return try {
      var etag: String? = null
      var total: Long? = null
      for (line in file.readLines(Charsets.UTF_8)) {
        val sep = line.indexOf('=')
        if (sep <= 0) continue
        val key = line.substring(0, sep)
        val value = line.substring(sep + 1)
        when (key) {
          "etag" -> if (value.isNotEmpty()) etag = value
          "totalBytes" -> total = value.toLongOrNull()?.takeIf { it > 0L }
        }
      }
      DownloadMeta(etag = etag, totalBytes = total)
    } catch (_: Exception) {
      null
    }
  }

  private fun writeMeta(file: File, meta: DownloadMeta) {
    try {
      val lines = buildList {
        meta.etag?.replace("\r", "")?.replace("\n", "")?.takeIf { it.isNotBlank() }?.let {
          add("etag=$it")
        }
        if (meta.totalBytes != null) add("totalBytes=${meta.totalBytes}")
      }
      file.writeText(lines.joinToString("\n"), Charsets.UTF_8)
    } catch (_: Exception) {
      // Metadata is best-effort for Range/ETag validation; missing meta simply restarts from 0.
    }
  }

  private fun computeFileSha256(file: File, isCancelled: () -> Boolean = { false }): String {
    val digest = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(BUFFER_BYTES)
    FileInputStream(file).use { input ->
      while (true) {
        if (isCancelled()) throw UpdaterException("CANCELLED", "Download cancelled")
        val read = input.read(buffer)
        if (read < 0) break
        if (read > 0) digest.update(buffer, 0, read)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  private fun readBounded(stream: java.io.InputStream, maxBytes: Long): ByteArray {
    val buffer = ByteArray(8192)
    val out = java.io.ByteArrayOutputStream()
    var total = 0L
    while (true) {
      val read = stream.read(buffer)
      if (read < 0) break
      total += read
      if (total > maxBytes) {
        throw UpdaterException("RESPONSE_TOO_LARGE", "Response body exceeds maximum size")
      }
      out.write(buffer, 0, read)
    }
    return out.toByteArray()
  }
}
