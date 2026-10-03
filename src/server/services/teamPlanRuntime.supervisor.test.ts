import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetTerminalShellEnvironmentCacheForTests } from '../../utils/terminalShellEnvironment.js'

let home: string
let originalEnv: NodeJS.ProcessEnv
beforeEach(async () => {
  originalEnv = { ...process.env }
  home = await mkdtemp(join(tmpdir(), 'team-supervisor-'))
  process.env.HOME = home
  process.env.CLAUDE_CONFIG_DIR = home
  process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = '1'
  process.env.CLAUDE_CLI_PATH = join(import.meta.dir, '__fixtures__', 'team-worker-cli.ts')
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
async function startHarness(memberNames: string[]) {
  const { conversationService: service } = await import('./conversationService.js')
  const { ProviderService } = await import('./providerService.js')
  const { launchTeamPlanRuntime } = await import('./teamPlanRuntime.js')
  const { writeTeamFileAsync, getTeamDir } = await import('../../utils/swarm/teamHelpers.js')
  const { beginTaskListLifecycle, withTaskListLifecycleLock, getCanonicalTeamTaskListId } = await import('../../utils/tasks.js')
  const requests: Array<{ resumed: string | null; prompt: string }> = []
  const replies: string[] = []
  let held: Promise<void> | undefined
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as { resumed?: string | null; prompt?: unknown }
    requests.push({ resumed: body.resumed ?? null, prompt: JSON.stringify(body.prompt ?? '') })
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
  const tasks = memberNames.map(name => ({ id: `task-${name}`, subject: `Task for ${name}`, ownerId: name, dependencies: [] }))
  const planId = crypto.randomUUID()
  const plan = { schemaVersion: 1, planId, sessionId: parentId, teamName, incarnationId: createHash('sha256').update(JSON.stringify([teamName, parentId, createdAt])).digest('hex'), revision: 2, state: 'launching', workDir: home, members, tasks, leaderRuntime: members[0]!.runtime, createdAt, updatedAt: createdAt, approvedSnapshot: { revision: 1, members, tasks, leaderRuntime: members[0]!.runtime, approvedAt: Date.now(), requestId: 'approve' } } as any
  await writeFile(join(getTeamDir(teamName), 'plan.json'), JSON.stringify(plan))
  const { memberIds } = await launchTeamPlanRuntime(plan)
  // The service records the running state the way TeamPlanService does after launch.
  await writeFile(join(getTeamDir(teamName), 'plan.json'), JSON.stringify({ ...plan, state: 'running', revision: 3, launch: { status: 'running', memberIds } }))
  const waitFor = async (condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 8000) => {
    const end = Date.now() + timeoutMs
    while (!(await condition()) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20))
    if (!(await condition())) throw new Error(`Timed out waiting for ${label}`)
  }
  await waitFor(() => requests.length >= memberNames.length, 'initial member turns')
  return {
    service, teamName, parentId, planId, memberIds, requests, replies, waitFor,
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
      await runtime.stopTeamPlanRuntime(planId)
      await service.stopAllSessionsAndWait(1000)
      ProviderService.setServerPort(oldPort)
      bridge.stop(true)
      upstream.stop(true)
    },
  }
}

async function messageMember(h: Harness, to: string, from: string, text: string) {
  const { writeToMailbox } = await import('../../utils/teammateMailbox.js')
  await writeToMailbox(to, { from, text, timestamp: new Date().toISOString() }, h.teamName)
}

