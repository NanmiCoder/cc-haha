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

/** 打开 cc-haha 的系统通知设置；打不开具体页面时退回到 App 设置首页。 */
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

/** 读 Android 通知渠道当前的重要程度和声音（用户在系统里改过的也算）；非 Android 或读不到返回 null。 */
export async function readChannel(kind: ChannelKind) {
  if (Platform.OS !== 'android') return null
  try {
    const channel = await Notifications.getNotificationChannelAsync(CHANNEL_IDS[kind])
    return channel ? { importance: Number(channel.importance), sound: channel.sound ?? null } : null
  } catch {
    return null
  }
}

/** 打开某个渠道在系统里的设置页（声音、震动、横幅）；打不开就退回 App 设置首页。 */
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
 * 只发一条本地通知，验证系统权限和横幅；它不经过电脑，不能证明远程推送可用。
 * 延迟几秒发出：App 在前台时不弹横幅，需要先回到主屏幕。
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
