import { create } from 'zustand'
import { wsManager } from '../api/websocket'
import { sessionsApi } from '../api/sessions'
import { useTeamStore } from './teamStore'
import { useSessionStore } from './sessionStore'
import { useCLITaskStore } from './cliTaskStore'
import { useSessionRuntimeStore } from './sessionRuntimeStore'
import { useTabStore } from './tabStore'
import { randomSpinnerVerb } from '../config/spinnerVerbs'
import { AGENT_LIFECYCLE_TYPES } from '../types/team'
import type { MessageEntry } from '../types/session'
import type { PermissionMode } from '../types/settings'
import type { RuntimeSelection } from '../types/runtime'
import type {
  AgentTaskNotification,
  AttachmentRef,
  ChatState,
  ComputerUsePermissionRequest,
  ComputerUsePermissionResponse,
  UIAttachment,
  UIMessage,
  ServerMessage,
  TokenUsage,
} from '../types/chat'

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

export type PerSessionState = {
  messages: UIMessage[]
  chatState: ChatState
  connectionState: ConnectionState
  streamingText: string
  streamingToolInput: string
  activeToolUseId: string | null
  activeToolName: string | null
  activeThinkingId: string | null
  pendingPermission: {
    requestId: string
    toolName: string
    toolUseId?: string
    input: unknown
    description?: string
  } | null
  pendingComputerUsePermission: {
    requestId: string
    request: ComputerUsePermissionRequest
  } | null
  tokenUsage: TokenUsage
  elapsedSeconds: number
  statusVerb: string
  slashCommands: Array<{ name: string; description: string }>
  agentTaskNotifications: Record<string, AgentTaskNotification>
  elapsedTimer: ReturnType<typeof setInterval> | null
  composerPrefill?: {
    text: string
    attachments?: UIAttachment[]
    nonce: number
  } | null
  showFullConversation: boolean
}

const DEFAULT_SESSION_STATE: PerSessionState = {
  messages: [],
  chatState: 'idle',
  connectionState: 'disconnected',
  streamingText: '',
  streamingToolInput: '',
  activeToolUseId: null,
  activeToolName: null,
  activeThinkingId: null,
  pendingPermission: null,
  pendingComputerUsePermission: null,
  tokenUsage: { input_tokens: 0, output_tokens: 0 },
  elapsedSeconds: 0,
  statusVerb: '',
  slashCommands: [],
  agentTaskNotifications: {},
  elapsedTimer: null,
  composerPrefill: null,
  showFullConversation: false,
}

