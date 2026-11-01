import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createQualityGateSandbox, type QualityGateSandbox } from '../../../scripts/quality-gate/sandbox.js'
import { createOfflineTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { IdlePowerService, readIdlePowerActivity, type PowerActivitySnapshot } from '../../../desktop/electron/services/idlePower.js'
import type { IdlePowerRecord, IdlePowerSettings } from '../../../desktop/src/lib/idlePower.js'

let sandbox: QualityGateSandbox
let originalEnv: NodeJS.ProcessEnv
let cleanupHarness: (() => Promise<void>) | undefined

beforeEach(() => {
  originalEnv = { ...process.env }
  sandbox = createQualityGateSandbox({
    label: 'idle-power-flow',
    source: createOfflineTestEnvironment({}, process.env),
    envOverrides: { NODE_ENV: 'test', CC_HAHA_LOCAL_INDEX: 'off', ANTHROPIC_API_KEY: 'fixture-only' },
  })
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, sandbox.env)
})

afterEach(async () => {
  try {
    await cleanupHarness?.()
    expect(sandbox.detectUserStateMutations()).toEqual([])
  } finally {
    cleanupHarness = undefined
    mock.restore()
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, originalEnv)
    sandbox.cleanup()
  }
})

async function waitFor(condition: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = performance.now() + 5_000
  while (!(await condition()) && performance.now() < deadline) await Bun.sleep(5)
  if (!(await condition())) throw new Error(`Timed out waiting for ${label}`)
}

