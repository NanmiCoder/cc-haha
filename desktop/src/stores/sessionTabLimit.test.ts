// The tab limit closes chat tabs through the same path as the tab strip's own
// close, so these tests drive the real tab, chat and session stores and only
// stub the network edge (session API) and the socket teardown.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sessionsApiMock = vi.hoisted(() => ({
  delete: vi.fn(() => Promise.resolve()),
  list: vi.fn(async () => ({ sessions: [] })),
  getSummary: vi.fn(),
}))
vi.mock('../api/sessions', () => ({ sessionsApi: sessionsApiMock }))

import { createDefaultSessionState, useChatStore, type PerSessionState } from './chatStore'
import { installSessionTabLimit } from './sessionTabLimit'
import { useTabBehaviorStore } from './tabBehaviorStore'
import { SETTINGS_TAB_ID, useTabStore } from './tabStore'
import { useTeamStore } from './teamStore'
import { DEFAULT_TAB_BEHAVIOR } from '../lib/tabBehavior'

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve))
const tabIds = () => useTabStore.getState().tabs.map((tab) => tab.sessionId)

let uninstall: (() => void) | undefined
const disconnectSession = vi.fn()

function setSession(sessionId: string, patch: Partial<PerSessionState> = {}) {
  useChatStore.setState((state) => ({
    sessions: { ...state.sessions, [sessionId]: { ...createDefaultSessionState(), historyStatus: 'ready', ...patch } },
  }))
}

/** Opens chat tabs one after another, each becoming the active tab. */
async function openSessions(...ids: string[]) {
  for (const id of ids) {
    useTabStore.getState().openTab(id, id)
    await flush()
  }
}

beforeEach(() => {
  localStorage.clear()
  sessionsApiMock.delete.mockClear()
  disconnectSession.mockReset()
  useTabStore.setState({ tabs: [], activeTabId: null, closedSessionTabs: [] })
  useChatStore.setState({ sessions: {}, disconnectSession } as never)
  useTeamStore.setState({ teamNameBySession: {} } as never)
  useTabBehaviorStore.setState({ behavior: { ...DEFAULT_TAB_BEHAVIOR } })
})

afterEach(() => {
  uninstall?.()
  uninstall = undefined
})

