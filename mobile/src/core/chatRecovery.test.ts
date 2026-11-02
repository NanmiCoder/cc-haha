import { afterEach, describe, expect, test } from 'bun:test'
import { ApiClient, type FetchAdapter } from './client'
import { ChatRecovery } from './chatRecovery'
import {
  SessionTransport,
  type SocketLike,
  type TransportTimers,
} from './sessionTransport'
import type { Session } from './types'

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
    for (;;) {
      const next = [...this.jobs]
        .filter(([, job]) => job.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      this.now = next[1].at
      this.jobs.delete(next[0])
      next[1].callback()
    }
    this.now = end
  }
}

class FakeSocket implements SocketLike {
  readyState = 0
  failSend = false
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null
  send() {
    if (this.failSend) throw new Error('Socket closed during send')
  }
  close() {
    this.readyState = 3
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  snapshots() {
    for (const event of [
      { type: 'connected', sessionId: 'session' },
      {
        type: 'permission_requests_snapshot',
        toolRequestIds: [],
        computerUseRequestIds: [],
        turnActive: false,
      },
      { type: 'session_state', turnState: 'idle', activeBackgroundTaskIds: [] },
    ])
      this.onmessage?.({ data: JSON.stringify(event) })
  }
}

const summary: Session = {
  id: 'session',
  title: 'Recovered session',
  createdAt: '2026-01-01T00:00:00Z',
  modifiedAt: '2026-01-01T00:00:00Z',
  messageCount: 0,
  projectPath: '/fixture/project',
  workDir: '/fixture/project',
  workDirExists: true,
}
const history = {
  messages: [],
  page: {
    sourceVersion: 'v1',
    nextCursor: null,
    hasMore: false,
    historyComplete: true,
    scannedBytes: 0,
    omittedOversizedEntries: 0,
  },
}
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status })
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve()
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

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function harness(fetch: FetchAdapter) {
  const client = new ApiClient(
    { id: 'host', name: 'Fixture', url: 'http://192.168.1.2:3456', auth: 'lan' },
    'fake-token',
    { fetch }
  )
  const timers = new FakeTimers()
  const sockets: FakeSocket[] = []
  const feedback = {
    connectionError: '',
    businessError: '',
    summaries: [] as Session[],
  }
  const recovery = new ChatRecovery({
    loadSummary: (signal) =>
      client.get<Session>('/api/sessions/session/summary', { signal }),
    onSummary: (value) => feedback.summaries.push(value),
    onConnectionError: (value) => {
      feedback.connectionError = value
    },
    onBusinessError: (value) => {
      feedback.businessError = value.message
    },
  })
  const channel = new SessionTransport({
    client,
    credential: 'fake-token',
    sessionId: 'session',
    platform: 'native',
    timers,
    socketFactory: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    onState: () => {},
    onConnection: (value) => recovery.onConnection(value),
    onError: (value) => recovery.onTransportError(value),
  })
  const dispose = () => {
    recovery.dispose()
    channel.dispose()
  }
  cleanups.push(dispose)
  recovery.start()
  channel.start()
  return {
    channel,
    timers,
    sockets,
    feedback,
    dispose,
    ready: async () => {
      await flush()
      const socket = sockets.at(-1)!
      expect(socket).toBeDefined()
      socket.open()
      socket.snapshots()
      await flush()
      expect(channel.connection).toBe('ready')
      return socket
    },
  }
}

