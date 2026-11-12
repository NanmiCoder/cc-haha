import type { ApiClient } from './client'
import { sessionPath, type BackgroundSnapshot, type BackgroundTask } from './operations'

export type SessionTasks = { sessionId: string; tasks: BackgroundTask[] }

/**
 * Background activity on a computer = union of each session's background tasks. The server only has per-session endpoints, 
 * so read concurrently here; a single session failure does not affect others, and failed sessions are omitted from the result.
 */
export async function loadHostBackgroundTasks(
  client: Pick<ApiClient, 'get'>,
  sessionIds: string[],
  signal?: AbortSignal
): Promise<SessionTasks[]> {
  const unique = [...new Set(sessionIds)]
  const results = await Promise.allSettled(
    unique.map(async (sessionId) => {
      const snapshot = await client.get<BackgroundSnapshot>(
        `${sessionPath(sessionId)}/background-tasks`,
        { signal }
      )
      return { sessionId, tasks: snapshot.tasks ?? [] }
    })
  )
  return results.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : []
  )
}

export function runningTaskCount(groups: SessionTasks[]) {
  return groups.reduce(
    (total, group) =>
      total + group.tasks.filter((task) => task.status === 'running').length,
    0
  )
}
