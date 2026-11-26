/**
 * Provider model catalog — discover the model list a provider publishes on its
 * Base URL, so the UI can offer a picker instead of a free-text model field.
 *
 * Derived from cc-switch (https://github.com/farion1231/cc-switch),
 * `src-tauri/src/services/model_fetch.rs`.
 * Original work by Jason Young, MIT License
 * (full text in src/server/proxy/LICENSE-cc-switch.md).
 */

import {
  getNetworkProxyFetchOptions,
  loadNetworkSettings,
  resolveProviderNetworkSettings,
} from './networkSettings.js'
import { buildBedrockModelsEndpoints } from '../proxy/bedrockEndpoint.js'
import {
  buildBedrockRequestHeaders,
  buildOpenaiAuthHeaders,
  resolveVertexAuthHeaders,
} from '../proxy/cloudAuth.js'
import { isVertexEndpointUrl, normalizeGeminiModelName } from '../proxy/geminiEndpoint.js'
import { DEFAULT_AZURE_OPENAI_API_VERSION, isAzureOpenaiEndpoint } from '../proxy/openaiEndpoint.js'
import type { ApiFormat, ProviderProxyConfig } from '../types/provider.js'

export type FetchedModel = {
  id: string
  ownedBy?: string
}

export type FetchProviderModelsErrorCode =
  | 'missing-config'
  | 'auth-failed'
  | 'endpoint-not-found'
  | 'timeout'
  | 'not-supported'
  | 'network'
  | 'unknown'

export type FetchProviderModelsResult =
  | { ok: true; models: FetchedModel[]; endpoint: string }
  | {
      ok: false
      errorCode: FetchProviderModelsErrorCode
      message: string
      httpStatus?: number
      endpointsTried: string[]
    }

export type FetchProviderModelsInput = {
  baseUrl: string
  apiKey: string
  apiFormat?: ApiFormat
  isFullUrl?: boolean
  modelsUrl?: string
  /** The provider's own proxy override, so the probe reaches it the way chat will. */
  proxy?: ProviderProxyConfig
}

// cc-switch's FETCH_TIMEOUT_SECS. Deliberately not networkSettings'
// aiRequestTimeoutMs: that knob is the "wait for the first token" budget for a
// real completion (default 600s, floor 30s), while this probe walks several
// candidate URLs in sequence and a slow one must not hold the UI hostage.
const FETCH_TIMEOUT_MS = 15_000

// cc-switch's ERROR_BODY_MAX_CHARS. Gateways love answering with a full HTML
// error page; only the head of it is worth carrying back to the client.
const ERROR_BODY_MAX_CHARS = 512

// Vendor "compat" mount points: the Anthropic/Claude-shaped endpoint lives on a
// sub-path while the OpenAI-shaped model catalog stays at the API root. Ordered
// longest-first so `/api/anthropic` is never shadowed by `/anthropic`.
const COMPAT_SUFFIXES = [
  '/api/claudecode',
  '/api/anthropic',
  '/apps/anthropic',
  '/api/coding',
  '/claudecode',
  '/anthropic',
  '/step_plan',
  '/coding',
  '/claude',
] as const

const VERSION_SEGMENT_RE = /^v\d+(?:alpha|beta\d*)?$/i

// Shapes seen in the wild for the same catalog: OpenAI's `data`, plus the
// `models`/`items`/bare-array variants, Bedrock model summaries and Vertex publisher models.
const MODEL_ARRAY_KEYS = ['data', 'models', 'items', 'modelSummaries', 'publisherModels'] as const
const MODEL_ID_KEYS = ['id', 'modelId', 'slug', 'model', 'name'] as const
const MODEL_OWNER_KEYS = ['owned_by', 'ownedBy', 'providerName', 'provider', 'vendor', 'owner'] as const

// Structural auth markers only — never match on human-readable text, which is
// localized and would misfire across providers.
const AUTH_ERROR_HINT_RE = /auth|unauthor|invalid_api_key/i
const UPSTREAM_MESSAGE_KEYS = ['msg', 'message'] as const

/**
 * Build the ordered list of `/models` URLs to probe for a given Base URL.
 * Exported separately so the derivation rules stay unit-testable without I/O.
 *
 * @throws when no endpoint can be derived (empty Base URL, or a full URL that
 *   carries no usable root).
 */
/**
 * Only http(s) may be fetched.
 *
 * `fetch` in this runtime also honours `file:`, so an unvalidated endpoint
 * would turn this route into an arbitrary local-file reader — the response
 * body is echoed back in `message`, and a JSON file would even parse as a
 * model list. Enforced for the override *and* for the derived Base URL, since
 * both end up in `fetch()`.
 */
