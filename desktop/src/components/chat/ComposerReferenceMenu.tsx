import { sessionCollaborationApi, type SessionCandidate } from '@/api/sessionCollaboration'
import { SessionReferenceDetails } from '@/components/chat/SessionReferenceDetails'
import { useTabStore } from '@/stores/tabStore'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { ComposerSuggestionRow } from '@/components/chat/ComposerSuggestionRow'
import { rankComposerSuggestions } from '@/components/chat/composerSuggestionSearch'
import { ApiError } from '@/api/client'
import { filesystemApi } from '@/api/filesystem'
import { useTranslation } from '@/i18n'
import { safeMentionIcon, type NewComposerMention } from '@/lib/composerMentions'
import { publicAssetPath } from '@/lib/publicAsset'
import type { ComposerReferenceCandidate } from '@/types/composerReference'
import { referenceFallbackIcon, skillSourceLabelKey } from './referencePresentation'

type FileEntry = { name: string, path: string, isDirectory: boolean, relativePath?: string }
type Row = { key: string, label: string, description: string, searchTerms?: string[], contentMatch?: boolean, session?: SessionCandidate, shortId?: string, source?: string, mention?: NewComposerMention, file?: FileEntry, icon?: ReactNode, onSelect?: () => void }
export type ComposerReferenceMenuHandle = { handleKeyDown(event: KeyboardEvent): void }
type Props = {
  id: string
  cwd: string
  filter?: string
  compact?: boolean
  embedded?: boolean
  browseReferences?: boolean
  actions?: Array<{ key: string, label: string, description?: string, icon?: ReactNode, onSelect: () => void }>
  references: ComposerReferenceCandidate[]
  referencesLoading?: boolean
  referencesError?: string | boolean | null
  onSelect(mention: NewComposerMention): void
  onNavigate?(relativePath: string): void
  onActiveChange?(optionId: string | undefined): void
}

export function getComposerReferenceOptionId(id: string, index: number): string { return `${id}-option-${index}` }

