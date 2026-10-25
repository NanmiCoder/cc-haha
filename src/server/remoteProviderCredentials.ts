import type { SavedProvider } from './types/provider.js'

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

function proxyDestination(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'follow_global'
  const proxy = value as Record<string, unknown>
  if (proxy.mode === 'manual') return `manual:${typeof proxy.url === 'string' ? proxy.url.trim() : ''}`
  return proxy.mode === 'direct' ? 'direct' : 'follow_global'
}

/** A redacted credential may be reused only at its existing destination. */
export function remoteProviderNeedsCredentials(current: SavedProvider, input: Record<string, unknown>): boolean {
  const nextBaseUrl = typeof input.baseUrl === 'string' ? input.baseUrl : current.baseUrl
  const replacesMainKey = nonempty(input.apiKey)
  // A forward proxy can read HTTP provider credentials even when the API URL
  // stays unchanged. Route changes must protect image credentials as well.
  const proxyChanged = input.proxy !== undefined && proxyDestination(input.proxy) !== proxyDestination(current.proxy)
  if (current.apiKey && (nextBaseUrl !== current.baseUrl || proxyChanged) && !replacesMainKey) return true

  if (input.imageGeneration === null) return false
  const imagePatch = input.imageGeneration && typeof input.imageGeneration === 'object' && !Array.isArray(input.imageGeneration)
    ? input.imageGeneration as Record<string, unknown>
    : undefined
  if (!imagePatch && !current.imageGeneration) return false
  const oldImageDestination = current.imageGeneration?.baseUrl?.trim() || current.baseUrl
  // Image updates replace the image object; an omitted/empty URL falls back to the main URL.
  const nextImageDestination = imagePatch
    ? (nonempty(imagePatch.baseUrl) ? imagePatch.baseUrl.trim() : nextBaseUrl)
    : (current.imageGeneration?.baseUrl?.trim() || nextBaseUrl)
  if (nextImageDestination === oldImageDestination && !proxyChanged) return false

  const replacesImageKey = !!imagePatch && nonempty(imagePatch.apiKey)
  const retainedImageKey = current.imageGeneration?.apiKey?.trim()
  if (replacesImageKey) return false
  if (retainedImageKey) return true
  // Without a dedicated image key, image generation uses the main provider key.
  return !!current.apiKey && !replacesMainKey
}
