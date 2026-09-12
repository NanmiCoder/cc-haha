import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBaseUrl } from './client'
import { modelsApi } from './models'

describe('modelsApi', () => {
  afterEach(() => {
    setBaseUrl('http://127.0.0.1:3456')
    vi.restoreAllMocks()
  })

  it.each([
    [undefined, '/api/models'],
    [{ providerId: 'openai-official', refresh: true }, '/api/models?providerId=openai-official&refresh=true'],
    [{ providerId: 'provider with spaces', refresh: false }, '/api/models?providerId=provider+with+spaces'],
  ])('requests the selected catalog with optional forced refresh', async (options, endpoint) => {
    setBaseUrl('http://127.0.0.1:3456')
    const response = { models: [], provider: null }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    expect(await modelsApi.list(options)).toEqual(response)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://127.0.0.1:3456${endpoint}`)
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' })
  })
})
