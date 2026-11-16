import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TeamPlanRecord } from '../../shared/teamPlan.js'
import type { TeamMemberRuntimeIdentity, TeamRuntimeControlAction } from '../../shared/teamRuntimeControl.js'
import { resetTerminalShellEnvironmentCacheForTests } from '../../utils/terminalShellEnvironment.js'

let home: string
let originalEnv: NodeJS.ProcessEnv
beforeEach(async () => {
  originalEnv = { ...process.env }
  home = await mkdtemp(join(tmpdir(), 'team-supervisor-'))
  process.env.HOME = home
  process.env.CLAUDE_CONFIG_DIR = home
  process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = '1'
  // The lead fixture's own model call lands mid-test, as it does on a loaded CI
  // runner. Assertions about members must not depend on when the lead speaks.
  process.env.FIXTURE_LEAD_MODEL_DELAY_MS = '300'
  process.env.CLAUDE_CLI_PATH = join(import.meta.dir, '__fixtures__', 'team-worker-cli.ts')
  process.env.FIXTURE_TEAM_RUNTIME_CONTROL_EVENTS = join(home, 'fixture-runtime-controls.jsonl')
  resetTerminalShellEnvironmentCacheForTests()
})
afterEach(async () => {
  const runtime = await import('./teamPlanRuntime.js')
  runtime.setTeamRuntimeTimingForTests(null)
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  resetTerminalShellEnvironmentCacheForTests()
  await rm(home, { recursive: true, force: true })
})

test('worker failures are classified as transient only for provider and transport hiccups', async () => {
  const { isTransientWorkerFailure } = await import('./teamPlanRuntime.js')
  for (const text of [
    'API Error: {"type":"error","error":{"type":"stream_truncated","message":"OpenAI Chat upstream stream ended without finish_reason"}}',
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
    'API Error: 502 Bad Gateway',
    'Request timed out',
    'API Error: Connection error.',
    'Repeated 529 Overloaded errors',
    'API Error: 429 Too Many Requests',
  ]) expect(isTransientWorkerFailure(text)).toBe(true)
  for (const text of [
    '',
    'Prompt is too long',
    'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
    'Credit balance is too low',
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"bad tool"}}',
    'Reached maximum turns',
    'Done: everything reviewed.',
  ]) expect(isTransientWorkerFailure(text)).toBe(false)
})

type Harness = Awaited<ReturnType<typeof startHarness>>

/**
 * A real ConversationService with fixture worker CLIs over a loopback SDK
 * bridge. `respond` decides how each upstream "model" call ends.
 */
