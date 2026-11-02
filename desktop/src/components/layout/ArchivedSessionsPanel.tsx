import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronLeft, Folder, RotateCcw } from 'lucide-react'
import { ApiError } from '@/api/client'
import { sessionsApi } from '@/api/sessions'
import { EmptyState } from '@/components/ui/EmptyState'
import { IconButton } from '@/components/ui/IconButton'
import { useDismissable } from '@/hooks/useDismissable'
import { useTranslation } from '@/i18n'
import { formatRelativeTime } from '@/lib/formatRelativeTime'
import { useChatStore } from '@/stores/chatStore'
import { resolveProjectDisplayName } from '@/stores/projectDisplayNameStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useTabStore } from '@/stores/tabStore'
import type { SessionListItem } from '@/types/session'
import { SidebarMenuItem } from './SidebarMenuItem'
import { getSessionProjectKey, projectTitle } from './sidebarTaskGroups'

type Props = {
  /** Limits the list to one project; omitted, every project's archive shows. */
  projectRoot?: string
  onBack: () => void
}
type ArchivePage = { sessions: SessionListItem[]; nextCursor: string | null; offset: number; hasMore: boolean; total: number | null }
const PAGE_SIZE = 50
const ICON_STROKE = 1.75

/**
 * Archived sessions, shown in place of the sidebar's project list. Rows read
 * like ordinary session rows; opening one keeps the list, and restoring one
 * returns it to its project.
 */
export function ArchivedSessionsPanel(props: Props) {
  // Each directory owns its pagination and pending requests. Switching scope
  // must never let a late response replace the newly selected directory.
  return <ArchivedSessionList key={props.projectRoot ?? ''} {...props} />
}

function titleForProject(projectKey: string): string {
  return resolveProjectDisplayName(projectKey) || projectTitle(projectKey)
}

