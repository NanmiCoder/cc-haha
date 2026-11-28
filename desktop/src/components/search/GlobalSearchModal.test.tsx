import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

import { GlobalSearchModal } from './GlobalSearchModal'
import { useSessionStore } from '../../stores/sessionStore'
import { useTabStore } from '../../stores/tabStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import {
  captureProjectDisplayNameHydrationRevision,
  hydrateProjectDisplayNames,
} from '../../stores/projectDisplayNameStore'
import { searchApi } from '../../api/search'
import { sessionsApi } from '../../api/sessions'
import { useSessionRuntimeStore } from '../../stores/sessionRuntimeStore'
import type { SessionListItem } from '../../types/session'
import type { SessionSearchResult } from '../../api/search'

vi.mock('../../api/search', () => ({
  searchApi: { searchSessions: vi.fn() },
}))
vi.mock('../../api/sessions', () => ({
  sessionsApi: { getSummary: vi.fn() },
}))

const mockSearch = vi.mocked(searchApi.searchSessions)

// jsdom does not implement scrollIntoView (used to keep the active row in view).
Element.prototype.scrollIntoView = vi.fn()

function makeSession(
  id: string,
  title: string,
  overrides?: Partial<SessionListItem>,
): SessionListItem {
  return {
    id,
    title,
    createdAt: '2026-06-01T00:00:00.000Z',
    modifiedAt: '2026-06-01T00:00:00.000Z',
    messageCount: 2,
    projectPath: 'proj',
    projectRoot: '/home/u/proj',
    workDir: '/home/u/proj',
    workDirExists: true,
    ...overrides,
  }
}

