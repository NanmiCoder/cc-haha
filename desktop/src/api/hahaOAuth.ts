// desktop/src/api/hahaOAuth.ts

import { api, getBaseUrl } from './client'

export type HahaOAuthStatus =
  | { loggedIn: false }
  | {
      loggedIn: true
      expiresAt: number | null
      scopes: string[]
      subscriptionType: 'pro' | 'max' | 'team' | 'enterprise' | null
    }

/** One rolling limit as the official account reports it. */
export type ClaudePlanUsageWindow = {
  utilization: number | null // percent used, 0–100
  resets_at: string | null // ISO 8601
}

export type ClaudePlanUsage = {
  five_hour?: ClaudePlanUsageWindow | null
  seven_day?: ClaudePlanUsageWindow | null
  seven_day_oauth_apps?: ClaudePlanUsageWindow | null
  seven_day_opus?: ClaudePlanUsageWindow | null
  seven_day_sonnet?: ClaudePlanUsageWindow | null
  extra_usage?: {
    is_enabled: boolean
    monthly_limit: number | null
    used_credits: number | null
    utilization: number | null
  } | null
}

export type ClaudePlanUsageResult =
  | { available: true; fetchedAt: string; usage: ClaudePlanUsage }
  | {
      available: false
      fetchedAt: string
      reason: 'not_logged_in' | 'missing_scope' | 'request_failed'
      status?: number
    }

function currentServerPort(): number {
  const port = new URL(getBaseUrl()).port
  const parsed = Number.parseInt(port, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Cannot determine server port from baseUrl: ${getBaseUrl()}`)
  }
  return parsed
}

export const hahaOAuthApi = {
  start() {
    return api.post<{ authorizeUrl: string; state: string }>(
      '/api/haha-oauth/start',
      { serverPort: currentServerPort() },
    )
  },

  status() {
    return api.get<HahaOAuthStatus>('/api/haha-oauth')
  },

  logout() {
    return api.delete<{ ok: true }>('/api/haha-oauth')
  },

  planUsage() {
    return api.get<ClaudePlanUsageResult>('/api/haha-oauth/usage')
  },
}
