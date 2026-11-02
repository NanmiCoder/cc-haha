import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { createQualityGateSandbox, type QualityGateSandbox } from '../../../scripts/quality-gate/sandbox.js'
import { createOfflineTestEnvironment } from '../../../scripts/pr/test-environment.js'
import type { TeamPlanRecord } from '../../shared/teamPlan.js'
import type { WebSocketData } from '../ws/handler.js'

let sandbox: QualityGateSandbox
let originalEnv: NodeJS.ProcessEnv
let cleanupHarness: (() => Promise<void>) | undefined

beforeEach(() => {
  originalEnv = { ...process.env }
  sandbox = createQualityGateSandbox({
    label: 'team-power',
    source: createOfflineTestEnvironment({}, process.env),
    envOverrides: {
      NODE_ENV: 'test',
      CLAUDE_CLI_PATH: join(import.meta.dir, 'fixtures', 'team-power-cli.ts'),
    },
  })
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, sandbox.env)
})

afterEach(async () => {
  try {
    await cleanupHarness?.()
    const runtime = await import('../services/teamPlanRuntime.js')
    runtime.setTeamRuntimeTimingForTests(null)
    const { __resetWebSocketHandlerStateForTests } = await import('../ws/handler.js')
    __resetWebSocketHandlerStateForTests()
    expect(sandbox.detectUserStateMutations()).toEqual([])
  } finally {
    mock.restore()
    cleanupHarness = undefined
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, originalEnv)
    sandbox.cleanup()
  }
})

