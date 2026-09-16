import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { GitFork, Target } from 'lucide-react'
import {
  SCHEDULED_TAB_ID,
  SETTINGS_TAB_ID,
  TEAM_TAB_PREFIX,
  TERMINAL_TAB_PREFIX,
  TRACE_TAB_PREFIX,
  WORKBENCH_TAB_PREFIX,
  useTabStore,
  type TabType,
} from '../stores/tabStore'
import { useSessionStore } from '../stores/sessionStore'
import { useChatStore } from '../stores/chatStore'
import { useCLITaskStore } from '../stores/cliTaskStore'
import { teamTaskWindowsForSnapshot, useTeamStore } from '../stores/teamStore'
import {
  WORKSPACE_BOTTOM_DEFAULT_HEIGHT,
  WORKSPACE_BOTTOM_MAX_HEIGHT,
  WORKSPACE_BOTTOM_MIN_HEIGHT,
  useWorkspaceStore,
} from '../stores/workspaceStore'
import { useWorkspaceContentStore } from '../stores/workspaceContentStore'
import { useTranslation } from '../i18n'
import { LoadingState } from '@/components/ui/LoadingState'
import { Tooltip } from '@/components/ui/Tooltip'
import { BrandSeal } from '@/components/composite/BrandSeal'
import { MessageList } from '../components/chat/MessageList'
import { ChatInput } from '../components/chat/ChatInput'
import {
  SessionChatHeader,
  SessionChatSurface,
  type SessionHeaderMetaItem,
} from '@/components/chat/SessionChatSurface'
import { getWorktreeDisplayName, WorktreeDetails } from '../components/chat/WorktreeDetails'
import {
  WorkspaceSurface,
  useWorkspaceBrowserEventBridge,
} from '../components/workbench/WorkspaceSurface'
import { AgentTeamsStrip } from '../components/agentTeams/AgentTeamsSummary'
import { snapshotWithHistoricalMembers } from '../components/agentTeams/agentTeamsModel'
import {
  SessionActivityPanel,
  type OpenSubagentPayload,
} from '../components/activity/SessionActivityPanel'
import { buildMainSessionActivityModel, hasVisibleSessionActivity } from '../components/activity/sessionActivityModel'
import { runsForSession, useWorkflowStore } from '../stores/workflowStore'
import type { SessionListItem } from '../types/session'
import type { ActiveGoalState, TokenUsage } from '../types/chat'
import type { TeamMember } from '../types/team'
import { useWorkspaceAdaptiveLayout } from '@/hooks/useWorkspaceAdaptiveLayout'
import { useMobileViewport } from '../hooks/useMobileViewport'
import { useWorkspaceShortcuts } from '../hooks/useWorkspaceShortcuts'
import { useWorkspaceFocusReturn } from '../hooks/useWorkspaceFocusReturn'
import { isDesktopRuntime } from '../lib/desktopRuntime'
import { formatTokenCount } from '../lib/formatTokenCount'
import {
  createBackgroundTaskDismissKey,
  hasRunningBackgroundTasks as hasAnyRunningBackgroundTasks,
} from '../lib/backgroundTasks'
import { useActivityPanelStore } from '../stores/activityPanelStore'
import { getSessionBrowsablePath, getSessionWorkspaceState } from '../lib/sessionWorkspace'
import type { AgentTaskNotification, UIMessage } from '../types/chat'
import { sessionsApi, type SessionGitInfo } from '../api/sessions'

/**
 * Stable fallbacks for optional session state. A `?? []` / `?? {}` literal allocates a
 * fresh value on every render, and both of these feed the `activityModel` dependency
 * array below — so an idle session with no messages or no agent notifications rebuilt
 * the whole activity model on every render. 29586ce38 fixed exactly this in
 * MessageList.tsx; the same pattern was still here.
 */
const EMPTY_MESSAGES: UIMessage[] = []
const EMPTY_AGENT_TASK_NOTIFICATIONS: Record<string, AgentTaskNotification> = {}

const TASK_POLL_INTERVAL_MS = 1000
const ACTIVITY_AUTOCLOSE_GRACE_MS = 2000
const WORKSPACE_RESIZE_STEP = 32
const TERMINAL_RESIZE_STEP = 24
const EMPTY_DISMISSED_BACKGROUND_TASK_KEYS: readonly string[] = []

function isSessionTabState(activeTabId: string | null, activeTabType: TabType | null | undefined) {
  if (!activeTabId) return false
  if (activeTabType === 'session') return true
  if (activeTabType) return false
  return activeTabId !== SETTINGS_TAB_ID &&
    activeTabId !== SCHEDULED_TAB_ID &&
    !activeTabId.startsWith(TERMINAL_TAB_PREFIX) &&
    !activeTabId.startsWith(TRACE_TAB_PREFIX) &&
    !activeTabId.startsWith(WORKBENCH_TAB_PREFIX) &&
    !activeTabId.startsWith(TEAM_TAB_PREFIX)
}

