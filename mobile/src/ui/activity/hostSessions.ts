import type { ApiClient } from '../../core/client'
import { groupDashboard, type MobileActivity } from '../../core/dashboard'
import type { DashboardSnapshot } from '../../core/dashboardSync'
import { sessionPath } from '../../core/operations'
import type { Session } from '../../core/types'

export type ActiveSession = { id: string; title: string }

const untitled = 'Untitled session'

/**
 * Whole-computer background activity only looks at "waiting for you" and "running" sessions. Prefer the snapshot home already fetched; 
 * when the snapshot is not for this computer (e.g. entered from another computer), read mobile-status and session summaries itself.
 */
export async function activeSessions(
  client: Pick<ApiClient, 'get'>,
  snapshot: DashboardSnapshot | null,
  signal?: AbortSignal
): Promise<ActiveSession[]> {
  if (snapshot) {
    const { waiting, running } = groupDashboard(snapshot.sessions, snapshot.activity)
    return [...waiting, ...running].map(({ session }) => ({
      id: session.id,
      title: session.title || untitled,
    }))
  }
  const status = await client.get<{ sessions: MobileActivity[] }>(
    '/api/sessions/mobile-status',
    { signal }
  )
  const ids = [
    ...new Set(
      status.sessions
        .filter((item) => item.activityState === 'waiting')
        .concat(status.sessions.filter((item) => item.activityState === 'running'))
        .map((item) => item.id)
    ),
  ]
  const summaries = await Promise.allSettled(
    ids.map((id) => client.get<Session>(`${sessionPath(id)}/summary`, { signal }))
  )
  return ids.map((id, index) => {
    const result = summaries[index]
    return {
      id,
      title: (result?.status === 'fulfilled' && result.value.title) || untitled,
    }
  })
}
