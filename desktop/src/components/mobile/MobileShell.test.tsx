import { useEffect } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@/stores/uiStore'
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

// Navigation tests isolate chat rendering; browser smoke uses the real router.
vi.mock('../layout/ContentRouter', () => ({
  ContentRouter: () => {
    const activeTabId = useTabStore(state => state.activeTabId)
    const draft = useUIStore(state => state.newSessionDraft)
    useEffect(() => {
      if (!activeTabId && !draft) useUIStore.getState().startNewSessionDraft()
    }, [activeTabId, draft])
    return activeTabId
      ? <div data-testid="routed-page">page for {activeTabId}</div>
      : <div data-testid="new-task-page">new task in {draft?.workDir || '(no project)'}</div>
  },
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
    if (!('PointerEvent' in window)) Object.defineProperty(window, 'PointerEvent', { configurable: true, value: TestPointerEvent })
  })
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.live = []
    window.history.replaceState(null, '', '/')
    useUIStore.setState({ newSessionDraft: null })
    seed()
  })
  afterEach(() => { vi.useRealTimers() })

  const openDrawer = () => fireEvent.click(screen.getByTestId('mobile-open-sessions'))
  const nativeBack = () => {
    let handled: boolean | undefined
    act(() => { handled = window.__CC_HAHA_MOBILE_NAVIGATE_BACK__?.() })
    return handled
  }
  const seedChat = (project = '/work/current-project') => seed({
    tabs: [{ sessionId: 's-login', title: 'Fix login i18n', type: 'session', status: 'idle' }],
    activeTabId: 's-login',
    sessions: [session('s-login', 'Fix login i18n', 60, project), session('s-newer', 'Another project')],
  })

  it('starts on a full-page composer instead of making the session list the phone home', () => {
    renderShell()
    expect(screen.queryByTestId('mobile-session-list')).not.toBeInTheDocument()
    expect(screen.getByTestId('mobile-open-sessions')).toBeInTheDocument()
    expect(screen.getByTestId('new-task-page')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(nativeBack()).toBe(false)
  })

  it('keeps a viewed archived session out of the mobile default list and project filters', async () => {
    seed({ sessions: [session('active', 'Active conversation'), { ...session('archived', 'Archived conversation', 90, '/work/archive-only'), archived: true }] })
    renderShell()
    openDrawer()
    expect(await screen.findByText('Active conversation')).toBeInTheDocument()
    expect(screen.queryByText('Archived conversation')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'archive-only' })).not.toBeInTheDocument()
  })

  it('opens sessions beside the retained conversation without clearing its active tab', () => {
    seedChat()
    renderShell()
    openDrawer()
    expect(screen.getByTestId('mobile-session-drawer')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-session-drawer-panel')).toHaveClass('w-[min(86vw,340px)]')
    expect(useTabStore.getState().activeTabId).toBe('s-login')
    expect(screen.getByTestId('routed-page')).toHaveTextContent('page for s-login')
    expect(connectToSession).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Fix login i18n/ })).toHaveAttribute('aria-current', 'true')
  })

  it('closes the drawer on native Back and reports chat root without returning to pairing', async () => {
    seedChat()
    renderShell()
    expect(nativeBack()).toBe(false)
    openDrawer()
    expect(nativeBack()).toBe(true)
    expect(screen.queryByTestId('mobile-session-drawer')).not.toBeInTheDocument()
    expect(useTabStore.getState().activeTabId).toBe('s-login')
    await waitFor(() => expect(window.history.state).toBeNull())
    expect(nativeBack()).toBe(false)
  })

  it('closes navigation with browser Back without releasing the selected chat', async () => {
    seedChat()
    renderShell()
    openDrawer()
    act(() => window.history.back())
    await waitFor(() => expect(screen.queryByTestId('mobile-session-drawer')).not.toBeInTheDocument())
    expect(useTabStore.getState().activeTabId).toBe('s-login')
    expect(disconnectSession).not.toHaveBeenCalled()
  })

  it('closes the drawer when selecting the current row without reconnecting it', async () => {
    seedChat()
    renderShell()
    openDrawer()
    fireEvent.click(await screen.findByRole('button', { name: /Fix login i18n/ }))
    expect(screen.queryByTestId('mobile-session-drawer')).not.toBeInTheDocument()
    expect(connectToSession).not.toHaveBeenCalled()
    expect(useTabStore.getState().activeTabId).toBe('s-login')
    await waitFor(() => expect(window.history.state).toBeNull())
  })

  it('selects another session and closes navigation', async () => {
    renderShell()
    openDrawer()
    fireEvent.click(await screen.findByRole('button', { name: /Fix login i18n/ }))
    expect(screen.queryByTestId('mobile-session-drawer')).not.toBeInTheDocument()
    expect(screen.getByTestId('routed-page')).toHaveTextContent('page for s-login')
    expect(connectToSession).toHaveBeenCalledTimes(1)
    expect(connectToSession).toHaveBeenCalledWith('s-login')
    await waitFor(() => expect(window.history.state).toBeNull())
  })

  it('keeps attention grouping and project filters inside the drawer', async () => {
    mocks.live = [{ id: 's-release', activityState: 'waiting' }]
    renderShell()
    openDrawer()
    const list = await screen.findByTestId('mobile-session-list')
    await waitFor(() => expect(within(list).getAllByRole('heading')[0]).toHaveTextContent('mobile.group.attention'))
    expect(within(within(list).getAllByRole('region')[0]!).getByText('Draft release notes')).toBeInTheDocument()
  })

  it('starts a full-page chat in the filtered project without a new connection', async () => {
    seed({ sessions: [session('s-login', 'Fix login i18n'), session('s-crawl', 'Export comments', 60, '/work/media-crawler')] })
    renderShell()
    openDrawer()
    fireEvent.click(await screen.findByRole('button', { name: 'media-crawler' }))
    fireEvent.click(screen.getByTestId('mobile-new-task'))
    expect(screen.getByTestId('new-task-page')).toHaveTextContent('new task in /work/media-crawler')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mobile-session-drawer')).not.toBeInTheDocument()
    expect(connectToSession).not.toHaveBeenCalled()
    await waitFor(() => expect(window.history.state).toBeNull())
  })

  it('starts a new page from a chat and native Back returns to the same chat', async () => {
    seedChat()
    renderShell()
    fireEvent.click(within(screen.getByTestId('mobile-top-bar')).getByRole('button', { name: 'mobile.home.newTask' }))
    expect(screen.getByTestId('new-task-page')).toHaveTextContent('new task in /work/current-project')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(useTabStore.getState().activeTabId).toBeNull()
    expect(connectToSession).not.toHaveBeenCalled()
    expect(nativeBack()).toBe(true)
    expect(useTabStore.getState().activeTabId).toBe('s-login')
    expect(screen.getByTestId('routed-page')).toHaveTextContent('page for s-login')
    await waitFor(() => expect(window.history.state).toBeNull())
  })

  it('keeps a draft when returning to its chat, then opens the same draft again', async () => {
    seedChat()
    renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'mobile.home.newTask' }))
    const draft = useUIStore.getState().newSessionDraft!
    act(() => useUIStore.getState().setNewSessionDraftContent(draft.revision, true))
    expect(nativeBack()).toBe(true)
    await waitFor(() => expect(window.history.state).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'mobile.home.newTask' }))
    expect(useUIStore.getState().newSessionDraft).toMatchObject({ revision: draft.revision, hasContent: true })
  })

  it('browser Back closes the draft sidebar first, then returns from the draft to its chat', async () => {
    seedChat()
    renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'mobile.home.newTask' }))
    openDrawer()
    act(() => window.history.back())
    await waitFor(() => expect(screen.queryByTestId('mobile-session-drawer')).not.toBeInTheDocument())
    expect(screen.getByTestId('new-task-page')).toBeInTheDocument()
    await waitFor(() => expect(window.history.state).toEqual({ ccHahaMobileGuard: true }))
    act(() => window.history.back())
    await waitFor(() => expect(useTabStore.getState().activeTabId).toBe('s-login'))
    expect(window.history.state).toBeNull()
  })

  it('does not suggest a removed project when starting from a conversation', () => {
    seedChat()
    useSessionStore.setState(state => ({ sessions: state.sessions.map(session => ({ ...session, workDirExists: false })) }))
    renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'mobile.home.newTask' }))
    expect(screen.getByTestId('new-task-page')).toHaveTextContent('new task in (no project)')
  })

  it('starts in the project of the newest task when no filter is selected', async () => {
    seed({ sessions: [
      { ...session('s-old', 'Old refactor', 600, '/work/legacy'), modifiedAt: new Date().toISOString() },
      session('s-new', 'Export comments', 30, '/work/media-crawler'),
    ] })
    renderShell()
    openDrawer()
    fireEvent.click(screen.getByTestId('mobile-new-task'))
    expect(screen.getByTestId('new-task-page')).toHaveTextContent('new task in /work/media-crawler')
    await waitFor(() => expect(window.history.state).toBeNull())
  })

  it('returns from settings to the conversation where navigation was opened', async () => {
    seedChat()
    renderShell()
    openDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.settings' }))
    expect(screen.queryByTestId('mobile-session-drawer')).not.toBeInTheDocument()
    expect(screen.getByTestId('mobile-top-bar')).toHaveTextContent('sidebar.settings')
    expect(nativeBack()).toBe(true)
    expect(useTabStore.getState().activeTabId).toBe('s-login')
    await waitFor(() => expect(window.history.state).toBeNull())
  })

  it('lets the system back gesture leave a detail page for its session', async () => {
    const tabs: Tab[] = [
      { sessionId: 's-login', title: 'Fix login i18n', type: 'session', status: 'idle' },
      { sessionId: '__subagent__s-login:tool-1', title: 'Explore H5', type: 'subagent', status: 'idle', sourceSessionId: 's-login', subagentToolUseId: 'tool-1' },
    ]
    seed({ tabs, activeTabId: '__subagent__s-login:tool-1' })
    renderShell()
    act(() => window.history.back())
    await waitFor(() => expect(useTabStore.getState().activeTabId).toBe('s-login'))
    expect(useTabStore.getState().tabs.some(tab => tab.type === 'subagent')).toBe(false)
    expect(nativeBack()).toBe(false)
  })

  it('sends a desktop-only tab to the composer without deleting the tab', async () => {
    seed({ tabs: [{ sessionId: '__terminal__1', title: 'Terminal', type: 'terminal', status: 'idle' }], activeTabId: '__terminal__1' })
    renderShell()
    await waitFor(() => expect(useTabStore.getState().activeTabId).toBeNull())
    expect(screen.getByTestId('new-task-page')).toBeInTheDocument()
    expect(useTabStore.getState().tabs).toHaveLength(1)
  })

  it('keeps the list beside the session on a tablet without a drawer', async () => {
    seedChat()
    renderShell('tablet')
    const pane = screen.getByTestId('mobile-tablet-pane')
    expect((await within(pane).findByText('Fix login i18n')).closest('button')).toHaveAttribute('aria-current', 'true')
    expect(screen.queryByTestId('mobile-open-sessions')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mobile-back')).not.toBeInTheDocument()
    fireEvent.click(within(pane).getByTestId('mobile-new-task'))
    expect(screen.getByTestId('new-task-page')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('puts parallel work behind the existing activity pill', () => {
    seedChat()
    renderShell()
    expect(screen.queryByTestId('mobile-activity-pill')).not.toBeInTheDocument()
    act(() => useActivityPanelStore.getState().setMobileSummary('s-login', { visible: true, count: 3 }))
    fireEvent.click(screen.getByTestId('mobile-activity-pill'))
    expect(useActivityPanelStore.getState().isOpen('s-login')).toBe(true)
    act(() => useActivityPanelStore.getState().close())
  })

  it('renames a session from the press-and-hold sheet inside navigation', async () => {
    renderShell()
    openDrawer()
    const row = (await screen.findByText('Fix login i18n')).closest('button')!
    vi.useFakeTimers()
    fireEvent.pointerDown(row, { pointerType: 'touch', isPrimary: true, clientX: 5, clientY: 5 })
    act(() => vi.advanceTimersByTime(LONG_PRESS_DELAY_MS))
    fireEvent.pointerUp(row)
    fireEvent.click(row)
    vi.useRealTimers()
    expect(useTabStore.getState().activeTabId).toBeNull()
    fireEvent.click(within(screen.getByTestId('mobile-session-actions')).getByRole('menuitem', { name: 'common.rename' }))
    fireEvent.change(within(screen.getByTestId('mobile-session-rename')).getByRole('textbox'), { target: { value: 'Renamed chat' } })
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }))
    await waitFor(() => expect(renameSession).toHaveBeenCalledWith('s-login', 'Renamed chat'))
  })

  it('deletes a session after confirmation and releases its socket and tab', async () => {
    seed({ tabs: [{ sessionId: 's-login', title: 'Fix login i18n', type: 'session', status: 'idle' }] })
    renderShell()
    openDrawer()
    fireEvent.contextMenu((await screen.findByText('Fix login i18n')).closest('button')!)
    fireEvent.click(within(screen.getByTestId('mobile-session-actions')).getByRole('menuitem', { name: 'common.delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }))
    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith('s-login'))
    expect(disconnectSession).toHaveBeenCalledWith('s-login')
    expect(useTabStore.getState().tabs).toHaveLength(0)
  })

  it('gives a nested sheet native Back before closing the drawer', async () => {
    seedChat()
    renderShell()
    openDrawer()
    fireEvent.contextMenu((await screen.findByRole('button', { name: /Fix login i18n/ })))
    expect(screen.getByTestId('mobile-session-actions')).toBeInTheDocument()
    expect(nativeBack()).toBe(true)
    expect(screen.queryByTestId('mobile-session-actions')).not.toBeInTheDocument()
    expect(screen.getByTestId('mobile-session-drawer')).toBeInTheDocument()
    expect(useTabStore.getState().activeTabId).toBe('s-login')
  })

  it('browser Back also dismisses a nested sheet before the drawer and restores trigger focus', async () => {
    seedChat()
    renderShell()
    const opener = screen.getByTestId('mobile-open-sessions')
    opener.focus()
    openDrawer()
    fireEvent.contextMenu(await screen.findByRole('button', { name: /Fix login i18n/ }))
    act(() => window.history.back())
    await waitFor(() => expect(screen.queryByTestId('mobile-session-actions')).not.toBeInTheDocument())
    expect(screen.getByTestId('mobile-session-drawer')).toBeInTheDocument()
    await waitFor(() => expect(window.history.state).toEqual({ ccHahaMobileGuard: true }))
    act(() => window.history.back())
    await waitFor(() => expect(screen.queryByTestId('mobile-session-drawer')).not.toBeInTheDocument())
    expect(useTabStore.getState().activeTabId).toBe('s-login')
    expect(opener).toHaveFocus()
  })
})
