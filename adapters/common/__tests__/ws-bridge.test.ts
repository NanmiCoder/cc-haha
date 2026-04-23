import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { WsBridge } from '../ws-bridge.js'
import { WebSocketServer, type WebSocket as WsServerSocket } from 'ws'

describe('WsBridge', () => {
  let bridge: WsBridge

  beforeEach(() => {
    bridge = new WsBridge('ws://127.0.0.1:19999', 'test')
  })

  afterEach(() => {
    bridge.destroy()
  })

  it('connectSession connects with provided sessionId', () => {
    const result = bridge.connectSession('chat-1', 'my-uuid-session-id')
    expect(result).toBe(true)
    expect(bridge.hasSession('chat-1')).toBe(true)
  })

  it('connectSession for different chatIds creates separate sessions', () => {
    bridge.connectSession('chat-1', 'uuid-1')
    bridge.connectSession('chat-2', 'uuid-2')
    expect(bridge.hasSession('chat-1')).toBe(true)
    expect(bridge.hasSession('chat-2')).toBe(true)
  })

  it('resetSession removes the session', () => {
    bridge.connectSession('chat-reset', 'uuid-reset')
    bridge.resetSession('chat-reset')
    expect(bridge.hasSession('chat-reset')).toBe(false)
  })

  it('sendUserMessage returns false when no open connection', () => {
    bridge.connectSession('chat-offline', 'uuid-offline')
    expect(bridge.sendUserMessage('chat-offline', 'hello')).toBe(false)
  })

  it('sendPermissionResponse returns false when no open connection', () => {
    bridge.connectSession('chat-perm', 'uuid-perm')
    expect(bridge.sendPermissionResponse('chat-perm', 'req-1', true)).toBe(false)
  })

  it('sendStopGeneration returns false when no open connection', () => {
    bridge.connectSession('chat-stop', 'uuid-stop')
    expect(bridge.sendStopGeneration('chat-stop')).toBe(false)
  })

  it('destroy cleans up all sessions', () => {
    bridge.connectSession('a', 'uuid-a')
    bridge.connectSession('b', 'uuid-b')
    bridge.destroy()
    expect(bridge.hasSession('a')).toBe(false)
    expect(bridge.hasSession('b')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Integration: per-chat handler serialization
//
// Reproduces the feishu text→tool→text race: a slow handler on msg 1 must
// complete BEFORE msg 2's handler starts, otherwise msg 2 reads the stale
// state msg 1's continuation is about to clear.
// ---------------------------------------------------------------------------

describe('WsBridge: handler serialization', () => {
  let server: WebSocketServer
  let port: number
  let connections: WsServerSocket[]
  let serverUrl: string

  beforeEach(async () => {
    connections = []
    // port 0 → let the OS pick a free one
    server = new WebSocketServer({ port: 0 })
    server.on('connection', (ws) => {
      connections.push(ws)
    })
    await new Promise<void>((resolve) => server.on('listening', () => resolve()))
    port = (server.address() as { port: number }).port
    serverUrl = `ws://127.0.0.1:${port}`
  })

  afterEach(async () => {
    // Forcibly kill any server-side sockets (not graceful close) so
    // WebSocketServer.close() doesn't wait for client FIN.
    for (const ws of connections) {
      try { ws.terminate() } catch {}
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => resolve(), 500) // hard cap
      server.close(() => {
        clearTimeout(t)
        resolve()
      })
    })
  })

  it('processes handler calls in strict FIFO order per chatId', async () => {
    const bridge = new WsBridge(serverUrl, 'test')
    const events: string[] = []

    // The handler simulates an async side effect that takes varying time.
    // If handlers ran concurrently, fast msgs could finish before slow ones,
    // producing an out-of-order `events` array.
    bridge.onServerMessage('chat-1', async (msg: any) => {
      const tag = msg.tag as string
      const delay = msg.delay as number
      events.push(`start:${tag}`)
      await new Promise((r) => setTimeout(r, delay))
      events.push(`end:${tag}`)
    })

    bridge.connectSession('chat-1', 'sess-1')
    const ok = await bridge.waitForOpen('chat-1')
    expect(ok).toBe(true)
    expect(connections.length).toBe(1)
    const serverWs = connections[0]!

    // Blast three messages back-to-back. msg1 is slow, msg2/msg3 are fast.
    // With serialization: start:1, end:1, start:2, end:2, start:3, end:3
    // Without serialization: start:1, start:2, start:3, end:2, end:3, end:1
    serverWs.send(JSON.stringify({ tag: '1', delay: 40 }))
    serverWs.send(JSON.stringify({ tag: '2', delay: 5 }))
    serverWs.send(JSON.stringify({ tag: '3', delay: 5 }))

    // Wait long enough for all three handlers to run serially
    await new Promise((r) => setTimeout(r, 200))

    expect(events).toEqual([
      'start:1', 'end:1',
      'start:2', 'end:2',
      'start:3', 'end:3',
    ])

    bridge.destroy()
  })

  it('handler error does not break the chain (subsequent messages still run)', async () => {
    const bridge = new WsBridge(serverUrl, 'test')
    const events: string[] = []

    bridge.onServerMessage('chat-err', async (msg: any) => {
      if (msg.throw) {
        events.push('throwing')
        throw new Error('boom')
      }
      events.push(`ok:${msg.tag}`)
    })

    bridge.connectSession('chat-err', 'sess-err')
    await bridge.waitForOpen('chat-err')
    const serverWs = connections[0]!

    serverWs.send(JSON.stringify({ throw: true }))
    serverWs.send(JSON.stringify({ tag: 'after' }))

    await new Promise((r) => setTimeout(r, 80))

    expect(events).toEqual(['throwing', 'ok:after'])

    bridge.destroy()
  })

  it('resetSession clears the handler chain', async () => {
    const bridge = new WsBridge(serverUrl, 'test')
    bridge.onServerMessage('chat-reset', () => {})
    bridge.connectSession('chat-reset', 'sess-reset')
    await bridge.waitForOpen('chat-reset')

    bridge.resetSession('chat-reset')
    expect(bridge.hasSession('chat-reset')).toBe(false)

    bridge.destroy()
  })
})
