
import { api } from './client'
import type { 
  SessionListItem, 
  MessageEntry, 
  SessionDetail, 
  CreateSessionRequest, 
  CreateSessionResponse 
} from '../types/session'

export type {
  SessionListItem,
  MessageEntry,
  SessionDetail,
  CreateSessionRequest,
  CreateSessionResponse,
} from '../types/session'

type SessionsResponse = { sessions: SessionListItem[]; total: number }
type MessagesResponse = {
  messages: MessageEntry[]
  taskNotifications?: unknown[]
}

export const sessionsApi = {
  list(params?: { project?: string; limit?: number; offset?: number }) {
    const query = new URLSearchParams()
    if (params?.project) query.set('project', params.project)
    if (params?.limit) query.set('limit', String(params.limit))
    if (params?.offset) query.set('offset', String(params.offset))
    const qs = query.toString()
    return api.get<SessionsResponse>(`/api/sessions${qs ? `?${qs}` : ''}`)
  },

  get(sessionId: string) {
    return api.get<SessionDetail>(`/api/sessions/${sessionId}`)
  },

  getMessages(sessionId: string) {
    return api.get<MessagesResponse>(`/api/sessions/${sessionId}/messages`)
  },

  create(input?: string | CreateSessionRequest) {
    const body = typeof input === 'string'
      ? (input ? { workDir: input } : {})
      : (input ?? {})
    return api.post<CreateSessionResponse>('/api/sessions', body)
  },

  delete(sessionId: string) {
    return api.delete<{ ok: true }>(`/api/sessions/${sessionId}`)
  },

  rename(sessionId: string, title: string) {
    return api.patch<{ ok: true }>(`/api/sessions/${sessionId}`, { title })
  },
}
