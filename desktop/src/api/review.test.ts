import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultBaseUrl, setBaseUrl } from './client'
import { reviewApi } from './review'

const BASE = 'http://127.0.0.1:49241'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockFetch(body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(body))
}

function requestedUrl(fetchMock: ReturnType<typeof mockFetch>): string {
  return String(fetchMock.mock.calls[0]?.[0])
}

function requestedInit(fetchMock: ReturnType<typeof mockFetch>): RequestInit {
  return (fetchMock.mock.calls[0]?.[1] ?? {}) as RequestInit
}

describe('reviewApi', () => {
  afterEach(() => {
    setBaseUrl(getDefaultBaseUrl())
    vi.restoreAllMocks()
  })

  it('names the comparison explicitly on every status request', async () => {
    setBaseUrl(BASE)

    const unstaged = mockFetch({ state: 'ok', files: [] })
    await reviewApi.getStatus('session-1', { kind: 'unstaged' })
    expect(requestedUrl(unstaged)).toBe(`${BASE}/api/sessions/session-1/review?source=unstaged`)
    vi.restoreAllMocks()

    const branch = mockFetch({ state: 'ok', files: [] })
    await reviewApi.getStatus('session-1', { kind: 'branch', baseRef: 'release/1.x' })
    expect(requestedUrl(branch)).toBe(
      `${BASE}/api/sessions/session-1/review?source=branch&baseRef=release%2F1.x`,
    )
    vi.restoreAllMocks()

    const commit = mockFetch({ state: 'ok', files: [] })
    await reviewApi.getStatus('session-1', { kind: 'commit', commit: 'abc123' })
    expect(requestedUrl(commit)).toBe(
      `${BASE}/api/sessions/session-1/review?source=commit&commit=abc123`,
    )
  })

  it('carries the file path and its rename origin on a diff request', async () => {
    setBaseUrl(BASE)
    const fetchMock = mockFetch({ state: 'ok', path: 'src/new name.ts' })

    await reviewApi.getDiff('session-1', { kind: 'staged' }, 'src/new name.ts', 'src/old.ts')

    expect(requestedUrl(fetchMock)).toBe(
      `${BASE}/api/sessions/session-1/review/diff?source=staged&path=src%2Fnew+name.ts&oldPath=src%2Fold.ts`,
    )
  })

  it('posts the snapshot token with every write so the server can reject stale edits', async () => {
    setBaseUrl(BASE)
    const fetchMock = mockFetch({ state: 'ok', snapshot: 'v2', results: [] })

    await reviewApi.stage('session-1', {
      paths: ['a.ts', 'b.ts'],
      snapshot: 'v1',
      source: { kind: 'unstaged' },
    })

    expect(requestedUrl(fetchMock)).toBe(`${BASE}/api/sessions/session-1/review/stage`)
    const init = requestedInit(fetchMock)
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      paths: ['a.ts', 'b.ts'],
      snapshot: 'v1',
      source: { kind: 'unstaged' },
    })
  })

  it('routes each write to its own endpoint', async () => {
    setBaseUrl(BASE)

    const cases: Array<[string, () => Promise<unknown>]> = [
      ['unstage', () => reviewApi.unstage('s', { paths: ['a'], snapshot: 'v1' })],
      ['revert', () => reviewApi.revert('s', { paths: ['a'], snapshot: 'v1' })],
      ['stage-hunk', () => reviewApi.stageHunk('s', { patch: 'p', snapshot: 'v1' })],
      ['unstage-hunk', () => reviewApi.unstageHunk('s', { patch: 'p', snapshot: 'v1' })],
    ]

    for (const [endpoint, run] of cases) {
      const fetchMock = mockFetch({ state: 'ok', snapshot: 'v2', results: [] })
      await run()
      expect(requestedUrl(fetchMock)).toBe(`${BASE}/api/sessions/s/review/${endpoint}`)
      vi.restoreAllMocks()
    }
  })
})
