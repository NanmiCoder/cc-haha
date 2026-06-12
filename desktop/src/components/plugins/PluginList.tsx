import { useEffect, useMemo, useState } from 'react'
import { usePluginStore, type PluginActionTarget } from '../../stores/pluginStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTranslation } from '../../i18n'
import type { TranslationKey } from '../../i18n'
import { useUIStore } from '../../stores/uiStore'
import { Button } from '../shared/Button'
import { ConfirmDialog } from '../shared/ConfirmDialog'
import { ToggleSwitch } from '../shared/ToggleSwitch'
import type {
  CatalogPlugin,
  KnownLanguageServerRow,
  PluginPrerequisiteRow,
  PluginSummary,
} from '../../types/plugin'
import { pluginsApi } from '../../api/plugins'
import { PluginPrerequisitesModal } from './PluginPrerequisitesModal'
import { detectPlatform } from '../../lib/detectPlatform'
import { injectInstallScriptIntoNewTerminal } from '../../lib/terminalCommandInjection'

type PluginBucket = 'attention' | 'enabled' | 'disabled'
type BatchAction = 'enable' | 'disable'

// Localized labels for catalog descriptions and category badges. Keyed by
// the stable `id` and `category` from the server. Falls back to the English
// values from the catalog payload when an i18n key is absent.
const CATALOG_DESC_KEY: Record<string, TranslationKey> = {
  superpowers: 'settings.plugins.catalog.superpowers.desc',
  github: 'settings.plugins.catalog.github.desc',
  linear: 'settings.plugins.catalog.linear.desc',
  coderabbit: 'settings.plugins.catalog.coderabbit.desc',
  sentry: 'settings.plugins.catalog.sentry.desc',
  supabase: 'settings.plugins.catalog.supabase.desc',
  vercel: 'settings.plugins.catalog.vercel.desc',
  'netlify-skills': 'settings.plugins.catalog.netlify.desc',
  figma: 'settings.plugins.catalog.figma.desc',
  playwright: 'settings.plugins.catalog.playwright.desc',
  'chrome-devtools-mcp': 'settings.plugins.catalog.chromeDevtools.desc',
  stripe: 'settings.plugins.catalog.stripe.desc',
}

