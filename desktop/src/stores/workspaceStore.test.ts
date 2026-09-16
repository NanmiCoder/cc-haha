import { beforeEach, describe, expect, it, vi } from 'vitest'

type HoistedVi = typeof vi & {
  hoisted?: <T>(factory: () => T) => T
}

if (typeof (vi as HoistedVi).hoisted !== 'function') {
  ;(vi as HoistedVi).hoisted = <T>(factory: () => T) => factory()
}

const mocks = vi.hoisted(() => ({
  destroyTerminalRuntime: vi.fn(),
  releaseWorkspaceBrowserTab: vi.fn(),
}))

vi.mock('../lib/terminalRuntime', () => ({
  destroyTerminalRuntime: mocks.destroyTerminalRuntime,
}))

vi.mock('../lib/workspace/browserHost', () => ({
  releaseWorkspaceBrowserTab: mocks.releaseWorkspaceBrowserTab,
}))

import {
  WORKSPACE_SIDE_MAX_WIDTH,
  WORKSPACE_SIDE_MIN_WIDTH,
  useWorkspaceStore,
  workspaceTabTitle,
} from './workspaceStore'
import type {
  WorkspaceBrowserTab,
  WorkspaceTerminalTab,
} from '../lib/workspace/types'

const SESSION = 'session-a'
const OTHER = 'session-b'

function store() {
  return useWorkspaceStore.getState()
}

function sideTabs(sessionId = SESSION) {
  return store().getTabs(sessionId, 'side')
}

function bottomTabs(sessionId = SESSION) {
  return store().getTabs(sessionId, 'bottom')
}

function openFile(path: string, options?: { preview?: boolean; line?: number }) {
  return store().openTarget(
    SESSION,
    { kind: 'file', path, ...(options?.line ? { reveal: { line: options.line } } : {}) },
    options?.preview ? { preview: true } : undefined,
  )!
}

beforeEach(() => {
  useWorkspaceStore.setState({ bySession: {}, sideWidth: 860, bottomHeight: 420 })
  mocks.destroyTerminalRuntime.mockClear()
  mocks.releaseWorkspaceBrowserTab.mockClear()
})

describe('layout', () => {
  it('starts hidden with no tabs so the panel opens on the four-entry launcher', () => {
    const state = store().getSession(SESSION)
    expect(state.layout).toBe('hidden')
    expect(state.tabs).toEqual([])
  })

  it('opens a side tab out of the hidden state without being asked twice', () => {
    openFile('src/a.ts')
    expect(store().getSession(SESSION).layout).toBe('split')
  })

  it('toggles back to split, never to full, so a toggle cannot swallow the chat', () => {
    openFile('src/a.ts')
    store().toggleFullscreen(SESSION)
    expect(store().getSession(SESSION).layout).toBe('full')
    store().toggleWorkspace(SESSION)
    expect(store().getSession(SESSION).layout).toBe('hidden')
    store().toggleWorkspace(SESSION)
    expect(store().getSession(SESSION).layout).toBe('split')
  })

  it('keeps every tab and every resource alive while hidden', () => {
    openFile('src/a.ts')
    store().openTarget(SESSION, { kind: 'browser', url: 'http://localhost:3000/' })
    store().openTarget(SESSION, { kind: 'terminal', cwd: '/repo' })
    store().toggleWorkspace(SESSION)

    expect(store().getSession(SESSION).layout).toBe('hidden')
    expect(sideTabs()).toHaveLength(3)
    expect(mocks.destroyTerminalRuntime).not.toHaveBeenCalled()
    expect(mocks.releaseWorkspaceBrowserTab).not.toHaveBeenCalled()
  })

  it('returns focus to the entry point that opened the panel when it is hidden', () => {
    openFile('src/a.ts')
    store().toggleWorkspace(SESSION)
    expect(store().getSession(SESSION).focus?.target).toBe('side-toggle')
  })

  it('clamps the side width to the readable range', () => {
    store().setSideWidth(10)
    expect(store().sideWidth).toBe(WORKSPACE_SIDE_MIN_WIDTH)
    store().setSideWidth(99999)
    expect(store().sideWidth).toBe(WORKSPACE_SIDE_MAX_WIDTH)
  })
})

