import { useEffect, useId, useMemo, useState } from 'react'
import { Check, CircleAlert } from 'lucide-react'

import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { SearchField } from '@/components/ui/SearchField'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { SelectField } from '@/components/ui/SelectField'
import { cx } from '@/lib/cx'
import { useTranslation } from '../../i18n'
import { getAutoCompactWindowErrorKey, parseAutoCompactWindowInput } from '../../lib/providerModelContext'
import { useProviderStore } from '../../stores/providerStore'
import { useSettingsStore } from '../../stores/settingsStore'
import {
  MAGPIE_PRESET_ID,
  formatTokenLimit,
  groupMagpieModels,
  useMagpieStore,
} from '../../stores/magpieStore'
import type { MagpieModel, ModelMapping, SavedProvider } from '../../types/provider'

/** Magpie's own default for Claude Code on models with a longer window (its "working window"). */
export const MAGPIE_WORKING_WINDOW = 272_000

type CompactMode = 'full' | 'working' | 'custom'

function compactModeOf(window: number | undefined): CompactMode {
  if (window === undefined) return 'full'
  return window === MAGPIE_WORKING_WINDOW ? 'working' : 'custom'
}

function matchesQuery(model: MagpieModel, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const text = [model.displayName, model.id, model.providerName ?? '', model.provider].join('\n').toLowerCase()
  return terms.every((term) => text.includes(term))
}

const TAG = 'inline-flex h-[18px] items-center rounded-[var(--radius-xs)] px-1.5 text-[11px]'
const TAG_NEUTRAL = cx(TAG, 'bg-[var(--color-surface-container)] text-[var(--color-text-tertiary)]')
const TAG_WARNING = cx(TAG, 'bg-[var(--color-warning-container)] text-[var(--color-on-warning-container)]')

/**
 * Connects Magpie (no provider passed) or edits the saved Magpie provider.
 * The catalog, each model's window and reply limit come from the gateway; the
 * user only picks the main model, the background model and when to compact.
 */
