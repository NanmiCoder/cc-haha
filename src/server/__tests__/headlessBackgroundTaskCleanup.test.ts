import { afterEach, expect, test, mock, spyOn } from 'bun:test'
import {
  __resetWebSocketHandlerStateForTests,
  ensureCliSessionStartedForControl,
  getSessionChatActivityState,
  getSessionTurnState,
} from '../ws/handler.js'
import { activeNonAgentTasks } from '../ws/agentTaskState.js'
import { conversationService } from '../services/conversationService.js'
import { computerUseApprovalService } from '../services/computerUseApprovalService.js'
import { sessionService } from '../services/sessionService.js'
import { SettingsService } from '../services/settingsService.js'
import { ProviderService } from '../services/providerService.js'
import { migrationMaintenance } from '../migrationMaintenance.js'

async function flushMicrotasks() {
  for (let index = 0; index < 30; index++) await Promise.resolve()
}

function setup() {
  const sessionId = `headless-background-${crypto.randomUUID()}`
  const callbacks = new Set<(message: any) => void>()
  const timers: Array<{ callback: () => void; delay: number }> = []
  let runtimeAlive = false
  spyOn(conversationService, 'hasSession').mockImplementation(() => runtimeAlive)
  const start = spyOn(conversationService, 'startSession').mockImplementation(async () => { runtimeAlive = true })
  const stop = spyOn(conversationService, 'stopSession').mockImplementation(() => { runtimeAlive = false })
  spyOn(conversationService, 'onOutput').mockImplementation((_id, callback) => { callbacks.add(callback) })
  spyOn(conversationService, 'removeOutputCallback').mockImplementation((_id, callback) => { callbacks.delete(callback) })
  spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
  spyOn(computerUseApprovalService, 'getPendingRequests').mockReturnValue([])
  spyOn(sessionService, 'getSessionWorkDir').mockResolvedValue('/tmp/headless-control-fixture')
  spyOn(sessionService, 'getSessionLaunchInfo').mockResolvedValue({
    runtimeModelId: 'fixture-model', runtimeProviderId: 'fixture-provider', permissionMode: 'default',
  } as any)
  spyOn(ProviderService.prototype, 'listProviders').mockResolvedValue({
    activeId: 'fixture-provider', providers: [{ id: 'fixture-provider' }],
  } as any)
  spyOn(ProviderService.prototype, 'getProvider').mockResolvedValue(null)
  spyOn(SettingsService.prototype, 'getUserSettings').mockResolvedValue({})
  const append = spyOn(sessionService, 'appendSessionTaskNotification').mockResolvedValue()
  spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay = 0) => {
    timers.push({ callback, delay })
    return timers.length as any
  }) as any)
  spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})
  function dispatch(message: any) { for (const callback of [...callbacks]) callback(message) }
  function task(id = 'headless-shell') {
    dispatch({ type: 'system', subtype: 'task_started', task_id: id, tool_use_id: `tool-${id}`, task_type: 'local_bash' })
  }
  const ensure = () => ensureCliSessionStartedForControl(sessionId, new URL('http://127.0.0.1:12345/api/sessions/control'))
  return { sessionId, callbacks, timers, start, stop, append, dispatch, task, ensure }
}

afterEach(() => {
  __resetWebSocketHandlerStateForTests()
  migrationMaintenance.resetForTests()
  mock.restore()
})

test('a control-started session settles a runtime crash without ever opening a client socket', async () => {
  const s = setup()
  await s.ensure()
  expect(s.start).toHaveBeenCalledTimes(1)
  s.task()
  expect(activeNonAgentTasks.get(s.sessionId)?.has('headless-shell')).toBe(true)
  s.stop(s.sessionId)
  s.dispatch({ type: 'result', is_error: true, result: 'CLI died' })
  await flushMicrotasks()
  expect(s.append).toHaveBeenCalledWith(s.sessionId, expect.objectContaining({ taskId: 'headless-shell', status: 'failed' }))
  expect(activeNonAgentTasks.has(s.sessionId)).toBe(false)
  expect(getSessionTurnState(s.sessionId)).toBe('idle')
  expect(getSessionChatActivityState(s.sessionId)).not.toBe('running')
})

test('a control-started silent shell gets a ceiling without a client disconnect event', async () => {
  const s = setup()
  await s.ensure()
  expect(s.timers.some(timer => timer.delay === 30_000)).toBe(false)
  s.task()
  const ceiling = s.timers.find(timer => timer.delay === 31 * 60_000)
  expect(ceiling).toBeDefined()
  ceiling!.callback()
  await flushMicrotasks()
  expect(s.stop).toHaveBeenCalledWith(s.sessionId)
  expect(s.append).toHaveBeenCalledWith(s.sessionId, expect.objectContaining({ taskId: 'headless-shell', status: 'failed' }))
})

test('initial CLI idle does not arm cleanup ahead of the first headless control request', async () => {
  const s = setup()
  await s.ensure()
  s.dispatch({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
  expect(s.timers.some(timer => timer.delay === 30_000)).toBe(false)
  expect(s.stop).not.toHaveBeenCalled()
})

test('the independent observer does not persist stale task results after its durable runtime-loss bookend', async () => {
  const s = setup()
  await s.ensure()
  s.task()
  s.stop(s.sessionId)
  s.dispatch({ type: 'result', is_error: true, result: 'CLI died' })
  await flushMicrotasks()
  expect(s.append).toHaveBeenCalledWith(s.sessionId, expect.objectContaining({ taskId: 'headless-shell', status: 'failed' }))
  s.append.mockClear()
  s.dispatch({ type: 'system', subtype: 'task_notification', task_id: 'headless-shell', tool_use_id: 'tool-headless-shell', status: 'completed' })
  await flushMicrotasks()
  expect(s.append).not.toHaveBeenCalled()
})
