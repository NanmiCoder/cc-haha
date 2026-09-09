import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBaseUrl } from './client'
import { sessionsApi } from './sessions'

describe('sessionsApi', () => {
  afterEach(() => {
    setBaseUrl('http://127.0.0.1:3456')
    vi.restoreAllMocks()
  })

  it('lists a project history page without excluding sessions older than 30 days', async () => {
    const session = {
      id: 'old-session',
      title: 'Archived work',
      createdAt: '2020-01-01T00:00:00.000Z',
      modifiedAt: '2020-01-02T00:00:00.000Z',
      messageCount: 12,
      projectPath: '/workspace/older project',
      workDir: '/workspace/older project',
      workDirExists: true,
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      sessions: [session],
      total: 51,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await sessionsApi.list({ project: session.projectPath, limit: 25, offset: 50 })

    expect(result).toEqual({ sessions: [session], total: 51 })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:3456/api/sessions?project=%2Fworkspace%2Folder+project&limit=25&offset=50')
    expect(init).toMatchObject({ method: 'GET' })
  })

  it('fetches one historical session summary without requesting its messages', async () => {
    const summary = {
      id: 'historical-session',
      title: 'Old conversation',
      runtimeProviderId: 'fixture-provider',
      runtimeModelId: 'fixture-model',
      permissionMode: 'plan',
      workspaceState: 'worktree_removed',
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(summary), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    expect(await sessionsApi.getSummary(summary.id)).toEqual(summary)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:3456/api/sessions/historical-session/summary')
  })

  it.each([
    [{ projectRoot: '/workspace/repo with spaces', limit: 50, cursor: 'opaque+/=' }, 'projectRoot=%2Fworkspace%2Frepo+with+spaces&limit=50&cursor=opaque%2B%2F%3D'],
    [{ projectRoot: '/workspace/repo', limit: 50, beforeModifiedAt: '2026-08-01T00:00:00.000Z', beforeId: 'boundary-id' }, 'projectRoot=%2Fworkspace%2Frepo&limit=50&beforeModifiedAt=2026-08-01T00%3A00%3A00.000Z&beforeId=boundary-id'],
  ])('requests logical project history with an opaque cursor or initial boundary', async (params, expectedQuery) => {
    const page = { sessions: [], nextCursor: 'next-page' }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(page), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    expect(await sessionsApi.listProjectHistory(params)).toEqual(page)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://127.0.0.1:3456/api/sessions/project-history?${expectedQuery}`)
  })

  it.each(['list', 'summary', 'project'] as const)('cancels an in-flight history %s request when the caller aborts', async (resource) => {
    const controller = new AbortController()
    let requestSignal: AbortSignal | null | undefined
    let resolveFetch!: (response: Response) => void
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementationOnce((_url, init) => {
      requestSignal = init?.signal
      return new Promise<Response>((resolve, reject) => {
        resolveFetch = resolve
        requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true })
      })
    })
    const options = { signal: controller.signal }
    const request = (resource === 'list'
      ? sessionsApi.list({ project: '/workspace/repo', limit: 25, offset: 25 }, options)
      : resource === 'summary'
        ? sessionsApi.getSummary('historical-session', options)
        : sessionsApi.listProjectHistory({ projectRoot: '/workspace/repo', limit: 50 }, options)).catch(error => error)

    try {
      expect(requestSignal?.aborted).toBe(false)
      controller.abort()

      expect(requestSignal?.aborted).toBe(true)
      await expect(request).resolves.toMatchObject({ name: 'AbortError' })
      expect(fetchMock).toHaveBeenCalledOnce()
    } finally {
      resolveFetch(new Response(JSON.stringify({ sessions: [], total: 0 })))
      await request
    }
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

  it('deduplicates concurrent Git info requests for the same session', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    let resolveFetch!: (response: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => {
      resolveFetch = resolve
    }))

    const first = sessionsApi.getGitInfo('session-1')
    const second = sessionsApi.getGitInfo('session-1')

    expect(fetchMock).toHaveBeenCalledOnce()
    resolveFetch(new Response(JSON.stringify({
      branch: 'main',
      repoName: 'repo',
      workDir: '/repo',
      changedFiles: 0,
      worktree: null,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toEqual(secondResult)

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      branch: 'main',
      repoName: 'repo',
      workDir: '/repo',
      changedFiles: 1,
      worktree: null,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    await sessionsApi.getGitInfo('session-1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
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

  it('reads pet activity without opening a websocket session', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      state: 'thinking',
      activityState: 'waiting',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await sessionsApi.getChatStatus('session-1')

    expect(result.state).toBe('thinking')
    expect(result.activityState).toBe('waiting')
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:3456/api/sessions/session-1/chat/status')
    expect(init).toMatchObject({ method: 'GET' })
  })

  it('searches the session workspace with an encoded query', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      state: 'ok',
      query: 'Mental Health Controller',
      truncated: false,
      entries: [],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await sessionsApi.searchWorkspace('session-1', 'Mental Health Controller')

    expect(result.query).toBe('Mental Health Controller')
    expect(result.truncated).toBe(false)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:3456/api/sessions/session-1/workspace/search?query=Mental+Health+Controller')
    expect(init).toMatchObject({ method: 'GET' })
  })

  it('preserves optional local index progress from session list responses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      sessions: [],
      total: 0,
      index: {
        mode: 'on',
        state: 'building',
        discovered: 12,
        indexed: 4,
        degradedSources: 0,
        databaseBytes: 4096,
        walBytes: 0,
        lastUpdatedAt: '2026-07-15T00:00:00.000Z',
        lastErrorCode: null,
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await sessionsApi.list()

    expect(result.index).toMatchObject({
      mode: 'on',
      state: 'building',
      discovered: 12,
      indexed: 4,
    })
  })
})
