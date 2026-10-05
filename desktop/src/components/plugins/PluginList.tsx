import { useEffect, useMemo, useState } from 'react'
import {
  ChevronRight,
  CircleCheck,
  ListChecks,
  Puzzle,
  RefreshCw,
  RotateCw,
  Store,
  ToggleLeft,
  ToggleRight,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { usePluginStore, type PluginActionTarget } from '../../stores/pluginStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTranslation } from '../../i18n'
import { useUIStore } from '../../stores/uiStore'
import { cx } from '@/lib/cx'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Checkbox } from '@/components/ui/Checkbox'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { LoadingState } from '@/components/ui/LoadingState'
import type { PluginSummary } from '../../types/plugin'

type PluginBucket = 'attention' | 'enabled' | 'disabled'
type BatchAction = 'enable' | 'disable'

export function PluginList() {
  const {
    plugins,
    marketplaces,
    summary,
    lastReloadSummary,
    isLoading,
    isApplying,
    error,
    fetchPlugins,
    fetchPluginDetail,
    reloadPlugins,
    bulkEnablePlugins,
    bulkDisablePlugins,
  } = usePluginStore()
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const addToast = useUIStore((s) => s.addToast)
  const t = useTranslation()
  const [selectedPluginIds, setSelectedPluginIds] = useState<Set<string>>(() => new Set())
  const [confirmBatchAction, setConfirmBatchAction] = useState<BatchAction | null>(null)
  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const currentWorkDir = activeSession?.workDir || undefined

  useEffect(() => {
    void fetchPlugins(currentWorkDir)
  }, [fetchPlugins, currentWorkDir])

  const grouped = useMemo(() => {
    const buckets: Record<PluginBucket, PluginSummary[]> = {
      attention: [],
      enabled: [],
      disabled: [],
    }

    for (const plugin of plugins) {
      if (plugin.hasErrors) {
        buckets.attention.push(plugin)
      } else if (plugin.enabled) {
        buckets.enabled.push(plugin)
      } else {
        buckets.disabled.push(plugin)
      }
    }

    return buckets
  }, [plugins])

  useEffect(() => {
    setSelectedPluginIds((current) => {
      const selectableIds = new Set(plugins.filter(canMutatePlugin).map((plugin) => plugin.id))
      const next = new Set([...current].filter((id) => selectableIds.has(id)))
      return next.size === current.size ? current : next
    })
  }, [plugins])

  const selectedPlugins = useMemo(
    () => plugins.filter((plugin) => selectedPluginIds.has(plugin.id) && canMutatePlugin(plugin)),
    [plugins, selectedPluginIds],
  )
  const enableCandidates = useMemo(
    () => selectedPlugins.filter((plugin) => !plugin.enabled),
    [selectedPlugins],
  )
  const disableCandidates = useMemo(
    () => selectedPlugins.filter((plugin) => plugin.enabled),
    [selectedPlugins],
  )
  const confirmBatchPlugins = confirmBatchAction === 'enable' ? enableCandidates : disableCandidates
  const confirmBatchNames = useMemo(
    () => formatPluginNames(confirmBatchPlugins),
    [confirmBatchPlugins],
  )

  const handleReload = async () => {
    try {
      const reloadSummary = await reloadPlugins(currentWorkDir, activeSessionId || undefined)
      addToast({
        type: reloadSummary.errors > 0 ? 'warning' : 'success',
        message: t('settings.plugins.reloadToast', {
          enabled: String(reloadSummary.enabled),
          skills: String(reloadSummary.skills),
          errors: String(reloadSummary.errors),
        }),
      })
    } catch (err) {
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const togglePluginSelection = (pluginId: string, selected: boolean) => {
    setSelectedPluginIds((current) => {
      const next = new Set(current)
      if (selected) {
        next.add(pluginId)
      } else {
        next.delete(pluginId)
      }
      return next
    })
  }

  const clearSelection = () => {
    setSelectedPluginIds(new Set())
  }

  const toActionTargets = (items: PluginSummary[]): PluginActionTarget[] =>
    items.map((plugin) => ({ id: plugin.id, scope: plugin.scope }))

  const handleBatchConfirm = async () => {
    if (!confirmBatchAction) return

    const action = confirmBatchAction
    const targets = action === 'enable' ? enableCandidates : disableCandidates
    if (targets.length === 0) {
      setConfirmBatchAction(null)
      return
    }

    try {
      const changed = action === 'enable'
        ? await bulkEnablePlugins(toActionTargets(targets), currentWorkDir, activeSessionId || undefined)
        : await bulkDisablePlugins(toActionTargets(targets), currentWorkDir, activeSessionId || undefined)

      setSelectedPluginIds((current) => {
        const next = new Set(current)
        for (const plugin of targets) {
          next.delete(plugin.id)
        }
        return next
      })
      setConfirmBatchAction(null)
      addToast({
        type: 'success',
        message: t(action === 'enable' ? 'settings.plugins.bulkEnableToast' : 'settings.plugins.bulkDisableToast', {
          count: String(changed),
        }),
      })
    } catch (err) {
      setConfirmBatchAction(null)
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (isLoading) {
    return <LoadingState label={t('common.loading')} labelHidden />
  }

  if (error) {
    // Was a bare red line of text with no role, so a screen reader only found
    // the failure by walking into it.
    return <ErrorState title={error} />
  }

  if (plugins.length === 0) {
    return (
      <EmptyState
        icon={<Puzzle size={20} strokeWidth={1.75} aria-hidden="true" />}
        title={t('settings.plugins.empty')}
        description={t('settings.plugins.emptyHint')}
        action={{ label: t('settings.plugins.refresh'), onClick: () => void fetchPlugins(currentWorkDir) }}
      />
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {/* The page head above already names this page, so the list opens on
          its numbers and the two runtime actions rather than a second title. */}
      <div className="flex flex-col gap-3">
        <div className="grid min-w-0 grid-cols-2 gap-3 md:grid-cols-4">
          <SummaryCard
            label={t('settings.plugins.summary.total')}
            value={String(summary?.total ?? plugins.length)}
            icon={Puzzle}
          />
          <SummaryCard
            label={t('settings.plugins.summary.enabled')}
            value={String(summary?.enabled ?? plugins.filter((plugin) => plugin.enabled).length)}
            icon={CircleCheck}
          />
          <SummaryCard
            label={t('settings.plugins.summary.attention')}
            value={String(grouped.attention.length)}
            icon={TriangleAlert}
          />
          <SummaryCard
            label={t('settings.plugins.summary.marketplaces')}
            value={String(summary?.marketplaceCount ?? marketplaces.length)}
            icon={Store}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className="min-w-0 flex-1 text-xs text-[var(--color-text-tertiary)]">
            {lastReloadSummary && t('settings.plugins.lastReload', {
              enabled: String(lastReloadSummary.enabled),
              skills: String(lastReloadSummary.skills),
              errors: String(lastReloadSummary.errors),
            })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="base"
              icon={<RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />}
              onClick={() => void fetchPlugins(currentWorkDir)}
            >
              {t('settings.plugins.refresh')}
            </Button>
            <Button
              size="base"
              icon={<RotateCw size={14} strokeWidth={1.75} aria-hidden="true" />}
              onClick={handleReload}
              loading={isApplying}
            >
              {t('settings.plugins.apply')}
            </Button>
          </div>
        </div>
      </div>

      {/* Batch selection: one quiet bar, filled only while something is picked. */}
      <div
        className={cx(
          'flex flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between',
          selectedPlugins.length > 0 ? 'bg-[var(--color-surface-selected)]' : 'bg-[var(--color-surface-container-lowest)]',
        )}
      >
        <div className="flex min-w-0 items-center gap-2 text-[13px] text-[var(--color-text-secondary)]">
          <ListChecks className="flex-shrink-0 text-[var(--color-text-tertiary)]" size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="font-medium text-[var(--color-text-primary)]">
            {t('settings.plugins.selectionCount', { count: String(selectedPlugins.length) })}
          </span>
          {selectedPlugins.length > 0 && (
            <Button variant="ghost" size="sm" onClick={clearSelection}>
              {t('settings.plugins.clearSelection')}
            </Button>
          )}
        </div>
        <div className="flex flex-wrap gap-2 sm:justify-end">
          <Button
            size="sm"
            icon={<ToggleRight size={14} strokeWidth={1.75} aria-hidden="true" />}
            disabled={enableCandidates.length === 0 || isApplying}
            onClick={() => setConfirmBatchAction('enable')}
          >
            {t('settings.plugins.enableSelected')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<ToggleLeft size={14} strokeWidth={1.75} aria-hidden="true" />}
            disabled={disableCandidates.length === 0 || isApplying}
            onClick={() => setConfirmBatchAction('disable')}
          >
            {t('settings.plugins.disableSelected')}
          </Button>
        </div>
      </div>

      {renderGroup('attention', grouped.attention, {
        fetchPluginDetail,
        cwd: currentWorkDir,
        t,
        selectedPluginIds,
        onToggleSelection: togglePluginSelection,
      })}
      {renderGroup('enabled', grouped.enabled, {
        fetchPluginDetail,
        cwd: currentWorkDir,
        t,
        selectedPluginIds,
        onToggleSelection: togglePluginSelection,
      })}
      {renderGroup('disabled', grouped.disabled, {
        fetchPluginDetail,
        cwd: currentWorkDir,
        t,
        selectedPluginIds,
        onToggleSelection: togglePluginSelection,
      })}

      {marketplaces.length > 0 && (
        <section className="min-w-0">
          <GroupHeading title={t('settings.plugins.marketplacesTitle')} hint={t('settings.plugins.marketplacesHint')} />
          <Card radius="lg" surface="lowest" padding="none" className="divide-y divide-[var(--color-border)] overflow-hidden">
            {marketplaces.map((marketplace) => (
              <div key={marketplace.name} className="flex min-w-0 items-start gap-3 px-4 py-3">
                <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-surface-container)] text-[var(--color-text-tertiary)]">
                  <Store size={14} strokeWidth={1.75} aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium text-[var(--color-text-primary)]">
                      {marketplace.name}
                    </span>
                    <Badge tone={marketplace.autoUpdate ? 'success' : 'neutral'}>
                      {marketplace.autoUpdate
                        ? t('settings.plugins.marketplaceAutoUpdateOn')
                        : t('settings.plugins.marketplaceAutoUpdateOff')}
                    </Badge>
                  </div>
                  <div className="mt-0.5 break-words font-mono text-[11px] leading-5 text-[var(--color-text-secondary)]">
                    {marketplace.source}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-1.5 gap-y-1 text-xs text-[var(--color-text-tertiary)]">
                    <span>{t('settings.plugins.marketplaceInstalledCount', { count: String(marketplace.installedCount) })}</span>
                    {marketplace.lastUpdated && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{t('settings.plugins.marketplaceUpdatedAt', { value: new Date(marketplace.lastUpdated).toLocaleString() })}</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </Card>
        </section>
      )}

      <ConfirmDialog
        open={confirmBatchAction !== null}
        onClose={() => setConfirmBatchAction(null)}
        onConfirm={handleBatchConfirm}
        title={confirmBatchAction === 'enable'
          ? t('settings.plugins.bulkEnableTitle', { count: String(confirmBatchPlugins.length) })
          : t('settings.plugins.bulkDisableTitle', { count: String(confirmBatchPlugins.length) })}
        body={confirmBatchAction === 'enable'
          ? t('settings.plugins.bulkEnableBody', { names: confirmBatchNames })
          : t('settings.plugins.bulkDisableBody', { names: confirmBatchNames })}
        confirmLabel={confirmBatchAction === 'enable' ? t('settings.plugins.enable') : t('settings.plugins.disable')}
        cancelLabel={t('common.cancel')}
        confirmVariant={confirmBatchAction === 'disable' ? 'danger' : 'primary'}
        loading={isApplying}
      />
    </div>
  )
}

type RenderGroupOptions = {
  fetchPluginDetail: (id: string, cwd?: string) => Promise<void>
  cwd: string | undefined
  t: ReturnType<typeof useTranslation>
  selectedPluginIds: Set<string>
  onToggleSelection: (pluginId: string, selected: boolean) => void
}

/** 13 semibold secondary over the card it names, with an optional 12px hint. */
function GroupHeading({ title, hint, count }: { title: string; hint?: string; count?: number }) {
  return (
    <div className="mb-2 px-0.5">
      <div className="flex items-center gap-2">
        <h4 className="text-[13px] font-semibold text-[var(--color-text-secondary)]">{title}</h4>
        {count !== undefined && (
          <span className="font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">{count}</span>
        )}
      </div>
      {hint && <p className="mt-0.5 text-xs text-[var(--color-text-tertiary)]">{hint}</p>}
    </div>
  )
}

function renderGroup(
  bucket: PluginBucket,
  items: PluginSummary[],
  {
    fetchPluginDetail,
    cwd,
    t,
    selectedPluginIds,
    onToggleSelection,
  }: RenderGroupOptions,
) {
  if (items.length === 0) return null

  const titleKey =
    bucket === 'attention'
      ? 'settings.plugins.group.attention'
      : bucket === 'enabled'
        ? 'settings.plugins.group.enabled'
        : 'settings.plugins.group.disabled'

  return (
    <section key={bucket} className="min-w-0">
      <GroupHeading
        title={t(titleKey)}
        hint={t('settings.plugins.groupHint', { count: String(items.length) })}
        count={items.length}
      />
      <Card radius="lg" surface="lowest" padding="none" className="divide-y divide-[var(--color-border)] overflow-hidden">
        {items.map((plugin) => {
          const selected = selectedPluginIds.has(plugin.id)
          return (
            <div
              key={plugin.id}
              className={cx(
                'group flex items-start gap-3 px-4 py-3 transition-colors duration-150',
                selected ? 'bg-[var(--color-surface-selected)]' : 'hover:bg-[var(--color-surface-hover)]',
              )}
            >
              {canMutatePlugin(plugin) ? (
                <Checkbox
                  label={t('settings.plugins.selectPlugin', { name: plugin.name })}
                  labelHidden
                  checked={selected}
                  onChange={(event) => onToggleSelection(plugin.id, event.currentTarget.checked)}
                  containerClassName="mt-1 h-5 w-5 shrink-0"
                />
              ) : (
                <span className="mt-1 h-5 w-5 shrink-0" aria-hidden="true" />
              )}
              <button
                type="button"
                onClick={() => void fetchPluginDetail(plugin.id, cwd)}
                className="flex min-w-0 flex-1 items-start gap-3 rounded-[var(--radius-sm)] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]"
              >
                <span
                  className={cx(
                    'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[var(--radius-md)]',
                    plugin.hasErrors
                      ? 'bg-[var(--color-error-container)] text-[var(--color-on-error-container)]'
                      : 'bg-[var(--color-surface-container)] text-[var(--color-text-tertiary)]',
                  )}
                >
                  {plugin.hasErrors
                    ? <TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" />
                    : <Puzzle size={14} strokeWidth={1.75} aria-hidden="true" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="break-all text-[13px] font-medium text-[var(--color-text-primary)]">
                      {plugin.name}
                    </span>
                    <StatusPill plugin={plugin} />
                    <ScopePill scope={plugin.scope} />
                    {plugin.version && <Badge mono>v{plugin.version}</Badge>}
                  </div>
                  <p className="mt-0.5 break-words text-xs leading-5 text-[var(--color-text-secondary)]">
                    {plugin.description || t('settings.plugins.noDescription')}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--color-text-tertiary)]">
                    <span>{plugin.marketplace}</span>
                    {plugin.componentCounts.skills > 0 && (
                      <span>{t('settings.plugins.capability.skills', { count: String(plugin.componentCounts.skills) })}</span>
                    )}
                    {plugin.componentCounts.agents > 0 && (
                      <span>{t('settings.plugins.capability.agents', { count: String(plugin.componentCounts.agents) })}</span>
                    )}
                    {plugin.componentCounts.mcpServers > 0 && (
                      <span>{t('settings.plugins.capability.mcpServers', { count: String(plugin.componentCounts.mcpServers) })}</span>
                    )}
                    {plugin.errors.length > 0 && (
                      <span className="text-[var(--color-error)]">
                        {t('settings.plugins.errorCount', { count: String(plugin.errors.length) })}
                      </span>
                    )}
                  </div>
                </div>
                <ChevronRight
                  className="mt-1.5 flex-shrink-0 text-[var(--color-text-tertiary)] opacity-60 transition-opacity group-hover:opacity-100"
                  size={14}
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
              </button>
            </div>
          )
        })}
      </Card>
    </section>
  )
}

function canMutatePlugin(plugin: PluginSummary) {
  return plugin.scope !== 'managed' && plugin.scope !== 'builtin'
}

function formatPluginNames(plugins: PluginSummary[]) {
  return plugins.map((plugin) => plugin.name).join(', ')
}

/** Label above, figure below: the figure is what the eye lands on. */
function SummaryCard({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: string
  icon: LucideIcon
}) {
  return (
    <Card radius="lg" surface="lowest" padding="none" className="min-w-0 px-4 py-3">
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--color-text-tertiary)]">
        <Icon className="flex-shrink-0" size={14} strokeWidth={1.75} aria-hidden="true" />
        <span className="min-w-0 truncate">{label}</span>
      </div>
      <div className="mt-1 truncate text-[22px] font-semibold leading-7 tabular-nums text-[var(--color-text-primary)]">
        {value}
      </div>
    </Card>
  )
}

function StatusPill({ plugin }: { plugin: PluginSummary }) {
  const t = useTranslation()

  if (plugin.hasErrors) {
    return <Badge tone="danger">{t('settings.plugins.status.attention')}</Badge>
  }

  return (
    <Badge tone={plugin.enabled ? 'success' : 'neutral'}>
      {plugin.enabled
        ? t('settings.plugins.status.enabled')
        : t('settings.plugins.status.disabled')}
    </Badge>
  )
}

function ScopePill({ scope }: { scope: PluginSummary['scope'] }) {
  const t = useTranslation()
  return <Badge variant="outline">{t(`settings.plugins.scope.${scope}`)}</Badge>
}
