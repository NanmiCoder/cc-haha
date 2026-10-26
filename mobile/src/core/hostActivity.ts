import type { ApiClient } from './client'
import { sessionPath, type BackgroundSnapshot, type BackgroundTask } from './operations'

export type SessionTasks = { sessionId: string; tasks: BackgroundTask[] }

/**
 * 一台电脑上的后台活动 = 各会话后台任务的并集。服务端只有按会话的接口，
 * 这里并发读取；单个会话失败不影响其他会话，失败的会话不出现在结果里。
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
