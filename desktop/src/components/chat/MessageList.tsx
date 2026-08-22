import { useRef, useEffect, useMemo, memo, useState, useCallback, useDeferredValue, useLayoutEffect, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, BookMarked, Bot, CheckCircle2, ChevronDown, ChevronRight, CircleStop, FileStack, LoaderCircle, MessageCircle, Settings, Target, XCircle } from 'lucide-react'
import { ApiError } from '../../api/client'
import { sessionsApi, type SessionRewindMode, type SessionTurnCheckpoint } from '../../api/sessions'
import { listPendingPermissions, useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useWorkspaceChatContextStore } from '../../stores/workspaceChatContextStore'
import { useWorkspacePanelStore, type WorkspacePanelOrigin } from '../../stores/workspacePanelStore'
import { SETTINGS_TAB_ID, useTabStore } from '../../stores/tabStore'
import { teamTaskWindowsForSnapshot, useTeamStore } from '../../stores/teamStore'
import { useUIStore } from '../../stores/uiStore'
import { useTranslation } from '../../i18n'
import type { TranslationKey } from '../../i18n/locales/en'
import { UserMessage } from './UserMessage'
import { AssistantMessage } from './AssistantMessage'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallBlock } from './ToolCallBlock'
import { ToolCallGroup, type OpenAgentRunPayload } from './ToolCallGroup'
import type { ActivityStep } from './activityGroupModel'
import { ToolResultBlock } from './ToolResultBlock'
import { PermissionDialog } from './PermissionDialog'
import { AskUserQuestion } from './AskUserQuestion'
import { StreamingIndicator } from './StreamingIndicator'
import { InlineTaskSummary } from './InlineTaskSummary'
import { CurrentTurnChangeCard } from './CurrentTurnChangeCard'
import { AgentTeamsInlineCard } from '../agentTeams/AgentTeamsSummary'
import { MEMBER_AVATARS, memberAccentColor } from '../agentTeams/agentTeamsAvatars'
import {
  getMemberAvatarKey,
  resolveTeamMemberIdentity,
  snapshotWithHistoricalMembers,
} from '../agentTeams/agentTeamsModel'
import {
  buildConversationNavigationItems,
  ConversationNavigator,
  type ConversationNavigationItem,
  type ConversationNavigationMode,
} from './ConversationNavigator'
import type { AgentTaskNotification, BackgroundAgentTask, UIMessage } from '../../types/chat'
import type { TeamDetail, TeamWorkbenchSnapshot } from '../../types/team'
import { formatTokenCount } from '../../lib/formatTokenCount'
import { formatDurationMs, hasRunningBackgroundTasks as hasAnyRunningBackgroundTasks } from '../../lib/backgroundTasks'
import { buildTurnCompletionByMessageId, type TurnCompletion } from '../../lib/turnCompletion'
import { isTouchH5Document } from '../../lib/touchH5'
import {
  EMPTY_TEAM_LIFECYCLE_CURSOR,
  isTeamLifecycleScopedAt,
  updateTeamLifecycleCursor,
} from '../../lib/teamLifecycleScope'
import { Button } from '@/components/ui/Button'
import { ActionDialog, type ActionDialogAction } from '@/components/ui/ActionDialog'
import { clearWindowSelection, getSelectionPopoverPosition, useSelectionPopoverDismiss } from '../../hooks/useSelectionPopoverDismiss'
import {
  getHeightsForSession,
  getMetricsForSession,
  type VirtualRenderItemMetric,
} from './virtualHeightCache'
import {
  notifyConversationFindContentChanged,
  registerConversationFindController,
  type ConversationFindController,
} from '../search/conversationFindBridge'

type ToolCall = Extract<UIMessage, { type: 'tool_use' }>
type ToolResult = Extract<UIMessage, { type: 'tool_result' }>
type MemoryEvent = Extract<UIMessage, { type: 'memory_event' }>
type GoalEvent = Extract<UIMessage, { type: 'goal_event' }>
type BackgroundTaskEvent = Extract<UIMessage, { type: 'background_task' }>
type CompactSummaryEvent = Extract<UIMessage, { type: 'compact_summary' }>

type RenderItem =
  /**
   * One contiguous activity run. `steps` is the run in transcript order —
   * thinking blocks included — and `toolCalls` is the tools-only projection the
   * agent/image/memory renderers still work from.
   */
  | { kind: 'tool_group'; toolCalls: ToolCall[]; steps: ActivityStep[]; id: string }
  | { kind: 'message'; message: UIMessage }
  /**
   * Stands in for the TeamCreate call so the transcript records that this turn
   * handed work to a team, without expanding into the workbench inline.
   */
  | {
      kind: 'team_card'
      id: string
      teamName: string
      startedAt: number
      endedAt?: number
      coordinationToolCalls: ToolCall[]
    }

type RenderModel = {
  renderItems: RenderItem[]
  toolResultMap: Map<string, ToolResult>
  childToolCallsByParent: Map<string, ToolCall[]>
}

type RewindTurnTarget = {
  messageId: string
  userMessageIndex: number
  content: string
  expectedContent: string
  attachments?: Extract<UIMessage, { type: 'user_text' }>['attachments']
}

type BranchableMessageTarget = {
  uiMessageId: string
  transcriptMessageId: string
}

type TurnChangeCardModel = {
  target: RewindTurnTarget
  checkpoint: SessionTurnCheckpoint
  workDir: string | null
  isLatest: boolean
}

const EMPTY_TURN_CHANGE_CARDS: TurnChangeCardModel[] = []

type ChatMessageRole = 'user' | 'assistant'

type ChatSelectionState = {
  text: string
  x: number
  y: number
}

type SelectionPointer = {
  clientX: number
  clientY: number
}

const CHAT_SELECTION_MENU_OFFSET = 10
const CHAT_SELECTION_MENU_WIDTH = 158
const CHAT_SELECTION_MENU_HEIGHT = 44

function getElementForNode(node: Node | null): Element | null {
  if (!node) return null
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
}

function getChatSelectionPosition(
  range: Range,
  root: HTMLElement,
  selection: Selection,
  pointer: { clientX: number; clientY: number },
) {
  return getSelectionPopoverPosition(range, root, {
    menuWidth: CHAT_SELECTION_MENU_WIDTH,
    menuHeight: CHAT_SELECTION_MENU_HEIGHT,
    offset: CHAT_SELECTION_MENU_OFFSET,
    fallbackPointer: pointer,
    selectionFocus: { node: selection.focusNode, offset: selection.focusOffset },
  })
}

function getChatSelectionFromContainer(
  root: HTMLElement | null,
  pointer: SelectionPointer,
): ChatSelectionState | null {
  if (!root) return null
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null

  const range = selection.getRangeAt(0)
  const startElement = getElementForNode(range.startContainer)
  const endElement = getElementForNode(range.endContainer)
  if (!startElement || !endElement || !root.contains(startElement) || !root.contains(endElement)) {
    return null
  }

  const text = selection.toString().trim()
  if (!text) return null

  return {
    ...getChatSelectionPosition(range, root, selection, pointer),
    text,
  }
}

function getSelectionPointer(event: SelectionPointer): SelectionPointer {
  return {
    clientX: event.clientX,
    clientY: event.clientY,
  }
}

function isPrimarySelectionPointer(event: Pick<PointerEvent, 'button' | 'ctrlKey' | 'pointerType'>) {
  return event.button === 0 && !(event.pointerType === 'mouse' && event.ctrlKey)
}

function isKeyboardSelectionKey(event: KeyboardEvent) {
  return event.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)
}

function ChatSelectionMenu({
  selection,
  onAdd,
  popoverRef,
}: {
  selection: ChatSelectionState | null
  onAdd: () => void
  popoverRef: { current: HTMLButtonElement | null }
}) {
  const t = useTranslation()
  if (!selection) return null

  return createPortal(
    <button
      ref={popoverRef}
      type="button"
      onMouseDown={(event) => {
        if (event.button === 0 && !event.ctrlKey) event.preventDefault()
      }}
      onClick={onAdd}
      className="fixed z-[var(--z-popover)] inline-flex h-11 items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-5 text-[15px] font-semibold text-[var(--color-text-primary)] shadow-[var(--shadow-overlay)] transition-colors hover:bg-[var(--color-surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
      style={{ left: selection.x, top: selection.y }}
    >
      <MessageCircle size={21} strokeWidth={2.15} className="shrink-0 text-[var(--color-text-primary)]" aria-hidden="true" />
      <span>{t('chat.addSelectionToChat')}</span>
    </button>,
    document.body,
  )
}

function getCompactSummaryTitle(message: CompactSummaryEvent, t: ReturnType<typeof useTranslation>) {
  if (message.trigger === 'auto') return t('chat.compactSummary.autoTitle')
  if (message.trigger === 'manual') return t('chat.compactSummary.manualTitle')
  if (!message.title || message.title === 'Context compacted' || message.title === 'Conversation compacted') {
    return t('chat.compactSummary.title')
  }
  return message.title
}

function CompactStatusDivider({ message, state }: { message?: CompactSummaryEvent; state: 'compacting' | 'complete' }) {
  const t = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const hasSummary = Boolean(message?.summary?.trim())
  const meta = [
    message?.trigger ? t(`chat.compactSummary.trigger.${message.trigger}` as TranslationKey) : null,
    typeof message?.preTokens === 'number'
      ? t('chat.compactSummary.tokens', { count: formatTokenCount(message.preTokens) })
      : null,
    typeof message?.messagesSummarized === 'number'
      ? t('chat.compactSummary.messages', { count: String(message.messagesSummarized) })
      : null,
  ].filter((item): item is string => Boolean(item))
  const hasDetails = hasSummary || meta.length > 0
  const title = state === 'compacting'
    ? t('chat.compactSummary.compacting')
    : message
      ? getCompactSummaryTitle(message, t)
      : t('chat.compactSummary.title')

  return (
    <section data-testid="compact-status-divider" className="my-4 w-full px-1">
      <div className="flex w-full items-center gap-3">
        <div className="h-px flex-1 bg-[var(--color-border)]" aria-hidden="true" />
        <button
          type="button"
          aria-expanded={hasDetails ? expanded : undefined}
          onClick={() => hasDetails && setExpanded((value) => !value)}
          disabled={!hasDetails}
          className="group inline-flex min-h-8 max-w-[min(78vw,520px)] items-center gap-2 rounded-[var(--radius-md)] px-2.5 py-1 text-[13px] font-semibold text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] disabled:cursor-default disabled:hover:text-[var(--color-text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
        >
          {state === 'compacting' ? (
            <LoaderCircle size={16} strokeWidth={2.1} className="shrink-0 animate-spin text-[var(--color-text-tertiary)]" aria-hidden="true" />
          ) : (
            <FileStack size={16} strokeWidth={2.05} className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
          )}
          <span className="min-w-0 truncate font-medium text-[var(--color-text-primary)]">
            {title}
          </span>
        </button>
        <div className="h-px flex-1 bg-[var(--color-border)]" aria-hidden="true" />
      </div>
      {hasDetails && expanded && (
        <div className="mx-auto mt-1.5 w-full max-w-[620px] rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-3 py-2">
          {meta.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-x-2 gap-y-1 text-[11px] font-medium text-[var(--color-text-tertiary)]">
              {meta.map((item) => <span key={item}>{item}</span>)}
            </div>
          )}
          {message?.summary && (
            <div className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words text-[12px] leading-5 text-[var(--color-text-secondary)]">
              {message.summary}
            </div>
          )}
          </div>
      )}
    </section>
  )
}

