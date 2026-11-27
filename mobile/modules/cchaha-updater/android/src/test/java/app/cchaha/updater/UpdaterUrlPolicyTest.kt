package app.cchaha.updater

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdaterUrlPolicyTest {
  @Test
  fun acceptsPinnedGitHubManifestAndApkUrls() {
    val manifest = UpdaterUrlPolicy.validateGitHubManifestUrl(UpdaterUrlPolicy.GITHUB_MANIFEST_URL)
    assertEquals("github.com", manifest.host)

    val apk = UpdaterUrlPolicy.validateGitHubApkUrl(
      "https://github.com/NanmiCoder/cc-haha/releases/download/v0.8.0/cc-haha-mobile-0.1.7-abc123.apk",
    )
    assertEquals("github.com", apk.host)
  }

  @Test(expected = UpdaterException::class)
  fun rejectsOtherGitHubReposOrHttpDowngrade() {
    UpdaterUrlPolicy.validateGitHubApkUrl(
      "https://github.com/evil/cc-haha/releases/download/v0.8.0/cc-haha-mobile-0.1.7.apk",
    )
  }

  @Test
  fun validatesGitHubRedirectsStrictly() {
    UpdaterUrlPolicy.validateGitHubRedirectUrl(
      "https://objects.githubusercontent.com/github-production-release-asset-2e65be/123?X-Amz-Signature=abc".toHttpUrl(),
    )
    UpdaterUrlPolicy.validateGitHubRedirectUrl(
      "https://release-assets.githubusercontent.com/github-production-release-asset-2e65be/123".toHttpUrl(),
    )

    val blocked = listOf(
      "http://objects.githubusercontent.com/asset.apk",
      "https://raw.githubusercontent.com/NanmiCoder/cc-haha/main/fake.apk",
      "https://avatars.githubusercontent.com/u/1",
      "https://evil.example.com/cc-haha.apk",
      "https://objects.githubusercontent.com:8443/asset.apk",
    )
    for (url in blocked) {
      var threw = false
      try {
        UpdaterUrlPolicy.validateGitHubRedirectUrl(url.toHttpUrl())
      } catch (e: UpdaterException) {
        threw = e.code == "REDIRECT_BLOCKED"
      }
      assertTrue("Expected redirect to be blocked: $url", threw)
    }
  }

  @Test
  fun validatesRelayUrlAndSanitizesHeaders() {
    val sha = "a".repeat(64)
    val origin = "http://192.168.1.20:3000"
    val url = UpdaterUrlPolicy.validateRelayApkUrl("$origin/api/mobile-update/android/apk?sha256=$sha", origin)
    assertEquals("/api/mobile-update/android/apk", url.encodedPath)

    val sanitized = UpdaterUrlPolicy.sanitizeRelayHeaders(
      mapOf(
        "Authorization" to "Bearer secret-token",
        "Origin" to origin,
        "Cookie" to "should-be-dropped",
        "X-Evil" to "ignored",
      ),
      origin,
    )
    assertEquals(mapOf("Authorization" to "Bearer secret-token", "Origin" to origin), sanitized)
  }

  @Test(expected = UpdaterException::class)
  fun rejectsCrossOriginRelayUrl() {
    UpdaterUrlPolicy.validateRelayApkUrl(
      "http://192.168.1.21:3000/api/mobile-update/android/apk",
      "http://192.168.1.20:3000",
    )
  }

  @Test
  fun verifiesSigningCertMatchAndRotationLineage() {
    assertTrue(ApkVerifier.signingCertDigestsMatch(setOf("aaa"), setOf("aaa"), emptySet()))
    assertTrue(ApkVerifier.signingCertDigestsMatch(setOf("aaa"), setOf("bbb"), setOf("aaa", "bbb")))
    assertFalse(ApkVerifier.signingCertDigestsMatch(setOf("aaa"), setOf("bbb"), setOf("ccc")))
    assertFalse(ApkVerifier.signingCertDigestsMatch(emptySet(), setOf("aaa"), emptySet()))

    val modern = listOf(byteArrayOf(1, 2, 3))
    val legacy = listOf(byteArrayOf(4, 5, 6))
    assertEquals(modern, ApkVerifier.selectCurrentSignerBytes(modern, legacy))
    assertEquals(legacy, ApkVerifier.selectCurrentSignerBytes(null, legacy))
    assertEquals(legacy, ApkVerifier.selectCurrentSignerBytes(emptyList(), legacy))
  }

  @Test
  fun checksUpgradeAntiDowngrade() {
    assertTrue(ApkVerifier.isAllowedUpgrade(10, "0.1.6", 11, "0.1.7"))
    assertTrue(ApkVerifier.isAllowedUpgrade(10, "0.1.6", 10, "0.1.7"))
    assertFalse(ApkVerifier.isAllowedUpgrade(10, "0.1.6", 9, "0.1.7"))
    assertFalse(ApkVerifier.isAllowedUpgrade(10, "0.1.6", 10, "0.1.6"))
  }
}
