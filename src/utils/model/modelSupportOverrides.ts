import memoize from 'lodash-es/memoize.js'
import { MODEL_REASONING_CAPABILITY_TIERS } from '../../shared/modelReasoning.js'
import { normalizeModelContextKey } from './modelContextWindows.js'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from './providers.js'

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
export const get3PModelCapabilityOverride = memoize(
  (model: string, capability: ModelCapabilityOverride): boolean | undefined => {
    if (getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()) {
      return undefined
    }
    const normalizedModel = normalizeModelContextKey(model)
    for (const tier of MODEL_REASONING_CAPABILITY_TIERS) {
      const pinned = process.env[tier.modelEnvVar]
      const capabilities = process.env[tier.capabilitiesEnvVar]
      if (!pinned || capabilities === undefined) continue
      if (normalizedModel !== normalizeModelContextKey(pinned)) continue
      return capabilities
        .toLowerCase()
        .split(',')
        .map(s => s.trim())
        .includes(capability)
    }
    return undefined
  },
  (model, capability) => `${normalizeModelContextKey(model)}:${capability}`,
)
