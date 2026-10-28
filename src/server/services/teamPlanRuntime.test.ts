import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TeamPlanRecord } from '../../shared/teamPlan.js'
import { CLAUDE_OFFICIAL_PROVIDER_ID } from '../types/provider.js'
import { ProviderService } from './providerService.js'
import { startTeamWorkersBarrier, validateTeamPlanRuntime } from './teamPlanRuntime.js'

let home: string
let savedEnv: Record<string, string | undefined>
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'team-plan-runtime-'))
  savedEnv = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
  process.env.HOME = home
  process.env.CLAUDE_CONFIG_DIR = home
})
afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(home, { recursive: true, force: true })
})

function modelPlan(providerId: string, modelId: string): TeamPlanRecord {
  return {
    workDir: home,
    agentCatalog: { fixture: { systemPrompt: 'Fixture instructions', model: modelId, source: 'flagSettings', sourceIdentity: { kind: 'session' } } },
    members: [{ id: 'worker', name: 'worker', agentType: 'fixture', prompt: 'Work', runtime: { providerId, modelId } }],
  } as TeamPlanRecord
}

test('runtime rejects a legacy review with a teammate name that cannot launch', async () => {
  const plan = { workDir: process.cwd(), members: [{ id: 'reader', name: 'README Reader' }] } as never
  await expect(validateTeamPlanRuntime(plan)).rejects.toThrow('Invalid teammate name: README Reader')
})

describe('team preset model resolution', () => {
  test.each([
    ['claude-opus-4-6', 'member-opus'],
    ['claude-opus-4-6[1m]', 'member-opus'],
    ['claude-3-opus-20240229', 'member-opus'],
    ['claude-3-5-sonnet-20241022', 'member-sonnet'],
    ['claude-fable-5-1', 'member-opus'],
  ])('maps saved %s through the approved member provider', async (requestedModel, expectedModel) => {
    const provider = await new ProviderService().addProvider({
      presetId: 'custom', name: 'Member provider', baseUrl: 'http://127.0.0.1:1', apiKey: 'fake-member-key',
      models: { main: 'member-main', sonnet: 'member-sonnet', opus: 'member-opus', haiku: 'member-haiku' },
    })
    const validated = await validateTeamPlanRuntime(modelPlan(provider.id, requestedModel))
    expect(validated.members[0]?.runtime).toEqual({ providerId: provider.id, modelId: expectedModel })
    expect(validated.members[0]?.agentSnapshot?.model).toBe(requestedModel)
  })

  test('retains an explicit Claude version for the official provider', async () => {
    const validated = await validateTeamPlanRuntime(modelPlan(CLAUDE_OFFICIAL_PROVIDER_ID, 'claude-opus-4-6'))
    expect(validated.members[0]?.runtime).toEqual({ providerId: CLAUDE_OFFICIAL_PROVIDER_ID, modelId: 'claude-opus-4-6' })
  })

  test('retains version pins when a configured provider maps the family to Claude', async () => {
    const provider = await new ProviderService().addProvider({
      presetId: 'custom', name: 'Claude provider', baseUrl: 'http://127.0.0.1:1', apiKey: 'fake-claude-key',
      models: { main: 'claude-sonnet-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', haiku: 'claude-haiku-5-5' },
    })
    const validated = await validateTeamPlanRuntime(modelPlan(provider.id, 'claude-opus-4-6'))
    expect(validated.members[0]?.runtime).toEqual({ providerId: provider.id, modelId: 'claude-opus-4-6' })
  })
})

