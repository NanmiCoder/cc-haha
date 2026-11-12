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

/** App true in the foreground; polling stops when switched to background. */
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
  /** IDs of currently active background tasks in chat state; reread immediately when they change. */
  backgroundTaskIds: readonly string[]
  enabled?: boolean
  /**
   * Send via the session WebSocket (used to stop tasks); returns false if not sent.
   * When omitted uses the send function registered via `registerSessionSender`.
   */
  send?(message: ClientMessage): boolean
  /** Number of pending approvals; tone is attention when greater than 0. */
  pendingApprovals?: number
  /** `subagents` in chat state: live steps and counts of subagents. */
  live?: Record<string, SubagentLive>
  /** Working directory, used to show paths in steps as relative paths. */
  workDir?: string | null
  /** planId and state of the team plan; reread the team immediately on approval, launch or end. */
  teamPlan?: { planId: string; state: string } | null
}

export type SessionActivity = SessionActivityModel & {
  loading: boolean
  /** Description of load failures (old data kept on partial failure). */
  error: string
  stopError: string
  /** IDs of tasks with a stop request sent, waiting for computer confirmation. */
  stopping: readonly string[]
  refresh(): Promise<void>
  /** Stop a subagent or background command; returns false if not sent. */
  stopTask(taskId: string): boolean
  /** Stop all subagents and background commands still running. */
  stopAll(): boolean
}

/**
 * Run activity of one session: task list, team and background tasks are fetched only here, 
 * and the capsule, sheet and status line share the same derived result. Read every 3.5 seconds while running or with background tasks, 
 * and not when idle, page hidden or app in background.
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
  teamPlan,
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
    // Switching computer or session creates a new store and cancels old requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, sessionId, host.id]
  )
  useEffect(() => {
    store?.setSender(send)
  }, [store, send])
  useEffect(() => () => store?.dispose(), [store])
  const backgroundKey = backgroundTaskIds.join('\n')
  const visible = focused && appActive
  const teamPlanKey = teamPlan ? `${teamPlan.planId}:${teamPlan.state}` : ''
  const teamLaunching = teamPlan?.state === 'launching'
  useEffect(() => {
    store?.configure({ enabled: enabled && !!client, visible, turnActive, backgroundKey, teamPlanKey, teamLaunching })
  }, [store, enabled, client, visible, turnActive, backgroundKey, teamPlanKey, teamLaunching])
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
