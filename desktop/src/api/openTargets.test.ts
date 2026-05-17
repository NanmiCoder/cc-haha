import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultBaseUrl, setBaseUrl } from './client'
import { openTargetsApi } from './openTargets'

describe('openTargetsApi', () => {
  afterEach(() => {
    setBaseUrl(getDefaultBaseUrl())
    vi.restoreAllMocks()
  })

  it('normalizes relative icon URLs to the configured desktop server URL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      platform: 'darwin',
      targets: [
        {
          id: 'vscode',
          kind: 'ide',
          label: 'VS Code',
          icon: 'vscode',
          iconUrl: '/api/open-targets/icons/vscode',
          platform: 'darwin',
        },
      ],
      primaryTargetId: 'vscode',
      cachedAt: 1,
      ttlMs: 30_000,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    setBaseUrl('http://127.0.0.1:49237')

    await expect(openTargetsApi.list()).resolves.toMatchObject({
      targets: [
        {
          id: 'vscode',
          iconUrl: 'http://127.0.0.1:49237/api/open-targets/icons/vscode',
        },
      ],
    })
  })
})
