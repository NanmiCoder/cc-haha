import { api, type ApiRequestOptions } from '@/api/client'
import type { SessionDelegationBatch, SessionModelChange, SessionModelChangeInput, SessionModelChoice, SessionRuntimeSelection } from '../../../src/shared/sessionDelegation'

export type SessionCandidate = {
  sessionId: string
  title: string
  cwd: string
  status: string
  updatedAt: string
}

export type CollaborationMemberStatus = {
  sessionId: string
  rootSessionId: string
  parentSessionId: string | null
  state: string
  stopped: boolean
  title?: string
}

export type CollaborationMessageStatus = {
  id: string
  sourceSessionId: string
  targetSessionId: string
  content: string
  kind: string
  status: string
  error?: string
  errorCode?: string
}

export type SessionDelegationSnapshot = {
  batches: SessionDelegationBatch[]
  models: SessionModelChoice[]
  sessions?: Array<{ sessionId: string; runtime?: SessionRuntimeSelection; state: string; paused: boolean; error?: string }>
  changes: SessionModelChange[]
  status?: {
    revision: number
    members: CollaborationMemberStatus[]
    messages: CollaborationMessageStatus[]
  }
}
const base = (sessionId: string) => `/api/session-collaboration/${encodeURIComponent(sessionId)}`
export const sessionCollaborationApi = {
  list(query = '', options?: ApiRequestOptions) { return api.get<{ sessions: SessionCandidate[] }>(`/api/session-collaboration?query=${encodeURIComponent(query)}`, options) },
  get(sessionId: string) {
    return api.get<SessionDelegationSnapshot>(`${base(sessionId)}/delegation`)
  },
  resume(sessionId: string) {
    return api.post<{ ok: boolean }>(`${base(sessionId)}/resume`, {})
  },
  update(sessionId: string, batch: SessionDelegationBatch, selections: Array<{ id: string; runtime: SessionRuntimeSelection }>) {
    return api.post<SessionDelegationBatch>(`${base(sessionId)}/batches/${encodeURIComponent(batch.id)}/update`, { expectedRevision: batch.revision, selections })
  },
  act(sessionId: string, batch: SessionDelegationBatch, action: 'confirm' | 'cancel') {
    return api.post<SessionDelegationBatch>(`${base(sessionId)}/batches/${encodeURIComponent(batch.id)}/${action}`, { expectedRevision: batch.revision })
  },
  change(sessionId: string, input: SessionModelChangeInput) {
    return api.post<SessionModelChange>(`${base(sessionId)}/model-changes`, input)
  },
  cancelChange(sessionId: string, changeId: string, expectedRevision: number) {
    return api.post(`${base(sessionId)}/model-changes/${encodeURIComponent(changeId)}/cancel`, { expectedRevision })
  },
}
