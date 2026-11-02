import { useEffect, useMemo } from 'react'
import type { VoiceCorrectionModelChoice, VoiceCorrectionTarget } from '@/api/voice'
import { ModelSelector, type ModelProviderChoice } from '@/components/controls/ModelSelector'
import { useTranslation } from '@/i18n'
import { useProviderStore } from '@/stores/providerStore'

/** The leading "follow the default provider" choice; never a real provider id. */
export const FOLLOW_DEFAULT_PROVIDER = '__voice_follow_default__'
const FOLLOW_DEFAULT_MODEL = '__voice_follow_default_model__'

type Props = {
  /** Accessible name of the field. */
  label: string
  value: VoiceCorrectionModelChoice
  onChange: (value: VoiceCorrectionModelChoice) => void
  /** What "follow the default provider" resolves to right now, from the voice catalog. */
  defaultTarget: VoiceCorrectionTarget | null
  disabled?: boolean
}

/**
 * Picks the model that AI correction (and the history vocabulary pick) calls.
 * The same field as an Agent's model in Settings → Agents: saved providers
 * grouped with their slots, plus one leading choice that follows whatever the
 * default provider's fast model is.
 */
export function VoiceCorrectionModelField({ label, value, onChange, defaultTarget, disabled }: Props) {
  const t = useTranslation()
  const providers = useProviderStore(state => state.providers)
  const hasLoadedProviders = useProviderStore(state => state.hasLoadedProviders)
  const fetchProviders = useProviderStore(state => state.fetchProviders)

  useEffect(() => {
    if (!hasLoadedProviders) void fetchProviders()
  }, [fetchProviders, hasLoadedProviders])

  const leadingChoices = useMemo(() => {
    const choices: ModelProviderChoice[] = [{
      providerId: FOLLOW_DEFAULT_PROVIDER,
      // The group heading carries the model it resolves to now, so the field
      // reads "Follow default provider · deepseek-flash" like the design.
      providerName: defaultTarget?.modelId ?? t('voice.settings.correction.model.noDefault'),
      isDefault: false,
      models: [{
        id: FOLLOW_DEFAULT_MODEL,
        name: t('voice.settings.correction.model.follow'),
        description: defaultTarget
          ? t('voice.settings.correction.model.followDescription', { provider: defaultTarget.providerName })
          : t('voice.settings.correction.model.followUnavailable'),
        context: '',
      }],
    }]
    // A saved choice whose provider was deleted keeps showing as itself
    // instead of silently becoming some other provider's model.
    if (value.providerId && value.modelId && hasLoadedProviders && !providers.some(provider => provider.id === value.providerId)) {
      choices.push({
        providerId: value.providerId,
        providerName: value.providerId,
        isDefault: false,
        models: [{
          id: value.modelId,
          name: value.modelId,
          description: t('voice.settings.correction.model.missingChoice'),
          context: '',
        }],
      })
    }
    return choices
  }, [defaultTarget, hasLoadedProviders, providers, t, value.modelId, value.providerId])

  return (
    <ModelSelector
      ariaLabel={label}
      appearance="field"
      fluid
      disabled={disabled}
      leadingChoices={leadingChoices}
      savedProvidersOnly
      runtimeSelection={{
        providerId: value.providerId ?? FOLLOW_DEFAULT_PROVIDER,
        modelId: value.modelId ?? FOLLOW_DEFAULT_MODEL,
      }}
      onRuntimeSelectionChange={(selection) => {
        if (selection.providerId === FOLLOW_DEFAULT_PROVIDER) {
          onChange({ providerId: null, modelId: null })
        } else if (selection.providerId && selection.modelId) {
          onChange({ providerId: selection.providerId, modelId: selection.modelId })
        }
      }}
    />
  )
}
