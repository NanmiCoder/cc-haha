import { useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import * as Notifications from 'expo-notifications'
import { pushRegistrations, useApp, useConnection } from '../state/AppContext'
import { useDashboard } from '../state/DashboardContext'
import { usePreferences } from '../state/PreferencesContext'
import { isQuietTime } from '../state/preferences'
import { getDevicePushToken } from '../state/devicePushToken'
import { buildDelivery } from '../state/pushRegistrations'
import TaskActivity from './TaskActivity.ios'
import {
  activityBridgeAction,
  finishedActivities,
  taskActivityData,
  TASK_ACTIVITY_NAME,
} from './activityData'
import { TaskActivityController } from './liveActivityController'

export function LiveActivityBridge({
  onStatus,
}: {
  onStatus?(message: string): void
}) {
  const { registry, ready: hostsReady } = useApp()
  const { snapshot, fresh, error } = useDashboard()
  const { preferences, ready, error: preferencesError } = usePreferences()
  const { client } = useConnection(snapshot?.hostId)
  const [controller] = useState(() => new TaskActivityController(TaskActivity))
  const [foreground, setForeground] = useState(
    AppState.currentState === 'active'
  )
  const registrationAvailable = !foreground || fresh
  const lastError = useRef('')
  const registrationLifetime = useRef<AbortController | null>(null)
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) =>
      setForeground(state === 'active')
    )
    return () => subscription.remove()
  }, [])
  useEffect(() => {
    const cancellation = new AbortController()
    registrationLifetime.current = cancellation
    return () => {
      cancellation.abort()
    }
  }, [
    client,
    preferences.notifications,
    preferences.quietHours,
    ready,
    preferencesError,
    registrationAvailable,
  ])
  useEffect(() => {
    const removers = registry.hosts.map((host) =>
      pushRegistrations.onRemoveHost(host.id, () =>
        controller.retireHost(host.id)
      )
    )
    return () => {
      for (const remove of removers) remove()
    }
  }, [controller, registry.hosts])
  useEffect(() => {
    const action = activityBridgeAction({
      hostsReady,
      preferencesReady: ready,
      preferencesError: Boolean(preferencesError),
      hasHosts: registry.hosts.length > 0,
      foreground,
      fresh,
      error: Boolean(error),
      hasSnapshot: Boolean(snapshot),
      hasClient: Boolean(client),
    })
    if (action === 'wait' || action === 'preserve') return
    if (action === 'end') {
      void controller
        .sync(null, async () => undefined, '')
        .catch((failure) => {
          onStatus?.(
            failure instanceof Error ? failure.message : '无法结束锁屏活动'
          )
        })
      return
    }
    if (action === 'stale') {
      void controller.markStale().catch((failure) => {
        onStatus?.(
          failure instanceof Error ? failure.message : '锁屏状态更新失败'
        )
      })
      return
    }
    if (!snapshot || !client) return
    const host = registry.hosts.find((value) => value.id === snapshot.hostId)
    if (!host || client.host.id !== host.id) return
    const quiet = isQuietTime(preferences, new Date())
    const now = Date.now()
    const props = taskActivityData(
      host,
      snapshot.sessions,
      snapshot.activity,
      preferences.notifications.decisions && !quiet,
      now,
      {
        mode: preferences.liveActivity,
        showCommand: preferences.liveActivityShowCommand,
      }
    )
    // Only used to close the card already on the lock screen with its outcome.
    const finished = finishedActivities(
      host,
      snapshot.sessions,
      snapshot.activity,
      now
    )
    const registrationKey = JSON.stringify([
      host.id,
      preferences.notifications,
      preferences.quietHours,
      // 这两项和 timeSensitive 都随登记上报给电脑，切换后需要重新登记。
      preferences.liveActivity,
      preferences.liveActivityShowCommand,
      preferences.timeSensitive,
    ])
    const cancellation = registrationLifetime.current!
    void controller
      .sync(
        props,
        async (activityId, token, value) => {
          if (cancellation.signal.aborted) return undefined
          const configured = await client.get<{ platforms: { ios: boolean } }>(
            '/api/sessions/mobile-push',
            { signal: cancellation.signal }
          )
          if (!configured.platforms.ios) {
            onStatus?.(
              '锁屏活动已在本机开启；电脑尚未配置 APNs，App 进入后台后不能远程更新。'
            )
            return undefined
          }
          const permission = await Notifications.getPermissionsAsync()
          if (!permission.granted) {
            onStatus?.('锁屏活动仅在本机更新；允许系统通知后才能登记后台推送。')
            return undefined
          }
          const deviceToken = await getDevicePushToken()
          const { decisions, completed, errors } = preferences.notifications
          const { enabled, start, end } = preferences.quietHours
          const response = await pushRegistrations.register(
            client,
            {
              platform: 'ios',
              kind: 'liveActivity',
              token,
              deviceToken,
              hostId: host.id,
              hostName: host.name,
              sessionId: value.sessionId,
              activityId,
              name: TASK_ACTIVITY_NAME,
              preferences: { decisions, completed, errors },
              quietHours: { enabled, start, end },
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              delivery: buildDelivery('ios', {
                timeSensitive: preferences.timeSensitive,
                liveActivity: preferences.liveActivity,
                liveActivityShowCommand: preferences.liveActivityShowCommand,
              }),
            },
            cancellation.signal
          )
          if (!response.registered || !response.id) {
            onStatus?.(
              '锁屏活动已在本机开启；电脑尚未配置 APNs，App 进入后台后不能远程更新。'
            )
            return undefined
          }
          const id = response.id
          return () => pushRegistrations.unregister(client, id, token)
        },
        registrationKey,
        finished
      )
      .then(() => {
        lastError.current = ''
      })
      .catch((failure) => {
        if (cancellation.signal.aborted) return
        const message =
          failure instanceof Error ? failure.message : '无法开启锁屏实时活动'
        if (lastError.current !== message) {
          lastError.current = message
          onStatus?.(message)
          console.warn(`[LiveActivity] ${message}`)
        }
      })
  }, [
    client,
    controller,
    error,
    foreground,
    fresh,
    hostsReady,
    onStatus,
    preferences,
    preferencesError,
    ready,
    registry.hosts,
    snapshot,
  ])
  return null
}
