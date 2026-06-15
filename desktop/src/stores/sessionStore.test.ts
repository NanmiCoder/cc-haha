import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { branchMock, createMock, listMock } = vi.hoisted(() => ({
  branchMock: vi.fn(),
  createMock: vi.fn(),
  listMock: vi.fn(),
}))

vi.mock('../api/sessions', () => ({
  sessionsApi: {
    branch: branchMock,
    create: createMock,
    list: listMock,
    delete: vi.fn(),
    rename: vi.fn(),
  },
}))

import { useSessionStore } from './sessionStore'
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
    listMock.mockReset()
    useSessionStore.setState({
      ...initialState,
      sessions: [],
      activeSessionId: null,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({ tabs: [], activeTabId: null })
  })

  afterEach(() => {
    useSessionStore.setState(initialState)
    useTabStore.setState({ tabs: [], activeTabId: null })
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
