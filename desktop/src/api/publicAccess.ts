import { api, ApiError } from './client'

export type PublicAccessDevice = { id: string, name: string, createdAt: number, expiresAt: number }
export type PublicAccessServerStatus = {
  enabled: boolean
  port: number | null
  publicUrl: string | null
  pending: { id: string, name: string }[]
  devices: PublicAccessDevice[]
}

export const publicAccessApi = {
  get: () => api.get<PublicAccessServerStatus>('/api/public-access'),
  pairing: () => api.post<{ secret: string, expiresAt: number }>('/api/public-access/pairing'),
  approve: (id: string) => api.post('/api/public-access/approve', { id }),
  reject: (id: string) => api.post('/api/public-access/reject', { id }),
  revoke: (id: string) => api.post('/api/public-access/revoke', { id }),
}

// Pairing must never inherit a LAN server override or bearer token.
async function remoteRequest<T>(path: string, body?: unknown): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch(`/api/public-access/${path}`, {
      signal: controller.signal,
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) throw new ApiError(response.status, 'Remote access request failed')
    return await response.json() as T
  } finally {
    clearTimeout(timeout)
  }
}

export const remoteAccessApi = {
  session: () => remoteRequest<{ authenticated: boolean }>('session'),
  pair: (secret: string, name: string) => remoteRequest<{ id: string, claimSecret: string }>('pair', { secret, name }),
  claim: (id: string, claimSecret: string) => remoteRequest<{ status: 'pending' | 'approved' | 'rejected' }>('claim', { id, claimSecret }),
}