function getTokenUsageTotal(usage: TokenUsage): number {
  return (
    usage.input_tokens +
    usage.output_tokens +
    (usage.cache_read_tokens ?? 0) +
    (usage.cache_creation_tokens ?? 0)
  )
}

function getSessionTerminalCwd(session: SessionListItem | undefined) {
  return getSessionBrowsablePath(session)
}

function ActiveGoalStrip({
  goal,
  isRunning,
  compact,
}: {
  goal: ActiveGoalState | null | undefined
  isRunning: boolean
  compact: boolean
}) {
  const t = useTranslation()
  if (!goal || goal.action === 'completed') return null

  const objective = goal.objective ?? goal.message
  if (!objective) return null

  const statusLabel = isRunning
    ? t('chat.activeGoal.running')
    : goal.status === 'paused'
      ? t('chat.activeGoal.paused')
      : t('chat.activeGoal.active')
  const meta = [
    goal.budget ? t('chat.activeGoal.budget', { value: goal.budget }) : null,
    goal.elapsed ? t('chat.activeGoal.elapsed', { value: goal.elapsed }) : null,
    goal.continuations ? t('chat.activeGoal.continuations', { value: goal.continuations }) : null,
  ].filter((value): value is string => value !== null)

  return (
    <div
      data-testid="active-goal-strip"
      className={[
        'mt-2 flex max-w-full items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-memory-border)] bg-[var(--color-memory-surface)] px-2.5 py-1.5',
        compact ? 'text-[11px]' : 'text-[12px]',
      ].join(' ')}
    >
      <Target size={compact ? 13 : 14} className="shrink-0 text-[var(--color-memory-accent)]" strokeWidth={2.25} aria-hidden="true" />
      <span className="shrink-0 font-semibold text-[var(--color-text-primary)]">
        {t('chat.activeGoal.title')}
      </span>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-memory-accent)]" aria-hidden="true" />
      <span className="shrink-0 text-[var(--color-text-tertiary)]">{statusLabel}</span>
      <span className="min-w-0 flex-1 truncate font-medium text-[var(--color-text-primary)]" title={objective}>
        {objective}
      </span>
      {meta.length > 0 ? (
        <span className="hidden shrink-0 items-center gap-1.5 text-[11px] text-[var(--color-text-tertiary)] lg:flex">
          {meta.map((item) => (
            <span key={item} className="max-w-[140px] truncate">{item}</span>
          ))}
        </span>
      ) : null}
    </div>
  )
}

function getRenderedWorkspacePanelWidth(panelRef: RefObject<HTMLElement>, fallbackWidth: number) {
  const renderedWidth = panelRef.current?.getBoundingClientRect().width ?? 0
  return Number.isFinite(renderedWidth) && renderedWidth > 0
    ? renderedWidth
    : fallbackWidth
}

function WorkspaceResizeHandle({ panelRef }: { panelRef: RefObject<HTMLElement> }) {
  const t = useTranslation()
  const width = useWorkspaceStore((state) => state.sideWidth)
  const setWidth = useWorkspaceStore((state) => state.setSideWidth)
  const [dragState, setDragState] = useState<{ startX: number; startWidth: number } | null>(null)
  const dragStateRef = useRef(dragState)

  useEffect(() => {
    dragStateRef.current = dragState
  }, [dragState])

  useEffect(() => {
    if (!dragState) return

    const handlePointerMove = (event: PointerEvent) => {
      const current = dragStateRef.current
      if (!current) return
      setWidth(current.startWidth + current.startX - event.clientX)
    }

    const handlePointerUp = () => {
      setDragState(null)
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)

    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [dragState, setWidth])

  return (
    <div
      role="separator"
      aria-label={t('workspace.resizePanel')}
      aria-orientation="vertical"
      aria-valuenow={width}
      tabIndex={0}
      data-testid="workspace-resize-handle"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        setDragState({ startX: event.clientX, startWidth: getRenderedWorkspacePanelWidth(panelRef, width) })
      }}
      onKeyDown={(event) => {
        const renderedWidth = getRenderedWorkspacePanelWidth(panelRef, width)
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          setWidth(renderedWidth + WORKSPACE_RESIZE_STEP)
        }
        if (event.key === 'ArrowRight') {
          event.preventDefault()
          setWidth(renderedWidth - WORKSPACE_RESIZE_STEP)
        }
      }}
      className="relative z-10 w-px shrink-0 cursor-col-resize bg-[var(--color-border)] outline-none transition-colors hover:bg-[var(--color-border-focus)] focus-visible:bg-[var(--color-border-focus)]"
    >
      <div aria-hidden="true" className="absolute -inset-x-1 inset-y-0" />
    </div>
  )
}

