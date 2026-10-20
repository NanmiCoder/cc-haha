import { describe, expect, it, vi } from 'vitest'
import { api } from '@/api/client'
import { sessionCollaborationApi } from './sessionCollaboration'
import type { SessionDelegationBatch } from '../../../src/shared/sessionDelegation'
vi.mock('@/api/client', () => ({ api: { get: vi.fn(), post: vi.fn() } }))

describe('session delegation API', () => {
  it('encodes identifiers and submits revision guarded actions with composite model identities', () => {
    const batch = { id: 'batch/one', revision: 4 } as SessionDelegationBatch
    const runtime = { providerId: 'provider-b', modelId: 'same-model' }
    sessionCollaborationApi.get('parent/one')
    expect(api.get).toHaveBeenCalledWith('/api/session-collaboration/parent%2Fone/delegation')
    sessionCollaborationApi.update('parent', batch, [{ id: 'entry', runtime }])
    expect(api.post).toHaveBeenLastCalledWith('/api/session-collaboration/parent/batches/batch%2Fone/update', { expectedRevision: 4, selections: [{ id: 'entry', runtime }] })
    sessionCollaborationApi.act('parent', batch, 'confirm')
    expect(api.post).toHaveBeenLastCalledWith('/api/session-collaboration/parent/batches/batch%2Fone/confirm', { expectedRevision: 4 })
    sessionCollaborationApi.cancelChange('parent', 'change/one', 3)
    expect(api.post).toHaveBeenLastCalledWith('/api/session-collaboration/parent/model-changes/change%2Fone/cancel', { expectedRevision: 3 })
  })
  it('preserves immediate, pause-only and idempotency intent', () => {
    const input = { requestId: 'stable', mode: 'immediate' as const, resume: false, selections: [{ sessionId: 'child', runtime: { providerId: null, modelId: 'model' } }] }
    sessionCollaborationApi.change('parent', input)
    expect(api.post).toHaveBeenLastCalledWith('/api/session-collaboration/parent/model-changes', input)
  })
})

it('uses the authenticated API client and encodes search text', () => {
  const signal = new AbortController().signal
  sessionCollaborationApi.list('Auth / 中文', { signal })
  expect(api.get).toHaveBeenCalledWith('/api/session-collaboration?query=Auth%20%2F%20%E4%B8%AD%E6%96%87', { signal })
})
