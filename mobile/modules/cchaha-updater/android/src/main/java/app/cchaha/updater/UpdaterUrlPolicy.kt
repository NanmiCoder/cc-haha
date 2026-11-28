package app.cchaha.updater

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.util.Locale

interface UrlPolicy {
  fun validateGitHubManifestUrl(rawUrl: String): HttpUrl
  fun validateGitHubApkUrl(rawUrl: String): HttpUrl
  fun validateGitHubRedirectUrl(url: HttpUrl): HttpUrl
  fun validateRelayApkUrl(rawUrl: String, relayOrigin: String): HttpUrl
  fun sanitizeRelayHeaders(headers: Map<String, String>?, relayOrigin: String): Map<String, String>
}

object UpdaterUrlPolicy : UrlPolicy {
  const val GITHUB_MANIFEST_URL =
    "https://github.com/NanmiCoder/cc-haha/releases/latest/download/mobile-release-android.json"

  private val GITHUB_APK_PATH =
    Regex("^/NanmiCoder/cc-haha/releases/download/v\\d+\\.\\d+\\.\\d+/cc-haha-mobile-[A-Za-z0-9._-]+\\.apk$")
  private val SHA256_PATTERN = Regex("^[a-f0-9]{64}$")

  private val EXACT_GITHUB_HOSTS = setOf(
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "github-releases.githubusercontent.com",
  )

  private val BLOCKED_GITHUB_USERCONTENT_HOSTS = setOf(
    "raw.githubusercontent.com",
    "gist.githubusercontent.com",
    "camo.githubusercontent.com",
    "avatars.githubusercontent.com",
    "user-images.githubusercontent.com",
    "private-user-images.githubusercontent.com",
    "cloud.githubusercontent.com",
  )

  override fun validateGitHubManifestUrl(rawUrl: String): HttpUrl {
    val parsed = parseStrictUrl(rawUrl)
    if (parsed.toString() != GITHUB_MANIFEST_URL) {
      throw UpdaterException("INVALID_URL", "Untrusted GitHub manifest URL")
    }
    return parsed
  }

  override fun validateGitHubApkUrl(rawUrl: String): HttpUrl {
    val parsed = parseStrictUrl(rawUrl)
    if (parsed.scheme != "https" ||
      !parsed.host.equals("github.com", ignoreCase = true) ||
      parsed.port != 443 ||
      parsed.encodedQuery != null ||
      parsed.fragment != null ||
      parsed.encodedPath.contains("..") ||
      !GITHUB_APK_PATH.matches(parsed.encodedPath)
    ) {
      throw UpdaterException("INVALID_URL", "Untrusted GitHub APK URL")
    }
    return parsed
  }

  override fun validateGitHubRedirectUrl(url: HttpUrl): HttpUrl {
    if (url.scheme != "https" || url.port != 443 || url.username.isNotEmpty() || url.password.isNotEmpty()) {
      throw UpdaterException("REDIRECT_BLOCKED", "Blocked non-HTTPS or non-443 redirect")
    }
    val host = url.host.lowercase(Locale.ROOT)
    val allowed = host in EXACT_GITHUB_HOSTS ||
      (host.endsWith(".githubusercontent.com") &&
        host !in BLOCKED_GITHUB_USERCONTENT_HOSTS &&
        !host.startsWith(".") &&
        !host.contains(".."))
    if (!allowed) {
      throw UpdaterException("REDIRECT_BLOCKED", "Blocked redirect outside GitHub release hosts")
    }
    return url
  }

  override fun validateRelayApkUrl(rawUrl: String, relayOrigin: String): HttpUrl {
    val origin = parseRelayOrigin(relayOrigin)
    val parsed = parseStrictUrl(rawUrl)
    if (parsed.scheme != origin.scheme ||
      !parsed.host.equals(origin.host, ignoreCase = true) ||
      parsed.port != origin.port ||
      parsed.encodedPath != "/api/mobile-update/android/apk" ||
      parsed.fragment != null
    ) {
      throw UpdaterException("INVALID_URL", "Relay APK URL does not match paired desktop origin")
    }
    val names = parsed.queryParameterNames
    if (names.any { it != "sha256" }) {
      throw UpdaterException("INVALID_URL", "Unexpected relay query parameter")
    }
    val shaValues = parsed.queryParameterValues("sha256")
    if (shaValues.size > 1) {
      throw UpdaterException("INVALID_URL", "Duplicate sha256 parameter")
    }
    val sha = shaValues.firstOrNull()
    if (sha != null && !SHA256_PATTERN.matches(sha)) {
      throw UpdaterException("INVALID_URL", "Invalid sha256 query parameter")
    }
    return parsed
  }

  override fun sanitizeRelayHeaders(
    headers: Map<String, String>?,
    relayOrigin: String,
  ): Map<String, String> {
    if (headers.isNullOrEmpty()) return emptyMap()
    val expectedOrigin = formatOrigin(parseRelayOrigin(relayOrigin))
    val sanitized = linkedMapOf<String, String>()
    for ((rawName, rawValue) in headers) {
      val name = rawName.trim()
      val value = rawValue.trim()
      if (value.isEmpty()) continue
      if (hasControlChars(name) || hasControlChars(value)) {
        throw UpdaterException("INVALID_HEADER", "Control characters are not allowed in relay headers")
      }
      when (name.lowercase(Locale.ROOT)) {
        "authorization" -> sanitized["Authorization"] = value
        "origin" -> {
          val parsedOrigin = parseRelayOrigin(value)
          if (formatOrigin(parsedOrigin) != expectedOrigin) {
            throw UpdaterException("INVALID_HEADER", "Relay Origin header does not match paired host")
          }
          sanitized["Origin"] = expectedOrigin
        }
        else -> {
          // Drop any unexpected headers so credentials/cookies cannot be smuggled.
        }
      }
    }
    return sanitized
  }

  internal fun parseRelayOrigin(rawOrigin: String): HttpUrl {
    val parsed = parseStrictUrl(rawOrigin.trim())
    if ((parsed.scheme != "http" && parsed.scheme != "https") ||
      parsed.encodedPath != "/" ||
      parsed.encodedQuery != null ||
      parsed.fragment != null
    ) {
      throw UpdaterException("INVALID_URL", "Invalid paired desktop origin")
    }
    return parsed
  }

  internal fun formatOrigin(url: HttpUrl): String {
    val defaultPort = if (url.scheme == "https") 443 else 80
    val host = if (url.host.contains(':')) "[${url.host}]" else url.host
    return if (url.port == defaultPort) "${url.scheme}://$host" else "${url.scheme}://$host:${url.port}"
  }

  private fun parseStrictUrl(raw: String): HttpUrl {
    val parsed = raw.toHttpUrlOrNull()
      ?: throw UpdaterException("INVALID_URL", "Malformed URL")
    if (parsed.username.isNotEmpty() || parsed.password.isNotEmpty()) {
      throw UpdaterException("INVALID_URL", "Credentials in URL are forbidden")
    }
    return parsed
  }

  private fun hasControlChars(value: String): Boolean =
    value.any { it == '\r' || it == '\n' || it == '\u0000' }
}
