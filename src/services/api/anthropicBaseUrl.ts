/**
 * Anthropic SDK and HTTP callers append /v1 themselves. Accept bases ending in
 * /v1 without duplicating that final segment; keep gateway prefixes intact.
 * Normalize only at the request boundary, never in persisted provider settings.
 */
export function normalizeAnthropicBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl)
    // Query/fragment bases are not supported by the SDK's string concatenation.
    // Leave them unchanged rather than silently rewriting routing parameters.
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.search || url.hash ||
      !url.pathname.replace(/\/+$/, '').endsWith('/v1')
    ) return baseUrl

    // Preserve the original spelling/encoding of the gateway prefix.
    return baseUrl.replace(/\/v1\/*$/, '')
  } catch {
    // Keep invalid-input handling at the existing SDK/fetch boundary.
    return baseUrl
  }
}
