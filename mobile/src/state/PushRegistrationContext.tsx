import {
  createContext,
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

export type PushStatus =
  | 'loading'
  | 'registered'
  | 'notConfigured'
  | 'permissionRequired'
  | 'unsupported'
  | 'error'
type Info = { status: PushStatus; error?: string }
const Context = createContext<Record<string, Info>>({})
function RegisterHost({
  id,
  onChange,
}: {
  id: string
  onChange(id: string, info: Info): void
}) {
  const { client } = useConnection(id)
  const { preferences, ready, error: preferencesError } = usePreferences()
  useEffect(() => {
    if (!client || Platform.OS === 'web') return
    if (!ready || preferencesError) {
      onChange(
        id,
        preferencesError
          ? { status: 'error', error: preferencesError }
          : { status: 'loading' }
      )
      return
    }
    let alive = true
    let running = false
    let pending = false
    let pendingToken: string | undefined
    let observedToken: string | undefined
    const controller = new AbortController()
    function update(info: Info) {
      if (alive) onChange(id, info)
    }
    async function register(nativeToken?: string) {
      if (!alive || controller.signal.aborted) return
      if (running) {
        pending = true
        if (nativeToken) pendingToken = nativeToken
        return
      }
      running = true
      update({ status: 'loading' })
      try {
        const permission = await Notifications.getPermissionsAsync()
        if (controller.signal.aborted) return
        if (!permission.granted) {
          await pushRegistrations.clearRegistrations(client!)
          update({ status: 'permissionRequired' })
          return
        }
        const configured = await client!.get<{
          platforms: { ios: boolean; android: boolean }
          status: string
        }>('/api/sessions/mobile-push', { signal: controller.signal })
        const platform = Platform.OS === 'ios' ? 'ios' : 'android'
        if (!configured.platforms[platform]) {
          update({ status: 'notConfigured' })
          return
        }
        const token = nativeToken ?? (await getDevicePushToken())
        observedToken = token
        if (controller.signal.aborted) return
        const { decisions, completed, errors } = preferences.notifications
        const { enabled, start, end } = preferences.quietHours
        const result = await pushRegistrations.register(
          client!,
          {
            platform,
            token,
            hostId: id,
            preferences: { decisions, completed, errors },
            quietHours: { enabled, start, end },
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
          controller.signal
        )
        if (result.registered && result.id) {
          update({ status: 'registered' })
        } else update({ status: 'notConfigured' })
      } catch (e) {
        if (!controller.signal.aborted)
          update({
            status: 'error',
            error: e instanceof Error ? e.message : '通知登记失败',
          })
      } finally {
        running = false
        if (pending && alive) {
          const token = pendingToken
          pending = false
          pendingToken = undefined
          void register(token)
        }
      }
    }
    void register()
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') void register()
    })
    const tokens = Notifications.addPushTokenListener((token) => {
      if (typeof token.data === 'string' && token.data !== observedToken) {
        observedToken = token.data
        void register(token.data)
      }
    })
    return () => {
      alive = false
      controller.abort()
      listener.remove()
      tokens.remove()
    }
  }, [
    client,
    id,
    onChange,
    preferences.notifications,
    preferences.quietHours,
    ready,
    preferencesError,
  ])
  return null
}
export function PushRegistrationProvider({ children }: PropsWithChildren) {
  const { registry } = useApp()
  const [statuses, setStatuses] = useState<Record<string, Info>>({})
  const [onChange] = useState(
    () => (id: string, info: Info) =>
      setStatuses((current) => ({ ...current, [id]: info }))
  )
  return (
    <Context.Provider value={statuses}>
      {registry.hosts.map((host) => (
        <RegisterHost key={host.id} id={host.id} onChange={onChange} />
      ))}
      {children}
    </Context.Provider>
  )
}
export function usePushRegistration(hostId?: string) {
  return useContext(Context)[hostId ?? '']
}
