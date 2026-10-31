import { OFFICIAL_DEFAULT_MODEL_ID } from '../constants/modelCatalog'
import {
  OPENAI_OFFICIAL_DEFAULT_MODEL_ID,
  OPENAI_OFFICIAL_MODELS,
  OPENAI_OFFICIAL_PROVIDER_ID,
} from '../constants/openaiOfficialProvider'
import type { SavedProvider } from '../types/provider'
import type { RuntimeSelection } from '../types/runtime'
import {
  GROK_OFFICIAL_DEFAULT_MODEL_ID,
  GROK_OFFICIAL_MODELS,
  GROK_OFFICIAL_PROVIDER_ID,
} from '../constants/grokOfficialProvider'
import {
  DEEPSEEK_ACCOUNT_DEFAULT_MODEL_ID,
  DEEPSEEK_ACCOUNT_PROVIDER_ID,
} from '../constants/deepseekAccountProvider'
import {
  getModelReasoningCapabilityOverride,
  isModelReasoningEffort,
  normalizeModelReasoningEffort,
  resolveModelReasoningProfile,
  type ModelReasoningApiFormat,
  type ModelReasoningProviderKind,
} from '../../../src/shared/modelReasoning'
import { BUNDLED_PROVIDER_PRESETS, getBundledPresetReasoningProviderKind } from '../config/providerPresets'
import type { ReasoningEffortLevel } from '../types/settings'

const PROVIDER_MODEL_SLOTS = ['main', 'haiku', 'sonnet', 'opus', 'fable'] as const

function baseProviderModelId(modelId: string): string {
  return modelId.trim().replace(/\[1m\]$/i, '').replace(/:1m$/i, '').trim()
}

export function resolveProviderSlotModelId(
  provider: SavedProvider,
  slot: keyof SavedProvider['models'],
): string {
  const modelId = provider.models[slot]?.trim() ?? ''
  const enabled = provider.model1mSupport?.[slot]
  // Missing flags are legacy configuration: preserve explicit model suffixes.
  if (!modelId || enabled === undefined) return modelId
  const baseModelId = baseProviderModelId(modelId)
  return enabled ? `${baseModelId}[1m]` : baseModelId
}

const PROVIDER_PRESET_DEFAULT_ENVS = new Map(
  BUNDLED_PROVIDER_PRESETS.map(preset => [preset.id, preset.defaultEnv ?? {}]),
)

export function getProviderModelCapabilityOverride(
  provider: SavedProvider,
  modelId: string,
): string | undefined {
  return getModelReasoningCapabilityOverride(
    modelId,
    {
      ...provider.models,
      haiku: resolveProviderSlotModelId(provider, 'haiku'),
      sonnet: resolveProviderSlotModelId(provider, 'sonnet'),
      opus: resolveProviderSlotModelId(provider, 'opus'),
    },
    PROVIDER_PRESET_DEFAULT_ENVS.get(provider.presetId) ?? {},
  )
}

/** Effort levels a saved provider's model accepts; undefined when unknown. */
export function getProviderModelReasoningEfforts(
  provider: SavedProvider,
  modelId: string,
): ReasoningEffortLevel[] | undefined {
  const efforts = resolveModelReasoningProfile(
    modelId,
    provider.apiFormat,
    getProviderModelCapabilityOverride(provider, modelId),
    getBundledPresetReasoningProviderKind(provider.presetId),
  )?.supportedReasoningEfforts
  return efforts ? [...efforts] : undefined
}

export function resolveProviderRuntimeModelId(provider: SavedProvider, modelId: string): string {
  const candidates = PROVIDER_MODEL_SLOTS
    .filter((slot) => provider.models[slot]?.trim() &&
      baseProviderModelId(provider.models[slot]!) === baseProviderModelId(modelId))
    .map((slot) => resolveProviderSlotModelId(provider, slot))
  // A provider can map one ID to slots with different capabilities. Preserve
  // an exact runtime choice; otherwise reconcile old IDs in main-first order.
  return candidates.find((candidate) => candidate === modelId.trim()) ?? candidates[0] ?? modelId
}

export function resolveActiveProviderRuntimeSelection(
  activeId: string | null,
  activeProviderName: string | null,
  providers: SavedProvider[],
  currentModelId: string | undefined,
): RuntimeSelection | null {
  const activeProvider = activeId
    ? providers.find((provider) => provider.id === activeId)
    : activeProviderName
      ? providers.find((provider) => provider.name === activeProviderName)
      : undefined
  const inferredProviderId = activeId ?? activeProvider?.id ?? null
  if (!inferredProviderId) return null

  const providerMainModelId = activeProvider ? resolveProviderSlotModelId(activeProvider, 'main') : undefined
  const configuredModelId = activeProvider && currentModelId && PROVIDER_MODEL_SLOTS.some(
    (slot) => activeProvider.models[slot]?.trim() &&
      baseProviderModelId(activeProvider.models[slot]!) === baseProviderModelId(currentModelId),
  ) ? resolveProviderRuntimeModelId(activeProvider, currentModelId) : undefined

  return {
    providerId: inferredProviderId,
    modelId: configuredModelId || providerMainModelId || currentModelId || (
      inferredProviderId === OPENAI_OFFICIAL_PROVIDER_ID
        ? OPENAI_OFFICIAL_DEFAULT_MODEL_ID
        : inferredProviderId === GROK_OFFICIAL_PROVIDER_ID
          ? GROK_OFFICIAL_DEFAULT_MODEL_ID
          : inferredProviderId === DEEPSEEK_ACCOUNT_PROVIDER_ID
            ? DEEPSEEK_ACCOUNT_DEFAULT_MODEL_ID
            : OFFICIAL_DEFAULT_MODEL_ID
    ),
  }
}