describe('tab identity and reuse', () => {
  it('activates the tab a file is already open in instead of duplicating it', () => {
    const first = openFile('src/a.ts')
    openFile('src/b.ts')
    const again = openFile('src/a.ts')

    expect(again).toBe(first)
    expect(sideTabs()).toHaveLength(2)
    expect(store().getSession(SESSION).activeSideTabId).toBe(first)
  })

  it('re-opening at a new line only moves the marker', () => {
    const id = openFile('src/a.ts', { line: 10 })
    const before = store().getTab(SESSION, id)
    openFile('src/a.ts', { line: 42 })
    const after = store().getTab(SESSION, id)

    expect(sideTabs()).toHaveLength(1)
    expect(after).toMatchObject({ kind: 'file', reveal: { line: 42 } })
    expect((after as { reveal?: { nonce: number } }).reveal?.nonce)
      .not.toBe((before as { reveal?: { nonce: number } }).reveal?.nonce)
  })

  it('re-opening the SAME line still bumps the nonce so the view scrolls back', () => {
    const id = openFile('src/a.ts', { line: 10 })
    const first = (store().getTab(SESSION, id) as { reveal?: { nonce: number } }).reveal?.nonce
    openFile('src/a.ts', { line: 10 })
    const second = (store().getTab(SESSION, id) as { reveal?: { nonce: number } }).reveal?.nonce
    expect(second).not.toBe(first)
  })

  it('omitting a reveal leaves the existing marker where it was', () => {
    const id = openFile('src/a.ts', { line: 10 })
    openFile('src/a.ts')
    expect(store().getTab(SESSION, id)).toMatchObject({ reveal: { line: 10 } })
  })

  it('gives every new browser tab its own page and restore identity', () => {
    store().openTarget(SESSION, { kind: 'browser', url: 'http://localhost:3000/' })
    store().openTarget(SESSION, { kind: 'browser', url: 'http://localhost:3000/' })

    const tabs = sideTabs().filter((tab): tab is WorkspaceBrowserTab => tab.kind === 'browser')
    expect(tabs).toHaveLength(2)
    expect(tabs[0]!.browserTabId).not.toBe(tabs[1]!.browserTabId)
    expect(tabs[0]!.storageId).not.toBe(tabs[1]!.storageId)
  })

  it('gives every new terminal its own PTY even with an identical cwd', () => {
    store().openTarget(SESSION, { kind: 'terminal', cwd: '/repo' })
    store().openTarget(SESSION, { kind: 'terminal', cwd: '/repo' })

    const tabs = sideTabs().filter((tab): tab is WorkspaceTerminalTab => tab.kind === 'terminal')
    expect(tabs).toHaveLength(2)
    expect(tabs[0]!.runtimeId).not.toBe(tabs[1]!.runtimeId)
    expect(tabs.map((tab) => tab.ordinal)).toEqual([1, 2])
  })

  it('reuses an existing terminal only when the caller asks for reuse', () => {
    const first = store().openTarget(SESSION, { kind: 'terminal', cwd: '/repo' })
    const reused = store().openTarget(SESSION, { kind: 'terminal', cwd: '/repo', reuse: true })
    expect(reused).toBe(first)
    expect(sideTabs()).toHaveLength(1)
  })

  it('keeps one review tab and retargets its source instead of stacking tabs', () => {
    const first = store().openTarget(SESSION, { kind: 'review' })!
    const again = store().openTarget(SESSION, { kind: 'review', source: { kind: 'staged' } })!

    expect(again).toBe(first)
    expect(sideTabs()).toHaveLength(1)
    expect(store().getTab(SESSION, first)).toMatchObject({ source: { kind: 'staged' } })
  })
})

