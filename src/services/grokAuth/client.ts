import { randomBytes } from 'crypto'
import { generateCodeChallenge } from '../oauth/crypto.js'
import type {
  GrokJwtClaims,
  GrokOAuthTokenResponse,
  GrokOAuthTokens,
} from './types.js'

export const GROK_OAUTH_ISSUER = 'https://auth.x.ai'
export const GROK_OAUTH_AUTHORIZE_ENDPOINT =
  `${GROK_OAUTH_ISSUER}/oauth2/authorize`
export const GROK_OAUTH_TOKEN_ENDPOINT = `${GROK_OAUTH_ISSUER}/oauth2/token`
export const GROK_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
export const GROK_OAUTH_SCOPE =
  'openid profile email offline_access grok-cli:access api:access conversations:read conversations:write'
export const GROK_OAUTH_REDIRECT_PATH = '/callback'

const DEFAULT_TOKEN_LIFETIME_SECONDS = 6 * 60 * 60
const TOKEN_EXPIRY_SKEW_MS = 5 * 60_000
const TOKEN_ERROR_BODY_LIMIT = 500

export type GrokTokenFetchOptions = {
  fetchOverride?: typeof fetch
  proxyUrl?: string | null
  timeoutMs?: number
  clientId?: string
}

export function generateGrokState(): string {
  return randomBytes(32).toString('hex')
}

export function generateGrokNonce(): string {
  return randomBytes(16).toString('hex')
}

export function generateGrokCodeVerifier(): string {
  return randomBytes(32).toString('base64url')
}

export function buildGrokAuthorizeUrl(input: {
  redirectUri: string
  codeVerifier: string
  state: string
  nonce: string
  clientId?: string
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId?.trim() || GROK_OAUTH_CLIENT_ID,
    redirect_uri: input.redirectUri,
    scope: GROK_OAUTH_SCOPE,
    state: input.state,
    nonce: input.nonce,
    code_challenge: generateCodeChallenge(input.codeVerifier),
    code_challenge_method: 'S256',
  })
  return `${GROK_OAUTH_AUTHORIZE_ENDPOINT}?${params.toString()}`
}

export async function exchangeGrokCodeForTokens(input: {
  code: string
  redirectUri: string
  codeVerifier: string
} & GrokTokenFetchOptions): Promise<GrokOAuthTokenResponse> {
  return requestGrokTokens(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: input.clientId?.trim() || GROK_OAUTH_CLIENT_ID,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    }),
    'exchange',
    input,
  )
}

export async function refreshGrokTokens(
  refreshToken: string,
  options: GrokTokenFetchOptions = {},
): Promise<GrokOAuthTokenResponse> {
  return requestGrokTokens(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: options.clientId?.trim() || GROK_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }),
    'refresh',
    options,
  )
}

async function requestGrokTokens(
  body: URLSearchParams,
  operation: 'exchange' | 'refresh',
  options: GrokTokenFetchOptions,
): Promise<GrokOAuthTokenResponse> {
  const fetchOverride = options.fetchOverride ?? globalThis.fetch
  const proxyOptions = options.proxyUrl
    ? getGrokProxyFetchOptions(options.proxyUrl)
    : {}
  const response = await fetchOverride(GROK_OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'cc-haha-grok-oauth/1.0',
    },
    body: body.toString(),
    ...(options.timeoutMs
      ? { signal: AbortSignal.timeout(options.timeoutMs) }
      : {}),
    ...(await proxyOptions),
  })
  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    const sanitized = sanitizeTokenError(raw)
    throw new Error(
      `Grok token ${operation} failed: ${response.status}${sanitized ? `: ${sanitized}` : ''}`,
    )
  }
  return (await response.json()) as GrokOAuthTokenResponse
}

async function getGrokProxyFetchOptions(
  proxyUrl: string,
): Promise<RequestInit> {
  const { getProxyFetchOptions } = await import('../../utils/proxy.js')
  return getProxyFetchOptions({ proxyUrl })
}

function sanitizeTokenError(body: string): string {
  return body
    .replace(
      /"((?:access_token|refresh_token|id_token|code|code_verifier))"\s*:\s*"[^"]*"/gi,
      '"$1":"[redacted]"',
    )
    .replace(
      /\b(access_token|refresh_token|id_token|code|code_verifier)=([^&\s]+)/gi,
      '$1=[redacted]',
    )
    .slice(0, TOKEN_ERROR_BODY_LIMIT)
}

function parseJwtClaims(token?: string): GrokJwtClaims | undefined {
  if (!token) return undefined
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString())
  } catch {
    return undefined
  }
}

export function normalizeGrokTokens(
  response: GrokOAuthTokenResponse,
): GrokOAuthTokens {
  if (!response.access_token) {
    throw new Error('Grok OAuth response did not include an access token')
  }
  if (!response.refresh_token) {
    throw new Error('Grok OAuth response did not include a refresh token')
  }
  const claims =
    parseJwtClaims(response.id_token) ?? parseJwtClaims(response.access_token)
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt:
      Date.now() +
      (response.expires_in ?? DEFAULT_TOKEN_LIFETIME_SECONDS) * 1000,
    ...(response.id_token && { idToken: response.id_token }),
    ...(claims?.email && { email: claims.email }),
    clientId: GROK_OAUTH_CLIENT_ID,
    ...(response.scope && { scope: response.scope }),
    tokenType: response.token_type || 'Bearer',
  }
}

export function withRefreshedGrokAccessToken(
  existing: GrokOAuthTokens,
  response: GrokOAuthTokenResponse,
): GrokOAuthTokens {
  const claims =
    parseJwtClaims(response.id_token) ?? parseJwtClaims(response.access_token)
  return {
    ...existing,
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? existing.refreshToken,
    expiresAt:
      Date.now() +
      (response.expires_in ?? DEFAULT_TOKEN_LIFETIME_SECONDS) * 1000,
    idToken: response.id_token ?? existing.idToken,
    email: claims?.email ?? existing.email,
    clientId: existing.clientId ?? GROK_OAUTH_CLIENT_ID,
    scope: response.scope ?? existing.scope,
    tokenType: response.token_type ?? existing.tokenType ?? 'Bearer',
  }
}

export function isGrokTokenExpired(expiresAt: number): boolean {
  return expiresAt - Date.now() <= TOKEN_EXPIRY_SKEW_MS
}
