import { create } from 'zustand'
import { destroyTerminalRuntime } from '../lib/terminalRuntime'
import { releaseWorkspaceBrowserTab } from '../lib/workspace/browserHost'
import { useWorkspaceBrowserStore } from './workspaceBrowserStore'
import {
  DEFAULT_REVIEW_SOURCE,
  basenameOf,
  isBlankBrowserTab,
  isBlankFileTab,
  reviewSourceKey,
  type WorkspaceBrowserTab,
  type WorkspaceClosedGroup,
  type WorkspaceCloseScope,
  type WorkspaceDock,
  type WorkspaceLayout,
  type WorkspaceOpenOptions,
  type WorkspaceReviewSource,
  type WorkspaceReviewTab,
  type WorkspaceTab,
  type WorkspaceTarget,
  type WorkspaceTerminalTabStatus,
} from '../lib/workspace/types'

export const WORKSPACE_SIDE_DEFAULT_WIDTH = 860
export const WORKSPACE_SIDE_MIN_WIDTH = 420
export const WORKSPACE_SIDE_MAX_WIDTH = 1120

export const WORKSPACE_BOTTOM_DEFAULT_HEIGHT = 420
export const WORKSPACE_BOTTOM_MIN_HEIGHT = 260
export const WORKSPACE_BOTTOM_MAX_HEIGHT = 760

/** How many closed tabs "reopen closed tab" can walk back through. */
const UNDO_STACK_LIMIT = 12

/**
 * Upper bound on tabs in one dock.
 *
 * A page can ask for a sibling tab (`window.open`, `target=_blank`), and each
 * one is a real renderer process. Without a ceiling a hostile or merely buggy
 * page can open them in a loop until the machine gives out.
 */
const MAX_TABS_PER_DOCK = 60

/**
 * Where the UI should put keyboard focus next, and a nonce so the same request
 * twice in a row still fires. The controller owns focus because focus follows
 * navigation: hiding a panel has to return the caret to the entry point that
 * opened it, and closing a tab has to land on whatever became active.
 */
export type WorkspaceFocusRequest = {
  target: 'side-toggle' | 'bottom-toggle' | 'active-side-tab' | 'active-bottom-tab'
  nonce: number
}

/**
 * The chat element that caused the workspace to open, so the conversation can
 * scroll back to it. Carried here rather than in the chat because the workspace
 * is what knows when it was opened and by what.
 */
export type WorkspaceOrigin = {
  sourceTurnKey: string
  sourceElementId: string
}

export type WorkspaceSessionState = {
  layout: WorkspaceLayout
  bottomOpen: boolean
  tabs: WorkspaceTab[]
  activeSideTabId: string | null
  activeBottomTabId: string | null
  closed: WorkspaceClosedGroup[]
  /** Next terminal label number. Monotonic so labels never collide. */
  nextTerminalOrdinal: number
  focus: WorkspaceFocusRequest | null
  origin: WorkspaceOrigin | null
}

type WorkspaceStore = {
  bySession: Record<string, WorkspaceSessionState | undefined>
  sideWidth: number
  bottomHeight: number

  getSession: (sessionId: string) => WorkspaceSessionState
  getTabs: (sessionId: string, dock: WorkspaceDock) => WorkspaceTab[]
  getActiveTab: (sessionId: string, dock: WorkspaceDock) => WorkspaceTab | null
  getTab: (sessionId: string, tabId: string) => WorkspaceTab | null
  /**
   * Which task owns a live page. Host events name the page, not the task, and
   * a page outlives its React surface — so the only correct way to route an
   * event is to look its owner up, never to assume the foreground task.
   */
  findBrowserTabOwner: (browserTabId: string) => { sessionId: string; tabId: string } | null

  setSideWidth: (width: number) => void
  setBottomHeight: (height: number) => void

  setLayout: (sessionId: string, layout: WorkspaceLayout) => void
  toggleWorkspace: (sessionId: string) => void
  toggleFullscreen: (sessionId: string) => void
  toggleBottomPanel: (sessionId: string, cwd: string) => void

  openTarget: (
    sessionId: string,
    target: WorkspaceTarget,
    options?: WorkspaceOpenOptions,
  ) => string | null
  activateTab: (sessionId: string, tabId: string) => void
  pinTab: (sessionId: string, tabId: string) => void
  closeTab: (sessionId: string, tabId: string) => void
  closeTabs: (sessionId: string, tabId: string, scope: WorkspaceCloseScope) => void
  moveTab: (sessionId: string, tabId: string, targetIndex: number) => void
  moveTabToDock: (sessionId: string, tabId: string, dock: WorkspaceDock) => void
  reopenClosedTab: (sessionId: string) => string | null

  updateBrowserTab: (
    sessionId: string,
    browserTabId: string,
    patch: Partial<Pick<WorkspaceBrowserTab, 'url' | 'title' | 'loadError'>>,
  ) => void
  setReviewSource: (sessionId: string, tabId: string, source: WorkspaceReviewSource) => void
  setReviewSelectedPath: (sessionId: string, tabId: string, path: string | null) => void
  setReviewViewedPaths: (sessionId: string, tabId: string, paths: string[], snapshot?: string) => void
  setTerminalStatus: (
    sessionId: string,
    runtimeId: string,
    status: WorkspaceTerminalTabStatus,
  ) => void

  consumeFocusRequest: (sessionId: string) => void
  setOrigin: (sessionId: string, origin: WorkspaceOrigin | null) => void
  clearSession: (sessionId: string) => void
  replaceAll: (bySession: Record<string, WorkspaceSessionState>) => void
}

