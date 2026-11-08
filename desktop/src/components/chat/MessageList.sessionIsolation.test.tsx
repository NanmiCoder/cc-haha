import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { MessageList } from '@/components/chat/MessageList'
import { sessionsApi } from '@/api/sessions'
import { mapHistoryMessagesToUiMessages, useChatStore, type PerSessionState } from '@/stores/chatStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useTabStore } from '@/stores/tabStore'
import { useTeamStore } from '@/stores/teamStore'
import { useWorkspaceChatContextStore } from '@/stores/workspaceChatContextStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useWorkflowStore } from '@/stores/workflowStore'
import type { UIMessage } from '@/types/chat'
import type { MessageEntry } from '@/types/session'

function replayedHistory(placement: 'separated' | 'adjacent'): MessageEntry[] {
  const history: MessageEntry[] = [{
    id: 'prompt-a',
    type: 'user',
    content: 'Read the fixture files one by one',
    timestamp: '2026-11-07T06:00:00.000Z',
  }]
  for (let index = 0; index < 5; index++) {
    const timestamp = new Date(Date.UTC(2026, 10, 7, 6, 0, index * 3 + 1)).toISOString()
    const text: MessageEntry = {
      id: `assistant-${index}`,
      type: 'assistant',
      content: [{ type: 'text', text: `A read page ${index}` }],
      timestamp,
    }
    history.push(text)
    if (index > 0 && placement === 'adjacent') history.push({ ...text })
    history.push({
      id: `tool-${index}`,
      type: 'tool_use',
      content: [{ type: 'tool_use', name: 'Bash', id: `bash-${index}`, input: { command: `sleep 10 && cat page-${index}.txt` } }],
      timestamp,
    })
    if (index > 0 && placement === 'separated') history.push({ ...text })
    history.push({
      id: `result-${index}`,
      type: 'tool_result',
      content: [{ type: 'tool_result', tool_use_id: `bash-${index}`, content: `page ${index}` }],
      timestamp,
    })
  }
  return history
}

function switchSession(sessionId: string) {
  act(() => {
    useTabStore.setState({ activeTabId: sessionId })
    useSessionStore.setState({ activeSessionId: sessionId })
  })
}

function assistantTexts(container: HTMLElement) {
  return [...container.querySelectorAll('[data-message-shell="assistant"]')].map(node => node.textContent)
}

function makeSessionState(messages: UIMessage[]): PerSessionState {
  return {
    messages,
    chatState: 'thinking',
    connectionState: 'connected',
    historyStatus: 'ready',
    historyHydrated: true,
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
    elapsedTimer: null,
    composerPrefill: null,
  }
}