function TerminalResizeHandle() {
  const t = useTranslation()
  const height = useWorkspaceStore((state) => state.bottomHeight)
  const setHeight = useWorkspaceStore((state) => state.setBottomHeight)
  const [dragState, setDragState] = useState<{ startY: number; startHeight: number } | null>(null)
  const dragStateRef = useRef(dragState)

  useEffect(() => {
    dragStateRef.current = dragState
  }, [dragState])

  useEffect(() => {
    if (!dragState) return

    const handlePointerMove = (event: PointerEvent) => {
      const current = dragStateRef.current
      if (!current) return
      setHeight(current.startHeight + current.startY - event.clientY)
    }

    const handlePointerUp = () => {
      setDragState(null)
    }

    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)

    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [dragState, setHeight])

  return (
    <div
      role="separator"
      aria-label={t('terminal.resizePanel')}
      aria-orientation="horizontal"
      aria-valuemin={WORKSPACE_BOTTOM_MIN_HEIGHT}
      aria-valuemax={WORKSPACE_BOTTOM_MAX_HEIGHT}
      aria-valuenow={height}
      tabIndex={0}
      data-testid="terminal-resize-handle"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        setDragState({ startY: event.clientY, startHeight: height })
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setHeight(height + TERMINAL_RESIZE_STEP)
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setHeight(height - TERMINAL_RESIZE_STEP)
        }
        if (event.key === 'Home') {
          event.preventDefault()
          setHeight(WORKSPACE_BOTTOM_MIN_HEIGHT)
        }
        if (event.key === 'End') {
          event.preventDefault()
          setHeight(WORKSPACE_BOTTOM_MAX_HEIGHT)
        }
      }}
      onDoubleClick={() => setHeight(WORKSPACE_BOTTOM_DEFAULT_HEIGHT)}
      className="group absolute inset-x-0 -top-1 z-[var(--z-raised)] flex h-2 cursor-row-resize items-center bg-transparent outline-none"
    >
      <div className="h-px flex-1 bg-transparent transition-colors group-hover:bg-[var(--color-border-focus)] group-focus-visible:bg-[var(--color-border-focus)]" />
    </div>
  )
}