function assertHttpUrl(candidate: string): string {
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error(`Not a valid URL: ${candidate}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme: ${parsed.protocol}`)
  }
  return candidate
}

export function buildModelsUrlCandidates(
  baseUrl: string,
  options?: { isFullUrl?: boolean; modelsUrl?: string; apiFormat?: ApiFormat },
): string[] {
  // An explicit override wins outright — no guessing on top of it.
  const override = options?.modelsUrl?.trim()
  if (override) return [assertHttpUrl(override)]

  const trimmed = stripTrailingSlashes(baseUrl.trim())
  if (!trimmed) {
    throw new Error('Base URL is required to derive the models endpoint')
  }

  const candidates: string[] = []
  const isGemini = options?.apiFormat === 'gemini' || options?.apiFormat === 'google_vertex'
  if (isGemini) {
    const url = new URL(trimmed)
    if (isVertexEndpointUrl(url.origin)) {
      // Model Garden lists across projects at the publisher's top-level resource.
      const publisher = url.pathname.match(/\/publishers\/([^/]+)/i)?.[1] ?? 'google'
      candidates.push(`${url.origin}/v1beta1/publishers/${publisher}/models`)
    }
  }

  // Full inference URLs can also expose a catalog at the API root.
  if (options?.isFullUrl) {
    return dedupe([...candidates, deriveModelsUrlFromFullUrl(trimmed)]).map(assertHttpUrl)
  }

  const lastSegment = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  const isVertex = options?.apiFormat === 'google_vertex' || (isGemini && isVertexEndpointUrl(trimmed))
  const isBedrock = options?.apiFormat === 'bedrock_converse'
  const isAzure = options?.apiFormat === 'azure_openai' || isAzureOpenaiEndpoint(trimmed)

  if (isBedrock) {
    candidates.push(...buildBedrockModelsEndpoints(trimmed))
  } else if (isAzure) {
    candidates.push(...buildAzureModelsUrlCandidates(trimmed))
  } else if (isGemini && /\/models$/i.test(trimmed)) {
    candidates.push(trimmed)
  } else if (isVertex && /\/publishers\/[^/]+$/i.test(trimmed)) {
    candidates.push(`${trimmed}/models`)
  } else if (isVertex && /\/projects\/[^/]+\/locations\/[^/]+$/i.test(trimmed)) {
    candidates.push(`${trimmed}/publishers/google/models`)
  } else if (isVertex && VERSION_SEGMENT_RE.test(lastSegment)) {
    candidates.push(`${trimmed}/publishers/google/models`)
    candidates.push(`${trimmed}/models`)
  } else if (isVertex) {
    candidates.push(`${trimmed}/v1/publishers/google/models`)
    candidates.push(`${trimmed}/v1/models`)
  } else if (VERSION_SEGMENT_RE.test(lastSegment)) {
    // Already versioned (…/v1, …/v1beta, or Zhipu's …/api/coding/paas/v4).
    candidates.push(`${trimmed}/models`)
    // A non-v1 API root may still mirror the catalog under the OpenAI-style
    // /v1 prefix, so keep that as a fallback unless it is a Gemini endpoint.
    if (!isGemini && !trimmed.endsWith('/v1')) {
      candidates.push(`${trimmed}/v1/models`)
    }
  } else if (isGemini) {
    candidates.push(`${trimmed}/v1beta/models`)
    candidates.push(`${trimmed}/v1/models`)
  } else {
    candidates.push(`${trimmed}/v1/models`)
  }

  for (const suffix of COMPAT_SUFFIXES) {
    if (!trimmed.endsWith(suffix)) continue
    const root = trimmed.slice(0, trimmed.length - suffix.length)
    if (hasHostAfterScheme(root)) {
      candidates.push(`${root}/v1/models`)
      candidates.push(`${root}/models`)
    }
    // Only the longest matching suffix is stripped; shorter ones are tails of
    // the same mount point and would produce nonsense roots.
    break
  }

  // Validate everything that will actually reach fetch(), not just the input.
  return dedupe(candidates).map(assertHttpUrl)
}

/**
 * Fetch a provider's model list. Upstream failures are reported as
 * `{ ok: false }` results — this never throws for them.
 */
