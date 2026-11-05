import { coordinateOAuthRefresh, oauthFileAuthority } from '../oauth/refresh-coordinator.js'
import {
  isGrokTokenExpired,
  refreshGrokTokens,
  withRefreshedGrokAccessToken,
  type GrokTokenFetchOptions,
} from './client.js'
import {
  getGrokOAuthTokenFilePath,
  getGrokOAuthTokens,
  getGrokOAuthTokensAsync,
  saveGrokOAuthTokens,
} from './storage.js'
import type { GrokOAuthTokens } from './types.js'

let refreshedCache: {
  sourceKey: string
  tokens: GrokOAuthTokens
} | null = null

export async function ensureFreshGrokTokens(
  options: GrokTokenFetchOptions = {},
): Promise<GrokOAuthTokens | null> {
  const authority = getGrokOAuthTokenFilePath()
  if (!authority) return null
  const stored = await getGrokOAuthTokensAsync()
  if (getGrokOAuthTokenFilePath() !== authority) throw new Error('Grok credential store changed during refresh; retry the request')
  if (!stored) return null

  if (
    refreshedCache?.sourceKey === JSON.stringify([authority, stored]) &&
    !isGrokTokenExpired(refreshedCache.tokens.expiresAt)
  ) {
    return refreshedCache.tokens
  }
  if (!isGrokTokenExpired(stored.expiresAt)) return stored

  return refreshStoredGrokTokens(authority, stored, options)
}

export async function forceRefreshGrokTokens(
  options: GrokTokenFetchOptions = {},
  rejectedAccessToken?: string,
): Promise<GrokOAuthTokens | null> {
  const authority = getGrokOAuthTokenFilePath()
  if (!authority) return null
  const stored = await getGrokOAuthTokensAsync()
  if (getGrokOAuthTokenFilePath() !== authority) throw new Error('Grok credential store changed during refresh; retry the request')
  if (!stored) return null
  // A late 401 for the previous access token must not rotate the new token again.
  if (rejectedAccessToken !== undefined && stored.accessToken !== rejectedAccessToken && !isGrokTokenExpired(stored.expiresAt)) return stored
  return refreshStoredGrokTokens(authority, stored, options)
}

async function refreshStoredGrokTokens(
  authority: string,
  stored: GrokOAuthTokens,
  options: GrokTokenFetchOptions,
): Promise<GrokOAuthTokens> {
  const key = JSON.stringify([authority, stored])
  const latest = getGrokOAuthTokens()
  if (JSON.stringify(latest) !== JSON.stringify(stored)) {
    if (latest && !isGrokTokenExpired(latest.expiresAt)) return latest
    throw new Error('Grok credentials changed during refresh; retry the request')
  }
  await coordinateOAuthRefresh('grok', oauthFileAuthority(authority), stored, async (assertOwnership) => {
    if (getGrokOAuthTokenFilePath() !== authority) throw new Error('Grok credential store changed during refresh; retry the request')
    const current = getGrokOAuthTokens()
    if (JSON.stringify(current) !== JSON.stringify(stored)) {
      if (current && !isGrokTokenExpired(current.expiresAt)) return
      throw new Error("Grok credentials changed during refresh; retry the request")
    }
    const response = await refreshGrokTokens(stored.refreshToken, {
      ...options,
      clientId: stored.clientId ?? options.clientId,
    })
    if (getGrokOAuthTokenFilePath() !== authority || JSON.stringify(getGrokOAuthTokens()) !== JSON.stringify(stored)) {
      throw new Error('Grok credentials changed during refresh; retry the request')
    }
    const tokens = withRefreshedGrokAccessToken(stored, response)
    assertOwnership()
    if (!saveGrokOAuthTokens(tokens)) throw new Error('Failed to persist refreshed Grok OAuth tokens')
    refreshedCache = { sourceKey: key, tokens }
  })
  if (getGrokOAuthTokenFilePath() !== authority) throw new Error('Grok credential store changed during refresh; retry the request')
  const updated = getGrokOAuthTokens()
  if (!updated) throw new Error("Grok credentials changed during refresh; retry the request")
  return updated
}

export function clearFreshGrokTokenCache(): void {
  refreshedCache = null
}
