import { describe, expect, test } from 'bun:test'
import { ApiError, type ApiClient } from './client'
import {
  SessionTransport,
  type ConnectionState,
  type HistoryStore,
  type SocketLike,
  type TransportTimers,
} from './sessionTransport'
import type {
  ClientMessage,
  HistoryEntry,
  HistoryPage,
  ServerEvent,
} from './types'

const { extractReplayUserText } = await import(
  new URL('../../../src/server/ws/cliMessageParsing.ts', import.meta.url).href
) as { extractReplayUserText(message: unknown): string | null }

class FakeTimers implements TransportTimers {
  now = 0
  nextId = 0
  jobs = new Map<number, { at: number; callback: () => void }>()
  set(callback: () => void, delay: number) {
    const id = ++this.nextId
    this.jobs.set(id, { at: this.now + delay, callback })
    return id
  }
  clear(handle: unknown) {
    this.jobs.delete(handle as number)
  }
  advance(ms: number) {
    const end = this.now + ms
    for (let count = 0; count < 1000; count++) {
      const next = [...this.jobs]
        .filter(([, job]) => job.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) {
        this.now = end
        return
      }
      this.now = next[1].at
      this.jobs.delete(next[0])
      next[1].callback()
    }
    throw new Error('Unexpected timer loop')
  }
}
class FakeSocket implements SocketLike {
  url = ''
  readyState = 0
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null
  sent: (ClientMessage | Record<string, unknown>)[] = []
  closed = false
  send(data: string) {
    if (this.readyState !== 1) throw new Error('Socket closed')
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.readyState = 3
    this.closed = true
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  receive(event: ServerEvent) {
    this.onmessage?.({ data: JSON.stringify(event) })
  }
  drop(code = 1006) {
    this.readyState = 3
    this.onclose?.({ code })
  }
  /** The server's answer to a stream request (see resumableStreams.ts). */
  attach(frame: { resumed: boolean; next: number; last: number; cack?: number; epoch?: string }) {
    this.onmessage?.({
      data: JSON.stringify({ type: 'stream_attached', v: 1, stream: 'fixture', epoch: 'epoch-1', cack: 0, ...frame }),
    })
  }
  /** A numbered stream frame. */
  frame(seq: number, event: ServerEvent | Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ seq, ...event }) })
  }
  /** The open-time snapshots as numbered frames, from `seq` on; returns the next number. */
  streamSnapshots(seq = 1) {
    this.frame(seq, { type: 'connected', sessionId: 'session' })
    this.frame(seq + 1, {
      type: 'permission_requests_snapshot',
      toolRequestIds: [],
      computerUseRequestIds: [],
      turnActive: false,
    })
    this.frame(seq + 2, { type: 'session_state', turnState: 'idle', activeBackgroundTaskIds: [] })
    return seq + 3
  }
  snapshots() {
    this.receive({ type: 'connected', sessionId: 'session' })
    this.receive({
      type: 'permission_requests_snapshot',
      toolRequestIds: [],
      computerUseRequestIds: [],
      turnActive: false,
    })
    this.receive({
      type: 'session_state',
      turnState: 'idle',
      activeBackgroundTaskIds: [],
    })
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}
const entry = (
  id: string,
  type: HistoryEntry['type'],
  content: unknown
): HistoryEntry => ({ id, type, content, timestamp: '2026-01-01T00:00:00Z' })
const history = (
  messages: HistoryEntry[] = [],
  sourceVersion = 'v1',
  nextCursor: string | null = null
): HistoryPage => ({
  messages,
  page: {
    sourceVersion,
    nextCursor,
    hasMore: !!nextCursor,
    historyComplete: !nextCursor,
    scannedBytes: 100,
    omittedOversizedEntries: 0,
  },
})

function harness(
  load: ApiClient['history'] = async () => history(),
  baseline = history(),
  store?: HistoryStore,
  extra: {
    verify?: ApiClient['verify']
    gate?: { hold(): () => void }
    streams?: boolean
  } = {}
) {
  let streamCount = 0
  const timers = new FakeTimers()
  const sockets: FakeSocket[] = []
  const connections: ConnectionState[] = []
  const errors: Error[] = []
  const verifies: number[] = []
  let skew = 0
  let firstRead = true
  let historyCalls = 0
  const client = {
    host: {
      id: 'a',
      name: 'A',
      url: 'http://192.168.1.1:3456',
      auth: 'lan' as const,
    },
    history: ((...args) => {
      historyCalls++
      if (firstRead) {
        firstRead = false
        return Promise.resolve(baseline)
      }
      return load(...args)
    }) as ApiClient['history'],
    verify: ((...args) => {
      verifies.push(timers.now)
      return extra.verify ? extra.verify(...args) : Promise.resolve({ ok: true as const })
    }) as ApiClient['verify'],
  }
  const transport = new SessionTransport({
    client,
    credential: 'fake-token',
    sessionId: 'session',
    platform: 'native',
    timers,
    clock: () => timers.now + skew,
    gate: extra.gate,
    ...(extra.streams
      ? { newStreamId: () => `stream${String(++streamCount).padStart(16, '0')}` }
      : {}),
    socketFactory: (options) => {
      expect(options.headers?.Authorization).toBe('Bearer fake-token')
      const socket = new FakeSocket()
      socket.url = options.url
      sockets.push(socket)
      return socket
    },
    onState: () => {},
    onConnection: (state) => connections.push(state),
    onError: (error) => errors.push(error),
    history: store,
  })
  transport.start()
  return {
    transport,
    sockets,
    timers,
    connections,
    errors,
    verifies,
    historyCalls: () => historyCalls,
    /** 模拟进程被挂起：墙钟往前走，计时器却没有按时触发。 */
    suspend: (ms: number) => {
      skew += ms
    },
    now: () => timers.now + skew,
    ready: async () => {
      await flush()
      const socket = sockets.at(-1)!
      socket.open()
      socket.snapshots()
      await flush()
      return socket
    },
  }
}