export const EMPTY_WORKSPACE_SESSION: WorkspaceSessionState = {
  layout: 'hidden',
  bottomOpen: false,
  tabs: [],
  activeSideTabId: null,
  activeBottomTabId: null,
  closed: [],
  nextTerminalOrdinal: 1,
  focus: null,
  origin: null,
}

let idCounter = 0
function nextId(prefix: string) {
  idCounter += 1
  return `${prefix}-${idCounter.toString(36)}-${Date.now().toString(36)}`
}

/** Test seam: makes generated ids reproducible across cases. */
export function __resetWorkspaceIdCounterForTest() {
  idCounter = 0
}

let focusNonce = 0

export function clampWorkspaceSideWidth(width: number) {
  if (!Number.isFinite(width)) return WORKSPACE_SIDE_DEFAULT_WIDTH
  return Math.min(WORKSPACE_SIDE_MAX_WIDTH, Math.max(WORKSPACE_SIDE_MIN_WIDTH, Math.round(width)))
}

export function clampWorkspaceBottomHeight(height: number) {
  if (!Number.isFinite(height)) return WORKSPACE_BOTTOM_DEFAULT_HEIGHT
  return Math.min(
    WORKSPACE_BOTTOM_MAX_HEIGHT,
    Math.max(WORKSPACE_BOTTOM_MIN_HEIGHT, Math.round(height)),
  )
}

function session(
  bySession: Record<string, WorkspaceSessionState | undefined>,
  sessionId: string,
): WorkspaceSessionState {
  return bySession[sessionId] ?? EMPTY_WORKSPACE_SESSION
}

function tabsInDock(state: WorkspaceSessionState, dock: WorkspaceDock) {
  return state.tabs.filter((tab) => tab.dock === dock)
}

function activeIdKey(dock: WorkspaceDock): 'activeSideTabId' | 'activeBottomTabId' {
  return dock === 'side' ? 'activeSideTabId' : 'activeBottomTabId'
}

function withFocus(
  state: WorkspaceSessionState,
  target: WorkspaceFocusRequest['target'],
): WorkspaceSessionState {
  focusNonce += 1
  return { ...state, focus: { target, nonce: focusNonce } }
}

/**
 * Release whatever the tab was keeping alive. Called only from real closes —
 * hiding a panel, switching tasks and unmounting React must never reach here,
 * which is exactly the bug the old `BrowserSurface` teardown had.
 */
function releaseTabResources(tab: WorkspaceTab) {
  if (tab.kind === 'terminal') {
    destroyTerminalRuntime(tab.runtimeId)
    return
  }
  if (tab.kind === 'browser') {
    releaseWorkspaceBrowserTab(tab.browserTabId)
    // The host owns the page; this store owns what the renderer learned about
    // it. Releasing one without the other leaves a visit log and a nav state
    // for a page that no longer exists, for the life of the process.
    useWorkspaceBrowserStore.getState().forgetTab(tab.browserTabId)
  }
}

/**
 * Pick what becomes active after `closedIds` leave `dock`.
 *
 * Right neighbour first, then left — the rule users already know from every
 * editor: closing a run of tabs left-to-right keeps walking rightwards instead
 * of jumping back to the start.
 */
