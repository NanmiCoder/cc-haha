// A base whose last segment is already an API version (OpenAI-style /v1, Volcengine
// Ark's /api/v3, Zhipu's /api/paas/v4) serves the endpoints directly under it, the
// way OpenAI SDK clients treat base_url. Only bare gateway roots get the
// conventional /v1. Matches the /models probe rule in providerModelCatalog.
const VERSIONED_BASE_RE = /\/v\d+$/

/** Accept both gateway roots and OpenAI SDK-style bases already ending in a version segment. */
export function buildOpenaiEndpoint(baseUrl: string, endpoint: 'chat/completions' | 'responses'): string {
  const base = baseUrl.replace(/\/+$/, '')
  return `${VERSIONED_BASE_RE.test(base) ? base : `${base}/v1`}/${endpoint}`
}
