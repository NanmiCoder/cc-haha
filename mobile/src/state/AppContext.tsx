import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { Drafts, HostRepository, type Registry, type Storage } from './storage'
import { PushRegistrationCoordinator } from './pushRegistrations'
import { createApiClient } from './api'
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
          setRegistry(
            await pushRegistrations.removeHost(id, client, () =>
              repository.remove(id)
            )
          )
          drafts.removeHost(id)
        },
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
  const [auth, setAuth] = useState<{ id: string; credential: string } | null>(
    null
  )
  const [failure, setFailure] = useState<{
    id: string
    message: string
  } | null>(null)
  useEffect(() => {
    let alive = true
    if (host)
      credentialOf(host.id)
        .then((credential) => {
          if (!alive) return
          if (credential === null)
            setFailure({
              id: host.id,
              message: '连接凭据已失效，请在主机页面移除后重新连接',
            })
          else setAuth({ id: host.id, credential })
        })
        .catch((e) => {
          if (alive) setFailure({ id: host.id, message: e.message })
        })
    return () => {
      alive = false
    }
  }, [host, credentialOf])
  const client = useMemo(
    () =>
      host && auth?.id === host.id
        ? createApiClient(host, auth.credential)
        : null,
    [host, auth]
  )
  return {
    host,
    client,
    credential: auth?.id === host?.id ? auth?.credential : undefined,
    error: failure?.id === host?.id ? (failure?.message ?? '') : '',
  }
}
