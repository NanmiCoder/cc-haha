import { useRef, useEffect, useMemo, memo, useState, useCallback, useLayoutEffect, type ReactNode } from 'react'
import { ArrowDown, BookMarked, Bot, CheckCircle2, ChevronDown, ChevronRight, CircleStop, LoaderCircle, Settings, Target, XCircle } from 'lucide-react'
import { ApiError } from '../../api/client'
import { sessionsApi, type SessionTurnCheckpoint } from '../../api/sessions'
import { useChatStore } from '../../stores/chatStore'
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
import { ConfirmDialog } from '../shared/ConfirmDialog'

type ToolCall = Extract<UIMessage, { type: 'tool_use' }>
type ToolResult = Extract<UIMessage, { type: 'tool_result' }>
type MemoryEvent = Extract<UIMessage, { type: 'memory_event' }>
type GoalEvent = Extract<UIMessage, { type: 'goal_event' }>
type BackgroundTaskEvent = Extract<UIMessage, { type: 'background_task' }>

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

const CHAT_SELECTION_MENU_OFFSET = 8

function clampValue(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max))
}

function getElementForNode(node: Node | null): Element | null {
  if (!node) return null
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
}

function getChatSelectionPosition(range: Range, root: HTMLElement, pointer: { clientX: number; clientY: number }) {
  const rect = typeof range.getBoundingClientRect === 'function'
    ? range.getBoundingClientRect()
    : null
  const rootRect = root.getBoundingClientRect()
  const pointerInsideRoot =
    pointer.clientX >= rootRect.left &&
    pointer.clientX <= rootRect.right &&
    pointer.clientY >= rootRect.top &&
    pointer.clientY <= rootRect.bottom
  const fallbackX = rect && rect.width > 0
    ? rect.left + rect.width / 2
    : rect?.left ?? rootRect.left + 24
  const fallbackY = rect
    ? rect.bottom + CHAT_SELECTION_MENU_OFFSET
    : rootRect.top + 24
  const unclampedX = pointerInsideRoot ? pointer.clientX : fallbackX
  const unclampedY = pointerInsideRoot ? pointer.clientY + CHAT_SELECTION_MENU_OFFSET : fallbackY
  const minX = Math.max(12, rootRect.left + 8)
  const maxX = Math.max(minX, Math.min(window.innerWidth - 160, rootRect.right - 136))
  const minY = Math.max(12, rootRect.top + 8)
  const maxY = Math.max(minY, Math.min(window.innerHeight - 48, rootRect.bottom - 40))

  return {
    x: clampValue(unclampedX, minX, maxX),
    y: clampValue(unclampedY, minY, maxY),
  }
}

