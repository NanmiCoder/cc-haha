import { describe, expect, it, vi } from 'vitest'
import { api } from '@/api/client'
import { teamPlansApi } from './teamPlans'
import type { TeamPlanRecord } from '../../../src/shared/teamPlan'

vi.mock('@/api/client', () => ({ api: { get: vi.fn(), patch: vi.fn(), post: vi.fn() } }))

describe('team plan wire contract', () => {
  it('sends only approved editable fields and full revision identity', () => {
    const plan = {
      teamName: 'team / one', sessionId: 'session', planId: 'plan', incarnationId: 'incarnation', revision: 7, members: [], tasks: [],
    } as unknown as TeamPlanRecord
    teamPlansApi.save(plan, {
      members: [{ id: 'one', name: 'One', agentType: 'reviewer', prompt: 'Do not send prompt', runtime: { providerId: 'provider', modelId: 'model' }, agentSnapshot: { systemPrompt: 'Do not send snapshot' } }],
      tasks: [{ id: 'task', subject: 'Do not send subject', dependencies: ['other'], ownerId: 'one' }],
    })
    expect(api.patch).toHaveBeenCalledWith('/api/teams/team%20%2F%20one/plan', {
      sessionId: 'session', planId: 'plan', incarnationId: 'incarnation', expectedRevision: 7,
      members: [{ id: 'one', agentType: 'reviewer', runtime: { providerId: 'provider', modelId: 'model' } }],
      tasks: [{ id: 'task', ownerId: 'one' }],
    })
  })

  it('omits unchanged runtimes so preset edits do not become human model overrides', () => {
    vi.mocked(api.patch).mockClear()
    const member = { id: 'one', name: 'One', agentType: 'engineer', prompt: 'Implement', runtime: { providerId: 'provider', modelId: 'balanced' } }
    const plan = { teamName: 'team', sessionId: 'session', planId: 'plan', incarnationId: 'incarnation', revision: 7, members: [member], tasks: [] } as unknown as TeamPlanRecord
    teamPlansApi.save(plan, { members: [{ ...member, agentType: 'reviewer' }], tasks: [] })
    expect(vi.mocked(api.patch).mock.calls[0]![1]).toMatchObject({ members: [{ id: 'one', agentType: 'reviewer' }] })
    expect((vi.mocked(api.patch).mock.calls[0]![1] as { members: unknown[] }).members).toEqual([{ id: 'one', agentType: 'reviewer' }])
  })

  it('scopes reads to the requested session and includes idempotency on actions', () => {
    teamPlansApi.get('session/one')
    expect(api.get).toHaveBeenCalledWith('/api/teams/session/session%2Fone/plan')
    teamPlansApi.act({ teamName: 'team', sessionId: 'session', planId: 'plan', incarnationId: 'incarnation', revision: 2 } as TeamPlanRecord, 'approve', 'request')
    expect(api.post).toHaveBeenCalledWith('/api/teams/team/plan/approve', {
      sessionId: 'session', planId: 'plan', incarnationId: 'incarnation', expectedRevision: 2, requestId: 'request',
    })
  })
})