describe('MessageList session isolation', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    // Repeated identities deliberately exercise React's unsupported-key path.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    useSettingsStore.setState({ locale: 'en' })
    useTabStore.setState({ activeTabId: 'session-a', tabs: [
      { sessionId: 'session-a', title: 'A', type: 'session', status: 'running' },
      { sessionId: 'session-b', title: 'B', type: 'session', status: 'running' },
    ] })
    useSessionStore.setState({ sessions: [], activeSessionId: 'session-a', isLoading: false, error: null })
    useTeamStore.getState().clearTeam()
    useWorkspaceChatContextStore.setState(useWorkspaceChatContextStore.getInitialState(), true)
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true)
    vi.spyOn(sessionsApi, 'getTurnCheckpoints').mockImplementation(() => new Promise(() => {}))
    vi.spyOn(sessionsApi, 'getWorkspaceStatus').mockImplementation(() => new Promise(() => {}))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // The old recorder can append text → tool → the same text UUID after its
  // message cache is cleared during an in-flight write. Each page has its own
  // UUID and each tool occurs once, matching the real recorder/API replay.
  // Adjacent duplicate text is a negative control: history mapping coalesces
  // it into one row, so duplicate API ids alone do not imply orphan DOM.
  it.each(['separated', 'adjacent'] as const)('isolates sessions after mapping %s replayed text records', (placement) => {
    const oldMessages = mapHistoryMessagesToUiMessages(replayedHistory(placement))
    useChatStore.setState({ sessions: {
      'session-a': makeSessionState(oldMessages),
      'session-b': makeSessionState([
        { id: 'prompt-b', type: 'user_text', content: 'Can my local network be reached?', timestamp: 99 },
      ]),
    } })

    const view = render(<MessageList />)
    expect(screen.getByText('A read page 0')).toBeTruthy()
    const initialAssistantTexts = assistantTexts(view.container)
    const initialRowCount = view.container.querySelectorAll('[data-chat-render-item-key]').length
    expect(view.container.querySelectorAll('[data-tool-use-id]')).toHaveLength(5)

    switchSession('session-b')

    expect(useChatStore.getState().sessions['session-b']?.messages).toHaveLength(1)
    expect(screen.queryAllByText(/A read page/)).toHaveLength(0)
    expect(view.container.querySelectorAll('[data-chat-render-item-key]')).toHaveLength(1)
    expect(screen.getByText('Can my local network be reached?')).toBeTruthy()
    expect(view.container.querySelector('[data-tool-use-id]')).toBeNull()

    // Revisiting A must rebuild its own transcript, and a second switch must
    // leave B with the same single prompt as its store rather than orphan DOM.
    switchSession('session-a')
    expect(assistantTexts(view.container)).toEqual(initialAssistantTexts)
    expect(view.container.querySelectorAll('[data-chat-render-item-key]')).toHaveLength(initialRowCount)
    expect(screen.queryByText('Can my local network be reached?')).toBeNull()

    switchSession('session-b')
    expect(screen.queryAllByText(/A read page/)).toHaveLength(0)
    expect(view.container.querySelectorAll('[data-chat-render-item-key]')).toHaveLength(1)
    expect(useChatStore.getState().sessions['session-a']?.messages).toEqual(oldMessages)
  })

  it('removes orphan paragraphs accumulated by a bounded reconnect history backfill', async () => {
    const history = replayedHistory('separated')
    useChatStore.setState({ sessions: {
      'session-a': makeSessionState(mapHistoryMessagesToUiMessages(history)),
      'session-b': makeSessionState([
        { id: 'prompt-b', type: 'user_text', content: 'Can my local network be reached?', timestamp: 99 },
      ]),
    } })
    const view = render(<MessageList />)

    // A bounded reader may start between two occurrences of a replayed UUID.
    // This legal response starts at page 1's tool, after its first text copy.
    // It models a history-budget boundary, not a proven Windows wake sequence.
    // Before isolation, this backfill then switching to B left page 1 once and
    // pages 2–4 twice, with no tools and only B's prompt present in B's store.
    const sourceVersion = '1:1:100:1'
    vi.spyOn(sessionsApi, 'getFullHistory').mockResolvedValue({
      messages: history.slice(5),
      taskNotifications: [],
      page: {
        nextCursor: 'older-history-cursor',
        hasMore: true,
        historyComplete: false,
        sourceVersion,
        scannedBytes: 100,
        omittedOversizedEntries: 0,
      },
    })
    vi.spyOn(sessionsApi, 'getHistoryRecovery').mockResolvedValue({
      messages: [],
      taskNotifications: [],
      sourceVersion,
      status: 'ready',
      tokenUsage: null,
      omittedRecords: 0,
    })
    vi.spyOn(useWorkflowStore.getState(), 'hydrateSession').mockResolvedValue(undefined)

    await act(async () => {
      await useChatStore.getState().loadHistory('session-a', { mode: 'terminal-reconnect' })
    })
    switchSession('session-b')

    expect(useChatStore.getState().sessions['session-b']?.messages).toHaveLength(1)
    expect(screen.queryAllByText(/A read page/)).toHaveLength(0)
    expect(view.container.querySelectorAll('[data-chat-render-item-key]')).toHaveLength(1)
    expect(view.container.querySelector('[data-tool-use-id]')).toBeNull()
    expect(screen.getByText('Can my local network be reached?')).toBeTruthy()
  })
})
