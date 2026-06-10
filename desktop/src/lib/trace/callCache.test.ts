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
})