function createDefaultSessionState(): PerSessionState {
  return { ...DEFAULT_SESSION_STATE, messages: [], tokenUsage: { input_tokens: 0, output_tokens: 0 } }
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
    options?: { displayContent?: string },
  ) => void
  respondToPermission: (
    sessionId: string,
    requestId: string,
    allowed: boolean,
    options?: {
      rule?: string
      updatedInput?: Record<string, unknown>
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
  loadHistory: (sessionId: string) => Promise<void>
  reloadHistory: (sessionId: string) => Promise<void>
  queueComposerPrefill: (
    sessionId: string,
    prefill: { text: string; attachments?: UIAttachment[] },
  ) => void
  clearMessages: (sessionId: string) => void
  toggleFullConversation: (sessionId: string) => void
  handleServerMessage: (sessionId: string, msg: ServerMessage) => void
}

const TASK_TOOL_NAMES = new Set(['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TodoWrite'])
const pendingTaskToolUseIds = new Set<string>()

let msgCounter = 0
const nextId = () => `msg-${++msgCounter}-${Date.now()}`

// Streaming throttle for content_delta
let pendingDelta = ''
let flushTimer: ReturnType<typeof setTimeout> | null = null

function consumePendingDelta(): string {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  const text = pendingDelta
  pendingDelta = ''
  return text
}

function appendAssistantTextMessage(
  messages: UIMessage[],
  content: string,
  timestamp: number,
  model?: string,
): UIMessage[] {
  if (!content.trim()) return messages

  const last = messages[messages.length - 1]
  if (last?.type === 'assistant_text') {
    const merged: UIMessage = {
      ...last,
      content: last.content + content,
      ...(model ?? last.model ? { model: model ?? last.model } : {}),
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
      ...(model ? { model } : {}),
    },
  ]
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

async function fetchAndMapSessionHistory(sessionId: string) {
  const { messages } = await sessionsApi.getMessages(sessionId)
  return {
    rawMessages: messages,
    uiMessages: mapHistoryMessagesToUiMessages(messages),
    restoredNotifications: reconstructAgentNotifications(messages),
    lastTodos: extractLastTodoWriteFromHistory(messages),
    hasMessagesAfterTaskCompletion: hasUserMessagesAfterTaskCompletion(messages),
  }
}

export const useChatStore = create<ChatStore>((set, get) => ({
  sessions: {},

  getSession: (sessionId) => get().sessions[sessionId] ?? createDefaultSessionState(),

  connectToSession: (sessionId) => {
    void useCLITaskStore.getState().fetchSessionTasks(sessionId)

    const existing = get().sessions[sessionId]
    if (existing && existing.connectionState !== 'disconnected') return

    set((s) => ({
      sessions: {
        ...s.sessions,
        [sessionId]: {
          ...createDefaultSessionState(),
          connectionState: 'connecting',
          messages: existing?.messages ?? [],
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
    if (!sessionId.startsWith('__') && !useTeamStore.getState().getMemberBySessionId(sessionId)) {
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
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    if (pendingDelta) {
      const text = consumePendingDelta()
      set((s) => ({ sessions: updateSessionIn(s.sessions, sessionId, (sess) => ({ streamingText: sess.streamingText + text })) }))
    }
    wsManager.disconnect(sessionId)
    set((s) => {
      const { [sessionId]: _, ...rest } = s.sessions
      return { sessions: rest }
    })
  },

  sendMessage: (sessionId, content, attachments, options) => {
    const userFacingContent =
      options?.displayContent?.trim() || content.trim()
    const isMemberSession = !!useTeamStore.getState().getMemberBySessionId(sessionId)
    const uiAttachments: UIAttachment[] | undefined =
      attachments && attachments.length > 0
        ? attachments.map((a) => ({
            type: a.type,
            name: a.name || a.path || a.mimeType || a.type,
            data: a.data,
            mimeType: a.mimeType,
          }))
        : undefined

    const taskStore = useCLITaskStore.getState()
    const allTasksDone = taskStore.tasks.length > 0 && taskStore.tasks.every((t) => t.status === 'completed')
    const completedTaskSummary = allTasksDone
      ? taskStore.tasks.map((t) => ({ id: t.id, subject: t.subject, status: t.status, activeForm: t.activeForm }))
      : []

    if (!isMemberSession && allTasksDone) {
      void taskStore.resetCompletedTasks()
    }

    set((s) => {
      const session = s.sessions[sessionId] ?? createDefaultSessionState()
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      const bufferedDelta = consumePendingDelta()
      const pendingAssistantText = `${session.streamingText}${bufferedDelta}`

      const newMessages = pendingAssistantText.trim()
        ? appendAssistantTextMessage(session.messages, pendingAssistantText, Date.now())
        : [...session.messages]
      if (!isMemberSession && allTasksDone) {
        newMessages.push({
          id: nextId(),
          type: 'task_summary',
          tasks: completedTaskSummary,
          timestamp: Date.now(),
        })
      }
      newMessages.push({
        id: nextId(),
        type: 'user_text',
        content: userFacingContent,
        attachments: isMemberSession ? undefined : uiAttachments,
        timestamp: Date.now(),
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
            streamingText: '',
            statusVerb: isMemberSession ? '' : randomSpinnerVerb(),
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
    })
    set((s) => ({ sessions: updateSessionIn(s.sessions, sessionId, () => ({ pendingPermission: null, chatState: allowed ? 'tool_executing' : 'idle' })) }))
  },

  respondToComputerUsePermission: (sessionId, requestId, response) => {
    wsManager.send(sessionId, {
      type: 'computer_use_permission_response',
      requestId,
      response,
    })
    set((s) => ({
      sessions: updateSessionIn(s.sessions, sessionId, () => ({
        pendingComputerUsePermission: null,
        chatState: response.userConsented === false ? 'idle' : 'tool_executing',
      })),
    }))
  },

  setSessionRuntime: (sessionId, selection) => {
    wsManager.send(sessionId, {
      type: 'set_runtime_config',
      ...selection,
    })
  },

  setSessionPermissionMode: (sessionId, mode) => {
    if (!get().sessions[sessionId]) return
    wsManager.send(sessionId, { type: 'set_permission_mode', mode })
  },

  stopGeneration: (sessionId) => {
    wsManager.send(sessionId, { type: 'stop_generation' })
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    if (pendingDelta) {
      const text = consumePendingDelta()
      set((s) => ({ sessions: updateSessionIn(s.sessions, sessionId, (sess) => ({ streamingText: sess.streamingText + text })) }))
    }
    set((s) => {
      const session = s.sessions[sessionId]
      if (!session) return s
      if (session.elapsedTimer) clearInterval(session.elapsedTimer)
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...session,
            chatState: 'idle',
            pendingPermission: null,
            pendingComputerUsePermission: null,
            elapsedTimer: null,
          },
        },
      }
    })
  },

  loadHistory: async (sessionId) => {
    try {
      const {
        uiMessages,
        restoredNotifications,
        lastTodos,
        hasMessagesAfterTaskCompletion,
      } = await fetchAndMapSessionHistory(sessionId)
      set((state) => {
        const session = state.sessions[sessionId]
        if (!session || session.messages.length > 0) return state
        return { sessions: updateSessionIn(state.sessions, sessionId, (s) => ({
          messages: uiMessages,
          agentTaskNotifications: { ...s.agentTaskNotifications, ...restoredNotifications },
        })) }
      })
      if (lastTodos && lastTodos.length > 0) {
        const taskStore = useCLITaskStore.getState()
        if (taskStore.tasks.length === 0) taskStore.setTasksFromTodos(lastTodos)
      } else {
        useCLITaskStore.getState().setTasksFromTodos([])
      }
      if (hasMessagesAfterTaskCompletion) {
        useCLITaskStore.getState().markCompletedAndDismissed()
      }
    } catch {
      // Session may not have messages yet
    }
  },

  reloadHistory: async (sessionId) => {
    try {
      const {
        uiMessages,
        restoredNotifications,
        lastTodos,
        hasMessagesAfterTaskCompletion,
      } = await fetchAndMapSessionHistory(sessionId)

      set((state) => {
        const session = state.sessions[sessionId]
        if (!session) return state
        if (session.elapsedTimer) clearInterval(session.elapsedTimer)
        return {
          sessions: updateSessionIn(state.sessions, sessionId, () => ({
            messages: uiMessages,
            agentTaskNotifications: restoredNotifications,
            chatState: 'idle',
            activeThinkingId: null,
            activeToolUseId: null,
            activeToolName: null,
            streamingText: '',
            streamingToolInput: '',
            pendingPermission: null,
            pendingComputerUsePermission: null,
            elapsedTimer: null,
            statusVerb: '',
          })),
        }
      })

      if (lastTodos && lastTodos.length > 0) {
        useCLITaskStore.getState().setTasksFromTodos(lastTodos)
      } else {
        useCLITaskStore.getState().setTasksFromTodos([])
      }
      if (hasMessagesAfterTaskCompletion) {
        useCLITaskStore.getState().markCompletedAndDismissed()
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
          nonce: Date.now(),
        },
      })),
    }))
  },

  clearMessages: (sessionId) => {
    set((s) => ({ sessions: updateSessionIn(s.sessions, sessionId, () => ({ messages: [], streamingText: '', chatState: 'idle' })) }))
  },

  toggleFullConversation: (sessionId) => {
    set((s) => ({
      sessions: updateSessionIn(s.sessions, sessionId, (session) => ({
        showFullConversation: !session.showFullConversation,
      })),
    }))
  },

  handleServerMessage: (sessionId, msg) => {
    const update = (updater: (session: PerSessionState) => Partial<PerSessionState>) => {
      set((s) => ({ sessions: updateSessionIn(s.sessions, sessionId, updater) }))
    }

    switch (msg.type) {
      case 'connected':
        break

      case 'status':
        update((session) => {
          const pendingText = `${session.streamingText}${consumePendingDelta()}`
          const hasPendingStreamText =
            session.chatState === 'streaming' && pendingText.trim().length > 0
          // Background task progress can arrive while the assistant is still
          // streaming one markdown reply. Keep that turn intact so we do not
          // split formatting markers (for example backticks/strong markers)
          // across separate bubbles.
          const preserveStreamingTurn = hasPendingStreamText && msg.state !== 'idle'
          const shouldFlush = hasPendingStreamText && msg.state === 'idle'
          return {
            chatState: preserveStreamingTurn ? 'streaming' : msg.state,
            ...(msg.verb && msg.verb !== 'Thinking' ? { statusVerb: msg.verb } : {}),
            ...(msg.tokens ? { tokenUsage: { ...session.tokenUsage, output_tokens: msg.tokens } } : {}),
            ...(msg.state === 'idle' ? { activeThinkingId: null, statusVerb: '' } : {}),
            ...(shouldFlush ? {
              messages: appendAssistantTextMessage(session.messages, pendingText, Date.now()),
              streamingText: '',
            } : pendingText !== session.streamingText ? { streamingText: pendingText } : {}),
          }
        })
        if (msg.state === 'idle') {
          const session = get().sessions[sessionId]
          if (session?.elapsedTimer) {
            clearInterval(session.elapsedTimer)
            update(() => ({ elapsedTimer: null }))
          }
        }
        // Sync tab status
        useTabStore.getState().updateTabStatus(sessionId, msg.state === 'idle' ? 'idle' : 'running')
        break

      case 'content_start': {
        const session = get().sessions[sessionId]
        if (!session) break
        const pendingText = `${session.streamingText}${consumePendingDelta()}`
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
          }))
        } else if (msg.blockType === 'tool_use') {
          update(() => ({
            activeToolUseId: msg.toolUseId ?? null,
            activeToolName: msg.toolName ?? null,
            streamingToolInput: '',
            chatState: 'tool_executing',
            activeThinkingId: null,
          }))
        }
        break
      }

      case 'content_delta':
        if (msg.text !== undefined) {
          pendingDelta += msg.text
          if (!flushTimer) {
            flushTimer = setTimeout(() => {
              const text = pendingDelta
              pendingDelta = ''
              flushTimer = null
              update((s) => ({ streamingText: s.streamingText + text }))
            }, 50)
          }
        }
        if (msg.toolInput !== undefined) update((s) => ({ streamingToolInput: s.streamingToolInput + msg.toolInput }))
        break

      case 'thinking':
        update((s) => {
          const pendingText = `${s.streamingText}${consumePendingDelta()}`
          const base = pendingText.trim()
            ? appendAssistantTextMessage(s.messages, pendingText, Date.now())
            : s.messages
          const last = base[base.length - 1]
          if (last && last.type === 'thinking') {
            const updated = [...base]
            updated[updated.length - 1] = { ...last, content: last.content + msg.text }
            return { messages: updated, chatState: 'thinking', activeThinkingId: last.id, streamingText: '' }
          }
          const id = nextId()
          return {
            messages: [...base, { id, type: 'thinking', content: msg.text, timestamp: Date.now() }],
            chatState: 'thinking',
            activeThinkingId: id,
            streamingText: '',
          }
        })
        break

      case 'tool_use_complete': {
        const session = get().sessions[sessionId]
        const toolName = msg.toolName || session?.activeToolName || 'unknown'
        update((s) => ({
          messages: [...s.messages, {
            id: nextId(), type: 'tool_use', toolName,
            toolUseId: msg.toolUseId || s.activeToolUseId || '',
            input: msg.input, timestamp: Date.now(), parentToolUseId: msg.parentToolUseId,
          }],
          activeToolUseId: null, activeToolName: null, activeThinkingId: null, streamingToolInput: '',
        }))
        if (toolName === 'TodoWrite' && Array.isArray((msg.input as any)?.todos)) {
          useCLITaskStore.getState().setTasksFromTodos((msg.input as any).todos)
        } else if (TASK_TOOL_NAMES.has(toolName)) {
          const useId = msg.toolUseId || session?.activeToolUseId
          if (useId) pendingTaskToolUseIds.add(useId)
        }
        break
      }

      case 'tool_result':
        update((s) => ({
          messages: [...s.messages, {
            id: nextId(), type: 'tool_result', toolUseId: msg.toolUseId,
            content: msg.content, isError: msg.isError, timestamp: Date.now(), parentToolUseId: msg.parentToolUseId,
          }],
          chatState: 'thinking', activeThinkingId: null,
        }))
        if (pendingTaskToolUseIds.has(msg.toolUseId)) {
          pendingTaskToolUseIds.delete(msg.toolUseId)
          useCLITaskStore.getState().refreshTasks()
        }
        break

      case 'permission_request':
        update((s) => ({
          pendingPermission: {
            requestId: msg.requestId,
            toolName: msg.toolName,
            toolUseId: msg.toolUseId,
            input: msg.input,
            description: msg.description,
          },
          pendingComputerUsePermission: null,
          chatState: 'permission_pending',
          activeThinkingId: null,
          messages:
            msg.toolName === 'AskUserQuestion'
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
        }))
        break

      case 'computer_use_permission_request':
        update(() => ({
          pendingComputerUsePermission: {
            requestId: msg.requestId,
            request: msg.request,
          },
          pendingPermission: null,
          chatState: 'permission_pending',
          activeThinkingId: null,
        }))
        break

      case 'message_complete': {
        const session = get().sessions[sessionId]
        if (!session) break
        const text = `${session.streamingText}${consumePendingDelta()}`
        if (text.trim()) {
          update((s) => ({
            messages: appendAssistantTextMessage(s.messages, text, Date.now()),
            streamingText: '',
          }))
        } else if (text !== session.streamingText) {
          update(() => ({ streamingText: text }))
        }
        if (session.elapsedTimer) clearInterval(session.elapsedTimer)
        update(() => ({
          tokenUsage: msg.usage,
          chatState: 'idle',
          activeThinkingId: null,
          pendingPermission: null,
          pendingComputerUsePermission: null,
          elapsedTimer: null,
        }))
        break
      }

      case 'error':
        update((s) => {
          const pendingText = `${s.streamingText}${consumePendingDelta()}`
          let newMessages = s.messages
          if (pendingText.trim()) {
            newMessages = appendAssistantTextMessage(newMessages, pendingText, Date.now())
          }
          newMessages = [...newMessages, { id: nextId(), type: 'error', message: msg.message, code: msg.code, timestamp: Date.now() }]
          return {
            messages: newMessages,
            chatState: 'idle',
            activeThinkingId: null,
            streamingText: '',
            pendingPermission: null,
            pendingComputerUsePermission: null,
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
          update(() => ({ slashCommands: msg.data as Array<{ name: string; description: string }> }))
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
            pendingComputerUsePermission: null,
            chatState: 'idle',
            elapsedTimer: null,
            elapsedSeconds: 0,
            statusVerb: '',
            tokenUsage: { input_tokens: 0, output_tokens: 0 },
            slashCommands: [],
          }))
          useCLITaskStore.getState().clearTasks()
          useSessionStore.getState().updateSessionTitle(sessionId, 'New Session')
          useTabStore.getState().updateTabTitle(sessionId, 'New Session')
          useTabStore.getState().updateTabStatus(sessionId, 'idle')
        }
        if (msg.subtype === 'compact_boundary') {
          update((session) => ({
            messages: [
              ...session.messages,
              {
                id: nextId(),
                type: 'system',
                content: typeof msg.message === 'string' && msg.message.trim()
                  ? msg.message
                  : 'Context compacted',
                timestamp: Date.now(),
              },
            ],
          }))
        }
        if (msg.subtype === 'task_notification' && msg.data && typeof msg.data === 'object') {
          const data = msg.data as Record<string, unknown>
          const toolUseId =
            typeof data.tool_use_id === 'string' && data.tool_use_id.trim()
              ? data.tool_use_id
              : null
          const taskStatus = data.status
          if (
            toolUseId &&
            (taskStatus === 'completed' ||
              taskStatus === 'failed' ||
              taskStatus === 'stopped')
          ) {
            update((session) => ({
              agentTaskNotifications: {
                ...session.agentTaskNotifications,
                [toolUseId]: {
                  taskId:
                    typeof data.task_id === 'string' && data.task_id.trim()
                      ? data.task_id
                      : toolUseId,
                  toolUseId,
                  status: taskStatus,
                  summary:
                    typeof data.summary === 'string' && data.summary.trim()
                      ? data.summary
                      : undefined,
                  outputFile:
                    typeof data.output_file === 'string' && data.output_file.trim()
                      ? data.output_file
                      : undefined,
                },
              },
            }))
          }
        }
        break
      case 'pong':
        break
    }
  },
}))

