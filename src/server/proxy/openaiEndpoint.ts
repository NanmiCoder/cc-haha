// A base whose last segment is already an API version (OpenAI-style /v1, Volcengine
// Ark's /api/v3, Zhipu's /api/paas/v4) serves the endpoints directly under it, the
// way OpenAI SDK clients treat base_url. Only bare gateway roots get the
// conventional /v1. Matches the /models probe rule in providerModelCatalog.
const VERSIONED_BASE_RE = /\/v\d+$/
const AZURE_OPENAI_HOST_RE = /\.(?:openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/i
const AZURE_DEPLOYMENTS_PATH_RE = /\/openai\/deployments\/[^/]+$/i
const AZURE_OPENAI_V1_PATH_RE = /\/openai\/v1$/i
const AZURE_OPENAI_ROOT_PATH_RE = /\/openai$/i
const OPENAI_ACTION_SUFFIX_RE = /\/(?:chat\/completions|responses)$/i

export const DEFAULT_AZURE_OPENAI_API_VERSION = '2024-10-21'

/**
 * True when a URL targets Microsoft Azure OpenAI / Azure AI Foundry (official
 * Azure hostnames, classic `/openai/deployments/...` paths, or explicit
 * `?api-version=` query parameters).
 */
export function isAzureOpenaiEndpoint(baseUrl: string): boolean {
  const trimmed = baseUrl.trim()
  if (!trimmed) return false
  try {
    const parsed = new URL(trimmed)
    return (
      AZURE_OPENAI_HOST_RE.test(parsed.hostname) ||
      /\/openai\/deployments\//i.test(parsed.pathname) ||
      parsed.searchParams.has('api-version')
    )
  } catch {
    return /\/openai\/deployments\//i.test(trimmed) || /[?&]api-version=/i.test(trimmed)
  }
}

export type BuildOpenaiEndpointOptions = {
  /** Model / deployment name used when expanding bare Azure deployment URLs. */
  modelId?: string
  /** Treat custom/local gateways as Azure OpenAI (for `apiFormat: 'azure_openai'`). */
  forceAzure?: boolean
}

/**
 * Accept gateway roots, OpenAI SDK-style versioned bases, AND Microsoft Azure
 * OpenAI / Azure AI Foundry URLs:
 * - Modern Azure v1 / Foundry: `https://{resource}.openai.azure.com/openai/v1`
 *   or `https://{resource}.services.ai.azure.com/openai/v1`
 * - Classic Azure deployment: `https://{resource}.openai.azure.com/openai/deployments/{deployment}?api-version=2024-10-21`
 * - Bare Azure resource root with `?api-version=...`: expands deployment from `modelId`
 * - Preserves query parameters (such as `?api-version=...`) instead of appending paths after them.
 */
export function buildOpenaiEndpoint(
  baseUrl: string,
  endpoint: 'chat/completions' | 'responses',
  options?: BuildOpenaiEndpointOptions,
): string {
  const trimmed = baseUrl.trim()
  const isAzure = options?.forceAzure === true || isAzureOpenaiEndpoint(trimmed)

  let parsed: URL | null = null
  try {
    parsed = new URL(trimmed)
  } catch {
    // Non-URL strings fall back to the plain path join below.
  }

  if (!parsed) {
    const base = trimmed.replace(/\/+$/, '')
    return `${VERSIONED_BASE_RE.test(base) ? base : `${base}/v1`}/${endpoint}`
  }

  const rawPathname = parsed.pathname.replace(/\/+$/, '')
  const apiVersion = parsed.searchParams.get('api-version')

  // Full endpoint URL (e.g. .../chat/completions?api-version=... or .../responses)
  if (OPENAI_ACTION_SUFFIX_RE.test(rawPathname)) {
    parsed.pathname = rawPathname.replace(OPENAI_ACTION_SUFFIX_RE, `/${endpoint}`)
    return parsed.toString()
  }

  if (isAzure) {
    // Classic deployment path: .../openai/deployments/{deployment}
    // Azure Responses API lives at `/openai/responses?api-version=...` (never
    // under `/deployments/{deployment}/responses`), whereas Chat Completions
    // stays under `/openai/deployments/{deployment}/chat/completions`.
    if (AZURE_DEPLOYMENTS_PATH_RE.test(rawPathname)) {
      if (endpoint === 'responses') {
        const openaiRoot = rawPathname.replace(/\/deployments\/[^/]+$/i, '')
        parsed.pathname = `${openaiRoot}/${endpoint}`
      } else {
        parsed.pathname = `${rawPathname}/${endpoint}`
      }
      if (!apiVersion) {
        parsed.searchParams.set('api-version', DEFAULT_AZURE_OPENAI_API_VERSION)
      }
      return parsed.toString()
    }

    // Modern Azure OpenAI v1 / Azure AI Foundry v1: .../openai/v1
    if (AZURE_OPENAI_V1_PATH_RE.test(rawPathname)) {
      parsed.pathname = `${rawPathname}/${endpoint}`
      return parsed.toString()
    }

    // Bare Azure resource root (`https://res.openai.azure.com` or `.../openai`)
    const openaiRoot = AZURE_OPENAI_ROOT_PATH_RE.test(rawPathname)
      ? rawPathname
      : rawPathname === ''
        ? '/openai'
        : `${rawPathname}/openai`

    if (apiVersion && apiVersion.toLowerCase() !== 'v1') {
      if (endpoint === 'chat/completions' && options?.modelId?.trim()) {
        parsed.pathname = `${openaiRoot}/deployments/${encodeURIComponent(options.modelId.trim())}/${endpoint}`
        return parsed.toString()
      }
      // Azure preview Responses API uses `/openai/responses?api-version=...`
      parsed.pathname = `${openaiRoot}/${endpoint}`
      return parsed.toString()
    }

    // Modern Azure OpenAI v1 default (no api-version required, matching @ai-sdk/azure).
    if (VERSIONED_BASE_RE.test(rawPathname)) {
      parsed.pathname = `${rawPathname}/${endpoint}`
    } else {
      parsed.pathname = `${openaiRoot}/v1/${endpoint}`
    }
    return parsed.toString()
  }

  parsed.pathname = `${VERSIONED_BASE_RE.test(rawPathname) ? rawPathname : `${rawPathname}/v1`}/${endpoint}`
  return parsed.toString()
}
