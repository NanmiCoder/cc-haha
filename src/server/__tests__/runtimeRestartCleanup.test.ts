import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import {
  __resetWebSocketHandlerStateForTests,
  getSessionTurnState,
  handleWebSocket,
} from '../ws/handler.js'
import {
  __resetDisconnectGraceMsForTests,
  __setDisconnectGraceMsForTests,
} from '../ws/disconnectGraceConfig.js'
import { conversationService } from '../services/conversationService.js'
import { computerUseApprovalService } from '../services/computerUseApprovalService.js'
import { sessionService } from '../services/sessionService.js'
import { SettingsService } from '../services/settingsService.js'
import { ProviderService } from '../services/providerService.js'
import * as teamPlanRuntime from '../services/teamPlanRuntime.js'
import { migrationMaintenance } from '../migrationMaintenance.js'

/**
 * Issue #1485: a model or permission switch replaces the session's CLI. The
 * replaced CLI's own `idle` frame is lost (its retired SDK token is rejected, or
 * it never sends one while shutting down), and any disconnect watcher was bound
 * to its output. The replacement must still be reclaimed once nobody watches.
 */

const GRACE_MS = 30_000
const TWO_DAYS_MS = 48 * 60 * 60_000

async function flush(count = 200) {
  for (let i = 0; i < count; i++) await Promise.resolve()
}

type FakeTimer = { id: number; run: () => void; delay: number; dueAt: number; cancelled: boolean; fired: boolean }

function installClock() {
  let now = 0
  let nextId = 1
  const timers: FakeTimer[] = []
  spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: any[]) => void, delay = 0, ...args: any[]) => {
    const ms = Number(delay) || 0
    const timer: FakeTimer = { id: nextId++, run: () => callback(...args), delay: ms, dueAt: now + ms, cancelled: false, fired: false }
    timers.push(timer)
    return timer.id as any
  }) as any)
  spyOn(globalThis, 'clearTimeout').mockImplementation(((id: any) => {
    const timer = timers.find(entry => entry.id === id)
    if (timer) timer.cancelled = true
  }) as any)
  async function advance(ms: number) {
    const target = now + ms
    for (;;) {
      const due = timers
        .filter(timer => !timer.cancelled && !timer.fired && timer.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id)[0]
      if (!due) break
      now = due.dueAt
      due.fired = true
      due.run()
      await flush()
    }
    now = target
  }
  return { advance, now: () => now }
}

