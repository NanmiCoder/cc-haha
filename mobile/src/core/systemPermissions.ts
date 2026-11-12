import { Linking, Platform } from 'react-native'
import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import { Camera } from 'expo-camera'
import * as ImagePicker from 'expo-image-picker'
import { CHANNEL_IDS, type ChannelKind } from '../state/channelIds'
import {
  readNotificationPermission,
  TEST_NOTIFICATION_DELAY_SECONDS,
  testNotificationContent,
  type PermissionSnapshot,
} from '../ui/settings/deliveryModel'

export type MediaPermission = { status: string; accessPrivileges?: string }

export async function readNotificationStatus(): Promise<PermissionSnapshot> {
  return readNotificationPermission(await Notifications.getPermissionsAsync())
}

export async function requestNotificationStatus(): Promise<PermissionSnapshot> {
  return readNotificationPermission(await Notifications.requestPermissionsAsync())
}

export async function readCameraStatus(): Promise<MediaPermission> {
  return Camera.getCameraPermissionsAsync()
}

export async function readPhotosStatus(): Promise<MediaPermission> {
  return ImagePicker.getMediaLibraryPermissionsAsync()
}

/** Open the cc-haha system notification settings; fall back to the app settings home when the specific page cannot be opened. */
export async function openNotificationSettings() {
  try {
    if (Platform.OS === 'ios') await Linking.openURL('app-settings:notifications')
    else
      await Linking.sendIntent('android.settings.APP_NOTIFICATION_SETTINGS', [
        {
          key: 'android.provider.extra.APP_PACKAGE',
          value: Constants.expoConfig?.android?.package ?? 'app.cchaha.mobile',
        },
      ])
  } catch {
    await Linking.openSettings()
  }
}

/** Read the current importance and sound of the Android notification channel (including user changes in the system); returns null on non-Android or when unreadable. */
export async function readChannel(kind: ChannelKind) {
  if (Platform.OS !== 'android') return null
  try {
    const channel = await Notifications.getNotificationChannelAsync(CHANNEL_IDS[kind])
    return channel ? { importance: Number(channel.importance), sound: channel.sound ?? null } : null
  } catch {
    return null
  }
}

/** Open a channel's settings page in the system (sound, vibration, banner); fall back to the app settings home if it cannot be opened. */
export async function openChannelSettings(kind: ChannelKind) {
  try {
    await Linking.sendIntent('android.settings.CHANNEL_NOTIFICATION_SETTINGS', [
      {
        key: 'android.provider.extra.APP_PACKAGE',
        value: Constants.expoConfig?.android?.package ?? 'app.cchaha.mobile',
      },
      { key: 'android.provider.extra.CHANNEL_ID', value: CHANNEL_IDS[kind] },
    ])
  } catch {
    await Linking.openSettings()
  }
}

export const openAppSettings = () => Linking.openSettings()

/**
 * Send only a local notification to verify system permission and banners; it does not go through the computer and cannot prove remote push works.
 * Sent after a few seconds' delay: no banner shows while the app is in the foreground, so go back to the home screen first.
 */
export async function scheduleTestNotification() {
  await Notifications.scheduleNotificationAsync({
    content: testNotificationContent,
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: TEST_NOTIFICATION_DELAY_SECONDS,
      channelId: CHANNEL_IDS.decisions,
    },
  })
}
