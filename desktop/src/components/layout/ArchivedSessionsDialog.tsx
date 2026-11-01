import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Archive, RotateCcw } from 'lucide-react'
import { ApiError } from '@/api/client'
import { sessionsApi } from '@/api/sessions'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Modal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { useTranslation } from '@/i18n'
import { useChatStore } from '@/stores/chatStore'
import { useSessionStore } from '@/stores/sessionStore'
import type { SessionListItem } from '@/types/session'

type Props = { projectRoot?: string; onClose: () => void }
type ArchivePage = { sessions: SessionListItem[]; nextCursor: string | null; offset: number; hasMore: boolean }
const PAGE_SIZE = 50

export function ArchivedSessionsDialog(props: Props) {
  // Each directory owns its pagination and pending requests. Switching scope
  // must never let a late response replace the newly selected directory.
  return <ArchivedSessionBrowser key={props.projectRoot ?? ''} {...props} />
}

function ArchivedSessionBrowser({ projectRoot, onClose }: Props) {
  const t = useTranslation()
  const errorId = useId()
  const [page, setPage] = useState<ArchivePage>({ sessions: [], nextCursor: null, offset: 0, hasMore: false })
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [restoreError, setRestoreError] = useState(false)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const pageRef = useRef(page)
  const mountedRef = useRef(false)
  const requestRef = useRef<AbortController | null>(null)
  const restoringRef = useRef<string | null>(null)
  const retryResetRef = useRef(true)

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
        next = { sessions: response.sessions, nextCursor: response.nextCursor, offset: 0, hasMore: response.nextCursor !== null }
      } else {
        const offset = restart ? 0 : previous.offset
        const response = await sessionsApi.list({ archived: true, limit: PAGE_SIZE, offset }, { signal: controller.signal })
        const nextOffset = offset + response.sessions.length
        next = { sessions: response.sessions, nextCursor: null, offset: nextOffset, hasMore: nextOffset < response.total }
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

  const openSession = (session: SessionListItem) => {
    useSessionStore.getState().openHistoricalSession(session)
    useChatStore.getState().connectToSession(session.id)
    onClose()
  }
  const hasError = loadError || restoreError

  return (
    <Modal open onClose={onClose} title={t('sidebar.archivedSessions')} width={640} typography="interface">
      <p className="mb-3 text-[13px] text-[var(--color-text-secondary)]">{t('sidebar.archiveHint')}</p>
      {projectRoot && <p className="mb-3 break-all text-xs text-[var(--color-text-tertiary)]">{projectRoot}</p>}
      {hasError && (
        <div id={errorId} role="alert" className="mb-3 flex items-center gap-2 text-[13px] text-[var(--color-error)]">
          {t(loadError ? 'sidebar.archiveLoadFailed' : 'sidebar.archiveRestoreFailed')}
          {loadError && <Button size="sm" variant="ghost" disabled={loading} onClick={() => void loadPage(retryResetRef.current)}>{t('common.retry')}</Button>}
        </div>
      )}
      <ul className="space-y-1" aria-busy={loading}>
        {page.sessions.map((session) => (
          <li key={session.id} className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] p-2">
            <button
              type="button"
              aria-label={t('sidebar.archiveOpen', { title: session.title })}
              onClick={() => openSession(session)}
              disabled={restoringId !== null}
              className="min-w-0 flex-1 rounded-[var(--radius-sm)] p-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
            >
              <span className="block truncate text-[13px] text-[var(--color-text-primary)]" title={session.title}>{session.title}</span>
              <span className="block truncate text-xs text-[var(--color-text-tertiary)]" title={session.projectRoot || session.workDir || session.projectPath}>{session.projectRoot || session.workDir || session.projectPath}</span>
            </button>
            <Button
              variant="secondary"
              size="base"
              icon={<RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />}
              aria-label={t('sidebar.archiveRestoreNamed', { title: session.title })}
              aria-describedby={hasError ? errorId : undefined}
              disabled={loading || restoringId !== null}
              loading={restoringId === session.id}
              onClick={() => void restoreSession(session.id)}
            >
              {t('sidebar.restoreSession')}
            </Button>
          </li>
        ))}
      </ul>
      {loading && <div role="status" className="flex items-center justify-center gap-2 py-4 text-xs text-[var(--color-text-tertiary)]"><Spinner size={14} />{t('common.loading')}</div>}
      {!loading && !loadError && page.sessions.length === 0 && <EmptyState icon={<Archive size={20} strokeWidth={1.75} />} title={t('sidebar.archiveEmpty')} variant="plain" />}
      {page.hasMore && !loadError && <Button className="mt-3" variant="ghost" block disabled={loading || restoringId !== null} onClick={() => void loadPage(false)}>{t('sidebar.archiveLoadMore')}</Button>}
    </Modal>
  )
}
