import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { branchMock, createMock, deleteMock, batchDeleteMock, listMock, projectHistoryMock, invalidateRecentProjectsCacheMock } = vi.hoisted(() => ({
  branchMock: vi.fn(),
  createMock: vi.fn(),
  deleteMock: vi.fn(),
  batchDeleteMock: vi.fn(),
  listMock: vi.fn(),
  projectHistoryMock: vi.fn(),
  invalidateRecentProjectsCacheMock: vi.fn(),
}))

vi.mock('../api/sessions', () => ({
  sessionsApi: {
    branch: branchMock,
    create: createMock,
    list: listMock,
    listProjectHistory: projectHistoryMock,
    delete: deleteMock,
    batchDelete: batchDeleteMock,
    rename: vi.fn(),
  },
}))

vi.mock('../lib/recentProjectsCache', () => ({
  invalidateRecentProjectsCache: invalidateRecentProjectsCacheMock,
}))

import { useSessionStore } from './sessionStore'
import { useSessionRuntimeStore } from './sessionRuntimeStore'
import { useSettingsStore } from './settingsStore'
import { useTabStore } from './tabStore'
import { ApiError } from '../api/client'

const initialState = useSessionStore.getState()

function makeSession(id: string, modifiedAt: string, title = id) {
  return {
    id,
    title,
    createdAt: modifiedAt,
    modifiedAt,
    messageCount: 1,
    projectPath: '/workspace/project',
    projectRoot: '/workspace/project',
    workDir: '/workspace/project',
    workDirExists: true,
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function makeIndexStatus(
  state: 'off' | 'building' | 'ready' | 'degraded',
  indexed = 0,
  discovered = indexed,
) {
  return {
    mode: state === 'off' ? 'off' as const : 'on' as const,
    state,
    discovered,
    indexed,
    degradedSources: state === 'degraded' ? 1 : 0,
    databaseBytes: 4096,
    walBytes: 0,
    lastUpdatedAt: '2026-07-15T00:00:00.000Z',
    lastErrorCode: state === 'degraded' ? 'source_unreadable' : null,
  }
}

describe('sessionStore', () => {
  beforeEach(() => {
    branchMock.mockReset()
    createMock.mockReset()
    deleteMock.mockReset()
    batchDeleteMock.mockReset()
    listMock.mockReset()
    projectHistoryMock.mockReset()
    invalidateRecentProjectsCacheMock.mockReset()
    useSessionStore.setState({
      ...initialState,
      sessions: [],
      activeSessionId: null,
      isLoading: false,
      error: null,
      indexStatus: null,
      selectedSessionIds: new Set(),
    })
    useSettingsStore.setState({ permissionMode: 'default' })
    useTabStore.setState({ tabs: [], activeTabId: null })
    useSessionRuntimeStore.setState({ selections: {} })
  })

  afterEach(() => {
    useSessionStore.setState(initialState)
    useSettingsStore.setState({ permissionMode: 'default' })
    useTabStore.setState({ tabs: [], activeTabId: null })
    useSessionRuntimeStore.setState({ selections: {} })
  })

  it('returns a new session id before the background refresh completes', async () => {
    createMock.mockResolvedValue({ sessionId: 'session-optimistic-1' })
    listMock.mockImplementation(() => new Promise(() => {}))

    const result = await Promise.race([
      useSessionStore.getState().createSession('D:/workspace/code/myself_code/cc-haha'),
      delay(100).then(() => 'timed-out'),
    ])

    expect(result).toBe('session-optimistic-1')
    expect(useSessionStore.getState().activeSessionId).toBe('session-optimistic-1')
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: 'session-optimistic-1',
      title: 'New Session',
      workDir: 'D:/workspace/code/myself_code/cc-haha',
      workDirExists: true,
    })
    expect(invalidateRecentProjectsCacheMock).toHaveBeenCalledOnce()
    expect(createMock).toHaveBeenCalledWith({
      workDir: 'D:/workspace/code/myself_code/cc-haha',
    })
    expect(listMock).toHaveBeenCalledOnce()
  })

  it('retains a locally created session until the refreshed list has observed it', async () => {
    const existing = makeSession('session-existing', '2026-05-07T00:00:00.000Z')
    const created = {
      ...makeSession('session-created', '2026-05-07T00:00:01.000Z'),
      messageCount: 0,
      title: 'New Session',
    }
    createMock.mockResolvedValue({ sessionId: created.id, workDir: created.workDir })
    listMock
      .mockResolvedValueOnce({ sessions: [existing], total: 1 })
      .mockResolvedValueOnce({ sessions: [created, existing], total: 2 })
      .mockResolvedValueOnce({ sessions: [existing], total: 1 })

    await useSessionStore.getState().createSession(created.workDir)
    await delay(0)

    expect(useSessionStore.getState().sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.id, workDir: created.workDir }),
    ]))

    await useSessionStore.getState().fetchSessions()
    await useSessionStore.getState().fetchSessions()

    expect(useSessionStore.getState().sessions.map((session) => session.id))
      .toEqual([existing.id])
  })

  it('keeps an optimistic local title when a background refresh still returns a placeholder', async () => {
    const refresh = createDeferred<{
      sessions: Array<{
        id: string
        title: string
        createdAt: string
        modifiedAt: string
        messageCount: number
        projectPath: string
        workDir: string | null
        workDirExists: boolean
      }>
      total: number
    }>()
    createMock.mockResolvedValue({ sessionId: 'session-title-1', workDir: '/workspace/project' })
    listMock.mockReturnValue(refresh.promise)

    await useSessionStore.getState().createSession('/workspace/project')
    useSessionStore.getState().updateSessionTitle('session-title-1', '开始优化UI')

    refresh.resolve({
      sessions: [{
        id: 'session-title-1',
        title: 'Untitled Session',
        createdAt: '2026-05-07T00:00:00.000Z',
        modifiedAt: '2026-05-07T00:00:01.000Z',
        messageCount: 0,
        projectPath: '',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      total: 1,
    })
    await refresh.promise
    await delay(0)

    expect(useSessionStore.getState().sessions[0]?.title).toBe('开始优化UI')
  })

  it('syncs refreshed session titles into already-open tabs', async () => {
    useTabStore.getState().openTab('session-title-2', '```json {"title":')
    listMock.mockResolvedValue({
      sessions: [{
        id: 'session-title-2',
        title: '使用bash写一个shell，随便写点什么东西',
        createdAt: '2026-05-07T00:00:00.000Z',
        modifiedAt: '2026-05-07T00:00:01.000Z',
        messageCount: 3,
        projectPath: '',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      total: 1,
    })

    await useSessionStore.getState().fetchSessions()

    expect(useTabStore.getState().tabs[0]?.title).toBe('使用bash写一个shell，随便写点什么东西')
  })

  it('syncs transcript runtime metadata before a session is opened from the sidebar', async () => {
    useSessionRuntimeStore.getState().setSelection('session-runtime-1', {
      providerId: null,
      modelId: 'gpt-5.4',
      effortLevel: 'max',
    })
    listMock.mockResolvedValue({
      sessions: [{
        ...makeSession('session-runtime-1', '2026-07-13T05:57:05.818Z'),
        runtimeProviderId: 'provider-latest',
        runtimeModelId: 'anthropic/claude-opus-4.7',
        effortLevel: 'max',
      }],
      total: 1,
    })

    await useSessionStore.getState().fetchSessions()

    expect(useSessionRuntimeStore.getState().selections['session-runtime-1']).toEqual({
      providerId: 'provider-latest',
      modelId: 'anthropic/claude-opus-4.7',
      effortLevel: 'max',
    })
  })

  it('updates a session message count without changing other metadata', () => {
    useSessionStore.setState({
      sessions: [makeSession('session-count-1', '2026-05-07T00:00:00.000Z', 'Working session')],
    })

    useSessionStore.getState().updateSessionMessageCount('session-count-1', 0)

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: 'session-count-1',
      title: 'Working session',
      messageCount: 0,
      workDir: '/workspace/project',
    })
  })

  it('hydrates only the selected historical session before activating its tab', () => {
    const historical = {
      ...makeSession('history-opened', '2025-01-01T00:00:00.000Z', 'Old worktree'),
      workDir: '/workspace/project/.claude/worktrees/old',
      workDirExists: false,
      workspaceState: 'worktree_removed' as const,
      permissionMode: 'acceptEdits',
      runtimeProviderId: 'provider-current',
      runtimeModelId: 'model-current',
      effortLevel: 'high' as const,
    }
    useSessionRuntimeStore.getState().setSelection(historical.id, {
      providerId: 'provider-stale',
      modelId: 'model-stale',
    })
    let observedAtActivation: unknown
    const unsubscribe = useTabStore.subscribe((state) => {
      if (state.activeTabId !== historical.id) return
      observedAtActivation = {
        session: useSessionStore.getState().sessions.find((session) => session.id === historical.id),
        runtime: useSessionRuntimeStore.getState().selections[historical.id],
      }
    })

    try {
      useSessionStore.getState().openHistoricalSession(historical)
    } finally {
      unsubscribe()
    }

    expect(observedAtActivation).toEqual({
      session: historical,
      runtime: {
        providerId: 'provider-current',
        modelId: 'model-current',
        effortLevel: 'high',
      },
    })
    expect(useTabStore.getState().tabs).toEqual([
      expect.objectContaining({ sessionId: historical.id, title: historical.title, type: 'session' }),
    ])
    expect(useSessionStore.getState().historicalSessionIds).toEqual(new Set([historical.id]))
    expect(listMock).not.toHaveBeenCalled()
  })

  it.each(['2025-01-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'])(
    'keeps current metadata when the history snapshot is not newer (%s)',
    (snapshotTime) => {
      const current = {
        ...makeSession('history-current', '2026-08-01T00:00:00.000Z', 'Current title'),
        permissionMode: 'plan',
        runtimeProviderId: 'provider-current',
        runtimeModelId: 'model-current',
      }
      const snapshot = {
        ...current,
        title: 'Stale history title',
        modifiedAt: snapshotTime,
        workDir: '/workspace/stale-worktree',
        permissionMode: 'acceptEdits',
        runtimeProviderId: 'provider-stale',
        runtimeModelId: 'model-stale',
      }
      useSessionStore.setState({ sessions: [current] })

      useSessionStore.getState().openHistoricalSession(snapshot)

      expect(useSessionStore.getState().sessions).toEqual([current])
      expect(useSessionRuntimeStore.getState().selections[current.id]).toEqual({
        providerId: 'provider-current',
        modelId: 'model-current',
      })
      expect(useTabStore.getState().tabs[0]?.title).toBe(current.title)
    },
  )

  it.each(['ready', 'building'] as const)('retains opened history across bounded %s refreshes and releases closed tabs', async (indexState) => {
    const historical = makeSession('history-retained', '2025-01-01T00:00:00.000Z')
    const recent = makeSession('history-recent', '2026-08-01T00:00:00.000Z')
    listMock.mockResolvedValue({
      sessions: [recent],
      total: 2000,
      index: makeIndexStatus(indexState, 1000, 2000),
    })
    useSessionStore.getState().openHistoricalSession(historical)
    useSessionStore.getState().updateSessionPermissionMode(historical.id, 'plan')

    await useSessionStore.getState().fetchSessions()
    expect(useSessionStore.getState().sessions).toEqual([
      recent,
      { ...historical, permissionMode: 'plan' },
    ])
    expect(listMock).toHaveBeenLastCalledWith({ limit: 400 })

    useTabStore.getState().closeTab(historical.id)
    await useSessionStore.getState().fetchSessions()
    expect(useSessionStore.getState().sessions).toEqual([recent])
    expect(useSessionStore.getState().historicalSessionIds).toEqual(new Set())
    expect(listMock).toHaveBeenLastCalledWith({ limit: 400 })
  })

  it('uses fresh recent metadata when an opened historical session reenters the recent page', async () => {
    const historical = makeSession('history-updated', '2025-01-01T00:00:00.000Z')
    useSessionStore.getState().openHistoricalSession(historical)
    const refreshed = { ...historical, title: 'Updated elsewhere', permissionMode: 'plan' }
    listMock.mockResolvedValue({ sessions: [refreshed], total: 1 })

    await useSessionStore.getState().fetchSessions()
    useTabStore.getState().closeTab(historical.id)
    await useSessionStore.getState().fetchSessions()

    expect(useSessionStore.getState().sessions).toEqual([refreshed])
    expect(useSessionStore.getState().historicalSessionIds).toEqual(new Set())
  })

  it.each(['single', 'batch'] as const)('does not resurrect deleted history from a pending refresh after %s deletion', async (deletion) => {
    const historical = makeSession(`history-deleted-${deletion}`, '2025-01-01T00:00:00.000Z')
    const pending = createDeferred<{ sessions: ReturnType<typeof makeSession>[]; total: number }>()
    listMock.mockReturnValueOnce(pending.promise).mockResolvedValue({ sessions: [], total: 0 })
    deleteMock.mockResolvedValue({ ok: true })
    batchDeleteMock.mockResolvedValue({ ok: true, successes: [historical.id], failures: [] })
    useSessionStore.getState().openHistoricalSession(historical)
    const refresh = useSessionStore.getState().fetchSessions()

    if (deletion === 'single') await useSessionStore.getState().deleteSession(historical.id)
    else await useSessionStore.getState().deleteSessions([historical.id])
    pending.resolve({ sessions: [historical], total: 1 })
    await refresh

    expect(useSessionStore.getState().sessions).toEqual([])
    expect(useSessionStore.getState().historicalSessionIds).toEqual(new Set())
    expect(useSessionStore.getState().isLoading).toBe(false)
    await useSessionStore.getState().fetchSessions()
    expect(useSessionStore.getState().sessions).toEqual([])
  })

  it('requests a large default session page for noisy history directories', async () => {
    listMock.mockResolvedValue({
      sessions: [makeSession('session-newest', '2026-05-07T00:00:03.000Z')],
      total: 474,
    })

    await useSessionStore.getState().fetchSessions()

    expect(listMock).toHaveBeenCalledWith({ limit: 400 })
  })

  it('loads one project below its recent boundary without skipping restored old tabs and retains pages on refresh', async () => {
    const root = '/workspace/project'
    const recent = makeSession('project-recent', '2026-08-01T00:00:00.000Z')
    const old = makeSession('project-old', '2025-01-01T00:00:00.000Z')
    const restored = makeSession('project-restored', '2020-01-01T00:00:00.000Z')
    listMock.mockResolvedValue({ sessions: [recent], total: 5000 })
    await useSessionStore.getState().fetchSessions()
    useSessionStore.getState().openHistoricalSession(restored)
    projectHistoryMock.mockResolvedValue({ sessions: [old], nextCursor: 'next-project-page' })

    await useSessionStore.getState().loadMoreProjectSessions(root)
    await useSessionStore.getState().fetchSessions()

    expect(projectHistoryMock).toHaveBeenCalledExactlyOnceWith({
      projectRoot: root,
      limit: 50,
      beforeModifiedAt: recent.modifiedAt,
      beforeId: recent.id,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(useSessionStore.getState().sessions.map((session) => session.id))
      .toEqual([recent.id, old.id, restored.id])
    expect(useSessionStore.getState().projectHistory[root]).toMatchObject({
      initialized: true,
      hasMore: true,
      nextCursor: 'next-project-page',
      isLoading: false,
      error: null,
    })
    expect(listMock).toHaveBeenLastCalledWith({ limit: 400 })
  })

  it('uses cursor pages once, deduplicates overlapping rows, and keeps current titles and runtime metadata', async () => {
    const root = '/workspace/project'
    const first = {
      ...makeSession('project-first', '2025-01-01T00:00:00.000Z'),
      runtimeProviderId: 'current-provider',
      runtimeModelId: 'current-model',
    }
    const second = makeSession('project-second', '2024-01-01T00:00:00.000Z')
    const pending = createDeferred<{ sessions: typeof first[]; nextCursor: string | null }>()
    projectHistoryMock.mockReturnValueOnce(pending.promise)
    const initial = useSessionStore.getState().loadMoreProjectSessions(root)
    await useSessionStore.getState().loadMoreProjectSessions(root)
    expect(projectHistoryMock).toHaveBeenCalledOnce()
    pending.resolve({ sessions: [first], nextCursor: 'cursor-1' })
    await initial
    useSessionStore.getState().updateSessionTitle(first.id, 'Fresh rename')
    projectHistoryMock.mockResolvedValueOnce({
      sessions: [{ ...first, runtimeModelId: 'stale-model' }, second],
      nextCursor: null,
    })

    await useSessionStore.getState().loadMoreProjectSessions(root)
    await useSessionStore.getState().loadMoreProjectSessions(root)

    expect(projectHistoryMock).toHaveBeenCalledTimes(2)
    expect(projectHistoryMock).toHaveBeenLastCalledWith({ projectRoot: root, limit: 50, cursor: 'cursor-1' }, expect.anything())
    expect(useSessionStore.getState().sessions).toEqual([{ ...first, title: 'Fresh rename' }, second])
    expect(useSessionRuntimeStore.getState().selections).toEqual({})
    useSessionStore.getState().openHistoricalSession(first)
    expect(useSessionRuntimeStore.getState().selections[first.id]?.modelId).toBe('current-model')
    expect(useSessionStore.getState().projectHistory[root]).toMatchObject({ hasMore: false, nextCursor: null })
  })

  it('anchors project history to the original recent page even when a row later changes activity time', async () => {
    const root = '/workspace/project'
    const recent = makeSession('snapshot-boundary', '2026-08-01T00:00:00.000Z')
    listMock.mockResolvedValue({ sessions: [recent], total: 5000 })
    await useSessionStore.getState().fetchSessions()
    useSessionStore.getState().hydrateHistoricalSessions([{ ...recent, modifiedAt: '2026-09-01T00:00:00.000Z' }])
    projectHistoryMock.mockResolvedValue({ sessions: [], nextCursor: null })

    await useSessionStore.getState().loadMoreProjectSessions(root)

    expect(projectHistoryMock).toHaveBeenCalledWith({
      projectRoot: root, limit: 50, beforeModifiedAt: recent.modifiedAt, beforeId: recent.id,
    }, expect.anything())
  })

  it('does not use an incomplete index-building page as a project history boundary', async () => {
    const root = '/workspace/project'
    listMock.mockResolvedValue({
      sessions: [makeSession('partial-old-row', '2020-01-01T00:00:00.000Z')],
      total: 1,
      index: makeIndexStatus('building', 1, 5000),
    })
    await useSessionStore.getState().fetchSessions()
    projectHistoryMock.mockResolvedValue({ sessions: [], nextCursor: null })

    await useSessionStore.getState().loadMoreProjectSessions(root)

    expect(projectHistoryMock).toHaveBeenCalledWith({ projectRoot: root, limit: 50 }, expect.anything())
  })

  it('releases a collapsed project page but keeps recent and open-tab metadata', async () => {
    const root = '/workspace/project'
    const recent = makeSession('collapse-recent', '2026-08-01T00:00:00.000Z')
    const opened = makeSession('collapse-opened', '2025-01-01T00:00:00.000Z')
    const extra = makeSession('collapse-extra', '2024-01-01T00:00:00.000Z')
    listMock.mockResolvedValue({ sessions: [recent], total: 5000 })
    await useSessionStore.getState().fetchSessions()
    projectHistoryMock.mockResolvedValue({ sessions: [recent, opened, extra], nextCursor: null })
    await useSessionStore.getState().loadMoreProjectSessions(root)
    useTabStore.getState().openTab(opened.id, opened.title)

    useSessionStore.getState().releaseProjectHistory(root)

    expect(useSessionStore.getState().projectHistory[root]).toBeUndefined()
    expect(useSessionStore.getState().sessions).toEqual([recent, opened])
    await useSessionStore.getState().fetchSessions()
    expect(useSessionStore.getState().sessions).toEqual([recent, opened])
    useTabStore.getState().closeTab(opened.id)
    await useSessionStore.getState().fetchSessions()
    expect(useSessionStore.getState().sessions).toEqual([recent])
  })

  it('ignores canceled project responses after collapse and keeps other project requests independent', async () => {
    const firstRoot = '/workspace/project'
    const secondRoot = '/workspace/another'
    const pending = createDeferred<{ sessions: ReturnType<typeof makeSession>[]; nextCursor: null }>()
    const stale = makeSession('collapsed-response', '2024-01-01T00:00:00.000Z')
    const other = { ...makeSession('other-project', '2025-01-01T00:00:00.000Z'), projectRoot: secondRoot }
    projectHistoryMock.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ sessions: [other], nextCursor: null })
    const loading = useSessionStore.getState().loadMoreProjectSessions(firstRoot)
    const signal = projectHistoryMock.mock.calls[0]![1].signal as AbortSignal
    await useSessionStore.getState().loadMoreProjectSessions(secondRoot)

    useSessionStore.getState().releaseProjectHistory(firstRoot)
    expect(signal.aborted).toBe(true)
    pending.resolve({ sessions: [stale], nextCursor: null })
    await loading

    expect(useSessionStore.getState().sessions).toEqual([other])
    expect(useSessionStore.getState().projectHistory[firstRoot]).toBeUndefined()
    expect(useSessionStore.getState().projectHistory[secondRoot]?.initialized).toBe(true)
  })

  it('keeps a reopened project request current when the canceled request finishes late', async () => {
    const root = '/workspace/project'
    const oldPage = createDeferred<{ sessions: ReturnType<typeof makeSession>[]; nextCursor: null }>()
    const newPage = createDeferred<{ sessions: ReturnType<typeof makeSession>[]; nextCursor: null }>()
    const stale = makeSession('project-canceled', '2024-01-01T00:00:00.000Z')
    const fresh = makeSession('project-reopened', '2025-01-01T00:00:00.000Z')
    projectHistoryMock.mockReturnValueOnce(oldPage.promise).mockReturnValueOnce(newPage.promise)
    const oldLoading = useSessionStore.getState().loadMoreProjectSessions(root)
    useSessionStore.getState().releaseProjectHistory(root)
    const newLoading = useSessionStore.getState().loadMoreProjectSessions(root)

    oldPage.resolve({ sessions: [stale], nextCursor: null })
    await oldLoading
    expect(useSessionStore.getState().projectHistory[root]?.isLoading).toBe(true)
    expect(useSessionStore.getState().sessions).toEqual([])
    newPage.resolve({ sessions: [fresh], nextCursor: null })
    await newLoading

    expect(useSessionStore.getState().sessions).toEqual([fresh])
    expect(useSessionStore.getState().projectHistory[root]).toMatchObject({ isLoading: false, hasMore: false })
  })

  it.each(['single', 'batch'] as const)('does not resurrect %s-deleted rows from an in-flight project page', async (deletion) => {
    const root = '/workspace/project'
    const deleted = makeSession(`project-delete-${deletion}`, '2025-01-01T00:00:00.000Z')
    const retained = makeSession('project-retained', '2024-01-01T00:00:00.000Z')
    const pending = createDeferred<{ sessions: ReturnType<typeof makeSession>[]; nextCursor: string | null }>()
    projectHistoryMock
      .mockResolvedValueOnce({ sessions: [deleted], nextCursor: 'cursor-1' })
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ sessions: [deleted], nextCursor: null })
    await useSessionStore.getState().loadMoreProjectSessions(root)
    const loading = useSessionStore.getState().loadMoreProjectSessions(root)
    deleteMock.mockResolvedValue({ ok: true })
    batchDeleteMock.mockResolvedValue({ ok: true, successes: [deleted.id], failures: [] })

    if (deletion === 'single') await useSessionStore.getState().deleteSession(deleted.id)
    else await useSessionStore.getState().deleteSessions([deleted.id])
    pending.resolve({ sessions: [deleted, retained], nextCursor: 'cursor-after-delete' })
    await loading
    await useSessionStore.getState().loadMoreProjectSessions(root)

    expect(useSessionStore.getState().sessions).toEqual([retained])
    expect(useSessionStore.getState().projectHistory[root]?.sessionIds).toEqual(new Set([retained.id]))
  })

  it('keeps the same project cursor on a retryable error', async () => {
    const root = '/workspace/project'
    projectHistoryMock
      .mockResolvedValueOnce({ sessions: [], nextCursor: 'retry-cursor' })
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValueOnce({ sessions: [], nextCursor: null })
    await useSessionStore.getState().loadMoreProjectSessions(root)
    await useSessionStore.getState().loadMoreProjectSessions(root)

    expect(useSessionStore.getState().projectHistory[root]).toMatchObject({ isLoading: false, error: 'Offline', nextCursor: 'retry-cursor', hasMore: true })
    await useSessionStore.getState().loadMoreProjectSessions(root)
    expect(projectHistoryMock).toHaveBeenLastCalledWith({ projectRoot: root, limit: 50, cursor: 'retry-cursor' }, expect.anything())
    expect(useSessionStore.getState().projectHistory[root]).toMatchObject({ error: null, hasMore: false })
  })

  it('restarts an expired project cursor once without discarding visible rows', async () => {
    const root = '/workspace/project'
    const existing = makeSession('project-expired', '2025-01-01T00:00:00.000Z')
    projectHistoryMock
      .mockResolvedValueOnce({ sessions: [existing], nextCursor: 'expired-cursor' })
      .mockRejectedValueOnce(new ApiError(409, { code: 'PROJECT_HISTORY_CURSOR_EXPIRED' }))
      .mockResolvedValueOnce({ sessions: [existing], nextCursor: 'fresh-cursor' })

    await useSessionStore.getState().loadMoreProjectSessions(root)
    await useSessionStore.getState().loadMoreProjectSessions(root)

    expect(projectHistoryMock).toHaveBeenLastCalledWith({ projectRoot: root, limit: 50 }, expect.anything())
    expect(useSessionStore.getState().sessions).toEqual([existing])
    expect(useSessionStore.getState().projectHistory[root]).toMatchObject({ nextCursor: 'fresh-cursor', error: null })
  })

  it('allows a fresh retry when resetting an expired project cursor also fails', async () => {
    const root = '/workspace/project'
    projectHistoryMock
      .mockResolvedValueOnce({ sessions: [], nextCursor: 'expired-cursor' })
      .mockRejectedValueOnce(new ApiError(409, { code: 'PROJECT_HISTORY_CURSOR_EXPIRED' }))
      .mockRejectedValueOnce(new Error('Unavailable'))
      .mockResolvedValueOnce({ sessions: [], nextCursor: null })
    await useSessionStore.getState().loadMoreProjectSessions(root)
    await useSessionStore.getState().loadMoreProjectSessions(root)

    expect(projectHistoryMock).toHaveBeenCalledTimes(3)
    expect(useSessionStore.getState().projectHistory[root]).toMatchObject({ error: 'Unavailable', nextCursor: null, initialized: false, isLoading: false })
    await useSessionStore.getState().loadMoreProjectSessions(root)
    expect(projectHistoryMock).toHaveBeenLastCalledWith({ projectRoot: root, limit: 50 }, expect.anything())
    expect(useSessionStore.getState().projectHistory[root]).toMatchObject({ error: null, initialized: true, hasMore: false })
  })

  it('ignores stale session list responses when a newer refresh finishes first', async () => {
    const slow = createDeferred<{
      sessions: Array<{
        id: string
        title: string
        createdAt: string
        modifiedAt: string
        messageCount: number
        projectPath: string
        workDir: string | null
        workDirExists: boolean
      }>
      total: number
    }>()
    const fast = createDeferred<{
      sessions: Array<{
        id: string
        title: string
        createdAt: string
        modifiedAt: string
        messageCount: number
        projectPath: string
        workDir: string | null
        workDirExists: boolean
      }>
      total: number
    }>()
    listMock
      .mockReturnValueOnce(slow.promise)
      .mockReturnValueOnce(fast.promise)

    const first = useSessionStore.getState().fetchSessions()
    const second = useSessionStore.getState().fetchSessions()

    fast.resolve({
      sessions: [{
        id: 'new-session',
        title: 'New session',
        createdAt: '2026-05-07T00:00:00.000Z',
        modifiedAt: '2026-05-07T00:00:02.000Z',
        messageCount: 1,
        projectPath: '',
        workDir: '/workspace/new',
        workDirExists: true,
      }],
      total: 1,
    })
    await second

    slow.resolve({
      sessions: [{
        id: 'old-session',
        title: 'Old session',
        createdAt: '2026-05-07T00:00:00.000Z',
        modifiedAt: '2026-05-07T00:00:01.000Z',
        messageCount: 1,
        projectPath: '',
        workDir: '/workspace/old',
        workDirExists: true,
      }],
      total: 1,
    })
    await first

    expect(useSessionStore.getState().sessions).toHaveLength(1)
    expect(useSessionStore.getState().sessions[0]?.id).toBe('new-session')
  })

  it('keeps older servers without index status backward compatible', async () => {
    useSessionStore.setState({
      indexStatus: makeIndexStatus('building', 3, 10),
    })
    listMock.mockResolvedValue({
      sessions: [makeSession('legacy-session', '2026-07-15T00:00:00.000Z')],
      total: 1,
    })

    await useSessionStore.getState().fetchSessions()

    expect(useSessionStore.getState().sessions.map((session) => session.id)).toEqual(['legacy-session'])
    expect(useSessionStore.getState().indexStatus).toBeNull()
  })

  it('merges partial building rows without clearing active or selected sessions', async () => {
    const retained = makeSession('retained-session', '2026-07-15T00:00:01.000Z')
    useSessionStore.setState({
      sessions: [retained],
      activeSessionId: retained.id,
      isBatchMode: true,
      selectedSessionIds: new Set([retained.id]),
    })
    listMock.mockResolvedValue({
      sessions: [makeSession('newly-indexed', '2026-07-15T00:00:02.000Z')],
      total: 2,
      index: makeIndexStatus('building', 1, 2),
    })

    await useSessionStore.getState().fetchSessions()

    const state = useSessionStore.getState()
    expect(state.sessions.map((session) => session.id)).toEqual(['newly-indexed', 'retained-session'])
    expect(state.activeSessionId).toBe(retained.id)
    expect([...state.selectedSessionIds]).toEqual([retained.id])
    expect(state.indexStatus).toMatchObject({ state: 'building', indexed: 1, discovered: 2 })
  })

  it('treats ready rows as an authoritative replacement', async () => {
    useSessionStore.setState({
      sessions: [makeSession('stale-session', '2026-07-15T00:00:01.000Z')],
    })
    listMock.mockResolvedValue({
      sessions: [makeSession('ready-session', '2026-07-15T00:00:02.000Z')],
      total: 1,
      index: makeIndexStatus('ready', 1, 1),
    })

    await useSessionStore.getState().fetchSessions()

    expect(useSessionStore.getState().sessions.map((session) => session.id)).toEqual(['ready-session'])
    expect(useSessionStore.getState().indexStatus?.state).toBe('ready')
  })

  it('treats off rows as an authoritative file-backed replacement', async () => {
    useSessionStore.setState({
      sessions: [makeSession('stale-session', '2026-07-15T00:00:01.000Z')],
    })
    listMock.mockResolvedValue({
      sessions: [makeSession('file-session', '2026-07-15T00:00:02.000Z')],
      total: 1,
      index: makeIndexStatus('off'),
    })

    await useSessionStore.getState().fetchSessions()

    expect(useSessionStore.getState().sessions.map((session) => session.id)).toEqual(['file-session'])
    expect(useSessionStore.getState().indexStatus?.state).toBe('off')
  })

  it('keeps loading without showing an error when the first building page is empty', async () => {
    listMock.mockResolvedValue({
      sessions: [],
      total: 10,
      index: makeIndexStatus('building', 0, 10),
    })

    await useSessionStore.getState().fetchSessions()

    expect(useSessionStore.getState()).toMatchObject({
      sessions: [],
      isLoading: true,
      error: null,
      indexStatus: { state: 'building', indexed: 0, discovered: 10 },
    })
  })

  it('rejects a slower old response for both rows and index progress', async () => {
    const slow = createDeferred<{
      sessions: ReturnType<typeof makeSession>[]
      total: number
      index: ReturnType<typeof makeIndexStatus>
    }>()
    const fast = createDeferred<{
      sessions: ReturnType<typeof makeSession>[]
      total: number
      index: ReturnType<typeof makeIndexStatus>
    }>()
    listMock.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise)

    const first = useSessionStore.getState().fetchSessions()
    const second = useSessionStore.getState().fetchSessions()

    fast.resolve({
      sessions: [makeSession('new-session', '2026-07-15T00:00:02.000Z')],
      total: 1,
      index: makeIndexStatus('building', 8, 10),
    })
    await second
    slow.resolve({
      sessions: [makeSession('old-session', '2026-07-15T00:00:01.000Z')],
      total: 1,
      index: makeIndexStatus('building', 2, 10),
    })
    await first

    expect(useSessionStore.getState().sessions.map((session) => session.id)).toEqual(['new-session'])
    expect(useSessionStore.getState().indexStatus).toMatchObject({ indexed: 8, discovered: 10 })
  })

  it('treats degraded fallback rows as an authoritative file-backed replacement', async () => {
    useSessionStore.setState({
      sessions: [makeSession('known-session', '2026-07-15T00:00:01.000Z')],
    })
    listMock.mockResolvedValue({
      sessions: [makeSession('fallback-session', '2026-07-15T00:00:02.000Z')],
      total: 2,
      index: makeIndexStatus('degraded', 1, 2),
    })

    await useSessionStore.getState().fetchSessions()

    expect(useSessionStore.getState().sessions.map((session) => session.id)).toEqual(['fallback-session'])
    expect(useSessionStore.getState().error).toBeNull()
    expect(useSessionStore.getState().indexStatus?.state).toBe('degraded')
  })

  it('keeps shadow building responses authoritative and bounded by the requested limit', async () => {
    useSessionStore.setState({
      sessions: [makeSession('stale-session', '2026-07-15T00:00:01.000Z')],
    })
    const fileSessions = Array.from({ length: 400 }, (_, index) => (
      makeSession(`file-session-${index}`, `2026-07-15T00:${String(index % 60).padStart(2, '0')}:02.000Z`)
    ))
    listMock.mockResolvedValue({
      sessions: fileSessions,
      total: fileSessions.length,
      index: {
        ...makeIndexStatus('building', 200, 400),
        mode: 'shadow',
      },
    })

    await useSessionStore.getState().fetchSessions()

    const sessions = useSessionStore.getState().sessions
    expect(sessions).toHaveLength(400)
    expect(sessions.some((session) => session.id === 'stale-session')).toBe(false)
    expect(useSessionStore.getState().indexStatus).toMatchObject({ mode: 'shadow', state: 'building' })
  })

  it('forwards direct branch switch repository options when creating a session', async () => {
    createMock.mockResolvedValue({ sessionId: 'session-branch-switch', workDir: '/workspace/repo' })
    listMock.mockImplementation(() => new Promise(() => {}))

    await useSessionStore.getState().createSession('/workspace/repo', {
      repository: { branch: 'feature/rail', worktree: false },
    })

    expect(createMock).toHaveBeenCalledWith({
      workDir: '/workspace/repo',
      repository: { branch: 'feature/rail', worktree: false },
    })
  })

  it('forwards isolated worktree repository options when creating a session', async () => {
    createMock.mockResolvedValue({
      sessionId: 'session-worktree-launch',
      workDir: '/workspace/repo/.claude/worktrees/desktop-feature-rail-12345678',
    })
    listMock.mockImplementation(() => new Promise(() => {}))

    await useSessionStore.getState().createSession('/workspace/repo', {
      repository: { branch: 'feature/rail', worktree: true },
    })

    expect(createMock).toHaveBeenCalledWith({
      workDir: '/workspace/repo',
      repository: { branch: 'feature/rail', worktree: true },
    })
    expect(useSessionStore.getState().sessions[0]?.workDir)
      .toBe('/workspace/repo/.claude/worktrees/desktop-feature-rail-12345678')
  })

  it('uses the global default permission mode for new sessions when no session override is provided', async () => {
    useSettingsStore.setState({ permissionMode: 'bypassPermissions' })
    createMock.mockResolvedValue({ sessionId: 'session-default-permission', workDir: '/workspace/repo' })
    listMock.mockImplementation(() => new Promise(() => {}))

    await useSessionStore.getState().createSession('/workspace/repo')

    expect(createMock).toHaveBeenCalledWith({
      workDir: '/workspace/repo',
      permissionMode: 'bypassPermissions',
    })
    expect(useSessionStore.getState().sessions[0]?.permissionMode).toBe('bypassPermissions')
  })

  it('keeps an explicit session permission override ahead of the global default', async () => {
    useSettingsStore.setState({ permissionMode: 'bypassPermissions' })
    createMock.mockResolvedValue({ sessionId: 'session-explicit-permission', workDir: '/workspace/repo' })
    listMock.mockImplementation(() => new Promise(() => {}))

    await useSessionStore.getState().createSession('/workspace/repo', {
      permissionMode: 'acceptEdits',
    })

    expect(createMock).toHaveBeenCalledWith({
      workDir: '/workspace/repo',
      permissionMode: 'acceptEdits',
    })
    expect(useSessionStore.getState().sessions[0]?.permissionMode).toBe('acceptEdits')
  })

  it('invalidates cached recent projects after deleting a session', async () => {
    deleteMock.mockResolvedValue({ ok: true })
    useSessionStore.setState({
      sessions: [makeSession('session-delete-1', '2026-05-07T00:00:00.000Z')],
      activeSessionId: 'session-delete-1',
    })

    await useSessionStore.getState().deleteSession('session-delete-1')

    expect(deleteMock).toHaveBeenCalledWith('session-delete-1')
    expect(invalidateRecentProjectsCacheMock).toHaveBeenCalledOnce()
    expect(useSessionStore.getState().sessions).toEqual([])
    expect(useSessionStore.getState().activeSessionId).toBeNull()
  })

  it('invalidates cached recent projects after successful batch deletion', async () => {
    batchDeleteMock.mockResolvedValue({
      ok: true,
      successes: ['session-delete-a'],
      failures: [{ sessionId: 'session-delete-b', message: 'locked' }],
    })
    useSessionStore.setState({
      sessions: [
        makeSession('session-delete-a', '2026-05-07T00:00:00.000Z'),
        makeSession('session-delete-b', '2026-05-07T00:00:01.000Z'),
      ],
      activeSessionId: 'session-delete-b',
    })

    const result = await useSessionStore.getState().deleteSessions([
      'session-delete-a',
      'session-delete-b',
      'session-delete-a',
    ])

    expect(batchDeleteMock).toHaveBeenCalledWith(['session-delete-a', 'session-delete-b'])
    expect(result.successes).toEqual(['session-delete-a'])
    expect(invalidateRecentProjectsCacheMock).toHaveBeenCalledOnce()
    expect(useSessionStore.getState().sessions.map((session) => session.id)).toEqual(['session-delete-b'])
    expect(useSessionStore.getState().activeSessionId).toBe('session-delete-b')
  })

  it('keeps cached recent projects when batch deletion has no successes', async () => {
    batchDeleteMock.mockResolvedValue({
      ok: false,
      successes: [],
      failures: [{ sessionId: 'session-delete-b', message: 'locked' }],
    })
    useSessionStore.setState({
      sessions: [makeSession('session-delete-b', '2026-05-07T00:00:01.000Z')],
      activeSessionId: 'session-delete-b',
    })

    await useSessionStore.getState().deleteSessions(['session-delete-b'])

    expect(invalidateRecentProjectsCacheMock).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions.map((session) => session.id)).toEqual(['session-delete-b'])
  })

  it('returns the branched session before the background refresh completes', async () => {
    branchMock.mockResolvedValue({
      sessionId: 'session-branch-1',
      title: 'Branch from here',
      workDir: '/workspace/repo/branches/session-branch-1',
      sourceSessionId: 'session-source-1',
      targetMessageId: 'transcript-message-1',
    })
    listMock.mockImplementation(() => new Promise(() => {}))
    useSessionStore.setState({
      sessions: [{
        id: 'session-source-1',
        title: 'Source session',
        createdAt: '2026-05-19T00:00:00.000Z',
        modifiedAt: '2026-05-19T00:00:00.000Z',
        messageCount: 4,
        projectPath: '/workspace/repo',
        projectRoot: '/workspace/repo',
        workDir: '/workspace/repo',
        workDirExists: true,
      }],
    })

    const result = await Promise.race([
      useSessionStore.getState().branchSession('session-source-1', 'transcript-message-1'),
      delay(100).then(() => 'timed-out'),
    ])

    expect(result).toMatchObject({
      sessionId: 'session-branch-1',
      title: 'Branch from here',
      workDir: '/workspace/repo/branches/session-branch-1',
    })
    expect(branchMock).toHaveBeenCalledWith('session-source-1', {
      targetMessageId: 'transcript-message-1',
    })
    expect(invalidateRecentProjectsCacheMock).toHaveBeenCalledOnce()
    expect(useSessionStore.getState().activeSessionId).toBe('session-branch-1')
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: 'session-branch-1',
      title: 'Branch from here',
      projectPath: '/workspace/repo',
      workDir: '/workspace/repo/branches/session-branch-1',
      projectRoot: '/workspace/repo',
      workDirExists: true,
    })
    expect(listMock).toHaveBeenCalledOnce()
  })

  it('updates an existing optimistic branch row when the branch session id is already present', async () => {
    branchMock.mockResolvedValue({
      sessionId: 'session-branch-existing',
      title: 'Updated branch',
      workDir: '/workspace/repo/branches/session-branch-existing',
      sourceSessionId: 'session-source-1',
      targetMessageId: 'transcript-message-2',
    })
    listMock.mockImplementation(() => new Promise(() => {}))
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-branch-existing',
          title: 'Old branch title',
          createdAt: '2026-05-18T00:00:00.000Z',
          modifiedAt: '2026-05-18T00:00:00.000Z',
          messageCount: 3,
          projectPath: '/workspace/old',
          projectRoot: '/workspace/old',
          workDir: '/workspace/old',
          workDirExists: true,
        },
        {
          id: 'session-source-1',
          title: 'Source session',
          createdAt: '2026-05-19T00:00:00.000Z',
          modifiedAt: '2026-05-19T00:00:00.000Z',
          messageCount: 4,
          projectPath: '/workspace/repo',
          projectRoot: '/workspace/repo',
          workDir: '/workspace/repo',
          workDirExists: true,
        },
      ],
    })

    await useSessionStore.getState().branchSession('session-source-1', 'transcript-message-2')

    expect(useSessionStore.getState().sessions).toHaveLength(2)
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: 'session-branch-existing',
      title: 'Updated branch',
      projectPath: '/workspace/repo',
      projectRoot: '/workspace/repo',
      workDir: '/workspace/repo/branches/session-branch-existing',
    })
  })
})
