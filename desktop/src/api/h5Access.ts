import { api } from './client'
import type { H5AccessSettings } from '../types/settings'

export type { H5AccessSettings } from '../types/settings'

export type H5AccessStatus = {
  settings: H5AccessSettings
}

export type H5AccessTokenResult = {
  settings: H5AccessSettings
  token: string
}

export const h5AccessApi = {
  get() {
    return api.get<H5AccessStatus>('/api/h5-access')
  },

  enable() {
    return api.post<H5AccessTokenResult>('/api/h5-access/enable')
  },

  disable() {
    return api.post<H5AccessStatus>('/api/h5-access/disable')
  },

  regenerate() {
    return api.post<H5AccessTokenResult>('/api/h5-access/regenerate')
  },

  update(input: {
    allowedOrigins?: string[]
    publicBaseUrl?: string | null
  }) {
    return api.put<H5AccessStatus>('/api/h5-access', input)
  },
}
