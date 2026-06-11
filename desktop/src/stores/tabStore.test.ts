import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionsApi } from '../api/sessions'
import { SETTINGS_TAB_ID, useTabStore } from './tabStore'

vi.mock('../api/sessions', () => ({
  sessionsApi: {
    list: vi.fn(async () => ({ sessions: [] })),
  },
}))

describe('tabStore', () => {
  beforeEach(() => {
    useTabStore.setState({ tabs: [], activeTabId: null })
    localStorage.clear()
    vi.mocked(sessionsApi.list).mockResolvedValue({ sessions: [] } as never)
  })

  it('refreshes an existing tab title when opening the same session again', () => {
    useTabStore.getState().openTab('session-1', '```json {"title":')
    useTabStore.getState().openTab('session-1', '使用bash写一个shell，随便写点什么东西')

    expect(useTabStore.getState().tabs).toHaveLength(1)
    expect(useTabStore.getState().tabs[0]).toMatchObject({
      sessionId: 'session-1',
      title: '使用bash写一个shell，随便写点什么东西',
      type: 'session',
    })
    expect(useTabStore.getState().activeTabId).toBe('session-1')
  })

  it('stores a promoted terminal runtime id on new terminal tabs', () => {
    const tabId = useTabStore.getState().openTerminalTab('/tmp/project', '__session_terminal__session-1')

    expect(useTabStore.getState().tabs).toEqual([
      {
        sessionId: tabId,
        title: 'Terminal 1',
        type: 'terminal',
        status: 'idle',
        terminalCwd: '/tmp/project',
        terminalRuntimeId: '__session_terminal__session-1',
      },
    ])
    expect(useTabStore.getState().activeTabId).toBe(tabId)
  })

  it('does not let async tab restore overwrite tabs opened while restore is in flight', async () => {
    let resolveSessions: (value: unknown) => void = () => {}
    vi.mocked(sessionsApi.list).mockReturnValueOnce(new Promise((resolve) => {
      resolveSessions = resolve
    }) as never)
    localStorage.setItem('cc-haha-open-tabs', JSON.stringify({
      openTabs: [{ sessionId: 'session-1', title: 'Old Session', type: 'session' }],
      activeTabId: 'session-1',
    }))

    const restore = useTabStore.getState().restoreTabs()
    useTabStore.getState().openTab(SETTINGS_TAB_ID, 'Settings', 'settings')
    resolveSessions({ sessions: [{ id: 'session-1', title: 'Old Session' }] })
    await restore

    expect(useTabStore.getState().activeTabId).toBe(SETTINGS_TAB_ID)
    expect(useTabStore.getState().tabs).toEqual([
      {
        sessionId: SETTINGS_TAB_ID,
        title: 'Settings',
        type: 'settings',
        status: 'idle',
      },
    ])
  })
})
