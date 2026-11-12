import { describe, expect, test } from 'bun:test'
import { ApiClient, ApiError, type FetchAdapter } from './client'
import {
  actOnTeamPlan,
  actionKey,
  editTeamPlan,
  loadTeamPlan,
  newerTeamPlan,
  sameTeamRuntime,
  suggestionDiffers,
  teamLaunchNotice,
  teamPlanErrorText,
  teamPlanReview,
  teamPlanSurface,
  teamRuntime,
  teamRuntimeConfig,
  teamRuntimeLabel,
  type TeamPlanRecord,
} from './teamPlan'

const plan = (patch: Partial<TeamPlanRecord> = {}): TeamPlanRecord => ({
  schemaVersion: 1,
  planId: 'plan-1',
  sessionId: 'session-1',
  teamName: 'Café board',
  incarnationId: 'inc-1',
  revision: 2,
  state: 'review_pending',
  workDir: '/fixture',
  leaderRuntime: { providerId: 'deepseek', modelId: 'deepseek-flash' },
  members: [
    { id: 'backend', name: 'backend-dev', agentType: 'general-purpose', prompt: 'API', runtime: { providerId: 'deepseek', modelId: 'deepseek-flash' }, suggestedRuntime: { providerId: 'deepseek', modelId: 'deepseek-flash' } },
    { id: 'frontend', name: 'frontend-dev', agentType: 'general-purpose', prompt: 'UI', runtime: { providerId: 'claude-official', modelId: 'claude-sonnet-5-5', effortLevel: 'high' } },
  ],
  tasks: [
    { id: 't1', subject: 'API', ownerId: 'backend', dependencies: [] },
    { id: 't2', subject: 'UI', ownerId: 'frontend', dependencies: ['t1'] },
  ],
  createdAt: 1,
  updatedAt: 2,
  ...patch,
})

function fakeClient(reply: (path: string, init: Parameters<FetchAdapter>[1]) => { status?: number; body: unknown }) {
  const calls: { path: string; method: string; body: unknown }[] = []
  const fetch: FetchAdapter = async (input, init) => {
    const url = new URL(input)
    calls.push({ path: url.pathname, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined })
    const { status = 200, body } = reply(url.pathname, init)
    return { ok: status < 300, status, url: '', redirected: false, text: async () => JSON.stringify(body) }
  }
  const client = new ApiClient({ id: 'h', name: 'H', url: 'https://fixture.invalid', auth: 'remote' }, 'token', { fetch })
  return { client, calls }
}

describe('team plan runtime mapping', () => {
  test('Claude official is null on the phone and claude-official in the plan, both ways', () => {
    const official = { providerId: 'claude-official', modelId: 'claude-sonnet-5-5', effortLevel: 'high' }
    expect(teamRuntimeConfig(official)).toEqual({ providerId: null, modelId: 'claude-sonnet-5-5', effortLevel: 'high' })
    expect(teamRuntime(teamRuntimeConfig(official))).toEqual(official)
    expect(teamRuntime({ providerId: 'deepseek', modelId: 'deepseek-flash' })).toEqual({ providerId: 'deepseek', modelId: 'deepseek-flash' })
    expect(teamRuntime({ providerId: 'openai-official', modelId: 'gpt', openAIFastMode: false }).openAIFastMode).toBe(false)
  })

  test('labels name the saved or official source and never guess an unknown one', () => {
    const providers = [{ id: 'deepseek', name: 'DeepSeek' }]
    expect(teamRuntimeLabel({ providerId: 'deepseek', modelId: 'deepseek-flash' }, providers)).toBe('DeepSeek · deepseek-flash')
    expect(teamRuntimeLabel({ providerId: 'claude-official', modelId: 'claude-sonnet-5-5' })).toBe('Claude Official · claude-sonnet-5-5')
    expect(teamRuntimeLabel({ providerId: 'openai-official', modelId: 'gpt-5.5' })).toBe('ChatGPT Official · gpt-5.5')
    expect(teamRuntimeLabel({ providerId: 'removed-provider', modelId: 'm' }, providers)).toBe('removed-provider · m')
  })

  test('effort is part of the runtime; a member differs from its suggestion only when it changed', () => {
    expect(sameTeamRuntime({ providerId: 'a', modelId: 'm' }, { providerId: 'a', modelId: 'm', effortLevel: 'high' })).toBe(false)
    expect(sameTeamRuntime({ providerId: 'a', modelId: 'm' }, { providerId: 'a', modelId: 'm' })).toBe(true)
    const [backend, frontend] = plan().members
    expect(suggestionDiffers(backend!)).toBe(false)
    expect(suggestionDiffers({ ...backend!, runtime: { providerId: 'deepseek', modelId: 'deepseek-pro' } })).toBe(true)
    // Without a suggestion there is nothing to restore.
    expect(suggestionDiffers(frontend!)).toBe(false)
  })
})

