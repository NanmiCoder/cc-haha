import { useEffect, useState, type ReactNode } from 'react'
import { isVoiceCaptureSupported } from '@/features/voiceInput/recorder'
import type {
  VoiceDownloadSource,
  VoiceFailureReason,
  VoiceLanguage,
  VoicePreferences,
  VoicePreparationPhase,
  VoicePreparationStep,
  VoiceProviderStatus,
} from '@/api/voice'
import { ChevronDown } from 'lucide-react'
import { Badge, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Dropdown } from '@/components/ui/Dropdown'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { ErrorState } from '@/components/ui/ErrorState'
import { LoadingState } from '@/components/ui/LoadingState'
import { Progress } from '@/components/ui/Progress'
import {
  SettingsBlock,
  SettingsGroup,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsSwitchRow,
} from '@/components/settings/SettingsSection'
import { useTranslation } from '@/i18n'
import type { TranslationKey } from '@/i18n/locales/en'
import { formatBytes } from '@/lib/formatBytes'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import { selectActiveVoiceProvider, useVoiceInputStore } from '@/stores/voiceInputStore'
import type { NetworkProxyMode } from '@/types/settings'
import { recorderErrorKey, useMicrophoneSelection } from './useMicrophoneSelection'
import { VoiceShortcutSettings } from './VoiceShortcutSettings'
import { VoiceTranscriptionTest } from './VoiceTranscriptionTest'

/** Upper bound for one settings test; the server limit can only lower it. */
const TEST_MAX_SECONDS = 30

const PHASE_KEYS: Record<VoicePreparationPhase, TranslationKey> = {
  unprepared: 'voice.settings.phase.unprepared',
  downloading: 'voice.settings.phase.downloading',
  verifying: 'voice.settings.phase.verifying',
  ready: 'voice.settings.phase.ready',
  failed: 'voice.settings.phase.failed',
  cancelled: 'voice.settings.phase.cancelled',
}

const PHASE_TONES: Record<VoicePreparationPhase, Tone> = {
  unprepared: 'neutral',
  // In progress reads as info app-wide; terracotta is never a status.
  downloading: 'info',
  verifying: 'info',
  ready: 'success',
  failed: 'danger',
  cancelled: 'warning',
}

const STEP_KEYS: Record<VoicePreparationStep, TranslationKey> = {
  runtime: 'voice.settings.step.runtime',
  model: 'voice.settings.step.model',
  vad: 'voice.settings.step.vad',
  verify: 'voice.settings.step.verify',
}

const FAILURE_KEYS: Record<VoiceFailureReason, TranslationKey> = {
  network: 'voice.settings.failure.network',
  dns: 'voice.settings.failure.dns',
  timeout: 'voice.settings.failure.timeout',
  certificate: 'voice.settings.failure.certificate',
  http: 'voice.settings.failure.http',
  integrity: 'voice.settings.failure.integrity',
  storage: 'voice.settings.failure.storage',
  'unsupported-platform': 'voice.settings.failure.unsupportedPlatform',
  unknown: 'voice.settings.failure.unknown',
}

const DOWNLOAD_SOURCE_KEYS: Record<VoiceDownloadSource, TranslationKey> = {
  auto: 'voice.settings.downloadSource.auto',
  official: 'voice.settings.downloadSource.official',
  mirror: 'voice.settings.downloadSource.mirror',
}

const PROXY_MODE_KEYS: Record<NetworkProxyMode, TranslationKey> = {
  direct: 'settings.general.networkProxyModeDirect',
  system: 'settings.general.networkProxyModeSystem',
  manual: 'settings.general.networkProxyModeManual',
}

/** Failures that a later retry can plausibly fix without touching the machine. */
const RESUMABLE_FAILURES = new Set<VoiceFailureReason>(['network', 'dns', 'timeout', 'certificate', 'http'])

const LANGUAGE_KEYS: Record<VoiceLanguage, TranslationKey> = {
  auto: 'voice.settings.language.auto',
  zh: 'voice.settings.language.zh',
  en: 'voice.settings.language.en',
  ja: 'voice.settings.language.ja',
  ko: 'voice.settings.language.ko',
  yue: 'voice.settings.language.yue',
}

