import { useEffect, useMemo, useRef, useState } from 'react'
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
import { useSessionRuntimeStore } from '../stores/sessionRuntimeStore'
import { projectsApi } from '../api/projects'
import { wsManager } from '../api/websocket'
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
import { MessageList } from '../components/chat/MessageList'
import { ChatInput } from '../components/chat/ChatInput'
import { ComputerUsePermissionModal } from '../components/chat/ComputerUsePermissionModal'
import { SessionTaskBar } from '../components/chat/SessionTaskBar'
import { SoloCouncilPanel } from '../components/chat/SoloCouncilPanel'
import { WorkbenchPanel } from '../components/workbench/WorkbenchPanel'
import { TeamStatusBar } from '../components/teams/TeamStatusBar'
import { TerminalSettings } from './TerminalSettings'
import type { SessionListItem } from '../types/session'
import type { ActiveGoalState } from '../types/chat'
import { useMobileViewport } from '../hooks/useMobileViewport'
import { isDesktopRuntime } from '../lib/desktopRuntime'
import { formatTokenCount } from '../lib/formatTokenCount'
import { publicAssetPath } from '../lib/publicAsset'
import {
  COMPOSER_PREFILL_EVENT,
  WelcomeTaskCards,
  type ComposerPrefillDetail,
  type WelcomeTaskCard,
} from '../components/welcome/WelcomeTaskCards'
import { RecentActivityCard } from '../components/welcome/RecentActivityCard'

const TASK_POLL_INTERVAL_MS = 1000
const WORKSPACE_RESIZE_STEP = 32
const TERMINAL_RESIZE_STEP = 24
const CHAT_COLUMN_WITH_WORKSPACE_CLASS =
  'min-w-[320px] flex-1 border-r border-[var(--color-border)] bg-[var(--color-surface)]'

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

