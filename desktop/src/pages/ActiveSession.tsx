import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, RefObject } from 'react'
import { Target } from 'lucide-react'
import {
  SCHEDULED_TAB_ID,
  SETTINGS_TAB_ID,
  TERMINAL_TAB_PREFIX,
  TRACE_TAB_PREFIX,
  WORKBENCH_TAB_PREFIX,
  useTabStore,
  type TabType,
} from '../stores/tabStore'
import { useSessionStore } from '../stores/sessionStore'
import { useChatStore } from '../stores/chatStore'
import { useCLITaskStore } from '../stores/cliTaskStore'
import { useTeamStore } from '../stores/teamStore'
import { useWorkspacePanelStore } from '../stores/workspacePanelStore'
import {
  TERMINAL_PANEL_DEFAULT_HEIGHT,
  TERMINAL_PANEL_MAX_HEIGHT,
  TERMINAL_PANEL_MIN_HEIGHT,
  useTerminalPanelStore,
} from '../stores/terminalPanelStore'
import { useTranslation } from '../i18n'
import { Button } from '@/components/ui/Button'
import { LoadingState } from '@/components/ui/LoadingState'
import { BrandSeal } from '@/components/composite/BrandSeal'
import { MessageList } from '../components/chat/MessageList'
import { ChatInput } from '../components/chat/ChatInput'
import { ComputerUsePermissionModal } from '../components/chat/ComputerUsePermissionModal'
import { WorkbenchPanel } from '../components/workbench/WorkbenchPanel'
import { SessionActivityPanel } from '../components/activity/SessionActivityPanel'
import { buildSessionActivityModel, hasVisibleSessionActivity } from '../components/activity/sessionActivityModel'
import { TerminalSettings } from './TerminalSettings'
import type { SessionListItem } from '../types/session'
import type { ActiveGoalState, TokenUsage } from '../types/chat'
import type { TeamMember } from '../types/team'
import { useMobileViewport } from '../hooks/useMobileViewport'
import { isDesktopRuntime } from '../lib/desktopRuntime'
import { formatTokenCount } from '../lib/formatTokenCount'
import {
  createBackgroundTaskDismissKey,
  hasRunningBackgroundTasks as hasAnyRunningBackgroundTasks,
} from '../lib/backgroundTasks'
import { useActivityPanelStore } from '../stores/activityPanelStore'
import { getSessionBrowsablePath, getSessionWorkspaceState } from '../lib/sessionWorkspace'
import type { AgentTaskNotification, UIMessage } from '../types/chat'

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
const CHAT_COLUMN_WITH_WORKSPACE_CLASS =
  'min-w-[320px] flex-1 bg-[var(--color-surface)]'
const EMPTY_DISMISSED_BACKGROUND_TASK_KEYS: readonly string[] = []

