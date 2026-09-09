import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionsApi } from '../api/sessions'
import { ApiError } from '../api/client'
import { useSessionRuntimeStore } from './sessionRuntimeStore'
import { useSessionStore } from './sessionStore'
import { SETTINGS_TAB_ID, MARKET_TAB_ID, useTabStore } from './tabStore'

vi.mock('../api/sessions', () => ({
  sessionsApi: {
    list: vi.fn(async () => ({ sessions: [] })),
    getSummary: vi.fn(),
  },
}))

const initialSessionState = useSessionStore.getState()

function historicalSummary(id = 'historical-session') {
  return {
    id,
    title: 'Historical worktree',
    createdAt: '2020-01-01T00:00:00.000Z',
    modifiedAt: '2020-01-02T00:00:00.000Z',
    messageCount: 10,
    projectPath: '-workspace-repo-worktree',
    projectRoot: '/workspace/repo',
    workDir: '/workspace/repo/.claude/worktrees/old',
    workDirExists: false,
    workspaceState: 'worktree_removed' as const,
    permissionMode: 'plan',
    runtimeProviderId: 'historical-provider',
    runtimeModelId: 'historical-model',
    effortLevel: 'high' as const,
  }
}

describe('tabStore', () => {
  beforeEach(() => {
    useTabStore.setState({ tabs: [], activeTabId: null })
    useSessionStore.setState({ ...initialSessionState, sessions: [], historicalSessionIds: new Set() })
    localStorage.clear()
    useSessionRuntimeStore.setState({ selections: {} })
    vi.mocked(sessionsApi.list).mockReset().mockResolvedValue({ sessions: [] } as never)
    vi.mocked(sessionsApi.getSummary).mockReset().mockRejectedValue(new ApiError(404, 'Session not found'))
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

  it('returns a subagent tab to its source session before closing it', () => {
    useTabStore.getState().openTab('session-a', 'Session A')
    useTabStore.getState().openTab('session-b', 'Session B')
    const tabId = useTabStore.getState().openSubagentTab('session-b', 'tool-1', 'SubAgent run')

    useTabStore.getState().returnFromSubagent(tabId)

    expect(useTabStore.getState().activeTabId).toBe('session-b')
    expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual(['session-a', 'session-b'])
  })

  it('returns a nested subagent to the agent tab that opened it', () => {
    useTabStore.getState().openTab('session-root', 'Root session')
    const parentTabId = useTabStore.getState().openSubagentTab(
      'session-root',
      'agent-a',
      'Agent A',
    )
    const nestedTabId = useTabStore.getState().openSubagentTab(
      'session-root',
      'agent-a/worker-a/agent-b',
      'Agent B',
      undefined,
      parentTabId,
    )

    useTabStore.getState().returnFromSubagent(nestedTabId)

    expect(useTabStore.getState().activeTabId).toBe(parentTabId)
    expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual([
      'session-root',
      parentTabId,
    ])
  })

  it('closes a subagent tab even when its source session is gone', () => {
    useTabStore.getState().openTab('session-a', 'Session A')
    const tabId = useTabStore.getState().openSubagentTab('session-missing', 'tool-1', 'SubAgent run')

    useTabStore.getState().returnFromSubagent(tabId)

    expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual(['session-a'])
    expect(useTabStore.getState().activeTabId).toBe('session-a')
  })

  it('ignores returnFromSubagent for non-subagent tabs', () => {
    useTabStore.getState().openTab('session-a', 'Session A')

    useTabStore.getState().returnFromSubagent('session-a')

    expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual(['session-a'])
    expect(useTabStore.getState().activeTabId).toBe('session-a')
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
    const tabId = useTabStore.getState().openSubagentTab('session-1', 'tool-1', 'Kuhn', 'agent-1')
    const sameTabId = useTabStore.getState().openSubagentTab('session-1', 'tool-1', 'Kuhn updated', 'agent-1')

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
        subagentTaskId: 'agent-1',
      },
    ])
    expect(useTabStore.getState().activeTabId).toBe('__subagent__session-1__tool-1')
    expect(localStorage.getItem('cc-haha-open-tabs')).toBe(JSON.stringify({
      openTabs: [],
      activeTabId: null,
    }))
  })

  it('returns an ephemeral Agent Teams member to its workbench tab', () => {
    useTabStore.getState().openTab('session-1', 'Lead session')
    const workbenchTabId = useTabStore.getState().openTeamWorkbenchTab('session-1', 'Review team')
    const memberTabId = useTabStore.getState().openTeamMemberTab(
      'session-1',
      'reviewer@review-team',
      'Reviewer',
      workbenchTabId,
    )

    expect(useTabStore.getState().tabs.find((tab) => tab.sessionId === memberTabId)).toMatchObject({
      type: 'team-member',
      sourceSessionId: 'session-1',
      teamLeadSessionId: 'session-1',
      teamMemberAgentId: 'reviewer@review-team',
      returnTabId: workbenchTabId,
    })
    expect(localStorage.getItem('cc-haha-open-tabs')).toBe(JSON.stringify({
      openTabs: [{ sessionId: 'session-1', title: 'Lead session', type: 'session' }],
      activeTabId: 'session-1',
    }))

    useTabStore.getState().returnFromTeamMember(memberTabId)

    expect(useTabStore.getState().activeTabId).toBe(workbenchTabId)
    expect(useTabStore.getState().tabs.some((tab) => tab.sessionId === memberTabId)).toBe(false)
  })

  it('isolates the same member id across Team incarnations', () => {
    const oldTabId = useTabStore.getState().openTeamMemberTab(
      'shared-lead',
      'reviewer@same-name',
      'Old reviewer',
      undefined,
      'old-incarnation',
    )
    const newTabId = useTabStore.getState().openTeamMemberTab(
      'shared-lead',
      'reviewer@same-name',
      'New reviewer',
      undefined,
      'new-incarnation',
    )

    expect(newTabId).not.toBe(oldTabId)
    expect(useTabStore.getState().tabs.filter((tab) => tab.type === 'team-member')).toEqual([
      expect.objectContaining({ sessionId: oldTabId, teamIncarnationId: 'old-incarnation' }),
      expect.objectContaining({ sessionId: newTabId, teamIncarnationId: 'new-incarnation' }),
    ])
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

  it('restores historical session and trace tabs by id with metadata ready before activation', async () => {
    const historical = historicalSummary()
    const traceId = `__trace__${historical.id}`
    localStorage.setItem('cc-haha-open-tabs', JSON.stringify({
      openTabs: [
        { sessionId: historical.id, title: 'Saved old title', type: 'session' },
        { sessionId: traceId, title: 'Saved trace title', type: 'trace', traceSessionId: historical.id },
      ],
      activeTabId: historical.id,
    }))
    vi.mocked(sessionsApi.list).mockResolvedValue({ sessions: [], total: 5000 })
    vi.mocked(sessionsApi.getSummary).mockResolvedValue(historical)
    let metadataAtActivation: unknown
    const unsubscribe = useTabStore.subscribe((state) => {
      if (state.activeTabId !== historical.id) return
      metadataAtActivation = {
        session: useSessionStore.getState().sessions.find((session) => session.id === historical.id),
        runtime: useSessionRuntimeStore.getState().selections[historical.id],
      }
    })

    try {
      await useTabStore.getState().restoreTabs()
    } finally {
      unsubscribe()
    }

    expect(sessionsApi.list).toHaveBeenCalledExactlyOnceWith({ limit: 200 })
    expect(sessionsApi.getSummary).toHaveBeenCalledExactlyOnceWith(historical.id)
    expect(metadataAtActivation).toEqual({
      session: historical,
      runtime: { providerId: 'historical-provider', modelId: 'historical-model', effortLevel: 'high' },
    })
    expect(useTabStore.getState().tabs).toEqual([
      { sessionId: historical.id, title: historical.title, type: 'session', status: 'idle' },
      { sessionId: traceId, title: historical.title, type: 'trace', status: 'idle', traceSessionId: historical.id },
    ])

    useTabStore.getState().closeTab(historical.id)
    await useSessionStore.getState().fetchSessions()
    expect(sessionsApi.list).toHaveBeenLastCalledWith({ limit: 400 })
    expect(useSessionStore.getState().sessions).toEqual([historical])
    useTabStore.getState().closeTab(traceId)
    await useSessionStore.getState().fetchSessions()
    expect(useSessionStore.getState().sessions).toEqual([])
  })

  it('drops only tabs whose individual historical summary returns 404', async () => {
    const available = historicalSummary('history-available')
    localStorage.setItem('cc-haha-open-tabs', JSON.stringify({
      openTabs: [
        { sessionId: 'history-missing', title: 'Deleted session', type: 'session' },
        { sessionId: available.id, title: 'Available session', type: 'session' },
      ],
      activeTabId: 'history-missing',
    }))
    vi.mocked(sessionsApi.getSummary)
      .mockRejectedValueOnce(new ApiError(404, 'Session not found'))
      .mockResolvedValueOnce(available)

    await useTabStore.getState().restoreTabs()

    expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual([available.id])
    expect(useTabStore.getState().activeTabId).toBe(available.id)
    expect(sessionsApi.list).toHaveBeenCalledExactlyOnceWith({ limit: 200 })
  })

  it('preserves saved tabs when a historical lookup has a transient failure', async () => {
    const persisted = JSON.stringify({
      openTabs: [{ sessionId: 'history-offline', title: 'Saved session', type: 'session' }],
      activeTabId: 'history-offline',
    })
    localStorage.setItem('cc-haha-open-tabs', persisted)
    vi.mocked(sessionsApi.getSummary).mockRejectedValueOnce(new ApiError(503, 'Server unavailable'))

    await useTabStore.getState().restoreTabs()

    expect(localStorage.getItem('cc-haha-open-tabs')).toBe(persisted)
    expect(useSessionStore.getState().sessions).toEqual([])
  })

  it('does not activate or hydrate restored history after a user opens a tab during its lookup', async () => {
    const historical = historicalSummary()
    let resolveSummary!: (session: typeof historical) => void
    vi.mocked(sessionsApi.getSummary).mockReturnValueOnce(new Promise((resolve) => {
      resolveSummary = resolve
    }))
    localStorage.setItem('cc-haha-open-tabs', JSON.stringify({
      openTabs: [{ sessionId: historical.id, title: 'Saved session', type: 'session' }],
      activeTabId: historical.id,
    }))
    const restoring = useTabStore.getState().restoreTabs()
    await vi.waitFor(() => expect(sessionsApi.getSummary).toHaveBeenCalledOnce())
    useTabStore.getState().openTab(SETTINGS_TAB_ID, 'Settings', 'settings')
    resolveSummary(historical)
    await restoring

    expect(useTabStore.getState().activeTabId).toBe(SETTINGS_TAB_ID)
    expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual([SETTINGS_TAB_ID])
    expect(useSessionStore.getState().sessions).toEqual([])
    expect(useSessionRuntimeStore.getState().selections[historical.id]).toBeUndefined()
  })

  it('bounds simultaneous historical summary lookups while restoring several tabs', async () => {
    const ids = ['history-a', 'history-b', 'history-c']
    localStorage.setItem('cc-haha-open-tabs', JSON.stringify({
      openTabs: ids.map((sessionId) => ({ sessionId, title: sessionId, type: 'session' })),
      activeTabId: ids[0],
    }))
    let activeRequests = 0
    let maximumActiveRequests = 0
    vi.mocked(sessionsApi.getSummary).mockImplementation(async (id) => {
      activeRequests += 1
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests)
      await new Promise((resolve) => setTimeout(resolve, 0))
      activeRequests -= 1
      return historicalSummary(id)
    })

    await useTabStore.getState().restoreTabs()

    expect(sessionsApi.getSummary).toHaveBeenCalledTimes(ids.length)
    expect(maximumActiveRequests).toBe(1)
    expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual(ids)
    expect(sessionsApi.list).toHaveBeenCalledExactlyOnceWith({ limit: 200 })
  })

  it.each(['2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z'])(
    'keeps recent metadata refreshed while restoring historical tabs (%s)',
    async (refreshedAt) => {
      const historical = historicalSummary()
      const savedRecent = {
        ...historicalSummary('recent-session'),
        modifiedAt: '2026-08-01T00:00:00.000Z',
        title: 'Before refresh',
        runtimeProviderId: 'provider-before',
        runtimeModelId: 'model-before',
      }
      const freshRecent = {
        ...savedRecent,
        modifiedAt: refreshedAt,
        title: 'After refresh',
        permissionMode: 'acceptEdits',
        runtimeProviderId: 'provider-after',
        runtimeModelId: 'model-after',
      }
      localStorage.setItem('cc-haha-open-tabs', JSON.stringify({
        openTabs: [
          { sessionId: savedRecent.id, title: savedRecent.title, type: 'session' },
          { sessionId: historical.id, title: historical.title, type: 'session' },
        ],
        activeTabId: savedRecent.id,
      }))
      vi.mocked(sessionsApi.list)
        .mockResolvedValueOnce({ sessions: [savedRecent], total: 5000 })
        .mockResolvedValueOnce({ sessions: [freshRecent], total: 5000 })
      let resolveSummary!: (session: typeof historical) => void
      vi.mocked(sessionsApi.getSummary).mockReturnValueOnce(new Promise((resolve) => {
        resolveSummary = resolve
      }))

      const restoring = useTabStore.getState().restoreTabs()
      await vi.waitFor(() => expect(sessionsApi.getSummary).toHaveBeenCalledOnce())
      await useSessionStore.getState().fetchSessions()
      resolveSummary(historical)
      await restoring

      expect(sessionsApi.list).toHaveBeenNthCalledWith(1, { limit: 200 })
      expect(sessionsApi.list).toHaveBeenNthCalledWith(2, { limit: 400 })
      expect(useSessionStore.getState().sessions.find((session) => session.id === freshRecent.id))
        .toEqual(freshRecent)
      expect(useSessionRuntimeStore.getState().selections[freshRecent.id]).toEqual({
        providerId: freshRecent.runtimeProviderId,
        modelId: freshRecent.runtimeModelId,
        effortLevel: freshRecent.effortLevel,
      })
      expect(useTabStore.getState().tabs.find((tab) => tab.sessionId === freshRecent.id)?.title)
        .toBe(freshRecent.title)
    },
  )

  it.each([false, true])('preserves a runtime chosen during tab restoration (historical: %s)', async (historical) => {
    const session = historicalSummary('runtime-restore-race')
    const nextSelection = { providerId: 'deepseek-provider', modelId: 'deepseek-v4.1' }
    localStorage.setItem('cc-haha-open-tabs', JSON.stringify({
      openTabs: [{ sessionId: session.id, title: session.title, type: 'session' }],
      activeTabId: session.id,
    }))
    let resolveResponse!: () => void
    if (historical) {
      vi.mocked(sessionsApi.list).mockResolvedValueOnce({ sessions: [], total: 1 })
      vi.mocked(sessionsApi.getSummary).mockReturnValueOnce(new Promise((resolve) => {
        resolveResponse = () => resolve(session)
      }))
    } else {
      vi.mocked(sessionsApi.list).mockReturnValueOnce(new Promise((resolve) => {
        resolveResponse = () => resolve({ sessions: [session], total: 1 })
      }))
    }

    const restoring = useTabStore.getState().restoreTabs()
    if (historical) await vi.waitFor(() => expect(sessionsApi.getSummary).toHaveBeenCalledOnce())
    useSessionRuntimeStore.getState().setSelection(session.id, nextSelection)
    resolveResponse()
    await restoring

    expect(useSessionRuntimeStore.getState().selections[session.id]).toEqual(nextSelection)
    expect(useTabStore.getState().activeTabId).toBe(session.id)
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