function makeResult(sessionId: string, title: string, overrides?: Partial<SessionSearchResult>): SessionSearchResult {
  return {
    sessionId,
    title,
    projectPath: 'proj',
    workDir: '/home/u/proj',
    modifiedAt: new Date().toISOString(),
    matchCount: 1,
    matches: [
      { role: 'user', messageId: 'u1', lineNumber: 1, snippet: `${title} body`, highlights: [] },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
  useSessionStore.setState({
    sessions: [],
    projectSessionTotals: {},
    projectArchivedTotals: {},
  })
  hydrateProjectDisplayNames({}, captureProjectDisplayNameHydrationRevision())
  useSessionRuntimeStore.setState({ selections: {} })
  vi.mocked(sessionsApi.getSummary).mockReset().mockRejectedValue(new Error('Summary unavailable'))
  useTabStore.setState({ openTab: vi.fn(), setActiveTab: vi.fn() } as Partial<ReturnType<typeof useTabStore.getState>>)
  mockSearch.mockResolvedValue({ results: [], total: 0, truncated: false })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('GlobalSearchModal', () => {
  it('renders nothing when closed', () => {
    render(<GlobalSearchModal open={false} onClose={() => {}} />)
    expect(screen.queryByPlaceholderText(/search projects and chats/i)).toBeNull()
  })

  it('renders the input and focuses it when open', async () => {
    render(<GlobalSearchModal open onClose={() => {}} />)
    const input = screen.getByPlaceholderText(/search projects and chats/i)
    await waitFor(() => expect(input).toHaveFocus())
  })

  it('shows recent sessions from the store when the query is empty', () => {
    useSessionStore.setState({ sessions: [makeSession('s1', 'Recent One'), makeSession('s2', 'Recent Two')] })
    render(<GlobalSearchModal open onClose={() => {}} />)

    expect(screen.getByText('Recent chats')).toBeInTheDocument()
    expect(screen.getByText('Recent One')).toBeInTheDocument()
    expect(screen.getByText('Recent Two')).toBeInTheDocument()
    expect(mockSearch).not.toHaveBeenCalled()
  })

  it('debounces input and calls searchApi once with the latest query', async () => {
    vi.useFakeTimers()
    try {
      render(<GlobalSearchModal open onClose={() => {}} />)
      const input = screen.getByPlaceholderText(/search projects and chats/i)
      fireEvent.change(input, { target: { value: 'a' } })
      fireEvent.change(input, { target: { value: 'ab' } })
      fireEvent.change(input, { target: { value: 'abc' } })
      expect(mockSearch).not.toHaveBeenCalled()

      await act(async () => {
        vi.advanceTimersByTime(300)
        await Promise.resolve()
      })

      expect(mockSearch).toHaveBeenCalledTimes(1)
      expect(mockSearch).toHaveBeenCalledWith(
        'abc',
        expect.objectContaining({
          limit: expect.any(Number),
          matchesPerSession: 3,
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders results with real title, match count and role badges', async () => {
    mockSearch.mockResolvedValue({
      results: [
        makeResult('s1', 'My Session', {
          matchCount: 3,
          matches: [
            { role: 'user', messageId: 'u1', lineNumber: 1, snippet: 'hello WORLD foo', highlights: [{ start: 6, end: 11 }] },
            { role: 'assistant', messageId: 'a1', lineNumber: 2, snippet: 'assistant reply here', highlights: [] },
          ],
        }),
      ],
      total: 1,
      truncated: false,
    })

    render(<GlobalSearchModal open onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText(/search projects and chats/i), { target: { value: 'world' } })

    await screen.findByText('My Session')
    expect(screen.getByText('3 matches')).toBeInTheDocument()
    expect(screen.getByText('You')).toBeInTheDocument()
    expect(screen.getByText('Assistant')).toBeInTheDocument()

    const mark = screen.getByText('WORLD')
    expect(mark.tagName).toBe('MARK')
  })

  it('opens the active result on Enter and closes the modal', async () => {
    const openTab = vi.fn()
    useTabStore.setState({ openTab } as Partial<ReturnType<typeof useTabStore.getState>>)
    const onClose = vi.fn()
    mockSearch.mockResolvedValue({
      results: [makeResult('s1', 'Session One'), makeResult('s2', 'Session Two')],
      total: 2,
      truncated: false,
    })

    render(<GlobalSearchModal open onClose={onClose} />)
    const input = screen.getByPlaceholderText(/search projects and chats/i)
    fireEvent.change(input, { target: { value: 'x' } })
    await screen.findByText('Session One')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(openTab).toHaveBeenCalledWith('s2', 'Session Two'))
    expect(onClose).toHaveBeenCalled()
  })

  it('opens a result on click', async () => {
    const openTab = vi.fn()
    useTabStore.setState({ openTab } as Partial<ReturnType<typeof useTabStore.getState>>)
    const onClose = vi.fn()
    mockSearch.mockResolvedValue({ results: [makeResult('s1', 'Clickable')], total: 1, truncated: false })

    render(<GlobalSearchModal open onClose={onClose} />)
    fireEvent.change(screen.getByPlaceholderText(/search projects and chats/i), { target: { value: 'x' } })
    fireEvent.click(await screen.findByText('Clickable'))

    await waitFor(() => expect(openTab).toHaveBeenCalledWith('s1', 'Clickable'))
    expect(onClose).toHaveBeenCalled()
  })

  it.each([false, true])('hydrates a search hit before opening without overriding a later confirmed runtime choice (%s)', async (switchRuntime) => {
    const summary = {
      ...makeSession('old-search-hit', 'Authoritative history title'),
      runtimeProviderId: 'history-provider',
      runtimeModelId: 'history-model',
      permissionMode: 'plan',
    }
    let resolveSummary!: (value: SessionListItem) => void
    const summaryPromise = new Promise<SessionListItem>((resolve) => { resolveSummary = resolve })
    vi.mocked(sessionsApi.getSummary).mockReturnValueOnce(summaryPromise)
    const onClose = vi.fn()
    let observedMetadata: unknown
    const openTab = vi.fn(() => {
      observedMetadata = {
        session: useSessionStore.getState().sessions.find((session) => session.id === summary.id),
        runtime: useSessionRuntimeStore.getState().selections[summary.id],
      }
    })
    useTabStore.setState({ openTab })
    mockSearch.mockResolvedValue({ results: [makeResult(summary.id, 'Search projection title')], total: 1, truncated: false })
    render(<GlobalSearchModal open onClose={onClose} />)
    fireEvent.change(screen.getByPlaceholderText(/search projects and chats/i), { target: { value: 'old history' } })
    fireEvent.click(await screen.findByText('Search projection title'))
    expect(sessionsApi.getSummary).toHaveBeenCalledWith(summary.id, expect.objectContaining({ signal: expect.any(AbortSignal), timeout: 5000 }))
    expect(openTab).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()

    const confirmedRuntime = { providerId: 'confirmed-provider', modelId: 'confirmed-model' }
    await act(async () => {
      if (switchRuntime) {
        useSessionRuntimeStore.getState().setSelection(summary.id, confirmedRuntime)
        useSessionRuntimeStore.getState().settleSelection(summary.id)
      }
      resolveSummary(summary)
    })
    expect(openTab).toHaveBeenCalledWith(summary.id, summary.title)
    expect(observedMetadata).toEqual({
      session: summary,
      runtime: switchRuntime ? confirmedRuntime : { providerId: 'history-provider', modelId: 'history-model' },
    })
    expect(useSessionStore.getState().historicalSessionIds.has(summary.id)).toBe(true)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('opens a recent row immediately and retains its metadata without a summary request', () => {
    const recent = makeSession('recent-opened', 'Recent opened')
    useSessionStore.setState({ sessions: [recent], historicalSessionIds: new Set() })
    const onClose = vi.fn()
    render(<GlobalSearchModal open onClose={onClose} />)
    fireEvent.click(screen.getByText(recent.title))
    expect(useTabStore.getState().openTab).toHaveBeenCalledWith(recent.id, recent.title)
    expect(useSessionStore.getState().historicalSessionIds).toEqual(new Set([recent.id]))
    expect(sessionsApi.getSummary).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it.each(['close', 'query'] as const)('does not activate or hydrate a pending hit after %s changes', async (change) => {
    const summary = makeSession('canceled-hit', 'Canceled hit')
    let resolveSummary!: (value: SessionListItem) => void
    vi.mocked(sessionsApi.getSummary).mockReturnValueOnce(new Promise((resolve) => { resolveSummary = resolve }))
    mockSearch.mockResolvedValueOnce({ results: [makeResult(summary.id, summary.title)], total: 1, truncated: false })
    const onClose = vi.fn()
    const { rerender } = render(<GlobalSearchModal open onClose={onClose} />)
    const input = screen.getByPlaceholderText(/search projects and chats/i)
    fireEvent.change(input, { target: { value: 'old' } })
    fireEvent.click(await screen.findByText(summary.title))
    const signal = vi.mocked(sessionsApi.getSummary).mock.calls[0]?.[1]?.signal
    if (change === 'close') rerender(<GlobalSearchModal open={false} onClose={onClose} />)
    else fireEvent.change(input, { target: { value: 'new query' } })
    expect(signal?.aborted).toBe(true)
    await act(async () => { resolveSummary(summary) })
    expect(useTabStore.getState().openTab).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions).toEqual([])
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not replace a later recent-row choice when an earlier summary resolves', async () => {
    const recent = makeSession('latest-row', 'Latest row')
    const old = makeSession('old-row', 'Old row')
    useSessionStore.setState({ sessions: [recent] })
    let resolveSummary!: (value: SessionListItem) => void
    vi.mocked(sessionsApi.getSummary).mockReturnValueOnce(new Promise((resolve) => { resolveSummary = resolve }))
    mockSearch.mockResolvedValueOnce({ results: [makeResult(old.id, old.title), makeResult(recent.id, recent.title)], total: 2, truncated: false })
    render(<GlobalSearchModal open onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText(/search projects and chats/i), { target: { value: 'rows' } })
    fireEvent.click(await screen.findByText(old.title))
    fireEvent.click(screen.getByText(recent.title))
    await act(async () => { resolveSummary(old) })
    expect(useTabStore.getState().openTab).toHaveBeenCalledExactlyOnceWith(recent.id, recent.title)
    expect(useSessionStore.getState().sessions).toEqual([recent])
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(<GlobalSearchModal open onClose={onClose} />)
    fireEvent.keyDown(screen.getByPlaceholderText(/search projects and chats/i), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('shows a no-results message', async () => {
    mockSearch.mockResolvedValue({ results: [], total: 0, truncated: false })
    render(<GlobalSearchModal open onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText(/search projects and chats/i), { target: { value: 'zzz' } })
    await screen.findByText('No matches found')
  })

  it('shows an error message when the search fails', async () => {
    mockSearch.mockRejectedValue(new Error('boom'))
    render(<GlobalSearchModal open onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText(/search projects and chats/i), { target: { value: 'zzz' } })
    await screen.findByText('Search failed')
  })

  it('shows a truncation note when results are capped', async () => {
    mockSearch.mockResolvedValue({ results: [makeResult('s1', 'Session One')], total: 1, truncated: true })
    render(<GlobalSearchModal open onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText(/search projects and chats/i), { target: { value: 'x' } })
    await screen.findByText('Session One')
    expect(screen.getByText(/showing first/i)).toBeInTheDocument()
  })

  it('ignores a stale response that resolves after a newer one', async () => {
    let resolveFirst: (value: { results: SessionSearchResult[]; total: number; truncated: boolean }) => void = () => {}
    const firstPromise = new Promise<{ results: SessionSearchResult[]; total: number; truncated: boolean }>((resolve) => {
      resolveFirst = resolve
    })
    mockSearch
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValueOnce({ results: [makeResult('s2', 'Session Two')], total: 1, truncated: false })

    render(<GlobalSearchModal open onClose={() => {}} />)
    const input = screen.getByPlaceholderText(/search projects and chats/i)

    fireEvent.change(input, { target: { value: 'one' } })
    await waitFor(() => expect(mockSearch).toHaveBeenCalledTimes(1))

    fireEvent.change(input, { target: { value: 'two' } })
    await waitFor(() => expect(mockSearch).toHaveBeenCalledTimes(2))
    await screen.findByText('Session Two')

    // The stale first request resolves last — it must not overwrite the newer results.
    await act(async () => {
      resolveFirst({ results: [makeResult('s1', 'Session One')], total: 1, truncated: false })
      await Promise.resolve()
    })

    expect(screen.queryByText('Session One')).toBeNull()
    expect(screen.getByText('Session Two')).toBeInTheDocument()
  })

  it('aborts the previous request as soon as the visible query changes', async () => {
    let firstSignal: AbortSignal | undefined
    mockSearch.mockImplementationOnce((_query, _options, requestOptions) => {
      firstSignal = requestOptions?.signal
      return new Promise(() => {})
    })

    render(<GlobalSearchModal open onClose={() => {}} />)
    const input = screen.getByPlaceholderText(/search projects and chats/i)
    fireEvent.change(input, { target: { value: 'first' } })
    await waitFor(() => expect(mockSearch).toHaveBeenCalledTimes(1))
    expect(firstSignal?.aborted).toBe(false)

    fireEvent.change(input, { target: { value: 'second' } })
    expect(firstSignal?.aborted).toBe(true)
    expect(screen.queryByText('Search failed')).toBeNull()
  })

  it('aborts an in-flight request when the modal closes', async () => {
    let signal: AbortSignal | undefined
    mockSearch.mockImplementationOnce((_query, _options, requestOptions) => {
      signal = requestOptions?.signal
      return new Promise(() => {})
    })

    const { rerender } = render(<GlobalSearchModal open onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText(/search projects and chats/i), {
      target: { value: 'running' },
    })
    await waitFor(() => expect(mockSearch).toHaveBeenCalledTimes(1))

    rerender(<GlobalSearchModal open={false} onClose={() => {}} />)
    expect(signal?.aborted).toBe(true)
  })

  it('waits for IME composition to finish before starting a search', async () => {
    vi.useFakeTimers()
    try {
      render(<GlobalSearchModal open onClose={() => {}} />)
      const input = screen.getByPlaceholderText(/search projects and chats/i)
      fireEvent.compositionStart(input)
      fireEvent.change(input, { target: { value: '搜索' } })

      await act(async () => {
        vi.advanceTimersByTime(300)
        await Promise.resolve()
      })
      expect(mockSearch).not.toHaveBeenCalled()

      fireEvent.compositionEnd(input)
      await act(async () => {
        vi.advanceTimersByTime(300)
        await Promise.resolve()
      })
      expect(mockSearch).toHaveBeenCalledTimes(1)
      expect(mockSearch.mock.calls[0]?.[0]).toBe('搜索')
    } finally {
      vi.useRealTimers()
    }
  })

  it('matches projects immediately by folder name even when chat search has no hits', async () => {
    useSessionStore.setState({
      sessions: [
        makeSession('s1', 'Fix login', {
          projectRoot: '/Users/dev/code/modeldial-arena',
          workDir: '/Users/dev/code/modeldial-arena',
          projectPath: '-Users-dev-code-modeldial-arena',
        }),
        makeSession('s2', 'Add theme', {
          projectRoot: '/Users/dev/code/cc-haha',
          workDir: '/Users/dev/code/cc-haha',
          projectPath: '-Users-dev-code-cc-haha',
        }),
      ],
      projectSessionTotals: {
        '/Users/dev/code/modeldial-arena': 5,
        '/Users/dev/code/cc-haha': 1,
      },
    })
    mockSearch.mockResolvedValue({ results: [], total: 0, truncated: false })

    const onSelectProject = vi.fn()
    const onClose = vi.fn()
    render(<GlobalSearchModal open onClose={onClose} onSelectProject={onSelectProject} />)

    const input = screen.getByPlaceholderText(/search projects and chats/i)
    fireEvent.change(input, { target: { value: 'modeldial' } })

    // Project matches appear immediately without waiting for debounced backend search.
    expect(screen.getByText('Projects')).toBeInTheDocument()
    const mark = screen.getByText('modeldial')
    expect(mark.tagName).toBe('MARK')
    expect(screen.getByText('5 chats')).toBeInTheDocument()

    // Wait for backend chat search to settle with zero hits; must NOT show "No matches found".
    await waitFor(() => expect(mockSearch).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('No matches found')).toBeNull()

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelectProject).toHaveBeenCalledWith('/Users/dev/code/modeldial-arena')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('matches projects by custom display name, original folder name, and archive-only projects', () => {
    useSessionStore.setState({
      sessions: [
        makeSession('s1', 'Work on feature', {
          projectRoot: '/Users/dev/code/backend-api',
          workDir: '/Users/dev/code/backend-api',
        }),
      ],
      projectSessionTotals: { '/Users/dev/code/backend-api': 1 },
      projectArchivedTotals: { '/Users/dev/code/legacy-portal': 4 },
    })
    hydrateProjectDisplayNames(
      { '/Users/dev/code/backend-api': 'Payment Core' },
      captureProjectDisplayNameHydrationRevision(),
    )

    render(<GlobalSearchModal open onClose={() => {}} onSelectProject={vi.fn()} />)
    const input = screen.getByPlaceholderText(/search projects and chats/i)

    fireEvent.change(input, { target: { value: 'Payment' } })
    expect(screen.getByText('Payment').tagName).toBe('MARK')
    expect(screen.getByText('1 chat')).toBeInTheDocument()

    // Renamed project still matches by its original folder name.
    fireEvent.change(input, { target: { value: 'backend-api' } })
    expect(screen.getByText('Payment Core')).toBeInTheDocument()
    expect(screen.getByText('backend-api').tagName).toBe('MARK')

    // Archive-only project is searchable too.
    fireEvent.change(input, { target: { value: 'legacy-portal' } })
    expect(screen.getByText('legacy-portal').tagName).toBe('MARK')
    expect(screen.getByText('Archived')).toBeInTheDocument()
  })

  it('navigates across project results and chat results with arrow keys', async () => {
    useSessionStore.setState({
      sessions: [
        makeSession('s-proj', 'Unrelated title', {
          projectRoot: '/Users/dev/code/alpha-web',
          workDir: '/Users/dev/code/alpha-web',
        }),
      ],
    })
    mockSearch.mockResolvedValue({
      results: [makeResult('s-hit', 'Alpha Chat Hit')],
      total: 1,
      truncated: false,
    })

    const openTab = vi.fn()
    useTabStore.setState({ openTab } as Partial<ReturnType<typeof useTabStore.getState>>)
    const onSelectProject = vi.fn()
    const onClose = vi.fn()

    render(<GlobalSearchModal open onClose={onClose} onSelectProject={onSelectProject} />)
    const input = screen.getByPlaceholderText(/search projects and chats/i)
    fireEvent.change(input, { target: { value: 'alpha' } })

    await screen.findByText('Alpha Chat Hit')
    expect(screen.getByText('Projects')).toBeInTheDocument()
    expect(screen.getByText('Chats')).toBeInTheDocument()

    // Index 0 is the matched project; ArrowDown moves to index 1 (the chat hit).
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(openTab).toHaveBeenCalledWith('s-hit', 'Alpha Chat Hit'))
    expect(onSelectProject).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('keeps matched projects visible when chat content search fails', async () => {
    useSessionStore.setState({
      sessions: [
        makeSession('s1', 'Chat', {
          projectRoot: '/Users/dev/code/solo-proj',
          workDir: '/Users/dev/code/solo-proj',
        }),
      ],
    })
    mockSearch.mockRejectedValue(new Error('search down'))

    const onSelectProject = vi.fn()
    const onClose = vi.fn()
    render(<GlobalSearchModal open onClose={onClose} onSelectProject={onSelectProject} />)

    fireEvent.change(screen.getByPlaceholderText(/search projects and chats/i), {
      target: { value: 'solo-proj' },
    })

    await screen.findByText('Search failed')
    expect(screen.getByText('Projects')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: /solo-proj/i }))
    expect(onSelectProject).toHaveBeenCalledWith('/Users/dev/code/solo-proj')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('falls back to opening the latest session or a new draft when onSelectProject is omitted', () => {
    const startNewSessionDraft = vi.fn()
    useUIStore.setState({ startNewSessionDraft } as Partial<ReturnType<typeof useUIStore.getState>>)
    const latest = makeSession('s-latest', 'Latest Chat', {
      projectRoot: '/Users/dev/code/standalone-proj',
      workDir: '/Users/dev/code/standalone-proj',
    })
    useSessionStore.setState({
      sessions: [latest],
      projectArchivedTotals: { '/Users/dev/code/archived-standalone': 2 },
    })

    const onClose = vi.fn()
    render(<GlobalSearchModal open onClose={onClose} />)
    const input = screen.getByPlaceholderText(/search projects and chats/i)

    fireEvent.change(input, { target: { value: 'standalone-proj' } })
    fireEvent.click(screen.getByRole('option', { name: /standalone-proj/i }))
    expect(useTabStore.getState().openTab).toHaveBeenCalledWith('s-latest', 'Latest Chat')
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.change(input, { target: { value: 'archived-standalone' } })
    fireEvent.click(screen.getByRole('option', { name: /archived-standalone/i }))
    expect(startNewSessionDraft).toHaveBeenCalledWith('/Users/dev/code/archived-standalone')
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('uses V6C dialog-panel, recessed search field, Kbd keycaps, and focus-visible lifted rows', () => {
    useSessionStore.setState({
      sessions: [
        makeSession('s1', 'Recent One', { projectRoot: '/Users/dev/code/alpha-proj', workDir: '/Users/dev/code/alpha-proj' }),
        makeSession('s2', 'Recent Two', { projectRoot: '/Users/dev/code/beta-proj', workDir: '/Users/dev/code/beta-proj' }),
      ],
    })
    render(<GlobalSearchModal open onClose={() => {}} />)

    const dialog = screen.getByRole('dialog', { name: /search projects and chats/i })
    expect(dialog).toHaveClass('dialog-panel', 'rounded-[var(--radius-3xl)]')
    expect(dialog).not.toHaveClass('z-10')

    const input = screen.getByPlaceholderText(/search projects and chats/i)
    expect(input.parentElement).toHaveClass('v6c-field', 'rounded-[var(--radius-card-inner)]')

    const closeBtn = screen.getByRole('button', { name: 'Close' })
    expect(closeBtn.querySelector('kbd')).toBeInTheDocument()

    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveClass(
      'rounded-[var(--radius-control)]',
      'v6c-row-highlight',
      'focus-visible:ring-2',
      'focus-visible:ring-inset',
      'focus-visible:ring-[var(--color-border-focus)]',
    )
    expect(options[1]).toHaveClass(
      'rounded-[var(--radius-control)]',
      'focus-visible:ring-2',
      'focus-visible:ring-inset',
      'focus-visible:ring-[var(--color-border-focus)]',
    )
    expect(options[1]).not.toHaveClass('v6c-row-highlight')

    // Also verify ProjectRow receives the inset focus-visible ring.
    fireEvent.change(input, { target: { value: 'alpha-proj' } })
    const projectOption = screen.getByRole('option', { name: /alpha-proj/i })
    expect(projectOption).toHaveClass(
      'focus-visible:ring-2',
      'focus-visible:ring-inset',
      'focus-visible:ring-[var(--color-border-focus)]',
    )
  })
})
