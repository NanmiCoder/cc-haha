import { useState, useEffect, useRef, useMemo, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Folder, MessageSquare, Search } from 'lucide-react'
import { useTranslation, type TranslationKey } from '../../i18n'
import { useSessionStore } from '../../stores/sessionStore'
import { useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import { useSessionRuntimeStore } from '@/stores/sessionRuntimeStore'
import {
  resolveProjectDisplayName,
  useProjectDisplayNameRevision,
} from '@/stores/projectDisplayNameStore'
import { sessionsApi } from '@/api/sessions'
import { searchApi, type SessionSearchResult, type SessionMatch, type SessionMatchRole } from '../../api/search'
import { projectTitle } from '@/components/layout/sidebarTaskGroups'
import { Badge } from '@/components/ui/Badge'
import { Spinner } from '@/components/ui/Spinner'
import {
  buildSearchableProjects,
  searchProjects,
  type HighlightRange,
  type ProjectSearchMatch,
} from './projectSearch'

const DEBOUNCE_MS = 250
const RECENT_LIMIT = 8
const PROJECT_SEARCH_LIMIT = 12
const SEARCH_LIMIT = 50
const MATCH_PREVIEW_PER_SESSION = 3
const OPEN_SUMMARY_TIMEOUT_MS = 5_000

type Props = {
  open: boolean
  onClose: () => void
  onSelectProject?: (projectKey: string) => void
}

/** A session row in the result list — either a recent session (no matches) or a search hit. */
type Row = {
  sessionId: string
  title: string
  projectPath: string
  projectRoot?: string | null
  workDir: string | null
  modifiedAt: string
  matchCount: number
  matches: SessionMatch[]
}

type SearchPaletteItem =
  | { kind: 'project'; project: ProjectSearchMatch }
  | { kind: 'session'; row: Row }

export function GlobalSearchModal({ open, onClose, onSelectProject }: Props) {
  const t = useTranslation()
  const sessions = useSessionStore((s) => s.sessions)
  const projectSessionTotals = useSessionStore((s) => s.projectSessionTotals)
  const projectArchivedTotals = useSessionStore((s) => s.projectArchivedTotals)
  const projectDisplayNameRevision = useProjectDisplayNameRevision()

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
    return () => {
      cancelAnimationFrame(id)
      requestControllerRef.current?.abort()
    }
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

  const searchableProjects = useMemo(
    () => buildSearchableProjects(
      sessions,
      projectSessionTotals,
      projectArchivedTotals,
      resolveProjectDisplayName,
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, projectSessionTotals, projectArchivedTotals, projectDisplayNameRevision],
  )

  const isSearching = query.trim().length > 0

  const matchedProjects = useMemo(
    () => (isSearching ? searchProjects(searchableProjects, query, PROJECT_SEARCH_LIMIT) : []),
    [isSearching, query, searchableProjects],
  )

  const rows: Row[] = useMemo(() => {
    if (!isSearching) {
      return recentSessions.map((s) => ({
        sessionId: s.id,
        title: s.title,
        projectPath: s.projectPath,
        projectRoot: s.projectRoot,
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

  const items: SearchPaletteItem[] = useMemo(() => {
    if (!isSearching) {
      return rows.map((row) => ({ kind: 'session', row }))
    }
    return [
      ...matchedProjects.map((project): SearchPaletteItem => ({ kind: 'project', project })),
      ...rows.map((row): SearchPaletteItem => ({ kind: 'session', row })),
    ]
  }, [isSearching, matchedProjects, rows])

  // Keep the active row in view.
  useEffect(() => {
    setActiveIndex((index) => items.length === 0 ? 0 : Math.min(index, items.length - 1))
  }, [items.length])

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex])

  function openProject(project: ProjectSearchMatch) {
    requestControllerRef.current?.abort()
    requestControllerRef.current = null
    requestIdRef.current += 1
    setLoading(false)
    if (onSelectProject) {
      onSelectProject(project.key)
      onClose()
      return
    }
    if (project.latestSession) {
      useSessionStore.getState().openHistoricalSession(project.latestSession)
      onClose()
      return
    }
    if (project.workDir) {
      useUIStore.getState().startNewSessionDraft(project.workDir)
      useSessionStore.getState().setActiveSession(null)
      useTabStore.getState().setActiveTab(null)
    }
    onClose()
  }

  async function openRow(row: Row) {
    requestControllerRef.current?.abort()
    requestControllerRef.current = null
    const requestId = ++requestIdRef.current
    const session = useSessionStore.getState().sessions.find((item) => item.id === row.sessionId)
    if (session) {
      setLoading(false)
      useSessionStore.getState().openHistoricalSession(session)
      onClose()
      return
    }
    // Search hits are not necessarily in the bounded sidebar list. Resolve
    // their metadata before connecting, just like opening project history.
    const controller = new AbortController()
    requestControllerRef.current = controller
    const runtimeSelections = useSessionRuntimeStore.getState().selections
    const isCurrent = () => !controller.signal.aborted && requestId === requestIdRef.current
    setLoading(true)
    try {
      const summary = await sessionsApi.getSummary(row.sessionId, { signal: controller.signal, timeout: OPEN_SUMMARY_TIMEOUT_MS })
      if (!isCurrent()) return
      useSessionStore.getState().openHistoricalSession(summary, runtimeSelections)
      onClose()
    } catch {
      if (!isCurrent()) return
      // A transient summary failure must not prevent opening the transcript
      // or discard the title already supplied by the search result.
      useTabStore.getState().openTab(row.sessionId, row.title)
      onClose()
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null
        setLoading(false)
      }
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (isComposing || e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (items.length === 0) return
      setActiveIndex((i) => Math.min(i + 1, items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (items.length === 0) return
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = items[activeIndex]
      if (!item) return
      if (item.kind === 'project') openProject(item.project)
      else void openRow(item.row)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[var(--z-dialog)] flex items-start justify-center pt-[12vh]">
      <div
        className="dialog-backdrop absolute inset-0 transition-opacity duration-200"
        onClick={onClose}
      />

      {/* V6C command palette: frosted 14px dialog-panel sheet, recessed 10px
          v6c-field search input, concentric 9px rows, and keycap legend footer. */}
      <div
        className="dialog-panel animate-overlay-in relative z-10 flex max-h-[70vh] w-[620px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-[var(--radius-xl)]"
        role="dialog"
        aria-modal="true"
        aria-label={t('search.global.placeholder')}
      >
        {/* Search input */}
        <div className="shrink-0 border-b border-[var(--color-border)] p-2.5">
          <div className="v6c-field flex h-10 items-center gap-2.5 rounded-[var(--radius-card-inner)] px-3 transition-[box-shadow] duration-150 focus-within:ring-2 focus-within:ring-[var(--color-border-focus)]">
            <Search size={16} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
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
              className="min-w-0 flex-1 bg-transparent text-[14px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
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
        </div>

        {/* Results */}
        <div ref={listRef} className="scrollbar-autohide min-h-0 flex-1 overflow-y-auto px-[5px] py-1.5" role="listbox">
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
          ) : matchedProjects.length === 0 && loading && results.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px] text-[var(--color-text-tertiary)]">
              {t('search.global.loading')}
            </div>
          ) : matchedProjects.length === 0 && error ? (
            <div className="px-4 py-8 text-center text-[13px] text-[var(--color-error)]">
              {t('search.global.error')}
            </div>
          ) : matchedProjects.length === 0 && rows.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px] text-[var(--color-text-tertiary)]">
              {t('search.global.noResults')}
            </div>
          ) : (
            <>
              {matchedProjects.length > 0 && (
                <>
                  <SectionTitle>{t('search.global.projectsTitle')}</SectionTitle>
                  {matchedProjects.map((project, i) => (
                    <ProjectRow
                      key={project.key}
                      project={project}
                      index={i}
                      active={i === activeIndex}
                      onActivate={setActiveIndex}
                      onSelect={openProject}
                      t={t}
                    />
                  ))}
                </>
              )}
              {rows.length > 0 && (
                <>
                  <SectionTitle>{t('search.global.chatsTitle')}</SectionTitle>
                  {rows.map((row, i) => {
                    const itemIndex = matchedProjects.length + i
                    return (
                      <ResultRow
                        key={row.sessionId}
                        row={row}
                        index={itemIndex}
                        active={itemIndex === activeIndex}
                        onActivate={setActiveIndex}
                        onOpen={openRow}
                        t={t}
                      />
                    )
                  })}
                  {truncated && (
                    <div className="px-4 py-2 text-center text-[12px] text-[var(--color-text-tertiary)]">
                      {t('search.global.truncated', { count: SEARCH_LIMIT })}
                    </div>
                  )}
                </>
              )}
              {matchedProjects.length > 0 && rows.length === 0 && loading && (
                <>
                  <SectionTitle>{t('search.global.chatsTitle')}</SectionTitle>
                  <div className="px-4 py-3 text-[12px] text-[var(--color-text-tertiary)]">
                    {t('search.global.loading')}
                  </div>
                </>
              )}
              {matchedProjects.length > 0 && rows.length === 0 && error && (
                <>
                  <SectionTitle>{t('search.global.chatsTitle')}</SectionTitle>
                  <div className="px-4 py-3 text-[12px] text-[var(--color-error)]">
                    {t('search.global.error')}
                  </div>
                </>
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
    <div className="px-3 pb-1 pt-2 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
      {children}
    </div>
  )
}

type ProjectRowProps = {
  project: ProjectSearchMatch
  index: number
  active: boolean
  onActivate: (index: number) => void
  onSelect: (project: ProjectSearchMatch) => void
  t: (key: TranslationKey, params?: Record<string, string | number>) => string
}

function ProjectRow({ project, index, active, onActivate, onSelect, t }: ProjectRowProps) {
  const countLabel = project.sessionCount > 0
    ? (project.sessionCount === 1
      ? t('search.global.projectSessionCountOne')
      : t('search.global.projectSessionCount', { count: project.sessionCount }))
    : project.archivedCount > 0
      ? t('search.global.projectArchivedOnly')
      : ''

  return (
    <button
      type="button"
      data-index={index}
      data-search-result-kind="project"
      role="option"
      aria-selected={active}
      title={project.path || project.title}
      onMouseEnter={() => onActivate(index)}
      onClick={() => onSelect(project)}
      className={`flex w-full flex-col rounded-[var(--radius-control)] px-2.5 text-left transition-[background-color,box-shadow] duration-150 ease-out focus-visible:outline-none ${
        active ? 'v6c-row-highlight' : 'hover:bg-[var(--color-surface-hover)]'
      }`}
    >
      <div className="flex h-9 w-full min-w-0 items-center gap-2.5">
        <Folder size={14} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--color-text-primary)]">
          {renderHighlighted(project.title, project.titleHighlights)}
        </span>
        {countLabel && (
          <span className="shrink-0 text-[12px] tabular-nums text-[var(--color-text-tertiary)]">
            {countLabel}
          </span>
        )}
        {project.displayPath && (
          <span className="max-w-[42%] shrink-0 truncate text-[12px] text-[var(--color-text-tertiary)]">
            {renderHighlighted(project.displayPath, project.pathHighlights)}
          </span>
        )}
        {active && <Keycap>↵</Keycap>}
      </div>
    </button>
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
      className={`flex w-full flex-col rounded-[var(--radius-control)] px-2.5 text-left transition-[background-color,box-shadow] duration-150 ease-out focus-visible:outline-none ${
        active ? 'v6c-row-highlight' : 'hover:bg-[var(--color-surface-hover)]'
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
  highlights: HighlightRange[],
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
  const candidate = row.projectRoot || row.workDir || row.projectPath
  if (!candidate) return ''
  return resolveProjectDisplayName(candidate) || projectTitle(candidate)
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
