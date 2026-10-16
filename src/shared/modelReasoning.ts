export const MODEL_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export type ModelReasoningEffort = (typeof MODEL_REASONING_EFFORTS)[number]
export type ModelReasoningApiFormat = 'anthropic' | 'openai_chat' | 'openai_responses'
export type ModelReasoningProviderKind =
  | 'zhipu_standard_api'
  | 'zhipu_coding_plan'

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
    | 'glm-5.3'
    | 'glm-5.2'
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
  supportedReasoningEfforts?: readonly ModelReasoningEffort[]
  defaultReasoningEffort?: ModelReasoningEffort
  providerProfiles?: Partial<Record<
    ModelReasoningProviderKind,
    Partial<Pick<
      ModelReasoningProfile,
      'supportedReasoningEfforts' | 'defaultReasoningEffort' | 'claudeCodeCapabilities'
    >>
  >>
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

const GLM_53_CODING_PLAN_PROFILE = {
  supportedReasoningEfforts: MODEL_REASONING_EFFORTS,
  defaultReasoningEffort: 'max',
  claudeCodeCapabilities: 'thinking,required_thinking,effort,xhigh_effort,max_effort',
} as const satisfies Pick<
  ModelReasoningProfile,
  'supportedReasoningEfforts' | 'defaultReasoningEffort' | 'claudeCodeCapabilities'
>

const GLM_53_STANDARD_API_PROFILE = {
  supportedReasoningEfforts: ['low', 'high', 'max'],
  defaultReasoningEffort: 'max',
  claudeCodeCapabilities: 'thinking,required_thinking,effort,max_effort',
} as const satisfies Pick<
  ModelReasoningProfile,
  'supportedReasoningEfforts' | 'defaultReasoningEffort' | 'claudeCodeCapabilities'
>

// Known families inherit Claude Code effort levels unless a documented provider
// contract narrows them. Provider-specific profiles keep standard API contracts
// from accidentally disabling aliases accepted by coding-plan runtimes.
const MODEL_REASONING_CAPABILITY_REGISTRY: readonly ModelReasoningCapabilityEntry[] = [
  {
    family: 'deepseek-v4',
    apiFormats: ['anthropic', 'openai_chat'],
    claudeCodeCapabilities: 'thinking,effort,adaptive_thinking,xhigh_effort,max_effort',
    matches: modelId => (
      modelId.startsWith('deepseek-v4') ||
      // V4.1 Flash as the DeepSeek account route names it.
      modelId === 'deepseek-flash' ||
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
    family: 'glm-5.3',
    apiFormats: ['anthropic', 'openai_chat'],
    ...GLM_53_CODING_PLAN_PROFILE,
    providerProfiles: {
      zhipu_standard_api: GLM_53_STANDARD_API_PROFILE,
      zhipu_coding_plan: GLM_53_CODING_PLAN_PROFILE,
    },
    matches: modelId => modelId === 'glm-5.3' || modelId === 'glm-5.3-flash',
  },
  {
    family: 'glm-5.2',
    apiFormats: ['anthropic', 'openai_chat'],
    claudeCodeCapabilities: 'thinking,effort,xhigh_effort,max_effort',
    matches: modelId => modelId === 'glm-5.2' || modelId.startsWith('glm-5.2-'),
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

export function isOpenAIReasoningModel(modelId: string): boolean {
  const normalizedModelId = normalizeReasoningModelId(modelId)
  return normalizedModelId.startsWith('gpt-') || /^o\d/.test(normalizedModelId)
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
  providerKind?: ModelReasoningProviderKind,
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
  const providerProfile = providerKind
    ? entry?.providerProfiles?.[providerKind]
    : undefined
  return entry
    ? {
        family: entry.family,
        apiFormats: entry.apiFormats,
        supportedReasoningEfforts:
          providerProfile?.supportedReasoningEfforts ??
          entry.supportedReasoningEfforts ??
          MODEL_REASONING_EFFORTS,
        ...((providerProfile?.defaultReasoningEffort ?? entry.defaultReasoningEffort)
          ? {
              defaultReasoningEffort:
                providerProfile?.defaultReasoningEffort ?? entry.defaultReasoningEffort,
            }
          : {}),
        claudeCodeCapabilities:
          providerProfile?.claudeCodeCapabilities ?? entry.claudeCodeCapabilities,
      }
    : GENERIC_REASONING_PROFILE
}

export function normalizeModelReasoningEffort(
  modelId: string,
  requestedEffort: ModelReasoningEffort | undefined,
  apiFormat?: ModelReasoningApiFormat,
  capabilitiesOverride?: string,
  providerKind?: ModelReasoningProviderKind,
): ModelReasoningEffort | undefined {
  if (requestedEffort === undefined) return undefined
  const profile = resolveModelReasoningProfile(
    modelId,
    apiFormat,
    capabilitiesOverride,
    providerKind,
  )
  if (!profile || profile.supportedReasoningEfforts.length === 0) return undefined
  return profile.supportedReasoningEfforts.includes(requestedEffort)
    ? requestedEffort
    : undefined
}

export function getClaudeCodeModelCapabilities(
  modelId: string,
  apiFormat?: ModelReasoningApiFormat,
  capabilitiesOverride?: string,
  providerKind?: ModelReasoningProviderKind,
): string {
  return resolveModelReasoningProfile(
    modelId,
    apiFormat,
    capabilitiesOverride,
    providerKind,
  )?.claudeCodeCapabilities ?? 'none'
}
