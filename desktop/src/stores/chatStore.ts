import { create } from 'zustand'
import { wsManager } from '../api/websocket'
import { sessionsApi } from '../api/sessions'
import { useTeamStore } from './teamStore'
import { useSessionStore } from './sessionStore'
import { useCLITaskStore } from './cliTaskStore'
import { useSessionRuntimeStore } from './sessionRuntimeStore'
import { useTabStore } from './tabStore'
import { randomSpinnerVerb } from '../config/spinnerVerbs'
import { notifyDesktop } from '../lib/desktopNotifications'
import { deriveSessionTitle, isPlaceholderSessionTitle } from '../lib/sessionTitle'
import { hasRunningBackgroundTasks } from '../lib/backgroundTasks'
import { AGENT_LIFECYCLE_TYPES } from '../types/team'
import type { ComposerAttachment } from '../lib/composerAttachments'
import type { MessageEntry } from '../types/session'
import type { PermissionMode } from '../types/settings'
import type { RuntimeSelection } from '../types/runtime'
import type {
  ActiveGoalState,
  AgentTaskNotification,
  ApiRetryState,
  AttachmentRef,
  BackgroundAgentTask,
  BackgroundAgentTaskUsage,
  ChatState,
  ComputerUsePermissionRequest,
  ComputerUsePermissionResponse,
  GoalEventAction,
  MemoryEventFile,
  StreamingFallbackState,
  UIAttachment,
  UIMessage,
  ServerMessage,
  TokenUsage,
  PermissionUpdate,
} from '../types/chat'

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'
type ToolCall = Extract<UIMessage, { type: 'tool_use' }>
type CompactSummaryMessage = Extract<UIMessage, { type: 'compact_summary' }>

export type ComposerDraftState = {
  input: string
  attachments: ComposerAttachment[]
}

export type QueuedUserMessage = {
  id: string
  content: string
  attachments?: AttachmentRef[]
  displayContent: string
  displayAttachments?: AttachmentRef[]
  createdAt: number
}

export type ComposerReferenceInsertion = {
  text: string
  reference?: {
    kind: 'file'
    path: string
    absolutePath?: string
    name: string
    isDirectory?: boolean
  }
  nonce: number
}

export type ComposerPrefillMode = 'replace' | 'append'

export type PendingPermission = {
  requestId: string
  toolName: string
  toolUseId?: string
  input: unknown
  description?: string
}

type PendingPermissions = Record<string, PendingPermission>

type PendingComputerUsePermission = {
  requestId: string
  request: ComputerUsePermissionRequest
}

type PendingComputerUsePermissions = Record<string, PendingComputerUsePermission>

export type PerSessionState = {
  messages: UIMessage[]
  chatState: ChatState
  connectionState: ConnectionState
  historyStatus?: 'idle' | 'loading' | 'ready' | 'error'
  historyError?: string | null
  streamingText: string
  streamingToolInput: string
  activeToolUseId: string | null
  activeToolName: string | null
  activeThinkingId: string | null
  /** Most recently received request, retained as a compatibility mirror. */
  pendingPermission: PendingPermission | null
  /** Authoritative set of outstanding SDK permission requests, keyed by request id. */
  pendingPermissions?: PendingPermissions
  /** Currently displayed Computer Use request; remaining requests stay queued. */
  pendingComputerUsePermission: PendingComputerUsePermission | null
  pendingComputerUsePermissions?: PendingComputerUsePermissions
  tokenUsage: TokenUsage
  /**
   * Bumped each time a compact boundary arrives. The context usage indicator
   * watches this to force an immediate re-read of the (now much smaller)
   * context instead of waiting for the next API response (#743).
   * Optional: legacy persisted sessions predate the field.
   */
  compactCount?: number
  /**
   * Characters streamed by the assistant during the current turn (text,
   * thinking, tool input). ÷4 approximates output tokens for the streaming
   * indicator — same estimation the CLI spinner uses. Reset on each send.
   */
  streamingResponseChars: number
  /** Boundary used to discard one failed, side-effect-free stream attempt. */
  streamAttemptStartIndex?: number
  streamAttemptStartResponseChars?: number
  elapsedSeconds: number
  statusVerb: string
  apiRetry?: ApiRetryState | null
  // 流式恢复/非流式降级提示（活动回合状态，与 apiRetry 同清除时机）。
  streamingFallback?: StreamingFallbackState | null
  slashCommands: Array<{ name: string; description: string; argumentHint?: string }>
  agentTaskNotifications: Record<string, AgentTaskNotification>
  backgroundAgentTasks?: Record<string, BackgroundAgentTask>
  stoppingBackgroundTaskIds?: Record<string, boolean>
  suppressNextTaskNotificationResponse?: boolean
  replaceHistoryOnCompletion?: boolean
  activeGoal?: ActiveGoalState | null
  elapsedTimer: ReturnType<typeof setInterval> | null
  composerPrefill?: {
    text: string
    attachments?: UIAttachment[]
    mode?: ComposerPrefillMode
    nonce: number
  } | null
  composerInsertion?: ComposerReferenceInsertion | null
  composerDraft?: ComposerDraftState | null
  queuedUserMessages?: QueuedUserMessage[]
}

const DEFAULT_SESSION_STATE: PerSessionState = {
  messages: [],
  chatState: 'idle',
  connectionState: 'disconnected',
  historyStatus: 'idle',
  historyError: null,
  streamingText: '',
  streamingToolInput: '',
  activeToolUseId: null,
  activeToolName: null,
  activeThinkingId: null,
  pendingPermission: null,
  pendingPermissions: {},
  pendingComputerUsePermission: null,
  pendingComputerUsePermissions: {},
  tokenUsage: { input_tokens: 0, output_tokens: 0 },
  compactCount: 0,
  streamingResponseChars: 0,
  elapsedSeconds: 0,
  statusVerb: '',
  apiRetry: null,
  streamingFallback: null,
  slashCommands: [],
  agentTaskNotifications: {},
  backgroundAgentTasks: {},
  stoppingBackgroundTaskIds: {},
  suppressNextTaskNotificationResponse: false,
  replaceHistoryOnCompletion: false,
  activeGoal: null,
  elapsedTimer: null,
  composerPrefill: null,
  composerInsertion: null,
  composerDraft: null,
  queuedUserMessages: [],
}

function createDefaultSessionState(): PerSessionState {
  return {
    ...DEFAULT_SESSION_STATE,
    messages: [],
    tokenUsage: { input_tokens: 0, output_tokens: 0 },
    queuedUserMessages: [],
  }
}

function getPendingPermissionRecord(
  session: Pick<PerSessionState, 'pendingPermission' | 'pendingPermissions'>,
): PendingPermissions {
  const pendingPermissions = { ...(session.pendingPermissions ?? {}) }
  if (session.pendingPermission && !pendingPermissions[session.pendingPermission.requestId]) {
    pendingPermissions[session.pendingPermission.requestId] = session.pendingPermission
  }
  return pendingPermissions
}

function getPendingComputerUsePermissionRecord(
  session: Pick<PerSessionState, 'pendingComputerUsePermission' | 'pendingComputerUsePermissions'>,
): PendingComputerUsePermissions {
  const pendingPermissions = { ...(session.pendingComputerUsePermissions ?? {}) }
  if (
    session.pendingComputerUsePermission &&
    !pendingPermissions[session.pendingComputerUsePermission.requestId]
  ) {
    pendingPermissions[session.pendingComputerUsePermission.requestId] =
      session.pendingComputerUsePermission
  }
  return pendingPermissions
}

function getCurrentComputerUsePermission(
  pendingPermissions: PendingComputerUsePermissions,
  currentPermission: PendingComputerUsePermission | null,
): PendingComputerUsePermission | null {
  return (currentPermission
    ? pendingPermissions[currentPermission.requestId]
    : undefined) ?? Object.values(pendingPermissions)[0] ?? null
}

function hasPendingPermissionRequests(session: PerSessionState): boolean {
  return Object.keys(getPendingPermissionRecord(session)).length > 0 ||
    Object.keys(getPendingComputerUsePermissionRecord(session)).length > 0
}

function getChatStateAfterPermissionResolution(
  session: PerSessionState,
  hasRemainingPermissions: boolean,
  allowed: boolean | undefined,
): ChatState {
  if (hasRemainingPermissions) return 'permission_pending'
  if (allowed === true) return 'tool_executing'
  if (allowed === false) return 'idle'
  return session.chatState === 'permission_pending' ? 'thinking' : session.chatState
}

export function listPendingPermissions(
  session: Pick<PerSessionState, 'pendingPermission' | 'pendingPermissions'> | undefined,
): PendingPermission[] {
  return session ? Object.values(getPendingPermissionRecord(session)) : []
}

export function getPendingPermission(
  session: Pick<PerSessionState, 'pendingPermission' | 'pendingPermissions'> | undefined,
  requestId: string,
): PendingPermission | undefined {
  if (!session) return undefined
  return session.pendingPermissions?.[requestId] ?? (
    session.pendingPermission?.requestId === requestId
      ? session.pendingPermission
      : undefined
  )
}

type ChatStore = {
  sessions: Record<string, PerSessionState>

  getSession: (sessionId: string) => PerSessionState
  connectToSession: (sessionId: string) => void
  disconnectSession: (sessionId: string) => void
  sendMessage: (
    sessionId: string,
    content: string,
    attachments?: AttachmentRef[],
    options?: { displayContent?: string; displayAttachments?: AttachmentRef[]; hideDisplayContent?: boolean },
  ) => void
  respondToPermission: (
    sessionId: string,
    requestId: string,
    allowed: boolean,
    options?: {
      rule?: string
      updatedInput?: Record<string, unknown>
      denyMessage?: string
      permissionUpdates?: PermissionUpdate[]
    },
  ) => void
  respondToComputerUsePermission: (
    sessionId: string,
    requestId: string,
    response: ComputerUsePermissionResponse,
  ) => void
  setSessionRuntime: (sessionId: string, selection: RuntimeSelection) => void
  setSessionPermissionMode: (sessionId: string, mode: PermissionMode) => void
  stopGeneration: (sessionId: string) => void
  stopBackgroundTask: (sessionId: string, taskId: string) => void
  loadHistory: (sessionId: string) => Promise<void>
  reloadHistory: (
    sessionId: string,
    guard?: {
      messages: UIMessage[]
      backgroundAgentTasks?: Record<string, BackgroundAgentTask>
    },
  ) => Promise<void>
  queueComposerPrefill: (
    sessionId: string,
    prefill: { text: string; attachments?: UIAttachment[]; mode?: ComposerPrefillMode },
  ) => void
  clearComposerPrefill: (sessionId: string, nonce?: number) => void
  queueComposerInsertion: (
    sessionId: string,
    insertion: Omit<ComposerReferenceInsertion, 'nonce'>,
  ) => void
  clearComposerInsertion: (sessionId: string, nonce?: number) => void
  setComposerDraft: (sessionId: string, draft: ComposerDraftState) => void
  clearComposerDraft: (sessionId: string) => void
  queueUserMessage: (
    sessionId: string,
    message: Omit<QueuedUserMessage, 'id' | 'createdAt'>,
  ) => string
  updateQueuedUserMessage: (sessionId: string, messageId: string, content: string) => void
  removeQueuedUserMessage: (sessionId: string, messageId: string) => void
  sendQueuedUserMessage: (sessionId: string, messageId: string) => void
  clearMessages: (sessionId: string) => void
  handleServerMessage: (sessionId: string, msg: ServerMessage) => void
}

const TASK_TOOL_NAMES = new Set(['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TodoWrite'])
const TASK_STOP_TOOL_NAMES = new Set(['TaskStop', 'KillShell'])
const pendingTaskToolUseIdsBySession = new Map<string, Set<string>>()
const pendingToolParentUseIdsBySession = new Map<string, Map<string, string>>()

function addPendingTaskToolUseId(sessionId: string, toolUseId: string): void {
  const ids = pendingTaskToolUseIdsBySession.get(sessionId) ?? new Set<string>()
  ids.add(toolUseId)
  pendingTaskToolUseIdsBySession.set(sessionId, ids)
}

function consumePendingTaskToolUseId(sessionId: string, toolUseId: string): boolean {
  const ids = pendingTaskToolUseIdsBySession.get(sessionId)
  if (!ids?.has(toolUseId)) return false
  ids.delete(toolUseId)
  if (ids.size === 0) pendingTaskToolUseIdsBySession.delete(sessionId)
  return true
}

function clearPendingTaskToolUseIds(sessionId: string): void {
  pendingTaskToolUseIdsBySession.delete(sessionId)
}

function rememberPendingToolParentUseId(
  sessionId: string,
  toolUseId: string | null | undefined,
  parentToolUseId: string | undefined,
): void {
  if (!toolUseId || !parentToolUseId) return
  const parentUseIds = pendingToolParentUseIdsBySession.get(sessionId) ?? new Map<string, string>()
  parentUseIds.set(toolUseId, parentToolUseId)
  pendingToolParentUseIdsBySession.set(sessionId, parentUseIds)
}

function getPendingToolParentUseId(sessionId: string, toolUseId: string): string | undefined {
  return pendingToolParentUseIdsBySession.get(sessionId)?.get(toolUseId)
}

function consumePendingToolParentUseId(sessionId: string, toolUseId: string): string | undefined {
  const parentUseIds = pendingToolParentUseIdsBySession.get(sessionId)
  if (!parentUseIds) return undefined
  const parentToolUseId = parentUseIds.get(toolUseId)
  parentUseIds.delete(toolUseId)
  if (parentUseIds.size === 0) pendingToolParentUseIdsBySession.delete(sessionId)
  return parentToolUseId
}

function clearPendingToolParentUseIds(sessionId: string): void {
  pendingToolParentUseIdsBySession.delete(sessionId)
}
const AGENT_COMPLETION_NOTIFICATION_PREVIEW_CHARS = 160
const COMPACT_SUMMARY_PREFIX =
  'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.'
const COMPACT_SUMMARY_CUTOFFS = [
  '\n\nIf you need specific details from before compaction',
  '\n\nContinue the conversation from where it left off',
  '\nContinue the conversation from where it left off',
]

let msgCounter = 0
const nextId = () => `msg-${++msgCounter}-${Date.now()}`

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readJsonStringLiteral(source: string, quoteIndex: number): string | undefined {
  if (source[quoteIndex] !== '"') return undefined
  let value = ''
  for (let index = quoteIndex + 1; index < source.length; index += 1) {
    const char = source[index]
    if (char === '\\') {
      const escaped = source[index + 1]
      if (escaped === undefined) return undefined
      value += char + escaped
      index += 1
      continue
    }
    if (char === '"') {
      try {
        return JSON.parse(`"${value}"`) as string
      } catch {
        return value
      }
    }
    value += char
  }
  return undefined
}

function extractPartialJsonStringField(source: string, field: string): string | undefined {
  const key = `"${field}"`
  const keyIndex = source.indexOf(key)
  if (keyIndex < 0) return undefined
  const colonIndex = source.indexOf(':', keyIndex + key.length)
  if (colonIndex < 0) return undefined

  let valueIndex = colonIndex + 1
  while (valueIndex < source.length && /\s/.test(source[valueIndex] ?? '')) {
    valueIndex += 1
  }
  return readJsonStringLiteral(source, valueIndex)
}

function buildPartialToolInputPreview(
  partialInput: string,
  previousInput: unknown,
): Record<string, unknown> {
  const previous = isRecord(previousInput) ? previousInput : {}
  const preview: Record<string, unknown> = { ...previous }
  for (const field of ['file_path', 'filePath', 'path', 'command', 'pattern', 'url', 'query', 'description']) {
    const value = extractPartialJsonStringField(partialInput, field)
    if (value !== undefined) {
      preview[field] = value
    }
  }
  return preview
}

function upsertToolUseMessage(
  messages: UIMessage[],
  toolUseId: string,
  build: (existing?: ToolCall) => ToolCall,
): UIMessage[] {
  const existingIndex = messages.findIndex(
    (message): message is ToolCall =>
      message.type === 'tool_use' && message.toolUseId === toolUseId,
  )
  if (existingIndex < 0) {
    return [...messages, build()]
  }

  const next = [...messages]
  next[existingIndex] = build(messages[existingIndex] as ToolCall)
  return next
}

function markPendingToolUseMessagesStopped(messages: UIMessage[]): UIMessage[] {
  const resolvedToolUseIds = new Set(
    messages
      .filter((message) => message.type === 'tool_result')
      .map((message) => message.toolUseId),
  )
  let changed = false
  const stoppedMessages = messages.map((message) => {
    if (
      message.type !== 'tool_use' ||
      (!message.isPending && resolvedToolUseIds.has(message.toolUseId))
    ) {
      return message
    }
    changed = true
    return {
      ...message,
      isPending: false,
      status: 'stopped' as const,
    }
  })
  return changed ? stoppedMessages : messages
}

// Streaming throttle for content_delta. Buffers must be per-session because
// multiple desktop tabs can stream at the same time.
const pendingDeltaBySession = new Map<string, string>()
const flushTimerBySession = new Map<string, ReturnType<typeof setTimeout>>()
const pendingToolInputDeltaBySession = new Map<string, string>()
const toolInputFlushTimerBySession = new Map<string, ReturnType<typeof setTimeout>>()

function consumePendingDelta(sessionId: string): string {
  const flushTimer = flushTimerBySession.get(sessionId)
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimerBySession.delete(sessionId)
  }
  const text = pendingDeltaBySession.get(sessionId) ?? ''
  pendingDeltaBySession.delete(sessionId)
  return text
}

function appendPendingDelta(sessionId: string, text: string): void {
  pendingDeltaBySession.set(
    sessionId,
    `${pendingDeltaBySession.get(sessionId) ?? ''}${text}`,
  )
}

