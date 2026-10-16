import { beforeEach, describe, expect, it, vi } from 'vitest'

const sessionsApiMock = vi.hoisted(() => ({
  delete: vi.fn(() => Promise.resolve()),
  batchDelete: vi.fn(async (ids: string[]) => ({ successes: ids, failures: [] })),
  list: vi.fn(async () => ({ sessions: [] })),
  getSummary: vi.fn(),
}))
vi.mock('../api/sessions', () => ({ sessionsApi: sessionsApiMock }))

import { ApiError } from '../api/client'
import { createDefaultSessionState, useChatStore } from './chatStore'
import { useSessionStore } from './sessionStore'
import { closeTabsWithPolicy, reopenClosedSessionTab } from './tabClose'
import { useTabStore } from './tabStore'

const initialSessionState = useSessionStore.getState()
const connectToSession = vi.fn()

function summary(id: string, title = id) {
  return {
    id,
    title,
    createdAt: '2026-10-01T00:00:00.000Z',
    modifiedAt: '2026-10-02T00:00:00.000Z',
    messageCount: 4,
    projectPath: '-workspace-repo',
    workDir: '/workspace/repo',
    workDirExists: true,
  }
}

beforeEach(() => {
  sessionsApiMock.getSummary.mockReset()
  connectToSession.mockReset()
  useTabStore.setState({ tabs: [], activeTabId: null, closedSessionTabs: [] })
  useSessionStore.setState({ ...initialSessionState, sessions: [], historicalSessionIds: new Set() })
  useChatStore.setState({ sessions: {}, connectToSession, disconnectSession: vi.fn() } as never)
})

describe('reopening a closed chat tab', () => {
  it('opens the most recently closed chat and connects to it', async () => {
    useSessionStore.setState({ sessions: [summary('a'), summary('b', 'Session B')] as never })
    useTabStore.setState({ closedSessionTabs: [{ sessionId: 'a', title: 'A' }, { sessionId: 'b', title: 'B' }] })

    await expect(reopenClosedSessionTab()).resolves.toBe(true)

    expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual(['b'])
    expect(useTabStore.getState().tabs[0]?.title).toBe('Session B')
    expect(useTabStore.getState().activeTabId).toBe('b')
    expect(connectToSession).toHaveBeenCalledWith('b')
    expect(useTabStore.getState().closedSessionTabs).toEqual([{ sessionId: 'a', title: 'A' }])
  })

  it('looks up a chat that is not in the loaded list, and skips one deleted since', async () => {
    useTabStore.setState({ closedSessionTabs: [{ sessionId: 'old', title: 'Old' }, { sessionId: 'deleted', title: 'Gone' }] })
    sessionsApiMock.getSummary.mockImplementation(async (id: string) => {
      if (id === 'deleted') throw new ApiError(404, 'Session not found')
      return summary(id, 'Old session')
    })

    await expect(reopenClosedSessionTab()).resolves.toBe(true)

    expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual(['old'])
    expect(useTabStore.getState().closedSessionTabs).toEqual([])
  })

  it('skips a chat whose tab is already open again', async () => {
    useSessionStore.setState({ sessions: [summary('a'), summary('b')] as never })
    useTabStore.getState().openTab('b', 'B')
    useTabStore.setState({ closedSessionTabs: [{ sessionId: 'a', title: 'A' }, { sessionId: 'b', title: 'B' }] })

    await reopenClosedSessionTab()

    expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual(['b', 'a'])
  })

  it('keeps the entry when the server cannot be reached', async () => {
    useTabStore.setState({ closedSessionTabs: [{ sessionId: 'a', title: 'A' }] })
    sessionsApiMock.getSummary.mockRejectedValue(new Error('offline'))

    await expect(reopenClosedSessionTab()).resolves.toBe(false)

    expect(useTabStore.getState().tabs).toEqual([])
    expect(useTabStore.getState().closedSessionTabs).toEqual([{ sessionId: 'a', title: 'A' }])
  })

  it('does nothing when no chat tab was closed', async () => {
    await expect(reopenClosedSessionTab()).resolves.toBe(false)
    expect(connectToSession).not.toHaveBeenCalled()
  })
})

describe('deleted sessions are not offered back', () => {
  const closedIds = () => useTabStore.getState().closedSessionTabs.map((tab) => tab.sessionId)

  it('drops a closed tab once its session is deleted from the sidebar', async () => {
    useSessionStore.setState({ sessions: [summary('del-closed-first'), summary('del-kept')] as never })
    useTabStore.getState().openTab('del-closed-first', 'A')
    useTabStore.getState().openTab('del-kept', 'B')
    useTabStore.getState().closeTab('del-closed-first')
    useTabStore.getState().closeTab('del-kept')

    await useSessionStore.getState().deleteSession('del-closed-first')

    expect(closedIds()).toEqual(['del-kept'])
  })

  it('does not remember a tab the delete flow closes after deleting its session', async () => {
    // The sidebar, batch delete and the phone list all delete first, then close the tab.
    useSessionStore.setState({ sessions: [summary('del-open-1'), summary('del-open-2'), summary('del-open-3')] as never })
    for (const id of ['del-open-1', 'del-open-2', 'del-open-3']) useTabStore.getState().openTab(id, id)

    await useSessionStore.getState().deleteSession('del-open-1')
    useTabStore.getState().closeTab('del-open-1')
    const result = await useSessionStore.getState().deleteSessions(['del-open-2', 'del-open-3'])
    for (const id of result.successes) useTabStore.getState().closeTab(id)

    expect(closedIds()).toEqual([])
    expect(useTabStore.getState().tabs).toEqual([])
  })

  it('does not offer back an unused "New session" deleted when its tab closes', () => {
    useSessionStore.setState({ sessions: [{ ...summary('del-placeholder', 'New Session'), messageCount: 0 }] as never })
    useTabStore.getState().openTab('del-placeholder', 'New Session')
    useChatStore.setState({
      sessions: { 'del-placeholder': { ...createDefaultSessionState(), historyStatus: 'ready' } },
    } as never)

    closeTabsWithPolicy(useTabStore.getState().tabs, [], false)

    expect(sessionsApiMock.delete).toHaveBeenCalledWith('del-placeholder')
    expect(closedIds()).toEqual([])
  })
})
