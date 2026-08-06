import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageEntry } from '../types/session'
import { useSessionRuntimeStore } from './sessionRuntimeStore'

const {
  sendMock,
  getMemberBySessionIdMock,
  sendMessageToMemberMock,
  handleTeamCreatedMock,
  handleTeamUpdateMock,
  handleTeamDeletedMock,
  fetchSessionTasksMock,
  clearTasksMock,
  setTasksFromTodosMock,
  markCompletedAndDismissedMock,
  resetCompletedTasksMock,
  refreshTasksMock,
  notifyDesktopMock,
  updateTabTitleMock,
  updateTabStatusMock,
  updateSessionTitleMock,
  updateSessionMessageCountMock,
  updateSessionPermissionModeMock,
  sessionStoreSnapshot,
  cliTaskStoreSnapshot,
  connectionStateHandlers,
} = vi.hoisted(() => ({
  sendMock: vi.fn(),
  getMemberBySessionIdMock: vi.fn<(sessionId: string) => any>(() => null),
  sendMessageToMemberMock: vi.fn(async () => {}),
  handleTeamCreatedMock: vi.fn(),
  handleTeamUpdateMock: vi.fn(),
  handleTeamDeletedMock: vi.fn(),
  fetchSessionTasksMock: vi.fn(),
  clearTasksMock: vi.fn(),
  setTasksFromTodosMock: vi.fn(),
  markCompletedAndDismissedMock: vi.fn(),
  resetCompletedTasksMock: vi.fn(async () => {}),
  refreshTasksMock: vi.fn(),
  notifyDesktopMock: vi.fn(),
  updateTabTitleMock: vi.fn(),
  updateTabStatusMock: vi.fn(),
  updateSessionTitleMock: vi.fn(),
  updateSessionMessageCountMock: vi.fn(),
  updateSessionPermissionModeMock: vi.fn(),
  sessionStoreSnapshot: {
    sessions: [] as Array<{
      id: string
      title: string
      createdAt: string
      modifiedAt: string
      messageCount: number
      projectPath: string
      workDir: string | null
      workDirExists: boolean
    }>,
  },
  cliTaskStoreSnapshot: {
    tasks: [] as Array<{ id: string; subject: string; status: string; activeForm?: string }>,
    sessionId: null as string | null,
  },
  connectionStateHandlers: new Map<string, (state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected') => void>(),
}))

vi.mock('../lib/desktopNotifications', () => ({
  notifyDesktop: notifyDesktopMock,
}))

vi.mock('../api/websocket', () => ({
  wsManager: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onConnectionState: vi.fn((sessionId: string, handler: (state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected') => void) => {
      connectionStateHandlers.set(sessionId, handler)
      handler('connecting')
      return () => connectionStateHandlers.delete(sessionId)
    }),
    onMessage: vi.fn(() => () => {}),
    clearHandlers: vi.fn(),
    send: sendMock,
  },
}))

vi.mock('../api/sessions', () => ({
  sessionsApi: {
    getMessages: vi.fn(async () => ({ messages: [] })),
    getSlashCommands: vi.fn(async () => ({ commands: [] })),
  },
}))

vi.mock('./teamStore', () => ({
  useTeamStore: {
    getState: () => ({
      getMemberBySessionId: getMemberBySessionIdMock,
      sendMessageToMember: sendMessageToMemberMock,
      handleTeamCreated: handleTeamCreatedMock,
      handleTeamUpdate: handleTeamUpdateMock,
      handleTeamDeleted: handleTeamDeletedMock,
    }),
  },
}))

vi.mock('./tabStore', () => ({
  useTabStore: {
    getState: () => ({
      updateTabStatus: updateTabStatusMock,
      updateTabTitle: updateTabTitleMock,
    }),
  },
}))

vi.mock('./sessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      sessions: sessionStoreSnapshot.sessions,
      updateSessionTitle: updateSessionTitleMock,
      updateSessionMessageCount: updateSessionMessageCountMock,
      updateSessionPermissionMode: updateSessionPermissionModeMock,
    }),
  },
}))

vi.mock('./cliTaskStore', () => ({
  useCLITaskStore: {
    getState: () => ({
      fetchSessionTasks: fetchSessionTasksMock,
      tasks: cliTaskStoreSnapshot.tasks,
      sessionId: cliTaskStoreSnapshot.sessionId,
      clearTasks: clearTasksMock,
      setTasksFromTodos: setTasksFromTodosMock,
      markCompletedAndDismissed: markCompletedAndDismissedMock,
      resetCompletedTasks: resetCompletedTasksMock,
      refreshTasks: refreshTasksMock,
    }),
  },
}))

import { sessionsApi } from '../api/sessions'
import { useSettingsStore } from './settingsStore'
import {
  mapHistoryMessagesToUiMessages,
  reconstructAgentNotifications,
  stripGeneratedImageMetadataLines,
  type PerSessionState,
  useChatStore,
} from './chatStore'

const TEST_SESSION_ID = 'test-session-1'
const initialState = useChatStore.getState()

function makeSession(overrides: Partial<PerSessionState> = {}): PerSessionState {
  return {
    messages: [],
    chatState: 'streaming',
    connectionState: 'connected',
    historyStatus: 'idle',
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
    ...overrides,
  }
}

describe('stripGeneratedImageMetadataLines', () => {
  it('removes simple, detailed, and resize metadata lines but keeps the prompt body', () => {
    const text = [
      'first line of the prompt',
      'second line',
      '[Image source: C:\\Users\\Relakkes\\.claude\\uploads\\sid\\a.png]',
      '[Image: source: /Users/me/.claude/uploads/sid/b.png, original 1024x768, displayed at 512x384. Multiply coordinates by 2 to map to original image.]',
      '[Image: original 800x600, displayed at 400x300. Multiply coordinates by 2 to map to original image.]',
    ].join('\n')
    expect(stripGeneratedImageMetadataLines(text)).toBe('first line of the prompt\nsecond line')
  })

  it('normalizes CRLF and leaves metadata-free text untouched', () => {
    expect(stripGeneratedImageMetadataLines('a\r\nb\r\n')).toBe('a\nb')
    expect(stripGeneratedImageMetadataLines('just a normal prompt')).toBe('just a normal prompt')
  })

  it('returns empty string when the text is only metadata', () => {
    expect(stripGeneratedImageMetadataLines('[Image source: /tmp/x.png]')).toBe('')
  })
})

describe('chatStore tool settlement', () => {
  beforeEach(() => {
    sendMock.mockReset()
    updateTabStatusMock.mockReset()
    notifyDesktopMock.mockReset()
    localStorage.clear()
    useSettingsStore.setState({ locale: 'en' })
    useChatStore.setState({
      ...initialState,
      sessions: {
        [TEST_SESSION_ID]: makeSession(),
      },
    })
  })

  it('marks sibling pending tool calls stopped when a parallel tool result fails and the turn completes', () => {
    const store = useChatStore.getState()

    store.handleServerMessage(TEST_SESSION_ID, {
      type: 'content_start',
      blockType: 'tool_use',
      toolName: 'Grep',
      toolUseId: 'grep-1',
    })
    store.handleServerMessage(TEST_SESSION_ID, {
      type: 'tool_use_complete',
      toolName: 'Grep',
      toolUseId: 'grep-1',
      input: { pattern: 'needle' },
    })
    store.handleServerMessage(TEST_SESSION_ID, {
      type: 'content_start',
      blockType: 'tool_use',
      toolName: 'Read',
      toolUseId: 'read-1',
    })
    store.handleServerMessage(TEST_SESSION_ID, {
      type: 'tool_use_complete',
      toolName: 'Read',
      toolUseId: 'read-1',
      input: { file_path: '/missing.md' },
    })
    store.handleServerMessage(TEST_SESSION_ID, {
      type: 'tool_result',
      toolUseId: 'read-1',
      content: 'File does not exist',
      isError: true,
    })
    store.handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 0 },
    })

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session).toBeTruthy()
    if (!session) return
    const grep = session.messages.find((message) =>
      message.type === 'tool_use' && message.toolUseId === 'grep-1',
    )
    const read = session.messages.find((message) =>
      message.type === 'tool_use' && message.toolUseId === 'read-1',
    )

    expect(read).toMatchObject({ type: 'tool_use', isPending: false })
    expect(grep).toMatchObject({
      type: 'tool_use',
      isPending: false,
      status: 'stopped',
    })
    expect(session.chatState).toBe('idle')
  })
})

// #1108: a background (async) agent's tool activity bubbles into the main
// message stream carrying parentToolUseId, but MessageList folds those into
// the agent card instead of rendering them inline. Merging streamed blocks
// against the raw array tail therefore chopped one continuous thinking block
// (or reply) into several, with nothing visible in between.
describe('chatStore background agent activity interleaving', () => {
  beforeEach(() => {
    useChatStore.setState({
      ...initialState,
      sessions: { [TEST_SESSION_ID]: makeSession() },
    })
  })

  function startBackgroundAgent(store: ReturnType<typeof useChatStore.getState>) {
    store.handleServerMessage(TEST_SESSION_ID, {
      type: 'tool_use_complete',
      toolName: 'Task',
      toolUseId: 'agent-1',
      input: { description: 'Explore project', run_in_background: true },
    })
  }

  function emitChildToolActivity(store: ReturnType<typeof useChatStore.getState>, id: string) {
    store.handleServerMessage(TEST_SESSION_ID, {
      type: 'tool_use_complete',
      toolName: 'Grep',
      toolUseId: id,
      input: { pattern: 'needle' },
      parentToolUseId: 'agent-1',
    })
    store.handleServerMessage(TEST_SESSION_ID, {
      type: 'tool_result',
      toolUseId: id,
      content: 'match',
      isError: false,
      parentToolUseId: 'agent-1',
    })
  }

  it('keeps one thinking block while a background agent streams tool activity', () => {
    const store = useChatStore.getState()
    startBackgroundAgent(store)

    store.handleServerMessage(TEST_SESSION_ID, { type: 'thinking', text: 'The agents ' })
    emitChildToolActivity(store, 'child-grep-1')
    store.handleServerMessage(TEST_SESSION_ID, { type: 'thinking', text: 'are still running. ' })
    emitChildToolActivity(store, 'child-grep-2')
    store.handleServerMessage(TEST_SESSION_ID, { type: 'thinking', text: 'Let me wait a bit.' })

    const messages = useChatStore.getState().sessions[TEST_SESSION_ID]?.messages ?? []
    const thinking = messages.filter((message) => message.type === 'thinking')
    expect(thinking).toHaveLength(1)
    expect(thinking[0]).toMatchObject({
      content: 'The agents are still running. Let me wait a bit.',
    })
  })

  it('keeps one assistant reply while a background agent streams tool activity', () => {
    const store = useChatStore.getState()
    startBackgroundAgent(store)

    store.handleServerMessage(TEST_SESSION_ID, { type: 'content_start', blockType: 'text' })
    store.handleServerMessage(TEST_SESSION_ID, { type: 'content_delta', text: 'First half. ' })
    store.handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    emitChildToolActivity(store, 'child-grep-3')
    store.handleServerMessage(TEST_SESSION_ID, { type: 'content_start', blockType: 'text' })
    store.handleServerMessage(TEST_SESSION_ID, { type: 'content_delta', text: 'Second half.' })
    store.handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 1 },
    })

    const messages = useChatStore.getState().sessions[TEST_SESSION_ID]?.messages ?? []
    const assistantText = messages.filter((message) => message.type === 'assistant_text')
    expect(assistantText).toHaveLength(1)
    expect(assistantText[0]).toMatchObject({ content: 'First half. Second half.' })
  })

  it('still starts a new thinking block after the main agent runs its own tool', () => {
    const store = useChatStore.getState()

    store.handleServerMessage(TEST_SESSION_ID, { type: 'thinking', text: 'Before the tool.' })
    store.handleServerMessage(TEST_SESSION_ID, {
      type: 'tool_use_complete',
      toolName: 'Read',
      toolUseId: 'read-1',
      input: { file_path: '/a.md' },
    })
    store.handleServerMessage(TEST_SESSION_ID, {
      type: 'tool_result',
      toolUseId: 'read-1',
      content: 'contents',
      isError: false,
    })
    store.handleServerMessage(TEST_SESSION_ID, { type: 'thinking', text: 'After the tool.' })

    const messages = useChatStore.getState().sessions[TEST_SESSION_ID]?.messages ?? []
    const thinking = messages.filter((message) => message.type === 'thinking')
    expect(thinking).toHaveLength(2)
    expect(thinking.map((message) => message.content)).toEqual([
      'Before the tool.',
      'After the tool.',
    ])
  })
})