function ArchivedSessionList({ projectRoot, onBack }: Props) {
  const t = useTranslation()
  const errorId = useId()
  const activeTabId = useTabStore((s) => s.activeTabId)
  const projectArchivedTotals = useSessionStore((s) => s.projectArchivedTotals)
  const [page, setPage] = useState<ArchivePage>({ sessions: [], nextCursor: null, offset: 0, hasMore: false, total: null })
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [restoreError, setRestoreError] = useState(false)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ session: SessionListItem; x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef(page)
  const mountedRef = useRef(false)
  const requestRef = useRef<AbortController | null>(null)
  const restoringRef = useRef<string | null>(null)
  const retryResetRef = useRef(true)

  useDismissable({ open: menu !== null, refs: [menuRef], onDismiss: () => setMenu(null), closeOnViewportChange: true })

  const loadPage = useCallback(async (reset: boolean) => {
    if (requestRef.current && !reset) return
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    const current = () => mountedRef.current && requestRef.current === controller && !controller.signal.aborted
    setLoading(true)
    setLoadError(false)
    let restart = reset
    try {
      const previous = pageRef.current
      let next: ArchivePage
      if (projectRoot) {
        const params = { projectRoot, archived: true, limit: PAGE_SIZE }
        let response
        try {
          response = await sessionsApi.listProjectHistory(
            !restart && previous.nextCursor ? { ...params, cursor: previous.nextCursor } : params,
            { signal: controller.signal },
          )
        } catch (error) {
          if (!current() || restart || !previous.nextCursor || !(error instanceof ApiError) || error.status !== 409) throw error
          // The server expires history snapshots. Retry once from the start;
          // a failed retry also needs to retry without the expired cursor.
          restart = true
          response = await sessionsApi.listProjectHistory(params, { signal: controller.signal })
        }
        next = { sessions: response.sessions, nextCursor: response.nextCursor, offset: 0, hasMore: response.nextCursor !== null, total: null }
      } else {
        const offset = restart ? 0 : previous.offset
        const response = await sessionsApi.list({ archived: true, limit: PAGE_SIZE, offset }, { signal: controller.signal })
        const nextOffset = offset + response.sessions.length
        next = { sessions: response.sessions, nextCursor: null, offset: nextOffset, hasMore: nextOffset < response.total, total: response.total }
      }
      if (!current()) return
      const items = new Map((restart ? [] : previous.sessions).map((session) => [session.id, session]))
      for (const session of next.sessions) items.set(session.id, session)
      next.sessions = [...items.values()]
      pageRef.current = next
      setPage(next)
    } catch {
      if (current()) {
        retryResetRef.current = restart
        setLoadError(true)
      }
    } finally {
      if (current()) {
        requestRef.current = null
        setLoading(false)
      }
    }
  }, [projectRoot])

  useEffect(() => {
    mountedRef.current = true
    void loadPage(true)
    return () => {
      mountedRef.current = false
      requestRef.current?.abort()
    }
  }, [loadPage])

  const restoreSession = async (sessionId: string) => {
    setMenu(null)
    if (restoringRef.current) return
    restoringRef.current = sessionId
    setRestoringId(sessionId)
    setRestoreError(false)
    try {
      await useSessionStore.getState().setSessionArchived(sessionId, false)
      if (!mountedRef.current) return
      const next = { ...pageRef.current, sessions: pageRef.current.sessions.filter((session) => session.id !== sessionId) }
      pageRef.current = next
      setPage(next)
      // Removing a row shifts all subsequent offsets. Rebuild the first page
      // instead of carrying an old offset forward and skipping an archive.
      await loadPage(true)
    } catch {
      if (mountedRef.current) setRestoreError(true)
    } finally {
      restoringRef.current = null
      if (mountedRef.current) setRestoringId(null)
    }
  }

  // The list stays put, so several archived sessions can be read in turn.
  const openSession = (session: SessionListItem) => {
    useSessionStore.getState().openHistoricalSession(session)
    useChatStore.getState().connectToSession(session.id)
  }

  // Across all projects, rows group under their project in server order.
  const groups = useMemo(() => {
    const byProject = new Map<string, SessionListItem[]>()
    for (const session of page.sessions) {
      const key = projectRoot ?? getSessionProjectKey(session)
      byProject.set(key, [...byProject.get(key) ?? [], session])
    }
    return [...byProject.entries()].map(([key, sessions]) => ({ key, sessions }))
  }, [page.sessions, projectRoot])

  const total = projectRoot ? projectArchivedTotals[projectRoot] : page.total
  const hasError = loadError || restoreError
  const showInitialLoading = loading && page.sessions.length === 0

  return (
    <div data-testid="sidebar-archive-view">
      <div className="flex h-7 items-center gap-1 pr-2">
        <IconButton
          icon={<ChevronLeft size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />}
          label={t('sidebar.archiveBack')}
          onClick={onBack}
          size="xs"
          tone="muted"
          surface="sidebar"
        />
        <div className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[var(--color-text-secondary)]">
          {projectRoot ? t('sidebar.archivedSessionsInProject', { project: titleForProject(projectRoot) }) : t('sidebar.archivedSessions')}
        </div>
        {total !== null && total !== undefined && total > 0 && (
          <span className="flex-shrink-0 text-[11px] font-medium tabular-nums text-[var(--color-text-tertiary)]">{total}</span>
        )}
      </div>

      {hasError && (
        <div id={errorId} role="alert" className="flex items-center gap-2 py-1 pl-8 pr-2 text-[12px] text-[var(--color-error)]">
          <span className="min-w-0 flex-1">{t(loadError ? 'sidebar.archiveLoadFailed' : 'sidebar.archiveRestoreFailed')}</span>
          {loadError && (
            <button
              type="button"
              disabled={loading}
              onClick={() => void loadPage(retryResetRef.current)}
              className="h-6 flex-shrink-0 rounded-[var(--radius-sm)] px-1.5 font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-sidebar-item-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] disabled:opacity-50"
            >
              {t('common.retry')}
            </button>
          )}
        </div>
      )}

      <div className="mt-px" aria-busy={loading}>
        {groups.map((group) => (
          <section key={group.key} className="mb-2.5" aria-label={projectRoot ? undefined : titleForProject(group.key)}>
            {!projectRoot && (
              <div className="flex h-7 items-center gap-2 px-2" title={group.key}>
                <Folder size={16} strokeWidth={ICON_STROKE} className="flex-shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[var(--color-text-secondary)]">{titleForProject(group.key)}</span>
                {(projectArchivedTotals[group.key] ?? 0) > 0 && (
                  <span className="flex-shrink-0 text-[11px] font-medium tabular-nums text-[var(--color-text-tertiary)]">{projectArchivedTotals[group.key]}</span>
                )}
              </div>
            )}
            {group.sessions.map((session) => {
              const title = session.title || t('tabs.untitled')
              const relativeTime = formatRelativeTime(session.modifiedAt, t)
              return (
                <div key={session.id} data-archived-session-id={session.id} className="group/archived relative mb-px last:mb-0">
                  <button
                    type="button"
                    onClick={() => openSession(session)}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      setMenu({ session, x: event.clientX, y: event.clientY })
                    }}
                    title={title}
                    className={`flex h-[30px] w-full items-center gap-1.5 rounded-[var(--radius-sm)] pl-8 pr-2 text-left text-[13px] transition-[background,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${
                      session.id === activeTabId
                        ? 'bg-[var(--color-sidebar-item-active)] font-medium text-[var(--color-text-primary)] shadow-[0_0_0_1px_var(--color-border),var(--shadow-raised)]'
                        : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-sidebar-item-hover)] hover:text-[var(--color-text-primary)]'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{title}</span>
                    {/* The restore control takes this place on hover and focus. */}
                    <span
                      className="flex-shrink-0 whitespace-nowrap text-[11px] font-normal tabular-nums text-[var(--color-text-tertiary)] group-hover/archived:invisible group-focus-within/archived:invisible"
                      title={t('session.lastUpdated', { time: relativeTime })}
                    >
                      {relativeTime}
                    </span>
                  </button>
                  <div
                    className={`absolute right-1 top-1/2 -translate-y-1/2 transition-opacity duration-150 group-hover/archived:pointer-events-auto group-hover/archived:opacity-100 group-focus-within/archived:pointer-events-auto group-focus-within/archived:opacity-100 ${
                      restoringId === session.id ? 'opacity-100' : 'pointer-events-none opacity-0'
                    }`}
                  >
                    <IconButton
                      icon={<RotateCcw size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />}
                      label={t('sidebar.archiveRestoreNamed', { title })}
                      aria-describedby={hasError ? errorId : undefined}
                      onClick={() => void restoreSession(session.id)}
                      disabled={loading || restoringId !== null}
                      loading={restoringId === session.id}
                      size="xs"
                      tone="muted"
                      surface="sidebar"
                    />
                  </div>
                </div>
              )
            })}
          </section>
        ))}
      </div>

      {showInitialLoading && (
        <div role="status" className="px-2 py-4 text-center text-[12px] text-[var(--color-text-tertiary)]">{t('common.loading')}</div>
      )}
      {!loading && !loadError && page.sessions.length === 0 && (
        <div className="px-2 py-2">
          <EmptyState variant="inline" title={t('sidebar.archiveEmpty')} />
        </div>
      )}
      {page.hasMore && !loadError && (
        <button
          type="button"
          disabled={loading || restoringId !== null}
          onClick={() => void loadPage(false)}
          className="inline-flex h-7 items-center rounded-[var(--radius-sm)] pl-8 pr-2 text-[12px] text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] disabled:opacity-50"
        >
          {loading ? t('common.loading') : t('sidebar.archiveLoadMore')}
        </button>
      )}

      {menu && (
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-[var(--z-dropdown)] min-w-[180px] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-1 shadow-[var(--shadow-dropdown)]"
          style={{ left: menu.x, top: menu.y }}
        >
          <SidebarMenuItem
            icon={<RotateCcw size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />}
            disabled={loading || restoringId !== null}
            onClick={() => void restoreSession(menu.session.id)}
          >
            {t('sidebar.restoreSession')}
          </SidebarMenuItem>
        </div>
      )}
    </div>
  )
}
