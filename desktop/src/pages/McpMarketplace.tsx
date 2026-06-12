import { useEffect, useMemo, useState } from 'react'
import { Button } from '../components/shared/Button'
import { Input } from '../components/shared/Input'
import { Modal } from '../components/shared/Modal'
import { useTranslation } from '../i18n'
import { mcpApi } from '../api/mcp'
import { useMcpStore } from '../stores/mcpStore'
import { useUIStore } from '../stores/uiStore'
import type {
  MarketplaceCatalog,
  MarketplaceCategory,
  MarketplaceEntry,
  MarketplaceRemoteSource,
  McpServerRecord,
  McpUpsertPayload,
  McpWritableScope,
} from '../types/mcp'

const CATEGORY_ORDER: MarketplaceCategory[] = [
  'browser',
  'dev-platform',
  'data',
  'memory',
  'search',
  'productivity',
  'ai',
  'utility',
]

const SCOPE_OPTIONS: McpWritableScope[] = ['local', 'project', 'user']

function formatRelativeTime(timestamp: number, locale: string): string {
  // RelativeTimeFormat support is universal in modern Electron, so use it for
  // a localized "5 minutes ago" without having to keep our own translation
  // matrix in sync.
  try {
    const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
    const diffSeconds = Math.round((timestamp - Date.now()) / 1000)
    const absDiff = Math.abs(diffSeconds)
    if (absDiff < 60) return formatter.format(diffSeconds, 'second')
    if (absDiff < 3600) return formatter.format(Math.round(diffSeconds / 60), 'minute')
    if (absDiff < 86400) return formatter.format(Math.round(diffSeconds / 3600), 'hour')
    return formatter.format(Math.round(diffSeconds / 86400), 'day')
  } catch {
    return new Date(timestamp).toLocaleString()
  }
}

function commandPreview(entry: MarketplaceEntry): string {
  if (entry.transport.type === 'stdio') {
    return [entry.transport.command, ...entry.transport.args].join(' ').trim()
  }
  return entry.transport.url
}

/**
 * Match an existing MCP server against a marketplace entry by *transport
 * shape*. We deliberately ignore the user-chosen save name (the install
 * modal lets users rename) and instead compare what actually gets spawned:
 * the stdio command + args, or the http/sse URL. Env values aren't part
 * of the match — two installs of the same package with different tokens
 * still count as "this server is here".
 */
function entryMatchesServer(
  entry: MarketplaceEntry,
  server: Pick<McpServerRecord, 'config'>,
): boolean {
  const config = server.config as {
    type: string
    command?: unknown
    args?: unknown
    url?: unknown
  }
  if (entry.transport.type === 'stdio') {
    if (config.type !== 'stdio') return false
    if (config.command !== entry.transport.command) return false
    const args = Array.isArray(config.args) ? (config.args as unknown[]) : []
    const expected = entry.transport.args
    if (args.length !== expected.length) return false
    for (let i = 0; i < expected.length; i++) {
      if (args[i] !== expected[i]) return false
    }
    return true
  }
  if (entry.transport.type === 'http' || entry.transport.type === 'sse') {
    if (config.type !== entry.transport.type) return false
    return config.url === entry.transport.url
  }
  return false
}

function findInstalledServer(
  entry: MarketplaceEntry,
  servers: McpServerRecord[],
): McpServerRecord | undefined {
  return servers.find((server) => entryMatchesServer(entry, server))
}

function buildUpsertPayload(
  entry: MarketplaceEntry,
  scope: McpWritableScope,
  envValues: Record<string, string>,
): McpUpsertPayload {
  if (entry.transport.type === 'stdio') {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(envValues)) {
      if (value.trim().length > 0) {
        env[key] = value
      }
    }
    return {
      scope,
      config: {
        type: 'stdio',
        command: entry.transport.command,
        args: entry.transport.args,
        env,
      },
    }
  }
  // http / sse — no env input today
  return {
    scope,
    config: {
      type: entry.transport.type,
      url: entry.transport.url,
      headers: {},
    },
  }
}

type AddSourceDraft = { url: string; label: string }

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; catalog: MarketplaceCatalog }

