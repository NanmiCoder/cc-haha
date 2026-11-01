import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
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
  const deadline = Date.now() + 5_000
  while (!(await condition()) && Date.now() < deadline) await Bun.sleep(5)
  if (!(await condition())) throw new Error(`Timed out waiting for ${label}`)
}

async function startHarness(scope: IdlePowerSettings['scope']) {
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
  const sessionId = `idle-power-main-${crypto.randomUUID()}`
  const backgroundSessionId = `idle-power-background-${crypto.randomUUID()}`

  function startController() {
    const service = new IdlePowerService({
      settings: { action: 'sleep', scope, countdownSeconds: 0 },
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
      quietPeriodMs: 20,
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
