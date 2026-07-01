import { afterEach, describe, expect, it, vi } from 'vitest'

import { getDefaultBaseUrl, setBaseUrl } from './client'
import { providersApi } from './providers'

describe('providersApi.fetchModels', () => {
  afterEach(() => {
    setBaseUrl(getDefaultBaseUrl())
    vi.restoreAllMocks()
  })

  // The whole point of this client method existing is that the renderer
  // CANNOT call upstream `/v1/models` directly — webview mixed-content
  // and missing CORS both kill that path. The client must POST to the
  // local server proxy and let the server make the upstream call.
  // This test locks the renderer→server contract: same-origin, JSON
  // body carrying baseUrl/apiKey/apiFormat, no leak of the upstream URL
  // into the renderer's outbound request.
  it('routes through the local server with the expected JSON body', async () => {
    setBaseUrl('http://127.0.0.1:3456')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 200,
          data: { data: [{ id: 'gpt-4o' }] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const result = await providersApi.fetchModels({
      // The user's broken case: plain HTTP relay with bare IP, which
      // the previous renderer-direct fetch path could not reach.
      baseUrl: 'http://47.116.22.0:3000',
      apiKey: 'sk-relay',
      apiFormat: 'openai_chat',
    })

    expect(result.status).toBe(200)
    expect(result.data).toEqual({ data: [{ id: 'gpt-4o' }] })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    // Critical: same-origin local server. The upstream URL must NOT be
    // the request target — it goes inside the body for the server to
    // call. Asserting same-origin guards against any future regression
    // where a refactor accidentally reintroduces the renderer-direct
    // fetch and reopens the mixed-content / CORS class of bugs.
    expect(url).toBe('http://127.0.0.1:3456/api/providers/fetch-models')
    expect(init).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        'Content-Type': 'application/json',
      }),
    })
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body).toEqual({
      baseUrl: 'http://47.116.22.0:3000',
      apiKey: 'sk-relay',
      apiFormat: 'openai_chat',
    })
  })

  it('surfaces server 502 errors so the UI can display the upstream message', async () => {
    setBaseUrl('http://127.0.0.1:3456')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'UPSTREAM_FAILED',
          message: 'Upstream returned HTTP 401: invalid_api_key',
        }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    await expect(
      providersApi.fetchModels({
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-bad',
        apiFormat: 'openai_chat',
      }),
    ).rejects.toThrow(/invalid_api_key/)
  })
})
