import { api, getBaseUrl } from './client'

export type HahaGrokOAuthStatus =
  | { loggedIn: false }
  | {
      loggedIn: true
      expiresAt: number | null
      email: string | null
    }

function currentServerPort(): number {
  const port = new URL(getBaseUrl()).port
  const parsed = Number.parseInt(port, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Cannot determine server port from baseUrl: ${getBaseUrl()}`)
  }
  return parsed
}

export const hahaGrokOAuthApi = {
  start() {
    return api.post<{ authorizeUrl: string; state: string }>(
      '/api/haha-grok-oauth/start',
      { serverPort: currentServerPort() },
    )
  },

  status() {
    return api.get<HahaGrokOAuthStatus>('/api/haha-grok-oauth')
  },

  successUrl() {
    return `${getBaseUrl()}/api/haha-grok-oauth/success`
  },

  logout() {
    return api.delete<{ ok: true }>('/api/haha-grok-oauth')
  },
}
