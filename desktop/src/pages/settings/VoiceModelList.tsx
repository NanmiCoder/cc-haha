import { useId, useState } from 'react'
import { Check, Download, Trash2 } from 'lucide-react'
import type {
  VoiceCatalog,
  VoiceDownloadSource,
  VoiceFailureReason,
  VoiceLanguage,
  VoicePreferences,
  VoicePreparationStep,
  VoiceProviderStatus,
} from '@/api/voice'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { ErrorState } from '@/components/ui/ErrorState'
import { IconButton } from '@/components/ui/IconButton'
import { Progress } from '@/components/ui/Progress'
import {
  SettingsBlock,
  SettingsGroup,
  SettingsSection,
  SettingsSwitchRow,
} from '@/components/settings/SettingsSection'
import { useTranslation } from '@/i18n'
import type { TranslationKey } from '@/i18n/locales/en'
import { formatBytes } from '@/lib/formatBytes'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import { useVoiceInputStore } from '@/stores/voiceInputStore'
import type { NetworkProxyMode } from '@/types/settings'
import { DEFAULT_VOICE_PROVIDER_ID, voiceModelCopy } from './voiceModelCopy'
import { VoicePicker, VoiceSettingRow } from './VoiceSettingsControls'

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

const LANGUAGE_KEYS: Record<VoiceLanguage, TranslationKey> = {
  auto: 'voice.settings.language.auto',
  zh: 'voice.settings.language.zh',
  en: 'voice.settings.language.en',
  ja: 'voice.settings.language.ja',
  ko: 'voice.settings.language.ko',
  yue: 'voice.settings.language.yue',
}

/** Failures that a later retry can plausibly fix without touching the machine. */
const RESUMABLE_FAILURES = new Set<VoiceFailureReason>(['network', 'dns', 'timeout', 'certificate', 'http'])

/** Keeps a saved language selectable even if the provider stopped advertising it. */
function withCurrent(languages: VoiceLanguage[], current: VoiceLanguage): VoiceLanguage[] {
  return languages.includes(current) ? languages : [...languages, current]
}

function languageLabel(t: (key: TranslationKey) => string, code: string): string {
  const key = (LANGUAGE_KEYS as Record<string, TranslationKey | undefined>)[code]
  return key ? t(key) : code
}

/**
 * Settings → Voice input → Recognition model: the on switch, then every local
 * model as one radio row that carries its own download state. Only a
 * downloaded model can be picked; the language and download source rows below
 * apply to whichever is in use.
 */
