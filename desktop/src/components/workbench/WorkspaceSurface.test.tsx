import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/workspace/useWorkspaceFileWatch', () => ({ useWorkspaceFileWatch: () => null }))

const mocks = vi.hoisted(() => ({
  subscribeWorkspaceBrowserEvents: vi.fn(),
  releaseWorkspaceBrowserTab: vi.fn(),
  isWorkspaceBrowserAvailable: vi.fn(() => false),
  workspaceBrowserHost: {
    create: vi.fn(async () => ({ ok: true })),
    setVisible: vi.fn(async () => ({ ok: true })),
    setBounds: vi.fn(async () => ({ ok: true })),
    close: vi.fn(async () => ({ ok: true })),
    message: vi.fn(async () => ({ ok: true })),
    snapshot: vi.fn(async (): Promise<string | null> => null),
  },
}))

vi.mock('../../lib/workspace/browserHost', () => ({
  subscribeWorkspaceBrowserEvents: mocks.subscribeWorkspaceBrowserEvents,
  releaseWorkspaceBrowserTab: mocks.releaseWorkspaceBrowserTab,
  isWorkspaceBrowserAvailable: mocks.isWorkspaceBrowserAvailable,
  workspaceBrowserHost: mocks.workspaceBrowserHost,
}))

vi.mock('../../pages/TerminalSettings', () => ({
  TerminalSettings: ({ testId }: { testId: string }) => <div data-testid={testId} />,
}))

vi.mock('../../api/sessions', () => ({
  sessionsApi: {
    getWorkspaceTree: vi.fn(async () => ({ state: 'ok', path: '', entries: [] })),
    getWorkspaceFile: vi.fn(async () => ({ state: 'ok', path: '', content: '', language: 'text', size: 0 })),
    getWorkspaceStatus: vi.fn(),
  },
}))

vi.mock('../../api/review', () => ({
  reviewApi: {
    getStatus: vi.fn(async () => ({
      state: 'ok',
      source: { kind: 'unstaged' },
      snapshot: 's1',
      files: [],
      untracked: [],
      totals: { additions: 0, deletions: 0, files: 0 },
    })),
    getDiff: vi.fn(),
    stage: vi.fn(),
    unstage: vi.fn(),
    stageHunk: vi.fn(),
    unstageHunk: vi.fn(),
    revert: vi.fn(),
  },
}))

import { useTabStore } from '../../stores/tabStore'
import { useWorkspaceBrowserStore } from '../../stores/workspaceBrowserStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { WorkspaceSurface, useWorkspaceBrowserEventBridge } from './WorkspaceSurface'
import { WorkspaceHeaderProvider } from '../layout/WorkspaceHeaderContext'
import { TabBar } from '../layout/TabBar'
import type { WorkspaceBrowserTab } from '../../lib/workspace/types'

const SESSION = 'session-a'

function renderSurface(props: Partial<Parameters<typeof WorkspaceSurface>[0]> = {}) {
  return render(
    <WorkspaceSurface sessionId={SESSION} dock="side" cwd="/repo" {...props} />,
  )
}

