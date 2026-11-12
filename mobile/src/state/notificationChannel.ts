import { Platform } from 'react-native'
import * as Notifications from 'expo-notifications'
import { createNotificationChannels } from './notificationChannelSetup'

let created: Promise<void> | undefined

/**
 * Android 13+ A channel must exist before the system notification permission prompt can show; idempotent and safe to call repeatedly.
 * Created only once per process after success (channel importance is fixed after creation); failures are not cached and retried next time.
 */
export function ensureNotificationChannel(): Promise<void> {
  if (Platform.OS !== 'android') return Promise.resolve()
  created ??= createNotificationChannels(
    Platform.OS,
    Notifications as never
  ).catch((error) => {
    created = undefined
    throw error
  })
  return created
}
