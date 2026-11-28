import { describe, expect, it } from 'bun:test'
import {
  DirectCdpWebSocketTransport,
  type WebSocketLike,
} from '../wsTransport'

class FakeWebSocket implements WebSocketLike {
  readyState = 0
  readonly sent: string[] = []
  closed = false
  throwOnSend = false
  throwOnClose = false
  private readonly listeners = new Map<string, Array<(ev: unknown) => void>>()

  send(data: string): void {
    if (this.throwOnSend) {
      throw new Error('send failed synchronously')
    }
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    this.readyState = 3
    if (this.throwOnClose) {
      throw new Error('close failed')
    }
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  emit(type: string, event: unknown = {}): void {
    if (type === 'open') {
      this.readyState = 1
    } else if (type === 'close') {
      this.readyState = 3
    }
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }
}

describe('browserUse/wsTransport', () => {
  it('handles connect timeouts, aborts, pre-open errors, pre-open close, and idempotent connect', async () => {
    // 1. Already-aborted connect
    const abortedController = new AbortController()
    abortedController.abort()
    const tAborted = new DirectCdpWebSocketTransport({
      wsUrl: 'ws://127.0.0.1:9222/devtools/browser/1',
      keepaliveIntervalMs: 0,
      webSocketFactory: () => new FakeWebSocket(),
    })
    await expect(tAborted.connect(abortedController.signal)).rejects.toThrow(
      'aborted',
    )

    // 2. Abort mid-connect
    const midAbort = new AbortController()
    const sockMid = new FakeWebSocket()
    const tMid = new DirectCdpWebSocketTransport({
      wsUrl: 'ws://127.0.0.1:9222/devtools/browser/2',
      keepaliveIntervalMs: 0,
      webSocketFactory: () => sockMid,
    })
    const midPromise = tMid.connect(midAbort.signal)
    midAbort.abort()
    await expect(midPromise).rejects.toThrow('aborted')
    expect(sockMid.closed).toBe(true)

    // 3. Connect timeout
    const sockTimeout = new FakeWebSocket()
    const tTimeout = new DirectCdpWebSocketTransport({
      wsUrl: 'ws://127.0.0.1:9222/devtools/browser/3',
      connectTimeoutMs: 15,
      keepaliveIntervalMs: 0,
      webSocketFactory: () => sockTimeout,
    })
    await expect(tTimeout.connect()).rejects.toThrow('Timed out connecting')

    // 4. Error before open
    const sockErr = new FakeWebSocket()
    const tErr = new DirectCdpWebSocketTransport({
      wsUrl: 'ws://127.0.0.1:9222/devtools/browser/4',
      keepaliveIntervalMs: 0,
      webSocketFactory: () => sockErr,
    })
    const errPromise = tErr.connect()
    sockErr.emit('error', { message: 'ECONNREFUSED' })
    await expect(errPromise).rejects.toThrow('ECONNREFUSED')

    // 5. Close before open
    const sockClose = new FakeWebSocket()
    const tClose = new DirectCdpWebSocketTransport({
      wsUrl: 'ws://127.0.0.1:9222/devtools/browser/5',
      keepaliveIntervalMs: 0,
      webSocketFactory: () => sockClose,
    })
    const closePromise = tClose.connect()
    sockClose.emit('close', { reason: 'rejected handshake' })
    await expect(closePromise).rejects.toThrow('rejected handshake')

    // 6. Successful connect + idempotent second connect + connect after close
    const sockOk = new FakeWebSocket()
    const tOk = new DirectCdpWebSocketTransport({
      wsUrl: 'ws://127.0.0.1:9222/devtools/browser/6',
      keepaliveIntervalMs: 0,
      webSocketFactory: () => sockOk,
    })
    const okPromise = tOk.connect()
    sockOk.emit('open')
    await okPromise
    expect(tOk.isConnected()).toBe(true)
    await tOk.connect() // no-op when already connected

    sockOk.throwOnClose = true
    await tOk.close()
    await tOk.close() // idempotent
    expect(tOk.isConnected()).toBe(false)
    await expect(tOk.connect()).rejects.toThrow('already closed')
    await expect(tOk.send('Browser.getVersion')).rejects.toThrow('not connected')
  })

  it('handles command timeouts, aborts, synchronous send errors, CDP error responses, and binary/malformed messages', async () => {
    const sock = new FakeWebSocket()
    const transport = new DirectCdpWebSocketTransport({
      wsUrl: 'ws://127.0.0.1:9222/devtools/browser/cmd',
      keepaliveIntervalMs: 0,
      defaultCommandTimeoutMs: 500,
      webSocketFactory: () => sock,
    })
    const conn = transport.connect()
    sock.emit('open')
    await conn

    // 1. Command timeout
    await expect(
      transport.send('Runtime.evaluate', {}, { timeoutMs: 15 }),
    ).rejects.toThrow('timed out after 15ms')

    // 2. Pre-aborted command signal
    const preAbort = new AbortController()
    preAbort.abort()
    await expect(
      transport.send('Page.reload', {}, { signal: preAbort.signal }),
    ).rejects.toThrow('aborted')

    // 3. Mid-flight abort signal
    const flightAbort = new AbortController()
    const flightPromise = transport.send(
      'Page.reload',
      {},
      { signal: flightAbort.signal, timeoutMs: 5_000 },
    )
    flightAbort.abort()
    await expect(flightPromise).rejects.toThrow('aborted')

    // 4. Synchronous ws.send throw
    sock.throwOnSend = true
    await expect(transport.send('DOM.enable')).rejects.toThrow(
      'send failed synchronously',
    )
    sock.throwOnSend = false

    // 5. CDP error response (string message)
    const errCmd = transport.send('Page.navigate', { url: 'about:blank' })
    const lastSent1 = JSON.parse(sock.sent[sock.sent.length - 1]!) as { id: number }
    sock.emit('message', {
      data: JSON.stringify({
        id: lastSent1.id,
        error: { code: -32000, message: 'Cannot navigate' },
      }),
    })
    await expect(errCmd).rejects.toThrow('Cannot navigate')

    // 6. CDP error response without string message + ArrayBuffer payload
    const errCmd2 = transport.send('Page.reload')
    const lastSent2 = JSON.parse(sock.sent[sock.sent.length - 1]!) as { id: number }
    const encodedErr = new TextEncoder().encode(
      JSON.stringify({ id: lastSent2.id, error: { code: -32601 } }),
    )
    sock.emit('message', { data: encodedErr.buffer })
    await expect(errCmd2).rejects.toThrow('-32601')

    // 7. Non-object result via Uint8Array (ArrayBufferView) resolves to {}
    const nullResCmd = transport.send('DOM.enable')
    const lastSent3 = JSON.parse(sock.sent[sock.sent.length - 1]!) as { id: number }
    sock.emit('message', {
      data: new TextEncoder().encode(
        JSON.stringify({ id: lastSent3.id, result: null }),
      ),
    })
    expect(await nullResCmd).toEqual({})

    // 8. Malformed JSON, non-object JSON, unknown id, unsupported payload type (must not crash)
    sock.emit('message', { data: '{ broken json' })
    sock.emit('message', { data: 'null' })
    sock.emit('message', { data: JSON.stringify({ id: 999999, result: {} }) })
    sock.emit('message', { data: 12345 })

    // 9. Event listeners (including throwing listener isolation + unsubscribe)
    const seenEvents: string[] = []
    const unsubBad = transport.onEvent(() => {
      throw new Error('listener bug')
    })
    const unsubGood = transport.onEvent(method => {
      seenEvents.push(method)
    })
    sock.emit('message', {
      data: JSON.stringify({ method: 'Page.loadEventFired', params: {} }),
    })
    expect(seenEvents).toEqual(['Page.loadEventFired'])
    unsubBad()
    unsubGood()

    await transport.close()
  })

  it('runs keepalive pings and notifies onDisconnect on post-open error/close', async () => {
    const sock = new FakeWebSocket()
    const transport = new DirectCdpWebSocketTransport({
      wsUrl: 'ws://127.0.0.1:9222/devtools/browser/ka',
      keepaliveIntervalMs: 20,
      webSocketFactory: () => sock,
    })

    const disconnectReasons: string[] = []
    const unsubBad = transport.onDisconnect(() => {
      throw new Error('disconnect listener bug')
    })
    const unsubGood = transport.onDisconnect(reason => {
      disconnectReasons.push(reason)
    })

    const conn = transport.connect()
    sock.emit('open')
    await conn

    // Wait for keepalive interval to trigger Browser.getVersion
    await new Promise(resolve => setTimeout(resolve, 65))
    expect(
      sock.sent.some(raw => {
        const parsed = JSON.parse(raw) as { method?: string }
        return parsed.method === 'Browser.getVersion'
      }),
    ).toBe(true)

    // Pending command fails cleanly when post-open error fires
    const inFlight = transport.send('Page.getFrameTree', undefined, {
      timeoutMs: 5_000,
    })
    sock.emit('error', { message: 'socket reset' })
    await expect(inFlight).rejects.toThrow('socket reset')
    expect(disconnectReasons).toEqual(['socket reset'])

    // Subsequent close event also notifies cleanly while transport is not closed
    sock.emit('close', { reason: 'peer closed' })
    expect(disconnectReasons).toContain('peer closed')

    unsubBad()
    unsubGood()
    await transport.close()
  })
})
