import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { ApiError } from '@/api/client'
import { filesystemApi } from '@/api/filesystem'
import { useTranslation } from '@/i18n'
import { safeMentionIcon, type NewComposerMention } from '@/lib/composerMentions'
import { publicAssetPath } from '@/lib/publicAsset'
import type { ComposerReferenceCandidate } from '@/types/composerReference'
import { referenceFallbackIcon, skillSourceLabelKey } from './referencePresentation'

type FileEntry = { name: string, path: string, isDirectory: boolean, relativePath?: string }
type Row = { key: string, label: string, description: string, source?: string, mention: NewComposerMention, file?: FileEntry }
export type ComposerReferenceMenuHandle = { handleKeyDown(event: KeyboardEvent): void }
type Props = {
  id: string
  cwd: string
  filter?: string
  compact?: boolean
  references: ComposerReferenceCandidate[]
  referencesLoading?: boolean
  referencesError?: string | boolean | null
  onSelect(mention: NewComposerMention): void
  onNavigate?(relativePath: string): void
  onActiveChange?(optionId: string | undefined): void
}

export function getComposerReferenceOptionId(id: string, index: number): string { return `${id}-option-${index}` }

export const ComposerReferenceMenu = forwardRef<ComposerReferenceMenuHandle, Props>(function ComposerReferenceMenu({
  id, cwd, filter = '', compact = false, references, referencesLoading = false, referencesError,
  onSelect, onNavigate, onActiveChange,
}, ref) {
  const t = useTranslation()
  const [manualPath, setManualPath] = useState<{ cwd: string, filter: string, path: string } | null>(null)
  const override = manualPath?.cwd === cwd && manualPath.filter === filter ? manualPath.path : undefined
  const queryKey = `${cwd}\0${filter}\0${override ?? ''}`
  const [result, setResult] = useState<{ key: string, entries: FileEntry[], root: string, current: string, error?: 'denied' | 'failed' } | null>(null)
  const [selection, setSelection] = useState<{ query: string, key: string } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef({ cwd, path: cwd })
  if (rootRef.current.cwd !== cwd) rootRef.current = { cwd, path: cwd }
  const currentResult = result?.key === queryKey ? result : null
  const loading = currentResult === null

  useEffect(() => {
    let active = true
    const base = (cwd || rootRef.current.path).replace(/[\\/]+$/, '')
    const directoryQuery = filter.replace(/\\/g, '/').trim()
    const browsing = directoryQuery.endsWith('/')
    const path = override ?? (browsing && base ? `${base}/${directoryQuery.replace(/\/+$/, '')}` : base)
    const search = override || browsing ? '' : directoryQuery
    const request = search ? filesystemApi.search(search, path) : filesystemApi.browse(path, { includeFiles: true })
    void request.then(data => {
      if (!active) return
      if (!rootRef.current.path) rootRef.current = { cwd, path: data.currentPath }
      setResult({ key: queryKey, entries: data.entries, current: data.currentPath, root: rootRef.current.path })
    }, error => {
      if (active) setResult({ key: queryKey, entries: [], current: path, root: base, error: error instanceof ApiError && error.status === 403 ? 'denied' : 'failed' })
    })
    return () => { active = false }
  }, [cwd, filter, override, queryKey])

  const groups = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase()
    const matches = references.filter(item => !query.endsWith('/') && query.split(/\s+/).every(word => `${item.displayName} ${item.name} ${item.description}`.toLocaleLowerCase().includes(word)))
    const referenceRow = (item: ComposerReferenceCandidate): Row => ({
      key: `${item.kind}:${item.id}`, label: item.displayName || item.name, description: item.description, source: item.source,
      mention: { kind: item.kind, id: item.id, label: item.displayName || item.name, path: item.path ?? '', isDirectory: false, description: item.description, icon: safeMentionIcon(item.icon), modelText: item.modelText },
    })
    const files: Row[] = (currentResult?.entries ?? []).map(entry => {
      const base = (cwd || currentResult?.root || '').replace(/\\/g, '/').replace(/\/+$/, '')
      const path = entry.path.replace(/\\/g, '/')
      const relative = path.startsWith(`${base}/`) ? path.slice(base.length + 1) : entry.relativePath ?? entry.name
      const name = entry.name.split(/[\\/]/).filter(Boolean).at(-1) ?? entry.name
      return { key: `file:${entry.path}`, label: name, description: relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '', file: { ...entry, relativePath: relative }, mention: { label: entry.isDirectory ? `${name}/` : name, path: entry.path, isDirectory: entry.isDirectory } }
    })
    return [
      { kind: 'plugins', label: t('chat.referencePlugins'), rows: matches.filter(item => item.kind === 'plugin').map(referenceRow) },
      { kind: 'skills', label: t('chat.referenceSkills'), rows: matches.filter(item => item.kind === 'skill').map(referenceRow) },
      { kind: 'files', label: t('chat.referenceFiles'), rows: files },
    ]
  }, [references, filter, currentResult, cwd, t])
  const rows = groups.flatMap(group => group.rows)
  const foundIndex = selection?.query === queryKey ? rows.findIndex(row => row.key === selection.key) : -1
  const activeIndex = rows.length ? Math.max(0, foundIndex) : -1
  const activeOptionId = activeIndex < 0 ? undefined : getComposerReferenceOptionId(id, activeIndex)

  useEffect(() => { onActiveChange?.(activeOptionId) }, [activeOptionId, onActiveChange])
  useEffect(() => {
    if (activeOptionId) listRef.current?.ownerDocument.getElementById(activeOptionId)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeOptionId])
  const highlight = useCallback((row: Row) => setSelection({ query: queryKey, key: row.key }), [queryKey])
  const navigate = useCallback((row: Row) => {
    if (!row.file?.isDirectory) return
    const relative = `${(row.file.relativePath ?? row.file.name).replace(/\/+$/, '')}/`
    if (onNavigate) onNavigate(relative)
    else setManualPath({ cwd, filter, path: row.file.path })
  }, [cwd, filter, onNavigate])
  useImperativeHandle(ref, () => ({ handleKeyDown(event) {
    if (event.isComposing || event.keyCode === 229) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (rows.length) highlight(rows[(Math.max(activeIndex, 0) + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]!)
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      if (rows[activeIndex]) onSelect(rows[activeIndex]!.mention)
    } else if (event.key === 'ArrowRight' && rows[activeIndex]?.file?.isDirectory) {
      event.preventDefault()
      navigate(rows[activeIndex]!)
    }
  } }), [activeIndex, rows, highlight, navigate, onSelect])

  let offset = 0
  return (
    <div className={`absolute bottom-full left-0 right-0 z-[var(--z-dropdown)] mb-2 overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-overlay)] ${compact ? 'max-w-[calc(100vw-32px)]' : ''}`} onMouseDown={event => event.preventDefault()}>
      <div ref={listRef} id={id} role="listbox" aria-label={t('chat.references')} aria-busy={loading || referencesLoading} className="min-w-0 max-h-[360px] overflow-y-auto p-1.5">
        {groups.map(group => {
          const start = offset
          offset += group.rows.length
          if (!group.rows.length) return null
          return <div key={group.kind} role="group" aria-label={group.label}>
            <div className="px-3 pb-1 pt-2 text-xs font-medium text-[var(--color-text-tertiary)]">{group.label}</div>
            {group.rows.map((row, position) => {
              const index = start + position
              const Icon = referenceFallbackIcon(row.file ? (row.file.isDirectory ? 'directory' : 'file') : row.mention.kind ?? 'skill')
              const sourceLabel = row.file ? null : skillSourceLabelKey(row.source)
              return <div key={row.key} id={getComposerReferenceOptionId(id, index)} role="option" tabIndex={-1} aria-selected={activeIndex === index} aria-labelledby={`${id}-label-${index}`} aria-describedby={`${id}-description-${index}`}
                onMouseEnter={() => highlight(row)} onClick={event => {
                  if ((event.target as Element).closest('[data-navigate-directory]')) navigate(row)
                  else onSelect(row.mention)
                }}
                className={`flex min-w-0 cursor-default items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${activeIndex === index ? 'bg-[var(--color-surface-hover)]' : 'hover:bg-[var(--color-surface-hover)]'}`}>
                {row.mention.icon ? <img src={publicAssetPath(row.mention.icon)} alt="" className="h-5 w-5 shrink-0 object-contain" /> : <Icon aria-hidden="true" className="h-5 w-5 shrink-0 text-[var(--color-text-secondary)]" strokeWidth={1.7} />}
                <span id={`${id}-label-${index}`} className="max-w-[45%] shrink-0 truncate text-sm font-medium text-[var(--color-text-primary)]">{row.label}</span>
                <span id={`${id}-description-${index}`} className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-tertiary)]">{row.description}</span>
                {sourceLabel ? <span className="shrink-0 text-xs text-[var(--color-text-tertiary)]">{t(sourceLabel)}</span> : null}
                {row.file?.isDirectory ? <span data-navigate-directory title={t('fileSearch.openFolder')} className="-my-2 -mr-2 flex h-8 w-8 shrink-0 items-center justify-center"><ChevronRight aria-hidden="true" className="h-4 w-4 text-[var(--color-text-tertiary)]" /></span> : null}
              </div>
            })}
          </div>
        })}
        {loading || referencesLoading ? <div role="status" className="px-3 py-2 text-xs text-[var(--color-text-tertiary)]">{t('fileSearch.searching')}</div> : null}
        {currentResult?.error ? <div role="alert" className="px-3 py-2 text-xs text-[var(--color-error)]">{t(currentResult.error === 'denied' ? 'fileSearch.accessDenied' : 'fileSearch.loadFailed')}</div> : null}
        {referencesError ? <div role="alert" className="px-3 py-2 text-xs text-[var(--color-error)]">{t('chat.referencesLoadFailed')}</div> : null}
        {!rows.length && !loading && !referencesLoading && !currentResult?.error && !referencesError ? <div className="px-3 py-3 text-xs text-[var(--color-text-tertiary)]">{t('chat.referencesEmpty')}</div> : null}
      </div>
      {!compact ? <div className="flex items-center gap-2 border-t border-[var(--color-border)] px-4 py-2 text-[10px] text-[var(--color-text-tertiary)]"><kbd>↑↓</kbd><span>{t('fileSearch.navigate')}</span><kbd className="ml-2">Enter / Tab</kbd><span>{t('fileSearch.select')}</span><kbd className="ml-2">→</kbd><span>{t('fileSearch.open')}</span><kbd className="ml-2">Esc</kbd><span>{t('fileSearch.close')}</span></div> : null}
    </div>
  )
})