describe('chat connection recovery with production transport callbacks', () => {
  test('offline summary/history failures clear only after synchronized reconnect and successful summary retry', async () => {
    let offline = true
    let summaries = 0
    const h = harness(async (url) => {
      if (url.endsWith('/summary')) summaries++
      if (offline) throw new TypeError('Fixture offline')
      return response(url.endsWith('/summary') ? summary : history)
    })
    await flush()
    expect(h.channel.connection).toBe('reconnecting')
    expect(h.feedback.connectionError).toBe('无法连接服务器，请检查地址与网络')
    expect(h.feedback.businessError).toBe('')
    offline = false
    h.timers.advance(500)
    await flush()
    const socket = h.sockets.at(-1)!
    socket.open()
    await flush()
    expect(h.channel.connection).toBe('syncing')
    expect(h.feedback.connectionError).not.toBe('')
    socket.snapshots()
    await flush()
    expect(h.channel.connection).toBe('ready')
    expect(h.feedback.connectionError).toBe('')
    expect(h.feedback.summaries).toEqual([summary])
    expect(summaries).toBe(2)
  })

  test('ready replaces an in-flight initial summary; its late rejection cannot restore the network banner', async () => {
    const initial = deferred<Response>()
    let firstSignal: AbortSignal | undefined
    let summaries = 0
    const h = harness(async (url, init) => {
      if (!url.endsWith('/summary')) return response(history)
      if (++summaries === 1) {
        firstSignal = init.signal
        return initial.promise
      }
      return response(summary)
    })
    await h.ready()
    expect(firstSignal?.aborted).toBe(true)
    expect(h.feedback.summaries).toEqual([summary])
    initial.reject(new TypeError('Delayed offline failure'))
    await flush()
    expect(h.feedback.connectionError).toBe('')
    expect(h.feedback.businessError).toBe('')
  })

  test('ready alone does not hide a failing summary; a later successful reconnect retries it', async () => {
    let unavailable = true
    const h = harness(async (url) =>
      url.endsWith('/summary')
        ? unavailable
          ? response({ message: '摘要暂不可用' }, 503)
          : response(summary)
        : response(history)
    )
    await h.ready()
    expect(h.feedback.summaries).toHaveLength(0)
    expect(h.feedback.connectionError).toBe('摘要暂不可用')
    unavailable = false
    h.channel.reconnect()
    await h.ready()
    expect(h.feedback.connectionError).toBe('')
    expect(h.feedback.summaries).toEqual([summary])
  })

  test('configuration timeout remains actionable after reconnect instead of being cleared with transport feedback', async () => {
    const h = harness(async (url) =>
      response(url.endsWith('/summary') ? summary : history)
    )
    await h.ready()
    expect(
      h.channel.send({
        type: 'set_runtime_config',
        providerId: null,
        modelId: 'fake-model',
      })
    ).toBe(true)
    h.timers.advance(10000)
    expect(h.channel.state.configPending).toBe(false)
    expect(h.feedback.businessError).toBe('电脑尚未确认配置，请重新选择后重试')
    h.channel.reconnect()
    await h.ready()
    expect(h.feedback.businessError).toBe('电脑尚未确认配置，请重新选择后重试')
    expect(h.channel.state.error?.code).toBe('CONFIG_TIMEOUT')
  })

  test('a failed user send stays visible after reconnect and is not automatically retried', async () => {
    const h = harness(async (url) =>
      response(url.endsWith('/summary') ? summary : history)
    )
    const socket = await h.ready()
    socket.failSend = true
    expect(
      h.channel.send({ type: 'user_message', content: 'Do not silently resend' })
    ).toBe(false)
    expect(h.feedback.businessError).toBe('发送失败，消息没有自动重试')
    h.timers.advance(500)
    await h.ready()
    expect(h.feedback.businessError).toBe('发送失败，消息没有自动重试')
    expect(h.channel.state.items).toEqual([])
  })

  test('leaving the chat cancels pending summary work and ignores its late result', async () => {
    const initial = deferred<Response>()
    let signal: AbortSignal | undefined
    const h = harness(async (url, init) => {
      if (!url.endsWith('/summary')) return response(history)
      signal = init.signal
      return initial.promise
    })
    await flush()
    h.dispose()
    expect(signal?.aborted).toBe(true)
    initial.resolve(response(summary))
    await flush()
    expect(h.feedback.summaries).toEqual([])
    expect(h.feedback.connectionError).toBe('')
  })
})
