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

  receive(message: unknown) {
    ;(this.onmessage as ((event: { data: string }) => void) | null)?.({
      data: JSON.stringify(message),
    })
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
    vi.restoreAllMocks()
  })

  it('replays queued messages after an unexpected reconnect', async () => {
    wsManager.connect('session-reconnect')
    const states: string[] = []
    wsManager.onConnectionState('session-reconnect', state => states.push(state))

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
      JSON.stringify({ type: 'sync_state' }),
    ])
    expect(states).toEqual(['connecting', 'connected', 'reconnecting', 'reconnecting', 'connected'])
  })

  it('closes and reconnects a half-open socket when a pong never arrives', async () => {
    wsManager.connect('session-half-open')
    const firstSocket = FakeWebSocket.instances[0]!
    firstSocket.open()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(firstSocket.sent).toContain(JSON.stringify({ type: 'ping' }))

    await vi.advanceTimersByTimeAsync(10_000)
    expect(firstSocket.readyState).toBe(FakeWebSocket.CLOSED)

    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('keeps a healthy socket open when the server answers the heartbeat', async () => {
    wsManager.connect('session-heartbeat')
    const socket = FakeWebSocket.instances[0]!
    socket.open()

    await vi.advanceTimersByTimeAsync(30_000)
    socket.receive({ type: 'pong' })
    await vi.advanceTimersByTimeAsync(10_000)

    expect(socket.readyState).toBe(FakeWebSocket.OPEN)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('does not let a stale socket close stop the replacement heartbeat', async () => {
    wsManager.connect('session-stale-close')
    const firstSocket = FakeWebSocket.instances[0]!
    firstSocket.open()
    firstSocket.fail()

    await vi.advanceTimersByTimeAsync(1000)
    const secondSocket = FakeWebSocket.instances[1]!
    secondSocket.open()

    // A browser may deliver a duplicate or delayed close callback for the
    // replaced socket. It must not clear the replacement connection's timer.
    firstSocket.fail()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(secondSocket.sent).toContain(JSON.stringify({ type: 'ping' }))
  })

  function changeVisibility(state: DocumentVisibilityState) {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state)
    document.dispatchEvent(new Event('visibilitychange'))
  }

  it('probes a foregrounded session immediately without replacing a healthy connection or resending its turn', async () => {
    wsManager.connect('session-resume')
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    wsManager.send('session-resume', { type: 'user_message', content: 'keep working' })
    changeVisibility('hidden')
    changeVisibility('visible')

    expect(socket.sent).toEqual([
      JSON.stringify({ type: 'user_message', content: 'keep working' }),
      JSON.stringify({ type: 'ping' }),
    ])
    socket.receive({ type: 'pong' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(socket.readyState).toBe(FakeWebSocket.OPEN)
  })

  it('reconnects and synchronizes an unresponsive foregrounded session without waiting for the regular heartbeat', async () => {
    wsManager.connect('session-sleep')
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    wsManager.send('session-sleep', { type: 'user_message', content: 'already sent' })
    changeVisibility('hidden')
    changeVisibility('visible')
    await vi.advanceTimersByTimeAsync(11_000)

    expect(FakeWebSocket.instances).toHaveLength(2)
    const replacement = FakeWebSocket.instances[1]!
    replacement.open()
    expect(replacement.sent).toEqual([JSON.stringify({ type: 'sync_state' })])
  })

  it('probes the Android resume event without resetting a healthy live stream', async () => {
    wsManager.connect('session-native-resume')
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    wsManager.send('session-native-resume', { type: 'user_message', content: 'continue the task' })
    window.dispatchEvent(new Event('cc-haha:resume'))
    expect(socket.sent).toEqual([
      JSON.stringify({ type: 'user_message', content: 'continue the task' }),
      JSON.stringify({ type: 'ping' }),
    ])
    socket.receive({ type: 'pong' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    // sync_state running snapshots reset raw stream buffers, so a healthy
    // resume must only probe, not request the socket-gap recovery protocol.
    expect(socket.sent).not.toContain(JSON.stringify({ type: 'sync_state' }))
  })

  it('keeps an in-flight handshake through repeated native resume and visibility events', async () => {
    wsManager.connect('session-resume-handshake')
    const socket = FakeWebSocket.instances[0]!
    wsManager.send('session-resume-handshake', { type: 'user_message', content: 'queued once' })
    changeVisibility('hidden')
    window.dispatchEvent(new Event('cc-haha:resume'))
    changeVisibility('visible')
    await vi.advanceTimersByTimeAsync(500)
    window.dispatchEvent(new Event('cc-haha:resume'))

    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(socket.readyState).toBe(FakeWebSocket.CONNECTING)
    socket.open()
    expect(socket.sent).toEqual([JSON.stringify({ type: 'user_message', content: 'queued once' })])
  })

  it('replaces a stalled handshake on resume and preserves its unsent turn', async () => {
    wsManager.connect('session-stalled-handshake')
    const socket = FakeWebSocket.instances[0]!
    const messages = vi.fn()
    wsManager.onMessage('session-stalled-handshake', messages)
    wsManager.send('session-stalled-handshake', { type: 'user_message', content: 'queued while connecting' })
    await vi.advanceTimersByTimeAsync(10_000)
    window.dispatchEvent(new Event('cc-haha:resume'))
    window.dispatchEvent(new Event('cc-haha:resume'))

    expect(FakeWebSocket.instances).toHaveLength(2)
    const replacement = FakeWebSocket.instances[1]!
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED)
    socket.open()
    socket.receive({ type: 'text_delta', text: 'stale' })
    expect(messages).not.toHaveBeenCalled()
    replacement.open()
    expect(replacement.sent).toEqual([
      JSON.stringify({ type: 'user_message', content: 'queued while connecting' }),
      JSON.stringify({ type: 'sync_state' }),
    ])
  })

  it('does not keep a young handshake when the network changes', () => {
    wsManager.connect('session-handshake-network-change')
    const socket = FakeWebSocket.instances[0]!
    wsManager.send('session-handshake-network-change', { type: 'user_message', content: 'queued on old network' })
    window.dispatchEvent(new Event('offline'))
    window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new Event('cc-haha:resume'))

    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED)
    const replacement = FakeWebSocket.instances[1]!
    replacement.open()
    expect(replacement.sent).toEqual([
      JSON.stringify({ type: 'user_message', content: 'queued on old network' }),
      JSON.stringify({ type: 'sync_state' }),
    ])
  })

  it('restores a changed network immediately, preserving only unsent messages and ignoring stale socket events', async () => {
    wsManager.connect('session-network')
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    const messages = vi.fn()
    wsManager.onMessage('session-network', messages)
    wsManager.send('session-network', { type: 'user_message', content: 'already sent' })
    window.dispatchEvent(new Event('offline'))
    wsManager.send('session-network', { type: 'user_message', content: 'queued while offline' })
    window.dispatchEvent(new Event('online'))

    expect(FakeWebSocket.instances).toHaveLength(2)
    const replacement = FakeWebSocket.instances[1]!
    // Native WebViews can deliver buffered callbacks after replacing a socket.
    socket.open()
    socket.receive({ type: 'text_delta', text: 'stale' })
    socket.fail()
    expect(messages).not.toHaveBeenCalled()
    replacement.open()
    expect(replacement.sent).toEqual([
      JSON.stringify({ type: 'user_message', content: 'queued while offline' }),
      JSON.stringify({ type: 'sync_state' }),
    ])
    expect(socket.sent).toEqual([JSON.stringify({ type: 'user_message', content: 'already sent' })])
    replacement.receive({ type: 'pong' })
    expect(messages).toHaveBeenCalledWith({ type: 'pong' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('does not reconnect intentionally disconnected sessions when the app resumes', () => {
    wsManager.connect('session-disconnected')
    FakeWebSocket.instances[0]!.open()
    changeVisibility('hidden')
    wsManager.disconnectAll()
    changeVisibility('visible')
    window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new Event('cc-haha:resume'))
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('honors a subscriber disconnecting during network recovery', () => {
    wsManager.connect('session-leaving')
    FakeWebSocket.instances[0]!.open()
    wsManager.onConnectionState('session-leaving', (state) => {
      if (state === 'reconnecting') wsManager.disconnect('session-leaving')
    })
    window.dispatchEvent(new Event('online'))
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(wsManager.getConnectedSessionIds()).toEqual([])
  })

  it('builds websocket URLs from http and encodes token query params', () => {
    clientMocks.baseUrl = 'http://10.0.0.2:3456'
    clientMocks.authToken = 'h5 token/with?chars'

    expect(buildSessionWebSocketUrl('session-reconnect')).toBe(
      'ws://10.0.0.2:3456/ws/session-reconnect?token=h5+token%2Fwith%3Fchars&suggestions=1',
    )
  })

  it('upgrades https backends to wss', () => {
    clientMocks.baseUrl = 'https://remote.example.com'

    expect(buildSessionWebSocketUrl('secure-session')).toBe(
      'wss://remote.example.com/ws/secure-session?suggestions=1',
    )
  })

  it('preserves reverse-proxy subpaths when building websocket URLs', () => {
    clientMocks.baseUrl = 'https://public.example.com/app'

    expect(buildSessionWebSocketUrl('s1')).toBe(
      'wss://public.example.com/app/ws/s1?suggestions=1',
    )
  })

  it('opts the desktop composer in to prompt suggestions but not touch H5', () => {
    clientMocks.baseUrl = 'http://127.0.0.1:3456'
    clientMocks.authToken = null

    expect(new URL(buildSessionWebSocketUrl('desk')).searchParams.get('suggestions')).toBe('1')

    document.documentElement.setAttribute('data-touch-h5', '')
    try {
      expect(new URL(buildSessionWebSocketUrl('touch')).searchParams.has('suggestions')).toBe(false)
    } finally {
      document.documentElement.removeAttribute('data-touch-h5')
    }
  })
})
