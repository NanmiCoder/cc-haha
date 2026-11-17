import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSessionState, useChatStore } from './chatStore'
import { useTabStore } from './tabStore'
import { wsManager } from '@/api/websocket'
import { sessionsApi } from '@/api/sessions'

const SESSION_ID = 'session-deepseek-stop'

describe('chatStore immediate stop fence (#1917)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useTabStore.setState({
      tabs: [{
        sessionId: SESSION_ID,
        title: 'DeepSeek Session',
        type: 'session',
        status: 'running',
      }],
      activeTabId: SESSION_ID,
    })
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          ...createDefaultSessionState(),
          connectionState: 'connected',
          historyHydrated: true,
          historyStatus: 'ready',
          historyBootstrapDisabled: true,
          chatState: 'thinking',
          streamingText: 'Partial before stop',
          backgroundAgentTasks: {
            'agent-1': {
              taskId: 'agent-1',
              toolUseId: 'tool-agent-1',
              taskType: 'local_agent',
              description: 'Helper subagent',
              status: 'running',
              startedAt: 1,
              updatedAt: 1,
            },
          },
        },
      },
    })
  })

  afterEach(() => {
    const session = useChatStore.getState().sessions[SESSION_ID]
    if (session?.elapsedTimer) clearInterval(session.elapsedTimer)
    useChatStore.setState({ sessions: {} })
    useTabStore.setState({ tabs: [], activeTabId: null })
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps chatState idle when in-flight DeepSeek thinking, delta, retry, and tool frames arrive before server idle ack, then streams normally on the next turn', () => {
    const sendSpy = vi.spyOn(wsManager, 'send').mockImplementation(() => {})
    vi.spyOn(wsManager, 'isConnected').mockReturnValue(true)

    const store = useChatStore.getState()
    store.stopGeneration(SESSION_ID)

    expect(sendSpy).toHaveBeenCalledWith(SESSION_ID, { type: 'stop_generation' })
    expect(useChatStore.getState().sessions[SESSION_ID]?.chatState).toBe('idle')
    expect(useChatStore.getState().sessions[SESSION_ID]?.stopAllSubagentsRequested).toBe(true)

    const messageCountAfterStop = useChatStore.getState().sessions[SESSION_ID]!.messages.length

    // Dense burst of frames already in flight on the WebSocket before server processes stop_generation:
    store.handleServerMessage(SESSION_ID, { type: 'status', state: 'thinking', verb: 'Thinking' })
    store.handleServerMessage(SESSION_ID, { type: 'thinking', text: 'Late DeepSeek reasoning burst 1' })
    store.handleServerMessage(SESSION_ID, { type: 'thinking', text: ' and burst 2' })
    store.handleServerMessage(SESSION_ID, { type: 'content_start', blockType: 'text' })
    store.handleServerMessage(SESSION_ID, { type: 'content_delta', text: 'Late text after stop' })
    store.handleServerMessage(SESSION_ID, {
      type: 'content_start',
      blockType: 'tool_use',
      toolName: 'Bash',
      toolUseId: 'late-tool-1',
    })
    store.handleServerMessage(SESSION_ID, {
      type: 'content_delta',
      toolInput: '{"command":"sleep 10"}',
    })
    store.handleServerMessage(SESSION_ID, {
      type: 'tool_use_complete',
      toolName: 'Bash',
      toolUseId: 'late-tool-1',
      input: { command: 'sleep 10' },
    })
    store.handleServerMessage(SESSION_ID, {
      type: 'tool_result',
      toolUseId: 'late-tool-1',
      content: 'late result',
      isError: false,
    })
    store.handleServerMessage(SESSION_ID, {
      type: 'api_retry',
      attempt: 1,
      maxRetries: 3,
      retryDelayMs: 1000,
      errorStatus: 529,
      errorMessage: 'overloaded',
    })
    store.handleServerMessage(SESSION_ID, {
      type: 'streaming_fallback',
      cause: 'stream_error',
    })
    store.handleServerMessage(SESSION_ID, {
      type: 'permission_request',
      requestId: 'late-perm-1',
      toolName: 'Bash',
      input: { command: 'rm -rf /tmp/x' },
    })
    store.handleServerMessage(SESSION_ID, {
      type: 'computer_use_permission_request',
      requestId: 'late-cu-perm-1',
      request: {
        action: 'screenshot',
        reason: 'late screenshot',
      } as never,
    })
    store.handleServerMessage(SESSION_ID, {
      type: 'permission_requests_snapshot',
      toolRequestIds: [],
      computerUseRequestIds: [],
      turnActive: true,
    })

    vi.advanceTimersByTime(100)

    const duringFence = useChatStore.getState().sessions[SESSION_ID]!
    expect(duringFence.chatState).toBe('idle')
    expect(duringFence.elapsedTimer).toBeNull()
    expect(duringFence.streamingText).toBe('')
    expect(duringFence.streamingToolInput).toBe('')
    expect(duringFence.pendingPermission).toBeNull()
    expect(duringFence.apiRetry).toBeNull()
    expect(duringFence.streamingFallback).toBeNull()
    expect(duringFence.stopAllSubagentsRequested).toBe(true)
    expect(duringFence.messages).toHaveLength(messageCountAfterStop)

    // Server processes stop_generation and sends terminal status: idle
    store.handleServerMessage(SESSION_ID, { type: 'status', state: 'idle' })
    expect(useChatStore.getState().sessions[SESSION_ID]?.chatState).toBe('idle')

    // Next user turn starts and streams DeepSeek reasoning + text normally!
    store.sendMessage(SESSION_ID, 'Follow-up prompt')
    expect(useChatStore.getState().sessions[SESSION_ID]?.chatState).toBe('thinking')

    store.handleServerMessage(SESSION_ID, {
      type: 'user_message_replay',
      content: 'Follow-up prompt',
    })
    store.handleServerMessage(SESSION_ID, {
      type: 'thinking',
      text: 'Fresh turn reasoning',
    })
    store.handleServerMessage(SESSION_ID, {
      type: 'content_start',
      blockType: 'text',
    })
    store.handleServerMessage(SESSION_ID, {
      type: 'content_delta',
      text: 'Fresh turn answer',
    })
    vi.advanceTimersByTime(60)

    const nextTurn = useChatStore.getState().sessions[SESSION_ID]!
    expect(nextTurn.chatState).toBe('streaming')
    expect(nextTurn.streamingText).toBe('Fresh turn answer')
    expect(nextTurn.messages.some((m) => m.type === 'thinking' && m.content === 'Fresh turn reasoning')).toBe(true)
  })

  it('allows immediate sendMessage right after stopGeneration even before server idle status arrives', () => {
    vi.spyOn(wsManager, 'send').mockImplementation(() => {})
    vi.spyOn(wsManager, 'isConnected').mockReturnValue(true)

    const store = useChatStore.getState()
    store.stopGeneration(SESSION_ID)
    store.sendMessage(SESSION_ID, 'Immediate replacement prompt')
    store.handleServerMessage(SESSION_ID, { type: 'thinking', text: 'Replacement thinking' })

    const session = useChatStore.getState().sessions[SESSION_ID]!
    expect(session.chatState).toBe('thinking')
    expect(session.messages.some((m) => m.type === 'thinking' && m.content === 'Replacement thinking')).toBe(true)
  })

  it('fires HTTP POST /api/sessions/:id/chat/stop immediately when session WebSocket is still connecting or reconnecting', () => {
    const sendSpy = vi.spyOn(wsManager, 'send').mockImplementation(() => {})
    vi.spyOn(wsManager, 'isConnected').mockReturnValue(false)
    const stopChatMock = vi.spyOn(sessionsApi, 'stopChat').mockResolvedValue({ ok: true })

    useChatStore.getState().stopGeneration(SESSION_ID)

    expect(sendSpy).toHaveBeenCalledWith(SESSION_ID, { type: 'stop_generation' })
    expect(stopChatMock).toHaveBeenCalledWith(SESSION_ID)
  })

  it('clears stopping fence across terminal server boundaries and explicit user actions', () => {
    vi.spyOn(wsManager, 'send').mockImplementation(() => {})
    vi.spyOn(wsManager, 'isConnected').mockReturnValue(true)
    const store = useChatStore.getState()

    // 1. permission_requests_snapshot with turnActive: false clears fence
    store.stopGeneration(SESSION_ID)
    store.handleServerMessage(SESSION_ID, {
      type: 'permission_requests_snapshot',
      toolRequestIds: [],
      computerUseRequestIds: [],
      turnActive: false,
    })
    expect(useChatStore.getState().sessions[SESSION_ID]?.awaitingStopIdle).toBe(false)

    // 2. session_state idle clears fence
    store.stopGeneration(SESSION_ID)
    store.handleServerMessage(SESSION_ID, {
      type: 'session_state',
      turnState: 'idle',
      activeBackgroundTaskIds: [],
    })
    expect(useChatStore.getState().sessions[SESSION_ID]?.awaitingStopIdle).toBe(false)

    // 3. session_state running clears fence and resumes running state
    store.stopGeneration(SESSION_ID)
    store.handleServerMessage(SESSION_ID, {
      type: 'session_state',
      turnState: 'running',
      activeBackgroundTaskIds: [],
    })
    expect(useChatStore.getState().sessions[SESSION_ID]?.awaitingStopIdle).toBe(false)
    expect(useChatStore.getState().sessions[SESSION_ID]?.chatState).toBe('thinking')

    // 4. message_complete clears fence
    store.stopGeneration(SESSION_ID)
    store.handleServerMessage(SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    expect(useChatStore.getState().sessions[SESSION_ID]?.awaitingStopIdle).toBe(false)

    // 5. error clears fence
    store.stopGeneration(SESSION_ID)
    store.handleServerMessage(SESSION_ID, {
      type: 'error',
      message: 'boom',
      code: 'API_ERROR',
    })
    expect(useChatStore.getState().sessions[SESSION_ID]?.awaitingStopIdle).toBe(false)

    // 6. goal_event and session_cleared clear fence
    store.stopGeneration(SESSION_ID)
    store.handleServerMessage(SESSION_ID, {
      type: 'system_notification',
      subtype: 'goal_event',
      message: 'Goal started',
      data: { action: 'started', goal: 'Fix bug' },
    })
    expect(useChatStore.getState().sessions[SESSION_ID]?.awaitingStopIdle).toBe(false)

    store.stopGeneration(SESSION_ID)
    store.handleServerMessage(SESSION_ID, {
      type: 'system_notification',
      subtype: 'session_cleared',
    })
    expect(useChatStore.getState().sessions[SESSION_ID]?.awaitingStopIdle).toBe(false)

    // 7. sendQueuedUserMessage and clearMessages clear fence
    store.queueUserMessage(SESSION_ID, { content: 'Queued prompt', displayContent: 'Queued prompt' })
    const queuedId = useChatStore.getState().sessions[SESSION_ID]?.queuedUserMessages?.[0]?.id
    store.stopGeneration(SESSION_ID)
    if (queuedId) store.sendQueuedUserMessage(SESSION_ID, queuedId)
    expect(useChatStore.getState().sessions[SESSION_ID]?.awaitingStopIdle).toBe(false)

    store.stopGeneration(SESSION_ID)
    store.clearMessages(SESSION_ID)
    expect(useChatStore.getState().sessions[SESSION_ID]?.awaitingStopIdle).toBe(false)
  })
})