function getChatSelectionFromContainer(
  root: HTMLElement | null,
  pointer: { clientX: number; clientY: number },
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

function ChatSelectionMenu({
  selection,
  onAdd,
}: {
  selection: ChatSelectionState | null
  onAdd: () => void
}) {
  const t = useTranslation()
  if (!selection) return null

  return (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onAdd}
      className="fixed z-50 inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-2.5 text-[12px] font-medium text-[var(--color-text-primary)] shadow-[var(--shadow-dropdown)] transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]/35"
      style={{ left: selection.x, top: selection.y }}
    >
      <span aria-hidden="true" className="material-symbols-outlined text-[15px] text-[var(--color-text-tertiary)]">person_add</span>
      <span>{t('chat.addSelectionToChat')}</span>
    </button>
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
              {task.taskType || t('chat.backgroundAgents.agent')}
            </span>
            <span className="shrink-0 text-[11px] text-[var(--color-text-tertiary)]">
              {t(`chat.backgroundAgents.status.${task.status}`)}
            </span>
            {task.usage?.totalTokens ? (
              <span className="hidden shrink-0 text-[11px] text-[var(--color-text-tertiary)] sm:inline">
                {t('chat.backgroundAgents.tokens', { count: task.usage.totalTokens.toLocaleString() })}
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
  const addReference = useWorkspaceChatContextStore((state) => state.addReference)
  const [selectionMenu, setSelectionMenu] = useState<ChatSelectionState | null>(null)
  const t = useTranslation()
  const sourceName = role === 'assistant'
    ? t('chat.assistantMessageReference')
    : t('chat.userMessageReference')

  useEffect(() => {
    setSelectionMenu(null)
  }, [content, messageId])

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
    window.getSelection()?.removeAllRanges()
  }, [addReference, messageId, role, selectionMenu, sessionId, sourceName])

  return (
    <div
      ref={rootRef}
      onMouseUp={(event) => {
        setSelectionMenu(getChatSelectionFromContainer(rootRef.current, event))
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setSelectionMenu(null)
      }}
    >
      {children}
      <ChatSelectionMenu selection={selectionMenu} onAdd={addCurrentSelectionToChat} />
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

export function buildRenderModel(messages: UIMessage[]): RenderModel {
  const items: RenderItem[] = []
  const toolResultMap = new Map<string, ToolResult>()
  const childToolCallsByParent = new Map<string, ToolCall[]>()
  const toolUseIds = new Set<string>()
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

  for (const msg of messages) {
    if (msg.type === 'tool_use') {
      toolUseIds.add(msg.toolUseId)
    }
    if (msg.type === 'tool_result') {
      toolResultMap.set(msg.toolUseId, msg)
    }
  }

  for (const msg of messages) {
    if (msg.type === 'assistant_text' && !msg.content.trim()) {
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
        flushGroup()
        items.push({ kind: 'message', message: msg })
      } else {
        pendingToolCalls.push(msg)
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
    message.type === 'background_task' ||
    message.type === 'error' ||
    message.type === 'task_summary'
  )
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
const MAX_SCROLL_SNAPSHOTS = 100
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

type SessionScrollSnapshot = {
  scrollTop: number
  wasAtBottom: boolean
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

function clampScrollTop(element: HTMLElement, scrollTop: number) {
  return Math.max(0, Math.min(scrollTop, getBottomScrollTop(element)))
}

function getBottomScrollTop(element: HTMLElement) {
  return Math.max(0, element.scrollHeight - element.clientHeight)
}

export function MessageList({ sessionId, compact = false }: MessageListProps = {}) {
  const activeTabId = useTabStore((s) => s.activeTabId)
  const resolvedSessionId = sessionId ?? activeTabId
  const sessionState = useChatStore((s) =>
    resolvedSessionId ? s.sessions[resolvedSessionId] : undefined,
  )
  const stopGeneration = useChatStore((s) => s.stopGeneration)
  const reloadHistory = useChatStore((s) => s.reloadHistory)
  const queueComposerPrefill = useChatStore((s) => s.queueComposerPrefill)
  const isMemberSession = useTeamStore((s) =>
    resolvedSessionId ? Boolean(s.getMemberBySessionId(resolvedSessionId)) : false,
  )
  const addToast = useUIStore((s) => s.addToast)
  const messages = sessionState?.messages ?? []
  const chatState = sessionState?.chatState ?? 'idle'
  const streamingText = sessionState?.streamingText ?? ''
  const activeThinkingId = sessionState?.activeThinkingId ?? null
  const agentTaskNotifications = sessionState?.agentTaskNotifications ?? {}
  const shouldFollowContentResize =
    streamingText.trim().length > 0 ||
    chatState === 'streaming' ||
    chatState === 'tool_executing' ||
    (chatState === 'thinking' && Boolean(activeThinkingId))
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const scrollContentRef = useRef<HTMLDivElement>(null)
  const shouldAutoScrollRef = useRef(true)
  const isProgrammaticScrollingRef = useRef(false)
  const lastSessionIdRef = useRef<string | null | undefined>(resolvedSessionId)
  const lastTailMessageIdBySessionRef = useRef(new Map<string, string | null>())
  const t = useTranslation()
  const [turnChangeCards, setTurnChangeCards] = useState<TurnChangeCardModel[]>([])
  const [turnChangeLoadError, setTurnChangeLoadError] = useState<string | null>(null)
  const [turnActionErrors, setTurnActionErrors] = useState<Record<string, string>>({})
  const [isLoadingTurnChangeCards, setIsLoadingTurnChangeCards] = useState(false)
  const [rewindingTurnId, setRewindingTurnId] = useState<string | null>(null)
  const [turnUndoConfirmTargetId, setTurnUndoConfirmTargetId] = useState<string | null>(null)
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    shouldAutoScrollRef.current = true
    isProgrammaticScrollingRef.current = true
    const container = scrollContainerRef.current
    const targetScrollTop = container ? getBottomScrollTop(container) : null
    if (container) {
      const nextScrollTop = targetScrollTop ?? 0
      if (typeof container.scrollTo === 'function') {
        try {
          container.scrollTo({ top: nextScrollTop, behavior })
        } catch {
          container.scrollTo(0, nextScrollTop)
        }
      }
      container.scrollTop = nextScrollTop
    }
    if (container && resolvedSessionId) {
      sessionScrollSnapshots.set(resolvedSessionId, {
        scrollTop: getBottomScrollTop(container),
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
          targetScrollTop === null ||
          latestContainer.scrollTop === targetScrollTop ||
          isNearScrollBottom(latestContainer)
        )
      ) {
        latestContainer.scrollTop = getBottomScrollTop(latestContainer)
        if (resolvedSessionId) {
          sessionScrollSnapshots.set(resolvedSessionId, {
            scrollTop: getBottomScrollTop(latestContainer),
            wasAtBottom: true,
          })
        }
      }
      isProgrammaticScrollingRef.current = false
    })
  }, [resolvedSessionId])

  const updateAutoScrollState = useCallback(() => {
    // Ignore scroll events triggered by our own programmatic scrolling to
    // prevent the jump-to-latest button from flickering during auto-scroll.
    if (isProgrammaticScrollingRef.current) return
    const container = scrollContainerRef.current
    if (!container) return
    const isAtBottom = isNearScrollBottom(container)
    shouldAutoScrollRef.current = isAtBottom
    setShowJumpToLatest(!isAtBottom)

    if (resolvedSessionId) {
      rememberSessionScroll(resolvedSessionId, container)
    }
  }, [resolvedSessionId])

  useLayoutEffect(() => {
    if (lastSessionIdRef.current !== resolvedSessionId) {
      const snapshot = resolvedSessionId ? sessionScrollSnapshots.get(resolvedSessionId) : undefined
      shouldAutoScrollRef.current = snapshot?.wasAtBottom ?? true
      lastSessionIdRef.current = resolvedSessionId

      const container = scrollContainerRef.current
      if (container && snapshot && !snapshot.wasAtBottom) {
        container.scrollTop = clampScrollTop(container, snapshot.scrollTop)
        setShowJumpToLatest(true)
      } else {
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
  }, [messages.length, resolvedSessionId, scrollToBottom, streamingText])

  const handleJumpToLatest = useCallback(() => {
    scrollToBottom('auto')
  }, [scrollToBottom])

  useEffect(() => {
    const content = scrollContentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(() => {
      if (!shouldFollowContentResize) return
      if (!shouldAutoScrollRef.current) return
      scrollToBottom('auto')
    })
    observer.observe(content)

    return () => observer.disconnect()
  }, [scrollToBottom, shouldFollowContentResize])

  const { toolResultMap, childToolCallsByParent, renderItems } = useMemo(
    () => buildRenderModel(messages),
    [messages],
  )
  const completedTurnTargets = useMemo(() => getCompletedTurnTargets(messages), [messages])
  const latestCompletedTurnId =
    completedTurnTargets.length > 0
      ? completedTurnTargets[completedTurnTargets.length - 1]?.messageId ?? null
      : null
  const turnCardsByRenderIndex = useMemo(
    () => buildTurnCardInsertionMap(renderItems, turnChangeCards),
    [renderItems, turnChangeCards],
  )
  const confirmTurnCard = useMemo(
    () => turnChangeCards.find((card) => card.target.messageId === turnUndoConfirmTargetId) ?? null,
    [turnChangeCards, turnUndoConfirmTargetId],
  )

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

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollContainerRef}
        onScroll={updateAutoScrollState}
        className={`${CHAT_SCROLL_AREA_CLASS} h-full overflow-y-auto ${compact ? 'px-3 py-3 pb-5' : 'px-4 py-4'}`}
      >
        <div
          ref={scrollContentRef}
          className={compact ? 'mx-auto max-w-full' : 'mx-auto max-w-[860px]'}
        >
          {renderItems.map((item, index) => {
            const itemKey = item.kind === 'tool_group' ? item.id : item.message.id
            const cardsForItem = turnCardsByRenderIndex.get(index) ?? []

            return (
              <div key={itemKey}>
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
                        ? (() => {
                            const result = toolResultMap.get(item.message.toolUseId)
                            return result ? { content: result.content, isError: result.isError } : null
                          })()
                        : null
                    }
                  />
                )}

                {resolvedSessionId && cardsForItem.map((card) => (
                  <CurrentTurnChangeCard
                    key={`turn-change-${card.target.messageId}`}
                    sessionId={resolvedSessionId}
                    targetUserMessageId={card.checkpoint.target.targetUserMessageId}
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
              </div>
            )
          })}

          {streamingText.trim() && (
            <AssistantMessage content={streamingText} isStreaming={chatState === 'streaming'} />
          )}

          {/* Show StreamingIndicator when:
              - tool_executing: tool is running
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
}: {
  sessionId?: string | null
  message: UIMessage
  activeThinkingId: string | null
  agentTaskNotifications: Record<string, AgentTaskNotification>
  toolResult?: { content: unknown; isError: boolean } | null
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
          <AssistantMessage content={message.content} />
        </SelectableChatMessage>
      )
    case 'thinking':
      return <ThinkingBlock content={message.content} isActive={message.id === activeThinkingId} />
    case 'tool_use':
      if (message.toolName === 'AskUserQuestion') {
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
      const errorKey = message.code ? `error.${message.code}` as TranslationKey : null
      const errorText = errorKey ? t(errorKey) : null
      const displayMessage = (errorText && errorText !== errorKey) ? errorText : message.message
      const showRawDetail =
        Boolean(message.message) &&
        message.message.trim() !== '' &&
        message.message !== displayMessage
      return (
        <div className="mb-3 px-4 py-2.5 rounded-lg border border-[var(--color-error)]/20 bg-[var(--color-error-container)]/28 text-sm text-[var(--color-error)]">
          <strong>Error:</strong> {displayMessage}
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