describe('chatStore history mapping', () => {
  beforeEach(() => {
    sendMock.mockReset()
    getMemberBySessionIdMock.mockReset()
    getMemberBySessionIdMock.mockReturnValue(null)
    sendMessageToMemberMock.mockReset()
    fetchSessionTasksMock.mockReset()
    clearTasksMock.mockReset()
    setTasksFromTodosMock.mockReset()
    markCompletedAndDismissedMock.mockReset()
    resetCompletedTasksMock.mockReset()
    refreshTasksMock.mockReset()
    notifyDesktopMock.mockReset()
    updateTabTitleMock.mockReset()
    updateTabStatusMock.mockReset()
    updateSessionTitleMock.mockReset()
    updateSessionMessageCountMock.mockReset()
    connectionStateHandlers.clear()
    vi.mocked(sessionsApi.getMessages).mockReset()
    vi.mocked(sessionsApi.getMessages).mockResolvedValue({ messages: [] })
    vi.mocked(sessionsApi.getSlashCommands).mockReset()
    vi.mocked(sessionsApi.getSlashCommands).mockResolvedValue({ commands: [] })
    sessionStoreSnapshot.sessions = []
    cliTaskStoreSnapshot.tasks = []
    cliTaskStoreSnapshot.sessionId = null
    useSessionRuntimeStore.setState({ selections: {} })
    localStorage.clear()
    useSettingsStore.setState({ locale: 'en' })
    useChatStore.setState({
      ...initialState,
      sessions: {},
    })
  })

  it('does not prewarm an existing transcript when opening it for history review', () => {
    sessionStoreSnapshot.sessions = [{
      id: TEST_SESSION_ID,
      title: 'Existing transcript',
      createdAt: '2026-06-20T10:00:00.000Z',
      modifiedAt: '2026-06-20T10:30:00.000Z',
      messageCount: 4,
      projectPath: '/workspace/project',
      workDir: '/workspace/project',
      workDirExists: true,
    }]

    useChatStore.getState().connectToSession(TEST_SESSION_ID)

    expect(sendMock).not.toHaveBeenCalledWith(TEST_SESSION_ID, { type: 'prewarm_session' })
  })

  it('still prewarms empty placeholder sessions so new chats start quickly', () => {
    sessionStoreSnapshot.sessions = [{
      id: TEST_SESSION_ID,
      title: 'New Session',
      createdAt: '2026-06-20T10:00:00.000Z',
      modifiedAt: '2026-06-20T10:00:00.000Z',
      messageCount: 0,
      projectPath: '/workspace/project',
      workDir: '/workspace/project',
      workDirExists: true,
    }]

    useChatStore.getState().connectToSession(TEST_SESSION_ID)

    expect(sendMock).toHaveBeenCalledWith(TEST_SESSION_ID, { type: 'prewarm_session' })
  })

  it('preserves thinking blocks when restoring transcript history', () => {
    const messages: MessageEntry[] = [
      {
        id: 'assistant-1',
        type: 'assistant',
        timestamp: '2026-04-06T00:00:00.000Z',
        model: 'opus',
        parentToolUseId: 'agent-1',
        content: [
          { type: 'thinking', thinking: 'internal reasoning' },
          { type: 'text', text: '目录结构分析' },
          { type: 'tool_use', name: 'Read', id: 'tool-1', input: { file_path: 'src/App.tsx' } },
        ],
      },
      {
        id: 'user-1',
        type: 'user',
        timestamp: '2026-04-06T00:00:01.000Z',
        parentToolUseId: 'agent-1',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok', is_error: false },
        ],
      },
    ]

    const mapped = mapHistoryMessagesToUiMessages(messages)

    expect(mapped.map((message) => message.type)).toEqual([
      'thinking',
      'assistant_text',
      'tool_use',
      'tool_result',
    ])
    expect(mapped[2]).toMatchObject({ parentToolUseId: 'agent-1' })
    expect(mapped[3]).toMatchObject({ parentToolUseId: 'agent-1' })
  })

  it('collapses replayed and blank thinking blocks from history mapping', () => {
    const messages: MessageEntry[] = [
      {
        id: 'assistant-snap-1',
        type: 'assistant',
        timestamp: '2026-04-06T00:00:00.000Z',
        content: [{ type: 'thinking', thinking: 'plan the fix' }],
      },
      // 流式快照整块重发：逐字相同，应丢弃
      {
        id: 'assistant-snap-2',
        type: 'assistant',
        timestamp: '2026-04-06T00:00:01.000Z',
        content: [{ type: 'thinking', thinking: 'plan the fix' }],
      },
      // 流式快照前缀增长：应替换为更全的新块而非追加
      {
        id: 'assistant-snap-3',
        type: 'assistant',
        timestamp: '2026-04-06T00:00:02.000Z',
        content: [{ type: 'thinking', thinking: 'plan the fix carefully' }],
      },
      // 纯空白块：不应产生空壳气泡
      {
        id: 'assistant-blank',
        type: 'assistant',
        timestamp: '2026-04-06T00:00:03.000Z',
        content: [{ type: 'thinking', thinking: '   \n  ' }],
      },
      // 相邻但内容无关的思考：合并为一个气泡
      {
        id: 'assistant-more',
        type: 'assistant',
        timestamp: '2026-04-06T00:00:04.000Z',
        content: [{ type: 'thinking', thinking: 'then run tests' }],
      },
      // 被工具打断后的新思考：保持独立
      {
        id: 'assistant-tools',
        type: 'assistant',
        timestamp: '2026-04-06T00:00:05.000Z',
        content: [
          { type: 'tool_use', name: 'Bash', id: 'bash-1', input: { command: 'pwd' } },
        ],
      },
      {
        id: 'assistant-final',
        type: 'assistant',
        timestamp: '2026-04-06T00:00:06.000Z',
        content: [{ type: 'thinking', thinking: 'tests pass' }],
      },
    ]

    const mapped = mapHistoryMessagesToUiMessages(messages)

    expect(mapped.map((message) => message.type)).toEqual(['thinking', 'tool_use', 'thinking'])
    expect(mapped[0]).toMatchObject({
      id: 'assistant-snap-1-block-0',
      // Two finished thoughts merge into one bubble, but they are still two thoughts:
      // the original expectation here was 'carefullythen', which pinned the missing
      // separator as correct rather than reading it as the bug it was.
      content: 'plan the fix carefully\n\nthen run tests',
    })
    expect(mapped[2]).toMatchObject({ id: 'assistant-final-block-0', content: 'tests pass' })
  })

  it('maps AskUserQuestion transcript answers from toolUseResult metadata', () => {
    const messages: MessageEntry[] = [
      {
        id: 'assistant-ask',
        type: 'assistant',
        timestamp: '2026-04-06T00:00:00.000Z',
        content: [
          {
            type: 'tool_use',
            name: 'AskUserQuestion',
            id: 'ask-1',
            input: {
              questions: [
                {
                  question: 'Pick one?',
                  options: [{ label: 'A' }, { label: 'B' }],
                },
              ],
            },
          },
        ],
      },
      {
        id: 'user-answer',
        type: 'tool_result',
        timestamp: '2026-04-06T00:00:01.000Z',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'ask-1',
            content: 'User has answered your questions: "Pick one?"="A". You can now continue with the user\'s answers in mind.',
          },
        ],
        toolUseResult: {
          questions: [
            {
              question: 'Pick one?',
              options: [{ label: 'A' }, { label: 'B' }],
            },
          ],
          answers: { 'Pick one?': 'A' },
        },
      },
    ]

    const mapped = mapHistoryMessagesToUiMessages(messages)

    expect(mapped).toHaveLength(2)
    expect(mapped[1]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'ask-1',
      content: {
        answers: { 'Pick one?': 'A' },
      },
    })
  })

  it('maps compact boundary and summary history without hiding pre-compact messages', () => {
    const messages: MessageEntry[] = [
      {
        id: 'old-user',
        type: 'user',
        content: 'Build the billing import flow',
        timestamp: '2026-05-19T09:59:58.000Z',
      },
      {
        id: 'old-assistant',
        type: 'assistant',
        content: 'Implemented the flow.',
        timestamp: '2026-05-19T09:59:59.000Z',
      },
      {
        id: 'compact-boundary',
        type: 'system',
        content: 'Conversation compacted',
        timestamp: '2026-05-19T10:00:00.000Z',
      },
      {
        id: 'compact-summary',
        type: 'user',
        content: [
          'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.',
          '',
          'Kept the billing import implementation details and next verification steps.',
          '',
          'If you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: /tmp/transcript.jsonl',
        ].join('\n'),
        timestamp: '2026-05-19T10:00:01.000Z',
      },
    ]

    const mapped = mapHistoryMessagesToUiMessages(messages)

    expect(mapped).toHaveLength(3)
    expect(mapped).toMatchObject([
      {
        id: 'old-user',
        type: 'user_text',
        content: 'Build the billing import flow',
      },
      {
        id: 'old-assistant',
        type: 'assistant_text',
        content: 'Implemented the flow.',
      },
      {
        type: 'compact_summary',
        title: 'Context compacted',
        summary: 'Kept the billing import implementation details and next verification steps.',
      },
    ])
  })

  it('drops compact local command stdout after mapping compact history', () => {
    const messages: MessageEntry[] = [
      {
        id: 'compact-summary',
        type: 'user',
        content: [
          'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.',
          '',
          'Kept the billing import implementation details.',
        ].join('\n'),
        timestamp: '2026-05-19T10:00:01.000Z',
      },
      {
        id: 'compact-stdout',
        type: 'user',
        content: '<local-command-stdout>Compacted </local-command-stdout>',
        timestamp: '2026-05-19T10:00:02.000Z',
      },
    ]

    const mapped = mapHistoryMessagesToUiMessages(messages)

    expect(mapped).toHaveLength(1)
    expect(mapped[0]).toMatchObject({
      type: 'compact_summary',
      summary: 'Kept the billing import implementation details.',
    })
  })

  it('restores saved memory system events from transcript history', () => {
    const messages: MessageEntry[] = [
      {
        id: 'memory-1',
        type: 'system',
        timestamp: '2026-04-06T00:00:00.000Z',
        content: {
          subtype: 'memory_saved',
          writtenPaths: ['/Users/test/.claude/projects/example/memory/preferences.md'],
          teamCount: 0,
        },
      },
    ]

    const mapped = mapHistoryMessagesToUiMessages(messages)

    expect(mapped).toMatchObject([
      {
        id: 'memory-1',
        type: 'memory_event',
        event: 'saved',
        files: [
          {
            path: '/Users/test/.claude/projects/example/memory/preferences.md',
            action: 'saved',
          },
        ],
      },
    ])
  })

  it('preserves transcript message ids on natural-language history messages', () => {
    const messages: MessageEntry[] = [
      {
        id: 'transcript-user-1',
        type: 'user',
        timestamp: '2026-04-06T00:00:00.000Z',
        content: '请从这里继续',
      },
      {
        id: 'transcript-assistant-1',
        type: 'assistant',
        timestamp: '2026-04-06T00:00:01.000Z',
        model: 'opus',
        content: [
          { type: 'text', text: '这里是答复。' },
          { type: 'tool_use', name: 'Read', id: 'tool-1', input: { file_path: 'src/App.tsx' } },
        ],
      },
    ]

    const mapped = mapHistoryMessagesToUiMessages(messages)

    expect(mapped).toMatchObject([
      {
        id: 'transcript-user-1',
        type: 'user_text',
        transcriptMessageId: 'transcript-user-1',
      },
      {
        type: 'assistant_text',
        transcriptMessageId: 'transcript-assistant-1',
      },
      {
        type: 'tool_use',
      },
    ])
  })

  it('keeps transcript block ids stable across repeated history mapping', () => {
    const messages: MessageEntry[] = [
      {
        id: 'assistant-tools-1',
        type: 'tool_use',
        timestamp: '2026-04-06T00:00:00.000Z',
        content: [
          { type: 'thinking', thinking: 'Inspecting the workspace' },
          { type: 'tool_use', name: 'Bash', id: 'bash-1', input: { command: 'pwd' } },
          { type: 'tool_use', name: 'Glob', id: 'glob-1', input: { pattern: '*' } },
        ],
      },
      {
        id: 'user-tool-results-1',
        type: 'tool_result',
        timestamp: '2026-04-06T00:00:01.000Z',
        content: [
          { type: 'tool_result', tool_use_id: 'bash-1', content: '/workspace', is_error: false },
          { type: 'tool_result', tool_use_id: 'glob-1', content: 'src', is_error: false },
        ],
      },
    ]

    const firstIds = mapHistoryMessagesToUiMessages(messages).map((message) => message.id)
    const secondIds = mapHistoryMessagesToUiMessages(messages).map((message) => message.id)

    expect(secondIds).toEqual(firstIds)
    expect(firstIds).toEqual([
      'assistant-tools-1-block-0',
      'assistant-tools-1-block-1',
      'assistant-tools-1-block-2',
      'user-tool-results-1-block-0',
      'user-tool-results-1-block-1',
    ])
  })

  it('restores slash-command metadata as readable history while skipping malformed breadcrumbs', () => {
    const messages: MessageEntry[] = [
      {
        id: 'agent-command-string',
        type: 'user',
        timestamp: '2026-06-15T03:32:13.000Z',
        content: [
          '<command-message>agent</command-message>',
          '<command-name>/agent</command-name>',
          '<command-args>Plan 222</command-args>',
        ].join('\n'),
      },
      {
        id: 'agent-command-array',
        type: 'user',
        timestamp: '2026-06-15T03:32:14.000Z',
        content: [
          {
            type: 'text',
            text: [
              '<command-message>agent</command-message>',
              '<command-name>/agent</command-name>',
              '<command-args>Plan 333</command-args>',
            ].join('\n'),
          },
        ],
      },
      {
        id: 'malformed-command',
        type: 'user',
        timestamp: '2026-06-15T03:32:14.500Z',
        content: '<command-name>/agent</command-name> malformed breadcrumb',
      },
      {
        id: 'transcript-user-1',
        type: 'user',
        timestamp: '2026-06-15T03:32:15.000Z',
        content: '继续处理这个问题',
      },
    ]

    expect(mapHistoryMessagesToUiMessages(messages)).toMatchObject([
      {
        id: 'agent-command-string',
        type: 'user_text',
        content: '/agent Plan 222',
      },
      {
        id: 'agent-command-array',
        type: 'user_text',
        content: '/agent Plan 333',
      },
      {
        id: 'transcript-user-1',
        type: 'user_text',
        content: '继续处理这个问题',
      },
    ])
  })

  it('restores user-invoked skill command metadata as readable user history', () => {
    const messages: MessageEntry[] = [
      {
        id: 'skill-command-user',
        type: 'user',
        timestamp: '2026-06-26T14:59:44.000Z',
        content: [
          '<command-message>frontend-design</command-message>',
          '<command-name>/frontend-design</command-name>',
          '<command-args>redesign the settings page</command-args>',
        ].join('\n'),
      },
    ]

    const mapped = mapHistoryMessagesToUiMessages(messages)

    expect(mapped).toMatchObject([
      {
        id: 'skill-command-user',
        type: 'user_text',
        content: '/frontend-design redesign the settings page',
        transcriptMessageId: 'skill-command-user',
      },
    ])
    expect(mapped[0]?.type === 'user_text' ? mapped[0].content : '').not.toContain('<command-message>')
  })

  it('restores persisted image user messages as renderable attachments without exposing image metadata text', () => {
    const messages: MessageEntry[] = [
      {
        id: 'image-user-1',
        type: 'user',
        timestamp: '2026-06-04T08:07:15.803Z',
        content: [
          { type: 'text', text: '解释一下这张图片讲了什么东西' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: 'JPEGBASE64',
            },
          },
          {
            type: 'text',
            text: '[Image source: /Users/test/.claude/uploads/session-1/pasted-image.jpeg]',
          },
        ],
      },
    ]

    const mapped = mapHistoryMessagesToUiMessages(messages)

    expect(mapped).toMatchObject([
      {
        id: 'image-user-1',
        type: 'user_text',
        content: '解释一下这张图片讲了什么东西',
        modelContent: [
          '解释一下这张图片讲了什么东西',
          '[Image source: /Users/test/.claude/uploads/session-1/pasted-image.jpeg]',
        ].join('\n'),
        attachments: [{
          type: 'image',
          name: 'pasted-image.jpeg',
          path: '/Users/test/.claude/uploads/session-1/pasted-image.jpeg',
          data: 'data:image/jpeg;base64,JPEGBASE64',
          mimeType: 'image/jpeg',
        }],
      },
    ])
  })

  it('restores multiple persisted images with their matching source paths in order', () => {
    const mapped = mapHistoryMessagesToUiMessages([
      {
        id: 'multi-image-user-1',
        type: 'user',
        timestamp: '2026-06-04T08:07:15.803Z',
        content: [
          { type: 'text', text: '对比这两张图' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: 'FIRSTJPEG',
            },
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'SECONDPNG',
            },
          },
          {
            type: 'text',
            text: '[Image source: /Users/test/.claude/uploads/session-1/first-pasted-image.jpeg]',
          },
          {
            type: 'text',
            text: '[Image source: /Users/test/.claude/uploads/session-1/second-pasted-image.png]',
          },
        ],
      },
    ])

    expect(mapped).toMatchObject([
      {
        id: 'multi-image-user-1',
        type: 'user_text',
        content: '对比这两张图',
        attachments: [
          {
            type: 'image',
            name: 'first-pasted-image.jpeg',
            path: '/Users/test/.claude/uploads/session-1/first-pasted-image.jpeg',
            data: 'data:image/jpeg;base64,FIRSTJPEG',
            mimeType: 'image/jpeg',
          },
          {
            type: 'image',
            name: 'second-pasted-image.png',
            path: '/Users/test/.claude/uploads/session-1/second-pasted-image.png',
            data: 'data:image/png;base64,SECONDPNG',
            mimeType: 'image/png',
          },
        ],
      },
    ])
  })

  it('keeps image-looking text visible when history has no image block', () => {
    const mapped = mapHistoryMessagesToUiMessages([
      {
        id: 'plain-text-user-1',
        type: 'user',
        timestamp: '2026-06-04T08:07:15.803Z',
        content: [
          { type: 'text', text: '[Image source: /tmp/example.png]' },
        ],
      },
    ])

    expect(mapped).toMatchObject([
      {
        id: 'plain-text-user-1',
        type: 'user_text',
        content: '[Image source: /tmp/example.png]',
      },
    ])
  })

  it('restores visual selection history as annotated screenshot attachment without exposing model prompt', () => {
    const modelPrompt = [
      '请根据截图中编号 1 的蓝色标注修改本地前端。',
      '目标元素：<time>',
      'Selector：#root > main > section > ol > li:nth-of-type(1) > article > div:nth-of-type(1) > time',
      'DOM 路径：body:nth-child(2) > div:nth-child(1) > main:nth-child(1) > section:nth-child(1) > ol:nth-child(4) > li:nth-child(1) > article:nth-child(1) > div:nth-child(3) > time:nth-child(2)',
      '页面标题：Todo Desk Board',
      '页面 URL：http://127.0.0.1:47931/',
      '当前文本：06/10 21:12',
      '用户注释：',
      '这里的时间加上年份',
      '请优先依据截图里的编号标注定位元素，selector 只作为辅助线索。',
    ].join('\n')

    const mapped = mapHistoryMessagesToUiMessages([
      {
        id: 'selection-user-1',
        type: 'user',
        timestamp: '2026-06-10T16:20:00.000Z',
        content: [
          { type: 'text', text: modelPrompt },
          {
            type: 'image',
            source: {
              media_type: 'image/png',
              data: 'SELECTIONPNG',
            },
          },
        ],
      } as MessageEntry,
    ])

    expect(mapped).toMatchObject([
      {
        id: 'selection-user-1',
        type: 'user_text',
        content: '',
        modelContent: modelPrompt,
        attachments: [{
          type: 'image',
          name: '<time>',
          data: 'data:image/png;base64,SELECTIONPNG',
          mimeType: 'image/png',
          note: '这里的时间加上年份',
          quote: '#root > main > section > ol > li:nth-of-type(1) > article > div:nth-of-type(1) > time',
        }],
      },
    ])
  })

  it('restores a batch selection as one numbered screenshot group with a compact summary', () => {
    const modelPrompt = [
      '请一次性处理以下批量标注的本地前端修改。每张截图中的蓝色编号与下方元素编号一一对应。',
      '',
      '[元素 1]',
      '目标元素：<h1>',
      'Selector：#title',
      '用户注释：',
      '标题更轻一点',
      '[元素 1 结束]',
      '',
      '[元素 3]',
      '目标元素：<button>',
      'Selector：#cta',
      '用户注释：',
      '按钮更醒目',
      '[元素 3 结束]',
      '',
      '请优先依据截图里的编号标注定位元素，selector 只作为辅助线索。',
    ].join('\n')

    const mapped = mapHistoryMessagesToUiMessages([{
      id: 'selection-batch-user-1',
      type: 'user',
      timestamp: '2026-06-10T16:20:00.000Z',
      content: [
        { type: 'text', text: modelPrompt },
        { type: 'image', source: { media_type: 'image/png', data: 'FIRSTPNG' } },
        { type: 'image', source: { media_type: 'image/png', data: 'THIRDPNG' } },
      ],
    } as MessageEntry])

    expect(mapped).toMatchObject([{
      id: 'selection-batch-user-1',
      type: 'user_text',
      content: '2 page changes',
      modelContent: modelPrompt,
      attachments: [
        { type: 'image', name: '<h1>', note: '标题更轻一点', quote: '#title', selectionNumber: 1 },
        { type: 'image', name: '<button>', note: '按钮更醒目', quote: '#cta', selectionNumber: 3 },
      ],
    }])
  })

  it('restores /goal local command output from transcript history', () => {
    const messages: MessageEntry[] = [
      {
        id: 'goal-command',
        type: 'system',
        timestamp: '2026-04-06T00:00:00.000Z',
        content: '<command-name>/goal</command-name>\n<command-args>ship the smoke test</command-args>',
      },
      {
        id: 'goal-output',
        type: 'system',
        timestamp: '2026-04-06T00:00:01.000Z',
        content: '<local-command-stdout>Goal set: ship the smoke test</local-command-stdout>',
      },
    ]

    expect(mapHistoryMessagesToUiMessages(messages)).toMatchObject([
      {
        id: 'goal-command',
        type: 'user_text',
        content: '/goal ship the smoke test',
      },
      {
        id: 'goal-output',
        type: 'goal_event',
        action: 'created',
        status: 'active',
        objective: 'ship the smoke test',
      },
    ])
  })

  it('restores repeated /goal set output as the current created event', () => {
    const messages: MessageEntry[] = [
      {
        id: 'goal-command',
        type: 'system',
        timestamp: '2026-04-06T00:00:00.000Z',
        content: '<command-name>/goal</command-name>\n<command-args>ship the replacement target</command-args>',
      },
      {
        id: 'goal-output',
        type: 'system',
        timestamp: '2026-04-06T00:00:01.000Z',
        content: '<local-command-stdout>Goal set: ship the replacement target</local-command-stdout>',
      },
    ]

    expect(mapHistoryMessagesToUiMessages(messages)).toMatchObject([
      {
        id: 'goal-command',
        type: 'user_text',
        content: '/goal ship the replacement target',
      },
      {
        id: 'goal-output',
        type: 'goal_event',
        action: 'created',
        status: 'active',
        objective: 'ship the replacement target',
      },
    ])
  })

  it('restores /goal continuation markers from transcript history', () => {
    const messages: MessageEntry[] = [
      {
        id: 'goal-continuing',
        type: 'system',
        timestamp: '2026-04-06T00:00:02.000Z',
        content: '<local-command-stdout>Goal continuing: verify the release path</local-command-stdout>',
      },
    ]

    expect(mapHistoryMessagesToUiMessages(messages)).toMatchObject([
      {
        id: 'goal-continuing',
        type: 'goal_event',
        action: 'status',
        status: 'continuing',
        message: 'Goal continuing: verify the release path',
      },
    ])
  })

  it('restores completed /goal state from transcript history after app restart', async () => {
    vi.mocked(sessionsApi.getMessages).mockResolvedValueOnce({
      messages: [
        {
          id: 'goal-command',
          type: 'system',
          timestamp: '2026-04-06T00:00:00.000Z',
          content: '<command-name>/goal</command-name>\n<command-args>ship the smoke test</command-args>',
        },
        {
          id: 'goal-output',
          type: 'system',
          timestamp: '2026-04-06T00:00:01.000Z',
          content: '<local-command-stdout>Goal set: ship the smoke test</local-command-stdout>',
        },
        {
          id: 'goal-complete',
          type: 'system',
          timestamp: '2026-04-06T00:00:02.000Z',
          content: '<local-command-stdout>Goal marked complete.</local-command-stdout>',
        },
      ],
    })

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({ messages: [] }),
      },
    })

    await useChatStore.getState().loadHistory(TEST_SESSION_ID)

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      {
        id: 'goal-command',
        type: 'user_text',
        content: '/goal ship the smoke test',
      },
      {
        id: 'goal-output',
        type: 'goal_event',
        action: 'created',
        objective: 'ship the smoke test',
      },
      {
        id: 'goal-complete',
        type: 'goal_event',
        action: 'completed',
        message: 'Goal marked complete.',
      },
    ])
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.activeGoal).toMatchObject({
      action: 'completed',
      status: 'complete',
      objective: 'ship the smoke test',
    })
  })

  it('restores token usage from transcript history after reopening a session', async () => {
    vi.mocked(sessionsApi.getMessages).mockResolvedValueOnce({
      messages: [
        {
          id: 'user-1',
          type: 'user',
          timestamp: '2026-04-06T00:00:00.000Z',
          content: 'build the docs',
        },
        {
          id: 'assistant-1',
          type: 'assistant',
          timestamp: '2026-04-06T00:00:01.000Z',
          content: 'done',
          usage: { input_tokens: 1200, output_tokens: 80 },
        },
        {
          id: 'assistant-2',
          type: 'assistant',
          timestamp: '2026-04-06T00:00:02.000Z',
          content: [{ type: 'text', text: 'follow-up done' }],
          usage: { input_tokens: 3400, output_tokens: 120 },
        },
      ],
    })

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          messages: [],
          tokenUsage: { input_tokens: 0, output_tokens: 0 },
        }),
      },
    })

    await useChatStore.getState().loadHistory(TEST_SESSION_ID)

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.tokenUsage).toEqual({
      input_tokens: 4600,
      output_tokens: 200,
    })
  })

  it('uses transcript terminal events to repair stale live goal and background task state', async () => {
    vi.mocked(sessionsApi.getMessages).mockResolvedValueOnce({
      messages: [
        {
          id: 'goal-command',
          type: 'system',
          timestamp: '2026-04-06T00:00:00.000Z',
          content: '<command-name>/goal</command-name>\n<command-args>ship the smoke test</command-args>',
        },
        {
          id: 'goal-output',
          type: 'system',
          timestamp: '2026-04-06T00:00:01.000Z',
          content: '<local-command-stdout>Goal set: ship the smoke test</local-command-stdout>',
        },
        {
          id: 'goal-complete',
          type: 'system',
          timestamp: '2026-04-06T00:00:02.000Z',
          content: '<local-command-stdout>Goal marked complete.</local-command-stdout>',
        },
      ],
      taskNotifications: [
        {
          taskId: 'agent-task-1',
          toolUseId: 'agent-tool-1',
          status: 'completed',
          summary: 'Agent completed',
          timestamp: '2026-04-06T00:00:03.000Z',
        },
      ],
    })

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          messages: [{ id: 'visible-message', type: 'assistant_text', content: 'already rendered', timestamp: 1 }],
          activeGoal: {
            action: 'created',
            status: 'active',
            objective: 'ship the smoke test',
            updatedAt: 1,
          },
          backgroundAgentTasks: {
            'agent-tool-1': {
              taskId: 'agent-tool-1',
              toolUseId: 'agent-tool-1',
              status: 'running',
              taskType: 'local_agent',
              description: 'Review app',
              startedAt: 1,
              updatedAt: 2,
            },
          },
        }),
      },
    })

    await useChatStore.getState().loadHistory(TEST_SESSION_ID)

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.messages).toMatchObject([
      { id: 'visible-message', type: 'assistant_text', content: 'already rendered' },
      {
        id: 'goal-complete',
        type: 'goal_event',
        action: 'completed',
        message: 'Goal marked complete.',
      },
    ])
    expect(session?.activeGoal).toMatchObject({
      action: 'completed',
      status: 'complete',
      objective: 'ship the smoke test',
    })
    expect(session?.backgroundAgentTasks?.['agent-tool-1']).toBeUndefined()
    expect(session?.backgroundAgentTasks?.['agent-task-1']).toMatchObject({
      taskId: 'agent-task-1',
      toolUseId: 'agent-tool-1',
      status: 'completed',
      description: 'Review app',
      summary: 'Agent completed',
    })
  })

  function mockRestoredSubagentActivity() {
    vi.mocked(sessionsApi.getMessages).mockResolvedValueOnce({
      messages: [
        {
          id: 'restored-child-use',
          type: 'assistant',
          timestamp: '2026-08-02T10:22:48.000Z',
          parentToolUseId: 'agent-parent',
          content: [{
            type: 'tool_use',
            id: 'agent-parent/agent-a500/call-child',
            original_tool_use_id: 'call-child',
            name: 'Grep',
            input: { pattern: 'needle' },
          }],
        },
        {
          id: 'restored-child-result',
          type: 'user',
          timestamp: '2026-08-02T10:22:49.000Z',
          parentToolUseId: 'agent-parent',
          content: [{
            type: 'tool_result',
            tool_use_id: 'agent-parent/agent-a500/call-child',
            original_tool_use_id: 'call-child',
            content: 'match',
          }],
        },
      ],
    })
  }

  it('backfills a synchronous subagent tool call missing from the live stream', async () => {
    mockRestoredSubagentActivity()
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          messages: [
            {
              id: 'live-agent',
              type: 'tool_use',
              toolName: 'Agent',
              toolUseId: 'agent-parent',
              input: { description: 'Review code' },
              timestamp: 1,
            },
            {
              id: 'live-orphan-result',
              type: 'tool_result',
              toolUseId: 'agent-parent/call-child',
              originalToolUseId: 'call-child',
              content: 'match',
              isError: false,
              parentToolUseId: 'agent-parent',
              timestamp: 2,
            },
          ],
        }),
      },
    })

    await useChatStore.getState().loadHistory(TEST_SESSION_ID)

    const messages = useChatStore.getState().sessions[TEST_SESSION_ID]?.messages ?? []
    const childUses = messages.filter((message) =>
      message.type === 'tool_use' && message.parentToolUseId === 'agent-parent')
    const childResults = messages.filter((message) =>
      message.type === 'tool_result' && message.parentToolUseId === 'agent-parent')
    expect(childUses).toHaveLength(1)
    expect(childUses[0]).toMatchObject({
      toolName: 'Grep',
      toolUseId: 'agent-parent/call-child',
    })
    expect(childResults).toHaveLength(1)
    expect(childResults[0]).toMatchObject({ toolUseId: 'agent-parent/call-child' })
    expect(messages.indexOf(childUses[0]!)).toBeLessThan(
      messages.indexOf(childResults[0]!),
    )
  })

  it('does not duplicate complete live subagent activity during history hydration', async () => {
    mockRestoredSubagentActivity()
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          messages: [
            {
              id: 'live-agent',
              type: 'tool_use',
              toolName: 'Agent',
              toolUseId: 'agent-parent',
              input: { description: 'Review code' },
              timestamp: 1,
            },
            {
              id: 'live-child-use',
              type: 'tool_use',
              toolName: 'Grep',
              toolUseId: 'agent-parent/call-child',
              originalToolUseId: 'call-child',
              input: { pattern: 'needle' },
              parentToolUseId: 'agent-parent',
              timestamp: 2,
            },
            {
              id: 'live-child-result',
              type: 'tool_result',
              toolUseId: 'agent-parent/call-child',
              originalToolUseId: 'call-child',
              content: 'match',
              isError: false,
              parentToolUseId: 'agent-parent',
              timestamp: 3,
            },
          ],
        }),
      },
    })

    await useChatStore.getState().loadHistory(TEST_SESSION_ID)

    const messages = useChatStore.getState().sessions[TEST_SESSION_ID]?.messages ?? []
    expect(messages.filter((message) =>
      message.type === 'tool_use' && message.parentToolUseId === 'agent-parent')).toHaveLength(1)
    expect(messages.filter((message) =>
      message.type === 'tool_result' && message.parentToolUseId === 'agent-parent')).toHaveLength(1)
  })

  it('hydrates transcript ids for a just-completed live turn', async () => {
    vi.mocked(sessionsApi.getMessages).mockResolvedValueOnce({
      messages: [
        {
          id: 'transcript-user-1',
          type: 'user',
          timestamp: '2026-04-06T00:00:00.000Z',
          content: 'live prompt',
        },
        {
          id: 'transcript-assistant-1',
          type: 'assistant',
          timestamp: '2026-04-06T00:00:01.000Z',
          content: 'live answer',
        },
      ],
    })

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          messages: [
            {
              id: 'live-user',
              type: 'user_text',
              content: 'live prompt',
              timestamp: 1,
            },
          ],
          streamingText: 'live answer',
          chatState: 'streaming',
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 2 },
    })

    await vi.waitFor(() => {
      expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
        {
          type: 'user_text',
          transcriptMessageId: 'transcript-user-1',
        },
        {
          type: 'assistant_text',
          transcriptMessageId: 'transcript-assistant-1',
        },
      ])
    })
  })

  it('does not duplicate a hydrated assistant reply when live output replays after reconnect', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          messages: [
            {
              id: 'live-user',
              type: 'user_text',
              content: 'live prompt',
              transcriptMessageId: 'transcript-user-1',
              timestamp: 1,
            },
            {
              id: 'live-assistant',
              type: 'assistant_text',
              content: 'live answer',
              transcriptMessageId: 'transcript-assistant-1',
              timestamp: 2,
            },
          ],
          streamingText: 'live answer',
          chatState: 'streaming',
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 2 },
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      {
        id: 'live-user',
        type: 'user_text',
        transcriptMessageId: 'transcript-user-1',
      },
      {
        id: 'live-assistant',
        type: 'assistant_text',
        content: 'live answer',
        transcriptMessageId: 'transcript-assistant-1',
      },
    ])
    expect(notifyDesktopMock).not.toHaveBeenCalled()
  })

  // Both directions of the thinking merge, because one `thinking` message carries two
  // granularities: handler.ts:2956 forwards a `thinking_delta` fragment, handler.ts:2787
  // forwards a finished block. Concatenating the first is required; concatenating the
  // second glued words together on screen.
  describe('thinking blocks merge by granularity, not by content', () => {
    it('concatenates stream fragments with nothing between them', () => {
      useChatStore.setState({ sessions: { [TEST_SESSION_ID]: makeSession({}) } })
      const store = useChatStore.getState()
      store.handleServerMessage(TEST_SESSION_ID, { type: 'thinking', text: 'plan the ' })
      store.handleServerMessage(TEST_SESSION_ID, { type: 'thinking', text: 'fix' })

      const thinking = useChatStore.getState().sessions[TEST_SESSION_ID]?.messages
        .filter((message) => message.type === 'thinking')
      expect(thinking).toHaveLength(1)
      expect(thinking?.[0]).toMatchObject({ content: 'plan the fix' })
    })

    it('separates two finished blocks so their words do not run together', () => {
      useChatStore.setState({ sessions: { [TEST_SESSION_ID]: makeSession({}) } })
      const store = useChatStore.getState()
      store.handleServerMessage(TEST_SESSION_ID, { type: 'thinking', text: 'plan the fix carefully', complete: true })
      store.handleServerMessage(TEST_SESSION_ID, { type: 'thinking', text: 'then run tests', complete: true })

      const thinking = useChatStore.getState().sessions[TEST_SESSION_ID]?.messages
        .filter((message) => message.type === 'thinking')
      expect(thinking).toHaveLength(1)
      expect(thinking?.[0]).toMatchObject({ content: 'plan the fix carefully\n\nthen run tests' })
      expect(thinking?.[0]?.content).not.toContain('carefullythen')
    })
  })

  // The bug this guard causes, as a test rather than a commit message. A turn can
  // legitimately produce the same short text twice — "Done.", "好的", a one-line
  // command result — and a mid-turn loadHistory back-fills a transcriptMessageId onto
  // the first one by exact content match (mergeRestoredTranscriptMessageIds). The
  // second then looks identical to a replay and is dropped at message_complete, with
  // no recovery: appendedCompletionMessage stays false so the notification is skipped,
  // and loadHistory's live-merge branch can annotate and filter but never re-add.
  //
  // d39e82b62 tried to fix this by bounding the scan to the current turn and was
  // reverted in 3a630db11: it still dropped same-turn repeats and disarmed the guard
  // whenever a user_text sat at the tail. Content equality cannot separate a replay
  // from a repeat at all — the distinguishing signal is identity, which the server
  // already computes and does not forward.
  it('keeps a reply the agent genuinely produced twice in one turn', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          messages: [
            { id: 'u1', type: 'user_text', content: 'rename it then delete the backup', timestamp: 1 },
            {
              id: 'a1',
              type: 'assistant_text',
              content: 'Done.',
              timestamp: 2,
              transcriptMessageId: 'transcript-a1',
            },
            { id: 't1', type: 'tool_use', toolName: 'Bash', toolUseId: 'tool-1', input: {}, timestamp: 3 },
          ],
          streamingText: 'Done.',
          chatState: 'streaming',
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 2 },
    })

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    const replies = session?.messages.filter(
      (message) => message.type === 'assistant_text' && message.content.trim() === 'Done.',
    )
    expect(replies).toHaveLength(2)
    expect(session?.streamingText).toBe('')
  })

  // Same reconnect replay as above, one block type over. A thinking UIMessage
  // carries no transcriptMessageId (types/chat.ts:291), so neither the
  // appendAssistantTextMessage guard nor dropDuplicateTranscriptTextMessages
  // can reach it — a replayed thinking block has nothing identifying it.
  it('does not duplicate a hydrated thinking block when live output replays after reconnect', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'idle',
          messages: [
            {
              id: 'live-user',
              type: 'user_text',
              content: 'live prompt',
              transcriptMessageId: 'transcript-user-1',
              timestamp: 1,
            },
            { id: 'live-thinking', type: 'thinking', content: 'weighing the options', timestamp: 2 },
            {
              id: 'live-assistant',
              type: 'assistant_text',
              content: 'live answer',
              transcriptMessageId: 'transcript-assistant-1',
              timestamp: 3,
            },
          ],
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'thinking',
      text: 'weighing the options',
    })

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.messages).toMatchObject([
      { id: 'live-user', type: 'user_text' },
      { id: 'live-thinking', type: 'thinking', content: 'weighing the options' },
      { id: 'live-assistant', type: 'assistant_text', content: 'live answer' },
    ])
    if (session?.elapsedTimer) clearInterval(session.elapsedTimer)
  })

  it('collapses duplicate assistant replies after transcript id hydration', async () => {
    vi.mocked(sessionsApi.getMessages).mockResolvedValueOnce({
      messages: [
        {
          id: 'transcript-user-1',
          type: 'user',
          timestamp: '2026-04-06T00:00:00.000Z',
          content: 'live prompt',
        },
        {
          id: 'transcript-assistant-1',
          type: 'assistant',
          timestamp: '2026-04-06T00:00:01.000Z',
          content: 'live answer',
        },
      ],
    })

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          messages: [
            {
              id: 'live-user',
              type: 'user_text',
              content: 'live prompt',
              transcriptMessageId: 'transcript-user-1',
              timestamp: 1,
            },
            {
              id: 'live-assistant',
              type: 'assistant_text',
              content: 'live answer',
              transcriptMessageId: 'transcript-assistant-1',
              timestamp: 2,
            },
            {
              id: 'replayed-assistant',
              type: 'assistant_text',
              content: 'live answer',
              timestamp: 3,
            },
          ],
        }),
      },
    })

    await useChatStore.getState().loadHistory(TEST_SESSION_ID)

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      {
        id: 'live-user',
        type: 'user_text',
        transcriptMessageId: 'transcript-user-1',
      },
      {
        id: 'live-assistant',
        type: 'assistant_text',
        content: 'live answer',
        transcriptMessageId: 'transcript-assistant-1',
      },
    ])
  })

  it('retries transcript id hydration after the assistant message is persisted', async () => {
    vi.useFakeTimers()
    vi.mocked(sessionsApi.getMessages)
      .mockResolvedValueOnce({
        messages: [
          {
            id: 'transcript-user-1',
            type: 'user',
            timestamp: '2026-04-06T00:00:00.000Z',
            content: 'live prompt',
          },
        ],
      })
      .mockResolvedValueOnce({
        messages: [
          {
            id: 'transcript-user-1',
            type: 'user',
            timestamp: '2026-04-06T00:00:00.000Z',
            content: 'live prompt',
          },
          {
            id: 'transcript-assistant-1',
            type: 'assistant',
            timestamp: '2026-04-06T00:00:01.000Z',
            content: 'live answer',
          },
        ],
      })

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          messages: [
            {
              id: 'live-user',
              type: 'user_text',
              content: 'live prompt',
              timestamp: 1,
            },
          ],
          streamingText: 'live answer',
          chatState: 'streaming',
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 2 },
    })

    await Promise.resolve()
    await Promise.resolve()

    expect(sessionsApi.getMessages).toHaveBeenCalledTimes(1)
    const firstHydrationMessages = useChatStore.getState().sessions[TEST_SESSION_ID]?.messages ?? []
    expect(firstHydrationMessages[0]).toMatchObject({
      type: 'user_text',
      transcriptMessageId: 'transcript-user-1',
    })
    expect(firstHydrationMessages[1]).toMatchObject({
      type: 'assistant_text',
    })
    expect(firstHydrationMessages[1]).not.toHaveProperty('transcriptMessageId')

    await vi.advanceTimersByTimeAsync(750)

    expect(sessionsApi.getMessages).toHaveBeenCalledTimes(2)
    const secondHydrationMessages = useChatStore.getState().sessions[TEST_SESSION_ID]?.messages ?? []
    expect(secondHydrationMessages[0]).toMatchObject({
      type: 'user_text',
      transcriptMessageId: 'transcript-user-1',
    })
    expect(secondHydrationMessages[1]).toMatchObject({
      type: 'assistant_text',
      transcriptMessageId: 'transcript-assistant-1',
    })

    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('merges consecutive assistant text blocks when restoring transcript history', () => {
    const messages: MessageEntry[] = [
      {
        id: 'assistant-merge-1',
        type: 'assistant',
        timestamp: '2026-04-06T00:00:00.000Z',
        model: 'opus',
        content: [
          { type: 'text', text: '第一段：Windows 下的桌面端输出。' },
          { type: 'text', text: '\r\n第二段：刷新后也不应该被拆开。' },
        ],
      },
    ]

    const mapped = mapHistoryMessagesToUiMessages(messages)

    expect(mapped).toMatchObject([
      {
        type: 'assistant_text',
        content: '第一段：Windows 下的桌面端输出。\r\n第二段：刷新后也不应该被拆开。',
      },
    ])
  })

  it('skips whitespace-only assistant transcript messages', () => {
    const messages: MessageEntry[] = [
      {
        id: 'assistant-empty',
        type: 'assistant',
        timestamp: '2026-04-06T00:00:00.000Z',
        model: 'opus',
        content: '\n\n  ',
      },
      {
        id: 'assistant-real',
        type: 'assistant',
        timestamp: '2026-04-06T00:00:01.000Z',
        model: 'opus',
        content: '可见回复',
      },
    ]

    const mapped = mapHistoryMessagesToUiMessages(messages)

    expect(mapped).toMatchObject([
      {
        id: 'assistant-real',
        type: 'assistant_text',
        content: '可见回复',
      },
    ])
  })

  it('filters task-notification turns and resumes at the next real user message', () => {
    const messages: MessageEntry[] = [
      {
        id: 'user-real-1',
        type: 'user',
        timestamp: '2026-04-06T00:00:00.000Z',
        content: '创建项目',
      },
      {
        id: 'assistant-real-1',
        type: 'assistant',
        timestamp: '2026-04-06T00:00:01.000Z',
        content: [{ type: 'text', text: '项目创建好了' }],
      },
      {
        id: 'task-notification',
        type: 'user',
        timestamp: '2026-04-06T00:00:02.000Z',
        content: '<task-notification>\n<task-id>bg-1</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n<summary>Background command completed</summary>\n</task-notification>',
      },
      {
        id: 'assistant-task-response',
        type: 'assistant',
        timestamp: '2026-04-06T00:00:03.000Z',
        content: [{ type: 'text', text: '旧后台任务通知，无需处理' }],
      },
      {
        id: 'user-real-2',
        type: 'user',
        timestamp: '2026-04-06T00:00:04.000Z',
        content: '继续真实问题',
      },
    ]

    const mapped = mapHistoryMessagesToUiMessages(messages)

    expect(mapped).toMatchObject([
      {
        id: 'user-real-1',
        type: 'user_text',
        content: '创建项目',
      },
      {
        type: 'assistant_text',
        content: '项目创建好了',
      },
      {
        id: 'user-real-2',
        type: 'user_text',
        content: '继续真实问题',
      },
    ])
    expect(JSON.stringify(mapped)).not.toContain('<task-notification>')
    expect(JSON.stringify(mapped)).not.toContain('旧后台任务通知')
  })

  it('reconstructs task notifications from transcript XML before filtering it from UI', () => {
    const restored = reconstructAgentNotifications([
      {
        id: 'task-notification',
        type: 'user',
        timestamp: '2026-04-06T00:00:00.000Z',
        content: '<task-notification>\n<task-id>bg-1</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n<summary>Background command &amp; agent done</summary>\n<result>Detailed result &amp; next step</result>\n<output-file>C:\\Temp\\bg.output</output-file>\n</task-notification>',
      },
    ])

    expect(restored).toEqual({
      toolu_bg: {
        taskId: 'bg-1',
        toolUseId: 'toolu_bg',
        status: 'completed',
        summary: 'Background command & agent done',
        result: 'Detailed result & next step',
        outputFile: 'C:\\Temp\\bg.output',
      },
    })
  })

  it('surfaces teammate prompt content when mapping member transcript history', () => {
    const messages: MessageEntry[] = [
      {
        id: 'user-1',
        type: 'user',
        timestamp: '2026-04-06T00:00:00.000Z',
        content: '<teammate-message teammate_id="security-reviewer">Review the auth diff and call out risks.</teammate-message>',
      },
    ]

    const mapped = mapHistoryMessagesToUiMessages(messages, {
      includeTeammateMessages: true,
    })

    expect(mapped).toMatchObject([
      {
        type: 'user_text',
        content: 'Review the auth diff and call out risks.',
      },
    ])
  })

  it('preserves source user ids when restoring array-content user prompts', () => {
    const messages: MessageEntry[] = [
      {
        id: 'user-with-attachment',
        type: 'user',
        timestamp: '2026-04-06T00:00:00.000Z',
        content: [
          { type: 'text', text: '请看这个文件' },
          { type: 'file', name: 'report.md' },
        ],
      },
    ]

    const mapped = mapHistoryMessagesToUiMessages(messages)

    expect(mapped).toMatchObject([
      {
        id: 'user-with-attachment',
        type: 'user_text',
        content: '请看这个文件',
        attachments: [{ type: 'file', name: 'report.md' }],
      },
    ])
  })

  it('restores CLI file mentions as visible attachment chips from transcript history', () => {
    const messages: MessageEntry[] = [
      {
        id: 'user-with-file-mention',
        type: 'user',
        timestamp: '2026-04-06T00:00:00.000Z',
        content: '@"/private/tmp/example/src/sentinel.ts" 这个常量是什么？',
      },
    ]

    const mapped = mapHistoryMessagesToUiMessages(messages)

    expect(mapped).toMatchObject([
      {
        id: 'user-with-file-mention',
        type: 'user_text',
        content: '这个常量是什么？',
        modelContent: '@"/private/tmp/example/src/sentinel.ts" 这个常量是什么？',
        attachments: [{
          type: 'file',
          name: 'sentinel.ts',
          path: '/private/tmp/example/src/sentinel.ts',
        }],
      },
    ])
  })

  it('restores persisted workspace diff comments without exposing the model prompt', () => {
    const modelPrompt = [
      '@"/repo/homepage/src/App.vue" Referenced workspace context:',
      '@"homepage/src/App.vue:new:L94-L105":',
      'Comment: 这块儿我们不能再修改一下',
      '```vue',
      '<section id="hero" class="pt-32 pb-20 px-6">',
      '  <h1>{{ name }}</h1>',
      '</section>',
      '```',
    ].join('\n')
    const mapped = mapHistoryMessagesToUiMessages([
      {
        id: 'workspace-comment-user-1',
        type: 'user',
        timestamp: '2026-07-14T00:00:00.000Z',
        content: [{ type: 'text', text: modelPrompt }],
      } as MessageEntry,
    ])

    expect(mapped).toMatchObject([
      {
        id: 'workspace-comment-user-1',
        type: 'user_text',
        content: '',
        modelContent: modelPrompt,
        attachments: [{
          type: 'file',
          name: 'App.vue',
          path: 'homepage/src/App.vue',
          lineStart: 94,
          lineEnd: 105,
          diffSide: 'new',
          note: '这块儿我们不能再修改一下',
          quote: '<section id="hero" class="pt-32 pb-20 px-6">\n  <h1>{{ name }}</h1>\n</section>',
        }],
      },
    ])
  })

  it('keeps workspace reference chips visible while sending CLI attachment paths', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
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
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    useChatStore.getState().sendMessage(
      TEST_SESSION_ID,
      'Referenced workspace context:\n@"src/App.tsx:L4":\nComment: tighten this\n```tsx\nconst value = 1\n```',
      [{
        type: 'file',
        name: 'App.tsx',
        path: '/repo/src/App.tsx',
        lineStart: 4,
        lineEnd: 4,
        note: 'tighten this',
        quote: 'const value = 1',
      }],
      {
        displayContent: '改这里',
        displayAttachments: [{
          type: 'file',
          name: 'App.tsx',
          path: 'src/App.tsx',
          lineStart: 4,
          lineEnd: 4,
          diffSide: 'new',
          hunkId: 'hunk-1',
          note: 'tighten this',
          quote: 'const value = 1',
        }],
      },
    )

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      {
        type: 'user_text',
        content: '改这里',
        modelContent: '@"/repo/src/App.tsx" Referenced workspace context:\n@"src/App.tsx:L4":\nComment: tighten this\n```tsx\nconst value = 1\n```',
        attachments: [{
          type: 'file',
          name: 'App.tsx',
          path: 'src/App.tsx',
          lineStart: 4,
          lineEnd: 4,
          diffSide: 'new',
          hunkId: 'hunk-1',
          note: 'tighten this',
          quote: 'const value = 1',
        }],
      },
    ])
    expect(sendMock).toHaveBeenCalledWith(
      TEST_SESSION_ID,
      {
        type: 'user_message',
        content: 'Referenced workspace context:\n@"src/App.tsx:L4":\nComment: tighten this\n```tsx\nconst value = 1\n```',
        attachments: [{
          type: 'file',
          name: 'App.tsx',
          path: '/repo/src/App.tsx',
          lineStart: 4,
          lineEnd: 4,
          note: 'tighten this',
          quote: 'const value = 1',
        }],
      },
    )
  })

  it('keeps queued message model context when editing the visible prompt text', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'streaming',
        }),
      },
    })

    const id = useChatStore.getState().queueUserMessage(TEST_SESSION_ID, {
      content: 'Referenced workspace context:\n@"src/App.tsx:L4":\n```tsx\nconst value = 1\n```\n\nfix this',
      attachments: [{
        type: 'file',
        name: 'App.tsx',
        path: '/repo/src/App.tsx',
        lineStart: 4,
        lineEnd: 4,
      }],
      displayContent: 'fix this',
      displayAttachments: [{
        type: 'file',
        name: 'App.tsx',
        path: 'src/App.tsx',
        lineStart: 4,
        lineEnd: 4,
      }],
    })

    useChatStore.getState().updateQueuedUserMessage(TEST_SESSION_ID, id, 'tighten this')

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.queuedUserMessages?.[0]).toMatchObject({
      displayContent: 'tighten this',
      content: 'Referenced workspace context:\n@"src/App.tsx:L4":\n```tsx\nconst value = 1\n```\n\ntighten this',
    })

    useChatStore.getState().sendQueuedUserMessage(TEST_SESSION_ID, id)

    expect(sendMock).toHaveBeenCalledWith(TEST_SESSION_ID, {
      type: 'user_message',
      content: 'Referenced workspace context:\n@"src/App.tsx:L4":\n```tsx\nconst value = 1\n```\n\ntighten this',
      attachments: [{
        type: 'file',
        name: 'App.tsx',
        path: '/repo/src/App.tsx',
        lineStart: 4,
        lineEnd: 4,
      }],
    })
  })

  it('can send a visual selection turn without rendering the full model prompt as user text', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
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
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    useChatStore.getState().sendMessage(
      TEST_SESSION_ID,
      '请根据截图中编号 1 的 <h1> 修改：这个标题更轻一点',
      [{
        type: 'image',
        name: '<h1>',
        data: 'data:image/png;base64,AAAA',
        mimeType: 'image/png',
        note: '这个标题更轻一点',
      }],
      {
        hideDisplayContent: true,
        displayAttachments: [{
          type: 'image',
          name: '<h1>',
          data: 'data:image/png;base64,AAAA',
          mimeType: 'image/png',
          note: '这个标题更轻一点',
        }],
      },
    )

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      {
        type: 'user_text',
        content: '',
        modelContent: '请根据截图中编号 1 的 <h1> 修改：这个标题更轻一点',
        attachments: [{
          type: 'image',
          name: '<h1>',
          data: 'data:image/png;base64,AAAA',
          mimeType: 'image/png',
          note: '这个标题更轻一点',
        }],
      },
    ])
    expect(sendMock).toHaveBeenCalledWith(
      TEST_SESSION_ID,
      {
        type: 'user_message',
        content: '请根据截图中编号 1 的 <h1> 修改：这个标题更轻一点',
        attachments: [{
          type: 'image',
          name: '<h1>',
          data: 'data:image/png;base64,AAAA',
          mimeType: 'image/png',
          note: '这个标题更轻一点',
        }],
      },
    )
  })

  it('stores server-materialized attachment prefixes for rewind matching', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
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
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    useChatStore.getState().sendMessage(
      TEST_SESSION_ID,
      '记一下这个文件讲了什么东西。',
      [{ type: 'file', name: 'conditions.py', path: '/repo/backend/conditions.py' }],
      {
        displayContent: '记一下这个文件讲了什么东西。',
        displayAttachments: [{ type: 'file', name: 'conditions.py', path: 'backend/conditions.py' }],
      },
    )

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      {
        type: 'user_text',
        content: '记一下这个文件讲了什么东西。',
        modelContent: '@"/repo/backend/conditions.py" 记一下这个文件讲了什么东西。',
        attachments: [{
          type: 'file',
          name: 'conditions.py',
          path: 'backend/conditions.py',
        }],
      },
    ])
  })

  it('hydrates TodoWrite history into the currently tracked task store only', async () => {
    const todos = [{ content: 'Session task', status: 'in_progress' }]
    vi.mocked(sessionsApi.getMessages).mockResolvedValueOnce({
      messages: [
        {
          id: 'assistant-todo',
          type: 'assistant',
          timestamp: '2026-04-06T00:00:00.000Z',
          content: [
            { type: 'tool_use', name: 'TodoWrite', id: 'todo-1', input: { todos } },
          ],
        },
      ],
    })
    cliTaskStoreSnapshot.sessionId = TEST_SESSION_ID
    cliTaskStoreSnapshot.tasks = []

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({ messages: [] }),
      },
    })

    await useChatStore.getState().loadHistory(TEST_SESSION_ID)

    expect(setTasksFromTodosMock).toHaveBeenCalledWith(todos, TEST_SESSION_ID)
  })

  it('does not hydrate parent-linked SubAgent task history into the session task store', async () => {
    const childTodos = [{ content: 'SubAgent internal task', status: 'completed' }]
    vi.mocked(sessionsApi.getMessages).mockResolvedValueOnce({
      messages: [
        {
          id: 'child-todo',
          type: 'assistant',
          timestamp: '2026-04-06T00:00:00.000Z',
          parentToolUseId: 'agent-tool-1',
          content: [
            { type: 'tool_use', name: 'TodoWrite', id: 'todo-child', input: { todos: childTodos } },
            { type: 'tool_use', name: 'TaskCreate', id: 'task-child', input: { subject: 'Child task' } },
          ],
        },
        {
          id: 'user-next',
          type: 'user',
          timestamp: '2026-04-06T00:00:01.000Z',
          content: '继续下一步',
        },
      ],
    })
    cliTaskStoreSnapshot.sessionId = TEST_SESSION_ID
    cliTaskStoreSnapshot.tasks = []
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({ messages: [] }),
      },
    })

    await useChatStore.getState().loadHistory(TEST_SESSION_ID)

    expect(setTasksFromTodosMock).not.toHaveBeenCalledWith(childTodos, TEST_SESSION_ID)
    expect(setTasksFromTodosMock).toHaveBeenCalledWith([], TEST_SESSION_ID)
    expect(markCompletedAndDismissedMock).not.toHaveBeenCalled()
  })

  it('marks history task completion dismissed when the user already continued', async () => {
    vi.mocked(sessionsApi.getMessages).mockResolvedValueOnce({
      messages: [
        {
          id: 'assistant-task',
          type: 'assistant',
          timestamp: '2026-04-06T00:00:00.000Z',
          content: [
            { type: 'tool_use', name: 'TaskCreate', id: 'task-1', input: { subject: 'Done' } },
          ],
        },
        {
          id: 'user-next',
          type: 'user',
          timestamp: '2026-04-06T00:00:01.000Z',
          content: '继续下一步',
        },
      ],
    })

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({ messages: [] }),
      },
    })

    await useChatStore.getState().loadHistory(TEST_SESSION_ID)

    expect(setTasksFromTodosMock).toHaveBeenCalledWith([], TEST_SESSION_ID)
    expect(markCompletedAndDismissedMock).toHaveBeenCalledWith(TEST_SESSION_ID)
  })

  it('reloads history task state for the requested session', async () => {
    const todos = [{ content: 'Reloaded task', status: 'pending' }]
    vi.mocked(sessionsApi.getMessages).mockResolvedValueOnce({
      messages: [
        {
          id: 'assistant-todo',
          type: 'assistant',
          timestamp: '2026-04-06T00:00:00.000Z',
          content: [
            { type: 'tool_use', name: 'TodoWrite', id: 'todo-1', input: { todos } },
          ],
        },
      ],
    })

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({ messages: [{ id: 'old', type: 'assistant_text', content: 'old', timestamp: 1 }] }),
      },
    })

    await useChatStore.getState().reloadHistory(TEST_SESSION_ID)

    expect(setTasksFromTodosMock).toHaveBeenCalledWith(todos, TEST_SESSION_ID)
  })

  it('clears reloaded task state after completed history is followed by a user turn', async () => {
    vi.mocked(sessionsApi.getMessages).mockResolvedValueOnce({
      messages: [
        {
          id: 'assistant-task',
          type: 'assistant',
          timestamp: '2026-04-06T00:00:00.000Z',
          content: [
            { type: 'tool_use', name: 'TaskUpdate', id: 'task-1', input: { subject: 'Done' } },
          ],
        },
        {
          id: 'user-next',
          type: 'user',
          timestamp: '2026-04-06T00:00:01.000Z',
          content: '新的问题',
        },
      ],
    })

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({ messages: [{ id: 'old', type: 'assistant_text', content: 'old', timestamp: 1 }] }),
      },
    })

    await useChatStore.getState().reloadHistory(TEST_SESSION_ID)

    expect(setTasksFromTodosMock).toHaveBeenCalledWith([], TEST_SESSION_ID)
    expect(markCompletedAndDismissedMock).toHaveBeenCalledWith(TEST_SESSION_ID)
  })

  it('keeps parent tool linkage for live tool events', () => {
    // Initialize the session first
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
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
          slashCommands: [{ name: 'old-command', description: 'Old command' }],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'tool_use_complete',
      toolName: 'Read',
      toolUseId: 'agent-1/tool-1',
      originalToolUseId: 'tool-1',
      input: { file_path: 'src/App.tsx' },
      parentToolUseId: 'agent-1',
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'tool_result',
      toolUseId: 'agent-1/tool-1',
      originalToolUseId: 'tool-1',
      content: 'ok',
      isError: false,
      parentToolUseId: 'agent-1',
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      {
        type: 'tool_use',
        toolUseId: 'agent-1/tool-1',
        originalToolUseId: 'tool-1',
        parentToolUseId: 'agent-1',
      },
      {
        type: 'tool_result',
        toolUseId: 'agent-1/tool-1',
        originalToolUseId: 'tool-1',
        parentToolUseId: 'agent-1',
      },
    ])
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.chatState).toBe('idle')
  })

  it('retains live parent linkage when only content_start carries the parent id', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession(),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_start',
      blockType: 'tool_use',
      toolName: 'Read',
      toolUseId: 'agent-1/tool-1',
      originalToolUseId: 'tool-1',
      parentToolUseId: 'agent-1',
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'tool_use_complete',
      toolName: 'Read',
      toolUseId: 'agent-1/tool-1',
      originalToolUseId: 'tool-1',
      input: { file_path: 'src/App.tsx' },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'tool_result',
      toolUseId: 'agent-1/tool-1',
      originalToolUseId: 'tool-1',
      content: 'ok',
      isError: false,
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      {
        type: 'tool_use',
        toolUseId: 'agent-1/tool-1',
        originalToolUseId: 'tool-1',
        parentToolUseId: 'agent-1',
      },
      {
        type: 'tool_result',
        toolUseId: 'agent-1/tool-1',
        originalToolUseId: 'tool-1',
        parentToolUseId: 'agent-1',
      },
    ])
  })

  it('renders a pending tool call as soon as the tool stream starts', () => {
    vi.useFakeTimers()

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession(),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_start',
      blockType: 'tool_use',
      toolName: 'Write',
      toolUseId: 'write-1',
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      {
        type: 'tool_use',
        toolName: 'Write',
        toolUseId: 'write-1',
        input: {},
        isPending: true,
      },
    ])

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_delta',
      toolInput: '{"file_path":"/private/tmp/ai-code-novel.md","content":"第一章',
    })
    vi.advanceTimersByTime(60)

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      {
        type: 'tool_use',
        toolName: 'Write',
        toolUseId: 'write-1',
        input: { file_path: '/private/tmp/ai-code-novel.md' },
        isPending: true,
        partialInput: '{"file_path":"/private/tmp/ai-code-novel.md","content":"第一章',
      },
    ])

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'tool_use_complete',
      toolName: 'Write',
      toolUseId: 'write-1',
      input: {
        file_path: '/private/tmp/ai-code-novel.md',
        content: '第一章\n正文',
      },
    })

    const messages = useChatStore.getState().sessions[TEST_SESSION_ID]?.messages ?? []
    const toolMessages = messages.filter((message) => message.type === 'tool_use')
    expect(toolMessages).toHaveLength(1)
    expect(toolMessages[0]).toMatchObject({
      type: 'tool_use',
      toolName: 'Write',
      toolUseId: 'write-1',
      input: {
        file_path: '/private/tmp/ai-code-novel.md',
        content: '第一章\n正文',
      },
      isPending: false,
    })
    expect(toolMessages[0]).not.toHaveProperty('partialInput')

    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('batches streaming tool input deltas before updating the pending card', () => {
    vi.useFakeTimers()

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession(),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_start',
      blockType: 'tool_use',
      toolName: 'Write',
      toolUseId: 'write-1',
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_delta',
      toolInput: '{"file_path":"/private/tmp/story.md","content":"第一',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_delta',
      toolInput: '章\\n第二段',
    })

    const beforeFlush = useChatStore.getState().sessions[TEST_SESSION_ID]?.messages[0]
    expect(beforeFlush).toMatchObject({
      type: 'tool_use',
      isPending: true,
      input: {},
      partialInput: '',
    })

    vi.advanceTimersByTime(60)

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages[0]).toMatchObject({
      type: 'tool_use',
      input: { file_path: '/private/tmp/story.md' },
      partialInput: '{"file_path":"/private/tmp/story.md","content":"第一章\\n第二段',
    })

    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('exposes complete nested tool input while the tool result is still pending', () => {
    vi.useFakeTimers()

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession(),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_start',
      blockType: 'tool_use',
      toolName: 'ImageGen',
      toolUseId: 'imagegen-1',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_delta',
      toolInput: JSON.stringify({
        prompt: 'change only the color',
        count: 1,
        input_images: [{ path: '/tmp/upload.png', role: 'edit_target' }],
      }),
    })
    vi.advanceTimersByTime(60)

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages[0]).toMatchObject({
      type: 'tool_use',
      toolName: 'ImageGen',
      toolUseId: 'imagegen-1',
      isPending: true,
      input: {
        prompt: 'change only the color',
        count: 1,
        input_images: [{ path: '/tmp/upload.png', role: 'edit_target' }],
      },
    })

    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('marks pending tool input as stopped when generation is stopped', () => {
    vi.useFakeTimers()

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({ chatState: 'tool_executing' }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_start',
      blockType: 'tool_use',
      toolName: 'Write',
      toolUseId: 'write-1',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_delta',
      toolInput: '{"file_path":"/private/tmp/story.md","content":"第一章',
    })
    vi.advanceTimersByTime(60)

    useChatStore.getState().stopGeneration(TEST_SESSION_ID)

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.chatState).toBe('idle')
    expect(session?.activeToolUseId).toBeNull()
    expect(session?.activeToolName).toBeNull()
    expect(session?.streamingToolInput).toBe('')
    expect(session?.messages[0]).toMatchObject({
      type: 'tool_use',
      toolUseId: 'write-1',
      isPending: false,
      status: 'stopped',
    })

    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('marks every running SubAgent as stopping when generation is stopped', () => {
    const backgroundAgentTasks = Object.fromEntries(
      Array.from({ length: 4 }, (_, index) => {
        const number = index + 1
        return [`agent-task-${number}`, {
          taskId: `agent-task-${number}`,
          toolUseId: `agent-tool-${number}`,
          taskType: number === 3 ? 'remote_agent' : 'local_agent',
          description: `Review area ${number}`,
          status: 'running' as const,
          startedAt: number,
          updatedAt: number,
        }]
      }),
    )

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'tool_executing',
          backgroundAgentTasks,
        }),
      },
    })

    useChatStore.getState().stopGeneration(TEST_SESSION_ID)

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(sendMock).toHaveBeenCalledWith(TEST_SESSION_ID, { type: 'stop_generation' })
    expect(session?.stoppingBackgroundTaskIds).toEqual({
      'agent-task-1': true,
      'agent-task-2': true,
      'agent-task-3': true,
      'agent-task-4': true,
    })
    expect(Object.values(session?.backgroundAgentTasks ?? {}).map((task) => task.status)).toEqual([
      'running',
      'running',
      'running',
      'running',
    ])
  })

  it('keeps a SubAgent that starts after the global stop in the stopping state', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({ chatState: 'tool_executing' }),
      },
    })

    useChatStore.getState().stopGeneration(TEST_SESSION_ID)
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'task_started',
      data: {
        task_id: 'late-agent-task',
        tool_use_id: 'late-agent-tool',
        task_type: 'local_agent',
        description: 'Started while the turn was stopping',
      },
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'task_started',
      data: {
        task_id: 'late-bash-task',
        tool_use_id: 'late-bash-tool',
        task_type: 'local_bash',
        description: 'Detached shell task',
      },
    })

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.stopAllSubagentsRequested).toBe(true)
    expect(session?.stoppingBackgroundTaskIds).toEqual({ 'late-agent-task': true })

    useChatStore.getState().sendMessage(TEST_SESSION_ID, 'Start the next turn')
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'task_started',
      data: {
        task_id: 'next-turn-agent-task',
        tool_use_id: 'next-turn-agent-tool',
        task_type: 'local_agent',
        description: 'Belongs to the next turn',
      },
    })

    const pendingSession = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(pendingSession?.stopAllSubagentsRequested).toBe(true)
    expect(pendingSession?.stoppingBackgroundTaskIds?.['next-turn-agent-task']).toBe(true)

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'user_message_replay',
      content: 'Start the next turn',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'task_started',
      data: {
        task_id: 'replayed-turn-agent-task',
        tool_use_id: 'replayed-turn-agent-tool',
        task_type: 'local_agent',
        description: 'Belongs to the replayed next turn',
      },
    })

    const resumedSession = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(resumedSession?.stopAllSubagentsRequested).toBe(false)
    expect(resumedSession?.stoppingBackgroundTaskIds?.['replayed-turn-agent-task']).toBeUndefined()
    if (resumedSession?.elapsedTimer) clearInterval(resumedSession.elapsedTimer)
  })

  it('keeps the global SubAgent stop latch when a replacement fails before replay', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'idle',
          stopAllSubagentsRequested: true,
        }),
      },
    })

    useChatStore.getState().sendMessage(TEST_SESSION_ID, 'Replacement that will fail')
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'error',
      message: 'Replacement rejected',
      code: 'CLI_START_FAILED',
    })

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.stopAllSubagentsRequested).toBe(true)
    if (session?.elapsedTimer) clearInterval(session.elapsedTimer)
  })

  it('ends the global SubAgent stop latch on authoritative local-command output', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'thinking',
          stopAllSubagentsRequested: true,
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_start',
      blockType: 'text',
    })

    expect(
      useChatStore.getState().sessions[TEST_SESSION_ID]?.stopAllSubagentsRequested,
    ).toBe(false)
  })

  it('ends the global SubAgent stop latch on authoritative /goal output', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'thinking',
          stopAllSubagentsRequested: true,
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'goal_event',
      message: 'Goal set: verify the replacement turn',
      data: {
        action: 'created',
        status: 'active',
        objective: 'verify the replacement turn',
      },
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 0, output_tokens: 0 },
    })

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.stopAllSubagentsRequested).toBe(false)
    expect(session?.chatState).toBe('idle')
    expect(session?.activeGoal).toMatchObject({
      action: 'created',
      status: 'active',
      objective: 'verify the replacement turn',
    })
    expect(session?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'goal_event',
        action: 'created',
        objective: 'verify the replacement turn',
      }),
    ]))
  })

  it('ends the global stop latch when an authoritative replay starts the next turn', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'idle',
          stopAllSubagentsRequested: true,
          stoppingBackgroundTaskIds: { 'previous-turn-agent': true },
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'user_message_replay',
      content: 'Start a turn from another renderer',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'task_started',
      data: {
        task_id: 'next-turn-agent',
        tool_use_id: 'next-turn-agent-tool',
        task_type: 'local_agent',
        description: 'Belongs to the authoritative replayed turn',
      },
    })

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.stopAllSubagentsRequested).toBe(false)
    expect(session?.stoppingBackgroundTaskIds).toEqual({ 'previous-turn-agent': true })
    expect(session?.backgroundAgentTasks?.['next-turn-agent']?.status).toBe('running')
  })

  it('refreshes merged slash commands when a live CLI update omits project commands', async () => {
    const cliCommand = { name: 'builtin-help', description: 'Built-in command' }
    const projectCommand = { name: 'project-probe', description: 'Project custom command' }

    vi.mocked(sessionsApi.getSlashCommands).mockClear()
    vi.mocked(sessionsApi.getSlashCommands).mockResolvedValueOnce({
      commands: [cliCommand, projectCommand],
    })

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          slashCommands: [projectCommand],
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'slash_commands',
      data: [cliCommand],
    })

    await Promise.resolve()

    expect(sessionsApi.getSlashCommands).toHaveBeenCalledTimes(1)
    expect(sessionsApi.getSlashCommands).toHaveBeenCalledWith(TEST_SESSION_ID)
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.slashCommands).toEqual([
      cliCommand,
      projectCommand,
    ])
  })

  it('keeps skill source metadata while a live CLI slash update is being reconciled', async () => {
    const projectSkill = {
      name: 'project-audit',
      description: 'Project skill',
      kind: 'skill' as const,
      source: 'project' as const,
    }

    vi.mocked(sessionsApi.getSlashCommands).mockResolvedValueOnce({
      commands: [projectSkill],
    })

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          slashCommands: [projectSkill],
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'slash_commands',
      data: [{ name: 'project-audit', description: 'CLI description' }],
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.slashCommands).toContainEqual({
      name: 'project-audit',
      description: 'CLI description',
      kind: 'skill',
      source: 'project',
    })

    await Promise.resolve()

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.slashCommands).toEqual([
      projectSkill,
    ])
  })

  it('syncs live TodoWrite tool input into the task store for that session', () => {
    const todos = [{ content: 'Live todo', status: 'in_progress' }]
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({ chatState: 'tool_executing' }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'tool_use_complete',
      toolName: 'TodoWrite',
      toolUseId: 'todo-live',
      input: { todos },
    })

    expect(setTasksFromTodosMock).toHaveBeenCalledWith(todos, TEST_SESSION_ID)
  })

  it('does not sync parent-linked SubAgent task tools into the session task store', () => {
    const childTodos = [{ content: 'SubAgent internal task', status: 'in_progress' }]
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({ chatState: 'tool_executing' }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'tool_use_complete',
      toolName: 'TodoWrite',
      toolUseId: 'agent-tool-1/todo-child',
      input: { todos: childTodos },
      parentToolUseId: 'agent-tool-1',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'tool_use_complete',
      toolName: 'TaskCreate',
      toolUseId: 'agent-tool-1/task-child',
      input: { subject: 'Child task' },
      parentToolUseId: 'agent-tool-1',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'tool_result',
      toolUseId: 'agent-tool-1/task-child',
      content: 'Task #2 created successfully: Child task',
      isError: false,
      parentToolUseId: 'agent-tool-1',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 1 },
    })

    expect(setTasksFromTodosMock).not.toHaveBeenCalledWith(childTodos, TEST_SESSION_ID)
    expect(refreshTasksMock).not.toHaveBeenCalled()
  })

  it('replays saved runtime selection and effort when reconnecting a session', () => {
    sessionStoreSnapshot.sessions = [{
      id: TEST_SESSION_ID,
      title: 'New Session',
      createdAt: '2026-06-20T10:00:00.000Z',
      modifiedAt: '2026-06-20T10:00:00.000Z',
      messageCount: 0,
      projectPath: '/workspace/project',
      workDir: '/workspace/project',
      workDirExists: true,
    }]
    useSessionRuntimeStore.getState().setSelection(TEST_SESSION_ID, {
      providerId: 'provider-1',
      modelId: 'kimi-k2.6',
      effortLevel: 'high',
    })

    useChatStore.getState().connectToSession(TEST_SESSION_ID)

    expect(sendMock).toHaveBeenCalledWith(TEST_SESSION_ID, {
      type: 'set_runtime_config',
      providerId: 'provider-1',
      modelId: 'kimi-k2.6',
      effortLevel: 'high',
    })
    expect(sendMock.mock.calls.slice(0, 2)).toEqual([
      [
        TEST_SESSION_ID,
        {
          type: 'set_runtime_config',
          providerId: 'provider-1',
          modelId: 'kimi-k2.6',
          effortLevel: 'high',
        },
      ],
      [TEST_SESSION_ID, { type: 'prewarm_session' }],
    ])
  })

  it('does not prewarm unknown desktop sessions when connecting', () => {
    useChatStore.getState().connectToSession(TEST_SESSION_ID)

    expect(sendMock).not.toHaveBeenCalledWith(TEST_SESSION_ID, {
      type: 'prewarm_session',
    })
  })

  it('can observe a known empty session without prewarming it', () => {
    sessionStoreSnapshot.sessions = [{
      id: TEST_SESSION_ID,
      title: 'Observed Session',
      createdAt: '2026-06-20T10:00:00.000Z',
      modifiedAt: '2026-06-20T10:00:00.000Z',
      messageCount: 0,
      projectPath: '/workspace/project',
      workDir: '/workspace/project',
      workDirExists: true,
    }]

    useChatStore.getState().connectToSession(TEST_SESSION_ID, { prewarm: false })

    expect(sendMock).not.toHaveBeenCalledWith(TEST_SESSION_ID, {
      type: 'prewarm_session',
    })
  })

  it('can connect a read-only companion without applying saved runtime selection', () => {
    sessionStoreSnapshot.sessions = [{
      id: TEST_SESSION_ID,
      title: 'Observed Session',
      createdAt: '2026-06-20T10:00:00.000Z',
      modifiedAt: '2026-06-20T10:00:00.000Z',
      messageCount: 1,
      projectPath: '/workspace/project',
      workDir: '/workspace/project',
      workDirExists: true,
    }]
    useSessionRuntimeStore.getState().setSelection(TEST_SESSION_ID, {
      providerId: 'provider-1',
      modelId: 'kimi-k2.6',
      effortLevel: 'high',
    })

    useChatStore.getState().connectToSession(TEST_SESSION_ID, {
      prewarm: false,
      applyRuntimeSelection: false,
    })

    expect(sendMock).not.toHaveBeenCalledWith(TEST_SESSION_ID, expect.objectContaining({
      type: 'set_runtime_config',
    }))
    expect(sendMock).not.toHaveBeenCalledWith(TEST_SESSION_ID, {
      type: 'prewarm_session',
    })
  })

  it('connects a scoped pet client without fetching transcript, commands, or tasks', () => {
    useChatStore.getState().connectToSession(TEST_SESSION_ID, {
      prewarm: false,
      applyRuntimeSelection: false,
      minimalBootstrap: true,
    })

    expect(fetchSessionTasksMock).not.toHaveBeenCalled()
    expect(sessionsApi.getMessages).not.toHaveBeenCalled()
    expect(sessionsApi.getSlashCommands).not.toHaveBeenCalled()
  })

  it('blocks sends across reconnects until a fresh authoritative snapshot arrives', () => {
    useChatStore.getState().connectToSession(TEST_SESSION_ID, {
      prewarm: false,
      applyRuntimeSelection: false,
    })
    const onConnectionState = connectionStateHandlers.get(TEST_SESSION_ID)
    expect(onConnectionState).toBeTypeOf('function')
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]).toMatchObject({
      connectionState: 'connecting',
      connectionSnapshotReady: false,
    })

    onConnectionState?.('connected')
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]).toMatchObject({
      connectionState: 'connected',
      connectionSnapshotReady: false,
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'permission_requests_snapshot',
      toolRequestIds: [],
      computerUseRequestIds: [],
      turnActive: false,
    })
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.connectionSnapshotReady).toBe(true)

    useChatStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [TEST_SESSION_ID]: {
          ...state.sessions[TEST_SESSION_ID]!,
          stoppingBackgroundTaskIds: { 'agent-task-before-reconnect': true },
        },
      },
    }))

    onConnectionState?.('reconnecting')
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]).toMatchObject({
      connectionState: 'reconnecting',
      connectionSnapshotReady: false,
      stoppingBackgroundTaskIds: {},
    })
    onConnectionState?.('connected')
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]).toMatchObject({
      connectionState: 'connected',
      connectionSnapshotReady: false,
    })
  })

  it('keeps global SubAgent stop markers visible while the socket reconnects', () => {
    useChatStore.getState().connectToSession(TEST_SESSION_ID, {
      prewarm: false,
      applyRuntimeSelection: false,
    })
    const onConnectionState = connectionStateHandlers.get(TEST_SESSION_ID)
    useChatStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [TEST_SESSION_ID]: {
          ...state.sessions[TEST_SESSION_ID]!,
          stopAllSubagentsRequested: true,
          stoppingBackgroundTaskIds: { 'agent-task-stop-reconnect': true },
        },
      },
    }))

    onConnectionState?.('reconnecting')

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]).toMatchObject({
      connectionState: 'reconnecting',
      stopAllSubagentsRequested: true,
      stoppingBackgroundTaskIds: { 'agent-task-stop-reconnect': true },
    })
  })

  it('does not prewarm team member sessions', () => {
    getMemberBySessionIdMock.mockReturnValue({
      agentId: 'reviewer@test-team',
      role: 'reviewer',
      status: 'running',
    })

    useChatStore.getState().connectToSession(TEST_SESSION_ID)

    expect(sendMock).not.toHaveBeenCalledWith(TEST_SESSION_ID, {
      type: 'prewarm_session',
    })
  })

  it('does not prewarm synthetic app tabs', () => {
    useChatStore.getState().connectToSession('__settings__')

    expect(sendMock).not.toHaveBeenCalledWith('__settings__', {
      type: 'prewarm_session',
    })
  })

  it('retries history loading for an already connected empty session', async () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          connectionState: 'connected',
          chatState: 'idle',
          messages: [],
        }),
      },
    })

    useChatStore.getState().connectToSession(TEST_SESSION_ID)
    await Promise.resolve()

    expect(sessionsApi.getMessages).toHaveBeenCalledWith(TEST_SESSION_ID)
    expect(sendMock).not.toHaveBeenCalledWith(TEST_SESSION_ID, { type: 'prewarm_session' })
  })

  it('sends explicit runtime overrides over websocket', () => {
    useChatStore.getState().setSessionRuntime(TEST_SESSION_ID, {
      providerId: null,
      modelId: 'claude-opus-4-7',
      effortLevel: 'max',
    })

    expect(sendMock).toHaveBeenCalledWith(TEST_SESSION_ID, {
      type: 'set_runtime_config',
      providerId: null,
      modelId: 'claude-opus-4-7',
      effortLevel: 'max',
    })
  })

  it('bumps context refresh only for the runtime config currently selected', () => {
    useSessionRuntimeStore.getState().setSelection(TEST_SESSION_ID, {
      providerId: 'provider-b',
      modelId: 'model-b',
      effortLevel: 'high',
    })
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({ runtimeConfigReadyCount: 0 }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'runtime_config_applied',
      providerId: 'provider-a',
      modelId: 'model-a',
      effortLevel: 'high',
    })
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.runtimeConfigReadyCount).toBe(0)

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'runtime_config_applied',
      providerId: 'provider-b',
      modelId: 'model-b',
      effortLevel: 'high',
    })
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.runtimeConfigReadyCount).toBe(1)
  })

  it('keeps AskUserQuestion permission requests out of the message list while tracking the pending request', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: {
          messages: [
            {
              id: 'ask-1',
              type: 'tool_use',
              toolName: 'AskUserQuestion',
              toolUseId: 'tool-ask-1',
              input: {
                questions: [
                  {
                    question: 'Should we persist data?',
                    options: [{ label: 'No' }, { label: 'Yes' }],
                  },
                ],
              },
              timestamp: 1,
            },
          ],
          chatState: 'idle',
          connectionState: 'connected',
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
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'permission_request',
      requestId: 'perm-ask-1',
      toolName: 'AskUserQuestion',
      toolUseId: 'tool-ask-1',
      input: {
        questions: [
          {
            question: 'Should we persist data?',
            options: [{ label: 'No' }, { label: 'Yes' }],
          },
        ],
      },
    })

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.pendingPermission).toMatchObject({
      requestId: 'perm-ask-1',
      toolName: 'AskUserQuestion',
      toolUseId: 'tool-ask-1',
    })
    expect(session?.messages).toHaveLength(1)
    expect(session?.messages[0]).toMatchObject({
      type: 'tool_use',
      toolUseId: 'tool-ask-1',
    })
    expect(notifyDesktopMock).toHaveBeenCalledWith({
      dedupeKey: 'permission:perm-ask-1',
      cooldownScope: 'permission-prompt',
      requestAttention: true,
      title: 'Claude Code Haha 需要你的确认',
      body: 'AskUserQuestion 请求执行，正在等待允许。',
      target: { type: 'session', sessionId: TEST_SESSION_ID },
    })
  })

  it('keeps concurrent permission requests independently pending until each is answered', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession(),
      },
    })
    const store = useChatStore.getState()

    store.handleServerMessage(TEST_SESSION_ID, {
      type: 'permission_request',
      requestId: 'perm-read-1',
      toolName: 'Read',
      toolUseId: 'tool-read-1',
      input: { file_path: '/outside/one.ts' },
    })
    store.handleServerMessage(TEST_SESSION_ID, {
      type: 'permission_request',
      requestId: 'perm-read-2',
      toolName: 'Read',
      toolUseId: 'tool-read-2',
      input: { file_path: '/outside/two.ts' },
    })

    let session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(Object.keys(session?.pendingPermissions ?? {})).toEqual([
      'perm-read-1',
      'perm-read-2',
    ])
    expect(session?.messages.filter((message) => message.type === 'permission_request'))
      .toHaveLength(2)

    store.handleServerMessage(TEST_SESSION_ID, {
      type: 'permission_request',
      requestId: 'perm-read-1',
      toolName: 'Read',
      toolUseId: 'tool-read-1',
      input: { file_path: '/outside/one.ts' },
    })
    session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.messages.filter((message) => message.type === 'permission_request'))
      .toHaveLength(2)

    store.respondToPermission(TEST_SESSION_ID, 'perm-read-2', true)

    session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.pendingPermissions).not.toHaveProperty('perm-read-2')
    expect(session?.pendingPermissions).toHaveProperty('perm-read-1')
    expect(session?.pendingPermission?.requestId).toBe('perm-read-1')
    expect(session?.chatState).toBe('permission_pending')

    store.handleServerMessage(TEST_SESSION_ID, {
      type: 'tool_result',
      toolUseId: 'tool-read-2',
      content: 'second file',
      isError: false,
    })
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.chatState)
      .toBe('permission_pending')

    store.respondToPermission(TEST_SESSION_ID, 'perm-read-1', true)

    session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.pendingPermissions).toEqual({})
    expect(session?.pendingPermission).toBeNull()
    expect(session?.chatState).toBe('tool_executing')
  })

  it('removes replayed or cancelled requests when the server resolves them', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession(),
      },
    })
    const store = useChatStore.getState()
    const sendPermission = (requestId: string) => {
      store.handleServerMessage(TEST_SESSION_ID, {
        type: 'permission_request',
        requestId,
        toolName: 'Read',
        toolUseId: `tool-${requestId}`,
        input: { file_path: `/outside/${requestId}.ts` },
      })
    }

    sendPermission('perm-read-1')
    sendPermission('perm-read-2')
    store.respondToPermission(TEST_SESSION_ID, 'perm-read-2', true)
    sendPermission('perm-read-2')

    let session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.pendingPermissions).toHaveProperty('perm-read-2')

    store.handleServerMessage(TEST_SESSION_ID, {
      type: 'permission_resolved',
      requestId: 'perm-read-2',
      permissionType: 'tool',
      allowed: true,
    })
    session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.pendingPermissions).not.toHaveProperty('perm-read-2')
    expect(session?.pendingPermissions).toHaveProperty('perm-read-1')
    expect(session?.chatState).toBe('permission_pending')

    store.handleServerMessage(TEST_SESSION_ID, {
      type: 'permission_resolved',
      requestId: 'perm-read-1',
      permissionType: 'tool',
    })
    session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.pendingPermissions).toEqual({})
    expect(session?.pendingPermission).toBeNull()
    expect(session?.chatState).toBe('thinking')
  })

  it('reconciles stale tool and Computer Use requests from the reconnect snapshot', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession(),
      },
    })
    const store = useChatStore.getState()

    for (const requestId of ['perm-read-1', 'perm-read-2']) {
      store.handleServerMessage(TEST_SESSION_ID, {
        type: 'permission_request',
        requestId,
        toolName: 'Read',
        toolUseId: `tool-${requestId}`,
        input: { file_path: `/outside/${requestId}.ts` },
      })
    }
    for (const requestId of ['cu-1', 'cu-2']) {
      store.handleServerMessage(TEST_SESSION_ID, {
        type: 'computer_use_permission_request',
        requestId,
        request: {
          requestId,
          reason: `Computer Use ${requestId}`,
          apps: [],
          requestedFlags: {},
          screenshotFiltering: 'native',
        },
      })
    }

    store.handleServerMessage(TEST_SESSION_ID, {
      type: 'permission_requests_snapshot',
      toolRequestIds: ['perm-read-2'],
      computerUseRequestIds: ['cu-2'],
      turnActive: true,
    })

    let session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.connectionSnapshotReady).toBe(true)
    expect(Object.keys(session?.pendingPermissions ?? {})).toEqual(['perm-read-2'])
    expect(session?.pendingPermission?.requestId).toBe('perm-read-2')
    expect(Object.keys(session?.pendingComputerUsePermissions ?? {})).toEqual(['cu-2'])
    expect(session?.pendingComputerUsePermission?.requestId).toBe('cu-2')
    expect(session?.chatState).toBe('permission_pending')

    store.handleServerMessage(TEST_SESSION_ID, {
      type: 'permission_requests_snapshot',
      toolRequestIds: [],
      computerUseRequestIds: [],
      turnActive: true,
    })

    session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.pendingPermissions).toEqual({})
    expect(session?.pendingPermission).toBeNull()
    expect(session?.pendingComputerUsePermissions).toEqual({})
    expect(session?.pendingComputerUsePermission).toBeNull()
    expect(session?.chatState).toBe('thinking')

    store.handleServerMessage(TEST_SESSION_ID, {
      type: 'permission_requests_snapshot',
      toolRequestIds: [],
      computerUseRequestIds: [],
      turnActive: false,
    })
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.chatState).toBe('idle')
  })

  it('preserves precise active chat states when a reconnect snapshot has no permissions', () => {
    for (const chatState of ['streaming', 'tool_executing', 'compacting'] as const) {
      useChatStore.setState({
        sessions: {
          [TEST_SESSION_ID]: makeSession({ chatState }),
        },
      })

      useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
        type: 'permission_requests_snapshot',
        toolRequestIds: [],
        computerUseRequestIds: [],
        turnActive: true,
      })

      expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.chatState).toBe(chatState)
    }
  })

  it('keeps generic and Computer Use permissions pending in either arrival order', () => {
    const sendReadPermission = () => {
      useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
        type: 'permission_request',
        requestId: 'perm-read-1',
        toolName: 'Read',
        toolUseId: 'tool-read-1',
        input: { file_path: '/outside/one.ts' },
      })
    }
    const sendComputerUsePermission = () => {
      useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
        type: 'computer_use_permission_request',
        requestId: 'cu-1',
        request: {
          requestId: 'cu-1',
          reason: 'Inspect another app',
          apps: [],
          requestedFlags: {},
          screenshotFiltering: 'native',
        },
      })
    }
    const allowComputerUse = {
      granted: [],
      denied: [],
      flags: {
        clipboardRead: false,
        clipboardWrite: false,
        systemKeyCombos: false,
      },
      userConsented: true,
    }

    for (const order of ['read-first', 'computer-first'] as const) {
      useChatStore.setState({
        sessions: {
          [TEST_SESSION_ID]: makeSession(),
        },
      })
      if (order === 'read-first') {
        sendReadPermission()
        sendComputerUsePermission()
      } else {
        sendComputerUsePermission()
        sendReadPermission()
      }

      let session = useChatStore.getState().sessions[TEST_SESSION_ID]
      expect(session?.pendingPermissions).toHaveProperty('perm-read-1')
      expect(session?.pendingComputerUsePermissions).toHaveProperty('cu-1')
      expect(session?.chatState).toBe('permission_pending')

      if (order === 'read-first') {
        useChatStore.getState().respondToPermission(TEST_SESSION_ID, 'perm-read-1', true)
        session = useChatStore.getState().sessions[TEST_SESSION_ID]
        expect(session?.pendingPermissions).toEqual({})
        expect(session?.pendingComputerUsePermissions).toHaveProperty('cu-1')
        expect(session?.chatState).toBe('permission_pending')
        useChatStore.getState().respondToComputerUsePermission(
          TEST_SESSION_ID,
          'cu-1',
          allowComputerUse,
        )
      } else {
        useChatStore.getState().respondToComputerUsePermission(
          TEST_SESSION_ID,
          'cu-1',
          allowComputerUse,
        )
        session = useChatStore.getState().sessions[TEST_SESSION_ID]
        expect(session?.pendingComputerUsePermissions).toEqual({})
        expect(session?.pendingPermissions).toHaveProperty('perm-read-1')
        expect(session?.chatState).toBe('permission_pending')
        useChatStore.getState().respondToPermission(TEST_SESSION_ID, 'perm-read-1', true)
      }

      session = useChatStore.getState().sessions[TEST_SESSION_ID]
      expect(session?.pendingPermission).toBeNull()
      expect(session?.pendingComputerUsePermission).toBeNull()
      expect(session?.chatState).toBe('tool_executing')
    }
  })

  it('queues concurrent Computer Use permissions until each is answered', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession(),
      },
    })
    const store = useChatStore.getState()

    for (const requestId of ['cu-1', 'cu-2']) {
      store.handleServerMessage(TEST_SESSION_ID, {
        type: 'computer_use_permission_request',
        requestId,
        request: {
          requestId,
          reason: `Computer Use ${requestId}`,
          apps: [],
          requestedFlags: {},
          screenshotFiltering: 'native',
        },
      })
    }

    let session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(Object.keys(session?.pendingComputerUsePermissions ?? {})).toEqual([
      'cu-1',
      'cu-2',
    ])
    expect(session?.pendingComputerUsePermission?.requestId).toBe('cu-1')

    const response = {
      granted: [],
      denied: [],
      flags: {
        clipboardRead: false,
        clipboardWrite: false,
        systemKeyCombos: false,
      },
      userConsented: true,
    }
    store.handleServerMessage(TEST_SESSION_ID, {
      type: 'permission_resolved',
      requestId: 'cu-1',
      permissionType: 'computer_use',
      allowed: true,
    })

    session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.pendingComputerUsePermissions).not.toHaveProperty('cu-1')
    expect(session?.pendingComputerUsePermissions).toHaveProperty('cu-2')
    expect(session?.pendingComputerUsePermission?.requestId).toBe('cu-2')
    expect(session?.chatState).toBe('permission_pending')

    store.respondToComputerUsePermission(TEST_SESSION_ID, 'cu-2', response)
    session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.pendingComputerUsePermissions).toEqual({})
    expect(session?.pendingComputerUsePermission).toBeNull()
    expect(session?.chatState).toBe('tool_executing')
  })

  it('shows the latest Computer Use payload when a request id is superseded', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession(),
      },
    })
    const store = useChatStore.getState()
    const sendRequest = (reason: string) => {
      store.handleServerMessage(TEST_SESSION_ID, {
        type: 'computer_use_permission_request',
        requestId: 'cu-1',
        request: {
          requestId: 'cu-1',
          reason,
          apps: [],
          requestedFlags: {},
          screenshotFiltering: 'native',
        },
      })
    }

    sendRequest('OLD request')
    sendRequest('NEW request')

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.pendingComputerUsePermission?.request.reason).toBe('NEW request')
    expect(session?.pendingComputerUsePermissions?.['cu-1']?.request.reason).toBe('NEW request')
  })

  it('sends permission mode updates to the active session only', () => {
    useChatStore.getState().setSessionPermissionMode('nonexistent-session', 'acceptEdits')
    expect(sendMock).not.toHaveBeenCalled()

    useChatStore.setState({
      sessions: {
        'session-1': {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
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
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })
    useChatStore.getState().setSessionPermissionMode('session-1', 'acceptEdits')

    expect(sendMock).toHaveBeenCalledWith('session-1', {
      type: 'set_permission_mode',
      mode: 'acceptEdits',
    })
    expect(updateSessionPermissionModeMock).not.toHaveBeenCalled()

    useChatStore.getState().handleServerMessage('session-1', {
      type: 'permission_mode_changed',
      mode: 'acceptEdits',
    })

    expect(updateSessionPermissionModeMock).toHaveBeenCalledWith('session-1', 'acceptEdits')
  })

  it('does not send permission mode updates while the session turn is active', () => {
    useChatStore.setState({
      sessions: {
        'session-1': makeSession({ chatState: 'thinking' }),
      },
    })

    useChatStore.getState().setSessionPermissionMode('session-1', 'acceptEdits')

    expect(sendMock).not.toHaveBeenCalledWith('session-1', {
      type: 'set_permission_mode',
      mode: 'acceptEdits',
    })
  })

  it('mirrors CLI permission-mode broadcasts locally without echoing back to the server', () => {
    sendMock.mockReset()
    updateSessionPermissionModeMock.mockReset()

    // CLI 退出 plan 后恢复到 bypassPermissions，回传 permission_mode_changed。
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'permission_mode_changed',
      mode: 'bypassPermissions',
    })

    // 本地镜像被校正……
    expect(updateSessionPermissionModeMock).toHaveBeenCalledWith(TEST_SESSION_ID, 'bypassPermissions')
    // ……但绝不能再 set_permission_mode 回发给 CLI，否则形成回环。
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('mirrors CLI-originated Auto mode without echoing it back to the server', () => {
    sendMock.mockReset()
    updateSessionPermissionModeMock.mockReset()

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'permission_mode_changed',
      mode: 'auto' as never,
    })

    expect(updateSessionPermissionModeMock).toHaveBeenCalledWith(TEST_SESSION_ID, 'auto')
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('stores terminal task notifications for agent tool cards', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
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
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'task_notification',
      data: {
        task_id: 'agent-task-1',
        tool_use_id: 'agent-tool-1',
        status: 'completed',
        summary: 'Agent "修复异常处理" completed',
        result: '修复了异常处理并补充了回归覆盖。',
        output_file: '/tmp/agent-output.txt',
      },
    })

    expect(
      useChatStore.getState().sessions[TEST_SESSION_ID]?.agentTaskNotifications[
        'agent-tool-1'
      ],
    ).toMatchObject({
      taskId: 'agent-task-1',
      toolUseId: 'agent-tool-1',
      status: 'completed',
      summary: 'Agent "修复异常处理" completed',
      result: '修复了异常处理并补充了回归覆盖。',
      outputFile: '/tmp/agent-output.txt',
    })
  })

  it('tracks background agent task lifecycle without duplicating transcript cards', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-06T00:00:01.000Z'))

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'tool_executing',
        }),
      },
    })

    vi.setSystemTime(new Date('2026-04-06T00:00:02.000Z'))

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'task_started',
      data: {
        task_id: 'agent-task-1',
        tool_use_id: 'agent-tool-1',
        description: 'Verify the todo app',
        task_type: 'local_agent',
        prompt: 'Run E2E verification',
      },
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.backgroundAgentTasks?.['agent-task-1']).toMatchObject({
      taskId: 'agent-task-1',
      toolUseId: 'agent-tool-1',
      status: 'running',
      description: 'Verify the todo app',
      taskType: 'local_agent',
      prompt: 'Run E2E verification',
    })
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toHaveLength(0)

    vi.setSystemTime(new Date('2026-04-06T00:00:03.000Z'))

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'task_progress',
      data: {
        task_id: 'agent-task-1',
        tool_use_id: 'agent-tool-1',
        description: 'Verify the todo app',
        summary: 'Running Playwright checks',
        last_tool_name: 'Bash',
        usage: {
          total_tokens: 1200,
          tool_uses: 4,
          duration_ms: 45000,
        },
      },
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.backgroundAgentTasks?.['agent-task-1']).toMatchObject({
      status: 'running',
      summary: 'Running Playwright checks',
      lastToolName: 'Bash',
      usage: {
        totalTokens: 1200,
        toolUses: 4,
        durationMs: 45000,
      },
    })
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toHaveLength(0)

    vi.setSystemTime(new Date('2026-04-06T00:00:04.000Z'))

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'task_notification',
      data: {
        task_id: 'agent-task-1',
        tool_use_id: 'agent-tool-1',
        status: 'completed',
        summary: 'Found and fixed localStorage corruption.',
        result: 'Root cause was a stale session cache entry.',
        output_file: '/tmp/agent-output.txt',
        usage: {
          total_tokens: 2400,
          tool_uses: 9,
          duration_ms: 120000,
        },
      },
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.backgroundAgentTasks?.['agent-task-1']).toMatchObject({
      status: 'completed',
      summary: 'Found and fixed localStorage corruption.',
      outputFile: '/tmp/agent-output.txt',
      usage: {
        totalTokens: 2400,
        toolUses: 9,
        durationMs: 120000,
      },
    })
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.agentTaskNotifications['agent-tool-1']).toMatchObject({
      status: 'completed',
      summary: 'Found and fixed localStorage corruption.',
      result: 'Root cause was a stale session cache entry.',
      outputFile: '/tmp/agent-output.txt',
    })
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toHaveLength(0)

    vi.setSystemTime(new Date('2026-04-06T00:00:05.000Z'))

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'task_progress',
      data: {
        task_id: 'agent-task-1',
        tool_use_id: 'agent-tool-1',
        status: 'running',
        summary: 'Resumed review',
      },
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.backgroundAgentTasks?.['agent-task-1']).toMatchObject({
      status: 'running',
      startedAt: new Date('2026-04-06T00:00:05.000Z').getTime(),
      summary: 'Resumed review',
    })

    vi.setSystemTime(new Date('2026-04-06T00:00:06.000Z'))

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'task_notification',
      data: {
        task_id: 'agent-task-1',
        tool_use_id: 'agent-tool-1',
        status: 'completed',
        summary: 'Second lifecycle complete.',
      },
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.backgroundAgentTasks?.['agent-task-1']).toMatchObject({
      status: 'completed',
      startedAt: new Date('2026-04-06T00:00:05.000Z').getTime(),
      summary: 'Second lifecycle complete.',
    })

    vi.setSystemTime(new Date('2026-04-06T00:00:07.000Z'))

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'task_notification',
      data: {
        task_id: 'agent-task-1',
        tool_use_id: 'agent-tool-1',
        status: 'completed',
        summary: 'Third lifecycle complete without progress.',
        result: 'The resumed agent finished without using another tool.',
      },
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.backgroundAgentTasks?.['agent-task-1']).toMatchObject({
      status: 'completed',
      startedAt: new Date('2026-04-06T00:00:07.000Z').getTime(),
      summary: 'Third lifecycle complete without progress.',
      result: 'The resumed agent finished without using another tool.',
    })
    vi.useRealTimers()
  })

  it('keeps idle chat state while marking the tab running for background task start and progress', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'idle',
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'task_started',
      data: {
        task_id: 'agent-task-1',
        tool_use_id: 'agent-tool-1',
        description: 'Verify the todo app',
        task_type: 'local_agent',
      },
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.chatState).toBe('idle')
    expect(updateTabStatusMock).toHaveBeenLastCalledWith(TEST_SESSION_ID, 'running')

    updateTabStatusMock.mockClear()

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'task_progress',
      data: {
        task_id: 'agent-task-1',
        tool_use_id: 'agent-tool-1',
        summary: 'Still reviewing',
      },
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.chatState).toBe('idle')
    expect(updateTabStatusMock).toHaveBeenLastCalledWith(TEST_SESSION_ID, 'running')
  })

  it('keeps non-agent background tasks visible and updates the existing transcript card', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-06T00:00:01.000Z'))

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession(),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'task_started',
      data: {
        task_id: 'shell-task-1',
        tool_use_id: 'shell-tool-1',
        description: 'Run desktop checks',
        task_type: 'local_bash',
      },
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      {
        type: 'background_task',
        task: {
          taskId: 'shell-task-1',
          toolUseId: 'shell-tool-1',
          status: 'running',
          taskType: 'local_bash',
          description: 'Run desktop checks',
        },
      },
    ])
    const insertedTaskTimestamp = useChatStore.getState().sessions[TEST_SESSION_ID]?.messages[0]?.timestamp

    vi.setSystemTime(new Date('2026-04-06T00:00:02.000Z'))

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'task_progress',
      data: {
        task_id: 'shell-task-1',
        tool_use_id: 'shell-tool-1',
        description: 'Run desktop checks',
        summary: 'Running Vitest',
        last_tool_name: 'Bash',
        task_type: 'local_bash',
      },
    })

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.messages).toHaveLength(1)
    expect(session?.messages[0]).toMatchObject({
      type: 'background_task',
      task: {
        taskId: 'shell-task-1',
        status: 'running',
        summary: 'Running Vitest',
        lastToolName: 'Bash',
      },
    })
    expect(session?.messages[0]?.timestamp).toBe(insertedTaskTimestamp)
    vi.useRealTimers()
  })

  it('marks a background shell task stopped when TaskStop returns before a task notification', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-19T13:34:19.000Z'))

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession(),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'task_started',
      data: {
        task_id: 'shell-task-1',
        tool_use_id: 'shell-tool-1',
        description: 'Start tap proxy',
        task_type: 'local_bash',
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'tool_use_complete',
      toolName: 'TaskStop',
      toolUseId: 'task-stop-1',
      input: { task_id: 'shell-task-1' },
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'tool_result',
      toolUseId: 'task-stop-1',
      isError: false,
      content: JSON.stringify({
        message: 'Successfully stopped task: shell-task-1 (tap proxy)',
        task_id: 'shell-task-1',
        task_type: 'local_bash',
        command: 'tap proxy',
      }),
    })

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.backgroundAgentTasks?.['shell-task-1']).toMatchObject({
      status: 'stopped',
      taskType: 'local_bash',
      description: 'tap proxy',
    })
    expect(session?.messages.find((message) => message.type === 'background_task')).toMatchObject({
      type: 'background_task',
      task: {
        taskId: 'shell-task-1',
        status: 'stopped',
        taskType: 'local_bash',
        description: 'tap proxy',
      },
    })

    vi.useRealTimers()
  })

  it('removes stale agent task transcript cards by matching tool use id', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          messages: [{
            id: 'background-task-old-agent-task',
            type: 'background_task',
            timestamp: 1,
            task: {
              taskId: 'old-agent-task',
              toolUseId: 'agent-tool-1',
              status: 'running',
              taskType: 'local_agent',
              startedAt: 1,
              updatedAt: 1,
            },
          }],
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'task_started',
      data: {
        task_id: 'new-agent-task',
        tool_use_id: 'agent-tool-1',
        task_type: 'local_agent',
        description: 'Review app',
      },
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toHaveLength(0)
  })

  it('keeps auto-dream background tasks out of the transcript while tracking lifecycle', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-06T00:00:01.000Z'))

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession(),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'task_started',
      data: {
        task_id: 'dream-task-1',
        task_type: 'dream',
        description: 'dreaming',
      },
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.backgroundAgentTasks?.['dream-task-1']).toMatchObject({
      taskId: 'dream-task-1',
      status: 'running',
      taskType: 'dream',
      description: 'dreaming',
    })
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toHaveLength(0)

    vi.setSystemTime(new Date('2026-04-06T00:00:02.000Z'))

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'task_notification',
      data: {
        task_id: 'dream-task-1',
        status: 'completed',
        summary: 'Auto-dream completed',
      },
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.backgroundAgentTasks?.['dream-task-1']).toMatchObject({
      status: 'completed',
      taskType: 'dream',
      summary: 'Auto-dream completed',
    })
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toHaveLength(0)

    vi.useRealTimers()
  })

  it('requests a background task stop and waits for the terminal event', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'idle',
          backgroundAgentTasks: {
            'bash-task-1': {
              taskId: 'bash-task-1',
              taskType: 'local_bash',
              status: 'running',
              startedAt: 1,
              updatedAt: 1,
            },
          },
        }),
      },
    })

    useChatStore.getState().stopBackgroundTask(TEST_SESSION_ID, 'bash-task-1')

    expect(sendMock).toHaveBeenCalledWith(TEST_SESSION_ID, {
      type: 'stop_background_task',
      taskId: 'bash-task-1',
    })
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.stoppingBackgroundTaskIds).toEqual({
      'bash-task-1': true,
    })
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.backgroundAgentTasks?.['bash-task-1']?.status).toBe('running')

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'task_notification',
      data: {
        task_id: 'bash-task-1',
        status: 'stopped',
        summary: 'Sleep stopped',
      },
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.backgroundAgentTasks?.['bash-task-1']?.status).toBe('stopped')
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.stoppingBackgroundTaskIds).toEqual({})
  })

  it('clears the pending stop marker when the server rejects the request', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'idle',
          backgroundAgentTasks: {
            'bash-task-1': {
              taskId: 'bash-task-1',
              taskType: 'local_bash',
              status: 'running',
              startedAt: 1,
              updatedAt: 1,
            },
          },
          stoppingBackgroundTaskIds: { 'bash-task-1': true },
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'background_task_stop_failed',
      taskId: 'bash-task-1',
      message: 'Task is not running',
    })

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.stoppingBackgroundTaskIds).toEqual({})
    expect(session?.messages.at(-1)).toMatchObject({
      type: 'error',
      code: 'STOP_BACKGROUND_TASK_FAILED',
      message: 'Task is not running',
    })
  })

  it('does not surface a stop error when the task already finished naturally', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'idle',
          messages: [{ id: 'done', type: 'assistant_text', content: 'Done', timestamp: 1 }],
          backgroundAgentTasks: {
            'bash-task-1': {
              taskId: 'bash-task-1',
              taskType: 'local_bash',
              status: 'completed',
              startedAt: 1,
              updatedAt: 2,
            },
          },
          stoppingBackgroundTaskIds: { 'bash-task-1': true },
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'background_task_stop_failed',
      taskId: 'bash-task-1',
      message: 'Task is not running',
    })

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.stoppingBackgroundTaskIds).toEqual({})
    expect(session?.messages).toHaveLength(1)
  })

  it('replays a cold reconnect stop failure after task history hydrates', async () => {
    vi.mocked(sessionsApi.getMessages).mockResolvedValueOnce({
      messages: [],
      taskNotifications: [],
    })
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          historyStatus: 'loading',
          backgroundAgentTasks: {},
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'background_task_stop_failed',
      taskId: 'agent-task-cold-reconnect',
      message: 'Remote archive could not be confirmed',
    })
    expect(
      useChatStore.getState().sessions[TEST_SESSION_ID]?.pendingBackgroundTaskStopFailures,
    ).toEqual({
      'agent-task-cold-reconnect': 'Remote archive could not be confirmed',
    })

    useChatStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [TEST_SESSION_ID]: {
          ...state.sessions[TEST_SESSION_ID]!,
          backgroundAgentTasks: {
            'agent-task-cold-reconnect': {
              taskId: 'agent-task-cold-reconnect',
              toolUseId: 'agent-tool-cold-reconnect',
              taskType: 'remote_agent',
              status: 'running',
              startedAt: 1,
              updatedAt: 2,
            },
          },
        },
      },
    }))
    await useChatStore.getState().loadHistory(TEST_SESSION_ID)

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.pendingBackgroundTaskStopFailures).toEqual({})
    expect(session?.backgroundAgentTasks?.['agent-task-cold-reconnect']?.status).toBe('running')
    expect(session?.messages.at(-1)).toMatchObject({
      type: 'error',
      code: 'STOP_BACKGROUND_TASK_FAILED',
      message: 'Remote archive could not be confirmed',
    })
  })

  it('surfaces a cold reconnect stop failure when task history fails to load', async () => {
    let rejectHistory!: (error: Error) => void
    vi.mocked(sessionsApi.getMessages).mockReturnValueOnce(new Promise((_resolve, reject) => {
      rejectHistory = reject
    }))
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'idle',
          backgroundAgentTasks: {},
        }),
      },
    })

    const historyLoad = useChatStore.getState().loadHistory(TEST_SESSION_ID)
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.historyStatus).toBe('loading')

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'background_task_stop_failed',
      taskId: 'agent-task-missing-history',
      message: 'Agent could not be stopped',
    })
    rejectHistory(new Error('History unavailable'))
    await historyLoad

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.historyStatus).toBe('error')
    expect(session?.historyError).toBe('History unavailable')
    expect(session?.pendingBackgroundTaskStopFailures).toEqual({})
    expect(session?.messages.at(-1)).toMatchObject({
      type: 'error',
      code: 'STOP_BACKGROUND_TASK_FAILED',
      message: 'Agent could not be stopped',
    })
  })

  it('does not leave history loading after a failed stale request', async () => {
    let rejectHistory!: (error: Error) => void
    vi.mocked(sessionsApi.getMessages).mockReturnValueOnce(new Promise((_resolve, reject) => {
      rejectHistory = reject
    }))
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({ chatState: 'idle' }),
      },
    })

    const historyLoad = useChatStore.getState().loadHistory(TEST_SESSION_ID)
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.historyStatus).toBe('loading')
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'user_message_replay',
      content: 'A newer externally started turn',
    })

    rejectHistory(new Error('Stale history failed'))
    await historyLoad

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.historyStatus).toBe('idle')
    expect(session?.historyError).toBeNull()
    expect(session?.messages).toContainEqual(expect.objectContaining({
      type: 'user_text',
      content: 'A newer externally started turn',
    }))
  })

  it('flushes a cached stop failure when a task start makes history stale', async () => {
    let resolveHistory!: (value: { messages: MessageEntry[]; taskNotifications: [] }) => void
    let resolveReload!: (value: { messages: MessageEntry[]; taskNotifications: [] }) => void
    vi.mocked(sessionsApi.getMessages)
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveHistory = resolve
      }))
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveReload = resolve
      }))
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({ chatState: 'idle' }),
      },
    })

    const historyLoad = useChatStore.getState().loadHistory(TEST_SESSION_ID)
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'background_task_stop_failed',
      taskId: 'agent-task-cold-order',
      message: 'Agent was still starting',
    })
    expect(
      useChatStore.getState().sessions[TEST_SESSION_ID]?.pendingBackgroundTaskStopFailures,
    ).toEqual({ 'agent-task-cold-order': 'Agent was still starting' })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'task_started',
      data: {
        task_id: 'agent-task-cold-order',
        tool_use_id: 'agent-tool-cold-order',
        task_type: 'local_agent',
        description: 'Late task start',
      },
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'session_state',
      turnState: 'idle',
    })
    resolveHistory({ messages: [], taskNotifications: [] })
    await historyLoad

    await vi.waitFor(() => {
      expect(sessionsApi.getMessages).toHaveBeenCalledTimes(2)
    })
    resolveReload({
      messages: [{
        id: 'stale-reload-answer',
        type: 'assistant',
        timestamp: '2026-07-10T00:00:00.000Z',
        content: [{ type: 'text', text: 'stale reload answer' }],
      }],
      taskNotifications: [],
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.historyStatus).toBe('idle')
    expect(session?.pendingBackgroundTaskStopFailures).toEqual({})
    expect(session?.backgroundAgentTasks?.['agent-task-cold-order']?.status).toBe('running')
    expect(session?.messages.at(-1)).toMatchObject({
      type: 'error',
      code: 'STOP_BACKGROUND_TASK_FAILED',
      message: 'Agent was still starting',
    })
    expect(session?.messages).not.toContainEqual(expect.objectContaining({
      type: 'assistant_text',
      content: 'stale reload answer',
    }))
  })

  it('clears local desktop chat state when the server confirms /clear', () => {
    vi.useFakeTimers()

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: {
          messages: [
            { id: 'u1', type: 'user_text', content: '/clear', timestamp: Date.now() },
            { id: 'a1', type: 'assistant_text', content: 'old context', timestamp: Date.now() },
          ],
          chatState: 'thinking',
          connectionState: 'connected',
          streamingText: 'pending',
          streamingToolInput: 'tool',
          activeToolUseId: 'tool-1',
          activeToolName: 'Read',
          activeThinkingId: 'thinking-1',
          pendingPermission: null,
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 12, output_tokens: 34 },
          streamingResponseChars: 999,
          elapsedSeconds: 5,
          statusVerb: 'Thinking',
          slashCommands: [],
          agentTaskNotifications: {},
          queuedUserMessages: [{
            id: 'queued-before-clear',
            content: 'do not replay after clear',
            displayContent: 'do not replay after clear',
            attachments: [],
            createdAt: Date.now(),
          }],
          elapsedTimer: null,
        },
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_delta',
      text: 'stale throttled delta',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'session_cleared',
      message: 'Conversation cleared',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 0, output_tokens: 0 },
    })

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.messages).toEqual([])
    expect(session?.queuedUserMessages).toEqual([])
    expect(sendMock).not.toHaveBeenCalledWith(TEST_SESSION_ID, {
      type: 'user_message',
      content: 'do not replay after clear',
      attachments: [],
    })
    expect(session?.streamingText).toBe('')
    expect(session?.chatState).toBe('idle')
    expect(session?.tokenUsage).toEqual({ input_tokens: 0, output_tokens: 0 })
    expect(session?.streamingResponseChars).toBe(0)
    expect(session?.slashCommands).toEqual([])
    expect(clearTasksMock).toHaveBeenCalledWith(TEST_SESSION_ID)
    expect(updateSessionTitleMock).toHaveBeenCalledWith(TEST_SESSION_ID, 'New Session')
    expect(updateSessionMessageCountMock).toHaveBeenCalledWith(TEST_SESSION_ID, 0)

    vi.advanceTimersByTime(60)
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.streamingText).toBe('')
    vi.useRealTimers()
  })

  it('does not restore cleared messages or tasks from an in-flight history load', async () => {
    let resolveHistory!: (value: {
      messages: MessageEntry[]
      taskNotifications: Array<{
        taskId: string
        toolUseId: string
        status: 'completed'
        summary: string
        timestamp: string
      }>
    }) => void
    vi.mocked(sessionsApi.getMessages).mockReturnValueOnce(new Promise((resolve) => {
      resolveHistory = resolve
    }))
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'idle',
          messages: [{ id: 'old-user', type: 'user_text', content: 'old turn', timestamp: 1 }],
          backgroundAgentTasks: {
            'old-agent': {
              taskId: 'old-agent',
              toolUseId: 'old-agent-tool',
              taskType: 'local_agent',
              status: 'running',
              startedAt: 1,
              updatedAt: 2,
            },
          },
        }),
      },
    })

    const historyLoad = useChatStore.getState().loadHistory(TEST_SESSION_ID)
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.historyStatus).toBe('loading')
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'session_cleared',
      message: 'Conversation cleared',
    })

    resolveHistory({
      messages: [
        {
          id: 'stale-user',
          type: 'user',
          timestamp: '2026-07-10T00:00:00.000Z',
          content: 'stale prompt',
        },
        {
          id: 'stale-assistant',
          type: 'assistant',
          timestamp: '2026-07-10T00:00:01.000Z',
          content: [{ type: 'text', text: 'stale answer' }],
        },
      ],
      taskNotifications: [{
        taskId: 'old-agent',
        toolUseId: 'old-agent-tool',
        status: 'completed',
        summary: 'Stale task completion',
        timestamp: '2026-07-10T00:00:02.000Z',
      }],
    })
    await historyLoad

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.messages).toEqual([])
    expect(session?.backgroundAgentTasks).toEqual({})
    expect(session?.agentTaskNotifications).toEqual({})
    expect(session?.historyStatus).toBe('ready')
  })

  it('clears local message state for only the requested session', () => {
    useChatStore.setState({
      sessions: {
        'session-a': makeSession({
          messages: [{ id: 'a1', type: 'assistant_text', content: 'A old', timestamp: 1 }],
          streamingText: 'A pending',
        }),
        'session-b': makeSession({
          messages: [{ id: 'b1', type: 'assistant_text', content: 'B old', timestamp: 1 }],
          streamingText: 'B pending',
        }),
      },
    })

    useChatStore.getState().clearMessages('session-a')

    expect(useChatStore.getState().sessions['session-a']?.messages).toEqual([])
    expect(useChatStore.getState().sessions['session-a']?.streamingText).toBe('')
    expect(useChatStore.getState().sessions['session-b']?.messages).toMatchObject([
      { content: 'B old' },
    ])
  })

  it('renders compact boundary notifications as compact summary cards', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: {
          messages: [
            { id: 'old-user', type: 'user_text', content: 'Build the billing import flow', timestamp: 1 },
            { id: 'old-assistant', type: 'assistant_text', content: 'Implemented the flow.', timestamp: 2 },
          ],
          chatState: 'idle',
          connectionState: 'connected',
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
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'compact_boundary',
      message: 'Context compacted',
      data: { trigger: 'auto', pre_tokens: 120000 },
    })

    const messages = useChatStore.getState().sessions[TEST_SESSION_ID]?.messages ?? []
    expect(messages).toHaveLength(3)
    expect(messages).toMatchObject([
      { id: 'old-user', type: 'user_text', content: 'Build the billing import flow' },
      { id: 'old-assistant', type: 'assistant_text', content: 'Implemented the flow.' },
      {
        type: 'compact_summary',
        title: 'Context compacted',
        trigger: 'auto',
        preTokens: 120000,
      },
    ])
    // The context usage indicator watches this counter to force an
    // immediate post-compact refresh (#743). The seeded session state above
    // intentionally lacks compactCount (legacy persisted shape) — the bump
    // must tolerate that.
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.compactCount).toBe(1)

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'compact_boundary',
      message: 'Context compacted',
      data: { trigger: 'manual' },
    })
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.compactCount).toBe(2)
  })

  it('attaches compact summary content to the latest compact card', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: {
          messages: [],
          chatState: 'compacting',
          connectionState: 'connected',
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
          statusVerb: 'Compacting conversation',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'compact_boundary',
      message: 'Context compacted',
      data: { trigger: 'manual' },
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'compact_summary',
      message: [
        'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.',
        '',
        'Implemented the billing report and verified export behavior.',
        '',
        'If you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: /tmp/session.jsonl',
      ].join('\n'),
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.chatState).toBe('thinking')
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      {
        type: 'compact_summary',
        trigger: 'manual',
        summary: 'Implemented the billing report and verified export behavior.',
      },
    ])
  })

  it('tracks compacting status as an active chat state', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: {
          messages: [
            { id: 'old-user', type: 'user_text', content: 'old context', timestamp: 1 },
          ],
          chatState: 'thinking',
          connectionState: 'connected',
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
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'status',
      state: 'compacting',
      verb: 'Compacting conversation',
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.chatState).toBe('compacting')
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.statusVerb).toBe('Compacting conversation')
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      {
        id: 'old-user',
        type: 'user_text',
        content: 'old context',
      },
      {
        type: 'compact_summary',
        phase: 'compacting',
      },
    ])
    expect(updateTabStatusMock).toHaveBeenLastCalledWith(TEST_SESSION_ID, 'running')
  })

  it('removes the transient compacting card when compaction is canceled', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: {
          messages: [
            { id: 'old-user', type: 'user_text', content: 'old context', timestamp: 1 },
          ],
          chatState: 'thinking',
          connectionState: 'connected',
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
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'status',
      state: 'compacting',
      verb: 'Compacting conversation',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'error',
      message: 'Compaction canceled.',
      code: 'aborted',
    })

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.statusVerb).toBe('')
    expect(session?.messages).toMatchObject([
      {
        id: 'old-user',
        type: 'user_text',
        content: 'old context',
      },
      {
        type: 'error',
        message: 'Compaction canceled.',
      },
    ])
    expect(session?.messages.some((message) => message.type === 'compact_summary' && message.phase === 'compacting')).toBe(false)
    expect(updateTabStatusMock).toHaveBeenLastCalledWith(TEST_SESSION_ID, 'error')
  })

  it('preserves business error codes from server error messages', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          messages: [],
          chatState: 'streaming',
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'error',
      message: 'This model does not support images.',
      code: 'invalid_request',
      businessErrorCode: 'image_unsupported',
    })

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.messages[session.messages.length - 1]).toMatchObject({
      type: 'error',
      message: 'This model does not support images.',
      code: 'invalid_request',
      businessErrorCode: 'image_unsupported',
    })
  })

  it('removes the transient compacting card when compacting status ends without a boundary', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: {
          messages: [
            { id: 'old-user', type: 'user_text', content: 'old context', timestamp: 1 },
          ],
          chatState: 'thinking',
          connectionState: 'connected',
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
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'status',
      state: 'compacting',
      verb: 'Compacting conversation',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'status',
      state: 'thinking',
      verb: 'Thinking',
    })

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.chatState).toBe('thinking')
    expect(session?.messages).toMatchObject([
      {
        id: 'old-user',
        type: 'user_text',
        content: 'old context',
      },
    ])
    expect(session?.messages.some((message) => message.type === 'compact_summary' && message.phase === 'compacting')).toBe(false)
    expect(updateTabStatusMock).toHaveBeenLastCalledWith(TEST_SESSION_ID, 'running')
  })

  it('starts an elapsed timer when a reconnected session reports running status', () => {
    vi.useFakeTimers()

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'idle',
          elapsedSeconds: 0,
          elapsedTimer: null,
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'status',
      state: 'thinking',
      verb: 'Thinking',
    })

    vi.advanceTimersByTime(2100)

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.elapsedSeconds).toBe(2)

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'status',
      state: 'idle',
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.elapsedTimer).toBeNull()

    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('reloads authoritative history when a reconnect finds the turn already idle', async () => {
    vi.mocked(sessionsApi.getMessages).mockClear()
    vi.mocked(sessionsApi.getMessages).mockResolvedValueOnce({
      messages: [
        {
          id: 'completed-assistant',
          type: 'assistant',
          timestamp: '2026-07-10T00:00:00.000Z',
          content: [{ type: 'text', text: 'Finished while the socket was offline.' }],
        },
      ],
    })
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'thinking',
          streamingText: 'stale partial',
          messages: [{ id: 'user-1', type: 'user_text', content: 'long task', timestamp: 1 }],
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'session_state',
      turnState: 'idle',
    })

    await vi.waitFor(() => {
      expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toContainEqual(
        expect.objectContaining({
          type: 'assistant_text',
          content: 'Finished while the socket was offline.',
        }),
      )
    })
    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(sessionsApi.getMessages).toHaveBeenCalledWith(TEST_SESSION_ID)
    expect(session?.streamingText).toBe('')
    expect(session?.messages).toContainEqual(expect.objectContaining({
      type: 'assistant_text',
      content: 'Finished while the socket was offline.',
    }))
  })

  it('reconciles a persisted stopped SubAgent after its terminal event was missed offline', async () => {
    vi.mocked(sessionsApi.getMessages).mockClear()
    vi.mocked(sessionsApi.getMessages).mockResolvedValueOnce({
      messages: [],
      taskNotifications: [
        {
          taskId: 'agent-task-1',
          toolUseId: 'agent-tool-1',
          status: 'stopped',
          summary: 'Agent was stopped while the renderer was offline',
          timestamp: '2026-07-10T00:00:00.000Z',
        },
      ],
    })
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'idle',
          stopAllSubagentsRequested: true,
          backgroundAgentTasks: {
            'agent-task-1': {
              taskId: 'agent-task-1',
              toolUseId: 'agent-tool-1',
              status: 'running',
              taskType: 'local_agent',
              description: 'Review screenshots',
              startedAt: 1,
              updatedAt: 2,
            },
          },
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'session_state',
      turnState: 'idle',
    })

    await vi.waitFor(() => {
      expect(
        useChatStore.getState().sessions[TEST_SESSION_ID]
          ?.backgroundAgentTasks?.['agent-task-1']?.status,
      ).toBe('stopped')
    })
    expect(sessionsApi.getMessages).toHaveBeenCalledWith(TEST_SESSION_ID)
    expect(updateTabStatusMock).toHaveBeenLastCalledWith(TEST_SESSION_ID, 'idle')
  })

  it('keeps a genuinely running SubAgent when idle reconnect history has no terminal event', async () => {
    vi.mocked(sessionsApi.getMessages).mockClear()
    vi.mocked(sessionsApi.getMessages).mockResolvedValueOnce({
      messages: [],
      taskNotifications: [],
    })
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'idle',
          backgroundAgentTasks: {
            'agent-task-1': {
              taskId: 'agent-task-1',
              toolUseId: 'agent-tool-1',
              status: 'running',
              taskType: 'local_agent',
              description: 'Still reviewing screenshots',
              startedAt: 1,
              updatedAt: 2,
            },
          },
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'session_state',
      turnState: 'idle',
    })

    await vi.waitFor(() => {
      expect(sessionsApi.getMessages).toHaveBeenCalledWith(TEST_SESSION_ID)
      expect(updateTabStatusMock).toHaveBeenLastCalledWith(TEST_SESSION_ID, 'running')
    })
    expect(
      useChatStore.getState().sessions[TEST_SESSION_ID]
        ?.backgroundAgentTasks?.['agent-task-1']?.status,
    ).toBe('running')
  })

  it('does not let an older persisted terminal overwrite a new lifecycle with the same Agent id', async () => {
    vi.mocked(sessionsApi.getMessages).mockClear()
    vi.mocked(sessionsApi.getMessages).mockResolvedValueOnce({
      messages: [],
      taskNotifications: [
        {
          taskId: 'agent-task-reused',
          toolUseId: 'agent-tool-reused',
          status: 'stopped',
          summary: 'Previous lifecycle stopped',
          timestamp: '2026-07-10T00:00:00.000Z',
        },
      ],
    })
    const newLifecycleStartedAt = new Date('2026-07-11T00:00:00.000Z').getTime()
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'idle',
          backgroundAgentTasks: {
            'agent-task-reused': {
              taskId: 'agent-task-reused',
              toolUseId: 'agent-tool-reused',
              status: 'running',
              taskType: 'local_agent',
              description: 'New lifecycle is still reviewing',
              startedAt: newLifecycleStartedAt,
              updatedAt: newLifecycleStartedAt,
            },
          },
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'session_state',
      turnState: 'idle',
    })

    await vi.waitFor(() => {
      expect(sessionsApi.getMessages).toHaveBeenCalledWith(TEST_SESSION_ID)
      expect(updateTabStatusMock).toHaveBeenLastCalledWith(TEST_SESSION_ID, 'running')
    })
    expect(
      useChatStore.getState().sessions[TEST_SESSION_ID]
        ?.backgroundAgentTasks?.['agent-task-reused']?.status,
    ).toBe('running')
  })

  it('lets fresh reconnect reconciliation follow an older in-flight history load', async () => {
    let resolveOlderHistory!: (value: { messages: MessageEntry[]; taskNotifications: [] }) => void
    vi.mocked(sessionsApi.getMessages).mockClear()
    vi.mocked(sessionsApi.getMessages)
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveOlderHistory = resolve
      }))
      .mockResolvedValueOnce({
        messages: [],
        taskNotifications: [
          {
            taskId: 'agent-task-history-order',
            toolUseId: 'agent-tool-history-order',
            status: 'stopped',
            summary: 'Fresh history observed the stopped Agent',
            timestamp: '2026-07-12T00:00:00.000Z',
          },
        ],
      })
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'idle',
          backgroundAgentTasks: {
            'agent-task-history-order': {
              taskId: 'agent-task-history-order',
              toolUseId: 'agent-tool-history-order',
              status: 'running',
              taskType: 'local_agent',
              startedAt: 1,
              updatedAt: 2,
            },
          },
        }),
      },
    })

    const olderLoad = useChatStore.getState().loadHistory(TEST_SESSION_ID)
    await vi.waitFor(() => {
      expect(sessionsApi.getMessages).toHaveBeenCalledTimes(1)
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'session_state',
      turnState: 'idle',
    })
    resolveOlderHistory({ messages: [], taskNotifications: [] })
    await olderLoad

    await vi.waitFor(() => {
      expect(sessionsApi.getMessages).toHaveBeenCalledTimes(2)
      expect(
        useChatStore.getState().sessions[TEST_SESSION_ID]
          ?.backgroundAgentTasks?.['agent-task-history-order']?.status,
      ).toBe('stopped')
    })
  })

  it('does not let an older concurrent reload overwrite the latest history snapshot', async () => {
    let resolveOlderReload!: (value: { messages: MessageEntry[]; taskNotifications: [] }) => void
    let resolveLatestReload!: (value: { messages: MessageEntry[]; taskNotifications: [] }) => void
    vi.mocked(sessionsApi.getMessages)
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveOlderReload = resolve
      }))
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveLatestReload = resolve
      }))
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'idle',
          backgroundAgentTasks: {
            'agent-task-concurrent-reload': {
              taskId: 'agent-task-concurrent-reload',
              toolUseId: 'agent-tool-concurrent-reload',
              taskType: 'local_agent',
              status: 'running',
              startedAt: 1,
              updatedAt: 2,
            },
          },
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'session_state',
      turnState: 'idle',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'session_state',
      turnState: 'idle',
    })
    await vi.waitFor(() => {
      expect(sessionsApi.getMessages).toHaveBeenCalledTimes(2)
    })

    resolveLatestReload({
      messages: [{
        id: 'latest-history-answer',
        type: 'assistant',
        timestamp: '2026-07-12T00:00:01.000Z',
        content: [{ type: 'text', text: 'latest history answer' }],
      }],
      taskNotifications: [],
    })
    await vi.waitFor(() => {
      expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toContainEqual(
        expect.objectContaining({
          type: 'assistant_text',
          content: 'latest history answer',
        }),
      )
    })

    resolveOlderReload({
      messages: [{
        id: 'older-history-answer',
        type: 'assistant',
        timestamp: '2026-07-12T00:00:00.000Z',
        content: [{ type: 'text', text: 'older history answer' }],
      }],
      taskNotifications: [],
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const messages = useChatStore.getState().sessions[TEST_SESSION_ID]?.messages ?? []
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'assistant_text',
      content: 'latest history answer',
    }))
    expect(messages).not.toContainEqual(expect.objectContaining({
      type: 'assistant_text',
      content: 'older history answer',
    }))
  })

  it('does not let delayed idle task reconciliation overwrite a newly sent turn', async () => {
    let resolveHistory!: (value: {
      messages: MessageEntry[]
      taskNotifications: Array<{
        taskId: string
        toolUseId: string
        status: 'stopped'
        summary: string
        timestamp: string
      }>
    }) => void
    vi.mocked(sessionsApi.getMessages).mockReturnValueOnce(new Promise((resolve) => {
      resolveHistory = resolve
    }))
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'idle',
          stopAllSubagentsRequested: true,
          messages: [{ id: 'old-user', type: 'user_text', content: 'old turn', timestamp: 1 }],
          backgroundAgentTasks: {
            'agent-task-1': {
              taskId: 'agent-task-1',
              toolUseId: 'agent-tool-1',
              status: 'running',
              taskType: 'local_agent',
              description: 'Review screenshots',
              startedAt: 1,
              updatedAt: 2,
            },
          },
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'session_state',
      turnState: 'idle',
    })
    await vi.waitFor(() => {
      expect(sessionsApi.getMessages).toHaveBeenCalledWith(TEST_SESSION_ID)
    })
    useChatStore.getState().sendMessage(TEST_SESSION_ID, 'new turn')

    resolveHistory({
      messages: [],
      taskNotifications: [
        {
          taskId: 'agent-task-1',
          toolUseId: 'agent-tool-1',
          status: 'stopped',
          summary: 'Agent was stopped while the renderer was offline',
          timestamp: '2026-07-10T00:00:00.000Z',
        },
      ],
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.chatState).toBe('thinking')
    expect(session?.messages).toContainEqual(expect.objectContaining({
      type: 'user_text',
      content: 'new turn',
    }))
    expect(session?.backgroundAgentTasks?.['agent-task-1']?.status).toBe('running')
    expect(session?.agentTaskNotifications?.['agent-tool-1']).toBeUndefined()
    if (session?.elapsedTimer) clearInterval(session.elapsedTimer)
  })

  it('does not let delayed idle reconciliation overwrite an externally completed turn', async () => {
    let resolveHistory!: (value: { messages: MessageEntry[]; taskNotifications: [] }) => void
    vi.mocked(sessionsApi.getMessages).mockReturnValueOnce(new Promise((resolve) => {
      resolveHistory = resolve
    }))
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'idle',
          stopAllSubagentsRequested: true,
          messages: [{ id: 'old-user', type: 'user_text', content: 'old turn', timestamp: 1 }],
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'session_state',
      turnState: 'idle',
    })
    await vi.waitFor(() => {
      expect(sessionsApi.getMessages).toHaveBeenCalledTimes(1)
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'user_message_replay',
      content: 'externally started turn',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_start',
      blockType: 'text',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_delta',
      text: 'external answer',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 3, output_tokens: 2 },
    })

    resolveHistory({
      messages: [{
        id: 'stale-assistant',
        type: 'assistant',
        timestamp: '2026-07-10T00:00:00.000Z',
        content: [{ type: 'text', text: 'stale completed answer' }],
      }],
      taskNotifications: [],
    })

    await vi.waitFor(() => {
      const messages = useChatStore.getState().sessions[TEST_SESSION_ID]?.messages ?? []
      expect(messages).toContainEqual(expect.objectContaining({
        type: 'assistant_text',
        content: 'external answer',
      }))
    })
    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.chatState).toBe('idle')
    expect(session?.messages).toContainEqual(expect.objectContaining({
      type: 'user_text',
      content: 'externally started turn',
    }))
    expect(session?.messages).not.toContainEqual(expect.objectContaining({
      type: 'assistant_text',
      content: 'stale completed answer',
    }))
    if (session?.elapsedTimer) clearInterval(session.elapsedTimer)
  })

  it('protects a live completion from reconciliation started after its user replay', async () => {
    let resolveHistory!: (value: { messages: MessageEntry[]; taskNotifications: [] }) => void
    vi.mocked(sessionsApi.getMessages).mockReturnValueOnce(new Promise((resolve) => {
      resolveHistory = resolve
    }))
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'idle',
          backgroundAgentTasks: {
            'agent-task-existing': {
              taskId: 'agent-task-existing',
              toolUseId: 'agent-tool-existing',
              taskType: 'local_agent',
              status: 'running',
              startedAt: 1,
              updatedAt: 2,
            },
          },
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'user_message_replay',
      content: 'external turn already replayed',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'session_state',
      turnState: 'idle',
    })
    await vi.waitFor(() => {
      expect(sessionsApi.getMessages).toHaveBeenCalledTimes(1)
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_start',
      blockType: 'text',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_delta',
      text: 'live completion after replay',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 4, output_tokens: 4 },
    })
    resolveHistory({
      messages: [{
        id: 'stale-after-replay',
        type: 'assistant',
        timestamp: '2026-07-10T00:00:00.000Z',
        content: [{ type: 'text', text: 'stale answer fetched after replay' }],
      }],
      taskNotifications: [],
    })

    await vi.waitFor(() => {
      expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toContainEqual(
        expect.objectContaining({
          type: 'assistant_text',
          content: 'live completion after replay',
        }),
      )
    })
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).not.toContainEqual(
      expect.objectContaining({
        type: 'assistant_text',
        content: 'stale answer fetched after replay',
      }),
    )
  })

  it('does not let delayed idle reconciliation overwrite a live API error', async () => {
    let resolveHistory!: (value: { messages: MessageEntry[]; taskNotifications: [] }) => void
    vi.mocked(sessionsApi.getMessages).mockReturnValueOnce(new Promise((resolve) => {
      resolveHistory = resolve
    }))
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'idle',
          stopAllSubagentsRequested: true,
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'session_state',
      turnState: 'idle',
    })
    await vi.waitFor(() => {
      expect(sessionsApi.getMessages).toHaveBeenCalledTimes(1)
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'error',
      message: 'Model API request failed',
      code: 'API_ERROR',
    })

    resolveHistory({
      messages: [{
        id: 'stale-before-error',
        type: 'assistant',
        timestamp: '2026-07-10T00:00:00.000Z',
        content: [{ type: 'text', text: 'stale answer before error' }],
      }],
      taskNotifications: [],
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.chatState).toBe('idle')
    expect(session?.messages).toContainEqual(expect.objectContaining({
      type: 'error',
      code: 'API_ERROR',
      message: 'Model API request failed',
    }))
    expect(session?.messages).not.toContainEqual(expect.objectContaining({
      type: 'assistant_text',
      content: 'stale answer before error',
    }))
  })

  it('does not let delayed idle reconciliation overwrite a known stop failure', async () => {
    let resolveHistory!: (value: { messages: MessageEntry[]; taskNotifications: [] }) => void
    vi.mocked(sessionsApi.getMessages).mockReturnValueOnce(new Promise((resolve) => {
      resolveHistory = resolve
    }))
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'idle',
          stopAllSubagentsRequested: true,
          stoppingBackgroundTaskIds: { 'agent-task-stop-failed': true },
          backgroundAgentTasks: {
            'agent-task-stop-failed': {
              taskId: 'agent-task-stop-failed',
              toolUseId: 'agent-tool-stop-failed',
              taskType: 'local_agent',
              status: 'running',
              startedAt: 1,
              updatedAt: 2,
            },
          },
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'session_state',
      turnState: 'idle',
    })
    await vi.waitFor(() => {
      expect(sessionsApi.getMessages).toHaveBeenCalledTimes(1)
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'background_task_stop_failed',
      taskId: 'agent-task-stop-failed',
      message: 'The server could not stop this Agent',
    })

    resolveHistory({
      messages: [{
        id: 'stale-assistant',
        type: 'assistant',
        timestamp: '2026-07-10T00:00:00.000Z',
        content: [{ type: 'text', text: 'stale history' }],
      }],
      taskNotifications: [],
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.stoppingBackgroundTaskIds).toEqual({})
    expect(session?.messages).toContainEqual(expect.objectContaining({
      type: 'error',
      code: 'STOP_BACKGROUND_TASK_FAILED',
      message: 'The server could not stop this Agent',
    }))
    expect(session?.messages).not.toContainEqual(expect.objectContaining({
      type: 'assistant_text',
      content: 'stale history',
    }))
  })

  it('does not let delayed idle reconciliation discard a newly started Agent', async () => {
    let resolveHistory!: (value: { messages: MessageEntry[]; taskNotifications: [] }) => void
    vi.mocked(sessionsApi.getMessages).mockReturnValueOnce(new Promise((resolve) => {
      resolveHistory = resolve
    }))
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'idle',
          stopAllSubagentsRequested: true,
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'session_state',
      turnState: 'idle',
    })
    await vi.waitFor(() => {
      expect(sessionsApi.getMessages).toHaveBeenCalledTimes(1)
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'task_started',
      data: {
        task_id: 'agent-task-started-during-reload',
        tool_use_id: 'agent-tool-started-during-reload',
        task_type: 'local_agent',
        description: 'New Agent lifecycle',
      },
    })

    resolveHistory({ messages: [], taskNotifications: [] })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.backgroundAgentTasks?.['agent-task-started-during-reload']).toMatchObject({
      status: 'running',
      taskType: 'local_agent',
      description: 'New Agent lifecycle',
    })
    expect(session?.stoppingBackgroundTaskIds).toEqual({
      'agent-task-started-during-reload': true,
    })
    expect(updateTabStatusMock).toHaveBeenLastCalledWith(TEST_SESSION_ID, 'running')
  })

  it('does not let delayed idle reconciliation discard a terminal Agent notification', async () => {
    let resolveHistory!: (value: { messages: MessageEntry[]; taskNotifications: [] }) => void
    vi.mocked(sessionsApi.getMessages).mockReturnValueOnce(new Promise((resolve) => {
      resolveHistory = resolve
    }))
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'idle',
          stopAllSubagentsRequested: true,
          stoppingBackgroundTaskIds: { 'agent-task-terminal-during-reload': true },
          backgroundAgentTasks: {
            'agent-task-terminal-during-reload': {
              taskId: 'agent-task-terminal-during-reload',
              toolUseId: 'agent-tool-terminal-during-reload',
              taskType: 'local_agent',
              status: 'running',
              startedAt: 1,
              updatedAt: 2,
            },
          },
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'session_state',
      turnState: 'idle',
    })
    await vi.waitFor(() => {
      expect(sessionsApi.getMessages).toHaveBeenCalledTimes(1)
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'task_notification',
      data: {
        task_id: 'agent-task-terminal-during-reload',
        tool_use_id: 'agent-tool-terminal-during-reload',
        task_type: 'local_agent',
        status: 'stopped',
        summary: 'Agent stopped while history was loading',
        result: 'Stopped by user',
      },
    })

    resolveHistory({ messages: [], taskNotifications: [] })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.backgroundAgentTasks?.['agent-task-terminal-during-reload']).toMatchObject({
      status: 'stopped',
      summary: 'Agent stopped while history was loading',
      result: 'Stopped by user',
    })
    expect(session?.agentTaskNotifications?.['agent-tool-terminal-during-reload']).toMatchObject({
      status: 'stopped',
      summary: 'Agent stopped while history was loading',
      result: 'Stopped by user',
    })
    expect(session?.stoppingBackgroundTaskIds).toEqual({})
    expect(updateTabStatusMock).toHaveBeenLastCalledWith(TEST_SESSION_ID, 'idle')
  })

  it('does not let delayed reconnect history overwrite a newly sent turn', async () => {
    let resolveHistory!: (value: { messages: MessageEntry[] }) => void
    vi.mocked(sessionsApi.getMessages).mockReturnValueOnce(new Promise((resolve) => {
      resolveHistory = resolve
    }))
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'thinking',
          streamingText: 'old partial',
          messages: [{ id: 'old-user', type: 'user_text', content: 'old turn', timestamp: 1 }],
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'session_state',
      turnState: 'idle',
    })
    await vi.waitFor(() => {
      expect(sessionsApi.getMessages).toHaveBeenCalledWith(TEST_SESSION_ID)
    })
    useChatStore.getState().sendMessage(TEST_SESSION_ID, 'new turn')

    resolveHistory({
      messages: [{
        id: 'old-assistant',
        type: 'assistant',
        timestamp: '2026-07-10T00:00:00.000Z',
        content: [{ type: 'text', text: 'old completed answer' }],
      }],
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.chatState).toBe('thinking')
    expect(session?.messages).toContainEqual(expect.objectContaining({
      type: 'user_text',
      content: 'new turn',
    }))
    expect(session?.messages).not.toContainEqual(expect.objectContaining({
      type: 'assistant_text',
      content: 'old completed answer',
    }))
    if (session?.elapsedTimer) clearInterval(session.elapsedTimer)
  })

  it('keeps the turn running but discards stale partials when reconnect reconciliation says running', async () => {
    vi.mocked(sessionsApi.getMessages).mockClear()
    vi.mocked(sessionsApi.getMessages).mockResolvedValueOnce({ messages: [] })
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'streaming',
          streamingText: 'still arriving',
          streamingToolInput: '{"stale":',
          activeToolUseId: 'stale-tool',
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'session_state',
      turnState: 'running',
    })
    await vi.waitFor(() => {
      expect(sessionsApi.getMessages).toHaveBeenCalledWith(TEST_SESSION_ID)
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]).toMatchObject({
      chatState: 'thinking',
      streamingText: '',
      streamingToolInput: '',
      activeToolUseId: null,
    })
  })

  it('replaces orphan thinking with authoritative history when a reconnected turn completes', async () => {
    vi.mocked(sessionsApi.getMessages).mockClear()
    vi.mocked(sessionsApi.getMessages).mockResolvedValue({
      messages: [
        {
          id: 'persisted-user',
          type: 'user',
          timestamp: '2026-07-11T00:00:00.000Z',
          content: 'Finish the foreground task',
        },
        {
          id: 'persisted-assistant',
          type: 'assistant',
          timestamp: '2026-07-11T00:00:01.000Z',
          content: [{ type: 'text', text: 'Foreground task finished.' }],
        },
      ],
    })
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'idle',
          messages: [],
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'session_state',
      turnState: 'running',
    })
    await vi.waitFor(() => {
      expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toHaveLength(2)
    })

    // The task_notification that should suppress this output arrived while
    // the renderer was disconnected, so only the late follow-up is observed.
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'thinking',
      text: 'orphan background follow-up thinking',
    })
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toContainEqual(
      expect.objectContaining({
        type: 'thinking',
        content: 'orphan background follow-up thinking',
      }),
    )

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 5, output_tokens: 8 },
    })

    await vi.waitFor(() => {
      expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).not.toContainEqual(
        expect.objectContaining({ type: 'thinking' }),
      )
    })
    expect(sessionsApi.getMessages).toHaveBeenCalledTimes(2)
  })

  it('keeps the tab running for background agents when reconnect reconciliation finds the foreground idle', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'thinking',
          backgroundAgentTasks: {
            'agent-task-1': {
              taskId: 'agent-task-1',
              toolUseId: 'agent-tool-1',
              status: 'running',
              taskType: 'local_agent',
              description: 'Review screenshots',
              startedAt: 1,
              updatedAt: 2,
            },
          },
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'session_state',
      turnState: 'idle',
    })

    expect(updateTabStatusMock).toHaveBeenLastCalledWith(TEST_SESSION_ID, 'running')
  })

  it('resumes the elapsed timer when streaming continues after the timer was lost', () => {
    vi.useFakeTimers()

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'streaming',
          elapsedSeconds: 3,
          elapsedTimer: null,
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_delta',
      text: 'still running',
    })

    vi.advanceTimersByTime(2100)

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.elapsedSeconds).toBe(5)

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'status',
      state: 'idle',
    })

    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('does not append completed turn duration after a running response finishes', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'streaming',
          elapsedSeconds: 65,
          streamingText: 'Finished answer',
          elapsedTimer: null,
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 12, output_tokens: 34 },
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      {
        type: 'assistant_text',
        content: 'Finished answer',
      },
    ])
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'system', content: expect.stringContaining('Completed in') }),
    ]))
  })

  it('does not append localized completed turn duration after a running response finishes', () => {
    useSettingsStore.setState({ locale: 'zh' })
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'streaming',
          elapsedSeconds: 65,
          streamingText: 'Finished answer',
          elapsedTimer: null,
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 12, output_tokens: 34 },
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      {
        type: 'assistant_text',
        content: 'Finished answer',
      },
    ])
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'system', content: expect.stringContaining('已完成，用时') }),
    ]))
  })

  it('keeps background agent sessions visibly running when the foreground turn completes', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'streaming',
          elapsedSeconds: 65,
          streamingText: 'Finished answer',
          elapsedTimer: null,
          backgroundAgentTasks: {
            'agent-task-1': {
              taskId: 'agent-task-1',
              toolUseId: 'agent-tool-1',
              status: 'running',
              taskType: 'local_agent',
              description: 'Review screenshots',
              startedAt: 1,
              updatedAt: 2,
            },
          },
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 12, output_tokens: 34 },
    })

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.messages).toMatchObject([
      {
        type: 'assistant_text',
        content: 'Finished answer',
      },
    ])
    expect(session?.messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'system', content: expect.stringContaining('Completed') }),
    ]))
    expect(session?.chatState).toBe('idle')
    expect(updateTabStatusMock).toHaveBeenLastCalledWith(TEST_SESSION_ID, 'running')
  })

  it('marks the tab idle without appending delayed completion when the last background agent task finishes after the foreground turn', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'streaming',
          elapsedSeconds: 65,
          streamingText: 'Finished answer',
          elapsedTimer: null,
          backgroundAgentTasks: {
            'agent-task-1': {
              taskId: 'agent-task-1',
              toolUseId: 'agent-tool-1',
              status: 'running',
              taskType: 'local_agent',
              description: 'Review screenshots',
              startedAt: 1,
              updatedAt: 2,
            },
          },
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 12, output_tokens: 34 },
    })
    expect(updateTabStatusMock).toHaveBeenLastCalledWith(TEST_SESSION_ID, 'running')

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'task_notification',
      data: {
        task_id: 'agent-task-1',
        tool_use_id: 'agent-tool-1',
        status: 'completed',
        summary: 'Review complete.',
      },
    })

    expect(updateTabStatusMock).toHaveBeenLastCalledWith(TEST_SESSION_ID, 'idle')
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'system', content: expect.stringContaining('Completed in') }),
    ]))
  })

  it('suppresses assistant output for a task-notification-only follow-up turn', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'idle',
          elapsedSeconds: 718,
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'task_notification',
      data: {
        task_id: 'butp7dybq',
        tool_use_id: 'toolu_bdrk_01SvH8CKoRoBcv1T1Gr9jWT3',
        status: 'completed',
        summary: 'Background command "1000 客户端压测并采样服务端内存" completed (exit code 0)',
        output_file: '/tmp/butp7dybq.output',
      },
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'thinking',
      text: "The earlier monitoring command has already been handled by subsequent work, so there's nothing more to add here.",
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_start',
      blockType: 'text',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_delta',
      text: '那是早前的监控命令收尾通知，已被后续的多核压测取代，无需处理。交付已全部完成并验证通过。',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 12, output_tokens: 34 },
    })

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.messages).toMatchObject([
      {
        type: 'background_task',
        task: {
          taskId: 'butp7dybq',
          toolUseId: 'toolu_bdrk_01SvH8CKoRoBcv1T1Gr9jWT3',
          status: 'completed',
        },
      },
    ])
    expect(session?.messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'thinking' }),
      expect.objectContaining({ type: 'assistant_text' }),
      expect.objectContaining({ type: 'system', content: 'Completed in 11m 58s' }),
    ]))
    expect(session?.chatState).toBe('idle')
    expect(updateTabStatusMock).toHaveBeenLastCalledWith(TEST_SESSION_ID, 'idle')
  })

  it('does not suppress foreground skill output when a background task completes', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          messages: [{
            id: 'skill-user-1',
            type: 'user_text',
            content: '/demo-skill',
            timestamp: 1,
          }],
          chatState: 'thinking',
          elapsedTimer: null,
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_start',
      blockType: 'tool_use',
      toolUseId: 'skill-tool-1',
      toolName: 'Skill',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'tool_use_complete',
      toolUseId: 'skill-tool-1',
      toolName: 'Skill',
      input: { skill: 'demo-skill' },
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'tool_result',
      toolUseId: 'skill-tool-1',
      content: 'Launching skill: demo-skill',
      isError: false,
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'task_notification',
      data: {
        task_id: 'older-background-task',
        tool_use_id: 'older-background-tool',
        status: 'completed',
        summary: 'Older background task completed',
      },
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.suppressNextTaskNotificationResponse).not.toBe(true)

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_start',
      blockType: 'text',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_delta',
      text: 'Visible skill output',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 12, output_tokens: 34 },
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'assistant_text', content: 'Visible skill output' }),
    ]))
  })

  it('does not flush a delayed completion before a new user turn while background tasks keep running', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'streaming',
          elapsedSeconds: 65,
          streamingText: 'Finished answer',
          elapsedTimer: null,
          backgroundAgentTasks: {
            'agent-task-1': {
              taskId: 'agent-task-1',
              toolUseId: 'agent-tool-1',
              status: 'running',
              taskType: 'local_agent',
              description: 'Review screenshots',
              startedAt: 1,
              updatedAt: 2,
            },
          },
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 12, output_tokens: 34 },
    })
    useChatStore.getState().sendMessage(TEST_SESSION_ID, 'Continue with next step')

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      { type: 'assistant_text', content: 'Finished answer' },
      { type: 'user_text', content: 'Continue with next step' },
    ])

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'task_notification',
      data: {
        task_id: 'agent-task-1',
        tool_use_id: 'agent-tool-1',
        status: 'completed',
        summary: 'Review complete.',
      },
    })

    const completedRows = useChatStore.getState().sessions[TEST_SESSION_ID]?.messages
      .filter((message) => message.type === 'system' && message.content === 'Completed in 1m 5s')
    expect(completedRows).toHaveLength(0)
  })

  it('tracks API retry status until the request finishes', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          messages: [],
          chatState: 'thinking',
          statusVerb: 'Thinking',
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'api_retry',
      attempt: 1,
      maxRetries: 10,
      retryDelayMs: 2500,
      errorStatus: 503,
      errorType: 'server_error',
    })

    const retryingSession = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(retryingSession?.chatState).toBe('thinking')
    expect(retryingSession?.statusVerb).toBe('')
    expect(retryingSession?.apiRetry).toMatchObject({
      attempt: 1,
      maxRetries: 10,
      retryDelayMs: 2500,
      errorStatus: 503,
      errorType: 'server_error',
    })
    expect(updateTabStatusMock).toHaveBeenLastCalledWith(TEST_SESSION_ID, 'running')

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 0 },
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.apiRetry).toBeNull()
  })

  it('tracks the streaming fallback notice and supersedes a stale retry banner', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          messages: [],
          chatState: 'thinking',
          statusVerb: 'Thinking',
          apiRetry: {
            attempt: 10,
            maxRetries: 10,
            retryDelayMs: 1000,
            errorStatus: 529,
            receivedAt: Date.now() - 5_000,
          },
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'streaming_fallback',
      cause: 'watchdog',
    })

    const fallbackSession = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(fallbackSession?.streamingFallback).toMatchObject({ cause: 'watchdog' })
    // 旧的流式重试横幅针对已放弃的请求，必须被降级提示接管。
    expect(fallbackSession?.apiRetry).toBeNull()
    expect(fallbackSession?.chatState).toBe('thinking')
    expect(fallbackSession?.statusVerb).toBe('')
    expect(updateTabStatusMock).toHaveBeenLastCalledWith(TEST_SESSION_ID, 'running')

    // 非流式响应的首个内容块到达即清除降级提示。
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_start',
      blockType: 'text',
    })
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.streamingFallback).toBeNull()
  })

  it('discards only the failed stream attempt before a safe retry', () => {
    const completedTool = {
      id: 'completed-tool',
      type: 'tool_use' as const,
      toolName: 'Read',
      toolUseId: 'read-1',
      input: { file_path: 'README.md' },
      timestamp: 1,
      isPending: false,
    }
    const completedResult = {
      id: 'completed-result',
      type: 'tool_result' as const,
      toolUseId: 'read-1',
      content: 'ok',
      isError: false,
      timestamp: 2,
    }
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          messages: [
            completedTool,
            completedResult,
            { id: 'failed-thinking', type: 'thinking', content: 'partial thought', timestamp: 3 },
            {
              id: 'failed-tool',
              type: 'tool_use',
              toolName: 'Write',
              toolUseId: 'write-partial',
              input: {},
              timestamp: 4,
              isPending: true,
              partialInput: '{"file_path":',
            },
          ],
          chatState: 'tool_executing',
          streamingText: 'partial answer',
          streamingToolInput: '{"file_path":',
          activeToolUseId: 'write-partial',
          activeToolName: 'Write',
          activeThinkingId: 'failed-thinking',
          streamingResponseChars: 200,
          streamAttemptStartIndex: 2,
          streamAttemptStartResponseChars: 80,
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'streaming_fallback',
      cause: 'stream_retry',
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]).toMatchObject({
      messages: [completedTool, completedResult],
      chatState: 'thinking',
      streamingText: '',
      streamingToolInput: '',
      activeToolUseId: null,
      activeToolName: null,
      activeThinkingId: null,
      streamingResponseChars: 80,
      streamingFallback: null,
    })
  })

  it('keeps the fallback notice when idle and clears it on turn completion', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          messages: [],
          chatState: 'idle',
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'streaming_fallback',
      cause: '404_stream_creation',
    })

    // idle 会话收到降级信号说明回合仍在跑，状态条要回到 thinking。
    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.chatState).toBe('thinking')
    expect(session?.streamingFallback).toMatchObject({ cause: '404_stream_creation' })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 0 },
    })
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.streamingFallback).toBeNull()
  })

  it('renders memory saved notifications as chat memory events', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          messages: [],
          chatState: 'idle',
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'memory_saved',
      message: 'Saved 2 memories',
      data: {
        writtenPaths: [
          '/Users/test/.claude/projects/example/memory/preferences.md',
          '/Users/test/.claude/projects/example/memory/team/MEMORY.md',
        ],
        teamCount: 1,
      },
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      {
        type: 'memory_event',
        event: 'saved',
        message: 'Saved 2 memories',
        teamCount: 1,
        files: [
          { path: '/Users/test/.claude/projects/example/memory/preferences.md', action: 'saved' },
          { path: '/Users/test/.claude/projects/example/memory/team/MEMORY.md', action: 'saved' },
        ],
      },
    ])
  })

  it('renders live goal notifications as visible goal events', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          messages: [],
          chatState: 'idle',
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'goal_event',
      message: 'Goal set: ship the smoke test',
      data: {
        action: 'created',
        status: 'active',
        objective: 'ship the smoke test',
        budget: '0 / 2,000 tokens',
        continuations: '0',
      },
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      {
        type: 'goal_event',
        action: 'created',
        status: 'active',
        objective: 'ship the smoke test',
        budget: '0 / 2,000 tokens',
        continuations: '0',
      },
    ])
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.activeGoal).toMatchObject({
      action: 'created',
      status: 'active',
      objective: 'ship the smoke test',
      budget: '0 / 2,000 tokens',
      continuations: '0',
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'goal_event',
      message: 'Goal set: ship the replacement target',
      data: {
        action: 'created',
        status: 'active',
        objective: 'ship the replacement target',
        budget: '0 / unlimited tokens',
        continuations: '0',
      },
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.activeGoal).toMatchObject({
      action: 'created',
      status: 'active',
      objective: 'ship the replacement target',
      budget: '0 / unlimited tokens',
      continuations: '0',
    })
  })

  it('keeps the active goal panel state in sync with /goal lifecycle events', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          messages: [],
          activeGoal: {
            action: 'created',
            status: 'active',
            objective: 'ship the smoke test',
            budget: '0 / 2,000 tokens',
            continuations: '0',
            updatedAt: 1,
          },
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'goal_event',
      data: {
        action: 'paused',
        status: 'paused',
      },
    })
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.activeGoal).toMatchObject({
      action: 'paused',
      status: 'paused',
      objective: 'ship the smoke test',
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'goal_event',
      data: {
        action: 'completed',
        message: 'Goal marked complete.',
      },
    })
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.activeGoal).toMatchObject({
      action: 'completed',
      status: 'complete',
      objective: 'ship the smoke test',
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'system_notification',
      subtype: 'goal_event',
      data: {
        action: 'cleared',
        message: 'Goal cleared.',
      },
    })
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.activeGoal).toBeNull()
  })

  it('flushes the previous assistant draft before starting a new user turn', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: {
          messages: [],
          chatState: 'streaming',
          connectionState: 'connected',
          streamingText: '上一次分析结果 **还在流式区域**',
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
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    useChatStore.getState().sendMessage(TEST_SESSION_ID, '你是什么模型？')

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      {
        type: 'assistant_text',
        content: '上一次分析结果 **还在流式区域**',
      },
      {
        type: 'user_text',
        content: '你是什么模型？',
      },
    ])
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.streamingText).toBe('')
  })

  it('resets completed CLI tasks before continuing the next user turn', () => {
    cliTaskStoreSnapshot.sessionId = TEST_SESSION_ID
    cliTaskStoreSnapshot.tasks = [
      { id: '1', subject: 'Existing completed task', status: 'completed' },
      { id: '2', subject: 'Another completed task', status: 'completed' },
    ]

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
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
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    useChatStore.getState().sendMessage(TEST_SESSION_ID, '继续下一轮')

    expect(resetCompletedTasksMock).toHaveBeenCalledWith(TEST_SESSION_ID)
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      {
        type: 'task_summary',
        tasks: [
          { id: '1', subject: 'Existing completed task', status: 'completed' },
          { id: '2', subject: 'Another completed task', status: 'completed' },
        ],
      },
      {
        type: 'user_text',
        content: '继续下一轮',
      },
    ])
  })

  it('does not attach completed tasks from another tracked session to a new user turn', () => {
    cliTaskStoreSnapshot.sessionId = 'session-b'
    cliTaskStoreSnapshot.tasks = [
      { id: '1', subject: 'Session B completed task', status: 'completed' },
    ]

    useChatStore.setState({
      sessions: {
        'session-a': makeSession({ chatState: 'idle' }),
        'session-b': makeSession({ chatState: 'idle' }),
      },
    })

    useChatStore.getState().sendMessage('session-a', '继续 A 会话')

    expect(resetCompletedTasksMock).not.toHaveBeenCalled()
    expect(useChatStore.getState().sessions['session-a']?.messages).toMatchObject([
      {
        type: 'user_text',
        content: '继续 A 会话',
      },
    ])
  })

  it('tracks task tool results independently per session even when tool IDs collide', () => {
    useChatStore.setState({
      sessions: {
        'session-a': makeSession({
          activeToolUseId: 'tool-same',
          activeToolName: 'TaskCreate',
        }),
        'session-b': makeSession({
          activeToolUseId: 'tool-same',
          activeToolName: 'TaskCreate',
        }),
      },
    })

    for (const sessionId of ['session-a', 'session-b']) {
      useChatStore.getState().handleServerMessage(sessionId, {
        type: 'tool_use_complete',
        toolName: 'TaskCreate',
        toolUseId: 'tool-same',
        input: { subject: sessionId },
      })
    }

    useChatStore.getState().handleServerMessage('session-a', {
      type: 'tool_result',
      toolUseId: 'tool-same',
      content: 'created A',
      isError: false,
    })
    useChatStore.getState().handleServerMessage('session-b', {
      type: 'tool_result',
      toolUseId: 'tool-same',
      content: 'created B',
      isError: false,
    })

    expect(refreshTasksMock).toHaveBeenCalledTimes(2)
    expect(refreshTasksMock).toHaveBeenNthCalledWith(1, 'session-a')
    expect(refreshTasksMock).toHaveBeenNthCalledWith(2, 'session-b')
  })

  it('tracks Computer Use approval requests separately from generic tool permissions', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
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
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'computer_use_permission_request',
      requestId: 'cu-1',
      request: {
        requestId: 'cu-1',
        reason: 'Open Finder and inspect a file',
        apps: [
          {
            requestedName: 'Finder',
            resolved: {
              bundleId: 'com.apple.finder',
              displayName: 'Finder',
            },
            isSentinel: false,
            alreadyGranted: false,
            proposedTier: 'full',
          },
        ],
        requestedFlags: { clipboardRead: true },
        screenshotFiltering: 'native',
      },
    })

    expect(
      useChatStore.getState().sessions[TEST_SESSION_ID]?.pendingComputerUsePermission,
    ).toMatchObject({
      requestId: 'cu-1',
      request: {
        reason: 'Open Finder and inspect a file',
      },
    })
    expect(
      useChatStore.getState().sessions[TEST_SESSION_ID]?.chatState,
    ).toBe('permission_pending')
    expect(notifyDesktopMock).toHaveBeenCalledWith({
      dedupeKey: 'computer-use-permission:cu-1',
      cooldownScope: 'permission-prompt',
      requestAttention: true,
      title: 'Claude Code Haha 需要你的确认',
      body: 'Open Finder and inspect a file',
      target: { type: 'session', sessionId: TEST_SESSION_ID },
    })
  })

  it('keeps delayed text blocks from one streamed assistant turn in a single message', () => {
    vi.useFakeTimers()

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
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
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_start',
      blockType: 'text',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_delta',
      text: '第一段：先到达。',
    })
    vi.advanceTimersByTime(60)

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_start',
      blockType: 'text',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_delta',
      text: '\r\n第二段：稍后到达，但仍属于同一轮回复。',
    })
    vi.advanceTimersByTime(60)

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 2 },
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      {
        type: 'assistant_text',
        content: '第一段：先到达。\r\n第二段：稍后到达，但仍属于同一轮回复。',
      },
    ])

    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('keeps throttled streaming deltas isolated per session', () => {
    vi.useFakeTimers()

    useChatStore.setState({
      sessions: {
        'session-a': makeSession(),
        'session-b': makeSession(),
      },
    })

    useChatStore.getState().handleServerMessage('session-a', {
      type: 'content_start',
      blockType: 'text',
    })
    useChatStore.getState().handleServerMessage('session-a', {
      type: 'content_delta',
      text: 'A-only response',
    })
    useChatStore.getState().handleServerMessage('session-b', {
      type: 'content_start',
      blockType: 'text',
    })
    useChatStore.getState().handleServerMessage('session-b', {
      type: 'content_delta',
      text: 'B-only response',
    })

    useChatStore.getState().handleServerMessage('session-a', {
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    useChatStore.getState().handleServerMessage('session-b', {
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 1 },
    })

    expect(useChatStore.getState().sessions['session-a']?.messages).toMatchObject([
      { type: 'assistant_text', content: 'A-only response' },
    ])
    expect(useChatStore.getState().sessions['session-b']?.messages).toMatchObject([
      { type: 'assistant_text', content: 'B-only response' },
    ])

    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('marks the tab idle when a message completes', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({ chatState: 'thinking' }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 2 },
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.chatState).toBe('idle')
    expect(updateTabStatusMock).toHaveBeenCalledWith(TEST_SESSION_ID, 'idle')
  })

  it('refreshes unfinished Task V2 tool state once when the message completes', () => {
    cliTaskStoreSnapshot.sessionId = TEST_SESSION_ID
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({ chatState: 'tool_executing' }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'tool_use_complete',
      toolName: 'TaskUpdate',
      toolUseId: 'task-update-1',
      input: { taskId: '1', status: 'completed' },
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 2 },
    })

    expect(refreshTasksMock).toHaveBeenCalledTimes(1)
    expect(refreshTasksMock).toHaveBeenCalledWith(TEST_SESSION_ID)

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 2 },
    })

    expect(refreshTasksMock).toHaveBeenCalledTimes(1)
  })

  it('flushes pending text before appending a thinking block', () => {
    vi.useFakeTimers()

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({ chatState: 'streaming' }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_delta',
      text: 'visible answer before thinking',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'thinking',
      text: 'internal note',
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      { type: 'assistant_text', content: 'visible answer before thinking' },
      { type: 'thinking', content: 'internal note' },
    ])

    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('does not duplicate the current prompt when CLI replays it after thinking starts', () => {
    const prompt = '# 角色与目标\n构建一个协同编辑器'
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          messages: [
            {
              id: 'live-user',
              type: 'user_text',
              content: prompt,
              timestamp: 1,
            },
          ],
          chatState: 'thinking',
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'thinking',
      text: 'I need to plan the implementation.',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'user_message_replay',
      content: prompt,
    })

    const userMessages = useChatStore.getState().sessions[TEST_SESSION_ID]?.messages
      .filter((message) => message.type === 'user_text')
    expect(userMessages).toHaveLength(1)
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      { type: 'user_text', content: prompt },
      { type: 'thinking', content: 'I need to plan the implementation.' },
    ])
  })

  it('does not duplicate a slash-command prompt when the replay normalizes extra spaces', () => {
    // The composer keeps the raw input (`/ego-browser␣␣https://…` — two spaces
    // after the command name). The CLI preserves them inside <command-args>,
    // but the server display text (formatCommandDisplayText) trims args and
    // re-joins name + args with a single space. The replay must still match the
    // optimistic bubble — HTML collapses the extra space, so a mismatch renders
    // as a visually identical duplicate bubble mid-stream.
    const typed = '/ego-browser  https://huggingface.co/MiniMaxAI/MiniMax-H3 \n\n去帮我看一下这个页面，我们本地部署这个模型需要大概怎样的配置？\n\n如果是用 macOS，它 M 系列芯片的统一内存大概要多少？'
    const replay = '/ego-browser https://huggingface.co/MiniMaxAI/MiniMax-H3 \n\n去帮我看一下这个页面，我们本地部署这个模型需要大概怎样的配置？\n\n如果是用 macOS，它 M 系列芯片的统一内存大概要多少？'
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          messages: [
            {
              id: 'live-user',
              type: 'user_text',
              content: typed.trim(),
              timestamp: 1,
            },
          ],
          chatState: 'thinking',
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'thinking',
      text: 'Checking the model page.',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'user_message_replay',
      content: replay,
    })

    const userMessages = useChatStore.getState().sessions[TEST_SESSION_ID]?.messages
      .filter((message) => message.type === 'user_text')
    expect(userMessages).toHaveLength(1)
    expect(userMessages?.[0]).toMatchObject({ content: typed.trim() })
  })

  it('restores workspace diff comment styling from a replayed model prompt', () => {
    const modelPrompt = [
      '@"/repo/src/App.vue" Referenced workspace context:',
      '@"src/App.vue:new:L94-L105":',
      'Comment: 调整这里',
      '```vue',
      '<section id="hero">',
      '```',
    ].join('\n')
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({ chatState: 'thinking' }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'user_message_replay',
      content: modelPrompt,
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      {
        type: 'user_text',
        content: '',
        modelContent: modelPrompt,
        attachments: [{
          type: 'file',
          path: 'src/App.vue',
          diffSide: 'new',
          lineStart: 94,
          lineEnd: 105,
          note: '调整这里',
          quote: '<section id="hero">',
        }],
      },
    ])
  })

  it('does not leak an image-bearing prompt when the replay appends [Image source] metadata (Windows path)', () => {
    // The optimistic message (e.g. a visual-selection annotation card) stores the
    // prompt body in modelContent with a hidden display. The CLI replay carries
    // the server-appended `[Image source: …]` line on the same text. Dedupe must
    // still match — otherwise the raw prompt + absolute upload path leak in as a
    // second grey bubble (the reported Windows regression).
    const prompt = '请根据截图中编号 1 的蓝色标注修改本地前端。\n目标元素：<button>'
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          messages: [
            {
              id: 'live-user',
              type: 'user_text',
              content: '',
              modelContent: prompt,
              timestamp: 1,
            },
          ],
          chatState: 'thinking',
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'user_message_replay',
      content: `${prompt}\n[Image source: C:\\Users\\Relakkes\\.claude\\uploads\\sid\\82017405-_button_.png]`,
    })

    const userMessages = useChatStore.getState().sessions[TEST_SESSION_ID]?.messages
      .filter((message) => message.type === 'user_text')
    expect(userMessages).toHaveLength(1)
    expect(userMessages?.[0]).toMatchObject({ content: '', modelContent: prompt })
  })

  it('dedupes an image-bearing prompt when the replay appends detailed (macOS) image metadata', () => {
    const prompt = 'describe this screenshot for me'
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          messages: [
            { id: 'live-user', type: 'user_text', content: prompt, timestamp: 1 },
          ],
          chatState: 'thinking',
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'user_message_replay',
      content: `${prompt}\n[Image: source: /Users/me/.claude/uploads/sid/a.png, original 1024x768, displayed at 512x384. Multiply coordinates by 2 to map to original image.]`,
    })

    const userMessages = useChatStore.getState().sessions[TEST_SESSION_ID]?.messages
      .filter((message) => message.type === 'user_text')
    expect(userMessages).toHaveLength(1)
  })

  it('keeps an image-only replay before the assistant response', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          messages: [
            {
              id: 'live-user',
              type: 'user_text',
              content: '',
              attachments: [{
                type: 'image',
                name: 'screenshot.png',
                data: 'data:image/png;base64,AAAA',
                mimeType: 'image/png',
              }],
              timestamp: 1,
            },
            {
              id: 'assistant-answer',
              type: 'assistant_text',
              content: 'The screenshot shows a repository list.',
              timestamp: 2,
            },
          ],
          chatState: 'thinking',
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'user_message_replay',
      content: [
        'Please analyze the attached image.',
        '[Image source: /Users/me/.claude/uploads/session/screenshot.png]',
      ].join('\n'),
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      {
        type: 'user_text',
        content: '',
        attachments: [{ type: 'image', name: 'screenshot.png' }],
      },
      {
        type: 'assistant_text',
        content: 'The screenshot shows a repository list.',
      },
    ])
  })

  it('dedupes a path-backed image after the server inlines it into replay content', () => {
    const prompt = '检查这张截图'
    const imagePath = 'C:\\Users\\tester\\Desktop\\screen.png'
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          messages: [
            {
              id: 'live-user',
              type: 'user_text',
              content: prompt,
              modelContent: `@"${imagePath}" ${prompt}`,
              attachments: [{
                type: 'file',
                name: 'screen.png',
                path: imagePath,
              }],
              timestamp: 1,
            },
          ],
          chatState: 'thinking',
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'user_message_replay',
      content: `${prompt}\n[Image source: ${imagePath}]`,
    })

    const userMessages = useChatStore.getState().sessions[TEST_SESSION_ID]?.messages
      .filter((message) => message.type === 'user_text')
    expect(userMessages).toHaveLength(1)
  })

  it('dedupes a prompt when data-only files replay with server-materialized upload paths', () => {
    const prompt = '检查这两个附件'
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          messages: [
            {
              id: 'live-user',
              type: 'user_text',
              content: prompt,
              attachments: [
                {
                  type: 'file',
                  name: 'PROJECT.md',
                  data: 'data:text/markdown;base64,IyBQcm9qZWN0',
                },
                {
                  type: 'file',
                  name: 'server.pem',
                  data: 'data:application/x-pem-file;base64,VEVTVA==',
                },
              ],
              timestamp: 1,
            },
          ],
          chatState: 'thinking',
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'user_message_replay',
      content: [
        '@"C:\\Users\\tester\\.claude\\uploads\\sid\\5d3af295-b914-4d44-a686-d665dc46b189-PROJECT.md"',
        '@"C:\\Users\\tester\\.claude\\uploads\\sid\\d81b63cd-978c-42ce-ad9a-3bcd049dc24e-server.pem"',
        prompt,
      ].join(' '),
    })

    const userMessages = useChatStore.getState().sessions[TEST_SESSION_ID]?.messages
      .filter((message) => message.type === 'user_text')
    expect(userMessages).toHaveLength(1)
    expect(userMessages?.[0]).toMatchObject({
      content: prompt,
      attachments: [
        { name: 'PROJECT.md', data: 'data:text/markdown;base64,IyBQcm9qZWN0' },
        { name: 'server.pem', data: 'data:application/x-pem-file;base64,VEVTVA==' },
      ],
    })
  })

  it('keeps a replay whose materialized upload filename does not match the current attachment', () => {
    const prompt = '检查这个附件'
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          messages: [
            {
              id: 'live-user',
              type: 'user_text',
              content: prompt,
              attachments: [{
                type: 'file',
                name: 'PROJECT.md',
                data: 'data:text/markdown;base64,IyBQcm9qZWN0',
              }],
              timestamp: 1,
            },
          ],
          chatState: 'thinking',
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'user_message_replay',
      content: `@"C:\\Users\\tester\\.claude\\uploads\\sid\\5d3af295-b914-4d44-a686-d665dc46b189-other.md" ${prompt}`,
    })

    const userMessages = useChatStore.getState().sessions[TEST_SESSION_ID]?.messages
      .filter((message) => message.type === 'user_text')
    expect(userMessages).toHaveLength(2)
  })

  it('flushes pending text before appending an error message', () => {
    vi.useFakeTimers()

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({ chatState: 'streaming' }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_delta',
      text: 'partial answer before error',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'error',
      message: 'API Error: Provider stream stalled after partial response - no new chunks for 240s',
      code: 'STREAM_IDLE_TIMEOUT',
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      { type: 'assistant_text', content: 'partial answer before error' },
      {
        type: 'error',
        message: 'API Error: Provider stream stalled after partial response - no new chunks for 240s',
        code: 'STREAM_IDLE_TIMEOUT',
      },
    ])

    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('flushes throttled deltas only for the stopped session', () => {
    vi.useFakeTimers()

    useChatStore.setState({
      sessions: {
        'session-a': makeSession(),
        'session-b': makeSession(),
      },
    })

    useChatStore.getState().handleServerMessage('session-a', {
      type: 'content_delta',
      text: 'A-only response',
    })
    useChatStore.getState().handleServerMessage('session-b', {
      type: 'content_delta',
      text: 'B-only response',
    })

    useChatStore.getState().stopGeneration('session-a')

    expect(useChatStore.getState().sessions['session-a']?.streamingText).toBe('')
    expect(useChatStore.getState().sessions['session-a']?.messages).toMatchObject([
      { type: 'assistant_text', content: 'A-only response' },
    ])
    expect(useChatStore.getState().sessions['session-b']?.streamingText).toBe('')

    useChatStore.getState().handleServerMessage('session-b', {
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 1 },
    })

    expect(useChatStore.getState().sessions['session-b']?.messages).toMatchObject([
      { type: 'assistant_text', content: 'B-only response' },
    ])

    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('does not flush one session throttled delta into another disconnected session', () => {
    vi.useFakeTimers()

    useChatStore.setState({
      sessions: {
        'session-a': makeSession(),
        'session-b': makeSession(),
      },
    })

    useChatStore.getState().handleServerMessage('session-a', {
      type: 'content_delta',
      text: 'A-only response',
    })
    useChatStore.getState().handleServerMessage('session-b', {
      type: 'content_delta',
      text: 'B-only response',
    })

    useChatStore.getState().disconnectSession('session-a')

    expect(useChatStore.getState().sessions['session-a']).toBeUndefined()
    expect(useChatStore.getState().sessions['session-b']?.streamingText).toBe('')

    useChatStore.getState().handleServerMessage('session-b', {
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 1 },
    })

    expect(useChatStore.getState().sessions['session-b']?.messages).toMatchObject([
      { type: 'assistant_text', content: 'B-only response' },
    ])

    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('ignores late throttled deltas after a session has disconnected', () => {
    vi.useFakeTimers()

    useChatStore.setState({
      sessions: {
        'session-a': makeSession(),
      },
    })

    useChatStore.getState().handleServerMessage('session-a', {
      type: 'content_delta',
      text: 'before disconnect',
    })
    useChatStore.getState().disconnectSession('session-a')

    useChatStore.getState().handleServerMessage('session-a', {
      type: 'content_delta',
      text: 'late stale delta',
    })
    useChatStore.setState({
      sessions: {
        'session-a': makeSession({ chatState: 'idle' }),
      },
    })

    useChatStore.getState().sendMessage('session-a', 'fresh turn')

    expect(useChatStore.getState().sessions['session-a']?.messages).toMatchObject([
      { type: 'user_text', content: 'fresh turn' },
    ])

    vi.runOnlyPendingTimers()
    expect(useChatStore.getState().sessions['session-a']?.streamingText).toBe('')
    vi.useRealTimers()
  })

  it('does not split one streamed markdown reply when task progress arrives mid-stream', () => {
    vi.useFakeTimers()

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
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
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_start',
      blockType: 'text',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_delta',
      text: '1. **`core/audio/waveform.py:19-31`** — 同步阻塞 I/O。',
    })
    vi.advanceTimersByTime(60)

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'status',
      state: 'tool_executing',
      verb: 'Task in progress',
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_delta',
      text: ' 建议直接用 `subprocess.PIPE` 流式处理。',
    })
    vi.advanceTimersByTime(60)

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 2 },
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      {
        type: 'assistant_text',
        content:
          '1. **`core/audio/waveform.py:19-31`** — 同步阻塞 I/O。 建议直接用 `subprocess.PIPE` 流式处理。',
      },
    ])

    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('clears transient worktree startup text when normal thinking resumes', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'idle',
        }),
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'status',
      state: 'thinking',
      verb: 'Creating worktree',
    })
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.statusVerb).toBe('Creating worktree')

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'status',
      state: 'thinking',
      verb: 'Thinking',
    })
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.statusVerb).toBe('')

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'status',
      state: 'thinking',
      verb: 'Creating worktree',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'status',
      state: 'thinking',
    })
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.statusVerb).toBe('')
  })

  it('sends a desktop notification when the agent finishes a markdown reply', () => {
    vi.useFakeTimers()

    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: {
          messages: [
            { id: 'user-1', type: 'user_text', content: '总结一下', timestamp: Date.now() },
          ],
          chatState: 'streaming',
          connectionState: 'connected',
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
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_start',
      blockType: 'text',
    })
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_delta',
      text: '## 结果\n\n- **修复完成**\n- `bun test` 已通过',
    })
    vi.advanceTimersByTime(60)
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 2 },
    })

    expect(notifyDesktopMock).toHaveBeenCalledWith(expect.objectContaining({
      cooldownScope: 'agent-completion',
      title: 'Claude Code Haha 已完成回复',
      body: '结果 修复完成 bun test 已通过',
      target: { type: 'session', sessionId: TEST_SESSION_ID },
    }))
    expect(notifyDesktopMock.mock.calls[0]?.[0].dedupeKey).toMatch(
      /^agent-completion:test-session-1:msg-/,
    )

    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('does not notify when completion has no assistant text', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: {
          messages: [],
          chatState: 'thinking',
          connectionState: 'connected',
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
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 0 },
    })

    expect(notifyDesktopMock).not.toHaveBeenCalled()
  })

  it('does not notify when a completion arrives after the session is already idle', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
          streamingText: '用户已停止后的残余文本',
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
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 1 },
    })

    expect(notifyDesktopMock).not.toHaveBeenCalled()
  })

  it('sends Computer Use approval payloads back over websocket', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: {
          messages: [],
          chatState: 'permission_pending',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: null,
          pendingComputerUsePermission: {
            requestId: 'cu-1',
            request: {
              requestId: 'cu-1',
              reason: 'Open Finder',
              apps: [],
              requestedFlags: {},
              screenshotFiltering: 'native',
            },
          },
          tokenUsage: { input_tokens: 0, output_tokens: 0 },
          streamingResponseChars: 0,
          elapsedSeconds: 0,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    useChatStore.getState().respondToComputerUsePermission(TEST_SESSION_ID, 'cu-1', {
      granted: [],
      denied: [],
      flags: {
        clipboardRead: true,
        clipboardWrite: false,
        systemKeyCombos: false,
      },
      userConsented: true,
    })

    expect(sendMock).toHaveBeenCalledWith(TEST_SESSION_ID, {
      type: 'computer_use_permission_response',
      requestId: 'cu-1',
      response: {
        granted: [],
        denied: [],
        flags: {
          clipboardRead: true,
          clipboardWrite: false,
          systemKeyCombos: false,
        },
        userConsented: true,
      },
    })
    expect(
      useChatStore.getState().sessions[TEST_SESSION_ID]?.pendingComputerUsePermission,
    ).toBeNull()
    expect(
      useChatStore.getState().sessions[TEST_SESSION_ID]?.chatState,
    ).toBe('tool_executing')
  })

  it('routes member-session messages through team mailbox delivery instead of websocket', async () => {
    const memberSessionId = 'team-member:security-reviewer@test-team'
    getMemberBySessionIdMock.mockReturnValue({
      agentId: 'security-reviewer@test-team',
      role: 'security-reviewer',
      status: 'running',
    })

    useChatStore.setState({
      sessions: {
        [memberSessionId]: {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
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
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    useChatStore.getState().sendMessage(memberSessionId, 'Check the latest regression')
    await Promise.resolve()

    expect(sendMessageToMemberMock).toHaveBeenCalledWith(
      memberSessionId,
      'Check the latest regression',
    )
    expect(sendMock).not.toHaveBeenCalled()
    const sessionMessages = useChatStore.getState().sessions[memberSessionId]?.messages ?? []

    expect(sessionMessages[sessionMessages.length - 1]).toMatchObject({
      type: 'user_text',
      content: 'Check the latest regression',
      pending: true,
    })
  })

  it('refreshes CLI tasks when switching to an already-connected session', () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
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
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })

    useChatStore.getState().connectToSession(TEST_SESSION_ID)

    expect(fetchSessionTasksMock).toHaveBeenCalledWith(TEST_SESSION_ID)
  })

  it('optimistically titles a new placeholder session from the first user message', () => {
    sessionStoreSnapshot.sessions = [{
      id: TEST_SESSION_ID,
      title: 'New Session',
      createdAt: '2026-05-07T00:00:00.000Z',
      modifiedAt: '2026-05-07T00:00:00.000Z',
      messageCount: 0,
      projectPath: '',
      workDir: '/workspace/project',
      workDirExists: true,
    }]

    useChatStore.getState().sendMessage(TEST_SESSION_ID, '开始优化UI')

    expect(updateSessionTitleMock).toHaveBeenCalledWith(TEST_SESSION_ID, '开始优化UI')
    expect(updateTabTitleMock).toHaveBeenCalledWith(TEST_SESSION_ID, '开始优化UI')
    expect(sendMock).toHaveBeenCalledWith(TEST_SESSION_ID, {
      type: 'user_message',
      content: '开始优化UI',
      attachments: undefined,
    })
  })

  // issue #757: the streaming indicator estimates this turn's output tokens
  // from streamed characters (÷4, mirroring the CLI spinner) instead of
  // showing the previous turn's stale usage.
  it('accumulates streamed text, tool input, and thinking chars for the token estimate', () => {
    vi.useFakeTimers()
    useChatStore.setState({ sessions: { [TEST_SESSION_ID]: makeSession() } })

    const charsOf = () =>
      useChatStore.getState().sessions[TEST_SESSION_ID]?.streamingResponseChars

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_delta',
      text: 'a'.repeat(40),
    })
    vi.advanceTimersByTime(60)
    expect(charsOf()).toBe(40)

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'content_delta',
      toolInput: '{"a":1}',
    })
    vi.advanceTimersByTime(60)
    expect(charsOf()).toBe(47)

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'thinking',
      text: 'pondering',
    })
    expect(charsOf()).toBe(56)

    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('resets the streaming token estimate when the user sends the next message', () => {
    vi.useFakeTimers()
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'idle',
          streamingResponseChars: 4321,
        }),
      },
    })

    useChatStore.getState().sendMessage(TEST_SESSION_ID, '继续')

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.streamingResponseChars).toBe(0)
    if (session?.elapsedTimer) clearInterval(session.elapsedTimer)
    vi.useRealTimers()
  })
})