async function waitFor(condition: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 8_000
  while (!(await condition()) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  if (!(await condition())) throw new Error(`Timed out waiting for ${label}`)
}

async function getLiveStatus(includeTeamWorkers = false) {
  const { handleSessionsApi } = await import('../api/sessions.js')
  const url = new URL('http://127.0.0.1/api/sessions/live-status')
  if (includeTeamWorkers) url.searchParams.set('includeTeamWorkers', '1')
  const response = await handleSessionsApi(new Request(url), url, ['api', 'sessions', 'live-status'])
  expect(response.status).toBe(200)
  return (await response.json() as { sessions: Array<{ id: string; activityState: string }> }).sessions
}

async function getPowerSnapshot() {
  const { handleSessionsApi } = await import('../api/sessions.js')
  const url = new URL('http://127.0.0.1/api/sessions/power-activity')
  const response = await handleSessionsApi(new Request(url), url, ['api', 'sessions', 'power-activity'])
  expect(response.status).toBe(200)
  return response.json() as Promise<{ busy: boolean; completionSequence: number; scheduledCompletionSequence: number; revision: number }>
}

/** Exercise the real team launch and SDK handler, without synthetic activity marks. */
async function startHarness(teamName = `Power.${crypto.randomUUID()}`) {
  const { resetTerminalShellEnvironmentCacheForTests } = await import('../../utils/terminalShellEnvironment.js')
  resetTerminalShellEnvironmentCacheForTests()
  const { conversationService } = await import('../services/conversationService.js')
  const { ProviderService } = await import('../services/providerService.js')
  const runtime = await import('../services/teamPlanRuntime.js')
  const { handleWebSocket, getSessionChatActivityState, listMobileSessionActivity } = await import('../ws/handler.js')
  const { writeTeamFileAsync, readTeamFile, getTeamDir } = await import('../../utils/swarm/teamHelpers.js')
  const { beginTaskListLifecycle, withTaskListLifecycleLock, getCanonicalTeamTaskListId } = await import('../../utils/tasks.js')

  const requests: Array<{ prompt: string; reply: (text: string) => void }> = []
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = await request.json() as { agent: string; prompt: unknown }
      if (body.agent !== 'reader') return new Response('Lead finished coordinating')
      const text = await new Promise<string>(reply => {
        requests.push({ prompt: JSON.stringify(body.prompt), reply })
      })
      return new Response(text)
    },
  })
  const states = new Map<string, string>()
  const bridge = Bun.serve<WebSocketData>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url)
      const sessionId = url.pathname.split('/').pop()!
      const sdkToken = url.searchParams.get('token')
      if (!conversationService.authorizeSdkConnection(sessionId, sdkToken)) {
        return new Response('denied', { status: 401 })
      }
      return server.upgrade(request, { data: {
        sessionId, sdkToken, channel: 'sdk', connectedAt: Date.now(),
        serverHost: '127.0.0.1', serverPort: server.port!,
      } }) ? undefined : new Response('bad upgrade', { status: 400 })
    },
    websocket: {
      open: handleWebSocket.open,
      message(ws, payload) {
        for (const line of String(payload).trim().split('\n')) {
          const message = JSON.parse(line)
          if (message.type === 'system' && message.subtype === 'session_state_changed') {
            states.set(ws.data.sessionId, message.state)
          }
        }
        handleWebSocket.message(ws, String(payload))
      },
      close: handleWebSocket.close,
    },
  })
  const oldPort = ProviderService.getServerPort()
  ProviderService.setServerPort(bridge.port!)
  const planId = crypto.randomUUID()
  cleanupHarness = async () => {
    for (const request of requests) request.reply('fixture cleanup')
    await runtime.stopTeamPlanRuntime(planId)
    await conversationService.stopAllSessionsAndWait(1_000)
    ProviderService.setServerPort(oldPort)
    bridge.stop(true)
    upstream.stop(true)
    resetTerminalShellEnvironmentCacheForTests()
  }

  const provider = await new ProviderService().addProvider({
    presetId: 'custom', name: 'fixture', baseUrl: upstream.url.toString(), apiKey: 'fixture-only',
    models: { main: 'cheap', sonnet: 'cheap', opus: 'capable', haiku: 'cheap' },
  })
  const parentId = `power-lead-${crypto.randomUUID()}`
  const createdAt = Date.now()
  await writeTeamFileAsync(teamName, {
    name: teamName, createdAt, leadAgentId: `team-lead@${teamName}`, leadSessionId: parentId, members: [],
  })
  const taskListId = getCanonicalTeamTaskListId(teamName)
  await withTaskListLifecycleLock(taskListId, () => beginTaskListLifecycle(taskListId, { teamName, createdAt, leadSessionId: parentId }))
  await conversationService.startSession(parentId, sandbox.home, `ws://127.0.0.1:${bridge.port}/sdk/${parentId}?token=lead-fixture`, {
    providerId: provider.id, model: 'cheap',
  })
  const parentPid = conversationService.getProcessIds()[0]!
  handleWebSocket.open({
    data: {
      sessionId: parentId, channel: 'client', clientKind: 'full', sdkToken: null,
      connectedAt: Date.now(), serverHost: '127.0.0.1', serverPort: bridge.port!,
    },
    send() {},
    close() {},
  } as unknown as ServerWebSocket<WebSocketData>)

  const member = {
    id: 'reader', name: 'reader', agentType: 'research', prompt: 'Inspect the fixture',
    runtime: { providerId: provider.id, modelId: 'cheap' },
    agentSnapshot: { systemPrompt: 'Read only', tools: ['Read'] },
  }
  const tasks = [{ id: 'inspect', subject: 'Inspect', ownerId: member.id, dependencies: [] }]
  const plan: TeamPlanRecord = {
    schemaVersion: 1, planId, sessionId: parentId, teamName,
    incarnationId: createHash('sha256').update(JSON.stringify([teamName, parentId, createdAt])).digest('hex'),
    revision: 2, state: 'launching', workDir: sandbox.home, members: [member], tasks,
    leaderRuntime: member.runtime, createdAt, updatedAt: createdAt,
    approvedSnapshot: {
      revision: 1, members: [member], tasks, leaderRuntime: member.runtime,
      approvedAt: createdAt, requestId: 'fixture-approval',
    },
  }
  await writeFile(join(getTeamDir(teamName), 'plan.json'), JSON.stringify(plan))
  const { memberIds } = await runtime.launchTeamPlanRuntime(plan)
  await writeFile(join(getTeamDir(teamName), 'plan.json'), JSON.stringify({
    ...plan, state: 'running', revision: 3, launch: { status: 'running', memberIds },
  }))
  const workerId = memberIds.reader!
  await waitFor(() => requests.length === 1 && states.get(workerId) === 'running' && states.get(parentId) === 'idle', 'running worker after lead idle')
  return {
    conversationService, runtime, parentId, parentPid, planId, workerId, requests, states, teamName,
    member: () => readTeamFile(teamName)?.members.find(entry => entry.sessionId === workerId),
    async expectWorkingTeam() {
      expect((await getPowerSnapshot()).busy).toBe(true)
      expect(runtime.hasActiveTeamWorkForParent(parentId)).toBe(true)
      expect(getSessionChatActivityState(parentId)).toBe('idle')
      expect(await getLiveStatus()).toEqual([])
      expect(listMobileSessionActivity()).toContainEqual(expect.objectContaining({ id: parentId, activityState: 'idle' }))
      expect(await getLiveStatus(true)).toEqual([{ id: parentId, activityState: 'running' }])
    },
  }
}

