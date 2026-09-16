import { useEffect, useState, useRef, useId } from 'react'
import { useTranslation, type TranslationKey } from '@/i18n'
import { SearchField } from '@/components/ui/SearchField'
import { SelectField } from '@/components/ui/SelectField'
import { Checkbox } from '@/components/ui/Checkbox'
import { SlidersHorizontal } from 'lucide-react'
import { useDismissable } from '@/hooks/useDismissable'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Input } from '@/components/ui/Input'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { ConnectorRow } from '@/components/connectors/ConnectorRow'
import { useConnectorStore } from '@/stores/connectorStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useChatStore } from '@/stores/chatStore'
import { useTabStore } from '@/stores/tabStore'
import { getDesktopHost } from '@/lib/desktopHost'
import { hasStoredCredentials, primaryAction, safeConnectorUrl } from '@/components/connectors/model'
import type { ConnectorAction, ConnectorActionOptions, ConnectorDto, ConnectorId } from '@/types/connector'

const CATEGORIES = ['office', 'development', 'search', 'maps', 'data', 'design', 'productivity', 'finance', 'legal'] as const
const PLATFORM_LABELS: Record<string, string> = { 'darwin-arm64': 'macOS · Apple Silicon', 'darwin-x64': 'macOS · Intel', 'win32-x64': 'Windows · x64', 'win32-arm64': 'Windows · ARM64' }
const PHASE_KEYS: Record<string, TranslationKey> = {
  downloading: 'connectors.phase.downloading', extracting: 'connectors.phase.extracting', verifying: 'connectors.phase.verifying',
  'awaiting-authorization': 'connectors.phase.awaiting-authorization', 'configuring-account': 'connectors.phase.configuring-account',
  'installing-plugin': 'connectors.phase.installing-plugin', checking: 'connectors.phase.checking',
  'enabling-plugin': 'connectors.phase.enabling-plugin', 'refreshing-sessions': 'connectors.phase.refreshing-sessions',
  'verifying-runtime': 'connectors.phase.verifying-runtime', persistence: 'connectors.phase.persistence', cancelling: 'connectors.phase.cancelling',
  authorizing: 'connectors.phase.authorizing', prepare: 'connectors.status.preparing', authenticate: 'connectors.status.authorizing',
  check: 'connectors.action.check', deactivate: 'connectors.action.deactivate', remove: 'connectors.action.remove',
}

const TOOL_PLUGIN_IDS = new Set(['hyperframes', 'obsidian', 'drawio'])

