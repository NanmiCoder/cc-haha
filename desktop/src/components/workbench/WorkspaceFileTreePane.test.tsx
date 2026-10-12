import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getWorkspaceTree: vi.fn(),
  searchWorkspace: vi.fn(),
  getWorkspaceStatus: vi.fn(),
  getWorkspaceFile: vi.fn(),
  openTarget: vi.fn().mockResolvedValue(undefined),
  copyText: vi.fn().mockResolvedValue(true),
}))

vi.mock('../../api/sessions', () => ({
  sessionsApi: {
    getWorkspaceTree: mocks.getWorkspaceTree,
    searchWorkspace: mocks.searchWorkspace,
    getWorkspaceFile: mocks.getWorkspaceFile,
    getWorkspaceStatus: mocks.getWorkspaceStatus,
  },
}))

vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: mocks.copyText }))
vi.mock('@/stores/openTargetStore', () => {
  const targets = [
    { id: 'system-default', kind: 'system_default', label: 'System default', platform: 'win32' },
    { id: 'explorer', kind: 'file_manager', label: 'Explorer', platform: 'win32' },
  ]
  const state = { targets, getTargetsForPath: () => new Promise(() => {}), openTarget: mocks.openTarget }
  return { useOpenTargetStore: Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state }) }
})

import { useWorkspaceContentStore } from '../../stores/workspaceContentStore'
import { WorkspaceFileTreePane } from './WorkspaceFileTreePane'
import { useWorkspaceChatContextStore } from '@/stores/workspaceChatContextStore'

const SESSION = 'session-a'
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
const scrollIntoView = vi.fn()

const ROOT = {
  state: 'ok' as const,
  path: '',
  entries: [
    { name: 'src', path: 'src', isDirectory: true },
    { name: 'README.md', path: 'README.md', isDirectory: false },
  ],
}

const SRC = {
  state: 'ok' as const,
  path: 'src',
  entries: [
    { name: 'adapters.ts', path: 'src/adapters.ts', isDirectory: false },
    { name: 'client.ts', path: 'src/client.ts', isDirectory: false },
  ],
}

async function renderPane(onOpen = vi.fn()) {
  const view = render(
    <WorkspaceFileTreePane sessionId={SESSION} selectedPath={null} onOpen={onOpen} />,
  )
  await act(async () => { await Promise.resolve() })
  return { ...view, onOpen }
}

beforeEach(() => {
  vi.useRealTimers()
  HTMLElement.prototype.scrollIntoView = scrollIntoView
  scrollIntoView.mockClear()
  useWorkspaceContentStore.setState({
    filesByKey: {},
    treeByKey: {},
    treeLoadingByKey: {},
    expandedBySession: {},
    treeViewBySession: {},
    fileViewByKey: {},
    statusBySession: { [SESSION]: { state: 'ok', workDir: '/repo', repoName: 'repo', branch: 'main', isGitRepo: true, changedFiles: [] } },
  })
  mocks.getWorkspaceTree.mockReset()
  mocks.getWorkspaceTree.mockImplementation(async (_session: string, path: string) =>
    path === 'src' ? SRC : ROOT)
  mocks.getWorkspaceStatus.mockResolvedValue({ state: 'ok', workDir: '/repo', changedFiles: [
    { path: 'src/changed.ts', status: 'modified', additions: 1, deletions: 0 },
  ] })
  mocks.searchWorkspace.mockReset()
  mocks.getWorkspaceFile.mockReset()
  mocks.searchWorkspace.mockImplementation(async (_session: string, query: string) => ({
    state: 'ok', query, truncated: false,
    entries: SRC.entries.filter((entry) => entry.path.includes(query)),
  }))
})

afterEach(() => {
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView
})

