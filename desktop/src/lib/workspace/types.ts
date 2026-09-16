/**
 * Shared vocabulary for the unified workspace.
 *
 * Three layers own three different things and must not be conflated:
 *
 * 1. **Layout / navigation** — which panel is visible, where a tab sits, which
 *    tab is active. Owned by `workspaceStore`.
 * 2. **Content data** — file bytes, review diffs, tree expansion. Owned by the
 *    per-kind content stores.
 * 3. **Running resources** — `webContents`, PTYs, watchers. Owned by the host
 *    services and keyed by the *resource* id below, never by the UI tab id.
 *
 * The separation is the whole point: a UI tab id is a navigation handle that a
 * React unmount may outlive, while `browserTabId` / `runtimeId` name a live
 * process. Reusing one for the other is how the previous implementation ended
 * up destroying a page whenever the panel switched modes.
 */

export type WorkspaceTabKind = 'file' | 'browser' | 'review' | 'terminal'

/** Where a tab is parked. Only terminals may use `bottom`. */
export type WorkspaceDock = 'side' | 'bottom'

/**
 * Side-panel presentation. `hidden` keeps every tab and every running resource
 * alive — it only stops rendering them.
 */
export type WorkspaceLayout = 'hidden' | 'split' | 'full'

export const WORKSPACE_LAYOUTS: readonly WorkspaceLayout[] = ['hidden', 'split', 'full']

/**
 * Git comparison a review tab is showing. Each variant names both sides of the
 * comparison explicitly; there is no implicit fallback to `HEAD`, because the
 * old status/diff pair silently compared against `HEAD` and could not express
 * "staged" at all.
 */
export type WorkspaceReviewSource =
  | { kind: 'unstaged' }
  | { kind: 'staged' }
  | { kind: 'uncommitted' }
  | { kind: 'branch'; baseRef: string }
  | { kind: 'turn'; turnKey: string; userMessageIndex?: number }
  | { kind: 'commit'; commit: string }

export const DEFAULT_REVIEW_SOURCE: WorkspaceReviewSource = { kind: 'unstaged' }

/** Sources that describe live working-tree state and therefore accept writes. */
export function isWritableReviewSource(source: WorkspaceReviewSource): boolean {
  return source.kind === 'unstaged' || source.kind === 'staged' || source.kind === 'uncommitted'
}

export function reviewSourceKey(source: WorkspaceReviewSource): string {
  switch (source.kind) {
    case 'branch':
      return `branch:${source.baseRef}`
    case 'turn':
      return `turn:${source.turnKey}${source.userMessageIndex === undefined ? '' : `:${source.userMessageIndex}`}`
    case 'commit':
      return `commit:${source.commit}`
    default:
      return source.kind
  }
}

/**
 * A line the content view should scroll to and mark.
 *
 * `nonce` exists so clicking the same `foo.ts:42` reference twice scrolls back
 * to it: re-opening an already-open tab at an unchanged line is otherwise a
 * no-op state update and the view stays wherever the user had scrolled to.
 */
export type WorkspaceReveal = { line: number; column?: number; nonce: number }

type WorkspaceTabBase = {
  /** UI identity. Unique within a session. Never sent to a host service. */
  id: string
  dock: WorkspaceDock
  /**
   * A preview tab is replaceable: the next single-click preview takes its slot
   * instead of adding a tab. Double-clicking, editing, or any explicit "open"
   * pins it.
   */
  preview: boolean
  createdAt: number
}

export type WorkspaceFileTab = WorkspaceTabBase & {
  kind: 'file'
  dock: 'side'
  path: string
  reveal?: WorkspaceReveal
}

export type WorkspaceBrowserTab = WorkspaceTabBase & {
  kind: 'browser'
  dock: 'side'
  /** Resource identity for the host `webContents`. Stable across re-renders. */
  browserTabId: string
  /**
   * Page restore identity, persisted so a restart can reopen the same page.
   * This is **not** a cookie partition: every tab of one user shares one
   * persistent partition, matching Codex's `persist:codex-browser-app`.
   */
  storageId: string
  /** Last committed URL, or `null` for a blank new-tab page. */
  url: string | null
  title: string | null
  /** Set when the page itself failed; the tab keeps a retry entry point. */
  loadError: string | null
}

