import { beforeEach, describe, expect, it, vi } from 'vitest'

type HoistedVi = typeof vi & { hoisted?: <T>(factory: () => T) => T }
if (typeof (vi as HoistedVi).hoisted !== 'function') {
  ;(vi as HoistedVi).hoisted = <T>(factory: () => T) => factory()
}

const mocks = vi.hoisted(() => ({
  getWorkspaceFile: vi.fn(),
  getWorkspaceTree: vi.fn(),
  getWorkspaceStatus: vi.fn(),
}))

vi.mock('../api/sessions', () => ({
  sessionsApi: {
    getWorkspaceFile: mocks.getWorkspaceFile,
    getWorkspaceTree: mocks.getWorkspaceTree,
    getWorkspaceStatus: mocks.getWorkspaceStatus,
  },
}))

import { useWorkspaceContentStore } from './workspaceContentStore'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

const SESSION = 'session-a'

function store() {
  return useWorkspaceContentStore.getState()
}

beforeEach(() => {
  // `clearSession` also drops the module-level probe/request bookkeeping, which
  // `setState` alone cannot reach.
  for (const sessionId of [SESSION, 'session-b']) {
    useWorkspaceContentStore.getState().clearSession(sessionId)
  }
  useWorkspaceContentStore.setState({
    filesByKey: {},
    treeByKey: {},
    treeLoadingByKey: {},
    expandedBySession: {},
    statusBySession: {},
  })
  mocks.getWorkspaceFile.mockReset()
  mocks.getWorkspaceTree.mockReset()
  mocks.getWorkspaceStatus.mockReset()
})

describe('file content', () => {
  it('reads a file once and serves the cache afterwards', async () => {
    mocks.getWorkspaceFile.mockResolvedValue({ state: 'ok', path: 'a.ts', content: 'x', language: 'ts', size: 1 })

    await store().loadFile(SESSION, 'a.ts')
    await store().loadFile(SESSION, 'a.ts')

    expect(mocks.getWorkspaceFile).toHaveBeenCalledTimes(1)
    expect(store().getFile(SESSION, 'a.ts')).toMatchObject({ state: 'ok', content: 'x' })
  })

  it('re-reads when the caller forces it', async () => {
    mocks.getWorkspaceFile.mockResolvedValue({ state: 'ok', path: 'a.ts', content: 'x', language: 'ts', size: 1 })

    await store().loadFile(SESSION, 'a.ts')
    await store().loadFile(SESSION, 'a.ts', { force: true })

    expect(mocks.getWorkspaceFile).toHaveBeenCalledTimes(2)
  })

  it('keeps the last good content when a refresh fails', async () => {
    mocks.getWorkspaceFile.mockResolvedValueOnce({ state: 'ok', path: 'a.ts', content: 'good', language: 'ts', size: 4 })
    await store().loadFile(SESSION, 'a.ts')

    mocks.getWorkspaceFile.mockResolvedValueOnce({ state: 'missing', path: 'a.ts', language: 'ts', size: 0, error: 'gone' })
    await store().loadFile(SESSION, 'a.ts', { force: true })

    // Blanking a file the user is reading because a refresh raced a save is
    // worse than showing slightly stale content next to the failure.
    expect(store().getFile(SESSION, 'a.ts')).toMatchObject({
      state: 'ok',
      content: 'good',
      refreshError: 'gone',
    })
  })

  it('surfaces a first-read failure as an error state', async () => {
    mocks.getWorkspaceFile.mockRejectedValue(new Error('boom'))
    await store().loadFile(SESSION, 'a.ts')
    expect(store().getFile(SESSION, 'a.ts')).toMatchObject({ state: 'error', error: 'boom' })
  })

  it('ignores a stale response that lost a race', async () => {
    const slow = deferred<unknown>()
    const fast = deferred<unknown>()
    mocks.getWorkspaceFile.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise)

    const first = store().loadFile(SESSION, 'a.ts')
    const second = store().loadFile(SESSION, 'a.ts', { force: true })

    fast.resolve({ state: 'ok', path: 'a.ts', content: 'newest', language: 'ts', size: 6 })
    await second
    slow.resolve({ state: 'ok', path: 'a.ts', content: 'stale', language: 'ts', size: 5 })
    await first

    expect(store().getFile(SESSION, 'a.ts')).toMatchObject({ content: 'newest' })
  })
})

