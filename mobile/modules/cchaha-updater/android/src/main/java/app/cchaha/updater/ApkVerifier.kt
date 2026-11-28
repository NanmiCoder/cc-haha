package app.cchaha.updater

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.pm.PackageInfoCompat
import java.io.File
import java.security.MessageDigest

data class InstalledAppInfo(
  val packageName: String,
  val versionName: String,
  val versionCode: Long,
  val signingCertSha256s: List<String>,
)

data class VerifiedApkInfo(
  val packageName: String,
  val versionName: String,
  val versionCode: Long,
)

object ApkVerifier {
  private val SEMVER = Regex("^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$")

  fun getInstalledAppInfo(context: Context): InstalledAppInfo {
    val info = getInstalledPackageInfo(context)
    val signers = extractCurrentSigners(info).sorted()
    return InstalledAppInfo(
      packageName = info.packageName,
      versionName = info.versionName ?: "",
      versionCode = PackageInfoCompat.getLongVersionCode(info),
      signingCertSha256s = signers,
    )
  }

  fun verify(context: Context, apkFile: File, expectedVersion: String?): VerifiedApkInfo {
    if (!apkFile.isFile || apkFile.length() <= 0L) {
      throw UpdaterException("INVALID_APK", "APK file is missing or empty")
    }
    val installed = getInstalledPackageInfo(context)
    val archive = getArchivePackageInfo(context, apkFile)
      ?: throw UpdaterException("INVALID_APK", "Unable to parse APK archive or verify APK signature")

    if (archive.packageName != installed.packageName) {
      throw UpdaterException("PACKAGE_NAME_MISMATCH", "APK package name does not match installed app")
    }

    val archiveVersion = archive.versionName ?: ""
    if (!expectedVersion.isNullOrEmpty() && archiveVersion != expectedVersion) {
      throw UpdaterException("VERSION_MISMATCH", "APK version does not match manifest version")
    }

    val installedCode = PackageInfoCompat.getLongVersionCode(installed)
    val archiveCode = PackageInfoCompat.getLongVersionCode(archive)
    val installedVersion = installed.versionName ?: ""
    if (!isAllowedUpgrade(installedCode, installedVersion, archiveCode, archiveVersion)) {
      throw UpdaterException("DOWNGRADE_REJECTED", "APK version is not newer than installed app")
    }

    val installedSigners = extractCurrentSigners(installed)
    val archiveSigners = extractCurrentSigners(archive)
    val archiveHistory = extractSigningHistory(archive)
    if (!signingCertDigestsMatch(installedSigners, archiveSigners, archiveHistory)) {
      throw UpdaterException("SIGNATURE_MISMATCH", "APK signing certificate does not match installed app")
    }

    return VerifiedApkInfo(
      packageName = archive.packageName,
      versionName = archiveVersion,
      versionCode = archiveCode,
    )
  }

  internal fun isAllowedUpgrade(
    installedCode: Long,
    installedVersion: String,
    archiveCode: Long,
    archiveVersion: String,
  ): Boolean {
    if (archiveCode < installedCode) return false
    if (archiveCode > installedCode) return true
    val cmp = compareSemver(archiveVersion, installedVersion)
    return cmp != null && cmp > 0
  }

  internal fun compareSemver(left: String, right: String): Int? {
    val l = SEMVER.matchEntire(left.trim()) ?: return null
    val r = SEMVER.matchEntire(right.trim()) ?: return null
    for (i in 1..3) {
      val diff = l.groupValues[i].toInt().compareTo(r.groupValues[i].toInt())
      if (diff != 0) return diff
    }
    return 0
  }

  internal fun signingCertDigestsMatch(
    installedDigests: Set<String>,
    apkCurrentDigests: Set<String>,
    apkHistoryDigests: Set<String>,
  ): Boolean {
    if (installedDigests.isEmpty() || apkCurrentDigests.isEmpty()) return false
    if (installedDigests == apkCurrentDigests) return true
    return installedDigests.size == 1 &&
      apkCurrentDigests.size == 1 &&
      installedDigests.single() in apkHistoryDigests
  }

  @Suppress("DEPRECATION")
  private fun getInstalledPackageInfo(context: Context): PackageInfo {
    val pm = context.packageManager
    val legacyAndModernFlags = PackageManager.GET_SIGNING_CERTIFICATES or PackageManager.GET_SIGNATURES
    return when {
      Build.VERSION.SDK_INT >= 33 -> pm.getPackageInfo(
        context.packageName,
        PackageManager.PackageInfoFlags.of(legacyAndModernFlags.toLong()),
      )
      Build.VERSION.SDK_INT >= 28 -> pm.getPackageInfo(
        context.packageName,
        legacyAndModernFlags,
      )
      else -> pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNATURES)
    }
  }

  @Suppress("DEPRECATION")
  private fun getArchivePackageInfo(context: Context, apkFile: File): PackageInfo? {
    val pm = context.packageManager
    // AOSP #243324820 (Android 13 / API 33) and #159537841 (Android 9-12) leave
    // PackageInfo.signingInfo null on getPackageArchiveInfo unless GET_SIGNATURES
    // is combined with GET_SIGNING_CERTIFICATES.
    val legacyAndModernFlags = PackageManager.GET_SIGNING_CERTIFICATES or PackageManager.GET_SIGNATURES
    return when {
      Build.VERSION.SDK_INT >= 33 -> pm.getPackageArchiveInfo(
        apkFile.absolutePath,
        PackageManager.PackageInfoFlags.of(legacyAndModernFlags.toLong()),
      )
      Build.VERSION.SDK_INT >= 28 -> pm.getPackageArchiveInfo(
        apkFile.absolutePath,
        legacyAndModernFlags,
      )
      else -> pm.getPackageArchiveInfo(apkFile.absolutePath, PackageManager.GET_SIGNATURES)
    }
  }

  @Suppress("DEPRECATION")
  private fun extractCurrentSigners(info: PackageInfo): Set<String> {
    val modern = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else null
    val rawBytes = selectCurrentSignerBytes(
      modernSigners = modern?.map { it.toByteArray() },
      legacySigners = info.signatures?.map { it.toByteArray() },
    )
    return rawBytes.map(::sha256Hex).toSet()
  }

  internal fun selectCurrentSignerBytes(
    modernSigners: List<ByteArray>?,
    legacySigners: List<ByteArray>?,
  ): List<ByteArray> {
    if (!modernSigners.isNullOrEmpty()) return modernSigners
    return legacySigners.orEmpty()
  }

  private fun extractSigningHistory(info: PackageInfo): Set<String> {
    if (Build.VERSION.SDK_INT < 28) return emptySet()
    val history = info.signingInfo?.signingCertificateHistory ?: return emptySet()
    return history.map { sha256Hex(it.toByteArray()) }.toSet()
  }

  private fun sha256Hex(bytes: ByteArray): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
    return digest.joinToString("") { "%02x".format(it) }
  }
}
