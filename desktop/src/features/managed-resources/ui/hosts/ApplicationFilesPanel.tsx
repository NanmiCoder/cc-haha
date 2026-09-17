import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronRight, Download, Eye, FileText, FolderOpen, Pin, PinOff, Play, RefreshCw, Search, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { IconButton } from '@/components/ui/IconButton'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Modal } from '@/components/ui/Modal'
import { useTranslation } from '@/i18n'
import { getDesktopHost } from '@/lib/desktopHost'
import { APPLICATION_DIRECTORIES, isApplicationLog, isApplicationScript, type ApplicationFile, type ApplicationFileTarget, type ApplicationOperation, type ApplicationOperationInput } from '../../api/applicationOperationsApi'
import type { Host, HostApplication } from '../../types/resourceTypes'
import { useHostSshStore } from '../../stores/hostSshStore'
import { useRemoteTransfers } from './useRemoteTransfers'
import { ApplicationOperationDialog } from './ApplicationOperationDialog'
import { ApplicationWorkspaceFrame } from './ApplicationWorkspaceFrame'
import { useHostToolsPreferences } from './useHostToolsPreferences'
import { ApplicationExecutionUser } from './ApplicationExecutionUser'

type Action = 'read' | 'delete' | 'script' | 'tail' | 'download'
type Selection = { target: ApplicationFileTarget; entry: ApplicationFile; action: Action; runAsUser?: string }
const bytes = (size: number) => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / (1024 * 1024)).toFixed(1)} MiB`

function ApplicationDirectoryPanel({ target, root, refresh, onAction, expanded, onToggle, config }: { target: ApplicationFileTarget; root: string; refresh: number; onAction: (selection: Selection) => void; expanded: boolean; onToggle: () => void; config: ReturnType<typeof useHostToolsPreferences> }) {
  const t = useTranslation()
  const label = (key: string) => t(`managedResources.appOperations.${key}` as never)
  const bodyId = useId()
  const [relative, setRelative] = useState('')
  const [entries, setEntries] = useState<ApplicationFile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const [searchText, setSearchText] = useState('')
  const [query, setQuery] = useState('')
  // The main-process preferences repository owns pins across reconnects and restarts.
  // Only acknowledged writes change the icon; a failed save must not look successful.
  const pinned = useMemo(() => new Set(config.preferences.pinnedFiles
    .filter(pin => pin.directory === target.directory).map(pin => pin.relativePath)), [config.preferences.pinnedFiles, target.directory])
  const composing = useRef(false)
  const listRef = useRef<HTMLDivElement>(null)
  const normalizedQuery = query.trim().normalize('NFC').toLowerCase()
  const visibleEntries = useMemo(() => {
    const matches = entries.filter(entry => entry.name.normalize('NFC').toLowerCase().includes(normalizedQuery))
    return [...matches.filter(entry => pinned.has(entry.relativePath)), ...matches.filter(entry => !pinned.has(entry.relativePath))]
  }, [entries, normalizedQuery, pinned])
  const clearSearch = () => { setSearchText(''); setQuery('') }
  const navigate = (next: string) => { clearSearch(); setRelative(next) }
  const togglePin = (entry: ApplicationFile) => {
    void config.save({ pinFile: { directory: target.directory, relativePath: entry.relativePath, pinned: !pinned.has(entry.relativePath) } })
  }
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0
  }, [normalizedQuery, relative, pinned])
  useEffect(() => {
    let disposed = false
    setLoading(true); setError(null)
    void getDesktopHost().hostManagement.applicationOperation({ ...target, action: 'list', relativePath: relative }).then(result => {
      if (disposed) return
      if (!result.ok) { setError(result.error.code); setEntries([]) }
      else if (result.data.kind === 'files') setEntries(result.data.entries)
    }).catch(() => { if (!disposed) setError('DISCONNECTED') }).finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true }
  }, [target, relative, refresh, nonce])
  const fullPath = `${root.replace(/\/+$/, '')}/${target.directory}${relative ? '/' + relative : ''}`
  return <section aria-label={target.directory} data-app-directory={target.directory} data-collapsed={!expanded} className={`flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] ${expanded ? 'p-3' : 'p-2'}`}>
    <div className={`flex shrink-0 gap-2 ${expanded ? 'items-center justify-between' : 'h-full flex-col items-center'}`}>
      <h4 className="min-w-0 flex-1 font-mono text-xs font-semibold">
        <button type="button" aria-expanded={expanded} aria-controls={bodyId} disabled={!config.ready} onClick={onToggle} className={`flex w-full min-w-0 items-center gap-1.5 rounded text-left hover:text-[var(--color-brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${expanded ? '' : 'h-full flex-col'}`}>
          <ChevronRight size={14} aria-hidden="true" className={`shrink-0 ${expanded ? 'rotate-180' : ''}`} />
          <span className="truncate" style={expanded ? undefined : { writingMode: 'vertical-rl' }}>{target.directory}</span>
        </button>
      </h4>
      <Button size="xs" variant="ghost" icon={<RefreshCw size={12} />} disabled={loading} onClick={() => setNonce(n => n + 1)} aria-label={`${label('refresh')}: ${target.directory}`}>{expanded ? label('refresh') : null}</Button>
    </div>
    <div id={bodyId} hidden={!expanded} className={expanded ? 'flex min-h-0 flex-1 flex-col' : ''}>
      <p className="mb-2 break-all font-mono text-[11px] text-[var(--color-text-tertiary)]">{fullPath}</p>
      {target.directory === 'bin/bin' && <ApplicationExecutionUser value={config.preferences.runAsUser} disabled={!config.ready || config.saving} onSave={value => config.save({ runAsUser: value })} />}
      <div className="mb-2 flex shrink-0 items-center gap-1">
        <Search size={13} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
        <Input id={`${bodyId}-search`} type="search" size="sm" data-application-file-search=""
          aria-label={`${label('search')}: ${target.directory}`} placeholder={label('searchPlaceholder')}
          containerClassName="min-w-0 flex-1" className="[&::-webkit-search-cancel-button]:hidden"
          autoComplete="off" spellCheck={false} value={searchText}
          onChange={event => { setSearchText(event.currentTarget.value); if (!composing.current) setQuery(event.currentTarget.value) }}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={event => { composing.current = false; setQuery(event.currentTarget.value) }}
          onKeyDown={event => {
            if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
            if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation() }
            if (event.key === 'Escape' && searchText) { event.preventDefault(); event.stopPropagation(); clearSearch() }
          }} />
        <IconButton size="xs" icon={<X size={13} />} label={`${label('clearSearch')}: ${target.directory}`}
          disabled={!searchText} onClick={() => { clearSearch(); document.getElementById(`${bodyId}-search`)?.focus() }} />
      </div>
      {!loading && !error && normalizedQuery && <p aria-live="polite" className="mb-1 shrink-0 text-[10px] text-[var(--color-text-tertiary)]">
        {t('managedResources.appOperations.searchCount' as never, { count: visibleEntries.length, total: entries.length })}
      </p>}
      {relative && <Button size="xs" variant="link" aria-label={`${label('up')}: ${target.directory}`} onClick={() => navigate(relative.split('/').slice(0, -1).join('/'))}>../</Button>}
      {loading ? <p role="status" className="text-xs">{label('loading')}</p> : error ? <p role="alert" className="text-xs text-[var(--color-error)]">{error === 'RESOURCE_NOT_FOUND' ? label('missing') : error}</p> : visibleEntries.length === 0 ? <p className="text-xs text-[var(--color-text-tertiary)]">{normalizedQuery ? label('noMatches') : label('empty')}</p> :
        <div ref={listRef} role="list" className="min-h-0 flex-1 overflow-auto divide-y divide-[var(--color-border)]">
          {visibleEntries.map(entry => <div role="listitem" key={entry.relativePath} data-application-entry={entry.relativePath} data-pinned={pinned.has(entry.relativePath)} className={`flex min-w-0 flex-wrap items-center gap-2 py-2 text-xs ${pinned.has(entry.relativePath) ? 'bg-[var(--color-surface-container)]' : ''}`}>
            {entry.type === 'directory' ? <FolderOpen size={13} /> : <FileText size={13} />}
            <button type="button" className="min-w-0 flex-1 truncate text-left font-mono hover:underline disabled:opacity-50" title={entry.name} disabled={!['file', 'directory'].includes(entry.type)} onClick={() => entry.type === 'directory' ? navigate(entry.relativePath) : onAction({ target: { ...target, relativePath: entry.relativePath }, entry, action: 'read' })}>{entry.name}</button>
            <span className="text-[10px] text-[var(--color-text-tertiary)]">{entry.type === 'file' ? bytes(entry.size) : entry.type === 'symlink' ? label('symlink') : ''}</span>
            {['file', 'directory'].includes(entry.type) && <IconButton size="xs"
              icon={pinned.has(entry.relativePath) ? <PinOff size={13} /> : <Pin size={13} />}
              label={`${pinned.has(entry.relativePath) ? label('unpin') : label('pin')}: ${entry.name}`}
              pressed={pinned.has(entry.relativePath)} tone={pinned.has(entry.relativePath) ? 'brand' : 'muted'}
              disabled={!config.ready || config.saving} onClick={() => togglePin(entry)} />}
            {entry.type === 'file' && <div className="flex w-full flex-wrap justify-end gap-1">
              {isApplicationScript(entry.name) && <Button size="xs" variant="secondary" disabled={!config.ready || config.saving} icon={<Play size={11} />} aria-label={`${label('execute')}: ${entry.name}`} onClick={() => onAction({ target: { ...target, relativePath: entry.relativePath }, entry, action: 'script' })}>{label('execute')}</Button>}
              <Button size="xs" variant="ghost" icon={<Eye size={11} />} aria-label={`${label('view')}: ${entry.name}`} onClick={() => onAction({ target: { ...target, relativePath: entry.relativePath }, entry, action: 'read' })}>{label('view')}</Button>
              <Button size="xs" variant="ghost" icon={<Download size={11} />} aria-label={`${label('download')}: ${entry.name}`} onClick={() => onAction({ target: { ...target, relativePath: entry.relativePath }, entry, action: 'download' })}>{label('download')}</Button>
              {isApplicationLog(entry.name) && <>
                <Button size="xs" variant="ghost" aria-label={`Tail: ${entry.name}`} onClick={() => onAction({ target: { ...target, relativePath: entry.relativePath }, entry, action: 'tail' })}>Tail</Button>
                <Button size="xs" variant="danger-outline" icon={<Trash2 size={11} />} aria-label={`${label('delete')}: ${entry.name}`} onClick={() => onAction({ target: { ...target, relativePath: entry.relativePath }, entry, action: 'delete' })}>{label('delete')}</Button>
              </>}
            </div>}
          </div>)}
        </div>}
    </div>
  </section>
}

function ApplicationFilesWorkspace({ host, application, rootIndex, connectionId, generation, fullScreen }: { host: Host; application: HostApplication; rootIndex: number; connectionId: string; generation: number; fullScreen: boolean }) {
  const t = useTranslation()
  const label = (key: string) => t(`managedResources.appOperations.${key}` as never)
  const [pending, setPending] = useState<Selection | null>(null)
  const [operation, setOperation] = useState<ApplicationOperation | null>(null)
  const [viewer, setViewer] = useState<{ absolutePath: string; text: string; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const config = useHostToolsPreferences({ hostId: host.id, applicationId: application.id, rootIndex, expectedRoot: application.installPaths[rootIndex]! })
  const collapsed = config.preferences.collapsed
  const busy = useRef(false)
  const alive = useRef(true)
  const active = useRef<string | null>(null)
  const viewRequest = useRef(0)
  const api = getDesktopHost().hostManagement
  const targets = useMemo(() => APPLICATION_DIRECTORIES.map(directory => ({ hostId: host.id, applicationId: application.id, rootIndex, connectionId, generation, directory, relativePath: '' })), [host.id, application.id, rootIndex, connectionId, generation])
  const transfers = useRemoteTransfers({ hostId: host.id, connectionId, generation, connected: true, onUploaded: () => {} })
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      viewRequest.current++
      if (active.current) void api.applicationOperation({ action: 'stop', operationId: active.current }).catch(() => undefined)
    }
  }, [api])
  const closeOperation = () => {
    const id = active.current
    active.current = null
    setOperation(null)
    if (id) void api.applicationOperation({ action: 'stop', operationId: id }).catch(() => undefined)
  }
  const invoke = async (input: ApplicationOperationInput) => {
    const result = await api.applicationOperation(input)
    if (!result.ok) throw new Error(result.error.code)
    return result.data
  }
  const perform = async (selection: Selection) => {
    if (busy.current) return
    busy.current = true
    setError(null)
    try {
      const { action, target, entry } = selection
      if (action === 'download') { await transfers.download(entry.absolutePath, entry.name); return }
      if (action === 'read') {
        const version = ++viewRequest.current
        const result = await invoke({ ...target, action: 'read' })
        if (alive.current && version === viewRequest.current && result.kind === 'content') setViewer(result)
      } else if (action === 'delete') {
        await invoke({ ...target, action, expectedRevision: entry.revision, confirmed: true })
        if (alive.current) setRefresh(n => n + 1)
      } else {
        closeOperation()
        const id = crypto.randomUUID()
        active.current = id
        const result = await invoke({ ...target, action: 'start', mode: action, requestId: id, expectedRevision: entry.revision, confirmed: true, expectedRunAsUser: selection.runAsUser ?? '' })
        if (!alive.current || active.current !== id) { void api.applicationOperation({ action: 'stop', operationId: id }).catch(() => undefined); return }
        if (result.kind === 'operation') setOperation({ ...result.operation, absolutePath: entry.absolutePath, cwd: entry.absolutePath.slice(0, entry.absolutePath.lastIndexOf('/')) })
      }
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : 'DISCONNECTED') }
    finally { busy.current = false }
  }
  const onAction = (selection: Selection) => {
    if (selection.action === 'delete' || selection.action === 'script') setPending({ ...selection, runAsUser: config.preferences.runAsUser })
    else void perform(selection)
  }
  return <div className={fullScreen ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'min-w-0'}>
    <div className={`overflow-x-auto pb-2 ${fullScreen ? 'min-h-0 flex-1' : ''}`} data-testid="application-file-lists-scroll">
      <div className={`grid min-h-0 items-stretch gap-3 ${fullScreen ? 'h-full' : 'h-[360px]'}`} style={{ gridTemplateColumns: targets.map(target => collapsed[target.directory] ? '48px' : 'minmax(240px, 1fr)').join(' ') }} data-testid="application-file-lists">
        {targets.map(target => <ApplicationDirectoryPanel key={target.directory} target={target} root={application.installPaths[rootIndex]!} refresh={refresh} onAction={onAction} expanded={!collapsed[target.directory]} config={config} onToggle={() => void config.save({ collapsed: { [target.directory]: !collapsed[target.directory] } })} />)}
      </div>
    </div>
    {config.error && <p role="alert" className="text-xs text-[var(--color-error)]">{t('managedResources.hostTools.preferenceError')}: {config.error}</p>}
    {(error || transfers.error) && <p role="alert" className="text-xs text-[var(--color-error)]">{error || transfers.error}</p>}
    {transfers.busy && <div role="status" className="flex gap-2 text-xs">{label('downloading')}<Button size="xs" variant="secondary" onClick={() => void transfers.cancel()}>{t('common.cancel')}</Button></div>}
    {transfers.job?.state === 'completed' && <p role="status" className="text-xs">{t('managedResources.files.transferCompleted')}</p>}
    <ConfirmDialog open={pending !== null} closeLabel={t('common.close')} onClose={() => setPending(null)}
      onConfirm={async () => { const selection = pending; setPending(null); if (selection) await perform(selection) }}
      title={pending?.action === 'delete' ? label('deleteTitle') : label('executeTitle')}
      body={`${pending?.entry.absolutePath ?? ''}\n${pending?.action === 'delete' ? label('deleteHelp') : `${label('confirmExecution')}\n${t('managedResources.hostTools.executionUser')}: ${pending?.runAsUser || host.username}`}`}
      confirmLabel={pending?.action === 'delete' ? label('delete') : label('execute')} cancelLabel={t('common.cancel')} confirmVariant="danger" />
    {viewer && <Modal open title={label('viewTitle')} closeLabel={t('common.close')} onClose={() => setViewer(null)} width={1000}>
      <p className="mb-2 break-all font-mono text-xs">{viewer.absolutePath}</p>
      {viewer.truncated && <p className="mb-2 text-xs text-[var(--color-text-tertiary)]">{label('previewLimit')}</p>}
      <pre tabIndex={0} aria-label={label('content')} className="h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-md)] bg-[var(--color-surface-container)] p-3 font-mono text-xs">{viewer.text}</pre>
    </Modal>}
    {operation && <ApplicationOperationDialog key={operation.id} operation={operation} onClose={closeOperation} />}
  </div>
}

export function ApplicationFilesPanel({ host, application, onConnect }: { host: Host; application: HostApplication; onConnect: () => void }) {
  const t = useTranslation()
  const label = (key: string) => t(`managedResources.appOperations.${key}` as never)
  const ssh = useHostSshStore(state => state.byHostId[host.id])
  const [rootIndex, setRootIndex] = useState(0)
  const root = application.installPaths[rootIndex]
  return <ApplicationWorkspaceFrame name={application.name} tools={application.installPaths.length > 1 &&
    <label className="flex min-w-0 items-center gap-2 text-xs">{label('root')}<select aria-label={label('root')} value={rootIndex} onChange={event => setRootIndex(Number(event.target.value))} className="max-w-full border border-[var(--color-border)] bg-[var(--color-surface)] p-1">{application.installPaths.map((value, index) => <option key={index} value={index}>{value}</option>)}</select></label>}>
    {fullScreen => !root ? <p className="text-xs text-[var(--color-text-tertiary)]">{label('noRoot')}</p> : ssh?.status !== 'ready' || !ssh.connectionId ? <div className="flex items-center gap-2 text-xs"><span>{label('connectFirst')}</span><Button size="xs" variant="secondary" onClick={onConnect}>{label('connect')}</Button></div> :
      <ApplicationFilesWorkspace key={`${host.id}:${application.id}:${rootIndex}:${root}:${ssh.connectionId}:${ssh.generation}`} host={host} application={application} rootIndex={rootIndex} connectionId={ssh.connectionId} generation={ssh.generation} fullScreen={fullScreen} />}
  </ApplicationWorkspaceFrame>
}
