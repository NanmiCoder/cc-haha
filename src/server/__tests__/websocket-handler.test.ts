import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import {
  __enqueueRuntimeTransitionForTests,
  __markPrewarmPendingForTests,
  __markActiveTurnForTests,
  __refreshDisconnectedTurnCleanupWatcherForTests,
  __registerPendingUserTurnForTests,
  __markPrewarmedForTests,
  __resetWebSocketHandlerStateForTests,
  __resolveRuntimeRestartWorkDirForTests,
  closeSessionConnection,
  getActiveSessionIds,
  handleWebSocket,
  __registerPendingSessionStartupForTests,
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
import * as teleportApi from '../../utils/teleport/api.js'

function makeClientSocket(sessionId: string, clientKind: 'full' | 'pet' = 'full') {
  const sent: string[] = []
  return {
    data: {
      sessionId,
      connectedAt: Date.now(),
      channel: 'client',
      clientKind,
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

function makeSdkSocket(sessionId: string, sdkToken: string) {
  return {
    data: {
      sessionId,
      connectedAt: Date.now(),
      channel: 'sdk',
      sdkToken,
      serverPort: 0,
      serverHost: '127.0.0.1',
    },
    send: mock(() => {}),
    close: mock(() => {}),
  } as unknown as ServerWebSocket<WebSocketData>
}

async function flushMicrotasks(count = 12): Promise<void> {
  for (let index = 0; index < count; index++) await Promise.resolve()
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

describe('WebSocket handler session title lifecycle', () => {
  afterEach(() => {
    __resetWebSocketHandlerStateForTests()
    mock.restore()
  })

  it('does not regenerate a title when a resumed session already has transcript messages', async () => {
    const sessionId = `title-resumed-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(conversationService, 'onOutput').mockImplementation(() => {})
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(conversationService, 'sendMessage').mockResolvedValue(true)
    spyOn(sessionService, 'getCustomTitle').mockResolvedValue(null)
    spyOn(sessionService, 'getSessionLaunchInfo').mockResolvedValue({
      filePath: '/tmp/resumed-session.jsonl',
      projectDir: '/tmp',
      workDir: '/tmp',
      transcriptMessageCount: 4,
      customTitle: null,
    })
    const appendAiTitle = spyOn(sessionService, 'appendAiTitle').mockResolvedValue(undefined)

    handleWebSocket.open(ws)
    ws.sent.length = 0
    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: 'Continue the existing investigation',
    }))
    await flushMicrotasks(30)

    expect(appendAiTitle).not.toHaveBeenCalled()
    expect(ws.sent.map((payload) => JSON.parse(payload))).not.toContainEqual(
      expect.objectContaining({ type: 'session_title_updated' }),
    )
  })

  it('ignores /compact for titles without disabling the next real first-message title', async () => {
    const sessionId = `title-compact-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const outputCallbacks = new Set<(cliMsg: any) => void>()
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(conversationService, 'onOutput').mockImplementation((_sessionId, callback) => {
      outputCallbacks.add(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation((_sessionId, callback) => {
      outputCallbacks.delete(callback)
    })
    spyOn(conversationService, 'sendMessage').mockResolvedValue(true)
    spyOn(sessionService, 'getCustomTitle').mockResolvedValue(null)
    spyOn(sessionService, 'getSessionLaunchInfo').mockResolvedValue({
      filePath: '/tmp/fresh-session.jsonl',
      projectDir: '/tmp',
      workDir: '/tmp',
      transcriptMessageCount: 0,
      customTitle: null,
    })
    const appendAiTitle = spyOn(sessionService, 'appendAiTitle').mockResolvedValue(undefined)

    handleWebSocket.open(ws)
    ws.sent.length = 0
    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: '/compact',
    }))
    await flushMicrotasks(30)

    expect(appendAiTitle).not.toHaveBeenCalled()
    expect(ws.sent.map((payload) => JSON.parse(payload))).not.toContainEqual(
      expect.objectContaining({ type: 'session_title_updated' }),
    )

    for (const callback of [...outputCallbacks]) {
      callback({
        type: 'result',
        subtype: 'success',
        result: '',
        usage: { input_tokens: 0, output_tokens: 0 },
      })
    }
    await flushMicrotasks()

    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: 'Design the renderer cache',
    }))
    await flushMicrotasks(30)

    expect(appendAiTitle).toHaveBeenCalledTimes(1)
    expect(appendAiTitle).toHaveBeenCalledWith(sessionId, 'Design the renderer cache')
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'session_title_updated',
      sessionId,
      title: 'Design the renderer cache',
    })
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

  it('falls back to persisted workDir when a queued runtime restart loses its active session', async () => {
    const sessionId = `runtime-restart-workdir-${crypto.randomUUID()}`
    const persistedWorkDir = '/persisted/runtime-project'
    spyOn(conversationService, 'getSessionWorkDir').mockReturnValue('')
    const getPersistedWorkDir = spyOn(sessionService, 'getSessionWorkDir')
      .mockResolvedValue(persistedWorkDir)

    await expect(__resolveRuntimeRestartWorkDirForTests(sessionId))
      .resolves.toBe(persistedWorkDir)
    expect(getPersistedWorkDir).toHaveBeenCalledWith(sessionId)
  })

  it('rejects a runtime restart when no active or persisted workDir remains', async () => {
    const sessionId = `runtime-restart-missing-workdir-${crypto.randomUUID()}`
    spyOn(conversationService, 'getSessionWorkDir').mockReturnValue('')
    spyOn(sessionService, 'getSessionWorkDir').mockResolvedValue(null)

    await expect(__resolveRuntimeRestartWorkDirForTests(sessionId))
      .rejects.toThrow(`Unable to resolve working directory for session: ${sessionId}`)
  })

  it('rejects an old SDK socket after the same session starts with a new token', () => {
    const sessionId = `sdk-token-replacement-${crypto.randomUUID()}`
    let currentToken = 'old-sdk-token'
    const oldSocket = makeSdkSocket(sessionId, currentToken)
    const newSocket = makeSdkSocket(sessionId, 'new-sdk-token')
    spyOn(conversationService, 'authorizeSdkConnection').mockImplementation(
      (_sessionId, token) => token === currentToken,
    )
    spyOn(conversationService, 'attachSdkConnection').mockReturnValue(true)
    const handleSdkPayload = spyOn(conversationService, 'handleSdkPayload').mockImplementation(
      () => {},
    )

    handleWebSocket.open(oldSocket)
    currentToken = 'new-sdk-token'
    handleWebSocket.message(oldSocket, JSON.stringify({
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-from-old-runtime',
      task_type: 'local_agent',
    }))

    expect(oldSocket.close).toHaveBeenCalledWith(1008, 'Stale SDK token')
    expect(handleSdkPayload).not.toHaveBeenCalled()

    handleWebSocket.open(newSocket)
    const currentPayload = JSON.stringify({ type: 'system', subtype: 'init' })
    handleWebSocket.message(newSocket, currentPayload)

    expect(newSocket.close).not.toHaveBeenCalled()
    expect(handleSdkPayload).toHaveBeenCalledTimes(1)
    expect(handleSdkPayload.mock.calls[0]?.[0]).toBe(sessionId)
    expect(handleSdkPayload.mock.calls[0]?.[1]).toBe(currentPayload)
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

  it('gives pet clients only sanitized state and denies privileged client messages', () => {
    const sessionId = `pet-capability-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId, 'pet')
    let outputCallback: ((message: unknown) => void) | null = null
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallback = callback
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([{
      requestId: 'pet-hidden-request',
      toolName: 'Read',
      input: { file_path: '/Users/alice/private.txt' },
    }])
    const clearSessionTranscript = spyOn(sessionService, 'clearSessionTranscript')

    handleWebSocket.open(ws)
    outputCallback?.({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'private transcript text' }] },
    })
    outputCallback?.({ type: 'system', subtype: 'status', status: 'compacting' })
    handleWebSocket.message(ws, JSON.stringify({
      type: 'set_permission_mode',
      mode: 'bypassPermissions',
    }))
    handleWebSocket.message(ws, JSON.stringify({ type: 'ping' }))
    handleWebSocket.message(ws, JSON.stringify({ type: 'user_message', content: '/clear' }))

    const sent = ws.sent.map((payload) => JSON.parse(payload))
    expect(sent).toContainEqual({ type: 'connected', sessionId })
    expect(sent).toContainEqual({
      type: 'permission_requests_snapshot',
      toolRequestIds: [],
      computerUseRequestIds: [],
      turnActive: false,
    })
    expect(sent).toContainEqual({
      type: 'error',
      message: 'Pet action failed. Open the session for details.',
      code: 'PET_CAPABILITY_DENIED',
    })
    expect(sent).toContainEqual({ type: 'pong' })
    expect(clearSessionTranscript).not.toHaveBeenCalled()
    expect(sent).not.toContainEqual(expect.objectContaining({ type: 'permission_request' }))
    expect(JSON.stringify(sent)).not.toContain('/Users/alice/private.txt')
    expect(JSON.stringify(sent)).not.toContain('private transcript text')
  })

  it('keeps only the selected pet session socket active', () => {
    const first = makeClientSocket(`pet-first-${crypto.randomUUID()}`, 'pet')
    const second = makeClientSocket(`pet-second-${crypto.randomUUID()}`, 'pet')

    handleWebSocket.open(first)
    handleWebSocket.open(second)

    expect(first.close).toHaveBeenCalledWith(1000, 'Pet session switched')
    expect(second.close).not.toHaveBeenCalled()
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

  it('cancels a stopped turn Computer Use request before another renderer reconnects', async () => {
    const sessionId = `computer-use-stop-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId)
    const second = makeClientSocket(sessionId)
    const request = {
      requestId: 'cu-request-stopped',
      reason: 'Inspect another app',
      apps: [],
      requestedFlags: {},
      screenshotFiltering: 'native' as const,
    }
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'sendInterrupt').mockReturnValue(true)

    handleWebSocket.open(first)
    __markActiveTurnForTests(sessionId)
    const approval = computerUseApprovalService.requestApproval(sessionId, request)
    const approvalResult = approval.catch((error: unknown) => error)

    handleWebSocket.message(first, JSON.stringify({ type: 'stop_generation' }))
    handleWebSocket.open(second)

    expect(computerUseApprovalService.getPendingRequests(sessionId)).toEqual([])
    expect(second.sent.map((payload) => JSON.parse(payload))).not.toContainEqual(
      expect.objectContaining({
        type: 'computer_use_permission_request',
        requestId: request.requestId,
      }),
    )
    expect(second.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'permission_requests_snapshot',
      toolRequestIds: [],
      computerUseRequestIds: [],
      turnActive: false,
    })
    expect(first.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'permission_resolved',
      requestId: request.requestId,
      permissionType: 'computer_use',
      allowed: false,
    })
    expect(await approvalResult).toEqual(expect.objectContaining({
      message: 'Desktop session disconnected during Computer Use approval',
    }))
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

  it('does not revive a stopped turn when reconnect sync follows a queued stop', () => {
    const sessionId = `stopped-turn-sync-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    handleWebSocket.open(ws)
    __markActiveTurnForTests(sessionId)
    ws.sent.length = 0

    // A stop clicked while the renderer socket is reconnecting is queued first;
    // WebSocketManager then sends sync_state immediately after the queue drains.
    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    handleWebSocket.message(ws, JSON.stringify({ type: 'sync_state' }))

    expect(ws.sent.map((payload) => JSON.parse(payload))).toEqual([
      { type: 'status', state: 'idle' },
      { type: 'session_state', turnState: 'idle', activeBackgroundTaskIds: [] },
    ])
  })

  it('does not forward late foreground stream output after stop', () => {
    const sessionId = `stopped-turn-late-stream-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    let outputCallback: ((cliMsg: any) => void) | null = null
    spyOn(globalThis, 'setTimeout').mockImplementation(() => 1 as any)
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'sendInterrupt').mockImplementation(() => true)
    spyOn(conversationService, 'onOutput').mockImplementation((_sessionId, callback) => {
      outputCallback = callback
    })

    handleWebSocket.open(ws)
    __markActiveTurnForTests(sessionId)
    ws.sent.length = 0

    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    outputCallback?.({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'late whole thinking block' },
          { type: 'text', text: 'late whole answer' },
        ],
      },
    })
    outputCallback?.({
      type: 'stream_event',
      event: { type: 'message_start' },
    })
    outputCallback?.({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'late unique thinking text' },
      },
    })
    outputCallback?.({
      type: 'system',
      subtype: 'status',
      status: null,
    })
    outputCallback?.({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'background-task-1',
      tool_use_id: 'background-tool-1',
      status: 'running',
      summary: 'Background work continues independently',
    })
    outputCallback?.({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      usage: { input_tokens: 12, output_tokens: 3 },
      result: 'Request interrupted by user',
    })
    outputCallback?.({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'late after interrupt result' }] },
    })
    outputCallback?.({
      type: 'system',
      subtype: 'status',
      status: 'compacting',
    })
    handleWebSocket.message(ws, JSON.stringify({ type: 'sync_state' }))

    expect(ws.sent.map((payload) => JSON.parse(payload))).toEqual([
      { type: 'status', state: 'idle' },
      {
        type: 'system_notification',
        subtype: 'task_notification',
        data: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'background-task-1',
          tool_use_id: 'background-tool-1',
          status: 'running',
          summary: 'Background work continues independently',
        },
      },
      {
        type: 'message_complete',
        usage: { input_tokens: 12, output_tokens: 3 },
      },
      {
        type: 'session_state',
        turnState: 'idle',
        activeBackgroundTaskIds: ['background-task-1'],
      },
    ])
  })

  it('forwards directed Agent output while a foreground admission awaits send acknowledgement', async () => {
    const sessionId = `agent-run-during-admission-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const outputCallbacks = new Set<(cliMsg: any) => void>()
    let resolveSend!: (sent: boolean) => void
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.add(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation((_sid, callback) => {
      outputCallbacks.delete(callback)
    })
    spyOn(sessionService, 'getCustomTitle').mockResolvedValue('Existing title')
    spyOn(conversationService, 'sendMessage').mockImplementation(
      () => new Promise<boolean>((resolve) => {
        resolveSend = resolve
      }),
    )

    handleWebSocket.open(ws)
    ws.sent.length = 0
    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: 'Start another foreground turn',
    }))
    await flushMicrotasks(30)

    const directedDelta = {
      type: 'system',
      subtype: 'agent_run_message',
      run_agent_id: 'background-physical-agent',
      stream_id: 'background-invocation',
      target_agent_id: 'background-logical-agent',
      event_kind: 'message',
      message: {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'background is still live' },
        },
      },
    }
    for (const callback of [...outputCallbacks]) callback(directedDelta)

    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'agent_run_event',
      runAgentId: 'background-physical-agent',
      streamId: 'background-invocation',
      targetAgentId: 'background-logical-agent',
      event: { type: 'content_delta', text: 'background is still live' },
    })

    resolveSend(true)
    await flushMicrotasks(30)
  })

  it('lets directed Agent terminals through the stop fence after suppressing late content', () => {
    const sessionId = `agent-run-terminal-after-stop-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    let outputCallback: ((cliMsg: any) => void) | null = null
    spyOn(globalThis, 'setTimeout').mockImplementation(() => 1 as any)
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'sendInterrupt').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallback = callback
    })

    handleWebSocket.open(ws)
    __markActiveTurnForTests(sessionId)
    ws.sent.length = 0
    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))

    const route = {
      type: 'system',
      subtype: 'agent_run_message',
      run_agent_id: 'stopped-physical-agent',
      target_agent_id: 'stopped-logical-agent',
    }
    outputCallback?.({
      ...route,
      stream_id: 'stopped-content-invocation',
      event_kind: 'message',
      message: {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'must stay hidden after stop' },
        },
      },
    })
    outputCallback?.({
      ...route,
      stream_id: 'stopped-content-invocation',
      event_kind: 'complete',
    })
    outputCallback?.({
      ...route,
      stream_id: 'stopped-error-invocation',
      event_kind: 'error',
      error: 'stopped child settled with an error',
    })

    const sent = ws.sent.map((payload) => JSON.parse(payload))
    expect(sent).not.toContainEqual(expect.objectContaining({
      type: 'agent_run_event',
      event: { type: 'content_delta', text: 'must stay hidden after stop' },
    }))
    expect(sent).toContainEqual({
      type: 'agent_run_event',
      runAgentId: 'stopped-physical-agent',
      streamId: 'stopped-content-invocation',
      targetAgentId: 'stopped-logical-agent',
      event: { type: 'status', state: 'idle' },
    })
    expect(sent).toContainEqual({
      type: 'agent_run_event',
      runAgentId: 'stopped-physical-agent',
      streamId: 'stopped-error-invocation',
      targetAgentId: 'stopped-logical-agent',
      event: {
        type: 'error',
        message: 'stopped child settled with an error',
        code: 'AGENT_RUN_ERROR',
      },
    })
  })

  it('suppresses an interrupted result for every client bound to the stopped session', () => {
    const sessionId = `stopped-turn-multi-client-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId)
    const second = makeClientSocket(sessionId)
    const outputCallbacks: Array<(cliMsg: any) => void> = []
    spyOn(globalThis, 'setTimeout').mockImplementation(() => 1 as any)
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'sendInterrupt').mockImplementation(() => true)
    spyOn(conversationService, 'onOutput').mockImplementation((_sessionId, callback) => {
      outputCallbacks.push(callback)
    })

    handleWebSocket.open(first)
    handleWebSocket.open(second)
    __markActiveTurnForTests(sessionId)
    first.sent.length = 0
    second.sent.length = 0

    handleWebSocket.message(first, JSON.stringify({ type: 'stop_generation' }))
    for (const callback of outputCallbacks) {
      callback({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'Request interrupted by user',
      })
    }

    expect(first.sent.map((payload) => JSON.parse(payload))).toEqual([
      { type: 'status', state: 'idle' },
      { type: 'message_complete', usage: { input_tokens: 0, output_tokens: 0 } },
    ])
    expect(second.sent.map((payload) => JSON.parse(payload))).toEqual([
      { type: 'status', state: 'idle' },
      { type: 'message_complete', usage: { input_tokens: 0, output_tokens: 0 } },
    ])
  })

  it('keeps late stopped-turn output fenced after rejecting /clear arguments', () => {
    const sessionId = `stopped-turn-invalid-clear-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    let outputCallback: ((cliMsg: any) => void) | null = null
    spyOn(globalThis, 'setTimeout').mockImplementation(() => 1 as any)
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'sendInterrupt').mockImplementation(() => true)
    spyOn(conversationService, 'onOutput').mockImplementation((_sessionId, callback) => {
      outputCallback = callback
    })

    handleWebSocket.open(ws)
    __markActiveTurnForTests(sessionId)
    ws.sent.length = 0

    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: '/clear unexpected',
    }))
    outputCallback?.({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'late stopped-turn output' }] },
    })

    expect(ws.sent.map((payload) => JSON.parse(payload))).toEqual([
      { type: 'status', state: 'idle' },
      {
        type: 'error',
        message: 'The /clear command does not accept arguments.',
        code: 'INVALID_SLASH_COMMAND_ARGS',
      },
      { type: 'status', state: 'idle' },
    ])
  })

  it('reports a committed replacement active before its replay reaches the server', async () => {
    const sessionId = `replacement-turn-reconnect-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId)
    const second = makeClientSocket(sessionId)
    spyOn(globalThis, 'setTimeout').mockImplementation(() => 1 as any)
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(conversationService, 'onOutput').mockImplementation(() => {})
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(conversationService, 'sendInterrupt').mockReturnValue(true)
    spyOn(sessionService, 'getCustomTitle').mockResolvedValue('Existing title')
    spyOn(conversationService, 'sendMessage').mockImplementation(
      async (_sid, _content, _attachments, options) => {
        options?.onCommitted?.()
        return true
      },
    )

    handleWebSocket.open(first)
    __markActiveTurnForTests(sessionId)
    handleWebSocket.message(first, JSON.stringify({ type: 'stop_generation' }))
    handleWebSocket.message(first, JSON.stringify({
      type: 'user_message',
      content: 'Replacement committed before replay',
    }))
    await flushMicrotasks(30)
    handleWebSocket.open(second)

    expect(second.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'permission_requests_snapshot',
      toolRequestIds: [],
      computerUseRequestIds: [],
      turnActive: true,
    })
  })

  it('does not let a stopped turn fallback kill a replacement turn', () => {
    const sessionId = `stopped-turn-replaced-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(() => 1 as any)
    const sendInterrupt = spyOn(conversationService, 'sendInterrupt').mockImplementation(() => {})
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    __markActiveTurnForTests(sessionId)

    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))

    expect(sendInterrupt).toHaveBeenCalledWith(sessionId)
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 3_000)
    const expireForceKill = setTimeoutSpy.mock.calls[0]?.[0] as (() => void) | undefined

    __registerPendingUserTurnForTests(sessionId)
    expireForceKill?.()

    expect(stopSession).not.toHaveBeenCalled()
  })

  it('does not turn background task lifecycle into foreground activity after the user turn ends', () => {
    const sessionId = `background-task-foreground-state-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const outputCallbacks: Array<(cliMsg: any) => void> = []
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.push(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})

    handleWebSocket.open(ws)
    ws.sent.length = 0

    outputCallbacks[0]?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-task-1',
      tool_use_id: 'agent-tool-1',
      description: 'Verify the todo app',
      task_type: 'local_agent',
    })
    outputCallbacks[0]?.({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'agent-task-1',
      tool_use_id: 'agent-tool-1',
      summary: 'Running Playwright checks',
      task_type: 'local_agent',
    })

    const idleMessages = ws.sent.map((payload) => JSON.parse(payload))
    expect(idleMessages).toContainEqual(expect.objectContaining({
      type: 'system_notification',
      subtype: 'task_started',
    }))
    expect(idleMessages).toContainEqual(expect.objectContaining({
      type: 'system_notification',
      subtype: 'task_progress',
    }))
    expect(idleMessages).not.toContainEqual(expect.objectContaining({
      type: 'status',
      state: 'tool_executing',
    }))

    handleWebSocket.message(ws, JSON.stringify({ type: 'sync_state' }))
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'session_state',
      turnState: 'idle',
      activeBackgroundTaskIds: ['agent-task-1'],
    })

    __markActiveTurnForTests(sessionId)
    ws.sent.length = 0
    outputCallbacks[0]?.({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'agent-task-1',
      tool_use_id: 'agent-tool-1',
      summary: 'Foreground turn is waiting for the task',
      task_type: 'local_agent',
    })

    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'status',
      state: 'tool_executing',
      verb: 'Foreground turn is waiting for the task',
    })
    handleWebSocket.message(ws, JSON.stringify({ type: 'sync_state' }))
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'session_state',
      turnState: 'running',
      activeBackgroundTaskIds: ['agent-task-1'],
    })

    outputCallbacks[0]?.({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'agent-task-1',
      tool_use_id: 'agent-tool-1',
      status: 'completed',
      summary: 'Playwright checks passed',
      task_type: 'local_agent',
    })
    ws.sent.length = 0
    handleWebSocket.message(ws, JSON.stringify({ type: 'sync_state' }))
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'session_state',
      turnState: 'running',
      activeBackgroundTaskIds: [],
    })
  })

  it('keeps owned member lifecycle out of the live root turn', async () => {
    const sessionId = `owned-member-lifecycle-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const outputCallbacks: Array<(cliMsg: any) => void> = []
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.push(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(sessionService, 'appendSessionTaskNotification').mockResolvedValue()

    handleWebSocket.open(ws)
    __markActiveTurnForTests(sessionId)
    ws.sent.length = 0

    const ownedLifecycle = [
      {
        subtype: 'task_started',
        description: 'Member analysis',
      },
      {
        subtype: 'task_progress',
        summary: 'Inspecting providers',
      },
      {
        subtype: 'task_notification',
        status: 'completed',
        summary: 'Provider analysis complete',
      },
    ]
    for (const event of ownedLifecycle) {
      outputCallbacks[0]?.({
        type: 'system',
        task_id: 'member-agent-task',
        tool_use_id: 'member-agent-tool',
        task_type: 'local_agent',
        owner_agent_id: 'provider-analyzer',
        ...event,
      })
    }
    await flushMicrotasks()

    const messages = ws.sent.map((payload) => JSON.parse(payload))
    expect(messages.map(({ type, subtype }) => ({ type, subtype }))).toEqual([
      { type: 'system_notification', subtype: 'task_started' },
      { type: 'system_notification', subtype: 'task_progress' },
      { type: 'system_notification', subtype: 'task_notification' },
    ])
    expect(messages).toEqual(messages.map((message) => expect.objectContaining({
      data: expect.objectContaining({ owner_agent_id: 'provider-analyzer' }),
    })))
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'user_message' }))
    expect(messages).not.toContainEqual(expect.objectContaining({
      type: 'status',
      state: 'tool_executing',
    }))
  })

  it('stops every active Agent task when generation is stopped', async () => {
    const sessionId = `stop-agent-fanout-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const outputCallbacks: Array<(cliMsg: any) => void> = []
    spyOn(globalThis, 'setTimeout').mockImplementation(() => 1 as any)
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.push(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    const sendInterrupt = spyOn(conversationService, 'sendInterrupt').mockImplementation(() => true)
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    const append = spyOn(sessionService, 'appendSessionTaskNotification').mockResolvedValue()
    const requestControl = spyOn(conversationService, 'requestControl').mockImplementation(
      async (_sessionId, request) => {
        if (request.task_id === 'agent-task-2') {
          throw new Error('Agent stop failed')
        }
        return {}
      },
    )
    const archiveRemoteSession = spyOn(teleportApi, 'archiveRemoteSession').mockResolvedValue()

    handleWebSocket.open(ws)
    __markActiveTurnForTests(sessionId)
    for (const [taskId, taskType] of [
      ['agent-task-1', 'local_agent'],
      ['agent-task-2', 'local_agent'],
      ['agent-task-3', 'remote_agent'],
      ['agent-task-4', 'local_agent'],
    ] as const) {
      outputCallbacks[0]?.({
        type: 'system',
        subtype: 'task_started',
        task_id: taskId,
        tool_use_id: `tool-${taskId}`,
        description: taskId,
        task_type: taskType,
        ...(taskType === 'remote_agent'
          ? { remote_session_id: 'remote-session-agent-task-3' }
          : {}),
      })
    }
    outputCallbacks[0]?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'bash-collateral-task',
      tool_use_id: 'bash-collateral-tool',
      description: 'Shell work sharing the Agent runtime',
      task_type: 'local_bash',
    })
    outputCallbacks[0]?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'provider-analyzer-teammate',
      tool_use_id: 'provider-analyzer-teammate-tool',
      description: 'Provider analyzer teammate',
      task_type: 'in_process_teammate',
      owner_agent_id: 'provider-analyzer',
    })
    outputCallbacks[0]?.({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'provider-analyzer-teammate',
      tool_use_id: 'provider-analyzer-teammate-tool',
      description: 'Provider analyzer teammate still running',
      task_type: 'in_process_teammate',
      status: 'running',
    })

    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    await flushMicrotasks()

    expect(sendInterrupt).toHaveBeenCalledWith(sessionId)
    expect(requestControl).toHaveBeenCalledTimes(4)
    for (const taskId of [
      'agent-task-1',
      'agent-task-2',
      'agent-task-3',
      'agent-task-4',
    ]) {
      expect(requestControl).toHaveBeenCalledWith(sessionId, {
        subtype: 'stop_task',
        task_id: taskId,
      }, 3_000)
    }
    expect(archiveRemoteSession).toHaveBeenCalledWith(
      'remote-session-agent-task-3',
      { timeoutMs: 1_500 },
    )
    expect(stopSession).toHaveBeenCalledWith(sessionId)
    expect(append).toHaveBeenCalledWith(sessionId, expect.objectContaining({
      taskId: 'agent-task-2',
      status: 'stopped',
    }))
    expect(append).toHaveBeenCalledWith(sessionId, expect.objectContaining({
      taskId: 'bash-collateral-task',
      toolUseId: 'bash-collateral-tool',
      status: 'stopped',
    }))
    expect(append).toHaveBeenCalledWith(sessionId, expect.objectContaining({
      taskId: 'provider-analyzer-teammate',
      toolUseId: 'provider-analyzer-teammate-tool',
      ownerAgentId: 'provider-analyzer',
      status: 'stopped',
    }))
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'system_notification',
      subtype: 'task_notification',
      data: expect.objectContaining({
        task_id: 'agent-task-2',
        status: 'stopped',
      }),
    })
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'system_notification',
      subtype: 'task_notification',
      data: expect.objectContaining({
        task_id: 'bash-collateral-task',
        status: 'stopped',
      }),
    })
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'system_notification',
      subtype: 'task_notification',
      data: expect.objectContaining({
        task_id: 'provider-analyzer-teammate',
        owner_agent_id: 'provider-analyzer',
        status: 'stopped',
      }),
    })

    outputCallbacks[0]?.({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'bash-collateral-task',
      tool_use_id: 'bash-collateral-tool',
      task_type: 'local_bash',
      status: 'stopped',
    })
    outputCallbacks[0]?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'late-bash-after-force-kill',
      tool_use_id: 'late-bash-after-force-kill-tool',
      description: 'Late Bash event drained after runtime exit',
      task_type: 'local_bash',
    })
    await flushMicrotasks()

    expect(append.mock.calls.filter(([, notification]) =>
      notification.taskId === 'bash-collateral-task')).toHaveLength(1)
    expect(append).toHaveBeenCalledWith(sessionId, expect.objectContaining({
      taskId: 'late-bash-after-force-kill',
      status: 'stopped',
    }))
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'system_notification',
      subtype: 'task_notification',
      data: expect.objectContaining({
        task_id: 'late-bash-after-force-kill',
        status: 'stopped',
      }),
    })
  })

  it('does not bulk-stop non-Agent background tasks', async () => {
    const sessionId = `stop-agent-filter-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const outputCallbacks: Array<(cliMsg: any) => void> = []
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.push(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    const requestControl = spyOn(conversationService, 'requestControl').mockResolvedValue({})

    handleWebSocket.open(ws)
    for (const [taskId, taskType] of [
      ['agent-task-1', 'local_agent'],
      ['bash-task-1', 'local_bash'],
      ['dream-task-1', 'dream'],
    ] as const) {
      outputCallbacks[0]?.({
        type: 'system',
        subtype: 'task_started',
        task_id: taskId,
        tool_use_id: `tool-${taskId}`,
        description: taskId,
        task_type: taskType,
      })
    }

    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    await Promise.resolve()

    expect(requestControl.mock.calls).toEqual([
      [sessionId, { subtype: 'stop_task', task_id: 'agent-task-1' }, 3_000],
    ])
    outputCallbacks[0]?.({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'agent-task-1',
      task_type: 'local_agent',
      description: 'Late stopped Agent progress',
    })
    outputCallbacks[0]?.({
      type: 'control_request',
      request_id: 'agent-permission-after-agent-stop',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        agent_id: 'agent-task-1',
        input: { command: 'echo stale-agent' },
      },
    })
    outputCallbacks[0]?.({
      type: 'control_request',
      request_id: 'non-agent-permission-after-agent-stop',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'echo still-running' },
      },
    })
    outputCallbacks[0]?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'late-bash-after-stop',
      task_type: 'local_bash',
      description: 'Independent Bash remains visible',
    })
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'permission_request',
      requestId: 'non-agent-permission-after-agent-stop',
      toolName: 'Bash',
      toolUseId: undefined,
      input: { command: 'echo still-running' },
      description: undefined,
    })
    expect(ws.sent.map((payload) => JSON.parse(payload))).not.toContainEqual(
      expect.objectContaining({
        type: 'permission_request',
        requestId: 'agent-permission-after-agent-stop',
      }),
    )
    expect(ws.sent.map((payload) => JSON.parse(payload))).not.toContainEqual(
      expect.objectContaining({
        type: 'status',
        state: 'tool_executing',
        verb: 'Late stopped Agent progress',
      }),
    )
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'system_notification',
      subtype: 'task_started',
      message: 'Independent Bash remains visible',
      data: expect.objectContaining({
        task_id: 'late-bash-after-stop',
        task_type: 'local_bash',
      }),
    })
    expect(ws.sent.map((payload) => JSON.parse(payload))).not.toContainEqual({
      type: 'status',
      state: 'tool_executing',
      verb: 'Independent Bash remains visible',
    })
  })

  it('stops active Agent tasks after the main turn has already settled', async () => {
    const sessionId = `stop-agent-after-turn-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const outputCallbacks: Array<(cliMsg: any) => void> = []
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.push(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    const sendInterrupt = spyOn(conversationService, 'sendInterrupt').mockImplementation(() => true)
    const requestControl = spyOn(conversationService, 'requestControl').mockResolvedValue({})

    handleWebSocket.open(ws)
    outputCallbacks[0]?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-task-after-turn',
      tool_use_id: 'agent-tool-after-turn',
      description: 'Continue after the main turn',
      task_type: 'local_agent',
    })

    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    await Promise.resolve()

    expect(sendInterrupt).not.toHaveBeenCalled()
    expect(requestControl).toHaveBeenCalledWith(sessionId, {
      subtype: 'stop_task',
      task_id: 'agent-task-after-turn',
    }, 3_000)
  })

  it('does not stop Agent tasks that already emitted a terminal status', async () => {
    const sessionId = `stop-agent-terminal-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const outputCallbacks: Array<(cliMsg: any) => void> = []
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.push(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    const requestControl = spyOn(conversationService, 'requestControl').mockResolvedValue({})

    handleWebSocket.open(ws)
    outputCallbacks[0]?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-task-completed',
      tool_use_id: 'agent-tool-completed',
      description: 'Already complete',
      task_type: 'local_agent',
    })
    outputCallbacks[0]?.({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'agent-task-completed',
      status: 'completed',
    })

    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    await Promise.resolve()

    expect(requestControl).not.toHaveBeenCalled()
  })

  it('persists an authoritative stopped bookend when the CLI exited before Stop', async () => {
    const sessionId = `stop-agent-after-exit-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    let cliRunning = true
    let outputCallback: ((cliMsg: any) => void) | null = null
    let finishPersistence: (() => void) | null = null
    spyOn(conversationService, 'hasSession').mockImplementation(() => cliRunning)
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallback = callback
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    const requestControl = spyOn(conversationService, 'requestControl').mockRejectedValue(
      new Error('CLI session is not running'),
    )
    const append = spyOn(sessionService, 'appendSessionTaskNotification').mockImplementation(
      () => new Promise<void>((resolve) => {
        finishPersistence = resolve
      }),
    )

    handleWebSocket.open(ws)
    outputCallback?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-task-after-exit',
      tool_use_id: 'agent-tool-after-exit',
      description: 'Review runtime failures',
      task_type: 'local_agent',
    })
    cliRunning = false
    outputCallback?.({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'CLI process exited unexpectedly (code 1): API unavailable',
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    ws.sent.length = 0

    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    await Promise.resolve()

    expect(requestControl).not.toHaveBeenCalled()
    expect(append).toHaveBeenCalledWith(sessionId, expect.objectContaining({
      taskId: 'agent-task-after-exit',
      toolUseId: 'agent-tool-after-exit',
      status: 'stopped',
    }))
    expect(ws.sent.map((payload) => JSON.parse(payload))).not.toContainEqual(
      expect.objectContaining({
        type: 'system_notification',
        subtype: 'task_notification',
      }),
    )

    finishPersistence?.()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'system_notification',
      subtype: 'task_notification',
      data: expect.objectContaining({
        task_id: 'agent-task-after-exit',
        tool_use_id: 'agent-tool-after-exit',
        task_type: 'local_agent',
        description: 'Review runtime failures',
        status: 'stopped',
      }),
    })
    expect(ws.sent.map((payload) => JSON.parse(payload))).not.toContainEqual(
      expect.objectContaining({ type: 'background_task_stop_failed' }),
    )
  })

  it('bounds persistence retries and keeps a synthetic Agent stop retryable', async () => {
    const sessionId = `stop-agent-persistence-retry-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    let cliRunning = true
    let outputCallback: ((cliMsg: any) => void) | null = null
    spyOn(conversationService, 'hasSession').mockImplementation(() => cliRunning)
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallback = callback
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    const append = spyOn(sessionService, 'appendSessionTaskNotification')
      .mockRejectedValueOnce(new Error('transcript unavailable'))
      .mockRejectedValueOnce(new Error('transcript unavailable'))
      .mockRejectedValueOnce(new Error('transcript unavailable'))
      .mockResolvedValue()
    spyOn(console, 'warn').mockImplementation(() => {})

    handleWebSocket.open(ws)
    outputCallback?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-task-persistence-retry',
      tool_use_id: 'agent-tool-persistence-retry',
      description: 'Retry durable stop',
      task_type: 'local_agent',
    })
    cliRunning = false
    ws.sent.length = 0

    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    await flushMicrotasks()

    expect(append).toHaveBeenCalledTimes(3)
    expect(ws.sent.map((payload) => JSON.parse(payload))).not.toContainEqual(
      expect.objectContaining({
        type: 'system_notification',
        subtype: 'task_notification',
      }),
    )
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'background_task_stop_failed',
      taskId: 'agent-task-persistence-retry',
      message: 'Agent stopped, but its terminal state could not be saved',
    })

    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    await flushMicrotasks()

    expect(append).toHaveBeenCalledTimes(4)
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'system_notification',
      subtype: 'task_notification',
      data: expect.objectContaining({
        task_id: 'agent-task-persistence-retry',
        status: 'stopped',
      }),
    })
  })

  it('times out a hung stopped bookend without pinning Agent finalization', async () => {
    const sessionId = `stop-agent-persistence-timeout-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    let cliRunning = true
    let outputCallback: ((cliMsg: any) => void) | null = null
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(() => 789 as any)
    spyOn(conversationService, 'hasSession').mockImplementation(() => cliRunning)
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallback = callback
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    const append = spyOn(sessionService, 'appendSessionTaskNotification').mockImplementation(
      () => new Promise<void>(() => {}),
    )
    spyOn(console, 'warn').mockImplementation(() => {})

    handleWebSocket.open(ws)
    outputCallback?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-task-persistence-timeout',
      tool_use_id: 'agent-tool-persistence-timeout',
      description: 'Bound a hung transcript write',
      task_type: 'local_agent',
    })
    cliRunning = false
    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))

    for (let attempt = 0; attempt < 3; attempt++) {
      await flushMicrotasks(30)
      expect(append).toHaveBeenCalledTimes(attempt + 1)
      const persistenceTimeouts = setTimeoutSpy.mock.calls.filter((call) => call[1] === 1_000)
      expect(persistenceTimeouts).toHaveLength(attempt + 1)
      const timeout = persistenceTimeouts[attempt]?.[0] as (() => void) | undefined
      expect(timeout).toBeTypeOf('function')
      timeout?.()
    }
    await flushMicrotasks(30)

    expect(append).toHaveBeenCalledTimes(3)
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'background_task_stop_failed',
      taskId: 'agent-task-persistence-timeout',
      message: 'Agent stopped, but its terminal state could not be saved',
    })
    expect(setTimeoutSpy.mock.calls.some((call) => call[1] === 250)).toBe(true)
  })

  it('does not let failed stop finalization pin a disconnected CLI', async () => {
    const sessionId = `stop-agent-finalization-disconnect-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId)
    const second = makeClientSocket(sessionId)
    let cliRunning = true
    let outputCallback: ((cliMsg: any) => void) | null = null
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(() => 456 as any)
    spyOn(conversationService, 'hasSession').mockImplementation(() => cliRunning)
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallback = callback
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(sessionService, 'appendSessionTaskNotification').mockRejectedValue(
      new Error('transcript unavailable'),
    )
    spyOn(console, 'warn').mockImplementation(() => {})
    __setDisconnectGraceMsForTests(1_234)

    handleWebSocket.open(first)
    outputCallback?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-task-finalization-disconnect',
      tool_use_id: 'agent-tool-finalization-disconnect',
      description: 'Stop before renderer disconnects',
      task_type: 'local_agent',
    })
    cliRunning = false
    handleWebSocket.message(first, JSON.stringify({ type: 'stop_generation' }))
    await flushMicrotasks()

    expect(first.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'background_task_stop_failed',
      taskId: 'agent-task-finalization-disconnect',
      message: 'Agent stopped, but its terminal state could not be saved',
    })

    setTimeoutSpy.mockClear()
    handleWebSocket.close(first, 1006, 'renderer closed after stop failure')
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(1_234)

    second.sent.length = 0
    handleWebSocket.open(second)
    expect(second.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'background_task_stop_failed',
      taskId: 'agent-task-finalization-disconnect',
      message: 'Agent stopped, but its terminal state could not be saved',
    })
  })

  it('keeps a failed remote archive retryable after disconnected CLI cleanup', async () => {
    const sessionId = `stop-agent-archive-reconnect-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId)
    const second = makeClientSocket(sessionId)
    let cliRunning = true
    let outputCallback: ((cliMsg: any) => void) | null = null
    let nextTimerId = 1
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      () => nextTimerId++ as any,
    )
    spyOn(conversationService, 'hasSession').mockImplementation(() => cliRunning)
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {
      cliRunning = false
    })
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallback = callback
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(conversationService, 'requestControl').mockResolvedValue({})
    const archiveRemoteSession = spyOn(teleportApi, 'archiveRemoteSession')
      .mockRejectedValueOnce(new Error('remote archive unavailable'))
      .mockResolvedValue()
    const append = spyOn(sessionService, 'appendSessionTaskNotification').mockResolvedValue()
    spyOn(console, 'warn').mockImplementation(() => {})
    __setDisconnectGraceMsForTests(1_234)

    handleWebSocket.open(first)
    outputCallback?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'remote-agent-archive-reconnect',
      tool_use_id: 'remote-agent-archive-reconnect-tool',
      description: 'Retry remote archive after reconnect',
      task_type: 'remote_agent',
      remote_session_id: 'remote-session-archive-reconnect',
    })
    handleWebSocket.message(first, JSON.stringify({ type: 'stop_generation' }))
    await flushMicrotasks()

    expect(first.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'background_task_stop_failed',
      taskId: 'remote-agent-archive-reconnect',
      message: 'remote archive unavailable',
    })

    handleWebSocket.close(first, 1006, 'renderer closed after archive failure')
    const expireDisconnectGrace = setTimeoutSpy.mock.calls.find((call) => call[1] === 1_234)?.[0] as
      | (() => void)
      | undefined
    expect(expireDisconnectGrace).toBeTypeOf('function')
    expireDisconnectGrace?.()
    expect(stopSession).toHaveBeenCalledWith(sessionId)

    handleWebSocket.open(second)
    expect(second.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'background_task_stop_failed',
      taskId: 'remote-agent-archive-reconnect',
      message: 'remote archive unavailable',
    })

    second.sent.length = 0
    handleWebSocket.message(second, JSON.stringify({ type: 'stop_generation' }))
    await flushMicrotasks()

    expect(archiveRemoteSession).toHaveBeenNthCalledWith(
      2,
      'remote-session-archive-reconnect',
      { timeoutMs: 1_500 },
    )
    expect(append).toHaveBeenCalledWith(sessionId, expect.objectContaining({
      taskId: 'remote-agent-archive-reconnect',
      status: 'stopped',
    }))
    expect(second.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'system_notification',
      subtype: 'task_notification',
      data: expect.objectContaining({
        task_id: 'remote-agent-archive-reconnect',
        status: 'stopped',
      }),
    })
  })

  it('closes stopped Agent activity when the CLI exit result arrives after Stop', async () => {
    const sessionId = `stop-agent-runtime-exit-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    let cliRunning = true
    let outputCallback: ((cliMsg: any) => void) | null = null
    spyOn(conversationService, 'hasSession').mockImplementation(() => cliRunning)
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallback = callback
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(conversationService, 'requestControl').mockImplementation(
      () => new Promise<Record<string, unknown>>(() => {}),
    )
    const append = spyOn(sessionService, 'appendSessionTaskNotification').mockResolvedValue()
    const archiveRemoteSession = spyOn(teleportApi, 'archiveRemoteSession').mockResolvedValue()

    handleWebSocket.open(ws)
    outputCallback?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-task-runtime-exit',
      tool_use_id: 'agent-tool-runtime-exit',
      description: 'Review provider failures',
      task_type: 'remote_agent',
      remote_session_id: 'remote-session-runtime-exit',
    })
    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    cliRunning = false
    outputCallback?.({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'CLI process exited unexpectedly (code 1): provider failed',
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    await flushMicrotasks()

    expect(append).toHaveBeenCalledWith(sessionId, expect.objectContaining({
      taskId: 'agent-task-runtime-exit',
      toolUseId: 'agent-tool-runtime-exit',
      status: 'stopped',
    }))
    expect(archiveRemoteSession).toHaveBeenCalledWith(
      'remote-session-runtime-exit',
      { timeoutMs: 1_500 },
    )
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'system_notification',
      subtype: 'task_notification',
      data: expect.objectContaining({
        task_id: 'agent-task-runtime-exit',
        tool_use_id: 'agent-tool-runtime-exit',
        status: 'stopped',
      }),
    })
  })

  it('automatically retries a confirmed local stop until remote archive succeeds', async () => {
    const sessionId = `stop-agent-archive-failed-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    let outputCallback: ((cliMsg: any) => void) | null = null
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(() => 1 as any)
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallback = callback
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    const requestControl = spyOn(conversationService, 'requestControl').mockImplementation(
      async () => {
        outputCallback?.({
          type: 'system',
          subtype: 'task_notification',
          task_id: 'remote-agent-archive-failed',
          tool_use_id: 'remote-agent-archive-failed-tool',
          task_type: 'remote_agent',
          status: 'stopped',
        })
        return {}
      },
    )
    const archiveRemoteSession = spyOn(teleportApi, 'archiveRemoteSession')
      .mockRejectedValueOnce(new Error('archive request timed out'))
      .mockResolvedValue()
    const append = spyOn(sessionService, 'appendSessionTaskNotification').mockResolvedValue()
    spyOn(console, 'warn').mockImplementation(() => {})

    handleWebSocket.open(ws)
    outputCallback?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'remote-agent-archive-failed',
      tool_use_id: 'remote-agent-archive-failed-tool',
      description: 'Remote review with failed archive',
      task_type: 'remote_agent',
      remote_session_id: 'remote-session-archive-failed',
    })
    ws.sent.length = 0

    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    await flushMicrotasks()

    expect(requestControl).toHaveBeenCalledWith(sessionId, {
      subtype: 'stop_task',
      task_id: 'remote-agent-archive-failed',
    }, 3_000)
    expect(append).not.toHaveBeenCalled()
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'background_task_stop_failed',
      taskId: 'remote-agent-archive-failed',
      message: 'archive request timed out',
    })
    expect(ws.sent.map((payload) => JSON.parse(payload))).not.toContainEqual({
      type: 'system_notification',
      subtype: 'task_notification',
      data: expect.objectContaining({
        task_id: 'remote-agent-archive-failed',
        status: 'stopped',
      }),
    })
    const expireForceKill = setTimeoutSpy.mock.calls[0]?.[0] as (() => void) | undefined
    expireForceKill?.()
    expect(stopSession).not.toHaveBeenCalled()

    const retryFinalization = setTimeoutSpy.mock.calls.find((call) => call[1] === 250)?.[0] as
      | (() => void)
      | undefined
    expect(retryFinalization).toBeTypeOf('function')
    retryFinalization?.()
    await flushMicrotasks()

    expect(requestControl).toHaveBeenCalledTimes(1)
    expect(archiveRemoteSession).toHaveBeenCalledTimes(2)
    expect(append).toHaveBeenCalledWith(sessionId, expect.objectContaining({
      taskId: 'remote-agent-archive-failed',
      status: 'stopped',
    }))
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'system_notification',
      subtype: 'task_notification',
      data: expect.objectContaining({
        task_id: 'remote-agent-archive-failed',
        status: 'stopped',
      }),
    })
  })

  it('routes an asynchronous Agent stop failure away from a disconnected socket', async () => {
    const sessionId = `stop-agent-replacement-client-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId)
    const second = makeClientSocket(sessionId)
    const outputCallbacks: Array<(cliMsg: any) => void> = []
    let rejectArchive: ((reason?: unknown) => void) | undefined
    spyOn(globalThis, 'setTimeout').mockImplementation(() => 1 as any)
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.push(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(conversationService, 'requestControl').mockResolvedValue({})
    spyOn(teleportApi, 'archiveRemoteSession').mockImplementation(
      () => new Promise<void>((_resolve, reject) => {
        rejectArchive = reject
      }),
    )
    spyOn(console, 'warn').mockImplementation(() => {})

    handleWebSocket.open(first)
    outputCallbacks[0]?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-task-replacement-client',
      tool_use_id: 'agent-tool-replacement-client',
      description: 'Stop across a renderer reconnect',
      task_type: 'remote_agent',
      remote_session_id: 'remote-session-replacement-client',
    })
    handleWebSocket.message(first, JSON.stringify({ type: 'stop_generation' }))
    await flushMicrotasks()

    handleWebSocket.close(first, 1006, 'renderer restarting during stop')
    handleWebSocket.open(second)
    first.sent.length = 0
    second.sent.length = 0

    rejectArchive?.(new Error('archive confirmation unavailable'))
    await flushMicrotasks()

    expect(first.sent).toHaveLength(0)
    expect(second.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'background_task_stop_failed',
      taskId: 'agent-task-replacement-client',
      message: 'archive confirmation unavailable',
    })
  })

  it('broadcasts a shared Agent stop failure to every requesting renderer', async () => {
    const sessionId = `stop-agent-concurrent-clients-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId)
    const second = makeClientSocket(sessionId)
    const outputCallbacks: Array<(cliMsg: any) => void> = []
    let rejectArchive: ((reason?: unknown) => void) | undefined
    spyOn(globalThis, 'setTimeout').mockImplementation(() => 1 as any)
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.push(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(conversationService, 'requestControl').mockResolvedValue({})
    spyOn(teleportApi, 'archiveRemoteSession').mockImplementation(
      () => new Promise<void>((_resolve, reject) => {
        rejectArchive = reject
      }),
    )
    spyOn(console, 'warn').mockImplementation(() => {})

    handleWebSocket.open(first)
    handleWebSocket.open(second)
    outputCallbacks[0]?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-task-concurrent-clients',
      tool_use_id: 'agent-tool-concurrent-clients',
      description: 'Stop from two renderers',
      task_type: 'remote_agent',
      remote_session_id: 'remote-session-concurrent-clients',
    })
    first.sent.length = 0
    second.sent.length = 0

    handleWebSocket.message(first, JSON.stringify({ type: 'stop_generation' }))
    handleWebSocket.message(second, JSON.stringify({ type: 'stop_generation' }))
    rejectArchive?.(new Error('shared archive confirmation failed'))
    await flushMicrotasks()

    const failure = {
      type: 'background_task_stop_failed',
      taskId: 'agent-task-concurrent-clients',
      message: 'shared archive confirmation failed',
    }
    expect(first.sent.map((payload) => JSON.parse(payload))).toContainEqual(failure)
    expect(second.sent.map((payload) => JSON.parse(payload))).toContainEqual(failure)
  })

  it('clears the transcript without waiting for independent strict remote Agent archival', async () => {
    const sessionId = `stop-agent-clear-generation-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    let outputCallback: ((cliMsg: any) => void) | null = null
    let resolveArchive: (() => void) | undefined
    spyOn(globalThis, 'setTimeout').mockImplementation(() => 1 as any)
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'getSessionWorkDir').mockReturnValue('/tmp/agent-clear-generation')
    spyOn(conversationService, 'getSessionPermissionMode').mockReturnValue('default')
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    spyOn(conversationService, 'clearOutputCallbacks').mockImplementation(() => {})
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallback = callback
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    const archiveRemoteSession = spyOn(teleportApi, 'archiveRemoteSession').mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveArchive = resolve
      }),
    )
    const append = spyOn(sessionService, 'appendSessionTaskNotification').mockResolvedValue()
    const clearTranscript = spyOn(sessionService, 'clearSessionTranscript').mockResolvedValue()

    handleWebSocket.open(ws)
    outputCallback?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'remote-agent-clear-generation',
      tool_use_id: 'remote-agent-clear-generation-tool',
      description: 'Finalize before replacing the CLI generation',
      task_type: 'remote_agent',
      remote_session_id: 'remote-session-clear-generation',
    })

    handleWebSocket.message(ws, JSON.stringify({ type: 'user_message', content: '/clear' }))
    await flushMicrotasks()
    expect(stopSession).toHaveBeenCalledWith(sessionId)
    expect(clearTranscript).toHaveBeenCalledWith(
      sessionId,
      '/tmp/agent-clear-generation',
      'default',
    )
    expect(archiveRemoteSession).toHaveBeenCalledWith(
      'remote-session-clear-generation',
      { timeoutMs: 1_500 },
    )

    resolveArchive?.()
    await flushMicrotasks()

    expect(append).not.toHaveBeenCalled()
    expect(ws.sent.map((payload) => JSON.parse(payload))).not.toContainEqual(
      expect.objectContaining({
        type: 'system_notification',
        subtype: 'task_notification',
      }),
    )
  })

  it('does not forward an old terminal event after transcript clear commits', async () => {
    const sessionId = `clear-terminal-forward-race-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    let outputCallback: ((cliMsg: any) => void) | null = null
    let resolveAppend!: () => void
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'getSessionWorkDir').mockReturnValue('/tmp/clear-terminal-forward-race')
    spyOn(conversationService, 'getSessionPermissionMode').mockReturnValue('default')
    spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    spyOn(conversationService, 'clearOutputCallbacks').mockImplementation(() => {})
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallback = callback
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(sessionService, 'clearSessionTranscript').mockResolvedValue()
    spyOn(sessionService, 'appendSessionTaskNotification').mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveAppend = resolve
      }),
    )

    handleWebSocket.open(ws)
    outputCallback?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-terminal-before-clear',
      tool_use_id: 'agent-terminal-before-clear-tool',
      task_type: 'local_agent',
      description: 'Terminal persistence overlaps clear',
    })
    ws.sent.length = 0
    outputCallback?.({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'agent-terminal-before-clear',
      tool_use_id: 'agent-terminal-before-clear-tool',
      task_type: 'local_agent',
      status: 'completed',
      summary: 'Old generation completed',
    })

    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: '/clear',
    }))
    await flushMicrotasks(30)
    resolveAppend()
    await flushMicrotasks(30)

    const sent = ws.sent.map((payload) => JSON.parse(payload))
    expect(sent).toContainEqual({
      type: 'system_notification',
      subtype: 'session_cleared',
      message: 'Conversation cleared',
    })
    expect(sent).not.toContainEqual(expect.objectContaining({
      type: 'system_notification',
      subtype: 'task_notification',
    }))
  })

  it('retries remote Agent archival independently while clearing the session', async () => {
    const sessionId = `stop-agent-clear-retry-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    let outputCallback: ((cliMsg: any) => void) | null = null
    spyOn(globalThis, 'setTimeout').mockImplementation((callback) => {
      queueMicrotask(() => (callback as () => void)())
      return 1 as any
    })
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'getSessionWorkDir').mockReturnValue('/tmp/agent-clear-retry')
    spyOn(conversationService, 'getSessionPermissionMode').mockReturnValue('default')
    spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    spyOn(conversationService, 'clearOutputCallbacks').mockImplementation(() => {})
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallback = callback
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    const archiveRemoteSession = spyOn(teleportApi, 'archiveRemoteSession')
      .mockRejectedValueOnce(new Error('temporary archive failure'))
      .mockResolvedValue()
    const append = spyOn(sessionService, 'appendSessionTaskNotification').mockResolvedValue()
    const clearTranscript = spyOn(sessionService, 'clearSessionTranscript').mockResolvedValue()

    handleWebSocket.open(ws)
    outputCallback?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'remote-agent-clear-retry',
      tool_use_id: 'remote-agent-clear-retry-tool',
      description: 'Retry archival after clear tears down runtime state',
      task_type: 'remote_agent',
      remote_session_id: 'remote-session-clear-retry',
    })

    handleWebSocket.message(ws, JSON.stringify({ type: 'user_message', content: '/clear' }))
    await flushMicrotasks(30)

    expect(archiveRemoteSession).toHaveBeenCalledTimes(2)
    expect(archiveRemoteSession).toHaveBeenNthCalledWith(
      2,
      'remote-session-clear-retry',
      { timeoutMs: 1_500 },
    )
    expect(clearTranscript).toHaveBeenCalledWith(
      sessionId,
      '/tmp/agent-clear-retry',
      'default',
    )
    expect(append).not.toHaveBeenCalled()
    expect(ws.sent.map((payload) => JSON.parse(payload))).not.toContainEqual(
      expect.objectContaining({ code: 'AGENT_STOP_UNCONFIRMED' }),
    )
  })

  it('reports a late clear archival failure without emitting a turn-terminal error', async () => {
    const sessionId = `stop-agent-clear-warning-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId)
    const second = makeClientSocket(sessionId)
    let outputCallback: ((cliMsg: any) => void) | null = null
    const archiveRejectors: Array<(reason?: unknown) => void> = []
    spyOn(globalThis, 'setTimeout').mockImplementation((callback) => {
      queueMicrotask(() => (callback as () => void)())
      return 1 as any
    })
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'getSessionWorkDir').mockReturnValue('/tmp/agent-clear-warning')
    spyOn(conversationService, 'getSessionPermissionMode').mockReturnValue('default')
    spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    spyOn(conversationService, 'clearOutputCallbacks').mockImplementation(() => {})
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallback = callback
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(sessionService, 'getCustomTitle').mockResolvedValue('Existing title')
    spyOn(sessionService, 'clearSessionTranscript').mockResolvedValue()
    const sendMessage = spyOn(conversationService, 'sendMessage').mockResolvedValue(true)
    spyOn(teleportApi, 'archiveRemoteSession').mockImplementation(
      () => new Promise<void>((_resolve, reject) => {
        archiveRejectors.push(reject)
      }),
    )
    spyOn(console, 'warn').mockImplementation(() => {})

    handleWebSocket.open(first)
    handleWebSocket.open(second)
    outputCallback?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'remote-agent-clear-warning',
      tool_use_id: 'remote-agent-clear-warning-tool',
      task_type: 'remote_agent',
      remote_session_id: 'remote-session-clear-warning',
      description: 'Archive after transcript clear',
    })
    handleWebSocket.message(first, JSON.stringify({
      type: 'user_message',
      content: '/clear',
    }))
    await flushMicrotasks(30)

    handleWebSocket.message(second, JSON.stringify({
      type: 'user_message',
      content: 'New turn after clear',
    }))
    await flushMicrotasks(30)
    expect(sendMessage).toHaveBeenCalledWith(
      sessionId,
      'New turn after clear',
      undefined,
      expect.objectContaining({
        canSend: expect.any(Function),
        messageUuid: expect.any(String),
        onCommitted: expect.any(Function),
      }),
    )

    for (let attempt = 0; attempt < 3; attempt++) {
      await flushMicrotasks(10)
      archiveRejectors[attempt]?.(new Error(`archive failure ${attempt + 1}`))
    }
    await flushMicrotasks(40)

    for (const client of [first, second]) {
      const sent = client.sent.map((payload) => JSON.parse(payload))
      expect(sent).toContainEqual({
        type: 'background_task_stop_failed',
        taskId: 'remote-agent-clear-warning',
        message: 'Conversation cleared, but one or more background Agents could not be fully stopped.',
      })
      expect(sent).not.toContainEqual(expect.objectContaining({
        type: 'error',
        code: 'AGENT_STOP_UNCONFIRMED',
      }))
    }
  })

  it('drains a user admission already waiting on CLI startup before clear commits', async () => {
    const sessionId = `clear-pending-startup-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId)
    const second = makeClientSocket(sessionId)
    let resolveStartup!: () => void
    let runtimeReady = false
    const pendingStartup = new Promise<void>((resolve) => {
      resolveStartup = () => {
        runtimeReady = true
        resolve()
      }
    })
    __registerPendingSessionStartupForTests(sessionId, pendingStartup)
    spyOn(conversationService, 'hasSession').mockImplementation(() => runtimeReady)
    spyOn(conversationService, 'getSessionWorkDir').mockReturnValue('/tmp/clear-pending-startup')
    spyOn(conversationService, 'getSessionPermissionMode').mockReturnValue('default')
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    spyOn(conversationService, 'clearOutputCallbacks').mockImplementation(() => {})
    spyOn(conversationService, 'onOutput').mockImplementation(() => {})
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(sessionService, 'getCustomTitle').mockResolvedValue('Existing title')
    const clearTranscript = spyOn(sessionService, 'clearSessionTranscript').mockResolvedValue()
    const sendMessage = spyOn(conversationService, 'sendMessage').mockResolvedValue(true)

    handleWebSocket.open(first)
    handleWebSocket.open(second)
    handleWebSocket.message(first, JSON.stringify({
      type: 'user_message',
      content: 'This admission is waiting for startup',
    }))
    await flushMicrotasks(20)

    handleWebSocket.message(second, JSON.stringify({
      type: 'user_message',
      content: '/clear',
    }))
    await flushMicrotasks(20)
    expect(clearTranscript).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()

    resolveStartup()
    await flushMicrotasks(40)

    expect(stopSession).toHaveBeenCalledWith(sessionId)
    expect(clearTranscript).toHaveBeenCalledWith(
      sessionId,
      '/tmp/clear-pending-startup',
      undefined,
    )
    expect(sendMessage).not.toHaveBeenCalled()
    for (const client of [first, second]) {
      expect(client.sent.map((payload) => JSON.parse(payload))).toContainEqual({
        type: 'system_notification',
        subtype: 'session_cleared',
        message: 'Conversation cleared',
      })
    }
  })

  it('does not cancel a new turn that queued behind an already-admitted clear', async () => {
    const sessionId = `clear-queued-replacement-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId)
    const second = makeClientSocket(sessionId)
    let releaseEarlierTransition!: () => void
    const earlierTransition = new Promise<void>((resolve) => {
      releaseEarlierTransition = resolve
    })
    void __enqueueRuntimeTransitionForTests(sessionId, earlierTransition)
    const order: string[] = []
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'getSessionWorkDir').mockReturnValue('/tmp/clear-queued-replacement')
    spyOn(conversationService, 'getSessionPermissionMode').mockReturnValue('default')
    spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    spyOn(conversationService, 'clearOutputCallbacks').mockImplementation(() => {})
    spyOn(conversationService, 'onOutput').mockImplementation(() => {})
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(sessionService, 'getCustomTitle').mockResolvedValue('Existing title')
    spyOn(sessionService, 'clearSessionTranscript').mockImplementation(async () => {
      order.push('clear')
    })
    const sendMessage = spyOn(conversationService, 'sendMessage').mockImplementation(async () => {
      order.push('send')
      return true
    })

    handleWebSocket.open(first)
    handleWebSocket.open(second)
    handleWebSocket.message(first, JSON.stringify({
      type: 'user_message',
      content: '/clear',
    }))
    handleWebSocket.message(second, JSON.stringify({
      type: 'user_message',
      content: 'Run after the queued clear',
    }))
    await flushMicrotasks(20)
    expect(sendMessage).not.toHaveBeenCalled()

    releaseEarlierTransition()
    await flushMicrotasks(60)

    expect(order).toEqual(['clear', 'send'])
    expect(sendMessage).toHaveBeenCalledWith(
      sessionId,
      'Run after the queued clear',
      undefined,
      expect.objectContaining({
        canSend: expect.any(Function),
        messageUuid: expect.any(String),
        onCommitted: expect.any(Function),
      }),
    )
  })

  it('serializes a new turn behind transcript clear without waiting for remote archival', async () => {
    const sessionId = `stop-agent-clear-barrier-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId)
    const second = makeClientSocket(sessionId)
    let outputCallback: ((cliMsg: any) => void) | null = null
    let resolveClear!: () => void
    let resolveArchive!: () => void
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'getSessionWorkDir').mockReturnValue('/tmp/agent-clear-barrier')
    spyOn(conversationService, 'getSessionPermissionMode').mockReturnValue('default')
    spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    spyOn(conversationService, 'clearOutputCallbacks').mockImplementation(() => {})
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallback = callback
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    const getCustomTitle = spyOn(sessionService, 'getCustomTitle').mockResolvedValue('Existing title')
    const sendMessage = spyOn(conversationService, 'sendMessage').mockResolvedValue(true)
    spyOn(sessionService, 'clearSessionTranscript').mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveClear = resolve
      }),
    )
    spyOn(teleportApi, 'archiveRemoteSession').mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveArchive = resolve
      }),
    )

    handleWebSocket.open(first)
    handleWebSocket.open(second)
    outputCallback?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'remote-agent-clear-barrier',
      tool_use_id: 'remote-agent-clear-barrier-tool',
      task_type: 'remote_agent',
      remote_session_id: 'remote-session-clear-barrier',
      description: 'Archive independently of the clear barrier',
    })
    handleWebSocket.message(first, JSON.stringify({ type: 'user_message', content: '/clear' }))
    await flushMicrotasks()

    handleWebSocket.message(second, JSON.stringify({
      type: 'user_message',
      content: 'Start only after clear commits',
    }))
    await flushMicrotasks()
    expect(getCustomTitle).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()

    resolveClear()
    await flushMicrotasks(30)

    for (const client of [first, second]) {
      expect(client.sent.map((payload) => JSON.parse(payload))).toContainEqual({
        type: 'system_notification',
        subtype: 'session_cleared',
        message: 'Conversation cleared',
      })
    }
    expect(getCustomTitle).toHaveBeenCalledWith(sessionId)
    expect(sendMessage).toHaveBeenCalledWith(
      sessionId,
      'Start only after clear commits',
      undefined,
      expect.objectContaining({
        canSend: expect.any(Function),
        messageUuid: expect.any(String),
        onCommitted: expect.any(Function),
      }),
    )
    resolveArchive()
    await flushMicrotasks()
  })

  it('persists stopped Agent bookends when transcript clear fails', async () => {
    const sessionId = `stop-agent-clear-failed-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId)
    const second = makeClientSocket(sessionId)
    let outputCallback: ((cliMsg: any) => void) | null = null
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'getSessionWorkDir').mockReturnValue('/tmp/agent-clear-failed')
    spyOn(conversationService, 'getSessionPermissionMode').mockReturnValue('default')
    spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    spyOn(conversationService, 'clearOutputCallbacks').mockImplementation(() => {})
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallback = callback
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(sessionService, 'clearSessionTranscript').mockRejectedValue(
      new Error('transcript replacement failed'),
    )
    const append = spyOn(sessionService, 'appendSessionTaskNotification').mockResolvedValue()

    handleWebSocket.open(first)
    handleWebSocket.open(second)
    outputCallback?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'local-agent-clear-failed',
      tool_use_id: 'local-agent-clear-failed-tool',
      task_type: 'local_agent',
      description: 'Retain a terminal state after clear fails',
    })
    outputCallback?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'bash-clear-failed',
      tool_use_id: 'bash-clear-failed-tool',
      task_type: 'local_bash',
      description: 'Shell work in the runtime whose clear fails',
    })
    handleWebSocket.message(first, JSON.stringify({ type: 'user_message', content: '/clear' }))
    await flushMicrotasks(30)

    for (const client of [first, second]) {
      expect(client.sent.map((payload) => JSON.parse(payload))).toContainEqual({
        type: 'error',
        message: 'transcript replacement failed',
        code: 'SESSION_CLEAR_FAILED',
      })
      expect(client.sent.map((payload) => JSON.parse(payload))).toContainEqual({
        type: 'status',
        state: 'idle',
      })
    }
    expect(append).toHaveBeenCalledWith(sessionId, expect.objectContaining({
      taskId: 'local-agent-clear-failed',
      status: 'stopped',
    }))
    expect(first.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'system_notification',
      subtype: 'task_notification',
      data: expect.objectContaining({
        task_id: 'local-agent-clear-failed',
        status: 'stopped',
      }),
    })
    expect(append).toHaveBeenCalledWith(sessionId, expect.objectContaining({
      taskId: 'bash-clear-failed',
      toolUseId: 'bash-clear-failed-tool',
      status: 'stopped',
    }))
    expect(first.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'system_notification',
      subtype: 'task_notification',
      data: expect.objectContaining({
        task_id: 'bash-clear-failed',
        status: 'stopped',
      }),
    })
  })

  it('keeps an archived remote Agent stopped when its local control response is lost', async () => {
    const sessionId = `stop-agent-archive-control-race-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId)
    const second = makeClientSocket(sessionId)
    const outputCallbacks: Array<(cliMsg: any) => void> = []
    let rejectControl: ((reason?: unknown) => void) | undefined
    spyOn(globalThis, 'setTimeout').mockImplementation(() => 1 as any)
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.push(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    const requestControl = spyOn(conversationService, 'requestControl').mockImplementation(
      () => new Promise<Record<string, unknown>>((_resolve, reject) => {
        rejectControl = reject
      }),
    )
    const archiveRemoteSession = spyOn(teleportApi, 'archiveRemoteSession').mockResolvedValue()
    const append = spyOn(sessionService, 'appendSessionTaskNotification').mockResolvedValue()

    handleWebSocket.open(first)
    handleWebSocket.open(second)
    const taskStarted = {
      type: 'system',
      subtype: 'task_started',
      task_id: 'remote-agent-control-race',
      tool_use_id: 'remote-agent-control-race-tool',
      description: 'Remote review with a lost control response',
      task_type: 'remote_agent',
      remote_session_id: 'remote-session-control-race',
    }
    for (const callback of outputCallbacks) callback(taskStarted)
    first.sent.length = 0
    second.sent.length = 0

    handleWebSocket.message(second, JSON.stringify({ type: 'stop_generation' }))
    await flushMicrotasks()

    const cliCompletedAfterArchive = {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'remote-agent-control-race',
      tool_use_id: 'remote-agent-control-race-tool',
      task_type: 'remote_agent',
      status: 'completed',
      summary: 'Remote task completed successfully',
    }
    for (const callback of outputCallbacks) callback(cliCompletedAfterArchive)
    await flushMicrotasks()
    rejectControl?.(new Error('Control response was lost'))
    await flushMicrotasks()

    // Every callback observes the same late CLI event. Repeat it after the
    // synthetic bookend to prove the session tombstone suppresses all observers.
    for (const callback of outputCallbacks) callback(cliCompletedAfterArchive)
    const lateProgressAfterStop = {
      type: 'system',
      subtype: 'task_progress',
      task_id: 'remote-agent-control-race',
      tool_use_id: 'remote-agent-control-race-tool',
      task_type: 'remote_agent',
      description: 'Remote review with a lost control response',
      summary: 'A stale poll still reported progress',
    }
    for (const callback of outputCallbacks) callback(lateProgressAfterStop)
    await flushMicrotasks()

    expect(requestControl.mock.calls).toEqual([
      [sessionId, { subtype: 'stop_task', task_id: 'remote-agent-control-race' }, 3_000],
    ])
    expect(archiveRemoteSession).toHaveBeenCalledTimes(1)
    expect(append).toHaveBeenCalledTimes(1)
    expect(append).toHaveBeenCalledWith(sessionId, expect.objectContaining({
      taskId: 'remote-agent-control-race',
      status: 'stopped',
    }))
    for (const ws of [first, second]) {
      const terminalStatuses = ws.sent
        .map((payload) => JSON.parse(payload))
        .filter((payload) =>
          payload.type === 'system_notification' &&
          payload.subtype === 'task_notification' &&
          payload.data?.task_id === 'remote-agent-control-race',
        )
        .map((payload) => payload.data.status)
      expect(terminalStatuses).toEqual(['stopped'])
      expect(ws.sent.map((payload) => JSON.parse(payload))).not.toContainEqual({
        type: 'system_notification',
        subtype: 'task_progress',
        data: expect.objectContaining({ task_id: 'remote-agent-control-race' }),
      })
    }
  })

  it('stops a late Agent exactly once after the interrupted result closes the foreground turn', async () => {
    const sessionId = `stop-agent-late-start-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId)
    const second = makeClientSocket(sessionId)
    const outputCallbacks: Array<(cliMsg: any) => void> = []
    let cliRunning = true
    spyOn(conversationService, 'hasSession').mockImplementation(() => cliRunning)
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.push(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    const requestControl = spyOn(conversationService, 'requestControl').mockImplementation(
      async () => {
        cliRunning = false
        throw new Error('CLI session is not running')
      },
    )
    spyOn(sessionService, 'appendSessionTaskNotification').mockResolvedValue()
    const archiveRemoteSession = spyOn(teleportApi, 'archiveRemoteSession').mockResolvedValue()

    handleWebSocket.open(first)
    handleWebSocket.open(second)
    handleWebSocket.message(first, JSON.stringify({ type: 'stop_generation' }))
    for (const callback of outputCallbacks) {
      callback({
        type: 'result',
        subtype: 'error',
        is_error: true,
        result: 'Interrupted',
        usage: { input_tokens: 0, output_tokens: 0 },
      })
    }
    first.sent.length = 0
    second.sent.length = 0

    const lateAgent = {
      type: 'system',
      subtype: 'task_started',
      task_id: 'late-agent-task',
      tool_use_id: 'late-agent-tool',
      description: 'Late detached review',
      task_type: 'remote_agent',
      remote_session_id: 'remote-session-late-agent',
    }
    for (const callback of outputCallbacks) callback(lateAgent)
    await flushMicrotasks()

    expect(requestControl.mock.calls).toEqual([
      [sessionId, { subtype: 'stop_task', task_id: 'late-agent-task' }, 3_000],
    ])
    expect(archiveRemoteSession).toHaveBeenCalledWith(
      'remote-session-late-agent',
      { timeoutMs: 1_500 },
    )
    for (const ws of [first, second]) {
      const sent = ws.sent.map((payload) => JSON.parse(payload))
      expect(sent).not.toContainEqual({
        type: 'status',
        state: 'tool_executing',
        verb: 'Late detached review',
      })
      expect(sent).toContainEqual({
        type: 'system_notification',
        subtype: 'task_notification',
        data: expect.objectContaining({
          task_id: 'late-agent-task',
          tool_use_id: 'late-agent-tool',
          status: 'stopped',
        }),
      })
      expect(sent).not.toContainEqual(
        expect.objectContaining({ type: 'background_task_stop_failed' }),
      )
    }

    const lateBash = {
      type: 'system',
      subtype: 'task_started',
      task_id: 'late-bash-task',
      tool_use_id: 'late-bash-tool',
      description: 'Late shell task',
      task_type: 'local_bash',
    }
    for (const callback of outputCallbacks) callback(lateBash)
    await Promise.resolve()

    expect(requestControl).toHaveBeenCalledTimes(1)
  })

  it('force-stops and closes a late Agent when task-scoped control fails', async () => {
    const sessionId = `stop-agent-late-failure-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId)
    const second = makeClientSocket(sessionId)
    const outputCallbacks: Array<(cliMsg: any) => void> = []
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.push(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    const requestControl = spyOn(conversationService, 'requestControl').mockRejectedValue(
      new Error('Late Agent stop failed'),
    )
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    spyOn(sessionService, 'appendSessionTaskNotification').mockResolvedValue()

    handleWebSocket.open(first)
    handleWebSocket.open(second)
    handleWebSocket.message(second, JSON.stringify({ type: 'stop_generation' }))
    first.sent.length = 0
    second.sent.length = 0

    const lateAgent = {
      type: 'system',
      subtype: 'task_started',
      task_id: 'late-agent-failure-task',
      tool_use_id: 'late-agent-failure-tool',
      description: 'Late detached review',
      task_type: 'local_agent',
    }
    for (const callback of outputCallbacks) callback(lateAgent)
    await flushMicrotasks()

    expect(requestControl.mock.calls).toEqual([
      [sessionId, { subtype: 'stop_task', task_id: 'late-agent-failure-task' }, 3_000],
    ])
    expect(stopSession).toHaveBeenCalledWith(sessionId)
    for (const ws of [first, second]) {
      expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
        type: 'system_notification',
        subtype: 'task_notification',
        data: expect.objectContaining({
          task_id: 'late-agent-failure-task',
          status: 'stopped',
        }),
      })
    }
  })

  it('keeps the Agent stop latch when a replacement user message is rejected', async () => {
    const sessionId = `stop-agent-invalid-message-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    let outputCallback: ((cliMsg: any) => void) | null = null
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallback = callback
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    const requestControl = spyOn(conversationService, 'requestControl').mockResolvedValue({})

    handleWebSocket.open(ws)
    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: '/clear unexpected',
    }))
    await Promise.resolve()

    outputCallback?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'late-agent-after-invalid-message',
      tool_use_id: 'late-agent-after-invalid-message-tool',
      description: 'Late Agent after rejected message',
      task_type: 'local_agent',
    })
    await Promise.resolve()

    expect(requestControl).toHaveBeenCalledWith(sessionId, {
      subtype: 'stop_task',
      task_id: 'late-agent-after-invalid-message',
    }, 3_000)
  })

  it('keeps the Agent stop latch while a replacement send is pending or fails', async () => {
    const sessionId = `stop-agent-pending-message-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const outputCallbacks = new Set<(cliMsg: any) => void>()
    let resolveSend!: (sent: boolean) => void
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.add(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation((_sid, callback) => {
      outputCallbacks.delete(callback)
    })
    spyOn(sessionService, 'getCustomTitle').mockResolvedValue('Existing title')
    spyOn(conversationService, 'sendMessage').mockImplementation(
      () => new Promise<boolean>((resolve) => {
        resolveSend = resolve
      }),
    )
    const requestControl = spyOn(conversationService, 'requestControl').mockResolvedValue({})

    const emitAgentStart = (taskId: string) => {
      const event = {
        type: 'system',
        subtype: 'task_started',
        task_id: taskId,
        tool_use_id: `${taskId}-tool`,
        description: taskId,
        task_type: 'local_agent',
      }
      for (const callback of [...outputCallbacks]) callback(event)
    }

    handleWebSocket.open(ws)
    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: '',
    }))
    await flushMicrotasks()

    emitAgentStart('agent-while-send-pending')
    await flushMicrotasks()
    expect(requestControl).toHaveBeenCalledWith(sessionId, {
      subtype: 'stop_task',
      task_id: 'agent-while-send-pending',
    }, 3_000)

    resolveSend(false)
    await flushMicrotasks()
    emitAgentStart('agent-after-send-failed')
    await flushMicrotasks()
    expect(requestControl).toHaveBeenCalledWith(sessionId, {
      subtype: 'stop_task',
      task_id: 'agent-after-send-failed',
    }, 3_000)
  })

  it('cancels the same pending user admission when Stop arrives before CLI startup', async () => {
    const sessionId = `stop-pending-admission-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    let resolveTitle!: (title: string | null) => void
    spyOn(conversationService, 'hasSession').mockReturnValue(false)
    const startSession = spyOn(conversationService, 'startSession').mockResolvedValue()
    const sendMessage = spyOn(conversationService, 'sendMessage').mockResolvedValue(true)
    spyOn(sessionService, 'getCustomTitle').mockImplementation(
      () => new Promise((resolve) => {
        resolveTitle = resolve
      }),
    )

    handleWebSocket.open(ws)
    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: 'Do not start this turn after Stop',
    }))
    await flushMicrotasks()

    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    resolveTitle(null)
    await flushMicrotasks(30)

    expect(startSession).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('broadcasts foreground Stop and its force-kill fallback to every renderer', () => {
    const sessionId = `stop-multi-renderer-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId)
    const second = makeClientSocket(sessionId)
    let forceKill!: () => void
    spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay) => {
      if (delay === 3_000) forceKill = callback as () => void
      return 1 as any
    })
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'sendInterrupt').mockReturnValue(true)
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})

    handleWebSocket.open(first)
    handleWebSocket.open(second)
    __markActiveTurnForTests(sessionId)
    first.sent.length = 0
    second.sent.length = 0

    handleWebSocket.message(first, JSON.stringify({ type: 'stop_generation' }))

    for (const client of [first, second]) {
      expect(client.sent.map((payload) => JSON.parse(payload))).toContainEqual({
        type: 'status',
        state: 'idle',
      })
    }
    forceKill()
    expect(stopSession).toHaveBeenCalledWith(sessionId)
  })

  it('reaps a send that was still awaiting acknowledgement when Stop arrived', async () => {
    const sessionId = `stop-inflight-send-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    let resolveSend!: (sent: boolean) => void
    const timerCallbacks: Array<() => void> = []
    spyOn(globalThis, 'setTimeout').mockImplementation((callback) => {
      timerCallbacks.push(callback as () => void)
      return 1 as any
    })
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation(() => {})
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(sessionService, 'getCustomTitle').mockResolvedValue('Existing title')
    spyOn(conversationService, 'sendMessage').mockImplementation(
      () => new Promise<boolean>((resolve) => {
        resolveSend = resolve
      }),
    )
    const sendInterrupt = spyOn(conversationService, 'sendInterrupt').mockReturnValue(true)
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})

    handleWebSocket.open(ws)
    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: 'This send has already entered the runtime',
    }))
    await flushMicrotasks(30)

    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    expect(sendInterrupt).toHaveBeenCalledWith(sessionId)

    resolveSend(true)
    await flushMicrotasks(30)
    expect(stopSession).toHaveBeenCalledWith(sessionId)

    for (const callback of timerCallbacks) callback()
    expect(stopSession).toHaveBeenCalledWith(sessionId)
  })

  it('keeps the committed turn boundary callback when Stop wins the await continuation', async () => {
    const sessionId = `stop-committed-send-continuation-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const outputCallbacks = new Set<(cliMsg: any) => void>()
    let releaseSend!: () => void
    const sendContinuation = new Promise<void>((resolve) => {
      releaseSend = resolve
    })
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.add(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation((_sid, callback) => {
      outputCallbacks.delete(callback)
    })
    spyOn(conversationService, 'sendInterrupt').mockReturnValue(true)
    spyOn(sessionService, 'getCustomTitle').mockResolvedValue('Existing title')
    spyOn(conversationService, 'sendMessage').mockImplementation(
      async (_sid, _content, _attachments, options) => {
        options?.onCommitted?.()
        await sendContinuation
        return true
      },
    )

    handleWebSocket.open(ws)
    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: 'Committed before the handler resumed',
    }))
    await flushMicrotasks(30)
    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    releaseSend()
    await flushMicrotasks(30)

    const interruptedResult = {
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'Interrupted',
      usage: { input_tokens: 0, output_tokens: 0 },
    }
    for (const callback of [...outputCallbacks]) callback(interruptedResult)
    await flushMicrotasks()
    ws.sent.length = 0
    handleWebSocket.message(ws, JSON.stringify({ type: 'sync_state' }))

    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'session_state',
      turnState: 'idle',
      activeBackgroundTaskIds: [],
    })
  })

  it('does not let an old pending-send fallback kill a replacement admission', async () => {
    const sessionId = `stop-pending-send-replacement-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    let resolveFirstSend!: (sent: boolean) => void
    let resolveSecondSend!: (sent: boolean) => void
    let sendCount = 0
    let forceKill!: () => void
    spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay) => {
      if (delay === 3_000) forceKill = callback as () => void
      return 1 as any
    })
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation(() => {})
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(conversationService, 'sendInterrupt').mockReturnValue(true)
    spyOn(sessionService, 'getCustomTitle').mockResolvedValue('Existing title')
    spyOn(conversationService, 'sendMessage').mockImplementation(() => {
      sendCount++
      return new Promise<boolean>((resolve) => {
        if (sendCount === 1) resolveFirstSend = resolve
        else resolveSecondSend = resolve
      })
    })
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})

    handleWebSocket.open(ws)
    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: 'Old turn with pending send acknowledgement',
    }))
    await flushMicrotasks(30)
    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: 'Replacement turn owns the runtime now',
    }))
    await flushMicrotasks(30)

    forceKill()
    expect(stopSession).not.toHaveBeenCalled()

    resolveFirstSend(true)
    await flushMicrotasks(20)
    expect(stopSession).not.toHaveBeenCalled()

    resolveSecondSend(true)
    await flushMicrotasks(20)
    expect(stopSession).not.toHaveBeenCalled()
  })

  it('releases the Agent stop latch only after the replacement replay is attributed', async () => {
    const sessionId = `stop-agent-successful-message-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const outputCallbacks = new Set<(cliMsg: any) => void>()
    let resolveSend!: (sent: boolean) => void
    let commitSend!: () => void
    let replacementUuid = ''
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.add(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation((_sid, callback) => {
      outputCallbacks.delete(callback)
    })
    spyOn(sessionService, 'getCustomTitle').mockResolvedValue('Existing title')
    spyOn(conversationService, 'sendMessage').mockImplementation(
      (_sid, _content, _attachments, options) => new Promise<boolean>((resolve) => {
        replacementUuid = options?.messageUuid ?? ''
        commitSend = options?.onCommitted ?? (() => {})
        resolveSend = resolve
      }),
    )
    const requestControl = spyOn(conversationService, 'requestControl').mockResolvedValue({})

    const emitAgentStart = (taskId: string) => {
      const event = {
        type: 'system',
        subtype: 'task_started',
        task_id: taskId,
        tool_use_id: `${taskId}-tool`,
        description: taskId,
        task_type: 'local_agent',
      }
      for (const callback of [...outputCallbacks]) callback(event)
    }
    const emitReplay = (content: string, uuid: string) => {
      const event = {
        type: 'user',
        isReplay: true,
        uuid,
        message: { role: 'user', content },
      }
      for (const callback of [...outputCallbacks]) callback(event)
    }

    handleWebSocket.open(ws)
    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: 'Replacement turn owns this boundary',
    }))
    await flushMicrotasks()

    emitAgentStart('agent-before-send-succeeds')
    await flushMicrotasks()
    expect(requestControl).toHaveBeenCalledTimes(1)

    commitSend()
    resolveSend(true)
    await flushMicrotasks()
    emitAgentStart('agent-after-send-ack')
    await flushMicrotasks()
    expect(requestControl).toHaveBeenCalledTimes(2)

    emitReplay('Replacement turn owns this boundary', crypto.randomUUID())
    emitAgentStart('agent-after-wrong-replay')
    await flushMicrotasks()
    expect(requestControl).toHaveBeenCalledTimes(3)

    emitReplay('Replacement turn owns this boundary', replacementUuid)
    emitAgentStart('agent-after-matching-replay')
    await flushMicrotasks()
    expect(requestControl).toHaveBeenCalledTimes(3)
  })

  it('does not attribute an interrupted result or stale replay to a replacement turn', async () => {
    const sessionId = `stop-replacement-boundary-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const outputCallbacks = new Set<(cliMsg: any) => void>()
    const sentUuids: string[] = []
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.add(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation((_sid, callback) => {
      outputCallbacks.delete(callback)
    })
    spyOn(conversationService, 'sendInterrupt').mockReturnValue(true)
    spyOn(sessionService, 'getCustomTitle').mockResolvedValue('Existing title')
    spyOn(conversationService, 'sendMessage').mockImplementation(
      async (_sid, _content, _attachments, options) => {
        sentUuids.push(options?.messageUuid ?? '')
        options?.onCommitted?.()
        return true
      },
    )
    const requestControl = spyOn(conversationService, 'requestControl').mockResolvedValue({})
    spyOn(sessionService, 'appendSessionTaskNotification').mockResolvedValue()

    const emit = (event: any) => {
      for (const callback of [...outputCallbacks]) callback(event)
    }
    const emitAgentStart = (taskId: string) => emit({
      type: 'system',
      subtype: 'task_started',
      task_id: taskId,
      tool_use_id: `${taskId}-tool`,
      description: taskId,
      task_type: 'local_agent',
    })

    handleWebSocket.open(ws)
    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: 'Repeat this exact prompt',
    }))
    await flushMicrotasks(30)
    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: 'Repeat this exact prompt',
    }))
    await flushMicrotasks(30)
    ws.sent.length = 0

    emit({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'Interrupted',
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    emit({
      type: 'user',
      isReplay: true,
      uuid: sentUuids[0],
      message: { role: 'user', content: 'Repeat this exact prompt' },
    })
    emitAgentStart('agent-before-replacement-replay')
    await flushMicrotasks()

    const beforeReplacementReplay = ws.sent.map((payload) => JSON.parse(payload))
    expect(beforeReplacementReplay).not.toContainEqual(expect.objectContaining({ type: 'error' }))
    expect(beforeReplacementReplay).not.toContainEqual({
      type: 'message_complete',
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    expect(requestControl).toHaveBeenCalledWith(sessionId, {
      subtype: 'stop_task',
      task_id: 'agent-before-replacement-replay',
    }, 3_000)

    emit({
      type: 'user',
      isReplay: true,
      uuid: sentUuids[1],
      message: { role: 'user', content: 'Repeat this exact prompt' },
    })
    emitAgentStart('agent-owned-by-replacement')
    emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      usage: { input_tokens: 1, output_tokens: 2 },
    })
    await flushMicrotasks()

    expect(requestControl).not.toHaveBeenCalledWith(sessionId, {
      subtype: 'stop_task',
      task_id: 'agent-owned-by-replacement',
    }, 3_000)
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'message_complete',
      usage: {
        input_tokens: 1,
        output_tokens: 2,
      },
    })
  })

  it('keeps consecutive Stop results ordered before a third replacement turn', async () => {
    const sessionId = `stop-replacement-consecutive-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const outputCallbacks = new Set<(cliMsg: any) => void>()
    const sentUuids: string[] = []
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.add(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation((_sid, callback) => {
      outputCallbacks.delete(callback)
    })
    spyOn(conversationService, 'sendInterrupt').mockReturnValue(true)
    spyOn(sessionService, 'getCustomTitle').mockResolvedValue('Existing title')
    spyOn(conversationService, 'sendMessage').mockImplementation(
      async (_sid, _content, _attachments, options) => {
        sentUuids.push(options?.messageUuid ?? '')
        options?.onCommitted?.()
        return true
      },
    )
    const requestControl = spyOn(conversationService, 'requestControl').mockResolvedValue({})
    spyOn(sessionService, 'appendSessionTaskNotification').mockResolvedValue()

    const emit = (event: any) => {
      for (const callback of [...outputCallbacks]) callback(event)
    }
    const sendTurn = async () => {
      handleWebSocket.message(ws, JSON.stringify({
        type: 'user_message',
        content: 'Same prompt across every turn',
      }))
      await flushMicrotasks(30)
    }

    handleWebSocket.open(ws)
    await sendTurn()
    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    await sendTurn()
    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    await sendTurn()
    ws.sent.length = 0

    for (let index = 0; index < 2; index++) {
      emit({
        type: 'result',
        subtype: 'error',
        is_error: true,
        result: 'Interrupted',
        usage: { input_tokens: 0, output_tokens: 0 },
      })
    }
    emit({
      type: 'user',
      isReplay: true,
      uuid: sentUuids[1],
      message: { role: 'user', content: 'Same prompt across every turn' },
    })
    emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-before-third-boundary',
      tool_use_id: 'agent-before-third-boundary-tool',
      description: 'Agent before third boundary',
      task_type: 'local_agent',
    })
    await flushMicrotasks()

    expect(ws.sent.map((payload) => JSON.parse(payload))).not.toContainEqual(
      expect.objectContaining({ type: 'message_complete' }),
    )
    expect(requestControl).toHaveBeenCalledWith(sessionId, {
      subtype: 'stop_task',
      task_id: 'agent-before-third-boundary',
    }, 3_000)

    emit({
      type: 'user',
      isReplay: true,
      uuid: sentUuids[2],
      message: { role: 'user', content: 'Same prompt across every turn' },
    })
    emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    await flushMicrotasks()

    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  })

  it('does not wait for an interrupted result when the old runtime is already gone', async () => {
    const sessionId = `stop-replacement-no-runtime-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const outputCallbacks = new Set<(cliMsg: any) => void>()
    let cliRunning = false
    let replacementUuid = ''
    spyOn(conversationService, 'hasSession').mockImplementation(() => cliRunning)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.add(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation((_sid, callback) => {
      outputCallbacks.delete(callback)
    })
    spyOn(sessionService, 'getCustomTitle').mockResolvedValue('Existing title')
    spyOn(conversationService, 'sendMessage').mockImplementation(
      async (_sid, _content, _attachments, options) => {
        replacementUuid = options?.messageUuid ?? ''
        options?.onCommitted?.()
        return true
      },
    )
    const requestControl = spyOn(conversationService, 'requestControl').mockResolvedValue({})

    handleWebSocket.open(ws)
    __markActiveTurnForTests(sessionId)
    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))

    cliRunning = true
    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: 'Replacement on a fresh runtime',
    }))
    await flushMicrotasks(30)
    const replay = {
      type: 'user',
      isReplay: true,
      uuid: replacementUuid,
      message: { role: 'user', content: 'Replacement on a fresh runtime' },
    }
    for (const callback of [...outputCallbacks]) callback(replay)
    const agentStart = {
      type: 'system',
      subtype: 'task_started',
      task_id: 'fresh-runtime-agent',
      tool_use_id: 'fresh-runtime-agent-tool',
      description: 'Fresh runtime Agent',
      task_type: 'local_agent',
    }
    for (const callback of [...outputCallbacks]) callback(agentStart)
    await flushMicrotasks()

    expect(requestControl).not.toHaveBeenCalled()
  })

  it('uses a matching local slash command as the replacement boundary', async () => {
    const sessionId = `stop-replacement-local-command-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const outputCallbacks = new Set<(cliMsg: any) => void>()
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.add(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation((_sid, callback) => {
      outputCallbacks.delete(callback)
    })
    spyOn(conversationService, 'sendInterrupt').mockReturnValue(true)
    spyOn(sessionService, 'getCustomTitle').mockResolvedValue('Existing title')
    spyOn(conversationService, 'sendMessage').mockImplementation(
      async (_sid, _content, _attachments, options) => {
        options?.onCommitted?.()
        return true
      },
    )
    const requestControl = spyOn(conversationService, 'requestControl').mockResolvedValue({})

    const emit = (event: any) => {
      for (const callback of [...outputCallbacks]) callback(event)
    }

    handleWebSocket.open(ws)
    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: 'Interrupted before a local command',
    }))
    await flushMicrotasks(30)
    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: '/goal clear',
    }))
    await flushMicrotasks(30)
    ws.sent.length = 0

    emit({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'Interrupted',
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    emit({
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/goal</command-name>\n<command-args>clear</command-args>',
    })
    emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-after-local-command-boundary',
      tool_use_id: 'agent-after-local-command-boundary-tool',
      description: 'Agent after local command boundary',
      task_type: 'local_agent',
    })
    emit({
      type: 'system',
      subtype: 'local_command_output',
      content: '<local-command-stdout>Goal cleared.</local-command-stdout>',
    })
    emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    await flushMicrotasks()

    expect(requestControl).not.toHaveBeenCalledWith(sessionId, {
      subtype: 'stop_task',
      task_id: 'agent-after-local-command-boundary',
    }, 3_000)
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'system_notification',
      subtype: 'goal_event',
      message: 'Goal cleared.',
      data: expect.objectContaining({
        action: 'cleared',
      }),
    })
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'message_complete',
      usage: { input_tokens: 0, output_tokens: 0 },
    })
  })

  it('completes a local slash replacement after Agent control failure kills the runtime', async () => {
    const sessionId = `stop-replacement-local-command-agent-failure-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const outputCallbacks = new Set<(cliMsg: any) => void>()
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.add(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation((_sid, callback) => {
      outputCallbacks.delete(callback)
    })
    spyOn(conversationService, 'sendInterrupt').mockReturnValue(true)
    spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    spyOn(sessionService, 'getCustomTitle').mockResolvedValue('Existing title')
    spyOn(conversationService, 'sendMessage').mockImplementation(
      async (_sid, _content, _attachments, options) => {
        options?.onCommitted?.()
        return true
      },
    )
    const requestControl = spyOn(conversationService, 'requestControl').mockRejectedValue(
      new Error('Agent control channel failed'),
    )
    spyOn(sessionService, 'appendSessionTaskNotification').mockResolvedValue()

    const emit = (event: any) => {
      for (const callback of [...outputCallbacks]) callback(event)
    }

    handleWebSocket.open(ws)
    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: 'Interrupt a foreground turn with an Agent',
    }))
    await flushMicrotasks(30)
    emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-before-control-failure',
      tool_use_id: 'agent-before-control-failure-tool',
      description: 'Agent whose control channel fails',
      task_type: 'local_agent',
    })

    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    await flushMicrotasks(30)
    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: '/goal clear',
    }))
    await flushMicrotasks(30)
    ws.sent.length = 0

    emit({
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/goal</command-name>\n<command-args>clear</command-args>',
    })
    emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-after-control-failure-boundary',
      tool_use_id: 'agent-after-control-failure-boundary-tool',
      description: 'Agent owned by the local command replacement',
      task_type: 'local_agent',
    })
    emit({
      type: 'system',
      subtype: 'local_command_output',
      content: '<local-command-stdout>Goal cleared.</local-command-stdout>',
    })
    emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    await flushMicrotasks(30)

    expect(requestControl).toHaveBeenCalledWith(sessionId, {
      subtype: 'stop_task',
      task_id: 'agent-before-control-failure',
    }, 3_000)
    expect(requestControl).not.toHaveBeenCalledWith(sessionId, {
      subtype: 'stop_task',
      task_id: 'agent-after-control-failure-boundary',
    }, 3_000)
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'message_complete',
      usage: { input_tokens: 0, output_tokens: 0 },
    })
  })

  it('arms idle cleanup after an Agent force-kill removes the cancelled turn', async () => {
    const sessionId = `stop-agent-force-kill-disconnect-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    let outputCallback: ((cliMsg: any) => void) | null = null
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(() => 1 as any)
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallback = callback
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(conversationService, 'sendInterrupt').mockReturnValue(true)
    spyOn(conversationService, 'requestControl').mockRejectedValue(
      new Error('Agent control channel failed'),
    )
    spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    spyOn(sessionService, 'appendSessionTaskNotification').mockResolvedValue()

    handleWebSocket.open(ws)
    __markActiveTurnForTests(sessionId)
    outputCallback?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'force-kill-disconnect-agent',
      tool_use_id: 'force-kill-disconnect-agent-tool',
      task_type: 'local_agent',
      description: 'Force runtime exit before renderer disconnects',
    })

    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    await flushMicrotasks(30)
    handleWebSocket.close(ws, 1006, 'renderer closed after force-kill')

    expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 30_000)).toBe(true)
  })

  it('counts repeated Stop clicks once for the same foreground turn', async () => {
    const sessionId = `stop-replacement-same-turn-repeated-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const outputCallbacks = new Set<(cliMsg: any) => void>()
    spyOn(globalThis, 'setTimeout').mockImplementation(() => 1 as any)
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.add(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation((_sid, callback) => {
      outputCallbacks.delete(callback)
    })
    const sendInterrupt = spyOn(conversationService, 'sendInterrupt').mockReturnValue(true)
    spyOn(sessionService, 'getCustomTitle').mockResolvedValue('Existing title')
    spyOn(conversationService, 'sendMessage').mockImplementation(
      async (_sid, _content, _attachments, options) => {
        options?.onCommitted?.()
        return true
      },
    )
    spyOn(conversationService, 'requestControl').mockResolvedValue({})
    spyOn(sessionService, 'appendSessionTaskNotification').mockResolvedValue()

    const emit = (event: any) => {
      for (const callback of [...outputCallbacks]) callback(event)
    }

    handleWebSocket.open(ws)
    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: 'Interrupt this turn once',
    }))
    await flushMicrotasks(30)
    emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-during-repeated-stop',
      tool_use_id: 'agent-during-repeated-stop-tool',
      task_type: 'local_agent',
      description: 'Keep the Agent stop control visible',
    })

    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    await flushMicrotasks(30)
    emit({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'Interrupted',
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: '/goal clear',
    }))
    await flushMicrotasks(30)
    ws.sent.length = 0

    emit({
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/goal</command-name>\n<command-args>clear</command-args>',
    })
    emit({
      type: 'system',
      subtype: 'local_command_output',
      content: '<local-command-stdout>Goal cleared.</local-command-stdout>',
    })
    emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    await flushMicrotasks(30)

    expect(sendInterrupt).toHaveBeenCalledTimes(1)
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'message_complete',
      usage: { input_tokens: 0, output_tokens: 0 },
    })
  })

  it('closes Agent activity after the main turn settled when the fallback removes the CLI session', async () => {
    const sessionId = `stop-agent-force-kill-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    let cliRunning = true
    let outputCallback: ((cliMsg: any) => void) | null = null
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(() => 1 as any)
    spyOn(conversationService, 'hasSession').mockImplementation(() => cliRunning)
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallback = callback
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(conversationService, 'sendInterrupt').mockImplementation(() => true)
    spyOn(conversationService, 'requestControl').mockImplementation(
      () => new Promise<Record<string, unknown>>(() => {}),
    )
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {
      cliRunning = false
    })
    const append = spyOn(sessionService, 'appendSessionTaskNotification').mockResolvedValue()

    handleWebSocket.open(ws)
    outputCallback?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'force-killed-agent',
      tool_use_id: 'force-killed-agent-tool',
      description: 'Hung Agent',
      task_type: 'local_agent',
    })

    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    const expireForceKill = setTimeoutSpy.mock.calls[0]?.[0] as (() => void) | undefined
    expireForceKill?.()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(stopSession).toHaveBeenCalledWith(sessionId)
    expect(append).toHaveBeenCalledWith(sessionId, expect.objectContaining({
      taskId: 'force-killed-agent',
      toolUseId: 'force-killed-agent-tool',
      status: 'stopped',
    }))
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'system_notification',
      subtype: 'task_notification',
      data: expect.objectContaining({
        task_id: 'force-killed-agent',
        tool_use_id: 'force-killed-agent-tool',
        status: 'stopped',
      }),
    })
  })

  it('forwards background task stop requests to the CLI control channel', async () => {
    const sessionId = `stop-background-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const requestControl = spyOn(conversationService, 'requestControl').mockResolvedValue({})
    handleWebSocket.open(ws)

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
    handleWebSocket.open(ws)

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

  it('persists terminal task notifications before forwarding them to the client', async () => {
    const sessionId = `task-notification-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    let outputCallback: ((cliMsg: any) => void) | null = null
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallback = callback
    })
    const append = spyOn(sessionService, 'appendSessionTaskNotification').mockResolvedValue()

    handleWebSocket.open(ws)
    ws.sent.length = 0

    const completed = {
      type: 'system',
      subtype: 'task_notification',
      uuid: 'terminal-task-event-1',
      task_id: 'agent-task-1',
      tool_use_id: 'agent-tool-1',
      status: 'completed',
      summary: 'Background task completed',
      timestamp: '2026-07-18T00:01:00.000Z',
    }
    outputCallback?.(completed)
    await Promise.resolve()
    await Promise.resolve()

    expect(append).toHaveBeenCalledTimes(1)
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'system_notification',
      subtype: 'task_notification',
      data: completed,
    })

    // A running notification is UI activity, not a terminal state that should
    // be restored after restart. It must forward without another persistence.
    const running = {
      ...completed,
      uuid: 'running-task-event-1',
      status: 'running',
    }
    outputCallback?.(running)

    expect(append).toHaveBeenCalledTimes(1)
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'system_notification',
      subtype: 'task_notification',
      data: running,
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

  it('only forwards boundary resolutions while Stop gates late unscoped output', () => {
    const sessionId = `permission-stop-resolution-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId)
    const second = makeClientSocket(sessionId)
    const outputCallbacks = new Set<(cliMsg: any) => void>()
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.add(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation((_sid, callback) => {
      outputCallbacks.delete(callback)
    })
    spyOn(conversationService, 'sendInterrupt').mockReturnValue(true)

    handleWebSocket.open(first)
    handleWebSocket.open(second)
    __markActiveTurnForTests(sessionId)
    handleWebSocket.message(first, JSON.stringify({ type: 'stop_generation' }))
    first.sent.length = 0
    second.sent.length = 0

    for (const callback of [...outputCallbacks]) {
      callback({ type: 'system', subtype: 'status', status: null })
      callback({
        type: 'control_request',
        request_id: 'late-permission-after-stop',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          input: { command: 'echo stale' },
        },
      })
      callback({
        type: 'system',
        subtype: 'task_progress',
        task_id: 'late-agent-progress-after-stop',
        task_type: 'local_agent',
        description: 'Stale Agent progress',
      })
    }

    const cancellation = {
      type: 'control_cancel_request',
      request_id: 'permission-cancelled-by-stop',
    }
    for (const callback of [...outputCallbacks]) callback(cancellation)

    for (const ws of [first, second]) {
      const sent = ws.sent.map((payload) => JSON.parse(payload))
      expect(sent).not.toContainEqual(expect.objectContaining({
        type: 'permission_request',
        requestId: 'late-permission-after-stop',
      }))
      expect(sent).not.toContainEqual(expect.objectContaining({
        type: 'status',
        state: 'thinking',
      }))
      expect(sent).not.toContainEqual(expect.objectContaining({
        type: 'status',
        state: 'tool_executing',
      }))
      expect(sent).not.toContainEqual(expect.objectContaining({
        type: 'system_notification',
        subtype: 'task_progress',
      }))
      expect(sent).toContainEqual({
        type: 'permission_resolved',
        requestId: 'permission-cancelled-by-stop',
        permissionType: 'tool',
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

  it('bounds an active turn waiting on permission after the last client disconnects', () => {
    const sessionId = `active-permission-disconnect-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as any)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([
      {
        requestId: 'request-bash-1',
        toolName: 'Bash',
        input: { command: 'echo hello' },
      },
    ])
    let turnCompleteCallback: ((cliMsg: any) => void) | null = null
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      turnCompleteCallback = callback
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})

    handleWebSocket.open(ws)
    __markActiveTurnForTests(sessionId)
    setTimeoutSpy.mockClear()

    handleWebSocket.close(ws, 1006, 'permission prompt abandoned')

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(30 * 60_000)
    expect(turnCompleteCallback).not.toBeNull()

    const expirePermissionWait = setTimeoutSpy.mock.calls[0]?.[0] as (() => void) | undefined
    expirePermissionWait?.()
    expect(stopSession).toHaveBeenCalledWith(sessionId)
  })

  it('starts the permission cleanup bound when disconnect happens before the turn is sent', () => {
    const sessionId = `late-permission-disconnect-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as any)
    const pendingRequests = spyOn(conversationService, 'getPendingPermissionRequests')
      .mockReturnValue([])
    let turnOutputCallback: ((cliMsg: any) => void) | null = null
    let cliSessionReady = false
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      // ConversationService.onOutput is a no-op until startSession has inserted
      // the session. This was the gap hidden by the previous regression test.
      if (cliSessionReady) turnOutputCallback = callback
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})

    handleWebSocket.open(ws)
    // Mirrors the real H5 race: user_message has synchronously claimed the
    // turn, but CLI startup has not completed and messageSent is still false.
    __registerPendingUserTurnForTests(sessionId)
    setTimeoutSpy.mockClear()
    handleWebSocket.close(ws, 1006, 'renderer closed before permission prompt')

    expect(setTimeoutSpy).not.toHaveBeenCalled()
    expect(turnOutputCallback).toBeNull()

    // CLI startup finishes while the H5 tab remains closed. handleUserMessage
    // refreshes the watcher immediately before sending the queued turn.
    cliSessionReady = true
    __refreshDisconnectedTurnCleanupWatcherForTests(sessionId)
    expect(turnOutputCallback).not.toBeNull()

    pendingRequests.mockReturnValue([{
      requestId: 'late-request-1',
      toolName: 'Bash',
      input: { command: 'echo later' },
    }])
    ;(turnOutputCallback as ((cliMsg: any) => void) | null)?.({
      type: 'control_request',
      request_id: 'late-request-1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash' },
    })

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(30 * 60_000)
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

  it('keeps a disconnected CLI alive through an internal Agent follow-up after the user result', () => {
    const sessionId = `cli-follow-up-disconnect-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(() => 321 as any)
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(conversationService, 'hasSession').mockReturnValue(true)

    const outputCallbacks: Array<(cliMsg: any) => void> = []
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.push(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})

    handleWebSocket.open(ws)
    outputCallbacks[0]?.({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'running',
    })
    setTimeoutSpy.mockClear()

    // An SDK result can precede the CLI's internally queued Agent-summary
    // turn. The authoritative idle event, not that intermediate result, owns
    // disconnected cleanup.
    handleWebSocket.close(ws, 1006, 'runner reached its observation deadline')
    expect(setTimeoutSpy).not.toHaveBeenCalled()
    expect(stopSession).not.toHaveBeenCalled()
    expect(outputCallbacks).toHaveLength(2)

    outputCallbacks[1]?.({ type: 'result', subtype: 'success' })
    expect(setTimeoutSpy).not.toHaveBeenCalled()

    outputCallbacks[1]?.({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'idle',
    })
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
    expect(stopSession).not.toHaveBeenCalled()

    const expireIdleGrace = setTimeoutSpy.mock.calls[0]?.[0] as (() => void) | undefined
    expireIdleGrace?.()
    expect(stopSession).toHaveBeenCalledWith(sessionId)
  })

  it('keeps the last disconnected client session alive until all background tasks finish', () => {
    const sessionId = `background-task-disconnect-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId, 'pet')
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as any)
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(conversationService, 'hasSession').mockReturnValue(true)

    const outputCallbacks: Array<(cliMsg: any) => void> = []
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.push(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})

    handleWebSocket.open(ws)
    outputCallbacks[0]?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-task-1',
      tool_use_id: 'agent-tool-1',
      description: 'Verify the desktop app',
      task_type: 'local_agent',
    })
    outputCallbacks[0]?.({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'shell-task-1',
      tool_use_id: 'shell-tool-1',
      status: 'running',
      output_file: '',
      summary: 'Running the focused tests',
    })
    setTimeoutSpy.mockClear()

    handleWebSocket.close(ws, 1000, 'pet closed')

    expect(setTimeoutSpy).not.toHaveBeenCalled()
    expect(stopSession).not.toHaveBeenCalled()
    expect(outputCallbacks).toHaveLength(2)

    outputCallbacks[1]?.({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'agent-task-1',
      tool_use_id: 'agent-tool-1',
      status: 'completed',
      output_file: '',
      summary: 'Desktop verification passed',
    })

    expect(setTimeoutSpy).not.toHaveBeenCalled()
    expect(stopSession).not.toHaveBeenCalled()

    outputCallbacks[1]?.({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'shell-task-1',
      tool_use_id: 'shell-tool-1',
      status: 'completed',
      output_file: '',
      summary: 'Focused tests passed',
    })

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(30_000)
    expect(stopSession).not.toHaveBeenCalled()

    const expireIdleGrace = setTimeoutSpy.mock.calls[0]?.[0] as (() => void) | undefined
    expireIdleGrace?.()
    expect(stopSession).toHaveBeenCalledWith(sessionId)
  })

  it('arms disconnected cleanup after a stopped Agent bookend finishes persisting', async () => {
    const sessionId = `stopped-agent-disconnect-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId, 'pet')
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(() => 789 as any)
    const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    const requestControl = spyOn(conversationService, 'requestControl').mockResolvedValue({})
    const archiveRemoteSession = spyOn(teleportApi, 'archiveRemoteSession').mockResolvedValue()
    const outputCallbacks: Array<(cliMsg: any) => void> = []
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.push(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    let resolveAppend: (() => void) | undefined
    const append = spyOn(sessionService, 'appendSessionTaskNotification')
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveAppend = resolve
      }))
      .mockResolvedValue()
    __setDisconnectGraceMsForTests(1_234)

    handleWebSocket.open(ws)
    outputCallbacks[0]?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-task-stop-disconnect',
      tool_use_id: 'agent-tool-stop-disconnect',
      description: 'Stop while renderer closes',
      task_type: 'local_agent',
    })
    setTimeoutSpy.mockClear()

    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    await flushMicrotasks()
    expect(append).toHaveBeenCalledTimes(1)

    handleWebSocket.close(ws, 1000, 'renderer closed during stop persistence')
    expect(outputCallbacks).toHaveLength(2)
    setTimeoutSpy.mockClear()

    resolveAppend?.()
    await flushMicrotasks()

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(1_234)
    expect(outputCallbacks).toHaveLength(3)

    setTimeoutSpy.mockClear()
    clearTimeoutSpy.mockClear()
    outputCallbacks.at(-1)?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'late-remote-agent-after-disconnect',
      tool_use_id: 'late-remote-agent-tool-after-disconnect',
      description: 'Spawned after the stopped bookend',
      task_type: 'remote_agent',
      remote_session_id: 'late-remote-session-after-disconnect',
    })
    await flushMicrotasks()

    expect(requestControl).toHaveBeenCalledWith(sessionId, {
      subtype: 'stop_task',
      task_id: 'late-remote-agent-after-disconnect',
    }, 3_000)
    expect(archiveRemoteSession).toHaveBeenCalledWith(
      'late-remote-session-after-disconnect',
      { timeoutMs: 1_500 },
    )
    expect(clearTimeoutSpy).toHaveBeenCalledWith(789)
    expect(setTimeoutSpy.mock.calls.filter((call) => call[1] === 1_234)).toHaveLength(1)
  })

  it('persists a local Agent terminal event observed only after Stop disconnects', async () => {
    const sessionId = `stopped-local-agent-disconnect-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const outputCallbacks: Array<(cliMsg: any) => void> = []
    spyOn(globalThis, 'setTimeout').mockImplementation(() => 789 as any)
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.push(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(conversationService, 'requestControl').mockImplementation(
      () => new Promise<Record<string, unknown>>(() => {}),
    )
    const append = spyOn(sessionService, 'appendSessionTaskNotification').mockResolvedValue()

    handleWebSocket.open(ws)
    outputCallbacks[0]?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'local-agent-terminal-after-disconnect',
      tool_use_id: 'local-agent-terminal-after-disconnect-tool',
      description: 'Stop while the renderer disconnects',
      task_type: 'local_agent',
    })
    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    await flushMicrotasks()

    handleWebSocket.close(ws, 1006, 'renderer disconnected before local terminal')
    expect(outputCallbacks.length).toBeGreaterThanOrEqual(2)
    outputCallbacks.at(-1)?.({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'local-agent-terminal-after-disconnect',
      tool_use_id: 'local-agent-terminal-after-disconnect-tool',
      task_type: 'local_agent',
      status: 'stopped',
    })
    await flushMicrotasks()

    expect(append).toHaveBeenCalledWith(sessionId, expect.objectContaining({
      taskId: 'local-agent-terminal-after-disconnect',
      toolUseId: 'local-agent-terminal-after-disconnect-tool',
      status: 'stopped',
    }))
  })

  it('cancels an armed idle timer when a background task starts late', () => {
    const sessionId = `late-background-task-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId, 'pet')
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(() => 123 as any)
    const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    const outputCallbacks: Array<(cliMsg: any) => void> = []
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.push(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})

    handleWebSocket.open(ws)
    setTimeoutSpy.mockClear()
    handleWebSocket.close(ws, 1000, 'pet closed while idle')

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
    expect(outputCallbacks).toHaveLength(2)
    outputCallbacks[1]?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'late-task-1',
      tool_use_id: 'late-tool-1',
      description: 'Started after the idle timer was armed',
      task_type: 'local_agent',
    })

    expect(clearTimeoutSpy).toHaveBeenCalledWith(123)
    expect(stopSession).not.toHaveBeenCalled()

    outputCallbacks[1]?.({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'late-task-1',
      tool_use_id: 'late-tool-1',
      status: 'completed',
      output_file: '',
      summary: 'Late task completed',
    })

    expect(setTimeoutSpy).toHaveBeenCalledTimes(2)
    const expireIdleGrace = setTimeoutSpy.mock.calls[1]?.[0] as (() => void) | undefined
    expireIdleGrace?.()
    expect(stopSession).toHaveBeenCalledWith(sessionId)
  })

  it('keeps the pending-permission disconnect bound when a background task starts late', () => {
    const sessionId = `permission-bound-background-task-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId, 'pet')
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(() => 456 as any)
    const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([{
      requestId: 'permission-1',
      toolName: 'Bash',
      input: { command: 'echo pending' },
    }])
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    const outputCallbacks: Array<(cliMsg: any) => void> = []
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.push(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})

    handleWebSocket.open(ws)
    __markActiveTurnForTests(sessionId)
    setTimeoutSpy.mockClear()
    clearTimeoutSpy.mockClear()
    handleWebSocket.close(ws, 1000, 'pet closed while awaiting permission')

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(30 * 60_000)
    expect(outputCallbacks).toHaveLength(2)

    outputCallbacks[1]?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'late-task-with-permission-1',
      tool_use_id: 'late-tool-with-permission-1',
      description: 'Started while permission was pending',
      task_type: 'local_agent',
    })

    expect(clearTimeoutSpy).not.toHaveBeenCalledWith(456)
    const expirePermissionBound = setTimeoutSpy.mock.calls[0]?.[0] as (() => void) | undefined
    expirePermissionBound?.()
    expect(stopSession).toHaveBeenCalledWith(sessionId)
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
      activeBackgroundTaskIds: [],
    })

    const idleSessionId = `sync-idle-${crypto.randomUUID()}`
    const idleSocket = makeClientSocket(idleSessionId)
    handleWebSocket.open(idleSocket)
    idleSocket.sent.length = 0
    handleWebSocket.message(idleSocket, JSON.stringify({ type: 'sync_state' }))

    expect(idleSocket.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'session_state',
      turnState: 'idle',
      activeBackgroundTaskIds: [],
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
      activeBackgroundTaskIds: [],
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
      activeBackgroundTaskIds: [],
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
