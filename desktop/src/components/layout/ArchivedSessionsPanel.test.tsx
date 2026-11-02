import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { useTabStore } from '@/stores/tabStore'
import type { SessionListItem } from '@/types/session'
import { ArchivedSessionsPanel } from './ArchivedSessionsPanel'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  history: vi.fn(),
  setSessionArchived: vi.fn(),
  openHistoricalSession: vi.fn(),
  connectToSession: vi.fn(),
  projectArchivedTotals: {} as Record<string, number>,
}))

vi.mock('@/api/sessions', () => ({
  sessionsApi: { list: mocks.list, listProjectHistory: mocks.history },
}))
vi.mock('@/stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (state: typeof mocks) => unknown) => selector(mocks),
    { getState: () => mocks },
  ),
}))
vi.mock('@/stores/chatStore', () => ({ useChatStore: { getState: () => mocks } }))
vi.mock('@/i18n', async () => {
  const { en } = await import('@/i18n/locales/en')
  const translate = (key: keyof typeof en, params?: Record<string, string | number>) => {
    let value: string = en[key] ?? key
    for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
    return value
  }
  return { useTranslation: () => translate }
})

function session(id: string, projectRoot = '/work/project'): SessionListItem {
  return {
    id, title: `Session ${id}`, projectRoot, projectPath: projectRoot, workDir: projectRoot,
    createdAt: '2026-10-01T00:00:00.000Z', modifiedAt: '2026-10-02T00:00:00.000Z',
    messageCount: 3, workDirExists: true, archived: true,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const row = (title: string) => screen.getByText(title).closest('button') as HTMLButtonElement

beforeEach(() => {
  for (const mock of [mocks.list, mocks.history, mocks.setSessionArchived, mocks.openHistoricalSession, mocks.connectToSession]) mock.mockReset()
  mocks.projectArchivedTotals = {}
  mocks.setSessionArchived.mockResolvedValue(undefined)
  useTabStore.setState({ activeTabId: null })
})
afterEach(cleanup)


describe('ArchivedSessionsPanel', () => {
  it('opens an archived transcript without restoring it and keeps the list in place', async () => {
    const archived = session('a')
    mocks.history.mockResolvedValue({ sessions: [archived, session('b')], nextCursor: null })
    const onBack = vi.fn()
    const { rerender } = render(<ArchivedSessionsPanel projectRoot="/work/project" onBack={onBack} />)

    fireEvent.click(await screen.findByText('Session a'))

    expect(mocks.history).toHaveBeenCalledWith(
      { projectRoot: '/work/project', archived: true, limit: 50 },
      { signal: expect.any(AbortSignal) },
    )
    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.openHistoricalSession).toHaveBeenCalledWith(archived)
    expect(mocks.connectToSession).toHaveBeenCalledWith('a')
    expect(mocks.setSessionArchived).not.toHaveBeenCalled()
    expect(onBack).not.toHaveBeenCalled()

    // The opened session reads as the current row, and the next one is still a click away.
    act(() => useTabStore.setState({ activeTabId: 'a' }))
    rerender(<ArchivedSessionsPanel projectRoot="/work/project" onBack={onBack} />)
    expect(row('Session a').className).toContain('font-medium')
    expect(row('Session b').className).not.toContain('font-medium')
    fireEvent.click(row('Session b'))
    expect(mocks.connectToSession).toHaveBeenLastCalledWith('b')
  })

  it('names one project in the title and lists its rows without repeating the path', async () => {
    mocks.projectArchivedTotals = { '/work/project': 2 }
    mocks.history.mockResolvedValue({ sessions: [session('a'), session('b')], nextCursor: null })
    const onBack = vi.fn()
    render(<ArchivedSessionsPanel projectRoot="/work/project" onBack={onBack} />)

    await screen.findByText('Session a')
    const view = screen.getByTestId('sidebar-archive-view')
    expect(within(view).getByText('Archived in project')).toBeInTheDocument()
    expect(within(view).getByText('2')).toBeInTheDocument()
    expect(view).not.toHaveTextContent('/work/project')
    expect(within(view).queryAllByRole('region')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Back to sessions' }))
    expect(onBack).toHaveBeenCalledOnce()
  })

  it('groups every project archive under its project, in server order', async () => {
    mocks.list.mockResolvedValue({
      sessions: [session('a', '/work/alpha'), session('b', '/work/beta'), session('c', '/work/alpha')],
      total: 3,
    })
    render(<ArchivedSessionsPanel onBack={vi.fn()} />)

    await screen.findByText('Session a')
    expect(screen.getByText('Archived sessions')).toBeInTheDocument()
    const groups = screen.getAllByRole('region')
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['alpha', 'beta'])
    expect(within(groups[0]!).getAllByRole('button', { name: /^Session/ }).map((button) => button.title)).toEqual(['Session a', 'Session c'])
    expect(within(groups[1]!).getByText('Session b')).toBeInTheDocument()
  })

  it('restores from the row context menu', async () => {
    mocks.history
      .mockResolvedValueOnce({ sessions: [session('a')], nextCursor: null })
      .mockResolvedValueOnce({ sessions: [], nextCursor: null })
    render(<ArchivedSessionsPanel projectRoot="/work/project" onBack={vi.fn()} />)

    fireEvent.contextMenu(await screen.findByText('Session a'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Restore' }))

    await waitFor(() => expect(mocks.setSessionArchived).toHaveBeenCalledWith('a', false))
    expect(await screen.findByText('No archived sessions')).toBeInTheDocument()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(mocks.openHistoricalSession).not.toHaveBeenCalled()
  })

  it('restarts offset pagination after restoring a row, so the next archived session is not skipped', async () => {
    mocks.list
      .mockResolvedValueOnce({ sessions: [session('a'), session('b')], total: 3 })
      .mockResolvedValueOnce({ sessions: [session('b')], total: 2 })
      .mockResolvedValueOnce({ sessions: [session('c', '/work/other')], total: 2 })
    render(<ArchivedSessionsPanel onBack={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Restore session: Session a' }))
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2))
    expect(mocks.setSessionArchived).toHaveBeenCalledWith('a', false)
    await waitFor(() => expect(screen.queryByText('Session a')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await screen.findByText('Session c')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'other' })).toBeInTheDocument()
    expect(mocks.list.mock.calls.map(([params]) => params.offset)).toEqual([0, 0, 1])
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  })

  it('keeps a session visible after a failed restore and allows retry', async () => {
    mocks.history.mockResolvedValue({ sessions: [session('a')], nextCursor: null })
    mocks.setSessionArchived.mockRejectedValueOnce(new Error('offline'))
    render(<ArchivedSessionsPanel projectRoot="/work/project" onBack={vi.fn()} />)
    const restore = await screen.findByRole('button', { name: 'Restore session: Session a' })
    fireEvent.click(restore)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not restore the session.')
    expect(screen.getByText('Session a')).toBeInTheDocument()
    expect(restore).toBeEnabled()

    mocks.history.mockResolvedValue({ sessions: [], nextCursor: null })
    fireEvent.click(restore)
    expect(await screen.findByText('No archived sessions')).toBeInTheDocument()
    expect(mocks.setSessionArchived).toHaveBeenCalledTimes(2)
  })

  it('shows load failures with a retry and then the empty state', async () => {
    mocks.list.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ sessions: [], total: 0 })
    render(<ArchivedSessionsPanel onBack={vi.fn()} />)
    const error = await screen.findByRole('alert')
    expect(error).toHaveTextContent('Could not load archived sessions.')
    fireEvent.click(within(error).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('No archived sessions')).toBeInTheDocument()
  })

  it('discards and aborts the previous project response when the project changes', async () => {
    const oldPage = deferred<{ sessions: SessionListItem[]; nextCursor: null }>()
    mocks.history.mockReturnValueOnce(oldPage.promise).mockResolvedValueOnce({ sessions: [session('new', '/work/new')], nextCursor: null })
    const { rerender } = render(<ArchivedSessionsPanel projectRoot="/work/old" onBack={vi.fn()} />)
    const oldSignal = mocks.history.mock.calls[0]![1].signal as AbortSignal
    rerender(<ArchivedSessionsPanel projectRoot="/work/new" onBack={vi.fn()} />)
    expect(await screen.findByText('Session new')).toBeInTheDocument()
    await act(async () => oldPage.resolve({ sessions: [session('old', '/work/old')], nextCursor: null }))
    expect(screen.queryByText('Session old')).not.toBeInTheDocument()
    expect(oldSignal.aborted).toBe(true)
  })

  it('restarts once when a project history cursor expires', async () => {
    mocks.history
      .mockResolvedValueOnce({ sessions: [session('a')], nextCursor: 'cursor-a' })
      .mockRejectedValueOnce(new ApiError(409, { message: 'Cursor expired', code: 'PROJECT_HISTORY_CURSOR_EXPIRED' }))
      .mockResolvedValueOnce({ sessions: [session('b')], nextCursor: null })
    render(<ArchivedSessionsPanel projectRoot="/work/project" onBack={vi.fn()} />)
    await screen.findByText('Session a')
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await screen.findByText('Session b')).toBeInTheDocument()
    expect(mocks.history.mock.calls[1]![0].cursor).toBe('cursor-a')
    expect(mocks.history.mock.calls[2]![0].cursor).toBeUndefined()
    expect(screen.queryByText('Session a')).not.toBeInTheDocument()
  })

  it('retains loaded rows when the next page fails and retries that page', async () => {
    mocks.history
      .mockResolvedValueOnce({ sessions: [session('a')], nextCursor: 'next-page' })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ sessions: [session('b')], nextCursor: null })
    render(<ArchivedSessionsPanel projectRoot="/work/project" onBack={vi.fn()} />)
    await screen.findByText('Session a')
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    const alert = await screen.findByRole('alert')
    expect(screen.getByText('Session a')).toBeInTheDocument()
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Session b')).toBeInTheDocument()
    expect(screen.getByText('Session a')).toBeInTheDocument()
    expect(mocks.history.mock.calls[2]![0].cursor).toBe('next-page')
  })

  it('keeps the restored row removed if refresh fails and retries from the beginning', async () => {
    mocks.list
      .mockResolvedValueOnce({ sessions: [session('a'), session('b')], total: 3 })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ sessions: [session('b'), session('c')], total: 2 })
    render(<ArchivedSessionsPanel onBack={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Restore session: Session a' }))
    const alert = await screen.findByRole('alert')
    expect(screen.queryByText('Session a')).not.toBeInTheDocument()
    expect(screen.getByText('Session b')).toBeInTheDocument()
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Session c')).toBeInTheDocument()
    expect(mocks.list.mock.calls.map(([params]) => params.offset)).toEqual([0, 0, 0])
  })

  it('does not let a restore finishing in the previous project refresh the new project', async () => {
    const restored = deferred<void>()
    mocks.history
      .mockResolvedValueOnce({ sessions: [session('old', '/work/old')], nextCursor: null })
      .mockResolvedValueOnce({ sessions: [session('new', '/work/new')], nextCursor: null })
    mocks.setSessionArchived.mockReturnValueOnce(restored.promise)
    const { rerender } = render(<ArchivedSessionsPanel projectRoot="/work/old" onBack={vi.fn()} />)
    const restore = await screen.findByRole('button', { name: 'Restore session: Session old' })
    fireEvent.click(restore)
    expect(restore).toBeDisabled()
    rerender(<ArchivedSessionsPanel projectRoot="/work/new" onBack={vi.fn()} />)
    await screen.findByText('Session new')
    await act(async () => restored.resolve())
    expect(screen.getByText('Session new')).toBeInTheDocument()
    expect(mocks.history).toHaveBeenCalledTimes(2)
  })
})
