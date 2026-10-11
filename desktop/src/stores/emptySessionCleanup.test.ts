import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sessionsApiMock = vi.hoisted(() => ({
  delete: vi.fn(async () => undefined),
}))
vi.mock('../api/sessions', () => ({ sessionsApi: sessionsApiMock }))

import { createDefaultSessionState, useChatStore, type PerSessionState } from './chatStore'
import { installEmptySessionCleanup } from './emptySessionCleanup'
import { useSessionStore } from './sessionStore'
import { SETTINGS_TAB_ID, useTabStore } from './tabStore'

/** The new-session page: no tab is shown and the chats stay warm. */
function showNewSessionPage() {
  useTabStore.setState((state) => ({ tabs: state.tabs.filter((tab) => tab.type === 'session'), activeTabId: null }))
  useTabStore.getState().saveTabs()
}


const initialSessionState = useSessionStore.getState()

function listed(id: string, overrides: Partial<{ title: string; messageCount: number }> = {}) {
  return {
    id,
    title: overrides.title ?? 'New Session',
    createdAt: '2026-10-11T00:00:00.000Z',
    modifiedAt: '2026-10-11T00:00:00.000Z',
    messageCount: overrides.messageCount ?? 0,
    projectPath: '/repo',
    workDir: '/repo',
    workDirExists: true,
  }
}

function chat(overrides: Partial<PerSessionState> = {}): PerSessionState {
  return { ...createDefaultSessionState(), historyStatus: 'ready', messages: [], ...overrides }
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('deleting a "New session" the person walked away from unused', () => {
  const disconnectSession = vi.fn()
  let uninstall: () => void

  beforeEach(() => {
    sessionsApiMock.delete.mockClear()
    disconnectSession.mockReset()
    localStorage.clear()
    useSessionStore.setState({ ...initialSessionState, sessions: [listed('empty'), listed('busy', { title: 'Fix login', messageCount: 4 })] })
    useChatStore.setState({
      sessions: { empty: chat(), busy: chat() },
      disconnectSession,
    } as Partial<ReturnType<typeof useChatStore.getState>>)
    useTabStore.setState({ tabs: [], activeTabId: null })
    useTabStore.getState().openTab('busy', 'Fix login')
    useTabStore.getState().openTab('empty', 'New session')
    uninstall = installEmptySessionCleanup(useChatStore)
  })

  afterEach(() => uninstall())

  it('deletes it when the person moves on to another chat', async () => {
    useTabStore.getState().setActiveTab('busy')
    await settle()

    expect(sessionsApiMock.delete).toHaveBeenCalledExactlyOnceWith('empty')
    expect(disconnectSession).toHaveBeenCalledWith('empty')
    expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual(['busy'])
    expect(useSessionStore.getState().sessions.map((session) => session.id)).toEqual(['busy'])
  })

  it('deletes it when the person goes to the new-session page instead', async () => {
    showNewSessionPage()
    await settle()

    expect(sessionsApiMock.delete).toHaveBeenCalledExactlyOnceWith('empty')
  })

  it('keeps it while a page is open on top of it, since the person is coming back', async () => {
    useTabStore.getState().openTab(SETTINGS_TAB_ID, 'Settings', 'settings')
    await settle()

    expect(sessionsApiMock.delete).not.toHaveBeenCalled()
  })

  it.each([
    ['something typed', { composerDraft: { input: 'half a question', attachments: [] } }],
    ['a message', { messages: [{ id: 'm1', type: 'user_text', content: 'hi', timestamp: 1 }] as PerSessionState['messages'] }],
    ['history still loading', { historyStatus: 'loading' as const }],
    ['a turn starting', { chatState: 'thinking' as const }],
  ])('keeps it when it holds %s', async (_, overrides) => {
    useChatStore.setState((state) => ({ sessions: { ...state.sessions, empty: chat(overrides as Partial<PerSessionState>) } }))

    useTabStore.getState().setActiveTab('busy')
    await settle()

    expect(sessionsApiMock.delete).not.toHaveBeenCalled()
  })

  it('keeps a session the server says has messages, or one with a real title', async () => {
    useSessionStore.setState({ sessions: [listed('empty', { messageCount: 1 }), listed('busy')] })
    useTabStore.getState().setActiveTab('busy')
    await settle()
    useTabStore.getState().setActiveTab('empty')
    useSessionStore.setState({ sessions: [listed('empty', { title: 'Named by hand' }), listed('busy')] })
    useTabStore.getState().setActiveTab('busy')
    await settle()

    expect(sessionsApiMock.delete).not.toHaveBeenCalled()
  })

  it('leaves an empty session that is swapped in place to the code that swaps it', async () => {
    useTabStore.getState().replaceTabSession('empty', 'worktree-session')
    await settle()

    expect(sessionsApiMock.delete).not.toHaveBeenCalled()
  })
})
