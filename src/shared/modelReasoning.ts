export const MODEL_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export type ModelReasoningEffort = (typeof MODEL_REASONING_EFFORTS)[number]
export type ModelReasoningApiFormat = 'anthropic' | 'openai_chat' | 'openai_responses'

export const MODEL_REASONING_CAPABILITY_TIERS = [
  {
    slot: 'fable',
    modelEnvVar: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    slot: 'opus',
    modelEnvVar: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    slot: 'sonnet',
    modelEnvVar: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    slot: 'haiku',
    modelEnvVar: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  },
] as const

export type ModelReasoningProfile = {
  family:
    | 'explicit'
    | 'generic'
    | 'deepseek-v4'
    | 'kimi-k3'
    | 'kimi-coding'
    | 'glm-5.2'
    | 'glm-5.3'
    | 'glm-legacy'
    | 'minimax'
  apiFormats: readonly ModelReasoningApiFormat[]
  supportedReasoningEfforts: readonly ModelReasoningEffort[]
  defaultReasoningEffort?: ModelReasoningEffort
  claudeCodeCapabilities: string
}

type ModelReasoningCapabilityEntry = Pick<
  ModelReasoningProfile,
  'family' | 'apiFormats' | 'claudeCodeCapabilities'
> & {
  matches: (modelId: string) => boolean
}

const COMPATIBLE_REASONING_API_FORMATS = [
  'anthropic',
  'openai_chat',
  'openai_responses',
] as const
const GENERIC_REASONING_PROFILE: ModelReasoningProfile = {
  family: 'generic',
  apiFormats: COMPATIBLE_REASONING_API_FORMATS,
  supportedReasoningEfforts: MODEL_REASONING_EFFORTS,
  claudeCodeCapabilities: 'thinking,effort,adaptive_thinking,xhigh_effort,max_effort',
}

// These entries preserve thinking-mode compatibility only. Effort levels are
// always inherited from Claude Code and are never remapped by model name.
const MODEL_REASONING_CAPABILITY_REGISTRY: readonly ModelReasoningCapabilityEntry[] = [
  {
    family: 'deepseek-v4',
    apiFormats: ['anthropic', 'openai_chat'],
    claudeCodeCapabilities: 'thinking,effort,adaptive_thinking,xhigh_effort,max_effort',
    matches: modelId => (
      modelId.startsWith('deepseek-v4') ||
      modelId === 'deepseek-chat' ||
      modelId === 'deepseek-reasoner'
    ),
  },
  {
    family: 'kimi-k3',
    apiFormats: ['anthropic', 'openai_chat'],
    claudeCodeCapabilities: 'thinking,required_thinking,effort,xhigh_effort,max_effort',
    matches: modelId => (
      modelId === 'k3' ||
      modelId.startsWith('k3-') ||
      modelId === 'kimi-k3' ||
      modelId.startsWith('kimi-k3-')
    ),
  },
  {
    family: 'kimi-coding',
    apiFormats: ['anthropic', 'openai_chat'],
    claudeCodeCapabilities: 'thinking,required_thinking,effort,xhigh_effort,max_effort',
    matches: modelId => (
      modelId.startsWith('kimi-for-coding') ||
      modelId.startsWith('kimi-k2.')
    ),
  },
  {
    family: 'glm-5.2',
    apiFormats: ['anthropic', 'openai_chat'],
    claudeCodeCapabilities: 'thinking,effort,xhigh_effort,max_effort',
    matches: modelId => modelId === 'glm-5.2' || modelId.startsWith('glm-5.2-'),
  },
  {
    // GLM-5.3 always reasons and rejects requests that omit or disable
    // thinking. Mark it required_thinking so the connectivity probe and the
    // request builder send an explicit enabled thinking block instead of
    // falling through to the generic profile (which would add adaptive
    // thinking and break the request).
    family: 'glm-5.3',
    apiFormats: ['anthropic', 'openai_chat'],
    claudeCodeCapabilities: 'required_thinking,thinking,effort,max_effort',
    matches: modelId => modelId === 'glm-5.3' || modelId.startsWith('glm-5.3-'),
  },
  {
    family: 'glm-legacy',
    apiFormats: ['anthropic', 'openai_chat'],
    claudeCodeCapabilities: 'thinking,effort,xhigh_effort,max_effort',
    matches: modelId => (
      modelId.startsWith('glm-4.') ||
      modelId === 'glm-5.1' ||
      modelId.startsWith('glm-5.1-') ||
      modelId === 'glm-5-turbo' ||
      modelId.startsWith('glm-5-turbo-')
    ),
  },
  {
    family: 'minimax',
    apiFormats: ['anthropic', 'openai_chat'],
    claudeCodeCapabilities: 'thinking,effort,adaptive_thinking,xhigh_effort,max_effort',
    matches: modelId => (
      modelId.startsWith('minimax-m2.7') ||
      modelId === 'minimax-m3' ||
      modelId.startsWith('minimax-m3-')
    ),
  },
]

