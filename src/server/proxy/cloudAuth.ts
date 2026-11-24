/**
 * Cloud-vendor authentication and routing headers for:
 * - Google Vertex AI (Express Mode API key, OAuth2 Bearer token, GCP Service Account JSON, ADC)
 * - AWS Bedrock Runtime (Bedrock Bearer API key, AWS SigV4 signing via @smithy/signature-v4)
 * - Microsoft Azure OpenAI / Azure AI Foundry (`api-key` header vs Entra ID Bearer token)
 *
 * Follows the verified auth contracts from `@ai-sdk/google-vertex`,
 * `@ai-sdk/amazon-bedrock`, and `@ai-sdk/azure`.
 */

import { createHash, createHmac } from 'node:crypto'
import { SignatureV4 } from '@smithy/signature-v4'
import { GoogleAuth, type GoogleAuthOptions } from 'google-auth-library'
import type { ProviderAuthStrategy, ServiceTier } from '../types/provider.js'
import { extractBedrockRegion } from './bedrockEndpoint.js'
import { isAzureOpenaiEndpoint } from './openaiEndpoint.js'

const GCP_CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
const AWS_ACCESS_KEY_COLON_RE = /^((?:AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}):([^:]+)(?::(.+))?$/
const JWT_TOKEN_RE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const BEARER_PREFIX_RE = /^bearer\s+(.+)$/i
const VERTEX_API_KEY_PREFIX_RE = /^(?:AQ\.|AIza)/
const VERTEX_EXPRESS_BARE_HOST_RE = /^https?:\/\/aiplatform\.googleapis\.com(?:\/v\d+(?:alpha|beta\d*)?)?(?:\/publishers\/google)?\/?$/i

type VertexServiceAccountCredentials = {
  type?: string
  client_email: string
  private_key: string
  project_id?: string
  token_uri?: string
}

export type AwsSigV4Credentials = {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  region?: string
}

export type ParsedBedrockAuth =
  | { kind: 'bearer'; token: string }
  | { kind: 'sigv4'; credentials: AwsSigV4Credentials }

export type ParsedVertexAuth =
  | { kind: 'api_key'; apiKey: string }
  | { kind: 'bearer'; token: string }
  | { kind: 'service_account'; credentials: VertexServiceAccountCredentials }
  | { kind: 'adc' }

// ─── Node crypto SHA-256 adapter for @smithy/signature-v4 ─────────────────────

class NodeSha256 {
  private readonly hash: ReturnType<typeof createHash> | ReturnType<typeof createHmac>

  constructor(secret?: string | Uint8Array | ArrayBuffer | ArrayBufferView) {
    if (secret !== undefined) {
      const key = typeof secret === 'string'
        ? secret
        : secret instanceof ArrayBuffer
          ? Buffer.from(secret)
          : Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength)
      this.hash = createHmac('sha256', key)
    } else {
      this.hash = createHash('sha256')
    }
  }

  update(data: string | Uint8Array | ArrayBuffer | ArrayBufferView): void {
    if (typeof data === 'string') {
      this.hash.update(data, 'utf8')
    } else if (data instanceof ArrayBuffer) {
      this.hash.update(Buffer.from(data))
    } else {
      this.hash.update(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
    }
  }

  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.hash.digest())
  }
}

// ─── Google Vertex AI Auth & Service Tier Headers ─────────────────────────────

const googleAuthCache = new Map<string, GoogleAuth>()

function getCachedGoogleAuth(cacheKey: string, options: GoogleAuthOptions): GoogleAuth {
  let cached = googleAuthCache.get(cacheKey)
  if (!cached) {
    // Keep cache bounded when users rotate or edit credentials repeatedly.
    if (googleAuthCache.size >= 16) googleAuthCache.clear()
    cached = new GoogleAuth({
      scopes: [GCP_CLOUD_PLATFORM_SCOPE],
      ...options,
    })
    googleAuthCache.set(cacheKey, cached)
  }
  return cached
}

