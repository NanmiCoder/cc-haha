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
async function startHarness(memberNames: string[], options: {
  tasks?: Array<{ id: string; subject: string; ownerId: string; dependencies: string[] }>
  /** Members expected to get their instructions at launch (default: all). */
  instructedAtLaunch?: string[]
} = {}) {
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
  const tasks = options.tasks ?? memberNames.map(name => ({ id: `task-${name}`, subject: `Task for ${name}`, ownerId: name, dependencies: [] }))
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
  const instructed = options.instructedAtLaunch ?? memberNames
  await waitFor(() => instructed.every(name => requests.some(request => request.prompt.includes(`Work as ${name}`))), 'initial member turns')
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

test('a Stop while a member is restarting leaves that member stopped', async () => {
  const h = await startHarness(['reader'])
  try {
    await h.waitFor(async () => (await h.leadNotifications()).length === 1, 'initial turn report')
    const sessionId = h.memberIds.reader!
    await h.service.stopSessionAndWait(sessionId)
    const start = h.service.startSession.bind(h.service)
    let stopped = false
    const spy = spyOn(h.service, 'startSession').mockImplementation(async (...args: Parameters<typeof start>) => {
      // The user presses Stop after the restart began but before its process
      // exists, so Stop's kill pass cannot see it.
      if (args[0] === sessionId && !stopped) {
        stopped = true
        h.service.sendInterrupt(h.parentId)
      }
      return start(...args)
    })
    try {
      await messageMember(h, 'reader', 'team-lead', 'Check one more file')
      await h.waitFor(() => stopped, 'restart to begin')
      await h.service.waitForTeamWorkersStopped(h.parentId)
      await new Promise(resolve => setTimeout(resolve, 800))
      expect(h.service.hasSession(sessionId)).toBe(false)
      expect((await h.teamMember('reader'))?.terminated).toBe(true)
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
    await h.service.stopSessionAndWait(h.memberIds.recon!)
    await h.service.stopSessionAndWait(h.memberIds.analyst!)
    runtime.forgetTeamPlanRuntimesForTests()
    expect(await runtime.rehydrateTeamPlanRuntimesForSession(h.parentId)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(h.analystBriefs()).toHaveLength(0)

    await updateTask(h.taskListId, h.map, { status: 'completed' })
    await h.waitFor(() => h.analystBriefs().length > 0, 'instructions after the restart')
    expect(h.service.hasSession(h.memberIds.analyst!)).toBe(true)
    // The rebuilt instructions carry the live task ids.
    expect(h.analystBriefs()[0]!.prompt).toContain(`\\"id\\":\\"${h.review}\\"`)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('members written before deferred instructions rehydrate as already instructed', async () => {
  const h = await startHarness(['reader'])
  try {
    const runtime = await import('./teamPlanRuntime.js')
    // An older team file never carries awaitingDependencies.
    expect(await h.teamMember('reader')).not.toHaveProperty('awaitingDependencies')
    await h.service.stopSessionAndWait(h.memberIds.reader!)
    runtime.forgetTeamPlanRuntimesForTests()
    expect(await runtime.rehydrateTeamPlanRuntimesForSession(h.parentId)).toBe(true)
    const before = h.requests.length
    await messageMember(h, 'reader', 'team-lead', 'Resume after restart')
    await h.waitFor(() => h.requests.length > before, 'restarted member turn')
    expect(h.requests.at(-1)?.prompt).toContain('Resume after restart')
    expect(h.requests.at(-1)?.prompt).not.toContain('Work as reader')
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
    await h.waitFor(() => h.requests.some(request => request.prompt.includes(`Approved team ${h.teamName} is running`)), 'launch notice to the lead')
    expect(h.requests.find(request => request.prompt.includes(`Approved team ${h.teamName} is running`))!.prompt)
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