test('a member whose process died restarts from its own transcript when the lead messages it', async () => {
  const h = await startHarness(['reader'])
  try {
    const sessionId = h.memberIds.reader!
    h.replies.push('FIXTURE_CRASH')
    await messageMember(h, 'reader', 'team-lead', 'Check one more file')
    await h.waitFor(async () => (await h.teamMember('reader'))?.terminated === true, 'crash to be recorded')
    expect(h.service.hasSession(sessionId)).toBe(false)
    const crashNotice = (await h.leadNotifications()).find(item => item.type === 'idle_notification' && item.idleReason === 'failed')
    expect(crashNotice?.failureReason).toContain('restarts it from its saved conversation')

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

    await messageMember(h, 'writer', 'team-lead', 'The user wants you to continue')
    await h.waitFor(() => h.requests.length > before, 'resumed member turn')
    expect(h.requests.at(-1)?.resumed).toBe(h.memberIds.writer)
    expect(h.requests.at(-1)?.prompt).toContain('peer note sent before the user stopped')
    expect(h.requests.at(-1)?.prompt).toContain('The user wants you to continue')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test("after a Stop, the lead's next message tells it which members stopped and how to resume them", async () => {
  const h = await startHarness(['reader', 'writer'])
  try {
    const { deliverTeamPauseNotice } = await import('./teamPlanRuntime.js')
    await h.waitFor(async () => (await h.leadNotifications()).length === 2, 'initial turn reports')
    const sent: Array<[string, string]> = []
    const send = h.service.sendMessage.bind(h.service)
    const spy = spyOn(h.service, 'sendMessage').mockImplementation(async (...args: Parameters<typeof send>) => {
      sent.push([args[0], String(args[1])])
      return send(...args)
    })
    try {
      // Without a Stop there is nothing to tell.
      await deliverTeamPauseNotice(h.parentId)
      expect(sent).toEqual([])

      h.service.sendInterrupt(h.parentId)
      await h.service.waitForTeamWorkersStopped(h.parentId)
      await deliverTeamPauseNotice(h.parentId)
      await deliverTeamPauseNotice(h.parentId)

      const notices = sent.filter(([sessionId]) => sessionId === h.parentId).map(([, text]) => text)
      expect(notices).toHaveLength(1)
      expect(notices[0]).toContain('[Team runtime notice]')
      expect(notices[0]).toMatch(/- reader: #\d+ Task for reader \(pending\)/)
      expect(notices[0]).toMatch(/- writer: #\d+ Task for writer \(pending\)/)
      expect(notices[0]).toContain('SendMessage each member that still has work')
    } finally {
      spy.mockRestore()
    }
  } finally {
    await h.cleanup()
  }
}, 30_000)

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
  const h = await startHarness(['reader'])
  try {
    const runtime = await import('./teamPlanRuntime.js')
    // Simulate a server restart: the processes and the in-memory owner are gone.
    await h.service.stopSessionAndWait(h.memberIds.reader!)
    runtime.forgetTeamPlanRuntimesForTests()
    expect(runtime.isTeamPlanRuntimeActive(h.planId)).toBe(false)
    expect(await runtime.rehydrateTeamPlanRuntimesForSession(h.parentId)).toBe(true)
    expect(runtime.isTeamPlanRuntimeActive(h.planId)).toBe(true)
    await h.waitFor(async () => (await h.teamMember('reader'))?.terminated === true, 'dormant member state')
    const before = h.requests.length
    await messageMember(h, 'reader', 'team-lead', 'Resume after restart')
    await h.waitFor(() => h.requests.length > before, 'restarted member turn')
    expect(h.requests.at(-1)?.resumed).toBe(h.memberIds.reader)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('after a server restart the next lead start re-owns the team and restores its roster', async () => {
  const h = await startHarness(['reader'])
  try {
    const runtime = await import('./teamPlanRuntime.js')
    const { ProviderService } = await import('./providerService.js')
    await h.service.stopSessionAndWait(h.memberIds.reader!)
    h.service.stopSession(h.parentId, { keepTeamWorkers: true })
    runtime.forgetTeamPlanRuntimesForTests()
    const control = spyOn(h.service, 'requestControl')
    // A real lead is an ordinary session, never a team worker.
    await h.service.startSession(h.parentId, home, `ws://127.0.0.1:${ProviderService.getServerPort()}/sdk/${h.parentId}?token=parent-3`, {})
    await h.waitFor(() => runtime.isTeamPlanRuntimeActive(h.planId), 're-owned team', 20_000)
    await h.waitFor(() => control.mock.calls.some(([sessionId, request]) => sessionId === h.parentId && (request as { subtype?: string }).subtype === 'team_runtime_snapshot'), 'restored roster')
    control.mockRestore()
    const before = h.requests.length
    await messageMember(h, 'reader', 'team-lead', 'Pick up where you left off')
    await h.waitFor(() => h.requests.length > before, 'member restarted after server restart')
    expect(h.requests.at(-1)?.resumed).toBe(h.memberIds.reader)
  } finally {
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
