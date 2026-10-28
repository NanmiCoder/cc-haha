import { Platform } from 'react-native'
import * as Notifications from 'expo-notifications'
import { createNotificationChannels } from './notificationChannelSetup'

let created: Promise<void> | undefined

/**
 * Android 13+ 必须先有渠道，系统通知授权框才会弹出；幂等，可重复调用。
 * 成功后整个进程只创建一次（渠道的重要程度创建后即固定）；失败不缓存，下次重试。
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