describe('preview and pinning', () => {
  it('replaces the preview tab on the next single click', () => {
    openFile('a.ts', { preview: true })
    openFile('b.ts', { preview: true })

    expect(sideTabs()).toHaveLength(1)
    expect(sideTabs()[0]).toMatchObject({ path: 'b.ts', preview: true })
  })

  it('never replaces a pinned tab', () => {
    openFile('pinned.ts')
    openFile('preview.ts', { preview: true })
    openFile('next.ts', { preview: true })

    expect(sideTabs().map((tab) => (tab as { path: string }).path)).toEqual(['pinned.ts', 'next.ts'])
  })

  it('pins the preview tab on an explicit open of the same file', () => {
    const id = openFile('a.ts', { preview: true })
    openFile('a.ts')
    expect(store().getTab(SESSION, id)).toMatchObject({ preview: false })

    openFile('b.ts', { preview: true })
    expect(sideTabs()).toHaveLength(2)
  })

  it('pins on demand', () => {
    const id = openFile('a.ts', { preview: true })
    store().pinTab(SESSION, id)
    openFile('b.ts', { preview: true })
    expect(sideTabs()).toHaveLength(2)
  })

  it('lets the content picker take over the active blank browser placeholder', () => {
    store().openTarget(SESSION, { kind: 'browser' })
    store().openTarget(SESSION, { kind: 'file', path: 'a.ts' }, { replaceBlankPlaceholder: true })

    expect(sideTabs()).toHaveLength(1)
    expect(sideTabs()[0]).toMatchObject({ kind: 'file', path: 'a.ts' })
    expect(mocks.releaseWorkspaceBrowserTab).toHaveBeenCalledTimes(1)
  })

  it('lets a tree pick take over the active empty Files tab', () => {
    // The Files launcher with nothing chosen is the same kind of placeholder:
    // the first pick loads into its slot instead of stranding an empty tab.
    store().openTarget(SESSION, { kind: 'file', path: '' }, { preview: true })
    store().openTarget(SESSION, { kind: 'file', path: 'a.ts' }, { replaceBlankPlaceholder: true })

    expect(sideTabs()).toHaveLength(1)
    expect(sideTabs()[0]).toMatchObject({ kind: 'file', path: 'a.ts', preview: false })
  })

  it('keeps the empty Files tab when the pick lands from a non-placeholder tab', () => {
    openFile('a.ts')
    store().openTarget(SESSION, { kind: 'file', path: '' }, { preview: true, background: true })
    store().openTarget(SESSION, { kind: 'file', path: 'b.ts' }, { replaceBlankPlaceholder: true })

    // The placeholder is not the active tab, so the open must add, not replace.
    expect(sideTabs().map((tab) => (tab as { path: string }).path)).toEqual(['a.ts', '', 'b.ts'])
  })

  it('leaves a blank browser tab alone for every other opener', () => {
    store().openTarget(SESSION, { kind: 'browser' })
    openFile('a.ts')

    // A page is "blank" until the host reports a committed URL, so an ordinary
    // open during that window would destroy a page that is still loading.
    expect(sideTabs()).toHaveLength(2)
    expect(mocks.releaseWorkspaceBrowserTab).not.toHaveBeenCalled()
  })

  it('leaves a browser tab that has navigated alone', () => {
    store().openTarget(SESSION, { kind: 'browser', url: 'http://localhost:3000/' })
    openFile('a.ts')
    expect(sideTabs()).toHaveLength(2)
    expect(mocks.releaseWorkspaceBrowserTab).not.toHaveBeenCalled()
  })
})

describe('closing', () => {
  it('prefers the right neighbour, then the left', () => {
    const a = openFile('a.ts')
    const b = openFile('b.ts')
    const c = openFile('c.ts')

    store().activateTab(SESSION, b)
    store().closeTab(SESSION, b)
    expect(store().getSession(SESSION).activeSideTabId).toBe(c)

    store().closeTab(SESSION, c)
    expect(store().getSession(SESSION).activeSideTabId).toBe(a)
  })

  it('releases only the closed tab resources', () => {
    store().openTarget(SESSION, { kind: 'terminal', cwd: '/repo' })
    const second = store().openTarget(SESSION, { kind: 'terminal', cwd: '/repo' })!
    const secondRuntime = (store().getTab(SESSION, second) as WorkspaceTerminalTab).runtimeId

    store().closeTab(SESSION, second)

    expect(mocks.destroyTerminalRuntime).toHaveBeenCalledTimes(1)
    expect(mocks.destroyTerminalRuntime).toHaveBeenCalledWith(secondRuntime)
    expect(sideTabs()).toHaveLength(1)
  })

  it('hides the panel when its last tab closes', () => {
    const id = openFile('a.ts')
    store().closeTab(SESSION, id)
    const state = store().getSession(SESSION)
    expect(state.layout).toBe('hidden')
    expect(state.activeSideTabId).toBeNull()
  })

  it('closes to the right without touching the left', () => {
    const a = openFile('a.ts')
    const b = openFile('b.ts')
    openFile('c.ts')

    store().closeTabs(SESSION, b, 'right')
    expect(sideTabs().map((tab) => tab.id)).toEqual([a, b])
  })

  it('closes others in the same dock only', () => {
    const a = openFile('a.ts')
    openFile('b.ts')
    store().openTarget(SESSION, { kind: 'terminal', cwd: '/repo', dock: 'bottom' })

    store().closeTabs(SESSION, a, 'others')
    expect(sideTabs().map((tab) => tab.id)).toEqual([a])
    expect(bottomTabs()).toHaveLength(1)
  })
})

