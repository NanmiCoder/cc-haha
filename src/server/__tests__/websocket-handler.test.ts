import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import {
  __markPrewarmPendingForTests,
  __markActiveTurnForTests,
  __registerPendingUserTurnForTests,
  __markPrewarmedForTests,
  __resetWebSocketHandlerStateForTests,
  closeSessionConnection,
  getActiveSessionIds,
  handleWebSocket,
  translateCliMessage,
  type WebSocketData,
} from '../ws/handler.js'
import {
  __resetDisconnectGraceMsForTests,
  __setDisconnectGraceMsForTests,
} from '../ws/disconnectGraceConfig.js'
import { conversationService } from '../services/conversationService.js'
import { computerUseApprovalService } from '../services/computerUseApprovalService.js'
import { sessionService } from '../services/sessionService.js'

function makeClientSocket(sessionId: string) {
  const sent: string[] = []
  return {
    data: {
      sessionId,
      connectedAt: Date.now(),
      channel: 'client',
      sdkToken: null,
      serverPort: 0,
      serverHost: '127.0.0.1',
    },
    send: mock((payload: string) => {
      sent.push(payload)
    }),
    close: mock(() => {}),
    sent,
  } as unknown as ServerWebSocket<WebSocketData> & { sent: string[] }
}

describe('translateCliMessage usage mapping', () => {
  afterEach(() => {
    __resetWebSocketHandlerStateForTests()
    mock.restore()
  })

  it('keeps cache token counts on result completion events', () => {
    const sessionId = `usage-${crypto.randomUUID()}`

    const messages = translateCliMessage({
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 3456,
        cache_creation_input_tokens: 789,
      },
    }, sessionId)

    expect(messages).toEqual([{
      type: 'message_complete',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 3456,
        cache_creation_tokens: 789,
      },
    }])
  })

  it('maps SDK permission cancellation and response events to resolution messages', () => {
    expect(translateCliMessage({
      type: 'control_cancel_request',
      request_id: 'permission-1',
    }, 'session-1')).toEqual([{
      type: 'permission_resolved',
      requestId: 'permission-1',
      permissionType: 'tool',
    }])

    expect(translateCliMessage({
      type: 'control_response',
      response: {
        request_id: 'permission-2',
        response: { behavior: 'deny' },
      },
    }, 'session-1')).toEqual([{
      type: 'permission_resolved',
      requestId: 'permission-2',
      permissionType: 'tool',
      allowed: false,
    }])
  })
})

