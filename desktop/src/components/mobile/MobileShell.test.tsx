import { useContext, type ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTabStore, type Tab } from '../../stores/tabStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useChatStore } from '../../stores/chatStore'
import { useActivityPanelStore } from '../../stores/activityPanelStore'
import type { SessionListItem } from '../../types/session'
import { LONG_PRESS_DELAY_MS } from '../../hooks/useLongPress'

const mocks = vi.hoisted(() => ({
  live: [] as Array<{ id: string; activityState: 'running' | 'waiting' }>,
}))

vi.mock('../../api/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/sessions')>()
  return {
    ...actual,
    sessionsApi: {
      ...actual.sessionsApi,
      getLiveStatus: vi.fn(async () => ({ sessions: mocks.live })),
    },
  }
})

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

// The router mounts real chat pages; the shell's job is only to choose between
// home and a page and to frame the page, so a stub that shows which it chose
// is enough here.
vi.mock('../layout/ContentRouter', () => ({
  ContentRouter: ({ homePage }: { homePage?: ReactNode }) => {
    const activeTabId = useTabStore((state) => state.activeTabId)
    const settingsShell = useContext(H5SettingsShellContext)
    if (!activeTabId) return <>{homePage ?? <div>desktop new-session page</div>}</>
    if (activeTabId === '__settings__' && settingsShell) {
      return (
        <div data-testid="routed-page" data-subpage={settingsShell.subpage ?? ''}>
          <button type="button" onClick={() => settingsShell.setSubpage('providers')}>
            open providers
          </button>
        </div>
      )
    }
    return <div data-testid="routed-page">page for {activeTabId}</div>
  },
}))

vi.mock('../../pages/EmptySession', () => ({
  EmptySession: ({ initialWorkDir }: { initialWorkDir?: string }) => (
    <div data-testid="new-task-page">new task in {initialWorkDir || '(no project)'}</div>
  ),
}))

vi.mock('../layout/UpdateChecker', () => ({ UpdateChecker: () => null }))
vi.mock('../layout/Toast', () => ({ ToastContainer: () => null }))

import { MobileShell } from './MobileShell'
import { SHEET_DISMISS_DISTANCE_PX } from './MobileNewTaskSheet'
import { H5SettingsShellContext } from '../../pages/settings/H5Settings'

class TestPointerEvent extends MouseEvent {
  pointerType: string
  isPrimary: boolean
  constructor(type: string, init: MouseEventInit & { pointerType?: string; isPrimary?: boolean } = {}) {
    super(type, init)
    this.pointerType = init.pointerType ?? 'touch'
    this.isPrimary = init.isPrimary ?? true
  }
}

function session(id: string, title: string, minutesAgo = 5, project = '/work/cc-haha'): SessionListItem {
  const modifiedAt = new Date(Date.now() - minutesAgo * 60_000).toISOString()
  return {
    id,
    title,
    createdAt: modifiedAt,
    modifiedAt,
    messageCount: 3,
    projectPath: project,
    projectRoot: project,
    workDir: project,
    workDirExists: true,
  }
}

const connectToSession = vi.fn()
const disconnectSession = vi.fn()
const renameSession = vi.fn(async () => undefined)
const deleteSession = vi.fn(async () => undefined)

function seed({
  tabs = [],
  activeTabId = null,
  sessions = [session('s-login', 'Fix login i18n'), session('s-release', 'Draft release notes', 90)],
}: { tabs?: Tab[]; activeTabId?: string | null; sessions?: SessionListItem[] } = {}) {
  useTabStore.setState({ tabs, activeTabId })
  useSessionStore.setState({
    sessions,
    isLoading: false,
    error: null,
    fetchSessions: vi.fn(async () => undefined),
    renameSession,
    deleteSession,
  })
  useChatStore.setState({ sessions: {}, connectToSession, disconnectSession })
}

function renderShell(layout: 'phone' | 'tablet' = 'phone') {
  return render(<MobileShell layout={layout} preferencesRequest={null} />)
}

