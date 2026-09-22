import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBaseUrl } from '../../api/client'
import { clearTraceCallCache, fetchTraceCallDetail } from './callCache'
import type { TraceCallRecord } from '../../types/trace'

function makeCall(overrides: Partial<TraceCallRecord> = {}): TraceCallRecord {
  return {
    id: 'call-1',
    sessionId: 'session-1',
    source: 'anthropic',
    status: 'ok',
    startedAt: '2026-06-09T10:00:00.000Z',
    completedAt: '2026-06-09T10:00:01.000Z',
    durationMs: 1000,
    request: {
      method: 'POST',
      url: 'https://api.example/v1/messages',
      headers: {},
      body: { contentType: 'json', bytes: 10, sha256: 'a', preview: '{"x":1}', truncated: false },
    },
    response: {
      status: 200,
      headers: {},
      body: { contentType: 'json', bytes: 10, sha256: 'b', preview: '{"ok":true}', truncated: false },
    },
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    if (url.includes('/api/diagnostics/')) return new Response(null, { status: 204 })
    return handler(url)
  })
}

function traceCallRequests(fetchMock: ReturnType<typeof mockFetch>): string[] {
  return fetchMock.mock.calls
    .map(([input]) => String(input))
    .filter((url) => url.includes('/trace/calls/'))
}