describe('WebSocket handler session isolation', () => {
  afterEach(() => {
    __resetWebSocketHandlerStateForTests()
    __resetDisconnectGraceMsForTests()
    mock.restore()
  })

  it('ignores stale disconnects from an older socket for the same session', () => {
    const sessionId = `duplicate-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId)
    const second = makeClientSocket(sessionId)
    const clearCallbacks = spyOn(conversationService, 'clearOutputCallbacks')
    const cancelComputerUse = spyOn(computerUseApprovalService, 'cancelSession')

    handleWebSocket.open(first)
    handleWebSocket.open(second)
    clearCallbacks.mockClear()
    cancelComputerUse.mockClear()

    handleWebSocket.close(first, 1000, 'stale tab closed')

    expect(getActiveSessionIds()).toContain(sessionId)
    expect(clearCallbacks).not.toHaveBeenCalled()
    expect(cancelComputerUse).not.toHaveBeenCalled()
  })

  it('closes and removes an active client socket when a session is deleted', () => {
    const sessionId = `delete-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const clearCallbacks = spyOn(conversationService, 'clearOutputCallbacks')
    const cancelComputerUse = spyOn(computerUseApprovalService, 'cancelSession')

    handleWebSocket.open(ws)

    expect(closeSessionConnection(sessionId, 'session deleted')).toBe(true)

    expect(getActiveSessionIds()).not.toContain(sessionId)
    expect(ws.close).toHaveBeenCalledWith(1000, 'session deleted')
    expect(clearCallbacks).toHaveBeenCalledWith(sessionId)
    expect(cancelComputerUse).toHaveBeenCalledWith(sessionId)
  })

  it('replays pending permission requests when a client reconnects', () => {
    const sessionId = `permission-reconnect-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation(() => {})
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([
      {
        requestId: 'request-ask-1',
        toolName: 'AskUserQuestion',
        toolUseId: 'tool-ask-1',
        input: {
          questions: [
            {
              header: 'Scope',
              question: 'Which scope?',
              options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }],
            },
          ],
        },
        description: 'Answer questions?',
      },
    ])

    handleWebSocket.open(ws)

    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'permission_request',
      requestId: 'request-ask-1',
      toolName: 'AskUserQuestion',
      toolUseId: 'tool-ask-1',
      input: {
        questions: [
          {
            header: 'Scope',
            question: 'Which scope?',
            options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }],
          },
        ],
      },
      description: 'Answer questions?',
    })
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'permission_requests_snapshot',
      toolRequestIds: ['request-ask-1'],
      computerUseRequestIds: [],
      turnActive: false,
    })
  })

  it('tracks and replays pending Computer Use requests when a client reconnects', async () => {
    const sessionId = `computer-use-reconnect-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId)
    const second = makeClientSocket(sessionId)
    const request = {
      requestId: 'cu-request-1',
      reason: 'Inspect another app',
      apps: [],
      requestedFlags: {},
      screenshotFiltering: 'native' as const,
    }
    const response = {
      granted: [],
      denied: [],
      flags: {
        clipboardRead: false,
        clipboardWrite: false,
        systemKeyCombos: false,
      },
      userConsented: true,
    }

    handleWebSocket.open(first)
    const approval = computerUseApprovalService.requestApproval(sessionId, request)
    expect(computerUseApprovalService.getPendingRequests(sessionId)).toEqual([request])

    handleWebSocket.open(second)

    expect(second.sent.map((payload) => JSON.parse(payload))).toEqual([
      { type: 'connected', sessionId },
      {
        type: 'computer_use_permission_request',
        requestId: request.requestId,
        request,
      },
      {
        type: 'permission_requests_snapshot',
        toolRequestIds: [],
        computerUseRequestIds: [request.requestId],
        turnActive: false,
      },
    ])

    expect(computerUseApprovalService.resolveApproval(request.requestId, response)).toBe(true)
    await expect(approval).resolves.toEqual(response)
    expect(computerUseApprovalService.getPendingRequests(sessionId)).toEqual([])
  })

  it('marks a registered pre-send user turn active in the reconnect snapshot', () => {
    const sessionId = `pending-turn-reconnect-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    __registerPendingUserTurnForTests(sessionId)

    handleWebSocket.open(ws)

    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'permission_requests_snapshot',
      toolRequestIds: [],
      computerUseRequestIds: [],
      turnActive: true,
    })
  })

  it('does not revive a stopped turn in the reconnect snapshot', () => {
    const sessionId = `stopped-turn-reconnect-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId)
    const second = makeClientSocket(sessionId)
    handleWebSocket.open(first)
    __markActiveTurnForTests(sessionId)

    handleWebSocket.message(first, JSON.stringify({ type: 'stop_generation' }))
    handleWebSocket.open(second)

    expect(second.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'permission_requests_snapshot',
      toolRequestIds: [],
      computerUseRequestIds: [],
      turnActive: false,
    })
  })

  it('forwards background task stop requests to the CLI control channel', async () => {
    const sessionId = `stop-background-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const requestControl = spyOn(conversationService, 'requestControl').mockResolvedValue({})

    handleWebSocket.message(ws, JSON.stringify({
      type: 'stop_background_task',
      taskId: 'bash-task-1',
    }))
    await Promise.resolve()

    expect(requestControl).toHaveBeenCalledWith(sessionId, {
      subtype: 'stop_task',
      task_id: 'bash-task-1',
    })
  })

  it('reports a task-scoped failure when the CLI rejects a background stop', async () => {
    const sessionId = `stop-background-failed-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    spyOn(conversationService, 'requestControl').mockRejectedValue(new Error('Task is not running'))

    handleWebSocket.message(ws, JSON.stringify({
      type: 'stop_background_task',
      taskId: 'bash-task-1',
    }))
    await Promise.resolve()
    await Promise.resolve()

    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'background_task_stop_failed',
      taskId: 'bash-task-1',
      message: 'Task is not running',
    })
  })

  it('rejects malformed background task ids without throwing from the async handler', async () => {
    const ws = makeClientSocket(`stop-background-invalid-${crypto.randomUUID()}`)
    const requestControl = spyOn(conversationService, 'requestControl').mockResolvedValue({})

    handleWebSocket.message(ws, JSON.stringify({
      type: 'stop_background_task',
      taskId: 42,
    }))
    await Promise.resolve()

    expect(requestControl).not.toHaveBeenCalled()
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'background_task_stop_failed',
      taskId: '',
      message: 'Background task id is required',
    })
  })

  it('broadcasts tool and Computer Use permission resolutions to every client', () => {
    const sessionId = `permission-resolution-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId)
    const second = makeClientSocket(sessionId)
    spyOn(conversationService, 'respondToPermission').mockReturnValue(true)
    spyOn(computerUseApprovalService, 'resolveApproval').mockReturnValue(true)

    handleWebSocket.open(first)
    handleWebSocket.open(second)
    first.sent.length = 0
    second.sent.length = 0

    handleWebSocket.message(first, JSON.stringify({
      type: 'permission_response',
      requestId: 'permission-1',
      allowed: true,
    }))

    for (const ws of [first, second]) {
      expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
        type: 'permission_resolved',
        requestId: 'permission-1',
        permissionType: 'tool',
        allowed: true,
      })
      ws.sent.length = 0
    }

    handleWebSocket.message(second, JSON.stringify({
      type: 'computer_use_permission_response',
      requestId: 'cu-1',
      response: {
        granted: [],
        denied: [],
        flags: {
          clipboardRead: false,
          clipboardWrite: false,
          systemKeyCombos: false,
        },
        userConsented: false,
      },
    }))

    for (const ws of [first, second]) {
      expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
        type: 'permission_resolved',
        requestId: 'cu-1',
        permissionType: 'computer_use',
        allowed: false,
      })
    }
  })

  it('keeps disconnected sessions alive longer while user input is pending', () => {
    const sessionId = `permission-disconnect-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as any)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([
      {
        requestId: 'request-ask-1',
        toolName: 'AskUserQuestion',
        toolUseId: 'tool-ask-1',
        input: { questions: [] },
      },
    ])

    handleWebSocket.open(ws)
    setTimeoutSpy.mockClear()

    handleWebSocket.close(ws, 1006, 'renderer reconnecting')

    expect(setTimeoutSpy).toHaveBeenCalled()
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBeGreaterThan(30_000)
  })

  it('does not forward prewarm startup status to a reconnecting client', async () => {
    const sessionId = `prewarm-reconnect-${crypto.randomUUID()}`
    const second = makeClientSocket(sessionId)
    let outputCallback: ((cliMsg: any) => void) | null = null

    __markPrewarmPendingForTests(sessionId)
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'getRecentSdkMessages').mockReturnValue([])
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallback = callback
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(conversationService, 'clearOutputCallbacks').mockImplementation(() => {
      outputCallback = null
    })

    handleWebSocket.open(second)
    outputCallback?.({
      type: 'stream_event',
      event: { type: 'message_start' },
    })

    const secondMessages = second.sent.map((payload) => JSON.parse(payload))
    expect(secondMessages).not.toContainEqual({ type: 'status', state: 'thinking' })
  })

  it('keeps a running session alive on disconnect and cleans up only after the turn finishes (issue #764)', () => {
    const sessionId = `running-disconnect-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout')
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])

    let turnCompleteCallback: ((cliMsg: any) => void) | null = null
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, cb) => {
      turnCompleteCallback = cb
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})

    handleWebSocket.open(ws)
    __markActiveTurnForTests(sessionId)
    setTimeoutSpy.mockClear()

    // Last client disconnects while the turn is still running: no kill timer,
    // just a turn-completion watcher.
    handleWebSocket.close(ws, 1006, 'phone locked screen')
    expect(setTimeoutSpy).not.toHaveBeenCalled()
    expect(stopSession).not.toHaveBeenCalled()
    expect(turnCompleteCallback).not.toBeNull()

    // Turn finishes while still disconnected → now the idle grace timer starts.
    turnCompleteCallback?.({ type: 'result', subtype: 'success' })
    expect(setTimeoutSpy).toHaveBeenCalled()
    // Timer body still hasn't run, so the process is not killed yet.
    expect(stopSession).not.toHaveBeenCalled()
  })

  it('uses the configured disconnect grace period for an idle session', () => {
    const sessionId = `idle-disconnect-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    __setDisconnectGraceMsForTests(120_000)
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as any)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])

    handleWebSocket.open(ws)
    setTimeoutSpy.mockClear()

    handleWebSocket.close(ws, 1006, 'tab closed')

    expect(setTimeoutSpy).toHaveBeenCalled()
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(120_000)
  })

  it('does not start the idle timer if the client reconnects before the turn finishes', () => {
    const sessionId = `reconnect-mid-turn-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const reconnected = makeClientSocket(sessionId)
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout')
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(conversationService, 'hasSession').mockReturnValue(true)

    let turnCompleteCallback: ((cliMsg: any) => void) | null = null
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, cb) => {
      turnCompleteCallback = cb
    })
    const removeOutputCallback = spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})

    handleWebSocket.open(ws)
    __markActiveTurnForTests(sessionId)
    handleWebSocket.close(ws, 1006, 'phone locked screen')
    expect(turnCompleteCallback).not.toBeNull()

    // Reconnect tears down the watcher before the turn completes.
    handleWebSocket.open(reconnected)
    expect(removeOutputCallback).toHaveBeenCalled()
    setTimeoutSpy.mockClear()

    // A late result must not schedule cleanup now that a client is back.
    turnCompleteCallback?.({ type: 'result', subtype: 'success' })
    expect(setTimeoutSpy).not.toHaveBeenCalled()
  })

  it('reports authoritative turn state when a reconnected client asks to reconcile', () => {
    const runningSessionId = `sync-running-${crypto.randomUUID()}`
    const runningSocket = makeClientSocket(runningSessionId)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])

    handleWebSocket.open(runningSocket)
    __markActiveTurnForTests(runningSessionId)
    runningSocket.sent.length = 0
    handleWebSocket.message(runningSocket, JSON.stringify({ type: 'sync_state' }))

    expect(runningSocket.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'session_state',
      turnState: 'running',
    })

    const idleSessionId = `sync-idle-${crypto.randomUUID()}`
    const idleSocket = makeClientSocket(idleSessionId)
    handleWebSocket.open(idleSocket)
    idleSocket.sent.length = 0
    handleWebSocket.message(idleSocket, JSON.stringify({ type: 'sync_state' }))

    expect(idleSocket.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'session_state',
      turnState: 'idle',
    })
  })

  it('terminates the desktop turn when user-message handling throws unexpectedly', async () => {
    const sessionId = `user-message-failure-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(sessionService, 'getCustomTitle').mockRejectedValue(
      new Error('metadata store unavailable'),
    )

    handleWebSocket.open(ws)
    ws.sent.length = 0
    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: 'continue the long task',
    }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    const messages = ws.sent.map((payload) => JSON.parse(payload))
    expect(messages).toContainEqual({
      type: 'error',
      message: 'The request could not be started. Please retry.',
      code: 'USER_TURN_FAILED',
      retryable: true,
    })
    expect(messages).toContainEqual({ type: 'status', state: 'idle' })

    ws.sent.length = 0
    handleWebSocket.message(ws, JSON.stringify({ type: 'sync_state' }))
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'session_state',
      turnState: 'idle',
    })
  })

  it('does not let an older failed handler clear a newer active turn', async () => {
    const sessionId = `concurrent-user-message-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])

    let rejectFirst!: (error: Error) => void
    let customTitleCalls = 0
    spyOn(sessionService, 'getCustomTitle').mockImplementation(() => {
      customTitleCalls++
      if (customTitleCalls === 1) {
        return new Promise((_resolve, reject) => {
          rejectFirst = reject
        })
      }
      return new Promise(() => {})
    })

    handleWebSocket.open(ws)
    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: 'older turn',
    }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(customTitleCalls).toBe(1)

    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: 'newer turn',
    }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(customTitleCalls).toBe(2)

    rejectFirst(new Error('older metadata request failed'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    ws.sent.length = 0
    handleWebSocket.message(ws, JSON.stringify({ type: 'sync_state' }))
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'session_state',
      turnState: 'running',
    })
  })
})

describe('prewarm idle timer active-turn guard (issue #865 follow-up)', () => {
  afterEach(() => {
    __resetWebSocketHandlerStateForTests()
    mock.restore()
  })

  // Arm the prewarm idle timer the way markPrewarmed does, and return its fire
  // callback so a test can trigger it deterministically without waiting 5 min.
  function armPrewarmIdleTimer(sessionId: string): () => void {
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      (() => 0) as unknown as typeof setTimeout,
    )
    __markPrewarmedForTests(sessionId)
    const fire = setTimeoutSpy.mock.calls.at(-1)?.[0] as (() => void) | undefined
    if (!fire) throw new Error('prewarm idle timer was not armed')
    return fire
  }

  it('does not kill a prewarmed session once a user turn is registered, even before messageSent flips (CLI-startup blind window)', () => {
    const sessionId = `prewarm-blind-window-${crypto.randomUUID()}`
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    const fire = armPrewarmIdleTimer(sessionId)

    // The concurrent prewarm_session/user_message race: the turn is registered
    // (activeUserTurns has it) but messageSent is still false during CLI startup
    // when the idle timer fires. The old isSessionTurnActive guard was blind to
    // this window — the turn-registered guard must catch it.
    __registerPendingUserTurnForTests(sessionId)
    fire()

    expect(stopSession).not.toHaveBeenCalled()
  })

  it('does not kill a prewarmed session with a fully active (messageSent) turn', () => {
    const sessionId = `prewarm-active-turn-${crypto.randomUUID()}`
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    const fire = armPrewarmIdleTimer(sessionId)

    __markActiveTurnForTests(sessionId)
    fire()

    expect(stopSession).not.toHaveBeenCalled()
  })

  it('still reclaims a truly idle prewarmed session with no turn and no clients', () => {
    const sessionId = `prewarm-truly-idle-${crypto.randomUUID()}`
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    const fire = armPrewarmIdleTimer(sessionId)

    // No registered turn and no connected client → the reaper must still fire,
    // otherwise the timer's whole purpose (reclaiming idle prewarmed CLIs) is lost.
    fire()

    expect(stopSession).toHaveBeenCalledWith(sessionId)
  })
})