function clearPendingDelta(sessionId: string): void {
  const flushTimer = flushTimerBySession.get(sessionId)
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimerBySession.delete(sessionId)
  }
  pendingDeltaBySession.delete(sessionId)
}

function consumePendingToolInputDelta(sessionId: string): string {
  const flushTimer = toolInputFlushTimerBySession.get(sessionId)
  if (flushTimer) {
    clearTimeout(flushTimer)
    toolInputFlushTimerBySession.delete(sessionId)
  }
  const text = pendingToolInputDeltaBySession.get(sessionId) ?? ''
  pendingToolInputDeltaBySession.delete(sessionId)
  return text
}

function appendPendingToolInputDelta(sessionId: string, text: string): void {
  pendingToolInputDeltaBySession.set(
    sessionId,
    `${pendingToolInputDeltaBySession.get(sessionId) ?? ''}${text}`,
  )
}

function clearPendingToolInputDelta(sessionId: string): void {
  const flushTimer = toolInputFlushTimerBySession.get(sessionId)
  if (flushTimer) {
    clearTimeout(flushTimer)
    toolInputFlushTimerBySession.delete(sessionId)
  }
  pendingToolInputDeltaBySession.delete(sessionId)
}

function appendAssistantTextMessage(
  messages: UIMessage[],
  content: string,
  timestamp: number,
  model?: string,
  transcriptMessageId?: string,
): UIMessage[] {
  const trimmedContent = content.trim()
  if (!trimmedContent) return messages

  const last = messages[messages.length - 1]
  // Wake/reconnect replay can resend persisted assistant text without a
  // transcript id. Ignore chunks that are already present in the hydrated tail.
  if (
    last?.type === 'assistant_text' &&
    last.transcriptMessageId &&
    !transcriptMessageId &&
    last.content.trim().includes(trimmedContent)
  ) {
    return messages
  }

  const canMergeIntoLast =
    last?.type === 'assistant_text' &&
    (
      transcriptMessageId
        ? last.transcriptMessageId === transcriptMessageId
        : !last.transcriptMessageId
    )
  if (canMergeIntoLast) {
    const merged: UIMessage = {
      ...last,
      content: last.content + content,
      ...(model ?? last.model ? { model: model ?? last.model } : {}),
      ...(transcriptMessageId ?? last.transcriptMessageId
        ? { transcriptMessageId: transcriptMessageId ?? last.transcriptMessageId }
        : {}),
    }
    return [...messages.slice(0, -1), merged]
  }

  return [
    ...messages,
    {
      id: nextId(),
      type: 'assistant_text',
      content,
      timestamp,
      ...(transcriptMessageId ? { transcriptMessageId } : {}),
      ...(model ? { model } : {}),
    },
  ]
}

function extractCompactSummaryContent(content: unknown): string | null {
  if (typeof content !== 'string') return null
  const trimmed = content.trim()
  if (!trimmed.startsWith(COMPACT_SUMMARY_PREFIX)) return null

  let summary = trimmed.slice(COMPACT_SUMMARY_PREFIX.length).trim()
  for (const marker of COMPACT_SUMMARY_CUTOFFS) {
    const index = summary.indexOf(marker)
    if (index >= 0) {
      summary = summary.slice(0, index).trim()
    }
  }
  return summary || null
}

function compactMetadataFromUnknown(data: unknown): Pick<CompactSummaryMessage, 'trigger' | 'preTokens' | 'messagesSummarized'> {
  if (!data || typeof data !== 'object') return {}
  const record = data as Record<string, unknown>
  const trigger = record.trigger === 'manual' || record.trigger === 'auto'
    ? record.trigger
    : undefined
  const preTokens = typeof record.preTokens === 'number'
    ? record.preTokens
    : typeof record.pre_tokens === 'number'
      ? record.pre_tokens
      : undefined
  const messagesSummarized = typeof record.messagesSummarized === 'number'
    ? record.messagesSummarized
    : typeof record.messages_summarized === 'number'
      ? record.messages_summarized
      : undefined

  return {
    ...(trigger ? { trigger } : {}),
    ...(preTokens !== undefined ? { preTokens } : {}),
    ...(messagesSummarized !== undefined ? { messagesSummarized } : {}),
  }
}

function appendOrUpdateTailCompactSummary(
  messages: UIMessage[],
  update: Partial<Omit<CompactSummaryMessage, 'id' | 'type' | 'timestamp'>>,
  timestamp: number,
): UIMessage[] {
  const existingIndex = messages.length - 1
  const existingMessage = messages[existingIndex]
  if (existingMessage?.type === 'compact_summary') {
    const existing = existingMessage
    const next: CompactSummaryMessage = {
      ...existing,
      ...update,
      title: update.title ?? existing.title,
      timestamp: existing.timestamp,
    }
    return [
      ...messages.slice(0, existingIndex),
      next,
      ...messages.slice(existingIndex + 1),
    ]
  }

  return [
    ...messages,
    {
      id: nextId(),
      type: 'compact_summary',
      title: update.title ?? 'Context compacted',
      ...update,
      timestamp,
    },
  ]
}

function dropTailCompactingCompactSummary(messages: UIMessage[]): UIMessage[] {
  const tail = messages[messages.length - 1]
  if (tail?.type === 'compact_summary' && tail.phase === 'compacting') {
    return messages.slice(0, -1)
  }
  return messages
}

function upsertBackgroundTaskMessage(
  messages: UIMessage[],
  task: BackgroundAgentTask,
  timestamp: number,
): UIMessage[] {
  const isSameTaskMessage = (message: UIMessage) =>
    message.type === 'background_task' &&
    (message.task.taskId === task.taskId ||
      (task.toolUseId && message.task.toolUseId === task.toolUseId))

  if (isAgentBackgroundTask(task)) {
    return messages.filter((message) => !isSameTaskMessage(message))
  }

  const existingIndex = messages.findIndex((message) =>
    isSameTaskMessage(message))
  if (existingIndex === -1) {
    return [...messages, {
      id: `background-task-${task.taskId}`,
      type: 'background_task',
      task,
      timestamp,
    }]
  }

  return messages.map((message, index) =>
    index === existingIndex && message.type === 'background_task'
      ? { ...message, task: { ...message.task, ...task }, timestamp: message.timestamp || timestamp }
      : message)
}

function buildBackgroundTaskSessionUpdate(
  session: PerSessionState,
  backgroundAgentTasks: Record<string, BackgroundAgentTask>,
  task: BackgroundAgentTask | undefined,
  timestamp: number,
): Partial<PerSessionState> {
  const messages = task
    ? upsertBackgroundTaskMessage(session.messages, task, timestamp)
    : session.messages

  return {
    backgroundAgentTasks,
    ...(messages !== session.messages ? { messages } : {}),
  }
}

function mergeBackgroundTaskMessages(
  messages: UIMessage[],
  tasks: Record<string, BackgroundAgentTask>,
): UIMessage[] {
  const merged = Object.values(tasks).reduce(
    (current, task) => upsertBackgroundTaskMessage(current, task, task.updatedAt),
    messages,
  )
  return [...merged].sort((a, b) => a.timestamp - b.timestamp)
}

function isAgentBackgroundTask(task: Pick<BackgroundAgentTask, 'taskType' | 'summary'>): boolean {
  if (task.taskType === 'local_agent' || task.taskType === 'remote_agent' || task.taskType === 'dream') {
    return true
  }
  return /^Agent (?:(?:"[^"]+" )?(completed|was stopped)|(?:"[^"]+" )?failed(?::|$))/.test(
    task.summary ?? '',
  )
}

function shouldSuppressTaskNotificationResponse(session: PerSessionState): boolean {
  const lastMessage = session.messages[session.messages.length - 1]
  const hasVisibleActiveOutput =
    session.streamingText.trim().length > 0 ||
    Boolean(session.activeToolUseId) ||
    session.chatState === 'streaming' ||
    session.chatState === 'tool_executing' ||
    session.chatState === 'permission_pending'
  return !hasVisibleActiveOutput && lastMessage?.type !== 'user_text'
}

function mergeRestoredTerminalGoalEvents(
  messages: UIMessage[],
  restoredMessages: UIMessage[],
): UIMessage[] {
  const existingKeys = new Set(messages
    .filter((message): message is Extract<UIMessage, { type: 'goal_event' }> =>
      message.type === 'goal_event')
    .map((message) => `${message.action}:${message.message ?? ''}:${message.objective ?? ''}`))

  const missingTerminalEvents = restoredMessages.filter((
    message,
  ): message is Extract<UIMessage, { type: 'goal_event' }> =>
    message.type === 'goal_event' &&
    (message.action === 'completed' || message.action === 'cleared') &&
    !existingKeys.has(`${message.action}:${message.message ?? ''}:${message.objective ?? ''}`))

  return missingTerminalEvents.length > 0
    ? [...messages, ...missingTerminalEvents]
    : messages
}

function mergeRestoredTranscriptMessageIds(
  messages: UIMessage[],
  restoredMessages: UIMessage[],
): UIMessage[] {
  const restoredCandidates = restoredMessages.filter((
    message,
  ): message is Extract<UIMessage, { type: 'user_text' | 'assistant_text' }> =>
    (message.type === 'user_text' || message.type === 'assistant_text') &&
    typeof message.transcriptMessageId === 'string' &&
    message.transcriptMessageId.length > 0)

  if (restoredCandidates.length === 0) return messages

  let restoredCursor = 0
  let changed = false
  const merged = messages.map((message) => {
    if (
      (message.type !== 'user_text' && message.type !== 'assistant_text') ||
      message.transcriptMessageId
    ) {
      return message
    }

    const matchIndex = restoredCandidates.findIndex((candidate, index) =>
      index >= restoredCursor &&
      candidate.type === message.type &&
      candidate.content.trim() === message.content.trim())

    if (matchIndex === -1) return message

    restoredCursor = matchIndex + 1
    changed = true
    return {
      ...message,
      transcriptMessageId: restoredCandidates[matchIndex]!.transcriptMessageId,
    }
  })

  return changed ? merged : messages
}

function dropDuplicateTranscriptTextMessages(messages: UIMessage[]): UIMessage[] {
  const seen = new Set<string>()
  const deduped: UIMessage[] = []
  let changed = false

  for (const message of messages) {
    if (
      (message.type === 'user_text' || message.type === 'assistant_text') &&
      message.transcriptMessageId
    ) {
      const key = `${message.type}:${message.transcriptMessageId}:${message.content.trim()}`
      if (seen.has(key)) {
        changed = true
        continue
      }
      seen.add(key)
    }

    deduped.push(message)
  }

  return changed ? deduped : messages
}

function mergeRestoredHistoryIntoLiveMessages(
  messages: UIMessage[],
  restoredMessages: UIMessage[],
): UIMessage[] {
  return mergeRestoredTerminalGoalEvents(
    dropDuplicateTranscriptTextMessages(
      mergeRestoredTranscriptMessageIds(messages, restoredMessages),
    ),
    restoredMessages,
  )
}

function needsTranscriptIdHydrationRetry(session: PerSessionState | undefined): boolean {
  if (!session || session.chatState !== 'idle') return false

  let currentTurnHasHydratedUser = false
  for (const message of session.messages) {
    if (message.type === 'user_text') {
      currentTurnHasHydratedUser = Boolean(message.transcriptMessageId)
      continue
    }
    if (
      currentTurnHasHydratedUser &&
      message.type === 'assistant_text' &&
      !message.transcriptMessageId
    ) {
      return true
    }
  }

  return false
}

function refreshCompletedTranscriptHistory(
  get: () => ChatStore,
  sessionId: string,
): void {
  void get().loadHistory(sessionId).then(() => {
    if (!needsTranscriptIdHydrationRetry(get().sessions[sessionId])) return
    setTimeout(() => {
      if (!needsTranscriptIdHydrationRetry(get().sessions[sessionId])) return
      void get().loadHistory(sessionId)
    }, 750)
  })
}

function reconcileCompletedTranscriptHistory(
  get: () => ChatStore,
  sessionId: string,
  replaceHistory: boolean,
): void {
  if (!replaceHistory) {
    refreshCompletedTranscriptHistory(get, sessionId)
    return
  }

  const session = get().sessions[sessionId]
  if (!session) return
  void get().reloadHistory(sessionId, {
    messages: session.messages,
    backgroundAgentTasks: session.backgroundAgentTasks,
  })
}

function normalizeMemoryEventFiles(data: unknown): MemoryEventFile[] {
  if (!data || typeof data !== 'object') return []
  const writtenPaths = (data as { writtenPaths?: unknown }).writtenPaths
  if (!Array.isArray(writtenPaths)) return []
  return writtenPaths
    .filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
    .map((path) => ({ path, action: 'saved' as const }))
}

function normalizeMemoryTeamCount(data: unknown): number | undefined {
  if (!data || typeof data !== 'object') return undefined
  const teamCount = (data as { teamCount?: unknown }).teamCount
  return typeof teamCount === 'number' && Number.isFinite(teamCount)
    ? teamCount
    : undefined
}

function normalizeNotificationPreview(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_~>#-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildAgentCompletionNotification(
  sessionId: string,
  messages: UIMessage[],
  text: string,
): { title: string; body: string; dedupeKey: string } | null {
  const preview = normalizeNotificationPreview(text)
  if (!preview) return null

  const lastAssistant = [...messages].reverse().find((message) => message.type === 'assistant_text')
  const suffix = preview.length > AGENT_COMPLETION_NOTIFICATION_PREVIEW_CHARS ? '...' : ''
  return {
    title: 'Claude Code Haha 已完成回复',
    body: preview.slice(0, AGENT_COMPLETION_NOTIFICATION_PREVIEW_CHARS) + suffix,
    dedupeKey: `agent-completion:${sessionId}:${lastAssistant?.id ?? Date.now()}`,
  }
}

/** Helper: immutably update a specific session within the sessions record */
function updateSessionIn(
  sessions: Record<string, PerSessionState>,
  sessionId: string,
  updater: (s: PerSessionState) => Partial<PerSessionState>,
): Record<string, PerSessionState> {
  const session = sessions[sessionId]
  if (!session) return sessions
  return { ...sessions, [sessionId]: { ...session, ...updater(session) } }
}

type SlashCommandState = PerSessionState['slashCommands'][number]

function normalizeSlashCommand(command: unknown): SlashCommandState | null {
  if (!command || typeof command !== 'object') return null
  const candidate = command as { name?: unknown; description?: unknown; argumentHint?: unknown }
  if (typeof candidate.name !== 'string' || !candidate.name) return null
  return {
    name: candidate.name,
    description: typeof candidate.description === 'string' ? candidate.description : '',
    ...(typeof candidate.argumentHint === 'string' && candidate.argumentHint
      ? { argumentHint: candidate.argumentHint }
      : {}),
  }
}

function normalizeSlashCommandList(commands: ReadonlyArray<unknown>): SlashCommandState[] {
  return commands
    .map(normalizeSlashCommand)
    .filter((command): command is SlashCommandState => command !== null)
}

function mergeSlashCommandUpdates(
  current: ReadonlyArray<SlashCommandState>,
  incoming: ReadonlyArray<SlashCommandState>,
): SlashCommandState[] {
  const merged = new Map<string, SlashCommandState>()
  for (const command of current) {
    if (command.name) merged.set(command.name, command)
  }
  for (const command of incoming) {
    if (command.name) merged.set(command.name, command)
  }
  return [...merged.values()]
}

function readUsageToken(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function summarizeTokenUsageFromHistory(messages: MessageEntry[]): TokenUsage | null {
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0

  for (const message of messages) {
    const usage = message.usage
    if (!usage) continue
    inputTokens += readUsageToken(usage.input_tokens)
    outputTokens += readUsageToken(usage.output_tokens)
    cacheReadTokens += readUsageToken(usage.cache_read_input_tokens)
    cacheCreationTokens += readUsageToken(usage.cache_creation_input_tokens)
  }

  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheCreationTokens === 0) {
    return null
  }

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(cacheReadTokens > 0 ? { cache_read_tokens: cacheReadTokens } : {}),
    ...(cacheCreationTokens > 0 ? { cache_creation_tokens: cacheCreationTokens } : {}),
  }
}

async function fetchAndMapSessionHistory(sessionId: string) {
  const { messages, taskNotifications } = await sessionsApi.getMessages(sessionId)
  const uiMessages = mapHistoryMessagesToUiMessages(messages)
  const restoredNotifications = {
    ...reconstructAgentNotifications(messages),
    ...agentNotificationRecordFromList(taskNotifications ?? []),
  }
  return {
    rawMessages: messages,
    uiMessages,
    activeGoal: deriveActiveGoalFromMessages(uiMessages),
    restoredNotifications,
    restoredBackgroundTasks: backgroundTaskRecordFromNotifications(Object.values(restoredNotifications)),
    lastTodos: extractLastTodoWriteFromHistory(messages),
    hasMessagesAfterTaskCompletion: hasUserMessagesAfterTaskCompletion(messages),
    tokenUsage: summarizeTokenUsageFromHistory(messages),
  }
}

const historyLoadsInFlight = new Map<string, Promise<void>>()

function shouldPrewarmSession(sessionId: string): boolean {
  const knownSession = useSessionStore.getState().sessions.find((session) => session.id === sessionId)
  return !knownSession || knownSession.messageCount === 0
}

