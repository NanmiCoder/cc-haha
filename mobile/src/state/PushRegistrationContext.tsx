import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type PropsWithChildren,
} from 'react'
import { AppState, Platform } from 'react-native'
import * as Notifications from 'expo-notifications'
import { pushRegistrations, useApp, useConnection } from './AppContext'
import { usePreferences } from './PreferencesContext'
import { getDevicePushToken } from './devicePushToken'
import { subscribePermissionDecided } from './notifyPromptGate'
import { ensureNotificationChannel } from './notificationChannel'
import { buildDelivery } from './pushRegistrations'
import { ApiError } from '../core/client'
import {
  PushRegistrationRecovery,
  pushRegistrationFailure,
  type PushInfo,
  type PushStage,
} from './pushRegistrationRecovery'

export type { PushStatus, PushIssue, PushInfo } from './pushRegistrationRecovery'

type RetryRegistry = Map<string, () => void>
const Context = createContext<Record<string, PushInfo>>({})
const RetryContext = createContext<RetryRegistry>(new Map())
function RegisterHost({
  id,
  onChange,
  retries,
}: {
  id: string
  onChange(id: string, info: PushInfo): void
  retries: RetryRegistry
}) {
  const { client, error: connectionError } = useConnection(id)
  const { preferences, ready, error: preferencesError } = usePreferences()
  useEffect(() => {
    if (Platform.OS === 'web') return
    if (!client) {
      onChange(id, connectionError
        ? { status: 'error', issue: 'authorization', error: connectionError }
        : { status: 'loading' })
      return
    }
    if (!ready || preferencesError) {
      onChange(id, preferencesError
        ? { status: 'error', issue: 'storage', error: preferencesError }
        : { status: 'loading' })
      return
    }
    let observedToken: string | undefined
    const recovery = new PushRegistrationRecovery(async (signal, nativeToken) => {
      let stage: PushStage = 'permission'
      const check = () => {
        if (signal.aborted) throw new ApiError('通知登记已取消', 0, 'ABORTED')
      }
      try {
        const permission = await Notifications.getPermissionsAsync()
        check()
        if (!permission.granted) {
          // Revocation proofs remain durable if the computer is offline. A cleanup
          // failure must not hide the already-known system permission state.
          try {
            await pushRegistrations.clearRegistrations(client)
            return { info: { status: 'permissionRequired' } }
          } catch (error) {
            return { info: { ...pushRegistrationFailure(error, 'registration').info, status: 'permissionRequired' } }
          }
        }
        stage = 'device'
        const token = nativeToken ?? (await getDevicePushToken())
        observedToken = token
        check()
        stage = 'host'
        const configured = await client.get<{
          platforms: { ios: boolean; android: boolean }
          status: string
        }>('/api/sessions/mobile-push', { signal })
        check()
        const platform = Platform.OS === 'ios' ? 'ios' : 'android'
        if (typeof configured?.platforms?.[platform] !== 'boolean')
          throw new ApiError('电脑返回的推送状态无效', 0, 'INVALID_RESPONSE')
        if (!configured.platforms[platform])
          return { info: { status: 'notConfigured' } }
        const { decisions, completed, errors } = preferences.notifications
        const { enabled, start, end } = preferences.quietHours
        // Android only declares split channels after channel creation succeeds.
        let channelsReady = false
        if (platform === 'android')
          channelsReady = await ensureNotificationChannel().then(() => true, () => false)
        check()
        stage = 'registration'
        const result = await pushRegistrations.register(
          client,
          {
            platform,
            token,
            hostId: id,
            preferences: { decisions, completed, errors },
            quietHours: { enabled, start, end },
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            delivery: buildDelivery(platform, {
              channelsReady,
              timeSensitive: preferences.timeSensitive,
              liveActivity: preferences.liveActivity,
              liveActivityShowCommand: preferences.liveActivityShowCommand,
            }),
          },
          signal
        )
        check()
        if (result.registered && result.id)
          return { info: { status: 'registered' } }
        if (!result.registered && result.status === 'notConfigured')
          return { info: { status: 'notConfigured' } }
        throw new ApiError('电脑返回的通知登记结果无效', 0, 'INVALID_RESPONSE')
      } catch (error) {
        return pushRegistrationFailure(error, stage)
      }
    }, (info) => onChange(id, info))
    const refresh = () => recovery.refresh()
    retries.set(id, refresh)
    recovery.setActive(AppState.currentState === 'active')
    const listener = AppState.addEventListener('change', (state) => {
      recovery.setActive(state === 'active')
    })
    const decided = subscribePermissionDecided(refresh)
    const tokens = Notifications.addPushTokenListener((token) => {
      if (typeof token.data === 'string' && token.data !== observedToken) {
        observedToken = token.data
        recovery.refresh(token.data)
      }
    })
    return () => {
      recovery.stop()
      if (retries.get(id) === refresh) retries.delete(id)
      listener.remove()
      decided()
      tokens.remove()
    }
  }, [
    client,
    connectionError,
    retries,
    id,
    onChange,
    preferences.notifications,
    preferences.quietHours,
    preferences.timeSensitive,
    preferences.liveActivity,
    preferences.liveActivityShowCommand,
    ready,
    preferencesError,
  ])
  return null
}
export function PushRegistrationProvider({ children }: PropsWithChildren) {
  const { registry } = useApp()
  const [statuses, setStatuses] = useState<Record<string, PushInfo>>({})
  const [onChange] = useState(
    () => (id: string, info: PushInfo) =>
      setStatuses((current) => ({ ...current, [id]: info }))
  )
  const [retries] = useState<RetryRegistry>(() => new Map())
  return (
    <Context.Provider value={statuses}>
      <RetryContext.Provider value={retries}>
        {registry.hosts.map((host) => (
          <RegisterHost key={host.id} id={host.id} onChange={onChange} retries={retries} />
        ))}
        {children}
      </RetryContext.Provider>
    </Context.Provider>
  )
}
export function usePushRegistration(hostId?: string) {
  return useContext(Context)[hostId ?? '']
}

/** Explicit retry also rechecks a configured-but-not-yet-registered computer. */
export function useRetryPushRegistration(hostId?: string) {
  const retries = useContext(RetryContext)
  return useCallback(() => {
    if (hostId) retries.get(hostId)?.()
  }, [hostId, retries])
}
