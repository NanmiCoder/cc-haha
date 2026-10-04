import { api, type ApiRequestOptions } from './client'
import type { TraceCallsNear, TrajectoryLoc, TrajectoryPage, TrajectoryRowDetail, TrajectorySnapshotBlob } from '../types/trajectory'

function sessionPath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/trajectory`
}

export const trajectoryApi = {
  /** Tail page when neither `cursor` nor `after` is given. */
  getPage(
    sessionId: string,
    page: { cursor?: string; after?: string; agentId?: string } = {},
    options?: ApiRequestOptions,
  ) {
    const query = new URLSearchParams()
    if (page.cursor) query.set('cursor', page.cursor)
    if (page.after) query.set('after', page.after)
    if (page.agentId) query.set('agentId', page.agentId)
    const suffix = query.size ? `?${query}` : ''
    return api.get<TrajectoryPage>(`${sessionPath(sessionId)}${suffix}`, options)
  },

  getRow(
    sessionId: string,
    rowId: string,
    loc: TrajectoryLoc[],
    agentId?: string,
    options?: ApiRequestOptions,
  ) {
    const query = new URLSearchParams()
    query.set('loc', loc.map(([start, end]) => `${start}-${end}`).join(','))
    if (agentId) query.set('agentId', agentId)
    return api.get<TrajectoryRowDetail>(
      `${sessionPath(sessionId)}/rows/${encodeURIComponent(rowId)}?${query}`,
      options,
    )
  },

  /** Captured model calls that started inside `[from, to]` (located by time through the capture index). */
  getTraceCallsNear(sessionId: string, from: string, to: string, options?: ApiRequestOptions) {
    const query = new URLSearchParams({ from, to })
    return api.get<TraceCallsNear>(`/api/sessions/${encodeURIComponent(sessionId)}/trace/near?${query}`, options)
  },

  getSnapshot(sessionId: string, hash: string, options?: ApiRequestOptions) {
    return api.get<TrajectorySnapshotBlob>(
      `${sessionPath(sessionId)}/snapshots/${encodeURIComponent(hash)}`,
      options,
    )
  },
}
