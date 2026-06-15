import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  api,
  getApiUrl,
  getDefaultBaseUrl,
  rawRecordDiagnosticEvent,
  setAuthToken,
  setBaseUrl,
} from './client'

describe('api diagnostics reporting', () => {
  afterEach(() => {
    vi.useRealTimers()
    setAuthToken(null)
    setBaseUrl(getDefaultBaseUrl())
    vi.restoreAllMocks()
  })

  it('does not send Authorization for default local requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await api.get('/api/status')

    const [, init] = fetchMock.mock.calls[0]!
    expect((init as RequestInit).headers).toMatchObject({
      'Content-Type': 'application/json',
    })
    expect((init as RequestInit & { headers?: Record<string, string> }).headers?.Authorization).toBeUndefined()
  })

  it('resolves relative asset URLs against the configured API base URL', () => {
    setBaseUrl('http://127.0.0.1:49237')

    expect(getApiUrl('/api/open-targets/icons/finder')).toBe(
      'http://127.0.0.1:49237/api/open-targets/icons/finder',
    )
    expect(getApiUrl('https://example.com/icon.png')).toBe('https://example.com/icon.png')
  })

  it('adds Authorization when an H5 token is configured', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    setAuthToken('h5_x')
    await api.get('/api/status')

    const [, init] = fetchMock.mock.calls[0]!
    expect((init as RequestInit & { headers?: Record<string, string> }).headers).toMatchObject({
      Authorization: 'Bearer h5_x',
    })
  })

  it('reports non-diagnostics API failures without request bodies', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Nope' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    await expect(api.post('/api/providers/test', { apiKey: 'sk-should-not-report' })).rejects.toThrow('Nope')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const diagnosticCall = fetchMock.mock.calls[1]
    expect(diagnosticCall).toBeDefined()
    const [diagnosticUrl, diagnosticInit] = diagnosticCall!
    expect(String(diagnosticUrl)).toContain('/api/diagnostics/events')
    const body = JSON.parse(String((diagnosticInit as RequestInit).body))
    expect(body.type).toBe('client_api_request_failed')
    expect(body.details.path).toBe('/api/providers/test')
    expect(JSON.stringify(body)).not.toContain('sk-should-not-report')
  })

  it('does not leak the H5 token in diagnostics payloads', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    setAuthToken('h5_super_secret')

    await expect(api.get('/api/status')).rejects.toThrow('Unauthorized')

    const [, diagnosticInit] = fetchMock.mock.calls[1]!
    const body = JSON.parse(String((diagnosticInit as RequestInit).body))
    expect(JSON.stringify(body)).not.toContain('h5_super_secret')
  })

  it('does not recursively report diagnostics endpoint failures', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: 'diagnostics down' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(api.get('/api/diagnostics/status')).rejects.toThrow('diagnostics down')

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('defaults local API requests to a 120 second timeout', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockImplementation((url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/api/slow')) {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })
        })
      }

      return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    })

    const request = expect(api.get('/api/slow')).rejects.toThrow('Request timed out after 120s')

    await vi.advanceTimersByTimeAsync(120_000)
    await request

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [, diagnosticInit] = fetchMock.mock.calls[1]!
    const body = JSON.parse(String((diagnosticInit as RequestInit).body))
    expect(body.type).toBe('client_api_request_failed')
    expect(body.details.message).toBe('Request timed out after 120s')
  })

  it('can report raw client exceptions', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await rawRecordDiagnosticEvent({
      type: 'client_window_error',
      severity: 'error',
      summary: 'boom',
      details: { filename: 'App.tsx' },
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = fetchMock.mock.calls[0]
    expect(call).toBeDefined()
    const [, init] = call!
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.type).toBe('client_window_error')
  })
})
