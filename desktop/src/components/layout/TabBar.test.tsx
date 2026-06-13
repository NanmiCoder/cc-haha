import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import type { PerSessionState } from '../../stores/chatStore'
import type { ChatState } from '../../types/chat'
import { browserHost } from '../../lib/desktopHost/browserHost'

const startDraggingMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const getCurrentWindowMock = vi.hoisted(() => vi.fn(() => ({
  startDragging: startDraggingMock,
})))
const windowControlsMock = vi.hoisted(() => ({
  show: true,
}))
const scrollIntoViewMock = vi.hoisted(() => vi.fn())
const openProjectMenuMock = vi.hoisted(() => ({
  paths: [] as Array<string | null | undefined>,
}))

function makeChatSession(chatState: ChatState): PerSessionState {
  return {
    messages: [],
    chatState,
    connectionState: 'connected',
    streamingText: '',
    streamingToolInput: '',
    activeToolUseId: null,
    activeToolName: null,
    activeThinkingId: null,
    pendingPermission: null,
    pendingComputerUsePermission: null,
    tokenUsage: { input_tokens: 0, output_tokens: 0 },
    elapsedSeconds: 0,
    statusVerb: '',
    slashCommands: [],
    agentTaskNotifications: {},
    backgroundAgentTasks: {},
    activeGoal: null,
    elapsedTimer: null,
    composerPrefill: null,
    composerDraft: null,
  }
}

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: getCurrentWindowMock,
}))

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string, params?: Record<string, string | number>) => {
    const translations: Record<string, string> = {
      'tabs.close': 'Close',
      'tabs.closeOthers': 'Close Others',
      'tabs.closeLeft': 'Close Left',
      'tabs.closeRight': 'Close Right',
      'tabs.closeAll': 'Close All',
      'tabs.closeConfirmTitle': 'Session Running',
      'tabs.closeConfirmMessage': 'Still running',
      'tabs.closeConfirmKeep': 'Keep Running',
      'tabs.closeConfirmStop': 'Stop & Close',
      'tabs.closeAllConfirmTitle': 'Sessions Running',
      'tabs.closeAllConfirmMessage': '{count} sessions still running',
      'tabs.closeAllConfirmStop': 'Stop All & Close',
      'tabs.sessionRunning': 'Session running',
      'tabs.openTerminal': 'Open Terminal',
      'tabs.showWorkspace': 'Show Workspace',
      'tabs.hideWorkspace': 'Hide Workspace',
      'tabs.showBrowser': 'Show Browser',
      'tabs.hideBrowser': 'Hide Browser',
      'openProject.openProject': 'Open project',
      'openProject.openIn': 'Open in {target}',
      'openProject.openFailed': 'Could not open project',
      'common.cancel': 'Cancel',
    }

    let text = translations[key] ?? key
    if (params) {
      for (const [paramKey, paramValue] of Object.entries(params)) {
        text = text.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), String(paramValue))
      }
    }
    return text
  },
}))

vi.mock('./OpenProjectMenu', () => ({
  OpenProjectMenu: ({ path }: { path: string | null | undefined }) => {
    if (!path) return null
    openProjectMenuMock.paths.push(path)
    return <div data-testid="open-project-menu">{path}</div>
  },
}))

vi.mock('./WindowControls', () => ({
  WindowControls: () => (windowControlsMock.show ? <div data-testid="window-controls" /> : null),
  get showWindowControls() {
    return windowControlsMock.show
  },
}))