async function startHarness(memberNames: string[], options: {
  tasks?: Array<{ id: string; subject: string; ownerId: string; dependencies: string[] }>
  /** Members expected to get their instructions at launch (default: all). */
  instructedAtLaunch?: string[]
  /** Hold the initial member reply while an independently delayed lead speaks. */
  initialMemberReply?: Promise<void>
  /** Real approved additions keep older members in an archived running plan. */
  planGroups?: string[][]
} = {}) {
  const { conversationService: service } = await import('./conversationService.js')
  const { ProviderService } = await import('./providerService.js')
  const { launchTeamPlanRuntime, teamRuntimeOwnerId } = await import('./teamPlanRuntime.js')
  const { ensureTeamRuntimeControl } = await import('../../utils/swarm/teamRuntimeControlStore.js')
  const { writeTeamFileAsync, getTeamDir } = await import('../../utils/swarm/teamHelpers.js')
  const { beginTaskListLifecycle, withTaskListLifecycleLock, getCanonicalTeamTaskListId } = await import('../../utils/tasks.js')
  // Only members' model calls are recorded and answered from `replies`. The lead
  // fixture calls the same upstream (launch tells it the team is running) at a
  // time of its own choosing; counted together, its late request became the
  // "last" request or took a reply scripted for a member.
  const requests: Array<{ agent: string; resumed: string | null; prompt: string; model?: string }> = []
  const leadRequests: Array<{ prompt: string }> = []
  const replies: string[] = []
  let held: Promise<void> | undefined
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as { agent?: string | null; resumed?: string | null; prompt?: unknown; model?: string }
    if (!body.agent || !memberNames.includes(body.agent)) {
      leadRequests.push({ prompt: JSON.stringify(body.prompt ?? '') })
      return new Response('fixture result')
    }
    const initialMemberRequest = !requests.some(item => item.agent === body.agent)
    requests.push({ agent: body.agent, resumed: body.resumed ?? null, prompt: JSON.stringify(body.prompt ?? ''), model: body.model })
    if (initialMemberRequest) await options.initialMemberReply
    await held
    return new Response(replies.shift() ?? 'fixture result')
  } })
  const bridge = Bun.serve<{ id: string }>({ hostname: '127.0.0.1', port: 0,
    fetch(request, server) {
      const url = new URL(request.url)
      const id = url.pathname.split('/').pop()!
      if (!service.authorizeSdkConnection(id, url.searchParams.get('token'))) return new Response('denied', { status: 401 })
      return server.upgrade(request, { data: { id } }) ? undefined : new Response('bad', { status: 400 })
    },
    websocket: { open(ws) { service.attachSdkConnection(ws.data.id, ws) }, message(ws, msg) { service.handleSdkPayload(ws.data.id, String(msg)) }, close(ws) { service.detachSdkConnection(ws.data.id, ws) } },
  })
  const oldPort = ProviderService.getServerPort()
  ProviderService.setServerPort(bridge.port!)
  const provider = await new ProviderService().addProvider({ presetId: 'custom', name: 'local', baseUrl: upstream.url.toString(), apiKey: 'fake', models: { main: 'cheap', sonnet: 'cheap', opus: 'capable', haiku: 'cheap' } })
  const parentId = `parent-${crypto.randomUUID()}`
  const teamName = `team-${crypto.randomUUID().slice(0, 8)}`
  const createdAt = Date.now()
  await writeTeamFileAsync(teamName, { name: teamName, createdAt, leadAgentId: `team-lead@${teamName}`, leadSessionId: parentId, members: [] } as any)
  const taskListId = getCanonicalTeamTaskListId(teamName)
  await withTaskListLifecycleLock(taskListId, () => beginTaskListLifecycle(taskListId, { teamName, createdAt, leadSessionId: parentId }))
  // The lead is a fixture process too; it only needs to answer control requests.
  await service.startSession(parentId, home, `ws://127.0.0.1:${bridge.port}/sdk/${parentId}?token=parent`, { providerId: provider.id, model: 'cheap', teamWorker: { parentSessionId: 'external', teamName: 'lead-fixture', memberId: 'lead', name: 'leader', systemPrompt: 'lead fixture' } })
  const members = memberNames.map(name => ({ id: name, name, agentType: 'research', prompt: `Work as ${name}`, runtime: { providerId: provider.id, modelId: 'cheap' }, agentSnapshot: { systemPrompt: 'Read only', tools: ['Read'] } }))
  const tasks = options.tasks ?? memberNames.map(name => ({ id: `task-${name}`, subject: `Task for ${name}`, ownerId: name, dependencies: [] }))
  const incarnationId = createHash('sha256').update(JSON.stringify([teamName, parentId, createdAt])).digest('hex')
  const planGroups = options.planGroups ?? [memberNames]
  if (JSON.stringify(planGroups.flat().sort()) !== JSON.stringify([...memberNames].sort())) throw new Error('Fixture plan groups must include every member exactly once')
  const memberIds: Record<string, string> = {}
  const plans: TeamPlanRecord[] = []
  for (const names of planGroups) {
    const previous = plans.at(-1)
    if (previous) await writeFile(join(getTeamDir(teamName), `plan-${previous.planId}.json`), JSON.stringify(previous))
    const selectedMembers = members.filter(member => names.includes(member.name))
    const selectedTasks = tasks.filter(task => names.includes(task.ownerId))
    const plan: TeamPlanRecord = { schemaVersion: 1, planId: crypto.randomUUID(), sessionId: parentId, teamName, incarnationId, revision: 2, state: 'launching', workDir: home, members: selectedMembers, tasks: selectedTasks, leaderRuntime: members[0]!.runtime, createdAt, updatedAt: createdAt, ...(previous ? { parentPlanId: previous.planId } : {}), approvedSnapshot: { revision: 1, members: selectedMembers, tasks: selectedTasks, leaderRuntime: members[0]!.runtime, approvedAt: Date.now(), requestId: `approve-${plans.length}` } }
    await writeFile(join(getTeamDir(teamName), 'plan.json'), JSON.stringify(plan))
    const launched = await launchTeamPlanRuntime(plan)
    Object.assign(memberIds, launched.memberIds)
    const running: TeamPlanRecord = { ...plan, state: 'running', revision: 3, launch: { status: 'running', memberIds: launched.memberIds } }
    // Persist the same approval/launch boundary that TeamPlanService writes.
    await writeFile(join(getTeamDir(teamName), 'plan.json'), JSON.stringify(running))
    plans.push(running)
  }
  await ensureTeamRuntimeControl(teamName, { leadSessionId: parentId, incarnationId }, teamRuntimeOwnerId, { approvedLaunch: true })
  const planId = plans[0]!.planId
  const waitFor = async (condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 8000) => {
    const end = Date.now() + timeoutMs
    while (!(await condition()) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20))
    if (!(await condition())) throw new Error(`Timed out waiting for ${label}`)
  }
  const instructed = options.instructedAtLaunch ?? memberNames
  await waitFor(() => instructed.every(name => requests.some(request => request.prompt.includes(`Work as ${name}`))), 'initial member turns')
  return {
    service, teamName, parentId, planId, plans, incarnationId, createdAt, memberIds, requests, leadRequests, replies, waitFor, providerId: provider.id, upstreamUrl: upstream.url.toString(),
    async startLeader(sessionId: string) {
      if (sessionId !== parentId) throw new Error('Fixture refuses a foreign leader')
      if (service.hasSession(parentId)) return
      await service.startSession(parentId, home, `ws://127.0.0.1:${bridge.port}/sdk/${parentId}?token=resumed-parent`, { providerId: provider.id, model: 'cheap', teamWorker: { parentSessionId: 'external', teamName: 'lead-fixture', memberId: 'lead', name: 'leader', systemPrompt: 'lead fixture' } })
    },
    async runtimeEvents(): Promise<Array<{ type: string; pid: number; sessionId: string; agent: string; model?: string; resumed?: string | null; request?: Record<string, unknown>; acknowledgement?: Record<string, unknown>; error?: string }>> {
      try {
        return (await readFile(join(home, 'fixture-runtime-controls.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
    },
    memberRequests(name: string) {
      return requests.filter(request => request.agent === name)
    },
    /** Keeps model replies (and so member turns) pending until released. */
    holdReplies() {
      let release!: () => void
      held = new Promise(resolve => { release = resolve })
      return () => { held = undefined; release() }
    },
    async teamMember(name: string) {
      const { readTeamFile } = await import('../../utils/swarm/teamHelpers.js')
      return readTeamFile(teamName)?.members.find(member => member.name === name)
    },
    async leadNotifications() {
      const { readMailbox } = await import('../../utils/teammateMailbox.js')
      return (await readMailbox('team-lead', teamName)).map(message => {
        try { return { from: message.from, ...JSON.parse(message.text) } } catch { return { from: message.from, text: message.text } }
      })
    },
    async cleanup() {
      const runtime = await import('./teamPlanRuntime.js')
      for (const plan of plans) await runtime.stopTeamPlanRuntime(plan.planId)
      await service.stopAllSessionsAndWait(1000)
      ProviderService.setServerPort(oldPort)
      bridge.stop(true)
      upstream.stop(true)
    },
  }
}

/**
 * The user sends the lead a message. The lead here is a fixture whose turns
 * would call the fake model too, so what the runtime tells it is recorded
 * instead of delivered.
 */
async function userMessagesLead(h: Harness, toLead: string[] = []) {
  const { noteLeadUserMessage } = await import('./teamPlanRuntime.js')
  const send = h.service.sendMessage.bind(h.service)
  const spy = spyOn(h.service, 'sendMessage').mockImplementation(async (...args: Parameters<typeof send>) => {
    if (args[0] !== h.parentId) return send(...args)
    toLead.push(String(args[1]))
    return true
  })
  try {
    await noteLeadUserMessage(h.parentId)
  } finally {
    spy.mockRestore()
  }
  return toLead
}

async function messageMember(h: Harness, to: string, from: string, text: string) {
  const { writeToMailbox } = await import('../../utils/teammateMailbox.js')
  await writeToMailbox(to, { from, text, timestamp: new Date().toISOString() }, h.teamName)
}

async function runtimeControl(h: Harness) {
  const { getTeamRuntimeControlView } = await import('./teamRuntimeControlService.js')
  const view = await getTeamRuntimeControlView(h.teamName, { leadSessionId: h.parentId, incarnationId: h.incarnationId })
  if (!view) throw new Error('Reviewed fixture team must have a runtime control view')
  return view
}

async function memberRuntimeIdentity(h: Harness, name: string): Promise<TeamMemberRuntimeIdentity> {
  const view = await runtimeControl(h)
  return { leadSessionId: h.parentId, incarnationId: h.incarnationId, expectedRevision: view.revision, sessionId: h.memberIds[name]! }
}

async function saveMemberRuntime(h: Harness, name: string, change: { providerId: string | null; modelId: string; effortLevel?: string }, identity?: TeamMemberRuntimeIdentity) {
  const { changeTeamMemberRuntime } = await import('./teamPlanRuntime.js')
  return changeTeamMemberRuntime(h.teamName, `${name}@${h.teamName}`, change, identity ?? await memberRuntimeIdentity(h, name))
}

async function reviewedPlan(h: Harness, planId?: string): Promise<TeamPlanRecord> {
  const { getTeamDir } = await import('../../utils/swarm/teamHelpers.js')
  return JSON.parse(await readFile(join(getTeamDir(h.teamName), planId ? `plan-${planId}.json` : 'plan.json'), 'utf8'))
}

async function waitForInitialReports(h: Harness, names = Object.keys(h.memberIds)) {
  await h.waitFor(async () => {
    const reports = await h.leadNotifications()
    return names.every(name => reports.some(report => report.from === name && report.type === 'idle_notification'))
  }, 'initial worker transcripts and result reports')
  await h.waitFor(() => h.leadRequests.length >= h.plans.length, 'all delayed initial lead model requests')
  try {
    await h.waitFor(async () => (await Promise.all(names.map(name => h.teamMember(name)))).every(member => member?.isActive === false), 'initial members idle')
  } catch (error) {
    const { readTeamFile } = await import('../../utils/swarm/teamHelpers.js')
    const { getTeamRuntimeLaunches } = await import('./teamPlanRuntime.js')
    console.error('[Team supervisor fixture] Initial idle timeout', JSON.stringify({
      teamName: h.teamName,
      expectedNames: names,
      roster: readTeamFile(h.teamName)?.members,
      launches: getTeamRuntimeLaunches(h.parentId, h.teamName).map(owner => ({
        planId: owner.plan.planId, running: owner.running, stopped: owner.stopped, controlSequence: owner.controlSequence,
        workers: [...owner.workers.values()].map(worker => ({
          name: worker.member.name, sessionId: worker.sessionId, released: worker.released, starting: Boolean(worker.starting),
          processGeneration: worker.processGeneration, lastResultAt: worker.lastResultAt,
          processPresent: h.service.hasSession(worker.sessionId),
        })),
      })),
      requests: h.requests,
      notifications: await h.leadNotifications(),
      runtimeEvents: await h.runtimeEvents(),
    }))
    throw error
  }
}

async function pauseReviewedTeam(h: Harness) {
  h.service.sendInterrupt(h.parentId)
  await h.service.waitForTeamWorkersStopped(h.parentId)
  const view = await runtimeControl(h)
  expect(view.status).toBe('paused')
  for (const sessionId of Object.values(h.memberIds)) expect(h.service.hasSession(sessionId)).toBe(false)
  return view
}

async function resumeAction(h: Harness, requestId = crypto.randomUUID()): Promise<TeamRuntimeControlAction> {
  const view = await runtimeControl(h)
  return { leadSessionId: h.parentId, incarnationId: h.incarnationId, expectedRevision: view.revision, requestId }
}

async function resumeReviewedTeam(h: Harness, action?: TeamRuntimeControlAction) {
  const control = await import('./teamRuntimeControlService.js')
  return control.resumeReviewedTeam(h.teamName, action ?? await resumeAction(h), h.startLeader)
}

test('a member whose process died restarts from its own transcript when the lead messages it', async () => {
  const h = await startHarness(['reader'])
  try {
    const sessionId = h.memberIds.reader!
    h.replies.push('FIXTURE_CRASH')
    await messageMember(h, 'reader', 'team-lead', 'Check one more file')
    await h.waitFor(async () => (await h.teamMember('reader'))?.terminated === true, 'crash to be recorded')
    expect(h.service.hasSession(sessionId)).toBe(false)
    // The runtime records `terminated` before it notifies the lead, so wait for the
    // notice itself rather than reading the mailbox the moment the flag flips.
    const crashNotice = async () => (await h.leadNotifications()).find(item => item.type === 'idle_notification' && item.idleReason === 'failed')
    await h.waitFor(async () => (await crashNotice()) !== undefined, 'crash notice to reach the lead')
    expect((await crashNotice())?.failureReason).toContain('restarts it from its saved conversation')

    const before = h.requests.length
    await messageMember(h, 'reader', 'team-lead', 'Please continue')
    await h.waitFor(() => h.requests.length > before, 'restarted member turn')
    expect(h.requests.at(-1)?.resumed).toBe(sessionId)
    expect(h.requests.at(-1)?.prompt).toContain('Please continue')
    await h.waitFor(async () => (await h.teamMember('reader'))?.terminated === false, 'restart to be recorded')
    expect(h.service.hasSession(sessionId)).toBe(true)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('transient turn failures are continued automatically and only exhausted retries reach the lead', async () => {
  const { setTeamRuntimeTimingForTests } = await import('./teamPlanRuntime.js')
  setTeamRuntimeTimingForTests({ autoContinueDelaysMs: [40, 40] })
  const h = await startHarness(['reader'])
  try {
    const truncated = 'FIXTURE_ERROR:API Error: {"type":"error","error":{"type":"stream_truncated","message":"OpenAI Chat upstream stream ended without finish_reason"}}'
    h.replies.push(truncated, truncated, truncated)
    const before = h.requests.length
    await messageMember(h, 'reader', 'team-lead', 'Review the runner')
    await h.waitFor(() => h.requests.length >= before + 3, 'two automatic continuations')
    const continuations = h.requests.slice(before + 1).filter(request => request.prompt.includes('[Team runtime notice]'))
    expect(continuations).toHaveLength(2)
    await h.waitFor(async () => (await h.leadNotifications()).some(item => item.idleReason === 'failed'), 'exhaustion notice')
    const failures = (await h.leadNotifications()).filter(item => item.idleReason === 'failed')
    expect(failures).toHaveLength(1)
    expect(failures[0].failureReason).toContain('automatic retries exhausted')
    // The member stayed alive throughout: a message still reaches it directly.
    expect(h.service.hasSession(h.memberIds.reader!)).toBe(true)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a successful turn reports its result to the lead and resets the retry budget', async () => {
  const { setTeamRuntimeTimingForTests } = await import('./teamPlanRuntime.js')
  setTeamRuntimeTimingForTests({ autoContinueDelaysMs: [40] })
  const h = await startHarness(['reader'])
  try {
    h.replies.push('FIXTURE_ERROR:API Error: 502 Bad Gateway', 'Found 3 issues in runner.ts')
    const before = h.requests.length
    await messageMember(h, 'reader', 'team-lead', 'Review the runner')
    await h.waitFor(async () => (await h.leadNotifications()).some(item => item.result === 'Found 3 issues in runner.ts'), 'result notification')
    expect(h.requests.length).toBe(before + 2)
    expect((await h.leadNotifications()).filter(item => item.idleReason === 'failed')).toHaveLength(0)
    const entry = await h.teamMember('reader') as any
    expect(entry.lastError).toBeUndefined()
    expect(entry.autoRetry).toBeUndefined()
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a message to a failed member clears its failure as soon as the member starts on it', async () => {
  const h = await startHarness(['reader'])
  try {
    h.replies.push('FIXTURE_ERROR:API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}')
    await messageMember(h, 'reader', 'team-lead', 'Review the runner')
    await h.waitFor(async () => (await h.teamMember('reader') as any)?.lastError !== undefined, 'failure to be recorded')
    const release = h.holdReplies()
    try {
      await messageMember(h, 'reader', 'user', 'The key is fixed, please retry')
      await h.waitFor(async () => (await h.teamMember('reader'))?.isActive === true, 'recovery turn to start')
      const entry = await h.teamMember('reader') as any
      expect(entry.lastError).toBeUndefined()
      expect(entry.autoRetry).toBeUndefined()
    } finally {
      release()
    }
    await h.waitFor(async () => (await h.teamMember('reader'))?.isActive === false, 'recovery turn to finish')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('an automatic continuation that cannot be sent reports the failure instead of a stale countdown', async () => {
  const { setTeamRuntimeTimingForTests } = await import('./teamPlanRuntime.js')
  setTeamRuntimeTimingForTests({ autoContinueDelaysMs: [40, 40] })
  const h = await startHarness(['reader'])
  try {
    h.replies.push('FIXTURE_ERROR:API Error: {"type":"error","error":{"type":"stream_truncated","message":"upstream stream ended without finish_reason"}}')
    const send = h.service.sendMessage.bind(h.service)
    const spy = spyOn(h.service, 'sendMessage').mockImplementation(async (...args: Parameters<typeof send>) =>
      String(args[1]).includes('[Team runtime notice]') ? false : send(...args))
    try {
      await messageMember(h, 'reader', 'team-lead', 'Review the runner')
      await h.waitFor(async () => (await h.leadNotifications()).some(item => item.idleReason === 'failed'), 'failure notice')
    } finally {
      spy.mockRestore()
    }
    const entry = await h.teamMember('reader') as any
    expect(entry.autoRetry).toBeUndefined()
    expect(entry.lastError).toContain('stream_truncated')
    expect(entry.isActive).toBe(false)
    const failure = (await h.leadNotifications()).find(item => item.idleReason === 'failed')
    expect(failure.failureReason).toContain('could not continue automatically')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test("the user's Stop pauses the team instead of ending it, and only an instruction resumes members", async () => {
  const h = await startHarness(['reader', 'writer'])
  try {
    const { isTeamPlanRuntimeActive } = await import('./teamPlanRuntime.js')
    const { getTeamDir } = await import('../../utils/swarm/teamHelpers.js')
    await h.waitFor(async () => (await h.leadNotifications()).length === 2, 'initial turn reports')
    const reportsBeforeStop = await h.leadNotifications()
    h.service.sendInterrupt(h.parentId)
    await h.service.waitForTeamWorkersStopped(h.parentId)
    expect(h.service.hasSession(h.memberIds.reader!)).toBe(false)
    expect(h.service.hasSession(h.memberIds.writer!)).toBe(false)
    expect(isTeamPlanRuntimeActive(h.planId)).toBe(true)
    expect(JSON.parse(await readFile(join(getTeamDir(h.teamName), 'plan.json'), 'utf8')).state).toBe('running')
    await h.waitFor(async () => (await h.teamMember('reader'))?.terminated === true && (await h.teamMember('writer'))?.terminated === true, 'members recorded as stopped')
    // Nothing new reaches the lead's mailbox: a delivered notice would start a
    // lead turn right after the user stopped everything.
    expect(await h.leadNotifications()).toEqual(reportsBeforeStop)

    const before = h.requests.length
    await messageMember(h, 'writer', 'reader', 'peer note sent before the user stopped')
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(h.requests.length).toBe(before)
    expect(h.service.hasSession(h.memberIds.writer!)).toBe(false)

    // A lead message the user did not ask for (one the lead was sending as the
    // user pressed Stop, or a turn it started on its own) must not undo the Stop.
    await messageMember(h, 'writer', 'team-lead', 'Lead message from before the user spoke again')
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(h.requests.length).toBe(before)
    expect(h.service.hasSession(h.memberIds.writer!)).toBe(false)

    await userMessagesLead(h)
    await messageMember(h, 'writer', 'team-lead', 'The user wants you to continue')
    await h.waitFor(() => h.requests.length > before, 'resumed member turn')
    expect(h.requests.at(-1)?.resumed).toBe(h.memberIds.writer)
    expect(h.requests.at(-1)?.prompt).toContain('peer note sent before the user stopped')
    expect(h.requests.at(-1)?.prompt).toContain('The user wants you to continue')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test("a user's direct message resumes a stopped member without waiting for the lead", async () => {
  const h = await startHarness(['reader'])
  try {
    await h.waitFor(async () => (await h.leadNotifications()).length === 1, 'initial turn report')
    h.service.sendInterrupt(h.parentId)
    await h.service.waitForTeamWorkersStopped(h.parentId)
    const before = h.requests.length
    await messageMember(h, 'reader', 'user', 'Keep going on your own')
    await h.waitFor(() => h.requests.length > before, 'resumed member turn')
    expect(h.requests.at(-1)?.resumed).toBe(h.memberIds.reader)
    expect(h.requests.at(-1)?.prompt).toContain('Keep going on your own')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a member being restarted counts as running until its process is up', async () => {
  const h = await startHarness(['reader'])
  try {
    await h.waitFor(async () => (await h.leadNotifications()).length === 1, 'initial turn report')
    const sessionId = h.memberIds.reader!
    await h.service.stopSessionAndWait(sessionId)
    await h.waitFor(async () => (await h.teamMember('reader'))?.terminated === true, 'stopped member to be recorded')
    const start = h.service.startSession.bind(h.service)
    let release!: () => void
    const released = new Promise<void>(resolve => { release = resolve })
    let restarting = false
    const spy = spyOn(h.service, 'startSession').mockImplementation(async (...args: Parameters<typeof start>) => {
      if (args[0] === sessionId) {
        restarting = true
        await released
      }
      return start(...args)
    })
    try {
      const before = h.requests.length
      await messageMember(h, 'reader', 'team-lead', 'Check one more file')
      await h.waitFor(() => restarting, 'restart to begin')
      // TeamDelete only waits for members that are not terminated, and a lead
      // whose team looks finished is told to end it.
      expect(await h.teamMember('reader')).toMatchObject({ isActive: true, terminated: false })
      release()
      await h.waitFor(() => h.requests.length > before, 'restarted member turn')
      await h.waitFor(async () => (await h.teamMember('reader'))?.isActive === false, 'restarted turn to end')
      expect((await h.teamMember('reader'))?.terminated).toBe(false)
    } finally {
      release()
      spy.mockRestore()
    }
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a Stop while a member is restarting leaves that member stopped', async () => {
  const h = await startHarness(['reader'])
  try {
    await h.waitFor(async () => (await h.leadNotifications()).length === 1, 'initial turn report')
    const sessionId = h.memberIds.reader!
    await h.service.stopSessionAndWait(sessionId)
    const start = h.service.startSession.bind(h.service)
    let stopped = false
    let restartSettled = false
    const spy = spyOn(h.service, 'startSession').mockImplementation(async (...args: Parameters<typeof start>) => {
      // The user presses Stop after the restart began but before its process
      // exists, so Stop's kill pass cannot see it.
      if (args[0] === sessionId && !stopped) {
        stopped = true
        h.service.sendInterrupt(h.parentId)
      }
      try {
        return await start(...args)
      } finally {
        if (args[0] === sessionId) restartSettled = true
      }
    })
    try {
      const before = h.requests.length
      await messageMember(h, 'reader', 'team-lead', 'Check one more file')
      await h.waitFor(() => stopped, 'restart to begin')
      await h.service.waitForTeamWorkersStopped(h.parentId)
      // Stop's first kill pass runs before the restarting process exists. Wait
      // for that start to settle before checking its eventual cleanup.
      await h.waitFor(() => restartSettled, 'restarting process to settle')
      await h.waitFor(async () => !h.service.hasSession(sessionId) && (await h.teamMember('reader'))?.terminated === true, 'restarted member to stop')
      expect(h.service.hasSession(sessionId)).toBe(false)
      expect((await h.teamMember('reader'))?.terminated).toBe(true)
      expect(h.requests.length).toBe(before)
    } finally {
      spy.mockRestore()
    }
  } finally {
    await h.cleanup()
  }
}, 30_000)

test("after a Stop, the lead's next message tells it which members stopped and how to resume them", async () => {
  const h = await startHarness(['reader', 'writer'])
  try {
    await h.waitFor(async () => (await h.leadNotifications()).length === 2, 'initial turn reports')
    // Without a Stop or a failure there is nothing to tell.
    expect(await userMessagesLead(h)).toEqual([])

    h.service.sendInterrupt(h.parentId)
    await h.service.waitForTeamWorkersStopped(h.parentId)
    const notices = await userMessagesLead(h)
    await userMessagesLead(h, notices)

    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain("[Team runtime notice] The user's Stop also stopped your team")
    expect(notices[0]).toMatch(/- reader: #\d+ Task for reader \(pending\)/)
    expect(notices[0]).toMatch(/- writer: #\d+ Task for writer \(pending\)/)
    expect(notices[0]).toContain('SendMessage each member that still has work')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test("after any failure, the user's next message tells the lead which members to wake, once per failure", async () => {
  const { setTeamRuntimeTimingForTests } = await import('./teamPlanRuntime.js')
  setTeamRuntimeTimingForTests({ autoContinueDelaysMs: [40] })
  const h = await startHarness(['billing', 'network', 'crash', 'healthy'])
  try {
    await h.waitFor(async () => (await h.leadNotifications()).length === 4, 'initial turn reports')
    const notices: string[] = []
    const failureCount = async () => (await h.leadNotifications()).filter(item => item.idleReason === 'failed').length
    // Model calls are answered in arrival order, so members fail one at a
    // time: billing is final, a dropped connection exhausts its one retry,
    // and a crash ends the process.
    for (const [name, replies] of [
      ['billing', ['FIXTURE_ERROR:Credit balance is too low']],
      ['network', ['FIXTURE_ERROR:API Error: Connection error.', 'FIXTURE_ERROR:API Error: Connection error.']],
      ['crash', ['FIXTURE_CRASH']],
    ] as const) {
      const count = await failureCount()
      h.replies.push(...replies)
      await messageMember(h, name, 'team-lead', 'Keep working')
      await h.waitFor(async () => await failureCount() > count, `${name} failure`)
    }

    // No Stop happened, yet the user's next message names every member
    // that stopped on an error.
    await userMessagesLead(h, notices)
    expect(notices).toHaveLength(1)
    const notice = notices[0]!
    expect(notice).toContain('[Team runtime notice]')
    expect(notice).toMatch(/- billing \(stopped on an error: Credit balance is too low\): #\d+ Task for billing \(pending\)/)
    expect(notice).toMatch(/- network \(stopped on an error: [^)]*Connection error[^\n]*\): #\d+ Task for network/)
    expect(notice).toMatch(/- crash \(stopped on an error: [^\n]*exited[^\n]*\): #\d+ Task for crash/)
    expect(notice).not.toContain('healthy')
    expect(notice).toContain('SendMessage each member that still has work')

    // Each failure is announced once.
    await userMessagesLead(h, notices)
    expect(notices).toHaveLength(1)

    // The lead wakes a member: it continues in its own conversation.
    const before = h.requests.length
    await messageMember(h, 'billing', 'team-lead', 'Billing is fixed, continue')
    await h.waitFor(() => h.requests.length > before, 'woken member turn')
    expect(h.requests.at(-1)?.prompt).toContain('Billing is fixed, continue')
    await h.waitFor(async () => (await h.teamMember('billing'))?.isActive === false, 'woken turn to finish')

    // A new failure is announced again, alone.
    const count = await failureCount()
    h.replies.push('FIXTURE_ERROR:Credit balance is too low')
    await messageMember(h, 'billing', 'team-lead', 'One more thing')
    await h.waitFor(async () => await failureCount() > count, 'second billing failure')
    await userMessagesLead(h, notices)
    expect(notices).toHaveLength(2)
    expect(notices[1]).toContain('- billing (stopped on an error')
    expect(notices[1]).not.toContain('- network')
  } finally {
    await h.cleanup()
  }
}, 60_000)

test('stopping and resuming the team repeatedly is never mistaken for a crash loop', async () => {
  const h = await startHarness(['reader'])
  try {
    await h.waitFor(async () => (await h.leadNotifications()).length === 1, 'initial turn report')
    // More Stop/resume cycles than the crash-loop guard allows restarts.
    for (let cycle = 1; cycle <= 4; cycle++) {
      h.service.sendInterrupt(h.parentId)
      await h.service.waitForTeamWorkersStopped(h.parentId)
      await h.waitFor(async () => (await h.teamMember('reader'))?.terminated === true, `stop ${cycle} to be recorded`)
      const before = h.requests.length
      await userMessagesLead(h)
      await messageMember(h, 'reader', 'team-lead', `Continue after stop ${cycle}`)
      await h.waitFor(() => h.requests.length > before, `resume ${cycle}`)
      expect(h.requests.at(-1)?.prompt).toContain(`Continue after stop ${cycle}`)
      await h.waitFor(async () => (await h.teamMember('reader'))?.terminated === false, `resume ${cycle} to be recorded`)
    }
    expect((await h.leadNotifications()).filter(item => item.idleReason === 'failed')).toEqual([])
    expect((await h.teamMember('reader') as any).lastError).toBeUndefined()
  } finally {
    await h.cleanup()
  }
}, 60_000)

test('replacing the lead process keeps members working and restores the roster on the next lead start', async () => {
  const h = await startHarness(['reader'])
  try {
    const control = spyOn(h.service, 'requestControl')
    h.service.stopSession(h.parentId, { keepTeamWorkers: true })
    expect(h.service.hasSession(h.parentId)).toBe(false)
    expect(h.service.hasSession(h.memberIds.reader!)).toBe(true)
    const { ProviderService } = await import('./providerService.js')
    await h.service.startSession(h.parentId, home, `ws://127.0.0.1:${ProviderService.getServerPort()}/sdk/${h.parentId}?token=parent-2`, { teamWorker: { parentSessionId: 'external', teamName: 'lead-fixture', memberId: 'lead', name: 'leader', systemPrompt: 'lead fixture' } })
    await h.waitFor(() => control.mock.calls.some(([sessionId, request]) => sessionId === h.parentId && (request as { subtype?: string }).subtype === 'team_runtime_snapshot'), 'team snapshot after lead restart')
    const before = h.requests.length
    await messageMember(h, 'reader', 'team-lead', 'Still there?')
    await h.waitFor(() => h.requests.length > before, 'member turn after lead restart')
    expect(h.requests.at(-1)?.resumed).toBeNull()
    control.mockRestore()
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a team whose owner was lost is rehydrated dormant and its members restart on demand', async () => {
  let releaseInitialMember!: () => void
  const initialMemberReply = new Promise<void>(resolve => { releaseInitialMember = resolve })
  const h = await startHarness(['reader'], { initialMemberReply })
  try {
    await h.waitFor(() => h.leadRequests.length > 0, 'delayed lead model request')
    expect(h.memberRequests('reader')).toHaveLength(1)
    releaseInitialMember()
    // The fixture persists its reply before sending the result that produces
    // this notice. A provider request alone does not guarantee a resume file.
    await h.waitFor(async () => (await h.leadNotifications()).some(item =>
      item.from === 'reader' && item.type === 'idle_notification' && item.idleReason !== 'failed',
    ), 'initial reader transcript to be written before losing its owner')
    const runtime = await import('./teamPlanRuntime.js')
    // Simulate a server restart: the processes and the in-memory owner are gone.
    await h.service.stopSessionAndWait(h.memberIds.reader!, 1000, { requireExit: true })
    runtime.forgetTeamPlanRuntimesForTests()
    expect(runtime.isTeamPlanRuntimeActive(h.planId)).toBe(false)
    expect(await runtime.rehydrateTeamPlanRuntimesForSession(h.parentId)).toBe(true)
    expect(runtime.isTeamPlanRuntimeActive(h.planId)).toBe(true)
    await h.waitFor(async () => (await h.teamMember('reader'))?.terminated === true, 'dormant member state')
    const before = h.memberRequests('reader').length
    await messageMember(h, 'reader', 'team-lead', 'Held lead instruction before the user resumed the recovered owner')
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(h.memberRequests('reader')).toHaveLength(before)
    expect(h.service.hasSession(h.memberIds.reader!)).toBe(false)
    expect((await runtimeControl(h)).status).toBe('paused')
    await userMessagesLead(h)
    await messageMember(h, 'reader', 'team-lead', 'The user now asks you to resume after losing your owner')
    const restartedTurn = () => h.memberRequests('reader').slice(before)
      .find(request => request.prompt.includes('The user now asks you to resume after losing your owner'))
    await h.waitFor(() => restartedTurn() !== undefined, 'reader restarted after losing its owner')
    expect(restartedTurn()?.resumed).toBe(h.memberIds.reader)
    expect(restartedTurn()?.prompt).toContain('Held lead instruction before the user resumed the recovered owner')
    expect(await h.teamMember('reader')).toMatchObject({ sessionId: h.memberIds.reader, terminated: false })
  } finally {
    releaseInitialMember()
    await h.cleanup()
  }
}, 30_000)

test("after a server restart, the user's next message tells the lead which members the restart stopped, once", async () => {
  const h = await startHarness(['reader', 'writer'])
  try {
    const { createShutdownRequestMessage } = await import('../../utils/teammateMailbox.js')
    await h.waitFor(async () => (await h.leadNotifications()).length === 2, 'initial turn reports')
    // writer agreed to leave before the restart; reader was still at work.
    await messageMember(h, 'writer', 'team-lead', JSON.stringify(createShutdownRequestMessage({ requestId: 'stop-writer', from: 'team-lead', reason: 'FIXTURE_APPROVE_SHUTDOWN' })))
    await h.waitFor(async () => (await h.teamMember('writer'))?.terminated === true, 'writer gone')
    const runtime = await import('./teamPlanRuntime.js')
    // The server restarts: the in-memory owner and every process are gone, and
    // nothing recorded reader's end (its supervisor died with the server).
    runtime.forgetTeamPlanRuntimesForTests()
    await h.service.stopSessionAndWait(h.memberIds.reader!)
    expect(await runtime.rehydrateTeamPlanRuntimesForSession(h.parentId)).toBe(true)

    // Nothing wakes reader by itself; the lead, waiting for its report, is told.
    const notices = await userMessagesLead(h)
    await userMessagesLead(h, notices)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('[Team runtime notice] The app restarted, which stopped these members of your team')
    expect(notices[0]).toMatch(/- reader: #\d+ Task for reader \(pending\)/)
    expect(notices[0]).not.toContain('- writer')
    expect(notices[0]).toContain('SendMessage each member that still has work')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('after a server restart the next lead start re-owns the team and restores its roster', async () => {
  let releaseInitialMember!: () => void
  const initialMemberReply = new Promise<void>(resolve => { releaseInitialMember = resolve })
  const h = await startHarness(['reader'], { initialMemberReply })
  try {
    // Keep the member's initial result pending until the delayed launch notice
    // has reached the lead's model; its request must not count as a member turn.
    await h.waitFor(() => h.leadRequests.length > 0, 'delayed lead model request')
    expect(h.memberRequests('reader')).toHaveLength(1)
    releaseInitialMember()
    // Resume requires an existing transcript. A request reaching the provider
    // does not mean the fixture has written its result or finished the turn.
    await h.waitFor(async () => (await h.leadNotifications()).some(item =>
      item.from === 'reader' && item.type === 'idle_notification' && item.idleReason !== 'failed',
    ), 'initial reader turn to finish')
    const runtime = await import('./teamPlanRuntime.js')
    const { ProviderService } = await import('./providerService.js')
    await h.service.stopSessionAndWait(h.memberIds.reader!, 1000, { requireExit: true })
    h.service.stopSession(h.parentId, { keepTeamWorkers: true })
    runtime.forgetTeamPlanRuntimesForTests()
    const control = spyOn(h.service, 'requestControl')
    // A real lead is an ordinary session, never a team worker.
    await h.service.startSession(h.parentId, home, `ws://127.0.0.1:${ProviderService.getServerPort()}/sdk/${h.parentId}?token=parent-3`, {})
    await h.waitFor(() => runtime.isTeamPlanRuntimeActive(h.planId), 're-owned team', 20_000)
    await h.waitFor(() => control.mock.calls.some(([sessionId, request]) => sessionId === h.parentId && (request as { subtype?: string }).subtype === 'team_runtime_snapshot'), 'restored roster')
    control.mockRestore()
    const before = h.memberRequests('reader').length
    await messageMember(h, 'reader', 'team-lead', 'Held lead instruction from before a new user intent')
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(h.memberRequests('reader')).toHaveLength(before)
    expect(h.service.hasSession(h.memberIds.reader!)).toBe(false)
    expect((await runtimeControl(h)).status).toBe('paused')
    await userMessagesLead(h)
    await messageMember(h, 'reader', 'team-lead', 'The user now asks you to pick up where you left off')
    const restartedTurn = () => h.memberRequests('reader').slice(before)
      .find(request => request.prompt.includes('The user now asks you to pick up where you left off'))
    await h.waitFor(() => restartedTurn() !== undefined, 'reader restarted after server restart')
    expect(restartedTurn()?.resumed).toBe(h.memberIds.reader)
    expect(restartedTurn()?.prompt).toContain('Held lead instruction from before a new user intent')
    expect(await h.teamMember('reader')).toMatchObject({ sessionId: h.memberIds.reader, terminated: false })
  } finally {
    releaseInitialMember()
    await h.cleanup()
  }
}, 30_000)

test('paused runtime controls retain the first ordinary user intent while the lead startup restores its lost owner', async () => {
  const h = await startHarness(['reader'])
  const runtime = await import('./teamPlanRuntime.js')
  const plans = await import('../../utils/swarm/teamPlanStore.js')
  const findPlan = plans.findTeamPlanForSession
  let releaseLookup!: () => void
  const lookupGate = new Promise<void>(resolve => { releaseLookup = resolve })
  let lookupHeld = false
  let snapshotRestored = false
  let lookupSpy: { mockRestore(): void } | undefined
  let noticeSpy: { mockRestore(): void } | undefined
  let controlSpy: { mockRestore(): void } | undefined
  let firstIntent: Promise<void> | undefined
  try {
    const { ProviderService } = await import('./providerService.js')
    const { readUnreadMessages } = await import('../../utils/teammateMailbox.js')
    await waitForInitialReports(h)
    const before = h.memberRequests('reader').length
    runtime.forgetTeamPlanRuntimesForTests()
    await h.service.stopSessionAndWait(h.memberIds.reader!, 1000, { requireExit: true })
    await h.service.stopSessionAndWait(h.parentId, 1000, { keepTeamWorkers: true, requireExit: true })
    await messageMember(h, 'reader', 'team-lead', 'Held mail predating the first user input after reconnect')
    const persisted = await findPlan(h.parentId)
    expect(persisted?.planId).toBe(h.planId)
    let firstLookupClaimed = false
    let synchronousIntentLookup = false
    lookupSpy = spyOn(plans, 'findTeamPlanForSession').mockImplementation(async sessionId => {
      if (sessionId !== h.parentId) return findPlan(sessionId)
      if (!firstLookupClaimed) {
        firstLookupClaimed = true
        const result = await findPlan(sessionId)
        lookupHeld = true
        await lookupGate
        return result
      }
      // Only the note's synchronously initiated read gets the same actual,
      // unchanged persisted fixture record immediately. This removes disk
      // scheduling from the microtask checkpoint; other reads stay real.
      if (synchronousIntentLookup) return structuredClone(persisted)
      return findPlan(sessionId)
    })
    const requestControl = h.service.requestControl.bind(h.service)
    controlSpy = spyOn(h.service, 'requestControl').mockImplementation(async (...args: Parameters<typeof requestControl>) => {
      const response = await requestControl(...args)
      if (args[0] === h.parentId && args[1].subtype === 'team_runtime_snapshot') snapshotRestored = true
      return response
    })
    // An ordinary lead start invokes the real sessionStarted restoration hook.
    await h.service.startSession(h.parentId, home, `ws://127.0.0.1:${ProviderService.getServerPort()}/sdk/${h.parentId}?token=first-intent-parent`, { providerId: h.providerId, model: 'cheap' })
    await h.waitFor(() => lookupHeld, 'startup hook lookup held before returning its plan')
    expect(runtime.isTeamPlanRuntimeActive(h.planId)).toBe(false)
    expect(h.memberRequests('reader')).toHaveLength(before)
    expect(h.service.hasSession(h.memberIds.reader!)).toBe(false)

    const send = h.service.sendMessage.bind(h.service)
    const notices: string[] = []
    noticeSpy = spyOn(h.service, 'sendMessage').mockImplementation(async (...args: Parameters<typeof send>) => {
      if (args[0] !== h.parentId) return send(...args)
      notices.push(String(args[1]))
      return true
    })
    let intentSettled = false
    let intentError: unknown
    synchronousIntentLookup = true
    // This is the server fresh-intent API, not an SDK user frame. Intercepting
    // its synthetic notice proves the host gate, not print.ts mailbox polling.
    firstIntent = runtime.noteLeadUserMessage(h.parentId).then(() => { intentSettled = true }, error => { intentSettled = true; intentError = error })
    synchronousIntentLookup = false
    await new Promise<void>(resolve => setImmediate(resolve))
    const returnedBeforeRestoration = intentSettled
    releaseLookup()
    await firstIntent
    expect(intentError).toBeUndefined()
    await h.waitFor(() => runtime.isTeamPlanRuntimeActive(h.planId) && snapshotRestored, 'the same startup restoration and SDK snapshot complete')
    expect(h.memberRequests('reader')).toHaveLength(before)
    expect((await readUnreadMessages('reader', h.teamName)).some(message => message.text === 'Held mail predating the first user input after reconnect')).toBe(true)

    await messageMember(h, 'reader', 'team-lead', 'Fresh lead instruction for the first user input after reconnect')
    const resumed = () => h.memberRequests('reader').slice(before).find(request => request.prompt.includes('Fresh lead instruction for the first user input after reconnect'))
    await h.waitFor(() => resumed() !== undefined, 'first fresh user intent survives asynchronous owner restoration')
    expect(resumed()?.resumed).toBe(h.memberIds.reader)
    expect(resumed()?.prompt).toContain('Held mail predating the first user input after reconnect')
    expect(h.memberRequests('reader')).toHaveLength(before + 1)
    expect(returnedBeforeRestoration).toBe(false)
    expect(notices).toHaveLength(1)
  } finally {
    releaseLookup()
    await firstIntent
    if (lookupHeld && !snapshotRestored) await h.waitFor(() => snapshotRestored, 'pending startup restoration drains before cleanup').catch(() => {})
    lookupSpy?.mockRestore()
    noticeSpy?.mockRestore()
    controlSpy?.mockRestore()
    await h.cleanup()
  }
}, 30_000)

test('paused runtime controls let a newer Stop supersede an ordinary user note still awaiting its plan lookup', async () => {
  const h = await startHarness(['reader', 'writer'])
  const plans = await import('../../utils/swarm/teamPlanStore.js')
  const findPlan = plans.findTeamPlanForSession
  let releaseLookup!: () => void
  const lookupGate = new Promise<void>(resolve => { releaseLookup = resolve })
  let lookupSpy: { mockRestore(): void } | undefined
  let staleIntent: Promise<string[]> | undefined
  try {
    const { readUnreadMessages } = await import('../../utils/teammateMailbox.js')
    await waitForInitialReports(h)
    const firstPause = await pauseReviewedTeam(h)
    const before = Object.fromEntries(['reader', 'writer'].map(name => [name, h.memberRequests(name).length]))
    let claimed = false
    let lookupHeld = false
    let lookupHeldAt = 0
    lookupSpy = spyOn(plans, 'findTeamPlanForSession').mockImplementation(async sessionId => {
      const result = await findPlan(sessionId)
      if (sessionId === h.parentId && !claimed) {
        claimed = true
        lookupHeldAt = Date.now()
        lookupHeld = true
        await lookupGate
      }
      return result
    })
    let staleIntentError: unknown
    // This helper exercises only noteLeadUserMessage's server admission gate
    // and intercepts its synthetic notice; it does not send an SDK user frame.
    staleIntent = userMessagesLead(h).catch(error => { staleIntentError = error; return [] })
    await h.waitFor(() => lookupHeld, 'ordinary input is held inside its actual plan lookup')
    // Establish strict timestamp ordering, not a guessed I/O/supervisor delay.
    await h.waitFor(() => Date.now() > lookupHeldAt, 'clock advances past the older input before Main Stop')
    const newerPause = await pauseReviewedTeam(h)
    expect(newerPause.epoch).toBeGreaterThan(firstPause.epoch)
    releaseLookup()
    await staleIntent
    expect(staleIntentError).toBeUndefined()
    lookupSpy.mockRestore()
    lookupSpy = undefined

    for (const name of ['reader', 'writer']) await messageMember(h, name, 'team-lead', `Reply to the user note that predates the newer Stop for ${name}`)
    await new Promise(resolve => setTimeout(resolve, 650))
    for (const name of ['reader', 'writer']) {
      expect(h.memberRequests(name)).toHaveLength(before[name]!)
      expect(h.service.hasSession(h.memberIds[name]!)).toBe(false)
      expect(await h.teamMember(name)).toMatchObject({ sessionId: h.memberIds[name], terminated: true, isActive: false })
      expect((await readUnreadMessages(name, h.teamName)).some(message => message.text === `Reply to the user note that predates the newer Stop for ${name}`)).toBe(true)
    }
    const stillPaused = await runtimeControl(h)
    expect(stillPaused.status).toBe('paused')
    expect(stillPaused.epoch).toBe(newerPause.epoch)

    await userMessagesLead(h)
    for (const name of ['reader', 'writer']) await messageMember(h, name, 'team-lead', `Fresh instruction after the newer Stop for ${name}`)
    for (const name of ['reader', 'writer']) {
      const resumed = () => h.memberRequests(name).slice(before[name]).find(request => request.prompt.includes(`Fresh instruction after the newer Stop for ${name}`))
      await h.waitFor(() => resumed() !== undefined, `truly fresh user input resumes ${name}`)
      expect(resumed()?.resumed).toBe(h.memberIds[name])
      expect(await h.teamMember(name)).toMatchObject({ sessionId: h.memberIds[name], terminated: false })
    }
  } finally {
    releaseLookup()
    await staleIntent
    lookupSpy?.mockRestore()
    await h.cleanup()
  }
}, 30_000)

test('ending a lead (/clear or deletion) stops its team and removes only its reviewed team', async () => {
  const h = await startHarness(['reader'])
  try {
    const runtime = await import('./teamPlanRuntime.js')
    const { getTeamDir, writeTeamFileAsync, readTeamFile } = await import('../../utils/swarm/teamHelpers.js')
    // Another session's team and an unreviewed (CLI) team of the same lead stay.
    await writeTeamFileAsync('other-team', { name: 'other-team', createdAt: 1, leadAgentId: 'team-lead@other-team', leadSessionId: 'someone-else', reviewRequired: true, members: [] })
    const { mutateTeamFileAsync } = await import('../../utils/swarm/teamHelpers.js')
    await mutateTeamFileAsync(h.teamName, team => ({ ...team, reviewRequired: true }))
    await runtime.endTeamsForParent(h.parentId)
    expect(runtime.isTeamPlanRuntimeActive(h.planId)).toBe(false)
    expect(h.service.hasSession(h.memberIds.reader!)).toBe(false)
    expect(readTeamFile(h.teamName)).toBeNull()
    await expect(readFile(join(getTeamDir(h.teamName), 'plan.json'), 'utf8')).rejects.toThrow()
    expect(readTeamFile('other-team')?.name).toBe('other-team')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a newly unblocked task wakes its idle owner once', async () => {
  const { setTeamRuntimeTimingForTests } = await import('./teamPlanRuntime.js')
  setTeamRuntimeTimingForTests({ unblockedTaskWakeDelayMs: 0 })
  const h = await startHarness(['reader'])
  try {
    const { createTask, updateTask, getCanonicalTeamTaskListId } = await import('../../utils/tasks.js')
    const taskListId = getCanonicalTeamTaskListId(h.teamName)
    const blocker = await createTask(taskListId, { subject: 'Blocker', description: '', status: 'in_progress', blocks: [], blockedBy: [] })
    const follow = await createTask(taskListId, { subject: 'Follow-up review', description: '', status: 'pending', owner: 'reader', blocks: [], blockedBy: [blocker] })
    await h.waitFor(async () => (await h.teamMember('reader'))?.isActive === false, 'member idle')
    const before = h.requests.length
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(h.requests.length).toBe(before)
    await updateTask(taskListId, blocker, { status: 'completed' })
    await h.waitFor(() => h.requests.length > before, 'wake for the ready task')
    expect(h.requests.at(-1)?.prompt).toContain(`Task #${follow}`)
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(h.requests.filter(request => request.prompt.includes(`Task #${follow}`))).toHaveLength(1)
  } finally {
    await h.cleanup()
  }
}, 30_000)

/** recon maps the release; analyst reviews it once the map exists. */
async function startDependentTeam() {
  const h = await startHarness(['recon', 'analyst'], {
    tasks: [
      { id: 'map', subject: 'Map the release', ownerId: 'recon', dependencies: [] },
      { id: 'review', subject: 'Review the release', ownerId: 'analyst', dependencies: ['map'] },
    ],
    instructedAtLaunch: ['recon'],
  })
  const { listTasks, getCanonicalTeamTaskListId } = await import('../../utils/tasks.js')
  const taskListId = getCanonicalTeamTaskListId(h.teamName)
  const tasks = await listTasks(taskListId)
  return {
    ...h,
    taskListId,
    map: tasks.find(task => task.subject === 'Map the release')!.id,
    review: tasks.find(task => task.subject === 'Review the release')!.id,
    analystBriefs: () => h.requests.filter(request => request.prompt.includes('Work as analyst')),
  }
}

test('a member whose tasks all wait on other tasks gets its instructions only once one is ready', async () => {
  const { setTeamRuntimeTimingForTests } = await import('./teamPlanRuntime.js')
  // A redundant "task is ready" wake after the instructions would come at once.
  setTeamRuntimeTimingForTests({ unblockedTaskWakeDelayMs: 0 })
  const h = await startDependentTeam()
  try {
    const { updateTask } = await import('../../utils/tasks.js')
    expect(await h.teamMember('analyst')).toMatchObject({ isActive: false, awaitingDependencies: true })
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(h.analystBriefs()).toHaveLength(0)

    await updateTask(h.taskListId, h.map, { status: 'completed' })
    await h.waitFor(() => h.analystBriefs().length > 0, 'instructions once the review is ready')
    expect(h.analystBriefs()[0]!.prompt).toContain(`#${h.review} Review the release`)
    // recon completed without sending anything: the analyst is told, so it
    // asks instead of working without the result it depends on.
    expect(h.analystBriefs()[0]!.prompt).toContain('Nothing has reached you from recon yet')
    await h.waitFor(async () => (await h.teamMember('analyst'))?.awaitingDependencies === undefined, 'instructions recorded as delivered')
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(h.requests.filter(request => request.prompt.includes(`#${h.review}`))).toHaveLength(1)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test("only the user's own message starts a waiting member early; the lead's waits and arrives with its instructions", async () => {
  const h = await startDependentTeam()
  try {
    // A lead relays results as they come in; that must not start the member.
    await messageMember(h, 'analyst', 'team-lead', 'Forwarded: the inventory so far')
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(h.analystBriefs()).toHaveLength(0)
    expect(await h.teamMember('analyst')).toMatchObject({ isActive: false, awaitingDependencies: true })

    await messageMember(h, 'analyst', 'user', 'Start now, on my word')
    await h.waitFor(() => h.analystBriefs().length > 0, 'instructions with the user message')
    expect(h.analystBriefs()[0]!.prompt).toContain('Start now, on my word')
    expect(h.analystBriefs()[0]!.prompt).toContain('Forwarded: the inventory so far')
    await h.waitFor(async () => (await h.teamMember('analyst'))?.awaitingDependencies === undefined, 'instructions recorded as delivered')

    await messageMember(h, 'analyst', 'team-lead', 'One more thing')
    await h.waitFor(() => h.requests.some(request => request.prompt.includes('One more thing')), 'second message')
    expect(h.analystBriefs()).toHaveLength(1)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a shutdown request reaches a member that has not started yet, without its instructions', async () => {
  const h = await startDependentTeam()
  try {
    const { updateTask } = await import('../../utils/tasks.js')
    const { createShutdownRequestMessage } = await import('../../utils/teammateMailbox.js')
    await messageMember(h, 'analyst', 'team-lead', JSON.stringify(createShutdownRequestMessage({ requestId: 'shutdown-1', from: 'team-lead' })))
    await h.waitFor(() => h.requests.some(request => request.prompt.includes('shutdown-1')), 'shutdown request delivered')
    expect(h.analystBriefs()).toHaveLength(0)
    await h.waitFor(async () => (await h.teamMember('analyst'))?.isActive === false, 'member idle again')
    expect((await h.teamMember('analyst'))?.awaitingDependencies).toBe(true)

    // Declined or ignored, it still starts properly once its task is ready.
    await updateTask(h.taskListId, h.map, { status: 'completed' })
    await h.waitFor(() => h.analystBriefs().length > 0, 'instructions once the review is ready')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('after a Stop, a member that has not started yet starts once the team runs again and its task is ready', async () => {
  const h = await startDependentTeam()
  try {
    const { updateTask } = await import('../../utils/tasks.js')
    await h.waitFor(async () => (await h.leadNotifications()).length === 1, 'recon report')
    h.service.sendInterrupt(h.parentId)
    await h.service.waitForTeamWorkersStopped(h.parentId)
    const notices = await userMessagesLead(h)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatch(/- recon: #\d+ Map the release \(pending\)/)
    expect(notices[0]).toContain(`- analyst: not started yet; it starts by itself once #${h.map} is completed, and messages to it wait until then`)

    await updateTask(h.taskListId, h.map, { status: 'completed' })
    await new Promise(resolve => setTimeout(resolve, 700))
    // A finished dependency does not undo the user's Stop.
    expect(h.analystBriefs()).toHaveLength(0)

    // The lead's instruction resumes the team even when it goes to the member
    // that has not started; that member then starts because its task is ready.
    await messageMember(h, 'analyst', 'team-lead', 'The user wants you to continue')
    await h.waitFor(() => h.analystBriefs().length > 0, 'analyst starts once the team runs again')
    expect(h.analystBriefs()[0]!.prompt).toContain('The user wants you to continue')
    // It never had a turn, so its own session starts afresh rather than resuming.
    expect(h.service.hasSession(h.memberIds.analyst!)).toBe(true)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a member still waiting after a server restart gets its approved instructions once a task is ready', async () => {
  const h = await startDependentTeam()
  try {
    const runtime = await import('./teamPlanRuntime.js')
    const { updateTask } = await import('../../utils/tasks.js')
    await waitForInitialReports(h, ['recon'])
    await h.service.stopSessionAndWait(h.memberIds.recon!, 1000, { requireExit: true })
    await h.service.stopSessionAndWait(h.memberIds.analyst!, 1000, { requireExit: true })
    runtime.forgetTeamPlanRuntimesForTests()
    expect(await runtime.rehydrateTeamPlanRuntimesForSession(h.parentId)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(h.analystBriefs()).toHaveLength(0)

    const reconBefore = h.memberRequests('recon').length
    await messageMember(h, 'analyst', 'recon', 'Held result written before fresh user resume')
    await messageMember(h, 'analyst', 'team-lead', 'Held lead instruction for the recovered analyst')
    await updateTask(h.taskListId, h.map, { status: 'completed' })
    await new Promise(resolve => setTimeout(resolve, 700))
    // Recovery, ready tasks and queued peer/lead mail are not new human intent.
    expect(h.analystBriefs()).toHaveLength(0)
    expect(h.service.hasSession(h.memberIds.analyst!)).toBe(false)
    expect(h.memberRequests('recon')).toHaveLength(reconBefore)
    expect((await runtimeControl(h)).status).toBe('paused')

    expect((await resumeReviewedTeam(h)).status).toBe('running')
    await h.waitFor(() => h.analystBriefs().length > 0, 'instructions after the restart')
    expect(h.service.hasSession(h.memberIds.analyst!)).toBe(true)
    // The rebuilt instructions carry the live task ids.
    expect(h.analystBriefs()[0]!.prompt).toContain(`\\"id\\":\\"${h.review}\\"`)
    expect(h.analystBriefs()[0]!.prompt).toContain('Held result written before fresh user resume')
    expect(h.analystBriefs()[0]!.prompt).toContain('Held lead instruction for the recovered analyst')
    expect(await h.teamMember('analyst')).toMatchObject({ sessionId: h.memberIds.analyst })
    await new Promise(resolve => setTimeout(resolve, 650))
    expect(h.analystBriefs()).toHaveLength(1)
    expect(h.memberRequests('recon')).toHaveLength(reconBefore)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('members written before deferred instructions rehydrate as already instructed', async () => {
  const h = await startHarness(['reader'])
  try {
    const runtime = await import('./teamPlanRuntime.js')
    await waitForInitialReports(h)
    // An older team file never carries awaitingDependencies.
    expect(await h.teamMember('reader')).not.toHaveProperty('awaitingDependencies')
    await h.service.stopSessionAndWait(h.memberIds.reader!, 1000, { requireExit: true })
    runtime.forgetTeamPlanRuntimesForTests()
    expect(await runtime.rehydrateTeamPlanRuntimesForSession(h.parentId)).toBe(true)
    const before = h.requests.length
    await messageMember(h, 'reader', 'team-lead', 'Held lead request for an already-instructed member')
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(h.requests).toHaveLength(before)
    expect(h.service.hasSession(h.memberIds.reader!)).toBe(false)
    expect((await runtimeControl(h)).status).toBe('paused')
    await userMessagesLead(h)
    await messageMember(h, 'reader', 'team-lead', 'Fresh user intent: resume the already-instructed member')
    await h.waitFor(() => h.requests.length > before, 'restarted member turn')
    expect(h.requests.at(-1)?.resumed).toBe(h.memberIds.reader)
    expect(h.requests.at(-1)?.prompt).toContain('Fresh user intent: resume the already-instructed member')
    expect(h.requests.at(-1)?.prompt).toContain('Held lead request for an already-instructed member')
    expect(h.requests.at(-1)?.prompt).not.toContain('Work as reader')
    expect(await h.teamMember('reader')).toMatchObject({ sessionId: h.memberIds.reader, terminated: false })
  } finally {
    await h.cleanup()
  }
}, 30_000)

test("a teammate's note does not start a waiting member and arrives with its instructions", async () => {
  const h = await startDependentTeam()
  try {
    const { updateTask } = await import('../../utils/tasks.js')
    const { readUnreadMessages } = await import('../../utils/teammateMailbox.js')
    // recon hands its result over before it closes the task.
    await messageMember(h, 'analyst', 'recon', 'Release map: three feature groups')
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(h.analystBriefs()).toHaveLength(0)
    expect(await readUnreadMessages('analyst', h.teamName)).toHaveLength(1)
    expect(await h.teamMember('analyst')).toMatchObject({ isActive: false, awaitingDependencies: true })

    await updateTask(h.taskListId, h.map, { status: 'completed' })
    await h.waitFor(() => h.analystBriefs().length > 0, 'instructions once the review is ready')
    expect(h.analystBriefs()[0]!.prompt).toContain('Release map: three feature groups')
    expect(h.analystBriefs()[0]!.prompt).toContain(`#${h.review} Review the release`)
    // The result it depends on is in hand, so nothing is reported missing.
    expect(h.analystBriefs()[0]!.prompt).not.toContain('Nothing has reached you')
    await h.waitFor(async () => (await readUnreadMessages('analyst', h.teamName)).length === 0, 'note marked as read')
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(h.requests.filter(request => request.prompt.includes('Release map: three feature groups'))).toHaveLength(1)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('the release-review plan that started its second layer first now runs layer by layer', async () => {
  const { setTeamRuntimeTimingForTests } = await import('./teamPlanRuntime.js')
  setTeamRuntimeTimingForTests({ unblockedTaskWakeDelayMs: 0 })
  // The approved plan of the reported run: one inventory, three analyses that
  // depend on it, a verification of all three, and a report by one analyst.
  const names = ['recon', 'perf-analyst', 'sec-analyst', 'ux-analyst', 'verifier']
  const h = await startHarness(names, {
    tasks: [
      { id: 't1', subject: 'Inventory', ownerId: 'recon', dependencies: [] },
      { id: 't2', subject: 'Performance', ownerId: 'perf-analyst', dependencies: ['t1'] },
      { id: 't3', subject: 'Security', ownerId: 'sec-analyst', dependencies: ['t1'] },
      { id: 't4', subject: 'Interaction', ownerId: 'ux-analyst', dependencies: ['t1'] },
      { id: 't5', subject: 'Verification', ownerId: 'verifier', dependencies: ['t2', 't3', 't4'] },
      { id: 't6', subject: 'Report', ownerId: 'perf-analyst', dependencies: ['t2', 't3', 't4', 't5'] },
    ],
    instructedAtLaunch: ['recon'],
  })
  try {
    const { listTasks, updateTask, getCanonicalTeamTaskListId } = await import('../../utils/tasks.js')
    const taskListId = getCanonicalTeamTaskListId(h.teamName)
    const id = Object.fromEntries((await listTasks(taskListId)).map(task => [task.subject, task.id]))
    const complete = (subject: string) => updateTask(taskListId, id[subject]!, { status: 'completed' })
    const briefs = (name: string) => h.requests.filter(request => request.prompt.includes(`Work as ${name}`))
    const instructed = () => names.filter(name => briefs(name).length > 0)
    const settle = () => new Promise(resolve => setTimeout(resolve, 600))

    await settle()
    expect(instructed()).toEqual(['recon'])
    // Each member is told who waits on its task, and to hand its result over
    // before completing it: the inventory goes to the three analysts.
    expect(briefs('recon')[0]!.prompt).toContain(`\\"handOffTo\\":[\\"perf-analyst\\",\\"sec-analyst\\",\\"ux-analyst\\"]`)
    expect(briefs('recon')[0]!.prompt).toContain('first SendMessage its result to each member listed there, then mark it completed')
    await h.waitFor(() => h.leadRequests.some(request => request.prompt.includes(`Approved team ${h.teamName} is running`)), 'launch notice to the lead')
    expect(h.leadRequests.find(request => request.prompt.includes(`Approved team ${h.teamName} is running`))!.prompt)
      .toContain('Every task of perf-analyst, sec-analyst, ux-analyst, verifier waits on other tasks')

    await complete('Inventory')
    await h.waitFor(() => instructed().length === 4, 'the three analysts to start')
    await settle()
    expect(instructed()).toEqual(['recon', 'perf-analyst', 'sec-analyst', 'ux-analyst'])

    await complete('Performance')
    await complete('Security')
    await settle()
    expect(briefs('verifier')).toHaveLength(0)
    await complete('Interaction')
    await h.waitFor(() => briefs('verifier').length > 0, 'the verifier to start')
    expect(briefs('verifier')[0]!.prompt).toContain(`#${id.Verification} Verification`)
    // An analyst hands its analysis to the verifier; its own report task is not a hand-off.
    expect(briefs('perf-analyst')[0]!.prompt).toContain(`\\"handOffTo\\":[\\"verifier\\"]`)
    // The verification goes to the analyst who writes the report.
    expect(briefs('verifier')[0]!.prompt).toContain(`\\"handOffTo\\":[\\"perf-analyst\\"]`)

    // The analyst that also owns the report is woken for it, not instructed twice.
    await h.waitFor(async () => (await h.teamMember('perf-analyst'))?.isActive === false, 'perf-analyst idle')
    await complete('Verification')
    await h.waitFor(() => h.requests.some(request => request.prompt.includes(`Task #${id.Report}`)), 'wake for the report')
    await settle()
    for (const name of names) expect(briefs(name)).toHaveLength(1)
  } finally {
    await h.cleanup()
  }
}, 60_000)

test('a member that leaves after approving a shutdown request is not reported as a failure', async () => {
  const h = await startHarness(['reader', 'writer'])
  try {
    const { createShutdownRequestMessage } = await import('../../utils/teammateMailbox.js')
    await h.waitFor(async () => (await h.leadNotifications()).length === 2, 'initial turn reports')
    const request = (marker: string) => JSON.stringify(createShutdownRequestMessage({ requestId: `stop-${marker}`, from: 'team-lead', reason: marker }))
    // reader agrees and leaves; writer's process disappears without answering.
    await messageMember(h, 'reader', 'team-lead', request('FIXTURE_APPROVE_SHUTDOWN'))
    await messageMember(h, 'writer', 'team-lead', request('FIXTURE_SHUTDOWN'))
    await h.waitFor(async () => (await h.teamMember('reader'))?.terminated === true && (await h.teamMember('writer'))?.terminated === true, 'both processes gone')
    await h.waitFor(async () => (await h.leadNotifications()).some(item => item.from === 'writer' && item.idleReason === 'failed'), 'failure notice for the member that vanished')

    // An exit that is not recognised as approved is recorded a moment later,
    // so give that time to happen before asserting it did not.
    await new Promise(resolve => setTimeout(resolve, 900))
    expect((await h.teamMember('reader'))?.lastError).toBeUndefined()
    expect((await h.teamMember('writer'))?.lastError).toContain('exited')
    const notices = await h.leadNotifications()
    expect(notices.some(item => item.from === 'reader' && item.type === 'shutdown_approved')).toBe(true)
    expect(notices.filter(item => item.from === 'reader' && item.idleReason === 'failed')).toEqual([])
    // With the user's next message the lead hears about the failure only.
    const told = await userMessagesLead(h)
    expect(told).toHaveLength(1)
    expect(told[0]).toContain('- writer (stopped on an error')
    expect(told[0]).not.toContain('- reader')

    // The approval covers that one exit: a later crash is a failure again.
    const sessionId = h.memberIds.reader!
    await messageMember(h, 'reader', 'team-lead', 'One more check, please')
    await h.waitFor(() => h.service.hasSession(sessionId), 'reader restarted by the message')
    await h.waitFor(async () => (await h.teamMember('reader'))?.isActive === false, 'reader idle after the message')
    h.replies.push('FIXTURE_CRASH')
    await messageMember(h, 'reader', 'team-lead', 'And another')
    await h.waitFor(async () => (await h.leadNotifications()).some(item => item.from === 'reader' && item.idleReason === 'failed'), 'failure notice for the later crash')
    expect((await h.teamMember('reader'))?.lastError).toBeTruthy()
  } finally {
    await h.cleanup()
  }
}, 30_000)

test("a slash command the user types in a member's conversation runs in the member's own CLI, and the lead is not told", async () => {
  const h = await startHarness(['reader'])
  try {
    await h.waitFor(async () => (await h.leadNotifications()).length === 1, 'initial turn report')
    // The member failed the way an overflowing context does.
    h.replies.push('FIXTURE_ERROR:Prompt is too long')
    await messageMember(h, 'reader', 'team-lead', 'Read every file')
    await h.waitFor(async () => (await h.teamMember('reader') as any)?.lastError === 'Prompt is too long', 'failure to be recorded')
    // The roster records the failure before the lead is notified of it; count from the notice.
    await h.waitFor(async () => (await h.leadNotifications()).some(item => item.idleReason === 'failed'), 'failure notice')
    const notices = (await h.leadNotifications()).length

    const before = h.memberRequests('reader').length
    await messageMember(h, 'reader', 'user', '/compact')
    await h.waitFor(() => h.memberRequests('reader').length > before, 'command turn')
    await h.waitFor(async () => (await h.teamMember('reader'))?.isActive === false, 'command turn to end')
    // As typed, not a teammate message the model would read as text.
    expect(JSON.parse(h.memberRequests('reader').at(-1)!.prompt)).toEqual([{ type: 'text', text: '/compact' }])
    // The command answered the failure it was run for, and no turn report reached the lead.
    expect((await h.teamMember('reader') as any)?.lastError).toBeUndefined()
    await new Promise(resolve => setTimeout(resolve, 600))
    expect((await h.leadNotifications()).length).toBe(notices)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a command waits until the member is idle, and what the user sends after it waits for it', async () => {
  const h = await startHarness(['reader'])
  try {
    await h.waitFor(async () => (await h.leadNotifications()).length === 1, 'initial turn report')
    const release = h.holdReplies()
    const before = h.memberRequests('reader').length
    await messageMember(h, 'reader', 'team-lead', 'Review the runner')
    await h.waitFor(() => h.memberRequests('reader').length === before + 1, 'busy turn')
    await messageMember(h, 'reader', 'user', '/compact')
    await messageMember(h, 'reader', 'user', 'Then continue')
    // Queued behind a turn in flight, a command would be read as that turn's text.
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(h.memberRequests('reader').length).toBe(before + 1)
    release()
    await h.waitFor(() => h.memberRequests('reader').length >= before + 3, 'command, then the message')
    const [command, message] = h.memberRequests('reader').slice(before + 1).map(request => request.prompt)
    expect(JSON.parse(command!)).toEqual([{ type: 'text', text: '/compact' }])
    expect(message).toContain('Then continue')
    expect(message).toContain('teammate-message')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a member that cannot even answer a shutdown request is stopped, so the lead can end the team', async () => {
  const h = await startHarness(['reader'])
  const mailbox = await import('../../utils/teammateMailbox.js')
  const { TEAM_LEAD_NAME } = await import('../../utils/swarm/constants.js')
  const originalWrite = mailbox.writeToMailbox
  let releaseNotice!: () => void
  const noticeGate = new Promise<void>(resolve => { releaseNotice = resolve })
  let noticeHeld = false
  let noticeWrite: ReturnType<typeof originalWrite> | undefined
  const write = spyOn(mailbox, 'writeToMailbox').mockImplementation((...args) => {
    const notice = mailbox.isIdleNotification(args[1].text)
    if (args[0] === TEAM_LEAD_NAME && args[1].from === 'reader' && args[2] === h.teamName
      && notice?.idleReason === 'failed' && notice.failureReason?.includes('could not answer the shutdown request')) {
      noticeHeld = true
      noticeWrite = noticeGate.then(() => originalWrite(...args))
      return noticeWrite
    }
    return originalWrite(...args)
  })
  const failureNotice = async () => (await h.leadNotifications()).find(item => item.from === 'reader' && item.type === 'idle_notification' && item.idleReason === 'failed')
  try {
    await h.waitFor(async () => (await h.leadNotifications()).length === 1, 'initial turn report')
    h.replies.push('FIXTURE_ERROR:Prompt is too long')
    await messageMember(h, 'reader', 'team-lead', JSON.stringify(mailbox.createShutdownRequestMessage({ requestId: 'stop-reader', from: 'team-lead', reason: 'done' })))
    await h.waitFor(async () => (await h.teamMember('reader'))?.terminated === true, 'member to be stopped')
    expect(h.service.hasSession(h.memberIds.reader!)).toBe(false)
    // Stopping the member is recorded before its failure notice is published.
    await h.waitFor(() => noticeHeld, 'shutdown failure notice write to begin')
    expect(await h.teamMember('reader')).toMatchObject({ terminated: true, isActive: false })
    expect(await failureNotice()).toBeUndefined()
    releaseNotice()
    await h.waitFor(async () => (await failureNotice()) !== undefined, 'shutdown failure notice to reach the lead')
    const failure = await failureNotice()
    expect(failure?.failureReason).toContain('could not answer the shutdown request')
  } finally {
    releaseNotice()
    try {
      // Drain the real write before cleanup can remove the mailbox.
      await noticeWrite
    } finally {
      write.mockRestore()
      await h.cleanup()
    }
  }
}, 30_000)

test('paused runtime controls save a model without starting a CLI, then explicitly resume the same conversation', async () => {
  const h = await startHarness(['reader'])
  try {
    await waitForInitialReports(h)
    const paused = await pauseReviewedTeam(h)
    const approvedBefore = (await reviewedPlan(h)).approvedSnapshot!
    const before = h.memberRequests('reader').length
    const leadBefore = h.leadRequests.length
    const startsBefore = (await h.runtimeEvents()).filter(event => event.type === 'process-start')
    expect(await saveMemberRuntime(h, 'reader', { providerId: h.providerId, modelId: 'opus' })).toMatchObject({ model: 'capable' })
    const saved = await reviewedPlan(h)
    expect(saved.members.find(member => member.id === 'reader')?.runtime.modelId).toBe('capable')
    expect(saved.approvedSnapshot?.members.find(member => member.id === 'reader')?.runtime.modelId).toBe('capable')
    expect(saved.approvedSnapshot).toMatchObject({ tasks: approvedBefore.tasks, leaderRuntime: approvedBefore.leaderRuntime, revision: approvedBefore.revision, approvedAt: approvedBefore.approvedAt, requestId: approvedBefore.requestId })
    expect(await h.teamMember('reader')).toMatchObject({ sessionId: h.memberIds.reader, model: 'capable', terminated: true, isActive: false })
    expect((await runtimeControl(h)).revision).toBeGreaterThan(paused.revision)
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(h.memberRequests('reader')).toHaveLength(before)
    expect(h.leadRequests).toHaveLength(leadBefore)
    expect((await h.runtimeEvents()).filter(event => event.type === 'process-start')).toEqual(startsBefore)
    expect(h.service.hasSession(h.memberIds.reader!)).toBe(false)

    const action = await resumeAction(h)
    const resumed = await resumeReviewedTeam(h, action)
    expect(resumed.status).toBe('running')
    await h.waitFor(() => h.memberRequests('reader').length === before + 1, 'real resumed model request')
    expect(h.memberRequests('reader').at(-1)).toMatchObject({ resumed: h.memberIds.reader, model: 'capable' })
    expect(h.memberRequests('reader').at(-1)?.prompt).toContain('explicitly resumed this team')
    const acknowledgement = (await h.runtimeEvents()).find(event => event.type === 'resume-acknowledged' && event.request?.request_id === action.requestId)
    expect(acknowledgement).toMatchObject({ sessionId: h.parentId, acknowledgement: { team_name: h.teamName, incarnation_id: h.incarnationId, epoch: resumed.epoch, request_id: action.requestId } })
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('paused runtime controls save an archived member provider without changing the current approval', async () => {
  const h = await startHarness(['reader', 'writer'], { planGroups: [['reader'], ['writer']] })
  try {
    const { ProviderService } = await import('./providerService.js')
    await waitForInitialReports(h)
    await pauseReviewedTeam(h)
    const currentBefore = await reviewedPlan(h)
    const archivedBefore = await reviewedPlan(h, h.planId)
    const before = h.memberRequests('reader').length
    const startsBefore = (await h.runtimeEvents()).filter(event => event.type === 'process-start')
    const other = await new ProviderService().addProvider({ presetId: 'custom', name: 'other', baseUrl: h.upstreamUrl, apiKey: 'fake', models: { main: 'other-model', sonnet: 'other-model', opus: 'other-model', haiku: 'other-model' } })
    expect(await saveMemberRuntime(h, 'reader', { providerId: other.id, modelId: 'other-model' })).toMatchObject({ model: 'other-model', providerId: other.id, providerName: 'other' })
    const archived = await reviewedPlan(h, h.planId)
    expect(archived.members.find(member => member.id === 'reader')?.runtime).toMatchObject({ providerId: other.id, modelId: 'other-model' })
    expect(archived.approvedSnapshot?.members.find(member => member.id === 'reader')?.runtime).toMatchObject({ providerId: other.id, modelId: 'other-model' })
    expect(archived.approvedSnapshot).toMatchObject({ tasks: archivedBefore.approvedSnapshot!.tasks, leaderRuntime: archivedBefore.approvedSnapshot!.leaderRuntime, requestId: archivedBefore.approvedSnapshot!.requestId })
    expect(await reviewedPlan(h)).toEqual(currentBefore)
    expect(h.memberRequests('reader')).toHaveLength(before)
    expect((await h.runtimeEvents()).filter(event => event.type === 'process-start')).toEqual(startsBefore)
    expect(await h.teamMember('reader')).toMatchObject({ sessionId: h.memberIds.reader, model: 'other-model', providerId: other.id, terminated: true })

    expect((await resumeReviewedTeam(h)).status).toBe('running')
    await h.waitFor(() => h.memberRequests('reader').length === before + 1, 'same archived conversation on its saved provider')
    expect(h.memberRequests('reader').at(-1)).toMatchObject({ resumed: h.memberIds.reader!, model: 'other-model' })
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('paused runtime controls refuse model saves while an idle or busy team is still running', async () => {
  const h = await startHarness(['reader'])
  try {
    const { ProviderService } = await import('./providerService.js')
    await waitForInitialReports(h)
    expect((await runtimeControl(h)).status).toBe('running')
    const planBefore = await reviewedPlan(h)
    await expect(saveMemberRuntime(h, 'reader', { providerId: h.providerId, modelId: 'opus' })).rejects.toThrow('Pause the team')
    const other = await new ProviderService().addProvider({ presetId: 'custom', name: 'other', baseUrl: h.upstreamUrl, apiKey: 'fake', models: { main: 'other-model', sonnet: 'other-model', opus: 'other-model', haiku: 'other-model' } })
    const release = h.holdReplies()
    try {
      await messageMember(h, 'reader', 'team-lead', 'Review the runner')
      await h.waitFor(async () => (await h.teamMember('reader'))?.isActive === true, 'busy turn')
      await expect(saveMemberRuntime(h, 'reader', { providerId: other.id, modelId: 'other-model' })).rejects.toThrow('Pause the team')
      expect((await h.teamMember('reader'))?.model).toBe('cheap')
      expect(await reviewedPlan(h)).toEqual(planBefore)
    } finally {
      release()
    }
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a command run on a member the user stopped leaves it stopped, and the lead is still told so', async () => {
  const h = await startHarness(['reader'])
  try {
    await h.waitFor(async () => (await h.leadNotifications()).length === 1, 'initial turn report')
    h.service.sendInterrupt(h.parentId)
    await h.service.waitForTeamWorkersStopped(h.parentId)
    await h.waitFor(async () => (await h.teamMember('reader'))?.terminated === true, 'stopped')
    const before = h.memberRequests('reader').length
    await messageMember(h, 'reader', 'user', '/compact')
    await h.waitFor(() => h.memberRequests('reader').length > before, 'command turn')
    await h.waitFor(async () => (await h.teamMember('reader'))?.isActive === false, 'command turn to end')
    await new Promise(resolve => setTimeout(resolve, 400))
    const told = await userMessagesLead(h)
    expect(told).toHaveLength(1)
    expect(told[0]).toContain("The user's Stop")
    expect(told[0]).toContain('- reader: #1 Task for reader (pending)')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('in a stopped team a command runs even behind a held note, and the user message after it still resumes the member', async () => {
  const h = await startHarness(['reader', 'writer'])
  try {
    await h.waitFor(async () => (await h.leadNotifications()).length === 2, 'initial turn reports')
    h.service.sendInterrupt(h.parentId)
    await h.service.waitForTeamWorkersStopped(h.parentId)
    // A teammate's note that arrived around the Stop waits for the team to resume.
    await messageMember(h, 'writer', 'reader', 'peer note sent around the Stop')
    await new Promise(resolve => setTimeout(resolve, 300))
    const before = h.memberRequests('writer').length
    await messageMember(h, 'writer', 'user', '/compact')
    await messageMember(h, 'writer', 'user', 'Now continue your task')
    await h.waitFor(() => h.memberRequests('writer').length >= before + 2, 'the command, then the resumed turn')
    const [command, resumed] = h.memberRequests('writer').slice(before).map(request => request.prompt)
    expect(JSON.parse(command!)).toEqual([{ type: 'text', text: '/compact' }])
    expect(resumed).toContain('peer note sent around the Stop')
    expect(resumed).toContain('Now continue your task')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('nothing else reaches a member while a command it runs is under way', async () => {
  const h = await startHarness(['reader'])
  try {
    await h.waitFor(async () => (await h.leadNotifications()).length === 1, 'initial turn report')
    await h.waitFor(async () => (await h.teamMember('reader'))?.isActive === false, 'idle member')
    const release = h.holdReplies()
    const before = h.memberRequests('reader').length
    await messageMember(h, 'reader', 'user', '/my-skill check the routes')
    await h.waitFor(() => h.memberRequests('reader').length === before + 1, 'command turn')
    // Sent mid-command, the CLI would fold it into the command's turn and the lead would never hear back.
    await messageMember(h, 'reader', 'team-lead', 'Also check the tests')
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(h.memberRequests('reader').length).toBe(before + 1)
    h.replies.push('skill done', 'tests checked')
    release()
    await h.waitFor(() => h.memberRequests('reader').length === before + 2, "the lead's message on its own turn")
    expect(h.memberRequests('reader').at(-1)!.prompt).toContain('Also check the tests')
    await h.waitFor(async () => (await h.leadNotifications()).some(item => item.result === 'tests checked'), "the lead's turn reported")
    expect((await h.leadNotifications()).some(item => item.result === 'skill done')).toBe(false)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('paused runtime controls cancel an in-flight member command before explicit resume', async () => {
  const h = await startHarness(['reader'])
  let releaseReplies: (() => void) | undefined
  try {
    const { listTasks, getCanonicalTeamTaskListId } = await import('../../utils/tasks.js')
    const { readUnreadMessages } = await import('../../utils/teammateMailbox.js')
    await waitForInitialReports(h)
    const sessionId = h.memberIds.reader!
    const unfinished = (await listTasks(getCanonicalTeamTaskListId(h.teamName))).find(task => task.owner === 'reader' && task.status !== 'completed')!
    const before = h.memberRequests('reader').length
    releaseReplies = h.holdReplies()
    await messageMember(h, 'reader', 'user', '/compact')
    await h.waitFor(() => h.memberRequests('reader').length === before + 1, 'slash command accepted by the real fixture CLI')
    const commandPrompt = h.memberRequests('reader').at(-1)!.prompt
    expect(JSON.parse(commandPrompt)).toEqual([{ type: 'text', text: '/compact' }])
    await h.waitFor(async () => !(await readUnreadMessages('reader', h.teamName)).some(message => message.from === 'user' && message.text === '/compact'), 'accepted command consumed from the mailbox')
    expect(await h.teamMember('reader')).toMatchObject({ sessionId, isActive: true, terminated: false })

    // Main Stop physically cancels the accepted command; no result can clear
    // its old turn state because this CLI has exited with its control revoked.
    expect((await pauseReviewedTeam(h)).status).toBe('paused')
    expect(h.service.hasSession(sessionId)).toBe(false)
    expect(await h.teamMember('reader')).toMatchObject({ sessionId, isActive: false, terminated: true })
    releaseReplies()
    releaseReplies = undefined
    const resumed = await resumeReviewedTeam(h)
    expect(resumed.status).toBe('running')
    expect(resumed.error).toBeUndefined()
    await h.waitFor(() => h.memberRequests('reader').length === before + 2, 'unfinished work resumes after the canceled command')
    const continued = h.memberRequests('reader').at(-1)!
    expect(continued.resumed).toBe(sessionId)
    expect(continued.prompt).toContain('Continue only your unfinished ready tasks')
    expect(continued.prompt).toContain(`#${unfinished.id} ${unfinished.subject}`)
    expect(continued.prompt).not.toContain('/compact')
    await h.waitFor(async () => (await h.teamMember('reader'))?.isActive === false, 'resumed work completes its turn')
    await new Promise(resolve => setTimeout(resolve, 650))
    expect(h.memberRequests('reader')).toHaveLength(before + 2)
    expect(h.memberRequests('reader').filter(request => request.prompt === commandPrompt)).toHaveLength(1)
    expect(await h.teamMember('reader')).toMatchObject({ sessionId, terminated: false })
  } finally {
    releaseReplies?.()
    await h.cleanup()
  }
}, 30_000)

test('paused runtime controls save and clear effort in the roster and approved snapshot without restarting', async () => {
  const h = await startHarness(['reader'])
  try {
    await waitForInitialReports(h)
    await pauseReviewedTeam(h)
    const startsBefore = (await h.runtimeEvents()).filter(event => event.type === 'process-start')
    const requestsBefore = h.requests.length
    await saveMemberRuntime(h, 'reader', { providerId: h.providerId, modelId: 'cheap', effortLevel: 'high' })
    expect(await h.teamMember('reader')).toMatchObject({ model: 'cheap', effortLevel: 'high' })
    expect((await reviewedPlan(h)).approvedSnapshot!.members[0]!.runtime.effortLevel).toBe('high')
    await saveMemberRuntime(h, 'reader', { providerId: h.providerId, modelId: 'cheap' })
    expect((await h.teamMember('reader') as any).effortLevel).toBeUndefined()
    expect((await reviewedPlan(h)).approvedSnapshot!.members[0]!.runtime.effortLevel).toBeUndefined()
    expect(h.requests).toHaveLength(requestsBefore)
    expect((await h.runtimeEvents()).filter(event => event.type === 'process-start')).toEqual(startsBefore)
    expect((await runtimeControl(h)).status).toBe('paused')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('paused runtime controls reject an unavailable provider without changing approved work or starting a CLI', async () => {
  const h = await startHarness(['reader'])
  try {
    await waitForInitialReports(h)
    await pauseReviewedTeam(h)
    const planBefore = await reviewedPlan(h)
    const controlBefore = await runtimeControl(h)
    const startsBefore = (await h.runtimeEvents()).filter(event => event.type === 'process-start')
    const requestsBefore = h.requests.length
    await expect(saveMemberRuntime(h, 'reader', { providerId: 'missing-provider-fixture', modelId: 'other-model' })).rejects.toThrow()
    expect(await h.teamMember('reader')).toMatchObject({ model: 'cheap', providerId: h.providerId })
    expect(await reviewedPlan(h)).toEqual(planBefore)
    expect(await runtimeControl(h)).toEqual(controlBefore)
    expect(h.requests).toHaveLength(requestsBefore)
    expect((await h.runtimeEvents()).filter(event => event.type === 'process-start')).toEqual(startsBefore)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('paused runtime controls stop idle workers even after the lead process is missing', async () => {
  const h = await startHarness(['reader'])
  try {
    await waitForInitialReports(h)
    expect(h.service.hasSession(h.memberIds.reader!)).toBe(true)
    await h.service.stopSessionAndWait(h.parentId, 1000, { keepTeamWorkers: true, requireExit: true })
    expect(h.service.hasSession(h.parentId)).toBe(false)
    expect(h.service.hasSession(h.memberIds.reader!)).toBe(true)
    const before = h.memberRequests('reader').length
    // No SDK socket exists for the lead, but Stop still owns the worker exits.
    expect(h.service.sendInterrupt(h.parentId)).toBe(false)
    await h.service.waitForTeamWorkersStopped(h.parentId)
    expect((await runtimeControl(h)).status).toBe('paused')
    expect(h.service.hasSession(h.memberIds.reader!)).toBe(false)
    expect(await h.teamMember('reader')).toMatchObject({ sessionId: h.memberIds.reader, terminated: true, isActive: false })
    expect(h.memberRequests('reader')).toHaveLength(before)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('paused runtime controls reject a stale save revision and preserve the first saved model', async () => {
  const h = await startHarness(['reader', 'writer'])
  try {
    await waitForInitialReports(h)
    await pauseReviewedTeam(h)
    const stale = await memberRuntimeIdentity(h, 'writer')
    await saveMemberRuntime(h, 'reader', { providerId: h.providerId, modelId: 'opus' })
    const firstSaved = await reviewedPlan(h)
    const current = await runtimeControl(h)
    await expect(saveMemberRuntime(h, 'writer', { providerId: h.providerId, modelId: 'opus' }, stale)).rejects.toThrow('Team control changed')
    expect(await reviewedPlan(h)).toEqual(firstSaved)
    expect((await reviewedPlan(h)).approvedSnapshot!.members.find(member => member.id === 'reader')!.runtime.modelId).toBe('capable')
    expect((await reviewedPlan(h)).approvedSnapshot!.members.find(member => member.id === 'writer')!.runtime.modelId).toBe('cheap')
    expect(await runtimeControl(h)).toEqual(current)
  } finally {
    await h.cleanup()
  }
}, 30_000)

for (const mismatch of ['lead session', 'member session'] as const) {
  test(`paused runtime controls reject a mismatched ${mismatch} without mutating approvals`, async () => {
    const h = await startHarness(['reader', 'writer'])
    try {
      await waitForInitialReports(h)
      await pauseReviewedTeam(h)
      const identity = await memberRuntimeIdentity(h, 'reader')
      const stale = { ...identity, ...(mismatch === 'lead session' ? { leadSessionId: 'foreign-lead-session' } : { sessionId: h.memberIds.writer! }) }
      const planBefore = await reviewedPlan(h)
      const controlBefore = await runtimeControl(h)
      const startsBefore = (await h.runtimeEvents()).filter(event => event.type === 'process-start')
      await expect(saveMemberRuntime(h, 'reader', { providerId: h.providerId, modelId: 'opus' }, stale)).rejects.toThrow('identity changed')
      expect(await reviewedPlan(h)).toEqual(planBefore)
      expect(await runtimeControl(h)).toEqual(controlBefore)
      expect((await h.runtimeEvents()).filter(event => event.type === 'process-start')).toEqual(startsBefore)
    } finally {
      await h.cleanup()
    }
  }, 30_000)
}

test('paused runtime controls reject an old incarnation after a same-name team is recreated', async () => {
  const h = await startHarness(['reader'])
  const { readTeamFile, writeTeamFileAsync } = await import('../../utils/swarm/teamHelpers.js')
  let original: ReturnType<typeof readTeamFile> = null
  try {
    await waitForInitialReports(h)
    await pauseReviewedTeam(h)
    const stale = await memberRuntimeIdentity(h, 'reader')
    const planBefore = await reviewedPlan(h)
    original = readTeamFile(h.teamName)
    if (!original) throw new Error('Fixture team missing')
    // Same team name, lead and member session: createdAt makes this a new team.
    await writeTeamFileAsync(h.teamName, { ...original, createdAt: original.createdAt + 1 })
    await expect(saveMemberRuntime(h, 'reader', { providerId: h.providerId, modelId: 'opus' }, stale)).rejects.toThrow('Team identity changed')
    expect(readTeamFile(h.teamName)?.createdAt).toBe(original.createdAt + 1)
    expect(readTeamFile(h.teamName)?.members.find(member => member.name === 'reader')?.model).toBe('cheap')
    expect(await reviewedPlan(h)).toEqual(planBefore)
  } finally {
    if (original) await writeTeamFileAsync(h.teamName, original)
    await h.cleanup()
  }
}, 30_000)

test('paused runtime controls resume every ready unfinished member once and skip completed or unassigned work', async () => {
  const h = await startHarness(['reader', 'writer', 'done', 'unassigned'])
  try {
    const { listTasks, updateTask, deleteTask, getCanonicalTeamTaskListId } = await import('../../utils/tasks.js')
    await waitForInitialReports(h)
    await pauseReviewedTeam(h)
    const listId = getCanonicalTeamTaskListId(h.teamName)
    const tasks = await listTasks(listId)
    await updateTask(listId, tasks.find(task => task.owner === 'done')!.id, { status: 'completed' })
    await deleteTask(listId, tasks.find(task => task.owner === 'unassigned')!.id)
    const before = Object.fromEntries(['reader', 'writer', 'done', 'unassigned'].map(name => [name, h.memberRequests(name).length]))
    expect((await runtimeControl(h)).resumeEligibleCount).toBe(2)
    const action = await resumeAction(h)
    const [first, duplicate] = await Promise.all([resumeReviewedTeam(h, action), resumeReviewedTeam(h, action)])
    expect(first.status).toBe('running')
    expect(duplicate).toEqual(first)
    await h.waitFor(() => ['reader', 'writer'].every(name => h.memberRequests(name).length === before[name]! + 1), 'both ready conversations resumed')
    for (const name of ['reader', 'writer']) expect(h.memberRequests(name).at(-1)).toMatchObject({ resumed: h.memberIds[name], model: 'cheap' })
    expect((await resumeReviewedTeam(h, action)).status).toBe('running')
    await new Promise(resolve => setTimeout(resolve, 650))
    for (const name of ['reader', 'writer']) expect(h.memberRequests(name)).toHaveLength(before[name]! + 1)
    for (const name of ['done', 'unassigned']) {
      expect(h.memberRequests(name)).toHaveLength(before[name]!)
      expect(h.service.hasSession(h.memberIds[name]!)).toBe(false)
    }
    const acknowledgements = (await h.runtimeEvents()).filter(event => event.type === 'resume-acknowledged' && event.request?.request_id === action.requestId)
    expect(acknowledgements).toHaveLength(1)
    expect((await listTasks(listId)).find(task => task.owner === 'done')?.status).toBe('completed')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('paused runtime controls retry a failed leader snapshot before acknowledging explicit resume', async () => {
  const h = await startHarness(['reader'])
  let controlSpy: { mockRestore(): void } | undefined
  try {
    await waitForInitialReports(h)
    await pauseReviewedTeam(h)
    await h.service.stopSessionAndWait(h.parentId, 1000, { keepTeamWorkers: true, requireExit: true })
    expect(h.service.hasSession(h.parentId)).toBe(false)
    const before = h.memberRequests('reader').length
    const memberStartsBefore = (await h.runtimeEvents()).filter(event => event.type === 'process-start' && event.agent === 'reader')
    const action = await resumeAction(h)
    const requestControl = h.service.requestControl.bind(h.service)
    let snapshotCalls = 0
    let realSnapshotAcks = 0
    const protocolOrder: string[] = []
    controlSpy = spyOn(h.service, 'requestControl').mockImplementation(async (...args: Parameters<typeof requestControl>) => {
      if (args[0] === h.parentId && args[1].subtype === 'team_runtime_snapshot' && args[1].team_name === h.teamName) {
        const attempt = ++snapshotCalls
        protocolOrder.push(`snapshot-request-${attempt}`)
        if (attempt === 1) {
          // An async pre-send failure leaves the real fixture CLI without a
          // snapshot. Let the caller observe the owned restoration promise.
          await new Promise<void>(resolve => setImmediate(resolve))
          throw new Error('Fixture snapshot rejected before team context installation')
        }
        const response = await requestControl(...args)
        realSnapshotAcks++
        protocolOrder.push(`snapshot-ack-${attempt}`)
        return response
      }
      if (args[0] === h.parentId && args[1].subtype === 'team_runtime_resume') protocolOrder.push('resume-request')
      const response = await requestControl(...args)
      if (args[0] === h.parentId && args[1].subtype === 'team_runtime_resume') protocolOrder.push('resume-ack')
      return response
    })
    const failed = await resumeReviewedTeam(h, action)
    expect(failed.status).toBe('partial')
    expect(failed.error).toContain('snapshot rejected')
    expect(snapshotCalls).toBe(1)
    expect(realSnapshotAcks).toBe(0)
    expect(protocolOrder).toEqual(['snapshot-request-1'])
    expect(h.memberRequests('reader')).toHaveLength(before)
    expect(h.service.hasSession(h.memberIds.reader!)).toBe(false)
    expect((await h.runtimeEvents()).filter(event => event.type === 'process-start' && event.agent === 'reader')).toEqual(memberStartsBefore)
    expect(h.service.hasSession(h.parentId)).toBe(true)
    const leaderStartsAfterFailure = (await h.runtimeEvents()).filter(event => event.type === 'process-start' && event.sessionId === h.parentId)
    expect(leaderStartsAfterFailure).toHaveLength(2)

    // Drain rejection/finally microtasks so an empty restoration map cannot be
    // mistaken for a successfully installed roster on this same live lead.
    await new Promise<void>(resolve => setImmediate(resolve))
    const retried = await resumeReviewedTeam(h, action)
    expect(retried.status).toBe('running')
    expect(snapshotCalls).toBe(2)
    expect(realSnapshotAcks).toBe(1)
    expect(protocolOrder).toEqual(['snapshot-request-1', 'snapshot-request-2', 'snapshot-ack-2', 'resume-request', 'resume-ack'])
    expect((await h.runtimeEvents()).filter(event => event.type === 'process-start' && event.sessionId === h.parentId)).toEqual(leaderStartsAfterFailure)
    const acknowledgements = (await h.runtimeEvents()).filter(event => event.type === 'resume-acknowledged' && event.request?.request_id === action.requestId)
    expect(acknowledgements).toHaveLength(1)
    expect(acknowledgements[0]?.acknowledgement).toEqual({ team_name: h.teamName, incarnation_id: h.incarnationId, epoch: retried.epoch, request_id: action.requestId })
    await h.waitFor(() => h.memberRequests('reader').length === before + 1, 'worker resumes only after snapshot retry and matched resume ACK')
    expect(h.memberRequests('reader').at(-1)?.resumed).toBe(h.memberIds.reader)
    // This proves the host/fixture protocol order, not print.ts mail polling.
  } finally {
    controlSpy?.mockRestore()
    await h.cleanup()
  }
}, 30_000)

test('paused runtime controls confirm the real lead resume handshake even when no worker is eligible', async () => {
  const h = await startHarness(['reader'])
  try {
    const { listTasks, updateTask, getCanonicalTeamTaskListId } = await import('../../utils/tasks.js')
    await waitForInitialReports(h)
    await pauseReviewedTeam(h)
    const listId = getCanonicalTeamTaskListId(h.teamName)
    for (const task of await listTasks(listId)) await updateTask(listId, task.id, { status: 'completed' })
    await h.service.stopSessionAndWait(h.parentId, 1000, { keepTeamWorkers: true, requireExit: true })
    const memberRequestsBefore = h.requests.length
    const leadRequestsBefore = h.leadRequests.length
    expect((await runtimeControl(h)).resumeEligibleCount).toBe(0)
    const action = await resumeAction(h)
    const resumed = await resumeReviewedTeam(h, action)
    expect(resumed.status).toBe('running')
    expect(h.service.hasSession(h.parentId)).toBe(true)
    expect(h.service.hasSession(h.memberIds.reader!)).toBe(false)
    expect(h.requests).toHaveLength(memberRequestsBefore)
    expect(h.leadRequests).toHaveLength(leadRequestsBefore)
    const events = await h.runtimeEvents()
    expect(events.filter(event => event.type === 'process-start' && event.sessionId === h.parentId)).toHaveLength(2)
    expect(events.filter(event => event.type === 'resume-acknowledged' && event.request?.request_id === action.requestId)).toEqual([
      expect.objectContaining({ sessionId: h.parentId, request: expect.objectContaining({ team_name: h.teamName, created_at: h.createdAt, incarnation_id: h.incarnationId, epoch: resumed.epoch, request_id: action.requestId }), acknowledgement: { team_name: h.teamName, incarnation_id: h.incarnationId, epoch: resumed.epoch, request_id: action.requestId } }),
    ])
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('paused runtime controls release a blocked member once its unfinished task becomes ready', async () => {
  const h = await startDependentTeam()
  try {
    const { updateTask } = await import('../../utils/tasks.js')
    await waitForInitialReports(h, ['recon'])
    await pauseReviewedTeam(h)
    expect((await runtimeControl(h)).resumeEligibleCount).toBe(1)
    const before = h.memberRequests('recon').length
    expect((await resumeReviewedTeam(h)).status).toBe('running')
    await h.waitFor(() => h.memberRequests('recon').length === before + 1, 'ready recon resumed')
    expect(h.analystBriefs()).toHaveLength(0)
    expect(h.service.hasSession(h.memberIds.analyst!)).toBe(false)
    await updateTask(h.taskListId, h.map, { status: 'completed' })
    await h.waitFor(() => h.analystBriefs().length === 1, 'analyst resumes only after dependency completion')
    expect(h.analystBriefs()[0]?.prompt).toContain(`#${h.review}`)
    expect(h.service.hasSession(h.memberIds.analyst!)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 650))
    expect(h.analystBriefs()).toHaveLength(1)
    expect(h.memberRequests('recon')).toHaveLength(before + 1)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('paused runtime controls expose a failed provider and retry the same request without duplicating admitted members', async () => {
  const h = await startHarness(['reader', 'writer'])
  try {
    const { ProviderService } = await import('./providerService.js')
    await waitForInitialReports(h)
    await pauseReviewedTeam(h)
    const providers = new ProviderService()
    const other = await providers.addProvider({ presetId: 'custom', name: 'temporary writer provider', baseUrl: h.upstreamUrl, apiKey: 'fake', models: { main: 'writer-model', sonnet: 'writer-model', opus: 'writer-model', haiku: 'writer-model' } })
    await saveMemberRuntime(h, 'writer', { providerId: other.id, modelId: 'writer-model' })
    await providers.deleteProvider(other.id)
    const readerBefore = h.memberRequests('reader').length
    const writerBefore = h.memberRequests('writer').length
    const action = await resumeAction(h)
    const first = await resumeReviewedTeam(h, action)
    expect(first.status).toBe('partial')
    expect(first.error).toContain('Some members could not resume')
    expect(first.members.find(member => member.name === 'writer')).toMatchObject({ status: 'failed', sessionId: h.memberIds.writer, error: expect.any(String) })
    await h.waitFor(() => h.memberRequests('reader').length === readerBefore + 1, 'valid reader admitted')
    await h.waitFor(async () => (await h.teamMember('reader'))?.isActive === false, 'admitted reader finishes before retry')
    const replay = await resumeReviewedTeam(h, action)
    expect(replay.status).toBe('partial')
    expect(replay.members.find(member => member.name === 'writer')?.error).toBeTruthy()
    await new Promise(resolve => setTimeout(resolve, 650))
    expect(h.memberRequests('reader')).toHaveLength(readerBefore + 1)
    expect(h.memberRequests('writer')).toHaveLength(writerBefore)
    expect(h.service.hasSession(h.memberIds.writer!)).toBe(false)
    expect(await h.teamMember('writer')).toMatchObject({ sessionId: h.memberIds.writer, terminated: true, isActive: false, lastError: expect.any(String) })
    expect((await reviewedPlan(h)).approvedSnapshot!.members.find(member => member.id === 'writer')!.runtime).toMatchObject({ providerId: other.id, modelId: 'writer-model' })

    // A reloaded client loses its in-memory request ID. The durable partial
    // view still offers only the unadmitted writer, so a fresh ID must not
    // purchase another reader turn in this same human resume epoch.
    expect((await runtimeControl(h)).resumeEligibleCount).toBe(1)
    const freshClientAction = await resumeAction(h)
    expect(freshClientAction.requestId).not.toBe(action.requestId)
    const freshClientRetry = await resumeReviewedTeam(h, freshClientAction)
    expect(freshClientRetry.status).toBe('partial')
    expect(freshClientRetry.members.filter(member => member.error).map(member => member.name)).toEqual(['writer'])
    await new Promise(resolve => setTimeout(resolve, 650))
    expect(h.memberRequests('reader')).toHaveLength(readerBefore + 1)
    expect(h.memberRequests('writer')).toHaveLength(writerBefore)
    expect(freshClientRetry.epoch).toBe(first.epoch)
    expect((await runtimeControl(h)).resumeEligibleCount).toBe(1)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('paused runtime controls hold a newly ready member after provider failure until another confirmed human resume', async () => {
  const h = await startHarness(['reader', 'writer'], {
    tasks: [
      { id: 'read', subject: 'Read the release', ownerId: 'reader', dependencies: [] },
      { id: 'write', subject: 'Write the release review', ownerId: 'writer', dependencies: ['read'] },
    ],
    instructedAtLaunch: ['reader'],
  })
  let temporaryRequests = 0
  const temporaryUpstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { temporaryRequests++; return new Response('temporary writer result') } })
  let providerReads: { mockRestore(): void } | undefined
  try {
    const { ProviderService } = await import('./providerService.js')
    const { listTasks, updateTask, getCanonicalTeamTaskListId } = await import('../../utils/tasks.js')
    const { readTeamRuntimeControl } = await import('../../utils/swarm/teamRuntimeControlStore.js')
    await waitForInitialReports(h, ['reader'])
    await pauseReviewedTeam(h)
    const providers = new ProviderService()
    const temporary = await providers.addProvider({ presetId: 'custom', name: 'deferred writer provider', baseUrl: temporaryUpstream.url.toString(), apiKey: 'fake-writer', models: { main: 'temporary-writer', sonnet: 'temporary-writer', opus: 'temporary-writer', haiku: 'temporary-writer' } })
    await saveMemberRuntime(h, 'writer', { providerId: temporary.id, modelId: 'temporary-writer' })
    const beforeReader = h.memberRequests('reader').length
    const action = await resumeAction(h)
    expect((await resumeReviewedTeam(h, action)).status).toBe('running')
    await h.waitFor(() => h.memberRequests('reader').length === beforeReader + 1, 'only the unblocked reader resumes')
    expect(h.memberRequests('writer')).toHaveLength(0)
    expect(h.service.hasSession(h.memberIds.writer!)).toBe(false)
    await providers.deleteProvider(temporary.id)
    const getProvider = ProviderService.prototype.getProvider
    let missingProviderReads = 0
    providerReads = spyOn(ProviderService.prototype, 'getProvider').mockImplementation(async function(this: InstanceType<typeof ProviderService>, id) {
      if (id === temporary.id) missingProviderReads++
      return getProvider.call(this, id)
    })
    const listId = getCanonicalTeamTaskListId(h.teamName)
    const tasks = await listTasks(listId)
    const readerTask = tasks.find(task => task.owner === 'reader')!
    const writerStartsBefore = (await h.runtimeEvents()).filter(event => event.type === 'process-start' && event.agent === 'writer')
    await updateTask(listId, readerTask.id, { status: 'completed' })
    await h.waitFor(async () => {
      const current = await runtimeControl(h)
      return current.status === 'partial' && current.members.some(member => member.name === 'writer' && member.status === 'failed' && Boolean(member.error))
    }, 'newly ready writer failure is durably visible')
    const failed = await runtimeControl(h)
    expect(failed.error).toBeTruthy()
    const durable = await readTeamRuntimeControl(h.teamName, { leadSessionId: h.parentId, incarnationId: h.incarnationId })
    expect(durable?.status).toBe('partial')
    expect(durable?.resume?.requestId).toBe(action.requestId)
    expect(durable?.resume?.eligibleSessionIds).toContain(h.memberIds.writer!)
    expect(durable?.resume?.startedSessionIds).toContain(h.memberIds.reader!)
    expect(durable?.resume?.startedSessionIds).not.toContain(h.memberIds.writer!)
    expect(durable?.memberErrors?.[h.memberIds.writer!]).toBeTruthy()
    expect(missingProviderReads).toBe(1)
    await new Promise(resolve => setTimeout(resolve, 750))
    expect(missingProviderReads).toBe(1)
    expect((await runtimeControl(h)).revision).toBe(failed.revision)
    expect(h.memberRequests('writer')).toHaveLength(0)
    expect((await h.runtimeEvents()).filter(event => event.type === 'process-start' && event.agent === 'writer')).toEqual(writerStartsBefore)
    expect(temporaryRequests).toBe(0)

    expect((await resumeReviewedTeam(h, action)).status).toBe('partial')
    expect(missingProviderReads).toBe(2)
    await new Promise(resolve => setTimeout(resolve, 650))
    expect(missingProviderReads).toBe(2)
    expect(h.memberRequests('reader')).toHaveLength(beforeReader + 1)
    expect(h.memberRequests('writer')).toHaveLength(0)
    providerReads.mockRestore()
    providerReads = undefined

    await pauseReviewedTeam(h)
    await saveMemberRuntime(h, 'writer', { providerId: h.providerId, modelId: 'opus' })
    expect((await resumeReviewedTeam(h)).status).toBe('running')
    await h.waitFor(() => h.memberRequests('writer').length === 1, 'repaired writer resumes in its assigned conversation')
    expect(h.memberRequests('writer')[0]?.model).toBe('capable')
    expect(await h.teamMember('writer')).toMatchObject({ sessionId: h.memberIds.writer, terminated: false, providerId: h.providerId, model: 'capable' })
    expect((await h.runtimeEvents()).filter(event => event.type === 'process-start' && event.agent === 'writer').at(-1)).toMatchObject({ sessionId: h.memberIds.writer, model: 'capable' })
    expect(h.memberRequests('reader')).toHaveLength(beforeReader + 1)
    expect(temporaryRequests).toBe(0)
  } finally {
    providerReads?.mockRestore()
    try { await h.cleanup() } finally { temporaryUpstream.stop(true) }
  }
}, 30_000)

test('paused runtime controls restore a paused owner after restart without old mail waking its members', async () => {
  const h = await startHarness(['reader', 'writer'])
  try {
    const runtime = await import('./teamPlanRuntime.js')
    const { readUnreadMessages } = await import('../../utils/teammateMailbox.js')
    await waitForInitialReports(h)
    const paused = await pauseReviewedTeam(h)
    await messageMember(h, 'writer', 'reader', 'held peer result from before the server restart')
    await messageMember(h, 'writer', 'team-lead', 'held lead instruction from before the server restart')
    const requestsBefore = h.requests.length
    const startsBefore = (await h.runtimeEvents()).filter(event => event.type === 'process-start' && event.agent !== 'leader')
    const approvedBefore = (await reviewedPlan(h)).approvedSnapshot
    await h.service.stopSessionAndWait(h.parentId, 1000, { keepTeamWorkers: true, requireExit: true })
    runtime.forgetTeamPlanRuntimesForTests()
    expect(await runtime.rehydrateTeamPlanRuntimesForSession(h.parentId)).toBe(true)
    await h.startLeader(h.parentId)
    await new Promise(resolve => setTimeout(resolve, 700))
    const restored = await runtimeControl(h)
    expect(restored.status).toBe('paused')
    expect(restored.epoch).toBeGreaterThanOrEqual(paused.epoch)
    expect(h.requests).toHaveLength(requestsBefore)
    expect((await h.runtimeEvents()).filter(event => event.type === 'process-start' && event.agent !== 'leader')).toEqual(startsBefore)
    expect((await readUnreadMessages('writer', h.teamName)).map(message => message.text)).toEqual(expect.arrayContaining(['held peer result from before the server restart', 'held lead instruction from before the server restart']))
    expect((await reviewedPlan(h)).approvedSnapshot).toEqual(approvedBefore)
    for (const sessionId of Object.values(h.memberIds)) expect(h.service.hasSession(sessionId)).toBe(false)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('paused runtime controls keep members stopped when the real lead refuses the resume handshake', async () => {
  process.env.FIXTURE_TEAM_RUNTIME_RESUME_REJECT = '1'
  const h = await startHarness(['reader'])
  try {
    await waitForInitialReports(h)
    await pauseReviewedTeam(h)
    const before = h.requests.length
    const startsBefore = (await h.runtimeEvents()).filter(event => event.type === 'process-start')
    const action = await resumeAction(h)
    const rejected = await resumeReviewedTeam(h, action)
    expect(rejected.status).toBe('partial')
    expect(rejected.error).toContain('Fixture lead refused')
    expect(h.requests).toHaveLength(before)
    expect(h.service.hasSession(h.memberIds.reader!)).toBe(false)
    expect((await h.runtimeEvents()).filter(event => event.type === 'process-start')).toEqual(startsBefore)
    expect((await h.runtimeEvents()).filter(event => event.type === 'resume-rejected' && event.request?.request_id === action.requestId)).toHaveLength(1)
    expect((await h.runtimeEvents()).filter(event => event.type === 'resume-acknowledged' && event.request?.request_id === action.requestId)).toHaveLength(0)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('paused runtime controls let a later Stop supersede an in-flight lead resume acknowledgement', async () => {
  process.env.FIXTURE_TEAM_RUNTIME_RESUME_DELAY_MS = '400'
  const h = await startHarness(['reader'])
  try {
    await waitForInitialReports(h)
    await pauseReviewedTeam(h)
    const before = h.requests.length
    const action = await resumeAction(h)
    // Attach rejection handling before delivering the competing Stop.
    const pending = resumeReviewedTeam(h, action).then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as Error }))
    await h.waitFor(async () => (await h.runtimeEvents()).some(event => event.type === 'resume-received' && event.request?.request_id === action.requestId), 'resume reaches the real fixture lead')
    const stopped = await pauseReviewedTeam(h)
    const outcome = await pending
    expect(outcome.error?.message).toContain('newer pause takes precedence')
    const settled = await runtimeControl(h)
    expect(settled.status).toBe('paused')
    expect(settled.epoch).toBe(stopped.epoch)
    expect(h.requests).toHaveLength(before)
    expect(h.service.hasSession(h.memberIds.reader!)).toBe(false)
    expect((await h.runtimeEvents()).filter(event => event.type === 'resume-acknowledged' && event.request?.request_id === action.requestId)).toHaveLength(0)
    await expect(resumeReviewedTeam(h, action)).rejects.toThrow('superseded by a pause')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('paused runtime controls repair a failed delivered receipt without resending the admitted model turn', async () => {
  const h = await startHarness(['reader'])
  const store = await import('../../utils/swarm/teamRuntimeControlStore.js')
  const mutate = store.mutateTeamRuntimeControl
  let releaseReplies: (() => void) | undefined
  let write: { mockRestore(): void } | undefined
  try {
    await waitForInitialReports(h)
    await pauseReviewedTeam(h)
    const action = await resumeAction(h)
    const before = h.memberRequests('reader').length
    releaseReplies = h.holdReplies()
    let receiptFailed = false
    write = spyOn(store, 'mutateTeamRuntimeControl').mockImplementation((name, identity, update) => mutate(name, identity, async current => {
      const next = await update(current)
      if (!receiptFailed && name === h.teamName && next?.status === 'resuming' && next.resume?.requestId === action.requestId && next.resume.startedSessionIds.length > 0) {
        receiptFailed = true
        throw new Error('Fixture durable started-member receipt write failed')
      }
      return next
    }))
    const resumed = await resumeReviewedTeam(h, action)
    expect(receiptFailed).toBe(true)
    expect(resumed.status).toBe('running')
    await h.waitFor(() => h.memberRequests('reader').length === before + 1, 'first real admitted provider turn')
    expect(await h.teamMember('reader')).toMatchObject({ isActive: true, terminated: false })
    expect((await h.teamMember('reader') as { lastError?: string }).lastError).toBeUndefined()
    const repaired = await store.readTeamRuntimeControl(h.teamName, { leadSessionId: h.parentId, incarnationId: h.incarnationId })
    expect(repaired?.resume?.startedSessionIds).toContain(h.memberIds.reader!)
    expect((await resumeReviewedTeam(h, action)).status).toBe('running')
    releaseReplies()
    releaseReplies = undefined
    await h.waitFor(async () => (await h.teamMember('reader'))?.isActive === false, 'admitted turn finishes')
    expect((await resumeReviewedTeam(h, action)).status).toBe('running')
    await new Promise(resolve => setTimeout(resolve, 650))
    expect(h.memberRequests('reader')).toHaveLength(before + 1)
    expect((await h.runtimeEvents()).filter(event => event.type === 'resume-acknowledged' && event.request?.request_id === action.requestId)).toHaveLength(1)
  } finally {
    releaseReplies?.()
    write?.mockRestore()
    await h.cleanup()
  }
}, 30_000)

test('paused runtime controls remain editable and resumable when Stop wins while the durable reservation returns', async () => {
  const h = await startHarness(['reader'])
  const store = await import('../../utils/swarm/teamRuntimeControlStore.js')
  const mutate = store.mutateTeamRuntimeControl
  let releaseReservation!: () => void
  const reservationGate = new Promise<void>(resolve => { releaseReservation = resolve })
  let write: { mockRestore(): void } | undefined
  let pending: Promise<{ value: Awaited<ReturnType<typeof resumeReviewedTeam>> | undefined; error: Error | undefined }> | undefined
  try {
    await waitForInitialReports(h)
    await pauseReviewedTeam(h)
    const action = await resumeAction(h)
    const before = h.memberRequests('reader').length
    let reservationHeld = false
    write = spyOn(store, 'mutateTeamRuntimeControl').mockImplementation(async (name, identity, update) => {
      // The durable write and its lock really finish; only the API's return is
      // held, so a concurrent Stop can persist its newer epoch normally.
      const reserved = await mutate(name, identity, update)
      if (!reservationHeld && name === h.teamName && reserved.status === 'resuming' && reserved.resume?.requestId === action.requestId && reserved.resume.startedSessionIds.length === 0) {
        reservationHeld = true
        await reservationGate
      }
      return reserved
    })
    pending = resumeReviewedTeam(h, action).then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as Error }))
    await h.waitFor(() => reservationHeld, 'durable resuming reservation written, return held')
    const stopped = await pauseReviewedTeam(h)
    releaseReservation()
    const superseded = await pending
    expect(superseded.error?.message).toContain('newer pause takes precedence')
    expect((await runtimeControl(h)).epoch).toBe(stopped.epoch)
    expect((await h.runtimeEvents()).filter(event => event.type === 'resume-received' && event.request?.request_id === action.requestId)).toHaveLength(0)
    expect(h.memberRequests('reader')).toHaveLength(before)
    write.mockRestore()
    write = undefined

    // No stale controlResuming latch may poison the newer paused generation.
    expect(await saveMemberRuntime(h, 'reader', { providerId: h.providerId, modelId: 'opus' })).toMatchObject({ model: 'capable' })
    expect((await resumeReviewedTeam(h)).status).toBe('running')
    await h.waitFor(() => h.memberRequests('reader').length === before + 1, 'new generation can really resume')
    expect(h.memberRequests('reader').at(-1)).toMatchObject({ resumed: h.memberIds.reader, model: 'capable' })
    const { getTeamRuntimeLaunches } = await import('./teamPlanRuntime.js')
    expect(getTeamRuntimeLaunches(h.parentId, h.teamName).every(owner => owner.controlResuming !== true)).toBe(true)
  } finally {
    releaseReservation()
    await pending
    write?.mockRestore()
    await h.cleanup()
  }
}, 30_000)

test('paused runtime controls report partial and retain a late spawned session until physical exit is confirmed', async () => {
  const h = await startHarness(['reader'])
  type OwnedCli = { pid: number; exitCode: number | null; exited: Promise<number>; kill(signal?: NodeJS.Signals): void }
  const lifecycle = h.service as unknown as { stopProcessAndWait(id: string, session: { proc: OwnedCli }, timeoutMs: number, requireExit?: boolean): Promise<void> }
  const stopProcess = lifecycle.stopProcessAndWait.bind(lifecycle)
  const start = h.service.startSession.bind(h.service)
  let releaseStart!: () => void
  const startGate = new Promise<void>(resolve => { releaseStart = resolve })
  let startSpy: { mockRestore(): void } | undefined
  let stopSpy: { mockRestore(): void } | undefined
  let stopWait: Promise<void> | undefined
  let lateProcess: OwnedCli | undefined
  let physicalExitConfirmed = false
  let physicalExitCode: number | undefined
  try {
    await waitForInitialReports(h)
    const sessionId = h.memberIds.reader!
    await h.service.stopSessionAndWait(sessionId, 1000, { requireExit: true })
    await h.waitFor(async () => (await h.teamMember('reader'))?.terminated === true, 'original worker exit recorded')
    const before = h.memberRequests('reader').length
    let startHeld = false
    const stopAttempts: Array<{ pid: number; requireExit: boolean | undefined }> = []
    startSpy = spyOn(h.service, 'startSession').mockImplementation(async (...args: Parameters<typeof start>) => {
      if (args[0] === sessionId) {
        startHeld = true
        await startGate
      }
      return start(...args)
    })
    stopSpy = spyOn(lifecycle, 'stopProcessAndWait').mockImplementation(async (id, session, timeoutMs, requireExit) => {
      if (id !== sessionId) return stopProcess(id, session, timeoutMs, requireExit)
      // Model the exact unconfirmed-kill boundary without signalling anything:
      // this is the real newly spawned owned CLI, and it remains physically up.
      if (lateProcess !== session.proc) {
        lateProcess = session.proc
        physicalExitConfirmed = false
        const captured = session.proc
        void captured.exited.then(code => {
          if (lateProcess !== captured) return
          physicalExitConfirmed = true
          physicalExitCode = code
        })
      }
      stopAttempts.push({ pid: session.proc.pid, requireExit })
      if (requireExit) throw new Error('Fixture CLI process did not confirm exit')
    })
    await messageMember(h, 'reader', 'team-lead', 'restart requested before the competing Stop')
    await h.waitFor(() => startHeld, 'restart held before its actual process exists')
    expect(h.service.hasSession(sessionId)).toBe(false)
    h.service.sendInterrupt(h.parentId)
    stopWait = h.service.waitForTeamWorkersStopped(h.parentId)
    releaseStart()
    await stopWait
    const partial = await runtimeControl(h)
    expect(partial.status).toBe('partial')
    expect(partial.error).toContain('have not confirmed')
    expect(partial.members.find(member => member.sessionId === sessionId)).toMatchObject({ status: 'failed', error: 'Fixture CLI process did not confirm exit' })
    expect(stopAttempts.length).toBeGreaterThan(0)
    expect(stopAttempts.every(attempt => attempt.requireExit === true)).toBe(true)
    expect(physicalExitConfirmed).toBe(false)
    expect(h.service.hasSession(sessionId)).toBe(true)
    expect(h.memberRequests('reader')).toHaveLength(before)
    await expect(saveMemberRuntime(h, 'reader', { providerId: h.providerId, modelId: 'opus' })).rejects.toThrow('Pause the team')

    stopSpy.mockRestore()
    stopSpy = undefined
    startSpy.mockRestore()
    startSpy = undefined
    await h.service.stopSessionAndWait(sessionId, 1000, { requireExit: true })
    expect(physicalExitConfirmed).toBe(true)
    expect(physicalExitCode).toEqual(expect.any(Number))
    expect(h.service.hasSession(sessionId)).toBe(false)
    expect((await pauseReviewedTeam(h)).status).toBe('paused')
  } finally {
    releaseStart()
    await stopWait
    stopSpy?.mockRestore()
    startSpy?.mockRestore()
    // If a regression removed the map early, still reap only the exact process
    // captured from this fixture's own session, never a discovered/global PID.
    if (lateProcess && !physicalExitConfirmed) {
      lateProcess.kill('SIGTERM')
      await lateProcess.exited
    }
    await h.cleanup()
  }
}, 30_000)

for (const failedStatus of ['pausing', 'paused'] as const) {
  test(`paused runtime controls expose a ${failedStatus} write failure and recover through another confirmed Pause`, async () => {
    const h = await startHarness(['reader'])
    const store = await import('../../utils/swarm/teamRuntimeControlStore.js')
    const mutate = store.mutateTeamRuntimeControl
    let write: { mockRestore(): void } | undefined
    try {
      await waitForInitialReports(h)
      let failedOnce = false
      write = spyOn(store, 'mutateTeamRuntimeControl').mockImplementation((name, identity, update) => mutate(name, identity, async current => {
        const next = await update(current)
        if (!failedOnce && name === h.teamName && next?.status === failedStatus) {
          failedOnce = true
          throw new Error(`Fixture pause ${failedStatus} write failed`)
        }
        return next
      }))
      h.service.sendInterrupt(h.parentId)
      await h.service.waitForTeamWorkersStopped(h.parentId)
      expect(failedOnce).toBe(true)
      const failed = await runtimeControl(h)
      expect(failed.status).toBe('partial')
      expect(failed.error).toContain(`Fixture pause ${failedStatus} write failed`)
      const { getTeamRuntimeLaunches } = await import('./teamPlanRuntime.js')
      expect(getTeamRuntimeLaunches(h.parentId, h.teamName).every(owner => owner.pausePending !== true)).toBe(true)
      const before = h.requests.length
      await expect(resumeReviewedTeam(h)).rejects.toThrow()
      expect(h.requests).toHaveLength(before)
      write.mockRestore()
      write = undefined

      const confirmed = await pauseReviewedTeam(h)
      expect(confirmed.error).toBeUndefined()
      expect(await saveMemberRuntime(h, 'reader', { providerId: h.providerId, modelId: 'opus' })).toMatchObject({ model: 'capable' })
      expect((await resumeReviewedTeam(h)).status).toBe('running')
      await h.waitFor(() => h.memberRequests('reader').length === before + 1, 'recovered pause can save and admit real work')
      expect(h.memberRequests('reader').at(-1)).toMatchObject({ resumed: h.memberIds.reader, model: 'capable' })
    } finally {
      write?.mockRestore()
      await h.cleanup()
    }
  }, 30_000)
}