// A desktop window left open for hours re-renders a long-finished session as a
// wall of collapsed "已思考" bubbles with no reply text between them. No new LLM
// call happens — the finished turn's stream events are pushed at the renderer a
// second time on top of already-hydrated history. appendAssistantTextMessage
// guards against exactly that replay, `case 'thinking'` does not.
type FinishedTurnStep =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string }

// Verbatim block order of session fd09ae78-297a-427e-a849-5251731bf30c (Kimi
// k3, a Computer Use run): 13 thinking blocks, 5 of them empty. Only the very
// last assistant reply is elided — it is a long markdown table.
const FINISHED_COMPUTER_USE_TURN: FinishedTurnStep[] = [
  { kind: 'thinking', text: 'User wants Computer Use. I need to load the computer-use tools. Let me fetch the tool schemas first.' },
  { kind: 'text', text: '我先加载 Computer Use 工具，然后严格按顺序执行。' },
  { kind: 'tool', id: 'tool_aJGuYYOY4gzHHHFIaTus4M3e', name: 'ToolSearch' },
  { kind: 'thinking', text: 'Start: get_app_state to find search box, then step 1 click it. User wants get_app_state after each step and report the search field content.' },
  { kind: 'tool', id: 'tool_kosJoZ93D4WBqAWnmelI9Rik', name: 'mcp__computer-use__get_app_state' },
  { kind: 'thinking', text: 'Search box at approx (410, 50). Step 1: single click.' },
  { kind: 'text', text: '初始状态：搜索框为空（只有放大镜占位图标），位置约 (410, 50)。\n\n**第 1 步：单击搜索框**' },
  { kind: 'tool', id: 'tool_KlLouIdZHyPcj0Jbmy5nfJOf', name: 'mcp__computer-use__click' },
  { kind: 'thinking', text: '' },
  { kind: 'tool', id: 'tool_lNWmFSm7Er61dyZJcWGkGH6b', name: 'mcp__computer-use__get_app_state' },
  { kind: 'thinking', text: 'Step 1 done: search box still empty (only magnifier icon). Step 2: type "test".' },
  { kind: 'text', text: '第 1 步后：搜索框里**为空**（只有放大镜占位图标，无文字）。\n\n**第 2 步：type_text 输入 "test"**' },
  { kind: 'tool', id: 'tool_hTHyhielyvIaUIWN6YJDz2g5', name: 'mcp__computer-use__type_text' },
  { kind: 'thinking', text: '' },
  { kind: 'tool', id: 'tool_951Y0sQNx8tMZGGMS7XjVeOL', name: 'mcp__computer-use__get_app_state' },
  { kind: 'thinking', text: 'Step 2 done: search box still empty — "test" did not appear. Report honestly. Step 3: type "abc".' },
  { kind: 'text', text: '第 2 步后：搜索框里**为空** —— "test" 没有显示出来。\n\n**第 3 步：type_text 输入 "abc"**' },
  { kind: 'tool', id: 'tool_Y1MzoPySfdwd7tNrFj389CEN', name: 'mcp__computer-use__type_text' },
  { kind: 'thinking', text: 'Continue: get_app_state after step 3.' },
  { kind: 'tool', id: 'tool_8TrKG2qCE6Q4bDYE5hMvngSW', name: 'mcp__computer-use__get_app_state' },
  { kind: 'thinking', text: 'Step 3 done: still empty. Step 4: double-click search box.' },
  { kind: 'text', text: '第 3 步后：搜索框里**依然为空** —— "abc" 也没有显示。\n\n**第 4 步：双击搜索框**' },
  { kind: 'tool', id: 'tool_qguIh8LXvDxOn6wE4aSlys2K', name: 'mcp__computer-use__click' },
  { kind: 'thinking', text: '' },
  { kind: 'tool', id: 'tool_T4513oOu6to3GY1EeEPMLvFr', name: 'mcp__computer-use__get_app_state' },
  { kind: 'thinking', text: '' },
  { kind: 'text', text: '第 4 步后：搜索框里**仍然为空**，界面无任何变化。\n\n**第 5 步：type_text 输入 "xyz"**' },
  { kind: 'tool', id: 'tool_XhJWl5aNuSPaUXctFQ91KSPM', name: 'mcp__computer-use__type_text' },
  { kind: 'thinking', text: '' },
  { kind: 'tool', id: 'tool_b2c5HshyO48rmbYqmlcGj94K', name: 'mcp__computer-use__get_app_state' },
  { kind: 'thinking', text: 'Done. Report all 5 steps faithfully.' },
  { kind: 'text', text: '5 步全部完成，如实汇报每步后搜索框的内容：' },
]

