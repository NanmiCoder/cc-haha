import type { ReactNode } from 'react'
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
    if (!activeTabId) return <>{homePage ?? <div>desktop new-session page</div>}</>
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
})