test('prevent sleep follows real team work through an idle lead, retry backoff, continuation and completion', async () => {
  const { setTeamRuntimeTimingForTests } = await import('../services/teamPlanRuntime.js')
  setTeamRuntimeTimingForTests({ autoContinueDelaysMs: [500] })
  const h = await startHarness()
  const initial = await getPowerSnapshot()
  await h.expectWorkingTeam()

  h.requests[0]!.reply('FIXTURE_ERROR:API Error: 502 Bad Gateway')
  await waitFor(() => h.member()?.autoRetry?.attempt === 1 && h.member()?.isActive === false && h.states.get(h.workerId) === 'idle', 'automatic continuation backoff')
  await h.expectWorkingTeam()

  await waitFor(() => h.requests.length === 2 && h.member()?.isActive === true && h.states.get(h.workerId) === 'running', 'automatic continuation turn')
  expect(h.requests[1]!.prompt).toContain('[Team runtime notice]')
  await h.expectWorkingTeam()

  h.requests[1]!.reply('Review finished')
  await waitFor(() => !h.runtime.hasActiveTeamWorkForParent(h.parentId) && h.states.get(h.workerId) === 'idle' && h.states.get(h.parentId) === 'idle', 'all team work to finish')
  expect(h.conversationService.hasSession(h.workerId)).toBe(true)
  expect(await getLiveStatus(true)).toEqual([])
  expect(await getLiveStatus()).toEqual([])
  const completed = await getPowerSnapshot()
  expect(completed.busy).toBe(false)
  expect(completed.completionSequence).toBeGreaterThan(initial.completionSequence)
  expect(completed.scheduledCompletionSequence).toBe(initial.scheduledCompletionSequence)
}, 20_000)

test('power remains busy after retry timer fires while its async roster handoff is blocked', async () => {
  const runtime = await import('../services/teamPlanRuntime.js')
  runtime.setTeamRuntimeTimingForTests({ autoContinueDelaysMs: [150] })
  const h = await startHarness()
  h.requests[0]!.reply('FIXTURE_ERROR:API Error: 502 Bad Gateway')
  await waitFor(() => h.member()?.autoRetry !== undefined && h.member()?.isActive === false, 'retry backoff')
  const helpers = await import('../../utils/swarm/teamHelpers.js')
  const original = helpers.mutateTeamFileAsync
  let held = false
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const mutation = spyOn(helpers, 'mutateTeamFileAsync').mockImplementation(async (...args) => {
    if (!held) { held = true; await gate }
    return original(...args)
  })
  try {
    await waitFor(() => held, 'retry roster write')
    expect(h.member()?.isActive).toBe(false)
    expect(h.runtime.hasActiveTeamWorkForParent(h.parentId)).toBe(true)
    expect((await getPowerSnapshot()).busy).toBe(true)
  } finally {
    release()
    mutation.mockRestore()
  }
  await waitFor(() => h.requests.length === 2, 'continued worker')
  h.requests[1]!.reply('Retry finished')
  await waitFor(async () => !(await getPowerSnapshot()).busy, 'completed team')
}, 20_000)