function GoalEventCard({ message }: { message: GoalEvent }) {
  const t = useTranslation()
  const [expanded, setExpanded] = useState(true)
  const titleKey = `chat.goalEvent.${message.action === 'status' ? 'statusTitle' : message.action}` as TranslationKey
  const title = t(titleKey) === titleKey ? t('chat.goalEvent.message') : t(titleKey)
  const metaDetails = [
    message.status ? t('chat.goalEvent.statusValue', { value: message.status }) : null,
    message.budget ? t('chat.goalEvent.budget', { value: message.budget }) : null,
    message.continuations ? t('chat.goalEvent.continuations', { value: message.continuations }) : null,
  ].filter((detail): detail is string => detail !== null)

  return (
    <div className="mb-2">
      <div
        data-testid="goal-event-card"
        className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-memory-border)] bg-[var(--color-memory-surface)]"
      >
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
        >
          {expanded ? (
            <ChevronDown size={15} className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
          ) : (
            <ChevronRight size={15} className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
          )}
          <Target size={15} className="shrink-0 text-[var(--color-memory-accent)]" strokeWidth={2.25} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--color-text-primary)]">
            {title}
          </span>
          {message.status ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-[var(--color-text-tertiary)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-memory-accent)]" aria-hidden="true" />
              {message.status}
            </span>
          ) : null}
        </button>

        {expanded ? (
          <div className="border-t border-[var(--color-border)] px-3 py-2.5">
            <div className="space-y-1.5">
              {message.objective ? (
                <div className="line-clamp-2 rounded-[var(--radius-md)] px-2 py-1 text-[12px] leading-5 text-[var(--color-text-secondary)]">
                  {t('chat.goalEvent.objective', { value: message.objective })}
                </div>
              ) : message.message ? (
                <div className="whitespace-pre-wrap rounded-[var(--radius-md)] px-2 py-1 text-[12px] leading-5 text-[var(--color-text-secondary)]">
                  {message.message}
                </div>
              ) : null}
              {metaDetails.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 px-2 pt-0.5">
                  {metaDetails.map((detail) => (
                    <span
                      key={detail}
                      className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-text-secondary)]"
                    >
                      {detail}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function GoalContinuationDivider({ message }: { message: GoalEvent }) {
  const t = useTranslation()
  const reason = message.message?.replace(/^Goal continuing:\s*/i, '').trim()

  return (
    <section data-testid="goal-continuation-divider" className="my-4 w-full px-1">
      <div className="flex w-full items-center gap-3">
        <div className="h-px flex-1 bg-[var(--color-border)]" aria-hidden="true" />
        <div className="inline-flex min-h-8 max-w-[min(78vw,620px)] items-center gap-2 rounded-[var(--radius-md)] px-2.5 py-1 text-[13px] font-medium text-[var(--color-text-secondary)]">
          <Target size={16} strokeWidth={2.1} className="shrink-0 text-[var(--color-memory-accent)]" aria-hidden="true" />
          <span className="shrink-0 font-semibold text-[var(--color-text-primary)]">
            {t('chat.goalEvent.continuing')}
          </span>
          {reason ? (
            <span className="min-w-0 truncate text-[12px] text-[var(--color-text-tertiary)]" title={reason}>
              {reason}
            </span>
          ) : null}
        </div>
        <div className="h-px flex-1 bg-[var(--color-border)]" aria-hidden="true" />
      </div>
    </section>
  )
}

function BackgroundTaskEventCard({ message }: { message: BackgroundTaskEvent }) {
  const t = useTranslation()
  const { task } = message
  const isRunning = task.status === 'running'
  const isFailed = task.status === 'failed'
  const isStopped = task.status === 'stopped'
  const duration = formatDurationMs(task.usage?.durationMs, t)
  const detail = task.summary || task.lastToolName || task.description || task.outputFile || task.taskId
  const label = getBackgroundTaskLabel(task.taskType, t)

  return (
    <div className="mb-2">
      <div
        data-testid="background-task-event-card"
        data-status={task.status}
        className="flex min-w-0 items-start gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-2"
      >
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
          {isRunning ? (
            <LoaderCircle size={15} strokeWidth={2.25} className="animate-spin text-[var(--color-brand)]" aria-hidden="true" />
          ) : isFailed ? (
            <XCircle size={15} strokeWidth={2.25} className="text-[var(--color-error)]" aria-hidden="true" />
          ) : isStopped ? (
            <CircleStop size={15} strokeWidth={2.25} className="text-[var(--color-text-tertiary)]" aria-hidden="true" />
          ) : (
            <CheckCircle2 size={15} strokeWidth={2.25} className="text-[var(--color-success)]" aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <Bot size={14} strokeWidth={2.25} className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
            <span className="shrink-0 text-[12px] font-medium text-[var(--color-text-primary)]">
              {label}
            </span>
            <span className="shrink-0 text-[11px] text-[var(--color-text-tertiary)]">
              {t(`chat.backgroundAgents.status.${task.status}`)}
            </span>
            {task.usage?.totalTokens ? (
              <span className="hidden shrink-0 text-[11px] text-[var(--color-text-tertiary)] sm:inline">
                {t('chat.backgroundAgents.tokens', { count: formatTokenCount(task.usage.totalTokens) })}
              </span>
            ) : null}
            {duration ? (
              <span className="hidden shrink-0 text-[11px] text-[var(--color-text-tertiary)] sm:inline">
                {duration}
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 truncate text-[12px] leading-5 text-[var(--color-text-secondary)]">
            {detail}
          </div>
        </div>
      </div>
    </div>
  )
}

function isAgentBackgroundTaskMessage(message: UIMessage): boolean {
  if (message.type !== 'background_task') return false
  if (
    message.task.taskType === 'local_agent' ||
    message.task.taskType === 'remote_agent' ||
    message.task.taskType === 'dream'
  ) {
    return true
  }
  return /^Agent (?:(?:"[^"]+" )?(completed|was stopped)|(?:"[^"]+" )?failed(?::|$))/.test(
    message.task.summary ?? '',
  )
}

function getBackgroundTaskLabel(
  taskType: string | undefined,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  if (taskType === 'local_bash') return t('chat.backgroundTasks.command')
  if (taskType === 'local_workflow') return t('chat.backgroundTasks.workflow')
  return t('chat.backgroundTasks.task')
}

function SelectableChatMessage({
  sessionId,
  messageId,
  role,
  content,
  children,
}: {
  sessionId?: string | null
  messageId: string
  role: ChatMessageRole
  content: string
  children: ReactNode
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const selectionMenuRef = useRef<HTMLButtonElement>(null)
  const lastSelectionPointerRef = useRef<SelectionPointer | null>(null)
  const selectionGestureEpochRef = useRef(0)
  const selectionStartedInsideRef = useRef(false)
  const selectionUpdateAuthorizedRef = useRef(false)
  const selectionUpdateFrameRef = useRef<number | null>(null)
  const addReference = useWorkspaceChatContextStore((state) => state.addReference)
  const [selectionMenu, setSelectionMenu] = useState<ChatSelectionState | null>(null)
  const t = useTranslation()
  const sourceName = role === 'assistant'
    ? t('chat.assistantMessageReference')
    : t('chat.userMessageReference')

  const cancelPendingSelectionMenuUpdate = useCallback(() => {
    selectionGestureEpochRef.current += 1
    if (selectionUpdateFrameRef.current !== null) {
      window.cancelAnimationFrame(selectionUpdateFrameRef.current)
      selectionUpdateFrameRef.current = null
    }
  }, [])

  useEffect(() => {
    cancelPendingSelectionMenuUpdate()
    setSelectionMenu(null)
    lastSelectionPointerRef.current = null
    selectionStartedInsideRef.current = false
    selectionUpdateAuthorizedRef.current = false
  }, [cancelPendingSelectionMenuUpdate, content, messageId])

  const dismissSelectionMenu = useCallback(() => {
    setSelectionMenu(null)
  }, [])

  const queueSelectionMenuUpdate = useCallback((pointer?: SelectionPointer) => {
    if (pointer) lastSelectionPointerRef.current = pointer

    if (selectionUpdateFrameRef.current !== null) {
      window.cancelAnimationFrame(selectionUpdateFrameRef.current)
    }

    const gestureEpoch = selectionGestureEpochRef.current
    selectionUpdateFrameRef.current = window.requestAnimationFrame(() => {
      if (gestureEpoch !== selectionGestureEpochRef.current) {
        selectionUpdateFrameRef.current = null
        return
      }
      selectionUpdateFrameRef.current = window.requestAnimationFrame(() => {
        selectionUpdateFrameRef.current = null
        if (gestureEpoch !== selectionGestureEpochRef.current || !selectionUpdateAuthorizedRef.current) return

        const root = rootRef.current
        const rootRect = root?.getBoundingClientRect()
        const fallbackPointer = lastSelectionPointerRef.current ?? {
          clientX: (rootRect?.left ?? 0) + 24,
          clientY: (rootRect?.top ?? 0) + 24,
        }
        setSelectionMenu(getChatSelectionFromContainer(root, fallbackPointer))
      })
    })
  }, [])

  useEffect(() => {
    return () => {
      if (selectionUpdateFrameRef.current !== null) {
        window.cancelAnimationFrame(selectionUpdateFrameRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      cancelPendingSelectionMenuUpdate()
      const root = rootRef.current
      const target = event.target
      const startsInside = isPrimarySelectionPointer(event)
        && target instanceof Node
        && Boolean(root?.contains(target))
      selectionStartedInsideRef.current = startsInside
      selectionUpdateAuthorizedRef.current = startsInside
      if (startsInside) lastSelectionPointerRef.current = getSelectionPointer(event)
    }

    const handlePointerUp = (event: PointerEvent) => {
      if (!selectionStartedInsideRef.current || !isPrimarySelectionPointer(event)) return
      selectionStartedInsideRef.current = false
      selectionUpdateAuthorizedRef.current = true
      queueSelectionMenuUpdate(getSelectionPointer(event))
    }

    const handleSelectionChange = () => {
      if (selectionStartedInsideRef.current || !selectionUpdateAuthorizedRef.current) return
      queueSelectionMenuUpdate()
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      if (!isKeyboardSelectionKey(event)) return
      cancelPendingSelectionMenuUpdate()
      lastSelectionPointerRef.current = null
      selectionStartedInsideRef.current = false
      selectionUpdateAuthorizedRef.current = true
      queueSelectionMenuUpdate()
    }

    const handleContextMenu = () => {
      cancelPendingSelectionMenuUpdate()
      selectionStartedInsideRef.current = false
      selectionUpdateAuthorizedRef.current = false
      setSelectionMenu(null)
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('pointerup', handlePointerUp, true)
    document.addEventListener('selectionchange', handleSelectionChange)
    document.addEventListener('keyup', handleKeyUp, true)
    document.addEventListener('contextmenu', handleContextMenu, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('pointerup', handlePointerUp, true)
      document.removeEventListener('selectionchange', handleSelectionChange)
      document.removeEventListener('keyup', handleKeyUp, true)
      document.removeEventListener('contextmenu', handleContextMenu, true)
    }
  }, [cancelPendingSelectionMenuUpdate, queueSelectionMenuUpdate])

  useSelectionPopoverDismiss({
    active: Boolean(selectionMenu),
    popoverRef: selectionMenuRef,
    onDismiss: dismissSelectionMenu,
  })

  const addCurrentSelectionToChat = useCallback(() => {
    if (!sessionId || !selectionMenu) return
    addReference(sessionId, {
      kind: 'chat-selection',
      path: `chat://${role}/${messageId}`,
      name: sourceName,
      quote: selectionMenu.text,
      sourceRole: role,
      messageId,
    })
    setSelectionMenu(null)
    clearWindowSelection()
  }, [addReference, messageId, role, selectionMenu, sessionId, sourceName])

  return (
    <div
      ref={rootRef}
      data-chat-selectable-message={role}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setSelectionMenu(null)
      }}
    >
      {children}
      <ChatSelectionMenu selection={selectionMenu} onAdd={addCurrentSelectionToChat} popoverRef={selectionMenuRef} />
    </div>
  )
}

function appendChildToolCall(
  childToolCallsByParent: Map<string, ToolCall[]>,
  parentToolUseId: string,
  toolCall: ToolCall,
) {
  const siblings = childToolCallsByParent.get(parentToolUseId)
  if (siblings) {
    siblings.push(toolCall)
  } else {
    childToolCallsByParent.set(parentToolUseId, [toolCall])
  }
}

function hasTeamMessageRouting(value: unknown): boolean {
  if (typeof value === 'string') {
    try {
      return hasTeamMessageRouting(JSON.parse(value))
    } catch {
      return false
    }
  }
  if (Array.isArray(value)) return value.some(hasTeamMessageRouting)
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const routing = record.routing
  if (routing && typeof routing === 'object') {
    const route = routing as Record<string, unknown>
    if (typeof route.sender === 'string' && typeof route.target === 'string') return true
  }
  return 'content' in record && hasTeamMessageRouting(record.content)
}

function getSendMessageTarget(value: unknown): string | null {
  if (typeof value === 'string') {
    try {
      return getSendMessageTarget(JSON.parse(value))
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const target = (value as Record<string, unknown>).to
  return typeof target === 'string' ? target : null
}

function isTeamCoordinationSendMessage(
  input: unknown,
  result: unknown,
  teamMemberNames: ReadonlySet<string> | undefined,
  allowRosterFallback: boolean,
): boolean {
  if (hasTeamMessageRouting(result)) return true
  if (!allowRosterFallback) return false
  const target = getSendMessageTarget(input)
  return target === '*' || Boolean(target && teamMemberNames?.has(target))
}

function parseRecordValue(value: unknown): Record<string, unknown> | null {
  if (isRecordValue(value)) return value
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text.startsWith('{')) return null
  try {
    const parsed = JSON.parse(text) as unknown
    return isRecordValue(parsed) ? parsed : null
  } catch {
    return null
  }
}

function nestedStringField(value: unknown, field: string): string {
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = nestedStringField(item, field)
      if (nested) return nested
    }
    return ''
  }
  const record = parseRecordValue(value)
  if (!record) return ''
  const direct = record[field]
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  for (const child of [record.content, record.text]) {
    const nested = nestedStringField(child, field)
    if (nested) return nested
  }
  return ''
}

function explicitSuccessFlag(value: unknown): boolean | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = explicitSuccessFlag(item)
      if (nested !== undefined) return nested
    }
    return undefined
  }
  const record = parseRecordValue(value)
  if (!record) return undefined
  if (typeof record.success === 'boolean') return record.success
  if ('content' in record) return explicitSuccessFlag(record.content)
  if ('text' in record) return explicitSuccessFlag(record.text)
  return undefined
}

function canSummarizeCoordinationResult(result: ToolResult | undefined): boolean {
  return !result || (!result.isError && explicitSuccessFlag(result.content) !== false)
}

function lifecycleToolSucceeded(result: ToolResult | undefined): boolean {
  return Boolean(result) && canSummarizeCoordinationResult(result)
}

function teamNameFromCreate(toolCall: ToolCall, result: ToolResult | undefined): string {
  const input = parseRecordValue(toolCall.input)
  // TeamCreate can uniquify a requested name. The successful result owns the
  // durable identity that the workbench will expose.
  for (const value of [nestedStringField(result?.content, 'team_name'), input?.team_name]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return 'Agent Teams'
}

function isExplicitTeamAgent(
  input: unknown,
  result: ToolResult | undefined,
  teamActive: boolean,
): boolean {
  const inputRecord = parseRecordValue(input)
  const inputTeamName = inputRecord?.team_name
  if (typeof inputTeamName === 'string' && inputTeamName.trim()) return true
  const inputName = inputRecord?.name
  if (teamActive && typeof inputName === 'string' && inputName.trim()) return true

  if (nestedStringField(result?.content, 'status') === 'teammate_spawned') return true
  if (typeof result?.content !== 'string') return false
  return /^\s*team_name:\s*\S+/m.test(result.content) && /^\s*name:\s*\S+/m.test(result.content)
}

export function buildRenderModel(
  messages: UIMessage[],
  activeAskUserQuestionToolUseId?: string | null,
  options: {
    hideTeamCoordinationTools?: boolean
    teamMemberNames?: ReadonlySet<string>
    teamTaskWindows?: Array<{ startedAt: number; endedAt?: number }>
    teamName?: string
    teamStartedAt?: number
  } = {},
): RenderModel {
  const items: RenderItem[] = []
  const toolResultMap = new Map<string, ToolResult>()
  const childToolCallsByParent = new Map<string, ToolCall[]>()
  const toolUseIds = new Set<string>()
  const lastUnresolvedAskUserQuestionIndexByToolUseId = new Map<string, number>()
  let lastUnresolvedAskUserQuestionIndex: number | null = null
  let transcriptTeamCursor = EMPTY_TEAM_LIFECYCLE_CURSOR
  let activeTeamCard: Extract<RenderItem, { kind: 'team_card' }> | undefined
  let pendingSteps: ActivityStep[] = []
  let pendingToolCount = 0
  let pendingAgentCount = 0

  const flushGroup = () => {
    if (pendingSteps.length === 0) return
    const steps = pendingSteps
    const toolCount = pendingToolCount
    pendingSteps = []
    pendingToolCount = 0
    pendingAgentCount = 0

    if (toolCount === 0) {
      // A run of pure reasoning has nothing to summarize into a header, so the
      // thinking blocks keep their standalone inline form.
      for (const step of steps) {
        if (step.kind === 'thinking') items.push({ kind: 'message', message: step.message })
      }
      return
    }

    const toolCalls = steps.flatMap((step) => (step.kind === 'tool' ? [step.toolCall] : []))
    items.push({
      kind: 'tool_group',
      toolCalls,
      steps,
      // Keyed off the first tool call, not the first step: a thinking block that
      // later gains tools must not remount the group under the reader.
      id: `group-${toolCalls[0]!.id}`,
    })
  }
  const appendRootToolCall = (toolCall: ToolCall) => {
    const nextIsAgent = toolCall.toolName === 'Agent'
    // Agent runs render as their own dispatch cards, so they never mix with
    // ordinary steps — including the thinking that preceded the dispatch.
    const pendingIsAgentGroup = pendingToolCount > 0 && pendingAgentCount === pendingToolCount
    const pendingBlocksAgent = nextIsAgent && pendingSteps.length > pendingAgentCount

    if (pendingBlocksAgent || (pendingToolCount > 0 && pendingIsAgentGroup !== nextIsAgent)) {
      flushGroup()
    }
    pendingSteps.push({ kind: 'tool', toolCall })
    pendingToolCount += 1
    if (nextIsAgent) pendingAgentCount += 1
  }
  const appendThinking = (message: Extract<UIMessage, { type: 'thinking' }>) => {
    if (pendingToolCount > 0 && pendingAgentCount === pendingToolCount) flushGroup()
    pendingSteps.push({ kind: 'thinking', message })
  }
  const ensureTeamCardForCoordination = (
    message: ToolCall,
    result: ToolResult | undefined,
  ) => {
    const input = parseRecordValue(message.input)
    const outputTeamName = nestedStringField(result?.content, 'team_name')
    const inputTeamName = typeof input?.team_name === 'string'
      ? input.team_name.trim()
      : ''
    const explicitTeamName = outputTeamName || inputTeamName
    if (
      activeTeamCard &&
      (!explicitTeamName || activeTeamCard.teamName === explicitTeamName)
    ) return activeTeamCard
    if (activeTeamCard) activeTeamCard = undefined

    const scopedTeamName = options.teamName?.trim() || ''
    const teamName = explicitTeamName || scopedTeamName
    if (!teamName) return undefined
    const usesDurableScope = !explicitTeamName || explicitTeamName === scopedTeamName

    flushGroup()
    activeTeamCard = {
      kind: 'team_card',
      id: `team-card-scope-${message.id}`,
      teamName,
      startedAt: usesDurableScope
        ? options.teamStartedAt ?? message.timestamp
        : message.timestamp,
      coordinationToolCalls: [],
    }
    items.push(activeTeamCard)
    return activeTeamCard
  }

  for (const msg of messages) {
    if (msg.type === 'tool_use') {
      toolUseIds.add(msg.toolUseId)
    }
    if (msg.type === 'tool_result') {
      toolResultMap.set(msg.toolUseId, msg)
    }
  }
  const hasTeamLifecycleEvidence = Boolean(options.teamTaskWindows?.length) || messages.some((msg) => (
    msg.type === 'tool_use' &&
    (msg.toolName === 'TeamCreate' || msg.toolName === 'TeamDelete') &&
    lifecycleToolSucceeded(toolResultMap.get(msg.toolUseId))
  ))
  messages.forEach((msg, index) => {
    if (
      msg.type === 'tool_use' &&
      msg.toolName === 'AskUserQuestion' &&
      !toolResultMap.has(msg.toolUseId)
    ) {
      lastUnresolvedAskUserQuestionIndexByToolUseId.set(msg.toolUseId, index)
      lastUnresolvedAskUserQuestionIndex = index
    }
  })

  for (const msg of messages) {
    if (msg.type === 'assistant_text' && !msg.content.trim()) {
      continue
    }
    if (isAgentBackgroundTaskMessage(msg)) {
      continue
    }

    if (msg.type === 'tool_result' && toolUseIds.has(msg.toolUseId)) {
      continue
    }
    if (msg.type === 'tool_result' && msg.parentToolUseId && toolUseIds.has(msg.parentToolUseId)) {
      continue
    }

    if (msg.type === 'tool_use') {
      if (msg.parentToolUseId && toolUseIds.has(msg.parentToolUseId)) {
        flushGroup()
        appendChildToolCall(childToolCallsByParent, msg.parentToolUseId, msg)
        continue
      }
      const toolResult = toolResultMap.get(msg.toolUseId)
      let summarizedTeamDelete = false
      if (options.hideTeamCoordinationTools) {
        if (msg.toolName === 'TeamCreate' && lifecycleToolSucceeded(toolResult)) {
          transcriptTeamCursor = updateTeamLifecycleCursor(
            true,
            msg.timestamp,
          )
        } else if (msg.toolName === 'TeamDelete' && lifecycleToolSucceeded(toolResult)) {
          transcriptTeamCursor = updateTeamLifecycleCursor(
            false,
            msg.timestamp,
          )
          const deletedTeamCard = ensureTeamCardForCoordination(msg, toolResult)
          if (deletedTeamCard) {
            deletedTeamCard.endedAt = msg.timestamp
            deletedTeamCard.coordinationToolCalls.push(msg)
            summarizedTeamDelete = true
          }
          // A later lifecycle can be present only in the durable workbench
          // window after transcript compaction. Do not attach that run's
          // coordination audit to the card from the lifecycle just deleted.
          activeTeamCard = undefined
        }

        const isTeamScopedAtMessage = isTeamLifecycleScopedAt(
          msg.timestamp,
          transcriptTeamCursor,
          options.teamTaskWindows,
        )
        const isTeamTask =
          (msg.toolName === 'TaskCreate' || msg.toolName === 'TaskUpdate') &&
          isTeamScopedAtMessage
        const explicitTeamAgent = msg.toolName === 'Agent' &&
          isExplicitTeamAgent(msg.input, toolResult, isTeamScopedAtMessage)
        const ambiguousTeamAgent = msg.toolName === 'Agent' &&
          isTeamScopedAtMessage &&
          !explicitTeamAgent &&
          msg.isPending === true
        const isTeamAgent = msg.toolName === 'Agent' && (
          explicitTeamAgent
        )
        const isTeamMessage = msg.toolName === 'SendMessage' && (
          isTeamScopedAtMessage ||
          isTeamCoordinationSendMessage(
            msg.input,
            toolResult?.content,
            options.teamMemberNames,
            !hasTeamLifecycleEvidence,
          )
        )

        // During an active Team lifecycle, a streamed Agent without
        // teammate identity is not yet classifiable: it can settle as a direct
        // SubAgent if `name` stays absent, or as a teammate once that identity
        // arrives. Keep it out of both projections during that partial state.
        if (ambiguousTeamAgent) continue

        // These records remain untouched in `messages` and `toolResultMap`.
        // The lead transcript projects them through the inline team card while
        // the workbench owns the roster, DAG, and communication presentation.
        // A failed coordination call stays visible because it changes what the
        // turn means and is not represented by successful workbench state.
        if (
          (isTeamTask || isTeamAgent || isTeamMessage) &&
          canSummarizeCoordinationResult(toolResult)
        ) {
          const teamCard = ensureTeamCardForCoordination(msg, toolResult)
          if (teamCard) {
            teamCard.coordinationToolCalls.push(msg)
            continue
          }
        }
      }
      if (summarizedTeamDelete) continue
      // The raw TeamCreate call and its JSON result say nothing a reader can
      // use; the team card in its place links to the workbench that does.
      if (
        options.hideTeamCoordinationTools &&
        msg.toolName === 'TeamCreate' &&
        canSummarizeCoordinationResult(toolResult)
      ) {
        flushGroup()
        activeTeamCard = {
          kind: 'team_card',
          id: `team-card-${msg.id}`,
          teamName: teamNameFromCreate(msg, toolResult),
          startedAt: msg.timestamp,
          coordinationToolCalls: [],
        }
        items.push(activeTeamCard)
        continue
      }
      if (msg.toolName === 'AskUserQuestion') {
        const isResolved = toolResultMap.has(msg.toolUseId)
        const lastUnresolvedIndex = lastUnresolvedAskUserQuestionIndexByToolUseId.get(msg.toolUseId)
        if (!isResolved && lastUnresolvedIndex !== undefined && messages[lastUnresolvedIndex] !== msg) {
          continue
        }
        if (
          !isResolved &&
          activeAskUserQuestionToolUseId &&
          msg.toolUseId !== activeAskUserQuestionToolUseId
        ) {
          continue
        }
        if (
          !isResolved &&
          !activeAskUserQuestionToolUseId &&
          lastUnresolvedAskUserQuestionIndex !== null &&
          messages[lastUnresolvedAskUserQuestionIndex] !== msg
        ) {
          continue
        }
        flushGroup()
        items.push({ kind: 'message', message: msg })
      } else {
        appendRootToolCall(msg)
      }
    } else if (msg.type === 'thinking') {
      appendThinking(msg)
    } else if (msg.type === 'background_task' && msg.task.status === 'completed') {
      // The activity panel already lists every background task — agent-like ones
      // under SubAgents, the rest under Background Tasks — with live status and a
      // way into the full run. A card here repeating a finished one just buries
      // the conversation under status reports, and a long team session emits
      // dozens. Anything that did NOT finish cleanly still gets a card: a failure
      // or a stop changes what the turn means, and the panel can be closed.
      continue
    } else {
      flushGroup()
      items.push({ kind: 'message', message: msg })
    }
  }

  flushGroup()
  return { renderItems: items, toolResultMap, childToolCallsByParent }
}

function coordinationToolSummary(toolCall: ToolCall): string | null {
  const input = parseRecordValue(toolCall.input)
  if (!input) return null
  const values = toolCall.toolName === 'TaskCreate'
    ? [input.subject]
    : toolCall.toolName === 'TaskUpdate'
      ? [input.taskId, input.status, input.owner]
      : toolCall.toolName === 'Agent'
        ? [input.name, input.description]
        : toolCall.toolName === 'SendMessage'
          ? [input.to, input.message]
          : []
  const summary = values
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .join(' · ')
  return summary || null
}

function TeamCoordinationAudit({ toolCalls }: { toolCalls: ToolCall[] }) {
  const t = useTranslation()
  if (toolCalls.length === 0) return null

  return (
    <details
      data-testid="agent-teams-coordination-audit"
      className="mx-2 border-x border-b border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-3 py-1.5 text-[11px] text-[var(--color-text-secondary)]"
    >
      <summary className="cursor-pointer select-none font-medium text-[var(--color-text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]">
        {t('agentTeams.inline.coordination', { count: toolCalls.length })}
      </summary>
      <ol className="mt-2 space-y-1 border-t border-[var(--color-border)] pt-2">
        {toolCalls.map((toolCall) => {
          const summary = coordinationToolSummary(toolCall)
          return (
            <li key={toolCall.toolUseId} className="flex min-w-0 items-start gap-2">
              <code className="shrink-0 font-mono text-[10px] font-semibold text-[var(--color-text-tertiary)]">
                {toolCall.toolName}
              </code>
              {summary ? <span className="min-w-0 break-words">{summary}</span> : null}
            </li>
          )
        })}
      </ol>
    </details>
  )
}

function teamTimestamp(value: string | number | undefined): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (!value) return undefined
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function snapshotForTeamCard(
  snapshot: TeamWorkbenchSnapshot | undefined,
  item: Extract<RenderItem, { kind: 'team_card' }>,
): TeamWorkbenchSnapshot | undefined {
  if (!snapshot || snapshot.team.name !== item.teamName) return undefined
  const startedAt = teamTimestamp(snapshot.team.createdAt)
  if (startedAt === undefined) return snapshot
  if (item.endedAt !== undefined && item.endedAt < startedAt) return undefined

  // The TeamCreate tool and server lifecycle event are emitted by separate
  // transports, so allow a small clock/order gap while still refusing to bind
  // an older card to a newer incarnation that reused the same team name.
  return Math.abs(item.startedAt - startedAt) <= 5_000 ? snapshot : undefined
}

function isTurnResponseMessage(message: UIMessage) {
  return (
    message.type === 'assistant_text' ||
    message.type === 'tool_use' ||
    message.type === 'tool_result' ||
    (message.type === 'background_task' && !isAgentBackgroundTaskMessage(message)) ||
    message.type === 'error' ||
    message.type === 'task_summary'
  )
}

function getBranchableMessageTargets(messages: UIMessage[]): Map<string, BranchableMessageTarget> {
  const branchableTargets = new Map<string, BranchableMessageTarget>()
  let currentTurnCandidates: Array<Extract<UIMessage, { type: 'user_text' | 'assistant_text' }>> = []
  let hasResponseForCurrentTurn = false

  const markCurrentTurnBranchable = () => {
    if (!hasResponseForCurrentTurn) return
    for (const candidate of currentTurnCandidates) {
      if (!candidate.transcriptMessageId) continue
      branchableTargets.set(candidate.id, {
        uiMessageId: candidate.id,
        transcriptMessageId: candidate.transcriptMessageId,
      })
    }
  }

  for (const message of messages) {
    if (message.type === 'user_text') {
      markCurrentTurnBranchable()
      currentTurnCandidates = []
      hasResponseForCurrentTurn = false
      if (!message.pending && message.transcriptMessageId) {
        currentTurnCandidates = [message]
      }
      continue
    }

    if (currentTurnCandidates.length === 0) continue

    if (isTurnResponseMessage(message)) {
      hasResponseForCurrentTurn = true
    }

    if (message.type === 'assistant_text' && message.transcriptMessageId) {
      currentTurnCandidates.push(message)
    }
  }

  markCurrentTurnBranchable()
  return branchableTargets
}

export function getCompletedTurnTargets(messages: UIMessage[]): RewindTurnTarget[] {
  let userMessageIndex = -1
  const completedTurns: RewindTurnTarget[] = []
  let currentTarget: RewindTurnTarget | null = null
  let hasResponseForCurrentTarget = false

  for (const message of messages) {
    if (message.type === 'user_text' && !message.pending) {
      if (currentTarget && hasResponseForCurrentTarget) {
        completedTurns.push(currentTarget)
      }
      userMessageIndex += 1
      currentTarget = {
        messageId: message.id,
        userMessageIndex,
        content: message.content,
        expectedContent: message.modelContent ?? message.content,
        attachments: message.attachments,
      }
      hasResponseForCurrentTarget = false
      continue
    }

    if (currentTarget && isTurnResponseMessage(message)) {
      hasResponseForCurrentTarget = true
    }
  }

  if (currentTarget && hasResponseForCurrentTarget) {
    completedTurns.push(currentTarget)
  }

  return completedTurns
}

export function getLatestCompletedTurnTarget(messages: UIMessage[]): RewindTurnTarget | null {
  const completedTurns = getCompletedTurnTargets(messages)
  return completedTurns.length > 0 ? completedTurns[completedTurns.length - 1] ?? null : null
}

function buildTurnCardInsertionMap(
  renderItems: RenderItem[],
  turnChangeCards: TurnChangeCardModel[],
) {
  const lastResponseIndexByTurnId = new Map<string, number>()
  const userIndexByTurnId = new Map<string, number>()
  let activeTurnId: string | null = null

  renderItems.forEach((item, index) => {
    if (item.kind === 'message' && item.message.type === 'user_text' && !item.message.pending) {
      activeTurnId = item.message.id
      userIndexByTurnId.set(activeTurnId, index)
      return
    }

    if (activeTurnId) {
      lastResponseIndexByTurnId.set(activeTurnId, index)
    }
  })

  const cardsByRenderIndex = new Map<number, TurnChangeCardModel[]>()
  turnChangeCards.forEach((card) => {
    // An unverified-only turn has no structured files to list, but still needs
    // the card for conversation rewind and the warning about changes left on disk.
    if (
      card.checkpoint.code.filesChanged.length === 0 &&
      (card.checkpoint.unverifiedChangeSources?.length ?? 0) === 0
    ) return
    const renderIndex =
      lastResponseIndexByTurnId.get(card.target.messageId) ??
      userIndexByTurnId.get(card.target.messageId)
    if (renderIndex === undefined) return
    const existing = cardsByRenderIndex.get(renderIndex)
    if (existing) {
      existing.push(card)
    } else {
      cardsByRenderIndex.set(renderIndex, [card])
    }
  })

  return cardsByRenderIndex
}

/**
 * Map each render item to the REAL changed files of the turn it belongs to, so an
 * assistant message can anchor its output chips on files that were actually
 * written this turn instead of guessing paths from the prose. Items are attributed
 * to the most recent preceding non-pending user message (the turn boundary).
 */
function buildChangedFilesByRenderIndex(
  renderItems: RenderItem[],
  turnChangeCards: TurnChangeCardModel[],
): Map<number, string[]> {
  const filesByTurnId = new Map<string, string[]>()
  for (const card of turnChangeCards) {
    filesByTurnId.set(card.target.messageId, card.checkpoint.code.filesChanged)
  }
  if (filesByTurnId.size === 0) return new Map()

  const filesByRenderIndex = new Map<number, string[]>()
  let activeTurnId: string | null = null
  renderItems.forEach((item, index) => {
    if (item.kind === 'message' && item.message.type === 'user_text' && !item.message.pending) {
      activeTurnId = item.message.id
      return
    }
    if (activeTurnId) {
      const files = filesByTurnId.get(activeTurnId)
      if (files) filesByRenderIndex.set(index, files)
    }
  })

  return filesByRenderIndex
}

/**
 * Where a render item sits inside its turn, which is what decides its spacing.
 *
 * `none` is the user bubble: it opens an exchange, so it carries the large gap
 * that separates one turn from the last. Everything else is a response and takes
 * the tight within-turn gap. The names still read positionally because the
 * boundaries are what the spacing is derived from — see `.chat-turn-rail*`,
 * which owns the actual values and deliberately draws nothing.
 */
export type TurnRailPosition = 'none' | 'start' | 'middle' | 'end' | 'solo'

/**
 * Rail position for every render item, indexed alongside `renderItems`.
 *
 * Deliberately breaks on EVERY `user_text`, unlike the three turn walks above
 * (`buildTurnCardInsertionMap`, `buildChangedFilesByRenderIndex`,
 * `getBranchableMessageTargets`) which skip `pending` ones. Those answer "which
 * turn owns this checkpoint", and a member session's pending echo must not steal
 * ownership. This answers "where does the line stop", and a pending message still
 * renders as a visible right-aligned bubble (see the `user_text` case in
 * `MessageBlock`) — a bubble mid-column is a break whatever it means for
 * attribution. Do not "fix" this to match the others.
 */
export function buildTurnRailPositions(
  renderItems: RenderItem[],
  options: { hasTrailingStreamingItem?: boolean } = {},
): TurnRailPosition[] {
  const positions: TurnRailPosition[] = new Array<TurnRailPosition>(renderItems.length).fill('none')
  let runStart = -1

  /** Label the open run [runStart, endExclusive). `continues` = the streaming
   *  block will pick the line up below, so the run must not cap itself. */
  const closeRun = (endExclusive: number, continues: boolean) => {
    if (runStart < 0) return
    const last = endExclusive - 1
    for (let index = runStart; index <= last; index += 1) {
      positions[index] = index === runStart ? 'start' : 'middle'
    }
    if (!continues) positions[last] = runStart === last ? 'solo' : 'end'
    runStart = -1
  }

  renderItems.forEach((item, index) => {
    if (item.kind === 'message' && item.message.type === 'user_text') {
      closeRun(index, false)
      positions[index] = 'none'
      return
    }
    if (runStart < 0) runStart = index
  })

  closeRun(renderItems.length, Boolean(options.hasTrailingStreamingItem))

  return positions
}

/**
 * Rail position for the live streaming reply, which renders outside the virtual
 * list. It caps whatever run the transcript left open, or stands alone when the
 * user has just sent and nothing else has landed yet.
 */
export function trailingStreamingRailPosition(positions: TurnRailPosition[]): TurnRailPosition {
  const last = positions[positions.length - 1]
  return last === 'start' || last === 'middle' ? 'end' : 'solo'
}

function getApiErrorMessage(error: unknown) {
  return error instanceof ApiError
    ? typeof error.body === 'object' && error.body && 'message' in error.body
      ? String((error.body as { message: unknown }).message)
      : error.message
    : error instanceof Error
      ? error.message
      : String(error)
}

function isSessionTurnCheckpoint(value: unknown): value is SessionTurnCheckpoint {
  if (!value || typeof value !== 'object') return false
  const checkpoint = value as Partial<SessionTurnCheckpoint>
  return (
    Boolean(checkpoint.target) &&
    typeof checkpoint.target?.targetUserMessageId === 'string' &&
    typeof checkpoint.target?.userMessageIndex === 'number' &&
    Boolean(checkpoint.code) &&
    typeof checkpoint.code?.available === 'boolean' &&
    Array.isArray(checkpoint.code?.filesChanged) &&
    (checkpoint.restoreAvailable === undefined ||
      typeof checkpoint.restoreAvailable === 'boolean') &&
    (checkpoint.unverifiedChangeSources === undefined ||
      (Array.isArray(checkpoint.unverifiedChangeSources) &&
        checkpoint.unverifiedChangeSources.every((source) => typeof source === 'string')))
  )
}

function normalizeTurnCheckpoints(response: unknown): SessionTurnCheckpoint[] {
  if (!response || typeof response !== 'object') return []
  const checkpoints = (response as { checkpoints?: unknown }).checkpoints
  if (!Array.isArray(checkpoints)) return []
  return checkpoints.filter(isSessionTurnCheckpoint)
}

function memoryFileLabel(path: string) {
  const normalized = path.replace(/\\/g, '/')
  return normalized.split('/').pop() || normalized
}

function openMemorySettings(path?: string) {
  const ui = useUIStore.getState()
  if (path) ui.setPendingMemoryPath(path)
  ui.setPendingSettingsTab('memory')
  useTabStore.getState().openTab(SETTINGS_TAB_ID, 'Settings', 'settings')
}

function MemoryEventCard({ message }: { message: MemoryEvent }) {
  const t = useTranslation()
  const visibleFiles = message.files.slice(0, 3)
  const hiddenCount = Math.max(0, message.files.length - visibleFiles.length)

  return (
    <div className="mb-3 flex justify-center px-3">
      <div className="w-full max-w-2xl rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3.5 py-3 text-xs shadow-[var(--shadow-card)]">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-brand)]">
            <BookMarked size={15} aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-medium text-[var(--color-text-primary)]">
                {t('chat.memorySavedTitle', { count: message.files.length })}
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => openMemorySettings(message.files[0]?.path)}
                icon={<Settings size={13} aria-hidden="true" />}
              >
                {t('chat.memoryOpenSettings')}
              </Button>
            </div>
            {message.message ? (
              <div className="mt-1 text-[var(--color-text-tertiary)]">{message.message}</div>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {visibleFiles.map((file) => (
                <span
                  key={file.path}
                  title={file.path}
                  className="max-w-full truncate rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-mono text-[10px] text-[var(--color-text-secondary)]"
                >
                  {memoryFileLabel(file.path)}
                </span>
              ))}
              {hiddenCount > 0 ? (
                <span className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-mono text-[10px] text-[var(--color-text-tertiary)]">
                  {t('chat.memoryMoreFiles', { count: hiddenCount })}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

type MessageListProps = {
  sessionId?: string | null
  compact?: boolean
  mobileLayout?: boolean
  onOpenAgentRun?: (payload: OpenAgentRunPayload) => void
}

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 48
const SCROLL_BOTTOM_SENTINEL = 1_000_000_000
const MAX_SCROLL_SNAPSHOTS = 100
const VIRTUALIZE_MIN_RENDER_ITEMS = 120
const VIRTUALIZE_MIN_CONTENT_CHARS = 120_000
// Touch-H5 disables content-visibility paint skipping for selection
// correctness (globals.css), which makes virtualization the only paint bound
// for long transcripts there — so it kicks in at half the desktop thresholds.
const TOUCH_H5_VIRTUALIZE_MIN_RENDER_ITEMS = 60
const TOUCH_H5_VIRTUALIZE_MIN_CONTENT_CHARS = 60_000
const VIRTUAL_OVERSCAN_PX = 1200
const VIRTUAL_DEFAULT_VIEWPORT_HEIGHT = 720
/** Floor for both estimated AND measured item heights, so it has to sit under
 *  the shortest real item — a collapsed activity line at ~34px. Set above that
 *  and every such row is recorded too tall forever: the clamp is applied to the
 *  ResizeObserver's reading too, so no amount of measuring corrects it. */
const VIRTUAL_MIN_ITEM_HEIGHT = 24
const VIRTUAL_MAX_ITEM_HEIGHT = 24_000
// Chromium on Windows can report up to 2px ResizeObserver oscillations at
// fractional DPI. Keep the last accepted value as the baseline so cumulative
// real growth still crosses the band; only the back-and-forth noise is dropped.
const RESIZE_OBSERVER_JITTER_MAX_DELTA_PX = 2
// Native scroll anchoring and fractional DPI can leave the WebView a few CSS
// pixels shy of its computed bottom. Rewriting that correction on every live
// delta makes the two owners fight and turns the rounding into visible bounce.
const LIVE_FOLLOW_BOTTOM_GAP_TOLERANCE_PX = 4
const USER_SCROLL_INTENT_WINDOW_MS = 500
/**
 * Backstop for the disclosure suppression window. The window normally ends at
 * the next animation frame (see `handleDisclosureToggle`); this only bounds it
 * if that frame never runs, so a dropped rAF cannot leave follow off forever.
 */
const DISCLOSURE_FOLLOW_SUPPRESS_MS = 400
/** Collapse toggles inside the transcript, matched via event delegation. */
const CHAT_DISCLOSURE_SELECTOR = '[data-chat-disclosure="true"]'
const CONVERSATION_NAVIGATION_MIN_ITEMS = 4
const CONVERSATION_NAVIGATION_FULL_MIN_WIDTH_PX = 960
const CONVERSATION_NAVIGATION_COMPACT_MIN_WIDTH_PX = 560
const STREAMING_ASSISTANT_NAVIGATION_KEY = 'streaming-assistant-message'
const EMPTY_MESSAGES: UIMessage[] = []
const EMPTY_AGENT_TASK_NOTIFICATIONS: Record<string, AgentTaskNotification> = {}
const CHAT_SCROLL_AREA_CLASS = [
  'chat-scroll-area',
  '[scrollbar-width:auto]',
  '[scrollbar-color:color-mix(in_srgb,var(--color-outline)_72%,transparent)_transparent]',
  '[&::-webkit-scrollbar]:w-2.5',
  '[&::-webkit-scrollbar-track]:bg-transparent',
  '[&::-webkit-scrollbar-thumb]:rounded-full',
  '[&::-webkit-scrollbar-thumb]:border-[3px]',
  '[&::-webkit-scrollbar-thumb]:border-transparent',
  '[&::-webkit-scrollbar-thumb]:bg-[color-mix(in_srgb,var(--color-outline)_74%,transparent)]',
  '[&::-webkit-scrollbar-thumb]:bg-clip-content',
  '[&::-webkit-scrollbar-thumb:hover]:border-2',
  '[&::-webkit-scrollbar-thumb:hover]:bg-[color-mix(in_srgb,var(--color-outline)_90%,transparent)]',
].join(' ')
const CHAT_RENDER_ITEM_CLASS = [
  'chat-render-item',
].join(' ')

/**
 * Carries the turn rail. Kept separate from `chat-render-item` on purpose: the
 * streaming reply and the turn status line also sit on the rail but are not
 * transcript items, and `.chat-render-item` is counted exactly in tests.
 */
const CHAT_TURN_RAIL_CLASS = 'chat-turn-rail'

function turnRailClass(position: TurnRailPosition): string {
  return `${CHAT_TURN_RAIL_CLASS} chat-turn-rail--${position}`
}

export function isRenderItemFullyVisibleInChatScroller(renderItem: HTMLElement) {
  const scroller = renderItem.closest<HTMLElement>('.chat-scroll-area')
  if (!scroller) return false

  const itemRect = renderItem.getBoundingClientRect()
  const scrollerRect = scroller.getBoundingClientRect()
  return itemRect.top >= scrollerRect.top &&
    itemRect.bottom <= scrollerRect.bottom &&
    itemRect.left >= scrollerRect.left &&
    itemRect.right <= scrollerRect.right
}

type SessionScrollSnapshot = {
  scrollTop: number
  wasAtBottom: boolean
}

type VirtualViewport = {
  scrollTop: number
  viewportHeight: number
}

type VirtualTranscriptItem = {
  item: RenderItem
  index: number
}

type VirtualTranscriptWindow = {
  enabled: boolean
  beforeHeight: number
  afterHeight: number
  items: VirtualTranscriptItem[]
  offsets: number[]
  totalHeight: number
}

type ConversationFindMatch = {
  renderIndex: number
  renderItemKey: string
  occurrenceIndex: number
  query: string
}

const MAX_CONVERSATION_FIND_MATCHES = 1_000
const CONVERSATION_FIND_CONTENT_REFRESH_MS = 80

const sessionScrollSnapshots = new Map<string, SessionScrollSnapshot>()

export function resetSessionScrollSnapshotsForTests() {
  sessionScrollSnapshots.clear()
}

function isNearScrollBottom(element: HTMLElement) {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <=
    AUTO_SCROLL_BOTTOM_THRESHOLD_PX
  )
}

function rememberSessionScroll(sessionId: string, element: HTMLElement) {
  if (sessionScrollSnapshots.size >= MAX_SCROLL_SNAPSHOTS && !sessionScrollSnapshots.has(sessionId)) {
    const oldestSessionId = sessionScrollSnapshots.keys().next().value
    if (oldestSessionId) {
      sessionScrollSnapshots.delete(oldestSessionId)
    }
  }

  sessionScrollSnapshots.set(sessionId, {
    scrollTop: element.scrollTop,
    wasAtBottom: isNearScrollBottom(element),
  })
}

function getBottomScrollTop(element: HTMLElement) {
  return Math.max(0, element.scrollHeight - element.clientHeight)
}

function setScrollTopWithoutLayoutRead(element: HTMLElement, scrollTop: number) {
  element.scrollTop = Math.max(0, scrollTop)
}

function setScrollToBottomWithoutLayoutRead(element: HTMLElement) {
  element.scrollTop = SCROLL_BOTTOM_SENTINEL

  // Browsers clamp the large value to the true bottom without needing us to
  // synchronously read layout metrics. JSDOM test doubles do not clamp, so keep
  // the old numeric behavior there as a fallback.
  if (element.scrollTop === SCROLL_BOTTOM_SENTINEL) {
    element.scrollTop = getBottomScrollTop(element)
  }
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function getRenderItemKey(item: RenderItem) {
  if (item.kind === 'tool_group' || item.kind === 'team_card') return item.id
  return item.message.id
}

function findConversationMatches(
  renderItems: RenderItem[],
  streamingText: string,
  query: string,
): ConversationFindMatch[] {
  const needle = query.toLocaleLowerCase()
  if (!needle) return []
  const matches: ConversationFindMatch[] = []

  renderItems.forEach((item, renderIndex) => {
    if (matches.length >= MAX_CONVERSATION_FIND_MATCHES || item.kind !== 'message') return
    const message = item.message
    if (message.type !== 'user_text' && message.type !== 'assistant_text') return
    let occurrenceIndex = 0
    const text = message.content.toLocaleLowerCase()
    let offset = text.indexOf(needle)
    while (offset !== -1 && matches.length < MAX_CONVERSATION_FIND_MATCHES) {
      matches.push({
        renderIndex,
        renderItemKey: getRenderItemKey(item),
        occurrenceIndex,
        query,
      })
      occurrenceIndex += 1
      offset = text.indexOf(needle, offset + needle.length)
    }
  })

  if (matches.length < MAX_CONVERSATION_FIND_MATCHES && streamingText.trim()) {
    const text = streamingText.toLocaleLowerCase()
    let occurrenceIndex = 0
    let offset = text.indexOf(needle)
    while (offset !== -1 && matches.length < MAX_CONVERSATION_FIND_MATCHES) {
      matches.push({
        renderIndex: renderItems.length,
        renderItemKey: STREAMING_ASSISTANT_NAVIGATION_KEY,
        occurrenceIndex,
        query,
      })
      occurrenceIndex += 1
      offset = text.indexOf(needle, offset + needle.length)
    }
  }

  return matches
}

function collectConversationFindRanges(root: Node, query: string) {
  const ranges: Range[] = []
  const needle = query.toLocaleLowerCase()
  if (!needle) return ranges
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT
      if (node.parentElement?.closest('[data-find-bar], script, style, noscript, .material-symbols-outlined')) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })

  let textNode = walker.nextNode() as Text | null
  while (textNode) {
    const text = textNode.nodeValue?.toLocaleLowerCase() ?? ''
    let offset = text.indexOf(needle)
    while (offset !== -1 && ranges.length < MAX_CONVERSATION_FIND_MATCHES) {
      const range = document.createRange()
      range.setStart(textNode, offset)
      range.setEnd(textNode, offset + needle.length)
      ranges.push(range)
      offset = text.indexOf(needle, offset + needle.length)
    }
    if (ranges.length >= MAX_CONVERSATION_FIND_MATCHES) break
    textNode = walker.nextNode() as Text | null
  }
  return ranges
}

function clearConversationFindHighlights() {
  const highlights = (globalThis.CSS as any)?.highlights as Map<string, unknown> | undefined
  highlights?.delete('cc-find-results')
  highlights?.delete('cc-find-active')
}

function paintConversationFindHighlights(root: HTMLElement, match: ConversationFindMatch) {
  const highlights = (globalThis.CSS as any)?.highlights as Map<string, unknown> | undefined
  const HighlightCtor = (globalThis as any).Highlight
  if (!highlights || !HighlightCtor) return

  const resultRanges = collectConversationFindRanges(root, match.query)
  const target = Array.from(root.querySelectorAll<HTMLElement>('[data-chat-render-item-key]'))
    .find((node) => node.dataset.chatRenderItemKey === match.renderItemKey)
  const targetRanges = target
    ? resultRanges.filter((range) => target.contains(range.startContainer))
    : []
  const activeRange = targetRanges[Math.min(match.occurrenceIndex, Math.max(0, targetRanges.length - 1))]

  const results = new HighlightCtor()
  for (const range of resultRanges) results.add(range)
  highlights.set('cc-find-results', results)

  if (activeRange) {
    const active = new HighlightCtor()
    active.add(activeRange)
    active.priority = 1
    highlights.set('cc-find-active', active)
  } else {
    highlights.delete('cc-find-active')
  }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function getShallowStringWeight(value: unknown, depth = 0): number {
  if (typeof value === 'string') return value.length
  if (!value || depth > 1) return 0
  if (Array.isArray(value)) {
    return value.slice(0, 12).reduce((total, item) => total + getShallowStringWeight(item, depth + 1), 0)
  }
  if (!isRecordValue(value)) return 0

  let total = 0
  for (const item of Object.values(value).slice(0, 24)) {
    total += getShallowStringWeight(item, depth + 1)
    if (total >= VIRTUALIZE_MIN_CONTENT_CHARS) return total
  }
  return total
}

function getMessageContentWeight(message: UIMessage): number {
  switch (message.type) {
    case 'user_text':
    case 'assistant_text':
    case 'thinking':
    case 'system':
      return message.content.length
    case 'tool_use':
      return getShallowStringWeight(message.input) + (message.partialInput?.length ?? 0)
    case 'tool_result':
      return getShallowStringWeight(message.content)
    case 'permission_request':
      return getShallowStringWeight(message.input) + (message.description?.length ?? 0)
    case 'error':
      return message.message.length
    case 'compact_summary':
      return message.title.length + (message.summary?.length ?? 0)
    case 'goal_event':
      return (message.objective?.length ?? 0) + (message.message?.length ?? 0)
    case 'memory_event':
      return (message.message?.length ?? 0) + message.files.reduce((total, file) => total + file.path.length + (file.summary?.length ?? 0), 0)
    case 'background_task':
      return getShallowStringWeight(message.task)
    case 'task_summary':
      return message.tasks.reduce((total, task) => total + task.subject.length + (task.activeForm?.length ?? 0), 0)
  }
}

function getRenderItemContentWeight(item: RenderItem): number {
  if (item.kind === 'message') return getMessageContentWeight(item.message)
  // The team card is a fixed-height summary, so it contributes no text weight
  // to the virtualization heuristic.
  if (item.kind === 'team_card') return 0
  return item.steps.reduce(
    (total, step) => total + getMessageContentWeight(step.kind === 'tool' ? step.toolCall : step.message),
    0,
  )
}

export function shouldVirtualizeRenderItems(
  metrics: VirtualRenderItemMetric[],
  touchH5 = isTouchH5Document(),
) {
  const minRenderItems = touchH5 ? TOUCH_H5_VIRTUALIZE_MIN_RENDER_ITEMS : VIRTUALIZE_MIN_RENDER_ITEMS
  const minContentChars = touchH5 ? TOUCH_H5_VIRTUALIZE_MIN_CONTENT_CHARS : VIRTUALIZE_MIN_CONTENT_CHARS
  if (metrics.length >= minRenderItems) return true

  let totalWeight = 0
  for (const metric of metrics) {
    totalWeight += metric.contentWeight
    if (totalWeight >= minContentChars) return true
  }
  return false
}

function countLineBreaksCapped(content: string, maxLines: number) {
  let lineBreaks = 0
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) {
      lineBreaks += 1
      if (lineBreaks >= maxLines) return lineBreaks
    }
  }
  return lineBreaks
}

function estimateTextHeight(content: string, baseHeight: number) {
  const sample = content.length > 12_000 ? content.slice(0, 12_000) : content
  const sampledLineBreaks = countLineBreaksCapped(sample, 900)
  const explicitLines = content.length > sample.length
    ? Math.ceil((sampledLineBreaks + 1) * (content.length / sample.length))
    : sampledLineBreaks + 1
  const wrappedLines = Math.ceil(content.length / 76)
  const estimated = baseHeight + Math.max(explicitLines, wrappedLines) * 22
  return clampNumber(estimated, VIRTUAL_MIN_ITEM_HEIGHT, VIRTUAL_MAX_ITEM_HEIGHT)
}

/* Base heights are the non-text chrome of one item, measured as a border box so
 * they match what the ResizeObserver reports. Post-rail that is:
 *   prompt   24 rail padding-top (the turn gap) + 8 padding-bottom
 *            + 26 bubble padding + 36 action bar = 94
 *   reply    8 rail padding-bottom + 36 action bar = 44 (the card is gone)
 * The action bar is 36 (mt-2 + h-7) and always reserves its space — it must not
 * collapse on hover, or the transcript shifts under the reader's cursor. */
function estimateMessageHeight(message: UIMessage): number {
  switch (message.type) {
    case 'user_text':
      return estimateTextHeight(message.content, message.attachments?.length ? 160 : 94)
    case 'assistant_text':
      return estimateTextHeight(message.content, 44)
    case 'thinking':
      return estimateTextHeight(message.content, 40)
    case 'tool_use':
      return clampNumber(92 + Math.ceil(getMessageContentWeight(message) / 120) * 18, 72, 2200)
    case 'tool_result':
      return clampNumber(88 + Math.ceil(getMessageContentWeight(message) / 120) * 18, 64, 2200)
    case 'background_task':
    case 'goal_event':
    case 'memory_event':
    case 'permission_request':
    case 'task_summary':
      return 110
    case 'compact_summary':
      return message.summary ? clampNumber(92 + Math.ceil(message.summary.length / 90) * 20, 80, 1800) : 70
    case 'error':
    case 'system':
      return 64
  }
}

/** A collapsed activity group is one header line, however many steps it holds:
 *  py-1 (8) + a 12.5px line (~18) + the turn's padding-bottom (8).
 *
 *  A group only renders its rows while it is still running, and a running group
 *  sits at the scroll anchor where items are mounted and measured — so estimates
 *  are only ever consulted for the settled, collapsed form, which is this line. */
const ACTIVITY_GROUP_COLLAPSED_HEIGHT = 34
/** Avatar row plus two text lines, plus the turn's padding-bottom. */
const TEAM_CARD_HEIGHT = 86
/** Collapsed coordination disclosure below the card adds one compact row. */
const TEAM_CARD_WITH_AUDIT_HEIGHT = 116

export function estimateRenderItemHeight(item: RenderItem): number {
  if (item.kind === 'message') return estimateMessageHeight(item.message)
  if (item.kind === 'team_card') {
    return item.coordinationToolCalls.length > 0
      ? TEAM_CARD_WITH_AUDIT_HEIGHT
      : TEAM_CARD_HEIGHT
  }
  // Agent dispatch groups keep their taller per-agent cards; everything else
  // collapses to the single-line activity header.
  const isAgentGroup = item.toolCalls.length > 0 && item.toolCalls.every((toolCall) => toolCall.toolName === 'Agent')
  if (!isAgentGroup) return ACTIVITY_GROUP_COLLAPSED_HEIGHT
  const textWeight = getRenderItemContentWeight(item)
  return clampNumber(92 + item.toolCalls.length * 78 + Math.ceil(textWeight / 140) * 16, 88, 2600)
}

function getMessageMetricSignature(message: UIMessage): string {
  switch (message.type) {
    case 'user_text':
      return `${message.type}:${message.content.length}:${message.attachments?.length ?? 0}:${message.pending ? 1 : 0}`
    case 'assistant_text':
    case 'thinking':
    case 'system':
      return `${message.type}:${message.content.length}`
    case 'tool_use':
      return `${message.type}:${message.toolName}:${message.toolUseId}:${message.partialInput?.length ?? 0}:${message.isPending ? 1 : 0}:${message.status ?? ''}`
    case 'tool_result':
      return `${message.type}:${message.toolUseId}:${message.isError ? 1 : 0}`
    case 'compact_summary':
      return `${message.type}:${message.phase ?? ''}:${message.title.length}:${message.summary?.length ?? 0}`
    case 'goal_event':
      return `${message.type}:${message.action}:${message.status ?? ''}:${message.objective?.length ?? 0}:${message.message?.length ?? 0}`
    case 'memory_event':
      return `${message.type}:${message.event}:${message.files.length}:${message.message?.length ?? 0}`
    case 'background_task':
      return `${message.type}:${message.task.taskId}:${message.task.status}:${message.task.updatedAt}`
    case 'permission_request':
      return `${message.type}:${message.requestId}:${message.toolUseId ?? ''}:${message.description?.length ?? 0}`
    case 'error':
      return `${message.type}:${message.code}:${message.message.length}`
    case 'task_summary':
      return `${message.type}:${message.tasks.length}:${message.tasks.map((task) => task.id).join(',')}`
  }
}

function getRenderItemMetricSignature(item: RenderItem): string {
  if (item.kind === 'message') return getMessageMetricSignature(item.message)
  if (item.kind === 'team_card') {
    return `team_card:${item.id}:${item.coordinationToolCalls.length}`
  }
  return item.steps
    .map((step) => getMessageMetricSignature(step.kind === 'tool' ? step.toolCall : step.message))
    .join('|')
}

function findVirtualStartIndex(offsets: number[], target: number) {
  let low = 0
  let high = offsets.length - 1
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if ((offsets[mid + 1] ?? offsets[mid] ?? 0) < target) {
      low = mid + 1
    } else {
      high = mid
    }
  }
  return Math.max(0, low)
}

function findVirtualEndIndex(offsets: number[], target: number) {
  let low = 0
  let high = offsets.length - 1
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if ((offsets[mid] ?? 0) <= target) {
      low = mid + 1
    } else {
      high = mid
    }
  }
  return clampNumber(low + 1, 0, offsets.length - 1)
}

export function buildVirtualItemOffsets(
  itemKeys: string[],
  metrics: VirtualRenderItemMetric[],
  measuredHeights: Map<string, number>,
) {
  const offsets = new Array<number>(itemKeys.length + 1)
  offsets[0] = 0
  for (let index = 0; index < itemKeys.length; index += 1) {
    const measuredHeight = measuredHeights.get(itemKeys[index]!)
    const height = measuredHeight && measuredHeight > 0
      ? measuredHeight
      : metrics[index]?.estimatedHeight ?? VIRTUAL_MIN_ITEM_HEIGHT
    offsets[index + 1] = offsets[index]! + height
  }
  return offsets
}

const CONVERSATION_NAVIGATION_READING_ANCHOR_RATIO = 0.25

export function getActiveConversationNavigationItemId(
  items: ConversationNavigationItem[],
  offsets: number[],
  scrollTop: number,
  viewportHeight: number,
) {
  if (items.length === 0) return null
  if (scrollTop <= 1) return items[0]!.id
  const readingAnchor = scrollTop + viewportHeight * CONVERSATION_NAVIGATION_READING_ANCHOR_RATIO
  let activeItem = items[0]!

  for (const item of items) {
    if ((offsets[item.renderIndex] ?? 0) > readingAnchor) break
    activeItem = item
  }

  return activeItem.id
}

export function getConversationNavigationTargetScrollTop(
  item: ConversationNavigationItem,
  offsets: number[],
  viewportHeight: number,
  totalHeight: number,
) {
  const targetTop = offsets[item.renderIndex] ?? 0
  const readingAnchor = viewportHeight * CONVERSATION_NAVIGATION_READING_ANCHOR_RATIO
  return clampNumber(targetTop - readingAnchor, 0, Math.max(0, totalHeight - viewportHeight))
}

function buildVirtualTranscriptWindow(
  renderItems: RenderItem[],
  itemKeys: string[],
  metrics: VirtualRenderItemMetric[],
  measuredHeights: Map<string, number>,
  viewport: VirtualViewport,
  overscanPx: number,
): VirtualTranscriptWindow {
  const offsets = buildVirtualItemOffsets(itemKeys, metrics, measuredHeights)
  const totalHeight = offsets[renderItems.length] ?? 0
  if (!shouldVirtualizeRenderItems(metrics)) {
    return {
      enabled: false,
      beforeHeight: 0,
      afterHeight: 0,
      items: renderItems.map((item, index) => ({ item, index })),
      offsets,
      totalHeight,
    }
  }

  const viewportHeight = viewport.viewportHeight || VIRTUAL_DEFAULT_VIEWPORT_HEIGHT
  const maxScrollTop = Math.max(0, totalHeight - viewportHeight)
  const scrollTop = clampNumber(viewport.scrollTop, 0, maxScrollTop)
  const windowTop = Math.max(0, scrollTop - overscanPx)
  const windowBottom = Math.min(totalHeight, scrollTop + viewportHeight + overscanPx)
  const startIndex = findVirtualStartIndex(offsets, windowTop)
  const endIndex = Math.min(renderItems.length, findVirtualEndIndex(offsets, windowBottom))

  return {
    enabled: true,
    beforeHeight: offsets[startIndex] ?? 0,
    afterHeight: totalHeight - (offsets[endIndex] ?? totalHeight),
    items: renderItems.slice(startIndex, endIndex).map((item, offset) => ({
      item,
      index: startIndex + offset,
    })),
    offsets,
    totalHeight,
  }
}

const VIRTUAL_SPACER_CHUNK_PX = 800

function VirtualSpacer({ height, position }: { height: number; position: 'top' | 'bottom' }) {
  if (height <= 0) return null
  if (height <= VIRTUAL_SPACER_CHUNK_PX) {
    return (
      <div
        data-virtual-spacer={position}
        aria-hidden="true"
        style={{ height }}
      />
    )
  }

  // Splitting the spacer into chunks lets the WebView keep painting placeholder
  // boxes via content-visibility:auto + contain-intrinsic-size, instead of
  // leaving a single huge area unpainted while React reconciles the window.
  const chunkCount = Math.max(1, Math.ceil(height / VIRTUAL_SPACER_CHUNK_PX))
  const chunkHeight = Math.floor(height / chunkCount)
  const remainder = height - chunkHeight * chunkCount
  const chunks: Array<{ key: string; px: number }> = []
  for (let i = 0; i < chunkCount; i++) {
    const px = i === chunkCount - 1 ? chunkHeight + remainder : chunkHeight
    chunks.push({ key: `${position}-${i}`, px })
  }

  return (
    <div data-virtual-spacer={position} aria-hidden="true">
      {chunks.map((chunk) => (
        <div
          key={chunk.key}
          data-virtual-spacer-chunk={position}
          style={{
            height: chunk.px,
            contentVisibility: 'auto',
            containIntrinsicSize: `0 ${chunk.px}px`,
          }}
        />
      ))}
    </div>
  )
}

const MeasuredRenderItem = memo(function MeasuredRenderItem({
  itemKey,
  onHeightChange,
  highlighted,
  railPosition,
  children,
}: {
  itemKey: string
  onHeightChange: (itemKey: string, height: number) => void
  highlighted: boolean
  railPosition: TurnRailPosition
  children: ReactNode
}) {
  const itemRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const node = itemRef.current
    if (!node) return undefined

    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      // Border box, not `contentRect`: the rail's padding is the gap between
      // turns, so a content-box read would under-measure every item by that gap
      // and the virtualizer's offsets would drift low over a long transcript.
      // `borderBoxSize` predates every browser we ship on; the fallback is for
      // environments that stub ResizeObserver with `contentRect` alone.
      const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height
      if (Number.isFinite(height) && height > 0) {
        // Keep the layout engine's fractional CSS-pixel measurement. Rounding
        // each sample upward creates a discontinuity at every integer boundary:
        // at fractional Windows DPI a stable row reported as 117.99/118.01px
        // then becomes 118/119px, bypasses the sub-pixel guard below, and makes
        // the virtual window repaint forever (#1223).
        onHeightChange(itemKey, height)
      }
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [itemKey, onHeightChange])

  return (
    <div
      ref={itemRef}
      data-virtual-message-item={itemKey}
      data-chat-render-item-key={itemKey}
      data-turn-rail={railPosition}
      className={`${CHAT_RENDER_ITEM_CLASS} ${turnRailClass(railPosition)} ${highlighted ? 'chat-render-item--navigation-target' : ''}`}
    >
      {children}
    </div>
  )
})

export function MessageList({
  sessionId,
  compact = false,
  mobileLayout = false,
  onOpenAgentRun,
}: MessageListProps = {}) {
  const activeTabId = useTabStore((s) => s.activeTabId)
  const resolvedSessionId = sessionId ?? activeTabId
  const isWorkspacePanelOpen = useWorkspacePanelStore((state) =>
    resolvedSessionId ? state.isPanelOpen(resolvedSessionId) : false,
  )
  const workspacePanelOrigin = useWorkspacePanelStore((state) =>
    resolvedSessionId ? state.originBySession[resolvedSessionId] ?? null : null,
  )
  const sessionState = useChatStore((s) =>
    resolvedSessionId ? s.sessions[resolvedSessionId] : undefined,
  )
  const branchSession = useSessionStore((s) => s.branchSession)
  const stopGeneration = useChatStore((s) => s.stopGeneration)
  const reloadHistory = useChatStore((s) => s.reloadHistory)
  const queueComposerPrefill = useChatStore((s) => s.queueComposerPrefill)
  const memberSessionTeam = useTeamStore((s) => (
    resolvedSessionId ? s.getTeamByMemberSessionId(resolvedSessionId) : null
  ))
  const isMemberSession = Boolean(memberSessionTeam)
  const isAgentRunTab = useTabStore((s) => s.tabs.some((tab) => (
    tab.sessionId === resolvedSessionId &&
    (tab.type === 'subagent' || tab.type === 'team-member')
  )))
  const isDirectAgentSession = isMemberSession || isAgentRunTab
  const teamWorkbench = useTeamStore((s) =>
    resolvedSessionId ? s.workbenchesBySession[resolvedSessionId] : undefined,
  )
  const activeTeamName = useTeamStore((s) => (
    resolvedSessionId ? s.teamNameBySession[resolvedSessionId] : undefined
  ))
  const activeTeamStartedAt = useTeamStore((s) => (
    resolvedSessionId ? s.activeTeamStartedAtBySession[resolvedSessionId] : undefined
  ))
  const teamSnapshot = useMemo(() => {
    const snapshots = teamWorkbench?.snapshots
    return snapshots?.length
      ? snapshotWithHistoricalMembers(snapshots, snapshots.length - 1)
      : undefined
  }, [teamWorkbench?.snapshots])
  const teamTaskWindows = useMemo(
    () => teamTaskWindowsForSnapshot(teamSnapshot, activeTeamStartedAt),
    [activeTeamStartedAt, teamSnapshot],
  )
  const openTeamWorkbench = useCallback((leadSessionId: string, teamName: string) => {
    useTabStore.getState().openTeamWorkbenchTab(leadSessionId, teamName)
  }, [])
  const teamMemberNames = useMemo(() => {
    if (!teamSnapshot) return undefined
    return new Set(teamSnapshot.team.members.flatMap((member) =>
      member.name ? [member.name] : [],
    ))
  }, [teamSnapshot])
  const addToast = useUIStore((s) => s.addToast)
  const messages = sessionState?.messages ?? EMPTY_MESSAGES
  const chatState = sessionState?.chatState ?? 'idle'
  const isPreparingTurn = Boolean(sessionState?.isPreparingTurn)
  const historyMutationEpoch = sessionState?.historyMutationEpoch ?? 0
  const streamingText = sessionState?.streamingText ?? ''
  const streamingToolInput = sessionState?.streamingToolInput ?? ''
  const activeThinkingId = sessionState?.activeThinkingId ?? null
  const hasApiRetry = Boolean(sessionState?.apiRetry)
  const hasStreamingFallback = Boolean(sessionState?.streamingFallback)
  const agentTaskNotifications = sessionState?.agentTaskNotifications ?? EMPTY_AGENT_TASK_NOTIFICATIONS
  const backgroundAgentTasks = sessionState?.backgroundAgentTasks
  const agentTaskStatuses = useMemo<Record<string, BackgroundAgentTask['status']>>(() => {
    const statuses: Record<string, BackgroundAgentTask['status']> = {}
    for (const task of Object.values(backgroundAgentTasks ?? {})) {
      if (task.toolUseId) statuses[task.toolUseId] = task.status
    }
    return statuses
  }, [backgroundAgentTasks])
  const hasRunningBackgroundTasks = hasAnyRunningBackgroundTasks(backgroundAgentTasks)
  const pendingPermissions = listPendingPermissions(sessionState)
  const activeAskUserQuestionToolUseId =
    pendingPermissions
      .find((permission) => permission.toolName === 'AskUserQuestion')?.toolUseId ?? null
  const hasPendingPermissionCard = pendingPermissions.some(
    (permission) => permission.toolName !== 'AskUserQuestion',
  )
  const shouldFollowContentResize =
    isPreparingTurn ||
    streamingText.trim().length > 0 ||
    chatState === 'streaming' ||
    chatState === 'compacting' ||
    chatState === 'tool_executing' ||
    hasPendingPermissionCard ||
    (chatState === 'thinking' && Boolean(activeThinkingId))
  const messageListRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const scrollContentRef = useRef<HTMLDivElement>(null)
  const virtualItemHeightsRef = useRef<Map<string, number>>(
    resolvedSessionId ? getHeightsForSession(resolvedSessionId) : new Map<string, number>(),
  )
  const virtualItemMetricCacheRef = useRef<Map<string, VirtualRenderItemMetric>>(
    resolvedSessionId ? getMetricsForSession(resolvedSessionId) : new Map<string, VirtualRenderItemMetric>(),
  )
  const pendingMeasuredHeightsRef = useRef(false)
  const measureFlushFrameRef = useRef<number | null>(null)
  const liveFollowFrameRef = useRef<number | null>(null)
  const navigationHighlightTimerRef = useRef<number | null>(null)
  const workspaceOriginRestoreFrameRef = useRef<number | null>(null)
  const conversationFindRefreshTimerRef = useRef<number | null>(null)
  const conversationFindLastRefreshAtRef = useRef(0)
  const workspaceOriginSessionRef = useRef(resolvedSessionId)
  const lastAutoScrollAtRef = useRef(0)
  const lastContentResizeFollowHeightRef = useRef<number | null>(null)
  const shouldAutoScrollRef = useRef(true)
  const isProgrammaticScrollingRef = useRef(false)
  const ignoreProgrammaticScrollUntilRef = useRef(0)
  const ignoreProgrammaticScrollTopRef = useRef<number | null>(null)
  const userScrollIntentUntilRef = useRef(0)
  const disclosureLayoutUntilRef = useRef(0)
  const lastSessionIdRef = useRef<string | null | undefined>(undefined)
  const lastTailMessageIdBySessionRef = useRef(new Map<string, string | null>())
  const lastLiveFollowInputRef = useRef({
    sessionId: resolvedSessionId,
    messageCount: messages.length,
    streamingText,
    streamingToolInput,
  })
  const t = useTranslation()
  const [turnChangeCards, setTurnChangeCards] = useState<TurnChangeCardModel[]>([])
  const [turnChangeLoadError, setTurnChangeLoadError] = useState<string | null>(null)
  const [turnActionErrors, setTurnActionErrors] = useState<Record<string, string>>({})
  const [isLoadingTurnChangeCards, setIsLoadingTurnChangeCards] = useState(false)
  const [branchingMessageId, setBranchingMessageId] = useState<string | null>(null)
  const [rewindingTurnId, setRewindingTurnId] = useState<string | null>(null)
  const [turnUndoConfirmTargetId, setTurnUndoConfirmTargetId] = useState<string | null>(null)
  const [isAwayFromLatest, setIsAwayFromLatest] = useState(false)
  const [virtualViewport, setVirtualViewport] = useState<VirtualViewport>({
    scrollTop: SCROLL_BOTTOM_SENTINEL,
    viewportHeight: VIRTUAL_DEFAULT_VIEWPORT_HEIGHT,
  })
  const [measuredItemsVersion, setMeasuredItemsVersion] = useState(0)
  const [highlightedNavigationItemKey, setHighlightedNavigationItemKey] = useState<string | null>(null)
  const [programmaticNavigationItemId, setProgrammaticNavigationItemId] = useState<string | null>(null)
  const [activeConversationFindMatch, setActiveConversationFindMatch] = useState<ConversationFindMatch | null>(null)
  const conversationFindMatchesRef = useRef<ConversationFindMatch[]>([])
  const [messageListWidth, setMessageListWidth] = useState<number | null>(null)
  const branchActionsDisabled =
    isDirectAgentSession ||
    isPreparingTurn ||
    chatState !== 'idle' ||
    hasRunningBackgroundTasks ||
    streamingText.trim().length > 0 ||
    Boolean(activeThinkingId) ||
    Boolean(sessionState?.activeToolUseId) ||
    Boolean(sessionState?.activeToolName)
  const hasCompactingDivider = messages.some((message) =>
    message.type === 'compact_summary' && message.phase === 'compacting')

  useEffect(() => () => {
    if (measureFlushFrameRef.current !== null) {
      cancelAnimationFrame(measureFlushFrameRef.current)
    }
    if (liveFollowFrameRef.current !== null) {
      cancelAnimationFrame(liveFollowFrameRef.current)
    }
    if (navigationHighlightTimerRef.current !== null) {
      window.clearTimeout(navigationHighlightTimerRef.current)
    }
    if (workspaceOriginRestoreFrameRef.current !== null) {
      cancelAnimationFrame(workspaceOriginRestoreFrameRef.current)
    }
    if (conversationFindRefreshTimerRef.current !== null) {
      window.clearTimeout(conversationFindRefreshTimerRef.current)
    }
    clearConversationFindHighlights()
  }, [])

  useLayoutEffect(() => {
    const messageList = messageListRef.current
    if (!messageList) return

    const updateWidth = (width: number) => {
      const roundedWidth = Math.round(width)
      if (roundedWidth <= 0) return
      setMessageListWidth((current) => current === roundedWidth ? current : roundedWidth)
    }

    updateWidth(messageList.getBoundingClientRect().width || messageList.clientWidth)
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === messageList)
      if (entry) updateWidth(entry.contentRect.width)
    })
    observer.observe(messageList)
    return () => observer.disconnect()
  }, [])

  const syncVirtualViewportFromContainer = useCallback((container: HTMLElement) => {
    const nextScrollTop = container.scrollTop
    const nextViewportHeight = container.clientHeight || VIRTUAL_DEFAULT_VIEWPORT_HEIGHT
    setVirtualViewport((current) => {
      if (
        Math.abs(current.scrollTop - nextScrollTop) < 1 &&
        Math.abs(current.viewportHeight - nextViewportHeight) < 1
      ) {
        return current
      }
      return {
        scrollTop: nextScrollTop,
        viewportHeight: nextViewportHeight,
      }
    })
  }, [])

  const scrollToBottom = useCallback(() => {
    shouldAutoScrollRef.current = true
    isProgrammaticScrollingRef.current = true
    ignoreProgrammaticScrollUntilRef.current = performance.now() + 250
    lastAutoScrollAtRef.current = performance.now()
    const container = scrollContainerRef.current
    if (container) {
      setScrollToBottomWithoutLayoutRead(container)
      ignoreProgrammaticScrollTopRef.current = container.scrollTop
    }
    setVirtualViewport((current) => ({
      scrollTop: SCROLL_BOTTOM_SENTINEL,
      viewportHeight: current.viewportHeight,
    }))
    if (container && resolvedSessionId) {
      sessionScrollSnapshots.set(resolvedSessionId, {
        scrollTop: container.scrollTop,
        wasAtBottom: true,
      })
    }
    setIsAwayFromLatest(false)
    // Keep this path to one native scroll write. A second write in the next
    // frame can fight Chromium's scroll anchoring at fractional Windows DPI.
    requestAnimationFrame(() => {
      isProgrammaticScrollingRef.current = false
    })
  }, [resolvedSessionId])

  const requestLiveFollow = useCallback(() => {
    if (!shouldAutoScrollRef.current || liveFollowFrameRef.current !== null) return

    liveFollowFrameRef.current = requestAnimationFrame(() => {
      liveFollowFrameRef.current = null
      const container = scrollContainerRef.current
      if (!container || !shouldAutoScrollRef.current) return

      const bottomScrollTop = getBottomScrollTop(container)
      const bottomGap = bottomScrollTop - container.scrollTop
      if (Math.abs(bottomGap) > LIVE_FOLLOW_BOTTOM_GAP_TOLERANCE_PX) {
        isProgrammaticScrollingRef.current = true
        ignoreProgrammaticScrollUntilRef.current = performance.now() + 250
        lastAutoScrollAtRef.current = performance.now()
        setScrollTopWithoutLayoutRead(container, bottomScrollTop)
        ignoreProgrammaticScrollTopRef.current = container.scrollTop
        setVirtualViewport((current) => ({
          scrollTop: container.scrollTop,
          viewportHeight: container.clientHeight || current.viewportHeight || VIRTUAL_DEFAULT_VIEWPORT_HEIGHT,
        }))
        requestAnimationFrame(() => {
          isProgrammaticScrollingRef.current = false
        })
      }

      if (resolvedSessionId) {
        sessionScrollSnapshots.set(resolvedSessionId, {
          scrollTop: container.scrollTop,
          wasAtBottom: true,
        })
      }
      setIsAwayFromLatest(false)
    })
  }, [resolvedSessionId])

  const flushMeasuredHeightVersion = useCallback(() => {
    if (!pendingMeasuredHeightsRef.current) return
    pendingMeasuredHeightsRef.current = false
    setMeasuredItemsVersion((version) => version + 1)
  }, [])

  const handleVirtualItemHeightChange = useCallback((itemKey: string, height: number) => {
    const measuredHeight = clampNumber(height, VIRTUAL_MIN_ITEM_HEIGHT, VIRTUAL_MAX_ITEM_HEIGHT)
    const previousHeight = virtualItemHeightsRef.current.get(itemKey)
    if (
      previousHeight !== undefined &&
      Math.abs(previousHeight - measuredHeight) <= RESIZE_OBSERVER_JITTER_MAX_DELTA_PX
    ) return

    virtualItemHeightsRef.current.set(itemKey, measuredHeight)
    if (hasPendingPermissionCard && shouldAutoScrollRef.current) {
      requestLiveFollow()
    }

    if (typeof requestAnimationFrame === 'undefined') {
      pendingMeasuredHeightsRef.current = true
      flushMeasuredHeightVersion()
    } else if (!pendingMeasuredHeightsRef.current) {
      pendingMeasuredHeightsRef.current = true
      if (measureFlushFrameRef.current !== null) {
        cancelAnimationFrame(measureFlushFrameRef.current)
      }
      measureFlushFrameRef.current = requestAnimationFrame(() => {
        measureFlushFrameRef.current = null
        flushMeasuredHeightVersion()
      })
    }
  }, [flushMeasuredHeightVersion, hasPendingPermissionCard, requestLiveFollow])

  const updateAutoScrollState = useCallback(() => {
    // Ignore scroll events triggered by our own programmatic scrolling to
    // prevent the jump-to-latest button from flickering during auto-scroll.
    const container = scrollContainerRef.current
    if (!container) return
    const matchesProgrammaticScrollTop =
      ignoreProgrammaticScrollTopRef.current !== null &&
      Math.abs(container.scrollTop - ignoreProgrammaticScrollTopRef.current) < 1
    const shouldIgnoreRecentProgrammaticScroll =
      matchesProgrammaticScrollTop &&
      (
        isProgrammaticScrollingRef.current ||
        performance.now() < ignoreProgrammaticScrollUntilRef.current
      )
    if (shouldIgnoreRecentProgrammaticScroll) {
      syncVirtualViewportFromContainer(container)
      return
    }
    if (performance.now() < userScrollIntentUntilRef.current) {
      setProgrammaticNavigationItemId(null)
    }
    syncVirtualViewportFromContainer(container)
    const isAtBottom = isNearScrollBottom(container)
    const isPermissionLayoutShift =
      hasPendingPermissionCard &&
      shouldAutoScrollRef.current &&
      !isAtBottom &&
      performance.now() >= userScrollIntentUntilRef.current
    if (isPermissionLayoutShift) return

    shouldAutoScrollRef.current = isAtBottom
    setIsAwayFromLatest(!isAtBottom)

    if (resolvedSessionId) {
      rememberSessionScroll(resolvedSessionId, container)
    }
  }, [hasPendingPermissionCard, resolvedSessionId, syncVirtualViewportFromContainer])

  /**
   * Expanding a collapsed block is the reader rearranging their own view, not
   * the model producing output — so the live-follow must not treat the height
   * jump as new content and yank the transcript to the bottom (#1177). Browser
   * scroll anchoring already keeps the clicked row where it is; this only has to
   * stop `requestLiveFollow` from overriding it for that one frame.
   *
   * Deliberately not `userScrollIntentUntilRef`: that one is set by any
   * pointerdown on the scroller, so reusing it would suppress content-resize
   * follow on every stray click and turn "no jump" into "randomly stops
   * following".
   */
  const handleDisclosureToggle = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target
    if (!(target instanceof Element) || !target.closest(CHAT_DISCLOSURE_SELECTOR)) return

    disclosureLayoutUntilRef.current = performance.now() + DISCLOSURE_FOLLOW_SUPPRESS_MS

    // Suppression only covers the resize frame. Once the block is open the
    // container is no longer at the bottom, and the next streamed token would
    // pull it back down and throw the reader out again — so re-decide whether
    // we are still following, exactly as a wheel gesture would.
    requestAnimationFrame(() => {
      // The expansion's resize has landed by now, so hand follow back before the
      // next token arrives — suppression must never outlive the reader's click.
      disclosureLayoutUntilRef.current = 0
      const container = scrollContainerRef.current
      if (!container) return
      const atBottom = isNearScrollBottom(container)
      shouldAutoScrollRef.current = atBottom
      setIsAwayFromLatest(!atBottom)
      syncVirtualViewportFromContainer(container)
    })
  }, [syncVirtualViewportFromContainer])

  const markUserScrollIntent = useCallback(() => {
    userScrollIntentUntilRef.current = performance.now() + USER_SCROLL_INTENT_WINDOW_MS
  }, [])

  const handleWheelScrollIntent = useCallback((event: { deltaY: number }) => {
    markUserScrollIntent()
    if (event.deltaY < 0) {
      shouldAutoScrollRef.current = false
      setIsAwayFromLatest(true)
    }
  }, [markUserScrollIntent])

  const handleKeyDownScrollIntent = useCallback((event: { key: string; shiftKey: boolean }) => {
    const isUpwardScrollKey =
      event.key === 'ArrowUp' ||
      event.key === 'PageUp' ||
      event.key === 'Home' ||
      (event.key === ' ' && event.shiftKey)
    const isScrollKey = isUpwardScrollKey ||
      event.key === 'ArrowDown' ||
      event.key === 'PageDown' ||
      event.key === 'End' ||
      event.key === ' '
    if (!isScrollKey) return

    markUserScrollIntent()
    if (isUpwardScrollKey) {
      shouldAutoScrollRef.current = false
      setIsAwayFromLatest(true)
    }
  }, [markUserScrollIntent])

  useLayoutEffect(() => {
    if (lastSessionIdRef.current !== resolvedSessionId) {
      const snapshot = resolvedSessionId ? sessionScrollSnapshots.get(resolvedSessionId) : undefined
      shouldAutoScrollRef.current = snapshot?.wasAtBottom ?? true
      lastSessionIdRef.current = resolvedSessionId
      setProgrammaticNavigationItemId(null)
      virtualItemHeightsRef.current = resolvedSessionId
        ? getHeightsForSession(resolvedSessionId)
        : new Map<string, number>()
      virtualItemMetricCacheRef.current = resolvedSessionId
        ? getMetricsForSession(resolvedSessionId)
        : new Map<string, VirtualRenderItemMetric>()
      pendingMeasuredHeightsRef.current = false
      lastContentResizeFollowHeightRef.current = null
      if (measureFlushFrameRef.current !== null) {
        cancelAnimationFrame(measureFlushFrameRef.current)
        measureFlushFrameRef.current = null
      }
      if (liveFollowFrameRef.current !== null) {
        cancelAnimationFrame(liveFollowFrameRef.current)
        liveFollowFrameRef.current = null
      }
      setMeasuredItemsVersion((version) => version + 1)

      const container = scrollContainerRef.current
      if (container && snapshot && !snapshot.wasAtBottom) {
        ignoreProgrammaticScrollUntilRef.current = performance.now() + 250
        ignoreProgrammaticScrollTopRef.current = snapshot.scrollTop
        setScrollTopWithoutLayoutRead(container, snapshot.scrollTop)
        setVirtualViewport((current) => ({
          scrollTop: snapshot.scrollTop,
          viewportHeight: container.clientHeight || current.viewportHeight || VIRTUAL_DEFAULT_VIEWPORT_HEIGHT,
        }))
        setIsAwayFromLatest(true)
      } else if (container) {
        // Switch to a session we were at the bottom of (or first visit): write
        // the bottom sentinel without going through scrollToBottom's read path,
        // so we never force a layout flush during the switch's commit.
        ignoreProgrammaticScrollUntilRef.current = performance.now() + 250
        ignoreProgrammaticScrollTopRef.current = null
        lastAutoScrollAtRef.current = performance.now()
        shouldAutoScrollRef.current = true
        setScrollToBottomWithoutLayoutRead(container)
        setVirtualViewport((current) => ({
          scrollTop: SCROLL_BOTTOM_SENTINEL,
          viewportHeight: container.clientHeight || current.viewportHeight || VIRTUAL_DEFAULT_VIEWPORT_HEIGHT,
        }))
        setIsAwayFromLatest(false)
        if (resolvedSessionId) {
          sessionScrollSnapshots.set(resolvedSessionId, {
            scrollTop: container.scrollTop,
            wasAtBottom: true,
          })
        }
      } else {
        // No container yet (initial mount before ref settles): fall back to the
        // existing scrollToBottom path which is safe pre-mount.
        scrollToBottom()
      }
    }
  }, [resolvedSessionId, scrollToBottom])

  const tailMessage = messages[messages.length - 1] ?? null
  const tailMessageId = tailMessage?.id ?? null
  const tailMessageType = tailMessage?.type ?? null

  useEffect(() => {
    if (!resolvedSessionId) return

    const previousTailMessageId = lastTailMessageIdBySessionRef.current.get(resolvedSessionId)
    lastTailMessageIdBySessionRef.current.set(resolvedSessionId, tailMessageId)
    if (previousTailMessageId === undefined || previousTailMessageId === tailMessageId) return

    if (tailMessageType === 'user_text') {
      scrollToBottom()
    }
  }, [resolvedSessionId, scrollToBottom, tailMessageId, tailMessageType])

  useEffect(() => {
    const previousInput = lastLiveFollowInputRef.current
    lastLiveFollowInputRef.current = {
      sessionId: resolvedSessionId,
      messageCount: messages.length,
      streamingText,
      streamingToolInput,
    }
    // Session restoration already owns the initial/switch scroll. Only live
    // transitions within the same session enter the coalesced follow path.
    if (
      previousInput.sessionId !== resolvedSessionId ||
      (
        previousInput.messageCount === messages.length &&
        previousInput.streamingText === streamingText &&
        previousInput.streamingToolInput === streamingToolInput
      )
    ) {
      return
    }
    if (!shouldAutoScrollRef.current) {
      setIsAwayFromLatest(true)
      return
    }

    requestLiveFollow()
  }, [messages.length, requestLiveFollow, resolvedSessionId, streamingText, streamingToolInput])

  const handleJumpToLatest = useCallback(() => {
    setProgrammaticNavigationItemId(null)
    scrollToBottom()
  }, [scrollToBottom])

  useEffect(() => {
    const content = scrollContentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver((entries) => {
      const nextHeight = entries[0]?.contentRect.height
      if (typeof nextHeight === 'number' && Number.isFinite(nextHeight)) {
        const previousFollowHeight = lastContentResizeFollowHeightRef.current
        if (
          previousFollowHeight !== null &&
          Math.abs(nextHeight - previousFollowHeight) <= RESIZE_OBSERVER_JITTER_MAX_DELTA_PX
        ) {
          return
        }
        lastContentResizeFollowHeightRef.current = nextHeight
      }
      if (!shouldFollowContentResize) return
      if (!shouldAutoScrollRef.current) return
      // The reader just opened something: the growth is theirs, not the model's.
      if (performance.now() < disclosureLayoutUntilRef.current) return
      requestLiveFollow()
    })
    observer.observe(content)

    return () => observer.disconnect()
  }, [requestLiveFollow, shouldFollowContentResize])

  // Touch-H5 only: the visual-viewport fit (touchH5.ts) shrinks the scroll
  // container when the soft keyboard opens. If the user was reading the tail,
  // keep the latest message pinned above the keyboard instead of letting the
  // shorter container cut it off.
  useEffect(() => {
    if (!isTouchH5Document()) return
    const container = scrollContainerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(() => {
      if (!shouldAutoScrollRef.current) return
      requestLiveFollow()
    })
    observer.observe(container)

    return () => observer.disconnect()
  }, [requestLiveFollow])

  const { toolResultMap, childToolCallsByParent, renderItems } = useMemo(
    () => buildRenderModel(messages, activeAskUserQuestionToolUseId, {
      hideTeamCoordinationTools: !isDirectAgentSession,
      teamMemberNames,
      teamTaskWindows,
      teamName: activeTeamName ?? teamSnapshot?.team.name,
      teamStartedAt: activeTeamStartedAt,
    }),
    [
      activeAskUserQuestionToolUseId,
      activeTeamName,
      activeTeamStartedAt,
      isDirectAgentSession,
      messages,
      teamMemberNames,
      teamSnapshot?.team.name,
      teamTaskWindows,
    ],
  )
  // Defer the per-message branchable / completed-turn computations so the first
  // commit on tab switch can render the virtualization window without doing two
  // additional O(N) walks synchronously. They re-run in a low-priority render
  // once the initial frame is painted.
  const deferredMessages = useDeferredValue(messages)
  const branchableMessageTargets = useMemo(
    () => branchActionsDisabled
      ? new Map<string, BranchableMessageTarget>()
      : getBranchableMessageTargets(deferredMessages),
    [branchActionsDisabled, deferredMessages],
  )
  const completedTurnTargets = useMemo(
    () => getCompletedTurnTargets(deferredMessages),
    [deferredMessages],
  )
  const turnCompletionByMessageId = useMemo(
    () => buildTurnCompletionByMessageId(deferredMessages, { turnActive: chatState !== 'idle' }),
    [deferredMessages, chatState],
  )
  const latestCompletedTurnId =
    completedTurnTargets.length > 0
      ? completedTurnTargets[completedTurnTargets.length - 1]?.messageId ?? null
      : null
  const visibleTurnChangeCards = hasRunningBackgroundTasks ? EMPTY_TURN_CHANGE_CARDS : turnChangeCards
  const turnCardsByRenderIndex = useMemo(
    () => buildTurnCardInsertionMap(renderItems, visibleTurnChangeCards),
    [renderItems, visibleTurnChangeCards],
  )
  const changedFilesByRenderIndex = useMemo(
    () => buildChangedFilesByRenderIndex(renderItems, turnChangeCards),
    [renderItems, turnChangeCards],
  )
  const hasTrailingStreamingItem = streamingText.trim().length > 0
  const turnRailPositions = useMemo(
    () => buildTurnRailPositions(renderItems, { hasTrailingStreamingItem }),
    [renderItems, hasTrailingStreamingItem],
  )
  const streamingRailPosition = trailingStreamingRailPosition(turnRailPositions)
  // The rail is the progress indicator: whichever segment the turn is currently
  // working in carries the running state, so it sits next to the work it
  // describes instead of in a separate strip somewhere else on screen.
  const showsTurnStatusLine = hasApiRetry
    || hasStreamingFallback
    || isPreparingTurn
    || chatState === 'tool_executing'
    || (chatState === 'thinking' && !activeThinkingId)
  const renderItemKeys = useMemo(
    () => renderItems.map(getRenderItemKey),
    [renderItems],
  )
  const renderItemMetrics = useMemo(
    () => renderItems.map((item, index) => {
      const key = renderItemKeys[index]!
      const signature = getRenderItemMetricSignature(item)
      const cached = virtualItemMetricCacheRef.current.get(key)
      if (cached?.signature === signature) return cached

      const metric = {
        signature,
        contentWeight: getRenderItemContentWeight(item),
        estimatedHeight: estimateRenderItemHeight(item),
      }
      virtualItemMetricCacheRef.current.set(key, metric)
      return metric
    }),
    [renderItemKeys, renderItems],
  )
  const conversationNavigationItems = useMemo(() => {
    const sources = renderItems.flatMap((item, renderIndex) => item.kind === 'message'
      ? [{
          message: item.message,
          renderIndex,
          renderItemKey: getRenderItemKey(item),
        }]
      : [])

    return buildConversationNavigationItems(sources)
  }, [renderItems])
  const virtualTranscriptWindow = useMemo(
    () => buildVirtualTranscriptWindow(
      renderItems,
      renderItemKeys,
      renderItemMetrics,
      virtualItemHeightsRef.current,
      virtualViewport,
      VIRTUAL_OVERSCAN_PX,
    ),
    [measuredItemsVersion, renderItemKeys, renderItemMetrics, renderItems, virtualViewport],
  )
  const activeConversationNavigationItemId = useMemo(
    () => isAwayFromLatest
      ? getActiveConversationNavigationItemId(
          conversationNavigationItems,
          virtualTranscriptWindow.offsets,
          virtualViewport.scrollTop,
          virtualViewport.viewportHeight,
        )
      : null,
    [conversationNavigationItems, isAwayFromLatest, virtualTranscriptWindow.offsets, virtualViewport],
  )
  const visibleConversationNavigationItemId =
    programmaticNavigationItemId && conversationNavigationItems.some((item) => item.id === programmaticNavigationItemId)
      ? programmaticNavigationItemId
      : activeConversationNavigationItemId
  const conversationNavigationMode: ConversationNavigationMode =
    messageListWidth === null || messageListWidth >= CONVERSATION_NAVIGATION_FULL_MIN_WIDTH_PX
      ? 'full'
      : messageListWidth >= CONVERSATION_NAVIGATION_COMPACT_MIN_WIDTH_PX
        ? 'compact'
        : 'edge'
  const showConversationNavigator =
    !mobileLayout &&
    !isTouchH5Document() &&
    conversationNavigationItems.length >= CONVERSATION_NAVIGATION_MIN_ITEMS
  const chatScrollPaddingClass = compact
    ? showConversationNavigator && conversationNavigationMode === 'full'
      ? 'pb-5 px-20 py-3'
      : showConversationNavigator && conversationNavigationMode === 'compact'
        ? 'pb-5 px-12 py-3'
        : showConversationNavigator && conversationNavigationMode === 'edge'
          ? 'pb-5 px-7 py-3'
          : 'px-3 py-3 pb-5'
    : showConversationNavigator && conversationNavigationMode === 'full'
      ? 'px-20 py-4'
      : showConversationNavigator && conversationNavigationMode === 'compact'
        ? 'px-12 py-4'
        : showConversationNavigator && conversationNavigationMode === 'edge'
          ? 'px-7 py-4'
          : 'px-4 py-4'
  const confirmTurnCard = useMemo(
    () => visibleTurnChangeCards.find((card) => card.target.messageId === turnUndoConfirmTargetId) ?? null,
    [turnUndoConfirmTargetId, visibleTurnChangeCards],
  )
  // Undo is not reversible, so the dialog — not just the card — has to say which
  // changes it will leave behind when the checkpoint could not cover them all.
  const confirmUnverifiedSources = confirmTurnCard?.checkpoint.unverifiedChangeSources ?? []
  const confirmCanRestoreCode = confirmTurnCard?.checkpoint.restoreAvailable !== false
  const confirmBodyText = confirmTurnCard?.isLatest
    ? t('chat.turnChangesLatestConfirmBody')
    : t('chat.turnChangesHistoricalConfirmBody')
  const confirmCaution = !confirmCanRestoreCode
    ? t('chat.turnChangesConversationOnlyConfirmBody')
    : confirmUnverifiedSources.length > 0
      ? t('chat.turnChangesPartialCoverageConfirmBody', {
          sources: confirmUnverifiedSources.join(', '),
        })
      : null
  const confirmBody = confirmCaution === null
    ? confirmBodyText
    : (
        <div className="space-y-2 text-sm leading-6 text-[var(--color-text-secondary)]">
          {confirmCanRestoreCode ? <p>{confirmBodyText}</p> : null}
          <p className="text-[var(--color-warning)]">{confirmCaution}</p>
        </div>
      )

  useEffect(() => {
    const liveKeys = new Set(renderItemKeys)
    let removed = false
    for (const key of virtualItemHeightsRef.current.keys()) {
      if (!liveKeys.has(key)) {
        virtualItemHeightsRef.current.delete(key)
        removed = true
      }
    }
    for (const key of virtualItemMetricCacheRef.current.keys()) {
      if (!liveKeys.has(key)) {
        virtualItemMetricCacheRef.current.delete(key)
      }
    }
    if (removed) setMeasuredItemsVersion((version) => version + 1)
  }, [renderItemKeys])

  useEffect(() => {
    if (!resolvedSessionId || completedTurnTargets.length === 0 || isDirectAgentSession) {
      setTurnChangeCards([])
      setTurnChangeLoadError(null)
      setIsLoadingTurnChangeCards(false)
      return
    }

    if (hasRunningBackgroundTasks) {
      setTurnChangeLoadError(null)
      setIsLoadingTurnChangeCards(false)
      return
    }

    if (chatState !== 'idle') {
      setTurnChangeLoadError(null)
      setIsLoadingTurnChangeCards(false)
      return
    }

    let cancelled = false
    const controller = new AbortController()
    setIsLoadingTurnChangeCards(true)
    setTurnChangeLoadError(null)

    Promise.all([
      sessionsApi.getTurnCheckpoints(resolvedSessionId, { signal: controller.signal }),
      sessionsApi.getWorkspaceStatus(resolvedSessionId).catch(() => null),
    ])
      .then(([checkpointResponse, workspaceStatus]) => {
        if (cancelled) return
        const targetByMessageId = new Map(
          completedTurnTargets.map((target) => [target.messageId, target] as const),
        )
        const targetByUserMessageIndex = new Map(
          completedTurnTargets.map((target) => [target.userMessageIndex, target] as const),
        )

        setTurnChangeCards(
          normalizeTurnCheckpoints(checkpointResponse).flatMap((checkpoint) => {
            const target =
              targetByMessageId.get(checkpoint.target.targetUserMessageId) ??
              targetByUserMessageIndex.get(checkpoint.target.userMessageIndex)
            if (!target || !checkpoint.code.available) {
              return []
            }
            return [{
              target,
              checkpoint,
              workDir: checkpoint.workDir ?? workspaceStatus?.workDir ?? null,
              isLatest: target.messageId === latestCompletedTurnId,
            }]
          }),
        )
      })
      .catch((error) => {
        if (cancelled) return
        setTurnChangeCards([])
        setTurnChangeLoadError(getApiErrorMessage(error))
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingTurnChangeCards(false)
        }
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [chatState, completedTurnTargets, hasRunningBackgroundTasks, historyMutationEpoch, isDirectAgentSession, latestCompletedTurnId, resolvedSessionId])

  const handleUndoCurrentTurn = useCallback(async (mode: SessionRewindMode = 'both') => {
    if (!resolvedSessionId || !confirmTurnCard || rewindingTurnId || hasRunningBackgroundTasks) return

    const target = confirmTurnCard.target
    setRewindingTurnId(target.messageId)
    setTurnActionErrors((current) => {
      if (!(target.messageId in current)) return current
      const next = { ...current }
      delete next[target.messageId]
      return next
    })

    try {
      if (chatState !== 'idle') {
        stopGeneration(resolvedSessionId)
      }

      const checkpointTarget = confirmTurnCard.checkpoint.target
      const result = await sessionsApi.rewind(resolvedSessionId, {
        targetUserMessageId: checkpointTarget.targetUserMessageId,
        userMessageIndex: checkpointTarget.userMessageIndex,
        expectedContent: target.expectedContent,
        mode,
      })

      await reloadHistory(resolvedSessionId)
      queueComposerPrefill(resolvedSessionId, {
        text: target.content,
        attachments: target.attachments,
      })

      // Each branch has to match what actually happened on disk: nothing was
      // restored in conversation mode, and in `both` mode a turn that also wrote
      // off-checkpoint left changes behind. A plain success would overstate both.
      const messageCount = result.conversation.messagesRemoved
      const leftBehind = mode === 'both' ? result.unverifiedChangeSources ?? [] : []
      addToast({
        type: leftBehind.length > 0 ? 'warning' : 'success',
        message: mode === 'conversation'
          ? t('chat.rewindSuccessConversationOnly', { count: messageCount })
          : leftBehind.length > 0
            ? t('chat.rewindSuccessPartialCoverage', {
                count: messageCount,
                sources: leftBehind.join(', '),
              })
            : result.code.available
              ? t('chat.rewindSuccessWithCode', { count: messageCount })
              : t('chat.rewindSuccessConversationOnly', { count: messageCount }),
      })

      setTurnUndoConfirmTargetId(null)
    } catch (error) {
      setTurnActionErrors((current) => ({
        ...current,
        [target.messageId]: getApiErrorMessage(error),
      }))
      setTurnUndoConfirmTargetId(null)
    } finally {
      setRewindingTurnId(null)
    }
  }, [
    addToast,
    chatState,
    confirmTurnCard,
    hasRunningBackgroundTasks,
    queueComposerPrefill,
    reloadHistory,
    resolvedSessionId,
    rewindingTurnId,
    stopGeneration,
    t,
  ])

  // Rolling the conversation back never depends on the checkpoint, so it stays
  // on offer even when restoring the files is impossible — that is the only
  // action left in that case, and losing it entirely was the whole complaint.
  const confirmActions: ActionDialogAction[] = [
    {
      label: t('common.cancel'),
      onClick: () => setTurnUndoConfirmTargetId(null),
      variant: 'secondary',
    },
    {
      label: t('chat.turnChangesUndoConversationOnly'),
      onClick: () => { void handleUndoCurrentTurn('conversation') },
      variant: confirmCanRestoreCode ? 'secondary' : 'danger',
      loading: Boolean(rewindingTurnId),
    },
    ...(confirmCanRestoreCode
      ? [{
          label: confirmTurnCard?.isLatest
            ? t('chat.turnChangesLatestConfirmUndo')
            : t('chat.turnChangesHistoricalConfirmUndo'),
          onClick: () => { void handleUndoCurrentTurn('both') },
          variant: 'danger' as const,
          loading: Boolean(rewindingTurnId),
        }]
      : []),
  ]

  const handleBranchMessage = useCallback(async (target: BranchableMessageTarget) => {
    if (!resolvedSessionId || branchingMessageId) return

    setBranchingMessageId(target.uiMessageId)
    try {
      const result = await branchSession(resolvedSessionId, target.transcriptMessageId)
      const title = result.title.trim() || t('sidebar.newSession')
      useTabStore.getState().openTab(result.sessionId, title)
      useChatStore.getState().connectToSession(result.sessionId)
      addToast({
        type: 'success',
        message: t('chat.branchSuccess', { title }),
      })
    } catch (error) {
      addToast({
        type: 'error',
        message: t('chat.branchError', { detail: getApiErrorMessage(error) }),
      })
    } finally {
      setBranchingMessageId(null)
    }
  }, [addToast, branchSession, branchingMessageId, resolvedSessionId, t])

  // Pre-compute per-message branchAction + toolResult lookups so MessageBlock's
  // memo barrier is not broken by inline object literals on every render.
  const branchActionByMessageId = useMemo(() => {
    if (branchableMessageTargets.size === 0) {
      return new Map<string, { label: string; loading: boolean; onBranch: () => void }>()
    }
    const result = new Map<string, { label: string; loading: boolean; onBranch: () => void }>()
    const label = t('chat.branchFromHere')
    for (const [uiMessageId, target] of branchableMessageTargets) {
      result.set(uiMessageId, {
        label,
        loading: branchingMessageId === target.uiMessageId,
        onBranch: () => { void handleBranchMessage(target) },
      })
    }
    return result
  }, [branchableMessageTargets, branchingMessageId, handleBranchMessage, t])

  const toolResultByToolUseId = useMemo(() => {
    if (toolResultMap.size === 0) return new Map<string, { content: unknown; isError: boolean }>()
    const result = new Map<string, { content: unknown; isError: boolean }>()
    for (const [toolUseId, toolResult] of toolResultMap) {
      result.set(toolUseId, { content: toolResult.content, isError: toolResult.isError })
    }
    return result
  }, [toolResultMap])

  const handleNavigateToConversationItem = useCallback((item: ConversationNavigationItem) => {
    const container = scrollContainerRef.current
    if (!container) return

    const viewportHeight = container.clientHeight || virtualViewport.viewportHeight || VIRTUAL_DEFAULT_VIEWPORT_HEIGHT
    userScrollIntentUntilRef.current = 0
    setProgrammaticNavigationItemId(item.id)
    setHighlightedNavigationItemKey(item.renderItemKey)

    const scheduleHighlightClear = () => {
      if (navigationHighlightTimerRef.current !== null) {
        window.clearTimeout(navigationHighlightTimerRef.current)
      }
      navigationHighlightTimerRef.current = window.setTimeout(() => {
        setHighlightedNavigationItemKey((current) => current === item.renderItemKey ? null : current)
        navigationHighlightTimerRef.current = null
      }, 1400)
    }

    const targetScrollTop = getConversationNavigationTargetScrollTop(
      item,
      virtualTranscriptWindow.offsets,
      viewportHeight,
      virtualTranscriptWindow.totalHeight,
    )
    const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const isNearby = Math.abs(container.scrollTop - targetScrollTop) <= viewportHeight * 1.25

    shouldAutoScrollRef.current = false
    setIsAwayFromLatest(true)
    ignoreProgrammaticScrollUntilRef.current = performance.now() + 250
    ignoreProgrammaticScrollTopRef.current = targetScrollTop

    if (isNearby && !prefersReducedMotion && typeof container.scrollTo === 'function') {
      container.scrollTo({ top: targetScrollTop, behavior: 'smooth' })
    } else {
      setScrollTopWithoutLayoutRead(container, targetScrollTop)
    }
    setVirtualViewport({ scrollTop: targetScrollTop, viewportHeight })

    requestAnimationFrame(() => {
      const targetNode = Array.from(
        scrollContentRef.current?.querySelectorAll<HTMLElement>('[data-chat-render-item-key]') ?? [],
      ).find((node) => node.dataset.chatRenderItemKey === item.renderItemKey)

      if (targetNode) {
        const targetRect = targetNode.getBoundingClientRect()
        const containerRect = container.getBoundingClientRect()
        if (targetRect.height > 0) {
          const correction = targetRect.top - containerRect.top - viewportHeight * CONVERSATION_NAVIGATION_READING_ANCHOR_RATIO
          if (Math.abs(correction) >= 1) {
            setScrollTopWithoutLayoutRead(container, container.scrollTop + correction)
            syncVirtualViewportFromContainer(container)
          }
        }
      }

      scheduleHighlightClear()
    })
  }, [
    syncVirtualViewportFromContainer,
    virtualTranscriptWindow.offsets,
    virtualTranscriptWindow.totalHeight,
    virtualViewport.viewportHeight,
  ])

  const navigateToConversationFindMatch = useCallback((match: ConversationFindMatch) => {
    const container = scrollContainerRef.current
    if (!container) return

    const viewportHeight = container.clientHeight || virtualViewport.viewportHeight || VIRTUAL_DEFAULT_VIEWPORT_HEIGHT
    const targetOffset = virtualTranscriptWindow.offsets[match.renderIndex] ?? virtualTranscriptWindow.totalHeight
    const targetScrollTop = clampNumber(
      targetOffset - viewportHeight * CONVERSATION_NAVIGATION_READING_ANCHOR_RATIO,
      0,
      Math.max(0, virtualTranscriptWindow.totalHeight - viewportHeight),
    )

    setActiveConversationFindMatch(match)
    shouldAutoScrollRef.current = false
    setIsAwayFromLatest(true)
    ignoreProgrammaticScrollUntilRef.current = performance.now() + 250
    ignoreProgrammaticScrollTopRef.current = targetScrollTop
    setScrollTopWithoutLayoutRead(container, targetScrollTop)
    setVirtualViewport({ scrollTop: targetScrollTop, viewportHeight })
  }, [virtualTranscriptWindow.offsets, virtualTranscriptWindow.totalHeight, virtualViewport.viewportHeight])
  const navigateToConversationFindMatchRef = useRef(navigateToConversationFindMatch)
  navigateToConversationFindMatchRef.current = navigateToConversationFindMatch
  const conversationFindRenderItemsRef = useRef(renderItems)
  conversationFindRenderItemsRef.current = renderItems
  const conversationFindStreamingTextRef = useRef(streamingText)
  conversationFindStreamingTextRef.current = streamingText
  const conversationFindControllerRef = useRef<ConversationFindController | null>(null)

  useEffect(() => {
    if (!resolvedSessionId || resolvedSessionId !== activeTabId) return

    const controller: ConversationFindController = {
      search(query, preferredIndex = 0) {
        const matches = findConversationMatches(
          conversationFindRenderItemsRef.current,
          conversationFindStreamingTextRef.current,
          query,
        )
        conversationFindMatchesRef.current = matches
        const selectedMatch = matches[Math.min(preferredIndex, Math.max(0, matches.length - 1))]
        if (selectedMatch) {
          navigateToConversationFindMatchRef.current(selectedMatch)
        } else {
          setActiveConversationFindMatch(null)
          clearConversationFindHighlights()
        }
        return matches.length
      },
      navigate(index) {
        const match = conversationFindMatchesRef.current[index]
        if (match) navigateToConversationFindMatchRef.current(match)
      },
      clear() {
        conversationFindMatchesRef.current = []
        setActiveConversationFindMatch(null)
        clearConversationFindHighlights()
      },
    }
    conversationFindControllerRef.current = controller
    const unregister = registerConversationFindController(controller)
    return () => {
      if (conversationFindControllerRef.current === controller) {
        conversationFindControllerRef.current = null
      }
      unregister()
    }
  }, [activeTabId, resolvedSessionId])

  useEffect(() => {
    const controller = conversationFindControllerRef.current
    if (!controller) return
    const notify = () => {
      conversationFindRefreshTimerRef.current = null
      conversationFindLastRefreshAtRef.current = performance.now()
      notifyConversationFindContentChanged(controller)
    }
    if (conversationFindRefreshTimerRef.current !== null) return
    const remainingDelay = CONVERSATION_FIND_CONTENT_REFRESH_MS -
      (performance.now() - conversationFindLastRefreshAtRef.current)
    if (remainingDelay <= 0) {
      notify()
      return
    }
    conversationFindRefreshTimerRef.current = window.setTimeout(notify, remainingDelay)
  }, [renderItems, streamingText])

  useLayoutEffect(() => {
    if (!activeConversationFindMatch) {
      clearConversationFindHighlights()
      return
    }

    const root = scrollContentRef.current
    if (!root) return
    paintConversationFindHighlights(root, activeConversationFindMatch)
  }, [activeConversationFindMatch, virtualTranscriptWindow.items])

  const restoreWorkspacePanelOrigin = useCallback((origin: WorkspacePanelOrigin, attempt = 0) => {
    const container = scrollContainerRef.current
    const content = scrollContentRef.current
    if (!container || !content || !resolvedSessionId) return

    const renderItem = [...content.querySelectorAll<HTMLElement>('[data-chat-render-item-key]')]
      .find((node) => node.dataset.chatRenderItemKey === origin.sourceTurnKey)
    const opener = renderItem
      ? [...renderItem.querySelectorAll<HTMLElement>('[id]')]
          .find((node) => node.id === origin.sourceElementId)
      : null

    if (renderItem && opener) {
      if (!isRenderItemFullyVisibleInChatScroller(renderItem)) {
        renderItem.scrollIntoView({ block: 'nearest' })
      }
      opener.focus({ preventScroll: true })
      useWorkspacePanelStore.getState().clearOrigin(resolvedSessionId)
      workspaceOriginRestoreFrameRef.current = null
      return
    }

    const renderIndex = renderItemKeys.indexOf(origin.sourceTurnKey)
    if (!renderItem && renderIndex >= 0) {
      const viewportHeight = container.clientHeight || virtualViewport.viewportHeight || VIRTUAL_DEFAULT_VIEWPORT_HEIGHT
      const targetScrollTop = clampNumber(
        (virtualTranscriptWindow.offsets[renderIndex] ?? 0) - viewportHeight * CONVERSATION_NAVIGATION_READING_ANCHOR_RATIO,
        0,
        Math.max(0, virtualTranscriptWindow.totalHeight - viewportHeight),
      )
      shouldAutoScrollRef.current = false
      setScrollTopWithoutLayoutRead(container, targetScrollTop)
      setVirtualViewport({ scrollTop: targetScrollTop, viewportHeight })
    }

    if (attempt >= 7 || renderIndex < 0) {
      useWorkspacePanelStore.getState().clearOrigin(resolvedSessionId)
      workspaceOriginRestoreFrameRef.current = null
      return
    }

    workspaceOriginRestoreFrameRef.current = requestAnimationFrame(() => {
      restoreWorkspacePanelOrigin(origin, attempt + 1)
    })
  }, [
    renderItemKeys,
    resolvedSessionId,
    virtualTranscriptWindow.offsets,
    virtualTranscriptWindow.totalHeight,
    virtualViewport.viewportHeight,
  ])

  useEffect(() => {
    if (workspaceOriginSessionRef.current !== resolvedSessionId) {
      workspaceOriginSessionRef.current = resolvedSessionId
      if (workspaceOriginRestoreFrameRef.current !== null) {
        cancelAnimationFrame(workspaceOriginRestoreFrameRef.current)
        workspaceOriginRestoreFrameRef.current = null
      }
    }
    if (isWorkspacePanelOpen) {
      if (workspaceOriginRestoreFrameRef.current !== null) {
        cancelAnimationFrame(workspaceOriginRestoreFrameRef.current)
        workspaceOriginRestoreFrameRef.current = null
      }
      return
    }
    if (!workspacePanelOrigin || workspaceOriginRestoreFrameRef.current !== null) return

    workspaceOriginRestoreFrameRef.current = requestAnimationFrame(() => {
      workspaceOriginRestoreFrameRef.current = null
      restoreWorkspacePanelOrigin(workspacePanelOrigin)
    })
  }, [isWorkspacePanelOpen, resolvedSessionId, restoreWorkspacePanelOrigin, workspacePanelOrigin])

  const renderTranscriptItem = (item: RenderItem, index: number) => {
    const cardsForItem = turnCardsByRenderIndex.get(index) ?? []

    return (
      <>
        {item.kind === 'tool_group' ? (
          <ToolCallGroup
            sessionId={resolvedSessionId}
            onOpenAgentRun={onOpenAgentRun}
            toolCalls={item.toolCalls}
            steps={item.steps}
            resultMap={toolResultMap}
            childToolCallsByParent={childToolCallsByParent}
            agentTaskNotifications={agentTaskNotifications}
            agentTaskStatuses={agentTaskStatuses}
            activeThinkingId={activeThinkingId}
            isStreaming={
              chatState === 'tool_executing' &&
              item.toolCalls.some((tc) => !toolResultMap.has(tc.toolUseId))
            }
            // Only the tail of a live turn can still grow. Everything above it
            // is finished, whatever any individual tool's state looks like this
            // instant — which is why this, and not `isStreaming`, decides
            // whether a run stands open.
            isLive={chatState !== 'idle' && index === renderItems.length - 1 && !hasTrailingStreamingItem}
          />
        ) : item.kind === 'team_card' ? (
          resolvedSessionId ? (() => {
            const cardSnapshot = snapshotForTeamCard(teamSnapshot, item)
            const fallbackPhase = item.endedAt !== undefined || teamTaskWindows.some((window) => (
              item.startedAt >= window.startedAt &&
              window.endedAt !== undefined &&
              item.startedAt <= window.endedAt
            )) ? 'completed' : 'forming'
            return (
            <AgentTeamsInlineCard
              snapshot={cardSnapshot}
              teamName={item.teamName}
              fallbackPhase={fallbackPhase}
              phaseOverride={item.endedAt !== undefined ? 'completed' : undefined}
              onOpen={cardSnapshot
                ? () => openTeamWorkbench(resolvedSessionId, cardSnapshot.team.name)
                : undefined}
            >
              <TeamCoordinationAudit toolCalls={item.coordinationToolCalls} />
            </AgentTeamsInlineCard>
            )
          })() : null
        ) : (
          <MessageBlock
            sessionId={resolvedSessionId}
            message={item.message}
            team={memberSessionTeam ?? undefined}
            activeThinkingId={activeThinkingId}
            agentTaskNotifications={agentTaskNotifications}
            toolResult={
              item.message.type === 'tool_use'
                ? toolResultByToolUseId.get(item.message.toolUseId) ?? null
                : null
            }
            branchAction={branchActionByMessageId.get(item.message.id)}
            turnChangedFiles={changedFilesByRenderIndex.get(index)}
            turnCompletion={turnCompletionByMessageId.get(item.message.id)}
          />
        )}

        {resolvedSessionId && cardsForItem.map((card) => (
          <CurrentTurnChangeCard
            key={`turn-change-${card.target.messageId}`}
            sessionId={resolvedSessionId}
            checkpoint={card.checkpoint}
            workDir={card.workDir}
            error={turnActionErrors[card.target.messageId] ?? null}
            isUndoing={rewindingTurnId === card.target.messageId}
            isLatest={card.isLatest}
            onUndo={() => {
              setTurnUndoConfirmTargetId(card.target.messageId)
            }}
          />
        ))}
      </>
    )
  }

  return (
    <div ref={messageListRef} data-testid="message-list" className="relative min-h-0 flex-1">
      <div
        ref={scrollContainerRef}
        onScroll={updateAutoScrollState}
        onClickCapture={handleDisclosureToggle}
        onWheel={handleWheelScrollIntent}
        onPointerDown={markUserScrollIntent}
        onTouchStart={markUserScrollIntent}
        onKeyDown={handleKeyDownScrollIntent}
        className={`${CHAT_SCROLL_AREA_CLASS} h-full overflow-y-auto ${chatScrollPaddingClass}`}
      >
        <div
          ref={scrollContentRef}
          // The reading measure holds whether or not a right-hand panel is
          // open — `compact` only tightens padding. Dropping to `max-w-full`
          // was what made the transcript lose its centred structure the moment
          // the agent-teams workbench appeared.
          className="mx-auto max-w-[900px]"
        >
          {virtualTranscriptWindow.enabled ? (
            <VirtualSpacer height={virtualTranscriptWindow.beforeHeight} position="top" />
          ) : null}

          {virtualTranscriptWindow.items.map(({ item, index }) => {
            const itemKey = getRenderItemKey(item)
            const content = renderTranscriptItem(item, index)
            const railPosition = turnRailPositions[index] ?? 'none'

            return virtualTranscriptWindow.enabled ? (
              <MeasuredRenderItem
                key={itemKey}
                itemKey={itemKey}
                onHeightChange={handleVirtualItemHeightChange}
                highlighted={highlightedNavigationItemKey === itemKey}
                railPosition={railPosition}
              >
                {content}
              </MeasuredRenderItem>
            ) : (
              <div
                key={itemKey}
                data-chat-render-item-key={itemKey}
                data-turn-rail={railPosition}
                className={`${CHAT_RENDER_ITEM_CLASS} chat-render-item--cv ${turnRailClass(railPosition)} ${highlightedNavigationItemKey === itemKey ? 'chat-render-item--navigation-target' : ''}`}
              >
                {content}
              </div>
            )
          })}

          {virtualTranscriptWindow.enabled ? (
            <VirtualSpacer height={virtualTranscriptWindow.afterHeight} position="bottom" />
          ) : null}

          {streamingText.trim() && (
            <div
              data-chat-render-item-key={STREAMING_ASSISTANT_NAVIGATION_KEY}
              data-turn-rail={streamingRailPosition}
              className={turnRailClass(streamingRailPosition)}
            >
              <AssistantMessage content={streamingText} isStreaming={chatState === 'streaming'} />
            </div>
          )}

          {chatState === 'compacting' && !hasCompactingDivider && (
            <CompactStatusDivider state="compacting" />
          )}

          {/* Show StreamingIndicator when:
              - tool_executing: background work is running
              - thinking but no active ThinkingBlock yet: the gap between
                sending a message and receiving the first thinking delta
              The live status stays in the transcript, next to the output it is
              describing — it is part of the conversation, not composer chrome. */}
          {showsTurnStatusLine && (
            // On the rail, so the lit line runs all the way down to the status
            // it explains — except while preparing a turn, when no transcript
            // item exists yet and the status has to stand on its own.
            <div className={renderItems.length === 0 ? undefined : turnRailClass('end')}>
              <StreamingIndicator />
            </div>
          )}

          {!isLoadingTurnChangeCards && visibleTurnChangeCards.length === 0 && turnChangeLoadError && (
            <div className="mx-auto mb-5 w-full max-w-[900px] rounded-[var(--radius-lg)] border border-[var(--color-error)] bg-[var(--color-error-container)] px-4 py-3 text-xs text-[var(--color-on-error-container)]">
              {turnChangeLoadError}
            </div>
          )}

          <div />
        </div>
      </div>

      {showConversationNavigator ? (
        <ConversationNavigator
          mode={conversationNavigationMode}
          items={conversationNavigationItems}
          activeItemId={visibleConversationNavigationItemId}
          onNavigate={handleNavigateToConversationItem}
        />
      ) : null}

      {isAwayFromLatest && (
        <Button
          variant="secondary"
          size="md"
          onClick={handleJumpToLatest}
          title={t('chat.jumpToLatest')}
          aria-label={t('chat.jumpToLatest')}
          // `glass-panel` is unlayered CSS, so it wins over the variant's
          // layered background/border utilities without a tailwind-merge.
          className="glass-panel absolute bottom-4 right-5 z-20 rounded-full text-[13.5px] font-medium hover:-translate-y-px motion-reduce:hover:translate-y-0"
          icon={<ArrowDown size={15} aria-hidden="true" />}
        >
          {t('chat.jumpToLatest')}
        </Button>
      )}

      <ActionDialog
        open={Boolean(confirmTurnCard)}
        onClose={() => {
          if (!rewindingTurnId) {
            setTurnUndoConfirmTargetId(null)
          }
        }}
        title={confirmTurnCard?.isLatest
          ? t('chat.turnChangesLatestConfirmTitle')
          : t('chat.turnChangesHistoricalConfirmTitle')}
        body={confirmBody}
        actions={confirmActions}
        width={520}
        loading={Boolean(rewindingTurnId)}
      />
    </div>
  )
}

export const MessageBlock = memo(function MessageBlock({
  sessionId,
  message,
  team,
  activeThinkingId,
  agentTaskNotifications,
  toolResult,
  branchAction,
  turnChangedFiles,
  turnCompletion,
}: {
  sessionId?: string | null
  message: UIMessage
  team?: TeamDetail
  activeThinkingId: string | null
  agentTaskNotifications: Record<string, AgentTaskNotification>
  toolResult?: { content: unknown; isError: boolean } | null
  branchAction?: {
    label: string
    loading?: boolean
    onBranch: () => void
  }
  turnChangedFiles?: string[]
  turnCompletion?: TurnCompletion
}) {
  const t = useTranslation()
  const teammateVisual = message.type === 'user_text' && message.teammateFrom && team
    ? (() => {
        const { member, isLead } = resolveTeamMemberIdentity(team, message.teammateFrom)
        const avatarKey = getMemberAvatarKey(member, isLead)
        const memberIndex = Math.max(0, team.members.findIndex((candidate) => candidate.agentId === member.agentId))
        return {
          avatarKey,
          avatarSrc: MEMBER_AVATARS[avatarKey],
          accent: memberAccentColor(member.color, memberIndex),
        }
      })()
    : null

  switch (message.type) {
    case 'user_text':
      return (
        <SelectableChatMessage
          sessionId={sessionId}
          messageId={message.id}
          role="user"
          content={message.content}
        >
          <UserMessage
            content={message.content}
            attachments={message.attachments}
            branchAction={branchAction}
            timestamp={message.timestamp}
            sessionId={sessionId ?? undefined}
            teammateFrom={message.teammateFrom}
            teammateAvatarSrc={teammateVisual?.avatarSrc}
            teammateAvatarKey={teammateVisual?.avatarKey}
            teammateAccent={teammateVisual?.accent}
          />
        </SelectableChatMessage>
      )
    case 'assistant_text':
      return (
        <SelectableChatMessage
          sessionId={sessionId}
          messageId={message.id}
          role="assistant"
          content={message.content}
        >
          <AssistantMessage
            content={message.content}
            branchAction={branchAction}
            sessionId={sessionId ?? undefined}
            turnChangedFiles={turnChangedFiles}
            turnCompletion={turnCompletion}
          />
        </SelectableChatMessage>
      )
    case 'thinking':
      // No wrapper padding: the row's own `-mx-2 … px-2` already lands its text
      // on the column's left edge, the same as one inside a run.
      return <ThinkingBlock content={message.content} isActive={message.id === activeThinkingId} />
    case 'tool_use':
      if (message.toolName === 'AskUserQuestion' && !message.isPending) {
        return (
          <AskUserQuestion
            sessionId={sessionId}
            toolUseId={message.toolUseId}
            input={message.input}
            result={toolResult?.content}
          />
        )
      }
      // No durationMs prop here on purpose: buildRenderModel only emits a
      // standalone tool_use item for AskUserQuestion, and this branch is reached
      // only while such a call is still pending — so there is never a result to
      // measure against. The badge is wired in ToolCallGroup, the path every
      // other tool call takes.
      return (
        <ToolCallBlock
          toolName={message.toolName}
          input={message.input}
          result={toolResult}
          isPending={message.isPending}
          status={message.status}
          partialInput={message.partialInput}
          agentTaskNotification={
            message.toolName === 'Agent'
              ? agentTaskNotifications[message.toolUseId]
              : undefined
          }
        />
      )
    case 'tool_result':
      return (
        <ToolResultBlock
          content={message.content}
          isError={message.isError}
          standalone
        />
      )
    case 'permission_request':
      return (
        <PermissionDialog
          sessionId={sessionId}
          requestId={message.requestId}
          toolName={message.toolName}
          input={message.input}
          description={message.description}
        />
      )
    case 'error': {
      const businessErrorKey = message.businessErrorCode
        ? `businessError.${message.businessErrorCode}` as TranslationKey
        : null
      const businessErrorText = businessErrorKey ? t(businessErrorKey) : null
      const errorKey = message.code ? `error.${message.code}` as TranslationKey : null
      const errorText = errorKey ? t(errorKey) : null
      const displayMessage =
        businessErrorText && businessErrorText !== businessErrorKey
          ? businessErrorText
          : (errorText && errorText !== errorKey)
            ? errorText
            : message.message
      const showRawDetail =
        !message.businessErrorCode &&
        Boolean(message.message) &&
        message.message.trim() !== '' &&
        message.message !== displayMessage
      return (
        <div className="mb-3 px-4 py-2.5 rounded-[var(--radius-lg)] border border-[var(--color-error)] bg-[var(--color-error-container)] text-sm text-[var(--color-on-error-container)]">
          <strong>{t('common.error')}:</strong> {displayMessage}
          {showRawDetail && (
            <div className="mt-1 whitespace-pre-wrap text-xs text-[var(--color-on-error-container)]">
              {message.message}
            </div>
          )}
        </div>
      )
    }
    case 'task_summary':
      return <InlineTaskSummary tasks={message.tasks} />
    case 'memory_event':
      return <MemoryEventCard message={message} />
    case 'compact_summary':
      return <CompactStatusDivider message={message} state={message.phase === 'compacting' ? 'compacting' : 'complete'} />
    case 'goal_event':
      return message.action === 'status' && message.status === 'continuing'
        ? <GoalContinuationDivider message={message} />
        : <GoalEventCard message={message} />
    case 'background_task':
      return <BackgroundTaskEventCard message={message} />
    case 'system':
      return (
        <div className="mb-3 text-center text-xs text-[var(--color-text-tertiary)]">
          {message.content}
        </div>
      )
  }
})
