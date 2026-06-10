import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBaseUrl } from './client'
import { sessionsApi } from './sessions'

describe('sessionsApi', () => {
  afterEach(() => {
    setBaseUrl('http://127.0.0.1:3456')
    vi.restoreAllMocks()
  })

  it('posts branch requests to the session branch endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      sessionId: 'branch-session',
      title: 'Branch',
      workDir: '/workspace/repo',
      sourceSessionId: 'source-session',
      targetMessageId: 'message-1',
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }))

    setBaseUrl('http://127.0.0.1:49237')
    const result = await sessionsApi.branch('source-session', {
      targetMessageId: 'message-1',
      title: 'Branch',
    })

    expect(result.sessionId).toBe('branch-session')
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:49237/api/sessions/source-session/branch')
    expect(init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({
        targetMessageId: 'message-1',
        title: 'Branch',
      }),
    })
  })

  it('fetches a single trace call from the call detail endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      call: { id: 'call-1', sessionId: 'session-1' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await sessionsApi.getTraceCall('session-1', 'call-1')

    expect(result.call.id).toBe('call-1')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:3456/api/sessions/session-1/trace/calls/call-1')
    expect(init).toMatchObject({ method: 'GET' })
  })
})