export function MagpieProviderDialog({
  open,
  onClose,
  provider,
}: {
  open: boolean
  onClose: () => void
  provider?: SavedProvider
}) {
  const t = useTranslation()
  const editing = provider !== undefined
  const state = useMagpieStore((store) => store.state)
  const loading = useMagpieStore((store) => store.loading)
  const refresh = useMagpieStore((store) => store.refresh)
  const openApp = useMagpieStore((store) => store.open)
  const createProvider = useProviderStore((store) => store.createProvider)
  const updateProvider = useProviderStore((store) => store.updateProvider)
  const activateProvider = useProviderStore((store) => store.activateProvider)
  const fetchSettings = useSettingsStore((store) => store.fetchAll)
  const backgroundId = useId()

  const [query, setQuery] = useState('')
  const [main, setMain] = useState(provider?.models.main ?? '')
  const [background, setBackground] = useState(
    provider && provider.models.haiku !== provider.models.main ? provider.models.haiku : '',
  )
  const [compactMode, setCompactMode] = useState<CompactMode>(compactModeOf(provider?.autoCompactWindow))
  const [customCompact, setCustomCompact] = useState(
    compactModeOf(provider?.autoCompactWindow) === 'custom' ? String(provider?.autoCompactWindow) : '',
  )
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [openUnsupported, setOpenUnsupported] = useState(false)

  useEffect(() => {
    if (open) void refresh({ force: true })
  }, [open, refresh])

  const status = state?.status
  const running = status?.running === true
  const models = useMemo(() => state?.models ?? [], [state])
  const groups = useMemo(
    () => groupMagpieModels(models.filter((model) => matchesQuery(model, query))),
    [models, query],
  )
  const selected = models.find((model) => model.runtimeId === main)
  const unknownWindow = models.filter((model) => !model.isGroup && model.contextWindow === undefined)
  const customError = compactMode === 'custom' ? getAutoCompactWindowErrorKey(customCompact) : null
  const customMissing = compactMode === 'custom' && parseAutoCompactWindowInput(customCompact) === undefined

  const handleOpenApp = async () => {
    const result = await openApp()
    if (result.unsupported) setOpenUnsupported(true)
    else void refresh({ force: true })
  }

  const handleSave = async () => {
    if (!main || !status) return
    setSaving(true)
    setFailed(false)
    const mapping: ModelMapping = { main, haiku: background || main, sonnet: main, opus: main }
    const autoCompactWindow = compactMode === 'full'
      ? null
      : compactMode === 'working'
        ? MAGPIE_WORKING_WINDOW
        : parseAutoCompactWindowInput(customCompact) ?? null
    try {
      if (editing) {
        await updateProvider(provider.id, { models: mapping, autoCompactWindow })
      } else {
        const created = await createProvider({
          presetId: MAGPIE_PRESET_ID,
          name: 'Magpie',
          apiKey: '',
          baseUrl: status.baseUrl,
          apiFormat: 'anthropic',
          models: mapping,
          ...(autoCompactWindow !== null && { autoCompactWindow }),
        })
        // The server writes each model's window and reply limit onto the new
        // provider when it reads the catalog; do that before it becomes the
        // default so the settings it syncs already carry them.
        await refresh({ force: true })
        await activateProvider(created.id)
        await fetchSettings()
      }
      onClose()
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  const modelTags = (model: MagpieModel) => (
    <span className="flex shrink-0 flex-wrap justify-end gap-1.5">
      {model.contextWindow !== undefined ? (
        <span className={TAG_NEUTRAL}>{t('settings.providers.magpie.contextTag', { size: formatTokenLimit(model.contextWindow) })}</span>
      ) : model.isGroup ? null : (
        <span className={TAG_WARNING}>{t('settings.providers.magpie.unknownContext')}</span>
      )}
      {model.reasoningEfforts.length > 0 && <span className={TAG_NEUTRAL}>{t('settings.providers.magpie.reasoningTag')}</span>}
      {model.images && <span className={TAG_NEUTRAL}>{t('settings.providers.magpie.imagesTag')}</span>}
    </span>
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t(editing ? 'settings.providers.magpie.editTitle' : 'settings.providers.magpie.connectTitle')}
      width={600}
      typography="interface"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
          <Button
            onClick={() => void handleSave()}
            loading={saving}
            disabled={!main || !running || customMissing}
          >
            {t(editing ? 'common.save' : 'settings.providers.magpie.connectAndActivate')}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        {status && running && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--color-text-tertiary)]">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-[var(--color-success)]" />
            <span>{t('settings.providers.magpie.running', { count: models.length })}</span>
            <span className="font-mono text-[11px]">{status.baseUrl}</span>
          </div>
        )}
        {!editing && running && (
          <p className="text-[13px] leading-5 text-[var(--color-text-secondary)]">{t('settings.providers.magpie.connectDescription')}</p>
        )}

        {status && !running ? (
          <div role="status" className="rounded-[var(--radius-lg)] bg-[var(--color-surface-container)] px-4 py-3">
            <div className="text-sm font-semibold text-[var(--color-text-primary)]">{t('settings.providers.magpie.notRunningTitle')}</div>
            <p className="mt-1 text-[13px] leading-5 text-[var(--color-text-secondary)]">
              {t(openUnsupported ? 'settings.providers.magpie.openAppManually' : 'settings.providers.magpie.notRunningBody')}
            </p>
            <div className="mt-3 flex gap-2">
              {!openUnsupported && (
                <Button variant="secondary" size="sm" onClick={() => void handleOpenApp()}>{t('settings.providers.magpie.openApp')}</Button>
              )}
              <Button variant="ghost" size="sm" loading={loading} onClick={() => void refresh({ force: true })}>
                {t('settings.providers.magpie.recheck')}
              </Button>
            </div>
          </div>
        ) : running ? (
          <>
            <SearchField
              value={query}
              onChange={setQuery}
              label={t('settings.providers.magpie.searchLabel')}
              clearLabel={t('settings.providers.search.clear')}
              placeholder={t('settings.providers.magpie.searchPlaceholder', { count: models.length })}
            />
            <div
              role="radiogroup"
              aria-label={t('settings.providers.mainModel')}
              className="max-h-[320px] overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] p-1"
            >
              {models.length === 0 ? (
                <p className="px-3 py-6 text-center text-[13px] text-[var(--color-text-tertiary)]">{t('settings.providers.magpie.noModels')}</p>
              ) : groups.map((group) => (
                <div key={group.key}>
                  <div className="px-2.5 pb-1 pt-2.5 text-xs font-semibold text-[var(--color-text-tertiary)]">
                    {group.label ?? t('settings.providers.magpie.routingGroups')}
                  </div>
                  {group.models.map((model) => {
                    const isSelected = model.runtimeId === main
                    return (
                      <button
                        key={model.id}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        onClick={() => setMain(model.runtimeId)}
                        className={cx(
                          'flex w-full items-center gap-3 rounded-[var(--radius-md)] px-2.5 py-1.5 text-left transition-colors duration-150',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]',
                          isSelected ? 'bg-[var(--color-surface-hover)]' : 'hover:bg-[var(--color-surface-hover)]',
                        )}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-[var(--color-text-primary)]">{model.displayName}</span>
                          <span className="block truncate font-mono text-[11px] text-[var(--color-text-tertiary)]">{model.id}</span>
                        </span>
                        {modelTags(model)}
                        <Check
                          aria-hidden="true"
                          size={14}
                          strokeWidth={2}
                          className={cx('shrink-0 text-[var(--color-brand)]', !isSelected && 'invisible')}
                        />
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>

            {selected && !selected.isGroup && selected.contextWindow === undefined && (
              <div role="note" className="flex gap-2 rounded-[var(--radius-md)] bg-[var(--color-warning-container)] px-3 py-2.5 text-xs leading-[18px] text-[var(--color-on-warning-container)]">
                <CircleAlert aria-hidden="true" size={14} strokeWidth={1.75} className="mt-0.5 shrink-0" />
                <span>{t('settings.providers.magpie.unknownContextNote')}</span>
              </div>
            )}

            <SelectField
              id={backgroundId}
              label={t('settings.providers.magpie.backgroundModel')}
              value={background}
              onChange={setBackground}
              options={[
                { value: '', label: t('settings.providers.magpie.sameAsMain') },
                ...models.map((model) => ({ value: model.runtimeId, label: `${model.displayName} (${model.id})` })),
              ]}
            />

            {editing && (
              <section className="mt-1 border-t border-[var(--color-border)] pt-4">
                <h3 className="text-[13px] font-semibold text-[var(--color-text-secondary)]">{t('settings.providers.magpie.contextSection')}</h3>
                <p className="mt-1 text-xs leading-[18px] text-[var(--color-text-tertiary)]">{t('settings.providers.magpie.contextSectionHint')}</p>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <span className="text-[13px] text-[var(--color-text-primary)]">{t('settings.providers.magpie.autoCompact')}</span>
                  <SegmentedControl
                    label={t('settings.providers.magpie.autoCompact')}
                    value={compactMode}
                    onChange={setCompactMode}
                    items={[
                      { value: 'full', label: t('settings.providers.magpie.compactFull') },
                      { value: 'working', label: t('settings.providers.magpie.compactWorking') },
                      { value: 'custom', label: t('settings.providers.magpie.compactCustom') },
                    ]}
                  />
                </div>
                {compactMode === 'custom' && (
                  <Input
                    containerClassName="mt-3 max-w-[260px]"
                    label={t('settings.providers.magpie.compactCustomLabel')}
                    inputMode="numeric"
                    value={customCompact}
                    onChange={(event) => setCustomCompact(event.target.value)}
                    error={customError ? t(customError === 'number' ? 'settings.providers.autoCompactWindowNumberError' : 'settings.providers.autoCompactWindowRangeError') : undefined}
                  />
                )}
                <p className="mt-2 text-xs leading-[18px] text-[var(--color-text-tertiary)]">{t('settings.providers.magpie.compactHint')}</p>

                {unknownWindow.length > 0 && (
                  <div className="mt-3 rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3.5 py-3">
                    <div className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-[var(--color-text-secondary)]">
                      {t('settings.providers.magpie.unknownModelsTitle')}
                      <span className={TAG_WARNING}>{t('settings.providers.magpie.unknownModelsCount', { count: unknownWindow.length })}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {unknownWindow.map((model) => (
                        <span key={model.id} className="inline-flex h-[22px] items-center rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 font-mono text-[11px] text-[var(--color-text-secondary)]">
                          {model.id}
                        </span>
                      ))}
                    </div>
                    <p className="mt-2 text-xs text-[var(--color-text-tertiary)]">{t('settings.providers.magpie.unknownModelsHint')}</p>
                  </div>
                )}
              </section>
            )}
          </>
        ) : (
          <p className="py-6 text-center text-[13px] text-[var(--color-text-tertiary)]">{t('common.loading')}</p>
        )}

        {failed && <p role="alert" className="text-[13px] text-[var(--color-error)]">{t('settings.providers.magpie.saveFailed')}</p>}
      </div>
    </Modal>
  )
}
