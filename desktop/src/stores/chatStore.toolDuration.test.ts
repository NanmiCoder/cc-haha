import { beforeEach, describe, expect, it } from 'vitest'
import { toolCallDurationMs } from '../components/chat/activityGroupModel'
import { mapHistoryMessagesToUiMessages, type PerSessionState, useChatStore } from './chatStore'
import { useTabStore } from './tabStore'
import type { MessageEntry } from '../types/session'

const SESSION_ID = 'session-issue-1915'

function makeSession(): PerSessionState {
  return {
    messages: [],
    chatState: 'streaming',
    connectionState: 'connected',
    historyStatus: 'idle',
    historyHydrated: false,
    historyError: null,
    streamingText: '',
    streamingToolInput: '',
    activeToolUseId: null,
    activeToolName: null,
    activeThinkingId: null,
    pendingPermission: null,
    pendingComputerUsePermission: null,
    tokenUsage: { input_tokens: 0, output_tokens: 0 },
    streamingResponseChars: 0,
    elapsedSeconds: 0,
    statusVerb: '',
    apiRetry: null,
    slashCommands: [],
    agentTaskNotifications: {},
    backgroundAgentTasks: {},
    elapsedTimer: null,
  }
}

describe('chatStore tool_result durationMs (#1915)', () => {
  beforeEach(() => {
    useTabStore.setState({
      tabs: [{ sessionId: SESSION_ID, title: 'Test', type: 'session', status: 'idle' }],
      activeTabId: SESSION_ID,
    })
    useChatStore.setState({ sessions: { [SESSION_ID]: makeSession() } })
  })

  it('stores per-tool durationMs from live tool_result frames instead of streaming + serial queue delta', () => {
    const store = useChatStore.getState()
    store.handleServerMessage(SESSION_ID, {
      type: 'content_start',
      blockType: 'tool_use',
      toolName: 'Edit',
      toolUseId: 'toolu_edit_1',
    })
    store.handleServerMessage(SESSION_ID, {
      type: 'tool_use_complete',
      toolName: 'Edit',
      toolUseId: 'toolu_edit_1',
      input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' },
    })
    store.handleServerMessage(SESSION_ID, {
      type: 'tool_result',
      toolUseId: 'toolu_edit_1',
      content: 'The file a.ts has been updated.',
      isError: false,
      durationMs: 220,
    })

    const messages = useChatStore.getState().sessions[SESSION_ID]?.messages ?? []
    const toolCall = messages.find((m) => m.type === 'tool_use' && m.toolUseId === 'toolu_edit_1')
    const toolResult = messages.find((m) => m.type === 'tool_result' && m.toolUseId === 'toolu_edit_1')
    expect(toolCall?.type).toBe('tool_use')
    expect(toolResult).toMatchObject({
      type: 'tool_result',
      toolUseId: 'toolu_edit_1',
      durationMs: 220,
    })
    if (toolCall?.type === 'tool_use' && toolResult?.type === 'tool_result') {
      // Simulate 1.92s of streaming + queue delay between content_block_start and tool_result arrival.
      expect(toolCallDurationMs({ timestamp: toolResult.timestamp - 1920 }, toolResult)).toBe(220)
    }
  })

  it('hydrates durationMs from MessageEntry history while keeping legacy and multi-result entries clean', () => {
    const history: MessageEntry[] = [
      {
        id: 'assistant-batch',
        type: 'tool_use',
        timestamp: '2026-11-16T04:00:00.000Z',
        content: [
          { type: 'tool_use', id: 'edit_1', name: 'Edit', input: { file_path: 'a.ts' } },
          { type: 'tool_use', id: 'edit_denied', name: 'Edit', input: { file_path: 'b.ts' } },
          { type: 'tool_use', id: 'grep_legacy', name: 'Grep', input: { pattern: 'foo' } },
        ],
      },
      {
        id: 'result-1',
        type: 'tool_result',
        timestamp: '2026-11-16T04:00:01.770Z',
        durationMs: 220,
        content: [{ type: 'tool_result', tool_use_id: 'edit_1', content: 'updated a.ts', is_error: false }],
      },
      {
        id: 'result-zero',
        type: 'tool_result',
        timestamp: '2026-11-16T04:00:12.000Z',
        durationMs: 0,
        content: [{ type: 'tool_result', tool_use_id: 'edit_denied', content: 'User rejected edit', is_error: true }],
      },
      {
        id: 'result-legacy',
        type: 'tool_result',
        timestamp: '2026-11-16T04:00:02.490Z',
        content: [{ type: 'tool_result', tool_use_id: 'grep_legacy', content: '3 matches', is_error: false }],
      },
      {
        id: 'result-multi',
        type: 'tool_result',
        timestamp: '2026-11-16T04:00:03.000Z',
        durationMs: 180,
        content: [
          { type: 'tool_result', tool_use_id: 'multi_a', content: 'a', is_error: false },
          { type: 'tool_result', tool_use_id: 'multi_b', content: 'b', is_error: false },
        ],
      },
    ]

    const uiMessages = mapHistoryMessagesToUiMessages(history)
    const byToolId = new Map(
      uiMessages
        .filter((m): m is Extract<typeof m, { type: 'tool_result' }> => m.type === 'tool_result')
        .map((m) => [m.toolUseId, m]),
    )
    const callsByToolId = new Map(
      uiMessages
        .filter((m): m is Extract<typeof m, { type: 'tool_use' }> => m.type === 'tool_use')
        .map((m) => [m.toolUseId, m]),
    )

    expect(byToolId.get('edit_1')?.durationMs).toBe(220)
    expect(toolCallDurationMs(callsByToolId.get('edit_1')!, byToolId.get('edit_1'))).toBe(220)

    expect(byToolId.get('edit_denied')?.durationMs).toBe(0)
    expect(toolCallDurationMs(callsByToolId.get('edit_denied')!, byToolId.get('edit_denied'))).toBe(0)

    expect('durationMs' in byToolId.get('grep_legacy')!).toBe(false)
    expect(toolCallDurationMs(callsByToolId.get('grep_legacy')!, byToolId.get('grep_legacy'))).toBe(2490)

    expect('durationMs' in byToolId.get('multi_a')!).toBe(false)
    expect('durationMs' in byToolId.get('multi_b')!).toBe(false)
  })
})
