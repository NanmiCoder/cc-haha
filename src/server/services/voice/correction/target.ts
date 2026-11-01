import { isDeepSeekAccountProviderId, resolveDeepSeekAccountRequestHeaders } from '../../deepseekAccountProvider.js'
import { hahaOpenAIOAuthService } from '../../hahaOpenAIOAuthService.js'
import { isOpenAIOfficialProviderId } from '../../openaiOfficialProvider.js'
import { ProviderService } from '../../providerService.js'
import type { SavedProvider } from '../../../types/provider.js'
import type { VoiceCorrectionInfo, VoiceCorrectionTarget, VoicePreferences } from '../types.js'

/** A wire target plus the provider record the request is sent with. */
export interface ResolvedCorrectionTarget {
  target: VoiceCorrectionTarget
  provider: SavedProvider
}

/**
 * Picks the model the correction (and history pick) request goes to. Shared by
 * the catalog, preference validation and both endpoints so they always agree.
 */
export interface CorrectionTargetResolver {
  /** The active provider's fast (Haiku-slot) model; null when nothing usable is configured. */
  resolveDefault(): Promise<ResolvedCorrectionTarget | null>
  /** An explicitly chosen provider + model; null when that provider no longer exists. */
  resolveFixed(providerId: string, modelId: string): Promise<ResolvedCorrectionTarget | null>
}

type ProviderLookup = Pick<ProviderService, 'getProvider' | 'listProviders'>

function toTarget(provider: SavedProvider, modelId: string): ResolvedCorrectionTarget {
  return { provider, target: { providerId: provider.id, providerName: provider.name, modelId } }
}

/** Whether the shared text transport could authenticate a request to this provider right now. */
async function hasUsableCredentials(provider: SavedProvider): Promise<boolean> {
  if (isOpenAIOfficialProviderId(provider.id)) {
    return Boolean((await hahaOpenAIOAuthService.loadTokens())?.accessToken)
  }
  if (!provider.baseUrl) return false
  if (isDeepSeekAccountProviderId(provider.id)) {
    return (await resolveDeepSeekAccountRequestHeaders()) !== null
  }
  return Boolean(provider.apiKey)
}

export function createProviderTargetResolver(
  providers: ProviderLookup = new ProviderService(),
): CorrectionTargetResolver {
  return {
    async resolveDefault() {
      // Same "default provider" title generation uses: the active saved provider,
      // or the ChatGPT / DeepSeek account routes when one of those is active.
      const { activeId, providers: saved } = await providers.listProviders()
      if (!activeId) return null
      const provider = isOpenAIOfficialProviderId(activeId) || isDeepSeekAccountProviderId(activeId)
        ? await providers.getProvider(activeId)
        : saved.find(item => item.id === activeId) ?? null
      if (!provider) return null
      const modelId = provider.models.haiku || provider.models.main
      if (!modelId || !(await hasUsableCredentials(provider))) return null
      return toTarget(provider, modelId)
    },

    async resolveFixed(providerId, modelId) {
      let provider: SavedProvider
      try {
        provider = await providers.getProvider(providerId)
      } catch {
        return null
      }
      return toTarget(provider, modelId)
    },
  }
}

/** Resolves the saved choice: a fixed pair, or (both null) the default provider. */
export async function resolvePreferredTarget(
  resolver: CorrectionTargetResolver,
  preferences: Pick<VoicePreferences, 'correctionProviderId' | 'correctionModelId'>,
): Promise<ResolvedCorrectionTarget | null> {
  if (preferences.correctionProviderId && preferences.correctionModelId) {
    return resolver.resolveFixed(preferences.correctionProviderId, preferences.correctionModelId)
  }
  return resolver.resolveDefault()
}

/** Catalog view; a broken provider index reads as "nothing configured" instead of failing the catalog. */
export async function describeCorrectionTargets(
  resolver: CorrectionTargetResolver,
  preferences: Pick<VoicePreferences, 'correctionProviderId' | 'correctionModelId'>,
): Promise<VoiceCorrectionInfo> {
  const safely = async (resolve: () => Promise<ResolvedCorrectionTarget | null>) => {
    try {
      return (await resolve())?.target ?? null
    } catch {
      return null
    }
  }
  const defaultTarget = await safely(() => resolver.resolveDefault())
  const fixed = preferences.correctionProviderId && preferences.correctionModelId
  return {
    defaultTarget,
    target: fixed
      ? await safely(() => resolver.resolveFixed(preferences.correctionProviderId!, preferences.correctionModelId!))
      : defaultTarget,
  }
}
