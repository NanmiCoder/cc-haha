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
export const pushRegistrations = new PushRegistrationCoordinator(secrets)
const Context = createContext<{
  registry: Registry
  ready: boolean
  error: string
  drafts: Drafts
  add(host: Host, credential: string, signal?: AbortSignal): Promise<void>
  select(id: string): Promise<void>
  remove(id: string): Promise<void>
} | null>(null)

export function AppProvider({ children }: React.PropsWithChildren) {
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
export function useApp() {
  const context = useContext(Context)
  if (!context) throw new Error('AppProvider is missing')
  return context
}
export function useConnection(id?: string) {
  const { registry } = useApp()
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
      repository
        .credential(host.id)
        .then((credential) => {
          if (!alive) return
          if (!credential)
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
  }, [host])
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
