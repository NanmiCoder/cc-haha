import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '../../stores/uiStore'
import { useSessionStore } from '../../stores/sessionStore'

const mocks = vi.hoisted(() => ({
  initializeDesktopServerUrl: vi.fn(),
  isTauriRuntime: false,
  isMobile: false,
  fetchAll: vi.fn(),
  restoreTabs: vi.fn(),
  connectToSession: vi.fn(),
  setActiveTab: vi.fn(),
  tabState: {
    activeTabId: null as string | null,
    tabs: [] as Array<{ sessionId: string; title: string; type: string; status: string }>,
  },
}))

vi.mock('../../lib/desktopRuntime', () => ({
  initializeDesktopServerUrl: mocks.initializeDesktopServerUrl,
  isTauriRuntime: () => mocks.isTauriRuntime,
  isH5ConnectionRequiredError: (error: unknown) =>
    error instanceof Error && error.name === 'H5ConnectionRequiredError',
}))

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: { fetchAll: typeof mocks.fetchAll }) => unknown) =>
    selector({ fetchAll: mocks.fetchAll }),
}))

vi.mock('../../hooks/useMobileViewport', () => ({
  useMobileViewport: () => mocks.isMobile,
}))

vi.mock('../../stores/tabStore', () => {
  const useTabStore = (selector: (state: {
    tabs: typeof mocks.tabState.tabs
    activeTabId: string | null
    setActiveTab: typeof mocks.setActiveTab
  }) => unknown) => selector({
    tabs: mocks.tabState.tabs,
    activeTabId: mocks.tabState.activeTabId,
    setActiveTab: mocks.setActiveTab,
  })
  useTabStore.getState = () => ({
    restoreTabs: mocks.restoreTabs,
    activeTabId: mocks.tabState.activeTabId,
    tabs: mocks.tabState.tabs,
    openTab: vi.fn(),
    setActiveTab: mocks.setActiveTab,
  })
  useTabStore.setState = (next: { activeTabId?: string | null }) => {
    if ('activeTabId' in next) mocks.tabState.activeTabId = next.activeTabId ?? null
  }
  return {
    SETTINGS_TAB_ID: '__settings__',
    useTabStore,
  }
})

vi.mock('../../stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      connectToSession: mocks.connectToSession,
    }),
  },
}))

vi.mock('../../hooks/useKeyboardShortcuts', () => ({
  useKeyboardShortcuts: vi.fn(),
}))

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string) => key,
}))

vi.mock('./Sidebar', () => ({
  Sidebar: () => <aside>sidebar loaded</aside>,
}))

vi.mock('./ContentRouter', () => ({
  ContentRouter: () => <section>content loaded</section>,
}))

vi.mock('./TabBar', () => ({
  TabBar: () => <nav>tabs loaded</nav>,
}))

vi.mock('./H5ConnectionView', () => ({
  H5ConnectionView: ({ error, onConnected }: { error?: string | null; onConnected: () => void }) => (
    <div>
      <div>h5 connection view</div>
      <div>{error}</div>
      <button type="button" onClick={onConnected}>retry h5 bootstrap</button>
    </div>
  ),
}))

vi.mock('../shared/Toast', () => ({
  ToastContainer: () => null,
}))

vi.mock('../shared/UpdateChecker', () => ({
  UpdateChecker: () => <div>updates loaded</div>,
}))

import { AppShell } from './AppShell'