function normalizeReasoningModelId(modelId: string): string {
  const normalized = modelId
    .trim()
    .replace(/\[1m\]$/i, '')
    .replace(/:1m$/i, '')
    .toLowerCase()
  const namespaceSeparator = normalized.lastIndexOf('/')
  return namespaceSeparator >= 0
    ? normalized.slice(namespaceSeparator + 1)
    : normalized
}

export function getModelReasoningCapabilityOverride(
  modelId: string,
  models: Partial<Record<(typeof MODEL_REASONING_CAPABILITY_TIERS)[number]['slot'], string>>,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const normalizedModelId = modelId.trim().toLowerCase()
  for (const tier of MODEL_REASONING_CAPABILITY_TIERS) {
    const mappedModel = models[tier.slot]?.trim().toLowerCase()
    const capabilities = env[tier.capabilitiesEnvVar]
    if (mappedModel === normalizedModelId && capabilities !== undefined) {
      return capabilities
    }
  }
  return undefined
}

export function isModelReasoningEffort(value: string): value is ModelReasoningEffort {
  return (MODEL_REASONING_EFFORTS as readonly string[]).includes(value)
}

function profileFromCapabilityOverride(
  capabilities: string,
  apiFormat?: ModelReasoningApiFormat,
): ModelReasoningProfile {
  const capabilitySet = new Set(
    capabilities.toLowerCase().split(',').map(capability => capability.trim()),
  )
  const supportsEffort = capabilitySet.has('effort')
  return {
    family: 'explicit',
    apiFormats: apiFormat ? [apiFormat] : COMPATIBLE_REASONING_API_FORMATS,
    supportedReasoningEfforts: supportsEffort
      ? MODEL_REASONING_EFFORTS.filter(level => (
          (level !== 'xhigh' || capabilitySet.has('xhigh_effort')) &&
          (level !== 'max' || capabilitySet.has('max_effort'))
        ))
      : [],
    claudeCodeCapabilities: capabilities,
  }
}

export function resolveModelReasoningProfile(
  modelId: string,
  apiFormat?: ModelReasoningApiFormat,
  capabilitiesOverride?: string,
): ModelReasoningProfile | undefined {
  if (capabilitiesOverride !== undefined) {
    return profileFromCapabilityOverride(capabilitiesOverride, apiFormat)
  }

  if (apiFormat !== undefined && !GENERIC_REASONING_PROFILE.apiFormats.includes(apiFormat)) {
    return undefined
  }

  const normalizedModelId = normalizeReasoningModelId(modelId)
  const entry = MODEL_REASONING_CAPABILITY_REGISTRY.find(candidate => (
    candidate.matches(normalizedModelId) &&
    (apiFormat === undefined || candidate.apiFormats.includes(apiFormat))
  ))
  return entry
    ? {
        family: entry.family,
        apiFormats: entry.apiFormats,
        supportedReasoningEfforts: MODEL_REASONING_EFFORTS,
        claudeCodeCapabilities: entry.claudeCodeCapabilities,
      }
    : GENERIC_REASONING_PROFILE
}

export function normalizeModelReasoningEffort(
  modelId: string,
  requestedEffort: ModelReasoningEffort | undefined,
  apiFormat?: ModelReasoningApiFormat,
  capabilitiesOverride?: string,
): ModelReasoningEffort | undefined {
  if (requestedEffort === undefined) return undefined
  const profile = resolveModelReasoningProfile(modelId, apiFormat, capabilitiesOverride)
  if (!profile || profile.supportedReasoningEfforts.length === 0) return undefined
  return profile.supportedReasoningEfforts.includes(requestedEffort)
    ? requestedEffort
    : undefined
}

export function getClaudeCodeModelCapabilities(
  modelId: string,
  apiFormat?: ModelReasoningApiFormat,
  capabilitiesOverride?: string,
): string {
  return resolveModelReasoningProfile(
    modelId,
    apiFormat,
    capabilitiesOverride,
  )?.claudeCodeCapabilities ?? 'none'
}

/**
 * Whether a model rejects requests that omit or disable thinking (e.g.
 * "always-reason" models such as GLM-5.3). The connectivity probe uses this to
 * include an explicit enabled thinking block instead of sending a bare request
 * the upstream API treats as thinking disabled.
 */
export function modelRequiresThinkingParam(
  modelId: string,
  apiFormat?: ModelReasoningApiFormat,
): boolean {
  return getClaudeCodeModelCapabilities(modelId, apiFormat)
    .split(',')
    .map(capability => capability.trim())
    .includes('required_thinking')
}