export async function fetchProviderModels(
  input: FetchProviderModelsInput,
): Promise<FetchProviderModelsResult> {
  const baseUrl = input.baseUrl?.trim() ?? ''
  const apiKey = input.apiKey?.trim() ?? ''

  const allowsAmbientCloudCredential =
    input.apiFormat === 'google_vertex' || input.apiFormat === 'bedrock_converse'
  if (!baseUrl || (!apiKey && !allowsAmbientCloudCredential)) {
    return {
      ok: false,
      errorCode: 'missing-config',
      message: allowsAmbientCloudCredential
        ? 'Base URL is required to fetch models'
        : 'Base URL and API key are both required to fetch models',
      endpointsTried: [],
    }
  }

  let candidates: string[]
  try {
    candidates = buildModelsUrlCandidates(baseUrl, {
      isFullUrl: input.isFullUrl,
      modelsUrl: input.modelsUrl,
      apiFormat: input.apiFormat,
    })
  } catch (err) {
    // Undeducible endpoint is a configuration problem, not a network one.
    return {
      ok: false,
      errorCode: 'missing-config',
      message: errorMessage(err),
      endpointsTried: [],
    }
  }

  const networkSettings = resolveProviderNetworkSettings(await loadNetworkSettings(), input.proxy)
  const endpointsTried: string[] = []
  let lastStatus: number | undefined
  let lastFailure = ''

  for (const endpoint of candidates) {
    endpointsTried.push(endpoint)

    let requestHeaders: Record<string, string>
    try {
      requestHeaders = await buildModelsRequestHeaders(endpoint, apiKey, input.apiFormat)
    } catch (err) {
      return {
        ok: false,
        errorCode: 'auth-failed',
        message: redactApiKey(errorMessage(err), apiKey),
        endpointsTried,
      }
    }

    let response: Response
    try {
      const proxyOptions = getNetworkProxyFetchOptions(networkSettings, endpoint)
      response = await fetch(endpoint, {
        method: 'GET',
        headers: requestHeaders,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        ...proxyOptions,
      })
    } catch (err) {
      // Transport failures abort the whole probe: DNS/TLS/proxy problems hit
      // every candidate on the same host, so retrying siblings only stalls.
      return transportFailure(err, apiKey, endpointsTried)
    }

    // The candidate simply does not host a catalog — try the next shape.
    if (response.status === 404 || response.status === 405) {
      lastStatus = response.status
      lastFailure = describeHttpFailure(
        response.status,
        formatErrorBody(await readBodyTextSafe(response), apiKey),
      )
      continue
    }

    if (!response.ok) {
      const body = formatErrorBody(await readBodyTextSafe(response), apiKey)
      const isAuthFailure = response.status === 401 || response.status === 403
      return {
        ok: false,
        errorCode: isAuthFailure ? 'auth-failed' : 'unknown',
        message: describeHttpFailure(response.status, body),
        httpStatus: response.status,
        endpointsTried,
      }
    }

    let bodyText: string
    try {
      bodyText = await response.text()
    } catch (err) {
      return transportFailure(err, apiKey, endpointsTried)
    }

    let payload: unknown
    try {
      payload = JSON.parse(bodyText)
    } catch {
      return {
        ok: false,
        errorCode: 'not-supported',
        message: `Endpoint did not return JSON: ${formatErrorBody(bodyText, apiKey)}`,
        httpStatus: response.status,
        endpointsTried,
      }
    }

    const rawList = findModelArray(payload)
    if (!rawList) {
      // A 2xx carrying no model array at all is an error envelope, not an empty
      // catalog: open.bigmodel.cn answers 200 + {"code":1000,"msg":"…","success":false}
      // for a rejected key. Reporting "no models" there would hide the cause.
      const { errorCode, upstreamMessage } = classifyNonListPayload(payload)
      return {
        ok: false,
        errorCode,
        message: upstreamMessage
          ? formatErrorBody(upstreamMessage, apiKey)
          : `Endpoint returned an unrecognized model list: ${formatErrorBody(bodyText, apiKey)}`,
        httpStatus: response.status,
        endpointsTried,
      }
    }

    return { ok: true, models: toFetchedModels(rawList, input.apiFormat), endpoint }
  }

  return {
    ok: false,
    errorCode: 'endpoint-not-found',
    message: `No model list endpoint found. ${lastFailure}`.trim(),
    httpStatus: lastStatus,
    endpointsTried,
  }
}

// ─── Internals ────────────────────────────────────────────────────────────────

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '')
}

/** `true` when the URL has a scheme separator with a host behind it. */
function hasHostAfterScheme(value: string): boolean {
  const schemeEnd = value.indexOf('://')
  return schemeEnd >= 0 && value.length > schemeEnd + 3
}

