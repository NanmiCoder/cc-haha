import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Search, Settings, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { IconButton } from '@/components/ui/IconButton'
import { SearchField } from '@/components/ui/SearchField'
import { SkeletonRows } from '@/components/ui/Skeleton'
import type { DesktopUiPreferencesResponse } from '../../api/desktopUiPreferences'
import { useSessionListAutoRefresh } from '../../hooks/useSessionListAutoRefresh'
import { useChatStore } from '../../stores/chatStore'
import {
  resolveProjectDisplayName,
  useProjectDisplayNameRevision,
} from '../../stores/projectDisplayNameStore'
import { useSessionStore } from '../../stores/sessionStore'
import { SETTINGS_TAB_ID, useTabStore } from '../../stores/tabStore'
import type { SessionListItem } from '../../types/session'
import {
  normalizeSidebarProjectPreferences,
  readCachedSidebarProjectPreferences,
} from '../layout/sidebarProjectPreferenceStorage'
import { getSessionProjectKey, getSessionWorkspaceLabel } from '../layout/sidebarTaskGroups'
import { MobileSessionList } from './MobileSessionList'
import { openMobileSession } from './mobileNavigation'
import { resolveNewTaskWorkDir } from './mobileNewTask'
import {
  buildMobileSessionGroups,
  filterMobileSessions,
  listMobileProjectFilters,
} from './mobileSessionGroups'
import { useMobileSessionStatus } from './mobileSessionStatus'
import { useLiveSessionActivity } from './useLiveSessionActivity'

type Props = {
  /**
   * `home` is the phone's first page; `pane` is the tablet's left column,
   * where the open session is shown beside it.
   */
  variant: 'home' | 'pane'
  selectedSessionId?: string | null
  preferencesRequest?: Promise<DesktopUiPreferencesResponse> | null
  /** Starts a new task, in the folder the list suggests (empty: none). */
  onNewTask: (workDir: string) => void
}

/**
 * Header, search, project filter and the status-grouped session list, with
 * the New task button floating over its lower corner: what the phone opens
 * on, and what the tablet keeps on its left.
 */