describe('team worker ready barrier', () => {
  test('never releases a task before all isolated runtimes are ready', async () => {
    const events: string[] = []
    const ids = await startTeamWorkersBarrier(['cheap', 'capable'], async member => {
      events.push(`prepare:${member}`)
      return member
    }, async member => { events.push(`release:${member}`) }, async id => { events.push(`stop:${id}`) })
    expect(ids).toEqual(['cheap', 'capable'])
    expect(events).toEqual(['prepare:cheap', 'prepare:capable', 'release:cheap', 'release:capable'])
  })
  test('failed preparation rolls back ready workers without sending a task', async () => {
    const released: string[] = []
    const stopped: string[] = []
    await expect(startTeamWorkersBarrier(['a', 'b'], async member => {
      if (member === 'b') throw new Error('provider unavailable')
      return member
    }, async member => { released.push(member) }, async id => { stopped.push(id) })).rejects.toThrow('provider unavailable')
    expect(released).toEqual([])
    expect(stopped).toEqual(['a'])
  })
  test('release failure stops workers and never automatically retries', async () => {
    const released: string[] = []
    const stopped: string[] = []
    await expect(startTeamWorkersBarrier(['a', 'b'], async member => member, async member => {
      released.push(member)
      if (member === 'b') throw new Error('lost SDK connection')
    }, async id => { stopped.push(id) })).rejects.toThrow('lost SDK connection')
    expect(released).toEqual(['a', 'b'])
    expect(stopped).toEqual(['a', 'b'])
  })
})