const FIRST_THINKING = FINISHED_COMPUTER_USE_TURN[0] as { kind: 'thinking'; text: string }
const LAST_THINKING = FINISHED_COMPUTER_USE_TURN[30] as { kind: 'thinking'; text: string }

/** The CLI persists one transcript entry per content block; mirror that shape. */
function buildFinishedTurnHistory(): MessageEntry[] {
  const entries: MessageEntry[] = [{
    id: 'cu-prompt',
    type: 'user',
    timestamp: '2026-07-28T15:00:00.000Z',
    content: '用 Computer Use 操作网易云音乐，严格按顺序做，每步做完立刻 get_app_state。',
  }]
  FINISHED_COMPUTER_USE_TURN.forEach((step, index) => {
    const timestamp = new Date(Date.UTC(2026, 6, 28, 15, 1, index)).toISOString()
    if (step.kind === 'thinking') {
      entries.push({ id: `cu-a-${index}`, type: 'assistant', timestamp, content: [{ type: 'thinking', thinking: step.text }] })
      return
    }
    if (step.kind === 'text') {
      entries.push({ id: `cu-a-${index}`, type: 'assistant', timestamp, content: [{ type: 'text', text: step.text }] })
      return
    }
    entries.push({ id: `cu-a-${index}`, type: 'assistant', timestamp, content: [{ type: 'tool_use', name: step.name, id: step.id, input: {} }] })
    entries.push({ id: `cu-u-${index}`, type: 'user', timestamp, content: [{ type: 'tool_result', tool_use_id: step.id, content: 'ok', is_error: false }] })
  })
  return entries
}

