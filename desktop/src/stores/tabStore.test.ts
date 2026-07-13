import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionsApi } from '../api/sessions'
import { useSessionRuntimeStore } from './sessionRuntimeStore'
import { SETTINGS_TAB_ID, MARKET_TAB_ID, useTabStore } from './tabStore'

vi.mock('../api/sessions', () => ({
  sessionsApi: {
    list: vi.fn(async () => ({ sessions: [] })),
  },
}))

describe('tabStore', () => {
  beforeEach(() => {
    useTabStore.setState({ tabs: [], activeTabId: null })
    localStorage.clear()
    useSessionRuntimeStore.setState({ selections: {} })
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

  it('repairs an existing special tab type when opened through its canonical entrypoint', () => {
    useTabStore.setState({
      tabs: [{ sessionId: SETTINGS_TAB_ID, title: 'Market', type: 'market', status: 'idle' }],
      activeTabId: SETTINGS_TAB_ID,
    })

    useTabStore.getState().openTab(SETTINGS_TAB_ID, 'Settings', 'settings')

    expect(useTabStore.getState().tabs).toEqual([
      {
        sessionId: SETTINGS_TAB_ID,
        title: 'Settings',
        type: 'settings',
        status: 'idle',
      },
    ])
    expect(useTabStore.getState().activeTabId).toBe(SETTINGS_TAB_ID)
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

  it('opens one ephemeral workbench tab per source session', () => {
    const firstTabId = useTabStore.getState().openWorkbenchTab('session-1', 'Workbench')
    const secondTabId = useTabStore.getState().openWorkbenchTab('session-1', 'Workbench')

    expect(firstTabId).toBe('__workbench__session-1')
    expect(secondTabId).toBe(firstTabId)
    expect(useTabStore.getState().tabs).toEqual([
      {
        sessionId: '__workbench__session-1',
        title: 'Workbench',
        type: 'workbench',
        status: 'idle',
        workbenchSessionId: 'session-1',
        sourceSessionId: 'session-1',
      },
    ])
    expect(useTabStore.getState().activeTabId).toBe('__workbench__session-1')
    expect(localStorage.getItem('cc-haha-open-tabs')).toBe(JSON.stringify({
      openTabs: [],
      activeTabId: null,
    }))
  })

  it('returns an ephemeral workbench tab to its source session before closing it', () => {
    useTabStore.getState().openTab('session-a', 'Session A')
    useTabStore.getState().openTab('session-b', 'Session B')
    const tabId = useTabStore.getState().openWorkbenchTab('session-b', 'Workbench', {
      sourceSessionId: 'session-b',
      sourceTurnKey: 'assistant:turn-2',
      sourceElementId: 'turn-change-session-b-main-ts',
    })

    useTabStore.getState().returnFromWorkbench(tabId)

    expect(useTabStore.getState().activeTabId).toBe('session-b')
    expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual(['session-a', 'session-b'])
  })

  it('defaults a workbench origin to its source session and keeps it ephemeral', () => {
    useTabStore.getState().openTab('session-a', 'Session A')
    const tabId = useTabStore.getState().openWorkbenchTab('session-a', 'Workbench')

    expect(useTabStore.getState().tabs.find((tab) => tab.sessionId === tabId)).toMatchObject({
      sourceSessionId: 'session-a',
    })
    expect(localStorage.getItem('cc-haha-open-tabs')).toBe(JSON.stringify({
      openTabs: [{ sessionId: 'session-a', title: 'Session A', type: 'session' }],
      activeTabId: 'session-a',
    }))
  })

  it('persists the source session as active while its ephemeral workbench is active', () => {
    useTabStore.getState().openTab('session-a', 'Session A')
    useTabStore.getState().openTab('session-b', 'Session B')
    useTabStore.getState().openWorkbenchTab('session-b', 'Workbench')

    expect(localStorage.getItem('cc-haha-open-tabs')).toBe(JSON.stringify({
      openTabs: [
        { sessionId: 'session-a', title: 'Session A', type: 'session' },
        { sessionId: 'session-b', title: 'Session B', type: 'session' },
      ],
      activeTabId: 'session-b',
    }))
  })

  it('opens one ephemeral SubAgent tab per source session and tool use', () => {
    const tabId = useTabStore.getState().openSubagentTab('session-1', 'tool-1', 'Kuhn')
    const sameTabId = useTabStore.getState().openSubagentTab('session-1', 'tool-1', 'Kuhn updated')

    expect(tabId).toBe('__subagent__session-1__tool-1')
    expect(sameTabId).toBe(tabId)
    expect(useTabStore.getState().tabs).toEqual([
      {
        sessionId: '__subagent__session-1__tool-1',
        title: 'Kuhn updated',
        type: 'subagent',
        status: 'idle',
        sourceSessionId: 'session-1',
        subagentToolUseId: 'tool-1',
      },
    ])
    expect(useTabStore.getState().activeTabId).toBe('__subagent__session-1__tool-1')
    expect(localStorage.getItem('cc-haha-open-tabs')).toBe(JSON.stringify({
      openTabs: [],
      activeTabId: null,
    }))
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

  it('restores the market tab without requiring a server session', async () => {
    localStorage.setItem('cc-haha-open-tabs', JSON.stringify({
      openTabs: [{ sessionId: MARKET_TAB_ID, title: 'Market', type: 'market' }],
      activeTabId: MARKET_TAB_ID,
    }))

    await useTabStore.getState().restoreTabs()

    expect(useTabStore.getState().tabs).toEqual([
      {
        sessionId: MARKET_TAB_ID,
        title: 'Market',
        type: 'market',
        status: 'idle',
      },
    ])
    expect(useTabStore.getState().activeTabId).toBe(MARKET_TAB_ID)
  })

  it('hydrates restored tabs with authoritative transcript runtime metadata', async () => {
    useSessionRuntimeStore.getState().setSelection('session-1', {
      providerId: null,
      modelId: 'gpt-5.4',
      effortLevel: 'max',
    })
    localStorage.setItem('cc-haha-open-tabs', JSON.stringify({
      openTabs: [{ sessionId: 'session-1', title: 'Runtime session', type: 'session' }],
      activeTabId: 'session-1',
    }))
    vi.mocked(sessionsApi.list).mockResolvedValue({
      sessions: [{
        id: 'session-1',
        title: 'Runtime session',
        runtimeProviderId: 'provider-latest',
        runtimeModelId: 'anthropic/claude-opus-4.7',
        effortLevel: 'max',
      }],
      total: 1,
    } as never)

    await useTabStore.getState().restoreTabs()

    expect(useSessionRuntimeStore.getState().selections['session-1']).toEqual({
      providerId: 'provider-latest',
      modelId: 'anthropic/claude-opus-4.7',
      effortLevel: 'max',
    })
  })

  it('canonicalizes mismatched persisted special tab ids and types during restore', async () => {
    localStorage.setItem('cc-haha-open-tabs', JSON.stringify({
      openTabs: [
        { sessionId: SETTINGS_TAB_ID, title: 'Settings', type: 'market' },
        { sessionId: MARKET_TAB_ID, title: 'Market', type: 'settings' },
      ],
      activeTabId: SETTINGS_TAB_ID,
    }))

    await useTabStore.getState().restoreTabs()

    expect(useTabStore.getState().tabs).toEqual([
      {
        sessionId: SETTINGS_TAB_ID,
        title: 'Settings',
        type: 'settings',
        status: 'idle',
      },
      {
        sessionId: MARKET_TAB_ID,
        title: 'Market',
        type: 'market',
        status: 'idle',
      },
    ])
    expect(useTabStore.getState().activeTabId).toBe(SETTINGS_TAB_ID)
  })
})