describe('WorkspaceFileTreePane', () => {
  it.each(['create', 'rename', 'delete'] as const)('refreshes a restored filter after a watched %s when the file parent has no cached listing', async change => {
    const file = '/repo/large/zz-last.txt'
    const base = { name: 'zz-last.txt', path: 'large/zz-last.txt', isDirectory: false }
    const old = { name: 'zz-last-existing.txt', path: 'large/zz-last-existing.txt', isDirectory: false }
    const next = { name: 'zz-last-new.txt', path: 'large/zz-last-new.txt', isDirectory: false }
    let matches = change === 'create' ? [base] : [base, old]
    mocks.getWorkspaceTree.mockResolvedValue({ state: 'ok', path: '', entries: [{ name: 'large', path: 'large', isDirectory: true }] })
    mocks.getWorkspaceFile.mockResolvedValue({ state: 'ok', path: base.path, content: 'after', language: 'text', size: 5 })
    mocks.searchWorkspace.mockImplementation(async (_task, query) => ({ state: 'ok', query, truncated: false, entries: [...matches] }))
    useWorkspaceContentStore.getState().setTreeView(SESSION, { filter: 'zz-last' })
    useWorkspaceContentStore.setState({ filesByKey: {
      [`${SESSION}::${file}`]: { path: file, watchPath: base.path, state: 'ok', content: 'before' },
    } })
    render(<WorkspaceFileTreePane sessionId={SESSION} selectedPath={file} onOpen={vi.fn()} />)
    await screen.findByTestId(`workspace-tree-row-${change === 'create' ? base.path : old.path}`)
    expect(mocks.searchWorkspace).toHaveBeenCalledTimes(1)
    expect(useWorkspaceContentStore.getState().getTree(SESSION, 'large')).toBeUndefined()
    matches = change === 'delete' ? [base] : [base, next]
    await act(async () => {
      await useWorkspaceContentStore.getState().refreshWatchedPaths(SESSION, change === 'create' ? [next.path] : [old.path, next.path], ['large'], new AbortController().signal)
    })
    // The preview receives its update: a valid watch event arrived. There is
    // no cached parent tree to replace, as on cold restore with a saved query.
    expect(useWorkspaceContentStore.getState().getFile(SESSION, file)?.content).toBe('after')
    expect(mocks.getWorkspaceTree).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(mocks.searchWorkspace).toHaveBeenCalledTimes(2)
      if (change !== 'delete') expect(screen.getByTestId(`workspace-tree-row-${next.path}`)).toBeInTheDocument()
      if (change !== 'create') expect(screen.queryByTestId(`workspace-tree-row-${old.path}`)).toBeNull()
    })
    expect(screen.getByRole('searchbox')).toHaveValue('zz-last')
  })

  it.each(['create', 'rename', 'delete'] as const)('refreshes an unchanged filter after a watched %s in a large loaded directory', async change => {
    let entries = [
      ...Array.from({ length: 300 }, (_, index) => ({ name: `${index}.txt`, path: `large/${index}.txt`, isDirectory: false })),
      { name: 'zz-last.txt', path: 'large/zz-last.txt', isDirectory: false },
    ]
    mocks.getWorkspaceTree.mockImplementation(async (_session, path) => ({
      state: 'ok', path, entries: path === 'large' ? [...entries] : [{ name: 'large', path: 'large', isDirectory: true }],
    }))
    mocks.searchWorkspace.mockImplementation(async (_session, query) => ({ state: 'ok', query, truncated: false, entries: entries.filter(entry => entry.path.includes(query)) }))
    await renderPane()
    fireEvent.click(screen.getByTestId('workspace-tree-row-large'))
    await screen.findByTestId('workspace-tree-row-large/zz-last.txt')
    const input = screen.getByRole('searchbox')
    act(() => input.focus())
    fireEvent.change(input, { target: { value: 'zz-last' } })
    await waitFor(() => expect(mocks.searchWorkspace).toHaveBeenCalledTimes(1))
    const old = 'large/zz-last.txt'
    const next = 'large/zz-last-new.txt'
    if (change !== 'create') entries = entries.filter(entry => entry.path !== old)
    if (change !== 'delete') entries.push({ name: 'zz-last-new.txt', path: next, isDirectory: false })
    await act(async () => {
      await useWorkspaceContentStore.getState().refreshWatchedPaths(SESSION, change === 'create' ? [next] : [old, next], ['large'], new AbortController().signal)
    })
    await waitFor(() => {
      if (change !== 'delete') expect(screen.getByTestId(`workspace-tree-row-${next}`)).toBeInTheDocument()
      if (change !== 'create') expect(screen.queryByTestId(`workspace-tree-row-${old}`)).toBeNull()
      expect(mocks.searchWorkspace).toHaveBeenCalledTimes(2)
    })
    expect(input).toHaveValue('zz-last')
    expect(input).toHaveFocus()
    expect(mocks.searchWorkspace).toHaveBeenLastCalledWith(SESSION, 'zz-last', expect.any(AbortSignal))
  })

  it('coalesces watched refreshes without searching on idle, other tasks, preview updates or an empty filter', async () => {
    mocks.getWorkspaceTree.mockImplementation(async (_session, path) => ({ ...(path === 'src' ? SRC : ROOT) }))
    const view = await renderPane()
    await act(async () => { await useWorkspaceContentStore.getState().loadTree(SESSION, 'src') })
    vi.useFakeTimers()
    try {
      const input = screen.getByRole('searchbox')
      fireEvent.change(input, { target: { value: 'adapters' } })
      await act(() => vi.advanceTimersByTimeAsync(120))
      expect(mocks.searchWorkspace).toHaveBeenCalledTimes(1)
      const signal = new AbortController().signal
      await act(async () => {
        await useWorkspaceContentStore.getState().refreshWatchedPaths('other-task', [], [''], signal)
        await useWorkspaceContentStore.getState().loadTree('other-task', 'src')
        useWorkspaceContentStore.setState(state => ({
          treeByKey: { ...state.treeByKey },
          filesByKey: { ...state.filesByKey, [`${SESSION}::preview.ts`]: { path: 'preview.ts', state: 'ok', content: 'after' } },
        }))
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(mocks.searchWorkspace).toHaveBeenCalledTimes(1)
      await act(async () => {
        for (let index = 0; index < 3; index++) {
          await useWorkspaceContentStore.getState().refreshWatchedPaths(SESSION, ['src/adapters.ts'], ['src'], signal)
        }
      })
      await act(() => vi.advanceTimersByTimeAsync(119))
      expect(mocks.searchWorkspace).toHaveBeenCalledTimes(1)
      await act(() => vi.advanceTimersByTimeAsync(1))
      expect(mocks.searchWorkspace).toHaveBeenCalledTimes(2)
      fireEvent.change(input, { target: { value: '' } })
      await act(async () => {
        await useWorkspaceContentStore.getState().refreshWatchedPaths(SESSION, [], ['src'], signal)
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(mocks.searchWorkspace).toHaveBeenCalledTimes(2)
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  it('aborts an in-flight unchanged-query search after a watch refresh and ignores its late result', async () => {
    let resolveOld!: (result: unknown) => void
    mocks.searchWorkspace.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    mocks.searchWorkspace.mockImplementationOnce(async (_task, query) => ({
      state: 'ok', query, truncated: false,
      entries: [{ name: 'adapters-new.ts', path: 'src/adapters-new.ts', isDirectory: false }],
    }))
    const view = await renderPane()
    await act(async () => { await useWorkspaceContentStore.getState().loadTree(SESSION, 'src') })
    vi.useFakeTimers()
    try {
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'adapters' } })
      await act(() => vi.advanceTimersByTimeAsync(120))
      expect(mocks.searchWorkspace).toHaveBeenCalledTimes(1)
      const oldSignal = mocks.searchWorkspace.mock.calls[0]![2] as AbortSignal
      mocks.getWorkspaceTree.mockResolvedValueOnce({ ...SRC, entries: [{ name: 'adapters-new.ts', path: 'src/adapters-new.ts', isDirectory: false }] })
      await act(async () => {
        await useWorkspaceContentStore.getState().refreshWatchedPaths(SESSION, ['src/adapters-new.ts'], ['src'], new AbortController().signal)
      })
      expect(oldSignal.aborted).toBe(true)
      await act(() => vi.advanceTimersByTimeAsync(120))
      expect(mocks.searchWorkspace).toHaveBeenCalledTimes(2)
      expect(screen.getByTestId('workspace-tree-row-src/adapters-new.ts')).toBeInTheDocument()
      await act(async () => resolveOld({
        state: 'ok', query: 'adapters', truncated: false,
        entries: [{ name: 'adapters-stale.ts', path: 'src/adapters-stale.ts', isDirectory: false }],
      }))
      expect(screen.queryByTestId('workspace-tree-row-src/adapters-stale.ts')).toBeNull()
      expect(screen.getByTestId('workspace-tree-row-src/adapters-new.ts')).toBeInTheDocument()
      const currentSignal = mocks.searchWorkspace.mock.calls[1]![2] as AbortSignal
      view.unmount()
      expect(currentSignal.aborted).toBe(true)
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  it('groups interleaved search hits under their real parent for display and keyboard navigation', async () => {
    mocks.searchWorkspace.mockImplementationOnce(async (_session: string, query: string) => ({
      state: 'ok', query, truncated: false,
      entries: ['src/a.ts', 'test/b.ts', 'src/c.ts'].map((path) => ({
        path, name: path.split('/').at(-1), isDirectory: false,
      })),
    }))
    await renderPane()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'files' } })
    await screen.findByTestId('workspace-tree-row-src/c.ts')
    expect(screen.getAllByRole('treeitem').map((row) => row.getAttribute('data-testid'))).toEqual([
      'workspace-tree-row-src',
      'workspace-tree-row-src/a.ts',
      'workspace-tree-row-src/c.ts',
      'workspace-tree-row-test',
      'workspace-tree-row-test/b.ts',
    ])
    const file = screen.getByTestId('workspace-tree-row-src/c.ts')
    act(() => file.focus())
    fireEvent.keyDown(file, { key: 'ArrowLeft' })
    expect(screen.getByTestId('workspace-tree-row-src')).toHaveFocus()
  })

  it('finds a nested file without opening its nonmatching parent first', async () => {
    await renderPane()
    await act(async () => {
      fireEvent.change(screen.getByTestId('workspace-file-tree-filter'), {
        target: { value: 'adapters' },
      })
      await new Promise((resolve) => setTimeout(resolve, 250))
    })
    expect(screen.getByTestId('workspace-tree-row-src/adapters.ts')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-tree-row-src')).toBeInTheDocument()
    expect(mocks.getWorkspaceTree).toHaveBeenCalledTimes(1)
  })
  it('always browses project files even when an old in-memory tree selected changed files', async () => {
    useWorkspaceContentStore.getState().setTreeView(SESSION, { mode: 'changed' })
    await renderPane()
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    expect(screen.getByTestId('workspace-tree-row-README.md')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'adapters' } })
    expect(await screen.findByTestId('workspace-tree-row-src/adapters.ts')).toBeInTheDocument()
    expect(mocks.searchWorkspace).toHaveBeenCalledWith(SESSION, 'adapters', expect.any(AbortSignal))
  })

  it('reveals an externally opened nested file without moving keyboard focus or reopening a user-collapsed parent', async () => {
    const view = await renderPane()
    const input = screen.getByRole('searchbox')
    act(() => input.focus())
    view.rerender(<WorkspaceFileTreePane sessionId={SESSION} selectedPath="src/adapters.ts" onOpen={vi.fn()} />)
    const file = await screen.findByTestId('workspace-tree-row-src/adapters.ts')
    expect(mocks.getWorkspaceTree).toHaveBeenCalledWith(SESSION, 'src', undefined)
    expect(screen.getByTestId('workspace-tree-row-src')).toHaveAttribute('aria-expanded', 'true')
    expect(file).toHaveAttribute('aria-selected', 'true')
    expect(file).toHaveAttribute('tabindex', '0')
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
    expect(scrollIntoView.mock.instances.at(-1)).toBe(file)
    expect(input).toHaveFocus()

    scrollIntoView.mockClear()
    fireEvent.click(screen.getByTestId('workspace-tree-row-src'))
    expect(screen.queryByTestId('workspace-tree-row-src/adapters.ts')).toBeNull()
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('uses the server-relative identity to reveal a file opened by an absolute chat path', async () => {
    useWorkspaceContentStore.setState({ filesByKey: {
      [`${SESSION}::/repo/src/client.ts`]: { path: '/repo/src/client.ts', watchPath: 'src/client.ts', state: 'ok', content: '' },
    } })
    render(<WorkspaceFileTreePane sessionId={SESSION} selectedPath="/repo/src/client.ts" onOpen={vi.fn()} />)
    expect(await screen.findByTestId('workspace-tree-row-src/client.ts')).toHaveAttribute('aria-selected', 'true')
    expect(mocks.getWorkspaceTree).not.toHaveBeenCalledWith(SESSION, '/repo', undefined)
  })

  it('reveals an already-loaded new selection only once as unrelated tree data refreshes', async () => {
    const view = await renderPane()
    const directory = screen.getByTestId('workspace-tree-row-src')
    act(() => directory.focus())
    view.rerender(<WorkspaceFileTreePane sessionId={SESSION} selectedPath="README.md" onOpen={vi.fn()} />)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('workspace-tree-row-README.md')).toHaveAttribute('tabindex', '0')
    expect(directory).toHaveFocus()
    act(() => useWorkspaceContentStore.setState((state) => ({ treeByKey: { ...state.treeByKey } })))
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('waits until the tree is reopened to reveal a file selected while it was hidden', async () => {
    useWorkspaceContentStore.getState().setTreeView(SESSION, { open: false })
    render(<WorkspaceFileTreePane sessionId={SESSION} selectedPath="src/adapters.ts" onOpen={vi.fn()} />)
    await screen.findByTestId('workspace-tree-row-src/adapters.ts')
    expect(scrollIntoView).not.toHaveBeenCalled()
    act(() => useWorkspaceContentStore.getState().setTreeView(SESSION, { open: true }))
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('reveals the active file again after clearing a search without opening a different file', async () => {
    render(<WorkspaceFileTreePane sessionId={SESSION} selectedPath="src/adapters.ts" onOpen={vi.fn()} />)
    await screen.findByTestId('workspace-tree-row-src/adapters.ts')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'client' } })
    await screen.findByTestId('workspace-tree-row-src/client.ts')
    scrollIntoView.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Clear file filter' }))
    expect(await screen.findByTestId('workspace-tree-row-src/adapters.ts')).toHaveAttribute('aria-selected', 'true')
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it.each(['error', 'missing'] as const)('reports a %s root instead of an empty project and can retry the cached failure', async (state) => {
    mocks.getWorkspaceTree.mockResolvedValueOnce({ state, path: '', entries: [], error: state === 'error' ? 'EACCES fixture directory' : undefined })
    await renderPane()
    expect(screen.getByRole('alert')).toHaveTextContent(state === 'error' ? 'EACCES fixture directory' : 'Directory not found')
    expect(screen.queryByText('No files')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry: Project root' }))
    expect(await screen.findByTestId('workspace-tree-row-README.md')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(mocks.getWorkspaceTree).toHaveBeenCalledTimes(2)
  })

  it('retries a failed selected ancestor without dropping other project rows', async () => {
    let failed = false
    mocks.getWorkspaceTree.mockImplementation(async (_session, path) => {
      if (path !== 'src') return ROOT
      if (!failed) {
        failed = true
        return { state: 'error', path: 'src', entries: [], error: 'EACCES src fixture' }
      }
      return SRC
    })
    render(<WorkspaceFileTreePane sessionId={SESSION} selectedPath="src/adapters.ts" onOpen={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('EACCES src fixture')
    expect(screen.getByTestId('workspace-tree-row-README.md')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry: src' }))
    expect(await screen.findByTestId('workspace-tree-row-src/adapters.ts')).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('distinguishes file types and carries hierarchy guides without adding them to the accessible row name', async () => {
    await renderPane()
    fireEvent.click(screen.getByTestId('workspace-tree-row-src'))
    const file = await screen.findByTestId('workspace-tree-row-src/adapters.ts')
    expect(file).toHaveAccessibleName('adapters.ts')
    expect(file).toHaveClass('h-7', 'text-[13px]')
    expect(file.querySelector('[data-file-type="ts"]')).not.toBeNull()
    expect(file.querySelector('[data-workspace-tree-guide]')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('workspace-tree-row-README.md').querySelector('[data-file-type="markdown"]')).not.toBeNull()
  })

  it('focuses search for quick open and hands ArrowDown to the results', async () => {
    render(<WorkspaceFileTreePane sessionId={SESSION} selectedPath={null} onOpen={vi.fn()} autoFocus />)
    await act(async () => { await Promise.resolve() })
    const input = screen.getByRole('searchbox')
    expect(input).toHaveFocus()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getByTestId('workspace-tree-row-src')).toHaveFocus()
    act(() => window.dispatchEvent(new CustomEvent('workspace-quick-open', { detail: { sessionId: SESSION } })))
    expect(input).toHaveFocus()
  })

  it('ignores a late search result after the query changes and aborts on unmount', async () => {
    let resolveOld!: (result: unknown) => void
    mocks.searchWorkspace.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
    const view = await renderPane()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'old' } })
    await waitFor(() => expect(mocks.searchWorkspace).toHaveBeenCalledTimes(1))
    const oldSignal = mocks.searchWorkspace.mock.calls[0]![2] as AbortSignal
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'client' } })
    await waitFor(() => expect(mocks.searchWorkspace).toHaveBeenCalledTimes(2))
    expect(oldSignal.aborted).toBe(true)
    await act(async () => resolveOld({ state: 'ok', query: 'old', entries: [{ name: 'old.ts', path: 'old.ts', isDirectory: false }] }))
    expect(screen.queryByTestId('workspace-tree-row-old.ts')).toBeNull()
    expect(screen.getByTestId('workspace-tree-row-src/client.ts')).toBeInTheDocument()
    const signal = mocks.searchWorkspace.mock.calls[1]![2] as AbortSignal
    view.unmount()
    expect(signal.aborted).toBe(true)
  })

  it('lists the workspace root on mount', async () => {
    await renderPane()
    expect(screen.getByTestId('workspace-tree-row-src')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-tree-row-README.md')).toBeInTheDocument()
  })

  it('expands a directory in place rather than replacing the view', async () => {
    await renderPane()

    await act(async () => {
      fireEvent.click(screen.getByTestId('workspace-tree-row-src'))
      await Promise.resolve()
    })

    expect(screen.getByTestId('workspace-tree-row-src')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('workspace-tree-row-src/adapters.ts')).toBeInTheDocument()
    // The root stays listed: the tree is a sibling of the content, not a mode.
    expect(screen.getByTestId('workspace-tree-row-README.md')).toBeInTheDocument()
  })

  it('opens on a single click, without waiting out a double-click window', async () => {
    const onOpen = vi.fn()
    render(<WorkspaceFileTreePane sessionId={SESSION} selectedPath={null} onOpen={onOpen} />)
    await act(async () => { await Promise.resolve() })

    fireEvent.click(screen.getByTestId('workspace-tree-row-README.md'))

    // Every click opens its own tab — a deferred preview that a second click
    // replaces made ten picks collapse into one slot.
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith('README.md')
  })

  it('marks the row the content area is showing', async () => {
    render(
      <WorkspaceFileTreePane sessionId={SESSION} selectedPath="README.md" onOpen={vi.fn()} />,
    )
    await act(async () => { await Promise.resolve() })
    expect(screen.getByTestId('workspace-tree-row-README.md')).toHaveAttribute('aria-selected', 'true')
  })

  it('keeps a directory whose children match the filter', async () => {
    await renderPane()

    await act(async () => {
      fireEvent.click(screen.getByTestId('workspace-tree-row-src'))
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.change(screen.getByTestId('workspace-file-tree-filter'), {
        target: { value: 'adapters' },
      })
      await Promise.resolve()
    })

    // Dropping the parent would make the match unreachable.
    expect(screen.getByTestId('workspace-tree-row-src')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-tree-row-src/adapters.ts')).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-tree-row-README.md')).toBeNull()
  })

  it('says so when the workspace has no files', async () => {
    mocks.getWorkspaceTree.mockResolvedValue({ state: 'ok', path: '', entries: [] })
    await renderPane()
    expect(screen.getByText('No files')).toBeInTheDocument()
  })
})

/**
 * Every row shipped with `tabIndex={-1}` and nothing ever set `0`, so the tree
 * was outside the tab order entirely: no key reached a row, and no key moved
 * between them. These cases drive real key events and assert on
 * `document.activeElement`, because a roving tabindex that never moves focus
 * looks correct in the markup and is unusable in the hand.
 */
/** `.focus()` runs the row's own onFocus, which is a state update. */
function focusRow(node: HTMLElement) {
  act(() => { node.focus() })
}

describe('keyboard', () => {
  it('keeps exactly one row in the tab order and moves it with Up/Down', async () => {
    await renderPane()
    const src = screen.getByTestId('workspace-tree-row-src')
    const readme = screen.getByTestId('workspace-tree-row-README.md')

    expect(src).toHaveAttribute('tabindex', '0')
    expect(readme).toHaveAttribute('tabindex', '-1')

    focusRow(src)
    fireEvent.keyDown(src, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(readme)
    expect(readme).toHaveAttribute('tabindex', '0')
    expect(src).toHaveAttribute('tabindex', '-1')

    fireEvent.keyDown(readme, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(src)
  })

  it('expands, descends, ascends and collapses with the left and right arrows', async () => {
    await renderPane()
    const src = screen.getByTestId('workspace-tree-row-src')
    focusRow(src)

    await act(async () => {
      fireEvent.keyDown(src, { key: 'ArrowRight' })
      await Promise.resolve()
    })
    expect(src).toHaveAttribute('aria-expanded', 'true')

    // Right on an already-open directory descends to its first child.
    fireEvent.keyDown(src, { key: 'ArrowRight' })
    const child = screen.getByTestId('workspace-tree-row-src/adapters.ts')
    expect(document.activeElement).toBe(child)

    // Left from a leaf goes up to the parent rather than nowhere.
    fireEvent.keyDown(child, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(src)

    await act(async () => {
      fireEvent.keyDown(src, { key: 'ArrowLeft' })
      await Promise.resolve()
    })
    expect(src).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('workspace-tree-row-src/adapters.ts')).toBeNull()
  })

  it('jumps to the first and last row with Home and End', async () => {
    await renderPane()
    const src = screen.getByTestId('workspace-tree-row-src')
    const readme = screen.getByTestId('workspace-tree-row-README.md')

    focusRow(src)
    fireEvent.keyDown(src, { key: 'End' })
    expect(document.activeElement).toBe(readme)

    fireEvent.keyDown(readme, { key: 'Home' })
    expect(document.activeElement).toBe(src)
  })

  it('opens the focused file with Enter and with Space', async () => {
    const onOpen = vi.fn()
    render(<WorkspaceFileTreePane sessionId={SESSION} selectedPath={null} onOpen={onOpen} />)
    await act(async () => { await Promise.resolve() })

    const readme = screen.getByTestId('workspace-tree-row-README.md')
    focusRow(readme)
    fireEvent.keyDown(readme, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith('README.md')

    onOpen.mockClear()
    fireEvent.keyDown(readme, { key: ' ' })
    expect(onOpen).toHaveBeenCalledWith('README.md')
  })

  it('gives the tab stop to the row the content area is showing', async () => {
    render(
      <WorkspaceFileTreePane sessionId={SESSION} selectedPath="README.md" onOpen={vi.fn()} />,
    )
    await act(async () => { await Promise.resolve() })

    // Landing on the first row would drop a keyboard user somewhere unrelated
    // to what is on screen.
    expect(screen.getByTestId('workspace-tree-row-README.md')).toHaveAttribute('tabindex', '0')
    expect(screen.getByTestId('workspace-tree-row-src')).toHaveAttribute('tabindex', '-1')
  })

  it('states each row depth, which padding alone never reaches', async () => {
    await renderPane()
    const src = screen.getByTestId('workspace-tree-row-src')
    expect(src).toHaveAttribute('aria-level', '1')

    await act(async () => {
      fireEvent.click(src)
      await Promise.resolve()
    })
    expect(screen.getByTestId('workspace-tree-row-src/adapters.ts')).toHaveAttribute('aria-level', '2')
  })
})

describe('filter field', () => {
  it('uses the compact 28px filter field with 12px type', async () => {
    await renderPane()
    expect(screen.getByRole('searchbox')).toHaveClass('h-7', 'text-xs')
  })

  it('offers the clear button the hand-rolled input never had', async () => {
    await renderPane()

    await act(async () => {
      fireEvent.change(screen.getByTestId('workspace-file-tree-filter'), {
        target: { value: 'adapters' },
      })
      await Promise.resolve()
    })
    expect(screen.getByTestId('workspace-file-tree-filter')).toHaveValue('adapters')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear file filter' }))
      await Promise.resolve()
    })
    expect(screen.getByTestId('workspace-file-tree-filter')).toHaveValue('')
  })
})

// #1322: a whole file must be attachable without opening it and selecting lines.
describe('file chat references', () => {
  beforeEach(() => useWorkspaceChatContextStore.setState({ referencesBySession: {} }))

  it('adds a right-clicked file to its own session without opening it', async () => {
    const { onOpen } = await renderPane()
    fireEvent.contextMenu(screen.getByTestId('workspace-tree-row-README.md'), { clientX: 30, clientY: 40 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to chat' }))
    expect(useWorkspaceChatContextStore.getState().referencesBySession[SESSION]).toEqual([
      expect.objectContaining({ kind: 'file', path: 'README.md', name: 'README.md' }),
    ])
    expect(onOpen).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('supports keyboard invocation and dismisses without adding', async () => {
    await renderPane()
    const file = screen.getByTestId('workspace-tree-row-README.md')
    fireEvent.keyDown(file, { key: 'F10', shiftKey: true })
    expect(screen.getByRole('menuitem', { name: 'Add to chat' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Add to chat' }), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(useWorkspaceChatContextStore.getState().referencesBySession[SESSION]).toBeUndefined()
  })

  it('closes an old session menu when switching sessions', async () => {
    const view = await renderPane()
    fireEvent.contextMenu(screen.getByTestId('workspace-tree-row-README.md'))
    expect(screen.getByRole('menuitem', { name: 'Add to chat' })).toBeInTheDocument()
    await act(async () => {
      view.rerender(<WorkspaceFileTreePane sessionId="session-b" selectedPath={null} onOpen={vi.fn()} />)
      await Promise.resolve()
    })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(useWorkspaceChatContextStore.getState().referencesBySession).toEqual({})
  })
})

// #1361: the unified tree dropped the existing native-open and copy actions.
describe('file tree open actions', () => {
  it.each([
    ['README.md', false], ['src', true],
  ])('opens and copies the exact absolute path for %s without previewing it', async (path, isDirectory) => {
    mocks.openTarget.mockClear()
    mocks.copyText.mockClear()
    useWorkspaceContentStore.setState({ statusBySession: { [SESSION]: { state: 'ok', workDir: 'C:\\repo', repoName: 'repo', branch: 'main', isGitRepo: true, changedFiles: [] } } })
    const { onOpen } = await renderPane()
    const openMenu = async () => {
      fireEvent.contextMenu(screen.getByTestId(`workspace-tree-row-${path}`))
      await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Default application' })).toBeInTheDocument())
    }
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Default application' }))
    expect(mocks.openTarget).toHaveBeenLastCalledWith('system-default', `C:\\repo/${path}`)
    expect(screen.queryByRole('menu')).toBeNull()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open containing folder' }))
    expect(mocks.openTarget).toHaveBeenLastCalledWith('explorer', `C:\\repo/${path}`)
    await openMenu()
    if (isDirectory) expect(screen.queryByRole('menuitem', { name: 'Copy file contents' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy path' }))
    expect(mocks.copyText).toHaveBeenLastCalledWith(`C:\\repo/${path}`)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('routes a tree context-menu preview through the pane activation callback', async () => {
    const { onOpen } = await renderPane()
    fireEvent.contextMenu(screen.getByTestId('workspace-tree-row-README.md'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Workspace preview' }))
    expect(onOpen).toHaveBeenCalledWith('README.md')
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