describe('fetchTraceCallDetail', () => {
  beforeEach(() => {
    clearTraceCallCache()
  })

  afterEach(() => {
    setBaseUrl('http://127.0.0.1:3456')
    vi.restoreAllMocks()
  })

  it('fetches the call detail endpoint and caches terminal records', async () => {
    const call = makeCall({ status: 'ok' })
    const fetchMock = mockFetch(() => jsonResponse({ call }))

    const first = await fetchTraceCallDetail('session-1', 'call-1')
    const second = await fetchTraceCallDetail('session-1', 'call-1')

    expect(first?.id).toBe('call-1')
    expect(second).toBe(first)
    expect(traceCallRequests(fetchMock)).toEqual([
      'http://127.0.0.1:3456/api/sessions/session-1/trace/calls/call-1',
    ])
  })

  it('caches error-status records as terminal', async () => {
    const call = makeCall({ status: 'error', error: { name: 'Error', message: 'boom' } })
    const fetchMock = mockFetch(() => jsonResponse({ call }))

    await fetchTraceCallDetail('session-1', 'call-1')
    await fetchTraceCallDetail('session-1', 'call-1')

    expect(traceCallRequests(fetchMock)).toHaveLength(1)
  })

  it('does not cache pending records', async () => {
    const call = makeCall({ status: 'pending', response: undefined, completedAt: undefined })
    const fetchMock = mockFetch(() => jsonResponse({ call }))

    await fetchTraceCallDetail('session-1', 'call-1')
    await fetchTraceCallDetail('session-1', 'call-1')

    expect(traceCallRequests(fetchMock)).toHaveLength(2)
  })

  it('returns null on 404 without caching', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ error: 'call not found' }, 404))

    expect(await fetchTraceCallDetail('session-1', 'missing')).toBeNull()
    expect(await fetchTraceCallDetail('session-1', 'missing')).toBeNull()
    expect(traceCallRequests(fetchMock)).toHaveLength(2)
  })

  it('returns null on network errors', async () => {
    mockFetch(() => {
      throw new TypeError('network down')
    })

    expect(await fetchTraceCallDetail('session-1', 'call-1')).toBeNull()
  })

  it('clearTraceCallCache forces a refetch', async () => {
    const call = makeCall({ status: 'ok' })
    const fetchMock = mockFetch(() => jsonResponse({ call }))

    await fetchTraceCallDetail('session-1', 'call-1')
    clearTraceCallCache()
    await fetchTraceCallDetail('session-1', 'call-1')

    expect(traceCallRequests(fetchMock)).toHaveLength(2)
  })

  it('keeps a call cached while its content key is unchanged and refetches when that key changes', async () => {
    let version = 'old'
    const fetchMock = mockFetch(() => jsonResponse({
      call: makeCall({
        request: {
          method: 'POST',
          url: 'https://api.example/v1/messages',
          headers: {},
          body: { contentType: 'text', bytes: 3, sha256: version, preview: version, truncated: false },
        },
      }),
    }))

    const first = await fetchTraceCallDetail('session-1', 'call-1', 'epoch-a:1')
    version = 'new'
    const sameRevision = await fetchTraceCallDetail('session-1', 'call-1', 'epoch-a:1')
    const nextRevision = await fetchTraceCallDetail('session-1', 'call-1', 'epoch-a:2')

    expect(first?.request.body.preview).toBe('old')
    expect(sameRevision?.request.body.preview).toBe('old')
    expect(nextRevision?.request.body.preview).toBe('new')
    expect(traceCallRequests(fetchMock)).toHaveLength(2)
  })

  it('does not reuse terminal calls after switching to another API runtime', async () => {
    const fetchMock = mockFetch((url) => jsonResponse({
      call: makeCall({
        request: {
          method: 'POST',
          url: 'https://api.example/v1/messages',
          headers: {},
          body: {
            contentType: 'text',
            bytes: 7,
            sha256: url.includes(':4101/') ? 'runtime-a' : 'runtime-b',
            preview: url.includes(':4101/') ? 'runtime-a' : 'runtime-b',
            truncated: false,
          },
        },
      }),
    }))

    setBaseUrl('http://127.0.0.1:4101')
    const firstRuntime = await fetchTraceCallDetail('session-1', 'call-1', 'epoch:1')
    setBaseUrl('http://127.0.0.1:4102')
    const secondRuntime = await fetchTraceCallDetail('session-1', 'call-1', 'epoch:1')

    expect(firstRuntime?.request.body.preview).toBe('runtime-a')
    expect(secondRuntime?.request.body.preview).toBe('runtime-b')
    expect(traceCallRequests(fetchMock)).toEqual([
      'http://127.0.0.1:4101/api/sessions/session-1/trace/calls/call-1',
      'http://127.0.0.1:4102/api/sessions/session-1/trace/calls/call-1',
    ])
  })

  it('bounds terminal calls across runtimes and keeps a recently used entry', async () => {
    const fetchMock = mockFetch((url) => {
      const callId = decodeURIComponent(url.split('/trace/calls/')[1] ?? '')
      return jsonResponse({ call: makeCall({ id: callId }) })
    })

    setBaseUrl('http://127.0.0.1:4101')
    for (let index = 0; index < 32; index += 1) {
      await fetchTraceCallDetail('session-1', `call-${index}`, 'epoch:1')
    }

    await fetchTraceCallDetail('session-1', 'call-0', 'epoch:1')
    setBaseUrl('http://127.0.0.1:4102')
    await fetchTraceCallDetail('session-1', 'call-32', 'epoch:1')
    setBaseUrl('http://127.0.0.1:4101')
    await fetchTraceCallDetail('session-1', 'call-1', 'epoch:1')
    await fetchTraceCallDetail('session-1', 'call-0', 'epoch:1')

    expect(traceCallRequests(fetchMock)).toHaveLength(34)
  })
  it('does not retain a single oversized semantic request', async () => {
    const call = makeCall()
    call.request.semantic = { version: 1, request: { prompt: 'x'.repeat(9 * 1024 * 1024) } }
    const fetchMock = mockFetch(() => jsonResponse({ call }))
    await fetchTraceCallDetail('session-1', 'call-1')
    await fetchTraceCallDetail('session-1', 'call-1')
    expect(traceCallRequests(fetchMock)).toHaveLength(2)
  })

  it('evicts by retained bytes before the entry-count limit', async () => {
    const fetchMock = mockFetch((url) => {
      const call = makeCall({ id: url.split('/').at(-1)! })
      call.request.body.preview = 'x'.repeat(3 * 1024 * 1024)
      return jsonResponse({ call })
    })
    for (const id of ['a', 'b', 'c', 'b', 'a']) await fetchTraceCallDetail('session-1', id)
    expect(traceCallRequests(fetchMock)).toHaveLength(4)
  })

})