/**
 * Push the finished turn at the renderer exactly as the server emits it. Both
 * emit paths skip falsy thinking (`handler.ts` thinking_delta and the
 * no-stream-events assistant fallback), so the five empty transcript blocks
 * never reach the wire — `withEmptyThinking` exists only for the defensive case.
 */
function replayFinishedTurn(options: { withText: boolean; withEmptyThinking?: boolean }) {
  const store = useChatStore.getState()
  for (const step of FINISHED_COMPUTER_USE_TURN) {
    if (step.kind === 'thinking') {
      if (step.text || options.withEmptyThinking) {
        store.handleServerMessage(TEST_SESSION_ID, { type: 'thinking', text: step.text })
      }
      continue
    }
    if (step.kind === 'text') {
      if (options.withText) store.handleServerMessage(TEST_SESSION_ID, { type: 'content_delta', text: step.text })
      continue
    }
    store.handleServerMessage(TEST_SESSION_ID, {
      type: 'tool_use_complete',
      toolName: step.name,
      toolUseId: step.id,
      input: {},
    })
    store.handleServerMessage(TEST_SESSION_ID, {
      type: 'tool_result',
      toolUseId: step.id,
      content: 'ok',
      isError: false,
    })
  }
}

function thinkingBlocks() {
  return (useChatStore.getState().sessions[TEST_SESSION_ID]?.messages ?? [])
    .filter((message) => message.type === 'thinking')
    .map((message) => message.content)
}