describe('ending a team at the user\'s request', () => {
  const runtime = { providerId: 'fake', modelId: 'fixture' }
  async function team(members: Array<{ agentId: string; name: string }>) {
    const { writeTeamFileAsync } = await import('../../utils/swarm/teamHelpers.js')
    const { ensureTeamDraft } = await import('../../utils/swarm/teamPlanStore.js')
    const tasks = await import('../../utils/tasks.js')
    await writeTeamFileAsync('review', { name: 'review', createdAt: 1, leadAgentId: 'team-lead@review', leadSessionId: 'session', members: [
      { agentId: 'team-lead@review', name: 'team-lead', joinedAt: 1, tmuxPaneId: '', cwd: home, subscriptions: [] },
      ...members.map(member => ({ ...member, joinedAt: 1, tmuxPaneId: '', cwd: home, subscriptions: [], backendType: 'process' as const })),
    ] })
    const listId = tasks.getCanonicalTeamTaskListId('review')
    await tasks.withTaskListLifecycleLock(listId, () => tasks.beginTaskListLifecycle(listId, { teamName: 'review', createdAt: 1, leadSessionId: 'session' }))
    await tasks.createTask(listId, { subject: 'materialized by the launch', description: '', status: 'pending', owner: 'worker', blocks: [], blockedBy: [] })
    return ensureTeamDraft('review', 'session', runtime)
  }

  test('a team no member joined is removed with its tasks, and the running lead lets go of it', async () => {
    const { conversationService } = await import('./conversationService.js')
    const { readTeamFile } = await import('../../utils/swarm/teamHelpers.js')
    const { readTeamPlan } = await import('../../utils/swarm/teamPlanStore.js')
    const { listTasks, getCanonicalTeamTaskListId } = await import('../../utils/tasks.js')
    const { endTeamOfPlan } = await import('./teamPlanRuntime.js')
    const controls: unknown[] = []
    const hasSession = spyOn(conversationService, 'hasSession').mockImplementation(id => id === 'session')
    const control = spyOn(conversationService, 'requestControl').mockImplementation(async (_id, request) => { controls.push(request); return {} })
    try {
      const plan = await team([])
      expect(await endTeamOfPlan(plan, { unlessStarted: true })).toBe(true)
      expect(readTeamFile('review')).toBeNull()
      expect(await readTeamPlan('review')).toBeNull()
      expect(await listTasks(getCanonicalTeamTaskListId('review'))).toEqual([])
      expect(controls).toEqual([{ subtype: 'team_runtime_ended', team_name: 'review' }])
    } finally {
      hasSession.mockRestore()
      control.mockRestore()
    }
  })

  test('a team a member already joined is only ended when asked to end it whole', async () => {
    const { readTeamFile } = await import('../../utils/swarm/teamHelpers.js')
    const { endTeamOfPlan } = await import('./teamPlanRuntime.js')
    const plan = await team([{ agentId: 'worker@review', name: 'worker' }])
    expect(await endTeamOfPlan(plan, { unlessStarted: true })).toBe(false)
    expect(readTeamFile('review')?.members.map(member => member.name)).toEqual(['team-lead', 'worker'])
    expect(await endTeamOfPlan(plan)).toBe(true)
    expect(readTeamFile('review')).toBeNull()
  })

  test('a launch cut off before any member joined takes back its tasks; one a member joined is left as it is', async () => {
    const { mutateTeamFileAsync } = await import('../../utils/swarm/teamHelpers.js')
    const { reclaimUnstartedLaunch } = await import('./teamPlanRuntime.js')
    const tasks = await import('../../utils/tasks.js')
    const listId = tasks.getCanonicalTeamTaskListId('review')
    const draft = await team([])
    const plan = { ...draft, approvedSnapshot: { revision: 1, members: [{ id: 'w', name: 'worker' }], tasks: [], leaderRuntime: runtime, approvedAt: 1, requestId: 'r' } } as unknown as TeamPlanRecord
    const own = (subject: string) => tasks.createTask(listId, { subject, description: '', status: 'pending', owner: 'worker', blocks: [], blockedBy: [], metadata: { teamPlanId: plan.planId, teamPlanTaskId: subject } })
    const subjects = async () => (await tasks.listTasks(listId)).map(task => task.subject).sort()

    // The app stopped after the tasks were written and before the roster was.
    await own('read')
    expect(await reclaimUnstartedLaunch(plan)).toBe(true)
    // Only this plan's tasks go; the one the helper made for another plan stays.
    expect(await subjects()).toEqual(['materialized by the launch'])

    // A task already under way, or a member on the roster, means work may have started.
    const started = await own('write')
    await tasks.updateTask(listId, started, { status: 'in_progress' })
    expect(await reclaimUnstartedLaunch(plan)).toBe(false)
    await tasks.updateTask(listId, started, { status: 'pending' })
    await mutateTeamFileAsync('review', current => ({ ...current, members: [...current.members, { agentId: 'worker@review', name: 'worker', joinedAt: 1, tmuxPaneId: '', cwd: home, subscriptions: [] }] }))
    expect(await reclaimUnstartedLaunch(plan)).toBe(false)
    expect(await subjects()).toEqual(['materialized by the launch', 'write'])
  })

  test('the lead hears once, with the reason, that its team did not start', async () => {
    const { conversationService } = await import('./conversationService.js')
    const { mutateTeamPlan } = await import('../../utils/swarm/teamPlanStore.js')
    const { noteLeadUserMessage } = await import('./teamPlanRuntime.js')
    const sent: string[] = []
    const send = spyOn(conversationService, 'sendMessage').mockImplementation(async (_id, text) => { sent.push(String(text)); return true })
    try {
      const plan = await team([])
      await noteLeadUserMessage('session')
      expect(sent).toEqual([])
      await mutateTeamPlan('review', { ...plan, expectedRevision: plan.revision }, current => ({ ...current, state: 'launch_failed', launch: { status: 'failed', error: 'CLI session exited before the control request completed' } }))
      await noteLeadUserMessage('session')
      await noteLeadUserMessage('session')
      expect(sent).toHaveLength(1)
      expect(sent[0]).toContain('Your team review did not start, so none of its members is running')
      expect(sent[0]).toContain('\nWhat failed: CLI session exited before the control request completed')
      // Members proposed for a team already at work fail without stopping it.
      // A crashed process's output can be long; the lead gets the start of it.
      const failed = (await import('../../utils/swarm/teamPlanStore.js')).readTeamPlan
      const current = (await failed('review'))!
      const output = `worker did not start: CLI process exited unexpectedly (code 1): stderr:\n${'at frame\n'.repeat(400)}`
      await mutateTeamPlan('review', { ...current, expectedRevision: current.revision }, item => ({ ...item, parentPlanId: 'running-plan', launch: { status: 'failed', error: output } }))
      await noteLeadUserMessage('session')
      expect(sent).toHaveLength(2)
      expect(sent[1]).toContain('The members you proposed to add to your team review did not start')
      expect(sent[1]).toContain('Members already running are not affected')
      expect(sent[1]).toContain('What failed: worker did not start: CLI process exited unexpectedly (code 1)')
      expect(sent[1].length).toBeLessThan(output.length)
      expect(sent[1].endsWith('…')).toBe(true)
    } finally {
      send.mockRestore()
    }
  })
})
