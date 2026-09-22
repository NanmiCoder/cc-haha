import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, FileText, Folder, RefreshCw, Save, Upload, X } from 'lucide-react'

import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { SearchField } from '@/components/ui/SearchField'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { RemoteFileEditor } from './RemoteFileEditor'
import { useTranslation } from '@/i18n'
import { getDesktopHost } from '@/lib/desktopHost'
import { useHostSshStore } from '../../stores/hostSshStore'
import type {
  ManagedRemoteEditSnapshot,
  ManagedSftpEntry,
} from '../../api/hostManagementApi'
import type { Host } from '../../types/resourceTypes'
import { useRemoteTransfers } from './useRemoteTransfers'
import { RemoteTransferHeader } from './RemoteTransferHeader'

type EditorState = {
  snapshot: ManagedRemoteEditSnapshot
  draft: string
  dirty: boolean
  error: string | null
}

type CachedDraft = {
  baseRevision: string
  text: string
}

const dirtyDraftCache = new Map<string, CachedDraft>()

function draftKey(hostId: string, absolutePath: string): string {
  return `${hostId}:${absolutePath}`
}

function parentPath(absolutePath: string): string {
  if (absolutePath === '/') return '/'
  const parts = absolutePath.split('/').filter(Boolean)
  parts.pop()
  return parts.length === 0 ? '/' : `/${parts.join('/')}`
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`
}

export function normalizeRemoteDirectory(value: string): string | null {
  const text = value.trim()
  if (!text.startsWith('/') || text.length > 4096 || /[\\\\\x00-\x1f\x7f]/.test(text)) return null
  const parts: string[] = []
  for (const part of text.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return '/' + parts.join('/')
}

export function RemoteFilesPanel({ host }: { host: Host }) {
  const t = useTranslation()
  const ssh = useHostSshStore(state => state.byHostId[host.id])
  const connected = ssh?.status === 'ready' && !!ssh.connectionId
  const connectionId = ssh?.connectionId ?? null
  const generation = ssh?.generation ?? 0
  const [currentPath, setCurrentPath] = useState(host.initialDirectory || '/')
  const [pathDraft, setPathDraft] = useState(host.initialDirectory || '/')
  const [searchQuery, setSearchQuery] = useState('')
  const directoryRequest = useRef(0)
  const liveConnection = useRef('')
  liveConnection.current = connected ? `${host.id}:${connectionId}:${generation}` : ''
  const [entries, setEntries] = useState<ManagedSftpEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [pendingOpen, setPendingOpen] = useState<ManagedSftpEntry | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const sortedEntries = useMemo(() => {
    const query = searchQuery.trim().normalize('NFC').toLowerCase()
    return entries.filter(entry => entry.name.normalize('NFC').toLowerCase().includes(query)).sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1
    if (a.type !== 'directory' && b.type === 'directory') return 1
    return a.name.localeCompare(b.name)
    })
  }, [entries, searchQuery])

  useEffect(() => {
    setCurrentPath(host.initialDirectory || '/')
    setPathDraft(host.initialDirectory || '/')
    setSearchQuery('')
    directoryRequest.current++
    setEntries([])
    setError(null)
    setEditor(null)
  }, [host.id, host.initialDirectory])

  const loadDirectory = async (absolutePath = currentPath) => {
    if (!connectionId || !connected) return
    const request = ++directoryRequest.current
    const binding = liveConnection.current
    const path = normalizeRemoteDirectory(absolutePath)
    if (path === null) { setLoading(false); setError(t('managedResources.files.invalidDirectoryPath')); return }
    setLoading(true)
    setError(null)
    const current = () => request === directoryRequest.current && binding === liveConnection.current
    try {
      const result = await getDesktopHost().hostManagement.sftpList(connectionId, generation, path)
      if (!current()) return
      if (!result.ok) { setError(`${t('managedResources.files.operationFailed')}: ${result.error.code}`); return }
      // Commit navigation only after successful SFTP validation, never on click.
      setCurrentPath(result.data.parent.absolutePath)
      setPathDraft(result.data.parent.absolutePath)
      setEntries(result.data.entries)
      if (result.data.parent.absolutePath !== currentPath) setSearchQuery('')
    } catch {
      if (current()) setError(t('managedResources.files.operationFailed'))
    } finally {
      if (current()) setLoading(false)
    }
  }

  useEffect(() => {
    if (connected && connectionId) void loadDirectory(currentPath)
    else setLoading(false)
    return () => { directoryRequest.current++ }
    // `currentPath` intentionally stays user-controlled; reconnect revalidates it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, connectionId, generation])

  const performOpen = async (entry: ManagedSftpEntry) => {
    if (!connectionId || !connected || entry.type !== 'file') return
    setError(null)
    const result = await getDesktopHost().hostManagement.remoteEditOpen(connectionId, generation, entry.absolutePath)
    if (!result.ok) {
      setError(`${t('managedResources.files.operationFailed')}: ${result.error.code}`)
      return
    }
    const cached = dirtyDraftCache.get(draftKey(host.id, entry.absolutePath))
    const canRestore = cached?.baseRevision === result.data.edit.baseRevision
    setEditor({
      snapshot: result.data,
      draft: canRestore ? cached.text : result.data.edit.text,
      dirty: Boolean(canRestore),
      error: cached && !canRestore ? t('managedResources.files.revisionConflict') : null,
    })
  }

  const requestOpen = (entry: ManagedSftpEntry) => {
    if (entry.type === 'directory') {
      void loadDirectory(entry.absolutePath)
      return
    }
    if (entry.type !== 'file') return
    if (editor?.dirty) {
      setPendingOpen(entry)
      setConfirmDiscard(true)
      return
    }
    void performOpen(entry)
  }

  const updateDraft = (text: string) => {
    if (!editor) return
    const key = draftKey(host.id, editor.snapshot.edit.absolutePath)
    dirtyDraftCache.set(key, { baseRevision: editor.snapshot.edit.baseRevision, text })
    setEditor({ ...editor, draft: text, dirty: text !== editor.snapshot.edit.text, error: null })
  }

  const saveDraft = async () => {
    if (!editor || !connectionId || !connected) return
    let activeSnapshot = editor.snapshot
    if (activeSnapshot.edit.generation !== generation) {
      const rebound = await getDesktopHost().hostManagement.remoteEditOpen(
        connectionId,
        generation,
        activeSnapshot.edit.absolutePath,
      )
      if (!rebound.ok) {
        setEditor({ ...editor, error: `${t('managedResources.files.operationFailed')}: ${rebound.error.code}` })
        return
      }
      if (rebound.data.edit.baseRevision !== activeSnapshot.edit.baseRevision) {
        setEditor({ ...editor, snapshot: rebound.data, error: t('managedResources.files.revisionConflict') })
        return
      }
      activeSnapshot = rebound.data
    }
    const saved = await getDesktopHost().hostManagement.remoteEditSave(
      activeSnapshot.edit.id,
      activeSnapshot.edit.baseRevision,
      editor.draft,
    )
    if (!saved.ok) {
      setEditor({
        ...editor,
        snapshot: activeSnapshot,
        error: saved.error.code === 'REVISION_CONFLICT'
          ? t('managedResources.files.revisionConflict')
          : `${t('managedResources.files.operationFailed')}: ${saved.error.code}`,
      })
      return
    }
    dirtyDraftCache.delete(draftKey(host.id, saved.data.edit.absolutePath))
    setEditor({ snapshot: saved.data, draft: saved.data.edit.text, dirty: false, error: null })
    await loadDirectory(currentPath)
  }

  const closeEditor = async (discard = false) => {
    if (!editor) return
    if (editor.dirty && !discard) {
      setPendingOpen(null)
      setConfirmDiscard(true)
      return
    }
    const closing = editor
    if (discard) dirtyDraftCache.delete(draftKey(host.id, closing.snapshot.edit.absolutePath))
    setEditor(null)
    await getDesktopHost().hostManagement.remoteEditClose(closing.snapshot.edit.id).catch(() => undefined)
  }

  const discardAndContinue = async () => {
    const next = pendingOpen
    setConfirmDiscard(false)
    setPendingOpen(null)
    await closeEditor(true)
    if (next) await performOpen(next)
  }

  const transfers = useRemoteTransfers({ hostId: host.id, connectionId, generation, connected, maxConcurrent: 3, onUploaded: () => { void loadDirectory(currentPath) } })

  return (
    <section className="min-w-0 overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3" aria-label={t('managedResources.files.title')}>
      <div className="mb-2 flex flex-wrap items-center gap-2" data-testid="remote-files-header">
        <div className="min-w-0 max-w-48 shrink-0">
          <h4 className="text-xs font-semibold text-[var(--color-text-primary)]">{t('managedResources.files.title')}</h4>
          <p className="truncate font-mono text-[11px] text-[var(--color-text-tertiary)]" title={currentPath}>{currentPath}</p>
        </div>
        <RemoteTransferHeader tasks={transfers.tasks} onCancel={transfers.cancel} />
        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <Button size="xs" variant="secondary" icon={<RefreshCw size={12} />} disabled={!connected || loading} onClick={() => void loadDirectory(currentPath)}>
            {t('managedResources.files.refresh')}
          </Button>
          <Button size="xs" variant="secondary" icon={<Upload size={12} />} disabled={!transfers.canStart} onClick={() => void transfers.upload(currentPath)}>
            {t('managedResources.files.upload')}
          </Button>
          <Button size="xs" variant="secondary" icon={<Folder size={12} />} data-testid="remote-upload-folder" disabled={!transfers.canStart} onClick={() => void transfers.uploadFolder(currentPath)}>
            {t('managedResources.transfer.uploadFolder')}
          </Button>
          <Button size="xs" variant="secondary" icon={<Download size={12} />} data-testid="remote-download-folder" disabled={!transfers.canStart || currentPath === '/'} onClick={() => void transfers.downloadFolder(currentPath)}>
            {t('managedResources.transfer.downloadFolder')}
          </Button>
        </div>
      </div>

      <form className="mb-3 flex min-w-0 items-start gap-2" onSubmit={event => { event.preventDefault(); void loadDirectory(pathDraft) }}>
        <Input size="sm" value={pathDraft} maxLength={4096} containerClassName="min-w-0 flex-1" className="font-mono"
          aria-label={t('managedResources.files.directoryPath')} placeholder={t('managedResources.files.directoryPath')}
          disabled={!connected} autoComplete="off" spellCheck={false} onChange={event => setPathDraft(event.currentTarget.value)}
          onKeyDown={event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault() }} />
        <Button type="submit" size="sm" variant="secondary" disabled={!connected}>{t('managedResources.files.goDirectory')}</Button>
      </form>

      <div data-testid="remote-files-split" className="grid min-h-0 grid-cols-[minmax(200px,1fr)_minmax(0,2fr)] gap-3" style={{ height: 'clamp(420px, 58vh, 760px)' }}>
        <div data-testid="remote-file-browser" className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] p-2">
          <SearchField size="sm" value={searchQuery} onChange={setSearchQuery} label={t('managedResources.files.searchNames')}
            clearLabel={t('managedResources.appOperations.clearSearch')} placeholder={t('managedResources.files.searchNames')}
            containerClassName="mb-2 shrink-0" disabled={!connected} autoComplete="off" spellCheck={false} />
          {!connected ? (
            <div className="rounded-[var(--radius-sm)] border border-dashed border-[var(--color-border)] p-3 text-xs text-[var(--color-text-tertiary)]">
              {editor?.dirty ? t('managedResources.files.disconnectedDraft') : t('managedResources.files.connectFirst')}
            </div>
          ) : (
            <>
              {currentPath !== '/' && (
                <Button size="xs" variant="link" className="shrink-0 justify-start" onClick={() => {
                  const next = parentPath(currentPath)
                  void loadDirectory(next)
                }}>
                  ../
                </Button>
              )}
              {loading ? (
                <div role="status" className="py-3 text-xs text-[var(--color-text-tertiary)]">{t('managedResources.files.loading')}</div>
              ) : sortedEntries.length === 0 ? (
                <div className="py-3 text-xs text-[var(--color-text-tertiary)]">{searchQuery.trim() ? t('managedResources.appOperations.noMatches') : t('managedResources.files.empty')}</div>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col divide-y divide-[var(--color-border)] overflow-y-auto overscroll-contain" role="list">
                  {sortedEntries.map(entry => (
                    <div key={entry.absolutePath} role="listitem" className={`grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1 px-1 py-2 ${editor?.snapshot.edit.absolutePath === entry.absolutePath ? 'bg-[var(--color-surface-container)]' : ''}`}>
                      <Button variant="link" size="xs" className="min-w-0 justify-start no-underline" onClick={() => requestOpen(entry)} disabled={entry.type === 'symlink' || entry.type === 'other'}>
                        <span className="flex min-w-0 items-center gap-1.5" title={entry.name}>
                          {entry.type === 'directory' ? <Folder size={13} className="shrink-0" /> : <FileText size={13} className="shrink-0" />}
                          <span className="truncate">{entry.name}</span>
                          <span className="shrink-0 text-[10px] text-[var(--color-text-tertiary)]">{t(`managedResources.files.type.${entry.type}` as never)}</span>
                        </span>
                      </Button>
                      <span className="text-[10px] tabular-nums text-[var(--color-text-tertiary)]">{entry.type === 'file' ? formatSize(entry.size) : ''}</span>
                      {entry.type === 'directory' && <Button size="xs" variant="ghost" className="col-span-2 justify-self-end" icon={<Download size={11} />} aria-label={`${t('managedResources.transfer.downloadFolder')}: ${entry.name}`} disabled={!transfers.canStart} onClick={() => void transfers.downloadFolder(entry.absolutePath)}>{t('managedResources.transfer.downloadFolder')}</Button>}
                      {entry.type === 'file' && (
                        <div className="col-span-2 flex justify-end gap-1">
                          <Button size="xs" variant="ghost" onClick={() => requestOpen(entry)}>{t('managedResources.files.edit')}</Button>
                          <Button size="xs" variant="ghost" icon={<Download size={11} />} disabled={!transfers.canStart} onClick={() => void transfers.download(entry.absolutePath, entry.name)}>{t('managedResources.files.download')}</Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        <div data-testid="remote-file-editor" className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] p-3">
          {editor ? (
            <>
              <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
                <span className="min-w-0 truncate font-mono text-xs text-[var(--color-text-secondary)]" title={editor.snapshot.edit.absolutePath}>{editor.snapshot.edit.absolutePath}</span>
                <div className="flex shrink-0 gap-1.5">
                  <Button size="xs" variant="primary" icon={<Save size={11} />} disabled={!connected || !editor.dirty} onClick={() => void saveDraft()}>
                    {t('managedResources.files.save')}
                  </Button>
                  <Button size="xs" variant="secondary" icon={<X size={11} />} onClick={() => void closeEditor()}>
                    {t('managedResources.files.closeEditor')}
                  </Button>
                </div>
              </div>
              <RemoteFileEditor
                absolutePath={editor.snapshot.edit.absolutePath}
                value={editor.draft}
                disabled={!connected}
                onChange={updateDraft}
                error={editor.error ?? undefined}
              />
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-xs text-[var(--color-text-tertiary)]">
              <FileText size={24} aria-hidden="true" />
              <p>{t('managedResources.files.selectFile')}</p>
            </div>
          )}
        </div>
      </div>

      {error && <div role="alert" className="mt-2 text-xs text-[var(--color-error)]">{error}</div>}

      <ConfirmDialog
        open={confirmDiscard}
        closeLabel={t('common.close')}
        onClose={() => {
          setConfirmDiscard(false)
          setPendingOpen(null)
        }}
        onConfirm={discardAndContinue}
        title={t('managedResources.files.discardTitle')}
        body={t('managedResources.files.discardBody')}
        confirmLabel={t('managedResources.files.discard')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
      />
    </section>
  )
}
