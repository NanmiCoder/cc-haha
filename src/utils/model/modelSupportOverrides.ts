import memoize from 'lodash-es/memoize.js'
import { MODEL_REASONING_CAPABILITY_TIERS } from '../../shared/modelReasoning.js'
import { normalizeModelContextKey } from './modelContextWindows.js'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from './providers.js'
import { getProviderRouteForModel } from './providerEnvScope.js'

export type ModelCapabilityOverride =
  | 'effort'
  | 'xhigh_effort'
  | 'max_effort'
  | 'thinking'
  | 'required_thinking'
  | 'adaptive_thinking'
  | 'interleaved_thinking'

/**
 * Check whether a 3p model capability override is set for a model that matches one of
 * the pinned ANTHROPIC_DEFAULT_*_MODEL env vars. Context-window markers are transport
 * annotations and must not change model identity.
 */
function readCapabilityOverride(
  model: string,
  capability: ModelCapabilityOverride,
  env: Readonly<Record<string, string | undefined>>,
): boolean | undefined {
  const normalizedModel = normalizeModelContextKey(model)
  for (const tier of MODEL_REASONING_CAPABILITY_TIERS) {
    const pinned = env[tier.modelEnvVar]
    const capabilities = env[tier.capabilitiesEnvVar]
    if (!pinned || capabilities === undefined) continue
    if (normalizedModel !== normalizeModelContextKey(pinned)) continue
    return capabilities
      .toLowerCase()
      .split(',')
      .map(s => s.trim())
      .includes(capability)
  }
  return undefined
}

const getSessionCapabilityOverride = memoize(
  (model: string, capability: ModelCapabilityOverride): boolean | undefined => {
    if (getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()) {
      return undefined
    }
    return readCapabilityOverride(model, capability, process.env)
  },
  (model, capability) => `${normalizeModelContextKey(model)}:${capability}`,
)

/**
 * An Agent routed to another saved provider reads that provider's declared
 * capabilities for its model; the session's memoized answers stay untouched.
 */
export const get3PModelCapabilityOverride = Object.assign(
  (model: string, capability: ModelCapabilityOverride): boolean | undefined => {
    const route = getProviderRouteForModel(model)
    return route
      ? readCapabilityOverride(model, capability, route.env)
      : getSessionCapabilityOverride(model, capability)
  },
  { cache: getSessionCapabilityOverride.cache },
)
