package app.cchaha.updater

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.StatFs
import android.provider.Settings
import androidx.core.content.FileProvider
import com.facebook.react.modules.network.OkHttpClientProvider
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.CookieJar
import okhttp3.OkHttpClient
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

class UpdaterModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  @Volatile
  private var downloaderInstance: ApkDownloader? = null

  private fun downloader(): ApkDownloader {
    downloaderInstance?.let { return it }
    synchronized(this) {
      downloaderInstance?.let { return it }
      val appContext = context
      val client: OkHttpClient = OkHttpClientProvider.getOkHttpClient()
        .newBuilder()
        .cache(null)
        .cookieJar(CookieJar.NO_COOKIES)
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()
      val dir = File(appContext.cacheDir, "cchaha-updates")
      return ApkDownloader(
        client = client,
        updatesDir = dir,
        urlPolicy = UpdaterUrlPolicy,
        availableBytes = { folder ->
          try {
            val target = if (folder.exists()) folder else appContext.cacheDir
            StatFs(target.absolutePath).availableBytes
          } catch (_: Exception) {
            folder.usableSpace
          }
        },
        apkValidator = { file, expectedVersion -> ApkVerifier.verify(appContext, file, expectedVersion) },
      ).also { downloaderInstance = it }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("CCHahaUpdater")

    Events("onDownloadProgress")

    Function("getInstalledAppInfo") {
      runUpdater {
        val info = ApkVerifier.getInstalledAppInfo(context)
        mapOf(
          "packageName" to info.packageName,
          "versionName" to info.versionName,
          "versionCode" to info.versionCode,
          "signingCertSha256s" to info.signingCertSha256s,
        )
      }
    }

    Function("canRequestPackageInstalls") {
      canRequestPackageInstalls()
    }

    Function("openUnknownSourcesSettings") {
      if (Build.VERSION.SDK_INT < 26) {
        true
      } else {
        val direct = Intent(
          Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
          Uri.parse("package:${context.packageName}"),
        )
        openActivity(direct) || openActivity(
          Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.parse("package:${context.packageName}"),
          ),
        )
      }
    }

    Function("cancelDownload") { downloadId: String?, deletePartial: Boolean ->
      downloader().cancel(downloadId, deletePartial)
    }

    AsyncFunction("fetchGitHubManifest") Coroutine { ->
      withContext(Dispatchers.IO) {
        runUpdater {
          downloader().fetchManifest()
        }
      }
    }

    AsyncFunction("getCachedApk") Coroutine { expectedSha256: String, expectedVersion: String? ->
      withContext(Dispatchers.IO) {
        runUpdater {
          val status = downloader().getCachedApk(expectedSha256, expectedVersion)
          mapOf(
            "ready" to status.ready,
            "verified" to status.verified,
            "partialBytes" to status.partialBytes,
            "totalBytes" to status.totalBytes,
            "sizeBytes" to status.sizeBytes,
            "versionName" to status.versionName,
            "versionCode" to status.versionCode,
          )
        }
      }
    }

    AsyncFunction("cleanupCachedApks") Coroutine { keepSha256: String? ->
      withContext(Dispatchers.IO) {
        runUpdater {
          downloader().cleanupCachedApks(keepSha256)
        }
      }
    }

    AsyncFunction("downloadApk") Coroutine { optionsJson: String ->
      withContext(Dispatchers.IO) {
        runUpdater {
          val request = parseDownloadRequest(optionsJson)
          val result = downloader().download(request) { progress ->
            sendEvent(
              "onDownloadProgress",
              mapOf(
                "downloadId" to progress.downloadId,
                "phase" to progress.phase,
                "bytesWritten" to progress.bytesWritten,
                "totalBytes" to progress.totalBytes,
                "resumedFromBytes" to progress.resumedFromBytes,
              ),
            )
          }
          mapOf(
            "sha256" to result.sha256,
            "versionName" to result.versionName,
            "versionCode" to result.versionCode,
            "sizeBytes" to result.sizeBytes,
          )
        }
      }
    }

    AsyncFunction("installApk") Coroutine { expectedSha256: String, expectedVersion: String ->
      val appContext = context
      if (!canRequestPackageInstalls()) {
        return@Coroutine mapOf(
          "launched" to false,
          "needsUnknownSourcesPermission" to true,
        )
      }
      val apkFile = withContext(Dispatchers.IO) {
        runUpdater {
          downloader().resolveVerifiedApkFile(expectedSha256, expectedVersion)
        }
      }
      val uri = try {
        FileProvider.getUriForFile(
          appContext,
          "${appContext.packageName}.updater.fileprovider",
          apkFile,
        )
      } catch (e: Exception) {
        throw CodedException("INSTALL_LAUNCH_FAILED", "Failed to build FileProvider URI", e)
      }
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      val launched = withContext(Dispatchers.Main) {
        openActivity(intent)
      }
      if (!launched) {
        throw CodedException("INSTALL_LAUNCH_FAILED", "No Android package installer could handle APK", null)
      }
      mapOf(
        "launched" to true,
        "needsUnknownSourcesPermission" to false,
      )
    }
  }

  private fun canRequestPackageInstalls(): Boolean =
    if (Build.VERSION.SDK_INT >= 26) context.packageManager.canRequestPackageInstalls() else true

  private fun openActivity(intent: Intent): Boolean {
    val activity = appContext.currentActivity
    return try {
      if (activity != null) activity.startActivity(intent)
      else context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      true
    } catch (_: Exception) {
      false
    }
  }

  private fun parseDownloadRequest(optionsJson: String): DownloadRequest {
    val json = try {
      JSONObject(optionsJson)
    } catch (e: Exception) {
      throw UpdaterException("INVALID_ARGUMENT", "Invalid download options JSON", e)
    }
    val headersJson = json.optJSONObject("headers")
    val headers = if (headersJson != null) {
      val map = linkedMapOf<String, String>()
      val keys = headersJson.keys()
      while (keys.hasNext()) {
        val key = keys.next()
        val value = headersJson.optString(key)
        if (value.isNotEmpty()) map[key] = value
      }
      map
    } else {
      null
    }
    return DownloadRequest(
      downloadId = json.optString("downloadId"),
      source = json.optString("source"),
      url = json.optString("url"),
      expectedSha256 = json.optString("expectedSha256"),
      expectedVersion = json.optString("expectedVersion"),
      relayOrigin = json.optString("relayOrigin").takeIf { it.isNotEmpty() },
      headers = headers,
    )
  }

  private inline fun <T> runUpdater(block: () -> T): T = try {
    block()
  } catch (e: UpdaterException) {
    throw CodedException(e.code, e.message, e)
  }
}