async function startHarness(scope: IdlePowerSettings['scope'], options: {
  countdownSeconds?: IdlePowerSettings['countdownSeconds']
  quietPeriodMs?: number
} = {}) {
  const { handleSessionsApi } = await import('../api/sessions.js')
  const { cronScheduler } = await import('../services/cronScheduler.js')
  const { CronService } = await import('../services/cronService.js')
  const { computerUseApprovalService } = await import('../services/computerUseApprovalService.js')
  const { activeBackgroundTaskIds } = await import('../ws/agentTaskState.js')
  const handler = await import('../ws/handler.js')
  const { resetTerminalShellEnvironmentCacheForTests } = await import('../../utils/terminalShellEnvironment.js')
  resetTerminalShellEnvironmentCacheForTests()

  const token = 'idle-power-loopback-fixture'
  let requestCount = 0
  let unauthorizedRequests = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (request.headers.get('Authorization') !== `Bearer ${token}`) {
        unauthorizedRequests += 1
        return new Response('Unauthorized fixture request', { status: 401 })
      }
      const url = new URL(request.url)
      if (url.pathname !== '/api/sessions/power-activity') return new Response('Not found', { status: 404 })
      requestCount += 1
      return handleSessionsApi(request, url, ['api', 'sessions', 'power-activity'])
    },
  })
  const access = { serverUrl: server.url.origin, token }
  const originalFetch = globalThis.fetch
  const forbiddenRequests: string[] = []
  spyOn(globalThis, 'fetch').mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== access.serverUrl) {
      forbiddenRequests.push(url.origin)
      return Promise.reject(new Error('Only the disposable activity API may be contacted'))
    }
    return originalFetch(input, init)
  }) as typeof fetch)

  const releasePath = join(sandbox.home, 'release-cron')
  const readyPath = join(sandbox.home, 'cron-ready')
  const cliPath = join(sandbox.home, 'idle-power-cli.ts')
  process.env.CLAUDE_CLI_PATH = cliPath
  const executions: Array<ReturnType<typeof cronScheduler.executeTask>> = []
  const services: IdlePowerService[] = []
  const snapshots: PowerActivitySnapshot[] = []
  const recheckRequests: number[] = []
  const dispatch = mock((_action: string) => {})
  const notifications = mock(() => true)
  let lastAction: IdlePowerRecord | null = null
  let prepareDispatch: (() => Promise<void>) | undefined
  const idleSince = Date.now() - 100_000
  const sessionId = crypto.randomUUID()
  const backgroundSessionId = `idle-power-background-${crypto.randomUUID()}`

  function startController() {
    const service = new IdlePowerService({
      settings: { action: 'sleep', scope, countdownSeconds: options.countdownSeconds ?? 0 },
      lastAction,
      capabilities: { lock: true, sleep: true, hibernate: false, shutdown: true },
      async readActivity(signal) {
        const snapshot = await readIdlePowerActivity(access, signal)
        snapshots.push(snapshot)
        return snapshot
      },
      async execute(action, beforeExecute) {
        await prepareDispatch?.()
        const requestsBeforeGuard = requestCount
        try {
          await beforeExecute()
        } finally {
          recheckRequests.push(requestCount - requestsBeforeGuard)
        }
        dispatch(action)
      },
      save(value) { lastAction = value.lastAction },
      notifyCountdown: notifications,
      notifyNotice: () => {},
      onChange: () => {},
      getIdleSeconds: () => Math.floor((Date.now() - idleSince) / 1000),
      pollIntervalMs: 10,
      quietPeriodMs: options.quietPeriodMs ?? 20,
    })
    services.push(service)
    service.start()
    return service
  }

  cleanupHarness = async () => {
    for (const service of services) service.dispose()
    computerUseApprovalService.cancelSession(sessionId)
    await writeFile(releasePath, 'cleanup')
    await Promise.allSettled(executions)
    server.stop(true)
    handler.__resetWebSocketHandlerStateForTests()
    resetTerminalShellEnvironmentCacheForTests()
    expect(cronScheduler.getProcessIds()).toEqual([])
    expect(unauthorizedRequests).toBe(0)
    expect(forbiddenRequests).toEqual([])
  }

  await writeFile(cliPath, [
    "import { existsSync, writeFileSync } from 'node:fs'",
    `writeFileSync(${JSON.stringify(readyPath)}, 'ready')`,
    'const deadline = Date.now() + 5_000',
    `while (!existsSync(${JSON.stringify(releasePath)}) && Date.now() < deadline) await Bun.sleep(5)`,
    `if (!existsSync(${JSON.stringify(releasePath)})) process.exit(2)`,
    "console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'fixture complete' }))",
  ].join('\n'))
  const task = await new CronService().createTask({
    cron: '* * * * *', prompt: 'offline power completion fixture', folderPath: sandbox.home, recurring: true,
  })

  async function observePolls(count = 6) {
    const target = snapshots.length + count
    await waitFor(() => snapshots.length >= target, 'fresh activity HTTP polls')
  }

  return {
    ...handler, activeBackgroundTaskIds, computerUseApprovalService, sessionId, backgroundSessionId,
    snapshots, recheckRequests, dispatch, notifications, startController, observePolls,
    ready: () => existsSync(readyPath),
    release: () => writeFile(releasePath, 'complete'),
    runScheduled() {
      const execution = cronScheduler.executeTask(task)
      executions.push(execution)
      return execution
    },
    prepare(callback: () => Promise<void>) { prepareDispatch = callback },
  }
}

