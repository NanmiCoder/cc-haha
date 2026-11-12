import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { AppState, Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { getRandomBytes } from 'expo-crypto'
import CCHahaDuty from '../../modules/cchaha-duty'
import { Drafts, HostRepository, type Registry, type Storage } from './storage'
import { PushRegistrationCoordinator } from './pushRegistrations'
import { PushTokens } from './pushProvider'
import { BackgroundDuty } from './backgroundDuty'
import { getDevicePushToken, getExpoPushToken } from './devicePushToken'
import { createApiClient, hostRelocator } from './api'
import { hostLinks } from '../core/hostLink'
import type { Host } from '../core/types'
import { h5CredentialValue, resolveH5Session, type H5Storage } from '../core/h5Session'
import { h5Location, isH5 } from './h5'

// Web is a review surface. Tokens deliberately disappear when its document reloads.
const memory = new Map<string, string>()
const secrets: Storage =
  Platform.OS === 'web'
    ? {
        getItem: async (key) => memory.get(key) ?? null,
        setItem: async (key, value) => {
          memory.set(key, value)
        },
        removeItem: async (key) => {
          memory.delete(key)
        },
      }
    : {
        getItem: SecureStore.getItemAsync,
        setItem: SecureStore.setItemAsync,
        removeItem: SecureStore.deleteItemAsync,
      }
const repository = new HostRepository(AsyncStorage, secrets)
const storedCredential = async (id: string) => (await repository.credential(id)) || null
export const pushRegistrations = new PushRegistrationCoordinator(secrets)
export const pushTokens = new PushTokens(secrets, {
  random: getRandomBytes,
  device: getDevicePushToken,
  expo: getExpoPushToken,
})
/** The Android foreground service that pulls alerts from computers registered via `desktop`. */
export const backgroundDuty = new BackgroundDuty(
  Platform.OS === 'android' ? CCHahaDuty : null
)
type AppContextValue = {
  registry: Registry
  ready: boolean
  error: string
  drafts: Drafts
  /** The stored credential; `null` when there is none. An H5 page may use `''` (cookie or loopback). */
  credential(id: string): Promise<string | null>
  add(host: Host, credential: string, signal?: AbortSignal): Promise<void>
  select(id: string): Promise<void>
  remove(id: string): Promise<void>
  /** A remote computer's verified new public address (its tunnel restarted). */
  relocate(id: string, url: string): Promise<void>
}
const Context = createContext<AppContextValue | null>(null)

export function AppProvider({ children }: React.PropsWithChildren) {
  return isH5 ? <H5AppProvider>{children}</H5AppProvider> : <NativeAppProvider>{children}</NativeAppProvider>
}

function NativeAppProvider({ children }: React.PropsWithChildren) {
  const [registry, setRegistry] = useState<Registry>({
    version: 1,
    hosts: [],
    selectedId: null,
  })
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [drafts] = useState(() => new Drafts())
  useEffect(() => {
    repository
      .load()
      .then(setRegistry)
      .catch((e) => setError(e.message))
      .finally(() => setReady(true))
  }, [])
  useEffect(() => {
    // The background service mutes its alerts while the app itself is on screen,
    // and can only (re)start from the foreground.
    backgroundDuty.setAppActive(AppState.currentState === 'active')
    const listener = AppState.addEventListener('change', (state) =>
      backgroundDuty.setAppActive(state === 'active')
    )
    return () => listener.remove()
  }, [])
  useEffect(() => {
    if (!ready || error) return
    backgroundDuty.retain(registry.hosts.map((host) => host.id))
    // A removed computer's direct-connection link must stop signaling on every
    // foreground and network change.
    hostLinks.retain(registry.hosts.map((host) => host.id))
    // ...and its local-network hints go with it.
    void hostRelocator.retain(registry.hosts.map((host) => host.id)).catch(() => {})
  }, [ready, error, registry.hosts])
  const relocate = useCallback(async (id: string, url: string) => {
    const next = await repository.updateUrl(id, url)
    if (!next) return
    // Links are cached per computer and keep the address they were made with:
    // drop it before anything rebuilds a client for the new address.
    hostLinks.forget(id)
    setRegistry(next)
  }, [])
  useEffect(() => {
    if (!ready || error) return
    return hostRelocator.attach({
      host: (id) => registry.hosts.find((host) => host.id === id),
      credential: storedCredential,
      relocate,
    })
  }, [ready, error, registry.hosts, relocate])
  return (
    <Context.Provider
      value={{
        registry,
        ready,
        error,
        drafts,
        credential: storedCredential,
        add: async (host, credential, signal) => {
          if (error) throw new Error(error)
          setRegistry(await repository.add(host, credential, signal))
        },
        select: async (id) => setRegistry(await repository.select(id)),
        remove: async (id) => {
          const host = registry.hosts.find((value) => value.id === id)
          if (!host) return
          const credential = await repository.credential(id)
          const client = credential ? createApiClient(host, credential) : null
          // Not on unmount: Android unmounts React when the activity goes away,
          // exactly when the background connection has to keep running.
          backgroundDuty.set(id, undefined)
          void pushTokens.forget(id).catch(() => {})
          setRegistry(
            await pushRegistrations.removeHost(id, client, () =>
              repository.remove(id)
            )
          )
          // The unregister request above may have created this computer's link.
          hostLinks.forget(id)
          drafts.removeHost(id)
        },
        relocate,
      }}
    >
      {children}
    </Context.Provider>
  )
}
/**
 * The page the computer serves to phone browsers: that computer is the only
 * one. Its connection was set up by the desktop H5 entry (token page or remote
 * pairing); without one the page goes back there.
 */
function H5AppProvider({ children }: React.PropsWithChildren) {
  const [state, setState] = useState<{
    registry: Registry
    credential: string | null
    ready: boolean
  }>({ registry: { version: 1, hosts: [], selectedId: null }, credential: null, ready: false })
  const [error, setError] = useState('')
  const [drafts] = useState(() => new Drafts())
  useEffect(() => {
    const controller = new AbortController()
    resolveH5Session({
      location: h5Location(),
      storage: safeLocalStorage(),
      fetch: (url, init) => fetch(url, init),
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return
        if ('entry' in result) {
          window.location.replace(result.entry)
          return
        }
        setState({
          registry: { version: 1, hosts: [result.host], selectedId: result.host.id },
          credential: h5CredentialValue(result.credential),
          ready: true,
        })
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure))
      })
    return () => controller.abort()
  }, [])
  const value = useMemo<AppContextValue>(() => {
    const unsupported = async () => {
      throw new Error('网页版只连接打开它的这台电脑')
    }
    return {
      registry: state.registry,
      ready: state.ready,
      error,
      drafts,
      credential: async (id) =>
        state.registry.hosts.some((host) => host.id === id) ? state.credential : null,
      add: unsupported,
      select: unsupported,
      remove: unsupported,
      relocate: unsupported,
    }
  }, [state, error, drafts])
  return <Context.Provider value={value}>{children}</Context.Provider>
}

