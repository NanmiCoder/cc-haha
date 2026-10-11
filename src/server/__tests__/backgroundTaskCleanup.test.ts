import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import {
  __markActiveTurnForTests,
  __resetWebSocketHandlerStateForTests,
  getSessionChatActivityState,
  getSessionTurnState,
  handleWebSocket,
  stopSessionTurn,
} from '../ws/handler.js'
import { activeNonAgentTasks, authoritativeStoppedTaskIds, clearAgentRuntimeState } from '../ws/agentTaskState.js'
import { conversationService } from '../services/conversationService.js'
import { computerUseApprovalService } from '../services/computerUseApprovalService.js'
import { sessionService } from '../services/sessionService.js'
import * as teamPlanRuntime from '../services/teamPlanRuntime.js'
import { migrationMaintenance } from '../migrationMaintenance.js'

async function flushMicrotasks() {
  for (let index = 0; index < 30; index++) await Promise.resolve()
}

function setup() {
  const sessionId = `background-cleanup-${crypto.randomUUID()}`
  const clients: any[] = []
  function client() {
    const sent: any[] = []
    const ws: any = {
      data: { sessionId, channel: 'client', clientKind: 'full', connectedAt: Date.now(), sdkToken: null, serverPort: 0, serverHost: '127.0.0.1' },
      send: mock((payload: string) => sent.push(JSON.parse(payload))),
      close: mock(() => {}),
      sent,
    }
    clients.push(ws)
    return ws
  }
  const ws = client()
  const callbacks = new Set<(message: any) => void>()
  const timers: Array<{ id: number; callback: () => void; delay: number }> = []
  const cancelled = new Set<number>()
  let runtimeAlive = true
  spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay = 0) => {
    const id = timers.length + 1
    timers.push({ id, callback, delay })
    return id as any
  }) as any)
  spyOn(globalThis, 'clearTimeout').mockImplementation((id: any) => { cancelled.add(id) })
  spyOn(conversationService, 'hasSession').mockImplementation(() => runtimeAlive)
  const stop = spyOn(conversationService, 'stopSession').mockImplementation(() => { runtimeAlive = false })
  const permissions = spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
  const computerPermissions = spyOn(computerUseApprovalService, 'getPendingRequests').mockReturnValue([])
  spyOn(conversationService, 'onOutput').mockImplementation((_id, callback) => { callbacks.add(callback) })
  spyOn(conversationService, 'removeOutputCallback').mockImplementation((_id, callback) => { callbacks.delete(callback) })
  spyOn(conversationService, 'sendInterrupt').mockReturnValue(true)
  spyOn(conversationService, 'sendMessage').mockResolvedValue(true)
  const control = spyOn(conversationService, 'requestControl').mockResolvedValue({})
  const append = spyOn(sessionService, 'appendSessionTaskNotification').mockResolvedValue()
  spyOn(sessionService, 'getCustomTitle').mockResolvedValue('Existing title')
  const teamWork = spyOn(teamPlanRuntime, 'hasActiveTeamWorkForParent').mockReturnValue(false)
  function dispatch(message: any) { for (const callback of [...callbacks]) callback(message) }
  function startTask(id = 'bash-1', type = 'local_bash') {
    dispatch({ type: 'system', subtype: 'task_started', task_id: id, tool_use_id: `tool-${id}`, task_type: type })
  }
  function close() { handleWebSocket.close(ws, 1000, 'test disconnect') }
  function ceiling() { return timers.findLast(timer => timer.delay === 31 * 60_000) }
  function terminals(socket = ws) {
    return socket.sent.filter((message: any) => message.type === 'system_notification' &&
      message.subtype === 'task_notification' && ['stopped', 'failed'].includes(message.data?.status))
  }
  handleWebSocket.open(ws)
  return { sessionId, ws, client, timers, cancelled, stop, permissions, computerPermissions, control, append, teamWork, dispatch, startTask, close, ceiling, terminals }
}

afterEach(() => {
  __resetWebSocketHandlerStateForTests()
  migrationMaintenance.resetForTests()
  mock.restore()
})

