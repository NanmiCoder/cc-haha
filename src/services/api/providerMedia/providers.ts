import { resolveDeepSeekMediaEndpoint } from './deepseek.js'
import type { MediaEndpointResolver } from './types.js'

// Capabilities are explicit, never inferred from a model name or API dialect.
const providers: readonly MediaEndpointResolver[] = [resolveDeepSeekMediaEndpoint]

export const resolveProviderMediaEndpoint: MediaEndpointResolver = url => {
  for (const resolve of providers) {
    const endpoint = resolve(url)
    if (endpoint) return endpoint
  }
  return undefined
}
