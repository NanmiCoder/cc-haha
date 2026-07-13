import {
  isGrokTokenExpired,
  refreshGrokTokens,
  withRefreshedGrokAccessToken,
  type GrokTokenFetchOptions,
} from './client.js'
import {
  getGrokOAuthTokenFilePath,
  getGrokOAuthTokensAsync,
  saveGrokOAuthTokens,
} from './storage.js'
import type { GrokOAuthTokens } from './types.js'

let refreshedCache: {
  authority: string
  refreshToken: string
  tokens: GrokOAuthTokens
} | null = null

export async function ensureFreshGrokTokens(
  options: GrokTokenFetchOptions = {},
): Promise<GrokOAuthTokens | null> {
  const authority = getGrokOAuthTokenFilePath()
  if (!authority) return null
  const stored = await getGrokOAuthTokensAsync()
  if (!stored) return null

  if (
    refreshedCache?.authority === authority &&
    refreshedCache.refreshToken === stored.refreshToken &&
    !isGrokTokenExpired(refreshedCache.tokens.expiresAt)
  ) {
    return refreshedCache.tokens
  }
  if (!isGrokTokenExpired(stored.expiresAt)) return stored

  return refreshStoredGrokTokens(authority, stored, options)
}

export async function forceRefreshGrokTokens(
  options: GrokTokenFetchOptions = {},
): Promise<GrokOAuthTokens | null> {
  const authority = getGrokOAuthTokenFilePath()
  if (!authority) return null
  const stored = await getGrokOAuthTokensAsync()
  if (!stored) return null
  return refreshStoredGrokTokens(authority, stored, options)
}

async function refreshStoredGrokTokens(
  authority: string,
  stored: GrokOAuthTokens,
  options: GrokTokenFetchOptions,
): Promise<GrokOAuthTokens> {
  const response = await refreshGrokTokens(stored.refreshToken, {
    ...options,
    clientId: stored.clientId ?? options.clientId,
  })
  const tokens = withRefreshedGrokAccessToken(stored, response)
  if (!saveGrokOAuthTokens(tokens)) {
    throw new Error('Failed to persist refreshed Grok OAuth tokens')
  }
  refreshedCache = { authority, refreshToken: stored.refreshToken, tokens }
  return tokens
}

export function clearFreshGrokTokenCache(): void {
  refreshedCache = null
}
