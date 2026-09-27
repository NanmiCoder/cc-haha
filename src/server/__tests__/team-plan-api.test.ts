import { expect, test } from 'bun:test'
import { handleTeamsApi } from '../api/teams.js'

test('team plan HTTP rejects malformed JSON, schema violations and client-owned execution fields', async () => {
  for (const body of ['{', JSON.stringify({ sessionId: 's', planId: 'p', incarnationId: 'i', expectedRevision: 1, members: [{ id: 'm', agentSnapshot: { systemPrompt: 'replace' } }] }), JSON.stringify({ sessionId: 's', planId: 'p', incarnationId: 'i', expectedRevision: 1, tasks: [{ id: 't', description: 'overwrite' }] })]) {
    const req = new Request('http://localhost/api/teams/fixture/plan', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body })
    const response = await handleTeamsApi(req, new URL(req.url), ['api', 'teams', 'fixture', 'plan'])
    expect(response.status).toBe(400)
  }
  const req = new Request('http://localhost/api/teams/fixture/plan/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 's', planId: 'p', incarnationId: 'i', expectedRevision: 1 }) })
  expect((await handleTeamsApi(req, new URL(req.url), ['api', 'teams', 'fixture', 'plan', 'approve'])).status).toBe(400)
})

test('HTTP plan review edits only allocation, handles stale clients and resumes through trusted actions', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spyOn } = await import('bun:test')
  const { writeTeamFileAsync } = await import('../../utils/swarm/teamHelpers.js')
  const { ensureTeamDraft, submitTeamPlan, readTeamPlan } = await import('../../utils/swarm/teamPlanStore.js')
  const { teamPlanService, TeamPlanService } = await import('../services/teamPlanService.js')
  const oldHome = process.env.HOME, oldConfig = process.env.CLAUDE_CONFIG_DIR
  const root = await mkdtemp(join(tmpdir(), 'team-plan-http-'))
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = root
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const runtime = new TeamPlanService({ validate: async plan => plan, launch: async () => { await barrier; return { memberIds: { worker: 'session-child' } } }, stop: async () => {} })
  const spies = [
    spyOn(teamPlanService, 'getForSession').mockImplementation(id => runtime.getForSession(id)),
    spyOn(teamPlanService, 'approve').mockImplementation((name, action) => runtime.approve(name, action)),
    spyOn(teamPlanService, 'action').mockImplementation((name, kind, action) => runtime.action(name, kind, action)),
  ]
  const request = async (method: string, pathname: string, body?: unknown) => {
    const req = new Request(`http://localhost${pathname}`, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) })
    return handleTeamsApi(req, new URL(req.url), pathname.split('/').filter(Boolean))
  }
  const identity = (plan: { sessionId: string; planId: string; incarnationId: string; revision: number }) => ({ sessionId: plan.sessionId, planId: plan.planId, incarnationId: plan.incarnationId, expectedRevision: plan.revision })
  try {
    expect(await (await request('GET', '/api/teams/session/leader/plan')).json()).toEqual({ plan: null })
    await writeTeamFileAsync('review', { name: 'review', createdAt: 1, leadAgentId: 'lead', leadSessionId: 'leader', members: [] })
    const route = { providerId: 'fixture', modelId: 'suggested' }
    const draft = await ensureTeamDraft('review', 'leader', route, { agentCatalog: { general: { systemPrompt: 'fixture preset' } }, members: [{ id: 'worker', name: 'worker', agentType: 'general', prompt: 'Original scoped work', runtime: route }], tasks: [{ id: 't1', subject: 'fixture work', ownerId: 'worker', dependencies: [] }] })
    const plan = await submitTeamPlan('review', identity(draft))
    const savedResponse = await request('PATCH', '/api/teams/review/plan', { ...identity(plan), members: [{ id: 'worker', runtime: { providerId: 'fixture', modelId: 'economy' } }], tasks: [{ id: 't1', ownerId: 'worker' }] })
    expect(savedResponse.status).toBe(200)
    const { plan: saved } = await savedResponse.json()
    expect(saved.members[0].prompt).toBe('Original scoped work')
    expect(saved.members[0].runtime.modelId).toBe('economy')
    expect((await request('PATCH', '/api/teams/review/plan', { ...identity(plan), members: [] })).status).toBe(409)
    expect((await request('POST', '/api/teams/review/plan/unknown', { ...identity(saved), requestId: 'unknown' })).status).toBe(400)
    const returned = await request('POST', '/api/teams/review/plan/return', { ...identity(saved), requestId: 'return', feedback: 'Revise proposal' })
    expect(returned.status).toBe(200)
    const { plan: changed } = await returned.json()
    expect(changed.state).toBe('draft')
    const pending = await submitTeamPlan('review', identity(changed))
    const approveBody = { ...identity(pending), requestId: 'approve' }
    expect((await request('POST', '/api/teams/review/plan/approve', approveBody)).status).toBe(200)
    expect((await request('POST', '/api/teams/review/plan/approve', approveBody)).status).toBe(200)
    release()
    for (let i = 0; i < 100 && (await readTeamPlan('review'))?.state !== 'running'; i++) await Bun.sleep(5)
    const resumed = await request('GET', '/api/teams/session/leader/plan')
    expect((await resumed.json()).plan.state).toBe('running')
  } finally {
    release()
    spies.forEach(spy => spy.mockRestore())
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = oldConfig
    await rm(root, { recursive: true, force: true })
  }
})