/** A runtime whose CLI generations can be replaced; a start can be held open. */
function installRuntime(sessionId: string, clock: ReturnType<typeof installClock>) {
  const callbacks = new Set<(message: any) => void>()
  const runtime = {
    alive: true,
    generation: 1,
    stops: [] as Array<{ at: number; generation: number; alive: boolean }>,
    held: null as Promise<void> | null,
  }
  spyOn(conversationService, 'hasSession').mockImplementation((id: string) => id === sessionId && runtime.alive)
  spyOn(conversationService, 'stopSession').mockImplementation(((id: string) => {
    if (id !== sessionId) return
    runtime.stops.push({ at: clock.now(), generation: runtime.generation, alive: runtime.alive })
    runtime.alive = false
    callbacks.clear()
  }) as any)
  spyOn(conversationService, 'startSession').mockImplementation((async () => {
    const held = runtime.held
    runtime.held = null
    if (held) await held
    runtime.generation += 1
    runtime.alive = true
  }) as any)
  spyOn(conversationService, 'onOutput').mockImplementation((_id: string, callback: any) => { if (runtime.alive) callbacks.add(callback) })
  spyOn(conversationService, 'removeOutputCallback').mockImplementation((_id: string, callback: any) => { callbacks.delete(callback) })
  spyOn(conversationService, 'clearOutputCallbacks').mockImplementation(() => { callbacks.clear() })
  spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
  spyOn(conversationService, 'getRecentSdkMessages').mockReturnValue([])
  spyOn(conversationService, 'sendInterrupt').mockReturnValue(true)
  spyOn(conversationService, 'sendMessage').mockImplementation((async (_id: string, _content: string, _attachments: unknown, options: any) => {
    options?.onCommitted?.()
    return true
  }) as any)
  spyOn(conversationService, 'requestControl').mockResolvedValue({} as any)
  spyOn(conversationService, 'getSessionWorkDir').mockReturnValue('/tmp/runtime-restart-fixture')
  spyOn(computerUseApprovalService, 'getPendingRequests').mockReturnValue([])
  spyOn(computerUseApprovalService, 'cancelSession').mockImplementation(() => {})
  spyOn(sessionService, 'getCustomTitle').mockResolvedValue('Existing title')
  spyOn(sessionService, 'appendSessionTaskNotification').mockResolvedValue()
  spyOn(sessionService, 'appendSessionMetadata').mockResolvedValue(undefined as any)
  spyOn(sessionService, 'getSessionWorkDir').mockResolvedValue('/tmp/runtime-restart-fixture')
  spyOn(sessionService, 'getSessionLaunchInfo').mockResolvedValue({
    runtimeModelId: 'fixture-model', runtimeProviderId: 'fixture-provider', permissionMode: 'default', transcriptMessageCount: 3,
  } as any)
  spyOn(ProviderService.prototype, 'listProviders').mockResolvedValue({ activeId: 'fixture-provider', providers: [{ id: 'fixture-provider' }] } as any)
  spyOn(ProviderService.prototype, 'getProvider').mockResolvedValue(null as any)
  spyOn(SettingsService.prototype, 'getUserSettings').mockResolvedValue({} as any)
  spyOn(teamPlanRuntime, 'hasActiveTeamWorkForParent').mockReturnValue(false)
  const dispatch = (message: any) => { for (const callback of [...callbacks]) callback(message) }
  const holdNextStart = () => {
    let release!: () => void
    runtime.held = new Promise<void>((resolve) => { release = resolve })
    return release
  }
  const replacementStops = () => runtime.stops.filter(stop => stop.generation === 2 && stop.alive)
  return { runtime, dispatch, holdNextStart, replacementStops }
}

function client(sessionId: string) {
  const sent: any[] = []
  return {
    data: { sessionId, channel: 'client', clientKind: 'full', connectedAt: Date.now(), sdkToken: null, serverPort: 0, serverHost: '127.0.0.1' },
    send: mock((payload: string) => { sent.push(JSON.parse(payload)) }),
    close: mock(() => {}),
    sent,
  } as any
}

const switchModel = JSON.stringify({ type: 'set_runtime_config', providerId: 'fixture-provider', modelId: 'other-model' })
const cliIdle = { type: 'system', subtype: 'session_state_changed', state: 'idle' }

afterEach(() => {
  __resetWebSocketHandlerStateForTests()
  __resetDisconnectGraceMsForTests()
  migrationMaintenance.resetForTests()
  mock.restore()
})