describe('undo close', () => {
  it('pins a restored preview without competing with the current preview slot', () => {
    const a = openFile('a.ts', { preview: true })
    store().closeTab(SESSION, a)
    openFile('b.ts', { preview: true })
    store().reopenClosedTab(SESSION)
    openFile('c.ts', { preview: true })

    expect(sideTabs().filter((tab) => tab.preview)).toHaveLength(1)
    expect(sideTabs()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: a, path: 'a.ts', preview: false }),
      expect.objectContaining({ path: 'c.ts', preview: true }),
    ]))
    expect(sideTabs()).toHaveLength(2)
  })

  it('reuses an already reopened file and preserves its newer location', () => {
    const closed = openFile('a.ts', { preview: true, line: 3 })
    store().closeTab(SESSION, closed)
    const current = openFile('a.ts', { preview: true, line: 42 })
    openFile('b.ts')

    expect(store().reopenClosedTab(SESSION)).toBe(current)
    expect(sideTabs().filter((tab) => tab.kind === 'file' && tab.path === 'a.ts')).toHaveLength(1)
    expect(store().getTab(SESSION, current)).toMatchObject({ preview: false, reveal: { line: 42 } })
    expect(store().getSession(SESSION).activeSideTabId).toBe(current)
    expect(store().getSession(SESSION).closed).toHaveLength(0)
  })

  it('restores the tab at its old position', () => {
    const a = openFile('a.ts')
    const b = openFile('b.ts')
    openFile('c.ts')

    store().closeTab(SESSION, b)
    const restored = store().reopenClosedTab(SESSION)

    expect(restored).toBe(b)
    expect(sideTabs()[0]!.id).toBe(a)
    expect(sideTabs()[1]!.id).toBe(b)
  })

  it('brings a terminal back as a stopped shell with a fresh runtime, never replaying', () => {
    const id = store().openTarget(SESSION, { kind: 'terminal', cwd: '/repo' })!
    const originalRuntime = (store().getTab(SESSION, id) as WorkspaceTerminalTab).runtimeId

    store().closeTab(SESSION, id)
    store().reopenClosedTab(SESSION)

    const restored = store().getTab(SESSION, id) as WorkspaceTerminalTab
    expect(restored.status).toBe('exited')
    expect(restored.runtimeId).not.toBe(originalRuntime)
  })

  it('gives a restored page a fresh webContents identity', () => {
    const id = store().openTarget(SESSION, { kind: 'browser', url: 'http://localhost:3000/' })!
    const before = (store().getTab(SESSION, id) as WorkspaceBrowserTab).browserTabId

    store().closeTab(SESSION, id)
    store().reopenClosedTab(SESSION)

    const after = store().getTab(SESSION, id) as WorkspaceBrowserTab
    expect(after.browserTabId).not.toBe(before)
    expect(after.url).toBe('http://localhost:3000/')
  })

  it('does nothing when there is nothing to reopen', () => {
    expect(store().reopenClosedTab(SESSION)).toBeNull()
  })
})