export const useChatStore = create<ChatStore>((set, get) => ({
  sessions: {},

  getSession: (sessionId) => get().sessions[sessionId] ?? createDefaultSessionState(),

  connectToSession: (sessionId) => {
    void useCLITaskStore.getState().fetchSessionTasks(sessionId)

    const existing = get().sessions[sessionId]
    if (existing && existing.connectionState !== 'disconnected') {
      if (
        existing.messages.length === 0 &&
        (existing.historyStatus === 'idle' || existing.historyStatus === 'error')
      ) {
        void get().loadHistory(sessionId)
      }
      return
    }

    set((s) => ({
      sessions: {
        ...s.sessions,
        [sessionId]: {
          ...createDefaultSessionState(),
          connectionState: 'connecting',
          messages: existing?.messages ?? [],
          activeGoal: existing?.activeGoal ?? null,
          composerDraft: existing?.composerDraft ?? null,
          queuedUserMessages: existing?.queuedUserMessages ?? [],
        },
      },
    }))

    wsManager.clearHandlers(sessionId)
    wsManager.connect(sessionId)
    wsManager.onMessage(sessionId, (msg) => {
      if (msg.type === 'connected') {
        set((s) => ({ sessions: updateSessionIn(s.sessions, sessionId, () => ({ connectionState: 'connected' })) }))
      }
      get().handleServerMessage(sessionId, msg)
    })

    const runtimeSelection = useSessionRuntimeStore.getState().selections[sessionId]
    if (runtimeSelection) {
      wsManager.send(sessionId, { type: 'set_runtime_config', ...runtimeSelection })
    }
    if (
      !sessionId.startsWith('__') &&
      !useTeamStore.getState().getMemberBySessionId(sessionId) &&
      shouldPrewarmSession(sessionId)
    ) {
      wsManager.send(sessionId, { type: 'prewarm_session' })
    }

    get().loadHistory(sessionId)
    sessionsApi.getSlashCommands(sessionId)
      .then(({ commands }) => {
        if (get().sessions[sessionId]) {
          set((s) => ({ sessions: updateSessionIn(s.sessions, sessionId, () => ({ slashCommands: commands })) }))
        }
      })
      .catch(() => {
        if (get().sessions[sessionId]) {
          set((s) => ({ sessions: updateSessionIn(s.sessions, sessionId, () => ({ slashCommands: [] })) }))
        }
      })
  },

  disconnectSession: (sessionId) => {
    const session = get().sessions[sessionId]
    if (session?.elapsedTimer) clearInterval(session.elapsedTimer)
    if (pendingDeltaBySession.has(sessionId)) {
      const text = consumePendingDelta(sessionId)
      set((s) => ({ sessions: updateSessionIn(s.sessions, sessionId, (sess) => ({ streamingText: sess.streamingText + text })) }))
    }
    clearPendingToolInputDelta(sessionId)
    clearPendingTaskToolUseIds(sessionId)
    clearPendingToolParentUseIds(sessionId)
    wsManager.disconnect(sessionId)
    set((s) => {
      const { [sessionId]: _, ...rest } = s.sessions
      return { sessions: rest }
    })
  },

  sendMessage: (sessionId, content, attachments, options) => {
    const isMemberSession = !!useTeamStore.getState().getMemberBySessionId(sessionId)
    const hideDisplayContent = !isMemberSession && options?.hideDisplayContent === true
    const userFacingContent =
      hideDisplayContent
        ? ''
        : options?.displayContent?.trim() || content.trim()
    const modelFacingContent = buildModelContent(content, attachments)
    const visibleAttachments = options?.displayAttachments ?? attachments
    const uiAttachments: UIAttachment[] | undefined =
      visibleAttachments && visibleAttachments.length > 0
        ? visibleAttachments.map((a) => ({
            type: a.type,
            name: a.name || a.path || a.mimeType || a.type,
            path: a.path,
            data: a.data,
            mimeType: a.mimeType,
            lineStart: a.lineStart,
            lineEnd: a.lineEnd,
            diffSide: a.diffSide,
            hunkId: a.hunkId,
            note: a.note,
            quote: a.quote,
          }))
        : undefined

    const taskStore = useCLITaskStore.getState()
    const sessionTasks = taskStore.sessionId === sessionId ? taskStore.tasks : []
    const allTasksDone = sessionTasks.length > 0 && sessionTasks.every((t) => t.status === 'completed')
    const completedTaskSummary = allTasksDone
      ? sessionTasks.map((t) => ({ id: t.id, subject: t.subject, status: t.status, activeForm: t.activeForm }))
      : []

    if (!isMemberSession && allTasksDone) {
      void taskStore.resetCompletedTasks(sessionId)
    }

    if (!isMemberSession) {
      updateOptimisticSessionTitle(sessionId, userFacingContent || content.trim())
    }

    set((s) => {
      const session = s.sessions[sessionId] ?? createDefaultSessionState()
      const bufferedDelta = consumePendingDelta(sessionId)
      const pendingAssistantText = `${session.streamingText}${bufferedDelta}`
      const now = Date.now()

      const newMessages = pendingAssistantText.trim()
        ? appendAssistantTextMessage(session.messages, pendingAssistantText, now)
        : [...session.messages]
      if (!isMemberSession && allTasksDone) {
        newMessages.push({
          id: nextId(),
          type: 'task_summary',
          tasks: completedTaskSummary,
          timestamp: now,
        })
      }
      newMessages.push({
        id: nextId(),
        type: 'user_text',
        content: userFacingContent,
        ...(userFacingContent !== modelFacingContent ? { modelContent: modelFacingContent } : {}),
        attachments: isMemberSession ? undefined : uiAttachments,
        timestamp: now,
        ...(isMemberSession ? { pending: true } : {}),
      })

      if (!isMemberSession && session.elapsedTimer) clearInterval(session.elapsedTimer)

      const timer = !isMemberSession
        ? setInterval(() => {
            set((st) => ({ sessions: updateSessionIn(st.sessions, sessionId, (sess) => ({ elapsedSeconds: sess.elapsedSeconds + 1 })) }))
          }, 1000)
        : null

      return {
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...session,
            messages: newMessages,
            chatState: 'thinking',
            elapsedSeconds: 0,
            suppressNextTaskNotificationResponse: false,
            replaceHistoryOnCompletion: false,
            streamingText: '',
            streamingResponseChars: 0,
            statusVerb: isMemberSession ? '' : randomSpinnerVerb(),
            apiRetry: null,
            streamingFallback: null,
            elapsedTimer: timer,
            connectionState: isMemberSession ? 'connected' : session.connectionState,
          },
        },
      }
    })

    if (isMemberSession) {
      void useTeamStore.getState().sendMessageToMember(sessionId, userFacingContent)
        .catch((err) => {
          set((s) => ({
            sessions: updateSessionIn(s.sessions, sessionId, (session) => ({
              chatState: 'idle',
              messages: [
                ...session.messages,
                {
                  id: nextId(),
                  type: 'error',
                  message: err instanceof Error ? err.message : String(err),
                  code: 'TEAM_MEMBER_MESSAGE_FAILED',
                  timestamp: Date.now(),
                },
              ],
            })),
          }))
        })
      return
    }

    wsManager.send(sessionId, { type: 'user_message', content, attachments })
  },

  respondToPermission: (sessionId, requestId, allowed, options) => {
    wsManager.send(sessionId, {
      type: 'permission_response',
      requestId,
      allowed,
      ...(options?.rule ? { rule: options.rule } : {}),
      ...(options?.updatedInput ? { updatedInput: options.updatedInput } : {}),
      ...(options?.denyMessage ? { denyMessage: options.denyMessage } : {}),
      ...(options?.permissionUpdates?.length ? { permissionUpdates: options.permissionUpdates } : {}),
    })
    set((s) => ({
      sessions: updateSessionIn(s.sessions, sessionId, (session) => {
        const pendingPermissions = getPendingPermissionRecord(session)
        delete pendingPermissions[requestId]
        const remainingPermissions = Object.values(pendingPermissions)

        return {
          pendingPermissions,
          pendingPermission: remainingPermissions[remainingPermissions.length - 1] ?? null,
          chatState: remainingPermissions.length > 0 ||
            Object.keys(getPendingComputerUsePermissionRecord(session)).length > 0
            ? 'permission_pending'
            : allowed ? 'tool_executing' : 'idle',
        }
      }),
    }))
  },

  respondToComputerUsePermission: (sessionId, requestId, response) => {
    wsManager.send(sessionId, {
      type: 'computer_use_permission_response',
      requestId,
      response,
    })
    set((s) => ({
      sessions: updateSessionIn(s.sessions, sessionId, (session) => {
        const pendingComputerUsePermissions = getPendingComputerUsePermissionRecord(session)
        delete pendingComputerUsePermissions[requestId]
        const remainingPermissions = Object.values(pendingComputerUsePermissions)

        return {
          pendingComputerUsePermissions,
          pendingComputerUsePermission: getCurrentComputerUsePermission(
            pendingComputerUsePermissions,
            session.pendingComputerUsePermission,
          ),
          chatState: Object.keys(getPendingPermissionRecord(session)).length > 0 ||
            remainingPermissions.length > 0
            ? 'permission_pending'
            : response.userConsented === false ? 'idle' : 'tool_executing',
        }
      }),
    }))
  },

  setSessionRuntime: (sessionId, selection) => {
    wsManager.send(sessionId, {
      type: 'set_runtime_config',
      ...selection,
    })
  },

  setSessionPermissionMode: (sessionId, mode) => {
    const session = get().sessions[sessionId]
    if (!session || session.chatState !== 'idle') return
    wsManager.send(sessionId, { type: 'set_permission_mode', mode })
  },

  stopGeneration: (sessionId) => {
    wsManager.send(sessionId, { type: 'stop_generation' })
    const bufferedText = consumePendingDelta(sessionId)
    clearPendingToolInputDelta(sessionId)
    clearPendingTaskToolUseIds(sessionId)
    clearPendingToolParentUseIds(sessionId)
    let hasRunningBackgroundAgents = false
    set((s) => {
      const session = s.sessions[sessionId]
      if (!session) return s
      hasRunningBackgroundAgents = hasRunningBackgroundTasks(session.backgroundAgentTasks)
      if (session.elapsedTimer) clearInterval(session.elapsedTimer)
      const pendingAssistantText = `${session.streamingText}${bufferedText}`
      const messagesWithFlushedText = pendingAssistantText.trim()
        ? appendAssistantTextMessage(session.messages, pendingAssistantText, Date.now())
        : session.messages
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...session,
            messages: markPendingToolUseMessagesStopped(messagesWithFlushedText),
            chatState: 'idle',
            activeToolUseId: null,
            activeToolName: null,
            activeThinkingId: null,
            streamingText: '',
            streamingToolInput: '',
            statusVerb: '',
            pendingPermission: null,
            pendingPermissions: {},
            pendingComputerUsePermission: null,
            pendingComputerUsePermissions: {},
            apiRetry: null,
            streamingFallback: null,
            suppressNextTaskNotificationResponse: false,
            elapsedTimer: null,
          },
        },
      }
    })
    useTabStore.getState().updateTabStatus(sessionId, hasRunningBackgroundAgents ? 'running' : 'idle')
  },

  stopBackgroundTask: (sessionId, taskId) => {
    const session = get().sessions[sessionId]
    const task = session?.backgroundAgentTasks?.[taskId]
    if (!task || task.status !== 'running' || session?.stoppingBackgroundTaskIds?.[taskId]) return

    set((state) => ({
      sessions: updateSessionIn(state.sessions, sessionId, (current) => ({
        stoppingBackgroundTaskIds: {
          ...current.stoppingBackgroundTaskIds,
          [taskId]: true,
        },
      })),
    }))
    wsManager.send(sessionId, { type: 'stop_background_task', taskId })
  },

  loadHistory: async (sessionId) => {
    const existingLoad = historyLoadsInFlight.get(sessionId)
    if (existingLoad) return existingLoad

    let load!: Promise<void>
    load = (async () => {
      try {
        set((state) => {
          const session = state.sessions[sessionId]
          if (!session) return state
          return {
            sessions: updateSessionIn(state.sessions, sessionId, () => ({
              historyStatus: 'loading',
              historyError: null,
            })),
          }
        })
        const {
          uiMessages,
          activeGoal,
          restoredNotifications,
          restoredBackgroundTasks,
          lastTodos,
          hasMessagesAfterTaskCompletion,
          tokenUsage,
        } = await fetchAndMapSessionHistory(sessionId)
        set((state) => {
          const session = state.sessions[sessionId]
          if (!session) return state
          if (session.messages.length > 0) {
            return { sessions: updateSessionIn(state.sessions, sessionId, (s) => ({
              historyStatus: 'ready',
              historyError: null,
              activeGoal: activeGoal ?? s.activeGoal ?? null,
              agentTaskNotifications: { ...s.agentTaskNotifications, ...restoredNotifications },
              backgroundAgentTasks: mergeBackgroundAgentTaskRecords(
                s.backgroundAgentTasks ?? {},
                restoredBackgroundTasks,
              ),
              tokenUsage: tokenUsage ?? s.tokenUsage,
              messages: mergeRestoredHistoryIntoLiveMessages(
                mergeBackgroundTaskMessages(s.messages, restoredBackgroundTasks),
                uiMessages,
              ),
            })) }
          }
          return { sessions: updateSessionIn(state.sessions, sessionId, (s) => ({
            historyStatus: 'ready',
            historyError: null,
            messages: mergeBackgroundTaskMessages(uiMessages, restoredBackgroundTasks),
            activeGoal,
            agentTaskNotifications: { ...s.agentTaskNotifications, ...restoredNotifications },
            backgroundAgentTasks: mergeBackgroundAgentTaskRecords(
              s.backgroundAgentTasks ?? {},
              restoredBackgroundTasks,
            ),
            tokenUsage: tokenUsage ?? s.tokenUsage,
          })) }
        })
        if (lastTodos && lastTodos.length > 0) {
          const taskStore = useCLITaskStore.getState()
          if (taskStore.sessionId === sessionId && taskStore.tasks.length === 0) taskStore.setTasksFromTodos(lastTodos, sessionId)
        } else {
          useCLITaskStore.getState().setTasksFromTodos([], sessionId)
        }
        if (hasMessagesAfterTaskCompletion) {
          useCLITaskStore.getState().markCompletedAndDismissed(sessionId)
        }
      } catch (error) {
        // Session may not have messages yet
        set((state) => {
          const session = state.sessions[sessionId]
          if (!session) return state
          return {
            sessions: updateSessionIn(state.sessions, sessionId, () => ({
              historyStatus: 'error',
              historyError: error instanceof Error ? error.message : String(error),
            })),
          }
        })
      } finally {
        if (historyLoadsInFlight.get(sessionId) === load) {
          historyLoadsInFlight.delete(sessionId)
        }
      }
    })()

    historyLoadsInFlight.set(sessionId, load)
    return load
  },

  reloadHistory: async (sessionId, guard) => {
    try {
      const {
        uiMessages,
        activeGoal,
        restoredNotifications,
        restoredBackgroundTasks,
        lastTodos,
        hasMessagesAfterTaskCompletion,
        tokenUsage,
      } = await fetchAndMapSessionHistory(sessionId)

      if (guard) {
        const current = get().sessions[sessionId]
        if (
          !current ||
          current.chatState !== 'idle' ||
          current.messages !== guard.messages ||
          current.backgroundAgentTasks !== guard.backgroundAgentTasks
        ) {
          return
        }
      }

      set((state) => {
        const session = state.sessions[sessionId]
        if (!session) return state
        if (session.elapsedTimer) clearInterval(session.elapsedTimer)
        return {
          sessions: updateSessionIn(state.sessions, sessionId, () => ({
            historyStatus: 'ready',
            historyError: null,
            messages: mergeBackgroundTaskMessages(uiMessages, restoredBackgroundTasks),
            activeGoal,
            agentTaskNotifications: restoredNotifications,
            backgroundAgentTasks: restoredBackgroundTasks,
            tokenUsage: tokenUsage ?? session.tokenUsage,
            chatState: 'idle',
            activeThinkingId: null,
            activeToolUseId: null,
            activeToolName: null,
            streamingText: '',
            streamingToolInput: '',
            pendingPermission: null,
            pendingPermissions: {},
            pendingComputerUsePermission: null,
            pendingComputerUsePermissions: {},
            elapsedTimer: null,
            statusVerb: '',
            apiRetry: null,
            streamingFallback: null,
          })),
        }
      })

      if (lastTodos && lastTodos.length > 0) {
        useCLITaskStore.getState().setTasksFromTodos(lastTodos, sessionId)
      } else {
        useCLITaskStore.getState().setTasksFromTodos([], sessionId)
      }
      if (hasMessagesAfterTaskCompletion) {
        useCLITaskStore.getState().markCompletedAndDismissed(sessionId)
      }
    } catch {
      // Session may not have messages yet
    }
  },

  queueComposerPrefill: (sessionId, prefill) => {
    set((state) => ({
      sessions: updateSessionIn(state.sessions, sessionId, () => ({
        composerPrefill: {
          text: prefill.text,
          attachments: prefill.attachments,
          mode: prefill.mode,
          nonce: Date.now(),
        },
      })),
    }))
  },

  clearComposerPrefill: (sessionId, nonce) => {
    set((state) => ({
      sessions: updateSessionIn(state.sessions, sessionId, (session) => {
        if (nonce !== undefined && session.composerPrefill?.nonce !== nonce) return {}
        return { composerPrefill: null }
      }),
    }))
  },

  queueComposerInsertion: (sessionId, insertion) => {
    set((state) => ({
      sessions: updateSessionIn(state.sessions, sessionId, () => ({
        composerInsertion: {
          ...insertion,
          nonce: Date.now(),
        },
      })),
    }))
  },

  clearComposerInsertion: (sessionId, nonce) => {
    set((state) => ({
      sessions: updateSessionIn(state.sessions, sessionId, (session) => {
        if (nonce !== undefined && session.composerInsertion?.nonce !== nonce) return {}
        return { composerInsertion: null }
      }),
    }))
  },

  setComposerDraft: (sessionId, draft) => {
    set((state) => {
      const session = state.sessions[sessionId] ?? createDefaultSessionState()
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            composerDraft: draft,
          },
        },
      }
    })
  },

  clearComposerDraft: (sessionId) => {
    set((state) => ({
      sessions: updateSessionIn(state.sessions, sessionId, () => ({
        composerDraft: null,
      })),
    }))
  },

  queueUserMessage: (sessionId, message) => {
    const id = `queued-user-${Date.now()}-${Math.random().toString(36).slice(2)}`
    set((state) => {
      const session = state.sessions[sessionId] ?? createDefaultSessionState()
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            queuedUserMessages: [
              ...(session.queuedUserMessages ?? []),
              {
                ...message,
                id,
                createdAt: Date.now(),
              },
            ],
          },
        },
      }
    })
    return id
  },

  updateQueuedUserMessage: (sessionId, messageId, content) => {
    const nextContent = content.trim()
    if (!nextContent) return
    set((state) => ({
      sessions: updateSessionIn(state.sessions, sessionId, (session) => ({
        queuedUserMessages: (session.queuedUserMessages ?? []).map((message) =>
          message.id === messageId
            ? {
                ...message,
                content: replaceQueuedMessageDisplayContent(message, nextContent),
                displayContent: nextContent,
              }
            : message),
      })),
    }))
  },

  removeQueuedUserMessage: (sessionId, messageId) => {
    set((state) => ({
      sessions: updateSessionIn(state.sessions, sessionId, (session) => ({
        queuedUserMessages: (session.queuedUserMessages ?? []).filter((message) => message.id !== messageId),
      })),
    }))
  },

  sendQueuedUserMessage: (sessionId, messageId) => {
    const session = get().sessions[sessionId]
    const queuedMessage = (session?.queuedUserMessages ?? []).find((message) => message.id === messageId)
    if (!session || !queuedMessage) return

    if (session.chatState === 'idle') {
      get().removeQueuedUserMessage(sessionId, messageId)
      get().sendMessage(
        sessionId,
        queuedMessage.content,
        queuedMessage.attachments,
        {
          displayContent: queuedMessage.displayContent,
          displayAttachments: queuedMessage.displayAttachments,
        },
      )
      return
    }

    const now = Date.now()
    set((state) => ({
      sessions: updateSessionIn(state.sessions, sessionId, (currentSession) => {
        const pendingText = `${currentSession.streamingText}${consumePendingDelta(sessionId)}`
        const baseMessages = pendingText.trim()
          ? appendAssistantTextMessage(currentSession.messages, pendingText, now)
          : currentSession.messages
        return {
          messages: appendOptimisticQueuedUserMessage(baseMessages, queuedMessage, now),
          queuedUserMessages: (currentSession.queuedUserMessages ?? [])
            .filter((message) => message.id !== messageId),
          ...(pendingText.trim() ? { streamingText: '' } : {}),
          suppressNextTaskNotificationResponse: false,
          replaceHistoryOnCompletion: false,
        }
      }),
    }))

    wsManager.send(sessionId, {
      type: 'user_message',
      content: queuedMessage.content,
      attachments: queuedMessage.attachments,
    })
  },

  clearMessages: (sessionId) => {
    clearPendingTaskToolUseIds(sessionId)
    clearPendingToolParentUseIds(sessionId)
    clearPendingToolInputDelta(sessionId)
    set((s) => ({ sessions: updateSessionIn(s.sessions, sessionId, () => ({
      messages: [],
      activeGoal: null,
      streamingText: '',
      chatState: 'idle',
      apiRetry: null,
      streamingFallback: null,
      suppressNextTaskNotificationResponse: false,
      replaceHistoryOnCompletion: false,
      queuedUserMessages: [],
    })) }))
  },

  handleServerMessage: (sessionId, msg) => {
    const update = (updater: (session: PerSessionState) => Partial<PerSessionState>) => {
      set((s) => ({ sessions: updateSessionIn(s.sessions, sessionId, updater) }))
    }
    const ensureElapsedTimer = () => {
      const session = get().sessions[sessionId]
      if (!session || session.elapsedTimer) return
      const timer = setInterval(() => {
        set((st) => ({
          sessions: updateSessionIn(st.sessions, sessionId, (sess) => ({
            elapsedSeconds: sess.elapsedSeconds + 1,
          })),
        }))
      }, 1000)
      update(() => ({ elapsedTimer: timer }))
    }
    const clearElapsedTimer = () => {
      const session = get().sessions[sessionId]
      if (!session?.elapsedTimer) return
      clearInterval(session.elapsedTimer)
      update(() => ({ elapsedTimer: null }))
    }

    switch (msg.type) {
      case 'connected':
        break

      case 'session_state': {
        const session = get().sessions[sessionId]
        if (!session) break

        if (msg.turnState === 'running') {
          // Raw deltas are not replayable across a socket gap. Discard the
          // uncommitted attempt instead of appending new deltas (or a missed
          // stream_retry attempt) to stale text/tool JSON. Persisted completed
          // messages are merged back below while the turn remains running.
          consumePendingDelta(sessionId)
          clearPendingToolInputDelta(sessionId)
          clearPendingTaskToolUseIds(sessionId)
          clearPendingToolParentUseIds(sessionId)
          update((current) => {
            const startIndex = Math.max(
              0,
              Math.min(
                current.streamAttemptStartIndex ?? current.messages.length,
                current.messages.length,
              ),
            )
            return {
              messages: [
                ...current.messages.slice(0, startIndex),
                ...current.messages.slice(startIndex).filter((message) =>
                  message.type !== 'assistant_text' &&
                  message.type !== 'thinking' &&
                  !(message.type === 'tool_use' && message.isPending)),
              ],
              chatState: 'thinking',
              streamingText: '',
              streamingToolInput: '',
              activeThinkingId: null,
              activeToolUseId: null,
              activeToolName: null,
              streamingResponseChars:
                current.streamAttemptStartResponseChars ?? current.streamingResponseChars,
              streamAttemptStartIndex: undefined,
              streamAttemptStartResponseChars: undefined,
              apiRetry: null,
              streamingFallback: null,
              statusVerb: '',
              replaceHistoryOnCompletion: true,
            }
          })
          useTabStore.getState().updateTabStatus(sessionId, 'running')
          ensureElapsedTimer()
          void get().loadHistory(sessionId)
          break
        }

        if (session.chatState === 'idle') break

        const text = `${session.streamingText}${consumePendingDelta(sessionId)}`
        clearPendingToolInputDelta(sessionId)
        clearPendingTaskToolUseIds(sessionId)
        clearPendingToolParentUseIds(sessionId)
        if (session.elapsedTimer) clearInterval(session.elapsedTimer)
        const messagesWithText = text.trim()
          ? appendAssistantTextMessage(session.messages, text, Date.now())
          : session.messages
        update(() => ({
          messages: markPendingToolUseMessagesStopped(messagesWithText),
          chatState: 'idle',
          activeThinkingId: null,
          activeToolUseId: null,
          activeToolName: null,
          pendingPermission: null,
          pendingComputerUsePermission: null,
          elapsedTimer: null,
          statusVerb: '',
          apiRetry: null,
          streamingFallback: null,
          streamingText: '',
          streamingToolInput: '',
        }))
        const reconciledSession = get().sessions[sessionId]
        const hasRunningBackgroundAgents = hasRunningBackgroundTasks(
          reconciledSession?.backgroundAgentTasks,
        )
        useTabStore.getState().updateTabStatus(
          sessionId,
          hasRunningBackgroundAgents ? 'running' : 'idle',
        )
        // The terminal event may have arrived while this renderer was offline.
        // Replace optimistic/partial state with the persisted transcript.
        if (reconciledSession) {
          void get().reloadHistory(sessionId, {
            messages: reconciledSession.messages,
            backgroundAgentTasks: reconciledSession.backgroundAgentTasks,
          })
        }
        break
      }

      case 'status':
        update((session) => {
          const pendingText = `${session.streamingText}${consumePendingDelta(sessionId)}`
          const hasPendingStreamText =
            session.chatState === 'streaming' && pendingText.trim().length > 0
          // Background task progress can arrive while the assistant is still
          // streaming one markdown reply. Keep that turn intact so we do not
          // split formatting markers (for example backticks/strong markers)
          // across separate bubbles.
          const preserveStreamingTurn = hasPendingStreamText && msg.state !== 'idle' && msg.state !== 'compacting'
          const shouldFlush = hasPendingStreamText && (msg.state === 'idle' || msg.state === 'compacting')
          let nextMessages = session.messages
          if (shouldFlush) {
            nextMessages = appendAssistantTextMessage(nextMessages, pendingText, Date.now())
          }
          if (msg.state === 'compacting') {
            nextMessages = appendOrUpdateTailCompactSummary(
              nextMessages,
              {
                title: 'Context compacted',
                phase: 'compacting',
              },
              Date.now(),
            )
          } else {
            nextMessages = dropTailCompactingCompactSummary(nextMessages)
          }
          return {
            chatState: preserveStreamingTurn ? 'streaming' : msg.state,
            statusVerb: msg.state === 'idle'
              ? ''
              : msg.verb && msg.verb !== 'Thinking'
                ? msg.verb
                : '',
            ...(msg.state === 'idle' ? { activeThinkingId: null } : {}),
            ...(msg.state === 'idle' ? { apiRetry: null, streamingFallback: null } : {}),
            ...(msg.attemptStart ? {
              streamAttemptStartIndex: session.messages.length,
              streamAttemptStartResponseChars: session.streamingResponseChars,
            } : {}),
            ...(nextMessages !== session.messages ? { messages: nextMessages } : {}),
            ...(shouldFlush ? {
              streamingText: '',
            } : pendingText !== session.streamingText ? { streamingText: pendingText } : {}),
          }
        })
        if (msg.state !== 'idle') ensureElapsedTimer()
        if (msg.state === 'idle') {
          clearElapsedTimer()
        }
        // Sync tab status
        useTabStore.getState().updateTabStatus(
          sessionId,
          msg.state === 'idle' && !hasRunningBackgroundTasks(get().sessions[sessionId]?.backgroundAgentTasks)
            ? 'idle'
            : 'running',
        )
        break

      case 'permission_mode_changed': {
        // CLI 是权限模式的真相来源。这里把它恢复/切换后的权威值校正到本地镜像。
        // 注意：只更新本地状态，**不要**走 setSessionPermissionMode —— 那会把
        // set_permission_mode 再回发给 CLI 形成回环。未知模式直接忽略，避免
        // 选择器拿到无法渲染的值。
        const KNOWN_MODES: PermissionMode[] = ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions', 'dontAsk']
        if (KNOWN_MODES.includes(msg.mode)) {
          useSessionStore.getState().updateSessionPermissionMode(sessionId, msg.mode)
        }
        break
      }

      case 'content_start': {
        const session = get().sessions[sessionId]
        if (!session) break
        if (session.suppressNextTaskNotificationResponse && msg.blockType === 'text') {
          consumePendingDelta(sessionId)
          update(() => ({
            streamingText: '',
            activeThinkingId: null,
            statusVerb: '',
          }))
          break
        }
        if (session.suppressNextTaskNotificationResponse) {
          update(() => ({ suppressNextTaskNotificationResponse: false }))
        }
        const pendingText = `${session.streamingText}${consumePendingDelta(sessionId)}`
        if (msg.blockType !== 'text' && pendingText.trim()) {
          update((s) => ({
            messages: appendAssistantTextMessage(s.messages, pendingText, Date.now()),
            streamingText: '',
          }))
        }
        if (msg.blockType === 'text') {
          update((s) => ({
            ...(pendingText !== s.streamingText ? { streamingText: pendingText } : {}),
            chatState: 'streaming',
            activeThinkingId: null,
            apiRetry: null,
            streamingFallback: null,
          }))
        } else if (msg.blockType === 'tool_use') {
          clearPendingToolInputDelta(sessionId)
          rememberPendingToolParentUseId(sessionId, msg.toolUseId, msg.parentToolUseId)
          const toolUseId = msg.toolUseId ?? null
          const toolName = msg.toolName ?? 'unknown'
          update((s) => ({
            ...(toolUseId
              ? {
                  messages: upsertToolUseMessage(s.messages, toolUseId, (existing) => ({
                    id: existing?.id ?? nextId(),
                    type: 'tool_use',
                    toolName,
                    toolUseId,
                    input: existing?.input ?? {},
                    timestamp: existing?.timestamp ?? Date.now(),
                    parentToolUseId: msg.parentToolUseId ?? existing?.parentToolUseId,
                    isPending: true,
                    partialInput: existing?.partialInput ?? '',
                  })),
                }
              : {}),
            activeToolUseId: toolUseId,
            activeToolName: toolName,
            streamingToolInput: '',
            chatState: 'tool_executing',
            activeThinkingId: null,
            apiRetry: null,
            streamingFallback: null,
          }))
        }
        ensureElapsedTimer()
        break
      }

      case 'api_retry': {
        const attempt = Math.max(1, Math.trunc(msg.attempt))
        const maxRetries = Math.max(attempt, Math.trunc(msg.maxRetries))
        const retryDelayMs = Math.max(0, Math.trunc(msg.retryDelayMs))
        update((session) => ({
          apiRetry: {
            attempt,
            maxRetries,
            retryDelayMs,
            errorStatus: msg.errorStatus ?? null,
            errorType: msg.errorType,
            errorMessage: msg.errorMessage,
            receivedAt: Date.now(),
          },
          chatState: session.chatState === 'idle' ? 'thinking' : session.chatState,
          activeThinkingId: null,
          statusVerb: '',
        }))
        ensureElapsedTimer()
        useTabStore.getState().updateTabStatus(sessionId, 'running')
        break
      }

      case 'streaming_fallback': {
        if (msg.cause === 'stream_retry') {
          consumePendingDelta(sessionId)
          clearPendingToolInputDelta(sessionId)
          clearPendingTaskToolUseIds(sessionId)
          clearPendingToolParentUseIds(sessionId)
          update((session) => {
            const startIndex = Math.max(
              0,
              Math.min(
                session.streamAttemptStartIndex ?? session.messages.length,
                session.messages.length,
              ),
            )
            const messages = [
              ...session.messages.slice(0, startIndex),
              ...session.messages.slice(startIndex).filter((message) =>
                message.type !== 'assistant_text' &&
                message.type !== 'thinking' &&
                !(message.type === 'tool_use' && message.isPending)),
            ]
            return {
              messages,
              streamingText: '',
              streamingToolInput: '',
              activeToolUseId: null,
              activeToolName: null,
              activeThinkingId: null,
              streamingResponseChars:
                session.streamAttemptStartResponseChars ?? session.streamingResponseChars,
              streamAttemptStartIndex: undefined,
              streamAttemptStartResponseChars: undefined,
              streamingFallback: null,
              apiRetry: null,
              chatState: 'thinking',
              statusVerb: '',
            }
          })
          ensureElapsedTimer()
          useTabStore.getState().updateTabStatus(sessionId, 'running')
          break
        }

        // 进入非流式降级阶段：旧的重试横幅（针对失败的流式请求）已过时，
        // 清掉换成降级提示；后续非流式重试到来的 api_retry 会重新接管显示。
        update((session) => ({
          streamingFallback: {
            cause: msg.cause,
            receivedAt: Date.now(),
          },
          apiRetry: null,
          chatState: session.chatState === 'idle' ? 'thinking' : session.chatState,
          activeThinkingId: null,
          statusVerb: '',
        }))
        ensureElapsedTimer()
        useTabStore.getState().updateTabStatus(sessionId, 'running')
        break
      }

      case 'content_delta':
        if (get().sessions[sessionId]?.suppressNextTaskNotificationResponse) {
          consumePendingDelta(sessionId)
          break
        }
        let receivedLiveDelta = false
        if (msg.text !== undefined) {
          if (!get().sessions[sessionId]) break
          receivedLiveDelta = true
          appendPendingDelta(sessionId, msg.text)
          if (!flushTimerBySession.has(sessionId)) {
            const timer = setTimeout(() => {
              const text = pendingDeltaBySession.get(sessionId) ?? ''
              pendingDeltaBySession.delete(sessionId)
              flushTimerBySession.delete(sessionId)
              update((s) => ({
                streamingText: s.streamingText + text,
                streamingResponseChars: s.streamingResponseChars + text.length,
              }))
            }, 50)
            flushTimerBySession.set(sessionId, timer)
          }
        }
        if (msg.toolInput !== undefined) {
          receivedLiveDelta = true
          appendPendingToolInputDelta(sessionId, msg.toolInput)
          if (!toolInputFlushTimerBySession.has(sessionId)) {
            const timer = setTimeout(() => {
              const text = consumePendingToolInputDelta(sessionId)
              if (!text) return
              update((s) => {
                const partialInput = s.streamingToolInput + text
                const activeToolUseId = s.activeToolUseId
                return {
                  streamingToolInput: partialInput,
                  streamingResponseChars: s.streamingResponseChars + text.length,
                  ...(activeToolUseId
                    ? {
                        messages: upsertToolUseMessage(s.messages, activeToolUseId, (existing) => {
                          const toolName = existing?.toolName ?? s.activeToolName ?? 'unknown'
                          return {
                            id: existing?.id ?? nextId(),
                            type: 'tool_use',
                            toolName,
                            toolUseId: activeToolUseId,
                            input: buildPartialToolInputPreview(partialInput, existing?.input),
                            timestamp: existing?.timestamp ?? Date.now(),
                            parentToolUseId: existing?.parentToolUseId ?? getPendingToolParentUseId(sessionId, activeToolUseId),
                            isPending: true,
                            partialInput,
                          }
                        }),
                      }
                    : {}),
                }
              })
            }, 50)
            toolInputFlushTimerBySession.set(sessionId, timer)
          }
        }
        if (receivedLiveDelta && get().sessions[sessionId]?.chatState !== 'idle') ensureElapsedTimer()
        break

      case 'thinking':
        if (get().sessions[sessionId]?.suppressNextTaskNotificationResponse) {
          consumePendingDelta(sessionId)
          update(() => ({
            streamingText: '',
            activeThinkingId: null,
            statusVerb: '',
          }))
          break
        }
        update((s) => {
          const pendingText = `${s.streamingText}${consumePendingDelta(sessionId)}`
          const base = pendingText.trim()
            ? appendAssistantTextMessage(s.messages, pendingText, Date.now())
            : s.messages
          const last = base[base.length - 1]
          if (last && last.type === 'thinking') {
            const updated = [...base]
            updated[updated.length - 1] = { ...last, content: last.content + msg.text }
            return {
              messages: updated,
              chatState: 'thinking',
              activeThinkingId: last.id,
              streamingText: '',
              streamingResponseChars: s.streamingResponseChars + msg.text.length,
            }
          }
          const id = nextId()
          return {
            messages: [...base, { id, type: 'thinking', content: msg.text, timestamp: Date.now() }],
            chatState: 'thinking',
            activeThinkingId: id,
            streamingText: '',
            streamingResponseChars: s.streamingResponseChars + msg.text.length,
          }
        })
        ensureElapsedTimer()
        break

      case 'tool_use_complete': {
        clearPendingToolInputDelta(sessionId)
        const session = get().sessions[sessionId]
        const toolName = msg.toolName || session?.activeToolName || 'unknown'
        const toolUseId = msg.toolUseId || session?.activeToolUseId || ''
        const parentToolUseId = msg.parentToolUseId ?? getPendingToolParentUseId(sessionId, toolUseId)
        rememberPendingToolParentUseId(sessionId, toolUseId, parentToolUseId)
        update((s) => ({
          messages: toolUseId
            ? upsertToolUseMessage(s.messages, toolUseId, (existing) => ({
                id: existing?.id ?? nextId(),
                type: 'tool_use',
                toolName,
                toolUseId,
                input: msg.input,
                timestamp: existing?.timestamp ?? Date.now(),
                parentToolUseId,
                isPending: false,
              }))
            : [...s.messages, {
                id: nextId(), type: 'tool_use', toolName,
                toolUseId,
                input: msg.input, timestamp: Date.now(), parentToolUseId,
                isPending: false,
              }],
          activeToolUseId: null, activeToolName: null, activeThinkingId: null, streamingToolInput: '',
        }))
        if (toolName === 'TodoWrite' && Array.isArray((msg.input as any)?.todos)) {
          useCLITaskStore.getState().setTasksFromTodos((msg.input as any).todos, sessionId)
        } else if (TASK_TOOL_NAMES.has(toolName)) {
          const useId = msg.toolUseId || session?.activeToolUseId
          if (useId) addPendingTaskToolUseId(sessionId, useId)
        }
        break
      }

      case 'tool_result': {
        const now = Date.now()
        const pendingParentToolUseId = consumePendingToolParentUseId(sessionId, msg.toolUseId)
        const parentToolUseId = msg.parentToolUseId ?? pendingParentToolUseId
        update((s) => {
          let messages: UIMessage[] = [...s.messages, {
            id: nextId(), type: 'tool_result', toolUseId: msg.toolUseId,
            content: msg.content, isError: msg.isError, timestamp: now, parentToolUseId,
          }]
          let backgroundAgentTasks = s.backgroundAgentTasks ?? {}
          const stoppedTask = msg.isError
            ? null
            : getStoppedBackgroundTaskFromToolResult(s.messages, msg.toolUseId, msg.content)
          if (stoppedTask) {
            backgroundAgentTasks = upsertBackgroundAgentTask(backgroundAgentTasks, stoppedTask, now)
            const task = backgroundAgentTasks[stoppedTask.taskId]
            if (task) {
              messages = upsertBackgroundTaskMessage(messages, task, now)
            }
          }
          return {
            messages,
            ...(stoppedTask ? { backgroundAgentTasks } : {}),
            chatState: hasPendingPermissionRequests(s)
              ? 'permission_pending'
              : 'thinking',
            activeThinkingId: null,
          }
        })
        if (consumePendingTaskToolUseId(sessionId, msg.toolUseId)) {
          useCLITaskStore.getState().refreshTasks(sessionId)
        }
        break
      }

      case 'permission_request':
        notifyDesktop({
          dedupeKey: `permission:${msg.requestId}`,
          cooldownScope: 'permission-prompt',
          requestAttention: true,
          title: 'Claude Code Haha 需要你的确认',
          body: msg.toolName
            ? `${msg.toolName} 请求执行，正在等待允许。`
            : '有一个工具请求正在等待允许。',
          target: { type: 'session', sessionId },
        })
        update((s) => {
          const pendingPermission: PendingPermission = {
            requestId: msg.requestId,
            toolName: msg.toolName,
            toolUseId: msg.toolUseId,
            input: msg.input,
            description: msg.description,
          }
          const pendingPermissions = {
            ...getPendingPermissionRecord(s),
            [msg.requestId]: pendingPermission,
          }
          const hasPermissionMessage = s.messages.some((message) =>
            message.type === 'permission_request' && message.requestId === msg.requestId)

          return {
            pendingPermission,
            pendingPermissions,
            chatState: 'permission_pending',
            activeThinkingId: null,
            apiRetry: null,
            streamingFallback: null,
            messages:
              msg.toolName === 'AskUserQuestion' || hasPermissionMessage
                ? s.messages
                : [...s.messages, {
                    id: nextId(),
                    type: 'permission_request',
                    requestId: msg.requestId,
                    toolName: msg.toolName,
                    toolUseId: msg.toolUseId,
                    input: msg.input,
                    description: msg.description,
                    timestamp: Date.now(),
                  }],
          }
        })
        break

      case 'computer_use_permission_request':
        notifyDesktop({
          dedupeKey: `computer-use-permission:${msg.requestId}`,
          cooldownScope: 'permission-prompt',
          requestAttention: true,
          title: 'Claude Code Haha 需要你的确认',
          body: msg.request.reason || 'Computer Use 正在等待允许。',
          target: { type: 'session', sessionId },
        })
        update((session) => {
          const pendingComputerUsePermission = {
            requestId: msg.requestId,
            request: msg.request,
          }
          const pendingComputerUsePermissions = {
            ...getPendingComputerUsePermissionRecord(session),
            [msg.requestId]: pendingComputerUsePermission,
          }
          return {
            pendingComputerUsePermission: getCurrentComputerUsePermission(
              pendingComputerUsePermissions,
              session.pendingComputerUsePermission,
            ),
            pendingComputerUsePermissions,
            chatState: 'permission_pending',
            activeThinkingId: null,
            apiRetry: null,
            streamingFallback: null,
          }
        })
        break

      case 'permission_resolved':
        update((session) => {
          if (msg.permissionType === 'computer_use') {
            const pendingComputerUsePermissions = getPendingComputerUsePermissionRecord(session)
            if (!pendingComputerUsePermissions[msg.requestId]) return {}
            delete pendingComputerUsePermissions[msg.requestId]
            const remainingPermissions = Object.values(pendingComputerUsePermissions)

            return {
              pendingComputerUsePermissions,
              pendingComputerUsePermission: getCurrentComputerUsePermission(
                pendingComputerUsePermissions,
                session.pendingComputerUsePermission,
              ),
              chatState: getChatStateAfterPermissionResolution(
                session,
                Object.keys(getPendingPermissionRecord(session)).length > 0 ||
                  remainingPermissions.length > 0,
                msg.allowed,
              ),
            }
          }

          const pendingPermissions = getPendingPermissionRecord(session)
          if (!pendingPermissions[msg.requestId]) return {}
          delete pendingPermissions[msg.requestId]
          const remainingPermissions = Object.values(pendingPermissions)
          return {
            pendingPermissions,
            pendingPermission: remainingPermissions[remainingPermissions.length - 1] ?? null,
            chatState: getChatStateAfterPermissionResolution(
              session,
              remainingPermissions.length > 0 ||
                Object.keys(getPendingComputerUsePermissionRecord(session)).length > 0,
              msg.allowed,
            ),
          }
        })
        break

      case 'permission_requests_snapshot':
        update((session) => {
          const toolRequestIds = new Set(msg.toolRequestIds)
          const pendingPermissions = Object.fromEntries(
            Object.entries(getPendingPermissionRecord(session))
              .filter(([requestId]) => toolRequestIds.has(requestId)),
          )
          const computerUseRequestIds = new Set(msg.computerUseRequestIds)
          const pendingComputerUsePermissions = Object.fromEntries(
            Object.entries(getPendingComputerUsePermissionRecord(session))
              .filter(([requestId]) => computerUseRequestIds.has(requestId)),
          )
          const remainingPermissions = Object.values(pendingPermissions)
          const remainingComputerUsePermissions = Object.values(pendingComputerUsePermissions)
          const hasRemainingPermissions = remainingPermissions.length > 0 ||
            remainingComputerUsePermissions.length > 0

          return {
            pendingPermissions,
            pendingPermission: remainingPermissions[remainingPermissions.length - 1] ?? null,
            pendingComputerUsePermissions,
            pendingComputerUsePermission: getCurrentComputerUsePermission(
              pendingComputerUsePermissions,
              session.pendingComputerUsePermission,
            ),
            chatState: hasRemainingPermissions
              ? 'permission_pending'
              : !msg.turnActive
                ? 'idle'
                : session.chatState === 'idle' || session.chatState === 'permission_pending'
                  ? 'thinking'
                  : session.chatState,
          }
        })
        break

      case 'message_complete': {
        const session = get().sessions[sessionId]
        if (!session) break
        if (session.suppressNextTaskNotificationResponse) {
          consumePendingDelta(sessionId)
          clearPendingToolInputDelta(sessionId)
          if (session.elapsedTimer) clearInterval(session.elapsedTimer)
          const hasRunningBackgroundAgents = hasRunningBackgroundTasks(session.backgroundAgentTasks)
          update(() => ({
            tokenUsage: msg.usage,
            chatState: 'idle',
            activeThinkingId: null,
            pendingPermission: null,
            pendingPermissions: {},
            pendingComputerUsePermission: null,
            pendingComputerUsePermissions: {},
            elapsedTimer: null,
            apiRetry: null,
            streamingFallback: null,
            streamingText: '',
            streamingToolInput: '',
            suppressNextTaskNotificationResponse: false,
            replaceHistoryOnCompletion: false,
          }))
          useTabStore.getState().updateTabStatus(sessionId, hasRunningBackgroundAgents ? 'running' : 'idle')
          reconcileCompletedTranscriptHistory(
            get,
            sessionId,
            session.replaceHistoryOnCompletion === true,
          )
          for (const queuedMessage of get().sessions[sessionId]?.queuedUserMessages ?? []) {
            get().sendQueuedUserMessage(sessionId, queuedMessage.id)
          }
          break
        }
        const completedAt = Date.now()
        const wasAgentRunning = session.chatState !== 'idle'
        const text = `${session.streamingText}${consumePendingDelta(sessionId)}`
        let completionMessages = session.messages
        if (text.trim()) {
          completionMessages = appendAssistantTextMessage(session.messages, text, completedAt)
          update(() => ({
            messages: completionMessages,
            streamingText: '',
          }))
        } else if (text !== session.streamingText) {
          update(() => ({ streamingText: text }))
        }
        const appendedCompletionMessage = completionMessages !== session.messages
        const finalMessages = markPendingToolUseMessagesStopped(completionMessages)
        const hasRunningBackgroundAgents = hasRunningBackgroundTasks(session.backgroundAgentTasks)
        if (session.elapsedTimer) clearInterval(session.elapsedTimer)
        update(() => ({
          messages: finalMessages,
          tokenUsage: msg.usage,
          chatState: 'idle',
          activeThinkingId: null,
          pendingPermission: null,
          pendingPermissions: {},
          pendingComputerUsePermission: null,
          pendingComputerUsePermissions: {},
          elapsedTimer: null,
          apiRetry: null,
          streamingFallback: null,
          replaceHistoryOnCompletion: false,
        }))
        useTabStore.getState().updateTabStatus(sessionId, hasRunningBackgroundAgents ? 'running' : 'idle')
        const notification = wasAgentRunning && appendedCompletionMessage
          ? buildAgentCompletionNotification(sessionId, finalMessages, text)
          : null
        if (notification) {
          void notifyDesktop({
            dedupeKey: notification.dedupeKey,
            cooldownScope: 'agent-completion',
            title: notification.title,
            body: notification.body,
            target: { type: 'session', sessionId },
          })
        }
        reconcileCompletedTranscriptHistory(
          get,
          sessionId,
          session.replaceHistoryOnCompletion === true,
        )
        for (const queuedMessage of get().sessions[sessionId]?.queuedUserMessages ?? []) {
          get().sendQueuedUserMessage(sessionId, queuedMessage.id)
        }
        break
      }

      case 'user_message_replay': {
        update((session) => {
          const pendingText = `${session.streamingText}${consumePendingDelta(sessionId)}`
          const baseMessages = pendingText.trim()
            ? appendAssistantTextMessage(session.messages, pendingText, Date.now())
            : session.messages
          return {
            messages: appendReplayedUserMessage(baseMessages, msg.content, Date.now()),
            ...(pendingText.trim() ? { streamingText: '' } : {}),
            activeThinkingId: null,
            suppressNextTaskNotificationResponse: false,
            replaceHistoryOnCompletion: false,
          }
        })
        break
      }

      case 'error':
        update((s) => {
          const pendingText = `${s.streamingText}${consumePendingDelta(sessionId)}`
          let newMessages = s.messages
          if (pendingText.trim()) {
            newMessages = appendAssistantTextMessage(newMessages, pendingText, Date.now())
          }
          newMessages = dropTailCompactingCompactSummary(newMessages)
          newMessages = [
            ...newMessages,
            {
              id: nextId(),
              type: 'error',
              message: msg.message,
              code: msg.code,
              ...(msg.businessErrorCode ? { businessErrorCode: msg.businessErrorCode } : {}),
              timestamp: Date.now(),
            },
          ]
          return {
            messages: newMessages,
            chatState: 'idle',
            activeThinkingId: null,
            streamingText: '',
            statusVerb: '',
            pendingPermission: null,
            pendingPermissions: {},
            pendingComputerUsePermission: null,
            pendingComputerUsePermissions: {},
            apiRetry: null,
            streamingFallback: null,
            suppressNextTaskNotificationResponse: false,
          }
        })
        useTabStore.getState().updateTabStatus(sessionId, 'error')
        {
          const session = get().sessions[sessionId]
          if (session?.elapsedTimer) {
            clearInterval(session.elapsedTimer)
            update(() => ({ elapsedTimer: null }))
          }
        }
        break

      case 'background_task_stop_failed':
        update((session) => {
          const stoppingBackgroundTaskIds = { ...session.stoppingBackgroundTaskIds }
          delete stoppingBackgroundTaskIds[msg.taskId]
          const taskAlreadyFinished = session.backgroundAgentTasks?.[msg.taskId]?.status !== 'running'
          return {
            stoppingBackgroundTaskIds,
            ...(taskAlreadyFinished ? {} : {
              messages: [
                ...session.messages,
                {
                  id: nextId(),
                  type: 'error',
                  message: msg.message,
                  code: 'STOP_BACKGROUND_TASK_FAILED',
                  timestamp: Date.now(),
                },
              ],
            }),
          }
        })
        break

      case 'team_created':
        useTeamStore.getState().handleTeamCreated(msg.teamName)
        break
      case 'team_update':
        useTeamStore.getState().handleTeamUpdate(msg.teamName, msg.members)
        break
      case 'team_deleted':
        useTeamStore.getState().handleTeamDeleted(msg.teamName)
        break
      case 'task_update':
        break
      case 'session_title_updated':
        useSessionStore.getState().updateSessionTitle(msg.sessionId, msg.title)
        useTabStore.getState().updateTabTitle(msg.sessionId, msg.title)
        break
      case 'system_notification':
        if (msg.subtype === 'slash_commands' && Array.isArray(msg.data)) {
          const incomingCommands = normalizeSlashCommandList(msg.data)
          update((session) => ({
            slashCommands: mergeSlashCommandUpdates(session.slashCommands, incomingCommands),
          }))
          void sessionsApi.getSlashCommands(sessionId)
            .then(({ commands }) => {
              if (!get().sessions[sessionId]) return
              set((s) => ({
                sessions: updateSessionIn(s.sessions, sessionId, () => ({
                  slashCommands: normalizeSlashCommandList(commands),
                })),
              }))
            })
            .catch(() => {
              // Keep the last known local + CLI union when the authoritative refresh is unavailable.
            })
        }
        if (msg.subtype === 'session_cleared') {
          const session = get().sessions[sessionId]
          if (session?.elapsedTimer) clearInterval(session.elapsedTimer)
          update(() => ({
            messages: [],
            streamingText: '',
            streamingToolInput: '',
            activeToolUseId: null,
            activeToolName: null,
            activeThinkingId: null,
            pendingPermission: null,
            pendingPermissions: {},
            pendingComputerUsePermission: null,
            pendingComputerUsePermissions: {},
            chatState: 'idle',
            elapsedTimer: null,
            elapsedSeconds: 0,
            statusVerb: '',
            apiRetry: null,
            streamingFallback: null,
            tokenUsage: { input_tokens: 0, output_tokens: 0 },
            streamingResponseChars: 0,
            slashCommands: [],
            activeGoal: null,
            backgroundAgentTasks: {},
            stoppingBackgroundTaskIds: {},
            agentTaskNotifications: {},
          }))
          clearPendingDelta(sessionId)
          clearPendingTaskToolUseIds(sessionId)
          clearPendingToolParentUseIds(sessionId)
          useCLITaskStore.getState().clearTasks(sessionId)
          useSessionStore.getState().updateSessionTitle(sessionId, 'New Session')
          useSessionStore.getState().updateSessionMessageCount(sessionId, 0)
          useTabStore.getState().updateTabTitle(sessionId, 'New Session')
          useTabStore.getState().updateTabStatus(sessionId, 'idle')
        }
        if (msg.subtype === 'compact_boundary') {
          const metadata = compactMetadataFromUnknown(msg.data)
          update((session) => ({
            chatState: session.chatState === 'compacting' ? 'thinking' : session.chatState,
            statusVerb: session.chatState === 'compacting' ? '' : session.statusVerb,
            compactCount: (session.compactCount ?? 0) + 1,
            messages: appendOrUpdateTailCompactSummary(
              session.messages,
              {
                title: typeof msg.message === 'string' && msg.message.trim()
                  ? msg.message
                  : 'Context compacted',
                phase: 'complete',
                ...metadata,
              },
              Date.now(),
            ),
          }))
        }
        if (msg.subtype === 'compact_summary') {
          const summary = extractCompactSummaryContent(msg.message)
          if (summary) {
            update((session) => ({
              messages: appendOrUpdateTailCompactSummary(
                session.messages,
                {
                  title: 'Context compacted',
                  phase: 'complete',
                  summary,
                  ...compactMetadataFromUnknown(msg.data),
                },
                Date.now(),
              ),
            }))
          }
        }
        if (msg.subtype === 'memory_saved') {
          const files = normalizeMemoryEventFiles(msg.data)
          if (files.length > 0) {
            update((session) => ({
              messages: [
                ...session.messages,
                {
                  id: nextId(),
                  type: 'memory_event',
                  event: 'saved',
                  files,
                  message: msg.message,
                  teamCount: normalizeMemoryTeamCount(msg.data),
                  timestamp: Date.now(),
                },
              ],
            }))
          }
        }
        if (msg.subtype === 'goal_event') {
          const goalEvent = normalizeGoalEventData(msg.data, msg.message)
          if (goalEvent) {
            update((session) => ({
              activeGoal: applyGoalEventToActiveGoal(session.activeGoal ?? null, goalEvent, Date.now()),
              messages: [
                ...session.messages,
                {
                  id: nextId(),
                  type: 'goal_event',
                  ...goalEvent,
                  timestamp: Date.now(),
                },
              ],
            }))
          }
        }
        if ((msg.subtype === 'task_started' || msg.subtype === 'task_progress') && msg.data && typeof msg.data === 'object') {
          const taskEvent = normalizeBackgroundAgentTaskEvent(msg.data, msg.subtype)
          if (taskEvent) {
            const now = Date.now()
            let shouldUpdateIdleTabStatus = false
            let hasRunningBackgroundAgentsAfterUpdate = false
            update((session) => {
              const backgroundAgentTasks = upsertBackgroundAgentTask(
                session.backgroundAgentTasks ?? {},
                taskEvent,
                now,
              )
              shouldUpdateIdleTabStatus = session.chatState === 'idle'
              hasRunningBackgroundAgentsAfterUpdate = hasRunningBackgroundTasks(backgroundAgentTasks)
              const task = backgroundAgentTasks[taskEvent.taskId]
              return buildBackgroundTaskSessionUpdate(session, backgroundAgentTasks, task, now)
            })
            if (shouldUpdateIdleTabStatus) {
              useTabStore.getState().updateTabStatus(
                sessionId,
                hasRunningBackgroundAgentsAfterUpdate ? 'running' : 'idle',
              )
            }
          }
        }
        if (msg.subtype === 'task_notification' && msg.data && typeof msg.data === 'object') {
          const data = msg.data as Record<string, unknown>
          const taskEvent = normalizeBackgroundAgentTaskEvent(data, 'task_notification')
          const toolUseId =
            typeof data.tool_use_id === 'string' && data.tool_use_id.trim()
              ? data.tool_use_id
              : null
          const taskResult = readNonEmptyString(data, 'result')
          const taskStatus = data.status
          if (taskEvent) {
            const now = Date.now()
            let shouldUpdateIdleTabStatus = false
            let hasRunningBackgroundAgentsAfterUpdate = false
            update((session) => {
              const backgroundAgentTasks = upsertBackgroundAgentTask(
                session.backgroundAgentTasks ?? {},
                taskEvent,
                now,
              )
              shouldUpdateIdleTabStatus = session.chatState === 'idle'
              hasRunningBackgroundAgentsAfterUpdate = hasRunningBackgroundTasks(backgroundAgentTasks)
              const task = backgroundAgentTasks[taskEvent.taskId]
              const suppressNotificationResponse =
                (taskEvent.status === 'completed' ||
                  taskEvent.status === 'failed' ||
                  taskEvent.status === 'stopped') &&
                shouldSuppressTaskNotificationResponse(session)
              const stoppingBackgroundTaskIds = { ...session.stoppingBackgroundTaskIds }
              delete stoppingBackgroundTaskIds[taskEvent.taskId]
              return {
                ...buildBackgroundTaskSessionUpdate(session, backgroundAgentTasks, task, now),
                stoppingBackgroundTaskIds,
                ...(suppressNotificationResponse ? { suppressNextTaskNotificationResponse: true } : {}),
                agentTaskNotifications: {
                  ...session.agentTaskNotifications,
                  ...(toolUseId &&
                  (taskStatus === 'completed' ||
                    taskStatus === 'failed' ||
                    taskStatus === 'stopped')
                    ? {
                        [toolUseId]: {
                          taskId: taskEvent.taskId,
                          toolUseId,
                          status: taskStatus,
                          summary: taskEvent.summary,
                          result: taskResult,
                          outputFile: taskEvent.outputFile,
                          usage: taskEvent.usage,
                        },
                      }
                    : {}),
                },
              }
            })
            if (shouldUpdateIdleTabStatus) {
              useTabStore.getState().updateTabStatus(
                sessionId,
                hasRunningBackgroundAgentsAfterUpdate ? 'running' : 'idle',
              )
            }
          }
        }
        break
      case 'pong':
        break
    }
  },
}))

