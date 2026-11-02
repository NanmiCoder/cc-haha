import { useEffect, useState } from 'react'
import { isVoiceCaptureSupported } from '@/features/voiceInput/recorder'
import { Button } from '@/components/ui/Button'
import { ErrorState } from '@/components/ui/ErrorState'
import { LoadingState } from '@/components/ui/LoadingState'
import {
  SettingsBlock,
  SettingsGroup,
  SettingsPageHeader,
  SettingsSection,
} from '@/components/settings/SettingsSection'
import { useTranslation } from '@/i18n'
import { selectActiveVoiceProvider, useVoiceInputStore } from '@/stores/voiceInputStore'
import { recorderErrorKey, useMicrophoneSelection } from './useMicrophoneSelection'
import { VoiceCorrectionSettings } from './VoiceCorrectionSettings'
import { VoiceModelList } from './VoiceModelList'
import { VoicePicker, VoiceSettingRow } from './VoiceSettingsControls'
import { VoiceShortcutSettings } from './VoiceShortcutSettings'
import { VoiceTranscriptionTest } from './VoiceTranscriptionTest'
import { VoiceVocabularySettings } from './VoiceVocabularySettings'

/** Upper bound for one settings test; the server limit can only lower it. */
const TEST_MAX_SECONDS = 30

/**
 * Settings → Voice input. Each section lives in its own file; this page only
 * loads the catalog and lays them out: recognition models, AI correction,
 * personal vocabulary, microphone, shortcut, transcription test.
 */
export function VoiceInputSettings() {
  const t = useTranslation()
  const catalog = useVoiceInputStore(state => state.catalog)
  const storeError = useVoiceInputStore(state => state.error)
  const loadCatalog = useVoiceInputStore(state => state.loadCatalog)

  const [captureSupported] = useState(() => isVoiceCaptureSupported())
  const microphone = useMicrophoneSelection(captureSupported)

  useEffect(() => {
    // Always re-read on entering the tab: models can be removed or downloaded
    // by another window while this page was closed.
    void loadCatalog({ force: true })
  }, [loadCatalog])

  const header = (
    <SettingsPageHeader
      title={t('settings.tab.voice')}
      description={t('voice.settings.description')}
    />
  )

  if (!catalog) {
    return (
      <div className="w-full min-w-0 [&>*+*]:mt-7">
        {header}
        {storeError ? (
          <ErrorState
            size="lg"
            title={t('voice.settings.loadFailed')}
            detail={storeError}
            retryLabel={t('common.retry')}
            onRetry={() => { void loadCatalog({ force: true }) }}
          />
        ) : (
          <LoadingState size="md" label={t('common.loading')} />
        )}
      </div>
    )
  }

  if (!catalog.supported) {
    return (
      <div className="w-full min-w-0 [&>*+*]:mt-7">
        {header}
        <ErrorState
          size="lg"
          tone="strong"
          title={t('voice.settings.unsupported.title')}
          detail={t('voice.settings.unsupported.detail')}
        />
      </div>
    )
  }

  const { preferences, providers, limits } = catalog
  const provider = selectActiveVoiceProvider({ catalog }) ?? providers[0]

  return (
    <div className="w-full min-w-0">
      {header}

      <VoiceModelList catalog={catalog} />
      <VoiceCorrectionSettings catalog={catalog} />
      <VoiceVocabularySettings catalog={catalog} />

      <SettingsSection title={t('voice.settings.mic.title')} description={t('voice.settings.mic.description')}>
        <SettingsGroup>
          {!captureSupported ? (
            <p className="px-4 py-3 text-[13px] leading-5 text-[var(--color-text-tertiary)]">{t('voice.settings.capture.unsupported')}</p>
          ) : (
            <>
              <VoiceSettingRow label={t('voice.settings.mic.label')}>
                <VoicePicker
                  label={t('voice.settings.mic.label')}
                  value={microphone.selectedId}
                  onChange={microphone.select}
                  items={[
                    { value: '', label: t('voice.settings.mic.systemDefault') },
                    // A saved device we cannot verify yet (names and ids stay
                    // hidden until permission) still has to be a real option, or
                    // the picker would claim "system default" while a device is set.
                    ...(microphone.selectedId && !microphone.devices.some(device => device.deviceId === microphone.selectedId)
                      ? [{ value: microphone.selectedId, label: t('voice.settings.mic.savedDevice') }]
                      : []),
                    ...microphone.devices.map((device, index) => ({
                      value: device.deviceId,
                      label: device.label || t('voice.settings.mic.unnamed', { index: index + 1 }),
                    })),
                  ]}
                />
              </VoiceSettingRow>
              {microphone.savedMissing || microphone.error || microphone.noInputDevices || microphone.needsPermission ? (
                <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                  <div className="min-w-0 space-y-1 text-xs leading-[1.5]">
                    {microphone.savedMissing ? (
                      <p role="status" className="text-[var(--color-warning)]">{t('voice.settings.mic.missing')}</p>
                    ) : null}
                    {microphone.error ? (
                      <p role="alert" className="text-[var(--color-error)]">{t(recorderErrorKey({ code: microphone.error }))}</p>
                    ) : microphone.noInputDevices ? (
                      <p className="text-[var(--color-text-tertiary)]">{t('voice.settings.mic.noDevices')}</p>
                    ) : microphone.needsPermission ? (
                      // Before permission the browser hides names (and often the
                      // devices themselves), so this is not a problem to report.
                      <p className="text-[var(--color-text-tertiary)]">{t('voice.settings.mic.allowHint')}</p>
                    ) : null}
                  </div>
                  {microphone.needsPermission ? (
                    <Button
                      variant="secondary"
                      size="base"
                      className="shrink-0 self-start sm:self-auto"
                      loading={microphone.requesting}
                      onClick={() => { void microphone.requestPermission() }}
                    >
                      {t('voice.settings.mic.allowAccess')}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </SettingsGroup>
      </SettingsSection>

      {captureSupported ? <VoiceShortcutSettings /> : null}

      <SettingsSection title={t('voice.settings.test.title')} description={t('voice.settings.test.description')}>
        <SettingsGroup>
          <SettingsBlock className="p-4">
            <VoiceTranscriptionTest
              deviceId={microphone.selectedId || undefined}
              providerId={provider?.info.id ?? preferences.providerId}
              language={preferences.language}
              maxSeconds={Math.max(1, Math.min(TEST_MAX_SECONDS, limits.maxAudioSeconds))}
              ready={provider?.preparation.phase === 'ready'}
              captureSupported={captureSupported}
            />
          </SettingsBlock>
        </SettingsGroup>
      </SettingsSection>
    </div>
  )
}
