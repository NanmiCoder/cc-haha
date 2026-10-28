import { afterEach, describe, expect, it, vi } from 'vitest'

const apiGetMock = vi.hoisted(() => vi.fn())

vi.mock('./client', () => ({
  api: { get: apiGetMock },
}))

import { modelsApi } from './models'

describe('modelsApi.catalog', () => {
  afterEach(() => vi.clearAllMocks())

  it('loads a provider catalog without forcing a network refresh', () => {
    modelsApi.catalog('openai-official')
    expect(apiGetMock).toHaveBeenCalledWith('/api/models/catalog?provider=openai-official')
  })

  it('explicitly refreshes the requested provider and encodes its identity', () => {
    modelsApi.catalog('team a/b&c', { forceRefresh: true })
    expect(apiGetMock).toHaveBeenCalledWith('/api/models/catalog?provider=team%20a%2Fb%26c&refresh=true')
  })

  it('does not change the ordinary request when forceRefresh is false', () => {
    modelsApi.catalog('grok-official', { forceRefresh: false })
    expect(apiGetMock).toHaveBeenCalledWith('/api/models/catalog?provider=grok-official')
  })
})
