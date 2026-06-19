import { useRef, useEffect, useMemo, memo, useState, useCallback, useDeferredValue, useLayoutEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, BookMarked, Bot, CheckCircle2, ChevronDown, ChevronRight, CircleStop, FileStack, LoaderCircle, MessageCircle, Settings, Target, XCircle } from 'lucide-react'
import { ApiError } from '../../api/client'
import { sessionsApi, type SessionTurnCheckpoint } from '../../api/sessions'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useWorkspaceChatContextStore } from '../../stores/workspaceChatContextStore'
import { SETTINGS_TAB_ID, useTabStore } from '../../stores/tabStore'
import { useTeamStore } from '../../stores/teamStore'
import { useUIStore } from '../../stores/uiStore'
import { useTranslation } from '../../i18n'
import type { TranslationKey } from '../../i18n/locales/en'
import { UserMessage } from './UserMessage'
import { AssistantMessage } from './AssistantMessage'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallBlock } from './ToolCallBlock'
import { ToolCallGroup } from './ToolCallGroup'
import { ToolResultBlock } from './ToolResultBlock'
import { PermissionDialog } from './PermissionDialog'
import { AskUserQuestion } from './AskUserQuestion'
import { StreamingIndicator } from './StreamingIndicator'
import { InlineTaskSummary } from './InlineTaskSummary'
import { CurrentTurnChangeCard } from './CurrentTurnChangeCard'
import type { AgentTaskNotification, UIMessage } from '../../types/chat'
import { formatTokenCount } from '../../lib/formatTokenCount'
import { isTouchH5Document } from '../../lib/touchH5'
import { ConfirmDialog } from '../shared/ConfirmDialog'
import { clearWindowSelection, getSelectionPopoverPosition, useSelectionPopoverDismiss } from '../../hooks/useSelectionPopoverDismiss'
import {
  getHeightsForSession,
  getMetricsForSession,
  type VirtualRenderItemMetric,
} from './virtualHeightCache'

type ToolCall = Extract<UIMessage, { type: 'tool_use' }>
type ToolResult = Extract<UIMessage, { type: 'tool_result' }>
type MemoryEvent = Extract<UIMessage, { type: 'memory_event' }>
type GoalEvent = Extract<UIMessage, { type: 'goal_event' }>
type BackgroundTaskEvent = Extract<UIMessage, { type: 'background_task' }>
type CompactSummaryEvent = Extract<UIMessage, { type: 'compact_summary' }>

type RenderItem =
  | { kind: 'tool_group'; toolCalls: ToolCall[]; id: string }
  | { kind: 'message'; message: UIMessage }

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

