import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import {
  __resetWebSocketHandlerStateForTests,
  closeSessionConnection,
  getActiveSessionIds,
  handleWebSocket,
  sendToSession,
  type WebSocketData,
} from '../ws/handler.js'
import { conversationService } from '../services/conversationService.js'
import { computerUseApprovalService } from '../services/computerUseApprovalService.js'

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

describe('WebSocket handler session isolation', () => {
  afterEach(() => {
    __resetWebSocketHandlerStateForTests()
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

  it('broadcasts session messages to every connected client for the same session', () => {
    const sessionId = `broadcast-${crypto.randomUUID()}`
    const desktop = makeClientSocket(sessionId)
    const android = makeClientSocket(sessionId)

    handleWebSocket.open(desktop)
    handleWebSocket.open(android)

    expect(sendToSession(sessionId, {
      type: 'status',
      state: 'thinking',
      verb: 'Thinking',
    })).toBe(true)

    expect(desktop.sent.some((payload) => payload.includes('"verb":"Thinking"'))).toBe(true)
    expect(android.sent.some((payload) => payload.includes('"verb":"Thinking"'))).toBe(true)
  })

  it('keeps a session active until the last client disconnects', () => {
    const sessionId = `multi-client-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId)
    const second = makeClientSocket(sessionId)
    const clearCallbacks = spyOn(conversationService, 'clearOutputCallbacks')
    const cancelComputerUse = spyOn(computerUseApprovalService, 'cancelSession')

    handleWebSocket.open(first)
    handleWebSocket.open(second)
    clearCallbacks.mockClear()
    cancelComputerUse.mockClear()

    handleWebSocket.close(first, 1000, 'desktop tab closed')

    expect(getActiveSessionIds()).toContain(sessionId)
    expect(clearCallbacks).not.toHaveBeenCalled()
    expect(cancelComputerUse).not.toHaveBeenCalled()

    handleWebSocket.close(second, 1000, 'android tab closed')

    expect(getActiveSessionIds()).not.toContain(sessionId)
    expect(clearCallbacks).toHaveBeenCalledWith(sessionId)
    expect(cancelComputerUse).toHaveBeenCalledWith(sessionId)
  })

  it('closes and removes all active client sockets when a session is deleted', () => {
    const sessionId = `delete-${crypto.randomUUID()}`
    const desktop = makeClientSocket(sessionId)
    const android = makeClientSocket(sessionId)
    const clearCallbacks = spyOn(conversationService, 'clearOutputCallbacks')
    const cancelComputerUse = spyOn(computerUseApprovalService, 'cancelSession')

    handleWebSocket.open(desktop)
    handleWebSocket.open(android)

    expect(closeSessionConnection(sessionId, 'session deleted')).toBe(true)

    expect(getActiveSessionIds()).not.toContain(sessionId)
    expect(desktop.close).toHaveBeenCalledWith(1000, 'session deleted')
    expect(android.close).toHaveBeenCalledWith(1000, 'session deleted')
    expect(clearCallbacks).toHaveBeenCalledWith(sessionId)
    expect(cancelComputerUse).toHaveBeenCalledWith(sessionId)
  })
})