describe('reclaiming a CLI that replaced another one', () => {
  it('a model switch deferred behind a running turn: the replacement goes once the renderer leaves', async () => {
    const sessionId = `restart-deferred-${crypto.randomUUID()}`
    const clock = installClock()
    const { runtime, dispatch, replacementStops } = installRuntime(sessionId, clock)
    const ws = client(sessionId)
    handleWebSocket.open(ws)
    handleWebSocket.message(ws, JSON.stringify({ type: 'user_message', content: 'refactor the module' }))
    await flush()
    dispatch({ type: 'system', subtype: 'session_state_changed', state: 'running' })
    handleWebSocket.message(ws, switchModel)
    await flush(2000)
    expect(runtime.generation).toBe(1)

    // print.ts sends `result`, then `idle` in a separate frame. The restart runs
    // on `result`, so that idle belongs to a retired runtime and never counts.
    dispatch({ type: 'result', subtype: 'success', is_error: false, result: 'done' })
    await flush(2000)
    expect(runtime.generation).toBe(2)
    dispatch(cliIdle)

    handleWebSocket.close(ws, 1001, 'window closed')
    await flush()
    await clock.advance(TWO_DAYS_MS)

    expect(replacementStops()).toEqual([{ at: GRACE_MS, generation: 2, alive: true }])
  })

  it('a model switch while the run waits on a background shell: clients see the replaced run end', async () => {
    const sessionId = `restart-shell-${crypto.randomUUID()}`
    const clock = installClock()
    const { runtime, dispatch, replacementStops } = installRuntime(sessionId, clock)
    const ws = client(sessionId)
    handleWebSocket.open(ws)
    handleWebSocket.message(ws, JSON.stringify({ type: 'user_message', content: 'start the dev server in the background' }))
    await flush()
    dispatch({ type: 'system', subtype: 'session_state_changed', state: 'running' })
    dispatch({ type: 'system', subtype: 'task_started', task_id: 'bash-1', tool_use_id: 'tool-bash-1', task_type: 'local_bash' })
    dispatch({ type: 'result', subtype: 'success', is_error: false, result: 'dev server started' })
    await flush()
    expect(getSessionTurnState(sessionId)).toBe('running')

    handleWebSocket.message(ws, switchModel)
    await flush(2000)
    await clock.advance(0)
    await flush(2000)
    expect(runtime.generation).toBe(2)
    // A hidden desktop session is released once its CLI reports idle; the
    // replaced CLI can no longer report it, so the server does.
    expect(ws.sent).toContainEqual({
      type: 'system_notification',
      subtype: 'session_state_changed',
      data: { type: 'system', subtype: 'session_state_changed', state: 'idle' },
    })
    expect(getSessionTurnState(sessionId)).toBe('idle')

    handleWebSocket.close(ws, 1001, 'window closed')
    await flush()
    await clock.advance(TWO_DAYS_MS)

    expect(replacementStops()).toEqual([{ at: GRACE_MS, generation: 2, alive: true }])
  })

  it('an idle grace that expires while a restart is still starting decides once it settles', async () => {
    const sessionId = `restart-grace-${crypto.randomUUID()}`
    __setDisconnectGraceMsForTests(5_000)
    const clock = installClock()
    const { runtime, holdNextStart, replacementStops } = installRuntime(sessionId, clock)
    const ws = client(sessionId)
    handleWebSocket.open(ws)
    const releaseStart = holdNextStart()
    handleWebSocket.message(ws, switchModel)
    await flush(2000)
    expect(runtime.stops.map(stop => stop.generation)).toEqual([1])

    handleWebSocket.close(ws, 1001, 'window closed during the model switch')
    await flush()
    await clock.advance(5_000)
    // Nothing is torn down while the replacement is still starting...
    expect(runtime.stops).toEqual([{ at: 0, generation: 1, alive: true }])
    releaseStart()
    await flush(2000)
    await clock.advance(TWO_DAYS_MS)

    // ...and once it is up, nobody watches it: it gets a fresh idle grace.
    expect(runtime.stops).toEqual([
      { at: 0, generation: 1, alive: true },
      { at: 10_000, generation: 2, alive: true },
    ])
    expect(runtime.alive).toBe(false)
  })

  it('a model switch deferred behind a turn that ends after the renderer left: the replacement still goes', async () => {
    const sessionId = `restart-unwatched-${crypto.randomUUID()}`
    const clock = installClock()
    const { runtime, dispatch, replacementStops } = installRuntime(sessionId, clock)
    const ws = client(sessionId)
    handleWebSocket.open(ws)
    handleWebSocket.message(ws, JSON.stringify({ type: 'user_message', content: 'refactor the module' }))
    await flush()
    dispatch({ type: 'system', subtype: 'session_state_changed', state: 'running' })
    handleWebSocket.message(ws, switchModel)
    await flush(2000)
    handleWebSocket.close(ws, 1001, 'window closed mid-turn')
    await flush()

    // The turn ends with nobody watching; the deferred restart runs now, and
    // the disconnect watcher it left behind was bound to the retired runtime.
    dispatch({ type: 'result', subtype: 'success', is_error: false, result: 'done' })
    await flush(2000)
    expect(runtime.generation).toBe(2)
    await clock.advance(TWO_DAYS_MS)

    expect(replacementStops()).toEqual([{ at: GRACE_MS, generation: 2, alive: true }])
  })
})