describe('review viewed paths', () => {
  it('keeps viewed files for the same source and clears them when the comparison changes', () => {
    const source = { kind: 'turn' as const, turnKey: 'message-1', userMessageIndex: 0 }
    const id = store().openTarget(SESSION, { kind: 'review', source })!
    store().setReviewViewedPaths(SESSION, id, ['src/a.ts', 'src/a.ts'])
    store().setReviewSource(SESSION, id, source)
    expect(store().getTab(SESSION, id)).toMatchObject({ viewedPaths: ['src/a.ts'] })
    store().setReviewSource(SESSION, id, { ...source, userMessageIndex: 1 })
    expect(store().getTab(SESSION, id)).toMatchObject({ viewedPaths: [] })

    store().setReviewViewedPaths(SESSION, id, ['src/b.ts'])
    store().openTarget(SESSION, { kind: 'review', source: { kind: 'unstaged' } })
    expect(store().getTab(SESSION, id)).toMatchObject({ viewedPaths: [] })
  })
})

describe('reordering and docking', () => {
  it('reorders within a dock only', () => {
    const a = openFile('a.ts')
    const b = openFile('b.ts')
    const c = openFile('c.ts')

    store().moveTab(SESSION, c, 0)
    expect(sideTabs().map((tab) => tab.id)).toEqual([c, a, b])
  })

  it('moves a terminal between docks without restarting its PTY', () => {
    const id = store().openTarget(SESSION, { kind: 'terminal', cwd: '/repo' })!
    const runtimeId = (store().getTab(SESSION, id) as WorkspaceTerminalTab).runtimeId

    store().moveTabToDock(SESSION, id, 'bottom')
    expect(bottomTabs().map((tab) => tab.id)).toEqual([id])
    expect(sideTabs()).toHaveLength(0)
    expect((store().getTab(SESSION, id) as WorkspaceTerminalTab).runtimeId).toBe(runtimeId)

    store().moveTabToDock(SESSION, id, 'side')
    expect((store().getTab(SESSION, id) as WorkspaceTerminalTab).runtimeId).toBe(runtimeId)
    expect(mocks.destroyTerminalRuntime).not.toHaveBeenCalled()
  })

  it('refuses to dock anything but a terminal at the bottom', () => {
    const id = openFile('a.ts')
    store().moveTabToDock(SESSION, id, 'bottom')
    expect(bottomTabs()).toHaveLength(0)
  })

  it('hides the side panel when its last tab moves to the bottom', () => {
    const id = store().openTarget(SESSION, { kind: 'terminal', cwd: '/repo' })!
    store().moveTabToDock(SESSION, id, 'bottom')
    expect(store().getSession(SESSION).layout).toBe('hidden')
  })
})

describe('bottom terminal entry point', () => {
  it('creates a terminal the first time and only shows it afterwards', () => {
    store().toggleBottomPanel(SESSION, '/repo')
    expect(bottomTabs()).toHaveLength(1)

    store().toggleBottomPanel(SESSION, '/repo')
    expect(store().getSession(SESSION).bottomOpen).toBe(false)
    expect(bottomTabs()).toHaveLength(1)

    store().toggleBottomPanel(SESSION, '/repo')
    expect(store().getSession(SESSION).bottomOpen).toBe(true)
    expect(bottomTabs()).toHaveLength(1)
  })

  it('always creates a separate shell for an explicit new-terminal action', () => {
    store().toggleBottomPanel(SESSION, '/repo')
    store().openTarget(SESSION, { kind: 'terminal', cwd: '/repo', dock: 'bottom' })
    expect(bottomTabs()).toHaveLength(2)
  })
})

describe('task isolation', () => {
  it('keeps each task workspace separate', () => {
    openFile('a.ts')
    store().openTarget(OTHER, { kind: 'browser', url: 'http://localhost:5173/' })

    expect(sideTabs(SESSION)).toHaveLength(1)
    expect(sideTabs(OTHER)).toHaveLength(1)
    expect(sideTabs(OTHER)[0]!.kind).toBe('browser')
  })

  it('releases everything a task owned when the task closes', () => {
    store().openTarget(SESSION, { kind: 'terminal', cwd: '/repo' })
    store().openTarget(SESSION, { kind: 'browser', url: 'http://localhost:3000/' })
    store().openTarget(OTHER, { kind: 'terminal', cwd: '/other' })

    store().clearSession(SESSION)

    expect(mocks.destroyTerminalRuntime).toHaveBeenCalledTimes(1)
    expect(mocks.releaseWorkspaceBrowserTab).toHaveBeenCalledTimes(1)
    expect(sideTabs(OTHER)).toHaveLength(1)
  })

  it('opens in the background without stealing the active tab', () => {
    const first = openFile('a.ts')
    store().openTarget(SESSION, { kind: 'file', path: 'b.ts' }, { background: true })
    expect(store().getSession(SESSION).activeSideTabId).toBe(first)
    expect(sideTabs()).toHaveLength(2)
  })
})