/** Parse a Vertex AI credential input into its concrete auth mechanism. */
export function parseVertexCredential(
  rawCredential: string,
  authStrategy: ProviderAuthStrategy = 'api_key',
  baseUrl = '',
): ParsedVertexAuth {
  const trimmed = rawCredential.trim()

  if (!trimmed || /^(?:adc|gcloud-adc|google-adc)$/i.test(trimmed)) {
    return { kind: 'adc' }
  }

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      if (
        typeof parsed.client_email === 'string' &&
        parsed.client_email.trim() &&
        typeof parsed.private_key === 'string' &&
        parsed.private_key.trim()
      ) {
        return {
          kind: 'service_account',
          credentials: {
            ...(typeof parsed.type === 'string' ? { type: parsed.type } : { type: 'service_account' }),
            client_email: parsed.client_email.trim(),
            private_key: parsed.private_key,
            ...(typeof parsed.project_id === 'string' ? { project_id: parsed.project_id } : {}),
            ...(typeof parsed.token_uri === 'string' ? { token_uri: parsed.token_uri } : {}),
          },
        }
      }
    } catch {
      // Non-JSON credentials fall through to token/API-key detection.
    }
  }

  const bearerPrefixMatch = trimmed.match(BEARER_PREFIX_RE)
  if (bearerPrefixMatch?.[1]?.trim()) {
    return { kind: 'bearer', token: bearerPrefixMatch[1].trim() }
  }

  // Express Mode API keys (`AQ.*` / `AIza*`) always use `x-goog-api-key`, even
  // when a Custom API preset defaulted to `authStrategy: 'auth_token'`.
  if (VERTEX_API_KEY_PREFIX_RE.test(trimmed)) {
    return { kind: 'api_key', apiKey: trimmed }
  }

  // OAuth2 access tokens (`ya29.*` from `gcloud auth print-access-token`) or JWTs.
  if (/^ya29\./.test(trimmed) || JWT_TOKEN_RE.test(trimmed)) {
    return { kind: 'bearer', token: trimmed }
  }

  // Vertex Express Mode endpoints (bare `https://aiplatform.googleapis.com` or
  // `.../publishers/google` without `/projects/.../locations/...`) authenticate
  // with `x-goog-api-key`. Project/location-scoped Vertex endpoints use Bearer
  // OAuth2 unless `authStrategy === 'api_key'`.
  const hasProjectLocation = /\/projects\/[^/]+\/locations\/[^/]+/i.test(baseUrl)
  const isExpressModeUrl = !hasProjectLocation && (
    /\/publishers\/google(?:\/|$)/i.test(baseUrl) ||
    VERTEX_EXPRESS_BARE_HOST_RE.test(baseUrl.trim())
  )
  if (!isExpressModeUrl && (authStrategy === 'auth_token' || authStrategy === 'auth_token_empty_api_key')) {
    return { kind: 'bearer', token: trimmed }
  }

  // Vertex Express Mode API key or custom gateway key.
  return { kind: 'api_key', apiKey: trimmed }
}

/**
 * Resolve authentication headers for a Google Vertex AI request.
 * Supports Express Mode `x-goog-api-key`, OAuth2 `Authorization: Bearer`,
 * GCP Service Account JSON keys, and GCP Application Default Credentials (ADC).
 */
export async function resolveVertexAuthHeaders(
  rawCredential: string,
  authStrategy: ProviderAuthStrategy = 'api_key',
  baseUrl = '',
  options?: {
    getAccessToken?: (parsed: Extract<ParsedVertexAuth, { kind: 'service_account' | 'adc' }>) => Promise<string>
  },
): Promise<Record<string, string>> {
  const parsed = parseVertexCredential(rawCredential, authStrategy, baseUrl)

  if (parsed.kind === 'api_key') {
    return { 'x-goog-api-key': parsed.apiKey }
  }
  if (parsed.kind === 'bearer') {
    return { Authorization: `Bearer ${parsed.token}` }
  }

  if (options?.getAccessToken) {
    const token = await options.getAccessToken(parsed)
    return { Authorization: `Bearer ${token}` }
  }

  const cacheKey = parsed.kind === 'adc'
    ? 'adc'
    : `sa:${createHash('sha256').update(parsed.credentials.client_email).update('\0').update(parsed.credentials.private_key).digest('hex')}`

  const auth = getCachedGoogleAuth(
    cacheKey,
    parsed.kind === 'service_account'
      ? { credentials: parsed.credentials }
      : {},
  )
  const client = await auth.getClient()
  const tokenResponse = await client.getAccessToken()
  const token = tokenResponse?.token?.trim()
  if (!token) {
    throw new Error('Google Vertex AI authentication failed: unable to obtain an OAuth2 access token.')
  }
  return { Authorization: `Bearer ${token}` }
}

