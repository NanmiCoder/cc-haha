package app.cchaha.duty

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Resume pulling after a reboot or an app update, without waiting for the user to open the app. */
class DutyBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    if (DutyStore.load(context).isNotEmpty()) DutyService.start(context)
  }
}
