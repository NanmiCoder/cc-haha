import { Fragment, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { HOME_RETURN_ID, isRootPageTab, useTabStore, type Tab } from '../../stores/tabStore'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useUIStore } from '../../stores/uiStore'
import type { UIMessage } from '../../types/chat'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useCLITaskStore } from '../../stores/cliTaskStore'
import { teamTaskWindowsForSnapshot, useTeamStore } from '../../stores/teamStore'
import { StatusDot } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { useTranslation } from '../../i18n'
import { displaySessionTitle } from '../../lib/sessionTitle'
import { getDesktopHost } from '../../lib/desktopHost'
import { nextAttentionSessionId } from '../../lib/sessionAttention'
import { openDesktopNotificationTarget } from '../../lib/desktopNotificationNavigation'
import { parentTabId, returnToTab } from '../../lib/tabNavigation'
import { useSessionStatus } from '../../hooks/useSessionStatus'
import { SessionAttentionMark } from './SessionAttentionMark'
import { SessionAttentionJump } from './SessionAttentionJump'
import { WindowControls, showWindowControls } from './WindowControls'
import { OpenProjectMenu } from './OpenProjectMenu'
import { WorkspaceLayoutControls } from './WorkspaceLayoutControls'
import { useWorkspaceHeaderHost } from './WorkspaceHeaderContext'
import { getMainSessionActivityModel, hasVisibleSessionActivity } from '../activity/sessionActivityModel'
import { SessionActivityButton } from '../activity/SessionActivityButton'
import { useActivityPanelStore } from '../../stores/activityPanelStore'
import { getSessionBrowsablePath } from '../../lib/sessionWorkspace'
import { runsForSession, useWorkflowStore } from '../../stores/workflowStore'

const desktopHost = getDesktopHost()
const isDesktopRuntime = desktopHost.isDesktop
const EMPTY_DISMISSED_BACKGROUND_TASK_KEYS: readonly string[] = []
const EMPTY_ACTIVITY_MESSAGES: UIMessage[] = []

type Crumb = { id: string; title: string }

/**
 * The window's top row, now that chats are switched from the sidebar rather
 * than a tab strip. It says where you are and holds the controls for it:
 * - a chat: its title (double-click to rename) and whether it is working or
 *   waiting on you;
 * - Settings, the market or scheduled tasks: the page name and a way back to
 *   what was on screen before it;
 * - a subagent, team or member page: the trail back to its chat.
 * On the right sit the jump to sessions waiting on you, the chat's activity,
 * open-project and workspace layout controls, and — while the workspace panel
 * is open — the panel's own resource tabs, portalled into the slot above it.
 *
 * The row is also the window's drag region over the content area; anything
 * clickable in it opts out through the global no-drag rules.
 */