export type MarketplacePageProps = {
  cwd?: string
  onBack: () => void
  onInstalled: (server: McpServerRecord) => void
  /**
   * Called when the user clicks "Configure" on an entry that already maps
   * to an installed server. Lets the parent settings view jump straight
   * into the existing server's details/edit screen instead of forcing a
   * round-trip through the marketplace back button.
   */
  onOpenInstalled?: (server: McpServerRecord) => void
}

export function MarketplacePage({
  cwd,
  onBack,
  onInstalled,
  onOpenInstalled,
}: MarketplacePageProps) {
  const t = useTranslation()
  const addToast = useUIStore((s) => s.addToast)
  const servers = useMcpStore((s) => s.servers)
  const browserLocale = typeof navigator !== 'undefined' ? navigator.language : 'en'

  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [refreshKey, setRefreshKey] = useState(0)
  const [isRefreshingRemotes, setIsRefreshingRemotes] = useState(false)
  const [installEntry, setInstallEntry] = useState<MarketplaceEntry | null>(null)
  const [installScope, setInstallScope] = useState<McpWritableScope>('local')
  const [installName, setInstallName] = useState('')
  const [installEnv, setInstallEnv] = useState<Record<string, string>>({})
  const [isInstalling, setIsInstalling] = useState(false)
  const [showAddSource, setShowAddSource] = useState(false)
  const [addSourceDraft, setAddSourceDraft] = useState<AddSourceDraft>({ url: '', label: '' })
  const [isAddingSource, setIsAddingSource] = useState(false)

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    mcpApi.marketplace
      .list()
      .then((catalog) => {
        if (!cancelled) setState({ status: 'ready', catalog })
      })
      .catch((error) => {
        if (cancelled) return
        setState({
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        })
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  const groupedEntries = useMemo(() => {
    if (state.status !== 'ready') return new Map<MarketplaceCategory, MarketplaceEntry[]>()
    const groups = new Map<MarketplaceCategory, MarketplaceEntry[]>()
    for (const entry of state.catalog.entries) {
      const list = groups.get(entry.category) ?? []
      list.push(entry)
      groups.set(entry.category, list)
    }
    return groups
  }, [state])

  const handleRefreshRemotes = async () => {
    if (isRefreshingRemotes) return
    setIsRefreshingRemotes(true)
    try {
      const catalog = await mcpApi.marketplace.refresh()
      setState({ status: 'ready', catalog })
    } catch (error) {
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setIsRefreshingRemotes(false)
    }
  }

  const handleAddSource = async () => {
    const url = addSourceDraft.url.trim()
    if (!url) return
    setIsAddingSource(true)
    try {
      await mcpApi.marketplace.addSource({
        url,
        label: addSourceDraft.label.trim() || undefined,
      })
      setAddSourceDraft({ url: '', label: '' })
      setShowAddSource(false)
      setRefreshKey((value) => value + 1)
    } catch (error) {
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setIsAddingSource(false)
    }
  }

  const handleRemoveSource = async (source: MarketplaceRemoteSource) => {
    const label = source.label || source.url
    if (!confirm(t('settings.mcp.marketplace.removeSourceConfirm', { label }))) return
    try {
      await mcpApi.marketplace.removeSource(source.id)
      setRefreshKey((value) => value + 1)
    } catch (error) {
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const openInstall = (entry: MarketplaceEntry) => {
    setInstallEntry(entry)
    setInstallScope('local')
    setInstallName(entry.id)
    const initialEnv: Record<string, string> = {}
    for (const variable of entry.requiresEnv ?? []) {
      initialEnv[variable.name] = ''
    }
    setInstallEnv(initialEnv)
  }

  const closeInstall = () => {
    if (isInstalling) return
    setInstallEntry(null)
  }

  /**
   * `requiresEnv` literally says "required". Empty values block the
   * Confirm button so users don't install a server that immediately
   * crashes with `-32000 Connection closed` because a token is missing.
   */
  const missingRequiredEnv = useMemo(() => {
    if (!installEntry) return []
    return (installEntry.requiresEnv ?? []).filter(
      (variable) => (installEnv[variable.name] ?? '').trim().length === 0,
    )
  }, [installEntry, installEnv])

  const canConfirmInstall = installName.trim().length > 0 && missingRequiredEnv.length === 0

  const handleInstall = async () => {
    if (!installEntry) return
    const trimmedName = installName.trim()
    if (!trimmedName) return
    setIsInstalling(true)
    try {
      const payload = buildUpsertPayload(installEntry, installScope, installEnv)
      const { server } = await mcpApi.create(trimmedName, payload, cwd)
      addToast({
        type: 'success',
        message: t('settings.mcp.marketplace.installSuccess', { name: trimmedName }),
      })
      setInstallEntry(null)
      onInstalled(server)
    } catch (error) {
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('settings.mcp.marketplace.installFailed'),
      })
    } finally {
      setIsInstalling(false)
    }
  }

  const remoteSources = state.status === 'ready' ? state.catalog.remoteSources : []

  return (
    <div className="max-w-5xl min-w-0">
      <button
        type="button"
        onClick={onBack}
        className="mb-5 inline-flex items-center gap-2 text-sm text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
      >
        <span className="material-symbols-outlined text-[18px]">arrow_back</span>
        {t('settings.mcp.marketplace.back')}
      </button>

      <div className="flex items-start justify-between gap-4 mb-8">
        <div>
          <h2 className="text-[2.2rem] font-semibold tracking-[-0.03em] text-[var(--color-text-primary)]">
            {t('settings.mcp.marketplace.title')}
          </h2>
          <p className="mt-3 text-base text-[var(--color-text-secondary)]">
            {t('settings.mcp.marketplace.description')}
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <Button
            variant="secondary"
            onClick={handleRefreshRemotes}
            loading={isRefreshingRemotes}
          >
            <span className="material-symbols-outlined text-[16px]">refresh</span>
            {t('settings.mcp.marketplace.refresh')}
          </Button>
          <Button onClick={() => setShowAddSource(true)}>
            <span className="material-symbols-outlined text-[16px]">add</span>
            {t('settings.mcp.marketplace.addSource')}
          </Button>
        </div>
      </div>

      {/* Sources management strip */}
      <section className="mb-8 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <div className="mb-3 text-sm font-semibold text-[var(--color-text-primary)]">
          {t('settings.mcp.marketplace.sourcesHeading')}
        </div>
        <ul className="flex flex-col gap-2">
          <li className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] bg-[var(--color-surface-hover)] px-3 py-2">
            <div className="flex items-center gap-2 text-sm text-[var(--color-text-primary)]">
              <span className="material-symbols-outlined text-[16px] text-[var(--color-text-secondary)]">
                star
              </span>
              {t('settings.mcp.marketplace.sourcesBuiltin')}
            </div>
          </li>
          {remoteSources.length === 0 && (
            <li className="px-3 py-2 text-xs text-[var(--color-text-tertiary)]">
              {t('settings.mcp.marketplace.sourcesEmpty')}
            </li>
          )}
          {remoteSources.map((source) => {
            const label = source.label || source.url
            const time = source.fetchedAt
              ? formatRelativeTime(source.fetchedAt, browserLocale)
              : null
            return (
              <li
                key={source.id}
                className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-[var(--color-text-primary)]">{label}</div>
                  <div className="mt-1 truncate text-xs text-[var(--color-text-tertiary)]">
                    {source.url}
                  </div>
                  {source.error ? (
                    <div className="mt-1 truncate text-xs text-[var(--color-inspector-danger)]">
                      {t('settings.mcp.marketplace.sourceError', { error: source.error })}
                    </div>
                  ) : time ? (
                    <div className="mt-1 text-xs text-[var(--color-text-tertiary)]">
                      {t('settings.mcp.marketplace.sourceFetched', { time })}
                    </div>
                  ) : null}
                </div>
                <Button
                  variant="ghost"
                  onClick={() => void handleRemoveSource(source)}
                >
                  {t('settings.mcp.marketplace.removeSource')}
                </Button>
              </li>
            )
          })}
        </ul>
      </section>

      {/* Catalog by category */}
      {state.status === 'loading' && (
        <div className="py-12 text-center text-sm text-[var(--color-text-secondary)]">
          {t('settings.mcp.tools.loading')}
        </div>
      )}

      {state.status === 'error' && (
        <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-inspector-danger-bg)] p-4 text-sm text-[var(--color-inspector-danger)]">
          {state.error}
        </div>
      )}

      {state.status === 'ready' && state.catalog.entries.length === 0 && (
        <div className="py-12 text-center text-sm text-[var(--color-text-secondary)]">
          {t('settings.mcp.marketplace.empty')}
        </div>
      )}

      {state.status === 'ready' && state.catalog.entries.length > 0 && (
        <div className="flex flex-col gap-8">
          {CATEGORY_ORDER.map((category) => {
            const entries = groupedEntries.get(category)
            if (!entries || entries.length === 0) return null
            return (
              <section key={category}>
                <div className="mb-3 flex items-baseline justify-between">
                  <h3 className="text-base font-semibold text-[var(--color-text-primary)]">
                    {t(`settings.mcp.marketplace.category.${category}`)}
                  </h3>
                  <span className="text-xs text-[var(--color-text-tertiary)]">
                    {entries.length}
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {entries.map((entry) => {
                    const installedServer = findInstalledServer(entry, servers)
                    return (
                    <article
                      key={`${entry.source}:${entry.id}`}
                      className="flex h-full flex-col rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
                    >
                      <div className="mb-2 flex items-start justify-between gap-2">
                        <h4 className="text-base font-semibold text-[var(--color-text-primary)]">
                          {entry.name}
                        </h4>
                        <div className="flex items-center gap-1.5">
                          {installedServer && (
                            <span className="rounded-full border border-[var(--color-inspector-success)] bg-[var(--color-inspector-success-bg)] px-2 py-[2px] text-[10px] font-medium text-[var(--color-inspector-success)]">
                              {t('settings.mcp.marketplace.installedBadge')}
                            </span>
                          )}
                          {entry.source !== 'builtin' && (
                            <span className="rounded-full border border-[var(--color-border)] px-2 py-[2px] text-[10px] font-medium text-[var(--color-text-tertiary)]">
                              {entry.source}
                            </span>
                          )}
                        </div>
                      </div>
                      <p className="text-sm text-[var(--color-text-secondary)]">
                        {entry.description}
                      </p>
                      <code className="mt-3 block break-all rounded-[var(--radius-md)] bg-[var(--color-surface-hover)] px-2 py-1 font-mono text-[11px] text-[var(--color-text-tertiary)]">
                        {commandPreview(entry)}
                      </code>
                      <div className="mt-4 flex items-center justify-between gap-2">
                        {entry.homepage ? (
                          <a
                            href={entry.homepage}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="text-xs text-[var(--color-text-secondary)] underline-offset-2 transition-colors hover:text-[var(--color-text-primary)] hover:underline"
                          >
                            {t('settings.mcp.marketplace.openHomepage')}
                          </a>
                        ) : (
                          <span />
                        )}
                        {installedServer ? (
                          onOpenInstalled ? (
                            <Button
                              variant="secondary"
                              onClick={() => onOpenInstalled(installedServer)}
                            >
                              <span className="material-symbols-outlined text-[16px]">
                                tune
                              </span>
                              {t('settings.mcp.marketplace.configure')}
                            </Button>
                          ) : (
                            <Button variant="secondary" disabled>
                              <span className="material-symbols-outlined text-[16px]">
                                check
                              </span>
                              {t('settings.mcp.marketplace.installed')}
                            </Button>
                          )
                        ) : (
                          <Button onClick={() => openInstall(entry)}>
                            <span className="material-symbols-outlined text-[16px]">
                              download
                            </span>
                            {t('settings.mcp.marketplace.install')}
                          </Button>
                        )}
                      </div>
                    </article>
                    )
                  })}
                </div>
              </section>
            )
          })}
        </div>
      )}

      {/* Install confirmation modal */}
      <Modal
        open={installEntry !== null}
        onClose={closeInstall}
        title={installEntry ? t('settings.mcp.marketplace.installTitle', { name: installEntry.name }) : ''}
        width={560}
        footer={
          <>
            <Button variant="ghost" onClick={closeInstall} disabled={isInstalling}>
              {t('settings.mcp.marketplace.installCancel')}
            </Button>
            <Button
              onClick={handleInstall}
              loading={isInstalling}
              disabled={!canConfirmInstall}
            >
              {t('settings.mcp.marketplace.installConfirm')}
            </Button>
          </>
        }
      >
        {installEntry && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-[var(--color-text-secondary)]">
              {t('settings.mcp.marketplace.installHint')}
            </p>

            <div>
              <label className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]">
                {t('settings.mcp.marketplace.installNameLabel')}
              </label>
              <Input
                value={installName}
                onChange={(event) => setInstallName(event.target.value)}
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]">
                {t('settings.mcp.marketplace.installScopeLabel')}
              </label>
              <div className="flex flex-wrap gap-2">
                {SCOPE_OPTIONS.map((scope) => (
                  <button
                    key={scope}
                    type="button"
                    onClick={() => setInstallScope(scope)}
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                      installScope === scope
                        ? 'border-[var(--color-text-primary)] bg-[var(--color-surface-hover)] text-[var(--color-text-primary)]'
                        : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                    }`}
                  >
                    {t(`settings.mcp.scope.${scope}` as const)}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]">
                {t('settings.mcp.marketplace.installCommandLabel')}
              </label>
              <code className="block break-all rounded-[var(--radius-md)] bg-[var(--color-surface-hover)] px-3 py-2 font-mono text-xs text-[var(--color-text-secondary)]">
                {commandPreview(installEntry)}
              </code>
            </div>

            {(installEntry.requiresEnv ?? []).length > 0 && (
              <div>
                <div className="mb-1 text-sm font-medium text-[var(--color-text-primary)]">
                  {t('settings.mcp.marketplace.installEnvHeading')}
                </div>
                <p className="mb-2 text-xs text-[var(--color-text-tertiary)]">
                  {t('settings.mcp.marketplace.installEnvHint')}
                </p>
                <div className="flex flex-col gap-3">
                  {(installEntry.requiresEnv ?? []).map((variable) => {
                    const isMissing =
                      (installEnv[variable.name] ?? '').trim().length === 0
                    return (
                      <div key={variable.name}>
                        <label className="mb-1 flex items-center gap-1 text-xs font-medium text-[var(--color-text-secondary)]">
                          <code className="font-mono">{variable.name}</code>
                          <span
                            aria-hidden="true"
                            className="text-[var(--color-inspector-danger)]"
                          >
                            *
                          </span>
                        </label>
                        <Input
                          value={installEnv[variable.name] ?? ''}
                          onChange={(event) =>
                            setInstallEnv((current) => ({
                              ...current,
                              [variable.name]: event.target.value,
                            }))
                          }
                          placeholder={variable.description}
                          aria-required="true"
                          aria-invalid={isMissing}
                        />
                      </div>
                    )
                  })}
                </div>
                {missingRequiredEnv.length > 0 && (
                  <p className="mt-2 text-xs text-[var(--color-inspector-danger)]">
                    {t('settings.mcp.marketplace.installEnvMissing', {
                      names: missingRequiredEnv.map((v) => v.name).join(', '),
                    })}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Add source modal */}
      <Modal
        open={showAddSource}
        onClose={() => {
          if (isAddingSource) return
          setShowAddSource(false)
          setAddSourceDraft({ url: '', label: '' })
        }}
        title={t('settings.mcp.marketplace.addSource')}
        width={520}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setShowAddSource(false)
                setAddSourceDraft({ url: '', label: '' })
              }}
              disabled={isAddingSource}
            >
              {t('settings.mcp.marketplace.addSourceCancel')}
            </Button>
            <Button
              onClick={handleAddSource}
              loading={isAddingSource}
              disabled={addSourceDraft.url.trim().length === 0}
            >
              {t('settings.mcp.marketplace.addSourceConfirm')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]">
              {t('settings.mcp.marketplace.addSourceUrlLabel')}
            </label>
            <Input
              value={addSourceDraft.url}
              onChange={(event) =>
                setAddSourceDraft((current) => ({ ...current, url: event.target.value }))
              }
              placeholder={t('settings.mcp.marketplace.addSourceUrlPlaceholder')}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]">
              {t('settings.mcp.marketplace.addSourceLabel')}
            </label>
            <Input
              value={addSourceDraft.label}
              onChange={(event) =>
                setAddSourceDraft((current) => ({ ...current, label: event.target.value }))
              }
              placeholder={t('settings.mcp.marketplace.addSourceLabelPlaceholder')}
            />
          </div>
        </div>
      </Modal>
    </div>
  )
}