export function MobileSessionBrowser({ variant, selectedSessionId = null, preferencesRequest = null, onNewTask }: Props) {
  const t = useTranslation()
  const sessions = useSessionStore((state) => state.sessions)
  const isLoading = useSessionStore((state) => state.isLoading)
  const error = useSessionStore((state) => state.error)
  const indexStatus = useSessionStore((state) => state.indexStatus)
  const fetchSessions = useSessionStore((state) => state.fetchSessions)
  const tabs = useTabStore((state) => state.tabs)
  const chatSessions = useChatStore((state) => state.sessions)
  const projectDisplayNameRevision = useProjectDisplayNameRevision()
  const refresh = useSessionListAutoRefresh(
    fetchSessions,
    indexStatus?.mode === 'on' && indexStatus.state === 'building',
  )
  const hiddenProjectKeys = useHiddenProjectKeys(preferencesRequest)
  const live = useLiveSessionActivity()
  const { runningIds, attentionIds } = useMobileSessionStatus(tabs, chatSessions, live)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [projectKey, setProjectKey] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const workspaceLabelFor = useCallback(
    (session: SessionListItem) => getSessionWorkspaceLabel(session, resolveProjectDisplayName),
    // A renamed project must relabel its rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectDisplayNameRevision],
  )
  const visibleSessions = useMemo(
    () => hiddenProjectKeys.size === 0
      ? sessions
      : sessions.filter((session) => !hiddenProjectKeys.has(getSessionProjectKey(session))),
    [hiddenProjectKeys, sessions],
  )
  const projectFilters = useMemo(
    () => listMobileProjectFilters(visibleSessions, workspaceLabelFor),
    [visibleSessions, workspaceLabelFor],
  )
  const effectiveProjectKey = projectKey && projectFilters.some((filter) => filter.key === projectKey)
    ? projectKey
    : null
  const filteredSessions = useMemo(
    () => filterMobileSessions(visibleSessions, { projectKey: effectiveProjectKey, query }),
    [effectiveProjectKey, query, visibleSessions],
  )
  const groups = useMemo(
    () => buildMobileSessionGroups(filteredSessions, runningIds, attentionIds, Date.now()),
    [attentionIds, filteredSessions, runningIds],
  )

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus()
  }, [searchOpen])

  const closeSearch = () => {
    setSearchOpen(false)
    setQuery('')
  }

  const openSettings = () => {
    useTabStore.getState().openTab(SETTINGS_TAB_ID, t('sidebar.settings'), 'settings')
  }

  const filtering = Boolean(query.trim()) || effectiveProjectKey !== null
  const showInitialLoading = isLoading && sessions.length === 0

  return (
    <div
      data-testid={`mobile-session-browser-${variant}`}
      className="relative flex min-h-0 flex-1 flex-col bg-[var(--color-surface)]"
    >
      <header className="flex h-14 shrink-0 items-center gap-1 pl-4 pr-1">
        <h1 className="min-w-0 flex-1 truncate text-[22px] font-semibold leading-tight tracking-tight text-[var(--color-text-primary)]">
          {t('mobile.home.title')}
        </h1>
        <IconButton
          size="2xl"
          tone="secondary"
          icon={searchOpen
            ? <X size={20} strokeWidth={1.75} aria-hidden="true" />
            : <Search size={20} strokeWidth={1.75} aria-hidden="true" />}
          label={searchOpen ? t('mobile.home.closeSearch') : t('mobile.home.openSearch')}
          aria-expanded={searchOpen}
          onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
        />
        <IconButton
          size="2xl"
          tone="secondary"
          icon={<Settings size={20} strokeWidth={1.75} aria-hidden="true" />}
          label={t('sidebar.settings')}
          onClick={openSettings}
        />
      </header>

      {searchOpen ? (
        <div className="shrink-0 px-4 pb-2">
          <SearchField
            ref={searchRef}
            size="xl"
            label={t('mobile.home.openSearch')}
            clearLabel={t('common.clearSearch')}
            placeholder={t('sidebar.searchPlaceholder')}
            value={query}
            onChange={setQuery}
          />
        </div>
      ) : null}

      {projectFilters.length > 1 ? (
        <div
          role="group"
          aria-label={t('mobile.home.projectFilter')}
          className="flex shrink-0 gap-2 overflow-x-auto px-4 pb-2 [scrollbar-width:none]"
        >
          <FilterChip active={effectiveProjectKey === null} onClick={() => setProjectKey(null)}>
            {t('mobile.home.allProjects')}
          </FilterChip>
          {projectFilters.map((filter) => (
            <FilterChip
              key={filter.key}
              active={effectiveProjectKey === filter.key}
              onClick={() => setProjectKey(filter.key)}
            >
              {filter.label}
            </FilterChip>
          ))}
        </div>
      ) : null}

      {/* The bottom padding lets the last row scroll clear of the button. */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-24">
        {showInitialLoading ? (
          <div className="px-4 pt-2"><SkeletonRows count={6} divided label={t('common.loading')} /></div>
        ) : error && sessions.length === 0 ? (
          <ErrorState
            title={t('sidebar.sessionListFailed')}
            retryLabel={t('common.retry')}
            onRetry={() => void refresh()}
          />
        ) : groups.length === 0 ? (
          <EmptyState
            title={filtering
              ? t('mobile.home.noMatches')
              : t(variant === 'home' ? 'mobile.home.empty' : 'mobile.home.emptyPane')}
          />
        ) : (
          <MobileSessionList
            groups={groups}
            runningIds={runningIds}
            attentionIds={attentionIds}
            selectedSessionId={variant === 'pane' ? selectedSessionId : null}
            workspaceLabelFor={workspaceLabelFor}
            onOpen={(session) => openMobileSession(session.id)}
          />
        )}
      </div>

      <button
        type="button"
        data-testid="mobile-new-task"
        onClick={() => onNewTask(resolveNewTaskWorkDir(visibleSessions, effectiveProjectKey))}
        className="absolute bottom-5 right-4 z-[var(--z-raised)] inline-flex h-12 items-center gap-1.5 rounded-[var(--radius-full)] bg-[var(--color-text-primary)] pl-4 pr-5 text-[15px] font-medium text-[var(--color-surface)] shadow-[var(--shadow-overlay)] transition-transform active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-2"
      >
        <Plus size={18} strokeWidth={2} aria-hidden="true" />
        {t('mobile.home.newTask')}
      </button>
    </div>
  )
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`h-9 max-w-[180px] shrink-0 truncate rounded-[var(--radius-full)] border px-3.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${
        active
          ? 'border-[var(--color-text-primary)] bg-[var(--color-text-primary)] text-[var(--color-surface)]'
          : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)]'
      }`}
    >
      {children}
    </button>
  )
}

/**
 * Projects hidden on the desktop stay hidden here. A phone usually starts
 * with an empty cache, so the server's copy decides once it answers.
 */
function useHiddenProjectKeys(
  preferencesRequest: Promise<DesktopUiPreferencesResponse> | null,
): ReadonlySet<string> {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(
    () => new Set(readCachedSidebarProjectPreferences().hiddenProjects),
  )

  useEffect(() => {
    if (!preferencesRequest) return
    let cancelled = false
    void preferencesRequest
      .then((response) => {
        if (cancelled || !response.exists) return
        const preferences = normalizeSidebarProjectPreferences(response.preferences.sidebar)
        setHidden(new Set(preferences.hiddenProjects))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [preferencesRequest])

  return hidden
}