describe('tree', () => {
  it('expands a directory and loads it once', async () => {
    mocks.getWorkspaceTree.mockResolvedValue({ state: 'ok', path: 'src', entries: [] })

    await store().toggleDirectory(SESSION, 'src')
    expect(store().isExpanded(SESSION, 'src')).toBe(true)
    expect(mocks.getWorkspaceTree).toHaveBeenCalledTimes(1)

    await store().toggleDirectory(SESSION, 'src')
    await store().toggleDirectory(SESSION, 'src')
    // Re-expanding a directory reuses the listing it already has.
    expect(mocks.getWorkspaceTree).toHaveBeenCalledTimes(1)
  })

  it('records a listing failure without losing the expansion', async () => {
    mocks.getWorkspaceTree.mockRejectedValue(new Error('nope'))
    await store().toggleDirectory(SESSION, 'src')

    expect(store().isExpanded(SESSION, 'src')).toBe(true)
    expect(store().getTree(SESSION, 'src')).toMatchObject({ state: 'error', error: 'nope' })
  })
})

describe('invalidation', () => {
  it.each([
    { name: 'coarse-only', paths: [], directories: ['src'] },
    { name: 'mixed', paths: ['other/b.ts'], directories: ['src', 'other'] },
  ])('refreshes cached descendants for $name directory events without enumerating other files', async ({ paths, directories }) => {
    let revision = 'before'
    mocks.getWorkspaceFile.mockImplementation(async (_session, path) => ({ state: 'ok', path: path.replace('/repo/', ''), content: revision, language: 'ts', size: 6 }))
    mocks.getWorkspaceTree.mockImplementation(async (_session, path) => ({ state: 'ok', path, entries: [] }))
    for (const path of ['/repo/src/nested/a.ts', 'src/c.ts', 'other/b.ts', 'src-other/keep.ts']) await store().loadFile(SESSION, path)
    await store().loadFile('session-b', 'src/c.ts')
    await store().toggleDirectory(SESSION, 'src/nested')
    store().setFileView(SESSION, '/repo/src/nested/a.ts', { scrollTop: 123, scrollLeft: 7 })
    mocks.getWorkspaceFile.mockClear()
    mocks.getWorkspaceTree.mockClear()
    revision = 'after'
    await store().refreshWatchedPaths(SESSION, paths, directories, new AbortController().signal)
    expect(store().getFile(SESSION, '/repo/src/nested/a.ts')?.content).toBe('after')
    expect(store().getFile(SESSION, 'src/c.ts')?.content).toBe('after')
    expect(store().getFile(SESSION, 'src-other/keep.ts')?.content).toBe('before')
    expect(store().getFile('session-b', 'src/c.ts')?.content).toBe('before')
    expect(mocks.getWorkspaceFile.mock.calls.map((call) => call[1])).toEqual([
      '/repo/src/nested/a.ts', 'src/c.ts', ...(directories.includes('other') ? ['other/b.ts'] : []),
    ])
    expect(mocks.getWorkspaceTree).toHaveBeenCalledWith(SESSION, 'src/nested', expect.any(AbortSignal))
    expect(store().isExpanded(SESSION, 'src/nested')).toBe(true)
    expect(store().fileViewByKey[`${SESSION}::/repo/src/nested/a.ts`]).toEqual({ scrollTop: 123, scrollLeft: 7 })
  })

  it('limits a root directory invalidation to cached workspace identities', async () => {
    let revision = 'before'
    mocks.getWorkspaceFile.mockImplementation(async (_session, path) => ({ state: 'ok', path: path.replace('/repo/', ''), content: revision, language: 'ts', size: 6 }))
    for (const path of ['root.ts', '/repo/src/nested/a.ts', 'c:relative.ts', '/outside/keep.ts', 'C:\\outside\\keep.ts']) await store().loadFile(SESSION, path)
    mocks.getWorkspaceFile.mockClear()
    revision = 'after'
    await store().refreshWatchedPaths(SESSION, ['root.ts'], [''], new AbortController().signal)
    expect(mocks.getWorkspaceFile.mock.calls.map((call) => call[1])).toEqual(['root.ts', '/repo/src/nested/a.ts', 'c:relative.ts'])
    expect(store().getFile(SESSION, '/repo/src/nested/a.ts')?.content).toBe('after')
    expect(store().getFile(SESSION, '/outside/keep.ts')?.content).toBe('before')
    expect(store().getFile(SESSION, 'C:\\outside\\keep.ts')?.content).toBe('before')
  })

  it('refreshes absolute opened files and trees from the server-relative watch paths', async () => {
    mocks.getWorkspaceFile.mockResolvedValue({ state: 'ok', path: 'src/a.ts', content: 'before', language: 'ts', size: 6 })
    mocks.getWorkspaceTree.mockResolvedValue({ state: 'ok', path: 'src', entries: [] })
    await store().loadFile(SESSION, '/repo/src/a.ts')
    await store().loadTree(SESSION, '/repo/src')
    mocks.getWorkspaceFile.mockResolvedValue({ state: 'ok', path: 'src/a.ts', content: 'after', language: 'ts', size: 5 })
    mocks.getWorkspaceFile.mockClear()
    mocks.getWorkspaceTree.mockClear()

    const signal = new AbortController().signal
    await store().refreshWatchedPaths(SESSION, ['src/a.ts'], ['src'], signal)

    expect(mocks.getWorkspaceFile).toHaveBeenCalledWith(SESSION, '/repo/src/a.ts', signal)
    expect(mocks.getWorkspaceTree).toHaveBeenCalledWith(SESSION, '/repo/src', signal)
    expect(store().getFile(SESSION, '/repo/src/a.ts')?.content).toBe('after')
    expect(store().getFile(SESSION, 'src/a.ts')).toBeUndefined()

    mocks.getWorkspaceFile.mockResolvedValue({ state: 'ok', path: 'src/a.ts', content: 'coarse event', language: 'ts', size: 12 })
    await store().refreshWatchedPaths(SESSION, [], ['src'], signal)
    expect(store().getFile(SESSION, '/repo/src/a.ts')?.content).toBe('coarse event')
  })

  it('refreshes only changed cached paths in place while preserving directory expansion', async () => {
    mocks.getWorkspaceFile.mockImplementation(async (_session, path) => ({ state: 'ok', path, content: 'before', language: 'ts', size: 6 }))
    mocks.getWorkspaceTree.mockResolvedValue({ state: 'ok', path: 'src', entries: [{ path: 'src/a.ts', name: 'a.ts', isDirectory: false }] })
    await store().loadFile(SESSION, 'src/a.ts')
    await store().loadFile(SESSION, 'unrelated.ts')
    await store().toggleDirectory(SESSION, 'src')
    mocks.getWorkspaceFile.mockClear()
    const read = deferred<unknown>()
    mocks.getWorkspaceFile.mockReturnValue(read.promise)
    const refresh = store().refreshWatchedPaths(SESSION, ['src/a.ts'], ['src'], new AbortController().signal)
    expect(store().getFile(SESSION, 'src/a.ts')?.content).toBe('before')
    expect(store().isExpanded(SESSION, 'src')).toBe(true)
    expect(mocks.getWorkspaceFile).toHaveBeenCalledTimes(1)
    read.resolve({ state: 'ok', path: 'src/a.ts', content: 'after', language: 'ts', size: 5 })
    await refresh
    expect(store().getFile(SESSION, 'src/a.ts')?.content).toBe('after')
    expect(store().getFile(SESSION, 'unrelated.ts')?.content).toBe('before')
  })

  it('does not apply a late watch refresh after cancellation or task release', async () => {
    mocks.getWorkspaceFile.mockResolvedValueOnce({ state: 'ok', path: 'a.ts', content: 'before', language: 'ts', size: 6 })
    await store().loadFile(SESSION, 'a.ts')
    const read = deferred<unknown>()
    mocks.getWorkspaceFile.mockReturnValue(read.promise)
    const abort = new AbortController()
    const refresh = store().refreshWatchedPaths(SESSION, ['a.ts'], [''], abort.signal)
    abort.abort()
    store().clearSession(SESSION)
    read.resolve({ state: 'ok', path: 'a.ts', content: 'late', language: 'ts', size: 4 })
    await refresh
    expect(store().getFile(SESSION, 'a.ts')).toBeUndefined()
  })

  it('keeps cached file and tree content when only the subscription is cancelled', async () => {
    mocks.getWorkspaceFile.mockResolvedValueOnce({ state: 'ok', path: 'src/a.ts', content: 'before', language: 'ts', size: 6 })
    mocks.getWorkspaceTree.mockResolvedValueOnce({ state: 'ok', path: 'src', entries: [{ name: 'a.ts', path: 'src/a.ts', isDirectory: false }] })
    await store().loadFile(SESSION, 'src/a.ts')
    await store().loadTree(SESSION, 'src')
    const file = deferred<unknown>()
    const tree = deferred<unknown>()
    mocks.getWorkspaceFile.mockReturnValue(file.promise)
    mocks.getWorkspaceTree.mockReturnValue(tree.promise)
    const abort = new AbortController()
    const refresh = store().refreshWatchedPaths(SESSION, ['src/a.ts'], ['src'], abort.signal)
    expect(mocks.getWorkspaceFile).toHaveBeenLastCalledWith(SESSION, 'src/a.ts', abort.signal)
    expect(mocks.getWorkspaceTree).toHaveBeenLastCalledWith(SESSION, 'src', abort.signal)
    abort.abort()
    file.resolve({ state: 'ok', path: 'src/a.ts', content: 'late', language: 'ts', size: 4 })
    tree.resolve({ state: 'ok', path: 'src', entries: [] })
    await refresh
    expect(store().getFile(SESSION, 'src/a.ts')?.content).toBe('before')
    expect(store().getTree(SESSION, 'src')?.entries).toHaveLength(1)
    expect(store().isTreeLoading(SESSION, 'src')).toBe(false)
  })

  it('drops a changed file and its directory listing but keeps the tree open', async () => {
    mocks.getWorkspaceFile.mockResolvedValue({ state: 'ok', path: 'src/a.ts', content: 'x', language: 'ts', size: 1 })
    mocks.getWorkspaceTree.mockResolvedValue({ state: 'ok', path: 'src', entries: [] })

    await store().loadFile(SESSION, 'src/a.ts')
    await store().toggleDirectory(SESSION, 'src')

    store().invalidatePaths(SESSION, ['src/a.ts'])

    expect(store().getFile(SESSION, 'src/a.ts')).toBeUndefined()
    expect(store().getTree(SESSION, 'src')).toBeUndefined()
    // Re-reading a directory must not collapse the tree the user is looking at.
    expect(store().isExpanded(SESSION, 'src')).toBe(true)
  })

  it('does not apply a read that was in flight when the path was invalidated', async () => {
    const pending = deferred<unknown>()
    mocks.getWorkspaceFile.mockReturnValue(pending.promise)

    const read = store().loadFile(SESSION, 'a.ts')
    store().invalidatePaths(SESSION, ['a.ts'])
    pending.resolve({ state: 'ok', path: 'a.ts', content: 'late', language: 'ts', size: 4 })
    await read

    expect(store().getFile(SESSION, 'a.ts')).toBeUndefined()
  })
})

