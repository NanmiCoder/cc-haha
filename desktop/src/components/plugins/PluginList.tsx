import { useEffect, useMemo, useState } from 'react'
import { usePluginStore } from '../../stores/pluginStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTranslation } from '../../i18n'
import type { TranslationKey } from '../../i18n'
import { useUIStore } from '../../stores/uiStore'
import { Button } from '../shared/Button'
import { ConfirmDialog } from '../shared/ConfirmDialog'
import { ToggleSwitch } from '../shared/ToggleSwitch'
import type { CatalogPlugin, PluginSummary } from '../../types/plugin'

type PluginBucket = 'attention' | 'enabled' | 'disabled'

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
  } = usePluginStore()
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const addToast = useUIStore((s) => s.addToast)
  const t = useTranslation()
  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const currentWorkDir = activeSession?.workDir || undefined
  const [marketplaceInput, setMarketplaceInput] = useState('')
  // Per-plugin action tracking — keyed by `${pluginId}:${action}` so a row can
  // show its own spinner without blocking sibling rows.
  const [pendingActionKey, setPendingActionKey] = useState<string | null>(null)
  const [pendingUninstall, setPendingUninstall] = useState<PluginSummary | null>(null)

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
    } catch (err) {
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setPendingActionKey(null)
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
      </section>

      <RecommendedSection
        catalog={catalog}
        installingId={installingCatalogId}
        onInstall={handleInstallCatalog}
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

      {renderGroup('attention', grouped.attention, fetchPluginDetail, currentWorkDir, t, {
        onToggle: handleInlineToggle,
        onAskUninstall: setPendingUninstall,
        pendingActionKey,
      })}
      {renderGroup('enabled', grouped.enabled, fetchPluginDetail, currentWorkDir, t, {
        onToggle: handleInlineToggle,
        onAskUninstall: setPendingUninstall,
        pendingActionKey,
      })}
      {renderGroup('disabled', grouped.disabled, fetchPluginDetail, currentWorkDir, t, {
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
    </div>
  )
}

type RowActions = {
  onToggle: (plugin: PluginSummary) => void
  onAskUninstall: (plugin: PluginSummary) => void
  /** `${pluginId}:${action}` of the action currently in flight, or null. */
  pendingActionKey: string | null
}

function renderGroup(
  bucket: PluginBucket,
  items: PluginSummary[],
  fetchPluginDetail: (id: string, cwd?: string) => Promise<void>,
  cwd: string | undefined,
  t: ReturnType<typeof useTranslation>,
  actions: RowActions,
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
          const canMutate = plugin.scope !== 'managed' && plugin.scope !== 'builtin'
          const isToggling = actions.pendingActionKey === `${plugin.id}:toggle`
          const isUninstalling = actions.pendingActionKey === `${plugin.id}:uninstall`
          return (
            <div
              key={plugin.id}
              className="group flex items-start gap-3 rounded-xl border border-transparent px-3 py-3 transition-all hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface-hover)]"
            >
              <button
                type="button"
                onClick={() => void fetchPluginDetail(plugin.id, cwd)}
                className="flex flex-1 min-w-0 items-start gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] rounded-lg"
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
                    onChange={() => actions.onToggle(plugin)}
                    ariaLabel={`${plugin.enabled ? t('settings.plugins.disable') : t('settings.plugins.enable')} ${plugin.name}`}
                  />
                ) : null}
                {canMutate && (
                  <button
                    type="button"
                    onClick={() => actions.onAskUninstall(plugin)}
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
          )
        })}
      </div>
    </section>
  )
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