function getChatSelectionPosition(range: Range, root: HTMLElement, pointer: { clientX: number; clientY: number }) {
  return getSelectionPopoverPosition(range, root, {
    menuWidth: CHAT_SELECTION_MENU_WIDTH,
    menuHeight: CHAT_SELECTION_MENU_HEIGHT,
    offset: CHAT_SELECTION_MENU_OFFSET,
    fallbackPointer: pointer,
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
    ...getChatSelectionPosition(range, root, pointer),
    text,
  }
}

function getSelectionPointer(event: SelectionPointer): SelectionPointer {
  return {
    clientX: event.clientX,
    clientY: event.clientY,
  }
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
      onMouseDown={(event) => event.preventDefault()}
      onClick={onAdd}
      className="fixed z-50 inline-flex h-11 items-center gap-2 rounded-full border border-[var(--color-border)]/70 bg-[var(--color-surface-container-lowest)] px-5 text-[15px] font-semibold text-[var(--color-text-primary)] shadow-[0_10px_28px_rgba(15,23,42,0.14),0_2px_8px_rgba(15,23,42,0.08)] transition-colors hover:bg-[var(--color-surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]/35"
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
          className="group inline-flex min-h-8 max-w-[min(78vw,520px)] items-center gap-2 rounded-md px-2.5 py-1 text-[13px] font-semibold text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] disabled:cursor-default disabled:hover:text-[var(--color-text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]/30"
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
        <div className="mx-auto mt-1.5 w-full max-w-[620px] rounded-md border border-[var(--color-border)]/65 bg-[var(--color-surface-container-lowest)] px-3 py-2">
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
        className="overflow-hidden rounded-lg border border-[var(--color-memory-border)] bg-[var(--color-memory-surface)]"
      >
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-hover)]/50"
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
          <div className="border-t border-[var(--color-border)]/55 px-3 py-2.5">
            <div className="space-y-1.5">
              {message.objective ? (
                <div className="line-clamp-2 rounded-md px-2 py-1 text-[12px] leading-5 text-[var(--color-text-secondary)]">
                  {t('chat.goalEvent.objective', { value: message.objective })}
                </div>
              ) : message.message ? (
                <div className="whitespace-pre-wrap rounded-md px-2 py-1 text-[12px] leading-5 text-[var(--color-text-secondary)]">
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

function formatBackgroundTaskDuration(durationMs?: number) {
  if (typeof durationMs !== 'number' || durationMs < 0) return null
  const seconds = Math.round(durationMs / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

function BackgroundTaskEventCard({ message }: { message: BackgroundTaskEvent }) {
  const t = useTranslation()
  const { task } = message
  const isRunning = task.status === 'running'
  const isFailed = task.status === 'failed'
  const isStopped = task.status === 'stopped'
  const duration = formatBackgroundTaskDuration(task.usage?.durationMs)
  const detail = task.summary || task.lastToolName || task.description || task.outputFile || task.taskId
  const label = getBackgroundTaskLabel(task.taskType, t)

  return (
    <div className="mb-2">
      <div
        data-testid="background-task-event-card"
        data-status={task.status}
        className="flex min-w-0 items-start gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-2"
      >
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
          {isRunning ? (
            <LoaderCircle size={15} strokeWidth={2.25} className="animate-spin text-[var(--color-accent)]" aria-hidden="true" />
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
  if (message.task.taskType === 'local_agent' || message.task.taskType === 'remote_agent') {
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
  const selectionUpdateFrameRef = useRef<number | null>(null)
  const addReference = useWorkspaceChatContextStore((state) => state.addReference)
  const [selectionMenu, setSelectionMenu] = useState<ChatSelectionState | null>(null)
  const t = useTranslation()
  const sourceName = role === 'assistant'
    ? t('chat.assistantMessageReference')
    : t('chat.userMessageReference')

  useEffect(() => {
    setSelectionMenu(null)
    lastSelectionPointerRef.current = null
  }, [content, messageId])

  const dismissSelectionMenu = useCallback(() => {
    setSelectionMenu(null)
  }, [])

  const queueSelectionMenuUpdate = useCallback((pointer?: SelectionPointer) => {
    if (pointer) lastSelectionPointerRef.current = pointer

    if (selectionUpdateFrameRef.current !== null) {
      window.cancelAnimationFrame(selectionUpdateFrameRef.current)
    }

    selectionUpdateFrameRef.current = window.requestAnimationFrame(() => {
      selectionUpdateFrameRef.current = window.requestAnimationFrame(() => {
        selectionUpdateFrameRef.current = null
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
      lastSelectionPointerRef.current = getSelectionPointer(event)
    }

    const handlePointerUp = (event: PointerEvent) => {
      queueSelectionMenuUpdate(getSelectionPointer(event))
    }

    const handleMouseUp = (event: MouseEvent) => {
      queueSelectionMenuUpdate(getSelectionPointer(event))
    }

    const handleSelectionChange = () => {
      queueSelectionMenuUpdate()
    }

    const handleKeyUp = () => {
      queueSelectionMenuUpdate()
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('pointerup', handlePointerUp, true)
    document.addEventListener('mouseup', handleMouseUp, true)
    document.addEventListener('selectionchange', handleSelectionChange)
    document.addEventListener('keyup', handleKeyUp, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('pointerup', handlePointerUp, true)
      document.removeEventListener('mouseup', handleMouseUp, true)
      document.removeEventListener('selectionchange', handleSelectionChange)
      document.removeEventListener('keyup', handleKeyUp, true)
    }
  }, [queueSelectionMenuUpdate])

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
      onPointerDown={(event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return
        lastSelectionPointerRef.current = getSelectionPointer(event)
      }}
      onMouseUp={(event) => {
        queueSelectionMenuUpdate(getSelectionPointer(event))
      }}
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

export function buildRenderModel(messages: UIMessage[], activeAskUserQuestionToolUseId?: string | null): RenderModel {
  const items: RenderItem[] = []
  const toolResultMap = new Map<string, ToolResult>()
  const childToolCallsByParent = new Map<string, ToolCall[]>()
  const toolUseIds = new Set<string>()
  const lastUnresolvedAskUserQuestionIndexByToolUseId = new Map<string, number>()
  let lastUnresolvedAskUserQuestionIndex: number | null = null
  let pendingToolCalls: ToolCall[] = []

  const flushGroup = () => {
    if (pendingToolCalls.length > 0) {
      items.push({
        kind: 'tool_group',
        toolCalls: [...pendingToolCalls],
        id: `group-${pendingToolCalls[0]!.id}`,
      })
      pendingToolCalls = []
    }
  }
  const appendRootToolCall = (toolCall: ToolCall) => {
    const nextIsAgent = toolCall.toolName === 'Agent'
    const pendingIsAgentGroup = pendingToolCalls.every((pendingToolCall) => pendingToolCall.toolName === 'Agent')

    if (pendingToolCalls.length > 0 && pendingIsAgentGroup !== nextIsAgent) {
      flushGroup()
    }
    pendingToolCalls.push(toolCall)
  }

  for (const msg of messages) {
    if (msg.type === 'tool_use') {
      toolUseIds.add(msg.toolUseId)
    }
    if (msg.type === 'tool_result') {
      toolResultMap.set(msg.toolUseId, msg)
    }
  }
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
    } else {
      flushGroup()
      items.push({ kind: 'message', message: msg })
    }
  }

  flushGroup()
  return { renderItems: items, toolResultMap, childToolCallsByParent }
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
    if (card.checkpoint.code.filesChanged.length > 0) {
      filesByTurnId.set(card.target.messageId, card.checkpoint.code.filesChanged)
    }
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
    Array.isArray(checkpoint.code?.filesChanged)
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
      <div className="w-full max-w-2xl rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3.5 py-3 text-xs shadow-sm">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-brand)]">
            <BookMarked size={15} aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-medium text-[var(--color-text-primary)]">
                {t('chat.memorySavedTitle', { count: message.files.length })}
              </div>
              <button
                type="button"
                onClick={() => openMemorySettings(message.files[0]?.path)}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-brand)]/50 hover:text-[var(--color-text-primary)]"
              >
                <Settings size={13} aria-hidden="true" />
                {t('chat.memoryOpenSettings')}
              </button>
            </div>
            {message.message ? (
              <div className="mt-1 text-[var(--color-text-tertiary)]">{message.message}</div>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {visibleFiles.map((file) => (
                <span
                  key={file.path}
                  title={file.path}
                  className="max-w-full truncate rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-mono text-[10px] text-[var(--color-text-secondary)]"
                >
                  {memoryFileLabel(file.path)}
                </span>
              ))}
              {hiddenCount > 0 ? (
                <span className="rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-mono text-[10px] text-[var(--color-text-tertiary)]">
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
const VIRTUAL_MIN_ITEM_HEIGHT = 48
const VIRTUAL_MAX_ITEM_HEIGHT = 24_000
// Windows WebView2 can report 1px oscillations for live chat content; don't
// convert those into bottom-scroll corrections.
const CONTENT_RESIZE_FOLLOW_MIN_DELTA_PX = 2
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
}

const sessionScrollSnapshots = new Map<string, SessionScrollSnapshot>()

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

function setScrollToBottomWithoutLayoutRead(element: HTMLElement, behavior: ScrollBehavior) {
  if (typeof element.scrollTo === 'function') {
    try {
      element.scrollTo({ top: SCROLL_BOTTOM_SENTINEL, behavior })
    } catch {
      element.scrollTo(0, SCROLL_BOTTOM_SENTINEL)
    }
  }
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
  return item.kind === 'tool_group' ? item.id : item.message.id
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
  return item.toolCalls.reduce((total, toolCall) => total + getMessageContentWeight(toolCall), 0)
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

function estimateMessageHeight(message: UIMessage): number {
  switch (message.type) {
    case 'user_text':
      return estimateTextHeight(message.content, message.attachments?.length ? 140 : 74)
    case 'assistant_text':
      return estimateTextHeight(message.content, 96)
    case 'thinking':
      return estimateTextHeight(message.content, 88)
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

function estimateRenderItemHeight(item: RenderItem): number {
  if (item.kind === 'message') return estimateMessageHeight(item.message)
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
  return item.toolCalls.map(getMessageMetricSignature).join('|')
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

function buildVirtualTranscriptWindow(
  renderItems: RenderItem[],
  itemKeys: string[],
  metrics: VirtualRenderItemMetric[],
  measuredHeights: Map<string, number>,
  viewport: VirtualViewport,
  overscanPx: number,
): VirtualTranscriptWindow {
  if (!shouldVirtualizeRenderItems(metrics)) {
    return {
      enabled: false,
      beforeHeight: 0,
      afterHeight: 0,
      items: renderItems.map((item, index) => ({ item, index })),
    }
  }

  const offsets = new Array<number>(renderItems.length + 1)
  offsets[0] = 0
  for (let index = 0; index < renderItems.length; index += 1) {
    const item = renderItems[index]!
    const measuredHeight = measuredHeights.get(itemKeys[index]!)
    const height = measuredHeight && measuredHeight > 0
      ? measuredHeight
      : metrics[index]?.estimatedHeight ?? estimateRenderItemHeight(item)
    offsets[index + 1] = offsets[index]! + height
  }

  const totalHeight = offsets[renderItems.length] ?? 0
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
  children,
}: {
  itemKey: string
  onHeightChange: (itemKey: string, height: number) => void
  children: ReactNode
}) {
  const itemRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const node = itemRef.current
    if (!node) return undefined

    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry && Number.isFinite(entry.contentRect.height) && entry.contentRect.height > 0) {
        onHeightChange(itemKey, Math.ceil(entry.contentRect.height))
      }
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [itemKey, onHeightChange])

  return (
    <div
      ref={itemRef}
      data-virtual-message-item={itemKey}
      className={CHAT_RENDER_ITEM_CLASS}
    >
      {children}
    </div>
  )
})

export function MessageList({ sessionId, compact = false }: MessageListProps = {}) {
  const activeTabId = useTabStore((s) => s.activeTabId)
  const resolvedSessionId = sessionId ?? activeTabId
  const sessionState = useChatStore((s) =>
    resolvedSessionId ? s.sessions[resolvedSessionId] : undefined,
  )
  const branchSession = useSessionStore((s) => s.branchSession)
  const stopGeneration = useChatStore((s) => s.stopGeneration)
  const reloadHistory = useChatStore((s) => s.reloadHistory)
  const queueComposerPrefill = useChatStore((s) => s.queueComposerPrefill)
  const isMemberSession = useTeamStore((s) =>
    resolvedSessionId ? Boolean(s.getMemberBySessionId(resolvedSessionId)) : false,
  )
  const addToast = useUIStore((s) => s.addToast)
  const messages = sessionState?.messages ?? EMPTY_MESSAGES
  const chatState = sessionState?.chatState ?? 'idle'
  const streamingText = sessionState?.streamingText ?? ''
  const streamingToolInput = sessionState?.streamingToolInput ?? ''
  const activeThinkingId = sessionState?.activeThinkingId ?? null
  const agentTaskNotifications = sessionState?.agentTaskNotifications ?? EMPTY_AGENT_TASK_NOTIFICATIONS
  const activeAskUserQuestionToolUseId =
    sessionState?.pendingPermission?.toolName === 'AskUserQuestion'
      ? sessionState.pendingPermission.toolUseId
      : null
  const shouldFollowContentResize =
    streamingText.trim().length > 0 ||
    chatState === 'streaming' ||
    chatState === 'compacting' ||
    chatState === 'tool_executing' ||
    (chatState === 'thinking' && Boolean(activeThinkingId))
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
  const lastAutoScrollAtRef = useRef(0)
  const lastContentResizeFollowHeightRef = useRef<number | null>(null)
  const shouldAutoScrollRef = useRef(true)
  const isProgrammaticScrollingRef = useRef(false)
  const ignoreProgrammaticScrollUntilRef = useRef(0)
  const ignoreProgrammaticScrollTopRef = useRef<number | null>(null)
  const lastSessionIdRef = useRef<string | null | undefined>(resolvedSessionId)
  const lastTailMessageIdBySessionRef = useRef(new Map<string, string | null>())
  const t = useTranslation()
  const [turnChangeCards, setTurnChangeCards] = useState<TurnChangeCardModel[]>([])
  const [turnChangeLoadError, setTurnChangeLoadError] = useState<string | null>(null)
  const [turnActionErrors, setTurnActionErrors] = useState<Record<string, string>>({})
  const [isLoadingTurnChangeCards, setIsLoadingTurnChangeCards] = useState(false)
  const [branchingMessageId, setBranchingMessageId] = useState<string | null>(null)
  const [rewindingTurnId, setRewindingTurnId] = useState<string | null>(null)
  const [turnUndoConfirmTargetId, setTurnUndoConfirmTargetId] = useState<string | null>(null)
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  const [virtualViewport, setVirtualViewport] = useState<VirtualViewport>({
    scrollTop: SCROLL_BOTTOM_SENTINEL,
    viewportHeight: VIRTUAL_DEFAULT_VIEWPORT_HEIGHT,
  })
  const [measuredItemsVersion, setMeasuredItemsVersion] = useState(0)
  const branchActionsDisabled =
    isMemberSession ||
    chatState !== 'idle' ||
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

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    shouldAutoScrollRef.current = true
    isProgrammaticScrollingRef.current = true
    ignoreProgrammaticScrollUntilRef.current = performance.now() + 250
    lastAutoScrollAtRef.current = performance.now()
    const container = scrollContainerRef.current
    let requestedScrollTop: number | null = null
    if (container) {
      setScrollToBottomWithoutLayoutRead(container, behavior)
      requestedScrollTop = container.scrollTop
      ignoreProgrammaticScrollTopRef.current = requestedScrollTop
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
    setShowJumpToLatest(false)
    // Reset flag after the scroll event(s) from scrollIntoView have fired
    requestAnimationFrame(() => {
      const latestContainer = scrollContainerRef.current
      if (
        shouldAutoScrollRef.current &&
        latestContainer &&
        (
          requestedScrollTop === null ||
          latestContainer.scrollTop === requestedScrollTop
        )
      ) {
        setScrollToBottomWithoutLayoutRead(latestContainer, 'auto')
        if (resolvedSessionId) {
          sessionScrollSnapshots.set(resolvedSessionId, {
            scrollTop: latestContainer.scrollTop,
            wasAtBottom: true,
          })
        }
      }
      isProgrammaticScrollingRef.current = false
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
    if (previousHeight !== undefined && Math.abs(previousHeight - measuredHeight) < 1) return

    virtualItemHeightsRef.current.set(itemKey, measuredHeight)

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
  }, [flushMeasuredHeightVersion])

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
    syncVirtualViewportFromContainer(container)
    const isAtBottom = isNearScrollBottom(container)
    shouldAutoScrollRef.current = isAtBottom
    setShowJumpToLatest(!isAtBottom)

    if (resolvedSessionId) {
      rememberSessionScroll(resolvedSessionId, container)
    }
  }, [resolvedSessionId, syncVirtualViewportFromContainer])

  useLayoutEffect(() => {
    if (lastSessionIdRef.current !== resolvedSessionId) {
      const snapshot = resolvedSessionId ? sessionScrollSnapshots.get(resolvedSessionId) : undefined
      shouldAutoScrollRef.current = snapshot?.wasAtBottom ?? true
      lastSessionIdRef.current = resolvedSessionId
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
        setShowJumpToLatest(true)
      } else if (container) {
        // Switch to a session we were at the bottom of (or first visit): write
        // the bottom sentinel without going through scrollToBottom's read path,
        // so we never force a layout flush during the switch's commit.
        ignoreProgrammaticScrollUntilRef.current = performance.now() + 250
        ignoreProgrammaticScrollTopRef.current = null
        lastAutoScrollAtRef.current = performance.now()
        shouldAutoScrollRef.current = true
        setScrollToBottomWithoutLayoutRead(container, 'auto')
        setVirtualViewport((current) => ({
          scrollTop: SCROLL_BOTTOM_SENTINEL,
          viewportHeight: container.clientHeight || current.viewportHeight || VIRTUAL_DEFAULT_VIEWPORT_HEIGHT,
        }))
        setShowJumpToLatest(false)
        if (resolvedSessionId) {
          sessionScrollSnapshots.set(resolvedSessionId, {
            scrollTop: container.scrollTop,
            wasAtBottom: true,
          })
        }
      } else {
        // No container yet (initial mount before ref settles): fall back to the
        // existing scrollToBottom path which is safe pre-mount.
        scrollToBottom('auto')
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
      scrollToBottom('auto')
    }
  }, [resolvedSessionId, scrollToBottom, tailMessageId, tailMessageType])

  useEffect(() => {
    if (!shouldAutoScrollRef.current) {
      setShowJumpToLatest(true)
      return
    }

    scrollToBottom('auto')
  }, [messages.length, resolvedSessionId, scrollToBottom, streamingText, streamingToolInput])

  const handleJumpToLatest = useCallback(() => {
    scrollToBottom('auto')
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
          Math.abs(nextHeight - previousFollowHeight) < CONTENT_RESIZE_FOLLOW_MIN_DELTA_PX
        ) {
          return
        }
        lastContentResizeFollowHeightRef.current = nextHeight
      }
      if (!shouldFollowContentResize) return
      if (!shouldAutoScrollRef.current) return
      scrollToBottom('auto')
    })
    observer.observe(content)

    return () => observer.disconnect()
  }, [scrollToBottom, shouldFollowContentResize])

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
      scrollToBottom('auto')
    })
    observer.observe(container)

    return () => observer.disconnect()
  }, [scrollToBottom])

  const { toolResultMap, childToolCallsByParent, renderItems } = useMemo(
    () => buildRenderModel(messages, activeAskUserQuestionToolUseId),
    [activeAskUserQuestionToolUseId, messages],
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
  const latestCompletedTurnId =
    completedTurnTargets.length > 0
      ? completedTurnTargets[completedTurnTargets.length - 1]?.messageId ?? null
      : null
  const turnCardsByRenderIndex = useMemo(
    () => buildTurnCardInsertionMap(renderItems, turnChangeCards),
    [renderItems, turnChangeCards],
  )
  const changedFilesByRenderIndex = useMemo(
    () => buildChangedFilesByRenderIndex(renderItems, turnChangeCards),
    [renderItems, turnChangeCards],
  )
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
  const confirmTurnCard = useMemo(
    () => turnChangeCards.find((card) => card.target.messageId === turnUndoConfirmTargetId) ?? null,
    [turnChangeCards, turnUndoConfirmTargetId],
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
    if (!resolvedSessionId || completedTurnTargets.length === 0 || isMemberSession) {
      setTurnChangeCards([])
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
    setIsLoadingTurnChangeCards(true)
    setTurnChangeLoadError(null)

    Promise.all([
      sessionsApi.getTurnCheckpoints(resolvedSessionId),
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
            if (!target || !checkpoint.code.available || checkpoint.code.filesChanged.length === 0) {
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
    }
  }, [chatState, completedTurnTargets, isMemberSession, latestCompletedTurnId, resolvedSessionId])

  const handleUndoCurrentTurn = useCallback(async () => {
    if (!resolvedSessionId || !confirmTurnCard || rewindingTurnId) return

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

      const result = await sessionsApi.rewind(resolvedSessionId, {
        targetUserMessageId: target.messageId,
        userMessageIndex: target.userMessageIndex,
        expectedContent: target.expectedContent,
      })

      await reloadHistory(resolvedSessionId)
      queueComposerPrefill(resolvedSessionId, {
        text: target.content,
        attachments: target.attachments,
      })

      addToast({
        type: 'success',
        message: result.code.available
          ? t('chat.rewindSuccessWithCode', {
              count: result.conversation.messagesRemoved,
            })
          : t('chat.rewindSuccessConversationOnly', {
              count: result.conversation.messagesRemoved,
            }),
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
    queueComposerPrefill,
    reloadHistory,
    resolvedSessionId,
    rewindingTurnId,
    stopGeneration,
    t,
  ])

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

  const renderTranscriptItem = (item: RenderItem, index: number) => {
    const cardsForItem = turnCardsByRenderIndex.get(index) ?? []

    return (
      <>
        {item.kind === 'tool_group' ? (
          <ToolCallGroup
            toolCalls={item.toolCalls}
            resultMap={toolResultMap}
            childToolCallsByParent={childToolCallsByParent}
            agentTaskNotifications={agentTaskNotifications}
            isStreaming={
              chatState === 'tool_executing' &&
              item.toolCalls.some((tc) => !toolResultMap.has(tc.toolUseId))
            }
          />
        ) : (
          <MessageBlock
            sessionId={resolvedSessionId}
            message={item.message}
            activeThinkingId={activeThinkingId}
            agentTaskNotifications={agentTaskNotifications}
            toolResult={
              item.message.type === 'tool_use'
                ? toolResultByToolUseId.get(item.message.toolUseId) ?? null
                : null
            }
            branchAction={branchActionByMessageId.get(item.message.id)}
            turnChangedFiles={changedFilesByRenderIndex.get(index)}
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
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollContainerRef}
        onScroll={updateAutoScrollState}
        role="log"
        aria-live="polite"
        aria-label={t('chat.messageLog')}
        aria-relevant="additions"
        aria-atomic="false"
        className={`${CHAT_SCROLL_AREA_CLASS} h-full overflow-y-auto ${compact ? 'px-3 py-3 pb-5' : 'px-4 py-4'}`}
      >
        <div
          ref={scrollContentRef}
          className={compact ? 'mx-auto max-w-full' : 'mx-auto max-w-[860px]'}
        >
          {virtualTranscriptWindow.enabled ? (
            <VirtualSpacer height={virtualTranscriptWindow.beforeHeight} position="top" />
          ) : null}

          {virtualTranscriptWindow.items.map(({ item, index }) => {
            const itemKey = getRenderItemKey(item)
            const content = renderTranscriptItem(item, index)

            return virtualTranscriptWindow.enabled ? (
              <MeasuredRenderItem
                key={itemKey}
                itemKey={itemKey}
                onHeightChange={handleVirtualItemHeightChange}
              >
                {content}
              </MeasuredRenderItem>
            ) : (
              <div key={itemKey} className={`${CHAT_RENDER_ITEM_CLASS} chat-render-item--cv`}>
                {content}
              </div>
            )
          })}

          {virtualTranscriptWindow.enabled ? (
            <VirtualSpacer height={virtualTranscriptWindow.afterHeight} position="bottom" />
          ) : null}

          {streamingText.trim() && (
            <AssistantMessage content={streamingText} isStreaming={chatState === 'streaming'} />
          )}

          {chatState === 'compacting' && !hasCompactingDivider && (
            <CompactStatusDivider state="compacting" />
          )}

          {/* Show StreamingIndicator when:
              - tool_executing: background work is running
              - thinking but no active ThinkingBlock yet: the gap between
                sending a message and receiving the first thinking delta */}
          {(chatState === 'tool_executing' || (chatState === 'thinking' && !activeThinkingId)) && (
            <StreamingIndicator />
          )}

          {!isLoadingTurnChangeCards && turnChangeCards.length === 0 && turnChangeLoadError && (
            <div className="mx-auto mb-5 w-full max-w-[860px] rounded-[var(--radius-lg)] border border-[var(--color-error)]/25 bg-[var(--color-error-container)]/18 px-4 py-3 text-xs text-[var(--color-error)]">
              {turnChangeLoadError}
            </div>
          )}

          <div />
        </div>
      </div>

      {showJumpToLatest && (
        <button
          type="button"
          onClick={handleJumpToLatest}
          title={t('chat.jumpToLatest')}
          aria-label={t('chat.jumpToLatest')}
          className="absolute bottom-4 right-5 z-20 flex h-9 items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-3 text-xs font-medium text-[var(--color-text-primary)] shadow-[var(--shadow-dropdown)] transition-colors hover:border-[var(--color-brand)]/50 hover:bg-[var(--color-surface-container-low)]"
        >
          <ArrowDown size={15} aria-hidden="true" />
          <span>{t('chat.jumpToLatest')}</span>
        </button>
      )}

      <ConfirmDialog
        open={Boolean(confirmTurnCard)}
        onClose={() => {
          if (!rewindingTurnId) {
            setTurnUndoConfirmTargetId(null)
          }
        }}
        onConfirm={handleUndoCurrentTurn}
        title={confirmTurnCard?.isLatest
          ? t('chat.turnChangesLatestConfirmTitle')
          : t('chat.turnChangesHistoricalConfirmTitle')}
        body={confirmTurnCard?.isLatest
          ? t('chat.turnChangesLatestConfirmBody')
          : t('chat.turnChangesHistoricalConfirmBody')}
        confirmLabel={confirmTurnCard?.isLatest
          ? t('chat.turnChangesLatestConfirmUndo')
          : t('chat.turnChangesHistoricalConfirmUndo')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
        loading={Boolean(rewindingTurnId)}
      />
    </div>
  )
}

export const MessageBlock = memo(function MessageBlock({
  sessionId,
  message,
  activeThinkingId,
  agentTaskNotifications,
  toolResult,
  branchAction,
  turnChangedFiles,
}: {
  sessionId?: string | null
  message: UIMessage
  activeThinkingId: string | null
  agentTaskNotifications: Record<string, AgentTaskNotification>
  toolResult?: { content: unknown; isError: boolean } | null
  branchAction?: {
    label: string
    loading?: boolean
    onBranch: () => void
  }
  turnChangedFiles?: string[]
}) {
  const t = useTranslation()

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
            timestamp={message.timestamp}
            turnChangedFiles={turnChangedFiles}
          />
        </SelectableChatMessage>
      )
    case 'thinking':
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
        <div className="mb-3 px-4 py-2.5 rounded-lg border border-[var(--color-error)]/20 bg-[var(--color-error-container)]/28 text-sm text-[var(--color-error)]">
          <strong>{t('common.error')}:</strong> {displayMessage}
          {showRawDetail && (
            <div className="mt-1 whitespace-pre-wrap text-xs text-[var(--color-on-error-container)]/85">
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
      return <GoalEventCard message={message} />
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
