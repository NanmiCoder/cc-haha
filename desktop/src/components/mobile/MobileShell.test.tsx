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
  EmptySession: ({ mobileHome }: { mobileHome?: ReactNode }) => (
    <div>
      {mobileHome}
      <div>new task composer</div>
    </div>
  ),
}))

vi.mock('../layout/UpdateChecker', () => ({ UpdateChecker: () => null }))
vi.mock('../layout/Toast', () => ({ ToastContainer: () => null }))

import { MobileShell } from './MobileShell'

class TestPointerEvent extends MouseEvent {
  pointerType: string
  isPrimary: boolean
  constructor(type: string, init: MouseEventInit & { pointerType?: string; isPrimary?: boolean } = {}) {
    super(type, init)
    this.pointerType = init.pointerType ?? 'touch'
    this.isPrimary = init.isPrimary ?? true
  }
}

function session(id: string, title: string, minutesAgo = 5): SessionListItem {
  const modifiedAt = new Date(Date.now() - minutesAgo * 60_000).toISOString()
  return {
    id,
    title,
    createdAt: modifiedAt,
    modifiedAt,
    messageCount: 3,
    projectPath: '/work/cc-haha',
    projectRoot: '/work/cc-haha',
    workDir: '/work/cc-haha',
    workDirExists: true,
  }
}

const connectToSession = vi.fn()
const disconnectSession = vi.fn()
const renameSession = vi.fn(async () => undefined)
const deleteSession = vi.fn(async () => undefined)

function seed({ tabs = [], activeTabId = null }: { tabs?: Tab[]; activeTabId?: string | null } = {}) {
  useTabStore.setState({ tabs, activeTabId })
  useSessionStore.setState({
    sessions: [session('s-login', 'Fix login i18n'), session('s-release', 'Draft release notes', 90)],
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
    expect(screen.getByText('new task composer')).toBeInTheDocument()
    expect(screen.queryByTestId('mobile-top-bar')).not.toBeInTheDocument()
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
