package app.cchaha.duty

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** The service's periodic alarm; see `DutyService.checkWorkers`. */
class DutyWatchdogReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    DutyService.watchdog()
  }
}