/**
 * Map a unified `serviceTier` preference to Vertex AI's documented PayGo routing headers.
 * @see https://cloud.google.com/vertex-ai/generative-ai/docs/priority-paygo
 * @see https://cloud.google.com/vertex-ai/generative-ai/docs/flex-paygo
 */
export function buildVertexServiceTierHeaders(
  serviceTier: ServiceTier | undefined,
): Record<string, string> {
  if (serviceTier === 'flex') {
    return {
      'X-Vertex-AI-LLM-Request-Type': 'shared',
      'X-Vertex-AI-LLM-Shared-Request-Type': 'flex',
    }
  }
  if (serviceTier === 'priority') {
    return {
      'X-Vertex-AI-LLM-Request-Type': 'shared',
      'X-Vertex-AI-LLM-Shared-Request-Type': 'priority',
    }
  }
  return {}
}

// ─── AWS Bedrock Auth (Bearer API Key + SigV4) ───────────────────────────────

/**
 * Parse an AWS Bedrock credential input into either:
 * - Bearer token authentication (`Authorization: Bearer <token>`, AWS Bedrock API keys)
 * - AWS Signature Version 4 credentials (`accessKeyId`, `secretAccessKey`, optional `sessionToken` & `region`)
 */
export function parseBedrockCredential(
  rawCredential: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ParsedBedrockAuth {
  const trimmed = rawCredential.trim()

  if (!trimmed || /^(?:aws-env|env|sigv4-env)$/i.test(trimmed)) {
    const bearer = env.AWS_BEARER_TOKEN_BEDROCK?.trim()
    if (bearer) return { kind: 'bearer', token: bearer }
    const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim()
    const secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim()
    if (accessKeyId && secretAccessKey) {
      return {
        kind: 'sigv4',
        credentials: {
          accessKeyId,
          secretAccessKey,
          ...(env.AWS_SESSION_TOKEN?.trim() ? { sessionToken: env.AWS_SESSION_TOKEN.trim() } : {}),
          ...(env.AWS_REGION?.trim() ? { region: env.AWS_REGION.trim() } : {}),
        },
      }
    }
    throw new Error(
      'AWS Bedrock credentials are missing. Provide a Bedrock API Key (Bearer token), ' +
      'an AWS credential string (AKIA...:secret[:sessionToken]), JSON credentials ' +
      '({"accessKeyId","secretAccessKey","sessionToken?"}), or set AWS_BEARER_TOKEN_BEDROCK / AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY.',
    )
  }

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const accessKeyId = typeof parsed.accessKeyId === 'string' ? parsed.accessKeyId.trim() : ''
      const secretAccessKey = typeof parsed.secretAccessKey === 'string' ? parsed.secretAccessKey.trim() : ''
      if (accessKeyId && secretAccessKey) {
        return {
          kind: 'sigv4',
          credentials: {
            accessKeyId,
            secretAccessKey,
            ...(typeof parsed.sessionToken === 'string' && parsed.sessionToken.trim()
              ? { sessionToken: parsed.sessionToken.trim() }
              : {}),
            ...(typeof parsed.region === 'string' && parsed.region.trim()
              ? { region: parsed.region.trim() }
              : {}),
          },
        }
      }
    } catch {
      // Fall through to colon/bearer parsing.
    }
  }

  const colonMatch = trimmed.match(AWS_ACCESS_KEY_COLON_RE)
  if (colonMatch) {
    return {
      kind: 'sigv4',
      credentials: {
        accessKeyId: colonMatch[1]!,
        secretAccessKey: colonMatch[2]!,
        ...(colonMatch[3] ? { sessionToken: colonMatch[3] } : {}),
      },
    }
  }

  return { kind: 'bearer', token: trimmed }
}

/**
 * Produce authenticated (Bearer or AWS SigV4-signed) HTTP headers for a Bedrock request.
 */