describe('session tab limit', () => {
  it('keeps every tab when no limit is set, as before the setting existed', async () => {
    uninstall = installSessionTabLimit()
    await openSessions('a', 'b', 'c', 'd', 'e', 'f', 'g')
    expect(tabIds()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
  })

  it('closes the tab looked at least recently when a new one goes over the limit', async () => {
    useTabBehaviorStore.getState().setBehavior({ sessionTabLimit: 5 })
    uninstall = installSessionTabLimit()
    await openSessions('a', 'b', 'c', 'd', 'e')
    // Looking at "a" again makes "b" the oldest one.
    useTabStore.getState().setActiveTab('a')
    await openSessions('f')

    expect(tabIds()).toEqual(['a', 'c', 'd', 'e', 'f'])
    expect(useTabStore.getState().activeTabId).toBe('f')
    // Closing a tab releases its socket but never deletes the session.
    expect(disconnectSession).toHaveBeenCalledWith('b')
    expect(sessionsApiMock.delete).not.toHaveBeenCalled()
    expect(useTabStore.getState().closedSessionTabs.map((tab) => tab.sessionId)).toEqual(['b'])
  })

  it('does not close anything while the person only switches between tabs', async () => {
    useTabBehaviorStore.getState().setBehavior({ sessionTabLimit: 5 })
    uninstall = installSessionTabLimit()
    await openSessions('a', 'b', 'c', 'd', 'e')
    for (const id of ['a', 'b', 'c', 'd', 'e']) setSession(id, { chatState: 'streaming' })
    await openSessions('f')
    expect(tabIds()).toHaveLength(6)

    // The runs finish and the person moves around: nothing closes behind their back.
    for (const id of ['a', 'b', 'c', 'd', 'e']) setSession(id, { chatState: 'idle' })
    useTabStore.getState().setActiveTab('b')
    useTabStore.getState().setActiveTab('c')
    await flush()
    expect(tabIds()).toHaveLength(6)

    // The next tab they open brings the count back to the limit.
    await openSessions('g')
    expect(tabIds()).toEqual(['b', 'c', 'e', 'f', 'g'])
  })

  it('applies a lowered limit right away, keeping the most recently viewed tabs', async () => {
    uninstall = installSessionTabLimit()
    await openSessions('a', 'b', 'c', 'd', 'e', 'f')
    useTabStore.getState().setActiveTab('b')
    useTabBehaviorStore.getState().setBehavior({ sessionTabLimit: 5 })
    await flush()
    expect(tabIds()).toEqual(['b', 'c', 'd', 'e', 'f'])
  })

  it('closes restored tabs that were never looked at first, leftmost first', async () => {
    useTabBehaviorStore.getState().setBehavior({ sessionTabLimit: 5 })
    uninstall = installSessionTabLimit()
    useTabStore.setState({
      tabs: ['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => ({ sessionId: id, title: id, type: 'session', status: 'idle' })),
      activeTabId: 'r5',
    })
    await flush()
    await openSessions('n1', 'n2')
    expect(tabIds()).toEqual(['r3', 'r4', 'r5', 'n1', 'n2'])
  })

  it('does not count settings and other page tabs', async () => {
    useTabBehaviorStore.getState().setBehavior({ sessionTabLimit: 5 })
    uninstall = installSessionTabLimit()
    useTabStore.getState().openTab(SETTINGS_TAB_ID, 'Settings', 'settings')
    await openSessions('a', 'b', 'c', 'd', 'e')
    expect(tabIds()).toEqual([SETTINGS_TAB_ID, 'a', 'b', 'c', 'd', 'e'])
  })

  it.each<[string, Partial<PerSessionState>]>([
    ['a running turn', { chatState: 'streaming' }],
    ['a pending approval', { pendingPermission: { requestId: 'p1' } as never }],
    ['a CLI still running background work', { cliRunState: 'running' }],
    ['an unsent message in the composer', { composerDraft: { input: 'half a thought', attachments: [] } }],
  ])('keeps a tab with %s and lets the count go over the limit', async (_label, patch) => {
    useTabBehaviorStore.getState().setBehavior({ sessionTabLimit: 5 })
    uninstall = installSessionTabLimit()
    await openSessions('busy', 'b', 'c', 'd', 'e')
    setSession('busy', patch)
    await openSessions('f')
    expect(tabIds()).toEqual(['busy', 'c', 'd', 'e', 'f'])

    // When every other tab is protected too, nothing is forced closed.
    for (const id of ['c', 'd', 'e', 'f']) setSession(id, patch)
    await openSessions('g')
    expect(tabIds()).toEqual(['busy', 'c', 'd', 'e', 'f', 'g'])
  })

  it('keeps an Agent Teams lead and a chat another open tab is a view into', async () => {
    useTabBehaviorStore.getState().setBehavior({ sessionTabLimit: 5 })
    uninstall = installSessionTabLimit()
    await openSessions('lead', 'parent', 'c', 'd', 'e')
    useTeamStore.setState({ teamNameBySession: { lead: 'team-1' } } as never)
    useTabStore.getState().openSubagentTab('parent', 'tool-1', 'SubAgent')
    await openSessions('f')
    expect(tabIds()).toEqual(['lead', 'parent', 'd', 'e', '__subagent__parent__tool-1', 'f'])
  })

  it('keeps the viewing order when the limit is installed again, as after a phone-width round trip', async () => {
    useTabBehaviorStore.getState().setBehavior({ sessionTabLimit: 5 })
    uninstall = installSessionTabLimit()
    await openSessions('a', 'b', 'c', 'd', 'e')
    useTabStore.getState().setActiveTab('a')
    uninstall()
    uninstall = installSessionTabLimit()
    await openSessions('f')
    expect(tabIds()).toEqual(['a', 'c', 'd', 'e', 'f'])
  })

  it('stops acting once uninstalled', async () => {
    useTabBehaviorStore.getState().setBehavior({ sessionTabLimit: 5 })
    uninstall = installSessionTabLimit()
    uninstall()
    uninstall = undefined
    await openSessions('a', 'b', 'c', 'd', 'e', 'f')
    expect(tabIds()).toHaveLength(6)
  })
})