describe('chatStore wake replay of a finished thinking turn', () => {
  beforeEach(async () => {
    sendMock.mockReset()
    notifyDesktopMock.mockReset()
    updateTabStatusMock.mockReset()
    getMemberBySessionIdMock.mockReset()
    getMemberBySessionIdMock.mockReturnValue(null)
    connectionStateHandlers.clear()
    vi.mocked(sessionsApi.getMessages).mockReset()
    vi.mocked(sessionsApi.getMessages).mockResolvedValue({ messages: buildFinishedTurnHistory() })
    localStorage.clear()
    useSettingsStore.setState({ locale: 'en' })
    useChatStore.setState({
      ...initialState,
      sessions: { [TEST_SESSION_ID]: makeSession({ chatState: 'idle', messages: [] }) },
    })
    await useChatStore.getState().loadHistory(TEST_SESSION_ID)
  })

  afterEach(() => {
    const timer = useChatStore.getState().sessions[TEST_SESSION_ID]?.elapsedTimer
    if (timer) clearInterval(timer)
  })

  it('hydrates the finished turn as eight non-empty thinking blocks', () => {
    // Sanity check on the fixture: history mapping drops the five empty
    // thinking blocks, so anything empty on screen came from the stream path.
    expect(thinkingBlocks()).toHaveLength(8)
    expect(thinkingBlocks().every((content) => content.trim().length > 0)).toBe(true)
  })

  it('does not re-append hydrated thinking when a finished turn is replayed after wake', () => {
    const before = thinkingBlocks()

    replayFinishedTurn({ withText: false })

    expect(thinkingBlocks()).toEqual(before)
  })

  // Defensive. The transcript really does hold five empty thinking blocks and
  // history mapping filters them, but no server emit path puts an empty
  // thinking event on the wire today — so a collapsed "已思考" row on screen is
  // not by itself proof that an empty block was streamed.
  it('does not spawn empty thinking bubbles from replayed empty thinking events', () => {
    replayFinishedTurn({ withText: false, withEmptyThinking: true })

    expect(thinkingBlocks().filter((content) => !content.trim())).toEqual([])
  })

  it('does not merge the turn tail into the turn head when the replay wraps around', () => {
    replayFinishedTurn({ withText: false })
    replayFinishedTurn({ withText: false })

    // The last thinking block of one replay round and the first of the next
    // arrive back to back with nothing between them, so the merge branch glues
    // two unrelated reasoning blocks into a single bubble.
    expect(thinkingBlocks().filter((content) =>
      content.includes(LAST_THINKING.text) && content.includes(FIRST_THINKING.text),
    )).toEqual([])
  })

  it('does not grow the thinking wall with every extra replay round', () => {
    const hydrated = thinkingBlocks().length

    replayFinishedTurn({ withText: false })
    const afterFirst = thinkingBlocks().length
    replayFinishedTurn({ withText: false })
    const afterSecond = thinkingBlocks().length

    expect({ afterFirst, afterSecond }).toEqual({
      afterFirst: hydrated,
      afterSecond: hydrated,
    })
  })

  // Reply text is deliberately NOT deduped here any more, and this test records why.
  //
  // de52656bb added two defences at once: uuid dedup on the server, and a content-
  // equality scan in this store. Only the first can be correct — the second cannot
  // tell a replay from a reply the model genuinely produced twice, and it dropped the
  // second one with no way to get it back (see 'keeps a reply the agent genuinely
  // produced twice in one turn'). d39e82b62 tried to bound the scan and was reverted
  // in 3a630db11.
  //
  // Removing it is safe because a whole-turn replay cannot reach this store: the SDK
  // channel has exactly one ingress, handler.ts:583 -> handleSdkPayload, which drops
  // every already-seen uuid at conversationService.ts:1047 before parsing goes any
  // further. Its 2000-uuid window covers the worst case de52656bb measured, 858
  // messages replayed 31 times.
  //
  // So this asserts what the store is actually responsible for: replayed text arrives
  // as normal text and is appended: the identity check belongs upstream. The thinking
  // case above still dedupes, because a thinking block carries no id at all — that
  // guard has no identity-based alternative to defer to.
  it('appends replayed reply text, leaving replay identity to the server', () => {
    const assistantTextOf = () => (useChatStore.getState().sessions[TEST_SESSION_ID]?.messages ?? [])
      .filter((message) => message.type === 'assistant_text')
      .map((message) => message.content)
    const before = assistantTextOf()

    replayFinishedTurn({ withText: true })

    expect(assistantTextOf().length).toBeGreaterThan(before.length)
  })
})