describe('late host events', () => {
  it('applies a page update to the tab that owns the page', () => {
    const id = store().openTarget(SESSION, { kind: 'browser', url: 'http://a.test/' })!
    const browserTabId = (store().getTab(SESSION, id) as WorkspaceBrowserTab).browserTabId

    store().updateBrowserTab(SESSION, browserTabId, { url: 'http://a.test/next', title: 'Next' })
    expect(store().getTab(SESSION, id)).toMatchObject({ url: 'http://a.test/next', title: 'Next' })
  })

  it('drops an update for a page that has already been closed', () => {
    const first = store().openTarget(SESSION, { kind: 'browser', url: 'http://a.test/' })!
    const closedBrowserTabId = (store().getTab(SESSION, first) as WorkspaceBrowserTab).browserTabId
    store().closeTab(SESSION, first)

    const second = store().openTarget(SESSION, { kind: 'browser', url: 'http://b.test/' })!
    store().updateBrowserTab(SESSION, closedBrowserTabId, { url: 'http://a.test/late' })

    expect(store().getTab(SESSION, second)).toMatchObject({ url: 'http://b.test/' })
  })

  it('drops a terminal exit for a runtime that is gone', () => {
    const id = store().openTarget(SESSION, { kind: 'terminal', cwd: '/repo' })!
    const runtimeId = (store().getTab(SESSION, id) as WorkspaceTerminalTab).runtimeId
    store().closeTab(SESSION, id)

    expect(() => store().setTerminalStatus(SESSION, runtimeId, 'exited')).not.toThrow()
    expect(sideTabs()).toHaveLength(0)
  })
})

describe('titles', () => {
  const labels = {
    newTab: 'New tab',
    review: 'Review',
    files: 'Files',
    terminal: (ordinal: number) => `Terminal ${ordinal}`,
  }

  it('names a file tab that has no file chosen yet after the view itself', () => {
    const id = openFile('')
    expect(workspaceTabTitle(store().getTab(SESSION, id)!, labels)).toBe('Files')
  })

  it('names a file tab by its basename', () => {
    const id = openFile('desktop/src/api/adapters.ts')
    expect(workspaceTabTitle(store().getTab(SESSION, id)!, labels)).toBe('adapters.ts')
  })

  it('falls back to the host, then to the new-tab label, for a page with no title', () => {
    const withUrl = store().openTarget(SESSION, { kind: 'browser', url: 'https://example.test/a' })!
    const blank = store().openTarget(SESSION, { kind: 'browser' })!

    expect(workspaceTabTitle(store().getTab(SESSION, withUrl)!, labels)).toBe('example.test')
    expect(workspaceTabTitle(store().getTab(SESSION, blank)!, labels)).toBe('New tab')
  })

  it('numbers terminals by their stable ordinal', () => {
    store().openTarget(SESSION, { kind: 'terminal', cwd: '/repo' })
    const second = store().openTarget(SESSION, { kind: 'terminal', cwd: '/repo' })!
    expect(workspaceTabTitle(store().getTab(SESSION, second)!, labels)).toBe('Terminal 2')
  })
})

describe('resource ownership', () => {
  it('finds the task that owns a page from the page id alone', () => {
    const mine = store().openTarget(SESSION, { kind: 'browser', url: 'http://a.test/' })!
    const theirs = store().openTarget(OTHER, { kind: 'browser', url: 'http://b.test/' })!
    const theirBrowserTabId = (store().getTab(OTHER, theirs) as WorkspaceBrowserTab).browserTabId

    // Host events name the page, never the task, and a page outlives its React
    // surface — so assuming the foreground task drops background events and
    // misfiles popups into whatever the user happens to be reading.
    expect(store().findBrowserTabOwner(theirBrowserTabId))
      .toEqual({ sessionId: OTHER, tabId: theirs })
    expect(store().findBrowserTabOwner('never-existed')).toBeNull()

    store().closeTab(OTHER, theirs)
    expect(store().findBrowserTabOwner(theirBrowserTabId)).toBeNull()
    expect(store().getTabs(SESSION, 'side').map((tab) => tab.id)).toEqual([mine])
  })
})

