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
import {
  DashboardPoller,
  type DashboardFailure,
  type DashboardSnapshot,
} from '../core/dashboardSync'

export type { DashboardFailure, DashboardSnapshot } from '../core/dashboardSync'
const Context = createContext<{
  /**
   * 这台电脑最后一份成功的快照。出错或过期时仍保留（只在内存里），
   * 用 fresh / failure 判断它是否还能代表电脑当前的状态。
   */
  snapshot: DashboardSnapshot | null
  loading: boolean
  fresh: boolean
  error: string
  failure: DashboardFailure | null
  refresh(): void
}>({
  snapshot: null,
  loading: false,
  fresh: false,
  error: '',
  failure: null,
  refresh() {},
})
export function DashboardProvider({ children }: PropsWithChildren) {
  const { client } = useConnection()
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<{
    hostId: string
    message: string
    kind: DashboardFailure
  } | null>(null)
  const [freshHost, setFreshHost] = useState<string | null>(null)
  const refresh = useRef<() => void>(() => {})
  useEffect(() => {
    if (!client) return
    const poller = new DashboardPoller(client, {
      snapshot: setSnapshot,
      loading: setLoading,
      fresh: (value) => setFreshHost(value ? client.host.id : null),
      error: (message, kind) =>
        setFailure(
          message
            ? { hostId: client.host.id, message, kind: kind ?? 'failed' }
            : null
        ),
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
  const current = failure?.hostId === client?.host.id ? failure : null
  return (
    <Context.Provider
      value={{
        snapshot: snapshot?.hostId === client?.host.id ? snapshot : null,
        loading,
        fresh: freshHost === client?.host.id,
        error: current?.message ?? '',
        failure: current?.kind ?? null,
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