beforeEach(() => {
  useWorkspaceStore.setState({ bySession: {} })
  useTabStore.setState({ tabs: [], activeTabId: SESSION })
  mocks.subscribeWorkspaceBrowserEvents.mockReset()
  mocks.subscribeWorkspaceBrowserEvents.mockResolvedValue(() => {})
  mocks.releaseWorkspaceBrowserTab.mockClear()
  mocks.isWorkspaceBrowserAvailable.mockReturnValue(false)
  Object.values(mocks.workspaceBrowserHost).forEach(mock => mock.mockClear())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('leaves the first Files quick-open search focused after the parent consumes its focus request', async () => {
  useWorkspaceStore.getState().openTarget(SESSION, { kind: 'file', path: '' }, { preview: true })
  renderSurface()
  await act(async () => { await Promise.resolve() })
  expect(screen.getByRole('searchbox')).toHaveFocus()
})

it('reveals successful navigation and ignores old failures and stopped error documents', async () => {
  const tabId = useWorkspaceStore.getState().openTarget(SESSION, { kind: 'browser', url: 'https://bad.test/' })!
  const browserTabId = (useWorkspaceStore.getState().getTab(SESSION, tabId) as WorkspaceBrowserTab).browserTabId
  renderHook(() => useWorkspaceBrowserEventBridge(true))
  await act(async () => { await Promise.resolve() })
  const emitEvent = (event: unknown) => act(() => { mocks.subscribeWorkspaceBrowserEvents.mock.calls[0]![0](event) })
  emitEvent({ type: 'failed', tabId: browserTabId, url: 'https://bad.test/', errorCode: -105, errorDescription: 'NAME_NOT_RESOLVED', navigationId: 1 })
  const state = { type: 'state', tabId: browserTabId, url: 'https://bad.test/', title: '', canGoBack: true, canGoForward: true, loading: false, navigationId: 1, navigationOutcome: 'failed' }
  emitEvent(state)
  expect(useWorkspaceStore.getState().getTab(SESSION, tabId)).toMatchObject({ loadError: 'NAME_NOT_RESOLVED' })
  emitEvent({ ...state, navigationId: 2, navigationOutcome: 'pending', loading: true })
  emitEvent({ ...state, navigationId: 2, navigationOutcome: 'succeeded', url: 'https://good.test/' })
  expect(useWorkspaceStore.getState().getTab(SESSION, tabId)).toMatchObject({ loadError: null, url: 'https://good.test/' })
  emitEvent({ type: 'failed', tabId: browserTabId, url: 'https://bad.test/', errorCode: -105, errorDescription: 'LATE', navigationId: 1 })
  emitEvent({ ...state, navigationId: 1 })
  expect(useWorkspaceStore.getState().getTab(SESSION, tabId)).toMatchObject({ loadError: null, url: 'https://good.test/' })
})

it('updates downloads after close without resurrecting page state', async () => {
  const tabId = useWorkspaceStore.getState().openTarget(SESSION, { kind: 'browser' })!
  const browserTabId = (useWorkspaceStore.getState().getTab(SESSION, tabId) as WorkspaceBrowserTab).browserTabId
  renderHook(() => useWorkspaceBrowserEventBridge(true))
  await act(async () => { await Promise.resolve() })
  useWorkspaceStore.getState().closeTab(SESSION, tabId)
  useWorkspaceBrowserStore.getState().forgetTab(browserTabId)
  act(() => {
    const emitEvent = mocks.subscribeWorkspaceBrowserEvents.mock.calls[0]![0]
    emitEvent({ type: 'state', tabId: browserTabId, url: 'https://late.test/', title: 'late', loading: false, canGoBack: false, canGoForward: false })
    emitEvent({ type: 'download', tabId: browserTabId, download: { id: 'closed-download', filename: 'saved.pdf', savePath: '/tmp/saved.pdf', receivedBytes: 10, totalBytes: 10, state: 'completed' } })
  })
  expect(useWorkspaceBrowserStore.getState().pageByTabId[browserTabId]).toBeUndefined()
  expect(useWorkspaceBrowserStore.getState().downloads.find(item => item.id === 'closed-download')).toMatchObject({ state: 'completed' })
  expect(useWorkspaceStore.getState().getTab(SESSION, tabId)).toBeNull()
})

describe('WorkspaceSurface', () => {
  it('shows the four-entry launcher when the workspace is empty', () => {
    renderSurface()
    expect(screen.getByTestId('workspace-launcher')).toBeInTheDocument()
    // Reference: the first-open invitation has no empty tab row or + button.
    expect(screen.queryByTestId('workspace-tab-strip-side')).not.toBeInTheDocument()
  })

  it('opens the chosen kind from the launcher', () => {
    renderSurface()
    act(() => {
      fireEvent.click(screen.getByTestId('workspace-launcher-terminal'))
    })

    const tabs = useWorkspaceStore.getState().getTabs(SESSION, 'side')
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ kind: 'terminal', cwd: '/repo' })
  })

  it.each(['side', 'bottom'] as const)('opens a non-replacing menu from + in the %s dock', (dock) => {
    const id = useWorkspaceStore.getState().openTarget(SESSION, { kind: 'terminal', cwd: '/repo', dock })!
    renderSurface({ dock })
    const content = screen.getByTestId(`workspace-terminal-${id}`)
    const add = screen.getByTestId(`workspace-add-tab-${dock}`)
    fireEvent.click(add)
    const menu = screen.getByRole('menu', { name: 'Open in workspace' })
    expect(menu).toHaveStyle({ position: 'fixed' })
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(4)
    expect(screen.getByTestId(`workspace-terminal-${id}`)).toBe(content)
    expect(content).toBeVisible()
    expect(add).toHaveAttribute('aria-expanded', 'true')
    expect(add).toHaveAttribute('aria-controls', menu.id)
    expect(screen.queryByTestId('workspace-picker-cancel')).toBeNull()
  })

  it('re-opens the picker from the plus button and leaves no empty tab if nothing is chosen', () => {
    renderSurface()
    act(() => {
      fireEvent.click(screen.getByTestId('workspace-launcher-terminal'))
    })
    expect(screen.queryByTestId('workspace-launcher')).toBeNull()

    act(() => {
      fireEvent.click(screen.getByTestId('workspace-add-tab-side'))
    })
    expect(screen.getByTestId('workspace-add-menu')).toBeInTheDocument()
    // Cancelling by choosing nothing must not leave a placeholder behind.
    expect(useWorkspaceStore.getState().getTabs(SESSION, 'side')).toHaveLength(1)
  })

  it('closes the menu on a second plus click without changing the active resource', () => {
    renderSurface()
    act(() => { fireEvent.click(screen.getByTestId('workspace-launcher-terminal')) })
    act(() => { fireEvent.click(screen.getByTestId('workspace-add-tab-side')) })
    expect(screen.getByTestId('workspace-add-menu')).toBeInTheDocument()

    act(() => { fireEvent.click(screen.getByTestId('workspace-add-tab-side')) })

    // A second + click closes its menu; it must not create a placeholder tab.
    expect(screen.queryByTestId('workspace-add-menu')).toBeNull()
    expect(screen.getByTestId('workspace-terminal-host-1')).toBeInTheDocument()
    expect(useWorkspaceStore.getState().getTabs(SESSION, 'side')).toHaveLength(1)
    expect(screen.getByTestId('workspace-add-tab-side')).toHaveFocus()
  })

  it('cancels the picker when an existing tab is chosen instead', () => {
    renderSurface()
    act(() => { fireEvent.click(screen.getByTestId('workspace-launcher-terminal')) })
    const terminalTabId = useWorkspaceStore.getState().getTabs(SESSION, 'side')[0]!.id
    act(() => { fireEvent.click(screen.getByTestId('workspace-add-tab-side')) })

    act(() => { fireEvent.click(screen.getByTestId(`workspace-tab-${terminalTabId}`)) })

    expect(screen.queryByTestId('workspace-add-menu')).toBeNull()
  })

  it('keeps the Files search focused after a menu selection has finished cleaning up', async () => {
    useWorkspaceStore.getState().openTarget(SESSION, { kind: 'terminal', cwd: '/repo' })
    renderSurface()
    const add = screen.getByTestId('workspace-add-tab-side')
    fireEvent.click(add)
    fireEvent.click(screen.getByTestId('workspace-menu-file'))

    await waitFor(() => { expect(screen.getByRole('searchbox')).toHaveFocus() })
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('searchbox')).toHaveFocus()
    expect(add).not.toHaveFocus()
    expect(screen.queryByTestId('workspace-add-menu')).toBeNull()
    expect(useWorkspaceStore.getState().getActiveTab(SESSION, 'side')).toMatchObject({ kind: 'file', path: '' })
  })

  it('leaves focus in the browser panel after opening it from the menu on a Web host', async () => {
    useWorkspaceStore.getState().openTarget(SESSION, { kind: 'terminal', cwd: '/repo' })
    renderSurface()
    const add = screen.getByTestId('workspace-add-tab-side')
    fireEvent.click(add)
    fireEvent.click(screen.getByTestId('workspace-menu-browser'))

    // The Web host has no native address bar; it must still focus the new
    // browser panel rather than the menu's old + trigger.
    await waitFor(() => { expect(screen.getByRole('tabpanel')).toHaveFocus() })
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('tabpanel')).toHaveFocus()
    expect(add).not.toHaveFocus()
    expect(screen.queryByTestId('workspace-add-menu')).toBeNull()
    expect(useWorkspaceStore.getState().getActiveTab(SESSION, 'side')).toMatchObject({ kind: 'browser', url: null })
  })

  it('keeps a live browser component and its address draft while its plus menu opens and closes', async () => {
    mocks.isWorkspaceBrowserAvailable.mockReturnValue(true)
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
      unobserve() {}
    })
    const tabId = useWorkspaceStore.getState().openTarget(SESSION, { kind: 'browser', url: 'https://fixture.test/current' })!
    const tab = useWorkspaceStore.getState().getTab(SESSION, tabId) as WorkspaceBrowserTab
    renderSurface()
    const address = await screen.findByTestId('workspace-browser-address')
    await waitFor(() => { expect(address).toBeEnabled() })
    const toolbar = screen.getByTestId('workspace-browser-toolbar')
    const draft = 'https://fixture.test/not-yet-submitted'
    fireEvent.change(address, { target: { value: draft } })
    const add = screen.getByTestId('workspace-add-tab-side')
    fireEvent.click(add)

    expect(screen.getByTestId('workspace-browser-toolbar')).toBe(toolbar)
    expect(screen.getByTestId('workspace-browser-address')).toBe(address)
    expect(address).toHaveValue(draft)
    await act(async () => { await Promise.resolve() })
    fireEvent.keyDown(screen.getByTestId('workspace-add-menu'), { key: 'Escape' })
    await act(async () => { await Promise.resolve() })

    expect(screen.queryByTestId('workspace-add-menu')).toBeNull()
    expect(screen.getByTestId('workspace-browser-toolbar')).toBe(toolbar)
    expect(address).toHaveValue(draft)
    expect(add).toHaveFocus()
    expect(mocks.workspaceBrowserHost.create).toHaveBeenCalledTimes(1)
    expect(mocks.workspaceBrowserHost.create).toHaveBeenCalledWith(tab.browserTabId, expect.objectContaining({ storageId: tab.storageId }))
    expect(mocks.workspaceBrowserHost.close).not.toHaveBeenCalled()
    expect(mocks.releaseWorkspaceBrowserTab).not.toHaveBeenCalled()
    expect(useWorkspaceStore.getState().getTabs(SESSION, 'side')).toEqual([tab])
  })

  it.each(['review', 'file', 'terminal'] as const)('retains an existing blank browser when the side plus menu opens %s', async (kind) => {
    mocks.isWorkspaceBrowserAvailable.mockReturnValue(true)
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
      unobserve() {}
    })
    const tabId = useWorkspaceStore.getState().openTarget(SESSION, { kind: 'browser' })!
    const tab = useWorkspaceStore.getState().getTab(SESSION, tabId) as WorkspaceBrowserTab
    renderSurface()
    const address = await screen.findByTestId('workspace-browser-address')
    await waitFor(() => { expect(address).toBeEnabled() })
    const draft = 'https://fixture.test/unsubmitted-address'
    fireEvent.change(address, { target: { value: draft } })
    fireEvent.click(screen.getByTestId('workspace-add-tab-side'))
    expect(address).toHaveValue(draft)

    fireEvent.click(screen.getByTestId(`workspace-menu-${kind}`))
    await waitFor(() => {
      expect(useWorkspaceStore.getState().getActiveTab(SESSION, 'side')).toMatchObject({ kind })
    })

    // A plus menu creates a separate resource. Only a New Tab page's own
    // launcher may replace that page; an unset committed URL does not make a
    // user's existing browser an expendable placeholder.
    expect(useWorkspaceStore.getState().getTab(SESSION, tabId)).toEqual(tab)
    expect(useWorkspaceStore.getState().getTabs(SESSION, 'side')).toHaveLength(2)
    expect(mocks.releaseWorkspaceBrowserTab).not.toHaveBeenCalled()
    expect(mocks.workspaceBrowserHost.close).not.toHaveBeenCalled()
    expect(screen.queryByTestId('workspace-add-menu')).toBeNull()
  })

  it('offers all four content kinds in the bottom dock', () => {
    render(<WorkspaceSurface sessionId={SESSION} dock="bottom" cwd="/repo" />)

    for (const kind of ['review', 'terminal', 'browser', 'file']) {
      expect(screen.getByTestId(`workspace-launcher-${kind}`)).toBeEnabled()
    }
  })

  it('keeps the bottom review entry disabled outside a Git repository', () => {
    renderSurface({ dock: 'bottom', reviewUnavailableReason: 'Not a Git repository' })
    expect(screen.getByTestId('workspace-launcher-review')).toBeDisabled()
    expect(screen.getByTestId('workspace-launcher-review')).toHaveTextContent('Not a Git repository')
    expect(screen.getByTestId('workspace-launcher-browser')).toBeEnabled()
  })

  it.each(['side', 'bottom'] as const)('adds independent terminals to the %s dock while keeping the other dock intact', (dock) => {
    const otherDock = dock === 'side' ? 'bottom' : 'side'
    const existingId = useWorkspaceStore.getState().openTarget(SESSION, { kind: 'terminal', cwd: '/repo', dock: otherDock })!
    const existing = useWorkspaceStore.getState().getTab(SESSION, existingId)
    renderSurface({ dock })

    for (let index = 0; index < 3; index += 1) {
      if (index > 0) fireEvent.click(screen.getByTestId(`workspace-add-tab-${dock}`))
      fireEvent.click(screen.getByTestId(index === 0 ? 'workspace-launcher-terminal' : 'workspace-menu-terminal'))
      const tabs = useWorkspaceStore.getState().getTabs(SESSION, dock)
      const active = useWorkspaceStore.getState().getActiveTab(SESSION, dock)
      expect(tabs).toHaveLength(index + 1)
      expect(active).toMatchObject({ id: tabs.at(-1)?.id, kind: 'terminal', dock, cwd: '/repo' })
      expect(screen.getByTestId(`workspace-terminal-${active!.id}`)).toBeInTheDocument()
      expect(screen.queryByTestId('workspace-add-menu')).toBeNull()
    }

    const terminals = useWorkspaceStore.getState().getTabs(SESSION, dock)
    expect(new Set(terminals.map(tab => tab.kind === 'terminal' ? tab.runtimeId : null)).size).toBe(3)
    expect(useWorkspaceStore.getState().getTabs(SESSION, otherDock)).toEqual([existing])
    expect(useWorkspaceStore.getState().getSession(SESSION)).toMatchObject({ layout: 'split', bottomOpen: true })
  })

  it.each(['review', 'browser', 'file'] as const)('opens %s from the bottom plus in the side dock and preserves its terminal', async (kind) => {
    const terminalId = useWorkspaceStore.getState().openTarget(SESSION, { kind: 'terminal', cwd: '/repo', dock: 'bottom' })!
    const terminal = useWorkspaceStore.getState().getTab(SESSION, terminalId)
    renderSurface({ dock: 'bottom' })
    fireEvent.click(screen.getByTestId('workspace-add-tab-bottom'))
    fireEvent.click(screen.getByTestId(`workspace-menu-${kind}`))
    await act(async () => { await Promise.resolve() })

    expect(useWorkspaceStore.getState().getActiveTab(SESSION, 'side')).toMatchObject({ kind, dock: 'side' })
    expect(useWorkspaceStore.getState().getSession(SESSION)).toMatchObject({ layout: 'split', bottomOpen: true, activeBottomTabId: terminalId })
    expect(useWorkspaceStore.getState().getTabs(SESSION, 'bottom')).toEqual([terminal])
    expect(screen.getByTestId(`workspace-terminal-${terminalId}`)).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-add-menu')).toBeNull()
  })

  it('does not consume a side browser placeholder when review is chosen from the bottom picker', () => {
    const browserId = useWorkspaceStore.getState().openTarget(SESSION, { kind: 'browser' })!
    const browser = useWorkspaceStore.getState().getTab(SESSION, browserId)
    useWorkspaceStore.getState().openTarget(SESSION, { kind: 'terminal', cwd: '/repo', dock: 'bottom' })
    renderSurface({ dock: 'bottom' })
    fireEvent.click(screen.getByTestId('workspace-add-tab-bottom'))
    fireEvent.click(screen.getByTestId('workspace-menu-review'))

    // An unrelated bottom picker must not close a side page whose first URL
    // has not committed yet, even though the host still describes it as blank.
    expect(useWorkspaceStore.getState().getTab(SESSION, browserId)).toEqual(browser)
    expect(useWorkspaceStore.getState().getTabs(SESSION, 'side')).toHaveLength(2)
    expect(mocks.releaseWorkspaceBrowserTab).not.toHaveBeenCalled()
  })

  it('cancels a bottom picker without adding a resource and keeps both active tabs', () => {
    const sideId = useWorkspaceStore.getState().openTarget(SESSION, { kind: 'terminal', cwd: '/repo', dock: 'side' })!
    const bottomId = useWorkspaceStore.getState().openTarget(SESSION, { kind: 'terminal', cwd: '/repo', dock: 'bottom' })!
    render(<><WorkspaceSurface sessionId={SESSION} dock="side" cwd="/repo" /><WorkspaceSurface sessionId={SESSION} dock="bottom" cwd="/repo" /></>)
    fireEvent.click(screen.getByTestId('workspace-add-tab-bottom'))
    const bottom = within(screen.getByTestId('workspace-surface-bottom'))
    expect(screen.getByTestId('workspace-menu-browser')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByTestId('workspace-add-menu'), { key: 'Escape' })

    expect(screen.queryByTestId('workspace-add-menu')).toBeNull()
    expect(bottom.getByTestId('workspace-add-tab-bottom')).toHaveFocus()
    expect(useWorkspaceStore.getState().getSession(SESSION)).toMatchObject({ activeSideTabId: sideId, activeBottomTabId: bottomId })
    expect(screen.getByTestId(`workspace-terminal-${sideId}`)).toBeInTheDocument()
    expect(screen.getByTestId(`workspace-terminal-${bottomId}`)).toBeInTheDocument()
    expect(useWorkspaceStore.getState().getSession(SESSION).tabs).toHaveLength(2)
  })

  it('dismisses the picker on session changes without leaking it into the next session', () => {
    const otherSession = 'session-b'
    useWorkspaceStore.getState().openTarget(SESSION, { kind: 'terminal', cwd: '/repo', dock: 'bottom' })
    const otherId = useWorkspaceStore.getState().openTarget(otherSession, { kind: 'terminal', cwd: '/other', dock: 'bottom' })!
    const { rerender } = renderSurface({ dock: 'bottom' })
    fireEvent.click(screen.getByTestId('workspace-add-tab-bottom'))
    expect(screen.getByTestId('workspace-add-menu')).toBeInTheDocument()

    act(() => { useTabStore.setState({ activeTabId: otherSession }) })
    rerender(<WorkspaceSurface sessionId={otherSession} dock="bottom" cwd="/other" />)
    expect(screen.queryByTestId('workspace-add-menu')).toBeNull()
    expect(screen.getByTestId(`workspace-terminal-${otherId}`)).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('workspace-add-tab-bottom'))
    fireEvent.click(screen.getByTestId('workspace-menu-terminal'))
    expect(useWorkspaceStore.getState().getTabs(otherSession, 'bottom')).toHaveLength(2)
    expect(useWorkspaceStore.getState().getActiveTab(otherSession, 'bottom')).toMatchObject({ cwd: '/other' })
    expect(useWorkspaceStore.getState().getTabs(SESSION, 'bottom')).toHaveLength(1)
  })

  it('dismisses the chooser when its bottom dock is hidden and reopened', () => {
    const terminalId = useWorkspaceStore.getState().openTarget(SESSION, { kind: 'terminal', cwd: '/repo', dock: 'bottom' })!
    const { rerender } = renderSurface({ dock: 'bottom' })
    fireEvent.click(screen.getByTestId('workspace-add-tab-bottom'))
    expect(screen.getByTestId('workspace-add-menu')).toBeInTheDocument()

    rerender(<WorkspaceSurface sessionId={SESSION} dock="bottom" cwd="/repo" visible={false} />)
    rerender(<WorkspaceSurface sessionId={SESSION} dock="bottom" cwd="/repo" visible />)

    expect(screen.queryByTestId('workspace-add-menu')).toBeNull()
    expect(screen.getByTestId(`workspace-terminal-${terminalId}`)).toBeInTheDocument()
    expect(useWorkspaceStore.getState().getTabs(SESSION, 'bottom')).toHaveLength(1)
  })

  it.each(['side', 'bottom'] as const)('leaves window layout controls out of the %s resource strip', (dock) => {
    useWorkspaceStore.getState().openTarget(SESSION, { kind: 'terminal', cwd: '/repo', dock })
    renderSurface({ dock })
    expect(screen.getByTestId(`workspace-add-tab-${dock}`)).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-toggle-side')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-toggle-bottom')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-toggle-fullscreen')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-hide-bottom')).not.toBeInTheDocument()
  })

  it('places side tabs in the real window header and keeps bottom tabs beside their content', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
    const sideId = useWorkspaceStore.getState().openTarget(SESSION, { kind: 'terminal', cwd: '/repo', dock: 'side' })!
    useWorkspaceStore.getState().openTarget(SESSION, { kind: 'terminal', cwd: '/repo', dock: 'bottom' })
    render(<WorkspaceHeaderProvider>
      <TabBar />
      <WorkspaceSurface sessionId={SESSION} dock="side" cwd="/repo" />
      <WorkspaceSurface sessionId={SESSION} dock="bottom" cwd="/repo" />
    </WorkspaceHeaderProvider>)
    const header = screen.getByTestId('workspace-window-header')
    // Session overflow must stay in its own shrinkable region when the resource header fills the window.
    const sessionHeader = screen.getByTestId('workspace-session-header')
    expect(sessionHeader).toContainElement(screen.getByTestId('tab-bar-scroll-region'))
    expect(sessionHeader).toHaveClass('min-w-0', 'overflow-hidden')
    expect(sessionHeader).not.toContainElement(screen.getByTestId('workspace-header-frame'))
    expect(within(header).getByTestId('workspace-tab-strip-side')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-header-slot').className).not.toMatch(/\btab-bar-interactive\b/)
    expect(within(header).getByTestId('workspace-tab-strip-side')).toHaveAttribute('data-desktop-drag-region')
    expect(within(header).getByTestId(`workspace-tab-wrap-${sideId}`)).toHaveClass('tab-bar-interactive')
    expect(within(header).getByTestId('workspace-toggle-side')).toBeInTheDocument()
    expect(within(screen.getByTestId('workspace-surface-side')).queryByRole('tablist')).toBeNull()
    expect(within(screen.getByTestId('workspace-surface-bottom')).getByRole('tablist')).toBeInTheDocument()
    const content = screen.getByTestId('workspace-surface-side').querySelector('[role="tabpanel"]')
    act(() => useWorkspaceStore.getState().toggleFullscreen(SESSION))
    expect(screen.getByTestId('workspace-surface-side').querySelector('[role="tabpanel"]')).toBe(content)
    fireEvent.click(within(header).getByTestId('workspace-add-tab-side'))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.getByTestId('workspace-add-tab-side')).toHaveFocus()
    act(() => useWorkspaceStore.getState().closeTab(SESSION, sideId))
    expect(within(header).queryByRole('tablist')).toBeNull()
    expect(screen.getByTestId('workspace-launcher')).toBeInTheDocument()
    await act(async () => { await Promise.resolve() })
  })

  it('renders only the active tab and switches content on activation', () => {
    renderSurface()
    act(() => { fireEvent.click(screen.getByTestId('workspace-launcher-terminal')) })
    act(() => { fireEvent.click(screen.getByTestId('workspace-add-tab-side')) })
    act(() => { fireEvent.click(screen.getByTestId('workspace-menu-review')) })

    expect(screen.getByTestId('workspace-review-toolbar')).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-terminal-host-1')).toBeNull()

    const terminalTabId = useWorkspaceStore.getState().getTabs(SESSION, 'side')[0]!.id
    act(() => { fireEvent.click(screen.getByTestId(`workspace-tab-${terminalTabId}`)) })

    expect(screen.getByTestId('workspace-terminal-host-1')).toBeInTheDocument()
  })
})