function nextActiveAfterClose(
  previousDockTabs: WorkspaceTab[],
  remainingDockTabs: WorkspaceTab[],
  activeId: string | null,
): string | null {
  if (remainingDockTabs.length === 0) return null
  if (activeId && remainingDockTabs.some((tab) => tab.id === activeId)) return activeId

  const previousIndex = previousDockTabs.findIndex((tab) => tab.id === activeId)
  if (previousIndex < 0) return remainingDockTabs[0]?.id ?? null

  const remainingIds = new Set(remainingDockTabs.map((tab) => tab.id))
  for (let i = previousIndex + 1; i < previousDockTabs.length; i += 1) {
    const candidate = previousDockTabs[i]
    if (candidate && remainingIds.has(candidate.id)) return candidate.id
  }
  for (let i = previousIndex - 1; i >= 0; i -= 1) {
    const candidate = previousDockTabs[i]
    if (candidate && remainingIds.has(candidate.id)) return candidate.id
  }
  return remainingDockTabs[0]?.id ?? null
}

function removeTabs(
  state: WorkspaceSessionState,
  removeIds: Set<string>,
): WorkspaceSessionState {
  if (removeIds.size === 0) return state

  const removed = state.tabs.filter((tab) => removeIds.has(tab.id))
  if (removed.length === 0) return state

  const previousSide = tabsInDock(state, 'side')
  const previousBottom = tabsInDock(state, 'bottom')
  const remaining = state.tabs.filter((tab) => !removeIds.has(tab.id))

  for (const tab of removed) releaseTabResources(tab)

  const nextSide = remaining.filter((tab) => tab.dock === 'side')
  const nextBottom = remaining.filter((tab) => tab.dock === 'bottom')
  const removedSide = removed.some((tab) => tab.dock === 'side')
  const removedBottom = removed.some((tab) => tab.dock === 'bottom')

  // One entry per close *action*, holding every tab it removed with that tab's
  // index inside its own dock, captured against the pre-removal order.
  const closed: WorkspaceClosedGroup[] = [
    ...state.closed,
    {
      tabs: removed.map((tab) => ({
        tab,
        dockIndex: (tab.dock === 'side' ? previousSide : previousBottom)
          .findIndex((candidate) => candidate.id === tab.id),
      })),
    },
  ].slice(-UNDO_STACK_LIMIT)

  return {
    ...state,
    tabs: remaining,
    activeSideTabId: nextActiveAfterClose(previousSide, nextSide, state.activeSideTabId),
    activeBottomTabId: nextActiveAfterClose(previousBottom, nextBottom, state.activeBottomTabId),
    // Closing the last tab of a dock hides *that* dock. Scoped to the dock that
    // actually lost something: an empty side panel is a legitimate state — it is
    // the four-entry launcher — so closing the last bottom terminal must not
    // collapse the launcher the user is looking at.
    layout: removedSide && nextSide.length === 0 ? 'hidden' : state.layout,
    bottomOpen: removedBottom && nextBottom.length === 0 ? false : state.bottomOpen,
    closed,
  }
}

function insertTab(
  state: WorkspaceSessionState,
  tab: WorkspaceTab,
  options: { activate: boolean; replaceTabId?: string },
): WorkspaceSessionState {
  let tabs: WorkspaceTab[]
  if (options.replaceTabId) {
    const index = state.tabs.findIndex((candidate) => candidate.id === options.replaceTabId)
    if (index >= 0) {
      const replaced = state.tabs[index]!
      releaseTabResources(replaced)
      tabs = [...state.tabs]
      tabs[index] = tab
    } else {
      tabs = [...state.tabs, tab]
    }
  } else {
    tabs = [...state.tabs, tab]
  }

  const key = activeIdKey(tab.dock)
  // When the tab being replaced was the active one, the new tab inherits that
  // slot even for a background open — otherwise the active id names a tab that
  // no longer exists and the dock renders a populated strip over a blank pane.
  const replacedWasActive = options.replaceTabId !== undefined &&
    state[key] === options.replaceTabId
  return {
    ...state,
    tabs,
    [key]: options.activate || replacedWasActive ? tab.id : (state[key] ?? tab.id),
    layout: tab.dock === 'side' && state.layout === 'hidden' ? 'split' : state.layout,
    bottomOpen: tab.dock === 'bottom' ? true : state.bottomOpen,
  }
}

