import { useCallback, useEffect, useState } from 'react'
import { AppState, Platform } from 'react-native'
import { useFocusEffect } from 'expo-router'
import {
  readCameraStatus,
  readChannel,
  readNotificationStatus,
  readPhotosStatus,
  type MediaPermission,
} from '../../core/systemPermissions'
import type { ChannelKind } from '../../state/channelIds'
import { channelRows, channelSummary, type PermissionSnapshot } from './deliveryModel'

type Snapshot = {
  notifications: PermissionSnapshot | null
  camera: MediaPermission | null
  photos: MediaPermission | null
  /** Android 三个通知渠道右侧的一句话；读不到的为空串。 */
  channels: Record<ChannelKind, string>
}

const noChannels: Snapshot['channels'] = { decisions: '', completed: '', errors: '' }

async function readSnapshot(): Promise<Snapshot> {
  const [notifications, camera, photos, ...channels] = await Promise.allSettled([
    readNotificationStatus(),
    readCameraStatus(),
    readPhotosStatus(),
    ...channelRows.map((row) => readChannel(row.kind)),
  ])
  const pick = <T,>(result: PromiseSettledResult<T>) =>
    result.status === 'fulfilled' ? result.value : null
  return {
    notifications: pick(notifications as PromiseSettledResult<PermissionSnapshot>),
    camera: pick(camera as PromiseSettledResult<MediaPermission>),
    photos: pick(photos as PromiseSettledResult<MediaPermission>),
    channels: Object.fromEntries(
      channelRows.map((row, index) => [
        row.kind,
        channelSummary(
          pick(channels[index] as PromiseSettledResult<Awaited<ReturnType<typeof readChannel>>>)
        ),
      ])
    ) as Snapshot['channels'],
  }
}

/**
 * 读系统权限（通知、相机、照片）和 Android 通知渠道。页面重新获得焦点、或用户去系统设置
 * 改完回到 App 时都会重新读，所以设置页上的状态不会停在离开前的样子。读不到的项保持 null，
 * 页面不显示它的值。
 */
export function useSystemPermissions() {
  const [snapshot, setSnapshot] = useState<Snapshot>({
    notifications: null,
    camera: null,
    photos: null,
    channels: noChannels,
  })
  const refresh = useCallback(async () => {
    if (Platform.OS !== 'web') setSnapshot(await readSnapshot())
  }, [])
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS === 'web') return
      let alive = true
      void readSnapshot().then((value) => {
        if (alive) setSnapshot(value)
      })
      return () => {
        alive = false
      }
    }, [])
  )
  useEffect(() => {
    if (Platform.OS === 'web') return
    let alive = true
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active')
        void readSnapshot().then((value) => {
          if (alive) setSnapshot(value)
        })
    })
    return () => {
      alive = false
      subscription.remove()
    }
  }, [])
  return { ...snapshot, refresh }
}