function safeLocalStorage(): H5Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function useApp() {
  const context = useContext(Context)
  if (!context) throw new Error('AppProvider is missing')
  return context
}
export function useConnection(id?: string) {
  const { registry, credential: credentialOf } = useApp()
  const host = registry.hosts.find(
    (item) => item.id === (id ?? registry.selectedId)
  )
  const [restored, setRestored] = useState<{
    host: Host
    credential: string | null
    issue: 'missing' | 'unavailable' | null
    message: string
  } | null>(null)
  // Forget the previous selection before rendering any new host-bound client.
  if (restored && restored.host !== host) setRestored(null)
  useEffect(() => {
    if (!host) return
    let alive = true
    let active = AppState.currentState === 'active'
    let resolved = false
    let generation = 0
    let retries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const restore = async () => {
      if (!alive || !active || resolved) return
      const attempt = ++generation
      const current = () => alive && active && attempt === generation
      try {
        const credential = await credentialOf(host.id)
        if (!current()) return
        resolved = credential !== null
        setRestored({
          host,
          credential,
          issue: credential === null ? 'missing' : null,
          message: credential === null ? '未找到这台电脑的连接凭据，请检查手机上的连接设置' : '',
        })
      } catch {
        if (!current()) return
        // A locked/unavailable secret store says nothing about server authorization.
        setRestored({
          host,
          credential: null,
          issue: 'unavailable',
          message: '暂时无法读取连接凭据，请解锁手机后重试',
        })
        const delay = [1000, 3000, 10000][retries++]
        if (delay !== undefined) timer = setTimeout(() => void restore(), delay)
      }
    }
    const listener = AppState.addEventListener('change', (state) => {
      const next = state === 'active'
      if (active === next) return
      active = next
      generation++
      clearTimeout(timer)
      if (active) {
        retries = 0
        void restore()
      }
    })
    void restore()
    return () => {
      alive = false
      clearTimeout(timer)
      listener.remove()
    }
  }, [host, credentialOf])
  const current = restored?.host === host ? restored : null
  const client = useMemo(
    () =>
      host && current?.credential !== null && current?.credential !== undefined
        ? createApiClient(host, current.credential)
        : null,
    [host, current]
  )
  return {
    host,
    client,
    credential: current?.credential ?? undefined,
    error: current?.message ?? '',
    credentialIssue: current?.issue ?? null,
  }
}