// Regression coverage for the activity panel losing its rows: visibility is
// derived from volatile client caches, so the reset/reload/abort paths below
// must not drain background task state.
describe('chatStore activity state survival across reload paths', () => {
  const runningTask = {
    taskId: 'agent-task-1',
    taskType: 'agent',
    status: 'running' as const,
    startedAt: 10,
    updatedAt: 10,
  }

  beforeEach(() => {
    sendMock.mockReset()
    getMemberBySessionIdMock.mockReset()
    getMemberBySessionIdMock.mockReturnValue(null)
    fetchSessionTasksMock.mockReset()
    setTasksFromTodosMock.mockReset()
    markCompletedAndDismissedMock.mockReset()
    updateTabStatusMock.mockReset()
    connectionStateHandlers.clear()
    vi.mocked(sessionsApi.getMessages).mockReset()
    vi.mocked(sessionsApi.getMessages).mockResolvedValue({ messages: [] })
    vi.mocked(sessionsApi.getSlashCommands).mockReset()
    vi.mocked(sessionsApi.getSlashCommands).mockResolvedValue({ commands: [] })
    sessionStoreSnapshot.sessions = []
    cliTaskStoreSnapshot.tasks = []
    cliTaskStoreSnapshot.sessionId = null
    localStorage.clear()
    useSettingsStore.setState({ locale: 'en' })
    useChatStore.setState({
      ...initialState,
      sessions: {},
    })
  })

  it('reloadHistory keeps running background tasks that are not in the transcript yet', async () => {
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'idle',
          messages: [{ id: 'm1', type: 'assistant_text', content: 'old', timestamp: 1 }],
          backgroundAgentTasks: { 'agent-task-1': runningTask },
        }),
      },
    })

    await useChatStore.getState().reloadHistory(TEST_SESSION_ID)

    expect(
      useChatStore.getState().sessions[TEST_SESSION_ID]?.backgroundAgentTasks?.['agent-task-1'],
    ).toMatchObject({ status: 'running' })
  })

  it('reloadHistory still lets transcript terminal state reconcile a stopped task', async () => {
    vi.mocked(sessionsApi.getMessages).mockResolvedValueOnce({
      messages: [],
      taskNotifications: [
        {
          taskId: 'agent-task-1',
          toolUseId: 'tool-use-1',
          status: 'stopped',
          summary: 'Stopped',
          timestamp: '2026-08-02T00:00:10.000Z',
        },
      ],
    } as never)
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'idle',
          messages: [{ id: 'm1', type: 'assistant_text', content: 'old', timestamp: 1 }],
          backgroundAgentTasks: { 'agent-task-1': runningTask },
        }),
      },
    })

    await useChatStore.getState().reloadHistory(TEST_SESSION_ID)

    expect(
      useChatStore.getState().sessions[TEST_SESSION_ID]?.backgroundAgentTasks?.['agent-task-1']?.status,
    ).toBe('stopped')
  })

  it('connectToSession reset branch preserves background activity of a disconnected session', () => {
    const notifications = {
      'agent-task-1': {
        taskId: 'agent-task-1',
        toolUseId: 'tool-use-1',
        status: 'running' as const,
        summary: 'Working',
        timestamp: 10,
      },
    }
    useChatStore.setState({
      sessions: {
        [TEST_SESSION_ID]: makeSession({
          chatState: 'idle',
          connectionState: 'disconnected',
          messages: [{ id: 'm1', type: 'assistant_text', content: 'old', timestamp: 1 }],
          backgroundAgentTasks: { 'agent-task-1': runningTask },
          agentTaskNotifications: notifications as never,
        }),
      },
    })

    useChatStore.getState().connectToSession(TEST_SESSION_ID)

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.backgroundAgentTasks?.['agent-task-1']).toMatchObject({ status: 'running' })
    expect(session?.agentTaskNotifications).toEqual(notifications)
  })

  it('retries a history load aborted by a concurrent task mutation when messages are empty', async () => {
    vi.useFakeTimers()
    try {
      let resolveFirstFetch!: (value: { messages: MessageEntry[] }) => void
      vi.mocked(sessionsApi.getMessages)
        .mockImplementationOnce(
          () => new Promise((resolve) => { resolveFirstFetch = resolve }),
        )
        .mockResolvedValueOnce({
          messages: [
            {
              id: 'assistant-1',
              type: 'assistant',
              timestamp: '2026-04-06T00:00:00.000Z',
              content: [{ type: 'text', text: '恢复的历史' }],
            } as never,
          ],
        })
      useChatStore.setState({
        sessions: {
          [TEST_SESSION_ID]: makeSession({ chatState: 'idle', messages: [] }),
        },
      })

      const loadPromise = useChatStore.getState().loadHistory(TEST_SESSION_ID)
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [TEST_SESSION_ID]: {
            ...state.sessions[TEST_SESSION_ID],
            historyMutationEpoch: 1,
          } as never,
        },
      }))
      resolveFirstFetch({ messages: [] })
      await loadPromise

      // The stale fetch was discarded; the retry must repopulate on its own.
      expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(200)
      await vi.runAllTimersAsync()

      const session = useChatStore.getState().sessions[TEST_SESSION_ID]
      expect(session?.historyStatus).toBe('ready')
      expect(session?.messages.some((message) => message.type === 'assistant_text')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
