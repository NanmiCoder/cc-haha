import { describe, expect, test } from 'bun:test'
import { ApiError, type ApiClient } from './client'
import {
  SessionTransport,
  type ConnectionState,
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
  readyState = 0
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null
  sent: ClientMessage[] = []
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
  baseline = history()
) {
  const timers = new FakeTimers()
  const sockets: FakeSocket[] = []
  const connections: ConnectionState[] = []
  const errors: Error[] = []
  let firstRead = true
  const client = {
    host: {
      id: 'a',
      name: 'A',
      url: 'http://192.168.1.1:3456',
      auth: 'lan' as const,
    },
    history: ((...args) => {
      if (firstRead) {
        firstRead = false
        return Promise.resolve(baseline)
      }
      return load(...args)
    }) as ApiClient['history'],
  }
  const transport = new SessionTransport({
    client,
    credential: 'fake-token',
    sessionId: 'session',
    platform: 'native',
    timers,
    socketFactory: (options) => {
      expect(options.headers?.Authorization).toBe('Bearer fake-token')
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    onState: () => {},
    onConnection: (state) => connections.push(state),
    onError: (error) => errors.push(error),
  })
  transport.start()
  return {
    transport,
    sockets,
    timers,
    connections,
    errors,
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

  test('HTTP 401 and WS 1008 require re-pairing and cancel all reconnect attempts', async () => {
    const unauthorized = harness(async () => {
      throw new ApiError('Unauthorized', 401)
    })
    await flush()
    unauthorized.sockets[0].open()
    await flush()
    expect(unauthorized.transport.connection).toBe('pairing_required')
    unauthorized.timers.advance(60000)
    expect(unauthorized.sockets).toHaveLength(1)
    const revoked = harness()
    const socket = await revoked.ready()
    socket.drop(1008)
    revoked.transport.reconnect()
    revoked.timers.advance(60000)
    expect(revoked.transport.connection).toBe('pairing_required')
    expect(revoked.sockets).toHaveLength(1)
    unauthorized.transport.dispose()
    revoked.transport.dispose()
  })

  test('1006 handshake failure probes HTTP to expose otherwise hidden 401', async () => {
    const h = harness(async () => {
      throw new ApiError('Unauthorized', 401)
    })
    await flush()
    h.sockets[0].drop(1006)
    await flush()
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
})
