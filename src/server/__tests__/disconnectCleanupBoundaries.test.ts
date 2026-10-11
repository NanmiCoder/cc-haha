import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import {
  __enqueueRuntimeTransitionForTests,
  __markActiveTurnForTests,
  __resetWebSocketHandlerStateForTests,
  __settleActiveTurnForTests,
  handleWebSocket,
} from '../ws/handler.js'
import { __resetDisconnectGraceMsForTests } from '../ws/disconnectGraceConfig.js'
import { conversationService } from '../services/conversationService.js'
import { computerUseApprovalService } from '../services/computerUseApprovalService.js'
import { sessionService } from '../services/sessionService.js'
import { SettingsService } from '../services/settingsService.js'
import { ProviderService } from '../services/providerService.js'
import { migrationMaintenance } from '../migrationMaintenance.js'

/**
 * Issue #1485: after the last client disconnects, cleanup must still reach a
 * CLI whose idle grace expires mid-startup, and a CLI whose user turn ends
 * before reaching it. Both used to leave a live runtime with no timer at all.
 */

const GRACE_MS = 30_000
const HOUR = 60 * 60_000

async function flush(count = 60) {
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
  const live = (delay: number) => timers.filter(timer => timer.delay === delay && !timer.cancelled && !timer.fired)
  return { timers, advance, live, now: () => now }
}