test('scheduled CLI completion crosses the real HTTP reader and waits for all work before one guarded dispatch', async () => {
  const h = await startHarness('scheduled')
  const service = h.startController()
  await h.observePolls(1)
  const baseline = h.snapshots.at(-1)!
  expect(baseline.busy).toBe(false)

  // Use existing admission/background ownership seams; the approval and cron
  // producers, activity route, HTTP reader and controller are real instances.
  h.__registerPendingUserTurnForTests(h.sessionId)
  h.activeBackgroundTaskIds.set(h.backgroundSessionId, new Set(['fixture-shell']))
  const approvalId = `idle-power-approval-${crypto.randomUUID()}`
  const approval = h.computerUseApprovalService.requestApproval(h.sessionId, {
    requestId: approvalId, reason: 'offline fixture decision', apps: [], requestedFlags: {}, screenshotFiltering: 'none',
  }).catch(error => error)
  const scheduled = h.runScheduled()
  await waitFor(h.ready, 'scheduled fixture subprocess startup')
  await h.observePolls()
  expect(h.snapshots.at(-1)?.busy).toBe(true)
  expect(h.dispatch).not.toHaveBeenCalled()

  await h.release()
  expect((await scheduled).status).toBe('completed')
  await h.observePolls()
  expect(h.snapshots.at(-1)).toMatchObject({ busy: true, scheduledCompletionSequence: baseline.scheduledCompletionSequence + 1 })
  expect(h.dispatch).not.toHaveBeenCalled()

  h.__settleActiveTurnForTests(h.sessionId, { type: 'result', subtype: 'success', is_error: false })
  await h.observePolls()
  expect(h.snapshots.at(-1)?.busy).toBe(true)
  expect(h.dispatch).not.toHaveBeenCalled()
  h.activeBackgroundTaskIds.delete(h.backgroundSessionId)
  await h.observePolls()
  expect(h.snapshots.at(-1)?.busy).toBe(true)
  expect(h.dispatch).not.toHaveBeenCalled()

  expect(h.computerUseApprovalService.resolveApproval(approvalId, {
    granted: [], denied: [], flags: { clipboardRead: false, clipboardWrite: false, systemKeyCombos: false },
  })).toBe(true)
  await approval
  await waitFor(() => service.getState().lastAction?.result === 'accepted', 'guarded OS dispatch')
  expect(h.dispatch).toHaveBeenCalledTimes(1)
  expect(h.dispatch).toHaveBeenCalledWith('sleep')
  expect(h.recheckRequests).toEqual([1])
  expect(h.notifications).toHaveBeenCalledTimes(1)
  await h.observePolls()
  expect(h.dispatch).toHaveBeenCalledTimes(1)

  service.dispose()
  const restarted = h.startController()
  await h.observePolls(8)
  expect(restarted.getState().countdown).toBeNull()
  expect(h.dispatch).toHaveBeenCalledTimes(1)
  expect((await h.runScheduled()).status).toBe('completed')
  await waitFor(() => h.dispatch.mock.calls.length === 2, 'a new scheduled completion after restart')
  await h.observePolls()
  expect(h.dispatch).toHaveBeenCalledTimes(2)
  expect(h.recheckRequests).toEqual([1, 1])
}, 15_000)

test('the final HTTP recheck cancels when new work starts and finishes during platform preparation', async () => {
  const h = await startHarness('any')
  let releasePreparation!: () => void
  let preparing = false
  h.prepare(async () => {
    preparing = true
    await new Promise<void>(resolve => { releasePreparation = resolve })
  })
  const service = h.startController()
  await h.observePolls(1)
  h.__markActiveTurnForTests(h.sessionId)
  h.__settleActiveTurnForTests(h.sessionId, { type: 'result', is_error: false })
  await waitFor(() => preparing, 'mock OS preparation after countdown')
  try {
    h.__markActiveTurnForTests(h.sessionId)
    h.__settleActiveTurnForTests(h.sessionId, { type: 'result', is_error: false })
  } finally {
    releasePreparation()
  }
  await waitFor(() => service.getState().notice === 'new-work', 'fresh activity rejection')
  expect(h.snapshots.at(-1)?.busy).toBe(false)
  expect(h.recheckRequests).toEqual([1])
  expect(h.dispatch).not.toHaveBeenCalled()
  await h.observePolls(8)
  expect(h.dispatch).not.toHaveBeenCalled()
  expect(service.getState().countdown).toBeNull()
}, 10_000)