function updateOptimisticSessionTitle(sessionId: string, content: string): void {
  const title = deriveSessionTitle(content)
  if (!title) return

  const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId)
  if (!session || session.messageCount > 0 || !isPlaceholderSessionTitle(session.title)) return

  useSessionStore.getState().updateSessionTitle(sessionId, title)
  useTabStore.getState().updateTabTitle(sessionId, title)
}

// ─── History mapping helpers ─────────

type AssistantHistoryBlock = { type: string; text?: string; thinking?: string; name?: string; id?: string; input?: unknown }
type UserHistoryBlock = { type: string; text?: string; tool_use_id?: string; content?: unknown; is_error?: boolean; source?: { data?: string; media_type?: string }; mimeType?: string; media_type?: string; name?: string }

const TASK_NOTIFICATION_RE = /^<task-notification>\s*[\s\S]*<\/task-notification>$/i
const GOAL_EVENT_ACTIONS = new Set<GoalEventAction>([
  'created',
  'replaced',
  'status',
  'paused',
  'resumed',
  'completed',
  'cleared',
  'message',
])

/**
 * Check if text is a teammate-message (internal agent-to-agent communication).
 * Uses full open+close tag match to avoid false positives on user text
 * that merely mentions the tag name (e.g., pasting code or discussing the protocol).
 */
