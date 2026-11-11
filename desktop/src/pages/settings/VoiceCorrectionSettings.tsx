import { useEffect, useState } from 'react'
import type { VoiceCatalog, VoiceCorrectionModelChoice, VoicePreferences } from '@/api/voice'
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSwitchRow,
} from '@/components/settings/SettingsSection'
import { Button } from '@/components/ui/Button'
import { useTranslation } from '@/i18n'
import { useProviderStore } from '@/stores/providerStore'
import { useUIStore } from '@/stores/uiStore'
import { useVoiceInputStore } from '@/stores/voiceInputStore'
import { SettingsHelpTopic } from './SettingsHelpTopic'
import { VoiceCorrectionModelField } from './VoiceCorrectionModelField'

/**
 * Settings → Voice input → AI correction: after recognition, send the text
 * (never the audio) to a model the user picked, to fix misheard product names,
 * model names, commands and identifiers. Off by default; while off nothing is
 * sent.
 */
export function VoiceCorrectionSettings({ catalog }: { catalog: VoiceCatalog }) {
  const t = useTranslation()
  const updatePreferences = useVoiceInputStore(state => state.updatePreferences)
  const savedProviders = useProviderStore(state => state.providers)
  const hasLoadedProviders = useProviderStore(state => state.hasLoadedProviders)
  const fetchProviders = useProviderStore(state => state.fetchProviders)
  const [saveFailed, setSaveFailed] = useState(false)

  useEffect(() => {
    if (!hasLoadedProviders) void fetchProviders()
  }, [fetchProviders, hasLoadedProviders])

  const { preferences } = catalog
  // Catalogs from before correction existed carry no block; read it as "nothing resolved".
  const correction = (catalog.correction as VoiceCatalog['correction'] | undefined) ?? { defaultTarget: null, target: null }
  const enabled = preferences.correctionEnabled
  // Nothing to call at all: no default provider that can answer, and no saved
  // provider to pick instead. Only claimed once the provider list is known.
  const noService = hasLoadedProviders && !correction.defaultTarget && savedProviders.length === 0
  const fixedChoice = preferences.correctionProviderId !== null && preferences.correctionModelId !== null
  const fixedMissing = enabled && fixedChoice && !correction.target

  const save = async (patch: Partial<VoicePreferences>) => {
    setSaveFailed(false)
    try {
      await updatePreferences(patch)
    } catch {
      setSaveFailed(true)
    }
  }

  const choose = (choice: VoiceCorrectionModelChoice) => {
    if (choice.providerId === preferences.correctionProviderId && choice.modelId === preferences.correctionModelId) return
    void save({ correctionProviderId: choice.providerId, correctionModelId: choice.modelId })
  }

  const openProviders = () => useUIStore.getState().setActiveSettingsTab('providers')

  return (
    <SettingsSection title={t('voice.settings.correction.title')} description={t('voice.settings.correction.description')}>
      <SettingsGroup>
        <SettingsSwitchRow
          title={t('voice.settings.correction.enable.label')}
          help={<SettingsHelpTopic topic="voiceCorrection" />}
          description={noService ? t('voice.settings.correction.noService') : t('voice.settings.correction.enable.description')}
          checked={enabled}
          // Switching it off always stays possible.
          disabled={noService && !enabled}
          onChange={(correctionEnabled) => { void save({ correctionEnabled }) }}
          data-testid="voice-correction-switch-row"
          footer={noService || saveFailed ? (
            <div className="space-y-1 text-xs leading-[1.5]">
              {noService ? (
                <p className="text-[var(--color-text-tertiary)]">
                  {t('voice.settings.correction.noServiceHint')}{' '}
                  <Button variant="link" size="sm" onClick={openProviders}>
                    {t('voice.settings.correction.addService')}
                  </Button>
                </p>
              ) : null}
              {saveFailed ? (
                <p role="alert" className="text-[var(--color-error)]">{t('voice.settings.saveFailed')}</p>
              ) : null}
            </div>
          ) : undefined}
        />
        {enabled ? (
          <SettingsRow
            title={t('voice.settings.correction.model.label')}
            description={t('voice.settings.correction.model.hint')}
            data-testid="voice-correction-model-row"
            footer={fixedMissing ? (
              <p role="status" className="text-xs leading-[1.5] text-[var(--color-warning)]">
                {t('voice.settings.correction.model.missing', { model: preferences.correctionModelId ?? '' })}
              </p>
            ) : undefined}
          >
            <div className="flex w-full sm:w-[280px]">
              <VoiceCorrectionModelField
                label={t('voice.settings.correction.model.label')}
                value={{ providerId: preferences.correctionProviderId, modelId: preferences.correctionModelId }}
                onChange={choose}
                defaultTarget={correction.defaultTarget}
              />
            </div>
          </SettingsRow>
        ) : null}
      </SettingsGroup>
    </SettingsSection>
  )
}
