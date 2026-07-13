import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { branchMock, createMock, deleteMock, batchDeleteMock, listMock, invalidateRecentProjectsCacheMock } = vi.hoisted(() => ({
  branchMock: vi.fn(),
  createMock: vi.fn(),
  deleteMock: vi.fn(),
  batchDeleteMock: vi.fn(),
  listMock: vi.fn(),
  invalidateRecentProjectsCacheMock: vi.fn(),
}))

vi.mock('../api/sessions', () => ({
  sessionsApi: {
    branch: branchMock,
    create: createMock,
    list: listMock,
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

describe('sessionStore', () => {
  beforeEach(() => {
    branchMock.mockReset()
    createMock.mockReset()
    deleteMock.mockReset()
    batchDeleteMock.mockReset()
    listMock.mockReset()
    invalidateRecentProjectsCacheMock.mockReset()
    useSessionStore.setState({
      ...initialState,
      sessions: [],
      activeSessionId: null,
      isLoading: false,
      error: null,
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

  it('requests a large default session page for noisy history directories', async () => {
    listMock.mockResolvedValue({
      sessions: [makeSession('session-newest', '2026-05-07T00:00:03.000Z')],
      total: 474,
    })

    await useSessionStore.getState().fetchSessions()

    expect(listMock).toHaveBeenCalledWith({ limit: 400 })
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