function isTeammateMessage(text: string): boolean {
  return text.includes('<teammate-message') && text.includes('</teammate-message>')
}

const SIMPLE_IMAGE_SOURCE_RE = /^\[Image source: (.+)\]$/
const DETAILED_IMAGE_SOURCE_RE = /^\[Image: source: (.+?)(?:, original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by \d+(?:\.\d+)? to map to original image\.)?\]$/
const IMAGE_RESIZE_METADATA_RE = /^\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by \d+(?:\.\d+)? to map to original image\.\]$/
const VISUAL_SELECTION_PROMPT_HEADER = '请根据截图中编号 1 的蓝色标注修改本地前端。'
const VISUAL_SELECTION_PROMPT_FOOTER = '请优先依据截图里的编号标注定位元素，selector 只作为辅助线索。'

type VisualSelectionHistoryDisplay = {
  displayName: string
  selector?: string
  note?: string
}

function getHistoryImageMediaType(block: UserHistoryBlock): string {
  const mediaType = block.source?.media_type ?? block.mimeType ?? block.media_type
  return mediaType?.startsWith('image/') ? mediaType : 'image/png'
}

function normalizeHistoryImageData(data: string | undefined, mediaType: string): string | undefined {
  const trimmed = data?.trim()
  if (!trimmed) return undefined
  if (/^data:image\//i.test(trimmed)) return trimmed
  return `data:${mediaType};base64,${trimmed}`
}

function extractImageMetadataSourcePath(text: string): string | undefined {
  const trimmed = text.trim()
  const simpleMatch = trimmed.match(SIMPLE_IMAGE_SOURCE_RE)
  if (simpleMatch?.[1]) return simpleMatch[1]
  const detailedMatch = trimmed.match(DETAILED_IMAGE_SOURCE_RE)
  if (detailedMatch?.[1]) return detailedMatch[1]
  return undefined
}

function isGeneratedImageMetadataText(text: string): boolean {
  return Boolean(extractImageMetadataSourcePath(text)) || IMAGE_RESIZE_METADATA_RE.test(text.trim())
}

/**
 * Strip the generated image-metadata lines (`[Image source: …]`, resize notes)
 * that the server appends to a user turn's text. The optimistic message never
 * carried them, so live-replay dedupe must normalize them away first — otherwise
 * `findCurrentTurnUserMessageIndex` never matches and the raw prompt leaks in as
 * a duplicate bubble. This was most visible on Windows, where the appended
 * absolute upload path (`[Image source: C:\Users\…\uploads\…png]`) made the
 * mismatch obvious, but it affects any message that carries an image.
 */
export function stripGeneratedImageMetadataLines(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !isGeneratedImageMetadataText(line))
    .join('\n')
    .trim()
}

