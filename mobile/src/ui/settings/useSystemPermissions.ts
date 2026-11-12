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
  /** Android One line on the right of each of the three notification channels; empty string when unreadable. */
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
 * Read system permissions (notifications, camera, photos) and Android notification channels. Reread when the page regains focus or the user returns from system settings
 * after changing them, so the status on the settings page never stays stale from before leaving. Unreadable items stay null, 
 * and the page does not show their values.
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
