import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react'
import { AppState } from 'react-native'
import { useConnection } from './AppContext'
import { DashboardPoller, type DashboardSnapshot } from '../core/dashboardSync'

export type { DashboardSnapshot } from '../core/dashboardSync'
const Context = createContext<{
  snapshot: DashboardSnapshot | null
  loading: boolean
  fresh: boolean
  error: string
  refresh(): void
}>({ snapshot: null, loading: false, fresh: false, error: '', refresh() {} })
export function DashboardProvider({ children }: PropsWithChildren) {
  const { client } = useConnection()
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<{
    hostId: string
    message: string
  } | null>(null)
  const [freshHost, setFreshHost] = useState<string | null>(null)
  const refresh = useRef<() => void>(() => {})
  useEffect(() => {
    if (!client) return
    const poller = new DashboardPoller(client, {
      snapshot: setSnapshot,
      loading: setLoading,
      fresh: (value) => setFreshHost(value ? client.host.id : null),
      error: (message) =>
        setFailure(message ? { hostId: client.host.id, message } : null),
    })
    refresh.current = () => poller.refresh()
    poller.start(AppState.currentState === 'active')
    const listener = AppState.addEventListener('change', (state) =>
      poller.setActive(state === 'active')
    )
    return () => {
      poller.stop()
      listener.remove()
      refresh.current = () => {}
    }
  }, [client])
  const trigger = useCallback(() => refresh.current(), [])
  return (
    <Context.Provider
      value={{
        snapshot: snapshot?.hostId === client?.host.id ? snapshot : null,
        loading,
        fresh: freshHost === client?.host.id,
        error:
          failure?.hostId === client?.host.id ? (failure?.message ?? '') : '',
        refresh: trigger,
      }}
    >
      {children}
    </Context.Provider>
  )
}
export function useDashboard() {
  return useContext(Context)
}