function parseVisualSelectionHistoryPrompt(text: string): VisualSelectionHistoryDisplay | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines[0]?.trim() !== VISUAL_SELECTION_PROMPT_HEADER) return null

  let displayName: string | undefined
  let selector: string | undefined
  let note: string | undefined

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? ''
    if (line.startsWith('目标元素：')) {
      displayName = line.slice('目标元素：'.length).trim()
    } else if (line.startsWith('Selector：')) {
      selector = line.slice('Selector：'.length).trim()
    } else if (line === '用户注释：') {
      const noteLines: string[] = []
      for (let noteIndex = index + 1; noteIndex < lines.length; noteIndex += 1) {
        const noteLine = lines[noteIndex] ?? ''
        if (noteLine.trim() === VISUAL_SELECTION_PROMPT_FOOTER) break
        noteLines.push(noteLine)
      }
      const trimmedNote = noteLines.join('\n').trim()
      note = trimmedNote || undefined
      break
    }
  }

  return displayName
    ? {
        displayName,
        ...(selector ? { selector } : {}),
        ...(note ? { note } : {}),
      }
    : null
}

function applyVisualSelectionHistoryDisplay(attachments: UIAttachment[], display: VisualSelectionHistoryDisplay): void {
  const imageAttachment = attachments.find((attachment) => attachment.type === 'image')
  if (!imageAttachment) return
  imageAttachment.name = display.displayName
  if (display.selector) imageAttachment.quote = display.selector
  if (display.note) imageAttachment.note = display.note
}

function normalizeHistoryImageAttachment(block: UserHistoryBlock): UIAttachment {
  const mediaType = getHistoryImageMediaType(block)
  return {
    type: 'image',
    name: block.name || 'image',
    data: normalizeHistoryImageData(block.source?.data, mediaType),
    mimeType: mediaType,
  }
}

function applyImageMetadataSourcePaths(attachments: UIAttachment[], sourcePaths: string[]): void {
  let imageIndex = 0
  for (const sourcePath of sourcePaths) {
    const attachment = attachments
      .slice(imageIndex)
      .find((candidate) => candidate.type === 'image')
    if (!attachment) return
    imageIndex = attachments.indexOf(attachment) + 1
    attachment.path = sourcePath
    if (!attachment.name || attachment.name === 'image') {
      attachment.name = getReferenceName(sourcePath)
    }
  }
}

function extractHistoryTextBlocks(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []

  return content
    .flatMap((block) => {
      if (!block || typeof block !== 'object') return []
      const record = block as Record<string, unknown>
      return record.type === 'text' && typeof record.text === 'string'
        ? [record.text]
        : []
    })
    .map((text) => text.trim())
    .filter(Boolean)
}

const COMMAND_METADATA_TAGS = new Set([
  'command-name',
  'command-message',
  'command-args',
  'local-command-caveat',
  'skill-format',
])
const COMMAND_METADATA_BLOCK_RE = /<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>\s*/gi

function hasCommandMetadataTag(text: string): boolean {
  return (
    text.includes('<command-name>') ||
    text.includes('<command-message>') ||
    text.includes('<command-args>') ||
    text.includes('<local-command-caveat>') ||
    text.includes('<skill-format>')
  )
}

function isOnlyKnownCommandMetadata(text: string): boolean {
  const remainder = text.replace(COMMAND_METADATA_BLOCK_RE, (match, tag: string) => (
    COMMAND_METADATA_TAGS.has(tag.toLowerCase()) ? '' : match
  ))
  return remainder.trim().length === 0
}

function formatCommandMetadataDisplayText(
  commandName: string,
  args: string,
  skillFormat: boolean,
  commandMessage?: string,
): string {
  if (skillFormat) {
    return `Skill(${commandMessage || commandName.replace(/^\//, '')})`
  }

  const normalizedName = commandName.startsWith('/') ? commandName : `/${commandName}`
  return [normalizedName, args.trim()].filter(Boolean).join(' ')
}

function parseCommandMetadataText(text: string): string | null {
  const trimmed = text.trim()
  if (!hasCommandMetadataTag(trimmed)) return null
  if (!isOnlyKnownCommandMetadata(trimmed)) return null

  const commandName = readXmlTag(trimmed, 'command-name')
  if (!commandName) return null

  const args = readXmlTag(trimmed, 'command-args') ?? ''
  const commandMessage = readXmlTag(trimmed, 'command-message')
  const skillFormat = readXmlTag(trimmed, 'skill-format') === 'true'
  return formatCommandMetadataDisplayText(commandName, args, skillFormat, commandMessage)
}

function getCommandMetadataDisplayText(content: unknown): string | null {
  const textBlocks = extractHistoryTextBlocks(content)
  if (textBlocks.length === 0) return null

  const displayBlocks = textBlocks.map(parseCommandMetadataText)
  if (displayBlocks.some((text) => text === null)) return null
  return displayBlocks.join('\n')
}

function shouldHideCommandMetadataContent(content: unknown): boolean {
  const textBlocks = extractHistoryTextBlocks(content)
  if (textBlocks.length === 0) return false
  if (!textBlocks.some(hasCommandMetadataTag)) return false
  return getCommandMetadataDisplayText(content) === null
}

function isTaskNotificationContent(content: unknown): boolean {
  const textBlocks = extractHistoryTextBlocks(content)
  return textBlocks.length > 0 && textBlocks.every((text) => extractTaskNotificationXml(text) !== null)
}

function extractTaskNotificationXml(text: string): string | null {
  const trimmed = text.trim()
  if (TASK_NOTIFICATION_RE.test(trimmed)) return trimmed
  return trimmed.match(/<task-notification>\s*[\s\S]*?<\/task-notification>/i)?.[0] ?? null
}

function decodeXmlText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function readXmlTag(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return match?.[1] ? decodeXmlText(match[1].trim()) : undefined
}

function readNonEmptyString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function normalizeHistoryToolResultContent(content: unknown, toolUseResult: unknown): unknown {
  const result = readRecord(toolUseResult)
  const answers = readRecord(result?.answers)
  if (!result || !answers || !Array.isArray(result.questions)) return content
  return {
    questions: result.questions,
    answers,
  }
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  const record = readRecord(value)
  if (record) return record
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    return readRecord(JSON.parse(trimmed))
  } catch {
    return null
  }
}

function findToolUseMessage(messages: UIMessage[], toolUseId: string): ToolCall | null {
  return messages.find((
    message,
  ): message is ToolCall =>
    message.type === 'tool_use' &&
    message.toolUseId === toolUseId) ?? null
}

function getStoppedBackgroundTaskFromToolResult(
  messages: UIMessage[],
  toolUseId: string,
  content: unknown,
): (Partial<BackgroundAgentTask> & Pick<BackgroundAgentTask, 'taskId' | 'status'>) | null {
  const toolUse = findToolUseMessage(messages, toolUseId)
  if (!toolUse || !TASK_STOP_TOOL_NAMES.has(toolUse.toolName)) return null

  const input = readRecord(toolUse.input) ?? {}
  const output = parseJsonRecord(content) ?? {}
  const taskId = readNonEmptyString(output, 'task_id', 'taskId') ??
    readNonEmptyString(input, 'task_id', 'taskId', 'shell_id', 'shellId')
  if (!taskId) return null

  return {
    taskId,
    status: 'stopped',
    taskType: readNonEmptyString(output, 'task_type', 'taskType'),
    description: readNonEmptyString(output, 'command', 'description', 'message'),
    summary: readNonEmptyString(output, 'message'),
  }
}

