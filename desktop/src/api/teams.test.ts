import { describe, expect, it, vi } from 'vitest'
import { api } from '@/api/client'
import { teamsApi } from './teams'

vi.mock('@/api/client', () => ({ api: { get: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn() } }))

describe('team member wire contract', () => {
  it("switches a member's model through its team, never a session route", () => {
    const change = {
      providerId: null, modelId: 'claude-sonnet-4-6', effortLevel: 'high',
      leadSessionId: 'lead', incarnationId: 'incarnation', expectedRevision: 7, sessionId: 'reader-cli',
    }
    teamsApi.updateMemberRuntime('team / one', 'reader@team / one', change)
    expect(api.patch).toHaveBeenCalledWith(
      '/api/teams/team%20%2F%20one/members/reader%40team%20%2F%20one/runtime',
      change,
    )
  })

  it('fetches the runtime control only for the requested lead and incarnation', () => {
    teamsApi.getRuntimeControl('team / one', { leadSessionId: 'lead / one', incarnationId: 'incarnation / one' })
    expect(api.get).toHaveBeenCalledWith('/api/teams/team%20%2F%20one/runtime-control?leadSessionId=lead+%2F+one&incarnationId=incarnation+%2F+one')
  })

  it('sends the explicit resume identity, revision and human request id', () => {
    const action = { leadSessionId: 'lead', incarnationId: 'incarnation', expectedRevision: 7, requestId: 'resume-once' }
    teamsApi.resumeRuntime('team / one', action)
    expect(api.post).toHaveBeenCalledWith('/api/teams/team%20%2F%20one/runtime-control/resume', action)
  })
})
