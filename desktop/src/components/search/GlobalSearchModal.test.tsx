import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

import { GlobalSearchModal } from './GlobalSearchModal'
import { useSessionStore } from '../../stores/sessionStore'
import { useTabStore } from '../../stores/tabStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { searchApi } from '../../api/search'
import type { SessionListItem } from '../../types/session'
import type { SessionSearchResult } from '../../api/search'

vi.mock('../../api/search', () => ({
  searchApi: { searchSessions: vi.fn() },
}))

const mockSearch = vi.mocked(searchApi.searchSessions)

// jsdom does not implement scrollIntoView (used to keep the active row in view).
Element.prototype.scrollIntoView = vi.fn()

function makeSession(id: string, title: string): SessionListItem {
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
  useSessionStore.setState({ sessions: [] })
  useTabStore.setState({ openTab: vi.fn() } as Partial<ReturnType<typeof useTabStore.getState>>)
  mockSearch.mockResolvedValue({ results: [], total: 0, truncated: false })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('GlobalSearchModal', () => {
  it('renders nothing when closed', () => {
    render(<GlobalSearchModal open={false} onClose={() => {}} />)
    expect(screen.queryByPlaceholderText(/search all chats/i)).toBeNull()
  })

  it('renders the input and focuses it when open', async () => {
    render(<GlobalSearchModal open onClose={() => {}} />)
    const input = screen.getByPlaceholderText(/search all chats/i)
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
      const input = screen.getByPlaceholderText(/search all chats/i)
      fireEvent.change(input, { target: { value: 'a' } })
      fireEvent.change(input, { target: { value: 'ab' } })
      fireEvent.change(input, { target: { value: 'abc' } })
      expect(mockSearch).not.toHaveBeenCalled()

      await act(async () => {
        vi.advanceTimersByTime(300)
        await Promise.resolve()
      })

      expect(mockSearch).toHaveBeenCalledTimes(1)
      expect(mockSearch).toHaveBeenCalledWith('abc', expect.objectContaining({ limit: expect.any(Number) }))
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
    fireEvent.change(screen.getByPlaceholderText(/search all chats/i), { target: { value: 'world' } })

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
    const input = screen.getByPlaceholderText(/search all chats/i)
    fireEvent.change(input, { target: { value: 'x' } })
    await screen.findByText('Session One')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(openTab).toHaveBeenCalledWith('s2', 'Session Two')
    expect(onClose).toHaveBeenCalled()
  })

  it('opens a result on click', async () => {
    const openTab = vi.fn()
    useTabStore.setState({ openTab } as Partial<ReturnType<typeof useTabStore.getState>>)
    const onClose = vi.fn()
    mockSearch.mockResolvedValue({ results: [makeResult('s1', 'Clickable')], total: 1, truncated: false })

    render(<GlobalSearchModal open onClose={onClose} />)
    fireEvent.change(screen.getByPlaceholderText(/search all chats/i), { target: { value: 'x' } })
    fireEvent.click(await screen.findByText('Clickable'))

    expect(openTab).toHaveBeenCalledWith('s1', 'Clickable')
    expect(onClose).toHaveBeenCalled()
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(<GlobalSearchModal open onClose={onClose} />)
    fireEvent.keyDown(screen.getByPlaceholderText(/search all chats/i), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('shows a no-results message', async () => {
    mockSearch.mockResolvedValue({ results: [], total: 0, truncated: false })
    render(<GlobalSearchModal open onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText(/search all chats/i), { target: { value: 'zzz' } })
    await screen.findByText('No matches found')
  })

  it('shows an error message when the search fails', async () => {
    mockSearch.mockRejectedValue(new Error('boom'))
    render(<GlobalSearchModal open onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText(/search all chats/i), { target: { value: 'zzz' } })
    await screen.findByText('Search failed')
  })

  it('shows a truncation note when results are capped', async () => {
    mockSearch.mockResolvedValue({ results: [makeResult('s1', 'Session One')], total: 1, truncated: true })
    render(<GlobalSearchModal open onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText(/search all chats/i), { target: { value: 'x' } })
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
    const input = screen.getByPlaceholderText(/search all chats/i)

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
})
