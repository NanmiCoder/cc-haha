import { describe, expect, test } from 'bun:test'
import type { ApiClient } from './client'
import { CommandOutbox, newStreamId, readStreamFrame, streamSocketUrl } from './resumableStream'
import { SessionTransport, type SocketLike, type TransportTimers } from './sessionTransport'
import type { HistoryPage } from './types'

// The server half of the protocol, imported the same way sessionTransport.test.ts
// imports server parsing: both sides must agree byte for byte.
type ServerSocket = { data: unknown; send(text: string): unknown; close(): void }
type ServerLayer = {
  open(ws: ServerSocket): void
  message(ws: ServerSocket, text: string): void
  close(ws: ServerSocket, code: number, reason: string): void
  readonly streamCount: number
}
const server = await import(
  new URL('../../../src/server/ws/resumableStreams.ts', import.meta.url).href
) as {
  parseResumeRequest(params: URLSearchParams): { streamId: string; ack: number; epoch?: string } | undefined
  createResumableSocketHandler(inner: unknown, options?: {
    epoch?: string
    setTimer?: (callback: () => void, ms: number) => unknown
    clearTimer?: (timer: unknown) => void
  }): ServerLayer
}

describe('stream protocol pieces', () => {
  test('stream ids are 22 base64url characters the computer accepts', () => {
    let seed = 0
    const source = { getRandomValues: <T extends Uint8Array>(array: T) => { array.forEach((_, i) => { array[i] = (seed++ * 37) & 255 }); return array } }
    const id = newStreamId(source)
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(newStreamId(source)).not.toBe(id)
    const url = streamSocketUrl('wss://desk.example.test/ws/s1?media=ref', { id, resume: { epoch: 'abc', ack: 41 } })
    expect(server.parseResumeRequest(new URL(url).searchParams)).toEqual({ streamId: id, ack: 41, epoch: 'abc' })
    expect(new URL(url).searchParams.get('media')).toBe('ref')
  })

  test('control frames are recognised and event frames keep their sequence number', () => {
    expect(readStreamFrame('{"type":"command_ack","cseq":3}')).toEqual({ kind: 'command_ack', cseq: 3 })
    expect(readStreamFrame('{"seq":7,"type":"status","state":"idle"}')).toEqual({
      kind: 'event',
      seq: 7,
      value: { seq: 7, type: 'status', state: 'idle' },
    })
    expect(readStreamFrame('{"type":"stream_attached","epoch":"e","resumed":"yes","cack":0,"next":1,"last":0}')).toBeNull()
    expect(readStreamFrame('not json')).toBeNull()
  })

  test('the outbox numbers commands first, forgets acknowledged ones and keeps their numbers for a resend', () => {
    const outbox = new CommandOutbox()
    const first = outbox.encode({ type: 'sync_state' })
    expect(first.cseq).toBe(1)
    expect(first.text.startsWith('{"cseq":1,')).toBe(true)
    outbox.encode({ type: 'stop_generation' })
    outbox.encode({ type: 'sync_state' })
    outbox.acknowledge(1)
    outbox.drop(3)
    expect(outbox.unacknowledged(0).map((item) => item.text)).toEqual(['{"cseq":2,"type":"stop_generation"}'])
  })
})