export function VoiceInputSettings() {
  const t = useTranslation()
  const catalog = useVoiceInputStore(state => state.catalog)
  const storeError = useVoiceInputStore(state => state.error)
  const loadCatalog = useVoiceInputStore(state => state.loadCatalog)
  const updatePreferences = useVoiceInputStore(state => state.updatePreferences)
  const prepare = useVoiceInputStore(state => state.prepare)
  const cancelPrepare = useVoiceInputStore(state => state.cancelPrepare)
  const removeAssets = useVoiceInputStore(state => state.removeAssets)

  const [captureSupported] = useState(() => isVoiceCaptureSupported())
  const [saveFailed, setSaveFailed] = useState(false)
  const [actionPending, setActionPending] = useState(false)
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false)
  const microphone = useMicrophoneSelection(captureSupported)
  const networkProxy = useSettingsStore(state => state.network.proxy)

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
  const phase = provider?.preparation.phase
  const modelReady = phase === 'ready'
  const languages = provider ? withCurrent(provider.info.languages, preferences.language) : []

  const savePreferences = async (patch: Partial<VoicePreferences>) => {
    setSaveFailed(false)
    try {
      await updatePreferences(patch)
    } catch {
      setSaveFailed(true)
    }
  }

  const changeProvider = (providerId: string) => {
    const next = providers.find(item => item.info.id === providerId)
    if (!next) return
    const patch: Partial<VoicePreferences> = { providerId }
    if (!next.info.languages.includes(preferences.language)) {
      patch.language = next.info.languages.includes('auto') ? 'auto' : next.info.languages[0]
    }
    void savePreferences(patch)
  }

  const runAction = async (action: () => Promise<void>) => {
    setActionPending(true)
    try {
      await action()
    } finally {
      setActionPending(false)
    }
  }

  const enableNotice = preferences.enabled && !modelReady && phase !== 'downloading' && phase !== 'verifying'

  return (
    <div className="w-full min-w-0">
      {header}

      <SettingsSection title={t('voice.settings.engine.title')} description={t('voice.settings.engine.description')}>
        <SettingsGroup>
          <SettingsSwitchRow
            title={t('voice.settings.enable.label')}
            description={t('voice.settings.enable.description')}
            checked={preferences.enabled}
            onChange={(enabled) => { void savePreferences({ enabled }) }}
            footer={enableNotice || saveFailed ? (
              <div className="space-y-1 text-xs leading-[1.5]">
                {enableNotice ? (
                  <p role="status" className="text-[var(--color-warning)]">
                    {t('voice.settings.enable.needModel')}
                  </p>
                ) : null}
                {saveFailed ? (
                  <p role="alert" className="text-[var(--color-error)]">
                    {t('voice.settings.saveFailed')}
                  </p>
                ) : null}
              </div>
            ) : undefined}
          />

          {provider ? (
            <>
              <SettingRow label={t('voice.settings.engine.provider')}>
                <Picker
                  label={t('voice.settings.engine.provider')}
                  value={provider.info.id}
                  onChange={changeProvider}
                  items={providers.map(item => ({ value: item.info.id, label: item.info.name }))}
                />
              </SettingRow>
              <ModelStatus
                provider={provider}
                pending={actionPending}
                onDownload={() => runAction(() => prepare(provider.info.id))}
                onCancel={() => runAction(() => cancelPrepare(provider.info.id))}
                onRemove={() => setRemoveConfirmOpen(true)}
              />
              {provider.info.location === 'local' && !modelReady ? (
                <SettingRow
                  label={t('voice.settings.downloadSource.label')}
                  hint={
                    <>
                      {t('voice.settings.downloadSource.proxyHint', {
                        mode: networkProxy.mode === 'manual' && networkProxy.url
                          ? `${t(PROXY_MODE_KEYS.manual)} ${networkProxy.url}`
                          : t(PROXY_MODE_KEYS[networkProxy.mode]),
                      })}{' '}
                      <button
                        type="button"
                        className="font-medium text-[var(--color-text-accent)] hover:underline"
                        onClick={() => useUIStore.getState().setActiveSettingsTab('general')}
                      >
                        {t('voice.settings.downloadSource.changeProxy')}
                      </button>
                    </>
                  }
                >
                  <Picker
                    label={t('voice.settings.downloadSource.label')}
                    value={preferences.downloadSource}
                    onChange={(downloadSource) => { void savePreferences({ downloadSource }) }}
                    items={(Object.keys(DOWNLOAD_SOURCE_KEYS) as VoiceDownloadSource[])
                      .map(source => ({ value: source, label: t(DOWNLOAD_SOURCE_KEYS[source]) }))}
                  />
                </SettingRow>
              ) : null}
              {storeError ? (
                <SettingsBlock>
                  <ErrorState size="sm" title={t('voice.settings.actionFailed')} detail={storeError} />
                </SettingsBlock>
              ) : null}
              <SettingRow label={t('voice.settings.language.label')}>
                <Picker
                  label={t('voice.settings.language.label')}
                  value={preferences.language}
                  onChange={(language) => { void savePreferences({ language }) }}
                  items={languages.map(code => ({ value: code, label: languageLabel(t, code) }))}
                />
              </SettingRow>
            </>
          ) : null}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title={t('voice.settings.mic.title')} description={t('voice.settings.mic.description')}>
        <SettingsGroup>
          {!captureSupported ? (
            <p className="px-4 py-3 text-[13px] leading-5 text-[var(--color-text-tertiary)]">{t('voice.settings.capture.unsupported')}</p>
          ) : (
            <>
              <SettingRow label={t('voice.settings.mic.label')}>
                <Picker
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
              </SettingRow>
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
              ready={modelReady}
              captureSupported={captureSupported}
            />
          </SettingsBlock>
        </SettingsGroup>
      </SettingsSection>

      <ConfirmDialog
        open={removeConfirmOpen && !!provider}
        onClose={() => setRemoveConfirmOpen(false)}
        loading={actionPending}
        onConfirm={async () => {
          if (provider) await runAction(() => removeAssets(provider.info.id))
          setRemoveConfirmOpen(false)
        }}
        title={t('voice.settings.model.removeTitle')}
        body={t('voice.settings.model.removeBody')}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
      />
    </div>
  )
}

type PickerItem<T extends string> = { value: T; label: string }

/**
 * One "name on the left, picker on the right" row of the shared settings
 * skeleton; the hint is a `<p>` so its inline "Change proxy" link reads as part
 * of the sentence.
 */
function SettingRow({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <SettingsRow title={label} description={hint ? <p>{hint}</p> : undefined}>
      <div className="w-full sm:w-[240px]">{children}</div>
    </SettingsRow>
  )
}

/** The library Dropdown (not the native select, whose menu is the OS's own); `label` is its accessible name. */
function Picker<T extends string>({ label, value, items, onChange }: {
  label: string
  value: T
  items: PickerItem<T>[]
  onChange: (value: T) => void
}) {
  const selected = items.find(item => item.value === value)
  return (
    <Dropdown<T>
      items={items}
      value={value}
      onChange={onChange}
      label={label}
      width="100%"
      maxHeight={320}
      className="block w-full"
      trigger={
        <Button variant="secondary" size="base" block className="gap-2" aria-label={label}>
          <span className="min-w-0 flex-1 truncate text-left">{selected?.label ?? ''}</span>
          <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
        </Button>
      }
    />
  )
}

/** Keeps a saved language selectable even if the provider stopped advertising it. */
function withCurrent(languages: VoiceLanguage[], current: VoiceLanguage): VoiceLanguage[] {
  return languages.includes(current) ? languages : [...languages, current]
}

function languageLabel(t: (key: TranslationKey) => string, code: string): string {
  const key = (LANGUAGE_KEYS as Record<string, TranslationKey | undefined>)[code]
  return key ? t(key) : code
}

type ModelStatusProps = {
  provider: VoiceProviderStatus
  pending: boolean
  onDownload: () => void
  onCancel: () => void
  onRemove: () => void
}

function ModelStatus({ provider, pending, onDownload, onCancel, onRemove }: ModelStatusProps) {
  const t = useTranslation()
  const { info, preparation } = provider
  const { phase } = preparation
  const total = preparation.totalBytes ?? 0
  const completed = preparation.completedBytes ?? 0
  const percent = total > 0 ? (completed / total) * 100 : undefined
  const error = preparation.error
  // Abandoned or failed downloads leave a partial file (up to the full model size) on disk.
  const hasPartial = (phase === 'unprepared' || phase === 'cancelled' || phase === 'failed') && completed > 0
  const canRetry = phase === 'failed' && error?.reason !== 'unsupported-platform'

  // One row: what it is on the left, what can be done about it on the right.
  const removeButton = (
    <Button variant="danger-ghost" size="base" onClick={onRemove}>
      {t('voice.settings.model.remove')}
    </Button>
  )

  return (
    <div
      data-testid="voice-model-status"
      data-phase={phase}
      className="min-h-[52px] space-y-2 px-4 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-[13px] font-medium text-[var(--color-text-primary)]">{info.name}</span>
          <Badge tone={PHASE_TONES[phase]} size="sm">{t(PHASE_KEYS[phase])}</Badge>
        </div>
        <div className="flex items-center gap-2">
          {phase === 'unprepared' ? (
            <Button variant="primary" size="base" loading={pending} onClick={onDownload}>
              {t('voice.settings.model.download')}
            </Button>
          ) : null}
          {phase === 'downloading' ? (
            <Button variant="secondary" size="base" loading={pending} onClick={onCancel}>
              {t('common.cancel')}
            </Button>
          ) : null}
          {canRetry ? (
            <Button variant="primary" size="base" loading={pending} onClick={onDownload}>
              {t('common.retry')}
            </Button>
          ) : null}
          {phase === 'cancelled' ? (
            <Button variant="primary" size="base" loading={pending} onClick={onDownload}>
              {t('voice.settings.model.resume')}
            </Button>
          ) : null}
          {phase === 'ready' || hasPartial ? removeButton : null}
        </div>
      </div>

      {info.location === 'local' && info.downloadBytes ? (
        <p className="text-xs text-[var(--color-text-tertiary)]">
          {t('voice.settings.model.meta', { size: formatBytes(info.downloadBytes) })}
        </p>
      ) : null}

      {phase === 'unprepared' ? (
        <p className="text-[13px] leading-5 text-[var(--color-text-secondary)]">{t('voice.settings.model.unprepared')}</p>
      ) : null}

      {phase === 'downloading' ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[13px] text-[var(--color-text-secondary)]">
            <span className="min-w-0 break-all">
              {preparation.step ? t(STEP_KEYS[preparation.step]) : t('voice.settings.model.downloading')}
              {preparation.resource ? <span className="text-[var(--color-text-tertiary)]">{` · ${preparation.resource}`}</span> : null}
            </span>
            {total > 0 ? (
              <span className="shrink-0 tabular-nums">
                {t('voice.settings.model.progress', { completed: formatBytes(completed), total: formatBytes(total) })}
              </span>
            ) : null}
          </div>
          <Progress
            label={t('voice.settings.model.downloading')}
            value={percent}
            indeterminate={percent === undefined}
            size="md"
          />
          {preparation.resumedFromBytes ? (
            <p className="text-xs text-[var(--color-text-tertiary)]">
              {t('voice.settings.model.resumed', { size: formatBytes(preparation.resumedFromBytes) })}
            </p>
          ) : null}
          {preparation.source ? (
            <p className="break-all text-xs text-[var(--color-text-tertiary)]">
              {t('voice.settings.model.source', { source: preparation.source })}
            </p>
          ) : null}
        </div>
      ) : null}

      {phase === 'verifying' ? (
        <div className="space-y-2">
          <p className="text-[13px] leading-5 text-[var(--color-text-secondary)]">{t('voice.settings.model.verifying')}</p>
          <Progress label={t('voice.settings.model.verifying')} indeterminate size="md" />
        </div>
      ) : null}

      {phase === 'ready' ? (
        <p className="text-[13px] leading-5 text-[var(--color-text-secondary)]">{t('voice.settings.model.ready')}</p>
      ) : null}

      {phase === 'failed' ? (
        <div className="space-y-1">
          <p role="alert" className="text-[13px] font-medium leading-5 text-[var(--color-error)]">
            {t(FAILURE_KEYS[error?.reason ?? 'unknown'])}
          </p>
          {error?.message ? (
            <p className="break-words text-xs leading-5 text-[var(--color-text-tertiary)]">{error.message}</p>
          ) : null}
          {error?.source ? (
            <p className="break-all text-xs text-[var(--color-text-tertiary)]">
              {t('voice.settings.model.source', { source: error.source })}
            </p>
          ) : null}
          {error && RESUMABLE_FAILURES.has(error.reason) ? (
            <p className="text-xs text-[var(--color-text-tertiary)]">{t('voice.settings.model.resumeHint')}</p>
          ) : null}
        </div>
      ) : null}

      {phase === 'cancelled' ? (
        <p className="text-[13px] leading-5 text-[var(--color-text-secondary)]">{t('voice.settings.model.cancelled')}</p>
      ) : null}
    </div>
  )
}