describe('MobileShell', () => {
  beforeAll(() => {
    if (!('PointerEvent' in window)) {
      Object.defineProperty(window, 'PointerEvent', { configurable: true, value: TestPointerEvent })
    }
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.live = []
    window.history.replaceState(null, '', '/')
    seed()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens on the session list, with sessions waiting elsewhere listed first', async () => {
    mocks.live = [{ id: 's-release', activityState: 'waiting' }]
    renderShell()

    const list = await screen.findByTestId('mobile-session-list')
    await waitFor(() => {
      expect(within(list).getAllByRole('heading')[0]).toHaveTextContent('mobile.group.attention')
    })
    const sections = within(list).getAllByRole('region')
    expect(within(sections[0]!).getByText('Draft release notes')).toBeInTheDocument()
    // Home is the list alone; a new task is one tap away, not a composer.
    expect(screen.queryByTestId('new-task-page')).not.toBeInTheDocument()
    expect(screen.getByTestId('mobile-new-task')).toHaveTextContent('mobile.home.newTask')
    expect(screen.queryByTestId('mobile-top-bar')).not.toBeInTheDocument()
  })

  it('keeps a viewed archived session out of the mobile default list and project filters', async () => {
    seed({ sessions: [session('active', 'Active conversation'), { ...session('archived', 'Archived conversation', 90, '/work/archive-only'), archived: true }] })
    renderShell()
    expect(await screen.findByText('Active conversation')).toBeInTheDocument()
    expect(screen.queryByText('Archived conversation')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'archive-only' })).not.toBeInTheDocument()
  })

  it('opens a new task over the list in the filtered project, and the back gesture closes it', async () => {
    seed({
      sessions: [
        session('s-login', 'Fix login i18n'),
        session('s-crawl', 'Export comments', 60, '/work/media-crawler'),
      ],
    })
    renderShell()

    fireEvent.click(await screen.findByRole('button', { name: 'media-crawler' }))
    fireEvent.click(screen.getByTestId('mobile-new-task'))

    const sheet = screen.getByTestId('mobile-new-task-sheet')
    expect(within(sheet).getByRole('dialog', { name: 'mobile.newTask.title' })).toBeInTheDocument()
    expect(within(sheet).getByTestId('new-task-page')).toHaveTextContent('new task in /work/media-crawler')
    // The list stays underneath, and the sheet is a level the system back leaves.
    expect(screen.getByTestId('mobile-session-list')).toBeInTheDocument()
    expect(window.history.state).toEqual({ ccHahaMobileGuard: true })

    act(() => { window.history.back() })

    await waitFor(() => expect(screen.queryByTestId('mobile-new-task-sheet')).not.toBeInTheDocument())
    expect(useTabStore.getState().activeTabId).toBeNull()
    expect(window.history.state).toBeNull()
  })

  it('starts a new task in the project of the newest task when no filter is picked', async () => {
    seed({
      sessions: [
        // Touched most recently, but started long ago.
        { ...session('s-old', 'Long running refactor', 600, '/work/legacy'), modifiedAt: new Date().toISOString() },
        session('s-new', 'Export comments', 30, '/work/media-crawler'),
      ],
    })
    renderShell()

    fireEvent.click(await screen.findByTestId('mobile-new-task'))

    expect(screen.getByTestId('new-task-page')).toHaveTextContent('new task in /work/media-crawler')
  })

  it('closes the new task with Cancel or a long enough pull on its bar', async () => {
    renderShell()

    fireEvent.click(await screen.findByTestId('mobile-new-task'))
    fireEvent.click(within(screen.getByTestId('mobile-new-task-sheet')).getByRole('button', { name: 'common.cancel' }))
    await waitFor(() => expect(screen.queryByTestId('mobile-new-task-sheet')).not.toBeInTheDocument())

    fireEvent.click(screen.getByTestId('mobile-new-task'))
    const grabber = screen.getByTestId('mobile-new-task-grabber')
    // A small nudge springs back.
    fireEvent.pointerDown(grabber, { clientY: 100 })
    fireEvent.pointerMove(grabber, { clientY: 115 })
    fireEvent.pointerUp(grabber, { clientY: 115 })
    // Closing goes through history.back(), which lands a tick later: wait it out.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
    expect(screen.getByTestId('mobile-new-task-sheet')).toBeInTheDocument()
    expect(window.history.state).toEqual({ ccHahaMobileGuard: true })

    fireEvent.pointerDown(grabber, { clientY: 100 })
    fireEvent.pointerMove(grabber, { clientY: 100 + SHEET_DISMISS_DISTANCE_PX + 10 })
    fireEvent.pointerUp(grabber, { clientY: 100 + SHEET_DISMISS_DISTANCE_PX + 10 })
    await waitFor(() => expect(screen.queryByTestId('mobile-new-task-sheet')).not.toBeInTheDocument())
    expect(window.history.state).toBeNull()
  })

  it('swaps the new task for the session it started, with Back going to the list', async () => {
    renderShell()
    fireEvent.click(await screen.findByTestId('mobile-new-task'))

    // What sending does: open the new session's tab.
    act(() => useTabStore.getState().openTab('s-started', 'New Session'))

    expect(screen.queryByTestId('mobile-new-task-sheet')).not.toBeInTheDocument()
    expect(screen.getByTestId('routed-page')).toHaveTextContent('page for s-started')
    expect(window.history.state).toEqual({ ccHahaMobileGuard: true })

    fireEvent.click(screen.getByTestId('mobile-back'))

    await waitFor(() => expect(useTabStore.getState().activeTabId).toBeNull())
    expect(screen.queryByTestId('mobile-new-task-sheet')).not.toBeInTheDocument()
    expect(screen.getByTestId('mobile-session-list')).toBeInTheDocument()
  })

  it('goes into a session and comes back with the Back button', async () => {
    renderShell()

    fireEvent.click(await screen.findByText('Fix login i18n'))

    expect(connectToSession).toHaveBeenCalledWith('s-login')
    expect(screen.getByTestId('routed-page')).toHaveTextContent('page for s-login')
    expect(screen.getByTestId('mobile-top-bar')).toHaveTextContent('Fix login i18n')
    expect(window.history.state).toEqual({ ccHahaMobileGuard: true })

    fireEvent.click(screen.getByTestId('mobile-back'))

    await waitFor(() => expect(useTabStore.getState().activeTabId).toBeNull())
    expect(screen.getByTestId('mobile-session-list')).toBeInTheDocument()
  })

  it('lets the system back gesture leave a detail page for its session', async () => {
    const tabs: Tab[] = [
      { sessionId: 's-login', title: 'Fix login i18n', type: 'session', status: 'idle' },
      {
        sessionId: '__subagent__s-login:tool-1',
        title: 'Explore the H5 shell',
        type: 'subagent',
        status: 'idle',
        sourceSessionId: 's-login',
        subagentToolUseId: 'tool-1',
      },
    ]
    seed({ tabs, activeTabId: '__subagent__s-login:tool-1' })
    renderShell()

    expect(screen.getByTestId('mobile-top-bar')).toHaveTextContent('Explore the H5 shell')

    act(() => { window.history.back() })

    await waitFor(() => expect(useTabStore.getState().activeTabId).toBe('s-login'))
    expect(useTabStore.getState().tabs.some((tab) => tab.type === 'subagent')).toBe(false)
    // Still above home, so the next back must be caught too.
    await waitFor(() => expect(window.history.state).toEqual({ ccHahaMobileGuard: true }))
  })

  it('sends a desktop-only tab home instead of showing a blank frame', async () => {
    seed({
      tabs: [{ sessionId: '__terminal__1', title: 'Terminal', type: 'terminal', status: 'idle' }],
      activeTabId: '__terminal__1',
    })
    renderShell()

    await waitFor(() => expect(useTabStore.getState().activeTabId).toBeNull())
    expect(useTabStore.getState().tabs).toHaveLength(1)
  })

  it('keeps the list beside the session on a tablet, without a Back for it', async () => {
    seed({
      tabs: [{ sessionId: 's-login', title: 'Fix login i18n', type: 'session', status: 'idle' }],
      activeTabId: 's-login',
    })
    renderShell('tablet')

    const pane = screen.getByTestId('mobile-tablet-pane')
    const row = await within(pane).findByText('Fix login i18n')
    expect(row.closest('button')).toHaveAttribute('aria-current', 'true')
    expect(screen.getByTestId('mobile-top-bar')).toHaveTextContent('Fix login i18n')
    expect(screen.queryByTestId('mobile-back')).not.toBeInTheDocument()
  })

  it('shows a new task beside the list on a tablet instead of a sheet over it', async () => {
    seed({
      tabs: [{ sessionId: 's-login', title: 'Fix login i18n', type: 'session', status: 'idle' }],
      activeTabId: 's-login',
    })
    renderShell('tablet')
    const pane = screen.getByTestId('mobile-tablet-pane')
    await within(pane).findByText('Fix login i18n')

    fireEvent.click(within(pane).getByTestId('mobile-new-task'))

    expect(useTabStore.getState().activeTabId).toBeNull()
    expect(screen.getByTestId('new-task-page')).toHaveTextContent('new task in /work/cc-haha')
    expect(screen.queryByTestId('mobile-new-task-sheet')).not.toBeInTheDocument()
  })

  it('puts the parallel work behind a pill in the session bar, once there is some', async () => {
    seed({
      tabs: [{ sessionId: 's-login', title: 'Fix login i18n', type: 'session', status: 'idle' }],
      activeTabId: 's-login',
    })
    renderShell()
    expect(screen.queryByTestId('mobile-activity-pill')).not.toBeInTheDocument()

    act(() => useActivityPanelStore.getState().setMobileSummary('s-login', { visible: true, count: 3 }))
    const pill = screen.getByTestId('mobile-activity-pill')
    expect(pill).toHaveTextContent('mobile.activity.inProgress:{"count":3}')

    fireEvent.click(pill)
    expect(useActivityPanelStore.getState().isOpen('s-login')).toBe(true)
    act(() => useActivityPanelStore.getState().close())
  })

  it('renames a session from the press-and-hold sheet', async () => {
    renderShell()
    const row = (await screen.findByText('Fix login i18n')).closest('button')!

    vi.useFakeTimers()
    fireEvent.pointerDown(row, { pointerType: 'touch', isPrimary: true, clientX: 5, clientY: 5 })
    act(() => { vi.advanceTimersByTime(LONG_PRESS_DELAY_MS) })
    fireEvent.pointerUp(row)
    fireEvent.click(row)
    vi.useRealTimers()

    // The press opened the sheet, not the session underneath it.
    expect(useTabStore.getState().activeTabId).toBeNull()
    const sheet = screen.getByTestId('mobile-session-actions')
    fireEvent.click(within(sheet).getByRole('menuitem', { name: 'common.rename' }))

    const field = within(screen.getByTestId('mobile-session-rename')).getByRole('textbox')
    fireEvent.change(field, { target: { value: 'Login copy in five languages' } })
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }))

    await waitFor(() => expect(renameSession).toHaveBeenCalledWith('s-login', 'Login copy in five languages'))
  })

  it('deletes a session after confirming, and lets go of its socket and tab', async () => {
    seed({ tabs: [{ sessionId: 's-login', title: 'Fix login i18n', type: 'session', status: 'idle' }] })
    renderShell()
    const row = (await screen.findByText('Fix login i18n')).closest('button')!

    fireEvent.contextMenu(row)
    fireEvent.click(within(screen.getByTestId('mobile-session-actions')).getByRole('menuitem', { name: 'common.delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }))

    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith('s-login'))
    await waitFor(() => expect(disconnectSession).toHaveBeenCalledWith('s-login'))
    expect(useTabStore.getState().tabs).toHaveLength(0)
  })

  it('applies V6C ambient shell, glass chrome, raised selected row with active bar, and 16px sheet top', async () => {
    seed({
      tabs: [{ sessionId: 's-login', title: 'Fix login i18n', type: 'session', status: 'idle' }],
      activeTabId: 's-login',
    })
    const { unmount } = renderShell('tablet')

    const shell = screen.getByTestId('mobile-shell')
    expect(shell).toHaveClass('v6c-ambient-shell')
    expect(screen.getByTestId('mobile-tablet-pane')).toHaveClass('v6c-sidebar-glass')
    expect(shell.querySelector('#content-area')).toHaveClass('v6c-main-canvas')

    const topBar = screen.getByTestId('mobile-top-bar')
    expect(topBar).toHaveClass('surface-glass')

    const selectedRow = (await within(screen.getByTestId('mobile-tablet-pane')).findByText('Fix login i18n')).closest('button')!
    expect(selectedRow).toHaveClass('v6c-raised', 'v6c-active-bar', 'rounded-[var(--radius-control)]')

    act(() => useActivityPanelStore.getState().setMobileSummary('s-login', { visible: true, count: 2 }))
    const pill = screen.getByTestId('mobile-activity-pill')
    expect(pill).toHaveClass('h-11', 'rounded-[var(--radius-control)]')
    expect(pill.firstElementChild).toHaveClass('v6c-raised', 'rounded-[var(--radius-control)]')
    expect(pill.firstElementChild).not.toHaveClass('v6c-ring-running')
    expect(pill.querySelector('.codex-shimmer-text')).toHaveClass('font-medium')
    act(() => useActivityPanelStore.getState().close())

    // Tablet pane sticky headers sit on the sidebar ground with a bottom hairline.
    const paneHeaders = within(screen.getByTestId('mobile-tablet-pane')).getAllByRole('heading', { level: 2 })
    expect(paneHeaders[0]).toHaveClass('bg-[var(--color-surface-sidebar)]', 'border-b', 'border-[var(--color-border)]')
    expect(paneHeaders[0]).not.toHaveClass('bg-[var(--color-surface-glass)]')

    unmount()

    // Phone layout: check sticky home header ground, flat attention group, idle dot suppression,
    // quiet filter chips, V6C send-style FAB, and 16px sheet top.
    mocks.live = [{ id: 's-release', activityState: 'waiting' }]
    seed({
      tabs: [],
      activeTabId: null,
      sessions: [
        session('s-login', 'Fix login i18n'),
        session('s-release', 'Draft release notes', 90, '/work/media-crawler'),
      ],
    })
    renderShell('phone')

    const list = await screen.findByTestId('mobile-session-list')
    await waitFor(() => {
      expect(within(list).getAllByRole('heading')[0]).toHaveTextContent('mobile.group.attention')
    })
    const homeHeaders = within(list).getAllByRole('heading', { level: 2 })
    expect(homeHeaders[0]).toHaveClass('bg-[var(--color-surface)]', 'border-b', 'border-[var(--color-border)]')
    expect(homeHeaders[0]).not.toHaveClass('bg-[var(--color-surface-glass)]')

    // Attention group renders flat rows without a heavy boxed wrapper; idle rows omit neutral dots.
    const attentionList = homeHeaders[0]!.nextElementSibling!
    expect(attentionList).not.toHaveClass('v6c-ring-waiting', 'bg-[var(--color-surface-glass)]')
    const waitingRow = within(list).getByText('Draft release notes').closest('button')!
    expect(within(waitingRow).getByRole('img', { name: 'mobile.session.waiting' })).toBeInTheDocument()
    const idleRow = within(list).getByText('Fix login i18n').closest('button')!
    expect(idleRow.querySelector('[data-status-dot]')).toBeNull()
    expect(within(idleRow).queryByRole('img')).toBeNull()

    // Filter chips: V6C radius-sm, active raised, inactive transparent ghost.
    const allChip = screen.getByRole('button', { name: 'mobile.home.allProjects' })
    const inactiveChip = screen.getByRole('button', { name: 'media-crawler' })
    expect(allChip).toHaveClass('rounded-[var(--radius-sm)]', 'v6c-raised')
    expect(inactiveChip).toHaveClass('rounded-[var(--radius-sm)]', 'bg-transparent', 'border-[var(--color-border)]')
    expect(inactiveChip).not.toHaveClass('bg-[var(--color-surface-glass)]')

    // Floating New task FAB uses V6C send-btn + radius-control + overlay shadow.
    const fab = screen.getByTestId('mobile-new-task')
    expect(fab).toHaveClass('v6c-send-btn', 'rounded-[var(--radius-control)]', 'shadow-[var(--shadow-overlay)]')

    fireEvent.click(fab)
    const dialog = within(screen.getByTestId('mobile-new-task-sheet')).getByRole('dialog', { name: 'mobile.newTask.title' })
    expect(dialog).toHaveClass('rounded-t-[var(--radius-2xl)]')
  })

  it('reuses MobileTopBar for H5Settings subpages and steps back to settings before leaving to home', async () => {
    seed({
      tabs: [{ sessionId: '__settings__', title: 'Settings', type: 'settings', status: 'idle' }],
      activeTabId: '__settings__',
    })
    renderShell('phone')

    expect(screen.getByTestId('mobile-top-bar')).toHaveTextContent('sidebar.settings')
    fireEvent.click(screen.getByRole('button', { name: 'open providers' }))

    expect(screen.getByTestId('mobile-top-bar')).toHaveTextContent('settings.tab.providers')
    expect(screen.getByTestId('mobile-back')).toHaveAttribute('aria-label', 'h5Settings.allSettings')

    fireEvent.click(screen.getByTestId('mobile-back'))
    await waitFor(() => expect(screen.getByTestId('mobile-top-bar')).toHaveTextContent('sidebar.settings'))
    expect(useTabStore.getState().activeTabId).toBe('__settings__')

    fireEvent.click(screen.getByTestId('mobile-back'))
    await waitFor(() => expect(useTabStore.getState().activeTabId).toBeNull())
  })
})