export function ActiveSession() {
  const isMobileLayout = useMobileViewport() && !isDesktopRuntime()
  const workbenchPanelRef = useRef<HTMLElement>(null)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const activeTabType = useTabStore((s) => s.tabs.find((tab) => tab.sessionId === s.activeTabId)?.type ?? null)
  const sessions = useSessionStore((s) => s.sessions)
  const connectToSession = useChatStore((s) => s.connectToSession)
  const stopBackgroundTask = useChatStore((s) => s.stopBackgroundTask)
  const sessionState = useChatStore((s) => activeTabId ? s.sessions[activeTabId] : undefined)
  const fetchSessionTasks = useCLITaskStore((s) => s.fetchSessionTasks)
  const trackedTaskSessionId = useCLITaskStore((s) => s.sessionId)
  const cliTasks = useCLITaskStore((s) => s.tasks)
  const cliTasksCompletedAndDismissed = useCLITaskStore((s) => s.completedAndDismissed)
  const hasIncompleteTasks = cliTasks.some((task) => task.status !== 'completed')
  const isActivityPanelOpen = useActivityPanelStore((state) => activeTabId ? state.isOpen(activeTabId) : false)
  const openActivityPanel = useActivityPanelStore((state) => state.open)
  const closeActivityPanel = useActivityPanelStore((state) => state.close)
  const dismissBackgroundTaskKeys = useActivityPanelStore((state) => state.dismissBackgroundTaskKeys)
  const pruneDismissedBackgroundTaskKeys = useActivityPanelStore((state) => state.pruneDismissedBackgroundTaskKeys)
  const dismissedBackgroundTaskKeyList = useActivityPanelStore((state) =>
    activeTabId
      ? state.dismissedBackgroundTaskKeysBySession[activeTabId] ?? EMPTY_DISMISSED_BACKGROUND_TASK_KEYS
      : EMPTY_DISMISSED_BACKGROUND_TASK_KEYS,
  )
  const chatState = sessionState?.chatState ?? 'idle'
  const tokenUsage = sessionState?.tokenUsage ?? { input_tokens: 0, output_tokens: 0 }
  const hasRunningBackgroundTasks = hasAnyRunningBackgroundTasks(sessionState?.backgroundAgentTasks)
  const stoppingBackgroundTaskIds = sessionState?.stoppingBackgroundTaskIds

  const session = sessions.find((s) => s.id === activeTabId)
  const sessionMessageCount = Math.max(
    sessionState?.messages.length ?? 0,
    session?.messageCount ?? 0,
  )
  const sessionSlashCommandCount = sessionState?.slashCommands.length ?? 0
  const agentTeamsSnapshots = useTeamStore((s) => activeTabId
    ? s.workbenchesBySession[activeTabId]?.snapshots
    : undefined)
  const agentTeamsSnapshot = useMemo(() => (
    agentTeamsSnapshots?.length
      ? snapshotWithHistoricalMembers(agentTeamsSnapshots, agentTeamsSnapshots.length - 1)
      : undefined
  ), [agentTeamsSnapshots])
  const activeTeamStartedAt = useTeamStore((s) => activeTabId
    ? s.activeTeamStartedAtBySession[activeTabId]
    : undefined)
  const fetchTeamForSession = useTeamStore((s) => s.fetchTeamForSession)
  const [sessionGitInfo, setSessionGitInfo] = useState<{
    sessionId: string
    info: SessionGitInfo
  } | null>(null)
  const workspaceEnabled = Boolean(activeTabId) &&
    isSessionTabState(activeTabId, activeTabType) &&
    !isMobileLayout
  const workspaceLayout = useWorkspaceStore((state) =>
    workspaceEnabled && activeTabId ? state.bySession[activeTabId]?.layout ?? 'hidden' : 'hidden',
  )
  const showWorkbench = workspaceLayout !== 'hidden'
  const showRightPanel = showWorkbench
  // `full` still renders the same panel; the chat column is what gives way, so
  // no tab is recreated and no page or PTY restarts on the way in or out.
  const compactWorkspace = useWorkspaceAdaptiveLayout(workbenchPanelRef, showWorkbench)
  const isWorkspaceFull = workspaceLayout === 'full' || compactWorkspace
  const rightPanelWidth = useWorkspaceStore((state) => state.sideWidth)
  const showTerminalPanel = useWorkspaceStore((state) =>
    workspaceEnabled && activeTabId ? state.bySession[activeTabId]?.bottomOpen ?? false : false,
  )
  const hasBottomTerminals = useWorkspaceStore((state) =>
    workspaceEnabled && activeTabId
      ? (state.bySession[activeTabId]?.tabs ?? []).some((tab) => tab.dock === 'bottom')
      : false,
  )
  const terminalPanelHeight = useWorkspaceStore((state) => state.bottomHeight)
  const workspaceIsGitRepo = useWorkspaceContentStore((state) =>
    activeTabId ? state.statusBySession[activeTabId]?.isGitRepo : undefined,
  )
  const activityVisibilityBySessionRef = useRef<Record<string, { hadAutoOpenActivity: boolean }>>({})

  useEffect(() => {
    if (activeTabId) {
      connectToSession(activeTabId)
      void fetchTeamForSession(activeTabId)
    }
  }, [activeTabId, connectToSession, fetchTeamForSession])

  useEffect(() => {
    if (!activeTabId || !isSessionTabState(activeTabId, activeTabType)) return
    void useWorkspaceContentStore.getState().loadStatus(activeTabId)
  }, [activeTabId, activeTabType])

  // Subscribed once for the app, not per task: the owner of each event is
  // resolved from the page id, so a background task's pages keep reporting.
  useWorkspaceBrowserEventBridge(!isMobileLayout)
  useWorkspaceFocusReturn(workspaceEnabled ? activeTabId : null)
  useWorkspaceShortcuts({
    sessionId: activeTabId,
    cwd: getSessionTerminalCwd(session) ?? '',
    enabled: workspaceEnabled,
  })

  useEffect(() => {
    if (!activeTabId || !isSessionTabState(activeTabId, activeTabType)) return

    let cancelled = false
    setSessionGitInfo((current) => current?.sessionId === activeTabId ? null : current)
    void sessionsApi.getGitInfo(activeTabId)
      .then((info) => {
        if (!cancelled && info.worktree?.enabled) {
          setSessionGitInfo({ sessionId: activeTabId, info })
        }
      })
      .catch(() => {
        // Git metadata is supplementary; the session remains usable without it.
      })

    return () => {
      cancelled = true
    }
  }, [activeTabId, activeTabType])

  useEffect(() => {
    if (
      !activeTabId ||
      !isSessionTabState(activeTabId, activeTabType) ||
      sessionMessageCount === 0
    ) return

    let cancelled = false
    const timeout = setTimeout(() => {
      void sessionsApi.getGitInfo(activeTabId)
        .then((info) => {
          if (cancelled) return
          setSessionGitInfo(info.worktree?.enabled
            ? { sessionId: activeTabId, info }
            : null)
        })
        .catch(() => {
          // Keep the last useful snapshot when supplementary Git metadata cannot refresh.
        })
    }, chatState === 'idle' ? 0 : 500)

    return () => {
      cancelled = true
      clearTimeout(timeout)
    }
  }, [
    activeTabId,
    activeTabType,
    chatState,
    sessionMessageCount,
    sessionSlashCommandCount,
  ])

  useEffect(() => {
    if (!activeTabId) return

    const shouldPollTasks =
      chatState !== 'idle' ||
      (trackedTaskSessionId === activeTabId && hasIncompleteTasks)

    if (!shouldPollTasks) return

    void fetchSessionTasks(activeTabId)

    const timer = setInterval(() => {
      void fetchSessionTasks(activeTabId)
    }, TASK_POLL_INTERVAL_MS)

    return () => clearInterval(timer)
  }, [
    activeTabId,
    chatState,
    trackedTaskSessionId,
    hasIncompleteTasks,
    fetchSessionTasks,
  ])

  const t = useTranslation()
  const messages = sessionState?.messages ?? EMPTY_MESSAGES
  const streamingText = sessionState?.streamingText ?? ''
  const isPreparingTurn = Boolean(sessionState?.isPreparingTurn)
  const backgroundTasks = useMemo(
    () => Object.values(sessionState?.backgroundAgentTasks ?? {}),
    [sessionState?.backgroundAgentTasks],
  )
  const dismissedBackgroundTaskKeys = useMemo(
    () => new Set(dismissedBackgroundTaskKeyList),
    [dismissedBackgroundTaskKeyList],
  )
  const agentTaskNotifications = sessionState?.agentTaskNotifications ?? EMPTY_AGENT_TASK_NOTIFICATIONS
  // Subscribe to the stable `runs` record and derive the per-session list here:
  // a selector that filtered would allocate a new array on every store read,
  // which zustand compares by identity and would re-render forever.
  const allWorkflowRuns = useWorkflowStore(state => state.runs)
  const workflowRuns = useMemo(
    () => (activeTabId ? runsForSession({ runs: allWorkflowRuns }, activeTabId) : []),
    [allWorkflowRuns, activeTabId],
  )
  const activeGoal = sessionState?.activeGoal ?? null
  const isEmpty =
    messages.length === 0 &&
    !streamingText &&
    !isPreparingTurn &&
    (session?.messageCount ?? 0) === 0
  const compactEmptyHero = isEmpty && showTerminalPanel
  const isHistoryLoading =
    (session?.messageCount ?? 0) > 0 &&
    messages.length === 0 &&
    sessionState?.historyStatus === 'loading'
  const historyError =
    (session?.messageCount ?? 0) > 0 &&
    messages.length === 0 &&
    sessionState?.historyStatus === 'error'
      ? sessionState.historyError || t('session.historyLoadFailed')
      : null
  const visibleMessageCount = messages.length > 0 ? messages.length : session?.messageCount ?? 0
  const headerTitle = session?.title || t('session.untitled')
  const currentGitInfo = sessionGitInfo?.sessionId === activeTabId ? sessionGitInfo.info : null
  const worktree = currentGitInfo?.worktree?.enabled ? currentGitInfo.worktree : null
  const worktreePath = worktree?.path || worktree?.plannedPath || null
  const worktreeName = getWorktreeDisplayName(worktree?.slug, worktreePath)

  const isActive = isPreparingTurn || chatState !== 'idle' || hasRunningBackgroundTasks
  const totalTokens = getTokenUsageTotal(tokenUsage)
  const cacheReadTokens = tokenUsage.cache_read_tokens ?? 0
  const cacheCreationTokens = tokenUsage.cache_creation_tokens ?? 0
  const cachedTokens = cacheReadTokens + cacheCreationTokens
  useEffect(() => {
    if (!activeTabId) return
    pruneDismissedBackgroundTaskKeys(
      activeTabId,
      backgroundTasks.map((task) => createBackgroundTaskDismissKey(task)),
    )
  }, [activeTabId, backgroundTasks, pruneDismissedBackgroundTaskKeys])

  const activityModel = useMemo(() => {
    if (!activeTabId) return null
    const includeCliTasks = trackedTaskSessionId === activeTabId
    const teamTaskWindows = teamTaskWindowsForSnapshot(agentTeamsSnapshot, activeTeamStartedAt)

    return buildMainSessionActivityModel({
      sessionId: activeTabId,
      messages,
      // cliTaskStore is explicitly loaded from the session-id list, so these
      // remain the lead's own tasks. AgentTeam's shared DAG, roster and launch
      // rows live in its strip/workbench, while member-internal activity stays
      // isolated by run ownership.
      tasks: includeCliTasks ? cliTasks : [],
      teamTaskWindows,
      completedAndDismissed: includeCliTasks ? cliTasksCompletedAndDismissed : false,
      isForegroundTurnActive: chatState !== 'idle',
      backgroundTasks,
      dismissedBackgroundTaskKeys,
      agentNotifications: Object.values(agentTaskNotifications),
      workflowRuns,
    })
  }, [
    activeTabId,
    activeTeamStartedAt,
    agentTeamsSnapshot,
    agentTaskNotifications,
    backgroundTasks,
    cliTasks,
    cliTasksCompletedAndDismissed,
    chatState,
    dismissedBackgroundTaskKeys,
    messages,
    trackedTaskSessionId,
    workflowRuns,
  ])
  const hasVisibleActivity = activityModel ? hasVisibleSessionActivity(activityModel) : false
  const hasAutoOpenActivity = activityModel ? activityModel.badgeCount > 0 : false

  useEffect(() => {
    if (!activeTabId || !isSessionTabState(activeTabId, activeTabType)) return

    const state = activityVisibilityBySessionRef.current[activeTabId]
    if (!state) {
      activityVisibilityBySessionRef.current[activeTabId] = {
        hadAutoOpenActivity: hasAutoOpenActivity,
      }
      return
    }

    if (!state.hadAutoOpenActivity && hasAutoOpenActivity && !isActivityPanelOpen) {
      openActivityPanel(activeTabId)
    }
    state.hadAutoOpenActivity = hasAutoOpenActivity
  }, [
    activeTabId,
    activeTabType,
    hasAutoOpenActivity,
    isActivityPanelOpen,
    openActivityPanel,
  ])

  useEffect(() => {
    if (!activeTabId || !isActivityPanelOpen || hasVisibleActivity) return
    // Activity rows derive from volatile caches that are briefly empty during
    // history loads, cli-task refetches and reconnect reloads. Closing the
    // panel on the first empty beat made that flicker permanent (auto-open
    // does not re-fire after a remount), so only close once the empty state
    // survives a full history-ready grace period.
    if (sessionState?.historyStatus === 'loading') return
    const timer = setTimeout(() => {
      const current = useChatStore.getState().sessions[activeTabId]
      if (current?.historyStatus === 'loading') return
      closeActivityPanel(activeTabId)
    }, ACTIVITY_AUTOCLOSE_GRACE_MS)
    return () => clearTimeout(timer)
  }, [activeTabId, closeActivityPanel, hasVisibleActivity, isActivityPanelOpen, sessionState?.historyStatus])

  useEffect(() => {
    if (!activeTabId || !showRightPanel || !isActivityPanelOpen) return
    closeActivityPanel(activeTabId)
  }, [activeTabId, closeActivityPanel, isActivityPanelOpen, showRightPanel])

  const handleOpenSubagentRun = useCallback((payload: OpenSubagentPayload) => {
    if (
      payload.teamName &&
      payload.teamMemberName &&
      payload.teamStartedAt !== undefined
    ) {
      void useTeamStore.getState().openMemberFromActivity(
        payload.sessionId,
        payload.teamName,
        payload.teamMemberName,
        payload.teamStartedAt,
      )
      return
    }

    const targetSessionId = useTabStore.getState().openSubagentTab(
      payload.sessionId,
      payload.toolUseId,
      payload.title,
      payload.taskId,
    )
    useActivityPanelStore.getState().open(targetSessionId)
  }, [])
  const handleOpenTeamMember = useCallback((member: TeamMember) => {
    useTeamStore.getState().openMemberSession(member)
  }, [])
  const handleClearFinishedBackgroundTasks = useCallback((taskKeys: string[]) => {
    if (!activeTabId || taskKeys.length === 0) return
    dismissBackgroundTaskKeys(activeTabId, taskKeys)
  }, [activeTabId, dismissBackgroundTaskKeys])
  const handleStopBackgroundTask = useCallback((taskId: string) => {
    if (!activeTabId) return
    stopBackgroundTask(activeTabId, taskId)
  }, [activeTabId, stopBackgroundTask])

  const lastUpdated = useMemo(() => {
    if (!session?.modifiedAt) return ''
    const diff = Date.now() - new Date(session.modifiedAt).getTime()
    if (diff < 60000) return t('session.timeJustNow')
    if (diff < 3600000) return t('session.timeMinutes', { n: Math.floor(diff / 60000) })
    if (diff < 86400000) return t('session.timeHours', { n: Math.floor(diff / 3600000) })
    return t('session.timeDays', { n: Math.floor(diff / 86400000) })
  }, [session?.modifiedAt, t])

  if (!activeTabId) return null

  // The activity rail is an absolutely positioned overlay, so it no longer
  // squeezes the column by itself — the column yields with padding instead.
  const showActivityRail = Boolean(activityModel) &&
    hasVisibleActivity &&
    !showRightPanel &&
    !isMobileLayout &&
    isSessionTabState(activeTabId, activeTabType)
  const isActivityRailOpen = showActivityRail && isActivityPanelOpen
  const headerMetadataCandidates: Array<SessionHeaderMetaItem | null> = [
    isActive
      ? {
          key: 'active',
          content: (
            <span className="flex shrink-0 items-center gap-1.5 text-[var(--color-text-secondary)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-success)] animate-pulse-dot" />
              {t('session.active')}
            </span>
          ),
        }
      : null,
    worktreeName
      ? {
          key: 'worktree',
          content: (
            <Tooltip
              placement="bottom-start"
              content={<WorktreeDetails name={worktreeName} path={worktreePath} />}
            >
              <span
                data-testid="session-worktree-indicator"
                tabIndex={0}
                className="flex min-w-0 max-w-[260px] shrink cursor-help items-center gap-1 rounded-[4px] text-[var(--color-text-secondary)] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]"
              >
                <GitFork size={11} className="shrink-0 text-[var(--color-brand)]" aria-hidden="true" />
                <span className="shrink-0 capitalize">{t('sidebar.worktree')}:</span>
                <span className="min-w-0 truncate font-medium">{worktreeName}</span>
              </span>
            </Tooltip>
          ),
        }
      : null,
    totalTokens > 0
      ? {
          key: 'tokens',
          content: (
            <span
              className="shrink-0"
              title={t('session.apiTokenBreakdown', {
                total: totalTokens.toLocaleString(),
                input: tokenUsage.input_tokens.toLocaleString(),
                output: tokenUsage.output_tokens.toLocaleString(),
                cacheRead: cacheReadTokens.toLocaleString(),
                cacheWrite: cacheCreationTokens.toLocaleString(),
              })}
            >
              {t(cachedTokens > 0 ? 'session.apiTokensWithCache' : 'session.apiTokens', {
                count: formatTokenCount(totalTokens),
              })}
            </span>
          ),
        }
      : null,
    lastUpdated
      ? {
          key: 'updated',
          content: <span className="truncate">{t('session.lastUpdated', { time: lastUpdated })}</span>,
        }
      : null,
    !showRightPanel && visibleMessageCount > 0
      ? {
          key: 'messages',
          content: <span className="shrink-0">{t('session.messages', { count: visibleMessageCount })}</span>,
        }
      : null,
  ]
  const headerMetadata = headerMetadataCandidates.filter(
    (item): item is SessionHeaderMetaItem => item !== null,
  )

  return (
    <SessionChatSurface
      surfaceKind="main"
      isMobileLayout={isMobileLayout}
      compact={showRightPanel}
      activityRailOpen={isActivityRailOpen}
      contentRowTestId="active-session-content-row"
      chatColumnTestId="active-session-chat-column"
      activityRail={activityModel && showActivityRail ? (
        <SessionActivityPanel
          model={activityModel}
          open={isActivityPanelOpen}
          onClose={() => closeActivityPanel(activeTabId)}
          onOpenSubagent={handleOpenSubagentRun}
          onClearFinishedBackgroundTasks={handleClearFinishedBackgroundTasks}
          onOpenMember={handleOpenTeamMember}
          onStopBackgroundTask={handleStopBackgroundTask}
          stoppingBackgroundTaskIds={stoppingBackgroundTaskIds}
          placement="rail"
        />
      ) : null}
      chatColumnHidden={isWorkspaceFull}
      sidePanel={showWorkbench ? (
        <>
          {isWorkspaceFull ? null : <WorkspaceResizeHandle panelRef={workbenchPanelRef} />}
          <aside
            ref={workbenchPanelRef}
            data-testid="workbench-panel"
            data-workspace-layout={isWorkspaceFull ? 'full' : workspaceLayout}
            className="flex h-full min-w-0 flex-col bg-[var(--color-surface)]"
            style={isWorkspaceFull
              ? { flex: '1 1 auto' }
              : { width: rightPanelWidth, flex: '0 0 auto', maxWidth: '70%', minWidth: 'min(420px, 54%)' }}
          >
            <WorkspaceSurface
              sessionId={activeTabId}
              dock="side"
              cwd={getSessionTerminalCwd(session) ?? ''}
              reviewUnavailableReason={workspaceIsGitRepo === false ? t('workspace.launcher.reviewNeedsGit') : null}
            />
          </aside>
        </>
      ) : null}
    >
          {isEmpty ? (
            <div
              data-testid="empty-session-hero"
              className={[
                'brand-seal-glow flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-8 pt-8',
                compactEmptyHero ? 'pb-6' : 'pb-32',
              ].join(' ')}
            >
              <div className="flex max-w-[420px] flex-col items-center gap-[13px] text-center">
                <BrandSeal size={compactEmptyHero ? 'lg' : 'xl'} />
                <h1
                  className={`text-2xl font-semibold tracking-tight text-[var(--color-text-primary)]`}
                  style={{ fontFamily: 'var(--font-headline)' }}
                >
                  {t('empty.title')}
                </h1>
                <p
                  className={`mx-auto -mt-1 text-[var(--color-text-secondary)] ${compactEmptyHero ? 'max-w-[280px] text-sm leading-6' : 'text-[15px] leading-[1.7]'}`}
                  style={{ fontFamily: 'var(--font-body)' }}
                >
                  {t('empty.subtitle')}
                </p>
              </div>
            </div>
          ) : (
            <>
              {!isMobileLayout && (
                <SessionChatHeader
                  title={headerTitle}
                  compact={showRightPanel}
                  metadata={headerMetadata}
                >
                  {session && getSessionWorkspaceState(session) !== 'available' && (
                    <div className={`mt-2 inline-flex max-w-full items-center gap-2 rounded-[var(--radius-md)] border px-3 py-1.5 text-[11px] ${
                      getSessionWorkspaceState(session) === 'worktree_removed'
                        ? 'border-[var(--color-border)] bg-[var(--color-surface-container)] text-[var(--color-text-secondary)]'
                        : 'border-[var(--color-error)] bg-[var(--color-error-container)] text-[var(--color-on-error-container)]'
                    }`}>
                      <span className="material-symbols-outlined text-[14px]">
                        {getSessionWorkspaceState(session) === 'worktree_removed' ? 'history' : 'warning'}
                      </span>
                      <span className="truncate">
                        {getSessionWorkspaceState(session) === 'worktree_removed'
                          ? t('session.worktreeRemoved', { dir: session.projectRoot || '' })
                          : t('session.workspaceUnavailable', { dir: session.workDir || 'directory no longer exists' })}
                      </span>
                    </div>
                  )}
                  <ActiveGoalStrip
                    goal={activeGoal}
                    isRunning={isActive}
                    compact={showRightPanel}
                  />
                  {agentTeamsSnapshot ? (
                    <AgentTeamsStrip
                      snapshot={agentTeamsSnapshot}
                      compact={showRightPanel}
                      onOpen={() => useTabStore.getState().openTeamWorkbenchTab(
                        activeTabId,
                        agentTeamsSnapshot.team.name,
                      )}
                    />
                  ) : null}
                </SessionChatHeader>
              )}

              {isHistoryLoading ? (
                <div className="flex flex-1 items-center justify-center p-8">
                  <LoadingState label={t('common.loading')} variant="inline" size="md" />
                </div>
              ) : historyError ? (
                <div role="alert" className="flex flex-1 items-center justify-center p-8 text-sm text-[var(--color-error)]">
                  {historyError}
                </div>
              ) : (
                <MessageList compact={showRightPanel} mobileLayout={isMobileLayout} />
              )}
            </>
          )}

          {activityModel && hasVisibleActivity && isMobileLayout && isSessionTabState(activeTabId, activeTabType) ? (
            <SessionActivityPanel
              model={activityModel}
              open={isActivityPanelOpen}
              onClose={() => closeActivityPanel(activeTabId)}
              onOpenSubagent={handleOpenSubagentRun}
              onClearFinishedBackgroundTasks={handleClearFinishedBackgroundTasks}
              onOpenMember={handleOpenTeamMember}
              onStopBackgroundTask={handleStopBackgroundTask}
              stoppingBackgroundTaskIds={stoppingBackgroundTaskIds}
              placement="overlay"
            />
          ) : null}

          <ChatInput
            variant={isEmpty && !showRightPanel ? 'hero' : 'default'}
            compact={showRightPanel}
          />

          {hasBottomTerminals && activeTabId ? (
            <div
              data-testid="session-terminal-panel"
              aria-label={t('workspace.bottomPanelLabel')}
              className={[
                'relative flex min-h-0 shrink-0 flex-col border-t border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]',
                showTerminalPanel ? '' : 'hidden',
              ].join(' ')}
              style={{ height: showTerminalPanel ? terminalPanelHeight : 0 }}
            >
              {showTerminalPanel && <TerminalResizeHandle />}
              {/*
                Kept mounted while hidden. The PTY would survive an unmount
                anyway, but xterm re-measures on every re-attach, and a hidden
                host measures as zero — which is what made a reopened terminal
                come back with a one-column viewport.
              */}
              <WorkspaceSurface
                sessionId={activeTabId}
                dock="bottom"
                cwd={getSessionTerminalCwd(session) ?? ''}
                visible={showTerminalPanel}
              />
            </div>
          ) : null}
    </SessionChatSurface>
  )
}