test('replayed subagent completion preserves live ownership and new work resets quiet time and cancels countdown', async () => {
  const h = await startHarness('any', { countdownSeconds: 30, quietPeriodMs: 1_000 })
  const { SessionService } = await import('../services/sessionService.js')
  const { getSubagentRunByTool } = await import('../services/subagentRunService.js')
  const { conversationService } = await import('../services/conversationService.js')
  const toolUseId = 'ordinary-agent-tool'
  const agentId = 'ordinary-agent'
  const project = join(sandbox.configDir, 'projects', 'idle-power-subagent')
  const transcript = join(project, `${h.sessionId}.jsonl`)
  const subagents = join(project, h.sessionId, 'subagents')
  await mkdir(subagents, { recursive: true })
  await writeFile(transcript, [
    { type: 'session-meta', workDir: sandbox.home },
    { type: 'assistant', uuid: 'agent-use', message: { role: 'assistant', content: [
      { type: 'tool_use', id: toolUseId, name: 'Agent', input: { description: 'Offline exploration', prompt: 'Read fixture files' } },
    ] } },
    { type: 'user', uuid: 'agent-launch', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: toolUseId, content: `Async agent launched successfully.\nagentId: ${agentId}\nThe agent is working in the background.` },
    ] } },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n')
  await writeFile(join(subagents, `agent-${agentId}.jsonl`), JSON.stringify({
    type: 'assistant', uuid: 'agent-answer', timestamp: '2026-01-01T00:00:02.000Z',
    message: { role: 'assistant', content: 'Fixture exploration complete' },
  }) + '\n')

  let cliOutput: (message: Record<string, unknown>) => void = () => { throw new Error('CLI output not attached') }
  spyOn(conversationService, 'hasSession').mockImplementation(id => id === h.sessionId)
  spyOn(conversationService, 'getActiveSessions').mockReturnValue([h.sessionId])
  spyOn(conversationService, 'onOutput').mockImplementation((_id, callback) => { cliOutput = callback })
  spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
  const socket = {
    data: { sessionId: h.sessionId, channel: 'client', clientKind: 'full', connectedAt: Date.now(), sdkToken: null, serverPort: 0, serverHost: '127.0.0.1' },
    send: mock(() => {}), close: mock(() => {}),
  } as unknown as Parameters<typeof h.handleWebSocket.open>[0]
  h.handleWebSocket.open(socket)
  const startTask = (taskId: string, taskType = 'local_bash', tool = `tool-${taskId}`) => cliOutput({
    type: 'system', subtype: 'task_started', task_id: taskId, task_type: taskType, tool_use_id: tool,
  })
  async function completeTask(taskId: string, tool = `tool-${taskId}`) {
    const terminal = { type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: tool,
      status: 'completed', summary: 'Fixture task complete', timestamp: '2026-01-01T00:00:03.000Z', uuid: `terminal-${taskId}` }
    cliOutput(terminal)
    await h.__persistCliTaskNotificationForTests(h.sessionId, terminal, { propagateFailure: true })
    return terminal
  }
  let now = Date.now()
  spyOn(Date, 'now').mockImplementation(() => now)
  const service = h.startController()
  try {
    await h.observePolls(2)
    const baseline = h.snapshots.at(-1)!
    h.markSessionChatQueued(h.sessionId)
    cliOutput({ type: 'system', subtype: 'session_state_changed', state: 'running' })
    startTask(agentId, 'local_agent', toolUseId)
    startTask('still-live-shell')
    cliOutput({ type: 'result', is_error: false, result: 'Root finished; background work remains' })
    expect(await getSubagentRunByTool(h.sessionId, toolUseId)).toMatchObject({ status: 'running' })
    const terminal = await completeTask(agentId, toolUseId)
    const xml = `<task-notification><task-id>${agentId}</task-id><tool-use-id>${toolUseId}</tool-use-id><status>completed</status><summary>${terminal.summary}</summary></task-notification>`
    for (const entry of [
      { type: 'queue-operation', content: xml },
      { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: xml } },
      { type: 'user', uuid: 'delivered-terminal', message: { role: 'user', content: xml } },
    ]) await appendFile(transcript, JSON.stringify({ ...entry, timestamp: terminal.timestamp }) + '\n')
    const reloaded = new SessionService()
    const lookup = await reloaded.getSubagentRunLookup(h.sessionId, toolUseId)
    expect(lookup.taskNotifications).toEqual(await reloaded.getSessionTaskNotifications(h.sessionId))
    expect(lookup.taskNotifications).toHaveLength(1)
    expect(await getSubagentRunByTool(h.sessionId, toolUseId)).toMatchObject({
      status: 'completed', canSendMessage: false, source: 'subagent-jsonl',
      messages: [{ content: 'Fixture exploration complete' }],
    })
    cliOutput(terminal)
    await h.observePolls(2)
    expect(h.snapshots.at(-1)).toMatchObject({ busy: true, completionSequence: baseline.completionSequence + 2 })
    expect(h.notifications).not.toHaveBeenCalled()

    // A durable ordinary-agent terminal cannot manufacture the missing raw
    // CLI idle boundary, even after its last background task finishes.
    await completeTask('still-live-shell')
    await h.observePolls(2)
    expect(h.activeBackgroundTaskIds.has(h.sessionId)).toBe(false)
    expect(h.snapshots.at(-1)?.busy).toBe(true)
    expect(h.getSessionChatActivityState(h.sessionId)).toBe('running')
    // After that boundary arrives, detached background work still owns busy.
    startTask('independent-shell')
    cliOutput({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    await h.observePolls(2)
    expect(h.snapshots.at(-1)?.busy).toBe(true)
    expect(h.activeBackgroundTaskIds.get(h.sessionId)).toEqual(new Set(['independent-shell']))
    const approvalId = `subagent-power-approval-${crypto.randomUUID()}`
    const approval = h.computerUseApprovalService.requestApproval(h.sessionId, {
      requestId: approvalId, reason: 'Independent fixture decision', apps: [], requestedFlags: {}, screenshotFiltering: 'none',
    }).catch(error => error)
    await completeTask('independent-shell')
    await h.observePolls(2)
    expect(h.activeBackgroundTaskIds.has(h.sessionId)).toBe(false)
    expect(h.snapshots.at(-1)?.busy).toBe(true)
    expect(h.notifications).not.toHaveBeenCalled()
    expect(h.computerUseApprovalService.resolveApproval(approvalId, {
      granted: [], denied: [], flags: { clipboardRead: false, clipboardWrite: false, systemKeyCombos: false },
    })).toBe(true)
    await approval
    await h.observePolls(2)
    expect(h.snapshots.at(-1)?.busy).toBe(false)

    now += 500
    startTask('quiet-period-work')
    await h.observePolls(2)
    now += 2_000
    await h.observePolls(2)
    expect(h.notifications).not.toHaveBeenCalled()
    await completeTask('quiet-period-work')
    await h.observePolls(2)
    now += 999
    await h.observePolls(2)
    expect(service.getState().countdown).toBeNull()
    now += 1
    await waitFor(() => service.getState().countdown !== null, 'quiet period after fresh work')
    expect(h.notifications).toHaveBeenCalledTimes(1)
    expect(service.getState().countdown?.deadline).toBe(now + 30_000)

    startTask('countdown-work')
    await waitFor(() => service.getState().notice === 'new-work', 'live task cancels countdown')
    expect(service.getState().countdown).toBeNull()
    now += 30_001
    await h.observePolls(2)
    expect(h.dispatch).not.toHaveBeenCalled()
    const finalTerminal = await completeTask('countdown-work')
    await h.observePolls(2)
    now += 1_000
    await waitFor(() => service.getState().countdown !== null, 'new completion countdown')
    expect(h.notifications).toHaveBeenCalledTimes(2)
    now += 30_000
    await waitFor(() => service.getState().lastAction?.result === 'accepted', 'one guarded dispatch after final completion')
    expect(h.dispatch).toHaveBeenCalledTimes(1)
    expect(h.recheckRequests).toEqual([1])
    cliOutput(terminal)
    cliOutput(finalTerminal)
    await h.observePolls(8)
    expect(h.snapshots.at(-1)).toMatchObject({ busy: false, completionSequence: baseline.completionSequence + 6 })
    expect(h.notifications).toHaveBeenCalledTimes(2)
    expect(h.dispatch).toHaveBeenCalledTimes(1)
  } finally {
    h.handleWebSocket.close(socket, 1000, 'fixture complete')
  }
}, 15_000)