describe('what the phone offers for a plan', () => {
  test('only review, failed launch and interrupted plans need a person', () => {
    expect(teamPlanSurface(plan())).toBe('review')
    expect(teamPlanSurface(plan({ state: 'launch_failed' }))).toBe('failed')
    expect(teamPlanSurface(plan({ state: 'interrupted' }))).toBe('interrupted')
    for (const state of ['draft', 'launching', 'running', 'cancelled'] as const)
      expect(teamPlanSurface(plan({ state }))).toBeNull()
    expect(teamPlanSurface(null)).toBeNull()
  })

  test('approval waits until every task has an owner and every member a task', () => {
    expect(teamPlanReview(plan()).blocker).toBeUndefined()
    const orphan = teamPlanReview(plan({ tasks: [{ id: 't1', subject: 'API', ownerId: 'gone', dependencies: [] }, { id: 't2', subject: 'UI', ownerId: 'frontend', dependencies: [] }] }))
    expect(orphan.unassigned.map((task) => task.id)).toEqual(['t1'])
    expect(orphan.blocker).toBe('1 task still has no owner.')
    const idle = teamPlanReview(plan({ tasks: [{ id: 't1', subject: 'API', ownerId: 'frontend', dependencies: [] }] }))
    expect(idle.idle.map((member) => member.name)).toEqual(['backend-dev'])
    expect(idle.blocker).toContain('backend-dev has no task assigned')
  })

  test('a late read of an older revision never replaces the newer plan', () => {
    const current = plan({ revision: 5 })
    expect(newerTeamPlan(current, plan({ revision: 4 }))).toBe(current)
    const next = plan({ revision: 6 })
    expect(newerTeamPlan(current, next)).toBe(next)
    // When a different plan arrives (lead resubmits) the new one wins.
    const other = plan({ planId: 'plan-2', revision: 1 })
    expect(newerTeamPlan(current, other)).toBe(other)
    expect(newerTeamPlan(current, null)).toBeNull()
  })
})

describe('team plan requests', () => {
  test('reads by session and sends edits and actions with the plan identity and revision', async () => {
    const { client, calls } = fakeClient(() => ({ body: { plan: plan({ revision: 3 }) } }))
    expect((await loadTeamPlan(client, 'session 1'))?.revision).toBe(3)
    await editTeamPlan(client, plan(), { members: [{ id: 'backend', runtime: { providerId: 'deepseek', modelId: 'deepseek-pro' } }] })
    await actOnTeamPlan(client, plan(), 'approve', 'req-1')
    await actOnTeamPlan(client, plan(), 'return', 'req-2', 'Split out the tests too')
    const identity = { sessionId: 'session-1', planId: 'plan-1', incarnationId: 'inc-1', expectedRevision: 2 }
    expect(calls).toEqual([
      { path: '/api/teams/session/session%201/plan', method: 'GET', body: undefined },
      { path: '/api/teams/Caf%C3%A9%20board/plan', method: 'PATCH', body: { ...identity, members: [{ id: 'backend', runtime: { providerId: 'deepseek', modelId: 'deepseek-pro' } }] } },
      { path: '/api/teams/Caf%C3%A9%20board/plan/approve', method: 'POST', body: { ...identity, requestId: 'req-1' } },
      { path: '/api/teams/Caf%C3%A9%20board/plan/return', method: 'POST', body: { ...identity, requestId: 'req-2', feedback: 'Split out the tests too' } },
    ])
  })

  test('the retry key is stable for one action on one revision only', () => {
    expect(actionKey(plan(), 'approve')).toBe(actionKey(plan(), 'approve'))
    expect(actionKey(plan(), 'approve')).not.toBe(actionKey(plan({ revision: 3 }), 'approve'))
    expect(actionKey(plan(), 'approve')).not.toBe(actionKey(plan(), 'cancel'))
  })

  test('known server errors read in Chinese, others stay verbatim', async () => {
    const { client } = fakeClient(() => ({ status: 409, body: { error: 'TEAM_PLAN_CONFLICT', message: 'Plan changed; refresh before continuing' } }))
    const conflict = await actOnTeamPlan(client, plan(), 'approve', 'r').catch((error: unknown) => error)
    expect(teamPlanErrorText(conflict)).toBe('The plan was just updated elsewhere and has been reloaded; please confirm again.')
    expect(teamPlanErrorText(new ApiError('Plan not found', 404, 'TEAM_PLAN_CONFLICT'))).toContain('is no longer there')
    expect(teamPlanErrorText(new ApiError('Every member needs an assigned task', 400, 'TEAM_PLAN_CONFLICT'))).toBe('Every member must be assigned at least one task.')
    // Older desktop versions do not allow these endpoints.
    expect(teamPlanErrorText(new ApiError('Desktop-only capability', 403))).toContain('update the desktop app')
    expect(teamPlanErrorText(new Error('Team leader could not start: boom'))).toBe('Team leader could not start: boom')
  })
})

describe('Post-approval hint', () => {
  test('Awaiting your approval → launching / straight to running: say one line based on the approved member count', () => {
    const before = plan()
    expect(teamLaunchNotice(before, plan({ state: 'launching' }))).toBe('Approved, launching 2 members')
    expect(teamLaunchNotice(before, plan({ state: 'running' }))).toBe('Approved, launching 2 members')
    // Based on the members at the moment of approval.
    const approved = plan({
      state: 'launching',
      approvedSnapshot: {
        revision: 3,
        members: [before.members[0]!],
        tasks: before.tasks,
        leaderRuntime: before.leaderRuntime,
        approvedAt: 3,
        requestId: 'request-1',
      },
    })
    expect(teamLaunchNotice(before, approved)).toBe('Approved, launching 1 member')
    expect(teamLaunchNotice(before, plan({ state: 'launching', parentPlanId: 'plan-0' }))).toBe('Approved, adding 2 members')
  })
  test('Already running when the session opens, returned, canceled, plan changed, launching → running: no hint', () => {
    expect(teamLaunchNotice(null, plan({ state: 'running' }))).toBeNull()
    expect(teamLaunchNotice(plan(), plan({ state: 'draft' }))).toBeNull()
    expect(teamLaunchNotice(plan(), plan({ state: 'cancelled' }))).toBeNull()
    expect(teamLaunchNotice(plan(), plan({ planId: 'plan-2', state: 'launching' }))).toBeNull()
    expect(teamLaunchNotice(plan({ state: 'launching' }), plan({ state: 'running' }))).toBeNull()
    expect(teamLaunchNotice(plan(), null)).toBeNull()
  })
})