describe('session lifetime', () => {
  it('drops only the closed session', async () => {
    mocks.getWorkspaceFile.mockResolvedValue({ state: 'ok', path: 'a.ts', content: 'x', language: 'ts', size: 1 })
    await store().loadFile(SESSION, 'a.ts')
    await store().loadFile('session-b', 'a.ts')

    store().clearSession(SESSION)

    expect(store().getFile(SESSION, 'a.ts')).toBeUndefined()
    expect(store().getFile('session-b', 'a.ts')).toMatchObject({ state: 'ok' })
  })

  it('probes the Git status once so the launcher can explain itself', async () => {
    mocks.getWorkspaceStatus.mockResolvedValue({
      state: 'ok', workDir: '/repo', repoName: null, branch: null, isGitRepo: false, changedFiles: [],
    })

    await store().loadStatus(SESSION)
    await store().loadStatus(SESSION)

    expect(mocks.getWorkspaceStatus).toHaveBeenCalledTimes(1)
    expect(useWorkspaceContentStore.getState().statusBySession[SESSION]).toMatchObject({ isGitRepo: false })
  })

  it('leaves the launcher alone when the status probe fails', async () => {
    mocks.getWorkspaceStatus.mockRejectedValue(new Error('offline'))
    await store().loadStatus(SESSION)
    expect(useWorkspaceContentStore.getState().statusBySession[SESSION]).toBeUndefined()
  })
})

describe('status probe', () => {
  it('does not re-request after a failure on every remount', async () => {
    mocks.getWorkspaceStatus.mockRejectedValue(new Error('offline'))

    await store().loadStatus(SESSION)
    await store().loadStatus(SESSION)
    await store().loadStatus(SESSION)

    // A failed probe caches nothing, so guarding only the *result* would fire a
    // fresh request every time the file tab mounted.
    expect(mocks.getWorkspaceStatus).toHaveBeenCalledTimes(1)
  })

  it('retries when the caller explicitly forces it', async () => {
    mocks.getWorkspaceStatus.mockRejectedValue(new Error('offline'))
    await store().loadStatus(SESSION)
    await store().loadStatus(SESSION, { force: true })
    expect(mocks.getWorkspaceStatus).toHaveBeenCalledTimes(2)
  })

  it('probes again for a session that was closed and reopened', async () => {
    mocks.getWorkspaceStatus.mockRejectedValue(new Error('offline'))
    await store().loadStatus(SESSION)
    store().clearSession(SESSION)
    await store().loadStatus(SESSION)
    expect(mocks.getWorkspaceStatus).toHaveBeenCalledTimes(2)
  })
})