function normalizeBackgroundTaskUsage(value: unknown): BackgroundAgentTaskUsage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const usage: BackgroundAgentTaskUsage = {}
  const totalTokens = record.total_tokens ?? record.totalTokens
  const toolUses = record.tool_uses ?? record.toolUses
  const durationMs = record.duration_ms ?? record.durationMs
  if (typeof totalTokens === 'number') usage.totalTokens = totalTokens
  if (typeof toolUses === 'number') usage.toolUses = toolUses
  if (typeof durationMs === 'number') usage.durationMs = durationMs
  return Object.keys(usage).length > 0 ? usage : undefined
}

function normalizeBackgroundAgentTaskEvent(
  data: unknown,
  subtype: string,
): Partial<BackgroundAgentTask> & Pick<BackgroundAgentTask, 'taskId' | 'status'> | null {
  if (!data || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  const taskId = readNonEmptyString(record, 'task_id', 'taskId')
  const toolUseId = readNonEmptyString(record, 'tool_use_id', 'toolUseId')
  const id = taskId ?? toolUseId
  if (!id) return null

  const rawStatus = readNonEmptyString(record, 'status')
  const status = rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'stopped'
    ? rawStatus
    : rawStatus === 'killed'
      ? 'stopped'
      : subtype === 'task_notification'
        ? 'completed'
        : 'running'

  return {
    taskId: id,
    toolUseId,
    status,
    description: readNonEmptyString(record, 'description', 'message', 'title'),
    taskType: readNonEmptyString(record, 'task_type', 'taskType'),
    workflowName: readNonEmptyString(record, 'workflow_name', 'workflowName'),
    prompt: readNonEmptyString(record, 'prompt'),
    result: readNonEmptyString(record, 'result'),
    summary: readNonEmptyString(record, 'summary'),
    lastToolName: readNonEmptyString(record, 'last_tool_name', 'lastToolName'),
    outputFile: readNonEmptyString(record, 'output_file', 'outputFile'),
    usage: normalizeBackgroundTaskUsage(record.usage),
  }
}

function upsertBackgroundAgentTask(
  current: Record<string, BackgroundAgentTask>,
  event: Partial<BackgroundAgentTask> & Pick<BackgroundAgentTask, 'taskId' | 'status'>,
  now: number,
): Record<string, BackgroundAgentTask> {
  const existingKey = current[event.taskId]
    ? event.taskId
    : event.toolUseId
      ? Object.keys(current).find((key) =>
        key === event.toolUseId || current[key]?.toolUseId === event.toolUseId)
      : undefined
  const existing = existingKey ? current[existingKey] : undefined
  const next = { ...current }
  if (existingKey && existingKey !== event.taskId) {
    delete next[existingKey]
  }
  const startsNewLifecycle = Boolean(existing && (
    (existing.status !== 'running' && event.status === 'running') ||
    (existing.status !== 'running' && event.status !== 'running' && hasTerminalTaskPayloadChanged(existing, event))
  ))
  return {
    ...next,
    [event.taskId]: {
      taskId: event.taskId,
      toolUseId: event.toolUseId ?? existing?.toolUseId,
      status: event.status,
      description: event.description ?? existing?.description,
      taskType: event.taskType ?? existing?.taskType,
      workflowName: event.workflowName ?? existing?.workflowName,
      prompt: event.prompt ?? existing?.prompt,
      result: event.result ?? existing?.result,
      summary: event.summary ?? existing?.summary,
      lastToolName: event.lastToolName ?? existing?.lastToolName,
      outputFile: event.outputFile ?? existing?.outputFile,
      usage: event.usage ?? existing?.usage,
      startedAt: startsNewLifecycle ? now : existing?.startedAt ?? now,
      updatedAt: now,
    },
  }
}

function hasTerminalTaskPayloadChanged(
  existing: BackgroundAgentTask,
  event: Partial<BackgroundAgentTask> & Pick<BackgroundAgentTask, 'taskId' | 'status'>,
): boolean {
  return event.summary != null && event.summary !== existing.summary ||
    event.result != null && event.result !== existing.result ||
    event.outputFile != null && event.outputFile !== existing.outputFile ||
    event.usage != null && !areBackgroundTaskUsageEqual(event.usage, existing.usage)
}

function areBackgroundTaskUsageEqual(
  a: BackgroundAgentTaskUsage | undefined,
  b: BackgroundAgentTaskUsage | undefined,
): boolean {
  return a?.totalTokens === b?.totalTokens &&
    a?.toolUses === b?.toolUses &&
    a?.durationMs === b?.durationMs
}

function normalizeGoalEventData(
  data: unknown,
  fallbackMessage?: string,
): Omit<Extract<UIMessage, { type: 'goal_event' }>, 'id' | 'type' | 'timestamp'> | null {
  if (!data || typeof data !== 'object') {
    const message = typeof fallbackMessage === 'string' ? fallbackMessage.trim() : ''
    return message ? { action: 'message', message } : null
  }

  const record = data as Record<string, unknown>
  const action = typeof record.action === 'string' && GOAL_EVENT_ACTIONS.has(record.action as GoalEventAction)
    ? record.action as GoalEventAction
    : 'message'
  const read = (key: string) =>
    typeof record[key] === 'string' && record[key].trim()
      ? record[key].trim()
      : undefined
  return {
    action,
    status: read('status'),
    objective: read('objective'),
    budget: read('budget'),
    elapsed: read('elapsed'),
    continuations: read('continuations'),
    message: read('message') ?? (typeof fallbackMessage === 'string' ? fallbackMessage.trim() : undefined),
  }
}

function applyGoalEventToActiveGoal(
  current: ActiveGoalState | null,
  event: Omit<Extract<UIMessage, { type: 'goal_event' }>, 'id' | 'type' | 'timestamp'>,
  updatedAt: number,
): ActiveGoalState | null {
  if (event.action === 'cleared') return null
  if (
    event.action === 'message' &&
    event.message &&
    /no (active )?goal/i.test(event.message)
  ) {
    return current
  }
  if (event.action === 'message') return current
  const baseGoal = event.action === 'created' || event.action === 'replaced' ? null : current

  return {
    action: event.action,
    status: event.status ?? (event.action === 'completed' ? 'complete' : baseGoal?.status),
    objective: event.objective ?? baseGoal?.objective,
    budget: event.budget ?? baseGoal?.budget,
    elapsed: event.elapsed ?? baseGoal?.elapsed,
    continuations: event.continuations ?? baseGoal?.continuations,
    message: event.message ?? baseGoal?.message,
    updatedAt,
  }
}

function deriveActiveGoalFromMessages(messages: UIMessage[]): ActiveGoalState | null {
  return messages.reduce<ActiveGoalState | null>((activeGoal, message) => {
    if (message.type !== 'goal_event') return activeGoal
    return applyGoalEventToActiveGoal(activeGoal, message, message.timestamp)
  }, null)
}

function extractLocalCommandText(content: unknown): string | null {
  if (typeof content !== 'string') return null
  return content.trim() || null
}

function parseGoalCommandFromLocalCommand(content: unknown): { name: string; args: string } | null {
  const text = extractLocalCommandText(content)
  if (!text) return null
  const commandName = readXmlTag(text, 'command-name')
  if (!commandName) return null
  return {
    name: commandName.replace(/^\//, ''),
    args: readXmlTag(text, 'command-args') ?? '',
  }
}

function formatVisibleLocalCommand(command: { name: string; args: string }): string {
  const normalizedName = command.name.replace(/^\//, '')
  const args = command.args.trim()
  return `/${normalizedName}${args ? ` ${args}` : ''}`
}

function extractLocalCommandOutputText(content: unknown): string | null {
  const text = extractLocalCommandText(content)
  if (!text) return null
  return readXmlTag(text, 'local-command-stdout') ?? readXmlTag(text, 'local-command-stderr') ?? null
}

function isCompactLocalCommandOutput(output: string): boolean {
  return output.trim() === 'Compacted'
}

function parseGoalEventFromLocalCommandOutput(
  output: string,
  command: { name: string; args: string } | null,
): Omit<Extract<UIMessage, { type: 'goal_event' }>, 'id' | 'type' | 'timestamp'> | null {
  if (command && command.name !== 'goal') return null
  const trimmed = output.trim()
  if (!trimmed) return null

  if (trimmed === 'Goal cleared.' || trimmed.startsWith('Goal cleared:')) return { action: 'cleared', message: trimmed }
  if (trimmed === 'Goal marked complete.') return { action: 'completed', message: trimmed }
  if (trimmed === 'No active goal.') return { action: 'message', message: trimmed }
  if (trimmed.startsWith('Goal continuing:')) {
    return {
      action: 'status',
      status: 'continuing',
      message: trimmed,
    }
  }
  if (trimmed.startsWith('Goal set:')) {
    const objective = trimmed.slice('Goal set:'.length).trim()
    return {
      action: 'created',
      status: 'active',
      objective: objective || undefined,
      message: trimmed,
    }
  }

  return command?.name === 'goal' ? { action: 'message', message: trimmed } : null
}

function extractTaskNotification(content: unknown): AgentTaskNotification | null {
  const xml = extractHistoryTextBlocks(content)
    .map((text) => extractTaskNotificationXml(text))
    .find((value): value is string => value !== null)
  if (!xml) return null

  const toolUseId = readXmlTag(xml, 'tool-use-id')
  const status = readXmlTag(xml, 'status')
  if (
    !toolUseId ||
    (status !== 'completed' && status !== 'failed' && status !== 'stopped')
  ) {
    return null
  }

  const taskId = readXmlTag(xml, 'task-id') || toolUseId
  const summary = readXmlTag(xml, 'summary')
  const result = readXmlTag(xml, 'result')
  const outputFile = readXmlTag(xml, 'output-file')
  return {
    taskId,
    toolUseId,
    status,
    ...(summary ? { summary } : {}),
    ...(result ? { result } : {}),
    ...(outputFile ? { outputFile } : {}),
  }
}

function agentNotificationRecordFromList(
  notifications: AgentTaskNotification[],
): Record<string, AgentTaskNotification> {
  return Object.fromEntries(
    notifications.map((notification) => [notification.toolUseId, notification]),
  )
}

function backgroundTaskRecordFromNotifications(
  notifications: AgentTaskNotification[],
): Record<string, BackgroundAgentTask> {
  return notifications.reduce<Record<string, BackgroundAgentTask>>((tasks, notification) => {
    const parsedTimestamp = notification.timestamp ? new Date(notification.timestamp).getTime() : NaN
    const now = Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now()
    return upsertBackgroundAgentTask(tasks, {
      taskId: notification.taskId,
      toolUseId: notification.toolUseId,
      status: notification.status,
      summary: notification.summary,
      outputFile: notification.outputFile,
      usage: notification.usage,
    }, now)
  }, {})
}

function mergeBackgroundAgentTaskRecords(
  current: Record<string, BackgroundAgentTask>,
  restored: Record<string, BackgroundAgentTask>,
): Record<string, BackgroundAgentTask> {
  return Object.values(restored).reduce(
    (tasks, task) => upsertBackgroundAgentTask(tasks, task, task.updatedAt),
    current,
  )
}

const TEAMMATE_CONTENT_REGEX = /<teammate-message\s+teammate_id="([^"]+)"[^>]*>\n?([\s\S]*?)\n?<\/teammate-message>/g

function extractVisibleTeammateMessageContents(text: string): string[] {
  const contents: string[] = []

  for (const match of text.matchAll(TEAMMATE_CONTENT_REGEX)) {
    const content = match[2]?.trim()
    if (!content) continue

    if (content.startsWith('{') && content.endsWith('}')) {
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>
        if (typeof parsed.type === 'string' && AGENT_LIFECYCLE_TYPES.has(parsed.type)) {
          continue
        }
      } catch {
        // Keep non-JSON payloads that happen to look like JSON.
      }
    }

    contents.push(content)
  }

  return contents
}

function pushAssistantHistoryText(
  messages: UIMessage[],
  content: string,
  timestamp: number,
  model?: string,
  transcriptMessageId?: string,
): void {
  if (!content.trim()) return

  const last = messages[messages.length - 1]
  const canMergeIntoLast =
    last?.type === 'assistant_text' &&
    (
      transcriptMessageId
        ? last.transcriptMessageId === transcriptMessageId
        : !last.transcriptMessageId
    )
  if (canMergeIntoLast) {
    last.content += content
    if (model && !last.model) last.model = model
    if (transcriptMessageId && !last.transcriptMessageId) {
      last.transcriptMessageId = transcriptMessageId
    }
    return
  }

  messages.push({
    id: nextId(),
    type: 'assistant_text',
    content,
    timestamp,
    ...(transcriptMessageId ? { transcriptMessageId } : {}),
    ...(model ? { model } : {}),
  })
}

type HistoryMappingOptions = {
  includeTeammateMessages?: boolean
}

function buildModelContent(content: string, attachments?: AttachmentRef[]): string {
  const paths = attachments
    ?.map((attachment) => attachment.path)
    .filter((path): path is string => typeof path === 'string' && path.length > 0) ?? []
  const trimmed = content.trim()
  if (paths.length === 0) return trimmed
  const prefix = paths.map((path) => `@"${path}"`).join(' ')
  return `${prefix} ${trimmed || 'Please analyze the attached files.'}`.trim()
}

function getReferenceName(referencePath: string): string {
  const normalized = referencePath.replace(/\\/g, '/').replace(/\/+$/, '')
  const name = normalized.split('/').filter(Boolean).pop()
  return name || referencePath
}

function extractLeadingFileReferences(text: string): {
  content: string
  attachments?: UIAttachment[]
  modelContent?: string
} {
  const attachments: UIAttachment[] = []
  let remaining = text

  while (true) {
    const match = remaining.match(/^@"([^"]+)"\s*/)
    if (!match?.[1]) break

    attachments.push({
      type: 'file',
      name: getReferenceName(match[1]),
      path: match[1],
    })
    remaining = remaining.slice(match[0].length)
  }

  if (attachments.length === 0) {
    return { content: text }
  }

  return {
    content: remaining.trimStart(),
    attachments,
    modelContent: text,
  }
}

type WorkspaceReferenceHistoryDisplay = {
  content: string
  attachments: UIAttachment[]
}

function parseWorkspaceReferenceLocation(location: string): {
  path: string
  lineStart?: number
  lineEnd?: number
  diffSide?: 'old' | 'new'
} {
  const match = location.match(/^(.*?)(?::(old|new))?:L(\d+)(?:-L(\d+))?$/)
  if (!match?.[1] || !match[3]) return { path: location }

  const lineStart = Number(match[3])
  const lineEnd = Number(match[4] ?? match[3])
  return {
    path: match[1],
    lineStart,
    lineEnd,
    ...(match[2] === 'old' || match[2] === 'new' ? { diffSide: match[2] } : {}),
  }
}

