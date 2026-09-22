import { api, type ApiRequestOptions } from '@/api/client'

export type SessionCandidate = {
  sessionId: string
  title: string
  cwd: string
  status: string
  updatedAt: string
}
const base = '/api/session-collaboration'
export const sessionCollaborationApi = {
  list(query = '', options?: ApiRequestOptions) { return api.get<{ sessions: SessionCandidate[] }>(`${base}?query=${encodeURIComponent(query)}`, options) },
}
