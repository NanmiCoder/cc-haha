import { randomBytes } from 'crypto'
import { generateCodeChallenge } from '../oauth/crypto.js'
import type {
  OpenAIJwtClaims,
  OpenAIOAuthTokenResponse,
  OpenAIOAuthTokens,
} from './types.js'
import { getProxyFetchOptions } from '../../utils/proxy.js'

export const OPENAI_AUTH_ISSUER = 'https://auth.openai.com'
export const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const OPENAI_CODEX_API_ENDPOINT =
  'https://chatgpt.com/backend-api/codex/responses'
export const OPENAI_CODEX_OAUTH_PORT = 1455
export const OPENAI_CODEX_REDIRECT_PATH = '/auth/callback'
export const OPENAI_CODEX_TOKEN_USER_AGENT = 'codex-cli/0.91.0'

const DEFAULT_TOKEN_LIFETIME_MS = 3600 * 1000
const OPENAI_TOKEN_ERROR_BODY_LIMIT = 500

const OPENAI_TOKEN_REQUEST_HEADERS = {
  Accept: 'application/json',
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': OPENAI_CODEX_TOKEN_USER_AGENT,
} as const

export type OpenAITokenFetchOptions = {
  proxyUrl?: string | null
  timeoutMs?: number
}

function buildOpenAITokenFetchInit(
  init: RequestInit,
  options: OpenAITokenFetchOptions = {},
): RequestInit {
  return {
    ...init,
    ...(options.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
    ...getProxyFetchOptions({ proxyUrl: options.proxyUrl }),
  }
}

export function generateOpenAIState(): string {
  return randomBytes(32).toString('hex')
}

export function generateOpenAICodeVerifier(): string {
  return randomBytes(64).toString('hex')
}

export function buildOpenAIAuthorizeUrl(input: {
  redirectUri: string
  codeVerifier: string
  state: string
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: OPENAI_CODEX_CLIENT_ID,
    redirect_uri: input.redirectUri,
    scope: 'openid profile email offline_access',
    code_challenge: generateCodeChallenge(input.codeVerifier),
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state: input.state,
  })

  return `${OPENAI_AUTH_ISSUER}/oauth/authorize?${params.toString()}`
}

export async function exchangeOpenAICodeForTokens(input: {
  code: string
  redirectUri: string
  codeVerifier: string
  proxyUrl?: string | null
  timeoutMs?: number
}): Promise<OpenAIOAuthTokenResponse> {
  const response = await fetch(
    `${OPENAI_AUTH_ISSUER}/oauth/token`,
    buildOpenAITokenFetchInit(
      {
        method: 'POST',
        headers: OPENAI_TOKEN_REQUEST_HEADERS,
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: input.code,
          redirect_uri: input.redirectUri,
          client_id: OPENAI_CODEX_CLIENT_ID,
          code_verifier: input.codeVerifier,
        }).toString(),
      },
      input,
    ),
  )

  if (!response.ok) {
    throw await buildOpenAITokenHttpError('exchange', response)
  }

  return (await response.json()) as OpenAIOAuthTokenResponse
}

export async function refreshOpenAITokens(
  refreshToken: string,
  options: OpenAITokenFetchOptions = {},
): Promise<OpenAIOAuthTokenResponse> {
  const response = await fetch(
    `${OPENAI_AUTH_ISSUER}/oauth/token`,
    buildOpenAITokenFetchInit(
      {
        method: 'POST',
        headers: OPENAI_TOKEN_REQUEST_HEADERS,
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: OPENAI_CODEX_CLIENT_ID,
          scope: 'openid profile email',
        }).toString(),
      },
      options,
    ),
  )

  if (!response.ok) {
    throw await buildOpenAITokenHttpError('refresh', response)
  }

  return (await response.json()) as OpenAIOAuthTokenResponse
}

async function buildOpenAITokenHttpError(
  operation: 'exchange' | 'refresh',
  response: Response,
): Promise<Error> {
  const body = await response.text().catch(() => '')
  const sanitizedBody = sanitizeOpenAITokenErrorBody(body)
  const bodySuffix = sanitizedBody ? `: ${sanitizedBody}` : ''
  return new Error(
    `OpenAI token ${operation} failed: ${response.status}${bodySuffix}`,
  )
}

function sanitizeOpenAITokenErrorBody(body: string): string {
  return body
    .replace(
      /"((?:access_token|refresh_token|id_token|code|code_verifier))"\s*:\s*"[^"]*"/gi,
      '"$1":"[redacted]"',
    )
    .replace(
      /\b(access_token|refresh_token|id_token|code|code_verifier)=([^&\s]+)/gi,
      '$1=[redacted]',
    )
    .slice(0, OPENAI_TOKEN_ERROR_BODY_LIMIT)
}

export function parseOpenAIJwtClaims(
  token?: string,
): OpenAIJwtClaims | undefined {
  if (!token) return undefined
  const parts = token.split('.')
  if (parts.length !== 3) return undefined

  try {
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString())
  } catch {
    return undefined
  }
}

export function extractOpenAIAccountId(
  claims?: OpenAIJwtClaims,
): string | undefined {
  if (!claims) return undefined

  return (
    claims.chatgpt_account_id ||
    claims['https://api.openai.com/auth']?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  )
}

export function normalizeOpenAITokens(
  response: OpenAIOAuthTokenResponse,
): OpenAIOAuthTokens {
  const claims =
    parseOpenAIJwtClaims(response.id_token) ??
    parseOpenAIJwtClaims(response.access_token)

  if (!response.refresh_token) {
    throw new Error('OpenAI OAuth response did not include a refresh token')
  }

  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: Date.now() + (response.expires_in ?? 3600) * 1000,
    idToken: response.id_token,
    accountId: extractOpenAIAccountId(claims),
    email: claims?.email,
    clientId: OPENAI_CODEX_CLIENT_ID,
  }
}

export function isOpenAITokenExpired(expiresAt: number): boolean {
  return expiresAt - Date.now() <= 5 * 60 * 1000
}

export function withRefreshedAccessToken(
  existing: OpenAIOAuthTokens,
  refreshed: OpenAIOAuthTokenResponse,
): OpenAIOAuthTokens {
  const claims =
    parseOpenAIJwtClaims(refreshed.id_token) ??
    parseOpenAIJwtClaims(refreshed.access_token)

  return {
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? existing.refreshToken,
    expiresAt: Date.now() + (refreshed.expires_in ?? 3600) * 1000,
    idToken: refreshed.id_token ?? existing.idToken,
    accountId: extractOpenAIAccountId(claims) ?? existing.accountId,
    email: claims?.email ?? existing.email,
    clientId: existing.clientId ?? OPENAI_CODEX_CLIENT_ID,
  }
}
