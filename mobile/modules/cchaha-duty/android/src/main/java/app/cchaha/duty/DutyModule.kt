package app.cchaha.duty

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject

class DutyModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("CCHahaDuty")

    Function("setHost") { json: String ->
      val host = DutyStore.host(JSONObject(json)) ?: throw IllegalArgumentException("Invalid duty host")
      DutyService.setHost(context, host)
    }

    Function("removeHost") { hostId: String ->
      DutyService.removeHost(context, hostId)
    }

    Function("retainHosts") { json: String ->
      val ids = JSONArray(json)
      DutyService.retainHosts(context, (0 until ids.length()).map { ids.getString(it) }.toSet())
    }

    Function("setAppActive") { active: Boolean ->
      DutyService.setAppActive(context, active)
    }

    Function("status") {
      mapOf(
        "running" to DutyService.running,
        "connected" to DutyService.connected,
        "batteryOptimizationIgnored" to batteryOptimizationIgnored()
      )
    }

    // Distributed outside Google Play, and its core function (FCM-less alerts) qualifies
    // for the documented exemption, so ask directly instead of sending users to a list.
    Function("requestIgnoreBatteryOptimizations") {
      if (!batteryOptimizationIgnored()) {
        val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
        if (!open(direct)) open(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
      }
    }
  }

  private fun batteryOptimizationIgnored(): Boolean =
    context.getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(context.packageName) == true

  private fun open(intent: Intent): Boolean {
    val activity = appContext.currentActivity
    return try {
      if (activity != null) activity.startActivity(intent)
      else context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      true
    } catch (_: Exception) {
      false
    }
  }
}