export function Connectors({ mode = 'plugins', embedded = false, externalQuery, installedFilter = 'all', management = false }: { mode?: 'plugins' | 'skills', embedded?: boolean, externalQuery?: string, installedFilter?: 'all' | 'installed' | 'installable', management?: boolean } = {}) {
  const t = useTranslation()
  const { items, loading, error, pending, refresh, act } = useConnectorStore()
  const [query, setQuery] = useState('')
  const [region, setRegion] = useState<'all' | 'china' | 'global'>('all')
  const [filter, setFilter] = useState<'all' | 'added'>('all')
  const [category, setCategory] = useState<string>('all')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const filterRef = useRef<HTMLDivElement>(null)
  const filterButtonRef = useRef<HTMLButtonElement>(null)
  const filterPanelId = useId()
  useDismissable({ open: filtersOpen, refs: [filterRef], onDismiss: reason => {
    setFiltersOpen(false)
    if (reason === 'escape') filterButtonRef.current?.focus()
  } })
  const activeFilters = [filter === 'added' ? t('connectors.added') : '', region !== 'all' ? t(`connectors.region.${region}`) : '', category !== 'all' ? t(`connectors.category.${category}` as TranslationKey) : ''].filter(Boolean)
  const resetFilters = () => { setFilter('all'); setRegion('all'); setCategory('all') }
  const [selected, setSelected] = useState<ConnectorId | null>(null)
  const [configuration, setConfiguration] = useState<Record<string, string>>({})
  const [invalidFields, setInvalidFields] = useState<string[]>([])
  const [confirmation, setConfirmation] = useState<{ item: ConnectorDto, action: ConnectorAction, options: ConnectorActionOptions } | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const operating = items.some(item => item.operation) || Object.values(pending).some(Boolean)
  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [refresh])
  useEffect(() => {
    if (!operating) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      await refresh(controller.signal)
      if (!controller.signal.aborted) timer = setTimeout(() => { void poll() }, 1500)
    }
    timer = setTimeout(() => { void poll() }, 1500)
    return () => { clearTimeout(timer); controller.abort() }
  }, [operating, refresh])
  const nativeText = (item: ConnectorDto, field: 'name' | 'description' | 'example' | 'requirements') => {
    const key = `connectors.${item.id}.${field}` as TranslationKey
    const translated = t(key)
    if (translated !== key) return translated
    if (item.id === 'feishu' || item.id === 'dingtalk' || item.id === 'wecom') return t(`connectors.${item.id}.${field}`)
    if (field === 'name') return item.displayName || item.packageName || item.id
    if (field === 'description') return item.description || item.capabilities?.join(' · ') || ''
    if (field === 'example') return item.example || t('connectors.remoteExample', { name: item.displayName || item.id })
    return item.requirements || t('connectors.remoteRequirements')
  }
  const name = (item: ConnectorDto) => nativeText(item, 'name')
  const isTool = (item: ConnectorDto) => item.collection === 'tools' || item.transport === 'skills'
  const statusLabel = (item: ConnectorDto) => isTool(item) && ['ready', 'configured', 'needs-auth', 'not-installed'].includes(item.status)
    ? t(item.enabled && (item.status === 'ready' || item.status === 'configured') ? 'connectors.skillsLoaded' : 'connectors.skillsPending')
    : item.transport === 'mcp' && item.status === 'needs-auth' ? t('connectors.needsService') : t(`connectors.status.${item.status}`)
  const phaseLabel = (phase: string) => t(PHASE_KEYS[phase] || 'connectors.waiting')
  const detail = items.find(item => item.id === selected)
  const detailCapabilities = (detail?.capabilities || []).filter(capability => capability !== detail?.description)
  const showDetail = (item: ConnectorDto) => {
    if (selected !== item.id) { setConfiguration({}); setInvalidFields([]); setLocalError(null) }
    setSelected(item.id)
  }
  const closeDetail = () => { setSelected(null); setConfiguration({}); setInvalidFields([]); setLocalError(null) }
  const requestAction = (item: ConnectorDto, action: ConnectorAction, fromDetail = false) => {
    if (!(management && action === 'remove' && !fromDetail)) showDetail(item)
    const fields = item.setupFields || []
    const configAction = action === 'prepare' || action === 'authenticate'
    if (fields.length && configAction && !fromDetail) return
    const values = fromDetail && configAction ? configuration : {}
    if (fields.length && configAction && action === 'authenticate') {
      // Any typed field selects the "replace the stored credential" path, so
      // every setup field must be complete. An entirely blank form is only
      // valid when a credential is already stored; otherwise the missing
      // fields are reported instead of submitting an empty configuration.
      const entered = Object.values(values).some(value => value.trim())
      const missing = entered || !hasStoredCredentials(item) ? fields.filter(field => !values[field.key]?.trim()).map(field => field.key) : []
      setInvalidFields(missing)
      if (missing.length) return
    }
    const nonemptyValues = Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim()))
    const options: ConnectorActionOptions = Object.keys(nonemptyValues).length ? { configuration: nonemptyValues } : {}
    if ((!isTool(item) && item.credentialMode === 'shared' && (action === 'authenticate' || action === 'check')) || action === 'remove') {
      setConfirmation({ item, action, options })
    } else {
      void act(item.id, action, options)
      setConfiguration({})
    }
  }
  const openUrl = async (url: string) => {
    const safe = safeConnectorUrl(url)
    if (!safe) { setLocalError(t('connectors.invalidUrl')); return }
    try { await getDesktopHost().shell.open(safe) } catch { setLocalError(t('connectors.openFailed')) }
  }
  const start = async (item: ConnectorDto) => {
    setStarting(true)
    try {
      const id = await useSessionStore.getState().createSession()
      useChatStore.getState().setComposerDraft(id, { input: nativeText(item, 'example'), attachments: [] })
      useSessionStore.getState().setActiveSession(id)
      useTabStore.getState().openTab(id, t('sidebar.newSession'))
    } catch { setLocalError(t('connectors.startFailed')) } finally { setStarting(false) }
  }
  const actionLabel = (item: ConnectorDto, action: ReturnType<typeof primaryAction>) => isTool(item) && action === 'check' ? t('connectors.verifySkills') : action === 'prepare' && item.installed
    ? t(item.updateAvailable ? 'connectors.update' : 'connectors.retry')
    : action === 'authenticate' && item.transport === 'mcp' ? t('connectors.connectService')
      : action ? t(`connectors.action.${action}`) : t('connectors.details')
  const actions = (item: ConnectorDto) => {
    const action = primaryAction(item)
    const canConfigure = !isTool(item) && item.installed && !!item.setupFields?.length && !item.operation
    const hasNewConfiguration = Object.values(configuration).some(value => value.trim())
    return <div className="flex flex-wrap gap-2">
      {action && !(action === 'authenticate' && canConfigure && hasNewConfiguration) && <Button size="sm" variant="secondary" aria-describedby={error || localError ? 'connector-error' : undefined} disabled={pending[item.id]} onClick={() => requestAction(item, action, true)}>{actionLabel(item, action)}</Button>}
      {canConfigure && (action !== 'authenticate' || hasNewConfiguration) && <Button size="sm" variant="secondary" disabled={!hasNewConfiguration || pending[item.id] || !item.supported} onClick={() => requestAction(item, 'authenticate', true)}>{t('connectors.saveAndVerify')}</Button>}
      {(item.status === 'ready' || item.status === 'configured') && <Button size="sm" variant="secondary" disabled={starting || !item.supported} onClick={() => void start(item)}>{t('connectors.start')}</Button>}
      {item.operation && <Button size="sm" variant="secondary" disabled={pending[item.id]} onClick={() => void act(item.id, 'cancel')}>{t('common.cancel')}</Button>}
      {item.installed && !item.operation && <>
        {item.enabled && <Button size="sm" variant="ghost" disabled={pending[item.id]} onClick={() => void act(item.id, 'deactivate')}>{t('connectors.action.deactivate')}</Button>}
        <Button size="sm" variant="ghost" disabled={pending[item.id]} onClick={() => requestAction(item, 'remove', true)}>{t('connectors.action.remove')}</Button>
      </>}
    </div>
  }
  const inMode = (item: ConnectorDto) => mode === 'skills' ? isTool(item) && !TOOL_PLUGIN_IDS.has(item.id) : !isTool(item) || TOOL_PLUGIN_IDS.has(item.id)
  const availableCategories = CATEGORIES.filter(value => items.some(item => inMode(item) && (item.category || 'office') === value))
  const visible = items.filter(item => {
    const matchesQuery = `${name(item)} ${nativeText(item, 'description')} ${item.packageName} ${(item.capabilities || []).join(' ')}`.toLowerCase().includes((externalQuery ?? query).toLowerCase())
    if (management) return matchesQuery && (item.installed || !!item.operation || !!pending[item.id])
    return matchesQuery && inMode(item)
      && (mode === 'skills' || region === 'all' || !isTool(item) && (item.region || (['feishu', 'dingtalk', 'wecom'].includes(item.id) ? 'china' : 'global')) === region)
      && (filter === 'all' || item.installed)
      && (installedFilter === 'all' || (installedFilter === 'installed' ? item.installed : !item.installed && item.supported))
      && (category === 'all' || (item.category || 'office') === category)
  })
  return <section className={`${embedded ? '' : 'h-full overflow-y-auto'} bg-[var(--color-surface)] text-[var(--color-text-primary)]`}>
    <div className={embedded ? 'py-4' : 'mx-auto max-w-7xl px-5 py-6 lg:px-8'}>
      <h1 className="sr-only">{t(mode === 'skills' ? 'extensions.skills' : 'extensions.plugins')}</h1>
      <header className={embedded ? '' : 'mb-5'}>
        {embedded && <h2 className="mb-3 text-sm font-semibold">{t('extensions.featuredSkills')}</h2>}
        {!embedded && <>
          <div className="flex items-center gap-3">
            <SearchField size="md" value={query} onChange={setQuery} label={t(mode === 'skills' ? 'extensions.searchSkills' : 'extensions.searchPlugins')} placeholder={t(mode === 'skills' ? 'extensions.searchSkills' : 'extensions.searchPlugins')} clearLabel={t('connectors.clear')} containerClassName="min-w-0 flex-1" />
            {!management && <div ref={filterRef} className="relative shrink-0">
              <Button ref={filterButtonRef} size="sm" variant="secondary" aria-expanded={filtersOpen} aria-controls={filterPanelId} onClick={() => setFiltersOpen(value => !value)}>
                <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
                {t('extensions.filter')}{activeFilters.length > 0 && <span className="tabular-nums">{activeFilters.length}</span>}
              </Button>
              {filtersOpen && <div id={filterPanelId} role="region" aria-label={t('extensions.filter')} className="absolute right-0 top-full z-[var(--z-dropdown)] mt-2 w-64 max-w-[calc(100vw-40px)] space-y-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-overlay)]">
                <Checkbox label={t('connectors.added')} checked={filter === 'added'} onChange={event => setFilter(event.target.checked ? 'added' : 'all')} />
                {mode === 'plugins' && <SelectField size="md" label={t('connectors.region')} value={region} onChange={setRegion} options={[{ value: 'all', label: t('connectors.region.all') }, { value: 'china', label: t('connectors.region.china') }, { value: 'global', label: t('connectors.region.global') }]} />}
                <SelectField size="md" label={t('extensions.categories')} value={category} onChange={setCategory} options={[{ value: 'all', label: t('connectors.all') }, ...availableCategories.map(value => ({ value, label: t(`connectors.category.${value}`) }))]} />
                {activeFilters.length > 0 && <Button size="sm" variant="ghost" onClick={resetFilters}>{t('connectors.resetFilters')}</Button>}
              </div>}
            </div>}
          </div>
          {!management && activeFilters.length > 0 && <p className="mt-2 text-xs text-[var(--color-text-secondary)]">{activeFilters.join(' · ')}</p>}
        </>}
      </header>
      {(error || localError) && (!detail || confirmation) && <div id="connector-error" className="mb-4"><ErrorState size="sm" title={t('connectors.loadFailed')} detail={localError || error} onRetry={() => { setLocalError(null); void refresh() }} retryLabel={t('connectors.retry')} /></div>}
      {loading ? <div role="status" aria-label={t('connectors.loading')} className="grid grid-cols-1 gap-3 lg:grid-cols-2">{Array.from({ length: 8 }, (_, index) => <div key={index} className="flex h-28 items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] px-4"><Skeleton shape="block" width="40px" height="40px" /><div className="flex-1 space-y-2"><Skeleton width="40%" /><Skeleton /><Skeleton width="72%" /></div></div>)}</div>
        : visible.length ? <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">{visible.map(item => <ConnectorRow key={item.id} id={item.id} name={name(item)} description={nativeText(item, 'description')} kind={isTool(item) && mode !== 'skills' ? t('connectors.toolKind') : undefined} status={!item.supported ? t('connectors.unsupported') : item.installed || item.operation || item.status === 'error' ? statusLabel(item) : undefined} added={item.installed || !!item.operation || management} actionLabel={t('connectors.details')} action={management && item.installed && !item.operation ? <Button size="sm" variant="secondary" disabled={pending[item.id]} onClick={() => requestAction(item, 'remove')}>{t('market.uninstall.action')}</Button> : undefined} onDetails={() => showDetail(item)} onAction={() => showDetail(item)} />)}</div>
          : <EmptyState variant="plain" size="md" title={t('extensions.empty')} description={t(management ? (externalQuery ?? query).trim() ? 'connectors.emptySearch' : 'connectors.emptyAdded' : filter === 'added' ? 'connectors.emptyAdded' : 'connectors.emptySearch')} action={embedded || management ? undefined : { label: t('connectors.resetFilters'), variant: 'secondary', onClick: () => { setFilter('all'); setCategory('all'); setRegion('all'); setQuery('') } }} />}
    </div>
    <Modal open={!!detail && !confirmation} onClose={closeDetail} title={detail ? name(detail) : ''} width={600} footer={detail ? actions(detail) : undefined}>
      {detail && <div className="space-y-4 text-xs leading-5">
        <p className="text-sm text-[var(--color-text-secondary)]">{nativeText(detail, 'description')}</p>
        <div className="flex items-center gap-2"><Badge tone="neutral">{statusLabel(detail)}</Badge><span className="text-[var(--color-text-tertiary)]">{isTool(detail) ? t(mode === 'skills' ? 'extensions.skills' : 'connectors.toolKind') : detail.transport === 'mcp' ? 'MCP' : 'CLI'}</span></div>
        <p className="text-[var(--color-text-secondary)]">{nativeText(detail, 'requirements')}</p>
        {(error || localError) && <div id="connector-error"><ErrorState size="sm" title={t('connectors.loadFailed')} detail={localError || error} /></div>}
        {!isTool(detail) && !!detail.setupFields?.length && <div className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-3">
          <p className="font-medium">{t('connectors.configuration')}</p>
          <p className="text-[var(--color-text-tertiary)]">{t('connectors.configurationHint')}</p>
          {detail.setupFields.map(field => <Input key={field.key} size="md" label={field.label} type={field.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} placeholder={field.placeholder} value={configuration[field.key] || ''} error={invalidFields.includes(field.key) ? t('connectors.fieldRequired') : undefined} onChange={event => { setConfiguration(state => ({ ...state, [field.key]: event.target.value })); setInvalidFields(state => state.filter(key => key !== field.key)) }} />)}
        </div>}
        {!!detailCapabilities.length && <div><h3 className="mb-1 font-medium">{t('connectors.capabilities')}</h3><p className="text-[var(--color-text-secondary)]">{detailCapabilities.join(' · ')}</p></div>}
        <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 border-y border-[var(--color-border)] py-3 [&>dt]:text-[var(--color-text-tertiary)] [&>dd]:min-w-0 [&>dd]:break-words">
          {!isTool(detail) && <><dt>{t('connectors.account')}</dt><dd>{detail.accountLabel || t(detail.connection === 'connected' ? 'connectors.currentAccount' : 'connectors.noAccount')}</dd></>}
          <dt>{t('connectors.platforms')}</dt><dd>{detail.platforms.map(platform => PLATFORM_LABELS[platform] || platform).join(', ')}</dd>
          <dt>{t('connectors.source')}</dt><dd>{detail.transport === 'mcp' ? t('connectors.officialMcp') : detail.packageName}<Button size="xs" variant="ghost" onClick={() => void openUrl(detail.homepage)}>{t('connectors.homepage')}</Button></dd>
          <dt>{t('connectors.version')}</dt><dd>{detail.installedVersion || detail.version}{detail.updateAvailable && <p>{t('connectors.updateAvailable')}: {detail.version}</p>}</dd>
          <dt>{t('connectors.skills')}</dt><dd>{name(detail)} · {detail.pluginId}</dd>
        </dl>
        <p className="text-[var(--color-text-tertiary)]">{t(isTool(detail) ? 'connectors.skillsRuntimeInfo' : detail.credentialMode === 'shared' ? 'connectors.shared' : 'connectors.isolated')}</p>
        {!isTool(detail) && detail.status === 'configured' && <p>{t('connectors.localVerification')}</p>}
        <div><h3 className="mb-1 font-medium">{t('connectors.example')}</h3><p className="text-[var(--color-text-secondary)]">{nativeText(detail, 'example')}</p></div>
        {detail.error && <ErrorState size="sm" title={detail.failedPhase ? `${t('connectors.phase.failed')}: ${phaseLabel(detail.failedPhase)}` : t('connectors.status.error')} detail={detail.error} />}
        {detail.operation && <div role="status" className="space-y-2 border-t border-[var(--color-border)] pt-3"><p>{phaseLabel(detail.operation.phase)}</p>{!isTool(detail) && detail.operation.authUrl && <Button size="sm" variant="secondary" onClick={() => void openUrl(detail.operation!.authUrl!)}>{t('connectors.authorize')}</Button>}</div>}
      </div>}
    </Modal>
    <ConfirmDialog open={!!confirmation} onClose={() => setConfirmation(null)} title={t('connectors.confirm')} body={confirmation?.action === 'remove' ? t(confirmation && isTool(confirmation.item) ? 'connectors.toolsRemoveInfo' : 'connectors.removeInfo') : t('connectors.shared')} confirmLabel={t('connectors.continue')} cancelLabel={t('common.cancel')} confirmVariant="primary" onConfirm={() => { if (confirmation) void act(confirmation.item.id, confirmation.action, { ...confirmation.options, acknowledgeSharedCredentials: true }); setConfiguration({}); setConfirmation(null) }} />
  </section>
}