describe('background task cleanup boundaries', () => {
  it('bounds a silent task from disconnect and converges both activity and runtime state', async () => {
    const s = setup()
    s.startTask()
    s.close()
    expect(s.ceiling()).toBeDefined()
    s.ceiling()!.callback()
    await flushMicrotasks()
    expect(s.stop).toHaveBeenCalledWith(s.sessionId)
    expect(s.append).toHaveBeenCalledWith(s.sessionId, expect.objectContaining({ taskId: 'bash-1', status: 'failed' }))
    expect(getSessionChatActivityState(s.sessionId)).toBe('idle')
    expect(getSessionTurnState(s.sessionId)).toBe('idle')
    expect(activeNonAgentTasks.has(s.sessionId)).toBe(false)
    const idleGrace = s.timers.findLast(timer => timer.delay === 30_000)
    expect(idleGrace).toBeDefined()
    idleGrace!.callback()
    expect(authoritativeStoppedTaskIds.has(s.sessionId)).toBe(false)
  })

  // Real CLI frame order (print.ts): a shell task does not hold back the turn's
  // result, and run() stays in its waiting_for_agents loop until the shell
  // ends, so session_state_changed:idle never arrives while it still runs.
  it('starts the shell ceiling from the root result while the CLI run keeps waiting on the shell', async () => {
    const s = setup()
    handleWebSocket.message(s.ws, JSON.stringify({ type: 'user_message', content: 'work' }))
    await flushMicrotasks()
    s.dispatch({ type: 'system', subtype: 'session_state_changed', state: 'running' })
    s.startTask()
    s.close()
    expect(s.ceiling()).toBeUndefined()
    s.dispatch({ type: 'result', subtype: 'success', is_error: false, result: 'done' })
    const ceiling = s.ceiling()
    expect(ceiling).toBeDefined()
    expect(getSessionTurnState(s.sessionId)).toBe('running')
    expect(s.stop).not.toHaveBeenCalled()
    ceiling!.callback()
    await flushMicrotasks()
    expect(s.stop).toHaveBeenCalledWith(s.sessionId)
    expect(s.append).toHaveBeenCalledWith(s.sessionId, expect.objectContaining({ taskId: 'bash-1', status: 'failed' }))
  })

  it('arms the shell ceiling when the renderer leaves after the turn while the shell keeps the CLI running', async () => {
    const s = setup()
    handleWebSocket.message(s.ws, JSON.stringify({ type: 'user_message', content: 'start the dev server' }))
    await flushMicrotasks()
    s.dispatch({ type: 'system', subtype: 'session_state_changed', state: 'running' })
    s.startTask()
    s.dispatch({ type: 'result', subtype: 'success', is_error: false, result: 'started' })
    expect(s.ceiling()).toBeUndefined()
    s.close()
    expect(s.ceiling()).toBeDefined()
    expect(s.timers.some(timer => timer.delay === 30_000)).toBe(false)
  })

  it('lets a task-notification follow-up finish, then re-arms a full ceiling from its own root result', async () => {
    const s = setup()
    handleWebSocket.message(s.ws, JSON.stringify({ type: 'user_message', content: 'work' }))
    await flushMicrotasks()
    s.dispatch({ type: 'system', subtype: 'session_state_changed', state: 'running' })
    s.startTask()
    s.startTask('bash-2')
    s.dispatch({ type: 'result', subtype: 'success', is_error: false, result: 'done' })
    s.close()
    const first = s.ceiling()!
    expect(first).toBeDefined()
    // bash-2 ends while bash-1 keeps running: the same run drains its
    // notification into a root model follow-up (system/init, stream, reply).
    s.dispatch({ type: 'system', subtype: 'task_notification', task_id: 'bash-2', status: 'completed' })
    expect(s.ceiling()!.id).toBe(first.id)
    s.dispatch({ type: 'system', subtype: 'init', session_id: 'cli-session', model: 'fixture-model' })
    expect(s.cancelled.has(first.id)).toBe(true)
    s.dispatch({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } })
    s.dispatch({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'bash-2 finished' }] } })
    first.callback()
    expect(s.stop).not.toHaveBeenCalled()
    expect(s.timers.filter(timer => timer.delay === 31 * 60_000)).toHaveLength(1)
    s.dispatch({ type: 'result', subtype: 'success', is_error: false, result: 'reported' })
    const second = s.ceiling()!
    expect(second.id).not.toBe(first.id)
    expect(second.delay).toBe(31 * 60_000)
    second.callback()
    await flushMicrotasks()
    expect(s.stop).toHaveBeenCalledTimes(1)
  })

  describe('keeps the ceiling off work it must not shorten, in the real frame order', () => {
    async function settledShellTurn(prepare: (s: ReturnType<typeof setup>) => void) {
      const s = setup()
      handleWebSocket.message(s.ws, JSON.stringify({ type: 'user_message', content: 'work' }))
      await flushMicrotasks()
      s.dispatch({ type: 'system', subtype: 'session_state_changed', state: 'running' })
      s.startTask()
      prepare(s)
      s.dispatch({ type: 'result', subtype: 'success', is_error: false, result: 'done' })
      s.close()
      return s
    }
    const liveCeilings = (s: ReturnType<typeof setup>) =>
      s.timers.filter(timer => timer.delay === 31 * 60_000 && !s.cancelled.has(timer.id))

    it('an Agent task', async () => {
      const s = await settledShellTurn(s => s.startTask('agent-1', 'local_agent'))
      expect(liveCeilings(s)).toHaveLength(0)
    })

    it('approved team work', async () => {
      const s = await settledShellTurn(s => s.teamWork.mockReturnValue(true))
      expect(liveCeilings(s)).toHaveLength(0)
    })

    it('a pending tool permission (only its own 31-min bound)', async () => {
      const s = await settledShellTurn(s => s.permissions.mockReturnValue([{ requestId: 'tool-permission', request: { subtype: 'can_use_tool' } }] as any))
      expect(liveCeilings(s)).toHaveLength(1)
      expect(s.timers.filter(timer => timer.delay === 31 * 60_000)).toHaveLength(1)
    })

    it('a pending computer-use approval', async () => {
      const s = await settledShellTurn(s => s.computerPermissions.mockReturnValue([{ requestId: 'computer-permission' }] as any))
      expect(liveCeilings(s)).toHaveLength(0)
    })

    it('a user turn admitted before the ceiling expires', async () => {
      const s = await settledShellTurn(() => {})
      const ceiling = s.ceiling()!
      __markActiveTurnForTests(s.sessionId)
      ceiling.callback()
      expect(s.stop).not.toHaveBeenCalled()
    })
  })

  it('does not reap a foreground run that starts after the shell ceiling was queued', async () => {
    const s = setup()
    s.startTask()
    s.close()
    const old = s.ceiling()!
    s.dispatch({ type: 'system', subtype: 'session_state_changed', state: 'running' })
    old.callback()
    expect(s.stop).not.toHaveBeenCalled()
    expect(getSessionTurnState(s.sessionId)).toBe('running')
    s.dispatch({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    expect(s.ceiling()!.id).not.toBe(old.id)
  })

  it('keeps Agent tasks and approved working teams alive alongside a shell', () => {
    const s = setup()
    s.startTask()
    s.startTask('agent-1', 'local_agent')
    s.close()
    expect(s.ceiling()).toBeUndefined()
    s.dispatch({ type: 'system', subtype: 'task_notification', task_id: 'agent-1', status: 'completed' })
    const beforeTeam = s.ceiling()!
    expect(beforeTeam).toBeDefined()
    s.teamWork.mockReturnValue(true)
    beforeTeam.callback()
    expect(s.stop).not.toHaveBeenCalled()
  })

  it('starts the shell ceiling after a detached Agent finishes its durable stop', async () => {
    const s = setup()
    s.startTask()
    s.startTask('agent-1', 'local_agent')
    await flushMicrotasks()
    let saveAgent!: () => void
    s.append.mockImplementation((_id, notification) => notification.taskId === 'agent-1' && notification.status === 'stopped'
      ? new Promise<void>(resolve => { saveAgent = resolve }) : Promise.resolve())
    handleWebSocket.message(s.ws, JSON.stringify({ type: 'stop_background_task', taskId: 'agent-1' }))
    await flushMicrotasks()
    s.close()
    expect(s.ceiling()).toBeUndefined()
    saveAgent()
    await flushMicrotasks()
    expect(s.ceiling()).toBeDefined()
    expect(s.stop).not.toHaveBeenCalled()
  })

  it('does not use the shell ceiling to shorten a pending tool or computer-use prompt', () => {
    const s = setup()
    s.startTask()
    s.close()
    const original = s.ceiling()!
    s.permissions.mockReturnValue([{ requestId: 'tool-permission', request: { subtype: 'can_use_tool' } }] as any)
    original.callback()
    expect(s.stop).not.toHaveBeenCalled()
    s.permissions.mockReturnValue([])
    s.dispatch({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    const next = s.ceiling()!
    s.computerPermissions.mockReturnValue([{ requestId: 'computer-permission' }] as any)
    next.callback()
    expect(s.stop).not.toHaveBeenCalled()
  })

  it('persists shell bookends when an abandoned permission reaches its own cleanup bound', async () => {
    const s = setup()
    s.startTask()
    s.permissions.mockReturnValue([{ requestId: 'abandoned-permission', request: { subtype: 'can_use_tool' } }] as any)
    s.close()
    // This is the existing permission ceiling, not the background-only ceiling.
    const permissionBound = s.timers.find(timer => timer.delay === 31 * 60_000)!
    expect(permissionBound).toBeDefined()
    permissionBound.callback()
    s.permissions.mockReturnValue([])
    await flushMicrotasks()
    expect(s.stop).toHaveBeenCalledTimes(1)
    expect(s.append).toHaveBeenCalledWith(s.sessionId, expect.objectContaining({ taskId: 'bash-1', status: 'failed' }))
    expect(getSessionTurnState(s.sessionId)).toBe('idle')
    expect(activeNonAgentTasks.get(s.sessionId)?.has('bash-1')).not.toBe(true)
    expect(s.timers.findLast(timer => timer.delay === 30_000)).toBeDefined()
  })

  it('does not kill or persist background tasks during migration maintenance', () => {
    const s = setup()
    s.startTask()
    s.close()
    const timer = s.ceiling()!
    s.append.mockClear()
    migrationMaintenance.begin()
    timer.callback()
    expect(s.stop).not.toHaveBeenCalled()
    expect(s.append).not.toHaveBeenCalled()
  })

  it('ignores a queued old ceiling after reconnect and a second disconnect', () => {
    const s = setup()
    s.startTask()
    s.close()
    const old = s.ceiling()!
    const reconnected = s.client()
    handleWebSocket.open(reconnected)
    expect(s.cancelled.has(old.id)).toBe(true)
    handleWebSocket.close(reconnected, 1000, 'second disconnect')
    const current = s.ceiling()!
    old.callback()
    expect(s.stop).not.toHaveBeenCalled()
    current.callback()
    expect(s.stop).toHaveBeenCalledTimes(1)
  })

  it('protects a real replacement turn from the previous Stop timeout', async () => {
    const s = setup()
    s.control.mockImplementation(() => new Promise(() => {}))
    s.startTask()
    handleWebSocket.message(s.ws, JSON.stringify({ type: 'stop_generation' }))
    const previousStop = s.timers.find(timer => timer.delay === 3_000)!
    handleWebSocket.message(s.ws, JSON.stringify({ type: 'user_message', content: 'new work' }))
    await flushMicrotasks()
    previousStop.callback()
    expect(s.stop).not.toHaveBeenCalled()
    expect(getSessionTurnState(s.sessionId)).toBe('running')
    s.startTask('new-shell')
    expect(s.control.mock.calls.filter(call => call[1]?.task_id === 'new-shell')).toHaveLength(0)
  })

  it('stops a late shell once while the original user Stop still owns its scope', async () => {
    const s = setup()
    handleWebSocket.message(s.ws, JSON.stringify({ type: 'stop_generation' }))
    s.startTask('late-shell')
    s.dispatch({ type: 'system', subtype: 'task_notification', task_id: 'late-shell', status: 'running' })
    expect(s.control.mock.calls).toEqual([[s.sessionId, { subtype: 'stop_task', task_id: 'late-shell' }]])
    s.timers.find(timer => timer.delay === 3_000)!.callback()
    await flushMicrotasks()
    expect(s.stop).toHaveBeenCalledTimes(1)
    expect(s.terminals()).toHaveLength(1)
  })

  it('keeps programmatic turn Stop narrow for independent shell tasks', () => {
    const s = setup()
    s.startTask()
    stopSessionTurn(s.sessionId)
    s.startTask('later-shell')
    expect(s.control).not.toHaveBeenCalled()
  })

  it('persists not_found before dropping tracking or publishing a terminal notification', async () => {
    const s = setup()
    s.startTask()
    await flushMicrotasks()
    let save!: () => void
    s.append.mockImplementation((_id, notification) => notification.status === 'stopped'
      ? new Promise<void>(resolve => { save = resolve }) : Promise.resolve())
    s.control.mockResolvedValue({ reason: 'not_found' })
    handleWebSocket.message(s.ws, JSON.stringify({ type: 'stop_background_task', taskId: 'bash-1' }))
    await flushMicrotasks()
    expect(activeNonAgentTasks.get(s.sessionId)?.has('bash-1')).toBe(true)
    expect(authoritativeStoppedTaskIds.get(s.sessionId)?.has('bash-1')).not.toBe(true)
    expect(s.terminals()).toHaveLength(0)
    s.dispatch({ type: 'system', subtype: 'task_notification', task_id: 'bash-1', status: 'running' })
    save()
    await flushMicrotasks()
    expect(activeNonAgentTasks.get(s.sessionId)?.has('bash-1')).not.toBe(true)
    expect(s.terminals()).toHaveLength(1)
  })

  it('retries failed terminal persistence without reviving or forgetting an exited task', async () => {
    const s = setup()
    s.startTask()
    await flushMicrotasks()
    s.append.mockRejectedValue(new Error('disk unavailable'))
    s.close()
    s.ceiling()!.callback()
    await flushMicrotasks()
    expect(activeNonAgentTasks.get(s.sessionId)?.has('bash-1')).toBe(true)
    expect(authoritativeStoppedTaskIds.get(s.sessionId)?.has('bash-1')).not.toBe(true)
    expect(getSessionChatActivityState(s.sessionId)).toBe('idle')
    // The ordinary cleanup must retain the pending terminal record as well.
    s.timers.findLast(timer => timer.delay === 30_000)!.callback()
    expect(activeNonAgentTasks.get(s.sessionId)?.has('bash-1')).toBe(true)
    s.append.mockResolvedValue()
    const returning = s.client()
    handleWebSocket.open(returning)
    await flushMicrotasks()
    expect(activeNonAgentTasks.get(s.sessionId)?.has('bash-1')).not.toBe(true)
    expect(s.terminals(returning)).toHaveLength(1)
  })

  for (const wholeSession of [false, true]) {
    for (const response of [{}, { reason: 'not_found' }]) {
      it(`ignores a stale ${wholeSession ? 'session' : 'task'} Stop response after its task record is replaced (${JSON.stringify(response)})`, async () => {
        const s = setup()
        let resolveControl!: (response: any) => void
        s.control.mockImplementation(() => new Promise(resolve => { resolveControl = resolve }))
        s.startTask()
        handleWebSocket.message(s.ws, JSON.stringify(wholeSession
          ? { type: 'stop_generation' }
          : { type: 'stop_background_task', taskId: 'bash-1' }))
        // A runtime replacement releases the old registry; the replacement CLI
        // is allowed to reuse a handle while an old request callback is queued.
        clearAgentRuntimeState(s.sessionId)
        s.startTask()
        const replacement = activeNonAgentTasks.get(s.sessionId)!.get('bash-1')
        resolveControl(response)
        await flushMicrotasks()
        expect(activeNonAgentTasks.get(s.sessionId)!.get('bash-1')).toBe(replacement)
        expect(s.terminals()).toHaveLength(0)
      })
    }
  }

  it('treats a successful stop control response as confirmation even without a terminal frame', async () => {
    const s = setup()
    s.startTask()
    handleWebSocket.message(s.ws, JSON.stringify({ type: 'stop_generation' }))
    await flushMicrotasks()
    expect(s.terminals().map((message: any) => message.data.status)).toEqual(['stopped'])
    expect(activeNonAgentTasks.get(s.sessionId)?.has('bash-1')).not.toBe(true)
    s.timers.find(timer => timer.delay === 3_000)!.callback()
    expect(s.stop).not.toHaveBeenCalled()
  })

  it('bounds a hung terminal write and can retry it after the timeout', async () => {
    const s = setup()
    s.startTask()
    await flushMicrotasks()
    s.append.mockImplementation(() => new Promise(() => {}))
    s.close()
    s.ceiling()!.callback()
    for (let attempt = 0; attempt < 3; attempt++) {
      const timeout = s.timers.filter(timer => timer.delay === 1_000)[attempt]
      expect(timeout).toBeDefined()
      timeout.callback()
      await flushMicrotasks()
    }
    expect(activeNonAgentTasks.get(s.sessionId)?.has('bash-1')).toBe(true)
    expect(authoritativeStoppedTaskIds.get(s.sessionId)?.has('bash-1')).not.toBe(true)
    s.append.mockResolvedValue()
    s.timers.find(timer => timer.delay === 250)!.callback()
    await flushMicrotasks()
    expect(activeNonAgentTasks.get(s.sessionId)?.has('bash-1')).not.toBe(true)
    expect(s.append.mock.calls.filter(call => call[1].status === 'failed')).toHaveLength(4)
  })

  it('does not infer task termination from a crash merely because Stop was requested', async () => {
    const s = setup()
    s.control.mockImplementation(() => new Promise(() => {}))
    s.startTask()
    handleWebSocket.message(s.ws, JSON.stringify({ type: 'stop_generation' }))
    s.stop(s.sessionId)
    s.dispatch({ type: 'result', subtype: 'error', is_error: true, result: 'runtime crashed before stop acknowledgement' })
    await flushMicrotasks()
    expect(s.terminals().map((message: any) => message.data.status)).toEqual(['failed'])
  })

  it('preserves an acknowledged stop outcome while persistence and a crash race', async () => {
    const s = setup()
    s.startTask()
    await flushMicrotasks()
    let save!: () => void
    s.append.mockImplementation((_id, notification) => notification.status === 'stopped'
      ? new Promise<void>(resolve => { save = resolve }) : Promise.resolve())
    handleWebSocket.message(s.ws, JSON.stringify({ type: 'stop_generation' }))
    await flushMicrotasks()
    s.stop(s.sessionId)
    s.dispatch({ type: 'result', subtype: 'error', is_error: true, result: 'runtime crashed after confirmed stop' })
    save()
    await flushMicrotasks()
    expect(s.terminals().map((message: any) => message.data.status)).toEqual(['stopped'])
    expect(s.append.mock.calls.filter(call => call[1].status === 'failed')).toHaveLength(0)
  })

  it('records an unacknowledged Windows force-stop as failed rather than claiming the shell died', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
    try {
      const s = setup()
      s.control.mockImplementation(() => new Promise(() => {}))
      s.startTask()
      handleWebSocket.message(s.ws, JSON.stringify({ type: 'stop_generation' }))
      s.timers.find(timer => timer.delay === 3_000)!.callback()
      await flushMicrotasks()
      s.startTask('late-shell')
      await flushMicrotasks()
      expect(s.terminals().map((message: any) => message.data.status)).toEqual(['failed', 'failed'])
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }
  })

  it('records unrequested runtime loss as failed and closes late task records consistently', async () => {
    const s = setup()
    s.startTask()
    s.stop(s.sessionId)
    s.dispatch({ type: 'result', subtype: 'error', is_error: true, result: 'runtime crashed' })
    await flushMicrotasks()
    s.startTask('late-shell')
    await flushMicrotasks()
    expect(s.terminals().map((message: any) => message.data.status)).toEqual(['failed', 'failed'])
    expect(s.append).toHaveBeenCalledWith(s.sessionId, expect.objectContaining({
      taskId: 'bash-1', status: 'failed', summary: expect.stringContaining('could not be confirmed'),
    }))
    expect(getSessionChatActivityState(s.sessionId)).toBe('idle')
  })
})