function installRuntime(sessionId: string, clock: ReturnType<typeof installClock>, alive: boolean) {
  const callbacks = new Set<(message: any) => void>()
  const runtime = { alive, stops: [] as Array<{ at: number; alive: boolean }> }
  spyOn(conversationService, 'hasSession').mockImplementation((id: string) => id === sessionId && runtime.alive)
  spyOn(conversationService, 'stopSession').mockImplementation(((id: string) => {
    if (id !== sessionId) return
    runtime.stops.push({ at: clock.now(), alive: runtime.alive })
    runtime.alive = false
  }) as any)
  // ConversationService.onOutput ignores callbacks until startSession registers the runtime.
  spyOn(conversationService, 'onOutput').mockImplementation((_id: string, callback: any) => { if (runtime.alive) callbacks.add(callback) })
  spyOn(conversationService, 'removeOutputCallback').mockImplementation((_id: string, callback: any) => { callbacks.delete(callback) })
  spyOn(conversationService, 'clearOutputCallbacks').mockImplementation(() => { callbacks.clear() })
  spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
  spyOn(conversationService, 'getRecentSdkMessages').mockReturnValue([])
  spyOn(conversationService, 'sendInterrupt').mockReturnValue(true)
  spyOn(conversationService, 'requestControl').mockResolvedValue({} as any)
  spyOn(computerUseApprovalService, 'getPendingRequests').mockReturnValue([])
  spyOn(computerUseApprovalService, 'cancelSession').mockImplementation(() => {})
  spyOn(sessionService, 'getCustomTitle').mockResolvedValue('Existing title')
  spyOn(sessionService, 'appendSessionTaskNotification').mockResolvedValue()
  const dispatch = (message: any) => { for (const callback of [...callbacks]) callback(message) }
  return { runtime, dispatch }
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

afterEach(() => {
  __resetWebSocketHandlerStateForTests()
  __resetDisconnectGraceMsForTests()
  migrationMaintenance.resetForTests()
  mock.restore()
})

describe('idle grace that expires while the CLI is still starting', () => {
  function slowPrewarm() {
    const sessionId = `startup-grace-${crypto.randomUUID()}`
    const clock = installClock()
    const { runtime, dispatch } = installRuntime(sessionId, clock, false)
    let finishStartup!: () => void
    spyOn(conversationService, 'startSession').mockImplementation((() => new Promise<void>((resolve) => {
      finishStartup = () => { runtime.alive = true; resolve() }
    })) as any)
    spyOn(sessionService, 'getSessionWorkDir').mockResolvedValue('/tmp/startup-grace-fixture')
    spyOn(sessionService, 'getSessionLaunchInfo').mockResolvedValue({
      runtimeModelId: 'fixture-model', runtimeProviderId: 'fixture-provider', permissionMode: 'default', transcriptMessageCount: 0,
    } as any)
    spyOn(ProviderService.prototype, 'listProviders').mockResolvedValue({ activeId: 'fixture-provider', providers: [{ id: 'fixture-provider' }] } as any)
    spyOn(ProviderService.prototype, 'getProvider').mockResolvedValue(null as any)
    spyOn(SettingsService.prototype, 'getUserSettings').mockResolvedValue({} as any)
    return { sessionId, clock, runtime, dispatch, finishStartup: () => finishStartup() }
  }

  async function openNewConversationAndLeave(s: ReturnType<typeof slowPrewarm>) {
    const ws = client(s.sessionId)
    handleWebSocket.open(ws)
    handleWebSocket.message(ws, JSON.stringify({ type: 'prewarm_session' }))
    await flush(200)
    expect(conversationService.startSession).toHaveBeenCalledTimes(1)
    handleWebSocket.close(ws, 1001, 'new conversation closed while its CLI starts')
    await flush()
  }

  it('stops the CLI once the startup that outlived the grace has registered it', async () => {
    const s = slowPrewarm()
    await openNewConversationAndLeave(s)
    await s.clock.advance(GRACE_MS + 15_000)
    // stopSession cannot reach a runtime that is not registered yet.
    expect(s.runtime.stops.filter(stop => stop.alive)).toHaveLength(0)
    s.finishStartup()
    await flush(200)
    await s.clock.advance(48 * HOUR)
    expect(s.runtime.stops.filter(stop => stop.alive)).toHaveLength(1)
    expect(s.runtime.alive).toBe(false)
  })

  it('keeps the CLI for a client that reconnects while the decision waits on startup', async () => {
    const s = slowPrewarm()
    await openNewConversationAndLeave(s)
    await s.clock.advance(GRACE_MS)
    const returning = client(s.sessionId)
    handleWebSocket.open(returning)
    s.finishStartup()
    await flush(200)
    await s.clock.advance(48 * HOUR)
    expect(s.runtime.alive).toBe(true)

    handleWebSocket.close(returning, 1000, 'tab closed')
    await s.clock.advance(GRACE_MS)
    expect(s.runtime.stops.filter(stop => stop.alive)).toHaveLength(1)
  })

  it('watches work that exists once the startup settles instead of stopping it', async () => {
    const s = slowPrewarm()
    await openNewConversationAndLeave(s)
    await s.clock.advance(GRACE_MS)
    __markActiveTurnForTests(s.sessionId)
    s.finishStartup()
    await flush(200)
    await s.clock.advance(HOUR)
    expect(s.runtime.alive).toBe(true)

    __settleActiveTurnForTests(s.sessionId, { type: 'result', subtype: 'success', is_error: false })
    s.dispatch({ type: 'result', subtype: 'success', is_error: false, result: 'done' })
    await s.clock.advance(GRACE_MS)
    expect(s.runtime.stops.filter(stop => stop.alive)).toHaveLength(1)
  })
})

describe('user turn released before it reaches the CLI', () => {
  it('restarts the idle grace when a runtime switch fails after the renderer left', async () => {
    const sessionId = `presend-transition-${crypto.randomUUID()}`
    const clock = installClock()
    const { runtime } = installRuntime(sessionId, clock, true)
    let failTransition!: (error: Error) => void
    void __enqueueRuntimeTransitionForTests(sessionId, new Promise<void>((_resolve, reject) => { failTransition = reject }))
      .catch(() => {})
    const ws = client(sessionId)
    handleWebSocket.open(ws)
    handleWebSocket.message(ws, JSON.stringify({ type: 'user_message', content: 'continue' }))
    await flush()
    handleWebSocket.close(ws, 1001, 'window reloaded while switching model')
    await flush()
    expect(clock.live(GRACE_MS)).toHaveLength(0)

    failTransition(new Error('provider switch failed'))
    await flush(200)
    expect(clock.live(GRACE_MS)).toHaveLength(1)
    await clock.advance(GRACE_MS)
    expect(runtime.stops).toEqual([{ at: GRACE_MS, alive: true }])
  })

  it('restarts the idle grace when the CLI refuses a turn the renderer no longer watches', async () => {
    const sessionId = `presend-refused-${crypto.randomUUID()}`
    const clock = installClock()
    const { runtime } = installRuntime(sessionId, clock, true)
    let refuse!: () => void
    spyOn(conversationService, 'sendMessage').mockImplementation((() => new Promise<boolean>((resolve) => {
      refuse = () => resolve(false)
    })) as any)
    const ws = client(sessionId)
    handleWebSocket.open(ws)
    handleWebSocket.message(ws, JSON.stringify({ type: 'user_message', content: 'continue' }))
    await flush(200)
    handleWebSocket.close(ws, 1001, 'renderer gone')
    await flush()
    expect(clock.live(GRACE_MS)).toHaveLength(0)

    refuse()
    await flush(200)
    expect(clock.live(GRACE_MS)).toHaveLength(1)
    await clock.advance(GRACE_MS)
    expect(runtime.stops).toEqual([{ at: GRACE_MS, alive: true }])
  })

  it('leaves a connected session alone when its turn fails before send', async () => {
    const sessionId = `presend-connected-${crypto.randomUUID()}`
    const clock = installClock()
    const { runtime } = installRuntime(sessionId, clock, true)
    let failTransition!: (error: Error) => void
    void __enqueueRuntimeTransitionForTests(sessionId, new Promise<void>((_resolve, reject) => { failTransition = reject }))
      .catch(() => {})
    const ws = client(sessionId)
    handleWebSocket.open(ws)
    handleWebSocket.message(ws, JSON.stringify({ type: 'user_message', content: 'continue' }))
    await flush()
    failTransition(new Error('provider switch failed'))
    await flush(200)
    expect(clock.timers).toHaveLength(0)
    expect(runtime.stops).toHaveLength(0)
  })
})