// ─── History mapping helpers (unchanged from original) ─────────

type AssistantHistoryBlock = { type: string; text?: string; thinking?: string; name?: string; id?: string; input?: unknown }
type UserHistoryBlock = { type: string; text?: string; tool_use_id?: string; content?: unknown; is_error?: boolean; source?: { data?: string }; mimeType?: string; media_type?: string; name?: string }

/**
 * Check if text is a teammate-message (internal agent-to-agent communication).
 * Uses full open+close tag match to avoid false positives on user text
 * that merely mentions the tag name (e.g., pasting code or discussing the protocol).
 */
function isTeammateMessage(text: string): boolean {
  return text.includes('<teammate-message') && text.includes('</teammate-message>')
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
): void {
  if (!content.trim()) return

  const last = messages[messages.length - 1]
  if (last?.type === 'assistant_text') {
    last.content += content
    if (model && !last.model) last.model = model
    return
  }

  messages.push({
    id: nextId(),
    type: 'assistant_text',
    content,
    timestamp,
    ...(model ? { model } : {}),
  })
}

type HistoryMappingOptions = {
  includeTeammateMessages?: boolean
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

  if (agentNameToToolUseId.size === 0) return {}

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

  return notifications
}

export function mapHistoryMessagesToUiMessages(
  messages: MessageEntry[],
  options?: HistoryMappingOptions,
): UIMessage[] {
  const includeTeammateMessages = options?.includeTeammateMessages === true
  const uiMessages: UIMessage[] = []
  for (const msg of messages) {
    const timestamp = new Date(msg.timestamp).getTime()
    if (msg.type === 'user' && typeof msg.content === 'string') {
      if (isTeammateMessage(msg.content)) {
        if (!includeTeammateMessages) continue
        const teammateContents = extractVisibleTeammateMessageContents(msg.content)
        if (teammateContents.length === 0) continue
        uiMessages.push({
          id: msg.id || nextId(),
          type: 'user_text',
          content: teammateContents.join('\n\n'),
          timestamp,
        })
        continue
      }
      uiMessages.push({ id: msg.id || nextId(), type: 'user_text', content: msg.content, timestamp })
      continue
    }
    if (msg.type === 'assistant' && typeof msg.content === 'string') {
      uiMessages.push({ id: msg.id || nextId(), type: 'assistant_text', content: msg.content, timestamp, model: msg.model })
      continue
    }
    if ((msg.type === 'assistant' || msg.type === 'tool_use') && Array.isArray(msg.content)) {
      for (const block of msg.content as AssistantHistoryBlock[]) {
        if (block.type === 'thinking' && block.thinking) uiMessages.push({ id: nextId(), type: 'thinking', content: block.thinking, timestamp })
        else if (block.type === 'text' && block.text) pushAssistantHistoryText(uiMessages, block.text, timestamp, msg.model)
        else if (block.type === 'tool_use') uiMessages.push({ id: nextId(), type: 'tool_use', toolName: block.name ?? 'unknown', toolUseId: block.id ?? '', input: block.input, timestamp, parentToolUseId: msg.parentToolUseId })
      }
      continue
    }
    if ((msg.type === 'user' || msg.type === 'tool_result') && Array.isArray(msg.content)) {
      const textParts: string[] = []
      const attachments: UIAttachment[] = []
      for (const block of msg.content as UserHistoryBlock[]) {
        if (block.type === 'text' && block.text && isTeammateMessage(block.text)) {
          if (!includeTeammateMessages) continue
          textParts.push(...extractVisibleTeammateMessageContents(block.text))
        } else if (block.type === 'text' && block.text) {
          textParts.push(block.text)
        }
        else if (block.type === 'image') attachments.push({ type: 'image', name: block.name || 'image', data: block.source?.data, mimeType: block.mimeType || block.media_type })
        else if (block.type === 'file') attachments.push({ type: 'file', name: block.name || 'file' })
        else if (block.type === 'tool_result') uiMessages.push({ id: nextId(), type: 'tool_result', toolUseId: block.tool_use_id ?? '', content: block.content, isError: !!block.is_error, timestamp, parentToolUseId: msg.parentToolUseId })
      }
      if (textParts.length > 0 || attachments.length > 0) {
        uiMessages.push({ id: msg.id || nextId(), type: 'user_text', content: textParts.join('\n'), attachments: attachments.length > 0 ? attachments : undefined, timestamp })
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