describe('TabBar', () => {
  const installElectronDesktopHost = () => {
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: {
        ...browserHost.capabilities,
        windowControls: true,
      },
      window: {
        ...browserHost.window,
        startDragging: startDraggingMock,
      },
    }
  }

  beforeEach(() => {
    class ResizeObserverMock {
      constructor(_callback: ResizeObserverCallback) {}

      observe(_target: Element) {}

      disconnect() {}
      unobserve() {}
    }

    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      value: ResizeObserverMock,
    })

    Reflect.deleteProperty(window, '__TAURI__')
    installElectronDesktopHost()

    Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoViewMock,
    })

    startDraggingMock.mockClear()
    getCurrentWindowMock.mockClear()
    scrollIntoViewMock.mockClear()
    openProjectMenuMock.paths = []
    windowControlsMock.show = true
    vi.resetModules()
  })

  afterEach(async () => {
    cleanup()

    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useSessionStore } = await import('../../stores/sessionStore')
    const { useWorkspacePanelStore } = await import('../../stores/workspacePanelStore')
    const { useTerminalPanelStore } = await import('../../stores/terminalPanelStore')
    const { useBrowserPanelStore } = await import('../../stores/browserPanelStore')

    useTabStore.setState({ tabs: [], activeTabId: null })
    useChatStore.setState({
      sessions: {},
    } as Partial<ReturnType<typeof useChatStore.getState>>)
    useSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      isLoading: false,
      error: null,
      isBatchMode: false,
      selectedSessionIds: new Set(),
    } as Partial<ReturnType<typeof useSessionStore.getState>>)
    useWorkspacePanelStore.setState(useWorkspacePanelStore.getInitialState(), true)
    useTerminalPanelStore.setState(useTerminalPanelStore.getInitialState(), true)
    useBrowserPanelStore.setState(useBrowserPanelStore.getInitialState(), true)

    Reflect.deleteProperty(window, 'desktopHost')
    Reflect.deleteProperty(window, '__TAURI__')
  })

  it('scrolls the active tab into view when the active tab changes', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'First Session', type: 'session', status: 'idle' },
        { sessionId: 'tab-2', title: 'Second Session', type: 'session', status: 'idle' },
        { sessionId: 'tab-3', title: 'Third Session', type: 'session', status: 'idle' },
        { sessionId: 'tab-4', title: 'Fourth Session', type: 'session', status: 'idle' },
        { sessionId: 'tab-5', title: 'New Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })
    scrollIntoViewMock.mockClear()

    await act(async () => {
      useTabStore.getState().setActiveTab('tab-5')
    })

    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
      behavior: 'smooth',
    })
  })

  it('exposes the scroll region with overflow-x-auto and a hidden scrollbar', async () => {
    // Pins the CSS contract introduced when we enabled wheel scroll
    // on the tab strip: the strip MUST scroll natively
    // (overflow-x-auto) so vertical wheel input translated to
    // scrollLeft actually moves it, but the visible scrollbar MUST
    // stay hidden so the tab strip looks like a clean app chrome
    // surface (mirrors the look of native browser tab bars).
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [{ sessionId: 'tab-1', title: 'A', type: 'session', status: 'idle' }],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    const region = screen.getByTestId('tab-bar-scroll-region')
    expect(region).toHaveClass('overflow-x-auto')
    expect(region).toHaveClass('min-w-0')
    expect(region.className).toContain('[scrollbar-width:none]')
    expect(region.className).toContain('[&::-webkit-scrollbar]:hidden')
  })

  it('translates a vertical wheel into a horizontal scroll on the tab strip', async () => {
    // The desktop wheel-scroll affordance: hover the tab strip,
    // spin the mouse wheel, the strip moves horizontally. JSDOM's
    // scrollLeft writes are persistent on the element, so we can
    // assert directly on it.
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'A', type: 'session', status: 'idle' },
        { sessionId: 'tab-2', title: 'B', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })
    const region = screen.getByTestId('tab-bar-scroll-region')
    // Force the region into an "overflowing" geometry — JSDOM
    // doesn't lay things out, so scrollWidth defaults to 0 and the
    // handler short-circuits without our help.
    Object.defineProperty(region, 'scrollWidth', { configurable: true, value: 800 })
    Object.defineProperty(region, 'clientWidth', { configurable: true, value: 200 })
    region.scrollLeft = 0

    fireEvent.wheel(region, { deltaY: 120, deltaX: 0 })

    expect(region.scrollLeft).toBe(120)
  })

  it('passes horizontal wheel input through untouched (trackpad sideways swipe)', async () => {
    // Trackpad two-finger horizontal swipe already produces a
    // deltaX-dominated wheel event the browser scrolls natively.
    // We must NOT also mutate scrollLeft, or the strip jumps by 2x.
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'A', type: 'session', status: 'idle' },
        { sessionId: 'tab-2', title: 'B', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })
    const region = screen.getByTestId('tab-bar-scroll-region')
    Object.defineProperty(region, 'scrollWidth', { configurable: true, value: 800 })
    Object.defineProperty(region, 'clientWidth', { configurable: true, value: 200 })
    region.scrollLeft = 50

    fireEvent.wheel(region, { deltaY: 10, deltaX: 80 })

    // We did NOT add deltaY's 10 to scrollLeft — the deltaX-
    // dominated event was a pass-through.
    expect(region.scrollLeft).toBe(50)
  })

  it('keeps the overflow button flush against window controls on Windows', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'Untitled Session', type: 'session', status: 'idle' },
        { sessionId: 'tab-2', title: 'Settings', type: 'settings', status: 'idle' },
        { sessionId: 'tab-3', title: 'hello', type: 'session', status: 'idle' },
        { sessionId: 'tab-4', title: 'overflow', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    const scrollRegion = screen.getByTestId('tab-bar').querySelector('.overflow-x-auto')
    expect(scrollRegion).toBeInTheDocument()

    Object.defineProperty(scrollRegion!, 'clientWidth', {
      configurable: true,
      get: () => 240,
    })
    Object.defineProperty(scrollRegion!, 'scrollWidth', {
      configurable: true,
      get: () => 720,
    })
    Object.defineProperty(scrollRegion!, 'scrollLeft', {
      configurable: true,
      get: () => 0,
    })
    Object.defineProperty(scrollRegion!, 'scrollBy', {
      configurable: true,
      value: vi.fn(),
    })

    act(() => {
      fireEvent.scroll(scrollRegion!)
    })

    await waitFor(() => {
      expect(screen.getByTestId('window-controls')).toBeInTheDocument()
      expect(screen.getByText('chevron_right').closest('button')).toBeInTheDocument()
    })

    const rightButton = screen.getByText('chevron_right').closest('button')
    expect(rightButton?.nextElementSibling).toBe(screen.getByTestId('window-controls'))
  })

  it('shows the terminal toolbar when no tabs are open', async () => {
    windowControlsMock.show = false
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')

    useTabStore.setState({ tabs: [], activeTabId: null })

    await act(async () => {
      render(<TabBar />)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Open Terminal' }))

    const terminalTabs = useTabStore.getState().tabs.filter((tab) => tab.type === 'terminal')
    expect(terminalTabs).toHaveLength(1)
    expect(useTabStore.getState().activeTabId).toBe(terminalTabs[0]?.sessionId)
    expect(screen.queryByTestId('window-controls')).not.toBeInTheDocument()
  })

  it('marks the tab bar as a native drag region', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'Untitled Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    expect(screen.getByTestId('tab-bar')).toHaveAttribute('data-desktop-drag-region')
    expect(screen.getByTestId('tab-bar-scroll-region')).toHaveAttribute('data-desktop-drag-region')
    expect(screen.getByTestId('tab-bar-drag-gutter')).toHaveAttribute('data-desktop-drag-region')
    const tab = screen.getByText('Untitled Session').closest('.tab-bar-interactive')
    expect(tab).toBeInTheDocument()
    expect(tab).not.toHaveAttribute('data-desktop-drag-region')
  })

  it('keeps the desktop tab strip at a roomier titlebar height', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'Untitled Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    const tabBar = screen.getByTestId('tab-bar')
    const tab = screen.getByText('Untitled Session').closest('.tab-bar-interactive')

    expect(tabBar).toHaveClass('min-h-11')
    expect(tab).toHaveClass('min-h-11')
    expect(screen.getByTestId('tab-bar-drag-gutter')).toHaveClass('min-h-11')
  })

  it('passes the active session workdir into the open-project control', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useSessionStore } = await import('../../stores/sessionStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'Workspace Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)
    useSessionStore.setState({
      sessions: [{
        id: 'tab-1',
        title: 'Workspace Session',
        createdAt: '2026-05-13T00:00:00.000Z',
        modifiedAt: '2026-05-13T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/repo',
        workDir: '/repo/worktree',
        workDirExists: true,
      }],
      activeSessionId: 'tab-1',
    })

    await act(async () => {
      render(<TabBar />)
    })

    expect(screen.getByTestId('open-project-menu')).toHaveTextContent('/repo/worktree')
    expect(openProjectMenuMock.paths[openProjectMenuMock.paths.length - 1]).toBe('/repo/worktree')
  })

  it('does not rerender for chat payload changes when tab running state is unchanged', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useSessionStore } = await import('../../stores/sessionStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'Workspace Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {
        'tab-1': makeChatSession('idle'),
      },
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)
    useSessionStore.setState({
      sessions: [{
        id: 'tab-1',
        title: 'Workspace Session',
        createdAt: '2026-05-13T00:00:00.000Z',
        modifiedAt: '2026-05-13T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/repo',
        workDir: '/repo/worktree',
        workDirExists: true,
      }],
      activeSessionId: 'tab-1',
    })

    await act(async () => {
      render(<TabBar />)
    })
    expect(openProjectMenuMock.paths[openProjectMenuMock.paths.length - 1]).toBe('/repo/worktree')

    openProjectMenuMock.paths = []
    await act(async () => {
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          'tab-1': {
            ...state.sessions['tab-1']!,
            streamingText: 'token churn should not affect tab chrome',
          },
        },
      }))
    })

    expect(openProjectMenuMock.paths).toEqual([])
  })

  it('hides the open-project control when the active session workdir is unavailable', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useSessionStore } = await import('../../stores/sessionStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'Workspace Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)
    useSessionStore.setState({
      sessions: [{
        id: 'tab-1',
        title: 'Workspace Session',
        createdAt: '2026-05-13T00:00:00.000Z',
        modifiedAt: '2026-05-13T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/repo',
        workDir: '/repo/worktree',
        workDirExists: false,
      }],
      activeSessionId: 'tab-1',
    })

    await act(async () => {
      render(<TabBar />)
    })

    expect(screen.queryByTestId('open-project-menu')).not.toBeInTheDocument()
  })

  it('hides the open-project control outside the desktop shell', async () => {
    Reflect.deleteProperty(window, 'desktopHost')

    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useSessionStore } = await import('../../stores/sessionStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'Workspace Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)
    useSessionStore.setState({
      sessions: [{
        id: 'tab-1',
        title: 'Workspace Session',
        createdAt: '2026-05-13T00:00:00.000Z',
        modifiedAt: '2026-05-13T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/repo',
        workDir: '/repo/worktree',
        workDirExists: true,
      }],
      activeSessionId: 'tab-1',
    })

    await act(async () => {
      render(<TabBar />)
    })

    expect(screen.queryByTestId('open-project-menu')).not.toBeInTheDocument()
  })

  it('marks the empty tab-bar gutter as a native drag region without runtime dragging', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'Untitled Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    const scrollRegion = screen.getByTestId('tab-bar-scroll-region')
    expect(scrollRegion).toBeInTheDocument()
    expect(scrollRegion).toHaveAttribute('data-desktop-drag-region')

    fireEvent.mouseDown(scrollRegion)

    expect(startDraggingMock).not.toHaveBeenCalled()
  })

  it('does not start dragging when clicking a tab', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'Untitled Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    fireEvent.mouseDown(screen.getByText('Untitled Session'))

    expect(startDraggingMock).not.toHaveBeenCalled()
  })

  it('reorders tabs via pointer drag', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'First Session', type: 'session', status: 'idle' },
        { sessionId: 'tab-2', title: 'Second Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    expect(screen.getByTestId('tab-bar').querySelector('.tab-bar-interactive')).toBeInTheDocument()

    const firstTab = screen.getByText('First Session').closest('.tab-bar-interactive')
    const secondTab = screen.getByText('Second Session').closest('.tab-bar-interactive')

    expect(firstTab).toBeTruthy()
    expect(secondTab).toBeTruthy()

    Object.defineProperty(firstTab!, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, width: 180 }),
    })
    Object.defineProperty(secondTab!, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 180, width: 180 }),
    })

    fireEvent.mouseDown(firstTab!, { button: 0, clientX: 20, clientY: 10 })
    fireEvent.mouseMove(window, { clientX: 260, clientY: 10 })

    expect(firstTab).toHaveAttribute('data-dragging', 'true')

    fireEvent.mouseUp(window)

    expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual(['tab-2', 'tab-1'])
  })

  it('does not reorder on a simple click without dragging', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'First Session', type: 'session', status: 'idle' },
        { sessionId: 'tab-2', title: 'Second Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    const firstTab = screen.getByText('First Session').closest('.tab-bar-interactive')
    expect(firstTab).toBeTruthy()

    fireEvent.mouseDown(firstTab!, { button: 0, clientX: 20, clientY: 10 })
    fireEvent.mouseUp(window)
    fireEvent.click(firstTab!)

    expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual(['tab-1', 'tab-2'])
    expect(useTabStore.getState().activeTabId).toBe('tab-1')
  })

  it('closes a tab from the close button without activating drag behavior', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    const disconnectSession = vi.fn()

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'First Session', type: 'session', status: 'idle' },
        { sessionId: 'tab-2', title: 'Second Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-2',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession,
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    const firstTab = screen.getByText('First Session').closest('.tab-bar-interactive')
    const closeButton = screen.getByLabelText('Close First Session')

    expect(firstTab).toHaveClass('group')

    fireEvent.mouseDown(closeButton, { button: 0, clientX: 20, clientY: 10 })
    fireEvent.click(closeButton)
    fireEvent.mouseMove(window, { clientX: 260, clientY: 10 })
    fireEvent.mouseUp(window)

    expect(disconnectSession).toHaveBeenCalledWith('tab-1')
    expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual(['tab-2'])
    expect(useTabStore.getState().activeTabId).toBe('tab-2')
  })

  it('closes terminal tabs without disconnecting chat sessions', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    const disconnectSession = vi.fn()

    useTabStore.setState({
      tabs: [
        { sessionId: '__terminal__1', title: 'Terminal 1', type: 'terminal', status: 'idle' },
      ],
      activeTabId: '__terminal__1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession,
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    expect(screen.getByLabelText('Open Terminal')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Close Terminal 1'))

    expect(disconnectSession).not.toHaveBeenCalled()
    expect(useTabStore.getState().tabs).toEqual([])
  })

  it('opens the bottom terminal panel from the toolbar for an active session', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useTerminalPanelStore } = await import('../../stores/terminalPanelStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'First Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Open Terminal' }))

    const terminalTabs = useTabStore.getState().tabs.filter((tab) => tab.type === 'terminal')
    expect(terminalTabs).toHaveLength(0)
    expect(useTerminalPanelStore.getState().isPanelOpen('tab-1')).toBe(true)
  })

  it('treats legacy session tabs without a type as bottom-panel terminal targets', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useTerminalPanelStore } = await import('../../stores/terminalPanelStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'legacy-session', title: 'Legacy Session', status: 'idle' } as ReturnType<typeof useTabStore.getState>['tabs'][number],
      ],
      activeTabId: 'legacy-session',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Open Terminal' }))

    expect(useTabStore.getState().tabs.some((tab) => tab.type === 'terminal')).toBe(false)
    expect(useTerminalPanelStore.getState().isPanelOpen('legacy-session')).toBe(true)
  })

  it('toggles the workspace panel for the active session from the toolbar', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useWorkspacePanelStore } = await import('../../stores/workspacePanelStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'First Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Show Workspace' }))
    expect(useWorkspacePanelStore.getState().isPanelOpen('tab-1')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Hide Workspace' }))
    expect(useWorkspacePanelStore.getState().isPanelOpen('tab-1')).toBe(false)
  })

  it('does not render a browser toolbar button for session tabs', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'First Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    expect(screen.queryByRole('button', { name: 'Show Browser' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Hide Browser' })).not.toBeInTheDocument()
  })

  it('hides the browser toolbar button for non-session tabs', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: '__terminal__1', title: 'Terminal 1', type: 'terminal', status: 'idle' },
        { sessionId: '__settings__', title: 'Settings', type: 'settings', status: 'idle' },
      ],
      activeTabId: '__terminal__1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    const { rerender } = render(<TabBar />)

    expect(screen.queryByRole('button', { name: 'Show Browser' })).not.toBeInTheDocument()

    await act(async () => {
      useTabStore.getState().setActiveTab('__settings__')
    })
    rerender(<TabBar />)

    expect(screen.queryByRole('button', { name: 'Show Browser' })).not.toBeInTheDocument()
  })

  it('hides the workspace toolbar button for non-session tabs', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: '__terminal__1', title: 'Terminal 1', type: 'terminal', status: 'idle' },
        { sessionId: '__settings__', title: 'Settings', type: 'settings', status: 'idle' },
      ],
      activeTabId: '__terminal__1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    const { rerender } = render(<TabBar />)

    expect(screen.queryByRole('button', { name: 'Show Workspace' })).not.toBeInTheDocument()

    await act(async () => {
      useTabStore.getState().setActiveTab('__settings__')
    })
    rerender(<TabBar />)

    expect(screen.queryByRole('button', { name: 'Show Workspace' })).not.toBeInTheDocument()
  })

  it('clears session panel state when closing a session tab', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useWorkspacePanelStore } = await import('../../stores/workspacePanelStore')
    const { useTerminalPanelStore } = await import('../../stores/terminalPanelStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-1', title: 'First Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-1',
    })
    useChatStore.setState({
      sessions: {},
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)
    useWorkspacePanelStore.getState().openPanel('tab-1')
    useTerminalPanelStore.getState().openPanel('tab-1')

    await act(async () => {
      render(<TabBar />)
    })

    fireEvent.click(screen.getByLabelText('Close First Session'))

    expect(useWorkspacePanelStore.getState().panelBySession['tab-1']).toBeUndefined()
    expect(useTerminalPanelStore.getState().panelBySession['tab-1']).toBeUndefined()
  })

  it('asks before stopping running sessions when closing all tabs', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    const disconnectSession = vi.fn()
    const stopGeneration = vi.fn()

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-running', title: 'Running Session', type: 'session', status: 'running' },
        { sessionId: 'tab-thinking', title: 'Thinking Session', type: 'session', status: 'running' },
        { sessionId: 'tab-idle', title: 'Idle Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-running',
    })
    useChatStore.setState({
      sessions: {
        'tab-running': makeChatSession('streaming'),
        'tab-thinking': makeChatSession('thinking'),
        'tab-idle': makeChatSession('idle'),
      },
      disconnectSession,
      stopGeneration,
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    fireEvent.contextMenu(screen.getByText('Running Session'))
    fireEvent.click(screen.getByText('Close All'))

    expect(screen.getByText('Sessions Running')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Sessions Running' })).toBeInTheDocument()
    expect(screen.getByText('2 sessions still running')).toBeInTheDocument()
    expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual(['tab-running', 'tab-thinking', 'tab-idle'])
    expect(disconnectSession).not.toHaveBeenCalled()
    expect(stopGeneration).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Stop All & Close'))

    expect(stopGeneration).toHaveBeenCalledWith('tab-running')
    expect(stopGeneration).toHaveBeenCalledWith('tab-thinking')
    expect(stopGeneration).toHaveBeenCalledTimes(2)
    expect(disconnectSession).toHaveBeenCalledWith('tab-running')
    expect(disconnectSession).toHaveBeenCalledWith('tab-thinking')
    expect(disconnectSession).toHaveBeenCalledWith('tab-idle')
    expect(useTabStore.getState().tabs).toEqual([])
  })

  it('shows a running marker on tabs from tab status or live chat state', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')

    useTabStore.setState({
      tabs: [
        { sessionId: 'tab-status-running', title: 'Status Running', type: 'session', status: 'running' },
        { sessionId: 'tab-chat-running', title: 'Chat Running', type: 'session', status: 'idle' },
        { sessionId: 'tab-idle', title: 'Idle', type: 'session', status: 'idle' },
      ],
      activeTabId: 'tab-status-running',
    })
    useChatStore.setState({
      sessions: {
        'tab-status-running': makeChatSession('idle'),
        'tab-chat-running': makeChatSession('thinking'),
        'tab-idle': makeChatSession('idle'),
      },
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    await act(async () => {
      render(<TabBar />)
    })

    expect(screen.getAllByLabelText('Session running')).toHaveLength(2)
    expect(screen.getByText('Idle').closest('[data-dragging]')?.querySelector('[aria-label="Session running"]')).toBeNull()
  })
})