export const ComposerReferenceMenu = forwardRef<ComposerReferenceMenuHandle, Props>(function ComposerReferenceMenu({
  id, cwd, filter = '', compact = false, embedded = false, browseReferences = false, actions = [], references, referencesLoading = false, referencesError,
  onSelect, onNavigate, onActiveChange,
}, ref) {
  const t = useTranslation()
  const activeSessionId = useTabStore(state => state.activeTabId)
  const [sessionResult, setSessionResult] = useState<{ query: string, sessions: SessionCandidate[], error?: boolean } | null>(null)
  useEffect(() => {
    if (browseReferences) return
    let active = true
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void sessionCollaborationApi.list(filter, { signal: controller.signal }).then(data => {
        if (active) setSessionResult({ query: filter, sessions: data.sessions })
      }, () => {
        if (active) setSessionResult({ query: filter, sessions: [], error: true })
      })
    }, 150)
    return () => { active = false; clearTimeout(timer); controller.abort() }
  }, [filter, browseReferences])
  const sessionCandidates = !browseReferences && sessionResult?.query === filter ? sessionResult.sessions : []
  const sessionLoading = !browseReferences && sessionResult?.query !== filter
  const sessionError = !browseReferences && sessionResult?.query === filter && sessionResult.error
  const [manualPath, setManualPath] = useState<{ cwd: string, filter: string, path: string } | null>(null)
  const override = manualPath?.cwd === cwd && manualPath.filter === filter ? manualPath.path : undefined
  const queryKey = `${cwd}\0${filter}\0${override ?? ''}`
  const [result, setResult] = useState<{ key: string, entries: FileEntry[], root: string, current: string, error?: 'denied' | 'failed' } | null>(null)
  const [selection, setSelection] = useState<{ query: string, key: string } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef({ cwd, path: cwd })
  if (rootRef.current.cwd !== cwd) rootRef.current = { cwd, path: cwd }
  const currentResult = !browseReferences && result?.key === queryKey ? result : null
  const directoryQuery = filter.replace(/\\/g, '/').trim()
  const browsingDirectory = directoryQuery.endsWith('/')
  const isSearching = directoryQuery.length > 0 || override !== undefined
  const loading = isSearching && !browseReferences && currentResult === null

  useEffect(() => {
    if (browseReferences || !filter.trim() && override === undefined) return
    let active = true
    const controller = new AbortController()
    const base = (cwd || rootRef.current.path).replace(/[\\/]+$/, '')
    const path = override ?? (browsingDirectory && base ? `${base}/${directoryQuery.replace(/\/+$/, '')}` : base)
    const search = override || browsingDirectory ? '' : directoryQuery
    const run = () => {
      const request = search ? filesystemApi.search(search, path, { signal: controller.signal }) : filesystemApi.browse(path, { includeFiles: true, signal: controller.signal })
      void request.then(data => {
        if (!active) return
        if (!rootRef.current.path) rootRef.current = { cwd, path: data.currentPath }
        setResult({ key: queryKey, entries: data.entries, current: data.currentPath, root: rootRef.current.path })
      }, error => {
        if (active) setResult({ key: queryKey, entries: [], current: path, root: base, error: error instanceof ApiError && error.status === 403 ? 'denied' : 'failed' })
      })
    }
    const timer = search ? setTimeout(run, 150) : undefined
    if (!search) run()
    return () => { active = false; clearTimeout(timer); controller.abort() }
  }, [cwd, filter, override, queryKey, browseReferences, directoryQuery, browsingDirectory])

  const groups = useMemo(() => {
    const matches = references.filter(() => browseReferences || !browsingDirectory)
    const referenceRow = (item: ComposerReferenceCandidate): Row => ({
      key: `${item.kind}:${item.id}`, label: item.displayName || item.name, description: item.description, searchTerms: [item.name], source: item.source,
      mention: { kind: item.kind, id: item.id, label: item.displayName || item.name, path: item.path ?? '', isDirectory: false, description: item.description, icon: safeMentionIcon(item.icon), modelText: item.modelText },
    })
    const files: Row[] = (browseReferences ? [] : currentResult?.entries ?? []).map(entry => {
      const base = (cwd || currentResult?.root || '').replace(/\\/g, '/').replace(/\/+$/, '')
      const path = entry.path.replace(/\\/g, '/')
      const relative = path.startsWith(`${base}/`) ? path.slice(base.length + 1) : entry.relativePath ?? entry.name
      const name = entry.name.split(/[\\/]/).filter(Boolean).at(-1) ?? entry.name
      return { key: `file:${entry.path}`, label: name, searchTerms: [relative, path], description: relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '', file: { ...entry, relativePath: relative }, mention: { label: entry.isDirectory ? `${name}/` : name, path: entry.path, isDirectory: entry.isDirectory } }
    })
    return [
      { kind: 'skills', label: t('chat.referenceSkills'), rows: matches.filter(item => item.kind === 'skill').map(referenceRow) },
      { kind: 'plugins', label: t('chat.referencePlugins'), rows: matches.filter(item => item.kind === 'plugin').map(referenceRow) },
      { kind: 'sessions', label: t('chat.referenceSessions'), rows: sessionCandidates.filter(item => item.sessionId !== activeSessionId).map((item): Row => ({
        key: `session:${item.sessionId}`, label: item.title || item.sessionId, description: `${item.cwd} · ${item.sessionId.slice(0, 8)}`, searchTerms: [item.sessionId, item.title, item.cwd], contentMatch: true, session: item,
        shortId: sessionCandidates.some(other => other.sessionId !== item.sessionId && other.sessionId.slice(0, 8) === item.sessionId.slice(0, 8)) ? item.sessionId : item.sessionId.slice(0, 8),
        mention: { kind: 'session' as const, id: item.sessionId, label: item.title || item.sessionId, description: item.cwd, path: '', isDirectory: false },
      })) },
      { kind: 'files', label: t('chat.referenceFiles'), rows: files },
      { kind: 'actions', label: t('chat.references'), rows: actions.map(action => ({ ...action, description: action.description ?? '' })) as Row[] },
    ]
  }, [references, currentResult, cwd, t, actions, browseReferences, browsingDirectory, sessionCandidates, activeSessionId, filter])
  const visibleGroups = isSearching
    ? [{ kind: 'results', label: t('chat.references'), rows: !browseReferences && (override || browsingDirectory)
      ? groups.find(group => group.kind === 'files')!.rows
      : rankComposerSuggestions(groups.flatMap(group => group.rows), filter) }]
    : groups.filter(group => group.kind !== 'files' && (browseReferences || group.kind !== 'actions')).map(group => ({ ...group, rows: browseReferences ? group.rows : group.rows.slice(0, 3) }))
  const rows = visibleGroups.flatMap(group => group.rows)
  const selectionKey = queryKey
  const foundIndex = selection?.query === selectionKey ? rows.findIndex(row => row.key === selection.key) : -1
  const activeIndex = rows.length ? Math.max(0, foundIndex) : -1
  const activeOptionId = activeIndex < 0 ? undefined : getComposerReferenceOptionId(id, activeIndex)

  useEffect(() => { onActiveChange?.(activeOptionId) }, [activeOptionId, onActiveChange])
  useEffect(() => {
    if (activeOptionId) listRef.current?.ownerDocument.getElementById(activeOptionId)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeOptionId])
  const highlight = useCallback((row: Row) => setSelection({ query: selectionKey, key: row.key }), [selectionKey])
  const navigate = useCallback((row: Row) => {
    if (!row.file?.isDirectory) return
    const relative = `${(row.file.relativePath ?? row.file.name).replace(/\/+$/, '')}/`
    if (onNavigate) onNavigate(relative)
    else setManualPath({ cwd, filter, path: row.file.path })
  }, [cwd, filter, onNavigate])
  const select = useCallback((row: Row) => {
    if (row.onSelect) row.onSelect()
    else if (row.mention) onSelect(row.mention)
  }, [onSelect])
  useImperativeHandle(ref, () => ({ handleKeyDown(event) {
    if (event.isComposing || event.keyCode === 229) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (rows.length) highlight(rows[(Math.max(activeIndex, 0) + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]!)
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      if (rows[activeIndex]) select(rows[activeIndex]!)
    } else if (event.key === 'ArrowRight' && rows[activeIndex]?.file?.isDirectory) {
      event.preventDefault()
      navigate(rows[activeIndex]!)
    }
  } }), [activeIndex, rows, highlight, navigate, select])

  let offset = 0
  return (
    <div className={embedded ? 'min-w-0' : `absolute bottom-full left-0 w-full z-[var(--z-dropdown)] mb-2 overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-overlay)] `} onMouseDown={event => event.preventDefault()}>
      <div ref={listRef} id={id} role="listbox" aria-label={t('chat.references')} aria-busy={loading || referencesLoading || sessionLoading} className="min-w-0 max-h-[min(320px,45vh)] overflow-y-auto p-1.5">
        {visibleGroups.map(group => {
          const start = offset
          offset += group.rows.length
          if (!group.rows.length) return null
          return <div key={group.kind} role="group" aria-label={group.label}>
            {!isSearching ? <div className="px-3 pb-1 pt-2 text-xs font-medium text-[var(--color-text-tertiary)]">{group.label}</div> : null}
            {group.rows.map((row, position) => {
              const index = start + position
              const Icon = referenceFallbackIcon(row.file ? (row.file.isDirectory ? 'directory' : 'file') : row.mention?.kind ?? 'skill')
              const sourceLabel = row.file ? null : skillSourceLabelKey(row.source)
              return <ComposerSuggestionRow key={row.key} id={getComposerReferenceOptionId(id, index)}
                label={row.label} description={row.description}
                details={row.session ? <SessionReferenceDetails session={row.session} shortId={row.shortId!} /> : undefined} selected={activeIndex === index}
                onMouseEnter={() => highlight(row)} onClick={event => {
                  if ((event.target as Element).closest('[data-navigate-directory]')) navigate(row)
                  else select(row)
                }}
                icon={row.icon ?? (row.mention?.icon ? <img src={publicAssetPath(row.mention.icon)} alt="" className="h-5 w-5 shrink-0 object-contain" /> : <Icon aria-hidden="true" className="h-5 w-5 shrink-0 text-[var(--color-text-secondary)]" strokeWidth={1.7} />)}
                trailing={<>
                  {sourceLabel ? <span className="shrink-0 text-xs text-[var(--color-text-tertiary)]">{t(sourceLabel)}</span> : null}
                  {row.file?.isDirectory ? <span data-navigate-directory title={t('fileSearch.openFolder')} className="-my-2 -mr-2 flex h-8 w-8 shrink-0 items-center justify-center"><ChevronRight aria-hidden="true" className="h-4 w-4 text-[var(--color-text-tertiary)]" /></span> : null}
                </>}
              />
            })}
          </div>
        })}
        {loading || referencesLoading || sessionLoading ? <div role="status" className="px-3 py-2 text-xs text-[var(--color-text-tertiary)]">{t('fileSearch.searching')}</div> : null}
        {currentResult?.error ? <div role="alert" className="px-3 py-2 text-xs text-[var(--color-error)]">{t(currentResult.error === 'denied' ? 'fileSearch.accessDenied' : 'fileSearch.loadFailed')}</div> : null}
        {sessionError ? <div role="alert" className="px-3 py-2 text-xs text-[var(--color-error)]">{t('chat.sessionReferencesLoadFailed')}</div> : null}
        {referencesError ? <div role="alert" className="px-3 py-2 text-xs text-[var(--color-error)]">{t('chat.referencesLoadFailed')}</div> : null}
        {!rows.length && !loading && !referencesLoading && !sessionLoading && !sessionError && !currentResult?.error && !referencesError ? <div className="px-3 py-3 text-xs text-[var(--color-text-tertiary)]">{t('chat.referencesEmpty')}</div> : null}
      </div>
      {!isSearching && !embedded ? <div className="border-t border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-text-tertiary)]">{t('chat.referenceSearchHint')}</div> : null}
      {!compact && !embedded ? <div className="flex items-center gap-2 border-t border-[var(--color-border)] px-4 py-2 text-[10px] text-[var(--color-text-tertiary)]"><kbd>↑↓</kbd><span>{t('fileSearch.navigate')}</span><kbd className="ml-2">Enter / Tab</kbd><span>{t('fileSearch.select')}</span><kbd className="ml-2">→</kbd><span>{t('fileSearch.open')}</span><kbd className="ml-2">Esc</kbd><span>{t('fileSearch.close')}</span></div> : null}
    </div>
  )
})
