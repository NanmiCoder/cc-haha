import { OFFICIAL_DEFAULT_MODEL_ID } from '../constants/modelCatalog'
import {
  OPENAI_OFFICIAL_DEFAULT_MODEL_ID,
  OPENAI_OFFICIAL_PROVIDER_ID,
} from '../constants/openaiOfficialProvider'
import type { SavedProvider } from '../types/provider'
import type { RuntimeSelection } from '../types/runtime'
import {
  GROK_OFFICIAL_DEFAULT_MODEL_ID,
  GROK_OFFICIAL_PROVIDER_ID,
} from '../constants/grokOfficialProvider'

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

  const providerMainModelId = activeProvider?.models.main.trim()

  return {
    providerId: inferredProviderId,
    modelId: providerMainModelId || currentModelId || (
      inferredProviderId === OPENAI_OFFICIAL_PROVIDER_ID
        ? OPENAI_OFFICIAL_DEFAULT_MODEL_ID
        : inferredProviderId === GROK_OFFICIAL_PROVIDER_ID
          ? GROK_OFFICIAL_DEFAULT_MODEL_ID
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
