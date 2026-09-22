import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { conversationService } from './conversationService.js'
import { sessionService } from './sessionService.js'
import { observeSessionTurns } from './sessionTurnEvents.js'
import * as turnEvents from './sessionTurnEvents.js'
import { ApiError } from '../middleware/errorHandler.js'
import { sessionMessageUuid } from '../../utils/sessionMessageInbox.js'
import { __resetWebSocketHandlerStateForTests, getSessionTurnState, getSessionChatActivityState, handleWebSocket, stopSessionTurn, submitSessionTurn } from '../ws/handler.js'

describe('background session turn admission', () => {
  afterEach(() => { __resetWebSocketHandlerStateForTests(); mock.restore() })

  function fixture() {
    const callbacks = new Set<(message: any) => void>()
    spyOn(sessionService, 'shouldPersistSession').mockReturnValue(false)
    spyOn(sessionService, 'getCustomTitle').mockResolvedValue('Independent task')
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(conversationService, 'onOutput').mockImplementation((_id, cb) => { callbacks.add(cb) })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation((_id, cb) => { callbacks.delete(cb) })
    return callbacks
  }

  it('uses the shared control turn without any renderer and observes completion', async () => {
    const callbacks = fixture()
    const control = spyOn(conversationService, 'requestControl').mockResolvedValue({ status: 'queued' })
    const ordinary = spyOn(conversationService, 'sendMessage').mockResolvedValue(true)
    const events: string[] = []
    const unobserve = observeSessionTurns(event => { events.push(event.type) })
    try {
      const ack = await submitSessionTurn('worker', 'Inspect code', { serverHost: '127.0.0.1', serverPort: 1234, messageId: 'assignment', sourceSessionId: 'root' })
      expect(ack).toEqual({ status: 'queued' })
      expect(control.mock.calls[0]?.[1]).toEqual({ subtype: 'enqueue_session_message', message_id: 'assignment', sender_session_id: 'root', text: 'Inspect code', start_if_idle: true })
      expect(ordinary).not.toHaveBeenCalled()
      expect(getSessionTurnState('worker')).toBe('running')
      for (const cb of [...callbacks]) cb({ type: 'system', subtype: 'session_message_receipt', status: 'consumed', message_id: 'assignment', source_uuid: sessionMessageUuid('assignment') })
      for (const cb of [...callbacks]) cb({ type: 'result', result: 'Finished', is_error: false })
      await Promise.resolve()
      expect(getSessionTurnState('worker')).toBe('idle')
      expect(ack.status).toBe('queued')
      expect(events).toContain('output')
    } finally { unobserve() }
  })

  it('delivers peer /clear as ordinary agent text while preserving the real user command', async () => {
    fixture()
    const control = spyOn(conversationService, 'requestControl').mockResolvedValue({ status: 'queued' })
    const clear = spyOn(sessionService, 'clearSessionTranscript').mockResolvedValue(undefined)
    spyOn(conversationService, 'getSessionWorkDir').mockReturnValue('/tmp/session-clear-fixture')
    spyOn(conversationService, 'getSessionPermissionMode').mockReturnValue('default')
    const stop = spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    spyOn(conversationService, 'clearOutputCallbacks').mockImplementation(() => {})
    await submitSessionTurn('peer-target', '/clear', { serverHost: '127.0.0.1', serverPort: 1234, messageId: 'clear-text', sourceSessionId: 'root' })
    expect(control.mock.calls[0]?.[1]).toMatchObject({ subtype: 'enqueue_session_message', text: '/clear' })
    expect(clear).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()

    const ws = { data: { sessionId: 'user-target', connectedAt: Date.now(), channel: 'client' as const, sdkToken: null, serverHost: '127.0.0.1', serverPort: 1234 }, send: mock(() => 1), close: mock(() => {}) }
    handleWebSocket.message(ws, JSON.stringify({ type: 'user_message', content: '/clear' }))
    for (let i = 0; i < 30; i++) await Promise.resolve()
    expect(clear).toHaveBeenCalledWith('user-target', '/tmp/session-clear-fixture', 'default')
    expect(stop).toHaveBeenCalledWith('user-target')
    expect(control).toHaveBeenCalledTimes(1)
  })

  function userSocket(sessionId: string) {
    const sent: any[] = []
    return { data: { sessionId, connectedAt: Date.now(), channel: 'client' as const, sdkToken: null, serverHost: '127.0.0.1', serverPort: 1234 }, send: mock((value: string) => { sent.push(JSON.parse(value)); return 1 }), close: mock(() => {}), sent }
  }

  it('rejects a capacity-denied manual turn before SDK delivery without reporting worker failure', async () => {
    fixture()
    spyOn(turnEvents, 'admitSessionUserTurn').mockRejectedValue(new ApiError(409, 'Worker capacity is full. Retry after a worker finishes.', 'SESSION_CAPACITY_FULL'))
    const start = spyOn(conversationService, 'startSession')
    const send = spyOn(conversationService, 'sendMessage').mockResolvedValue(true)
    const events: string[] = []
    const unobserve = observeSessionTurns(event => { events.push(event.type) })
    try {
      const ws = userSocket('capacity-worker')
      handleWebSocket.message(ws, JSON.stringify({ type: 'user_message', content: 'Start now' }))
      for (let i = 0; i < 30; i++) await Promise.resolve()
      expect(ws.sent).toContainEqual({ type: 'error', code: 'SESSION_CAPACITY_FULL', message: 'Worker capacity is full. Retry after a worker finishes.', retryable: true })
      expect(start).not.toHaveBeenCalled()
      expect(send).not.toHaveBeenCalled()
      expect(events).toEqual([])
      expect(getSessionTurnState('capacity-worker')).toBe('idle')
      expect(getSessionChatActivityState('capacity-worker')).toBe('idle')
    } finally { unobserve() }
  })

  it.each([false, true])('retains the manual reservation only when SDK delivery succeeds (%s)', async sent => {
    fixture()
    const release = mock(async () => {})
    spyOn(turnEvents, 'admitSessionUserTurn').mockResolvedValue({ release })
    const send = spyOn(conversationService, 'sendMessage').mockResolvedValue(sent)
    handleWebSocket.message(userSocket(`delivery-${sent}`), JSON.stringify({ type: 'user_message', content: 'Inspect' }))
    for (let i = 0; i < 70; i++) await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(sent ? 0 : 1)
  })

  it('releases only the cancelled manual admission and never delivers after Stop', async () => {
    fixture()
    let finish!: (lease: { release: () => Promise<void> }) => void
    let canAdmit: (() => boolean) | undefined
    const release = mock(async () => {})
    spyOn(turnEvents, 'admitSessionUserTurn').mockImplementation(async (_id, isCurrent) => {
      canAdmit = isCurrent
      return new Promise(resolve => { finish = resolve })
    })
    spyOn(conversationService, 'sendInterrupt').mockReturnValue(true)
    spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    const send = spyOn(conversationService, 'sendMessage').mockResolvedValue(true)
    handleWebSocket.message(userSocket('cancel-worker'), JSON.stringify({ type: 'user_message', content: 'Start now' }))
    for (let i = 0; i < 30 && !canAdmit; i++) await Promise.resolve()
    expect(canAdmit?.()).toBe(true)
    expect(getSessionTurnState('cancel-worker')).toBe('blocked')
    stopSessionTurn('cancel-worker')
    expect(canAdmit?.()).toBe(false)
    finish({ release })
    for (let i = 0; i < 30; i++) await Promise.resolve()
    expect(release).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
  })

  it('does not deliver a control after Stop revokes admission during readiness', async () => {
    fixture()
    let allowWrite: (() => boolean) | undefined
    let release!: () => void
    const ready = new Promise<void>(resolve => { release = resolve })
    spyOn(conversationService, 'sendInterrupt').mockReturnValue(true)
    spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    spyOn(conversationService, 'requestControl').mockImplementation(async (_id, _request, _timeout, _signal, canSend) => {
      allowWrite = canSend
      await ready
      if (!canSend?.()) throw new Error('Delivery cancelled')
      return { status: 'queued' }
    })
    const pending = submitSessionTurn('worker', 'Inspect', { serverHost: '127.0.0.1', serverPort: 1234, messageId: 'stopped', sourceSessionId: 'root' })
    for (let i = 0; i < 30 && !allowWrite; i++) await Promise.resolve()
    expect(allowWrite?.()).toBe(true)
    stopSessionTurn('worker')
    expect(allowWrite?.()).toBe(false)
    release()
    await expect(pending).rejects.toThrow('Delivery cancelled')
  })

  it('rejects a revoked collaboration before starting a turn', async () => {
    fixture()
    const control = spyOn(conversationService, 'requestControl')
    await expect(submitSessionTurn('worker', 'Inspect', { serverHost: '127.0.0.1', serverPort: 1234, messageId: 'gone', sourceSessionId: 'root', canSend: () => false })).rejects.toThrow('cancelled')
    expect(control).not.toHaveBeenCalled()
    expect(getSessionTurnState('worker')).toBe('idle')
  })

  it('returns explicit historical-consumption acknowledgments without inventing a fresh turn', async () => {
    fixture()
    spyOn(conversationService, 'requestControl').mockResolvedValue({ status: 'consumed', duplicate: true })
    const ack = await submitSessionTurn('worker', 'Already read', { serverHost: '127.0.0.1', serverPort: 1234, messageId: 'duplicate', sourceSessionId: 'root' })
    expect(ack).toEqual({ status: 'consumed' })
    expect(getSessionTurnState('worker')).toBe('idle')
  })
})
