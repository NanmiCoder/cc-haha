import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { randomUUID } from 'expo-crypto'
import type { ApiClient } from '../../core/client'
import type { TeamPlanAction, TeamPlanEdit } from '../../core/teamPlan'
import { TeamPlanSync, type TeamPlanSnapshot } from '../../core/teamPlanSync'

const EMPTY: TeamPlanSnapshot = { plan: null, pending: null, error: '' }
const idle = () => () => {}

/**
 * 会话的团队方案（逻辑见 core/teamPlanSync）。电脑推 `team_plan_updated` / `team_deleted`
 * （signal 变化）、连接恢复、回合起止时重新读取。
 */
export function useTeamPlan({
  client,
  sessionId,
  ready,
  signal,
  turnActive,
}: {
  client: ApiClient | null
  sessionId: string
  ready: boolean
  signal?: string
  turnActive: boolean
}) {
  const sync = useMemo(() => (client ? new TeamPlanSync(client, sessionId, randomUUID) : null), [client, sessionId])
  const snapshot = useSyncExternalStore(sync?.subscribe ?? idle, () => sync?.snapshot ?? EMPTY)
  useEffect(() => {
    if (!sync || !ready) return
    const controller = new AbortController()
    void sync.load(controller.signal)
    return () => controller.abort()
  }, [sync, ready, signal, turnActive])
  return {
    ...snapshot,
    edit: (edit: TeamPlanEdit) => sync?.edit(edit) ?? Promise.resolve(false),
    act: (action: TeamPlanAction, feedback?: string) => sync?.act(action, feedback) ?? Promise.resolve(false),
  }
}
export type TeamPlanController = ReturnType<typeof useTeamPlan>