test('power owns a paused member message from admission through queued resume and completed delivery', async () => {
  const h = await startHarness(`power-${crypto.randomUUID()}`)
  h.conversationService.sendInterrupt(h.parentId)
  await h.conversationService.waitForTeamWorkersStopped(h.parentId)
  await waitFor(async () => !(await getPowerSnapshot()).busy, 'paused team to drain')
  const initial = await getPowerSnapshot()
  const { teamService } = await import('../services/teamService.js')
  const mailbox = await import('../../utils/teammateMailbox.js')
  const originalRead = mailbox.readUnreadMessages
  const originalWrite = mailbox.writeToMailbox
  const originalAcknowledge = mailbox.markMessagesAsReadByPredicate
  let releaseSupervisor!: () => void
  let releaseWrite!: () => void
  let releaseAcknowledgement!: () => void
  const supervisorGate = new Promise<void>(resolve => { releaseSupervisor = resolve })
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve })
  const acknowledgementGate = new Promise<void>(resolve => { releaseAcknowledgement = resolve })
  let supervisorHeld = false
  let writeHeld = false
  let acknowledgementHeld = false
  // Hold one supervisor read. Activity snapshots still read the actual inbox.
  const read = spyOn(mailbox, 'readUnreadMessages').mockImplementation(async (...args) => {
    if (args[0] === 'reader' && args[1] === h.teamName && !supervisorHeld) {
      supervisorHeld = true
      await supervisorGate
    }
    return originalRead(...args)
  })
  const write = spyOn(mailbox, 'writeToMailbox').mockImplementation(async (...args) => {
    if (args[0] === 'reader' && args[1].from === 'user' && args[2] === h.teamName) {
      writeHeld = true
      await writeGate
    }
    return originalWrite(...args)
  })
  const acknowledge = spyOn(mailbox, 'markMessagesAsReadByPredicate').mockImplementation(async (...args) => {
    const result = await originalAcknowledge(...args)
    if (args[0] === 'reader' && args[2] === h.teamName) {
      acknowledgementHeld = true
      await acknowledgementGate
    }
    return result
  })
  let sending: Promise<void> | undefined
  try {
    await waitFor(() => supervisorHeld, 'paused supervisor read')
    sending = teamService.sendMemberMessage(h.teamName, h.member()!.agentId, 'Resume with the next task')
    void sending.catch(() => {})
    await waitFor(() => writeHeld, 'member message disk admission')
    const admitted = await getPowerSnapshot()
    expect(admitted.busy).toBe(true)
    expect(admitted.revision).toBeGreaterThan(initial.revision)
    expect(admitted.completionSequence).toBe(initial.completionSequence)
    expect(await originalRead('reader', h.teamName)).toEqual([])

    releaseWrite()
    await sending
    const queued = await getPowerSnapshot()
    expect(queued.busy).toBe(true)
    expect(queued.revision).toBeGreaterThan(admitted.revision)
    expect(queued.completionSequence).toBe(initial.completionSequence)
    expect(h.conversationService.hasSession(h.workerId)).toBe(false)
    expect((await originalRead('reader', h.teamName)).some(message => message.from === 'user')).toBe(true)

    releaseSupervisor()
    await waitFor(() => acknowledgementHeld && h.requests.length === 2, 'resumed worker to consume queued message')
    expect(await originalRead('reader', h.teamName)).toEqual([])
    expect((await getPowerSnapshot()).busy).toBe(true)
    h.requests[1]!.reply('Resumed task complete')
    await waitFor(() => h.member()?.isActive === false && h.states.get(h.workerId) === 'idle', 'resumed result bookkeeping')
    const delivering = await getPowerSnapshot()
    expect(delivering.busy).toBe(true)
    expect(delivering.completionSequence).toBeGreaterThan(initial.completionSequence)
    releaseAcknowledgement()
    await waitFor(async () => !(await getPowerSnapshot()).busy, 'completed mailbox handoff')
    expect((await getPowerSnapshot()).completionSequence).toBe(delivering.completionSequence)
  } finally {
    releaseWrite()
    releaseSupervisor()
    releaseAcknowledgement()
    await sending?.catch(() => {})
    read.mockRestore()
    write.mockRestore()
    acknowledge.mockRestore()
  }
}, 20_000)

test('paused teams ignore old user instructions and non-resuming teammate or lead mail', async () => {
  const h = await startHarness()
  h.conversationService.sendInterrupt(h.parentId)
  await h.conversationService.waitForTeamWorkersStopped(h.parentId)
  await waitFor(async () => !(await getPowerSnapshot()).busy, 'paused team to drain')
  const initial = await getPowerSnapshot()
  const { writeToMailbox } = await import('../../utils/teammateMailbox.js')
  const { TEAM_LEAD_NAME } = await import('../../utils/swarm/constants.js')
  for (const message of [
    { from: 'user', text: 'Old user instruction', timestamp: new Date(Date.now() - 60_000).toISOString() },
    { from: TEAM_LEAD_NAME, text: 'Old lead instruction', timestamp: new Date(Date.now() - 60_000).toISOString() },
    { from: TEAM_LEAD_NAME, text: 'Lead has not received a new user instruction', timestamp: new Date().toISOString() },
    { from: 'another-worker', text: 'New teammate result', timestamp: new Date().toISOString() },
  ]) {
    expect(await writeToMailbox('reader', message, h.teamName)).toBe(true)
    expect((await getPowerSnapshot()).busy).toBe(false)
  }
  await new Promise(resolve => setTimeout(resolve, 350))
  expect(h.conversationService.hasSession(h.workerId)).toBe(false)
  expect(h.requests).toHaveLength(1)
  const final = await getPowerSnapshot()
  expect(final.busy).toBe(false)
  expect(final.completionSequence).toBe(initial.completionSequence)
}, 20_000)

