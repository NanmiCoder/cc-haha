import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultBaseUrl, setBaseUrl } from './client'
import { tasksApi } from './tasks'

describe('tasksApi', () => {
  afterEach(() => {
    setBaseUrl(getDefaultBaseUrl())
    vi.restoreAllMocks()
  })

  it('sends the observed revision as a conflict guard instead of a writable field', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ task: { id: 'task' } }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    await tasksApi.update('task', { enabled: false, revision: 4 })
    const request = fetchMock.mock.calls[0]?.[1]
    expect(JSON.parse(String(request?.body))).toEqual({ enabled: false, expectedRevision: 4 })
  })

  it('serializes the terminal completion floor with summary pagination', async () => {
    setBaseUrl('http://127.0.0.1:49237')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ runs: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(tasksApi.getRecentRuns(50, {
      cursor: 'next page',
      summaryOnly: true,
      completedAfterMs: 1_777_766_430_000,
    })).resolves.toEqual({ runs: [] })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:49237/api/scheduled-tasks/runs?limit=50&cursor=next+page&summaryOnly=true&completedAfterMs=1777766430000',
      expect.objectContaining({ method: 'GET' }),
    )
  })
})