export function AppHeader() {
  const t = useTranslation()
  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const activeTab = tabs.find((tab) => tab.sessionId === activeTabId) ?? null
  const activeSessionId = activeTab?.type === 'session' ? activeTab.sessionId : null
  const sessions = useSessionStore((state) => state.sessions)
  const activeSession = activeSessionId ? sessions.find((session) => session.id === activeSessionId) : undefined
  const { attentionIds, runningIds } = useSessionStatus()

  // The session list's title wins over the tab's copy of it; a server
  // placeholder ("Untitled Session") is shown in the user's language.
  const sessionTitle = (sessionId: string, fallback?: string) =>
    displaySessionTitle(
      sessions.find((session) => session.id === sessionId)?.title,
      displaySessionTitle(fallback, t('tabs.untitled')),
    )

  // Waiting sessions other than the one on screen, in sidebar order (most
  // recent first); ones the list has not loaded go after it.
  const attentionOrder = useMemo(() => {
    const listed = sessions.map((session) => session.id).filter((id) => attentionIds.has(id))
    const listedSet = new Set(listed)
    return [...listed, ...[...attentionIds].filter((id) => !listedSet.has(id))]
  }, [attentionIds, sessions])
  const otherAttentionCount = attentionOrder.filter((sessionId) => sessionId !== activeTabId).length
  const jumpToAttention = () => {
    const next = nextAttentionSessionId(attentionOrder, attentionIds, activeTabId)
    if (next) openDesktopNotificationTarget({ type: 'session', sessionId: next })
  }

  const openProjectPath = activeSessionId ? getSessionBrowsablePath(activeSession) ?? null : null
  const workspaceLayout = useWorkspaceStore((state) =>
    activeSessionId ? state.bySession[activeSessionId]?.layout ?? 'hidden' : 'hidden',
  )
  const isWorkbenchOpen = workspaceLayout !== 'hidden'
  const workspaceHeader = useWorkspaceHeaderHost(activeSessionId)
  const hasWorkspaceHeader = workspaceHeader.available && isWorkbenchOpen
  const isWorkspaceFull = hasWorkspaceHeader && workspaceLayout === 'full'
  const isTerminalPanelOpen = useWorkspaceStore((state) =>
    activeSessionId ? state.bySession[activeSessionId]?.bottomOpen ?? false : false,
  )
  const hasVisibleActivity = useHasVisibleSessionActivity(activeSessionId)
  const showActivityButton = activeSessionId && hasVisibleActivity && !isWorkbenchOpen

  let leading: ReactNode = null
  if (activeTab?.type === 'session' && activeSessionId) {
    leading = (
      // Keyed so a rename half-typed in one chat can never be saved into
      // another one shown in its place.
      <SessionTitle
        key={activeSessionId}
        sessionId={activeSessionId}
        title={sessionTitle(activeSessionId, activeTab.title)}
        needsAttention={attentionIds.has(activeSessionId)}
        isRunning={runningIds.has(activeSessionId)}
        hasError={activeTab.status === 'error'}
      />
    )
  } else if (activeTab && isRootPageTab(activeTab)) {
    // Only the way back: Settings, the market and scheduled tasks each open
    // with their own page head, and a second title here said it twice.
    const returnTo = activeTab.returnTabId === HOME_RETURN_ID
      ? HOME_RETURN_ID
      : tabs.find((tab) => tab.sessionId === activeTab.returnTabId) ??
        (tabs.length > 1 ? tabs[tabs.length - 2] : undefined)
    const backTitle = returnTo === HOME_RETURN_ID
      ? t('sidebar.newSession')
      : returnTo ? tabTitle(returnTo, sessionTitle, t) : null
    leading = backTitle ? (
      <Button
        variant="ghost"
        size="base"
        icon={<ChevronLeft size={14} strokeWidth={1.75} aria-hidden="true" />}
        aria-label={t('header.backTo', { title: backTitle })}
        title={t('header.backTo', { title: backTitle })}
        onClick={() => useTabStore.getState().closeTab(activeTab.sessionId)}
        data-testid="app-header-back"
        className="min-w-0 max-w-[60%] shrink"
      >
        <span className="truncate">{backTitle}</span>
      </Button>
    ) : null
  } else if (activeTab) {
    const trail = buildTrail(activeTab, tabs, (tab) => tabTitle(tab, sessionTitle, t), sessionTitle)
    leading = (
      <nav aria-label={t('header.breadcrumb')} className="flex min-w-0 items-center gap-0.5" data-testid="app-header-breadcrumb">
        {trail.map((crumb, index) => {
          const isCurrent = index === trail.length - 1
          return (
            <Fragment key={crumb.id}>
              {index > 0 ? (
                <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
              ) : null}
              {isCurrent ? (
                <h1 aria-current="page" data-testid="app-header-title" title={crumb.title} className="truncate px-1.5 text-[13px] font-semibold text-[var(--color-text-primary)]">
                  {crumb.title}
                </h1>
              ) : (
                <Button
                  variant="ghost"
                  size="base"
                  onClick={() => returnToTab(crumb.id)}
                  title={crumb.title}
                  className="min-w-0 max-w-[40%] shrink"
                >
                  <span className="truncate">{crumb.title}</span>
                </Button>
              )}
            </Fragment>
          )
        })}
      </nav>
    )
  }

  return (
    <div
      data-testid="app-header"
      data-desktop-drag-region={isDesktopRuntime ? true : undefined}
      // On the sidebar's ground, as the strip was: the workspace's resource
      // tabs in the right half are a trough whose active tab runs into the
      // panel below, and one ground keeps the row from reading as two bands.
      className="flex min-h-[52px] items-stretch bg-[var(--color-surface-sidebar)] select-none"
    >
      <div
        data-testid="workspace-session-header"
        data-desktop-drag-region={isDesktopRuntime ? true : undefined}
        className={`flex min-w-0 items-center gap-1.5 overflow-hidden pl-4 pr-2 ${isWorkspaceFull ? 'max-w-[40%] flex-none' : 'flex-1'}`}
      >
        {leading}
      </div>

      {/*
        Split: the frame is exactly as wide as the panel, so the resource tabs
        sit straight above it. Full: the panel spans the whole row, and sizing
        the frame to it would push the chat's title out of the window; the
        frame takes what the title leaves instead.
      */}
      <div
        data-testid="workspace-header-frame"
        style={hasWorkspaceHeader && !isWorkspaceFull ? { width: workspaceHeader.width, maxWidth: '100%' } : undefined}
        className={`flex min-w-0 items-stretch ${isWorkspaceFull ? 'flex-1' : 'shrink-0'} ${hasWorkspaceHeader ? 'bg-[var(--color-surface-sidebar)]' : ''}`}
      >
        <div
          data-testid="workspace-window-header"
          data-desktop-drag-region={hasWorkspaceHeader && isDesktopRuntime ? true : undefined}
          className={hasWorkspaceHeader
            ? 'flex min-w-0 flex-1 items-center gap-1 pr-2'
            : 'relative flex shrink-0 items-center gap-1 px-2'}
        >
          {hasWorkspaceHeader ? (
            <div
              ref={workspaceHeader.ref}
              data-testid="workspace-header-slot"
              data-desktop-drag-region={isDesktopRuntime ? true : undefined}
              // The slot is titlebar chrome: empty space must drag the window.
              className="flex h-[52px] min-w-0 flex-1"
            />
          ) : null}
          {otherAttentionCount > 0 && (
            <SessionAttentionJump
              count={otherAttentionCount}
              label={t('tabs.jumpToAttention', { count: otherAttentionCount })}
              format={(shown) => t('header.waitingCount', { count: shown })}
              onJump={jumpToAttention}
            />
          )}
          {showActivityButton && activeSessionId && (
            <SessionActivityButton sessionId={activeSessionId} />
          )}
          {isDesktopRuntime && activeSessionId && !isWorkbenchOpen && (
            <OpenProjectMenu path={openProjectPath} />
          )}
          {activeSessionId ? (
            <WorkspaceLayoutControls
              layout={workspaceLayout}
              bottomOpen={isTerminalPanelOpen}
              onToggleFullscreen={() => useWorkspaceStore.getState().toggleFullscreen(activeSessionId)}
              onToggleBottom={() => useWorkspaceStore.getState().toggleBottomPanel(
                activeSessionId,
                getSessionBrowsablePath(activeSession) ?? '',
              )}
              onToggleWorkspace={() => useWorkspaceStore.getState().toggleWorkspace(activeSessionId)}
            />
          ) : null}
        </div>

        {isDesktopRuntime && (
          <div
            data-testid="app-header-drag-gutter"
            data-desktop-drag-region
            aria-hidden="true"
            className={`min-h-[52px] flex-shrink-0 ${showWindowControls ? 'w-3' : 'w-4'}`}
          />
        )}

        <WindowControls />
      </div>
    </div>
  )
}

