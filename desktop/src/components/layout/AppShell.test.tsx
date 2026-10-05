import { useEffect } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '../../stores/uiStore'
import { useSessionStore } from '../../stores/sessionStore'
import {
  hydrateProjectDisplayNames,
  resolveProjectDisplayName,
} from '../../stores/projectDisplayNameStore'

const mocks = vi.hoisted(() => ({
  initializeDesktopServerUrl: vi.fn(),
  isTauriRuntime: false,
  layout: 'desktop' as 'desktop' | 'phone' | 'tablet',
  fetchAll: vi.fn(),
  restoreTabs: vi.fn(),
  connectToSession: vi.fn(),
  setActiveTab: vi.fn(),
  openTab: vi.fn(),
  getDesktopUiPreferences: vi.fn(),
  updatePetPreferences: vi.fn(),
  tabState: {
    activeTabId: null as string | null,
    tabs: [] as Array<{ sessionId: string; title: string; type: string; status: string }>,
  },
}))

vi.mock('../../api/desktopUiPreferences', () => ({
  desktopUiPreferencesApi: {
    getPreferences: mocks.getDesktopUiPreferences,
    updatePetPreferences: mocks.updatePetPreferences,
  },
}))

vi.mock('../../lib/desktopRuntime', () => ({
  initializeDesktopServerUrl: mocks.initializeDesktopServerUrl,
  isTauriRuntime: () => mocks.isTauriRuntime,
  isDesktopRuntime: () => mocks.isTauriRuntime,
  isH5ConnectionRequiredError: (error: unknown) =>
    error instanceof Error && error.name === 'H5ConnectionRequiredError',
}))

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: { fetchAll: typeof mocks.fetchAll }) => unknown) =>
    selector({ fetchAll: mocks.fetchAll }),
}))

vi.mock('../mobile/mobileShellLayout', () => ({
  useMobileShellLayout: () => mocks.layout,
}))

