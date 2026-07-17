import { beforeEach, describe, expect, it, vi } from 'vitest'

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
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
    list: vi.fn(),
    getMessages: vi.fn(async () => ({ messages: [] })),
    getSlashCommands: vi.fn(async () => ({ commands: [] })),
  },
}))

vi.mock('./cliTaskStore', () => ({
  useCLITaskStore: {
    getState: () => ({
      fetchSessionTasks: vi.fn(),
      setTasksFromTodos: vi.fn(),
      markCompletedAndDismissed: vi.fn(),
      refreshTasks: vi.fn(),
      clearTasks: vi.fn(),
    }),
  },
}))

vi.mock('./teamStore', () => ({
  useTeamStore: {
    getState: () => ({
      getMemberBySessionId: vi.fn(() => null),
    }),
  },
}))

import { sessionsApi } from '../api/sessions'
import { useChatStore } from './chatStore'
import { useSessionRuntimeStore } from './sessionRuntimeStore'
import { useSessionStore } from './sessionStore'
import { useTabStore } from './tabStore'

const SESSION_ID = 'restored-session-1'
const initialChatState = useChatStore.getState()

describe('restored session prewarm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useTabStore.setState({ tabs: [], activeTabId: null })
    useSessionStore.setState({ sessions: [], activeSessionId: null })
    useSessionRuntimeStore.setState({ selections: {} })
    useChatStore.setState({ ...initialChatState, sessions: {} })
  })

  it('does not prewarm an existing transcript after the real tab restore sequence', async () => {
    localStorage.setItem('cc-haha-open-tabs', JSON.stringify({
      openTabs: [{ sessionId: SESSION_ID, title: 'Existing transcript', type: 'session' }],
      activeTabId: SESSION_ID,
    }))
    vi.mocked(sessionsApi.list).mockResolvedValue({
      sessions: [{
        id: SESSION_ID,
        title: 'Existing transcript',
        createdAt: '2026-07-16T10:00:00.000Z',
        modifiedAt: '2026-07-16T10:30:00.000Z',
        messageCount: 4,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      total: 1,
    } as never)

    await useTabStore.getState().restoreTabs()
    const restoredSessionId = useTabStore.getState().activeTabId

    expect(restoredSessionId).toBe(SESSION_ID)
    expect(useSessionStore.getState().sessions).toEqual([])

    useChatStore.getState().connectToSession(restoredSessionId!)

    expect(sendMock).not.toHaveBeenCalledWith(SESSION_ID, { type: 'prewarm_session' })
  })
})