describe('dock-scoped closing', () => {
  it('keeps the empty-workspace launcher when the last bottom terminal closes', () => {
    store().toggleWorkspace(SESSION)
    const bottom = store().openTarget(SESSION, { kind: 'terminal', cwd: '/repo', dock: 'bottom' })!
    expect(store().getSession(SESSION).layout).toBe('split')

    store().closeTab(SESSION, bottom)

    // An open side panel with no tabs is a legitimate state: it is the
    // four-entry launcher. Closing a bottom terminal must not collapse it.
    expect(store().getSession(SESSION).layout).toBe('split')
    expect(store().getSession(SESSION).bottomOpen).toBe(false)
  })

  it('returns focus to the toggle only when the closed tab left its dock empty', () => {
    const side = openFile('a.ts')
    store().openTarget(SESSION, { kind: 'terminal', cwd: '/repo', dock: 'bottom' })

    store().closeTab(SESSION, side)

    // The flat tab count still shows the bottom terminal, but the side dock is
    // empty and its panel has just been hidden.
    expect(store().getSession(SESSION).focus?.target).toBe('side-toggle')
  })
})

describe('undo across multiple closes', () => {
  it('restores each tab to the slot it was closed from', () => {
    const a = openFile('a.ts')
    const b = openFile('b.ts')
    const c = openFile('c.ts')

    store().closeTabs(SESSION, c, 'left')
    expect(sideTabs().map((tab) => tab.id)).toEqual([c])

    store().reopenClosedTab(SESSION)
    store().reopenClosedTab(SESSION)

    expect(sideTabs().map((tab) => tab.id)).toEqual([a, b, c])
  })

  it('restores a bottom tab into the bottom dock', () => {
    const side = openFile('a.ts')
    const bottom = store().openTarget(SESSION, { kind: 'terminal', cwd: '/repo', dock: 'bottom' })!

    store().closeTab(SESSION, bottom)
    store().reopenClosedTab(SESSION)

    expect(bottomTabs().map((tab) => tab.id)).toEqual([bottom])
    expect(sideTabs().map((tab) => tab.id)).toEqual([side])
  })
})

describe('background opens that replace a tab', () => {
  it('never leaves the active id naming a tab that is gone', () => {
    const preview = openFile('a.ts', { preview: true })
    expect(store().getSession(SESSION).activeSideTabId).toBe(preview)

    store().openTarget(SESSION, { kind: 'file', path: 'b.ts' }, { preview: true, background: true })

    const active = store().getSession(SESSION).activeSideTabId
    expect(sideTabs().map((tab) => tab.id)).toContain(active)
    expect(store().getActiveTab(SESSION, 'side')).not.toBeNull()
  })
})

describe('tab ceiling', () => {
  it('refuses to open past the per-dock limit', () => {
    // A page can ask for a sibling tab via `window.open`, and each one is a real
    // renderer process — a loop would otherwise open them until the machine
    // gave out.
    for (let index = 0; index < 100; index += 1) {
      store().openTarget(SESSION, { kind: 'browser', url: `http://a.test/${index}` })
    }

    expect(sideTabs().length).toBeLessThanOrEqual(60)
  })

  it('leaves the existing tabs untouched when the limit is reached', () => {
    for (let index = 0; index < 60; index += 1) {
      store().openTarget(SESSION, { kind: 'browser', url: `http://a.test/${index}` })
    }
    const before = sideTabs().map((tab) => tab.id)

    const refused = store().openTarget(SESSION, { kind: 'browser', url: 'http://a.test/extra' })

    expect(refused).toBeNull()
    expect(sideTabs().map((tab) => tab.id)).toEqual(before)
    expect(mocks.releaseWorkspaceBrowserTab).not.toHaveBeenCalled()
  })
})
