import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceWatchEvent } from './fileWatch'

const mocks = vi.hoisted(() => ({ stream: vi.fn(), refresh: vi.fn(), readFile: vi.fn(), readTree: vi.fn(), status: vi.fn() }))
vi.mock('./fileWatch', () => ({ streamWorkspaceWatch: mocks.stream }))
vi.mock('../../api/sessions', () => ({ sessionsApi: {
  getWorkspaceFile: mocks.readFile,
  getWorkspaceTree: mocks.readTree,
  getWorkspaceStatus: mocks.status,
} }))
vi.mock('../terminalRuntime', () => ({ destroyTerminalRuntime: vi.fn() }))
vi.mock('./browserHost', () => ({ releaseWorkspaceBrowserTab: vi.fn() }))

import { useWorkspaceContentStore } from '../../stores/workspaceContentStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useWorkspaceFileWatch } from './useWorkspaceFileWatch'

const originalRefresh = useWorkspaceContentStore.getState().refreshWatchedPaths
const subscriptions: Array<{ task: string; directories: string[]; signal: AbortSignal; notify: (event: WorkspaceWatchEvent) => void }> = []

beforeEach(() => {
  vi.useFakeTimers()
  subscriptions.length = 0
  mocks.refresh.mockReset().mockResolvedValue(undefined)
  mocks.readFile.mockReset()
  mocks.readTree.mockReset()
  mocks.status.mockReset().mockResolvedValue({ state: 'ok', workDir: '/repo', isGitRepo: false, changedFiles: [] })
  mocks.stream.mockReset().mockImplementation((task, directories, signal, notify) => {
    subscriptions.push({ task, directories, signal, notify })
    return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
  })
  useWorkspaceStore.setState({ bySession: {} })
  useWorkspaceContentStore.setState({
    filesByKey: {}, treeByKey: {}, treeLoadingByKey: {}, expandedBySession: {}, statusBySession: {},
    refreshWatchedPaths: mocks.refresh,
  })
})

afterEach(() => {
  useWorkspaceContentStore.setState({ refreshWatchedPaths: originalRefresh })
  vi.useRealTimers()
})