function getSessionTerminalCwd(session: SessionListItem | undefined) {
  if (!session) return undefined
  if (session.workDir && session.workDirExists !== false) return session.workDir
  return session.projectPath || undefined
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
        'mt-2 flex max-w-full items-center gap-2 rounded-[8px] border border-[var(--color-memory-border)] bg-[var(--color-memory-surface)] px-2.5 py-1.5',
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

function WorkspaceResizeHandle() {
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
        setDragState({ startX: event.clientX, startWidth: width })
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          setWidth(width + WORKSPACE_RESIZE_STEP)
        }
        if (event.key === 'ArrowRight') {
          event.preventDefault()
          setWidth(width - WORKSPACE_RESIZE_STEP)
        }
      }}
      className="group relative z-10 flex w-2 shrink-0 cursor-col-resize items-stretch justify-center bg-[var(--color-surface)] outline-none focus-visible:bg-[var(--color-surface-container)]"
    >
      <div className="my-3 w-px rounded-full bg-[var(--color-border)] transition-colors group-hover:bg-[var(--color-border-focus)] group-focus-visible:bg-[var(--color-border-focus)]" />
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
  const activeTabId = useTabStore((s) => s.activeTabId)
  const activeTabType = useTabStore((s) => s.tabs.find((tab) => tab.sessionId === s.activeTabId)?.type ?? null)
  const sessions = useSessionStore((s) => s.sessions)
  const connectToSession = useChatStore((s) => s.connectToSession)
  const sessionState = useChatStore((s) => activeTabId ? s.sessions[activeTabId] : undefined)
  // Hand-off context attached to this session (if any). Drives a small chip
  // in the header so the user remembers the AI started with summarized
  // prior context. Set by the "Continue from here" flow on success.
  const handoffInfoForActive = useSessionRuntimeStore((s) =>
    activeTabId ? s.handoffInfo[activeTabId] : undefined,
  )
  // Live mode flags drive the always-visible status chip in the chat header
  // so the user can see at a glance which session-level mode is active. The
  // `+`-menu toggle in ChatInput is the entry point but only surfaces the
  // current state inside that menu — the chip is the persistent affordance
  // that the steering contract calls "明示当前模式" (must be explicit).
  const coordinatorModeForActive = useSessionRuntimeStore((s) =>
    activeTabId ? s.coordinatorModes[activeTabId] ?? false : false,
  )
  const soloPipelineModeForActive = useSessionRuntimeStore((s) =>
    activeTabId ? s.soloPipelineModes[activeTabId] ?? false : false,
  )
  const pendingComputerUsePermission = sessionState?.pendingComputerUsePermission ?? null
  const fetchSessionTasks = useCLITaskStore((s) => s.fetchSessionTasks)
  const trackedTaskSessionId = useCLITaskStore((s) => s.sessionId)
  const hasIncompleteTasks = useCLITaskStore((s) => s.tasks.some((task) => task.status !== 'completed'))
  const hasRunningTasks = useCLITaskStore((s) => s.tasks.some((task) => task.status === 'in_progress'))
  const chatState = sessionState?.chatState ?? 'idle'
  const tokenUsage = sessionState?.tokenUsage ?? { input_tokens: 0, output_tokens: 0 }
  const hasRunningBackgroundTasks = Object.values(sessionState?.backgroundAgentTasks ?? {})
    .some((task) => task.status === 'running')

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
  const messages = sessionState?.messages ?? []
  const streamingText = sessionState?.streamingText ?? ''
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

  const isActive = chatState !== 'idle' ||
    (trackedTaskSessionId === activeTabId && hasRunningTasks) ||
    hasRunningBackgroundTasks
  const totalTokens = tokenUsage.input_tokens + tokenUsage.output_tokens

  const lastUpdated = useMemo(() => {
    if (!session?.modifiedAt) return ''
    const diff = Date.now() - new Date(session.modifiedAt).getTime()
    if (diff < 60000) return t('session.timeJustNow')
    if (diff < 3600000) return t('session.timeMinutes', { n: Math.floor(diff / 60000) })
    if (diff < 86400000) return t('session.timeHours', { n: Math.floor(diff / 3600000) })
    return t('session.timeDays', { n: Math.floor(diff / 86400000) })
  }, [session?.modifiedAt, t])

  if (!activeTabId) return null

  return (
    <div className="flex-1 flex relative overflow-hidden bg-background text-on-surface">
      <div data-testid="active-session-content-row" className="flex min-h-0 min-w-0 flex-1">
        <div
          data-testid="active-session-chat-column"
          className={`flex min-h-0 flex-col ${showRightPanel ? CHAT_COLUMN_WITH_WORKSPACE_CLASS : isMobileLayout ? 'min-w-0 flex-1' : 'min-w-[360px] flex-1'}`}
        >
          {isMemberSession && (
            <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface-container)]">
              <div className="mx-auto max-w-[860px] flex items-center justify-between gap-4 px-8 py-2">
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
                <button
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
                  className="flex shrink-0 items-center gap-1 text-xs font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-50 disabled:hover:text-[var(--color-text-secondary)]"
                >
                  <span className="material-symbols-outlined text-[14px]">arrow_back</span>
                  {t('teams.backToLeader')}
                </button>
              </div>
            </div>
          )}

          {isEmpty ? (
            <div
              data-testid="empty-session-hero"
              className={`flex min-h-0 flex-1 flex-col items-center justify-center gap-1 overflow-y-auto p-8 ${compactEmptyHero ? 'pb-6' : 'pb-32'}`}
            >
              <div className="flex max-w-md flex-col items-center text-center">
                {isMemberSession ? (
                  <>
                    <span className={`material-symbols-outlined mb-4 text-[var(--color-text-tertiary)] ${compactEmptyHero ? 'text-[36px]' : 'text-[48px]'}`}>smart_toy</span>
                    <p className="text-[var(--color-text-secondary)]">
                      {memberInfo?.status === 'running'
                        ? `${memberInfo.role} ${t('teams.working')}`
                        : t('teams.noMessages')}
                    </p>
                  </>
                ) : (
                  <>
                    <img
                      src={publicAssetPath('app-icon.png')}
                      alt="Claude Code Haha"
                      className={compactEmptyHero ? 'mb-4 h-16 w-16' : 'mb-6 h-24 w-24'}
                    />
                    <h1 className={`${compactEmptyHero ? 'mb-1 text-2xl' : 'mb-2 text-3xl'} font-extrabold tracking-tight text-[var(--color-text-primary)]`} style={{ fontFamily: 'var(--font-headline)' }}>
                      {t('empty.title')}
                    </h1>
                    <p className={`mx-auto max-w-xs text-[var(--color-text-secondary)] ${compactEmptyHero ? 'text-sm' : ''}`} style={{ fontFamily: 'var(--font-body)' }}>
                      {t('empty.subtitle')}
                    </p>
                  </>
                )}
              </div>
              {!isMemberSession && !isMobileLayout && activeTabId && session?.workDir && (
                <RecentActivityCard
                  workDir={session.workDir}
                  excludeSessionId={activeTabId}
                  hideContinueSessionButton
                  onContinueSession={(sessionId) => {
                    useTabStore.getState().openTab(sessionId, 'New Session')
                    connectToSession(sessionId)
                  }}
                  onAutoHandoff={async (previousSessionId, previousSessionTitle, fallbackText, setStage, options) => {
                    // 1. Resolve summary (cached → generated → null). Any
                    //    failure degrades silently to the zero-token
                    //    textarea-prefill path.
                    setStage('reading-cache')
                    let summary = null
                    try {
                      const cached = await projectsApi.getSessionSummary(previousSessionId)
                      summary = cached.summary
                    } catch {
                      // GET error → fall through to generation path below.
                    }
                    if (!summary) {
                      setStage('generating-summary')
                      try {
                        const fresh = await projectsApi.generateSessionSummary(previousSessionId)
                        summary = fresh.summary
                      } catch {
                        summary = null
                      }
                    }

                    if (!summary) {
                      // Zero-token fallback: write the static hand-off
                      // paragraph into the composer via the existing
                      // composer-prefill event.
                      const detail: ComposerPrefillDetail = {
                        sessionId: activeTabId,
                        text: fallbackText,
                      }
                      window.dispatchEvent(
                        new CustomEvent(COMPOSER_PREFILL_EVENT, { detail }),
                      )
                      return
                    }

                    setStage('starting-session')

                    // Stash hand-off info on the active session so the
                    // chat header can render a "↗ continued from..." chip.
                    useSessionRuntimeStore.getState().setHandoffInfo(activeTabId, {
                      previousSessionId,
                      previousSessionTitle,
                      approxTokens: Math.ceil(
                        (summary.main.length + summary.recent.length) / 4,
                      ),
                      generatedAt: summary.generatedAt,
                    })

                    // 2. Stage hand-off on the live session and auto-send a
                    //    short trigger message. Server reads cached summary
                    //    via WS message, restarts CLI with --append-system-
                    //    prompt, and the next user_message kicks off the AI
                    //    turn with full context already in system prompt.
                    wsManager.send(activeTabId, {
                      type: 'set_handoff_summary',
                      previousSessionId,
                      ...(options?.deep ? { deep: true } : {}),
                    })
                    useChatStore.getState().sendMessage(
                      activeTabId,
                      t('empty.recentActivity.continueTriggerMessage'),
                    )
                  }}
                />
              )}
              {!isMemberSession && !isMobileLayout && activeTabId && (
                <WelcomeTaskCards
                  workDir={session?.workDir || undefined}
                  excludeSessionId={activeTabId}
                  onApplyTask={(card: WelcomeTaskCard, promptText: string) => {
                    // Push the starter prompt into ChatInput's draft via a
                    // window event — ChatInput listens for this and sets its
                    // textarea state when the sessionId matches the active tab.
                    const detail: ComposerPrefillDetail = {
                      sessionId: activeTabId,
                      text: promptText,
                    }
                    window.dispatchEvent(new CustomEvent(COMPOSER_PREFILL_EVENT, { detail }))
                    if (card.orchestrate) {
                      // Session already exists here (we're in ActiveSession),
                      // so this immediately persists the preference and
                      // pushes the WS message if connected. Won't disable an
                      // existing toggle — non-orchestration cards leave it.
                      useChatStore.getState().setSessionCoordinatorMode(activeTabId, true)
                    }
                  }}
                />
              )}
            </div>
          ) : (
            <>
              {!isMemberSession && !isMobileLayout && (
                <div
                  className={
                    showRightPanel
                      ? 'flex w-full items-center border-b border-[var(--color-border)]/70 px-4 py-3'
                      : 'w-full border-b border-outline-variant/10 px-4 py-3'
                  }
                >
                  <div className={showRightPanel ? 'min-w-0 flex-1' : 'mx-auto w-full max-w-[860px] min-w-0'}>
                    <div className="flex min-w-0 items-center gap-3">
                      <h1
                        className={
                          showRightPanel
                            ? 'min-w-0 flex-1 truncate text-[15px] font-bold font-headline leading-tight text-on-surface'
                            : 'min-w-0 flex-1 text-lg font-bold font-headline text-on-surface leading-tight'
                        }
                      >
                        {session?.title || t('session.untitled')}
                      </h1>
                    </div>
                    <div
                      className={
                        showRightPanel
                          ? 'mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[10px] font-medium text-outline'
                          : 'flex items-center gap-2 text-[10px] text-outline font-medium mt-1'
                      }
                    >
                      {isActive && (
                        <span className="flex shrink-0 items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)] animate-pulse-dot" />
                          {t('session.active')}
                        </span>
                      )}
                      {totalTokens > 0 && (
                        <>
                          <span className="text-[var(--color-outline)]">·</span>
                          <span title={t('common.tokens', { count: totalTokens.toLocaleString() })}>
                            {t('common.tokens', { count: formatTokenCount(totalTokens) })}
                          </span>
                        </>
                      )}
                      {lastUpdated && (
                        <>
                          <span className="shrink-0 text-[var(--color-outline)]">·</span>
                          <span className="truncate">{t('session.lastUpdated', { time: lastUpdated })}</span>
                        </>
                      )}
                      {!showRightPanel && visibleMessageCount > 0 && (
                        <>
                          <span className="text-[var(--color-outline)]">·</span>
                          <span>{t('session.messages', { count: visibleMessageCount })}</span>
                        </>
                      )}
                      {handoffInfoForActive && (
                        <>
                          <span className="text-[var(--color-outline)]">·</span>
                          <span
                            data-testid="session-handoff-chip"
                            title={t('session.handoffChipTooltip', {
                              title: handoffInfoForActive.previousSessionTitle,
                              tokens: handoffInfoForActive.approxTokens,
                            })}
                            className="inline-flex shrink-0 items-center gap-0.5 cursor-help text-[var(--color-primary)]"
                          >
                            {t('session.handoffChip', {
                              tokens: handoffInfoForActive.approxTokens,
                            })}
                          </span>
                        </>
                      )}
                      {coordinatorModeForActive && (
                        <>
                          <span className="text-[var(--color-outline)]">·</span>
                          <span
                            data-testid="session-coordinator-chip"
                            title={t('session.coordinatorChipTooltip')}
                            className="inline-flex shrink-0 items-center gap-1 cursor-help text-[var(--color-primary)]"
                          >
                            <span
                              className="material-symbols-outlined text-[12px]"
                              aria-hidden="true"
                            >
                              hub
                            </span>
                            {t('session.coordinatorChip')}
                          </span>
                        </>
                      )}
                      {soloPipelineModeForActive && (
                        <>
                          <span className="text-[var(--color-outline)]">·</span>
                          <span
                            data-testid="session-solo-chip"
                            title={t('session.soloPipelineChipTooltip')}
                            className="inline-flex shrink-0 items-center gap-1 cursor-help text-[var(--color-primary)]"
                          >
                            <span
                              className="material-symbols-outlined text-[12px]"
                              aria-hidden="true"
                            >
                              linear_scale
                            </span>
                            {t('session.soloPipelineChip')}
                          </span>
                        </>
                      )}
                    </div>
                    {session?.workDirExists === false && (
                      <div className="mt-2 inline-flex max-w-full items-center gap-2 rounded-lg border border-[var(--color-error)]/20 bg-[var(--color-error)]/8 px-3 py-1.5 text-[11px] text-[var(--color-error)]">
                        <span className="material-symbols-outlined text-[14px]">warning</span>
                        <span className="truncate">
                          {t('session.workspaceUnavailable', { dir: session.workDir || 'directory no longer exists' })}
                        </span>
                      </div>
                    )}
                    <ActiveGoalStrip
                      goal={activeGoal}
                      isRunning={isActive}
                      compact={showRightPanel}
                    />
                    {soloPipelineModeForActive && activeTabId && (
                      <SoloCouncilPanel
                        sessionId={activeTabId}
                        compact={showRightPanel}
                      />
                    )}
                  </div>
                </div>
              )}

              {isHistoryLoading ? (
                <div role="status" className="flex flex-1 items-center justify-center p-8 text-sm text-[var(--color-text-secondary)]">
                  <span className="material-symbols-outlined mr-2 animate-spin text-[18px]">progress_activity</span>
                  {t('common.loading')}
                </div>
              ) : historyError ? (
                <div role="alert" className="flex flex-1 items-center justify-center p-8 text-sm text-[var(--color-error)]">
                  {historyError}
                </div>
              ) : (
                <MessageList compact={showRightPanel} />
              )}
            </>
          )}

          {!isMemberSession && <SessionTaskBar />}

          <TeamStatusBar />

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

        {showWorkbench ? (
          <>
            <WorkspaceResizeHandle />
            <aside
              data-testid="workbench-panel"
              className="flex h-full shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)]"
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
