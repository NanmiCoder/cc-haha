// A base whose last segment is already a Gemini API version (/v1beta, /v1alpha,
// /v1, /v1beta1) or a Vertex AI publisher path (/publishers/google) serves
// `/models/...` directly under it. Bare gateway roots (e.g.
// https://generativelanguage.googleapis.com or http://127.0.0.1:3425) get the
// standard /v1beta prefix (or /v1/publishers/google on Vertex Express Mode).
const GEMINI_VERSIONED_BASE_RE = /\/v\d+(?:alpha|beta\d*)?$/i
const VERTEX_PUBLISHER_BASE_RE = /\/publishers\/[^/]+$/i
const VERTEX_ANTHROPIC_PUBLISHER_RE = /\/publishers\/anthropic(?:\/models(?:\/.*)?)?$/i
const VERTEX_GOOGLE_PUBLISHER_RE = /\/publishers\/google(?:\/models(?:\/.*)?)?$/i
const VERTEX_LOCATION_BASE_RE = /\/projects\/[^/]+\/locations\/[^/]+$/i
const GEMINI_MODELS_SUFFIX_RE = /\/models$/i
const GEMINI_MODEL_ACTION_RE = /\/models\/.+:(?:generateContent|streamGenerateContent)$/i
const VERTEX_ANTHROPIC_ACTION_RE = /\/models\/.+:(?:rawPredict|streamRawPredict)$/i
const VERTEX_HOST_RE = /^(?:[a-z0-9-]+-)?aiplatform(?:\.[a-z0-9-]+)*\.googleapis\.com$/i

/** Convert Gemini and Vertex publisher resource names to inference model IDs. */
export function normalizeGeminiModelName(modelId: string): string {
  return modelId.trim().replace(/^(?:publishers\/[^/]+\/)?models\//i, '')
}

/**
 * True when a URL targets Google Cloud Vertex AI (standard regional/global/REP
 * host, Express Mode `aiplatform.googleapis.com`, or `/projects/.../locations/...`
 * / `/publishers/...` resource path).
 */
export function isVertexEndpointUrl(baseUrl: string): boolean {
  const trimmed = baseUrl.trim()
  if (!trimmed) return false
  if (/\/projects\/[^/]+\/locations\/[^/]+/i.test(trimmed) || /\/publishers\/[^/]+/i.test(trimmed)) {
    return true
  }
  try {
    const { hostname } = new URL(trimmed)
    return VERTEX_HOST_RE.test(hostname)
  } catch {
    return false
  }
}

function extractUrlPath(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  try {
    return new URL(trimmed).pathname.replace(/\/+$/, '')
  } catch {
    return trimmed.replace(/\/+$/, '')
  }
}

function stripSseAltParam(searchParams: URLSearchParams): void {
  for (const value of searchParams.getAll('alt')) {
    if (value.toLowerCase() === 'sse') {
      searchParams.delete('alt', value)
    }
  }
}

/**
 * True when a `google_vertex` request targets an Anthropic Claude model served
 * over Vertex `rawPredict` / `streamRawPredict` (`publishers/anthropic/models/...`)
 * rather than Gemini `generateContent`.
 */
export function isVertexAnthropicTarget(baseUrl: string, modelId: string): boolean {
  const path = extractUrlPath(baseUrl)
  if (VERTEX_ANTHROPIC_PUBLISHER_RE.test(path) || VERTEX_ANTHROPIC_ACTION_RE.test(path)) {
    return true
  }
  if (VERTEX_GOOGLE_PUBLISHER_RE.test(path)) {
    return false
  }
  return /(?:^|\/)claude-/i.test(normalizeGeminiModelName(modelId))
}

/**
 * Encode each slash-separated segment of a model id while preserving `/` for
 * namespaced gateway ids (e.g. `devin/gemini-4-neon`, `opencode-go/hungerg-free`),
 * which local gateways like Magpie parse as path segments under `/v1beta/models/`.
 */
function encodeGeminiModelPath(modelName: string): string {
  return modelName
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/**
 * Build a Google Gemini or Google Vertex AI Gemini `generateContent` /
 * `streamGenerateContent` URL.
 *
 * Accepts bare roots (`https://generativelanguage.googleapis.com`,
 * `http://127.0.0.1:3425`, `https://aiplatform.googleapis.com`), versioned bases
 * (`.../v1beta`, `.../v1`, `https://opencode.ai/inference/go/google/v1beta`),
 * Vertex project/location roots (`.../projects/<p>/locations/<l>`), Vertex
 * publisher roots (`.../publishers/google`), `/models` roots, and full action URLs.
 */
export function buildGeminiEndpoint(
  baseUrl: string,
  modelId: string,
  stream = false,
  options?: { isVertex?: boolean },
): string {
  const modelName = normalizeGeminiModelName(modelId)
  const encodedModel = encodeGeminiModelPath(modelName)
  const action = stream ? 'streamGenerateContent' : 'generateContent'
  const url = new URL(baseUrl)
  const path = url.pathname.replace(/\/+$/, '')
  let modelsPath = path
  if (GEMINI_MODEL_ACTION_RE.test(path)) {
    modelsPath = path.replace(GEMINI_MODEL_ACTION_RE, '/models')
  } else if (VERTEX_PUBLISHER_BASE_RE.test(path)) {
    modelsPath += '/models'
  } else if (VERTEX_LOCATION_BASE_RE.test(path)) {
    modelsPath += '/publishers/google/models'
  } else if (!GEMINI_MODELS_SUFFIX_RE.test(path)) {
    if (!GEMINI_VERSIONED_BASE_RE.test(path)) modelsPath += options?.isVertex ? '/v1' : '/v1beta'
    modelsPath += options?.isVertex ? '/publishers/google/models' : '/models'
  }
  url.pathname = `${modelsPath}/${encodedModel}:${action}`
  url.hash = ''
  if (stream) url.searchParams.set('alt', 'sse')
  else stripSseAltParam(url.searchParams)
  return url.toString()
}

/**
 * Build a Google Vertex AI Anthropic (`rawPredict` / `streamRawPredict`) URL.
 *
 * Follows `@ai-sdk/google-vertex/anthropic`:
 * `https://{host}/v1/projects/{project}/locations/{location}/publishers/anthropic/models/{model}:{rawPredict|streamRawPredict}`
 */
export function buildVertexAnthropicEndpoint(
  baseUrl: string,
  modelId: string,
  stream = false,
): string {
  const modelName = normalizeGeminiModelName(modelId)
  const encodedModel = encodeURIComponent(modelName)
  const action = stream ? 'streamRawPredict' : 'rawPredict'
  const url = new URL(baseUrl)
  const path = url.pathname.replace(/\/+$/, '')
  let modelsPath = path
  if (VERTEX_ANTHROPIC_ACTION_RE.test(path)) {
    modelsPath = path.replace(VERTEX_ANTHROPIC_ACTION_RE, '/models')
  } else if (VERTEX_PUBLISHER_BASE_RE.test(path)) {
    modelsPath += '/models'
  } else if (VERTEX_LOCATION_BASE_RE.test(path)) {
    modelsPath += '/publishers/anthropic/models'
  } else if (!GEMINI_MODELS_SUFFIX_RE.test(path)) {
    if (!GEMINI_VERSIONED_BASE_RE.test(path)) modelsPath += '/v1'
    modelsPath += '/publishers/anthropic/models'
  }
  url.pathname = `${modelsPath}/${encodedModel}:${action}`
  url.hash = ''
  return url.toString()
}
