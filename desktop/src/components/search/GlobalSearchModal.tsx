import { useState, useEffect, useRef, useMemo, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MessageSquare, Search } from 'lucide-react'
import { useTranslation, type TranslationKey } from '../../i18n'
import { useSessionStore } from '../../stores/sessionStore'
import { useTabStore } from '../../stores/tabStore'
import { searchApi, type SessionSearchResult, type SessionMatch, type SessionMatchRole } from '../../api/search'
import { Badge } from '@/components/ui/Badge'
import { Spinner } from '@/components/ui/Spinner'

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
  const requestControllerRef = useRef<AbortController | null>(null)
  const [isComposing, setIsComposing] = useState(false)

  // Reset + focus whenever the modal opens.
  useEffect(() => {
    if (!open) {
      requestControllerRef.current?.abort()
      requestControllerRef.current = null
      requestIdRef.current += 1
      return
    }
    setQuery('')
    setDebouncedQuery('')
    setResults([])
    setLoading(false)
    setError(false)
    setTruncated(false)
    setActiveIndex(0)
    setIsComposing(false)
    requestControllerRef.current?.abort()
    requestControllerRef.current = null
    requestIdRef.current += 1 // invalidate any in-flight request
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  // Cancel stale work as soon as the visible query changes. Waiting for the
  // debounce here would leave the previous full-history scan running.
  useEffect(() => {
    requestControllerRef.current?.abort()
    requestControllerRef.current = null
    requestIdRef.current += 1
    setResults([])
    setError(false)
    setTruncated(false)
    setActiveIndex(0)

    if (!open || !query.trim()) {
      setLoading(false)
      setDebouncedQuery('')
      return
    }

    setLoading(true)
    if (isComposing) return
    const id = setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [isComposing, open, query])

  // Run the search (or clear) when the debounced query changes.
  useEffect(() => {
    if (!open) return
    const q = debouncedQuery.trim()
    if (!q) {
      setResults([])
      setLoading(false)
      setError(false)
      setTruncated(false)
      return
    }

    const reqId = ++requestIdRef.current
    const controller = new AbortController()
    requestControllerRef.current = controller
    setLoading(true)
    setError(false)
    searchApi
      .searchSessions(
        q,
        { limit: SEARCH_LIMIT, matchesPerSession: MATCH_PREVIEW_PER_SESSION },
        { signal: controller.signal },
      )
      .then((resp) => {
        if (controller.signal.aborted || reqId !== requestIdRef.current) return
        setResults(resp.results)
        setTruncated(resp.truncated)
        setLoading(false)
      })
      .catch((searchError: unknown) => {
        if (
          controller.signal.aborted ||
          reqId !== requestIdRef.current ||
          (searchError instanceof Error && searchError.name === 'AbortError')
        ) return
        setResults([])
        setError(true)
        setLoading(false)
      })
      .finally(() => {
        if (requestControllerRef.current === controller) {
          requestControllerRef.current = null
        }
      })

    return () => controller.abort()
  }, [debouncedQuery, open])

  const recentSessions = useMemo(
    () =>
      [...sessions]
        .sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : 0))
        .slice(0, RECENT_LIMIT),
    [sessions],
  )

  const isSearching = query.trim().length > 0

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
    setActiveIndex((index) => rows.length === 0 ? 0 : Math.min(index, rows.length - 1))
  }, [rows.length])

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
    if (isComposing || e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (rows.length === 0) return
      setActiveIndex((i) => Math.min(i + 1, rows.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (rows.length === 0) return
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
    <div className="fixed inset-0 z-[var(--z-dialog)] flex items-start justify-center pt-[12vh]">
      <div
        className="absolute inset-0 bg-[var(--color-modal-scrim)] transition-opacity duration-200"
        onClick={onClose}
      />

      {/* The command palette (「素」): a paper sheet with a 52px query row,
          sectioned 36px rows, and the key legend as its footer. */}
      <div
        className="animate-overlay-in relative z-10 flex max-h-[70vh] w-[620px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-dropdown)]"
        role="dialog"
        aria-modal="true"
        aria-label={t('search.global.placeholder')}
      >
        {/* Search input */}
        <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-[var(--color-border)] px-3.5">
          <Search size={18} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('search.global.placeholder')}
            aria-label={t('search.global.placeholder')}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
          />
          {loading && <Spinner size={14} className="text-[var(--color-text-tertiary)]" />}
          {/* Esc closes from the keyboard; this is the same exit for the
              pointer, drawn as the key it stands for. */}
          <button
            type="button"
            onClick={onClose}
            aria-label={t('search.global.close')}
            title={t('search.global.close')}
            className={`${KEYCAP_CLASS} cursor-pointer transition-colors hover:border-[var(--color-outline)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]`}
          >
            esc
          </button>
        </div>

        {/* Results */}
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto pb-1.5" role="listbox">
          {!isSearching ? (
            <>
              {rows.length > 0 && <SectionTitle>{t('search.global.recentTitle')}</SectionTitle>}
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
            <div className="px-4 py-8 text-center text-[13px] text-[var(--color-text-tertiary)]">
              {t('search.global.loading')}
            </div>
          ) : error ? (
            <div className="px-4 py-8 text-center text-[13px] text-[var(--color-error)]">
              {t('search.global.error')}
            </div>
          ) : rows.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px] text-[var(--color-text-tertiary)]">
              {t('search.global.noResults')}
            </div>
          ) : (
            <>
              <div className="h-1.5" aria-hidden="true" />
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
                <div className="px-4 py-2 text-center text-[12px] text-[var(--color-text-tertiary)]">
                  {t('search.global.truncated', { count: SEARCH_LIMIT })}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer hints */}
        <div className="flex shrink-0 items-center gap-1 border-t border-[var(--color-border)] px-3.5 py-2.5 text-[11px] text-[var(--color-text-tertiary)]">
          <Keycap>↑</Keycap>
          <Keycap>↓</Keycap>
          <span className="ml-0.5 mr-2.5">{t('fileSearch.navigate')}</span>
          <Keycap>↵</Keycap>
          <span className="ml-0.5 mr-2.5">{t('fileSearch.select')}</span>
          <Keycap>esc</Keycap>
          <span className="ml-0.5">{t('fileSearch.close')}</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** 「素」 kbd: mono 11, 18px tall, `--radius-xs`, hairline, paper fill, tertiary ink. */
const KEYCAP_CLASS = 'inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-[var(--radius-xs)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-1 font-mono text-[11px] leading-none text-[var(--color-text-tertiary)]'

function Keycap({ children }: { children: ReactNode }) {
  return <kbd className={KEYCAP_CLASS}>{children}</kbd>
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 pb-1 pt-2.5 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
      {children}
    </div>
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
  const project = projectLabel(row)
  const time = formatRelativeTime(row.modifiedAt, t)
  const meta = [project, time].filter(Boolean).join(' · ')
  return (
    <button
      type="button"
      data-index={index}
      role="option"
      aria-selected={active}
      onMouseEnter={() => onActivate(index)}
      onClick={() => onOpen(row)}
      className={`mx-1.5 flex w-[calc(100%-12px)] flex-col rounded-[var(--radius-md)] px-2.5 text-left transition-colors focus-visible:outline-none ${
        active ? 'bg-[var(--color-surface-selected)]' : 'hover:bg-[var(--color-surface-hover)]'
      }`}
    >
      <div className="flex h-9 w-full min-w-0 items-center gap-2.5">
        <MessageSquare size={14} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text-primary)]">
          {row.title}
        </span>
        {row.matchCount > 0 && (
          <span className="shrink-0 text-[12px] tabular-nums text-[var(--color-text-tertiary)]">
            {t('search.global.matchCount', { count: row.matchCount })}
          </span>
        )}
        <span className="max-w-[45%] shrink-0 truncate text-[12px] tabular-nums text-[var(--color-text-tertiary)]">
          {meta}
        </span>
        {active && <Keycap>↵</Keycap>}
      </div>
      {row.matches.length > 0 && (
        <div className="-mt-1 flex w-full flex-col gap-1 pb-2 pl-6">
          {row.matches.slice(0, MATCH_PREVIEW_PER_SESSION).map((m, j) => (
            <div key={`${m.lineNumber}-${j}`} className="flex min-w-0 items-center gap-2">
              <RoleBadge role={m.role} t={t} />
              <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-secondary)]">
                {renderHighlighted(m.snippet, m.highlights)}
              </span>
            </div>
          ))}
        </div>
      )}
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
  // A speaker label, not a state: neutral either way, the words tell them apart.
  return (
    <Badge tone="neutral" size="xs" pill={false} className="shrink-0 leading-none">
      {isUser ? t('search.global.roleUser') : t('search.global.roleAssistant')}
    </Badge>
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
        className="rounded-[var(--radius-xs)] bg-[var(--color-search-highlight)] px-px text-[var(--color-on-search-highlight)]"
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
