import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  updateSessionPermissionModeMock,
  sessionStoreSnapshot,
  cliTaskStoreSnapshot,
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
}))

vi.mock('../lib/desktopNotifications', () => ({
  notifyDesktop: notifyDesktopMock,
}))

vi.mock('../api/websocket', () => ({
  wsManager: {
    connect: vi.fn(),
    disconnect: vi.fn(),
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
    vi.mocked(sessionsApi.getMessages).mockReset()
    vi.mocked(sessionsApi.getMessages).mockResolvedValue({ messages: [] })
    sessionStoreSnapshot.sessions = []
    cliTaskStoreSnapshot.tasks = []
    cliTaskStoreSnapshot.sessionId = null
    useSessionRuntimeStore.setState({ selections: {} })
    localStorage.clear()
    useChatStore.setState({
      ...initialState,
      sessions: {},
    })
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

  it('does not restore internal slash-command breadcrumbs as user history bubbles', () => {
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
        id: 'transcript-user-1',
        type: 'user',
        timestamp: '2026-06-15T03:32:15.000Z',
        content: '继续处理这个问题',
      },
    ]

    expect(mapHistoryMessagesToUiMessages(messages)).toMatchObject([
      {
        id: 'transcript-user-1',
        type: 'user_text',
        content: '继续处理这个问题',
      },
    ])
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
      toolUseId: 'tool-1',
      input: { file_path: 'src/App.tsx' },
      parentToolUseId: 'agent-1',
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'tool_result',
      toolUseId: 'tool-1',
      content: 'ok',
      isError: false,
      parentToolUseId: 'agent-1',
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      {
        type: 'tool_use',
        toolUseId: 'tool-1',
        parentToolUseId: 'agent-1',
      },
      {
        type: 'tool_result',
        toolUseId: 'tool-1',
        parentToolUseId: 'agent-1',
      },
    ])
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
      toolUseId: 'tool-1',
      parentToolUseId: 'agent-1',
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'tool_use_complete',
      toolName: 'Read',
      toolUseId: 'tool-1',
      input: { file_path: 'src/App.tsx' },
    })

    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'tool_result',
      toolUseId: 'tool-1',
      content: 'ok',
      isError: false,
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      {
        type: 'tool_use',
        toolUseId: 'tool-1',
        parentToolUseId: 'agent-1',
      },
      {
        type: 'tool_result',
        toolUseId: 'tool-1',
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

  it('replays saved runtime selection when reconnecting a session', () => {
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

  it('prewarms regular desktop sessions when connecting', () => {
    useChatStore.getState().connectToSession(TEST_SESSION_ID)

    expect(sendMock).toHaveBeenCalledWith(TEST_SESSION_ID, {
      type: 'prewarm_session',
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
    expect(updateSessionPermissionModeMock).toHaveBeenCalledWith('session-1', 'acceptEdits')
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

  it('ignores permission-mode broadcasts for modes the selector cannot render', () => {
    updateSessionPermissionModeMock.mockReset()

    // 'auto' 不在桌面端 PermissionMode 内（仅在 CLI 启用对应特性时存在），
    // 直接忽略，避免选择器拿到无法渲染的值。
    useChatStore.getState().handleServerMessage(TEST_SESSION_ID, {
      type: 'permission_mode_changed',
      mode: 'auto' as never,
    })

    expect(updateSessionPermissionModeMock).not.toHaveBeenCalled()
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
    vi.useRealTimers()
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

    const session = useChatStore.getState().sessions[TEST_SESSION_ID]
    expect(session?.messages).toEqual([])
    expect(session?.streamingText).toBe('')
    expect(session?.chatState).toBe('idle')
    expect(session?.tokenUsage).toEqual({ input_tokens: 0, output_tokens: 0 })
    expect(session?.streamingResponseChars).toBe(0)
    expect(session?.slashCommands).toEqual([])
    expect(clearTasksMock).toHaveBeenCalledWith(TEST_SESSION_ID)

    vi.advanceTimersByTime(60)
    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.streamingText).toBe('')
    vi.useRealTimers()
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
      message: 'provider failed',
      code: 'provider_error',
    })

    expect(useChatStore.getState().sessions[TEST_SESSION_ID]?.messages).toMatchObject([
      { type: 'assistant_text', content: 'partial answer before error' },
      { type: 'error', message: 'provider failed' },
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