const CATEGORY_LABEL_KEY: Record<string, TranslationKey> = {
  official: 'settings.plugins.catalogCategory.official',
  devops: 'settings.plugins.catalogCategory.devops',
  codeReview: 'settings.plugins.catalogCategory.codeReview',
  observability: 'settings.plugins.catalogCategory.observability',
  database: 'settings.plugins.catalogCategory.database',
  frontend: 'settings.plugins.catalogCategory.frontend',
  payments: 'settings.plugins.catalogCategory.payments',
  productivity: 'settings.plugins.catalogCategory.productivity',
  browser: 'settings.plugins.catalogCategory.browser',
}

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
    enablePlugin,
    disablePlugin,
    uninstallPlugin,
    catalog,
    installingCatalogId,
    isAddingMarketplace,
    fetchCatalog,
    installCatalogPlugin,
    addMarketplaceFromInput,
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
  const [marketplaceInput, setMarketplaceInput] = useState('')
  // Per-plugin action tracking — keyed by `${pluginId}:${action}` so a row can
  // show its own spinner without blocking sibling rows.
  const [pendingActionKey, setPendingActionKey] = useState<string | null>(null)
  const [pendingUninstall, setPendingUninstall] = useState<PluginSummary | null>(null)
  // Prerequisites modal state — populated after a successful enable when
  // the plugin's MCP servers declared host-command prerequisites that
  // aren't currently in PATH. Stays open while the user installs deps;
  // user can click "I installed it, recheck" to re-probe without
  // disabling/re-enabling the plugin.
  const [prereqModal, setPrereqModal] = useState<{
    pluginId: string
    pluginName: string
    rows: PluginPrerequisiteRow[]
    isRechecking: boolean
  } | null>(null)

  useEffect(() => {
    void fetchPlugins(currentWorkDir)
  }, [fetchPlugins, currentWorkDir])

  useEffect(() => {
    void fetchCatalog()
  }, [fetchCatalog])

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

  const languageServerPlugins = useMemo(
    () => plugins.filter((plugin) => plugin.componentCounts.lspServers > 0),
    [plugins],
  )

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

  const handleInstallCatalog = async (entry: CatalogPlugin) => {
    try {
      await installCatalogPlugin(
        entry.id,
        entry.marketplace,
        currentWorkDir,
        activeSessionId || undefined,
      )
      addToast({
        type: 'success',
        message: t('settings.plugins.recommended.installedToast', {
          name: entry.displayName,
        }),
      })
    } catch (err) {
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const handleAddMarketplace = async () => {
    const trimmed = marketplaceInput.trim()
    if (!trimmed) return
    try {
      const result = await addMarketplaceFromInput(
        trimmed,
        currentWorkDir,
        activeSessionId || undefined,
      )
      setMarketplaceInput('')
      addToast({
        type: 'success',
        message: t(
          result.alreadyMaterialized
            ? 'settings.plugins.urlInstall.alreadyToast'
            : 'settings.plugins.urlInstall.addedToast',
          { name: result.name },
        ),
      })
    } catch (err) {
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const handleInlineToggle = async (plugin: PluginSummary) => {
    const key = `${plugin.id}:toggle`
    if (pendingActionKey) return
    setPendingActionKey(key)
    try {
      const message = plugin.enabled
        ? await disablePlugin(plugin.id, plugin.scope, currentWorkDir, activeSessionId || undefined)
        : await enablePlugin(plugin.id, plugin.scope, currentWorkDir, activeSessionId || undefined)
      addToast({
        type: 'success',
        message,
      })

      // Right after enabling, probe whether the plugin's MCP servers'
      // declared host-command prerequisites are present. Skip on
      // disable (nothing to install). Failures here are non-fatal —
      // the toggle already succeeded; the modal is a best-effort
      // helper. Don't block the user with errors if the probe fails.
      if (!plugin.enabled) {
        try {
          const result = await pluginsApi.prerequisites(plugin.id, currentWorkDir)
          const missing = result.prerequisites.filter((row) => !row.installed)
          if (missing.length > 0) {
            setPrereqModal({
              pluginId: plugin.id,
              pluginName: plugin.name,
              rows: result.prerequisites,
              isRechecking: false,
            })
          }
        } catch {
          // Probe failure is silent — host environment variability is
          // wide and a CI runner without `where`/`command -v` should
          // not break plugin enable.
        }
      }
    } catch (err) {
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setPendingActionKey(null)
    }
  }

  const handlePrereqRecheck = async () => {
    if (!prereqModal) return
    setPrereqModal((prev) => (prev ? { ...prev, isRechecking: true } : prev))
    try {
      const result = await pluginsApi.prerequisites(
        prereqModal.pluginId,
        currentWorkDir,
      )
      const stillMissing = result.prerequisites.filter((row) => !row.installed)
      if (stillMissing.length === 0) {
        // Everything resolved — close the modal and confirm to the user
        // that they're good to go.
        setPrereqModal(null)
        addToast({
          type: 'success',
          message: t('pluginPrereq.allInstalledToast'),
        })
        return
      }
      setPrereqModal({
        pluginId: prereqModal.pluginId,
        pluginName: prereqModal.pluginName,
        rows: result.prerequisites,
        isRechecking: false,
      })
    } catch (err) {
      setPrereqModal((prev) => (prev ? { ...prev, isRechecking: false } : prev))
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const handleInlineUninstall = async () => {
    if (!pendingUninstall) return
    const key = `${pendingUninstall.id}:uninstall`
    setPendingActionKey(key)
    try {
      const message = await uninstallPlugin(
        pendingUninstall.id,
        pendingUninstall.scope,
        false,
        currentWorkDir,
        activeSessionId || undefined,
      )
      addToast({ type: 'success', message })
    } catch (err) {
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setPendingUninstall(null)
      setPendingActionKey(null)
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
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin w-5 h-5 border-2 border-[var(--color-brand)] border-t-transparent rounded-full" />
      </div>
    )
  }

  if (error) {
    return <div className="text-sm text-[var(--color-error)] py-4">{error}</div>
  }

  // Empty installed list is no longer an early return — we still show the
  // Recommended section and URL install form below so first-run users have a
  // path forward without dropping to the CLI.
  const showInstalledEmptyState = plugins.length === 0

  return (
    <div className="flex flex-col gap-6 min-w-0">
      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] overflow-hidden">
        <div className="flex flex-col gap-4 px-5 py-5 min-w-0">
          <div className="flex flex-col gap-4 min-w-0 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0 max-w-4xl">
              <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-tertiary)] mb-2">
                {t('settings.plugins.browserEyebrow')}
              </div>
              <div className="flex items-center gap-3 mb-2">
                <span className="material-symbols-outlined text-[22px] text-[var(--color-brand)]">
                  extension
                </span>
                <h3 className="text-lg font-semibold text-[var(--color-text-primary)]">
                  {t('settings.plugins.browserTitle')}
                </h3>
              </div>
              <p className="text-sm leading-6 text-[var(--color-text-secondary)]">
                {t('settings.plugins.browserDescription')}
              </p>
            </div>

            <div className="flex flex-wrap gap-2 xl:justify-end">
              <Button
                variant="secondary"
                size="sm"
                className="min-h-9 flex-1 sm:flex-none"
                onClick={() => void fetchPlugins(currentWorkDir)}
              >
                <span className="material-symbols-outlined text-[16px]">refresh</span>
                {t('settings.plugins.refresh')}
              </Button>
              <Button
                size="sm"
                className="min-h-9 flex-1 sm:flex-none"
                onClick={handleReload}
                loading={isApplying}
              >
                <span className="material-symbols-outlined text-[16px]">sync</span>
                {t('settings.plugins.apply')}
              </Button>
            </div>
          </div>

          <div className="grid min-w-0 grid-cols-2 gap-2 md:grid-cols-4">
            <SummaryCard
              label={t('settings.plugins.summary.total')}
              value={String(summary?.total ?? plugins.length)}
              icon="extension"
            />
            <SummaryCard
              label={t('settings.plugins.summary.enabled')}
              value={String(summary?.enabled ?? plugins.filter((plugin) => plugin.enabled).length)}
              icon="check_circle"
            />
            <SummaryCard
              label={t('settings.plugins.summary.attention')}
              value={String(grouped.attention.length)}
              icon="warning"
            />
            <SummaryCard
              label={t('settings.plugins.summary.marketplaces')}
              value={String(summary?.marketplaceCount ?? marketplaces.length)}
              icon="storefront"
            />
          </div>

          {lastReloadSummary && (
            <p className="text-xs text-[var(--color-text-tertiary)]">
              {t('settings.plugins.lastReload', {
                enabled: String(lastReloadSummary.enabled),
                skills: String(lastReloadSummary.skills),
                errors: String(lastReloadSummary.errors),
              })}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-3 border-t border-[var(--color-border)] px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-2 text-xs text-[var(--color-text-secondary)]">
            <span className="material-symbols-outlined text-[16px] text-[var(--color-text-tertiary)]">
              checklist
            </span>
            <span className="font-medium text-[var(--color-text-primary)]">
              {t('settings.plugins.selectionCount', { count: String(selectedPlugins.length) })}
            </span>
            {selectedPlugins.length > 0 && (
              <button
                type="button"
                onClick={clearSelection}
                className="rounded-md px-2 py-1 text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]"
              >
                {t('settings.plugins.clearSelection')}
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-2 sm:justify-end">
            <Button
              size="sm"
              disabled={enableCandidates.length === 0 || isApplying}
              onClick={() => setConfirmBatchAction('enable')}
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">toggle_on</span>
              {t('settings.plugins.enableSelected')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={disableCandidates.length === 0 || isApplying}
              onClick={() => setConfirmBatchAction('disable')}
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">toggle_off</span>
              {t('settings.plugins.disableSelected')}
            </Button>
          </div>
        </div>
      </section>

      <RecommendedSection
        catalog={catalog}
        installingId={installingCatalogId}
        onInstall={handleInstallCatalog}
        t={t}
      />

      <LanguageServersSection
        plugins={languageServerPlugins}
        fetchPluginDetail={fetchPluginDetail}
        cwd={currentWorkDir}
        t={t}
      />

      <UrlInstallSection
        value={marketplaceInput}
        onChange={setMarketplaceInput}
        onSubmit={handleAddMarketplace}
        loading={isAddingMarketplace}
        t={t}
      />

      {marketplaces.length > 0 && (
        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
          <div className="px-5 py-4 border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
            <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">
              {t('settings.plugins.marketplacesTitle')}
            </h4>
            <p className="text-xs text-[var(--color-text-tertiary)] mt-1">
              {t('settings.plugins.marketplacesHint')}
            </p>
          </div>
          <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
            {marketplaces.map((marketplace) => (
              <div
                key={marketplace.name}
                className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-[var(--color-text-primary)]">
                    {marketplace.name}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    marketplace.autoUpdate
                      ? 'bg-[var(--color-success-container)] text-[var(--color-success)]'
                      : 'bg-[var(--color-surface-container-high)] text-[var(--color-text-tertiary)]'
                  }`}>
                    {marketplace.autoUpdate
                      ? t('settings.plugins.marketplaceAutoUpdateOn')
                      : t('settings.plugins.marketplaceAutoUpdateOff')}
                  </span>
                </div>
                <div className="mt-2 text-xs leading-5 text-[var(--color-text-secondary)] break-words">
                  {marketplace.source}
                </div>
                <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--color-text-tertiary)]">
                  <span>{t('settings.plugins.marketplaceInstalledCount', { count: String(marketplace.installedCount) })}</span>
                  {marketplace.lastUpdated && (
                    <span>{t('settings.plugins.marketplaceUpdatedAt', { value: new Date(marketplace.lastUpdated).toLocaleString() })}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {renderGroup('attention', grouped.attention, {
        fetchPluginDetail,
        cwd: currentWorkDir,
        t,
        selectedPluginIds,
        onToggleSelection: togglePluginSelection,
        onToggle: handleInlineToggle,
        onAskUninstall: setPendingUninstall,
        pendingActionKey,
      })}
      {renderGroup('enabled', grouped.enabled, {
        fetchPluginDetail,
        cwd: currentWorkDir,
        t,
        selectedPluginIds,
        onToggleSelection: togglePluginSelection,
        onToggle: handleInlineToggle,
        onAskUninstall: setPendingUninstall,
        pendingActionKey,
      })}
      {renderGroup('disabled', grouped.disabled, {
        fetchPluginDetail,
        cwd: currentWorkDir,
        t,
        selectedPluginIds,
        onToggleSelection: togglePluginSelection,
        onToggle: handleInlineToggle,
        onAskUninstall: setPendingUninstall,
        pendingActionKey,
      })}

      {showInstalledEmptyState && (
        <div className="text-center py-8 rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-6">
          <span className="material-symbols-outlined text-[32px] text-[var(--color-text-tertiary)] mb-2 block">
            extension_off
          </span>
          <p className="text-sm text-[var(--color-text-tertiary)]">
            {t('settings.plugins.empty')}
          </p>
          <p className="text-xs text-[var(--color-text-tertiary)] mt-1">
            {t('settings.plugins.emptyHintRecommended')}
          </p>
        </div>
      )}

      <ConfirmDialog
        open={pendingUninstall !== null}
        onClose={() => {
          if (isApplying && pendingActionKey?.endsWith(':uninstall')) return
          setPendingUninstall(null)
        }}
        onConfirm={handleInlineUninstall}
        title={t('settings.plugins.uninstall')}
        body={
          pendingUninstall
            ? t('settings.plugins.confirmUninstall', { name: pendingUninstall.name })
            : ''
        }
        confirmLabel={t('settings.plugins.uninstall')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
        loading={isApplying && pendingActionKey?.endsWith(':uninstall') === true}
      />

      {prereqModal && (
        <PluginPrerequisitesModal
          open={prereqModal !== null}
          pluginName={prereqModal.pluginName}
          rows={prereqModal.rows}
          isRechecking={prereqModal.isRechecking}
          onRecheck={handlePrereqRecheck}
          onClose={() => setPrereqModal(null)}
        />
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
  onToggle: (plugin: PluginSummary) => void
  onAskUninstall: (plugin: PluginSummary) => void
  /** `${pluginId}:${action}` of the action currently in flight, or null. */
  pendingActionKey: string | null
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
    onToggle,
    onAskUninstall,
    pendingActionKey,
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
    <section
      key={bucket}
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden"
    >
      <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">
            {t(titleKey)}
          </h4>
          <p className="text-xs leading-5 text-[var(--color-text-tertiary)] mt-1">
            {t('settings.plugins.groupHint', { count: String(items.length) })}
          </p>
        </div>
        <span className="text-xs text-[var(--color-text-tertiary)]">{items.length}</span>
      </div>
      <div className="flex flex-col p-2">
        {items.map((plugin) => {
          const canMutate = canMutatePlugin(plugin)
          const isToggling = pendingActionKey === `${plugin.id}:toggle`
          const isUninstalling = pendingActionKey === `${plugin.id}:uninstall`
          return (
            <div
              key={plugin.id}
              className={`group rounded-xl border px-3 py-3 transition-all hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface-hover)] ${
                selectedPluginIds.has(plugin.id)
                  ? 'border-[var(--color-brand)]/45 bg-[var(--color-surface-selected)]'
                  : 'border-transparent'
              }`}
            >
              <div className="flex items-start gap-3">
                {canMutate ? (
                  <label className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-container-high)]">
                    <input
                      type="checkbox"
                      aria-label={t('settings.plugins.selectPlugin', { name: plugin.name })}
                      checked={selectedPluginIds.has(plugin.id)}
                      onChange={(event) => onToggleSelection(plugin.id, event.currentTarget.checked)}
                      className="h-4 w-4 rounded border-[var(--color-border)] accent-[var(--color-brand)]"
                    />
                  </label>
                ) : (
                  <span className="mt-0.5 h-6 w-6 shrink-0" aria-hidden="true" />
                )}
                <button
                  type="button"
                  onClick={() => void fetchPluginDetail(plugin.id, cwd)}
                  className="flex flex-1 min-w-0 items-start gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]"
                >
                  <span className="mt-0.5 material-symbols-outlined text-[18px] text-[var(--color-text-tertiary)]">
                    {plugin.hasErrors ? 'warning' : plugin.enabled ? 'extension' : 'extension_off'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-[var(--color-text-primary)] break-all">
                        {plugin.name}
                      </span>
                      <StatusPill plugin={plugin} />
                      <ScopePill scope={plugin.scope} />
                      {plugin.version && (
                        <span className="rounded-full bg-[var(--color-surface-container-high)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-tertiary)]">
                          v{plugin.version}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs leading-5 text-[var(--color-text-secondary)] break-words">
                      {plugin.description || t('settings.plugins.noDescription')}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--color-text-tertiary)]">
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
                      {plugin.componentCounts.lspServers > 0 && (
                        <span>{t('settings.plugins.capability.lspServers', { count: String(plugin.componentCounts.lspServers) })}</span>
                      )}
                      {plugin.errors.length > 0 && (
                        <span className="text-[var(--color-error)]">
                          {t('settings.plugins.errorCount', { count: String(plugin.errors.length) })}
                        </span>
                      )}
                    </div>
                  </div>
                </button>

                <div className="flex flex-shrink-0 items-center gap-2 pt-0.5">
                  {canMutate ? (
                    <ToggleSwitch
                      checked={plugin.enabled}
                      disabled={isToggling || isUninstalling}
                      onChange={() => onToggle(plugin)}
                      ariaLabel={`${plugin.enabled ? t('settings.plugins.disable') : t('settings.plugins.enable')} ${plugin.name}`}
                    />
                  ) : null}
                  {canMutate && (
                    <button
                      type="button"
                      onClick={() => onAskUninstall(plugin)}
                      disabled={isToggling || isUninstalling}
                      aria-label={`${t('settings.plugins.uninstall')} ${plugin.name}`}
                      title={t('settings.plugins.uninstall')}
                      className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-error)]/12 hover:text-[var(--color-error)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] disabled:opacity-50"
                    >
                      <span className="material-symbols-outlined text-[18px]">delete</span>
                    </button>
                  )}
                  <span className="material-symbols-outlined text-[18px] text-[var(--color-text-tertiary)] opacity-60 transition-transform group-hover:translate-x-0.5 group-hover:opacity-100">
                    chevron_right
                  </span>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function canMutatePlugin(plugin: PluginSummary) {
  return plugin.scope !== 'managed' && plugin.scope !== 'builtin'
}

function formatPluginNames(plugins: PluginSummary[]) {
  return plugins.map((plugin) => plugin.name).join(', ')
}

function SummaryCard({
  label,
  value,
  icon,
}: {
  label: string
  value: string
  icon: string
}) {
  return (
    <div className="min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3">
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
        <span className="material-symbols-outlined text-[14px] flex-shrink-0">{icon}</span>
        <span className="min-w-0 truncate text-[10px] leading-4">
          {label}
        </span>
      </div>
      <div className="mt-1.5 truncate text-lg font-semibold text-[var(--color-text-primary)]">
        {value}
      </div>
    </div>
  )
}

function StatusPill({ plugin }: { plugin: PluginSummary }) {
  const t = useTranslation()

  if (plugin.hasErrors) {
    return (
      <span className="rounded-full bg-[var(--color-error)]/12 px-2 py-0.5 text-[10px] font-medium text-[var(--color-error)]">
        {t('settings.plugins.status.attention')}
      </span>
    )
  }

  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
      plugin.enabled
        ? 'bg-[var(--color-success-container)] text-[var(--color-success)]'
        : 'bg-[var(--color-surface-container-high)] text-[var(--color-text-tertiary)]'
    }`}>
      {plugin.enabled
        ? t('settings.plugins.status.enabled')
        : t('settings.plugins.status.disabled')}
    </span>
  )
}

function ScopePill({ scope }: { scope: PluginSummary['scope'] }) {
  const t = useTranslation()
  return (
    <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-tertiary)]">
      {t(`settings.plugins.scope.${scope}`)}
    </span>
  )
}

function LanguageServersSection({
  plugins,
  fetchPluginDetail,
  cwd,
  t,
}: {
  plugins: PluginSummary[]
  fetchPluginDetail: (id: string, cwd?: string) => Promise<void>
  cwd: string | undefined
  t: ReturnType<typeof useTranslation>
}) {
  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
      <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--color-primary-fixed)] text-[var(--color-brand)]">
              <span className="material-symbols-outlined text-[16px]">code_blocks</span>
            </span>
            <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">
              {t('settings.plugins.languageServers.title')}
            </h4>
            <span className="text-xs text-[var(--color-text-tertiary)]">{plugins.length}</span>
          </div>
          <p className="text-xs leading-5 text-[var(--color-text-tertiary)]">
            {t('settings.plugins.languageServers.description')}
          </p>
        </div>
      </div>

      {plugins.length === 0 ? (
        <div className="px-5 py-4 text-xs leading-5 text-[var(--color-text-tertiary)]">
          {t('settings.plugins.languageServers.empty')}
        </div>
      ) : (
        <div className="grid gap-2 p-2 sm:grid-cols-2">
          {plugins.map((plugin) => (
            <button
              key={plugin.id}
              type="button"
              onClick={() => void fetchPluginDetail(plugin.id, cwd)}
              className="flex min-w-0 items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3 text-left transition-colors hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]"
            >
              <span className="mt-0.5 material-symbols-outlined text-[18px] text-[var(--color-text-tertiary)]">
                code_blocks
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-[var(--color-text-primary)] break-all">
                    {plugin.name}
                  </span>
                  <span className="rounded-full bg-[var(--color-surface-container-high)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-tertiary)]">
                    {t('settings.plugins.capability.lspServers', { count: String(plugin.componentCounts.lspServers) })}
                  </span>
                  <StatusPill plugin={plugin} />
                </div>
                <p className="mt-1 text-xs leading-5 text-[var(--color-text-secondary)] break-words">
                  {plugin.description || t('settings.plugins.noDescription')}
                </p>
                <p className="mt-1 text-[10px] text-[var(--color-text-tertiary)] break-all">
                  {plugin.id}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}

      <KnownLanguageServersPanel t={t} />
    </section>
  )
}

export function KnownLanguageServersPanel({
  t,
}: {
  t: ReturnType<typeof useTranslation>
}) {
  const addToast = useUIStore((s) => s.addToast)
  const [servers, setServers] = useState<KnownLanguageServerRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [installingLanguage, setInstallingLanguage] = useState<string | null>(null)

  const load = async (refresh?: boolean) => {
    setLoading(true)
    setError(null)
    try {
      const result = await pluginsApi.languageServers(refresh)
      setServers(result.servers)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // Detection runs once on mount; the recheck button re-probes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleInstall = async (server: KnownLanguageServerRow) => {
    const platform = detectPlatform()
    const steps = server.install[platform] ?? []
    const step = steps[0]
    if (!step) {
      if (server.homepage) {
        window.open(server.homepage, '_blank', 'noopener,noreferrer')
      }
      return
    }
    setInstallingLanguage(server.language)
    try {
      await injectInstallScriptIntoNewTerminal([step.cmd])
      addToast({
        type: 'success',
        message: t('settings.plugins.languageServers.known.injectedToast', {
          name: server.label,
        }),
      })
    } catch (err) {
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setInstallingLanguage(null)
    }
  }

  return (
    <div className="border-t border-[var(--color-border)]">
      <div className="flex items-start justify-between gap-3 px-5 py-3">
        <div className="min-w-0">
          <h5 className="text-xs font-semibold text-[var(--color-text-primary)]">
            {t('settings.plugins.languageServers.known.title')}
          </h5>
          <p className="mt-1 text-[11px] leading-5 text-[var(--color-text-tertiary)]">
            {t('settings.plugins.languageServers.known.description')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading}
          className="shrink-0 inline-flex items-center gap-1 rounded-lg border border-[var(--color-border)] px-2 py-1 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] disabled:opacity-60"
        >
          <span className="material-symbols-outlined text-[14px]">refresh</span>
          {t('settings.plugins.languageServers.known.recheck')}
        </button>
      </div>

      {error ? (
        <div className="px-5 pb-3 text-[11px] text-[var(--color-error)]">{error}</div>
      ) : loading && !servers ? (
        <div className="px-5 pb-4">
          <div className="h-8 animate-pulse rounded-lg bg-[var(--color-surface-container-high)]" />
        </div>
      ) : (
        <div className="grid gap-2 px-2 pb-2 sm:grid-cols-2">
          {(servers ?? []).map((server) => {
            const platform = detectPlatform()
            const hasInstallStep = (server.install[platform]?.length ?? 0) > 0
            return (
              <div
                key={server.language}
                className="flex min-w-0 items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-2.5"
              >
                <span
                  className={`material-symbols-outlined text-[18px] ${
                    server.installed
                      ? 'text-[var(--color-success)]'
                      : 'text-[var(--color-text-tertiary)]'
                  }`}
                >
                  {server.installed ? 'check_circle' : 'radio_button_unchecked'}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-[var(--color-text-primary)] break-all">
                    {server.label}
                  </div>
                  {server.installed && server.resolvedPath ? (
                    <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--color-text-tertiary)]">
                      {server.resolvedPath}
                    </div>
                  ) : (
                    <div className="mt-0.5 text-[10px] text-[var(--color-text-tertiary)]">
                      {t('settings.plugins.languageServers.known.notInstalled')}
                    </div>
                  )}
                </div>
                {server.installed ? (
                  <span className="shrink-0 text-[10px] font-medium text-[var(--color-success)]">
                    {t('settings.plugins.languageServers.known.installed')}
                  </span>
                ) : hasInstallStep ? (
                  <button
                    type="button"
                    onClick={() => void handleInstall(server)}
                    disabled={installingLanguage === server.language}
                    className="shrink-0 inline-flex items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] disabled:opacity-60"
                  >
                    <span className="material-symbols-outlined text-[14px]">download</span>
                    {t('settings.plugins.languageServers.known.install')}
                  </button>
                ) : server.homepage ? (
                  <a
                    href={server.homepage}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 inline-flex items-center gap-1 rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)]"
                  >
                    <span className="material-symbols-outlined text-[14px]">open_in_new</span>
                    {t('settings.plugins.languageServers.known.guide')}
                  </a>
                ) : null}
              </div>
            )
          })}
        </div>
      )}

      <p className="px-5 pb-4 text-[10px] leading-4 text-[var(--color-text-tertiary)]">
        {t('settings.plugins.languageServers.known.note')}
      </p>
    </div>
  )
}

function RecommendedSection({
  catalog,
  installingId,
  onInstall,
  t,
}: {
  catalog: CatalogPlugin[]
  installingId: string | null
  onInstall: (entry: CatalogPlugin) => void
  t: ReturnType<typeof useTranslation>
}) {
  if (catalog.length === 0) return null

  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
      <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--color-primary-fixed)] text-[var(--color-brand)]">
              <span className="material-symbols-outlined text-[16px]">download</span>
            </span>
            <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">
              {t('settings.plugins.recommended.title')}
            </h4>
            <span className="text-xs text-[var(--color-text-tertiary)]">{catalog.length}</span>
          </div>
          <p className="text-xs leading-5 text-[var(--color-text-tertiary)]">
            {t('settings.plugins.recommended.description')}
          </p>
        </div>
      </div>

      <div className="grid gap-2 p-2 sm:grid-cols-2">
        {catalog.map((entry) => {
          const isInstalling = installingId === entry.id
          const descKey = CATALOG_DESC_KEY[entry.id]
          const catKey = CATEGORY_LABEL_KEY[entry.category]
          return (
            <div
              key={`${entry.id}@${entry.marketplace}`}
              className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3 min-w-0"
            >
              <div className="flex items-start gap-3 min-w-0">
                <span className="mt-0.5 material-symbols-outlined text-[18px] text-[var(--color-text-tertiary)]">
                  extension
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-[var(--color-text-primary)] break-all">
                      {entry.displayName}
                    </span>
                    <span className="rounded-full bg-[var(--color-surface-container-high)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-tertiary)]">
                      {catKey ? t(catKey) : entry.category}
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-[var(--color-text-secondary)] break-words">
                    {descKey ? t(descKey) : entry.description}
                  </p>
                  <p className="mt-1 text-[10px] text-[var(--color-text-tertiary)] break-all">
                    {entry.id}@{entry.marketplace}
                  </p>
                </div>
              </div>
              <div className="flex items-center justify-end">
                {entry.installed ? (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--color-success)]">
                    <span className="material-symbols-outlined text-[16px]">check_circle</span>
                    {t('settings.plugins.recommended.installed')}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onInstall(entry)}
                    disabled={isInstalling}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] disabled:opacity-60 disabled:cursor-default"
                  >
                    {isInstalling ? (
                      <>
                        <span className="animate-spin w-3.5 h-3.5 border-2 border-[var(--color-brand)] border-t-transparent rounded-full" />
                        {t('settings.plugins.recommended.installing')}
                      </>
                    ) : (
                      <>
                        <span className="material-symbols-outlined text-[16px]">download</span>
                        {t('settings.plugins.recommended.install')}
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function UrlInstallSection({
  value,
  onChange,
  onSubmit,
  loading,
  t,
}: {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  loading: boolean
  t: ReturnType<typeof useTranslation>
}) {
  const trimmed = value.trim()
  const canSubmit = trimmed.length > 0 && !loading

  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
      <div className="px-5 py-4 border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
        <div className="flex items-center gap-2 mb-1">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--color-info-container)] text-[var(--color-info)]">
            <span className="material-symbols-outlined text-[16px]">link</span>
          </span>
          <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">
            {t('settings.plugins.urlInstall.title')}
          </h4>
        </div>
        <p className="text-xs leading-5 text-[var(--color-text-tertiary)]">
          {t('settings.plugins.urlInstall.description')}
        </p>
      </div>
      <div className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center">
        <div className="flex flex-1 min-h-10 items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 transition-colors focus-within:border-[var(--color-border-focus)] focus-within:ring-2 focus-within:ring-[var(--color-brand)]/20">
          <span className="material-symbols-outlined text-[18px] text-[var(--color-text-tertiary)]">
            storefront
          </span>
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t('settings.plugins.urlInstall.placeholder')}
            className="min-w-0 flex-1 bg-transparent text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSubmit) {
                e.preventDefault()
                onSubmit()
              }
            }}
          />
        </div>
        <Button
          size="sm"
          className="min-h-10 sm:flex-none"
          onClick={onSubmit}
          loading={loading}
          disabled={!canSubmit}
        >
          <span className="material-symbols-outlined text-[16px]">add</span>
          {t('settings.plugins.urlInstall.submit')}
        </Button>
      </div>
      <div className="px-4 pb-4 text-[11px] leading-5 text-[var(--color-text-tertiary)]">
        {t('settings.plugins.urlInstall.examples')}
      </div>
    </section>
  )
}