export function VoiceModelList({ catalog }: { catalog: VoiceCatalog }) {
  const t = useTranslation()
  const storeError = useVoiceInputStore(state => state.error)
  const updatePreferences = useVoiceInputStore(state => state.updatePreferences)
  const prepare = useVoiceInputStore(state => state.prepare)
  const cancelPrepare = useVoiceInputStore(state => state.cancelPrepare)
  const removeAssets = useVoiceInputStore(state => state.removeAssets)
  const networkProxy = useSettingsStore(state => state.network.proxy)
  const groupName = useId()

  const [saveFailed, setSaveFailed] = useState(false)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [removeId, setRemoveId] = useState<string | null>(null)

  const { preferences, providers } = catalog
  const active = providers.find(item => item.info.id === preferences.providerId) ?? providers[0]
  const activePhase = active?.preparation.phase
  const enableNotice = preferences.enabled && activePhase !== 'ready' && activePhase !== 'downloading' && activePhase !== 'verifying'
  const languages = active ? withCurrent(active.info.languages, preferences.language) : []
  // A model that only detects the language itself has nothing to choose.
  const languageFixed = !!active && active.info.languages.every(code => code === 'auto')
  const showSource = providers.some(item => item.info.location === 'local' && item.preparation.phase !== 'ready')
  const removing = providers.find(item => item.info.id === removeId) ?? null

  const savePreferences = async (patch: Partial<VoicePreferences>) => {
    setSaveFailed(false)
    try {
      await updatePreferences(patch)
    } catch {
      setSaveFailed(true)
    }
  }

  const selectProvider = (providerId: string) => {
    const next = providers.find(item => item.info.id === providerId)
    if (!next || providerId === preferences.providerId) return
    const patch: Partial<VoicePreferences> = { providerId }
    if (!next.info.languages.includes(preferences.language)) {
      patch.language = next.info.languages.includes('auto') ? 'auto' : next.info.languages[0]
    }
    void savePreferences(patch)
  }

  const runAction = async (providerId: string, action: () => Promise<void>) => {
    setPendingId(providerId)
    try {
      await action()
    } finally {
      setPendingId(null)
    }
  }

  const confirmRemove = async () => {
    if (!removing) return
    const providerId = removing.info.id
    await runAction(providerId, () => removeAssets(providerId))
    setRemoveId(null)
    // Deleting the model in use leaves dictation with nothing to run; go back
    // to the default model rather than to a dead choice.
    const after = useVoiceInputStore.getState().catalog
    const removed = after?.providers.find(item => item.info.id === providerId)
    if (
      after?.preferences.providerId === providerId &&
      providerId !== DEFAULT_VOICE_PROVIDER_ID &&
      removed?.preparation.phase !== 'ready'
    ) {
      selectProvider(DEFAULT_VOICE_PROVIDER_ID)
    }
  }

  const proxyMode = networkProxy.mode === 'manual' && networkProxy.url
    ? `${t(PROXY_MODE_KEYS.manual)} ${networkProxy.url}`
    : t(PROXY_MODE_KEYS[networkProxy.mode])

  return (
    <SettingsSection title={t('voice.settings.models.title')} description={t('voice.settings.models.description')}>
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
        <div role="radiogroup" aria-label={t('voice.settings.models.title')} className="divide-y divide-[var(--color-border)]">
          {providers.map(provider => (
            <VoiceModelRow
              key={provider.info.id}
              provider={provider}
              active={provider.info.id === active?.info.id}
              groupName={groupName}
              pending={pendingId === provider.info.id}
              onSelect={() => selectProvider(provider.info.id)}
              onDownload={() => { void runAction(provider.info.id, () => prepare(provider.info.id)) }}
              onPause={() => { void runAction(provider.info.id, () => cancelPrepare(provider.info.id)) }}
              onRemove={() => setRemoveId(provider.info.id)}
            />
          ))}
        </div>
        {storeError ? (
          <SettingsBlock>
            <ErrorState size="sm" title={t('voice.settings.actionFailed')} detail={storeError} />
          </SettingsBlock>
        ) : null}
      </SettingsGroup>

      {active ? (
        <SettingsGroup className="mt-2">
          <VoiceSettingRow
            label={t('voice.settings.language.label')}
            hint={languageFixed ? t('voice.settings.language.autoOnly', { name: active.info.name }) : undefined}
          >
            <VoicePicker
              label={t('voice.settings.language.label')}
              value={preferences.language}
              disabled={languageFixed}
              onChange={(language) => { void savePreferences({ language }) }}
              items={languages.map(code => ({ value: code, label: languageLabel(t, code) }))}
            />
          </VoiceSettingRow>
          {showSource ? (
            <VoiceSettingRow
              label={t('voice.settings.downloadSource.label')}
              hint={
                <>
                  {t('voice.settings.downloadSource.allModelsHint', { mode: proxyMode })}{' '}
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
              <VoicePicker
                label={t('voice.settings.downloadSource.label')}
                value={preferences.downloadSource}
                onChange={(downloadSource) => { void savePreferences({ downloadSource }) }}
                items={(Object.keys(DOWNLOAD_SOURCE_KEYS) as VoiceDownloadSource[])
                  .map(source => ({ value: source, label: t(DOWNLOAD_SOURCE_KEYS[source]) }))}
              />
            </VoiceSettingRow>
          ) : null}
        </SettingsGroup>
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoveId(null)}
        loading={pendingId !== null && pendingId === removeId}
        onConfirm={confirmRemove}
        title={t('voice.settings.model.removeNamedTitle', { name: removing?.info.name ?? '' })}
        body={
          removing && removing.info.id === active?.info.id && removing.info.id !== DEFAULT_VOICE_PROVIDER_ID
            ? `${t('voice.settings.model.removeBody')} ${t('voice.settings.model.removeActiveNote', {
              name: providers.find(item => item.info.id === DEFAULT_VOICE_PROVIDER_ID)?.info.name ?? DEFAULT_VOICE_PROVIDER_ID,
            })}`
            : t('voice.settings.model.removeBody')
        }
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
      />
    </SettingsSection>
  )
}

type VoiceModelRowProps = {
  provider: VoiceProviderStatus
  active: boolean
  groupName: string
  pending: boolean
  onSelect: () => void
  onDownload: () => void
  onPause: () => void
  onRemove: () => void
}

/** One model: what it is on the left, what can be done about it on the right, progress underneath. */
function VoiceModelRow({ provider, active, groupName, pending, onSelect, onDownload, onPause, onRemove }: VoiceModelRowProps) {
  const t = useTranslation()
  const nameId = useId()
  const detailId = useId()
  const { info, preparation } = provider
  const { phase } = preparation
  const copy = voiceModelCopy(info.id)
  const total = preparation.totalBytes ?? 0
  const completed = preparation.completedBytes ?? 0
  const percent = total > 0 ? (completed / total) * 100 : undefined
  const error = preparation.error
  // Abandoned or failed downloads leave a partial file (up to the full model size) on disk.
  const hasPartial = (phase === 'unprepared' || phase === 'cancelled' || phase === 'failed') && completed > 0
  const canRetry = phase === 'failed' && error?.reason !== 'unsupported-platform'
  const size = info.location === 'local' && info.downloadBytes ? formatBytes(info.downloadBytes) : null

  const meta = copy
    ? [
      size ? `${t(copy.vendor)} · ${size}` : t(copy.vendor),
      t('voice.settings.model.sentenceSpeed', { seconds: copy.sentenceSeconds }),
      t('voice.settings.model.memory', { memory: copy.memoryGb }),
    ]
    : size ? [t('voice.settings.model.meta', { size })] : []

  const removeButton = (
    <IconButton
      icon={<Trash2 size={15} strokeWidth={1.75} aria-hidden="true" />}
      label={t('voice.settings.model.removeNamed', { name: info.name })}
      size="sm"
      tone="muted"
      hoverTone="danger"
      onClick={onRemove}
    />
  )

  return (
    <div
      data-testid="voice-model-row"
      data-provider={info.id}
      data-phase={phase}
      data-active={active || undefined}
      className="flex items-start gap-3 px-4 py-3.5"
    >
      <input
        type="radio"
        name={groupName}
        checked={active}
        // Only a downloaded model can run; the one in use stays marked even
        // while it is being (re)downloaded.
        disabled={phase !== 'ready'}
        onChange={onSelect}
        aria-labelledby={nameId}
        aria-describedby={detailId}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] disabled:cursor-not-allowed"
      />

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span id={nameId} className="min-w-0 text-[13px] font-medium leading-5 text-[var(--color-text-primary)]">{info.name}</span>
          {info.id === DEFAULT_VOICE_PROVIDER_ID ? <Badge tone="neutral" size="xs">{t('voice.settings.model.defaultBadge')}</Badge> : null}
          {active ? <Badge tone="success" size="xs">{t('voice.settings.model.activeBadge')}</Badge> : null}
        </div>
        <div id={detailId} className="space-y-0.5 text-xs leading-[1.5] text-[var(--color-text-tertiary)]">
          {copy ? <p>{t(copy.description)}</p> : null}
          {meta.length > 0 ? <p>{meta.join(' · ')}</p> : null}
          {phase === 'ready' && !active ? <p>{t('voice.settings.model.switchHint')}</p> : null}
        </div>

        {phase === 'downloading' ? (
          <div className="space-y-1.5 pt-1.5">
            <div className="flex items-center gap-3">
              <Progress
                label={t('voice.settings.model.downloadProgress', { name: info.name })}
                value={percent}
                indeterminate={percent === undefined}
                size="sm"
                className="min-w-0 flex-1"
              />
              {total > 0 ? (
                <span className="shrink-0 text-xs tabular-nums text-[var(--color-text-tertiary)]">
                  {t('voice.settings.model.progress', { completed: formatBytes(completed), total: formatBytes(total) })}
                </span>
              ) : null}
            </div>
            <p className="break-all text-xs text-[var(--color-text-tertiary)]">
              {preparation.step ? t(STEP_KEYS[preparation.step]) : t('voice.settings.model.downloading')}
              {preparation.resource ? ` · ${preparation.resource}` : ''}
            </p>
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
          <div className="space-y-1.5 pt-1.5">
            <Progress label={t('voice.settings.model.verifying')} indeterminate size="sm" />
            <p className="text-xs text-[var(--color-text-tertiary)]">{t('voice.settings.model.verifying')}</p>
          </div>
        ) : null}

        {phase === 'failed' ? (
          <div className="space-y-0.5 pt-1">
            <p role="alert" className="text-xs font-medium leading-5 text-[var(--color-error)]">
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
          <p className="pt-1 text-xs text-[var(--color-text-secondary)]">{t('voice.settings.model.cancelled')}</p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {phase === 'ready' ? (
          <span className="inline-flex items-center gap-1 text-xs text-[var(--color-success)]">
            <Check size={14} strokeWidth={1.75} aria-hidden="true" />
            {t('voice.settings.model.downloaded')}
          </span>
        ) : null}
        {phase === 'unprepared' ? (
          <Button
            variant="primary"
            size="base"
            icon={<Download size={14} strokeWidth={1.75} aria-hidden="true" />}
            loading={pending}
            aria-label={t('voice.settings.model.downloadNamed', { name: info.name })}
            onClick={onDownload}
          >
            {t('voice.settings.model.download')}
          </Button>
        ) : null}
        {phase === 'downloading' ? (
          <Button variant="secondary" size="base" loading={pending} onClick={onPause}>
            {t('voice.settings.model.pause')}
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
  )
}