function parseWorkspaceReferenceHistoryPrompt(text: string): WorkspaceReferenceHistoryDisplay | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines[0]?.trim() !== 'Referenced workspace context:') return null

  const attachments: UIAttachment[] = []
  let index = 1
  const isLocationHeader = (line: string) => /^@".+":$/.test(line.trim())

  while (index < lines.length) {
    const header = lines[index]?.trim() ?? ''
    const locationMatch = header.match(/^@"(.+)":$/)
    if (!locationMatch?.[1]) break

    const location = parseWorkspaceReferenceLocation(locationMatch[1])
    index += 1

    let note: string | undefined
    if (lines[index]?.trimStart().startsWith('Comment:')) {
      const noteLines = [lines[index]!.trimStart().slice('Comment:'.length).trimStart()]
      index += 1
      while (
        index < lines.length &&
        lines[index]!.trim() !== '' &&
        !/^`{3,}/.test(lines[index]!.trim()) &&
        !isLocationHeader(lines[index]!)
      ) {
        noteLines.push(lines[index]!)
        index += 1
      }
      note = noteLines.join('\n').trim() || undefined
    }

    let quote: string | undefined
    const fenceMatch = lines[index]?.trim().match(/^(`{3,})[^`]*$/)
    if (fenceMatch?.[1]) {
      const fence = fenceMatch[1]
      index += 1
      const quoteLines: string[] = []
      while (index < lines.length && lines[index]?.trim() !== fence) {
        quoteLines.push(lines[index]!)
        index += 1
      }
      if (index >= lines.length) return null
      index += 1
      quote = quoteLines.join('\n').trim() || undefined
    }

    attachments.push({
      type: 'file',
      name: getReferenceName(location.path),
      path: location.path,
      ...(location.lineStart ? { lineStart: location.lineStart } : {}),
      ...(location.lineEnd ? { lineEnd: location.lineEnd } : {}),
      ...(location.diffSide ? { diffSide: location.diffSide } : {}),
      ...(note ? { note } : {}),
      ...(quote ? { quote } : {}),
    })
  }

  if (attachments.length === 0) return null
  while (lines[index]?.trim() === '') index += 1
  return {
    content: lines.slice(index).join('\n').trim(),
    attachments,
  }
}

function pathsReferToSameFile(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false
  const normalizedLeft = left.replace(/\\/g, '/').replace(/^\.\//, '')
  const normalizedRight = right.replace(/\\/g, '/').replace(/^\.\//, '')
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.endsWith(`/${normalizedRight}`) ||
    normalizedRight.endsWith(`/${normalizedLeft}`)
  )
}

function extractRestoredUserDisplay(text: string): {
  content: string
  attachments?: UIAttachment[]
  modelContent?: string
} {
  const leading = extractLeadingFileReferences(text)
  const workspace = parseWorkspaceReferenceHistoryPrompt(leading.content)
  if (!workspace) return leading

  const unmatchedLeading = [...(leading.attachments ?? [])]
  for (const attachment of workspace.attachments) {
    const matchingIndex = unmatchedLeading.findIndex((candidate) =>
      pathsReferToSameFile(candidate.path, attachment.path),
    )
    if (matchingIndex >= 0) unmatchedLeading.splice(matchingIndex, 1)
  }

  const attachments = [...unmatchedLeading, ...workspace.attachments]
  return {
    content: workspace.content,
    attachments: attachments.length > 0 ? attachments : undefined,
    modelContent: text,
  }
}

export function appendReplayedUserMessage(
  messages: UIMessage[],
  content: string,
  timestamp: number,
): UIMessage[] {
  // The replayed text carries server-appended image-metadata lines that the
  // optimistic message never had. Normalize them away (same as the history
  // mapping) so the dedupe below can match the already-rendered message instead
  // of appending the raw prompt — paths and all — as a duplicate bubble.
  const sanitized = stripGeneratedImageMetadataLines(content) || content.trim()
  const parsed = extractRestoredUserDisplay(sanitized)
  const displayContent = parsed.content.trim()
  if (!displayContent && !parsed.attachments?.length) return messages

  const modelContent = parsed.modelContent ?? sanitized
  const currentTurnUserIndex = findCurrentTurnUserMessageIndex(messages, modelContent)
  if (currentTurnUserIndex >= 0) {
    const optimisticMessage = messages[currentTurnUserIndex]
    if (optimisticMessage?.type === 'user_text' && optimisticMessage.optimisticQueued) {
      const { optimisticQueued: _optimisticQueued, ...confirmedMessage } = optimisticMessage
      return [
        ...messages.slice(0, currentTurnUserIndex),
        confirmedMessage,
        ...messages.slice(currentTurnUserIndex + 1),
      ]
    }
    return messages
  }

  return [
    ...messages,
    {
      id: nextId(),
      type: 'user_text',
      content: displayContent,
      ...(parsed.modelContent ? { modelContent: parsed.modelContent } : {}),
      ...(parsed.attachments ? { attachments: parsed.attachments } : {}),
      timestamp,
    },
  ]
}

function appendOptimisticQueuedUserMessage(
  messages: UIMessage[],
  message: QueuedUserMessage,
  timestamp: number,
): UIMessage[] {
  const displayContent = message.displayContent.trim()
  const modelContent = message.content.trim()
  const attachments = mapQueuedDisplayAttachments(message.displayAttachments)
  if (!displayContent && !attachments) return messages

  return [
    ...messages,
    {
      id: nextId(),
      type: 'user_text',
      content: displayContent,
      ...(modelContent && modelContent !== displayContent ? { modelContent } : {}),
      ...(attachments ? { attachments } : {}),
      timestamp,
      optimisticQueued: true,
    },
  ]
}

function mapQueuedDisplayAttachments(attachments?: AttachmentRef[]): UIAttachment[] | undefined {
  if (!attachments?.length) return undefined
  return attachments.map((attachment) => ({
    type: attachment.type,
    name: attachment.name || attachment.path || attachment.mimeType || attachment.type,
    path: attachment.path,
    data: attachment.data,
    mimeType: attachment.mimeType,
    isDirectory: attachment.isDirectory,
    lineStart: attachment.lineStart,
    lineEnd: attachment.lineEnd,
    diffSide: attachment.diffSide,
    hunkId: attachment.hunkId,
    note: attachment.note,
    quote: attachment.quote,
  }))
}

function findCurrentTurnUserMessageIndex(
  messages: UIMessage[],
  modelContent: string,
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.type !== 'user_text') {
      continue
    }
    return (message.modelContent ?? message.content).trim() === modelContent ? index : -1
  }
  return -1
}

function replaceQueuedMessageDisplayContent(
  message: QueuedUserMessage,
  nextDisplayContent: string,
): string {
  const currentModelContent = message.content.trim()
  const currentDisplayContent = message.displayContent.trim()
  if (!currentModelContent) return nextDisplayContent
  if (!currentDisplayContent) return `${currentModelContent}\n\n${nextDisplayContent}`
  if (currentModelContent === currentDisplayContent) return nextDisplayContent

  const displaySuffix = `\n\n${currentDisplayContent}`
  if (currentModelContent.endsWith(displaySuffix)) {
    return `${currentModelContent.slice(0, -currentDisplayContent.length)}${nextDisplayContent}`
  }
  if (currentModelContent.endsWith(currentDisplayContent)) {
    return `${currentModelContent.slice(0, -currentDisplayContent.length)}${nextDisplayContent}`
  }
  return `${currentModelContent}\n\n${nextDisplayContent}`
}

/**
 * Reconstruct agentTaskNotifications from history.
 *
 * During a live session, background agents report completion via system_notification
 * events (task_notification). These are NOT persisted in JSONL history. On reload,
 * we reconstruct them by correlating Agent tool_use names with <teammate-message>
 * teammate_ids found in subsequent user messages.
 */
export function reconstructAgentNotifications(messages: MessageEntry[]): Record<string, AgentTaskNotification> {
  const taskNotifications = messages
    .filter((message) => message.type === 'user')
    .map((message) => extractTaskNotification(message.content))
    .filter((notification): notification is AgentTaskNotification => notification !== null)

  // Step 1: Collect Agent tool_use blocks → map agent name to toolUseId
  const agentNameToToolUseId = new Map<string, string>()

  for (const msg of messages) {
    if ((msg.type === 'assistant' || msg.type === 'tool_use') && Array.isArray(msg.content)) {
      for (const block of msg.content as AssistantHistoryBlock[]) {
        if (block.type === 'tool_use' && block.name === 'Agent' && block.id) {
          const input = block.input as Record<string, unknown> | undefined
          const name = input?.name as string | undefined
          // Keep first toolUseId per name (consistent with first-wins for teammateContent)
          if (name && !agentNameToToolUseId.has(name)) agentNameToToolUseId.set(name, block.id)
        }
      }
    }
  }

  if (agentNameToToolUseId.size === 0) {
    return agentNotificationRecordFromList(taskNotifications)
  }

  // Step 2: Extract <teammate-message> content by teammate_id
  // Skip lifecycle messages (shutdown_approved, idle_notification, etc.)
  // which overwrite actual review content if stored later in history
  const teammateContent = new Map<string, string>()
  for (const msg of messages) {
    if (msg.type !== 'user') continue
    const text = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? (msg.content as Array<{ type?: string; text?: string }>).filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n')
        : ''
    if (!text.includes('<teammate-message')) continue
    for (const match of text.matchAll(TEAMMATE_CONTENT_REGEX)) {
      if (match[1] && match[2]) {
        const content = match[2].trim()
        // Skip lifecycle JSON messages (shutdown, idle, terminated notifications)
        if (content.startsWith('{') && content.endsWith('}')) {
          try {
            const parsed = JSON.parse(content) as Record<string, unknown>
            if (typeof parsed.type === 'string' && AGENT_LIFECYCLE_TYPES.has(parsed.type)) continue
          } catch { /* not JSON, keep it */ }
        }
        // Only store the first meaningful content per teammate (avoid overwrite by later lifecycle msgs)
        if (!teammateContent.has(match[1])) {
          teammateContent.set(match[1], content)
        }
      }
    }
  }

  // Step 3: Correlate and build notifications
  const notifications: Record<string, AgentTaskNotification> = {}
  for (const [name, toolUseId] of agentNameToToolUseId) {
    const content = teammateContent.get(name)
    if (content) {
      notifications[toolUseId] = {
        taskId: toolUseId,
        toolUseId,
        status: 'completed',
        summary: content,
      }
    }
  }

  for (const notification of taskNotifications) {
    notifications[notification.toolUseId] = notification
  }

  return notifications
}

export function mapHistoryMessagesToUiMessages(
  messages: MessageEntry[],
  options?: HistoryMappingOptions,
): UIMessage[] {
  const includeTeammateMessages = options?.includeTeammateMessages === true
  const uiMessages: UIMessage[] = []
  let suppressTaskNotificationResponse = false
  let pendingGoalCommand: { name: string; args: string } | null = null

  for (const msg of messages) {
    if (msg.type === 'user' && isTaskNotificationContent(msg.content)) {
      suppressTaskNotificationResponse = true
      continue
    }
    if (msg.type === 'user') {
      const commandDisplayText = getCommandMetadataDisplayText(msg.content)
      if (commandDisplayText) {
        uiMessages.push({
          id: msg.id || nextId(),
          type: 'user_text',
          content: commandDisplayText,
          ...(msg.id ? { transcriptMessageId: msg.id } : {}),
          timestamp: new Date(msg.timestamp).getTime(),
        })
        suppressTaskNotificationResponse = false
        continue
      }
      if (shouldHideCommandMetadataContent(msg.content)) {
        continue
      }
    }
    if (msg.type === 'user') {
      suppressTaskNotificationResponse = false
    } else if (suppressTaskNotificationResponse) {
      continue
    }

    const timestamp = new Date(msg.timestamp).getTime()
    if (msg.type === 'system' && typeof msg.content === 'string') {
      if (msg.content.trim() === 'Conversation compacted' || msg.content.trim() === 'Context compacted') {
        const compactMessages = appendOrUpdateTailCompactSummary(
          uiMessages,
          { title: 'Context compacted', phase: 'complete' },
          timestamp,
        )
        uiMessages.splice(0, uiMessages.length, ...compactMessages)
        continue
      }

      const localCommand = parseGoalCommandFromLocalCommand(msg.content)
      if (localCommand) {
        pendingGoalCommand = localCommand
        if (localCommand.name === 'goal') {
          uiMessages.push({
            id: msg.id || nextId(),
            type: 'user_text',
            content: formatVisibleLocalCommand(localCommand),
            timestamp,
          })
        }
        continue
      }

      const localCommandOutput = extractLocalCommandOutputText(msg.content)
      if (localCommandOutput) {
        const goalEvent = parseGoalEventFromLocalCommandOutput(localCommandOutput, pendingGoalCommand)
        pendingGoalCommand = null
        if (goalEvent) {
          uiMessages.push({
            id: msg.id || nextId(),
            type: 'goal_event',
            ...goalEvent,
            timestamp,
          })
        }
        continue
      }
    }
    if (msg.type === 'user' && typeof msg.content === 'string') {
      const localCommandOutput = extractLocalCommandOutputText(msg.content)
      if (localCommandOutput && isCompactLocalCommandOutput(localCommandOutput)) {
        continue
      }

      const compactSummary = extractCompactSummaryContent(msg.content)
      if (compactSummary) {
        const compactMessages = appendOrUpdateTailCompactSummary(
          uiMessages,
          {
            title: 'Context compacted',
            phase: 'complete',
            summary: compactSummary,
          },
          timestamp,
        )
        uiMessages.splice(0, uiMessages.length, ...compactMessages)
        continue
      }

      if (isTeammateMessage(msg.content)) {
        if (!includeTeammateMessages) continue
        const teammateContents = extractVisibleTeammateMessageContents(msg.content)
        if (teammateContents.length === 0) continue
        uiMessages.push({
          id: msg.id || nextId(),
          type: 'user_text',
          content: teammateContents.join('\n\n'),
          ...(msg.id ? { transcriptMessageId: msg.id } : {}),
          timestamp,
        })
        continue
      }
      const parsed = extractRestoredUserDisplay(msg.content)
      uiMessages.push({
        id: msg.id || nextId(),
        type: 'user_text',
        content: parsed.content,
        ...(msg.id ? { transcriptMessageId: msg.id } : {}),
        ...(parsed.modelContent ? { modelContent: parsed.modelContent } : {}),
        ...(parsed.attachments ? { attachments: parsed.attachments } : {}),
        timestamp,
      })
      continue
    }
    if (msg.type === 'assistant' && typeof msg.content === 'string') {
      if (!msg.content.trim()) continue
      uiMessages.push({
        id: msg.id || nextId(),
        type: 'assistant_text',
        content: msg.content,
        ...(msg.id ? { transcriptMessageId: msg.id } : {}),
        timestamp,
        model: msg.model,
      })
      continue
    }
    if ((msg.type === 'assistant' || msg.type === 'tool_use') && Array.isArray(msg.content)) {
      for (const block of msg.content as AssistantHistoryBlock[]) {
        if (block.type === 'thinking' && block.thinking) uiMessages.push({ id: nextId(), type: 'thinking', content: block.thinking, timestamp })
        else if (block.type === 'text' && block.text) {
          pushAssistantHistoryText(uiMessages, block.text, timestamp, msg.model, msg.id || undefined)
        }
        else if (block.type === 'tool_use') uiMessages.push({ id: nextId(), type: 'tool_use', toolName: block.name ?? 'unknown', toolUseId: block.id ?? '', input: block.input, timestamp, parentToolUseId: msg.parentToolUseId })
      }
      continue
    }
    if ((msg.type === 'user' || msg.type === 'tool_result') && Array.isArray(msg.content)) {
      const visibleTextParts: string[] = []
      const modelTextParts: string[] = []
      const attachments: UIAttachment[] = []
      const imageSourcePaths: string[] = []
      const hasImageBlock = (msg.content as UserHistoryBlock[]).some((block) => block.type === 'image')
      for (const block of msg.content as UserHistoryBlock[]) {
        if (block.type === 'text' && block.text && isTeammateMessage(block.text)) {
          modelTextParts.push(block.text)
          if (!includeTeammateMessages) continue
          visibleTextParts.push(...extractVisibleTeammateMessageContents(block.text))
        } else if (block.type === 'text' && block.text) {
          modelTextParts.push(block.text)
          const imageSourcePath = hasImageBlock ? extractImageMetadataSourcePath(block.text) : undefined
          if (imageSourcePath) {
            imageSourcePaths.push(imageSourcePath)
          }
          if (!hasImageBlock || !isGeneratedImageMetadataText(block.text)) {
            visibleTextParts.push(block.text)
          }
        }
        else if (block.type === 'image') attachments.push(normalizeHistoryImageAttachment(block))
        else if (block.type === 'file') attachments.push({ type: 'file', name: block.name || 'file' })
        else if (block.type === 'tool_result') uiMessages.push({
          id: nextId(),
          type: 'tool_result',
          toolUseId: block.tool_use_id ?? '',
          content: normalizeHistoryToolResultContent(block.content, msg.toolUseResult),
          isError: !!block.is_error,
          timestamp,
          parentToolUseId: msg.parentToolUseId,
        })
      }
      applyImageMetadataSourcePaths(attachments, imageSourcePaths)
      if (visibleTextParts.length > 0 || attachments.length > 0) {
        const visibleText = visibleTextParts.join('\n')
        const modelText = modelTextParts.join('\n')
        const visualSelectionDisplay =
          msg.type === 'user' && hasImageBlock
            ? parseVisualSelectionHistoryPrompt(modelText)
            : null
        if (visualSelectionDisplay) {
          applyVisualSelectionHistoryDisplay(attachments, visualSelectionDisplay)
        }
        const parsed = extractRestoredUserDisplay(visibleText)
        const userContent = visualSelectionDisplay ? '' : parsed.content
        const modelContent = visualSelectionDisplay || modelText !== visibleText ? modelText : parsed.modelContent
        const allAttachments = [...(parsed.attachments ?? []), ...attachments]
        uiMessages.push({
          id: msg.id || nextId(),
          type: 'user_text',
          content: userContent,
          ...(msg.id ? { transcriptMessageId: msg.id } : {}),
          ...(modelContent ? { modelContent } : {}),
          attachments: allAttachments.length > 0 ? allAttachments : undefined,
          timestamp,
        })
      }
    }
    if (msg.type === 'system' && msg.content && typeof msg.content === 'object') {
      const subtype = (msg.content as { subtype?: unknown }).subtype
      if (subtype === 'memory_saved') {
        const files = normalizeMemoryEventFiles(msg.content)
        if (files.length > 0) {
          uiMessages.push({
            id: msg.id || nextId(),
            type: 'memory_event',
            event: 'saved',
            files,
            message: typeof (msg.content as { message?: unknown }).message === 'string'
              ? (msg.content as { message: string }).message
              : undefined,
            teamCount: normalizeMemoryTeamCount(msg.content),
            timestamp,
          })
        }
      }
    }
  }
  return uiMessages
}

function extractLastTodoWriteFromHistory(messages: MessageEntry[]): Array<{ content: string; status: string; activeForm?: string }> | null {
  let foundIndex = -1
  let todos: Array<{ content: string; status: string; activeForm?: string }> | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if ((msg.type === 'assistant' || msg.type === 'tool_use') && Array.isArray(msg.content)) {
      const blocks = msg.content as AssistantHistoryBlock[]
      for (let j = blocks.length - 1; j >= 0; j--) {
        const block = blocks[j]!
        if (block.type === 'tool_use' && block.name === 'TodoWrite') {
          const input = block.input as { todos?: unknown } | undefined
          if (input && Array.isArray(input.todos)) {
            todos = input.todos as Array<{ content: string; status: string; activeForm?: string }>
            foundIndex = i
            break
          }
        }
      }
      if (todos) break
    }
  }
  if (!todos) return null
  const allDone = todos.every((t) => t.status === 'completed')
  if (allDone) {
    for (let i = foundIndex + 1; i < messages.length; i++) {
      if (messages[i]!.type === 'user' && messages[i]!.content) return null
    }
  }
  return todos
}

const TASK_RELATED_TOOL_NAMES = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'])

function hasUserMessagesAfterTaskCompletion(messages: MessageEntry[]): boolean {
  let lastTaskIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if ((msg.type === 'assistant' || msg.type === 'tool_use') && Array.isArray(msg.content)) {
      const blocks = msg.content as AssistantHistoryBlock[]
      if (blocks.some((b) => b.type === 'tool_use' && TASK_RELATED_TOOL_NAMES.has(b.name ?? ''))) { lastTaskIndex = i; break }
    }
  }
  if (lastTaskIndex < 0) return false
  for (let i = lastTaskIndex + 1; i < messages.length; i++) { if (messages[i]!.type === 'user') return true }
  return false
}