test('real worker permissions retain waiting priority in both power and default projections', async () => {
  const h = await startHarness()
  h.requests[0]!.reply('FIXTURE_PERMISSION')
  await waitFor(() => h.conversationService.getPendingPermissionRequests(h.parentId).length === 1, 'worker permission to reach the lead')
  expect(h.runtime.hasActiveTeamWorkForParent(h.parentId)).toBe(true)
  expect(await getLiveStatus()).toEqual([{ id: h.parentId, activityState: 'waiting' }])
  expect(await getLiveStatus(true)).toEqual([
    { id: h.parentId, activityState: 'waiting' },
    { id: h.workerId, activityState: 'waiting' },
  ])

  expect(h.conversationService.respondToPermission(h.parentId, 'fixture-permission', true)).toBe(true)
  await waitFor(() => !h.runtime.hasActiveTeamWorkForParent(h.parentId) && h.states.get(h.workerId) === 'idle', 'permission turn to finish')
  expect(await getLiveStatus(true)).toEqual([])
}, 20_000)

test('power keeps ownership while a removed team launch is still stopping its worker process', async () => {
  const h = await startHarness()
  const initial = await getPowerSnapshot()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const original = h.conversationService.stopSessionAndWait.bind(h.conversationService)
  const stopWorker = spyOn(h.conversationService, 'stopSessionAndWait').mockImplementation(async (...args) => {
    await gate
    return original(...args)
  })
  const stopping = h.runtime.stopTeamPlanRuntime(h.planId)
  try {
    expect(h.runtime.hasActiveTeamWorkForParent(h.parentId)).toBe(false)
    expect(h.conversationService.hasSession(h.workerId)).toBe(true)
    expect((await getPowerSnapshot()).busy).toBe(true)
  } finally {
    release()
    await stopping
    stopWorker.mockRestore()
  }
  const stopped = await getPowerSnapshot()
  expect(stopped.busy).toBe(false)
  expect(stopped.completionSequence).toBe(initial.completionSequence)
}, 20_000)

test.each(['completes', 'is stopped'] as const)('power retains real team work after the lead exits until its worker %s', async ending => {
  const h = await startHarness()
  await h.expectWorkingTeam()
  // A natural process loss preserves independent workers. stopSession would
  // exercise the explicit close path, which intentionally stops the whole team.
  process.kill(h.parentPid, 'SIGKILL')
  await waitFor(() => !h.conversationService.hasSession(h.parentId), 'natural lead exit')
  expect(h.conversationService.hasSession(h.workerId)).toBe(true)
  expect(h.states.get(h.workerId)).toBe('running')
  expect(h.runtime.hasActiveTeamWorkForParent(h.parentId)).toBe(true)
  expect(await getLiveStatus()).toEqual([])
  expect(await getLiveStatus(true)).toEqual([{ id: h.parentId, activityState: 'running' }])

  if (ending === 'completes') {
    h.requests[0]!.reply('Review finished without the lead')
    await waitFor(() => h.member()?.isActive === false && h.states.get(h.workerId) === 'idle'
      && !h.runtime.hasActiveTeamWorkForParent(h.parentId), 'independent worker completion and result bookkeeping')
    expect(h.conversationService.hasSession(h.workerId)).toBe(true)
  } else {
    await h.runtime.stopTeamPlanRuntime(h.planId)
    expect(h.conversationService.hasSession(h.workerId)).toBe(false)
  }
  expect(h.runtime.hasActiveTeamWorkForParent(h.parentId)).toBe(false)
  expect(await getLiveStatus(true)).toEqual([])
  expect(await getLiveStatus()).toEqual([])
}, 20_000)

test.each(['running', 'retry backoff'] as const)('Stop clears prevent-sleep activity during real worker %s', async phase => {
  const { setTeamRuntimeTimingForTests } = await import('../services/teamPlanRuntime.js')
  setTeamRuntimeTimingForTests({ autoContinueDelaysMs: [500] })
  const h = await startHarness()
  if (phase === 'retry backoff') {
    h.requests[0]!.reply('FIXTURE_ERROR:API Error: 502 Bad Gateway')
    await waitFor(() => h.member()?.autoRetry !== undefined && h.member()?.isActive === false && h.states.get(h.workerId) === 'idle', 'retry backoff before Stop')
  }
  await h.expectWorkingTeam()

  h.conversationService.sendInterrupt(h.parentId)
  await h.conversationService.waitForTeamWorkersStopped(h.parentId)
  expect(h.runtime.hasActiveTeamWorkForParent(h.parentId)).toBe(false)
  expect(h.conversationService.hasSession(h.workerId)).toBe(false)
  expect(await getLiveStatus(true)).toEqual([])
  expect(await getLiveStatus()).toEqual([])
  if (phase === 'retry backoff') {
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(h.requests).toHaveLength(1)
    expect(await getLiveStatus(true)).toEqual([])
  }
}, 20_000)
