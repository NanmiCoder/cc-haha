/** Accept both gateway roots and OpenAI SDK-style bases already ending in /v1. */
export function buildOpenaiEndpoint(baseUrl: string, endpoint: 'chat/completions' | 'responses'): string {
  const base = baseUrl.replace(/\/+$/, '')
  return `${base.endsWith('/v1') ? base : `${base}/v1`}/${endpoint}`
}
