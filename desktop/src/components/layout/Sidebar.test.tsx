import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('./ProjectFilter', () => ({
  ProjectFilter: () => <div data-testid="project-filter" />,
}))

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string) => {
    const translations: Record<string, string> = {
      'sidebar.newSession': 'New Session',
      'sidebar.scheduled': 'Scheduled',
      'sidebar.settings': 'Settings',
      'sidebar.searchPlaceholder': 'Search sessions',
      'sidebar.noSessions': 'No sessions',
      'sidebar.noMatching': 'No matching sessions',
      'sidebar.sessionListFailed': 'Session list failed',
      'common.retry': 'Retry',
      'common.loading': 'Loading...',
      'common.cancel': 'Cancel',
      'common.delete': 'Delete',
      'common.rename': 'Rename',
      'sidebar.timeGroup.today': 'Today',
      'sidebar.timeGroup.yesterday': 'Yesterday',
      'sidebar.timeGroup.last7days': 'Last 7 Days',
      'sidebar.timeGroup.last30days': 'Last 30 Days',
      'sidebar.timeGroup.older': 'Older',
      'sidebar.missingDir': 'Missing',
      'sidebar.confirmDelete': 'Delete this session? This cannot be undone.',
      'sidebar.collapse': 'Collapse sidebar',
      'sidebar.expand': 'Expand sidebar',
    }

    return translations[key] ?? key
  },
}))

import { Sidebar } from './Sidebar'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'

describe('Sidebar', () => {
  const connectToSession = vi.fn()
  const disconnectSession = vi.fn()
  const fetchSessions = vi.fn()
  const createSession = vi.fn()
  const deleteSession = vi.fn()
  const addToast = vi.fn()

  beforeEach(() => {
    connectToSession.mockReset()
    disconnectSession.mockReset()
    fetchSessions.mockReset()
    createSession.mockReset()
    deleteSession.mockReset()
    addToast.mockReset()

    useTabStore.setState({ tabs: [], activeTabId: null })
    useSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      isLoading: false,
      error: null,
      selectedProjects: [],
      availableProjects: [],
      fetchSessions,
      createSession,
      deleteSession,
    })
    useChatStore.setState({
      connectToSession,
      disconnectSession,
    } as Partial<ReturnType<typeof useChatStore.getState>>)
    useUIStore.setState({
      sidebarOpen: true,
      addToast,
    } as Partial<ReturnType<typeof useUIStore.getState>>)
  })

  afterEach(() => {
    cleanup()
    useTabStore.setState({ tabs: [], activeTabId: null })
  })

  it('opens a new tab when creating a session from the sidebar', async () => {
    createSession.mockResolvedValue('session-new-1')

    render(<Sidebar />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New Session' }))
    })

    await waitFor(() => {
      expect(createSession).toHaveBeenCalled()
      expect(connectToSession).toHaveBeenCalledWith('session-new-1')
    })

    expect(useTabStore.getState().tabs).toEqual([
      { sessionId: 'session-new-1', title: 'New Session', type: 'session', status: 'idle' },
    ])
    expect(useTabStore.getState().activeTabId).toBe('session-new-1')
    expect(screen.getByRole('complementary')).not.toHaveAttribute('data-tauri-drag-region')
  })

  it('shows a toast when session creation fails', async () => {
    createSession.mockRejectedValue(new Error('boom'))

    render(<Sidebar />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New Session' }))
    })

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith({
        type: 'error',
        message: 'boom',
      })
    })

    expect(useTabStore.getState().tabs).toEqual([])
  })

  it('requires confirmation before deleting a session from the sidebar', async () => {
    deleteSession.mockResolvedValue(undefined)
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          title: 'Open Session',
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
          messageCount: 1,
          projectPath: '/workspace/project',
          workDir: '/workspace/project',
          workDirExists: true,
        },
      ],
    })
    useTabStore.setState({
      tabs: [{ sessionId: 'session-1', title: 'Open Session', type: 'session', status: 'idle' }],
      activeTabId: 'session-1',
    })

    render(<Sidebar />)

    fireEvent.contextMenu(screen.getByRole('button', { name: /Open Session/ }))

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect(deleteSession).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeInTheDocument()
    expect(screen.getByText('Delete this session? This cannot be undone.')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    })

    await waitFor(() => {
      expect(deleteSession).toHaveBeenCalledWith('session-1')
      expect(disconnectSession).toHaveBeenCalledWith('session-1')
    })

    expect(useTabStore.getState().tabs).toEqual([])
    expect(useTabStore.getState().activeTabId).toBeNull()
  })

  it('collapses into an icon rail and expands back', async () => {
    render(<Sidebar />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    })

    expect(useUIStore.getState().sidebarOpen).toBe(false)
    expect(screen.queryByPlaceholderText('Search sessions')).not.toBeInTheDocument()
    expect(screen.getByRole('complementary')).toHaveAttribute('data-state', 'closed')
    expect(screen.getByTestId('sidebar-expand-button')).toHaveClass('sidebar-toggle-button--collapsed')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }))
    })

    expect(useUIStore.getState().sidebarOpen).toBe(true)
    expect(screen.getByPlaceholderText('Search sessions')).toBeInTheDocument()
    expect(screen.getByRole('complementary')).toHaveAttribute('data-state', 'open')
  })

  it('keeps the project filter section overflow visible for dropdown menus', () => {
    render(<Sidebar />)

    expect(screen.getByTestId('sidebar-project-filter-section')).toHaveStyle({ overflow: 'visible' })
    expect(screen.getByTestId('sidebar-project-filter-section')).toHaveClass('relative', 'z-20')
  })

  it('keeps the session list section in a constrained flex column for scrolling', () => {
    render(<Sidebar />)

    expect(screen.getByTestId('sidebar-session-list-section')).toHaveClass('flex', 'flex-1', 'min-h-0', 'flex-col')
  })

  it('shows a loading state instead of an empty session list while initial fetch is pending', () => {
    useSessionStore.setState({ isLoading: true, sessions: [] })

    render(<Sidebar />)

    expect(screen.getByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByText('No sessions')).not.toBeInTheDocument()
  })
})
