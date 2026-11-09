import { afterEach, describe, expect, it, vi } from 'vitest'

const apiGetMock = vi.hoisted(() => vi.fn())
const apiPutMock = vi.hoisted(() => vi.fn())

vi.mock('./client', () => ({
  api: { get: apiGetMock, put: apiPutMock },
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

  it('sends settings ownership as an encoded query, leaving the settings payload unchanged', () => {
    const settings = { futureSetting: true }
    providersApi.updateSettings(settings, 'team a/b&c')
    expect(apiPutMock).toHaveBeenCalledWith('/api/providers/settings?expectedActiveProviderId=team%20a%2Fb%26c', settings)
    expect(settings).toEqual({ futureSetting: true })
  })

  it('preserves the unconditional settings API for callers without an owner', () => {
    providersApi.updateSettings({ futureSetting: true })
    expect(apiPutMock).toHaveBeenCalledWith('/api/providers/settings', { futureSetting: true })
  })
})
