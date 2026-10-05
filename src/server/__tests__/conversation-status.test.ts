import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { handleConversationsApi } from '../api/conversations.js'
import { conversationService } from '../services/conversationService.js'
import { computerUseApprovalService } from '../services/computerUseApprovalService.js'
import {
  __markActiveTurnForTests,
  __registerPendingUserTurnForTests,
  __resetWebSocketHandlerStateForTests,
  __settleActiveTurnForTests,
  getSessionChatActivityState,
  handleWebSocket,
  translateCliMessage,
  type WebSocketData,
} from '../ws/handler.js'
import type { ServerWebSocket } from 'bun'

async function getStatus(sessionId: string): Promise<string> {
  const url = new URL(`http://127.0.0.1/api/sessions/${sessionId}/chat/status`)
  const response = await handleConversationsApi(
    new Request(url),
    url,
    ['api', 'sessions', sessionId, 'chat', 'status'],
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as { state: string; activityState: string }
  expect(body.state).toBe('idle')
  return body.activityState
}

function makeClientSocket(
  sessionId: string,
  clientKind: WebSocketData['clientKind'] = 'full',
): ServerWebSocket<WebSocketData> {
  return {
    data: {
      sessionId,
      clientKind,
      connectedAt: Date.now(),
      channel: 'client',
      sdkToken: null,
      serverPort: 0,
      serverHost: '127.0.0.1',
    },
    send: mock(() => {}),
    close: mock(() => {}),
  } as unknown as ServerWebSocket<WebSocketData>
}

describe('read-only session chat activity status', () => {
  afterEach(() => {
    __resetWebSocketHandlerStateForTests()
    mock.restore()
  })

  it('returns idle without tracked activity and running for pending or active turns', async () => {
    const sessionId = `status-running-${crypto.randomUUID()}`

    expect(await getStatus(sessionId)).toBe('idle')

    __registerPendingUserTurnForTests(sessionId)
    expect(await getStatus(sessionId)).toBe('running')

    __markActiveTurnForTests(sessionId)
    expect(await getStatus(sessionId)).toBe('running')
  })

  it('gives pending tool and Computer Use permissions priority over other states', () => {
    const sessionId = `status-waiting-${crypto.randomUUID()}`
    __markActiveTurnForTests(sessionId)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([{
      requestId: 'permission-1',
      toolName: 'Bash',
      input: { command: 'echo hello' },
    }])

    expect(getSessionChatActivityState(sessionId)).toBe('waiting')

    mock.restore()
    spyOn(computerUseApprovalService, 'getPendingRequests').mockReturnValue([{
      requestId: 'computer-use-1',
      reason: 'Inspect another app',
      apps: [],
      requestedFlags: {},
      screenshotFiltering: 'native',
    }])
    expect(getSessionChatActivityState(sessionId)).toBe('waiting')
  })

  it('keeps a real CLI error failed after the paired message_complete event', async () => {
    const sessionId = `status-failed-${crypto.randomUUID()}`
    const result = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'Provider request failed',
      usage: {},
    }
    __markActiveTurnForTests(sessionId)
    __settleActiveTurnForTests(sessionId, result)

    expect(translateCliMessage(result, sessionId)).toEqual([
      {
        type: 'error',
        message: 'Provider request failed',
        code: 'CLI_ERROR',
      },
      {
        type: 'message_complete',
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    ])
    expect(await getStatus(sessionId)).toBe('failed')
  })

  it('returns idle after a successful CLI result even while the session tab remains open', async () => {
    const sessionId = `status-review-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    handleWebSocket.open(ws)
    __markActiveTurnForTests(sessionId)
    __settleActiveTurnForTests(sessionId, {
      type: 'result',
      subtype: 'success',
      usage: {},
    })
    expect(await getStatus(sessionId)).toBe('idle')

    __registerPendingUserTurnForTests(sessionId)
    expect(await getStatus(sessionId)).toBe('running')
  })

  it('keeps a successful completed turn idle when the last full client closes', async () => {
    const sessionId = `status-review-close-${crypto.randomUUID()}`
    const pet = makeClientSocket(sessionId, 'pet')
    const ws = makeClientSocket(sessionId)
    handleWebSocket.open(pet)
    handleWebSocket.open(ws)
    __markActiveTurnForTests(sessionId)
    __settleActiveTurnForTests(sessionId, {
      type: 'result',
      subtype: 'success',
      usage: {},
    })
    expect(await getStatus(sessionId)).toBe('idle')

    handleWebSocket.close(ws, 1000, 'tab closed')
    expect(await getStatus(sessionId)).toBe('idle')
  })

  it('keeps a failed result visible when the last full client closes', async () => {
    const sessionId = `status-failed-close-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    handleWebSocket.open(ws)
    __markActiveTurnForTests(sessionId)
    __settleActiveTurnForTests(sessionId, {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'Provider request failed',
      usage: {},
    })
    expect(await getStatus(sessionId)).toBe('failed')

    handleWebSocket.close(ws, 1000, 'tab closed')
    expect(await getStatus(sessionId)).toBe('failed')
  })

  it('does not create review state when a disconnected turn finishes', async () => {
    const sessionId = `status-review-disconnected-${crypto.randomUUID()}`
    __markActiveTurnForTests(sessionId)
    __settleActiveTurnForTests(sessionId, {
      type: 'result',
      subtype: 'success',
      usage: {},
    })

    expect(await getStatus(sessionId)).toBe('idle')
  })

  it('keeps an interrupted result idle instead of classifying it as failed', async () => {
    const sessionId = `status-stopped-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    __markActiveTurnForTests(sessionId)
    spyOn(conversationService, 'hasSession').mockReturnValue(false)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([{
      requestId: 'permission-being-cancelled',
      toolName: 'Bash',
      input: { command: 'echo waiting' },
    }])

    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    expect(await getStatus(sessionId)).toBe('idle')

    __settleActiveTurnForTests(sessionId, {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'Interrupted by user',
      usage: {},
    })
    expect(await getStatus(sessionId)).toBe('idle')
  })

  it('clears terminal activity through the shared test reset hook', () => {
    const sessionId = `status-reset-${crypto.randomUUID()}`
    handleWebSocket.open(makeClientSocket(sessionId))
    __markActiveTurnForTests(sessionId)
    __settleActiveTurnForTests(sessionId, {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      usage: {},
    })
    expect(getSessionChatActivityState(sessionId)).toBe('failed')

    __resetWebSocketHandlerStateForTests()
    expect(getSessionChatActivityState(sessionId)).toBe('idle')
  })
})

describe('live session activity for the phone session list', () => {
  afterEach(() => {
    __resetWebSocketHandlerStateForTests()
    mock.restore()
  })

  async function getLiveStatus(): Promise<Array<{ id: string; activityState: string }>> {
    const { handleSessionsApi } = await import('../api/sessions.js')
    const url = new URL('http://127.0.0.1/api/sessions/live-status')
    const response = await handleSessionsApi(new Request(url), url, ['api', 'sessions', 'live-status'])
    expect(response.status).toBe(200)
    const body = (await response.json()) as { sessions: Array<{ id: string; activityState: string }> }
    return body.sessions
  }

  it('lists working and waiting sessions in one answer and leaves idle ones out', async () => {
    const running = `live-running-${crypto.randomUUID()}`
    const waiting = `live-waiting-${crypto.randomUUID()}`
    const idle = `live-idle-${crypto.randomUUID()}`
    __markActiveTurnForTests(running)
    __markActiveTurnForTests(waiting)
    spyOn(conversationService, 'getActiveSessions').mockReturnValue([running, waiting, idle])
    spyOn(conversationService, 'getPendingPermissionRequests').mockImplementation((id: string) => (
      id === waiting ? [{ requestId: 'permission-1', toolName: 'Bash', input: { command: 'ls' } }] : []
    ))

    const live = await getLiveStatus()

    expect(live).toContainEqual({ id: running, activityState: 'running' })
    expect(live).toContainEqual({ id: waiting, activityState: 'waiting' })
    expect(live.some((entry) => entry.id === idle)).toBe(false)
  })

  it('finds a turn that is running before its CLI process is tracked', async () => {
    const sessionId = `live-turn-only-${crypto.randomUUID()}`
    __markActiveTurnForTests(sessionId)
    spyOn(conversationService, 'getActiveSessions').mockReturnValue([])

    expect(await getLiveStatus()).toContainEqual({ id: sessionId, activityState: 'running' })
  })

  it('reports a team worker through its lead instead of as a row of its own', async () => {
    const lead = `live-lead-${crypto.randomUUID()}`
    const worker = `live-worker-${crypto.randomUUID()}`
    spyOn(conversationService, 'getActiveSessions').mockReturnValue([lead, worker])
    spyOn(conversationService, 'isTeamWorkerSession').mockImplementation((id: string) => id === worker)
    spyOn(conversationService, 'getPendingPermissionRequests').mockImplementation(() => [
      { requestId: 'permission-1', toolName: 'Bash', input: { command: 'ls' } },
    ])

    const live = await getLiveStatus()

    expect(live).toContainEqual({ id: lead, activityState: 'waiting' })
    expect(live.some((entry) => entry.id === worker)).toBe(false)
  })

  it('rejects writes to the live-status collection route', async () => {
    const { handleSessionsApi } = await import('../api/sessions.js')
    const url = new URL('http://127.0.0.1/api/sessions/live-status')
    const response = await handleSessionsApi(
      new Request(url, { method: 'POST' }),
      url,
      ['api', 'sessions', 'live-status'],
    )
    expect(response.status).toBe(405)
  })
})