function pinPreviewTab(state: WorkspaceSessionState, tabId: string): WorkspaceSessionState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId)
  if (index < 0) return state
  const tab = state.tabs[index]!
  if (!tab.preview) return state
  const tabs = [...state.tabs]
  tabs[index] = { ...tab, preview: false }
  return { ...state, tabs }
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  bySession: {},
  sideWidth: WORKSPACE_SIDE_DEFAULT_WIDTH,
  bottomHeight: WORKSPACE_BOTTOM_DEFAULT_HEIGHT,

  getSession: (sessionId) => session(get().bySession, sessionId),
  getTabs: (sessionId, dock) => tabsInDock(session(get().bySession, sessionId), dock),
  getActiveTab: (sessionId, dock) => {
    const state = session(get().bySession, sessionId)
    const activeId = state[activeIdKey(dock)]
    return state.tabs.find((tab) => tab.id === activeId) ?? null
  },
  getTab: (sessionId, tabId) =>
    session(get().bySession, sessionId).tabs.find((tab) => tab.id === tabId) ?? null,

  findBrowserTabOwner: (browserTabId) => {
    for (const [sessionId, state] of Object.entries(get().bySession)) {
      const tab = state?.tabs.find(
        (candidate) => candidate.kind === 'browser' && candidate.browserTabId === browserTabId,
      )
      if (tab) return { sessionId, tabId: tab.id }
    }
    return null
  },

  setSideWidth: (width) => set({ sideWidth: clampWorkspaceSideWidth(width) }),
  setBottomHeight: (height) => set({ bottomHeight: clampWorkspaceBottomHeight(height) }),

  setLayout: (sessionId, layout) =>
    set((store) => {
      const current = session(store.bySession, sessionId)
      if (current.layout === layout) return store
      const next = layout === 'hidden'
        ? withFocus({ ...current, layout }, 'side-toggle')
        : withFocus({ ...current, layout }, 'active-side-tab')
      return { bySession: { ...store.bySession, [sessionId]: next } }
    }),

  toggleWorkspace: (sessionId) =>
    set((store) => {
      const current = session(store.bySession, sessionId)
      const next = current.layout === 'hidden'
        // Re-opening restores split, never full: `full` hides the conversation,
        // and a toggle should not swallow the chat the user was reading.
        ? withFocus({ ...current, layout: 'split' }, 'active-side-tab')
        : withFocus({ ...current, layout: 'hidden' }, 'side-toggle')
      return { bySession: { ...store.bySession, [sessionId]: next } }
    }),

  toggleFullscreen: (sessionId) =>
    set((store) => {
      const current = session(store.bySession, sessionId)
      // Maximising is a presentation change only: no tab is created, no page
      // reloads and no PTY restarts, which is what made the old "expand into a
      // global app tab" behaviour wrong.
      const layout: WorkspaceLayout = current.layout === 'full' ? 'split' : 'full'
      return {
        bySession: {
          ...store.bySession,
          [sessionId]: withFocus({ ...current, layout }, 'active-side-tab'),
        },
      }
    }),

  toggleBottomPanel: (sessionId, cwd) => {
    const current = session(get().bySession, sessionId)
    const bottomTabs = tabsInDock(current, 'bottom')

    if (current.bottomOpen) {
      set((store) => ({
        bySession: {
          ...store.bySession,
          [sessionId]: withFocus({ ...session(store.bySession, sessionId), bottomOpen: false }, 'bottom-toggle'),
        },
      }))
      return
    }

    if (bottomTabs.length > 0) {
      // Show and activate what is already running. Only an explicit "new
      // terminal" spawns another shell.
      set((store) => {
        const state = session(store.bySession, sessionId)
        const tabs = tabsInDock(state, 'bottom')
        const activeId = state.activeBottomTabId && tabs.some((tab) => tab.id === state.activeBottomTabId)
          ? state.activeBottomTabId
          : tabs[tabs.length - 1]?.id ?? null
        return {
          bySession: {
            ...store.bySession,
            [sessionId]: withFocus(
              { ...state, bottomOpen: true, activeBottomTabId: activeId },
              'active-bottom-tab',
            ),
          },
        }
      })
      return
    }

    get().openTarget(sessionId, { kind: 'terminal', cwd, dock: 'bottom' })
  },

  openTarget: (sessionId, target, options = {}) => {
    const activate = options.background !== true
    const preview = options.preview === true
    let createdId: string | null = null

    set((store) => {
      const current = session(store.bySession, sessionId)
      const dock: WorkspaceDock = target.kind === 'terminal' ? target.dock ?? 'side' : 'side'
      const dockTabs = tabsInDock(current, dock)
      const activeId = current[activeIdKey(dock)]

      // --- Reuse rules -----------------------------------------------------
      if (target.kind === 'file') {
        const existing = dockTabs.find(
          (tab) => tab.kind === 'file' && tab.path === target.path,
        )
        if (existing) {
          createdId = existing.id
          const index = current.tabs.findIndex((tab) => tab.id === existing.id)
          const tabs = [...current.tabs]
          tabs[index] = {
            ...(existing as typeof existing & { kind: 'file' }),
            // A new line request only moves the marker; it never forks a tab.
            reveal: target.reveal
              ? { ...target.reveal, nonce: ++focusNonce }
              : (existing as { reveal?: never }).reveal,
            // An explicit (non-preview) open pins whatever was previewed.
            preview: preview ? existing.preview : false,
          } as WorkspaceTab
          let next: WorkspaceSessionState = { ...current, tabs }
          if (activate) {
            next = withFocus(
              { ...next, [activeIdKey(dock)]: existing.id, layout: next.layout === 'hidden' ? 'split' : next.layout },
              'active-side-tab',
            )
          }
          return { bySession: { ...store.bySession, [sessionId]: next } }
        }
      }

      if (target.kind === 'review') {
        const source = target.source ?? DEFAULT_REVIEW_SOURCE
        const existing = dockTabs.find((tab): tab is WorkspaceReviewTab => tab.kind === 'review')
        if (existing) {
          createdId = existing.id
          const index = current.tabs.findIndex((tab) => tab.id === existing.id)
          const tabs = [...current.tabs]
          tabs[index] = {
            ...existing,
            source: target.source ? source : existing.source,
            viewedSnapshot: target.source && reviewSourceKey(source) !== reviewSourceKey(existing.source) ? undefined : existing.viewedSnapshot,
            viewedPaths: target.source && reviewSourceKey(source) !== reviewSourceKey(existing.source)
              ? []
              : existing.viewedPaths,
            selectedPath: target.path ?? existing.selectedPath,
            preview: false,
          }
          let next: WorkspaceSessionState = { ...current, tabs }
          if (activate) {
            next = withFocus(
              { ...next, activeSideTabId: existing.id, layout: next.layout === 'hidden' ? 'split' : next.layout },
              'active-side-tab',
            )
          }
          return { bySession: { ...store.bySession, [sessionId]: next } }
        }
      }

      if (target.kind === 'terminal' && target.reuse) {
        const existing = dockTabs.find((tab) => tab.kind === 'terminal')
        if (existing) {
          createdId = existing.id
          const next = activate
            ? withFocus(
                {
                  ...current,
                  [activeIdKey(dock)]: existing.id,
                  ...(dock === 'side'
                    ? { layout: current.layout === 'hidden' ? 'split' : current.layout }
                    : { bottomOpen: true }),
                },
                dock === 'side' ? 'active-side-tab' : 'active-bottom-tab',
              )
            : current
          return { bySession: { ...store.bySession, [sessionId]: next } }
        }
      }

      // --- Creation --------------------------------------------------------
      // A preview open takes over the existing preview slot. Placeholder tabs
      // are the other replaceable kind: picking a file while the empty Files
      // launcher is showing, or picking a different kind on a blank browser
      // page, should not leave the empty tab behind.
      const previewVictim = preview
        ? dockTabs.find((tab) => tab.preview)
        : undefined
      const blankVictim = options.replaceBlankPlaceholder === true && !preview && target.kind !== 'browser'
        ? dockTabs.find((tab) => tab.id === activeId && (isBlankBrowserTab(tab) || isBlankFileTab(tab)))
        : undefined
      const replaceTabId = previewVictim?.id ?? blankVictim?.id

      if (dockTabs.length >= MAX_TABS_PER_DOCK) return store

      const createdAt = Date.now()
      let tab: WorkspaceTab
      let nextTerminalOrdinal = current.nextTerminalOrdinal

      switch (target.kind) {
        case 'file':
          tab = {
            id: nextId('wt-file'),
            kind: 'file',
            dock: 'side',
            preview,
            createdAt,
            path: target.path,
            ...(target.reveal ? { reveal: { ...target.reveal, nonce: ++focusNonce } } : {}),
          }
          break
        case 'browser':
          tab = {
            id: nextId('wt-web'),
            kind: 'browser',
            dock: 'side',
            preview,
            createdAt,
            // Two independent identities on purpose: `browserTabId` addresses
            // the live webContents, `storageId` is what a restart reopens.
            browserTabId: nextId('wb'),
            storageId: nextId('wsb'),
            url: target.url ?? null,
            title: null,
            loadError: null,
          }
          break
        case 'review':
          tab = {
            id: nextId('wt-review'),
            kind: 'review',
            dock: 'side',
            preview: false,
            createdAt,
            source: target.source ?? DEFAULT_REVIEW_SOURCE,
            selectedPath: target.path ?? null,
          }
          break
        case 'terminal':
          tab = {
            id: nextId('wt-term'),
            kind: 'terminal',
            dock,
            preview: false,
            createdAt,
            runtimeId: nextId('wterm'),
            cwd: target.cwd ?? '',
            status: 'live',
            ordinal: nextTerminalOrdinal,
          }
          nextTerminalOrdinal += 1
          break
      }

      createdId = tab.id
      const inserted = insertTab({ ...current, nextTerminalOrdinal }, tab, {
        activate,
        ...(replaceTabId ? { replaceTabId } : {}),
      })
      const next = activate
        ? withFocus(inserted, dock === 'side' ? 'active-side-tab' : 'active-bottom-tab')
        : inserted
      return { bySession: { ...store.bySession, [sessionId]: next } }
    })

    return createdId
  },

  activateTab: (sessionId, tabId) =>
    set((store) => {
      const current = session(store.bySession, sessionId)
      const tab = current.tabs.find((candidate) => candidate.id === tabId)
      if (!tab) return store
      const key = activeIdKey(tab.dock)
      if (current[key] === tabId) return store
      return {
        bySession: {
          ...store.bySession,
          [sessionId]: withFocus(
            { ...current, [key]: tabId },
            tab.dock === 'side' ? 'active-side-tab' : 'active-bottom-tab',
          ),
        },
      }
    }),

  pinTab: (sessionId, tabId) =>
    set((store) => {
      const current = session(store.bySession, sessionId)
      const next = pinPreviewTab(current, tabId)
      if (next === current) return store
      return { bySession: { ...store.bySession, [sessionId]: next } }
    }),

  closeTab: (sessionId, tabId) => get().closeTabs(sessionId, tabId, 'current'),

  closeTabs: (sessionId, tabId, scope) =>
    set((store) => {
      const current = session(store.bySession, sessionId)
      const target = current.tabs.find((tab) => tab.id === tabId)
      if (!target) return store

      const dockTabs = tabsInDock(current, target.dock)
      const index = dockTabs.findIndex((tab) => tab.id === tabId)
      let doomed: WorkspaceTab[]
      switch (scope) {
        case 'others':
          doomed = dockTabs.filter((tab) => tab.id !== tabId)
          break
        case 'left':
          doomed = dockTabs.slice(0, index)
          break
        case 'right':
          doomed = dockTabs.slice(index + 1)
          break
        case 'all':
          doomed = dockTabs
          break
        default:
          doomed = [target]
      }

      const next = removeTabs(current, new Set(doomed.map((tab) => tab.id)))
      if (next === current) return store
      // Whether focus lands on content or returns to the toggle depends on
      // whether *this dock* still has anything to show, not on the flat tab
      // count across both docks.
      const dockHasTabs = next.tabs.some((tab) => tab.dock === target.dock)
      const focused = dockHasTabs
        ? withFocus(next, target.dock === 'side' ? 'active-side-tab' : 'active-bottom-tab')
        : withFocus(next, target.dock === 'side' ? 'side-toggle' : 'bottom-toggle')
      return { bySession: { ...store.bySession, [sessionId]: focused } }
    }),

  moveTab: (sessionId, tabId, targetIndex) =>
    set((store) => {
      const current = session(store.bySession, sessionId)
      const tab = current.tabs.find((candidate) => candidate.id === tabId)
      if (!tab) return store

      const dockTabs = tabsInDock(current, tab.dock)
      const from = dockTabs.findIndex((candidate) => candidate.id === tabId)
      const to = Math.min(Math.max(targetIndex, 0), dockTabs.length - 1)
      if (from < 0 || from === to) return store

      const reordered = [...dockTabs]
      const [moved] = reordered.splice(from, 1)
      reordered.splice(to, 0, moved!)

      // Rebuild the flat list so the other dock's relative order is untouched.
      const queue = [...reordered]
      const tabs = current.tabs.map((candidate) =>
        candidate.dock === tab.dock ? queue.shift()! : candidate,
      )
      return { bySession: { ...store.bySession, [sessionId]: { ...current, tabs } } }
    }),

  moveTabToDock: (sessionId, tabId, dock) =>
    set((store) => {
      const current = session(store.bySession, sessionId)
      const index = current.tabs.findIndex((tab) => tab.id === tabId)
      if (index < 0) return store
      const tab = current.tabs[index]!
      // Only terminals live in two places. A moved terminal keeps its PTY: the
      // dock is presentation, the runtime id is the resource.
      if (tab.kind !== 'terminal' || tab.dock === dock) return store

      const previousDock = tab.dock
      const tabs = [...current.tabs]
      tabs[index] = { ...tab, dock }

      const previousDockRemaining = tabs.filter((candidate) => candidate.dock === previousDock)
      const next: WorkspaceSessionState = {
        ...current,
        tabs,
        [activeIdKey(dock)]: tabId,
        [activeIdKey(previousDock)]:
          current[activeIdKey(previousDock)] === tabId
            ? previousDockRemaining[previousDockRemaining.length - 1]?.id ?? null
            : current[activeIdKey(previousDock)],
        ...(dock === 'bottom' ? { bottomOpen: true } : {}),
        ...(dock === 'side' && current.layout === 'hidden' ? { layout: 'split' as const } : {}),
        ...(previousDock === 'bottom' && previousDockRemaining.length === 0
          ? { bottomOpen: false }
          : {}),
        ...(previousDock === 'side' && previousDockRemaining.length === 0
          ? { layout: 'hidden' as const }
          : {}),
      }
      return {
        bySession: {
          ...store.bySession,
          [sessionId]: withFocus(next, dock === 'side' ? 'active-side-tab' : 'active-bottom-tab'),
        },
      }
    }),

  reopenClosedTab: (sessionId) => {
    let restoredId: string | null = null
    set((store) => {
      const current = session(store.bySession, sessionId)
      const group = current.closed[current.closed.length - 1]
      if (!group || group.tabs.length === 0) return store

      const tabs = [...current.tabs]
      let layout = current.layout
      let bottomOpen = current.bottomOpen
      const activeByDock: Partial<Record<WorkspaceDock, string>> = {}

      // Lowest index first so each insertion lands in a list that already holds
      // everything that belonged to its left.
      for (const entry of [...group.tabs].sort((a, b) => a.dockIndex - b.dockIndex)) {
        const closedTab = entry.tab
        const existingIndex = closedTab.kind === 'file'
          ? tabs.findIndex((candidate) => candidate.kind === 'file' && candidate.path === closedTab.path)
          : -1
        // The file may have been reopened since this close action. Keep its
        // current identity and location; undo is an explicit durable open.
        if (existingIndex >= 0) {
          const existing = tabs[existingIndex]!
          tabs[existingIndex] = { ...existing, preview: false }
          activeByDock[existing.dock] = existing.id
          restoredId = existing.id
          if (layout === 'hidden') layout = 'split'
          continue
        }
        // A restored terminal is a fresh, stopped shell: new runtime id, no
        // replay. Pretending the old PTY is back is how "undo close" would
        // silently re-run whatever the user last typed.
        const tab: WorkspaceTab = entry.tab.kind === 'terminal'
          ? { ...entry.tab, runtimeId: nextId('wterm'), status: 'exited' }
          : entry.tab.kind === 'browser'
            ? { ...entry.tab, preview: false, browserTabId: nextId('wb'), loadError: null }
            // Restoring a closed preview must not create another replaceable
            // slot or discard the preview the user is currently looking at.
            : { ...entry.tab, preview: false }

        const dockTabs = tabs.filter((candidate) => candidate.dock === tab.dock)
        const successor = dockTabs[entry.dockIndex]
        const insertAt = successor
          ? tabs.findIndex((candidate) => candidate.id === successor.id)
          : tabs.length
        tabs.splice(insertAt < 0 ? tabs.length : insertAt, 0, tab)

        activeByDock[tab.dock] = tab.id
        restoredId = tab.id
        if (tab.dock === 'bottom') bottomOpen = true
        else if (layout === 'hidden') layout = 'split'
      }

      const lastDock: WorkspaceDock = activeByDock.side ? 'side' : 'bottom'
      const next: WorkspaceSessionState = {
        ...current,
        tabs,
        layout,
        bottomOpen,
        closed: current.closed.slice(0, -1),
        ...(activeByDock.side ? { activeSideTabId: activeByDock.side } : {}),
        ...(activeByDock.bottom ? { activeBottomTabId: activeByDock.bottom } : {}),
      }
      return {
        bySession: {
          ...store.bySession,
          [sessionId]: withFocus(next, lastDock === 'side' ? 'active-side-tab' : 'active-bottom-tab'),
        },
      }
    })
    return restoredId
  },

  updateBrowserTab: (sessionId, browserTabId, patch) =>
    set((store) => {
      const current = session(store.bySession, sessionId)
      const index = current.tabs.findIndex(
        (tab) => tab.kind === 'browser' && tab.browserTabId === browserTabId,
      )
      // A late event from a page that has already been closed must not
      // resurrect it or leak onto whatever took its slot.
      if (index < 0) return store
      const tab = current.tabs[index] as WorkspaceBrowserTab
      const nextTab: WorkspaceBrowserTab = { ...tab, ...patch }
      if (
        nextTab.url === tab.url &&
        nextTab.title === tab.title &&
        nextTab.loadError === tab.loadError
      ) return store
      const tabs = [...current.tabs]
      tabs[index] = nextTab
      return { bySession: { ...store.bySession, [sessionId]: { ...current, tabs } } }
    }),

  setReviewSource: (sessionId, tabId, source) =>
    set((store) => {
      const current = session(store.bySession, sessionId)
      const index = current.tabs.findIndex((tab) => tab.id === tabId && tab.kind === 'review')
      if (index < 0) return store
      const tab = current.tabs[index] as WorkspaceReviewTab
      if (reviewSourceKey(tab.source) === reviewSourceKey(source)) return store
      const tabs = [...current.tabs]
      // Changing the comparison resets the selection: the previous file may not
      // even be part of the new source.
      tabs[index] = { ...tab, source, selectedPath: null, viewedPaths: [], viewedSnapshot: undefined }
      return { bySession: { ...store.bySession, [sessionId]: { ...current, tabs } } }
    }),

  setReviewSelectedPath: (sessionId, tabId, path) =>
    set((store) => {
      const current = session(store.bySession, sessionId)
      const index = current.tabs.findIndex((tab) => tab.id === tabId && tab.kind === 'review')
      if (index < 0) return store
      const tab = current.tabs[index] as WorkspaceReviewTab
      if (tab.selectedPath === path) return store
      const tabs = [...current.tabs]
      tabs[index] = { ...tab, selectedPath: path }
      return { bySession: { ...store.bySession, [sessionId]: { ...current, tabs } } }
    }),

  setReviewViewedPaths: (sessionId, tabId, paths, snapshot) =>
    set((store) => {
      const current = session(store.bySession, sessionId)
      const index = current.tabs.findIndex((tab) => tab.id === tabId && tab.kind === 'review')
      if (index < 0) return store
      const tab = current.tabs[index] as WorkspaceReviewTab
      const viewedPaths = [...new Set(paths)]
      if (tab.viewedSnapshot === snapshot && tab.viewedPaths?.length === viewedPaths.length && viewedPaths.every((path, i) => path === tab.viewedPaths?.[i])) return store
      const tabs = [...current.tabs]
      tabs[index] = { ...tab, viewedPaths, viewedSnapshot: snapshot }
      return { bySession: { ...store.bySession, [sessionId]: { ...current, tabs } } }
    }),

  setTerminalStatus: (sessionId, runtimeId, status) =>
    set((store) => {
      const current = session(store.bySession, sessionId)
      const index = current.tabs.findIndex(
        (tab) => tab.kind === 'terminal' && tab.runtimeId === runtimeId,
      )
      if (index < 0) return store
      const tab = current.tabs[index]!
      if (tab.kind !== 'terminal' || tab.status === status) return store
      const tabs = [...current.tabs]
      tabs[index] = { ...tab, status }
      return { bySession: { ...store.bySession, [sessionId]: { ...current, tabs } } }
    }),

  setOrigin: (sessionId, origin) =>
    set((store) => {
      const current = session(store.bySession, sessionId)
      if (current.origin === origin) return store
      return { bySession: { ...store.bySession, [sessionId]: { ...current, origin } } }
    }),

  consumeFocusRequest: (sessionId) =>
    set((store) => {
      const current = session(store.bySession, sessionId)
      if (!current.focus) return store
      return { bySession: { ...store.bySession, [sessionId]: { ...current, focus: null } } }
    }),

  clearSession: (sessionId) =>
    set((store) => {
      const current = store.bySession[sessionId]
      if (!current) return store
      // Closing a task is the one place that releases everything it owned.
      // Switching tasks deliberately does not come here.
      for (const tab of current.tabs) releaseTabResources(tab)
      const { [sessionId]: _removed, ...rest } = store.bySession
      return { bySession: rest }
    }),

  replaceAll: (bySession) => set({ bySession }),
}))

/** Convenience for the many call sites that only need "is it showing". */
export function isWorkspaceVisible(state: WorkspaceSessionState) {
  return state.layout !== 'hidden'
}

export function workspaceTabTitle(
  tab: WorkspaceTab,
  labels: {
    newTab: string
    review: string
    files: string
    terminal: (ordinal: number) => string
  },
): string {
  switch (tab.kind) {
    case 'file':
      // Opening "Files" with nothing selected is a tree waiting for a choice;
      // an empty basename would render as a nameless tab.
      return tab.path ? basenameOf(tab.path) : labels.files
    case 'browser':
      return tab.title?.trim() || (tab.url ? hostLabel(tab.url) : labels.newTab)
    case 'review':
      return labels.review
    case 'terminal':
      return labels.terminal(tab.ordinal)
  }
}

function hostLabel(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}
