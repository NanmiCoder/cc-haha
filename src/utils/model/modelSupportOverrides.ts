import memoize from 'lodash-es/memoize.js'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from './providers.js'

export type ModelCapabilityOverride =
  | 'effort'
  | 'max_effort'
  | 'thinking'
  | 'adaptive_thinking'
  | 'interleaved_thinking'

const TIERS = [
  {
    modelEnvVar: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  },
] as const

/**
 * Strip [1m]/[2m] context-window suffixes so capability overrides match
 * regardless of whether the runtime model name includes the suffix.
 * The suffix is a client-side marker (never sent to the API) but the
 * pinned env var may carry it, while the runtime model passed to
 * modelSupportsThinking/modelSupportsEffort may not.
 */
function stripContextSuffix(model: string): string {
  return model.replace(/\[(1|2)m\]/gi, '')
}

/**
 * Check whether a 3p model capability override is set for a model that matches one of
 * the pinned ANTHROPIC_DEFAULT_*_MODEL env vars.
 */
export const get3PModelCapabilityOverride = memoize(
  (model: string, capability: ModelCapabilityOverride): boolean | undefined => {
    if (getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()) {
      return undefined
    }
    const m = stripContextSuffix(model.toLowerCase())
    for (const tier of TIERS) {
      const pinned = process.env[tier.modelEnvVar]
      const capabilities = process.env[tier.capabilitiesEnvVar]
      if (!pinned || capabilities === undefined) continue
      if (m !== stripContextSuffix(pinned.toLowerCase())) continue
      return capabilities
        .toLowerCase()
        .split(',')
        .map(s => s.trim())
        .includes(capability)
    }
    return undefined
  },
  (model, capability) => `${stripContextSuffix(model.toLowerCase())}:${capability}`,
)