describe('useWorkspaceBrowserEventBridge', () => {
  function emit(event: unknown) {
    const handler = mocks.subscribeWorkspaceBrowserEvents.mock.calls.at(-1)?.[0] as
      | ((value: unknown) => void)
      | undefined
    act(() => { handler?.(event) })
  }

  it('records a committed navigation on the tab that owns the page', async () => {
    const tabId = useWorkspaceStore.getState().openTarget(SESSION, { kind: 'browser' })!
    const browserTabId = (useWorkspaceStore.getState().getTab(SESSION, tabId) as WorkspaceBrowserTab).browserTabId

    renderHook(() => useWorkspaceBrowserEventBridge(true))
    await act(async () => { await Promise.resolve() })

    emit({
      type: 'state',
      tabId: browserTabId,
      url: 'http://localhost:3000/',
      title: 'Dev',
      canGoBack: false,
      canGoForward: false,
      loading: false,
    })

    expect(useWorkspaceStore.getState().getTab(SESSION, tabId))
      .toMatchObject({ url: 'http://localhost:3000/', title: 'Dev' })
  })

  it('turns a popup into a sibling tab rather than an OS window', async () => {
    const tabId = useWorkspaceStore.getState().openTarget(SESSION, { kind: 'browser' })!
    const browserTabId = (useWorkspaceStore.getState().getTab(SESSION, tabId) as WorkspaceBrowserTab).browserTabId

    renderHook(() => useWorkspaceBrowserEventBridge(true))
    await act(async () => { await Promise.resolve() })

    emit({ type: 'new-window', tabId: browserTabId, url: 'https://example.test/popup' })

    const tabs = useWorkspaceStore.getState().getTabs(SESSION, 'side')
    expect(tabs).toHaveLength(2)
    expect(tabs[1]).toMatchObject({ kind: 'browser', url: 'https://example.test/popup' })
  })

  it('keeps a failure on the page that failed', async () => {
    const first = useWorkspaceStore.getState().openTarget(SESSION, { kind: 'browser', url: 'http://a.test/' })!
    const second = useWorkspaceStore.getState().openTarget(SESSION, { kind: 'browser', url: 'http://b.test/' })!
    const firstBrowserTabId = (useWorkspaceStore.getState().getTab(SESSION, first) as WorkspaceBrowserTab).browserTabId

    renderHook(() => useWorkspaceBrowserEventBridge(true))
    await act(async () => { await Promise.resolve() })

    emit({
      type: 'failed',
      tabId: firstBrowserTabId,
      url: 'http://a.test/',
      errorCode: -105,
      errorDescription: 'NAME_NOT_RESOLVED',
    })

    expect(useWorkspaceStore.getState().getTab(SESSION, first))
      .toMatchObject({ loadError: 'NAME_NOT_RESOLVED' })
    expect(useWorkspaceStore.getState().getTab(SESSION, second)).toMatchObject({ loadError: null })
  })

  it('routes an event to the task that owns the page, not the task on screen', async () => {
    const OTHER = 'session-b'
    const backgroundTab = useWorkspaceStore.getState().openTarget(OTHER, { kind: 'browser' })!
    const backgroundBrowserTabId = (useWorkspaceStore.getState()
      .getTab(OTHER, backgroundTab) as WorkspaceBrowserTab).browserTabId
    // `session-a` is the foreground task throughout.
    useTabStore.setState({ tabs: [], activeTabId: SESSION })

    renderHook(() => useWorkspaceBrowserEventBridge(true))
    await act(async () => { await Promise.resolve() })

    emit({
      type: 'state',
      tabId: backgroundBrowserTabId,
      url: 'http://background.test/',
      title: 'Background',
      canGoBack: false,
      canGoForward: false,
      loading: false,
    })

    // Routing by the foreground task would silently drop this.
    expect(useWorkspaceStore.getState().getTab(OTHER, backgroundTab))
      .toMatchObject({ url: 'http://background.test/', title: 'Background' })
  })

  it('opens a popup in the task whose page asked for it', async () => {
    const OTHER = 'session-b'
    const backgroundTab = useWorkspaceStore.getState().openTarget(OTHER, { kind: 'browser' })!
    const backgroundBrowserTabId = (useWorkspaceStore.getState()
      .getTab(OTHER, backgroundTab) as WorkspaceBrowserTab).browserTabId
    useTabStore.setState({ tabs: [], activeTabId: SESSION })

    renderHook(() => useWorkspaceBrowserEventBridge(true))
    await act(async () => { await Promise.resolve() })

    emit({ type: 'new-window', tabId: backgroundBrowserTabId, url: 'https://popup.test/' })

    // A background page's popup must not appear in the task the user is reading.
    expect(useWorkspaceStore.getState().getTabs(SESSION, 'side')).toHaveLength(0)
    expect(useWorkspaceStore.getState().getTabs(OTHER, 'side')).toHaveLength(2)
  })

  it('drops an event for a page that has already been closed', async () => {
    const first = useWorkspaceStore.getState().openTarget(SESSION, { kind: 'browser', url: 'http://a.test/' })!
    const closedBrowserTabId = (useWorkspaceStore.getState().getTab(SESSION, first) as WorkspaceBrowserTab).browserTabId
    useWorkspaceStore.getState().closeTab(SESSION, first)
    const second = useWorkspaceStore.getState().openTarget(SESSION, { kind: 'browser', url: 'http://b.test/' })!

    renderHook(() => useWorkspaceBrowserEventBridge(true))
    await act(async () => { await Promise.resolve() })

    emit({
      type: 'state',
      tabId: closedBrowserTabId,
      url: 'http://a.test/late',
      title: 'Late',
      canGoBack: false,
      canGoForward: false,
      loading: false,
    })

    // The slot the closed page occupied now belongs to another page; a late
    // event must not repaint it.
    expect(useWorkspaceStore.getState().getTab(SESSION, second)).toMatchObject({ url: 'http://b.test/' })
  })
})