class Timers implements TransportTimers {
  jobs = new Map<number, { at: number; run: () => void }>()
  now = 0
  id = 0
  set(run: () => void, delay: number) {
    this.jobs.set(++this.id, { at: this.now + delay, run })
    return this.id
  }
  clear(handle: unknown) {
    this.jobs.delete(handle as number)
  }
  advance(ms: number) {
    const end = this.now + ms
    for (;;) {
      const next = [...this.jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      this.now = next[1].at
      this.jobs.delete(next[0])
      next[1].run()
    }
    this.now = end
  }
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('phone and computer agree on the stream protocol', () => {
  test('a drop mid-turn resumes through the real server layer with nothing lost, repeated or re-read', async () => {
    // The session handler behind the stream layer: opens with the usual snapshots,
    // answers sync_state, and records the commands it actually executes.
    let session: { send(text: string): unknown } | undefined
    const executed: string[] = []
    const inner = {
      open(ws: { send(text: string): unknown }) {
        session = ws
        ws.send(JSON.stringify({ type: 'connected', sessionId: 's1' }))
        ws.send(JSON.stringify({ type: 'permission_requests_snapshot', toolRequestIds: [], computerUseRequestIds: [], turnActive: false }))
      },
      message(ws: { send(text: string): unknown }, raw: string | Buffer) {
        const message = JSON.parse(String(raw)) as { type: string }
        if (message.type === 'sync_state') ws.send(JSON.stringify({ type: 'session_state', turnState: 'idle', activeBackgroundTaskIds: [] }))
        else executed.push(String(raw))
      },
      close() {},
    }
    const layer = server.createResumableSocketHandler(inner as never, { epoch: 'contract' })
    const physicals: { close(): void }[] = []
    const timers = new Timers()
    let reads = 0
    const page: HistoryPage = { messages: [], page: { nextCursor: null, hasMore: false, historyComplete: true, sourceVersion: 'v1', scannedBytes: 0, omittedOversizedEntries: 0 } }
    const client = {
      host: { id: 'h', name: 'H', url: 'http://192.168.1.2:3456', auth: 'lan' as const },
      history: (async () => { reads++; return page }) as ApiClient['history'],
      verify: (async () => ({ ok: true })) as ApiClient['verify'],
    }
    let streams = 0
    const transport = new SessionTransport({
      client,
      credential: 'fake-token',
      sessionId: 's1',
      platform: 'native',
      timers,
      newStreamId: () => `contractStream${String(++streams).padStart(8, '0')}`,
      onState: () => {},
      onConnection: () => {},
      onError: () => {},
      // An in-memory socket wired straight into the server's stream layer.
      socketFactory: (options) => {
        const socket: SocketLike = {
          readyState: 0,
          onopen: null, onmessage: null, onclose: null, onerror: null,
          send: (text) => layer.message(physical, text),
          close: () => {
            if (socket.readyState === 3) return
            socket.readyState = 3
            layer.close(physical, 1000, 'Client disconnected')
          },
        }
        const physical: ServerSocket = {
          data: {
            sessionId: 's1', connectedAt: 0, channel: 'client', clientKind: 'full', sdkToken: null,
            serverPort: 1, serverHost: '127.0.0.1',
            resume: server.parseResumeRequest(new URL(options.url).searchParams),
          },
          send: (text: string) => {
            if (socket.readyState === 1) queueMicrotask(() => socket.onmessage?.({ data: text }))
            return text.length
          },
          close: () => { socket.close() },
        }
        physicals.push({
          close: () => {
            // A network drop: the client sees 1006, the server sees the close.
            socket.readyState = 3
            layer.close(physical, 1006, '')
            socket.onclose?.({ code: 1006 })
          },
        })
        queueMicrotask(() => {
          socket.readyState = 1
          layer.open(physical)
          socket.onopen?.()
        })
        return socket
      },
    })
    transport.start()
    await flush()
    await flush()
    expect(transport.connection).toBe('ready')
    const readsWhenReady = reads

    session!.send(JSON.stringify({ type: 'content_start', blockType: 'text' }))
    session!.send(JSON.stringify({ type: 'content_delta', text: 'Before ' }))
    await flush()
    expect(transport.send({ type: 'stop_generation' })).toBe(true)
    await flush()
    expect(executed).toEqual(['{"type":"stop_generation"}'])

    // The phone goes to the background: its socket dies while output continues.
    physicals.at(-1)!.close()
    session!.send(JSON.stringify({ type: 'content_delta', text: 'after.' }))
    session!.send(JSON.stringify({ type: 'message_complete', usage: { input_tokens: 1, output_tokens: 1 } }))
    timers.advance(500)
    await flush()
    await flush()
    expect(transport.connection).toBe('ready')
    expect(transport.state.items.at(-1)?.text).toBe('Before after.')
    expect(reads).toBe(readsWhenReady)
    expect(executed).toEqual(['{"type":"stop_generation"}'])
    expect(layer.streamCount).toBe(1)

    transport.dispose()
    await flush()
    expect(layer.streamCount).toBe(0)
  })
})

/**
 * 手机传输层接在电脑真实的续传层上，帧由测试逐条放行：慢链路上补发还在路上、
 * 两条路交错到达、旧连接被顶替这些时序都能精确摆出来。
 */
type Wire = SocketLike & {
  url: string
  physical: ServerSocket
  /** 电脑发来、还没送到手机的帧；`close` 是电脑主动关掉这条连接。 */
  queue: (string | { close: number })[]
  sent: string[]
  /** 发出去的帧到不了电脑（链路已经死了，本地还不知道）。 */
  lost: boolean
  /** send 当场抛错。 */
  broken: boolean
  pump(count?: number): void
  open(): void
  /** 没连上电脑就失败了。 */
  fail(): void
  /** 网络断了：电脑看到关闭，手机收到 1006。 */
  die(): void
}
function world(options: { manualOpen?: (index: number) => boolean } = {}) {
  const executed: Record<string, unknown>[] = []
  const sessions: { send(text: string): unknown }[] = []
  const inner = {
    open(ws: { send(text: string): unknown }) {
      sessions.push(ws)
      ws.send(JSON.stringify({ type: 'connected', sessionId: 's1' }))
      ws.send(JSON.stringify({ type: 'permission_requests_snapshot', toolRequestIds: [], computerUseRequestIds: [], turnActive: false }))
      ws.send(JSON.stringify({ type: 'session_state', turnState: 'idle', activeBackgroundTaskIds: [] }))
    },
    message(_ws: unknown, raw: string | Buffer) {
      const message = JSON.parse(String(raw)) as Record<string, unknown>
      if (message.type !== 'sync_state') executed.push(message)
    },
    close() {},
  }
  const layer = server.createResumableSocketHandler(inner as never, {
    epoch: 'contract',
    setTimer: () => 0,
    clearTimer: () => {},
  })
  const timers = new Timers()
  const wires: Wire[] = []
  const connections: string[] = []
  const errors: string[] = []
  let reads = 0
  let verifies = 0
  const page: HistoryPage = { messages: [], page: { nextCursor: null, hasMore: false, historyComplete: true, sourceVersion: 'v1', scannedBytes: 0, omittedOversizedEntries: 0 } }
  let streams = 0
  const transport = new SessionTransport({
    client: {
      host: { id: 'h', name: 'H', url: 'http://192.168.1.2:3456', auth: 'lan' as const },
      history: (async () => { reads++; return page }) as ApiClient['history'],
      verify: (async () => { verifies++; return { ok: true } }) as ApiClient['verify'],
    },
    credential: 'fake-token',
    sessionId: 's1',
    platform: 'native',
    timers,
    clock: () => timers.now,
    newStreamId: () => `contractStream${String(++streams).padStart(8, '0')}`,
    onState: () => {},
    onConnection: (state) => connections.push(state),
    onError: (error) => errors.push(error.message),
    socketFactory: (socketOptions) => {
      const index = wires.length
      const wire = {
        url: socketOptions.url,
        queue: [],
        sent: [],
        lost: false,
        broken: false,
        readyState: 0,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      } as unknown as Wire
      const physical: ServerSocket = {
        data: {
          sessionId: 's1', connectedAt: 0, channel: 'client', clientKind: 'full', sdkToken: null,
          serverPort: 1, serverHost: '127.0.0.1',
          resume: server.parseResumeRequest(new URL(socketOptions.url).searchParams),
        },
        send: (text: string) => {
          wire.queue.push(text)
          return text.length
        },
        close: (code?: number) => {
          wire.queue.push({ close: code ?? 1000 })
        },
      }
      wire.physical = physical
      wire.send = (text: string) => {
        if (wire.readyState !== 1 || wire.broken) throw new Error('Socket closed')
        wire.sent.push(text)
        if (!wire.lost) layer.message(physical, text)
      }
      wire.close = () => {
        if (wire.readyState === 3) return
        wire.readyState = 3
        layer.close(physical, 1000, 'Client disconnected')
      }
      wire.pump = (count = Infinity) => {
        while (count-- > 0 && wire.queue.length) {
          const next = wire.queue.shift()!
          if (typeof next === 'string') {
            if (wire.readyState === 1) wire.onmessage?.({ data: next })
            continue
          }
          if (wire.readyState !== 3) {
            wire.readyState = 3
            layer.close(physical, next.close, '')
          }
          wire.onclose?.({ code: next.close })
        }
      }
      wire.open = () => {
        wire.readyState = 1
        layer.open(physical)
        wire.onopen?.()
      }
      wire.fail = () => {
        wire.readyState = 3
        wire.onerror?.()
        wire.onclose?.({ code: 1006 })
      }
      wire.die = () => {
        wire.readyState = 3
        layer.close(physical, 1006, '')
        wire.onclose?.({ code: 1006 })
      }
      wires.push(wire)
      if (!options.manualOpen?.(index)) queueMicrotask(() => wire.open())
      return wire
    },
  })
  const emit = (event: Record<string, unknown>) => sessions.at(-1)!.send(JSON.stringify(event))
  return {
    transport,
    timers,
    wires,
    executed,
    connections,
    errors,
    emit,
    reads: () => reads,
    verifies: () => verifies,
    /** 打开会话并完成第一次对齐。 */
    async ready() {
      transport.start()
      await flush()
      wires[0]!.pump()
      await flush()
      expect(transport.connection).toBe('ready')
    },
    /** 让最新的那条连接把收到的帧都处理完。 */
    async drain(wire = wires.at(-1)!) {
      for (let i = 0; i < 4; i++) {
        wire.pump()
        await flush()
      }
    },
  }
}
const assistantText = (transport: SessionTransport) =>
  transport.state.items.filter((item) => item.type === 'assistant').map((item) => item.text)

describe('resuming against the real server layer', () => {
  test('a send that failed on the spot is reported as not retried, and is not resent after resuming', async () => {
    const w = world()
    await w.ready()
    w.wires[0]!.broken = true
    expect(w.transport.send({ type: 'user_message', content: 'deploy to prod' })).toBe(false)
    expect(w.errors).toContain('发送失败，消息没有自动重试')
    w.timers.advance(500)
    await flush()
    await w.drain()
    expect(w.transport.connection).toBe('ready')
    expect(w.wires).toHaveLength(2)
    expect(w.executed).toEqual([])
    w.transport.dispose()
  })

  test('a new command cannot overtake an unexecuted one while the replay is still arriving', async () => {
    const w = world()
    await w.ready()
    // The mode change leaves the phone but the link is already dead.
    w.wires[0]!.lost = true
    expect(w.transport.send({ type: 'set_permission_mode', mode: 'plan' })).toBe(true)
    w.wires[0]!.die()
    // The computer keeps streaming while the phone is away.
    for (let i = 0; i < 5; i++) w.emit({ type: 'session_title_updated', sessionId: 's1', title: `t${i}` })
    w.timers.advance(500)
    await flush()
    const second = w.wires.at(-1)!
    second.pump(1)
    await flush()
    // The replay is still on its way over a slow link: nothing new may go out yet.
    expect(w.transport.connection).toBe('resuming')
    const early = w.transport.send({ type: 'user_message', content: 'go' })
    await w.drain()
    expect(w.transport.connection).toBe('ready')
    if (!early) expect(w.transport.send({ type: 'user_message', content: 'go' })).toBe(true)
    expect(w.executed.map((message) => message.type)).toEqual(['set_permission_mode', 'user_message'])
    expect(w.transport.state.title).toBe('t4')
    expect(w.reads()).toBe(2)
    w.transport.dispose()
  })

  test('a stop pressed during the replay waits for the unexecuted message instead of making the computer drop it', async () => {
    const w = world()
    await w.ready()
    w.wires[0]!.lost = true
    expect(w.transport.send({ type: 'user_message', content: 'hello' })).toBe(true)
    w.wires[0]!.die()
    for (let i = 0; i < 3; i++) w.emit({ type: 'session_title_updated', sessionId: 's1', title: `t${i}` })
    w.timers.advance(500)
    await flush()
    const second = w.wires.at(-1)!
    second.pump(1)
    await flush()
    const early = w.transport.send({ type: 'stop_generation' })
    await w.drain()
    if (!early) expect(w.transport.send({ type: 'stop_generation' })).toBe(true)
    expect(w.executed).toEqual([
      { type: 'user_message', content: 'hello' },
      { type: 'stop_generation' },
    ])
    w.transport.dispose()
  })

  test('a better path found while the first sync is running is taken once the session is ready', async () => {
    const w = world()
    w.transport.start()
    await flush()
    expect(w.transport.connection).toBe('syncing')
    w.transport.migrate()
    w.wires[0]!.pump()
    await flush()
    expect(w.transport.connection).toBe('ready')
    expect(w.wires).toHaveLength(2)
    await w.drain(w.wires[1]!)
    w.wires[0]!.pump()
    expect(w.transport.send({ type: 'stop_generation' })).toBe(true)
    expect(w.wires[1]!.sent.map((text) => JSON.parse(text).type)).toContain('stop_generation')
    expect(w.executed).toEqual([{ type: 'stop_generation' }])
    // Taking the new path once is enough: no further moves without a new request.
    w.timers.advance(1000)
    await flush()
    expect(w.wires).toHaveLength(2)
    expect(w.connections).not.toContain('resuming')
    expect(w.connections).not.toContain('reconnecting')
    w.transport.dispose()
  })

  test('moving to a new path keeps the old one working until the new one is attached; interleaved frames apply once', async () => {
    const w = world({ manualOpen: (index) => index === 1 })
    await w.ready()
    const old = w.wires[0]!
    w.emit({ type: 'content_start', blockType: 'text' })
    w.emit({ type: 'content_delta', text: 'a' })
    old.pump()
    const before = w.connections.length
    w.transport.migrate()
    const moved = w.wires[1]!
    // Until the new path answers, the old one carries everything.
    w.emit({ type: 'content_delta', text: 'b' })
    old.pump()
    expect(w.transport.send({ type: 'stop_generation' })).toBe(true)
    expect(old.sent.map((text) => JSON.parse(text).type)).toContain('stop_generation')
    w.emit({ type: 'content_delta', text: 'c' })
    // The computer moves the stream: the old socket is told it was superseded (4000).
    moved.open()
    w.emit({ type: 'content_delta', text: 'd' })
    // 'c' reaches the phone on the old path after the new one already replayed it.
    moved.pump()
    await flush()
    old.pump()
    await flush()
    expect(assistantText(w.transport)).toEqual(['abcd'])
    expect(w.transport.connection).toBe('ready')
    expect(w.connections.slice(before)).toEqual([])
    expect(w.executed).toEqual([{ type: 'stop_generation' }])
    expect(w.reads()).toBe(2)
    expect(w.verifies()).toBe(0)
    // Commands now go over the new path.
    w.emit({ type: 'status', state: 'idle' })
    moved.pump()
    expect(w.transport.send({ type: 'user_message', content: 'next' })).toBe(true)
    expect(JSON.parse(moved.sent.at(-1)!).type).toBe('user_message')
    expect(w.executed.at(-1)).toEqual({ type: 'user_message', content: 'next' })
    w.transport.dispose()
  })

  test('the old socket being superseded before the new path answers is not treated as a drop', async () => {
    const w = world({ manualOpen: (index) => index === 1 })
    await w.ready()
    const old = w.wires[0]!
    w.transport.migrate()
    const moved = w.wires[1]!
    moved.open()
    w.emit({ type: 'content_delta', text: 'x' })
    // The close for the old socket happens to arrive first.
    old.pump()
    await flush()
    expect(old.readyState).toBe(3)
    expect(w.wires).toHaveLength(2)
    expect(w.transport.connection).toBe('ready')
    moved.pump()
    await flush()
    expect(assistantText(w.transport)).toEqual(['x'])
    expect(w.connections.filter((state) => state !== 'ready')).toEqual(['connecting', 'syncing'])
    expect(w.verifies()).toBe(0)
    w.transport.dispose()
  })

  test('a new path that fails keeps the old socket in use, without resuming or re-reading', async () => {
    const w = world({ manualOpen: (index) => index === 1 || index === 2 })
    await w.ready()
    const old = w.wires[0]!
    const before = w.connections.length
    w.transport.migrate()
    w.wires[1]!.fail()
    await flush()
    w.emit({ type: 'content_delta', text: 'still here' })
    old.pump()
    expect(assistantText(w.transport)).toEqual(['still here'])
    expect(w.transport.send({ type: 'stop_generation' })).toBe(true)
    expect(w.executed).toEqual([{ type: 'stop_generation' }])
    expect(w.connections.slice(before)).toEqual([])
    expect(w.reads()).toBe(2)
    expect(w.verifies()).toBe(0)
    // A path that never answers is given up in time, also without touching the old socket.
    w.transport.migrate()
    expect(w.wires).toHaveLength(3)
    w.timers.advance(20_000)
    await flush()
    expect(w.wires[2]!.readyState).not.toBe(1)
    expect(old.readyState).toBe(1)
    expect(w.transport.connection).toBe('ready')
    expect(w.connections.slice(before)).toEqual([])
    w.transport.dispose()
  })
})
