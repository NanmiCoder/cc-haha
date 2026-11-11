import { describe, expect, it, vi } from 'vitest'
import { api } from '@/api/client'
import { teamsApi } from './teams'

vi.mock('@/api/client', () => ({ api: { get: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn() } }))

describe('team member wire contract', () => {
  it("switches a member's model through its team, never a session route", () => {
    teamsApi.updateMemberRuntime('team / one', 'reader@team / one', { providerId: null, modelId: 'claude-sonnet-4-6', effortLevel: 'high' })
    expect(api.patch).toHaveBeenCalledWith(
      '/api/teams/team%20%2F%20one/members/reader%40team%20%2F%20one/runtime',
      { providerId: null, modelId: 'claude-sonnet-4-6', effortLevel: 'high' },
    )
  })
})