describe('AppShell boot flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isTauriRuntime = false
    mocks.isMobile = false
    mocks.initializeDesktopServerUrl.mockResolvedValue('http://127.0.0.1:3456')
    mocks.fetchAll.mockResolvedValue(undefined)
    mocks.restoreTabs.mockResolvedValue(undefined)
    mocks.setActiveTab.mockImplementation((sessionId: string) => {
      mocks.tabState.activeTabId = sessionId
    })
    mocks.tabState.activeTabId = null
    mocks.tabState.tabs = []
    useSessionStore.setState({ sessions: [], activeSessionId: null, isLoading: false, error: null })
    useUIStore.setState({ sidebarOpen: true })
  })

  it('renders the desktop chrome after server and settings bootstrap', async () => {
    render(<AppShell />)

    expect(screen.getByText('app.launching')).toBeInTheDocument()

    expect(await screen.findByText('sidebar loaded')).toBeInTheDocument()
    expect(screen.getByText('tabs loaded')).toBeInTheDocument()
    expect(screen.getByText('content loaded')).toBeInTheDocument()
    expect(screen.getByText('updates loaded')).toBeInTheDocument()
  })

  it('shows startup diagnostics instead of a blank shell when bootstrap fails', async () => {
    mocks.fetchAll.mockRejectedValueOnce(new Error('settings file could not be read'))

    render(<AppShell />)

    expect(await screen.findByText('app.serverFailed')).toBeInTheDocument()
    expect(screen.getByText('settings file could not be read')).toBeInTheDocument()
    expect(screen.queryByText('sidebar loaded')).not.toBeInTheDocument()
  })

  it('keeps the app usable when persisted tab restore fails', async () => {
    mocks.restoreTabs.mockRejectedValueOnce(new Error('old tab payload is invalid'))

    render(<AppShell />)

    expect(await screen.findByText('sidebar loaded')).toBeInTheDocument()
    await waitFor(() => {
      expect(mocks.restoreTabs).toHaveBeenCalled()
    })
    expect(screen.queryByText('app.serverFailed')).not.toBeInTheDocument()
  })

  it('reconnects the restored active session tab after boot', async () => {
    mocks.tabState.activeTabId = 'session-1'
    mocks.tabState.tabs = [
      {
        sessionId: 'session-1',
        title: 'Existing session',
        type: 'session',
        status: 'idle',
      },
    ]

    render(<AppShell />)

    await screen.findByText('sidebar loaded')
    await waitFor(() => {
      expect(mocks.connectToSession).toHaveBeenCalledWith('session-1')
    })
  })

  it('shows the H5 connection view in browser mode when startup needs H5 auth', async () => {
    mocks.initializeDesktopServerUrl.mockRejectedValueOnce(
      Object.assign(new Error('Enter your H5 token to continue.'), {
        name: 'H5ConnectionRequiredError',
        serverUrl: 'https://remote.example.com',
      }),
    )

    render(<AppShell />)

    expect(await screen.findByText('h5 connection view')).toBeInTheDocument()
    expect(screen.getByText('Enter your H5 token to continue.')).toBeInTheDocument()
    expect(screen.queryByText('app.serverFailed')).not.toBeInTheDocument()
  })

  it('shows the H5 connection view for unreachable remote browser startup failures', async () => {
    mocks.initializeDesktopServerUrl.mockRejectedValueOnce(
      Object.assign(new Error('Unable to reach https://remote.example.com. Check the server URL or network access.'), {
        name: 'H5ConnectionRequiredError',
        serverUrl: 'https://remote.example.com',
      }),
    )

    render(<AppShell />)

    expect(await screen.findByText('h5 connection view')).toBeInTheDocument()
    expect(screen.getByText('Unable to reach https://remote.example.com. Check the server URL or network access.')).toBeInTheDocument()
    expect(screen.queryByText('app.serverFailed')).not.toBeInTheDocument()
  })

  it('retries bootstrap after a successful H5 connection', async () => {
    mocks.initializeDesktopServerUrl
      .mockRejectedValueOnce(
        Object.assign(new Error('The saved H5 token is no longer valid.'), {
          name: 'H5ConnectionRequiredError',
          serverUrl: 'https://remote.example.com',
        }),
      )
      .mockResolvedValueOnce('https://remote.example.com')

    render(<AppShell />)

    expect(await screen.findByText('h5 connection view')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'retry h5 bootstrap' }))

    await screen.findByText('sidebar loaded')
    expect(mocks.initializeDesktopServerUrl).toHaveBeenCalledTimes(2)
    expect(mocks.fetchAll).toHaveBeenCalledTimes(1)
  })

  it('keeps the Tauri startup error path unchanged', async () => {
    mocks.isTauriRuntime = true
    mocks.initializeDesktopServerUrl.mockRejectedValueOnce(
      Object.assign(new Error('desktop server startup failed'), {
        name: 'H5ConnectionRequiredError',
        serverUrl: 'https://remote.example.com',
      }),
    )

    render(<AppShell />)

    expect(await screen.findByText('app.serverFailed')).toBeInTheDocument()
    expect(screen.queryByText('h5 connection view')).not.toBeInTheDocument()
  })

  it('renders a mobile drawer toggle and backdrop in browser H5 mode', async () => {
    mocks.isMobile = true

    render(<AppShell />)

    await screen.findByText('content loaded')

    await waitFor(() => {
      expect(useUIStore.getState().sidebarOpen).toBe(false)
    })

    expect(screen.getByTestId('sidebar-shell')).toHaveAttribute('data-state', 'closed')
    expect(screen.getByTestId('sidebar-shell')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('sidebar-shell')).toHaveAttribute('inert')
    expect(screen.queryByText('sidebar loaded')).not.toBeInTheDocument()
    expect(screen.getByTestId('mobile-sidebar-toggle')).toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-backdrop')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('mobile-sidebar-toggle'))

    expect(useUIStore.getState().sidebarOpen).toBe(true)
    expect(screen.getByTestId('sidebar-shell')).toHaveAttribute('data-state', 'open')
    expect(screen.getByText('sidebar loaded')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar-backdrop')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('sidebar-backdrop'))

    expect(useUIStore.getState().sidebarOpen).toBe(false)
    expect(screen.getByTestId('sidebar-shell')).toHaveAttribute('data-state', 'closed')
  })

  it('shares the mobile drawer row with the active session title', async () => {
    mocks.isMobile = true
    mocks.tabState.activeTabId = 'session-mobile'
    mocks.tabState.tabs = [
      { sessionId: 'session-mobile', title: 'Fallback tab title', type: 'session', status: 'running' },
    ]
    useSessionStore.setState({
      sessions: [{
        id: 'session-mobile',
        title: 'Analyze recent commits',
        createdAt: '2026-05-10T00:00:00.000Z',
        modifiedAt: new Date().toISOString(),
        messageCount: 7,
        projectPath: '/tmp/project',
        workDir: '/tmp/project',
        workDirExists: true,
      }],
      activeSessionId: 'session-mobile',
      isLoading: false,
      error: null,
    })

    render(<AppShell />)

    await screen.findByText('content loaded')

    const header = screen.getByTestId('mobile-session-header')
    expect(header).toHaveTextContent('Analyze recent commits')
    expect(header).toHaveTextContent('session.active')
    expect(header).toHaveTextContent('session.messages')
    expect(screen.getByTestId('mobile-sidebar-toggle')).toHaveClass('h-10', 'w-10')
  })

  it('keeps browser H5 mobile on chat tabs when settings was restored as active', async () => {
    mocks.isMobile = true
    mocks.tabState.activeTabId = '__settings__'
    mocks.tabState.tabs = [
      { sessionId: '__settings__', title: 'Settings', type: 'settings', status: 'idle' },
      { sessionId: 'session-1', title: 'Existing session', type: 'session', status: 'idle' },
    ]

    render(<AppShell />)

    await screen.findByText('content loaded')
    expect(screen.queryByText('tabs loaded')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(mocks.setActiveTab).toHaveBeenCalledWith('session-1')
    })
  })
})