export async function buildBedrockRequestHeaders(input: {
  url: string
  method: 'GET' | 'POST'
  body?: string
  rawCredential: string
  baseHeaders?: Record<string, string>
  service?: string
  signingDate?: Date
}): Promise<Record<string, string>> {
  const parsed = parseBedrockCredential(input.rawCredential)
  const headers: Record<string, string> = { ...(input.baseHeaders ?? {}) }

  if (parsed.kind === 'bearer') {
    headers.Authorization = `Bearer ${parsed.token}`
    return headers
  }

  const target = new URL(input.url)
  const region = extractBedrockRegion(input.url, parsed.credentials.region)
  const query: Record<string, string> = {}
  for (const [key, value] of target.searchParams.entries()) {
    query[key] = value
  }

  const signableHeaders: Record<string, string> = {
    host: target.host,
  }
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (lower === 'authorization' || lower === 'host') continue
    if (!/[\u0080-\uffff]/.test(value)) {
      signableHeaders[lower] = value
    }
  }

  const signer = new SignatureV4({
    service: input.service ?? 'bedrock',
    region,
    credentials: {
      accessKeyId: parsed.credentials.accessKeyId,
      secretAccessKey: parsed.credentials.secretAccessKey,
      ...(parsed.credentials.sessionToken ? { sessionToken: parsed.credentials.sessionToken } : {}),
    },
    sha256: NodeSha256,
  })

  const signed = await signer.sign(
    {
      method: input.method,
      protocol: target.protocol,
      hostname: target.hostname,
      ...(target.port ? { port: Number(target.port) } : {}),
      path: target.pathname,
      ...(Object.keys(query).length > 0 ? { query } : {}),
      headers: signableHeaders,
      ...(input.body !== undefined ? { body: input.body } : {}),
    },
    ...(input.signingDate ? [{ signingDate: input.signingDate }] : []),
  )

  const finalHeaders: Record<string, string> = { ...headers }
  for (const [key, value] of Object.entries(signed.headers)) {
    const lower = key.toLowerCase()
    if (lower === 'host') continue
    if (typeof value === 'string') {
      // Remove any differently-cased key (e.g. `Content-Type` vs `content-type`,
      // `Accept` vs `accept`) so Fetch does not combine them into comma-separated
      // duplicates that invalidate the AWS SigV4 canonical header hash.
      for (const existing of Object.keys(finalHeaders)) {
        if (existing.toLowerCase() === lower) delete finalHeaders[existing]
      }
      finalHeaders[key] = value
    }
  }
  return finalHeaders
}

// ─── Azure OpenAI / OpenAI Auth Headers ──────────────────────────────────────

/**
 * Resolve auth headers for OpenAI Chat, OpenAI Responses, and Azure OpenAI endpoints.
 *
 * Classic and modern Azure OpenAI / Azure AI Foundry endpoints authenticate API
 * keys via the `api-key` header, while Microsoft Entra ID (OAuth2 JWTs or
 * explicit `auth_token` strategy) uses `Authorization: Bearer`. Standard OpenAI
 * endpoints always use `Authorization: Bearer`.
 */
export function buildOpenaiAuthHeaders(input: {
  url: string
  apiKey: string
  authStrategy?: ProviderAuthStrategy
  forceAzure?: boolean
}): Record<string, string> {
  const key = input.apiKey.trim()
  if (!key) return {}

  const isAzure = input.forceAzure === true || isAzureOpenaiEndpoint(input.url)
  if (!isAzure) {
    return { Authorization: `Bearer ${key}` }
  }

  // Microsoft Entra ID tokens are JWTs (`eyJ...`) or may be prefixed with
  // `Bearer `. Standard Azure API keys must always travel in `api-key` even
  // when saved under the Custom API preset (whose hidden default `authStrategy`
  // is `'auth_token'`).
  const bearerMatch = key.match(BEARER_PREFIX_RE)
  if (bearerMatch?.[1]?.trim()) {
    return { Authorization: `Bearer ${bearerMatch[1].trim()}` }
  }
  if (JWT_TOKEN_RE.test(key)) {
    return { Authorization: `Bearer ${key}` }
  }

  return { 'api-key': key }
}