function isSessionTabState(activeTabId: string | null, activeTabType: TabType | null | undefined) {
  if (!activeTabId) return false
  if (activeTabType === 'session') return true
  if (activeTabType) return false
  return activeTabId !== SETTINGS_TAB_ID &&
    activeTabId !== SCHEDULED_TAB_ID &&
    !activeTabId.startsWith(TERMINAL_TAB_PREFIX) &&
    !activeTabId.startsWith(TRACE_TAB_PREFIX) &&
    !activeTabId.startsWith(WORKBENCH_TAB_PREFIX)
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
  const width = useWorkspacePanelStore((state) => state.width)
  const setWidth = useWorkspacePanelStore((state) => state.setWidth)
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
  const height = useTerminalPanelStore((state) => state.height)
  const setHeight = useTerminalPanelStore((state) => state.setHeight)
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
      aria-valuemin={TERMINAL_PANEL_MIN_HEIGHT}
      aria-valuemax={TERMINAL_PANEL_MAX_HEIGHT}
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
          setHeight(TERMINAL_PANEL_MIN_HEIGHT)
        }
        if (event.key === 'End') {
          event.preventDefault()
          setHeight(TERMINAL_PANEL_MAX_HEIGHT)
        }
      }}
      onDoubleClick={() => setHeight(TERMINAL_PANEL_DEFAULT_HEIGHT)}
      className="group flex h-2.5 shrink-0 cursor-row-resize items-center bg-[var(--color-surface)] outline-none focus-visible:bg-[var(--color-surface-container)]"
    >
      <div className="mx-3 h-px flex-1 rounded-full bg-[var(--color-border)] transition-colors group-hover:bg-[var(--color-border-focus)] group-focus-visible:bg-[var(--color-border-focus)]" />
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
  const pendingComputerUsePermission = sessionState?.pendingComputerUsePermission ?? null
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
  const memberInfo = useTeamStore((s) => activeTabId ? s.getMemberBySessionId(activeTabId) : null)
  const activeTeam = useTeamStore((s) => s.activeTeam)
  const isMemberSession = !!memberInfo
  const showWorkbench = useWorkspacePanelStore((state) =>
    activeTabId && isSessionTabState(activeTabId, activeTabType) && !isMemberSession && !isMobileLayout
      ? state.isPanelOpen(activeTabId)
      : false,
  )
  const showRightPanel = showWorkbench
  const rightPanelWidth = useWorkspacePanelStore((state) => state.width)
  const showTerminalPanel = useTerminalPanelStore((state) =>
    activeTabId && isSessionTabState(activeTabId, activeTabType) && !isMemberSession && !isMobileLayout
      ? state.isPanelOpen(activeTabId)
      : false,
  )
  const terminalPanelRuntimeId = useTerminalPanelStore((state) =>
    activeTabId && isSessionTabState(activeTabId, activeTabType) && !isMemberSession && !isMobileLayout
      ? state.panelBySession[activeTabId]?.runtimeId
      : undefined,
  )
  const terminalPanelHeight = useTerminalPanelStore((state) => state.height)
  const activityVisibilityBySessionRef = useRef<Record<string, { hadAutoOpenActivity: boolean }>>({})

  useEffect(() => {
    if (activeTabId && !isMemberSession) {
      connectToSession(activeTabId)
    }
  }, [activeTabId, isMemberSession, connectToSession])

  useEffect(() => {
    if (!activeTabId || isMemberSession) return

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
    isMemberSession,
    chatState,
    trackedTaskSessionId,
    hasIncompleteTasks,
    fetchSessionTasks,
  ])

  const t = useTranslation()
  const messages = sessionState?.messages ?? EMPTY_MESSAGES
  const streamingText = sessionState?.streamingText ?? ''
  const backgroundTasks = useMemo(
    () => Object.values(sessionState?.backgroundAgentTasks ?? {}),
    [sessionState?.backgroundAgentTasks],
  )
  const dismissedBackgroundTaskKeys = useMemo(
    () => new Set(dismissedBackgroundTaskKeyList),
    [dismissedBackgroundTaskKeyList],
  )
  const agentTaskNotifications = sessionState?.agentTaskNotifications ?? EMPTY_AGENT_TASK_NOTIFICATIONS
  const activeGoal = sessionState?.activeGoal ?? null
  const isEmpty = messages.length === 0 && !streamingText && (session?.messageCount ?? 0) === 0
  const compactEmptyHero = isEmpty && showTerminalPanel
  const isHistoryLoading =
    !isMemberSession &&
    (session?.messageCount ?? 0) > 0 &&
    messages.length === 0 &&
    sessionState?.historyStatus === 'loading'
  const historyError =
    !isMemberSession &&
    (session?.messageCount ?? 0) > 0 &&
    messages.length === 0 &&
    sessionState?.historyStatus === 'error'
      ? sessionState.historyError || t('session.historyLoadFailed')
      : null
  const visibleMessageCount = messages.length > 0 ? messages.length : session?.messageCount ?? 0
  const headerTitle = session?.title || t('session.untitled')

  const isActive = chatState !== 'idle' || hasRunningBackgroundTasks
  const totalTokens = getTokenUsageTotal(tokenUsage)
  const cachedTokens = (tokenUsage.cache_read_tokens ?? 0) +
    (tokenUsage.cache_creation_tokens ?? 0)
  const activityTeamMembers = useMemo(() => {
    if (!activeTeam || activeTeam.leadSessionId !== activeTabId) return []
    return activeTeam.members.filter((member) =>
      !activeTeam.leadAgentId || member.agentId !== activeTeam.leadAgentId
    )
  }, [activeTabId, activeTeam])

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

    return buildSessionActivityModel({
      sessionId: activeTabId,
      messages,
      tasks: includeCliTasks ? cliTasks : [],
      completedAndDismissed: includeCliTasks ? cliTasksCompletedAndDismissed : false,
      isForegroundTurnActive: chatState !== 'idle',
      backgroundTasks,
      dismissedBackgroundTaskKeys,
      agentNotifications: Object.values(agentTaskNotifications),
      teamMembers: activityTeamMembers,
    })
  }, [
    activeTabId,
    activityTeamMembers,
    agentTaskNotifications,
    backgroundTasks,
    cliTasks,
    cliTasksCompletedAndDismissed,
    chatState,
    dismissedBackgroundTaskKeys,
    messages,
    trackedTaskSessionId,
  ])
  const hasVisibleActivity = activityModel ? hasVisibleSessionActivity(activityModel) : false
  const hasAutoOpenActivity = activityModel ? activityModel.badgeCount > 0 : false

  useEffect(() => {
    if (!activeTabId || isMemberSession || !isSessionTabState(activeTabId, activeTabType)) return

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
    isMemberSession,
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
    if (!activeTabId || !showWorkbench || !isActivityPanelOpen) return
    closeActivityPanel(activeTabId)
  }, [activeTabId, closeActivityPanel, isActivityPanelOpen, showWorkbench])

  const handleOpenSubagentRun = useCallback((payload: { sessionId: string; taskId?: string; toolUseId: string; title: string }) => {
    useTabStore.getState().openSubagentTab(payload.sessionId, payload.toolUseId, payload.title, payload.taskId)
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
    !showWorkbench &&
    !isMobileLayout &&
    !isMemberSession &&
    isSessionTabState(activeTabId, activeTabType)
  const isActivityRailOpen = showActivityRail && isActivityPanelOpen

  return (
    <div className="flex-1 flex relative overflow-hidden bg-background text-on-surface">
      <div data-testid="active-session-content-row" className="flex min-h-0 min-w-0 flex-1">
        <div
          data-testid="active-session-chat-column"
          className={[
            'relative flex min-h-0 min-w-0 flex-col overflow-hidden',
            'transition-[padding] duration-200 ease-out motion-reduce:transition-none',
            // 340px panel + 20px right inset leaves the 8px gap the handoff draws.
            isActivityRailOpen ? 'pr-[352px]' : '',
            showRightPanel ? CHAT_COLUMN_WITH_WORKSPACE_CLASS : isMobileLayout ? 'flex-1' : 'min-w-[360px] flex-1',
          ].filter(Boolean).join(' ')}
        >
          {isMemberSession && (
            <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface-container)]">
              <div className="mx-auto max-w-[900px] flex items-center justify-between gap-4 px-8 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-3">
                    {memberInfo?.status === 'running' && (
                      <span className="flex h-2 w-2 rounded-full bg-[var(--color-warning)] animate-pulse-dot" />
                    )}
                    {memberInfo?.status === 'completed' && (
                      <span className="material-symbols-outlined text-[14px] text-[var(--color-success)]" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                    )}
                    <span className="material-symbols-outlined text-[14px] text-[var(--color-text-tertiary)]">smart_toy</span>
                    <span className="text-sm font-semibold text-[var(--color-text-primary)]">
                      {memberInfo?.role}
                    </span>
                    {activeTeam && (
                      <span className="text-[10px] text-[var(--color-text-tertiary)]">
                        @ {activeTeam.name}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] text-[var(--color-text-tertiary)]">
                    {t('teams.memberSessionHint')}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  onClick={() => {
                    if (activeTeam?.leadSessionId) {
                      useTabStore.getState().openTab(
                        activeTeam.leadSessionId,
                        t('teams.leader'),
                        'session',
                      )
                    }
                  }}
                  disabled={!activeTeam?.leadSessionId}
                  icon={<span className="material-symbols-outlined text-[14px]">arrow_back</span>}
                >
                  {t('teams.backToLeader')}
                </Button>
              </div>
            </div>
          )}

          {isEmpty ? (
            <div
              data-testid="empty-session-hero"
              className={[
                'brand-seal-glow flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-8 pt-8',
                compactEmptyHero ? 'pb-6' : 'pb-32',
              ].join(' ')}
            >
              <div className="flex max-w-[420px] flex-col items-center gap-[13px] text-center">
                {isMemberSession ? (
                  <>
                    <span className={`material-symbols-outlined text-[var(--color-text-tertiary)] ${compactEmptyHero ? 'text-[36px]' : 'text-[48px]'}`}>smart_toy</span>
                    <p className="text-[var(--color-text-secondary)]">
                      {memberInfo?.status === 'running'
                        ? `${memberInfo.role} ${t('teams.working')}`
                        : t('teams.noMessages')}
                    </p>
                  </>
                ) : (
                  <>
                    <BrandSeal size={compactEmptyHero ? 'lg' : 'xl'} />
                    <h1
                      className={`${compactEmptyHero ? 'text-2xl' : 'text-[27px]'} font-bold tracking-tight text-[var(--color-text-primary)]`}
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
                  </>
                )}
              </div>
            </div>
          ) : (
            <>
              {!isMemberSession && !isMobileLayout && (
                <div
                  data-testid="session-header"
                  className={
                    showRightPanel
                      ? 'flex w-full items-center border-b border-[var(--color-border)] px-4 py-2.5'
                      : 'w-full border-b border-[var(--color-border)] px-9 py-3'
                  }
                >
                  <div className={showRightPanel ? 'min-w-0 flex-1' : 'mx-auto w-full max-w-[900px] min-w-0'}>
                    <div className="flex min-w-0 items-center gap-3">
                      <h1
                        className={`min-w-0 flex-1 truncate font-bold leading-tight tracking-[-0.2px] text-[var(--color-text-primary)] ${
                          showRightPanel ? 'text-[15px]' : 'text-[17px]'
                        }`}
                        style={{ fontFamily: 'var(--font-headline)' }}
                        title={headerTitle}
                      >
                        {headerTitle}
                      </h1>
                    </div>
                    <div className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11px] text-[var(--color-text-tertiary)]">
                      {[
                        isActive && (
                          <span key="active" className="flex shrink-0 items-center gap-1.5 text-[var(--color-text-secondary)]">
                            <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-success)] animate-pulse-dot" />
                            {t('session.active')}
                          </span>
                        ),
                        totalTokens > 0 && (
                          <span
                            key="tokens"
                            className="shrink-0"
                            title={t('session.apiTokenBreakdown', {
                              total: totalTokens.toLocaleString(),
                              input: tokenUsage.input_tokens.toLocaleString(),
                              output: tokenUsage.output_tokens.toLocaleString(),
                              cache: cachedTokens.toLocaleString(),
                            })}
                          >
                            {t('session.apiTokens', { count: formatTokenCount(totalTokens) })}
                          </span>
                        ),
                        lastUpdated && (
                          <span key="updated" className="truncate">{t('session.lastUpdated', { time: lastUpdated })}</span>
                        ),
                        !showRightPanel && visibleMessageCount > 0 && (
                          <span key="messages" className="shrink-0">{t('session.messages', { count: visibleMessageCount })}</span>
                        ),
                      ]
                        .filter((part): part is ReactElement => Boolean(part))
                        .map((part, index) => (
                          <Fragment key={part.key}>
                            {index > 0 && <span aria-hidden="true" className="shrink-0">·</span>}
                            {part}
                          </Fragment>
                        ))}
                    </div>
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
                  </div>
                </div>
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

          {activityModel && hasVisibleActivity && isMobileLayout && !isMemberSession && isSessionTabState(activeTabId, activeTabType) ? (
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
            variant={isEmpty && !isMemberSession && !showRightPanel ? 'hero' : 'default'}
            compact={showRightPanel}
          />

          {terminalPanelRuntimeId && activeTabId ? (
            <div
              data-testid="session-terminal-panel"
              className={[
                'flex min-h-0 shrink-0 flex-col border-t border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]',
                showTerminalPanel ? '' : 'hidden',
              ].join(' ')}
              style={{ height: showTerminalPanel ? terminalPanelHeight : 0 }}
            >
              {showTerminalPanel && <TerminalResizeHandle />}
              <TerminalSettings
                active={showTerminalPanel}
                docked
                cwd={getSessionTerminalCwd(session)}
                runtimeId={terminalPanelRuntimeId}
                preserveOnUnmount
                testId={`session-terminal-host-${activeTabId}`}
                onOpenInTab={() => {
                  useTerminalPanelStore.getState().closePanel(activeTabId)
                  useTabStore.getState().openTerminalTab(getSessionTerminalCwd(session), terminalPanelRuntimeId)
                  useTerminalPanelStore.getState().detachRuntime(activeTabId)
                }}
                onClose={() => useTerminalPanelStore.getState().closePanel(activeTabId)}
              />
            </div>
          ) : null}
        </div>

        {activityModel && showActivityRail ? (
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

        {showWorkbench ? (
          <>
            <WorkspaceResizeHandle panelRef={workbenchPanelRef} />
            <aside
              ref={workbenchPanelRef}
              data-testid="workbench-panel"
              className="flex h-full shrink-0 flex-col bg-[var(--color-surface)]"
              style={{ width: rightPanelWidth, maxWidth: '62%', minWidth: 'min(420px, 54%)' }}
            >
              <WorkbenchPanel sessionId={activeTabId} />
            </aside>
          </>
        ) : null}
      </div>

      {!isMemberSession && activeTabId ? (
        <ComputerUsePermissionModal
          sessionId={activeTabId}
          request={pendingComputerUsePermission?.request ?? null}
        />
      ) : null}
    </div>
  )
}