export type WorkspaceReviewTab = WorkspaceTabBase & {
  kind: 'review'
  dock: 'side'
  source: WorkspaceReviewSource
  /** File selected inside the review, or `null` for "show every file". */
  selectedPath: string | null
  /** Persisted review marks; scoped to this exact comparison. */
  viewedPaths?: string[]
  viewedSnapshot?: string
}

export type WorkspaceTerminalTabStatus = 'live' | 'exited'

export type WorkspaceTerminalTab = WorkspaceTabBase & {
  kind: 'terminal'
  /** Resource identity for the PTY. Survives dock moves and panel hides. */
  runtimeId: string
  cwd: string
  /**
   * `exited` covers both a process that ended and a tab restored from disk.
   * A restored terminal never replays its old command — it offers a manual
   * restart instead.
   */
  status: WorkspaceTerminalTabStatus
  /** Sequence used for the visible label, stable for the life of the tab. */
  ordinal: number
}

export type WorkspaceTab =
  | WorkspaceFileTab
  | WorkspaceBrowserTab
  | WorkspaceReviewTab
  | WorkspaceTerminalTab

/** What `openWorkspaceTarget` accepts from every entry point in the app. */
export type WorkspaceTarget =
  | {
      kind: 'file'
      path: string
      reveal?: { line: number; column?: number }
    }
  | {
      kind: 'browser'
      url?: string
    }
  | {
      kind: 'review'
      source?: WorkspaceReviewSource
      path?: string
    }
  | {
      kind: 'terminal'
      cwd?: string
      dock?: WorkspaceDock
      /** Activate an existing terminal in that dock instead of spawning one. */
      reuse?: boolean
    }

export type WorkspaceOpenOptions = {
  /** Single click opens a replaceable preview; double click pins. */
  preview?: boolean
  /** Leave the current tab active — used by background/agent-driven opens. */
  background?: boolean
  /**
   * Identity of the task that asked. A request that names a task other than
   * the foreground one lands in that task's workspace and never steals focus.
   */
  requestedBy?: 'user' | 'agent'
  /**
   * Let this open take over a blank placeholder tab instead of adding a tab.
   *
   * The rule is narrow on purpose: only the *active* tab is eligible, a browser
   * tab counts as "blank" until the host reports a committed URL, and a file
   * tab counts as "blank" while no path is chosen (the Files launcher). Between
   * pressing Enter in the address bar and the page committing, *any* other open
   * would otherwise destroy the page that is mid-load.
   */
  replaceBlankPlaceholder?: boolean
}

export type WorkspaceCloseScope = 'current' | 'others' | 'left' | 'right' | 'all'

/**
 * One closed tab: enough to rebuild it, and nothing more. Deliberately holds no
 * React state, no handles and no page content — a closed terminal comes back as
 * a restartable shell, not as a pretend-live process.
 */
export type WorkspaceClosedTab = {
  tab: WorkspaceTab
  /** Position within the tab's own dock, so undo restores where it was. */
  dockIndex: number
}

/**
 * Undo operates on the *action*, not on individual tabs.
 *
 * "Close to the right" removes several tabs at once; replaying them one at a
 * time cannot reconstruct their order, because each dock index was recorded
 * against the original layout and the list is only partly restored when the
 * next one arrives. Restoring the whole group, lowest index first, does.
 */
export type WorkspaceClosedGroup = {
  tabs: WorkspaceClosedTab[]
}

export function isTerminalTab(tab: WorkspaceTab): tab is WorkspaceTerminalTab {
  return tab.kind === 'terminal'
}

export function isBrowserTab(tab: WorkspaceTab): tab is WorkspaceBrowserTab {
  return tab.kind === 'browser'
}

export function isFileTab(tab: WorkspaceTab): tab is WorkspaceFileTab {
  return tab.kind === 'file'
}

export function isReviewTab(tab: WorkspaceTab): tab is WorkspaceReviewTab {
  return tab.kind === 'review'
}

/** A blank browser tab is one placeholder another kind may replace. */
export function isBlankBrowserTab(tab: WorkspaceTab): boolean {
  return tab.kind === 'browser' && !tab.url
}

/** The Files launcher with nothing chosen yet is the other placeholder. */
export function isBlankFileTab(tab: WorkspaceTab): boolean {
  return tab.kind === 'file' && tab.path === ''
}

export function basenameOf(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] ?? path
}
