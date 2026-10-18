import { afterEach, describe, expect, it, vi } from 'vitest'

const apiGetMock = vi.hoisted(() => vi.fn())

vi.mock('./client', () => ({
  api: { get: apiGetMock },
}))

import { providersApi } from './providers'

describe('providersApi.authStatus', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('asks about the global default when no provider is named', () => {
    providersApi.authStatus()
    expect(apiGetMock).toHaveBeenCalledWith('/api/providers/auth-status')
  })

  it('asks about one provider when the composer chose it', () => {
    providersApi.authStatus('claude-official')
    expect(apiGetMock).toHaveBeenCalledWith('/api/providers/auth-status?providerId=claude-official')
  })

  it('encodes a saved provider id into the query', () => {
    providersApi.authStatus('team a/b&c')
    expect(apiGetMock).toHaveBeenCalledWith('/api/providers/auth-status?providerId=team%20a%2Fb%26c')
  })
})
