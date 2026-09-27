import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TeamPlanService } from './teamPlanService.js'
import { approveTeamPlan, ensureTeamDraft, readTeamPlan, replaceTeamPlan, stageMember, submitTeamPlan } from '../../utils/swarm/teamPlanStore.js'
import { writeTeamFileAsync } from '../../utils/swarm/teamHelpers.js'
import type { TeamPlanRecord } from '../../shared/teamPlan.js'
const saved = { home: process.env.HOME, config: process.env.CLAUDE_CONFIG_DIR }
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'team-plan-service-'))
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = root
  await writeTeamFileAsync('review', { name: 'review', createdAt: 1, leadAgentId: 'lead', leadSessionId: 'session', members: [] })
})
afterEach(async () => {
  if (saved.home === undefined) delete process.env.HOME
  else process.env.HOME = saved.home
  if (saved.config === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = saved.config
  await rm(root, { recursive: true, force: true })
})
const identity = (plan: TeamPlanRecord) => ({ planId: plan.planId, sessionId: plan.sessionId, incarnationId: plan.incarnationId, expectedRevision: plan.revision, requestId: 'request' })
async function ready() {
  const runtime = { providerId: 'fake', modelId: 'fixture' }
  await ensureTeamDraft('review', 'session', runtime)
  const plan = await stageMember('review', { id: 'worker', name: 'Worker', agentType: 'general-purpose', prompt: 'fixture', runtime })
  const complete = await replaceTeamPlan('review', identity(plan), { tasks: [{ id: 't1', subject: 'fixture task', ownerId: 'worker', dependencies: [] }] })
  return submitTeamPlan('review', identity(complete))
}
async function settle(state: string) {
  for (let i = 0; i < 100; i++) {
    const plan = await readTeamPlan('review')
    if (plan?.state === state) return plan
    await Bun.sleep(5)
  }
  throw new Error(`Plan did not reach ${state}`)
}
test('approval launches once and returns frozen selected runtime to executor', async () => {
  let calls = 0
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const service = new TeamPlanService({ validate: async plan => plan, launch: async plan => {
    calls++
    expect(plan.approvedSnapshot?.members[0]?.runtime.modelId).toBe('fixture')
    await barrier
    return { memberIds: { worker: 'child-1' } }
  }, stop: async () => {} })
  const plan = await ready()
  expect((await service.approve('review', identity(plan))).state).toBe('launching')
  await service.approve('review', identity(plan))
  expect(calls).toBe(1)
  release()
  expect((await settle('running')).launch?.memberIds).toEqual({ worker: 'child-1' })
})
test('validation failure starts no process; launch failure requires explicit review retry', async () => {
  let calls = 0
  const plan = await ready()
  const invalid = new TeamPlanService({ validate: async () => { throw new Error('missing model') }, launch: async () => { calls++; return { memberIds: {} } }, stop: async () => {} })
  await expect(invalid.approve('review', identity(plan))).rejects.toThrow('missing model')
  expect(calls).toBe(0)
  expect((await readTeamPlan('review'))?.state).toBe('review_pending')
  const service = new TeamPlanService({ validate: async item => item, launch: async () => { throw new Error('fixture launch failed') }, stop: async () => {} })
  await service.approve('review', identity(plan))
  const failed = await settle('launch_failed')
  expect(failed.launch?.error).toBe('fixture launch failed')
  expect((await service.action('review', 'retry', identity(failed))).state).toBe('review_pending')
})
test('cold server observes durable pending launch as interrupted instead of replaying', async () => {
  const plan = await ready()
  await approveTeamPlan('review', identity(plan), 'request', plan)
  const service = new TeamPlanService({ validate: async item => item, launch: async () => { throw new Error('must never launch') }, stop: async () => {} })
  expect((await service.getForSession('session'))?.state).toBe('interrupted')
})

test('UI update only edits allocation, freezes catalog preset and marks human route', async () => {
  const plan = await ready()
  const withCatalog = await replaceTeamPlan('review', identity(plan), { agentCatalog: { specialist: { systemPrompt: 'specialist system', tools: ['Read'] } } })
  const service = new TeamPlanService({ validate: async item => item, launch: async () => ({ memberIds: {} }), stop: async () => {} })
  const edited = await service.update('review', identity(withCatalog), { members: [{ id: 'worker', agentType: 'specialist', runtime: { providerId: 'cheap', modelId: 'economy' } }] })
  expect(edited.members[0]?.agentSnapshot?.systemPrompt).toBe('specialist system')
  expect(edited.members[0]?.prompt).toBe('fixture')
  expect(edited.members[0]?.runtimeSource).toBe('human')
  const { teamPlanPatchRequestSchema } = await import('./teamPlanService.js')
  expect(teamPlanPatchRequestSchema.safeParse({ ...identity(plan), requestId: undefined, members: [{ id: 'worker', prompt: 'injected' }] }).success).toBe(false)
  expect(teamPlanPatchRequestSchema.safeParse({ ...identity(plan), leaderRuntime: { providerId: 'other', modelId: 'other' } }).success).toBe(false)
})
test('return and cancel send trusted leader control exactly once per revision', async () => {
  const controls: string[] = []
  const service = new TeamPlanService({ validate: async item => item, launch: async () => ({ memberIds: {} }), stop: async () => {}, notifyLeader: async (_plan, kind) => { controls.push(kind) } })
  const plan = await ready()
  const returned = await service.action('review', 'return', { ...identity(plan), feedback: 'Use economy model' })
  expect(returned.feedback).toBe('Use economy model')
  await expect(service.action('review', 'return', identity(plan))).rejects.toThrow('changed')
  await service.action('review', 'cancel', identity(returned))
  expect(controls).toEqual(['returned', 'cancelled'])
})

test('partial execution failure and lost running process cannot replay approved work', async () => {
  const plan = await ready()
  const service = new TeamPlanService({ validate: async item => item, launch: async () => { throw Object.assign(new Error('release interrupted'), { executionStarted: true }) }, stop: async () => {} })
  await service.approve('review', identity(plan))
  const interrupted = await settle('interrupted')
  await expect(service.action('review', 'retry', identity(interrupted))).rejects.toThrow('Only failed launches')
  const { mutateTeamPlan } = await import('../../utils/swarm/teamPlanStore.js')
  await mutateTeamPlan('review', identity(interrupted), current => ({ ...current, state: 'running' }))
  const restarted = new TeamPlanService({ validate: async item => item, launch: async () => ({ memberIds: {} }), stop: async () => {}, isRunning: () => false })
  expect((await restarted.getForSession('session'))?.state).toBe('interrupted')
})

test('preset switches recalculate suggestion under same provider and preserve human selections', async () => {
  const plan = await ready()
  const withCatalog = await replaceTeamPlan('review', identity(plan), { agentCatalog: { specialist: { systemPrompt: 'specialist', model: 'fast-model', effortLevel: 'low' }, architect: { systemPrompt: 'architect', model: 'large-model', effortLevel: 'high' } } })
  const service = new TeamPlanService({ validate: async item => item, launch: async () => ({ memberIds: {} }), stop: async () => {} })
  const changed = await service.update('review', identity(withCatalog), { members: [{ id: 'worker', agentType: 'specialist' }] })
  expect(changed.members[0]?.runtime).toEqual({ providerId: 'fake', modelId: 'fast-model', effortLevel: 'low' })
  const human = await service.update('review', identity(changed), { members: [{ id: 'worker', runtime: { providerId: 'other', modelId: 'chosen' } }] })
  const switched = await service.update('review', identity(human), { members: [{ id: 'worker', agentType: 'architect' }] })
  expect(switched.members[0]?.runtime).toEqual({ providerId: 'other', modelId: 'chosen' })
  expect(switched.members[0]?.suggestedRuntime).toEqual({ providerId: 'other', modelId: 'large-model', effortLevel: 'high' })
})


test('launch transitions preserve future persisted launch metadata', async () => {
  const { mutateTeamPlan } = await import('../../utils/swarm/teamPlanStore.js')
  const plan = await ready()
  const enriched = await mutateTeamPlan('review', identity(plan), current => ({ ...current, launch: { status: 'pending', futureLaunch: { retained: true } } }))
  const service = new TeamPlanService({ validate: async item => item, launch: async () => ({ memberIds: { worker: 'fixture-child' } }), stop: async () => {} })
  await service.approve('review', identity(enriched))
  const running = await settle('running')
  expect(running.launch?.futureLaunch).toEqual({ retained: true })
  const cold = new TeamPlanService({ validate: async item => item, launch: async () => ({ memberIds: {} }), stop: async () => {}, isRunning: () => false })
  const interrupted = await cold.getForSession('session')
  expect(interrupted?.launch?.futureLaunch).toEqual({ retained: true })
  expect(interrupted?.state).toBe('interrupted')
})
