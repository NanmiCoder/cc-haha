import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const clientMocks = vi.hoisted(() => ({
  baseUrl: 'http://127.0.0.1:3456',
  authToken: null as string | null,
}))

vi.mock('./client', () => ({
  getBaseUrl: () => clientMocks.baseUrl,
  getAuthToken: () => clientMocks.authToken,
}))

import { buildSessionWebSocketUrl, wsManager } from './websocket'

type SocketHandler = (() => void) | ((event: { data: string }) => void)

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly url: string
  readyState = FakeWebSocket.CONNECTING
  onopen: SocketHandler | null = null
  onmessage: SocketHandler | null = null
  onclose: SocketHandler | null = null
  onerror: SocketHandler | null = null
  sent: string[] = []

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
    ;(this.onclose as (() => void) | null)?.()
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    ;(this.onopen as (() => void) | null)?.()
  }

  fail() {
    this.readyState = FakeWebSocket.CLOSED
    ;(this.onclose as (() => void) | null)?.()
  }
}

describe('wsManager reconnect buffering', () => {
  const originalWebSocket = globalThis.WebSocket

  beforeEach(() => {
    vi.useFakeTimers()
    clientMocks.baseUrl = 'http://127.0.0.1:3456'
    clientMocks.authToken = null
    FakeWebSocket.instances = []
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    wsManager.disconnectAll()
  })

  afterEach(() => {
    wsManager.disconnectAll()
    globalThis.WebSocket = originalWebSocket
    vi.useRealTimers()
  })

  it('replays queued messages after an unexpected reconnect', async () => {
    wsManager.connect('session-reconnect')

    const firstSocket = FakeWebSocket.instances[0]
    expect(firstSocket?.url).toContain('/ws/session-reconnect')

    firstSocket!.open()
    wsManager.send('session-reconnect', { type: 'user_message', content: 'first' })
    expect(firstSocket!.sent).toEqual([
      JSON.stringify({ type: 'user_message', content: 'first' }),
    ])

    firstSocket!.fail()
    wsManager.send('session-reconnect', { type: 'user_message', content: 'queued while offline' })

    await vi.advanceTimersByTimeAsync(1000)

    const secondSocket = FakeWebSocket.instances[1]
    expect(secondSocket).toBeDefined()
    secondSocket!.open()

    expect(secondSocket!.sent).toEqual([
      JSON.stringify({ type: 'user_message', content: 'queued while offline' }),
    ])
  })

  it('builds websocket URLs from http and encodes token query params', () => {
    clientMocks.baseUrl = 'http://10.0.0.2:3456'
    clientMocks.authToken = 'h5 token/with?chars'

    expect(buildSessionWebSocketUrl('session-reconnect')).toBe(
      'ws://10.0.0.2:3456/ws/session-reconnect?token=h5+token%2Fwith%3Fchars',
    )
  })

  it('upgrades https backends to wss', () => {
    clientMocks.baseUrl = 'https://remote.example.com'

    expect(buildSessionWebSocketUrl('secure-session')).toBe(
      'wss://remote.example.com/ws/secure-session',
    )
  })

  it('preserves reverse-proxy subpaths when building websocket URLs', () => {
    clientMocks.baseUrl = 'https://public.example.com/app'

    expect(buildSessionWebSocketUrl('s1')).toBe(
      'wss://public.example.com/app/ws/s1',
    )
  })
})
