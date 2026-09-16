import type { SavedProvider } from './types/provider.js'

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

/** A redacted credential may be reused only at its existing destination. */
export function remoteProviderNeedsCredentials(current: SavedProvider, input: Record<string, unknown>): boolean {
  const nextBaseUrl = typeof input.baseUrl === 'string' ? input.baseUrl : current.baseUrl
  const replacesMainKey = nonempty(input.apiKey)
  if (current.apiKey && nextBaseUrl !== current.baseUrl && !replacesMainKey) return true

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
  if (nextImageDestination === oldImageDestination) return false

  const replacesImageKey = !!imagePatch && nonempty(imagePatch.apiKey)
  const retainedImageKey = current.imageGeneration?.apiKey?.trim()
  if (replacesImageKey) return false
  if (retainedImageKey) return true
  // Without a dedicated image key, image generation uses the main provider key.
  return !!current.apiKey && !replacesMainKey
}