describe('session synchronization', () => {
  test('confirmed REST rename survives subsequent stream state and reconnect', async () => {
    const h = harness()
    const socket = await h.ready()
    socket.receive({
      type: 'session_title_updated',
      sessionId: 'session',
      title: 'Automatic title',
    })
    h.transport.confirmTitle('User chosen title')
    socket.receive({ type: 'status', state: 'idle' })
    expect(h.transport.state.title).toBe('User chosen title')
    h.transport.reconnect()
    const next = await h.ready()
    expect(h.transport.state.title).toBe('User chosen title')
    next.receive({
      type: 'session_title_updated',
      sessionId: 'session',
      title: 'New server title',
    })
    expect(h.transport.state.title).toBe('New server title')
    h.transport.dispose()
    h.transport.confirmTitle('Late result after exit')
    expect(h.transport.state.title).toBe('New server title')
  })
  test('reads prior IDs then subscribes before hydration and buffers live events', async () => {
    const pending = deferred<HistoryPage>()
    let reads = 0
    const h = harness(async () => {
      reads++
      return pending.promise
    })
    expect(reads).toBe(0)
    expect(h.sockets).toHaveLength(0)
    await flush()
    const socket = h.sockets[0]
    socket.open()
    expect(reads).toBe(1)
    expect(socket.sent).toEqual([{ type: 'sync_state' }])
    socket.snapshots()
    socket.receive({
      type: 'content_delta',
      text: 'Arrived during history load',
    })
    expect(h.transport.connection).toBe('syncing')
    expect(
      h.transport.send({ type: 'user_message', content: 'Too early' })
    ).toBe(false)
    pending.resolve(history([entry('old', 'user', 'Old message')]))
    await flush()
    expect(h.transport.connection).toBe('ready')
    expect(h.transport.state.items.map((i) => i.text)).toEqual([
      'Old message',
      'Arrived during history load',
    ])
    h.transport.dispose()
  })

  test('history plus open socket alone cannot mark connection ready', async () => {
    const h = harness()
    await flush()
    const socket = h.sockets[0]
    socket.open()
    await flush()
    socket.receive({ type: 'connected', sessionId: 'session' })
    socket.receive({ type: 'session_state', turnState: 'idle' })
    expect(h.transport.connection).toBe('syncing')
    socket.receive({
      type: 'permission_requests_snapshot',
      toolRequestIds: [],
      computerUseRequestIds: [],
      turnActive: false,
    })
    expect(h.transport.connection).toBe('ready')
    h.transport.dispose()
  })

  test('a full user-bounded buffered turn replaces overlapping persisted history once', async () => {
    const pending = deferred<HistoryPage>()
    let reads = 0
    const complete = history(
      [
        entry('user', 'user', 'New prompt'),
        entry('answer', 'assistant', 'Same answer'),
      ],
      'v2'
    )
    const h = harness(async () => (++reads === 1 ? pending.promise : complete))
    await flush()
    const socket = h.sockets[0]
    socket.open()
    socket.snapshots()
    socket.receive({ type: 'user_message_replay', content: 'New prompt' })
    socket.receive({ type: 'content_delta', text: 'Same answer' })
    socket.receive({
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    pending.resolve(complete)
    await flush()
    expect(h.transport.state.items.map((i) => i.text)).toEqual([
      'New prompt',
      'Same answer',
    ])
    h.timers.advance(100)
    await flush()
    expect(h.transport.state.items.map((i) => i.text)).toEqual([
      'New prompt',
      'Same answer',
    ])
    expect(
      h.transport.state.items.every((item) => !item.id.startsWith('live:'))
    ).toBe(true)
    h.transport.dispose()
  })

  test('partial persisted answer overlaps only the matching user-bounded live turn', async () => {
    const pending = deferred<HistoryPage>()
    const h = harness(async () => pending.promise)
    await flush()
    const socket = h.sockets[0]
    socket.open()
    socket.snapshots()
    socket.receive({ type: 'user_message_replay', content: 'New prompt' })
    socket.receive({ type: 'content_delta', text: 'Full answer' })
    pending.resolve(
      history([
        entry('user', 'user', 'New prompt'),
        entry('answer', 'assistant', 'Full'),
      ])
    )
    await flush()
    expect(h.transport.state.items.map((i) => i.text)).toEqual([
      'New prompt',
      'Full answer',
    ])
    h.transport.dispose()
  })

  test('a fully repeated prompt and answer cannot be mistaken for initial overlap', async () => {
    const old = [
      entry('u1', 'user', 'Continue'),
      entry('a1', 'assistant', 'Done'),
    ]
    let persisted = history(old)
    const hydration = deferred<HistoryPage>()
    let reads = 0
    const h = harness(
      async () => (++reads === 1 ? hydration.promise : persisted),
      history(old)
    )
    await flush()
    const socket = h.sockets[0]
    socket.open()
    socket.snapshots()
    socket.receive({ type: 'user_message_replay', content: 'Continue' })
    socket.receive({ type: 'content_delta', text: 'Done' })
    socket.receive({
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    hydration.resolve(history(old))
    await flush()
    expect(h.transport.state.items.map((item) => item.text)).toEqual([
      'Continue',
      'Done',
      'Continue',
      'Done',
    ])
    h.timers.advance(100)
    await flush()
    expect(h.transport.state.items.map((item) => item.text)).toEqual([
      'Continue',
      'Done',
      'Continue',
      'Done',
    ])
    persisted = history(
      [
        ...old,
        entry('u2', 'user', 'Continue'),
        entry('a2', 'assistant', 'Done'),
      ],
      'v2'
    )
    h.timers.advance(500)
    await flush()
    expect(h.transport.state.items.map((item) => item.text)).toEqual([
      'Continue',
      'Done',
      'Continue',
      'Done',
    ])
    expect(
      h.transport.state.items.every((item) => !item.id.startsWith('live:'))
    ).toBe(true)
    h.transport.dispose()
  })

  test('new history read fills the interval between the prior ID baseline and WS subscription', async () => {
    const baseline = history([entry('old', 'user', 'Earlier')])
    const latest = history(
      [
        ...baseline.messages,
        entry('gap', 'assistant', 'Arrived before WS opened'),
      ],
      'v2'
    )
    const h = harness(async () => latest, baseline)
    await h.ready()
    expect(h.transport.state.items.map((item) => item.text)).toEqual([
      'Earlier',
      'Arrived before WS opened',
    ])
    h.transport.dispose()
  })

  test('starting another turn before first reconciliation still allows canonical convergence', async () => {
    let persisted = history()
    const h = harness(async () => persisted)
    const socket = await h.ready()
    h.transport.send({ type: 'user_message', content: 'One' })
    socket.receive({ type: 'user_message_replay', content: 'One' })
    socket.receive({ type: 'content_delta', text: 'First answer' })
    socket.receive({
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    h.transport.send({ type: 'user_message', content: 'Two' })
    socket.receive({ type: 'user_message_replay', content: 'Two' })
    socket.receive({ type: 'content_delta', text: 'Second answer' })
    socket.receive({
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    persisted = history(
      [
        entry('u1', 'user', 'One'),
        entry('a1', 'assistant', 'First answer'),
        entry('u2', 'user', 'Two'),
        entry('a2', 'assistant', 'Second answer'),
      ],
      'v2'
    )
    h.timers.advance(100)
    await flush()
    expect(h.transport.state.items.map((item) => item.text)).toEqual([
      'One',
      'First answer',
      'Two',
      'Second answer',
    ])
    expect(
      h.transport.state.items.every((item) => !item.id.startsWith('live:'))
    ).toBe(true)
    h.transport.dispose()
  })

  test('old identical answer cannot satisfy persistence of a new turn', async () => {
    const old = [
      entry('u1', 'user', 'old question'),
      entry('a1', 'assistant', 'Done'),
    ]
    let persisted = old
    const h = harness(async () =>
      history(persisted, persisted === old ? 'v1' : 'v2')
    )
    const socket = await h.ready()
    h.transport.send({ type: 'user_message', content: 'new question' })
    socket.receive({ type: 'user_message_replay', content: 'new question' })
    socket.receive({ type: 'content_delta', text: 'Done' })
    socket.receive({
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    h.timers.advance(100)
    await flush()
    expect(h.transport.state.items.map((i) => i.text)).toEqual([
      'old question',
      'Done',
      'new question',
      'Done',
    ])
    persisted = [
      ...old,
      entry('u2', 'user', 'new question'),
      entry('a2', 'assistant', 'Done'),
    ]
    h.timers.advance(500)
    await flush()
    expect(h.transport.state.items.map((i) => i.text)).toEqual([
      'old question',
      'Done',
      'new question',
      'Done',
    ])
    expect(
      h.transport.state.items.every((item) => !item.id.startsWith('live:'))
    ).toBe(true)
    h.transport.dispose()
  })

  test('joining mid-turn keeps ambiguous output until a changed persisted block can reconcile it', async () => {
    let persisted = history([
      entry('u1', 'user', 'Question'),
      entry('a1', 'assistant', 'Hel'),
    ])
    const h = harness(async () => persisted)
    const socket = await h.ready()
    socket.receive({ type: 'content_delta', text: 'lo' })
    socket.receive({
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    h.timers.advance(100)
    await flush()
    expect(h.transport.state.items.map((i) => i.text)).toEqual([
      'Question',
      'Hel',
      'lo',
    ])
    persisted = history(
      [entry('u1', 'user', 'Question'), entry('a1', 'assistant', 'Hello')],
      'v2'
    )
    h.timers.advance(500)
    await flush()
    expect(h.transport.state.items.map((i) => i.text)).toEqual([
      'Question',
      'Hello',
    ])
    h.transport.dispose()
  })

  test('a late completion refresh cannot overwrite a newly sent turn', async () => {
    const pending = deferred<HistoryPage>()
    let reads = 0
    const h = harness(async () => (++reads === 1 ? history() : pending.promise))
    const socket = await h.ready()
    socket.receive({ type: 'content_delta', text: 'First answer' })
    socket.receive({
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    h.timers.advance(100)
    expect(
      h.transport.send({ type: 'user_message', content: 'Second question' })
    ).toBe(true)
    socket.receive({ type: 'content_delta', text: 'Second answer' })
    pending.resolve(
      history([entry('first', 'assistant', 'First answer')], 'v2')
    )
    await flush()
    expect(h.transport.state.items.map((i) => i.text)).toContain(
      'Second answer'
    )
    expect(h.transport.state.items.map((i) => i.text)).toContain(
      'Second question'
    )
    expect(h.transport.state.turnActive).toBe(true)
    h.transport.dispose()
  })

  test('does not erase output while the persisted transcript still lags', async () => {
    let reads = 0
    const h = harness(async () => {
      reads++
      return history()
    })
    const socket = await h.ready()
    socket.receive({ type: 'content_delta', text: 'Not persisted yet' })
    socket.receive({
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    for (const delay of [100, 500, 1500]) {
      h.timers.advance(delay)
      await flush()
    }
    expect(reads).toBe(4)
    expect(h.transport.state.items.map((i) => i.text)).toEqual([
      'Not persisted yet',
    ])
    h.transport.dispose()
  })
})

describe('transport lifecycle and outbound commands', () => {
  test('real image replay and merged persisted blocks converge without duplicating or losing the image', async () => {
    let persisted = history()
    const h = harness(async () => persisted)
    const socket = await h.ready()
    const attachment = { type: 'image' as const, data: 'aGk=', mimeType: 'image/png', name: 'photo.png' }
    const path = '/tmp/fixture/uploads/session/photo.png'
    const blocks = [
      { type: 'text', text: 'Describe' },
      { type: 'image', source: { type: 'base64', media_type: attachment.mimeType, data: attachment.data } },
      { type: 'text', text: `[Image: source: ${path}]` },
    ]
    expect(h.transport.send({ type: 'user_message', content: 'Describe', attachments: [attachment] })).toBe(true)
    socket.receive({ type: 'user_message_replay', content: extractReplayUserText({ type: 'user', isReplay: true, message: { content: blocks } })! })
    expect(h.transport.state.items).toHaveLength(1)
    expect(h.transport.state.items[0]).toMatchObject({ pending: false, attachments: [{ ...attachment, path }] })
    socket.receive({ type: 'content_delta', text: 'An image.' })
    persisted = history([entry('image-turn', 'user', blocks), entry('answer', 'assistant', 'An image.')], 'v2')
    socket.receive({ type: 'message_complete', usage: { input_tokens: 1, output_tokens: 1 } })
    h.timers.advance(100)
    await flush()
    expect(h.transport.state.items).toHaveLength(2)
    expect(h.transport.state.items[0]).toMatchObject({ sourceMessageId: 'image-turn', text: 'Describe', attachments: [{ ...attachment, path }] })
    expect(h.transport.state.items[1]).toMatchObject({ sourceMessageId: 'answer', text: 'An image.' })
    h.transport.dispose()
  })
  test('material-only messages retain the local attachment through replay and converge to saved history', async () => {
    let persisted = history()
    const h = harness(async () => persisted)
    const socket = await h.ready()
    const attachment = {
      type: 'image' as const,
      data: 'aGk=',
      mimeType: 'image/jpeg',
      name: 'photo.jpg',
    }
    expect(
      h.transport.send({
        type: 'user_message',
        content: '',
        attachments: [attachment],
      })
    ).toBe(true)
    expect(h.transport.state.items[0]).toMatchObject({
      type: 'user',
      pending: true,
      attachments: [attachment],
    })
    socket.receive({ type: 'user_message_replay', content: '' })
    expect(h.transport.state.items).toHaveLength(1)
    expect(h.transport.state.items[0]).toMatchObject({
      pending: false,
      attachments: [attachment],
    })
    socket.receive({
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 0 },
    })
    h.timers.advance(100)
    await flush()
    expect(h.transport.state.items[0]?.attachments).toEqual([attachment])
    socket.receive({ type: 'content_delta', text: 'I can read the image.' })
    socket.receive({
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    persisted = history(
      [
        entry('image-turn', 'user', [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: 'aGk=' },
          },
        ]),
        entry('answer', 'assistant', 'I can read the image.'),
      ],
      'v2'
    )
    h.timers.advance(100)
    await flush()
    expect(h.transport.state.items).toHaveLength(2)
    expect(h.transport.state.items[0]).toMatchObject({
      sourceMessageId: 'image-turn',
      attachments: [{ type: 'image', data: 'aGk=', mimeType: 'image/jpeg' }],
    })
    h.transport.dispose()
  })
  test('disconnect retries connection without replaying an already sent user command', async () => {
    const h = harness()
    const first = await h.ready()
    expect(h.transport.send({ type: 'user_message', content: 'Do once' })).toBe(
      true
    )
    expect(h.transport.state.items[0]).toMatchObject({
      type: 'user',
      text: 'Do once',
      pending: true,
    })
    first.drop()
    expect(h.transport.connection).toBe('reconnecting')
    expect(
      h.transport.send({ type: 'user_message', content: 'Not ready' })
    ).toBe(false)
    h.timers.advance(500)
    const second = await h.ready()
    expect(second.sent).toEqual([{ type: 'sync_state' }])
    expect(first.sent.filter((m) => m.type === 'user_message')).toHaveLength(1)
    h.transport.dispose()
  })

  test('running, optimistic sends and permission requests prevent model switches', async () => {
    const h = harness()
    const socket = await h.ready()
    const model: ClientMessage = {
      type: 'set_runtime_config',
      providerId: null,
      modelId: 'model',
    }
    expect(h.transport.send(model)).toBe(true)
    expect(h.transport.state.configPending).toBe(true)
    expect(
      h.transport.send({
        type: 'user_message',
        content: 'Wait for runtime acknowledgement',
      })
    ).toBe(false)
    socket.receive({
      type: 'runtime_config_applied',
      providerId: null,
      modelId: 'model',
    })
    expect(h.transport.state.configPending).toBe(false)
    expect(
      h.transport.send({ type: 'user_message', content: 'Now start' })
    ).toBe(true)
    expect(h.transport.send(model)).toBe(false)
    socket.receive({ type: 'user_message_replay', content: 'Now start' })
    socket.receive({
      type: 'permission_request',
      requestId: 'request',
      toolName: 'Write',
      input: {},
    })
    expect(h.transport.send(model)).toBe(false)
    expect(
      h.transport.send({
        type: 'permission_response',
        requestId: 'unknown',
        allowed: true,
      })
    ).toBe(false)
    expect(
      h.transport.send({
        type: 'permission_response',
        requestId: 'request',
        allowed: false,
      })
    ).toBe(true)
    expect(h.transport.state.permissions).toHaveLength(1)
    h.transport.dispose()
  })

  test('stop followed only by idle preserves partial text and allows an explicit next send', async () => {
    const h = harness()
    const socket = await h.ready()
    expect(h.transport.send({ type: 'user_message', content: '/slow' })).toBe(
      true
    )
    socket.receive({ type: 'user_message_replay', content: '/slow' })
    socket.receive({
      type: 'content_delta',
      text: 'Partial response before stop',
    })
    expect(h.transport.send({ type: 'stop_generation' })).toBe(true)
    socket.receive({ type: 'status', state: 'idle' })
    const partial = h.transport.state.items.find(
      (item) => item.type === 'assistant'
    )
    expect(partial).toMatchObject({
      text: 'Partial response before stop',
      pending: false,
    })
    expect(h.transport.state.activeTextId).toBeUndefined()
    expect(
      h.transport.send({ type: 'user_message', content: 'Next task' })
    ).toBe(true)
    socket.receive({ type: 'content_delta', text: 'A new response' })
    expect(
      h.transport.state.items
        .filter((item) => item.type === 'assistant')
        .map((item) => item.text)
    ).toEqual(['Partial response before stop', 'A new response'])
    h.transport.dispose()
  })

  test('configuration ack, error, timeout and disconnect release the pending gate', async () => {
    const h = harness()
    const socket = await h.ready()
    const mode: ClientMessage = { type: 'set_permission_mode', mode: 'plan' }
    expect(h.transport.send(mode)).toBe(true)
    expect(h.transport.state.configPending).toBe(true)
    expect(
      h.transport.send({ type: 'user_message', content: 'Too soon' })
    ).toBe(false)
    socket.receive({ type: 'permission_mode_changed', mode: 'default' })
    expect(h.transport.state.configPending).toBe(true)
    socket.receive({ type: 'permission_mode_changed', mode: 'plan' })
    expect(h.transport.state.configPending).toBe(false)
    h.transport.send({
      type: 'set_runtime_config',
      modelId: 'invalid',
      providerId: null,
    })
    socket.receive({
      type: 'error',
      message: 'Rejected',
      code: 'RUNTIME_CONFIG_INVALID',
    })
    expect(h.transport.state.configPending).toBe(false)
    h.transport.send(mode)
    h.timers.advance(10000)
    expect(h.transport.state.configPending).toBe(false)
    expect(h.errors.at(-1)).toMatchObject({ code: 'CONFIG_TIMEOUT' })
    h.transport.send(mode)
    socket.drop(1001)
    expect(h.transport.state.configPending).toBe(false)
    h.transport.dispose()
  })

  test('expired question activity and approval IDs are never sent', async () => {
    const h = harness()
    const socket = await h.ready()
    socket.receive({
      type: 'permission_request',
      requestId: 'question',
      toolName: 'AskUserQuestion',
      input: {},
    })
    expect(
      h.transport.send({
        type: 'ask_user_question_activity',
        requestId: 'question',
      })
    ).toBe(true)
    socket.receive({
      type: 'permission_resolved',
      requestId: 'question',
      permissionType: 'tool',
    })
    const count = socket.sent.length
    expect(
      h.transport.send({
        type: 'ask_user_question_activity',
        requestId: 'question',
      })
    ).toBe(false)
    expect(
      h.transport.send({
        type: 'permission_response',
        requestId: 'question',
        allowed: true,
      })
    ).toBe(false)
    expect(socket.sent).toHaveLength(count)
    h.transport.dispose()
  })

  test('unconfirmed delivery after an idle reconnect does not permanently block the composer', async () => {
    const h = harness()
    await h.ready()
    h.transport.send({ type: 'user_message', content: 'Uncertain' })
    h.transport.reconnect()
    const socket = await h.ready()
    expect(h.transport.state.items[0]).toMatchObject({
      delivery: 'uncertain',
      pending: false,
      text: 'Uncertain',
    })
    h.timers.advance(100)
    await flush()
    expect(h.transport.state.items[0]).toMatchObject({
      delivery: 'uncertain',
      pending: false,
      text: 'Uncertain',
    })
    expect(
      h.transport.send({
        type: 'user_message',
        content: 'Next explicit message',
      })
    ).toBe(true)
    expect(
      socket.sent.filter((message) => message.type === 'user_message')
    ).toEqual([{ type: 'user_message', content: 'Next explicit message' }])
    h.transport.dispose()
  })

  test('HTTP 401 and a confirmed credential rejection after WS 1008 require re-pairing', async () => {
    const unauthorized = harness(async () => {
      throw new ApiError('Unauthorized', 401)
    })
    await flush()
    unauthorized.sockets[0].open()
    await flush()
    expect(unauthorized.transport.connection).toBe('pairing_required')
    unauthorized.timers.advance(60000)
    expect(unauthorized.sockets).toHaveLength(1)
    let rejectCredential = false
    const revoked = harness(
      async () => {
        if (rejectCredential) throw new ApiError('Unauthorized', 401)
        return history()
      },
      undefined,
      undefined,
      {
        verify: async () => {
          if (rejectCredential) throw new ApiError('Unauthorized', 401)
          return { ok: true }
        },
      }
    )
    const socket = await revoked.ready()
    rejectCredential = true
    socket.drop(1008)
    await flush()
    revoked.transport.reconnect()
    revoked.timers.advance(60000)
    expect(revoked.transport.connection).toBe('pairing_required')
    expect(revoked.sockets).toHaveLength(1)
    unauthorized.transport.dispose()
    revoked.transport.dispose()
  })

  test.each([1008, 1012])('a tunnel restart (%i) reconnects with the same credential when HTTP still authorizes it', async code => {
    const h = harness()
    const socket = await h.ready()
    socket.drop(code)
    await flush()
    expect(h.transport.connection).toBe('reconnecting')
    expect(h.errors).toHaveLength(0)
    h.timers.advance(500)
    const reconnected = await h.ready()
    expect(h.sockets).toHaveLength(2)
    expect(h.transport.connection).toBe('ready')
    expect(reconnected.sent).toEqual([{ type: 'sync_state' }])
    h.transport.dispose()
  })

  test.each([0, 403, 429, 503])('a 1008 close followed by HTTP %i keeps retrying instead of discarding authorization', async status => {
    let unavailable = false
    const h = harness(
      async () => {
        if (unavailable) throw new ApiError('Temporarily unavailable', status)
        return history()
      },
      undefined,
      undefined,
      {
        verify: async () => {
          if (unavailable) throw new ApiError('Temporarily unavailable', status)
          return { ok: true }
        },
      }
    )
    const socket = await h.ready()
    unavailable = true
    socket.drop(1008)
    await flush()
    expect(h.transport.connection).toBe('reconnecting')
    expect(h.connections).not.toContain('pairing_required')
    h.timers.advance(500)
    await flush()
    expect(h.transport.connection).toBe('reconnecting')
    unavailable = false
    h.timers.advance(1000)
    await h.ready()
    expect(h.transport.connection).toBe('ready')
    expect(h.connections).not.toContain('pairing_required')
    h.transport.dispose()
  })

  test('a late rejected authorization probe cannot invalidate a newer healthy connection', async () => {
    const pending = deferred<{ ok: true }>()
    let probePending = false
    const h = harness(undefined, undefined, undefined, {
      verify: async () => {
        if (probePending) {
          probePending = false
          return pending.promise
        }
        return { ok: true }
      },
    })
    const socket = await h.ready()
    probePending = true
    socket.drop(1008)
    await flush()
    h.transport.reconnect()
    await h.ready()
    expect(h.transport.connection).toBe('ready')
    pending.reject(new ApiError('Stale credential rejection', 401))
    await flush()
    expect(h.transport.connection).toBe('ready')
    expect(h.connections).not.toContain('pairing_required')
    h.transport.dispose()
  })

  test('1006 handshake failure asks verify() to expose an otherwise hidden 401, without a history read', async () => {
    const h = harness(undefined, undefined, undefined, {
      verify: async () => {
        throw new ApiError('Unauthorized', 401)
      },
    })
    await flush()
    const reads = h.historyCalls()
    h.sockets[0].drop(1006)
    await flush()
    expect(h.verifies).toHaveLength(1)
    expect(h.historyCalls()).toBe(reads)
    expect(h.transport.connection).toBe('pairing_required')
    h.timers.advance(30000)
    expect(h.sockets).toHaveLength(1)
    h.transport.dispose()
  })

  test('ping/pong keeps the socket alive and a missing pong triggers reconnect', async () => {
    const h = harness()
    const socket = await h.ready()
    h.timers.advance(15000)
    expect(socket.sent.at(-1)).toEqual({ type: 'ping' })
    socket.receive({ type: 'pong' })
    h.timers.advance(15000)
    expect(h.transport.connection).toBe('ready')
    h.timers.advance(15000)
    expect(h.transport.connection).toBe('reconnecting')
    expect(socket.closed).toBe(true)
    h.transport.dispose()
  })

  test('reconnect backoff caps at 30 seconds', async () => {
    const h = harness()
    await flush()
    for (const delay of [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const count = h.sockets.length
      h.sockets.at(-1)!.drop(1001)
      h.timers.advance(delay - 1)
      expect(h.sockets).toHaveLength(count)
      h.timers.advance(1)
      await flush()
      expect(h.sockets).toHaveLength(count + 1)
    }
    h.transport.dispose()
    expect(h.timers.jobs.size).toBe(0)
  })

  test('dispose aborts in-flight history and ignores stale callbacks', async () => {
    const pending = deferred<HistoryPage>()
    let signal: AbortSignal | undefined
    const h = harness(async (_id, _cursor, options) => {
      signal = options?.signal
      return pending.promise
    })
    await flush()
    h.sockets[0].open()
    h.transport.dispose()
    expect(signal?.aborted).toBe(true)
    pending.resolve(history([entry('late', 'assistant', 'Late response')]))
    await flush()
    expect(h.transport.state.items).toHaveLength(0)
    expect(h.sockets[0].closed).toBe(true)
  })
})

describe('incremental sync from the tail', () => {
  const tailed = (
    messages: HistoryEntry[],
    tail: string,
    complete = true,
    sourceVersion = 'v1',
    nextCursor: string | null = null
  ): HistoryPage => {
    const page = history(messages, sourceVersion, nextCursor)
    return { ...page, page: { ...page.page!, tailCursor: tail, tailComplete: complete } }
  }

  test('a reconnect with a tail cursor reads only what was appended, never a full page', async () => {
    const cursors: (string | undefined)[] = []
    let n = 0
    const h = harness(
      async (_id, cursor) => {
        cursors.push(cursor)
        n++
        return n === 2
          ? tailed([entry('u1', 'user', 'Later'), entry('a1', 'assistant', 'Reply')], `tail-${n}`, true, `v${n}`)
          : tailed([], `tail-${n}`, true, `v${n}`)
      },
      tailed([entry('u0', 'user', 'Start'), entry('a0', 'assistant', 'Ok')], 'tail-0', true, 'v0', 'older-0')
    )
    const socket = await h.ready()
    socket.drop(1001)
    h.timers.advance(500)
    await h.ready()
    expect(cursors).toEqual(['tail-0', 'tail-1', 'tail-2'])
    expect(h.transport.state.items.map((item) => item.text)).toEqual(['Start', 'Ok', 'Later', 'Reply'])
    // The cursor chain still belongs to the first page, so older pages keep merging.
    expect(h.transport.historyPage?.page?.sourceVersion).toBe('v0')
    expect(h.transport.historyPage?.page?.nextCursor).toBe('older-0')
    h.transport.dispose()
  })

  test('a completed identical turn saved before subscription is not collapsed into a new one', async () => {
    const cached = tailed([entry('u0', 'user', 'Start'), entry('a0', 'assistant', 'Ok')], 'tail-0')
    const hydration = deferred<HistoryPage>()
    const h = harness(
      async () => hydration.promise,
      // Saved elsewhere between the cached read and this reconnect.
      tailed([entry('u1', 'user', 'Continue'), entry('a1', 'assistant', 'Done')], 'tail-1'),
      { read: () => cached, write: () => {} }
    )
    await flush()
    const socket = h.sockets[0]
    socket.open()
    socket.snapshots()
    socket.receive({ type: 'user_message_replay', content: 'Continue' })
    socket.receive({ type: 'content_delta', text: 'Done' })
    socket.receive({ type: 'message_complete', usage: { input_tokens: 1, output_tokens: 1 } })
    hydration.resolve(tailed([], 'tail-1'))
    await flush()
    expect(h.transport.state.items.map((item) => item.text)).toEqual([
      'Start',
      'Ok',
      'Continue',
      'Done',
      'Continue',
      'Done',
    ])
    h.transport.dispose()
  })

  test('a rewritten transcript (409 on follow) falls back to the newest page exactly once', async () => {
    const cursors: (string | undefined)[] = []
    const fresh = tailed([entry('r1', 'user', 'Rewritten')], 'tail-new', true, 'v9')
    const h = harness(
      async (_id, cursor) => {
        cursors.push(cursor)
        if (cursor === 'tail-0') throw new ApiError('Session history was rewritten', 409, 'HISTORY_CHANGED')
        return cursor ? tailed([], cursor, true, 'v9') : fresh
      },
      tailed([entry('u0', 'user', 'Start')], 'tail-0')
    )
    await h.ready()
    expect(cursors).toEqual(['tail-0', undefined])
    expect(h.transport.state.items.map((item) => item.text)).toEqual(['Rewritten'])
    expect(h.errors).toEqual([])
    h.transport.dispose()
  })

  test('a follow chain that cannot reach the tail within its pages falls back to the newest page', async () => {
    const cursors: (string | undefined)[] = []
    let n = 0
    const h = harness(
      async (_id, cursor) => {
        cursors.push(cursor)
        if (!cursor) return tailed([entry('latest', 'assistant', 'Newest')], 'tail-latest')
        n++
        return cursor === 'tail-latest'
          ? tailed([], 'tail-latest')
          : tailed([entry(`n${n}`, 'assistant', `More ${n}`)], `tail-${n}`, false)
      },
      tailed([entry('u0', 'user', 'Start')], 'tail-0')
    )
    await h.ready()
    expect(cursors).toEqual(['tail-0', 'tail-1', 'tail-2', undefined])
    expect(h.transport.state.items.at(-1)?.text).toBe('Newest')
    h.transport.dispose()
  })

  test('a computer downgraded to a version without follow cursors falls back to the newest page', async () => {
    const cursors: (string | undefined)[] = []
    const h = harness(
      async (_id, cursor) => {
        cursors.push(cursor)
        // An older computer reads the follow cursor as a plain "newer" cursor: an empty page without tailCursor.
        return cursor
          ? history([])
          : history([entry('u0', 'user', 'Start'), entry('u1', 'user', 'Later')])
      },
      tailed([entry('u0', 'user', 'Start')], 'tail-0')
    )
    await h.ready()
    expect(cursors).toEqual(['tail-0', undefined])
    expect(h.transport.state.items.map((item) => item.text)).toEqual(['Start', 'Later'])
    h.transport.dispose()
  })

  test('reconciling after a finished turn downloads only the records it appended', async () => {
    const cursors: (string | undefined)[] = []
    let persisted = false
    const h = harness(
      async (_id, cursor) => {
        cursors.push(cursor)
        return persisted && cursor === 'tail-0'
          ? tailed([entry('u1', 'user', 'Question'), entry('a1', 'assistant', 'Answer')], 'tail-1')
          : tailed([], cursor ?? 'tail-0')
      },
      tailed([], 'tail-0')
    )
    const socket = await h.ready()
    h.transport.send({ type: 'user_message', content: 'Question' })
    socket.receive({ type: 'user_message_replay', content: 'Question' })
    socket.receive({ type: 'content_delta', text: 'Answer' })
    socket.receive({ type: 'message_complete', usage: { input_tokens: 1, output_tokens: 1 } })
    persisted = true
    cursors.length = 0
    h.timers.advance(100)
    await flush()
    expect(cursors).toEqual(['tail-0'])
    expect(h.transport.state.items.map((item) => item.text)).toEqual(['Question', 'Answer'])
    expect(h.transport.state.items.every((item) => !item.id.startsWith('live:'))).toBe(true)
    expect(h.transport.historyPage?.page?.tailCursor).toBe('tail-1')
    h.transport.dispose()
  })
})

describe('returning to the foreground', () => {
  test('a socket that answers the probe is kept, with no new socket and no history read', async () => {
    const h = harness()
    const socket = await h.ready()
    const reads = h.historyCalls()
    h.suspend(10 * 60_000)
    h.transport.resume(h.now() - 10 * 60_000)
    expect(socket.sent.at(-1)).toEqual({ type: 'ping' })
    expect(h.transport.connection).toBe('ready')
    h.timers.advance(1000)
    socket.receive({ type: 'pong' })
    h.timers.advance(5000)
    expect(h.sockets).toHaveLength(1)
    expect(socket.closed).toBe(false)
    expect(h.historyCalls()).toBe(reads)
    expect(h.connections.at(-1)).toBe('ready')
    expect(h.connections).not.toContain('reconnecting')
    h.transport.dispose()
  })

  test('a probe with no answer reconnects at once instead of after a backoff', async () => {
    const h = harness()
    const socket = await h.ready()
    h.transport.resume(h.now())
    h.timers.advance(2499)
    expect(h.transport.connection).toBe('ready')
    h.timers.advance(1)
    expect(socket.closed).toBe(true)
    expect(h.transport.connection).toBe('reconnecting')
    h.timers.advance(0)
    await h.ready()
    expect(h.sockets).toHaveLength(2)
    expect(h.transport.connection).toBe('ready')
    h.transport.dispose()
  })

  test('resuming does not abort an attempt that is still in flight', async () => {
    const preflight = deferred<HistoryPage>()
    let hold = false
    const h = harness(async () => (hold ? preflight.promise : history()))
    const socket = await h.ready()
    hold = true
    socket.drop(1001)
    h.timers.advance(500)
    await flush()
    const reads = h.historyCalls()
    h.transport.resume(h.now())
    h.transport.resume(h.now())
    await flush()
    expect(h.historyCalls()).toBe(reads)
    hold = false
    preflight.resolve(history())
    await h.ready()
    expect(h.sockets).toHaveLength(2)
    expect(h.transport.connection).toBe('ready')
    h.transport.dispose()
  })

  test('an attempt that spanned a long background stay restarts on return', async () => {
    const stuck = deferred<HistoryPage>()
    let hold = false
    const h = harness(async () => (hold ? stuck.promise : history()))
    const socket = await h.ready()
    hold = true
    socket.drop(1001)
    h.timers.advance(500)
    await flush()
    const hiddenAt = h.now()
    h.suspend(60_000)
    const reads = h.historyCalls()
    hold = false
    h.transport.resume(hiddenAt)
    await flush()
    expect(h.historyCalls()).toBe(reads + 1)
    await h.ready()
    expect(h.transport.connection).toBe('ready')
    h.transport.dispose()
  })

  test('returning while a backoff is pending retries immediately', async () => {
    const h = harness()
    const socket = await h.ready()
    for (let i = 0; i < 4; i++) {
      h.sockets.at(-1)!.drop(1001)
      h.timers.advance(30_000)
      await flush()
    }
    h.sockets.at(-1)!.drop(1001)
    const count = h.sockets.length
    h.transport.resume(h.now())
    await flush()
    expect(h.sockets).toHaveLength(count + 1)
    expect(socket.closed).toBe(true)
    h.transport.dispose()
  })

  test('a heartbeat that fires late after a suspension probes instead of dropping the socket', async () => {
    const h = harness()
    const socket = await h.ready()
    h.timers.advance(15_000)
    expect(socket.sent.at(-1)).toEqual({ type: 'ping' })
    // The pong never got processed before iOS froze the process.
    h.suspend(5 * 60_000)
    h.timers.advance(15_000)
    expect(socket.closed).toBe(false)
    expect(h.transport.connection).toBe('ready')
    // The pong held back by the suspension arrives first, then the probe's own.
    socket.receive({ type: 'pong' })
    socket.receive({ type: 'pong' })
    h.timers.advance(15_000)
    expect(h.sockets).toHaveLength(1)
    expect(h.transport.connection).toBe('ready')
    h.transport.dispose()
  })

  test('only the probe\'s own pong keeps the socket: frames and a pong held back by the suspension do not', async () => {
    const h = harness()
    const socket = await h.ready()
    h.timers.advance(15_000)
    expect(socket.sent.at(-1)).toEqual({ type: 'ping' })
    h.suspend(60_000)
    h.transport.resume(h.now() - 60_000)
    expect(socket.sent.filter((message) => message.type === 'ping')).toHaveLength(2)
    // Delivered only now: output and the pong for the ping sent before the suspension.
    socket.receive({ type: 'content_delta', text: 'From before' })
    socket.receive({ type: 'pong' })
    h.timers.advance(2500)
    expect(socket.closed).toBe(true)
    expect(h.transport.connection).toBe('reconnecting')
    h.transport.dispose()
  })

  test('a probe answered by its pong keeps the socket even when other frames arrive first', async () => {
    const h = harness()
    const socket = await h.ready()
    h.transport.resume(h.now())
    socket.receive({ type: 'content_delta', text: 'Buffered' })
    h.timers.advance(1000)
    socket.receive({ type: 'pong' })
    h.timers.advance(5000)
    expect(socket.closed).toBe(false)
    expect(h.sockets).toHaveLength(1)
    expect(h.transport.connection).toBe('ready')
    h.transport.dispose()
  })

  test('the credential check after a failed handshake runs at most once every 30 seconds', async () => {
    const h = harness()
    await flush()
    h.sockets[0].drop(1006)
    await flush()
    expect(h.verifies).toHaveLength(1)
    h.timers.advance(500)
    await flush()
    h.sockets.at(-1)!.drop(1006)
    await flush()
    expect(h.sockets).toHaveLength(2)
    expect(h.verifies).toHaveLength(1)
    h.timers.advance(30_000)
    await flush()
    h.sockets.at(-1)!.drop(1006)
    await flush()
    expect(h.sockets).toHaveLength(3)
    expect(h.verifies).toHaveLength(2)
    h.transport.dispose()
  })

  test('failed attempts in a row are counted until the session is ready again', async () => {
    let down = false
    const h = harness(async () => {
      if (down) throw new ApiError('Network unavailable', 0, 'NETWORK_ERROR')
      return history()
    })
    const socket = await h.ready()
    expect(h.transport.failures).toBe(0)
    down = true
    socket.drop(1001)
    // Losing a working connection is not a failed attempt yet.
    expect(h.transport.failures).toBe(0)
    h.timers.advance(500)
    await flush()
    expect(h.transport.failures).toBe(1)
    h.timers.advance(1000)
    await flush()
    expect(h.transport.failures).toBe(2)
    down = false
    h.timers.advance(2000)
    await h.ready()
    expect(h.transport.connection).toBe('ready')
    expect(h.transport.failures).toBe(0)
    h.transport.dispose()
  })

  test('holds the foreground gate only while it is not ready', async () => {
    let holds = 0
    const released: number[] = []
    const gate = {
      hold: () => {
        const id = ++holds
        return () => released.push(id)
      },
    }
    const h = harness(undefined, undefined, undefined, { gate })
    await flush()
    expect(holds).toBe(1)
    expect(released).toEqual([])
    const socket = await h.ready()
    expect(released).toEqual([1])
    socket.drop(1001)
    expect(holds).toBe(2)
    h.timers.advance(500)
    await h.ready()
    expect(released).toEqual([1, 2])
    h.sockets.at(-1)!.drop(1001)
    h.transport.dispose()
    expect(released).toEqual([1, 2, 3])
  })
})

describe('resumable streams', () => {
  const streamParams = (socket: FakeSocket) => new URL(socket.url).searchParams
  /** Open a fresh stream and finish its first sync; returns the next frame number. */
  async function readyStream(h: ReturnType<typeof harness>) {
    await flush()
    const socket = h.sockets.at(-1)!
    socket.open()
    socket.attach({ resumed: false, next: 1, last: 0 })
    const next = socket.streamSnapshots(1)
    await flush()
    expect(h.transport.connection).toBe('ready')
    return { socket, next }
  }

  test('a stream that was in sync resumes on a new socket without reading history or reopening', async () => {
    const h = harness(undefined, undefined, undefined, { streams: true })
    const { socket, next } = await readyStream(h)
    expect(streamParams(socket).get('stream')).toBe('stream0000000000000001')
    expect(streamParams(socket).get('ack')).toBeNull()
    const reads = h.historyCalls()
    const before = h.connections.length
    socket.drop(1001)
    expect(h.transport.connection).toBe('reconnecting')
    h.timers.advance(500)
    await flush()
    const second = h.sockets.at(-1)!
    expect(h.transport.connection).toBe('resuming')
    expect(streamParams(second).get('stream')).toBe('stream0000000000000001')
    expect(streamParams(second).get('ack')).toBe(String(next - 1))
    expect(streamParams(second).get('epoch')).toBe('epoch-1')
    second.open()
    second.attach({ resumed: true, next, last: next + 1 })
    // Until the replay is in, nothing new may overtake what was sent before the drop.
    expect(h.transport.connection).toBe('resuming')
    expect(h.transport.send({ type: 'stop_generation' })).toBe(false)
    second.frame(next, { type: 'content_delta', text: 'While you were away' })
    expect(h.transport.connection).toBe('resuming')
    second.frame(next + 1, { type: 'message_complete', usage: { input_tokens: 1, output_tokens: 1 } })
    expect(h.transport.connection).toBe('ready')
    expect(h.transport.state.items.at(-1)?.text).toBe('While you were away')
    expect(h.historyCalls()).toBe(reads)
    expect(second.sent).toEqual([])
    expect(h.connections.slice(before)).toEqual(['reconnecting', 'resuming', 'ready'])
    h.transport.dispose()
  })

  test('a command sent on a dying socket is resent once with its number, unless the computer already ran it', async () => {
    for (const cack of [0, 1]) {
      const h = harness(undefined, undefined, undefined, { streams: true })
      const { socket, next } = await readyStream(h)
      expect(h.transport.send({ type: 'set_permission_mode', mode: 'plan' })).toBe(true)
      expect(socket.sent.at(-1)).toEqual({ cseq: 1, type: 'set_permission_mode', mode: 'plan' })
      socket.drop(1001)
      h.timers.advance(500)
      await flush()
      const second = h.sockets.at(-1)!
      second.open()
      second.attach({ resumed: true, next, last: next - 1, cack })
      expect(second.sent).toEqual(cack ? [] : [{ cseq: 1, type: 'set_permission_mode', mode: 'plan' }])
      h.transport.dispose()
    }
  })

  test('a decision resolved elsewhere during the gap is not resent', async () => {
    const h = harness(undefined, undefined, undefined, { streams: true })
    const { socket, next } = await readyStream(h)
    socket.frame(next, { type: 'permission_request', requestId: 'r1', toolName: 'Bash', input: {} })
    expect(h.transport.send({ type: 'permission_response', requestId: 'r1', allowed: true })).toBe(true)
    socket.drop(1001)
    h.timers.advance(500)
    await flush()
    const second = h.sockets.at(-1)!
    second.open()
    second.attach({ resumed: true, next: next + 1, last: next + 1 })
    expect(second.sent).toEqual([])
    second.frame(next + 1, { type: 'permission_resolved', requestId: 'r1', permissionType: 'tool' })
    expect(second.sent).toEqual([])
    expect(h.transport.state.permissions).toEqual([])
    h.transport.dispose()
  })

  test('the replay is applied before an unexecuted decision is resent', async () => {
    const h = harness(undefined, undefined, undefined, { streams: true })
    const { socket, next } = await readyStream(h)
    socket.frame(next, { type: 'permission_request', requestId: 'r1', toolName: 'Bash', input: {} })
    h.transport.send({ type: 'permission_response', requestId: 'r1', allowed: true })
    socket.drop(1001)
    h.timers.advance(500)
    await flush()
    const second = h.sockets.at(-1)!
    second.open()
    second.attach({ resumed: true, next: next + 1, last: next + 1 })
    expect(second.sent).toEqual([])
    second.frame(next + 1, { type: 'status', state: 'permission_pending' })
    expect(second.sent).toEqual([{ cseq: 1, type: 'permission_response', requestId: 'r1', allowed: true }])
    h.transport.dispose()
  })

  test('frames that arrive twice are applied once', async () => {
    const h = harness(undefined, undefined, undefined, { streams: true })
    const { socket, next } = await readyStream(h)
    socket.frame(next, { type: 'content_delta', text: 'once' })
    socket.frame(next, { type: 'content_delta', text: 'once' })
    expect(h.transport.state.items.at(-1)?.text).toBe('once')
    h.transport.dispose()
  })

  test('pings carry the acknowledgement so the computer can release its buffer', async () => {
    const h = harness(undefined, undefined, undefined, { streams: true })
    const { socket, next } = await readyStream(h)
    socket.frame(next, { type: 'content_delta', text: 'x' })
    h.timers.advance(15_000)
    expect(socket.sent.at(-1)).toEqual({ type: 'ping', ack: next })
    h.transport.dispose()
  })

  test('a stream the computer no longer has starts over with a new stream and a fresh sync', async () => {
    const h = harness(undefined, undefined, undefined, { streams: true })
    const { socket } = await readyStream(h)
    socket.drop(1001)
    h.timers.advance(500)
    await flush()
    const second = h.sockets.at(-1)!
    const reads = h.historyCalls()
    const verifies = h.verifies.length
    second.open()
    second.attach({ resumed: false, reason: 'expired', next: 1, last: 0 } as never)
    // The computer opened nothing for this socket and closes it with 4001: there is no stream to end.
    expect(second.sent).toEqual([])
    second.drop(4001)
    await flush()
    expect(h.historyCalls()).toBe(reads + 1)
    expect(h.verifies).toHaveLength(verifies)
    const third = h.sockets.at(-1)!
    expect(third).not.toBe(second)
    expect(streamParams(third).get('stream')).toBe('stream0000000000000002')
    expect(streamParams(third).get('epoch')).toBeNull()
    third.open()
    third.attach({ resumed: false, next: 1, last: 0 })
    third.streamSnapshots(1)
    await flush()
    expect(h.transport.connection).toBe('ready')
    h.transport.dispose()
  })

  test('a drop before the first sync finished cannot resume and starts a new stream', async () => {
    const h = harness(undefined, undefined, undefined, { streams: true })
    await flush()
    const socket = h.sockets[0]
    socket.open()
    socket.attach({ resumed: false, next: 1, last: 0 })
    socket.drop(1001)
    h.timers.advance(500)
    await flush()
    const second = h.sockets.at(-1)!
    expect(streamParams(second).get('stream')).toBe('stream0000000000000002')
    expect(streamParams(second).get('ack')).toBeNull()
    h.transport.dispose()
  })

  test('an older computer without stream support keeps working the old way', async () => {
    const h = harness(undefined, undefined, undefined, { streams: true })
    await flush()
    const socket = h.sockets[0]
    socket.open()
    socket.snapshots()
    await flush()
    expect(h.transport.connection).toBe('ready')
    expect(h.transport.send({ type: 'set_permission_mode', mode: 'plan' })).toBe(true)
    expect(socket.sent.at(-1)).toEqual({ type: 'set_permission_mode', mode: 'plan' })
    h.timers.advance(15_000)
    expect(socket.sent.at(-1)).toEqual({ type: 'ping' })
    socket.drop(1001)
    h.timers.advance(500)
    await flush()
    expect(streamParams(h.sockets.at(-1)!).get('stream')).toBeNull()
    h.transport.dispose()
  })

  test('moving to a better path resumes the same stream there without reading history', async () => {
    const h = harness(undefined, undefined, undefined, { streams: true })
    const { socket, next } = await readyStream(h)
    const reads = h.historyCalls()
    const before = h.connections.length
    h.transport.migrate()
    // Make before break: the old socket stays in use until the new path is attached.
    expect(socket.closed).toBe(false)
    const moved = h.sockets.at(-1)!
    expect(moved).not.toBe(socket)
    expect(streamParams(moved).get('ack')).toBe(String(next - 1))
    moved.open()
    moved.attach({ resumed: true, next, last: next - 1 })
    expect(socket.closed).toBe(true)
    expect(h.transport.connection).toBe('ready')
    expect(h.connections.slice(before)).toEqual([])
    expect(h.historyCalls()).toBe(reads)
    expect(h.transport.send({ type: 'stop_generation' })).toBe(true)
    expect(moved.sent.at(-1)).toEqual({ cseq: 1, type: 'stop_generation' })
    h.transport.dispose()
  })

  test('after moving paths, new commands wait until the replay on the new path is in, without leaving ready', async () => {
    const h = harness(undefined, undefined, undefined, { streams: true })
    const { socket, next } = await readyStream(h)
    socket.frame(next, { type: 'permission_request', requestId: 'r1', toolName: 'Bash', input: {} })
    // Written on the old path just before the move; the computer has not run it yet.
    expect(h.transport.send({ type: 'permission_response', requestId: 'r1', allowed: true })).toBe(true)
    const before = h.connections.length
    h.transport.migrate()
    const moved = h.sockets.at(-1)!
    moved.open()
    moved.attach({ resumed: true, next: next, last: next + 1 })
    expect(h.transport.connection).toBe('ready')
    expect(h.transport.send({ type: 'stop_generation' })).toBe(false)
    moved.frame(next, { type: 'permission_request', requestId: 'r1', toolName: 'Bash', input: {} })
    moved.frame(next + 1, { type: 'status', state: 'permission_pending' })
    expect(moved.sent).toEqual([{ cseq: 1, type: 'permission_response', requestId: 'r1', allowed: true }])
    expect(h.transport.send({ type: 'stop_generation' })).toBe(true)
    expect(moved.sent.at(-1)).toEqual({ cseq: 2, type: 'stop_generation' })
    expect(h.connections.slice(before)).toEqual([])
    // A replay that never finishes does not block commands forever.
    h.transport.migrate()
    const stalled = h.sockets.at(-1)!
    stalled.open()
    stalled.attach({ resumed: true, next: next + 2, last: next + 5 })
    expect(h.transport.send({ type: 'stop_generation' })).toBe(false)
    h.timers.advance(15_000)
    expect(h.transport.connection).toBe('reconnecting')
    h.transport.dispose()
  })

  test('a better path found while reconnecting is simply used by the next socket, without another move', async () => {
    const h = harness(undefined, undefined, undefined, { streams: true })
    const { socket, next } = await readyStream(h)
    socket.drop(1001)
    h.transport.migrate()
    h.timers.advance(500)
    await flush()
    const second = h.sockets.at(-1)!
    second.open()
    second.attach({ resumed: true, next, last: next - 1 })
    expect(h.transport.connection).toBe('ready')
    h.timers.advance(1000)
    await flush()
    expect(h.sockets).toHaveLength(2)
    h.transport.dispose()
  })

  test('resyncing on request ends the stream, starts a new one and re-reads the newest page', async () => {
    const cursors: (string | undefined)[] = []
    const tailed = (messages: HistoryEntry[], tail: string): HistoryPage => {
      const page = history(messages)
      return { ...page, page: { ...page.page!, tailCursor: tail, tailComplete: true } }
    }
    const h = harness(
      async (_id, cursor) => {
        cursors.push(cursor)
        return tailed([entry('u0', 'user', 'Start')], `tail-${cursors.length}`)
      },
      tailed([entry('u0', 'user', 'Start')], 'tail-0'),
      undefined,
      { streams: true }
    )
    const { socket } = await readyStream(h)
    cursors.length = 0
    const reads = h.historyCalls()
    h.transport.reconnect()
    expect(socket.sent.at(-1)).toEqual({ type: 'stream_end' })
    expect(socket.closed).toBe(true)
    await flush()
    expect(h.historyCalls()).toBe(reads + 1)
    expect(cursors).toEqual([undefined])
    const fresh = h.sockets.at(-1)!
    expect(fresh).not.toBe(socket)
    expect(streamParams(fresh).get('stream')).toBe('stream0000000000000002')
    expect(streamParams(fresh).get('epoch')).toBeNull()
    expect(streamParams(fresh).get('ack')).toBeNull()
    fresh.open()
    fresh.attach({ resumed: false, next: 1, last: 0 })
    fresh.streamSnapshots(1)
    await flush()
    expect(h.transport.connection).toBe('ready')
    expect(h.transport.state.items.map((item) => item.text)).toEqual(['Start'])
    h.transport.dispose()
  })

  test('a reconcile cancelled by a drop is redone once the stream resumes', async () => {
    let saved = false
    const h = harness(
      async () => (saved ? history([entry('a1', 'assistant', 'Answer')]) : history()),
      undefined,
      undefined,
      { streams: true }
    )
    const { socket, next } = await readyStream(h)
    socket.frame(next, { type: 'content_delta', text: 'Answer' })
    socket.frame(next + 1, { type: 'message_complete', usage: { input_tokens: 1, output_tokens: 1 } })
    // The app goes to the background before the scheduled reconcile runs.
    socket.drop(1001)
    saved = true
    h.timers.advance(500)
    await flush()
    const second = h.sockets.at(-1)!
    second.open()
    second.attach({ resumed: true, next: next + 2, last: next + 1 })
    expect(h.transport.connection).toBe('ready')
    const persisted = () => h.transport.state.items.map((item) => [!item.id.startsWith('live:'), item.text])
    expect(persisted()).toEqual([[false, 'Answer']])
    h.timers.advance(100)
    await flush()
    expect(persisted()).toEqual([[true, 'Answer']])
    h.transport.dispose()
  })

  test('the sync epoch counts real alignments only, not resumes or path moves', async () => {
    const h = harness(undefined, undefined, undefined, { streams: true })
    expect(h.transport.syncEpoch).toBe(0)
    const { socket, next } = await readyStream(h)
    expect(h.transport.syncEpoch).toBe(1)
    socket.drop(1001)
    h.timers.advance(500)
    await flush()
    const second = h.sockets.at(-1)!
    second.open()
    second.attach({ resumed: true, next, last: next - 1 })
    expect(h.transport.connection).toBe('ready')
    expect(h.transport.syncEpoch).toBe(1)
    h.transport.migrate()
    const moved = h.sockets.at(-1)!
    moved.open()
    moved.attach({ resumed: true, next, last: next - 1 })
    expect(h.transport.connection).toBe('ready')
    expect(h.transport.syncEpoch).toBe(1)
    h.transport.reconnect()
    await readyStream(h)
    expect(h.transport.syncEpoch).toBe(2)
    h.transport.dispose()
  })

  test('a command the computer keeps refusing is resent at most twice, then reported as unconfirmed', async () => {
    const h = harness(undefined, undefined, undefined, { streams: true })
    const { socket, next } = await readyStream(h)
    expect(h.transport.send({ type: 'user_message', content: 'Too large' })).toBe(true)
    let current = socket
    const resent: number[] = []
    for (let round = 0; round < 3; round++) {
      // The computer closes the socket on this command every time (e.g. 1009 too big).
      current.drop(1009)
      h.timers.advance(30_000)
      await flush()
      current = h.sockets.at(-1)!
      current.open()
      current.attach({ resumed: true, next, last: next - 1 })
      resent.push(current.sent.filter((message) => message.type === 'user_message').length)
    }
    expect(resent).toEqual([1, 1, 0])
    expect(h.transport.connection).toBe('ready')
    expect(h.transport.state.items.find((item) => item.type === 'user')).toMatchObject({
      pending: false,
      delivery: 'uncertain',
    })
    expect(h.transport.state.error?.code).toBe('DELIVERY_UNCONFIRMED')
    // Ask the computer whether a turn is really running instead of trusting the optimistic state.
    expect(current.sent.at(-1)).toEqual({ type: 'sync_state' })
    h.transport.dispose()
  })

  test('an older computer without streams keeps its connection when a better path appears', async () => {
    const h = harness(undefined, undefined, undefined, { streams: true })
    await flush()
    const socket = h.sockets[0]
    socket.open()
    socket.snapshots()
    await flush()
    h.transport.migrate()
    expect(socket.closed).toBe(false)
    expect(h.sockets).toHaveLength(1)
    h.transport.dispose()
  })

  test('leaving the conversation ends the stream on the computer', async () => {
    const h = harness(undefined, undefined, undefined, { streams: true })
    const { socket } = await readyStream(h)
    h.transport.dispose()
    expect(socket.sent.at(-1)).toEqual({ type: 'stream_end' })
    expect(socket.closed).toBe(true)
  })
})

describe('steering a running turn', () => {
  test('guides a queued message into the active turn and dedupes the replay', async () => {
    const h = harness()
    const socket = await h.ready()
    expect(h.transport.send({ type: 'user_message', content: 'first' })).toBe(true)
    expect(h.transport.state.turnActive).toBe(true)
    socket.receive({ type: 'user_message_replay', content: 'first' })
    expect(h.transport.steer({ type: 'user_message', content: 'go left' })).toBe(true)
    expect(socket.sent.at(-1)).toEqual({ type: 'user_message', content: 'go left' })
    expect(h.transport.state.items.map((item) => item.text)).toEqual(['first', 'go left'])
    expect(h.transport.state.items.at(-1)).toMatchObject({ type: 'user', pending: true })

    socket.receive({ type: 'user_message_replay', content: 'go left' })
    const guided = h.transport.state.items.filter((item) => item.text === 'go left')
    expect(guided).toHaveLength(1)
    expect(guided[0]).toMatchObject({ pending: false, delivery: 'confirmed' })
    expect(h.transport.state.turnActive).toBe(true)
    h.transport.dispose()
  })

  test('refuses to steer while the previous message is still unconfirmed', async () => {
    const h = harness()
    const socket = await h.ready()
    expect(h.transport.send({ type: 'user_message', content: 'first' })).toBe(true)
    expect(h.transport.steer({ type: 'user_message', content: 'too early' })).toBe(false)
    socket.receive({ type: 'user_message_replay', content: 'first' })
    expect(h.transport.steer({ type: 'user_message', content: 'go left' })).toBe(true)
    h.transport.dispose()
  })

  test('a guide replay after the turn already completed does not add a duplicate', async () => {
    const h = harness()
    const socket = await h.ready()
    expect(h.transport.send({ type: 'user_message', content: 'first' })).toBe(true)
    socket.receive({ type: 'user_message_replay', content: 'first' })
    expect(h.transport.steer({ type: 'user_message', content: 'go left' })).toBe(true)
    socket.receive({ type: 'message_complete', usage: { input_tokens: 1, output_tokens: 1 } })
    socket.receive({ type: 'user_message_replay', content: 'go left' })
    const guided = h.transport.state.items.filter((item) => item.text === 'go left')
    expect(guided).toHaveLength(1)
    expect(guided[0]).toMatchObject({ pending: false, delivery: 'confirmed' })
    h.transport.dispose()
  })

  test('refuses to steer while idle or disconnected', async () => {
    const h = harness()
    expect(h.transport.steer({ type: 'user_message', content: 'early' })).toBe(false)
    await h.ready()
    expect(h.transport.steer({ type: 'user_message', content: 'idle' })).toBe(false)
    h.transport.dispose()
  })

  test('refuses to steer while a permission decision is waiting', async () => {
    const h = harness()
    const socket = await h.ready()
    expect(h.transport.send({ type: 'user_message', content: 'first' })).toBe(true)
    socket.receive({ type: 'user_message_replay', content: 'first' })
    socket.receive({
      type: 'permission_request',
      requestId: 'r1',
      toolName: 'Bash',
      toolUseId: 't1',
      input: {},
    })
    expect(h.transport.state.permissions).toHaveLength(1)
    expect(h.transport.steer({ type: 'user_message', content: 'blocked' })).toBe(false)
    h.transport.dispose()
  })
})

describe('history cursor safety', () => {
  test('older pages prepend but cannot remove live data arriving during the request', async () => {
    const pending = deferred<HistoryPage>()
    const h = harness(async (_id, cursor) =>
      cursor
        ? pending.promise
        : history([entry('two', 'user', 'Two')], 'v1', 'older')
    )
    const socket = await h.ready()
    const loading = h.transport.loadOlder()
    socket.receive({ type: 'content_delta', text: 'Live text' })
    pending.resolve(history([entry('one', 'user', 'One')], 'v1'))
    await loading
    expect(h.transport.state.items.map((i) => i.text)).toEqual([
      'One',
      'Two',
      'Live text',
    ])
    expect(h.transport.historyPage?.page?.nextCursor).toBeNull()
    h.transport.dispose()
  })

  test('loads several older pages in one call and stops at the end', async () => {
    const older: Record<string, HistoryPage> = {
      c1: history([entry('a', 'user', 'A')], 'v1', 'c2'),
      c2: history([entry('b', 'user', 'B')], 'v1', 'c3'),
      c3: history([entry('c', 'user', 'C')], 'v1'),
    }
    const h = harness(
      async (_id, cursor) =>
        cursor ? older[cursor]! : history([entry('z', 'user', 'Z')], 'v1', 'c1')
    )
    await h.ready()
    expect(await h.transport.loadOlder(3)).toBe('loaded')
    // 每次拿到的都是更早的一页：C（最早）→ B → A → 原本的 Z。
    expect(h.transport.state.items.map((item) => item.text)).toEqual(['C', 'B', 'A', 'Z'])
    expect(h.transport.historyPage?.page?.nextCursor).toBeNull()
    expect(await h.transport.loadOlder(3)).toBe('end')
    h.transport.dispose()
  })

  test('reports busy while an older page is already loading', async () => {
    const pending = deferred<HistoryPage>()
    const h = harness(async (_id, cursor) =>
      cursor ? pending.promise : history([entry('z', 'user', 'Z')], 'v1', 'c1')
    )
    await h.ready()
    const first = h.transport.loadOlder(3)
    expect(await h.transport.loadOlder(3)).toBe('busy')
    pending.resolve(history([entry('a', 'user', 'A')], 'v1'))
    expect(await first).toBe('loaded')
    h.transport.dispose()
  })

  test('reports unavailable before history is ready', async () => {
    const h = harness()
    expect(await h.transport.loadOlder()).toBe('unavailable')
    h.transport.dispose()
  })

  test('reports end when there is no older cursor', async () => {
    const h = harness(
      async () => history([entry('z', 'user', 'Z')], 'v1'),
      history([entry('z', 'user', 'Z')], 'v1')
    )
    await h.ready()
    expect(await h.transport.loadOlder(3)).toBe('end')
    h.transport.dispose()
  })

  test('stale cursor reloads newest history instead of merging different transcript versions', async () => {
    let reads = 0
    const h = harness(async (_id, cursor) => {
      reads++
      if (cursor) throw new ApiError('Changed', 409, 'HISTORY_PAGE_STALE')
      return reads === 1
        ? history([entry('old', 'user', 'Old')], 'v1', 'older')
        : history([entry('fresh', 'user', 'Fresh')], 'v2')
    })
    await h.ready()
    await h.transport.loadOlder()
    expect(h.transport.state.items.map((i) => i.text)).toEqual(['Fresh'])
    expect(h.transport.historyPage?.page?.sourceVersion).toBe('v2')
    expect(h.errors.at(-1)).toMatchObject({ code: 'HISTORY_PAGE_STALE' })
    h.transport.dispose()
  })

  test('a rewritten transcript (HISTORY_CHANGED) also reloads instead of getting stuck', async () => {
    let reads = 0
    const h = harness(async (_id, cursor) => {
      if (cursor) throw new ApiError('Session history changed', 409, 'HISTORY_CHANGED')
      reads++
      return reads === 1
        ? history([entry('old', 'user', 'Old')], 'v1', 'older')
        : history([entry('fresh', 'user', 'Fresh')], 'v2')
    })
    await h.ready()
    expect(await h.transport.loadOlder()).toBe('loaded')
    expect(h.transport.state.items.map((i) => i.text)).toEqual(['Fresh'])
    expect(h.transport.historyPage?.page?.sourceVersion).toBe('v2')
    expect(h.errors.at(-1)).toMatchObject({ code: 'HISTORY_PAGE_STALE' })
    h.transport.dispose()
  })
})

describe('history kept across refreshes', () => {
  const texts = (transport: SessionTransport) =>
    transport.state.items.map((item) => item.text)
  const finishTurn = (socket: FakeSocket, prompt: string, answer: string) => {
    socket.receive({ type: 'user_message_replay', content: prompt })
    socket.receive({ type: 'content_delta', text: answer })
    socket.receive({
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  }
  const memoryStore = (page?: HistoryPage) => {
    const store = {
      page,
      read: () => store.page,
      write: (next: HistoryPage) => {
        store.page = next
      },
    }
    return store
  }
  const one = entry('u1', 'user', 'One')
  const first = entry('a1', 'assistant', 'First')
  const two = entry('u2', 'user', 'Two')
  const second = entry('a2', 'assistant', 'Second')
  const three = entry('u3', 'user', 'Three')
  const third = entry('a3', 'assistant', 'Third')

  test('a finished turn refreshes the newest page without dropping older pages already loaded', async () => {
    let latest = history([two, second], 'v1', 'c1')
    const h = harness(
      async (_id, cursor) =>
        cursor === 'c1' ? history([one, first], 'v1') : latest,
      latest
    )
    const socket = await h.ready()
    expect(await h.transport.loadOlder()).toBe('loaded')
    expect(h.transport.send({ type: 'user_message', content: 'Three' })).toBe(true)
    finishTurn(socket, 'Three', 'Third')
    // 电脑上重新读到的最新一页只从 Two 开始，版本和游标链都是新的。
    latest = history([two, second, three, third], 'v2', 'fresh')
    h.timers.advance(100)
    await flush()
    expect(texts(h.transport)).toEqual(['One', 'First', 'Two', 'Second', 'Three', 'Third'])
    expect(h.transport.state.items.some((item) => item.id.startsWith('live:'))).toBe(false)
    expect(h.transport.historyPage?.page?.nextCursor).toBeNull()
    h.transport.dispose()
  })

  test('a turn longer than one page is bridged back to the pages already loaded', async () => {
    const requested: (string | undefined)[] = []
    let latest = history([two, second], 'v1', 'c1')
    const older: Record<string, HistoryPage> = {
      c1: history([entry('u0', 'user', 'Zero'), one, first], 'v1', 'c0'),
      // 新链往前一页才碰到已加载的 Two。
      f1: history([two, second], 'v2', 'f0'),
    }
    const h = harness(async (_id, cursor) => {
      requested.push(cursor)
      return cursor ? older[cursor]! : latest
    }, latest)
    const socket = await h.ready()
    expect(await h.transport.loadOlder()).toBe('loaded')
    expect(h.transport.send({ type: 'user_message', content: 'Three' })).toBe(true)
    finishTurn(socket, 'Three', 'Third')
    latest = history([three, third], 'v2', 'f1')
    h.timers.advance(100)
    await flush()
    expect(texts(h.transport)).toEqual(['Zero', 'One', 'First', 'Two', 'Second', 'Three', 'Third'])
    expect(requested).not.toContain('f0')
    // 再往前翻仍沿用最早那条链，版本对得上。
    expect(h.transport.historyPage?.page?.nextCursor).toBe('c0')
    older.c0 = history([entry('u-1', 'user', 'Start')], 'v1')
    expect(await h.transport.loadOlder()).toBe('loaded')
    expect(texts(h.transport)[0]).toBe('Start')
    h.transport.dispose()
  })

  test('a turn larger than one page still reconciles when the newest page no longer holds the prompt', async () => {
    // 一张大图或大量文件读取让这一轮超过一页：最新一页只剩回复，用户那条消息在更早一页。
    let latest = history([one, first], 'v1')
    const older: Record<string, HistoryPage> = {
      p1: history([two], 'v2', 'p0'),
      p0: history([one, first], 'v2'),
    }
    const h = harness(async (_id, cursor) => (cursor ? older[cursor]! : latest), latest)
    const socket = await h.ready()
    expect(h.transport.send({ type: 'user_message', content: 'Two' })).toBe(true)
    finishTurn(socket, 'Two', 'Second')
    latest = history([second], 'v2', 'p1')
    h.timers.advance(100)
    await flush()
    expect(texts(h.transport)).toEqual(['One', 'First', 'Two', 'Second'])
    // 实时条目已经换成电脑上保存的记录，不用等下次重连才整体替换。
    expect(h.transport.state.items.some((item) => item.id.startsWith('live:'))).toBe(false)
    h.transport.dispose()
  })

  test('reopening a conversation shows cached pages at once and keeps them after syncing', async () => {
    const store = memoryStore(history([one, first, two, second], 'v1', 'c0'))
    const latest = history([two, second, three, third], 'v2', 'fresh')
    const h = harness(
      async (_id, cursor) =>
        cursor === 'c0' ? history([entry('u0', 'user', 'Zero')], 'v1') : latest,
      latest,
      store
    )
    // 还没连上电脑就先显示上次读到的内容。
    expect(texts(h.transport)).toEqual(['One', 'First', 'Two', 'Second'])
    await h.ready()
    expect(texts(h.transport)).toEqual(['One', 'First', 'Two', 'Second', 'Three', 'Third'])
    expect(await h.transport.loadOlder()).toBe('loaded')
    expect(texts(h.transport)[0]).toBe('Zero')
    expect(store.page).toBe(h.transport.historyPage!)
    h.transport.dispose()
  })

  test('a cached transcript rewritten elsewhere is replaced by the newest page', async () => {
    const requested: (string | undefined)[] = []
    const store = memoryStore(history([one, first, two, second], 'v1', 'c0'))
    const rewritten = history([two, entry('a2b', 'assistant', 'Rewritten')], 'v2', 'fresh')
    const h = harness(async (_id, cursor) => {
      requested.push(cursor)
      return rewritten
    }, rewritten, store)
    await h.ready()
    expect(texts(h.transport)).toEqual(['Two', 'Rewritten'])
    expect(h.transport.historyPage?.page?.nextCursor).toBe('fresh')
    expect(requested.filter(Boolean)).toEqual([])
    expect(store.page).toBe(rewritten)
    h.transport.dispose()
  })

  test('a stale cursor replaces the cached chain with the newest page', async () => {
    const store = memoryStore()
    let reads = 0
    const h = harness(
      async (_id, cursor) => {
        if (cursor) throw new ApiError('Session history changed', 409, 'HISTORY_CHANGED')
        return ++reads === 1
          ? history([two, second], 'v1', 'c1')
          : history([entry('fresh', 'user', 'Fresh')], 'v2')
      },
      history(),
      store
    )
    await h.ready()
    await h.transport.loadOlder()
    expect(store.page?.page?.sourceVersion).toBe('v2')
    expect(store.page?.messages.map((item) => item.id)).toEqual(['fresh'])
    h.transport.dispose()
  })
})

describe('slow links', () => {
  const one = entry('u1', 'user', 'One')
  const first = entry('a1', 'assistant', 'First')

  test('a large frame that delays the pong still counts as a live connection', async () => {
    const h = harness()
    const socket = await h.ready()
    h.timers.advance(15000)
    expect(socket.sent.at(-1)).toEqual({ type: 'ping' })
    // A multi-megabyte tool result arrives before the pong does.
    socket.receive({ type: 'tool_result', toolUseId: 't', content: [], isError: false })
    h.timers.advance(15000)
    expect(h.transport.connection).toBe('ready')
    expect(socket.closed).toBe(false)
    // Real silence is still detected.
    h.timers.advance(15000)
    expect(h.transport.connection).toBe('reconnecting')
    h.transport.dispose()
  })

  test('reconcile retries download each older page once', async () => {
    const requested: (string | undefined)[] = []
    const chain: Record<string, HistoryPage> = {
      p4: history([entry('t4', 'assistant', 'Four')], 'v2', 'p3'),
      p3: history([entry('t3', 'assistant', 'Three')], 'v2', 'p2'),
      p2: history([entry('t2', 'assistant', 'Two')], 'v2', 'p1'),
    }
    let latest = history([one, first], 'v1')
    const h = harness(async (_id, cursor) => {
      requested.push(cursor)
      return cursor ? chain[cursor]! : latest
    }, latest)
    const socket = await h.ready()
    expect(h.transport.send({ type: 'user_message', content: 'Shots' })).toBe(true)
    socket.receive({ type: 'user_message_replay', content: 'Shots' })
    socket.receive({ type: 'content_delta', text: 'Done' })
    socket.receive({ type: 'message_complete', usage: { input_tokens: 1, output_tokens: 1 } })
    // The prompt is more pages back than a refresh walks, so every attempt misses it.
    latest = history([entry('t5', 'assistant', 'Done')], 'v2', 'p4')
    for (const delay of [100, 500, 1500]) {
      h.timers.advance(delay)
      for (let i = 0; i < 6; i++) await flush()
    }
    expect(requested.filter((cursor) => cursor === undefined).length).toBeGreaterThanOrEqual(4)
    expect(requested.filter(Boolean)).toEqual(['p4', 'p3', 'p2'])
    h.transport.dispose()
  })

  test('a slow older page during sync no longer runs into the sync timeout', async () => {
    const cached = history([one, first], 'v1')
    const store = { page: cached as HistoryPage | undefined, read: () => store.page, write: (next: HistoryPage) => { store.page = next } }
    const latest = history([entry('u3', 'user', 'Three'), entry('a3', 'assistant', 'Third')], 'v2', 'slow')
    const h = harness(async (_id, cursor, options) => {
      if (!cursor) return latest
      // The page holding a large result trickles in far slower than the sync budget.
      return new Promise<HistoryPage>((_resolve, reject) =>
        options?.signal?.addEventListener('abort', () => reject(new ApiError('请求已取消', 0, 'ABORTED')), { once: true }))
    }, latest, store)
    await h.ready()
    expect(h.transport.connection).toBe('syncing')
    h.timers.advance(8000)
    for (let i = 0; i < 4; i++) await flush()
    expect(h.transport.connection).toBe('ready')
    expect(h.transport.state.items.map((item) => item.text)).toEqual(['Three', 'Third'])
    h.timers.advance(20000)
    expect(h.errors.map((error) => (error as ApiError).code)).not.toContain('SYNC_TIMEOUT')
    expect(h.transport.connection).toBe('ready')
    h.transport.dispose()
  })
})