// The phone and tablet frame has its own suite against real stores; here only
// the hand-off is checked: which layout it is given and whether the desktop UI
// preferences request reaches it, since no Sidebar mounts to consume it.
vi.mock('../mobile/MobileShell', () => ({
  MobileShell: ({ layout, preferencesRequest }: { layout: string; preferencesRequest: Promise<unknown> | null }) => (
    <div data-testid="mobile-shell-stub" data-layout={layout} data-has-preferences={preferencesRequest ? 'yes' : 'no'} />
  ),
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
    openTab: mocks.openTab,
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
  Sidebar: ({
    desktopUiPreferencesRequest,
    onDesktopUiPreferencesConsumed,
  }: {
    desktopUiPreferencesRequest?: Promise<unknown> | null
    onDesktopUiPreferencesConsumed?: (request: Promise<unknown>) => void
  }) => {
    useEffect(() => {
      if (!desktopUiPreferencesRequest) return
      let cancelled = false
      void desktopUiPreferencesRequest
        .finally(() => {
          if (!cancelled) onDesktopUiPreferencesConsumed?.(desktopUiPreferencesRequest)
        })
        .catch(() => undefined)
      return () => {
        cancelled = true
      }
    }, [desktopUiPreferencesRequest, onDesktopUiPreferencesConsumed])
    return <aside>sidebar loaded</aside>
  },
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

vi.mock('@/components/layout/Toast', () => ({
  ToastContainer: () => null,
}))

vi.mock('@/components/layout/UpdateChecker', () => ({
  UpdateChecker: () => <div>updates loaded</div>,
}))

import { AppShell } from './AppShell'

describe('AppShell boot flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    act(() => {
      hydrateProjectDisplayNames({}, Number.MAX_SAFE_INTEGER)
    })
    mocks.isTauriRuntime = false
    mocks.layout = 'desktop'
    mocks.initializeDesktopServerUrl.mockResolvedValue('http://127.0.0.1:3456')
    mocks.fetchAll.mockResolvedValue(undefined)
    mocks.restoreTabs.mockResolvedValue(undefined)
    mocks.getDesktopUiPreferences.mockResolvedValue({
      exists: true,
      preferences: {
        schemaVersion: 3,
        sidebar: {},
        profile: {},
        projectDisplayNames: {},
        pet: {
          enabled: false,
          selectedPetId: 'dada-code',
          size: 144,
          collapsed: false,
          motionEnabled: true,
          lastSessionId: null,
        },
      },
    })
    mocks.updatePetPreferences.mockResolvedValue({
      ok: true,
      preferences: {
        schemaVersion: 3,
        sidebar: {},
        profile: {},
        projectDisplayNames: {},
        pet: {
          enabled: false,
          selectedPetId: 'dada-code',
          size: 144,
          collapsed: false,
          motionEnabled: true,
          lastSessionId: null,
        },
      },
    })
    mocks.openTab.mockReset()
    mocks.setActiveTab.mockImplementation((sessionId: string) => {
      mocks.tabState.activeTabId = sessionId
    })
    mocks.tabState.activeTabId = null
    mocks.tabState.tabs = []
    useSessionStore.setState({ sessions: [], activeSessionId: null, isLoading: false, error: null })
    useUIStore.setState({ sidebarOpen: true })
    Reflect.deleteProperty(window, 'desktopHost')
    window.history.pushState({}, '', '/')
  })

  it('renders the desktop chrome after server and settings bootstrap', async () => {
    render(<AppShell />)

    expect(screen.getByText('app.launching')).toBeInTheDocument()

    expect(await screen.findByText('sidebar loaded')).toBeInTheDocument()
    expect(screen.getByText('tabs loaded')).toBeInTheDocument()
    expect(screen.getByText('content loaded')).toBeInTheDocument()
    expect(screen.getByText('updates loaded')).toBeInTheDocument()
  })

  it('keeps the last real session as Settings project context', async () => {
    useSessionStore.setState({
      sessions: [{
        id: 'session-1',
        title: 'Project session',
        createdAt: '',
        modifiedAt: '',
        messageCount: 0,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: null,
    })
    mocks.tabState.activeTabId = 'session-1'
    mocks.tabState.tabs = [
      { sessionId: 'session-1', title: 'Project session', type: 'session', status: 'idle' },
      { sessionId: '__settings__', title: 'Settings', type: 'settings', status: 'idle' },
    ]

    const { rerender } = render(<AppShell />)

    await waitFor(() => {
      expect(useSessionStore.getState().activeSessionId).toBe('session-1')
    })

    mocks.tabState.activeTabId = '__settings__'
    rerender(<AppShell />)
    expect(useSessionStore.getState().activeSessionId).toBe('session-1')

    mocks.tabState.activeTabId = 'team-member:synthetic'
    mocks.tabState.tabs = [
      ...mocks.tabState.tabs,
      { sessionId: 'team-member:synthetic', title: 'Teammate', type: 'team-member', status: 'idle' },
    ]
    rerender(<AppShell />)
    expect(useSessionStore.getState().activeSessionId).toBe('session-1')
  })

  it('restores the most recent open real session as Settings project context', async () => {
    const restoredSessions = [
      {
        id: 'session-recent',
        title: 'Recent project session',
        createdAt: '2026-07-21T02:00:00.000Z',
        modifiedAt: '2026-07-21T03:00:00.000Z',
        messageCount: 2,
        projectPath: '/workspace/recent',
        workDir: '/workspace/recent',
        workDirExists: true,
      },
      {
        id: 'session-older',
        title: 'Older project session',
        createdAt: '2026-07-20T02:00:00.000Z',
        modifiedAt: '2026-07-20T03:00:00.000Z',
        messageCount: 1,
        projectPath: '/workspace/older',
        workDir: '/workspace/older',
        workDirExists: true,
      },
    ]
    mocks.tabState.activeTabId = '__settings__'
    mocks.tabState.tabs = [
      { sessionId: 'session-older', title: 'Older project session', type: 'session', status: 'idle' },
      { sessionId: '__settings__', title: 'Settings', type: 'settings', status: 'idle' },
      { sessionId: 'team-member:synthetic', title: 'Teammate', type: 'team-member', status: 'idle' },
      { sessionId: 'session-recent', title: 'Recent project session', type: 'session', status: 'idle' },
    ]

    const { rerender } = render(<AppShell />)

    expect(useSessionStore.getState().activeSessionId).toBeNull()
    act(() => {
      useSessionStore.setState({ sessions: restoredSessions })
    })

    await waitFor(() => {
      expect(useSessionStore.getState().activeSessionId).toBe('session-recent')
    })

    mocks.tabState.activeTabId = 'team-member:synthetic'
    rerender(<AppShell />)
    expect(useSessionStore.getState().activeSessionId).toBe('session-recent')
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

  it('keeps the app usable when desktop UI preferences are unavailable', async () => {
    mocks.getDesktopUiPreferences.mockRejectedValueOnce(new Error('preferences unavailable'))

    render(<AppShell />)

    expect(await screen.findByText('sidebar loaded')).toBeInTheDocument()
    expect(screen.getByText('content loaded')).toBeInTheDocument()
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

  it('keeps the pet selection synchronized with the main window current task', async () => {
    mocks.isTauriRuntime = true
    mocks.tabState.activeTabId = 'session-current'
    mocks.tabState.tabs = [{
      sessionId: 'session-current',
      title: 'Current session',
      type: 'session',
      status: 'running',
    }]

    render(<AppShell />)

    await screen.findByText('sidebar loaded')
    await waitFor(() => {
      expect(mocks.updatePetPreferences).toHaveBeenCalledWith({
        lastSessionId: 'session-current',
      })
    })
  })

  it('boots the normal shell for a retired trace-window deep link', async () => {
    // Trace windows and `?traceSessionId=` deep links were removed with the
    // standalone Trace page; a stale URL must not hide the workspace shell.
    window.history.pushState({}, '', '/?traceWindow=1&traceSessionId=session-window')

    render(<AppShell />)

    await screen.findByText('sidebar loaded')
    await waitFor(() => expect(mocks.restoreTabs).toHaveBeenCalledTimes(1))
    expect(mocks.openTab).not.toHaveBeenCalled()
  })

  it('routes native menu navigation through the desktop host', async () => {
    let navigate: ((target: string) => void) | undefined
    const unlisten = vi.fn()
    const onNativeMenuNavigate = vi.fn((handler: (target: string) => void) => {
      navigate = handler
      return Promise.resolve(unlisten)
    })
    window.desktopHost = {
      isDesktop: true,
      window: {
        onNativeMenuNavigate,
      },
    } as any

    render(<AppShell />)

    await screen.findByText('sidebar loaded')
    await waitFor(() => expect(onNativeMenuNavigate).toHaveBeenCalledTimes(1))

    act(() => {
      navigate?.('about')
    })

    expect(useUIStore.getState().pendingSettingsTab).toBe('about')
    expect(mocks.openTab).toHaveBeenCalledWith('__settings__', 'Settings', 'settings')
  })

  it('restores an enabled pet window and routes pet session navigation', async () => {
    mocks.isTauriRuntime = true
    mocks.getDesktopUiPreferences.mockResolvedValueOnce({
      exists: true,
      preferences: {
        schemaVersion: 3,
        sidebar: {},
        profile: {},
        projectDisplayNames: {},
        pet: {
          enabled: true,
          selectedPetId: 'dada-code',
          size: 144,
          collapsed: false,
          motionEnabled: true,
          lastSessionId: 'session-pet',
        },
      },
    })
    const show = vi.fn().mockResolvedValue(undefined)
    let navigate: ((sessionId: string) => void) | undefined
    window.desktopHost = {
      isDesktop: true,
      pets: {
        show,
        onNavigateSession: vi.fn((handler: (sessionId: string) => void) => {
          navigate = handler
          return Promise.resolve(vi.fn())
        }),
      },
      window: {
        onNativeMenuNavigate: vi.fn().mockResolvedValue(vi.fn()),
      },
    } as any

    render(<AppShell />)

    await screen.findByText('sidebar loaded')
    await waitFor(() => expect(show).toHaveBeenCalledTimes(1))
    act(() => navigate?.('session-pet'))
    expect(mocks.openTab).toHaveBeenCalledWith('session-pet', 'Session', 'session')
    expect(mocks.connectToSession).toHaveBeenCalledWith('session-pet')
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

  it('hydrates project display names on a phone, where no sidebar mounts to do it', async () => {
    mocks.layout = 'phone'
    mocks.getDesktopUiPreferences.mockResolvedValueOnce({
      exists: true,
      preferences: {
        schemaVersion: 5,
        sidebar: {},
        profile: {},
        projectDisplayNames: { '/workspace/project': 'Mobile alias' },
        pet: {
          enabled: false,
          selectedPetId: 'dada-code',
          size: 144,
          collapsed: false,
          motionEnabled: true,
          lastSessionId: null,
        },
      },
    })

    render(<AppShell />)

    const shell = await screen.findByTestId('mobile-shell-stub')
    expect(shell).toHaveAttribute('data-layout', 'phone')
    // The phone list reads hidden projects from this request.
    expect(shell).toHaveAttribute('data-has-preferences', 'yes')
    expect(screen.queryByText('sidebar loaded')).not.toBeInTheDocument()
    expect(screen.queryByText('tabs loaded')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(resolveProjectDisplayName('/workspace/project')).toBe('Mobile alias')
    })
    expect(mocks.getDesktopUiPreferences).toHaveBeenCalledTimes(1)
  })

  it('hands a touch tablet to the mobile shell instead of the desktop chrome', async () => {
    mocks.layout = 'tablet'

    render(<AppShell />)

    expect(await screen.findByTestId('mobile-shell-stub')).toHaveAttribute('data-layout', 'tablet')
    expect(screen.queryByTestId('sidebar-shell')).not.toBeInTheDocument()
    expect(screen.queryByText('tabs loaded')).not.toBeInTheDocument()
  })

  it('keeps the sidebar, tab strip and resize handle on a desktop window', async () => {
    mocks.layout = 'desktop'

    render(<AppShell />)

    await screen.findByText('content loaded')
    expect(screen.getByText('sidebar loaded')).toBeInTheDocument()
    expect(screen.getByText('tabs loaded')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar-resize-handle')).toBeInTheDocument()
    expect(screen.queryByTestId('mobile-shell-stub')).not.toBeInTheDocument()
  })
})