function deriveModelsUrlFromFullUrl(trimmed: string): string {
  // Preferred: everything before the API version prefix is the root.
  const versionIndex = trimmed.indexOf('/v1/')
  if (versionIndex >= 0) {
    return `${trimmed.slice(0, versionIndex)}/v1/models`
  }

  // Fallback: drop the last path segment (…/chat/completions → …/chat).
  const lastSlash = trimmed.lastIndexOf('/')
  if (lastSlash >= 0) {
    const root = trimmed.slice(0, lastSlash)
    if (hasHostAfterScheme(root)) {
      return `${root}/v1/models`
    }
  }

  throw new Error(`Cannot derive models endpoint from full URL: ${trimmed}`)
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

/**
 * Locate the model array inside a 2xx payload. Returns `null` when the payload
 * carries no model array at all — an explicitly present `[]` is an empty
 * catalog, everything else is an error envelope wearing a 200.
 */
function findModelArray(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== 'object') return null

  const record = payload as Record<string, unknown>
  for (const key of MODEL_ARRAY_KEYS) {
    const value = record[key]
    if (Array.isArray(value)) return value
  }
  return null
}

/** Map a model array leniently: entries may be plain strings or objects. */
function toFetchedModels(entries: unknown[], apiFormat?: ApiFormat): FetchedModel[] {
  const models: FetchedModel[] = []
  const seen = new Set<string>()
  const isGemini = apiFormat === 'gemini' || apiFormat === 'google_vertex'

  for (const entry of entries) {
    if (isGemini && !supportsGeminiGenerateContent(entry)) continue
    const rawId = readModelId(entry)
    const id = rawId && isGemini ? normalizeGeminiModelName(rawId) : rawId
    if (!id || seen.has(id)) continue
    seen.add(id)
    const ownedBy = readModelOwner(entry)
    models.push(ownedBy ? { id, ownedBy } : { id })
  }

  // cc-switch only dedupes on its OAuth path, but duplicate ids are never
  // useful in a picker. Codepoint order keeps the result stable regardless of
  // the host's locale data.
  models.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return models
}

function buildAzureModelsUrlCandidates(trimmed: string): string[] {
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return [`${trimmed}/v1/models`]
  }
  const pathname = parsed.pathname.replace(/\/+$/, '')
  const apiVersion = parsed.searchParams.get('api-version')
  const candidates: string[] = []

  // Strip `/deployments/<name>...` back to the `/openai` prefix so `/models` is discoverable.
  const deploymentIdx = pathname.toLowerCase().indexOf('/openai/deployments/')
  if (deploymentIdx >= 0) {
    const openaiRoot = pathname.slice(0, deploymentIdx + '/openai'.length)
    const classic = new URL(parsed.origin)
    classic.pathname = `${openaiRoot}/models`
    classic.searchParams.set('api-version', apiVersion || DEFAULT_AZURE_OPENAI_API_VERSION)
    candidates.push(classic.toString())

    const modern = new URL(parsed.origin)
    modern.pathname = `${openaiRoot}/v1/models`
    candidates.push(modern.toString())
    return candidates
  }

  if (/\/openai\/v1$/i.test(pathname)) {
    const modern = new URL(parsed.toString())
    modern.pathname = `${pathname}/models`
    candidates.push(modern.toString())
    return candidates
  }

  const openaiRoot = /\/openai$/i.test(pathname)
    ? pathname
    : pathname === ''
      ? '/openai'
      : `${pathname}/openai`

  const modern = new URL(parsed.origin)
  modern.pathname = `${openaiRoot}/v1/models`
  candidates.push(modern.toString())

  const classic = new URL(parsed.origin)
  classic.pathname = `${openaiRoot}/models`
  classic.searchParams.set('api-version', apiVersion || DEFAULT_AZURE_OPENAI_API_VERSION)
  candidates.push(classic.toString())
  return candidates
}

async function buildModelsRequestHeaders(
  endpoint: string,
  apiKey: string,
  apiFormat?: ApiFormat,
): Promise<Record<string, string>> {
  if (apiFormat === 'google_vertex' || (apiFormat === 'gemini' && isVertexEndpointUrl(endpoint))) {
    const authHeaders = await resolveVertexAuthHeaders(apiKey, 'api_key', endpoint)
    return {
      ...authHeaders,
      Accept: 'application/json',
    }
  }
  if (apiFormat === 'gemini') {
    return {
      ...(apiKey ? { 'x-goog-api-key': apiKey } : {}),
      Accept: 'application/json',
    }
  }
  if (apiFormat === 'bedrock_converse') {
    return buildBedrockRequestHeaders({
      url: endpoint,
      method: 'GET',
      rawCredential: apiKey,
      baseHeaders: { Accept: 'application/json' },
    })
  }
  if (apiFormat === 'azure_openai' || isAzureOpenaiEndpoint(endpoint)) {
    return {
      ...buildOpenaiAuthHeaders({
        url: endpoint,
        apiKey,
        forceAzure: apiFormat === 'azure_openai',
      }),
      Accept: 'application/json',
    }
  }
  return {
    // cc-switch sends a bearer token to every OpenAI/Anthropic provider.
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
  }
}