/**
 * The chat's title, its state, and an in-place rename: double-click the title,
 * Enter or leaving the field saves, Escape keeps the old one.
 */
function SessionTitle({
  sessionId,
  title,
  needsAttention,
  isRunning,
  hasError,
}: {
  sessionId: string
  title: string
  needsAttention: boolean
  isRunning: boolean
  hasError: boolean
}) {
  const t = useTranslation()
  const [draft, setDraft] = useState<string | null>(null)
  const committingRef = useRef(false)

  const commit = async () => {
    if (draft === null || committingRef.current) return
    const next = draft.trim()
    setDraft(null)
    if (!next || next === title) return
    committingRef.current = true
    try {
      await useSessionStore.getState().renameSession(sessionId, next)
    } catch (error) {
      useUIStore.getState().addToast({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      committingRef.current = false
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void commit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setDraft(null)
    }
  }

  // Waiting on the user outranks running: a session parked on a permission
  // card is also "running" by `chatState`, and a running dot there would say
  // the one thing that is not true of it.
  const status = needsAttention
    ? <SessionAttentionMark label={t('sidebar.sessionNeedsAttention')} />
    : isRunning
      ? <StatusDot tone="info" pulse label={t('tabs.sessionRunning')} />
      : hasError
        ? <StatusDot tone="danger" label={t('header.sessionFailed')} />
        : null

  return (
    <div
      data-testid="app-header-session"
      data-attention={needsAttention ? 'true' : 'false'}
      className="flex min-w-0 items-center gap-2"
    >
      {status ? <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center">{status}</span> : null}
      {draft !== null ? (
        <input
          autoFocus
          value={draft}
          aria-label={t('header.renameSession')}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={onKeyDown}
          onFocus={(event) => event.currentTarget.select()}
          className="h-7 min-w-[160px] max-w-full rounded-[var(--radius-sm)] border border-[var(--color-border-focus)] bg-[var(--color-surface)] px-2 text-[13px] font-semibold text-[var(--color-text-primary)] outline-none"
        />
      ) : (
        // The page's one heading: the conversation below no longer repeats it.
        // No-drag: inside the window's drag region a double-click would zoom
        // the window instead of reaching the title. Focusable, so Enter or F2
        // renames without a mouse; the hover text keeps the full title, which
        // the row truncates.
        <h1
          data-testid="app-header-title"
          tabIndex={0}
          title={`${title}\n${t('header.renameHint')}`}
          onDoubleClick={() => setDraft(title)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === 'F2') {
              event.preventDefault()
              setDraft(title)
            }
          }}
          className="tab-bar-interactive truncate rounded-[var(--radius-xs)] text-[13px] font-semibold text-[var(--color-text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
        >
          {title}
        </h1>
      )}
    </div>
  )
}

function tabTitle(
  tab: Tab,
  sessionTitle: (sessionId: string, fallback?: string) => string,
  t: ReturnType<typeof useTranslation>,
): string {
  switch (tab.type) {
    case 'session':
      return sessionTitle(tab.sessionId, tab.title)
    case 'settings':
      return t('settings.title')
    case 'scheduled':
      return t('sidebar.scheduled')
    case 'market':
    case 'connectors':
      return t('sidebar.extensions')
    case 'team':
      // The workbench below names the team; the trail names the surface.
      return 'Agent Teams'
    default:
      return tab.title || t('tabs.untitled')
  }
}

/**
 * The pages from the chat up to `tab`, following each page back to where it
 * was opened. A trail whose next page has since closed ends at the chat the
 * page belongs to.
 */
function buildTrail(
  tab: Tab,
  tabs: readonly Tab[],
  titleOf: (tab: Tab) => string,
  sessionTitle: (sessionId: string) => string,
): Crumb[] {
  const trail: Crumb[] = []
  const seen = new Set<string>()
  let current: Tab | undefined = tab
  while (current && !seen.has(current.sessionId)) {
    seen.add(current.sessionId)
    trail.unshift({ id: current.sessionId, title: titleOf(current) })
    if (current.type === 'session') return trail
    const parentId = parentTabId(current)
    const parent: Tab | undefined = parentId ? tabs.find((candidate) => candidate.sessionId === parentId) : undefined
    if (!parent) {
      const sessionId = current.sourceSessionId ?? current.teamLeadSessionId
      if (sessionId && !seen.has(sessionId)) trail.unshift({ id: sessionId, title: sessionTitle(sessionId) })
      return trail
    }
    current = parent
  }
  return trail
}

/**
 * Whether the chat on screen has anything for the activity panel to show.
 * Selects the session's inputs, not the model: a selector runs on every store
 * update of every session, and the model walks the whole transcript. Deriving
 * it inside one cost a full pass per streamed token of any background session
 * (#1480).
 */
function useHasVisibleSessionActivity(activitySessionId: string | null): boolean {
  const cliTasks = useCLITaskStore((state) => state.tasks)
  const cliTasksSessionId = useCLITaskStore((state) => state.sessionId)
  const cliTasksCompletedAndDismissed = useCLITaskStore((state) => state.completedAndDismissed)
  const agentTeamsSnapshot = useTeamStore((state) => activitySessionId
    ? state.workbenchesBySession[activitySessionId]?.snapshots.at(-1)
    : undefined)
  const activeTeamStartedAt = useTeamStore((state) => activitySessionId
    ? state.activeTeamStartedAtBySession[activitySessionId]
    : undefined)
  const allWorkflowRuns = useWorkflowStore((state) => state.runs)
  const workflowRuns = useMemo(
    () => activitySessionId ? runsForSession({ runs: allWorkflowRuns }, activitySessionId) : [],
    [activitySessionId, allWorkflowRuns],
  )
  const dismissedBackgroundTaskKeyList = useActivityPanelStore((state) =>
    activitySessionId
      ? state.dismissedBackgroundTaskKeysBySession[activitySessionId] ?? EMPTY_DISMISSED_BACKGROUND_TASK_KEYS
      : EMPTY_DISMISSED_BACKGROUND_TASK_KEYS,
  )
  const dismissedBackgroundTaskKeys = useMemo(
    () => new Set(dismissedBackgroundTaskKeyList),
    [dismissedBackgroundTaskKeyList],
  )
  const activityMessages = useChatStore((state) =>
    activitySessionId ? state.sessions[activitySessionId]?.messages ?? EMPTY_ACTIVITY_MESSAGES : EMPTY_ACTIVITY_MESSAGES)
  const activityTurnActive = useChatStore((state) => {
    const sessionState = activitySessionId ? state.sessions[activitySessionId] : undefined
    return Boolean(sessionState && sessionState.chatState !== 'idle')
  })
  const activityBackgroundTaskRecord = useChatStore((state) =>
    activitySessionId ? state.sessions[activitySessionId]?.backgroundAgentTasks : undefined)
  const activityNotificationRecord = useChatStore((state) =>
    activitySessionId ? state.sessions[activitySessionId]?.agentTaskNotifications : undefined)
  return useMemo(() => {
    if (!activitySessionId) return false
    const includeCliTasks = cliTasksSessionId === activitySessionId
    return hasVisibleSessionActivity(getMainSessionActivityModel({
      sessionId: activitySessionId,
      messages: activityMessages,
      tasks: includeCliTasks ? cliTasks : [],
      teamTaskWindows: teamTaskWindowsForSnapshot(agentTeamsSnapshot, activeTeamStartedAt),
      completedAndDismissed: includeCliTasks ? cliTasksCompletedAndDismissed : false,
      isForegroundTurnActive: activityTurnActive,
      backgroundTasks: Object.values(activityBackgroundTaskRecord ?? {}),
      dismissedBackgroundTaskKeys,
      agentNotifications: Object.values(activityNotificationRecord ?? {}),
      workflowRuns,
    }))
  }, [
    activeTeamStartedAt,
    activityBackgroundTaskRecord,
    activityMessages,
    activityNotificationRecord,
    activitySessionId,
    activityTurnActive,
    agentTeamsSnapshot,
    cliTasks,
    cliTasksCompletedAndDismissed,
    cliTasksSessionId,
    dismissedBackgroundTaskKeys,
    workflowRuns,
  ])
}
