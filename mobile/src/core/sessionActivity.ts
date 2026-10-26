import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import { useIsFocused } from 'expo-router'
import type { ApiClient } from './client'
import { sendToSession } from './sessionSender'
import type { ClientMessage, Host, SubagentLive } from './types'
import {
  ActivityStore,
  createActivityFetcher,
  deriveActivity,
  emptyActivityData,
  type SessionActivityModel,
} from './sessionActivityModel'

export * from './sessionActivityModel'

const noopSubscribe = () => () => {}
const emptySnapshot = () => emptyActivityData

/** App 在前台时为 true；切到后台就停止轮询。 */
function useAppActive() {
  const [active, setActive] = useState(() => AppState.currentState !== 'background')
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setActive(state === 'active'))
    return () => subscription.remove()
  }, [])
  return active
}

export type UseSessionActivityOptions = {
  client: ApiClient | null
  host: Pick<Host, 'id'>
  sessionId: string
  turnActive: boolean
  /** 聊天状态里当前活动的后台任务 id；增减时立刻重读。 */
  backgroundTaskIds: readonly string[]
  enabled?: boolean
  /**
   * 通过会话 WebSocket 发送（停止任务用）；没发出去返回 false。
   * 不传时用 `registerSessionSender` 登记的发送函数。
   */
  send?(message: ClientMessage): boolean
  /** 待审批的数量；大于 0 时 tone 为 attention。 */
  pendingApprovals?: number
  /** 聊天状态里的 `subagents`：子 Agent 的实时步骤和计数。 */
  live?: Record<string, SubagentLive>
  /** 工作目录，用于把步骤里的路径显示成相对路径。 */
  workDir?: string | null
}

export type SessionActivity = SessionActivityModel & {
  loading: boolean
  /** 读取失败的说明（部分失败时旧数据保留）。 */
  error: string
  stopError: string
  /** 已发出停止请求、等电脑确认的任务 id。 */
  stopping: readonly string[]
  refresh(): Promise<void>
  /** 停止一个子 Agent 或后台命令；没发出去返回 false。 */
  stopTask(taskId: string): boolean
  /** 停止所有仍在运行的子 Agent 和后台命令。 */
  stopAll(): boolean
}

/**
 * 一个会话的运行活动：任务清单、团队、后台任务只在这里拉一次，
 * 胶囊、底单、状态行共用同一份派生结果。运行或有后台任务时每 3.5 秒读一次，
 * 空闲、页面不可见或 App 在后台时不读。
 */
export function useSessionActivity({
  client,
  host,
  sessionId,
  turnActive,
  backgroundTaskIds,
  enabled = true,
  send,
  pendingApprovals = 0,
  live,
  workDir,
}: UseSessionActivityOptions): SessionActivity {
  const focused = useIsFocused()
  const appActive = useAppActive()
  const store = useMemo(
    () =>
      client
        ? new ActivityStore({
            fetch: createActivityFetcher(client, sessionId),
            send: (message) => sendToSession(sessionId, message),
          })
        : null,
    // 换电脑或换会话就换一个新的仓库，旧请求随之取消。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, sessionId, host.id]
  )
  useEffect(() => {
    store?.setSender(send)
  }, [store, send])
  useEffect(() => () => store?.dispose(), [store])
  const backgroundKey = backgroundTaskIds.join('\n')
  const visible = focused && appActive
  useEffect(() => {
    store?.configure({ enabled: enabled && !!client, visible, turnActive, backgroundKey })
  }, [store, enabled, client, visible, turnActive, backgroundKey])
  const data = useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getSnapshot : emptySnapshot
  )
  const model = useMemo(
    () => deriveActivity(data, { live, pendingApprovals, turnActive, workDir }),
    [data, live, pendingApprovals, turnActive, workDir]
  )
  const stopping = useMemo(() => Object.keys(data.stopping), [data.stopping])
  const refresh = useCallback(async () => {
    await store?.refresh({ forceTeam: true })
  }, [store])
  const stopTask = useCallback((taskId: string) => store?.stopTask(taskId) ?? false, [store])
  const stopAll = useCallback(() => store?.stopAll() ?? false, [store])
  return {
    ...model,
    loading: enabled && !!client && !data.loaded,
    error: data.error,
    stopError: model.runningCount > 0 ? data.stopError : '',
    stopping,
    refresh,
    stopTask,
    stopAll,
  }
}