describe('task-owned file watch', () => {
  it.each([
    { name: 'different directories', directory: 'src', coarse: 'src/a.ts', named: 'other/b.ts', namedDirectory: 'other' },
    { name: 'the same directory', directory: 'src', coarse: 'src/a.ts', named: 'src/b.ts', namedDirectory: 'src' },
    { name: 'the workspace root', directory: '', coarse: 'a.ts', named: 'other/b.ts', namedDirectory: 'other' },
  ])('refreshes both real caches when coarse and named changes share a batch in $name', async ({ directory, coarse, named, namedDirectory }) => {
    useWorkspaceContentStore.setState({ refreshWatchedPaths: originalRefresh })
    const content = () => useWorkspaceContentStore.getState()
    // Keep the absolute chat request key while events use the validated relative identity.
    const coarseRequest = `/repo/${coarse}`
    useWorkspaceStore.getState().openTarget('a', { kind: 'file', path: coarseRequest })
    useWorkspaceStore.getState().openTarget('a', { kind: 'file', path: named })
    let revision = 'before'
    mocks.readFile.mockImplementation(async (_task, path) => ({ state: 'ok', path: path.replace('/repo/', ''), content: revision, language: 'ts', size: 6 }))
    await content().loadFile('a', coarseRequest)
    await content().loadFile('a', named)
    const hook = renderHook(() => useWorkspaceFileWatch('a', true))
    try {
      act(() => subscriptions[0]!.notify({ type: 'ready' }))
      await act(() => vi.advanceTimersByTimeAsync(120))
      mocks.readFile.mockClear()
      revision = 'after'
      act(() => {
        subscriptions[0]!.notify({ type: 'change', paths: [], directories: [directory] })
        subscriptions[0]!.notify({ type: 'change', paths: [named], directories: [namedDirectory] })
      })
      await act(() => vi.advanceTimersByTimeAsync(120))
      expect(content().getFile('a', coarseRequest)?.content).toBe('after')
      expect(content().getFile('a', named)?.content).toBe('after')
      expect(new Set(mocks.readFile.mock.calls.map((call) => call[1]))).toEqual(new Set([coarseRequest, named]))
      expect(content().getFile('a', coarse)).toBeUndefined()
    } finally {
      hook.unmount()
      content().clearSession('a')
    }
  })

  it('does not refresh real caches from a mixed batch after its task is cancelled', async () => {
    useWorkspaceContentStore.setState({ refreshWatchedPaths: originalRefresh })
    mocks.readFile.mockImplementation(async (_task, path) => ({ state: 'ok', path, content: 'before', language: 'ts', size: 6 }))
    for (const path of ['src/a.ts', 'other/b.ts']) {
      useWorkspaceStore.getState().openTarget('a', { kind: 'file', path })
      await useWorkspaceContentStore.getState().loadFile('a', path)
    }
    const hook = renderHook(({ task }) => useWorkspaceFileWatch(task, true), { initialProps: { task: 'a' } })
    act(() => subscriptions[0]!.notify({ type: 'ready' }))
    await act(() => vi.advanceTimersByTimeAsync(120))
    mocks.readFile.mockClear()
    act(() => {
      subscriptions[0]!.notify({ type: 'change', paths: [], directories: ['src'] })
      subscriptions[0]!.notify({ type: 'change', paths: ['other/b.ts'], directories: ['other'] })
    })
    hook.rerender({ task: 'b' })
    await act(() => vi.advanceTimersByTimeAsync(120))
    expect(subscriptions[0]?.signal.aborted).toBe(true)
    expect(mocks.readFile).not.toHaveBeenCalled()
    expect(useWorkspaceContentStore.getState().getFile('a', 'src/a.ts')?.content).toBe('before')
    expect(useWorkspaceContentStore.getState().getFile('b', 'src/a.ts')).toBeUndefined()
    hook.unmount()
  })

  it('reattaches subscribed descendants when a mixed batch cannot name a replaced child directory', async () => {
    useWorkspaceStore.getState().openTarget('a', { kind: 'file', path: 'src/nested/a.ts' })
    useWorkspaceContentStore.setState({ treeByKey: { 'a::src': { state: 'ok', path: 'src', entries: [] } } })
    const hook = renderHook(() => useWorkspaceFileWatch('a', true))
    await act(async () => {
      subscriptions[0]!.notify({ type: 'change', paths: ['src/b.ts'], directories: ['src'] })
      await Promise.resolve()
    })
    expect(subscriptions[0]?.signal.aborted).toBe(true)
    expect(subscriptions).toHaveLength(2)
    expect(subscriptions[1]?.directories).toContain('src/nested')
    hook.unmount()
  })

  it('refreshes an absolute chat target through the server-relative subscription and change paths', async () => {
    useWorkspaceContentStore.setState({ refreshWatchedPaths: originalRefresh })
    useWorkspaceStore.getState().openTarget('a', { kind: 'file', path: '/repo/src/a.ts' })
    mocks.readFile.mockResolvedValue({ state: 'ok', path: 'src/a.ts', content: 'before', language: 'ts', size: 6 })
    mocks.readTree.mockResolvedValue({ state: 'ok', path: 'src', entries: [] })
    await useWorkspaceContentStore.getState().loadFile('a', '/repo/src/a.ts')
    await useWorkspaceContentStore.getState().loadTree('a', '/repo/src')
    const hook = renderHook(() => useWorkspaceFileWatch('a', true))
    act(() => subscriptions[0]!.notify({ type: 'ready' }))
    await act(() => vi.advanceTimersByTimeAsync(120))
    mocks.readFile.mockResolvedValue({ state: 'ok', path: 'src/a.ts', content: 'after', language: 'ts', size: 5 })
    act(() => subscriptions[0]!.notify({ type: 'change', paths: ['src/a.ts'], directories: ['src'] }))
    await act(() => vi.advanceTimersByTimeAsync(120))

    expect(useWorkspaceContentStore.getState().getFile('a', '/repo/src/a.ts')?.content).toBe('after')
    expect(subscriptions[0]?.directories).toEqual(['', 'src'])
    expect(mocks.readFile).toHaveBeenLastCalledWith('a', '/repo/src/a.ts', expect.any(AbortSignal))
    hook.unmount()
  })

  it('reattaches when missing ancestors of a subscribed directory are recreated', async () => {
    useWorkspaceStore.getState().openTarget('a', { kind: 'file', path: 'src/nested/a.ts' })
    const hook = renderHook(() => useWorkspaceFileWatch('a', true))
    // The root directory is itself authoritative: this could also contain an
    // unnamed replacement of src, so even a named sibling requires reattach.
    await act(async () => {
      subscriptions[0]!.notify({ type: 'change', paths: ['src-other'], directories: [''] })
      await Promise.resolve()
    })
    expect(subscriptions[0]?.signal.aborted).toBe(true)
    expect(subscriptions).toHaveLength(2)
    act(() => subscriptions[1]!.notify({ type: 'ready' }))
    await act(() => vi.advanceTimersByTimeAsync(120))
    expect(subscriptions).toHaveLength(2)
    await act(async () => {
      subscriptions[1]!.notify({ type: 'change', paths: ['src'], directories: [''] })
      await Promise.resolve()
    })
    expect(subscriptions[1]?.signal.aborted).toBe(true)
    expect(subscriptions).toHaveLength(3)
    await act(async () => {
      subscriptions[2]!.notify({ type: 'change', paths: ['src/nested'], directories: ['src'] })
      await Promise.resolve()
    })
    expect(subscriptions[2]?.signal.aborted).toBe(true)
    expect(subscriptions).toHaveLength(4)
    act(() => subscriptions[3]!.notify({ type: 'change', paths: ['src/nested/a.ts'], directories: ['src/nested'] }))
    await act(() => vi.advanceTimersByTimeAsync(120))
    expect(mocks.refresh.mock.calls.at(-1)?.[1]).toContain('src/nested/a.ts')
    hook.unmount()
  })

  it('watches loaded directories and file parents, coalesces events, and preserves subscriptions across activation', async () => {
    const id = useWorkspaceStore.getState().openTarget('a', { kind: 'file', path: 'src/nested/a.ts' })!
    useWorkspaceContentStore.setState({ treeByKey: { 'a::src': { state: 'ok', path: 'src', entries: [] } } })
    const hook = renderHook(() => useWorkspaceFileWatch('a', true))
    expect(subscriptions[0]?.directories).toEqual(['', 'src/nested', 'src'])
    act(() => subscriptions[0]!.notify({ type: 'ready' }))
    await act(() => vi.advanceTimersByTimeAsync(120))
    expect(mocks.refresh).toHaveBeenCalledWith('a', ['src/nested/a.ts'], ['', 'src/nested', 'src'], expect.any(AbortSignal))
    mocks.refresh.mockClear()

    act(() => {
      subscriptions[0]!.notify({ type: 'change', paths: ['src/nested/a.ts'], directories: ['src/nested'] })
      subscriptions[0]!.notify({ type: 'change', paths: ['src/nested/b.ts'], directories: ['src/nested'] })
      useWorkspaceStore.getState().activateTab('a', id)
    })
    await act(() => vi.advanceTimersByTimeAsync(120))
    expect(subscriptions).toHaveLength(1)
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
    expect(mocks.refresh.mock.calls[0]?.[1]).toEqual(['src/nested/a.ts', 'src/nested/b.ts'])
    hook.unmount()
    expect(subscriptions[0]?.signal.aborted).toBe(true)
  })

  it('cancels old task events and refreshes the resumed task after the subscription is ready', async () => {
    const hook = renderHook(({ task, enabled }) => useWorkspaceFileWatch(task, enabled), { initialProps: { task: 'a', enabled: true } })
    hook.rerender({ task: 'b', enabled: true })
    expect(subscriptions[0]?.signal.aborted).toBe(true)
    act(() => subscriptions[0]!.notify({ type: 'change', paths: ['old.ts'], directories: [''] }))
    await act(() => vi.advanceTimersByTimeAsync(120))
    expect(mocks.refresh).not.toHaveBeenCalled()
    hook.rerender({ task: 'a', enabled: true })
    act(() => subscriptions[2]!.notify({ type: 'ready' }))
    await act(() => vi.advanceTimersByTimeAsync(120))
    expect(mocks.refresh.mock.calls[0]?.[0]).toBe('a')
    hook.rerender({ task: 'a', enabled: false })
    expect(subscriptions[2]?.signal.aborted).toBe(true)
    hook.unmount()
  })

  it('reattaches after a watched directory is replaced and shows the directory bound', async () => {
    useWorkspaceContentStore.setState({ treeByKey: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [
      `a::dir-${index}`, { state: 'ok', path: `dir-${index}`, entries: [] },
    ])) })
    const hook = renderHook(() => useWorkspaceFileWatch('a', true))
    expect(subscriptions[0]?.directories).toHaveLength(64)
    expect(hook.result.current).toContain('64')
    await act(async () => {
      subscriptions[0]!.notify({ type: 'change', paths: ['dir-0'], directories: [''] })
      await Promise.resolve()
    })
    expect(subscriptions[0]?.signal.aborted).toBe(true)
    expect(subscriptions).toHaveLength(2)
    hook.unmount()
  })
})

it('invalidates review comparisons after an external file change', async () => {
  const { useWorkspaceReviewStore } = await import('../../stores/workspaceReviewStore')
  const previous = useWorkspaceReviewStore.getState().revisionBySession?.a ?? 0
  const hook = renderHook(() => useWorkspaceFileWatch('a', true))
  act(() => subscriptions[0]!.notify({ type: 'change', paths: ['a.txt'], directories: [''] }))
  await act(() => vi.advanceTimersByTimeAsync(120))
  expect(useWorkspaceReviewStore.getState().revisionBySession?.a).toBe(previous + 1)
  hook.unmount()
})
