import { useState, useEffect, useRef, useMemo, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Search, X } from 'lucide-react'
import { useTranslation, type TranslationKey } from '../../i18n'
import { useSessionStore } from '../../stores/sessionStore'
import { useTabStore } from '../../stores/tabStore'
import { searchApi, type SessionSearchResult, type SessionMatch, type SessionMatchRole } from '../../api/search'

const DEBOUNCE_MS = 250
const RECENT_LIMIT = 8
const SEARCH_LIMIT = 50
const MATCH_PREVIEW_PER_SESSION = 3

type Props = {
  open: boolean
  onClose: () => void
}

/** A row in the result list — either a recent session (no matches) or a search hit. */
type Row = {
  sessionId: string
  title: string
  projectPath: string
  workDir: string | null
  modifiedAt: string
  matchCount: number
  matches: SessionMatch[]
}

export function GlobalSearchModal({ open, onClose }: Props) {
  const t = useTranslation()
  const sessions = useSessionStore((s) => s.sessions)

  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [results, setResults] = useState<SessionSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const requestIdRef = useRef(0)

  // Reset + focus whenever the modal opens.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setDebouncedQuery('')
    setResults([])
    setError(false)
    setTruncated(false)
    setActiveIndex(0)
    requestIdRef.current += 1 // invalidate any in-flight request
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  // Debounce the query.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [query])

  // Run the search (or clear) when the debounced query changes.
  useEffect(() => {
    setActiveIndex(0)
    const q = debouncedQuery.trim()
    if (!q) {
      setResults([])
      setLoading(false)
      setError(false)
      setTruncated(false)
      return
    }

    const reqId = ++requestIdRef.current
    setLoading(true)
    setError(false)
    searchApi
      .searchSessions(q, { limit: SEARCH_LIMIT })
      .then((resp) => {
        if (reqId !== requestIdRef.current) return // a newer request superseded this one
        setResults(resp.results)
        setTruncated(resp.truncated)
        setLoading(false)
      })
      .catch(() => {
        if (reqId !== requestIdRef.current) return
        setResults([])
        setError(true)
        setLoading(false)
      })
  }, [debouncedQuery])

  const recentSessions = useMemo(
    () =>
      [...sessions]
        .sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : 0))
        .slice(0, RECENT_LIMIT),
    [sessions],
  )

  const isSearching = debouncedQuery.trim().length > 0

  const rows: Row[] = useMemo(() => {
    if (!isSearching) {
      return recentSessions.map((s) => ({
        sessionId: s.id,
        title: s.title,
        projectPath: s.projectPath,
        workDir: s.workDir,
        modifiedAt: s.modifiedAt,
        matchCount: 0,
        matches: [],
      }))
    }
    return results.map((r) => ({
      sessionId: r.sessionId,
      title: r.title,
      projectPath: r.projectPath,
      workDir: r.workDir,
      modifiedAt: r.modifiedAt,
      matchCount: r.matchCount,
      matches: r.matches,
    }))
  }, [isSearching, recentSessions, results])

  // Keep the active row in view.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  function openRow(row: Row) {
    useTabStore.getState().openTab(row.sessionId, row.title)
    onClose()
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, rows.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const row = rows[activeIndex]
      if (row) openRow(row)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]">
      <div
        className="absolute inset-0 bg-[var(--color-overlay-scrim)] transition-opacity duration-200"
        onClick={onClose}
      />

      <div
        className="glass-panel relative z-10 flex max-h-[70vh] w-[640px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-[var(--radius-xl)]"
        role="dialog"
        aria-modal="true"
        aria-label={t('search.global.placeholder')}
      >
        {/* Search input */}
        <div className="flex items-center gap-2.5 border-b border-[var(--color-border)] px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('search.global.placeholder')}
            aria-label={t('search.global.placeholder')}
            className="min-w-0 flex-1 bg-transparent text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
          />
          {loading && (
            <span className="material-symbols-outlined animate-spin text-[16px] text-[var(--color-text-tertiary)]">
              progress_activity
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={t('search.global.close')}
            title={t('search.global.close')}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Results */}
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1.5" role="listbox">
          {!isSearching ? (
            <>
              {rows.length > 0 && (
                <div className="px-4 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-tertiary)]">
                  {t('search.global.recentTitle')}
                </div>
              )}
              {rows.map((row, i) => (
                <ResultRow
                  key={row.sessionId}
                  row={row}
                  index={i}
                  active={i === activeIndex}
                  onActivate={setActiveIndex}
                  onOpen={openRow}
                  t={t}
                />
              ))}
            </>
          ) : loading && results.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-[var(--color-text-tertiary)]">
              {t('search.global.loading')}
            </div>
          ) : error ? (
            <div className="px-4 py-8 text-center text-xs text-[var(--color-error)]">
              {t('search.global.error')}
            </div>
          ) : rows.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-[var(--color-text-tertiary)]">
              {t('search.global.noResults')}
            </div>
          ) : (
            <>
              {rows.map((row, i) => (
                <ResultRow
                  key={row.sessionId}
                  row={row}
                  index={i}
                  active={i === activeIndex}
                  onActivate={setActiveIndex}
                  onOpen={openRow}
                  t={t}
                />
              ))}
              {truncated && (
                <div className="px-4 py-2 text-center text-[11px] text-[var(--color-text-tertiary)]">
                  {t('search.global.truncated', { count: SEARCH_LIMIT })}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer hints */}
        <div className="flex items-center gap-1.5 border-t border-[var(--color-border)] px-4 py-1.5 text-[10px] text-[var(--color-text-tertiary)]">
          <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-1 py-0.5 font-mono">↑↓</kbd>
          <span>{t('fileSearch.navigate')}</span>
          <kbd className="ml-2 rounded border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-1 py-0.5 font-mono">Enter</kbd>
          <span>{t('fileSearch.select')}</span>
          <kbd className="ml-2 rounded border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-1 py-0.5 font-mono">Esc</kbd>
          <span>{t('fileSearch.close')}</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}

type RowProps = {
  row: Row
  index: number
  active: boolean
  onActivate: (index: number) => void
  onOpen: (row: Row) => void
  t: (key: TranslationKey, params?: Record<string, string | number>) => string
}

function ResultRow({ row, index, active, onActivate, onOpen, t }: RowProps) {
  return (
    <button
      type="button"
      data-index={index}
      role="option"
      aria-selected={active}
      onMouseEnter={() => onActivate(index)}
      onClick={() => onOpen(row)}
      className={`flex w-full flex-col gap-0.5 px-4 py-2 text-left transition-colors focus-visible:outline-none ${
        active ? 'bg-[var(--color-surface-hover)]' : ''
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--color-text-primary)]">
          {row.title}
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-[var(--color-text-tertiary)]">
          {formatRelativeTime(row.modifiedAt, t)}
        </span>
      </div>
      <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-tertiary)]">
        <span className="min-w-0 truncate">{projectLabel(row)}</span>
        {row.matchCount > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <span className="shrink-0">{t('search.global.matchCount', { count: row.matchCount })}</span>
          </>
        )}
      </div>
      {row.matches.slice(0, MATCH_PREVIEW_PER_SESSION).map((m, j) => (
        <div key={`${m.lineNumber}-${j}`} className="mt-0.5 flex items-start gap-2">
          <RoleBadge role={m.role} t={t} />
          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-secondary)]">
            {renderHighlighted(m.snippet, m.highlights)}
          </span>
        </div>
      ))}
    </button>
  )
}

function RoleBadge({
  role,
  t,
}: {
  role: SessionMatchRole
  t: (key: TranslationKey, params?: Record<string, string | number>) => string
}) {
  const isUser = role === 'user'
  return (
    <span
      className={`mt-px shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none ${
        isUser
          ? 'bg-[var(--color-brand)]/15 text-[var(--color-brand)]'
          : 'bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)]'
      }`}
    >
      {isUser ? t('search.global.roleUser') : t('search.global.roleAssistant')}
    </span>
  )
}

/** Wrap matched ranges of `snippet` in <mark> for highlighting. */
function renderHighlighted(
  snippet: string,
  highlights: Array<{ start: number; end: number }>,
): ReactNode {
  if (!highlights.length) return snippet
  const parts: ReactNode[] = []
  let cursor = 0
  for (const h of highlights) {
    const start = Math.max(0, Math.min(h.start, snippet.length))
    const end = Math.max(start, Math.min(h.end, snippet.length))
    if (start > cursor) parts.push(snippet.slice(cursor, start))
    parts.push(
      <mark
        key={`${start}-${end}`}
        className="rounded-[3px] bg-[var(--color-brand)]/25 px-0.5 text-[var(--color-text-primary)]"
      >
        {snippet.slice(start, end)}
      </mark>,
    )
    cursor = end
  }
  if (cursor < snippet.length) parts.push(snippet.slice(cursor))
  return parts
}

function projectLabel(row: Row): string {
  const candidate = row.workDir || row.projectPath
  if (!candidate) return ''
  const segments = candidate.split('/').filter(Boolean)
  return segments[segments.length - 1] ?? candidate
}

function formatRelativeTime(
  dateStr: string,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  const date = new Date(dateStr)
  const timestamp = date.getTime()
  if (!Number.isFinite(timestamp)) return ''

  const diff = Date.now() - timestamp
  const min = Math.floor(diff / 60000)
  if (min < 1) return t('session.timeJustNow')
  if (min < 60) return t('session.timeMinutes', { n: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t('session.timeHours', { n: hr })
  const day = Math.floor(hr / 24)
  if (day < 30) return t('session.timeDays', { n: day })
  return new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric' }).format(date)
}