export function resolveDefaultRuntimeSelection(
  activeId: string | null,
  activeProviderName: string | null,
  providers: SavedProvider[],
  currentModelId: string | undefined,
): RuntimeSelection {
  return resolveActiveProviderRuntimeSelection(
    activeId,
    activeProviderName,
    providers,
    currentModelId,
  ) ?? {
    providerId: null,
    modelId: currentModelId || OFFICIAL_DEFAULT_MODEL_ID,
  }
}

/** Resolve restored choices only after the saved-provider list is authoritative. */
export function reconcileRuntimeSelection(
  selection: RuntimeSelection,
  context: {
    providers: SavedProvider[]
    hasLoadedProviders: boolean
    activeId: string | null
    currentModelId?: string
    defaultEffortLevel?: RuntimeSelection['effortLevel']
  },
): RuntimeSelection {
  const provider = context.providers.find((entry) => entry.id === selection.providerId)
  const isOfficial = selection.providerId === null ||
    selection.providerId === OPENAI_OFFICIAL_PROVIDER_ID ||
    selection.providerId === GROK_OFFICIAL_PROVIDER_ID ||
    selection.providerId === DEEPSEEK_ACCOUNT_PROVIDER_ID
  if (!provider && !isOfficial && context.hasLoadedProviders) {
    // Deleted/recreated providers must not carry their old model or effort into
    // the default provider. Use the same choice for rendering and transport.
    const fallback = resolveDefaultRuntimeSelection(
      context.activeId, null, context.providers, context.currentModelId,
    )
    const fallbackProvider = context.providers.find((entry) => entry.id === fallback.providerId)
    return normalizeRuntimeSelection(
      { ...fallback, ...(context.defaultEffortLevel ? { effortLevel: context.defaultEffortLevel } : {}) },
      fallbackProvider?.apiFormat,
      fallbackProvider ? getBundledPresetReasoningProviderKind(fallbackProvider.presetId) : undefined,
    )
  }
  const modelId = provider ? resolveProviderRuntimeModelId(provider, selection.modelId) : selection.modelId
  return normalizeRuntimeSelection(
    modelId === selection.modelId ? selection : { ...selection, modelId },
    provider?.apiFormat,
    provider ? getBundledPresetReasoningProviderKind(provider.presetId) : undefined,
  )
}

export function normalizeRuntimeSelection(
  selection: RuntimeSelection,
  apiFormat?: ModelReasoningApiFormat,
  providerKind?: ModelReasoningProviderKind,
): RuntimeSelection {
  if (selection.openAIFastMode !== undefined && (
    selection.providerId !== OPENAI_OFFICIAL_PROVIDER_ID ||
    typeof selection.openAIFastMode !== 'boolean'
  )) {
    const { openAIFastMode: _ignoredFastMode, ...runtime } = selection
    selection = runtime
  }
  if (
    selection.effortLevel === undefined ||
    selection.providerId === null
  ) {
    return selection
  }

  if (selection.providerId === GROK_OFFICIAL_PROVIDER_ID || selection.providerId === OPENAI_OFFICIAL_PROVIDER_ID) {
    const models = selection.providerId === GROK_OFFICIAL_PROVIDER_ID ? GROK_OFFICIAL_MODELS : OPENAI_OFFICIAL_MODELS
    const model = models.find((entry) => entry.id === selection.modelId)
    // Models only known from the live catalog (e.g. grok-4.6) are absent from
    // the bundled desktop list. Keep their effort untouched and let the server
    // validate it against the live catalog instead of silently dropping it.
    if (!model) return selection
    const effortLevel = model.supportedReasoningEfforts?.includes(selection.effortLevel)
      ? selection.effortLevel
      : model.defaultReasoningEffort ?? model.supportedReasoningEfforts?.[0]
    if (effortLevel === selection.effortLevel) return selection
    const { effortLevel: _unsupportedEffort, ...runtime } = selection
    return effortLevel ? { ...runtime, effortLevel } : runtime
  }

  const requestedEffort = isModelReasoningEffort(selection.effortLevel)
    ? selection.effortLevel
    : undefined
  const reasoningProfile = resolveModelReasoningProfile(
    selection.modelId,
    apiFormat,
    undefined,
    providerKind,
  )
  if (!reasoningProfile && apiFormat === undefined) return selection
  const effortLevel = normalizeModelReasoningEffort(
    selection.modelId,
    requestedEffort,
    apiFormat,
    undefined,
    providerKind,
  )
  if (effortLevel === selection.effortLevel) return selection

  const { effortLevel: _unsupportedEffort, ...runtime } = selection
  const defaultEffort = reasoningProfile?.defaultReasoningEffort
  return effortLevel
    ? { ...runtime, effortLevel }
    : defaultEffort
      ? { ...runtime, effortLevel: defaultEffort }
      : runtime
}