function supportsGeminiGenerateContent(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true
  const methods = (entry as Record<string, unknown>).supportedGenerationMethods
  if (!Array.isArray(methods)) return true
  return methods.some(method => method === 'generateContent' || method === 'streamGenerateContent')
}

function readModelId(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry.trim() || undefined
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  const record = entry as Record<string, unknown>
  return firstNonEmptyString(MODEL_ID_KEYS.map(key => record[key]))
}

function readModelOwner(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  const record = entry as Record<string, unknown>
  return firstNonEmptyString(MODEL_OWNER_KEYS.map(key => record[key]))
}

/**
 * Classify a 2xx payload that holds no model array, using structural fields
 * only. The upstream's own message is surfaced verbatim so a localized
 * explanation ("身份验证失败。") reaches the user instead of a generic string.
 */
function classifyNonListPayload(payload: unknown): {
  errorCode: 'auth-failed' | 'not-supported'
  upstreamMessage: string
} {
  const record = toRecord(payload)
  const error = toRecord(record.error)

  const authLike =
    isHttpAuthStatus(record.code) ||
    isHttpAuthStatus(record.status) ||
    isHttpAuthStatus(error.code) ||
    isHttpAuthStatus(error.status) ||
    hasAuthHint(record.type) ||
    hasAuthHint(record.code) ||
    hasAuthHint(error.type) ||
    hasAuthHint(error.code)

  const upstreamMessage = firstNonEmptyString([
    ...UPSTREAM_MESSAGE_KEYS.map(key => record[key]),
    ...UPSTREAM_MESSAGE_KEYS.map(key => error[key]),
  ])

  return {
    errorCode: authLike ? 'auth-failed' : 'not-supported',
    upstreamMessage: upstreamMessage ?? '',
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** HTTP-style status carried inside the body (number or numeric string). */
function isHttpAuthStatus(value: unknown): boolean {
  if (typeof value === 'number') return value === 401 || value === 403
  return value === '401' || value === '403'
}

function hasAuthHint(value: unknown): boolean {
  return typeof value === 'string' && AUTH_ERROR_HINT_RE.test(value)
}

function firstNonEmptyString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

async function readBodyTextSafe(response: Response): Promise<string> {
  return await response.text().catch(() => '')
}

/** Redact, then truncate — a key straddling the cut must not survive halved. */
function formatErrorBody(body: string, apiKey: string): string {
  const redacted = redactApiKey(body, apiKey)
  return redacted.length > ERROR_BODY_MAX_CHARS
    ? `${redacted.slice(0, ERROR_BODY_MAX_CHARS)}…`
    : redacted
}

/**
 * Upstreams occasionally echo the credential back inside their error body; it
 * must not travel further than the request that carried it. Short keys are left
 * alone so the redaction cannot mangle unrelated text.
 */
function redactApiKey(text: string, apiKey: string): string {
  if (apiKey.length < 8 || !text.includes(apiKey)) return text
  return text.split(apiKey).join('***')
}

function describeHttpFailure(status: number, body: string): string {
  return body ? `HTTP ${status}: ${body}` : `HTTP ${status}`
}

function transportFailure(
  err: unknown,
  apiKey: string,
  endpointsTried: string[],
): FetchProviderModelsResult {
  if (isTimeoutError(err)) {
    return {
      ok: false,
      errorCode: 'timeout',
      message: `Request timed out (${Math.round(FETCH_TIMEOUT_MS / 1000)}s)`,
      endpointsTried,
    }
  }
  return {
    ok: false,
    errorCode: 'network',
    message: redactApiKey(errorMessage(err), apiKey),
    endpointsTried,
  }
}

/**
 * AbortSignal.timeout rejects with a DOMException named TimeoutError (same
 * detection as ProviderService.testConnectivity); the plain-Error arm covers
 * runtimes that surface it without the DOM wrapper.
 */
function isTimeoutError(err: unknown): boolean {
  return (err instanceof DOMException || err instanceof Error) && err.name === 'TimeoutError'
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
