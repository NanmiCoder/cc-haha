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
import { isAppForeground } from '../core/appVisibility'
import { foregroundGate } from '../core/foregroundGate'
import {
  DashboardPoller,
  loadDashboardSnapshot,
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
  /**
   * 聊天页聚焦期间调用：只轮询运行状态，不再反复拉整份会话列表。返回释放函数。
   */
  holdActivityScope(): () => void
}>({
  snapshot: null,
  loading: false,
  fresh: false,
  error: '',
  failure: null,
  refresh() {},
  holdActivityScope: () => () => {},
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
  const poller = useRef<DashboardPoller | null>(null)
  const activityHolds = useRef(new Set<symbol>())
  const applyScope = useCallback(() => {
    poller.current?.setScope(activityHolds.current.size ? 'activity' : 'full')
  }, [])
  const holdActivityScope = useCallback(() => {
    const token = Symbol('activity')
    activityHolds.current.add(token)
    applyScope()
    return () => {
      if (activityHolds.current.delete(token)) applyScope()
    }
  }, [applyScope])
  useEffect(() => {
    if (!client) return
    const instance = new DashboardPoller(client, {
      snapshot: setSnapshot,
      loading: setLoading,
      fresh: (value) => setFreshHost(value ? client.host.id : null),
      error: (message, kind) =>
        setFailure(
          message
            ? { hostId: client.host.id, message, kind: kind ?? 'failed' }
            : null
        ),
    }, undefined, loadDashboardSnapshot, foregroundGate)
    poller.current = instance
    applyScope()
    refresh.current = () => instance.refresh()
    instance.start(isAppForeground(AppState.currentState))
    const listener = AppState.addEventListener('change', (state) =>
      instance.setActive(isAppForeground(state))
    )
    return () => {
      instance.stop()
      listener.remove()
      if (poller.current === instance) poller.current = null
      refresh.current = () => {}
    }
  }, [client, applyScope])
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
        holdActivityScope,
      }}
    >
      {children}
    </Context.Provider>
  )
}
export function useDashboard() {
  return useContext(Context)
}
