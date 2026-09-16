import {
  EMPTY_WORKSPACE_SESSION,
  clampWorkspaceBottomHeight,
  clampWorkspaceSideWidth,
  type WorkspaceSessionState,
} from '../../stores/workspaceStore'
import { WORKSPACE_STORAGE_KEY, WORKSPACE_STORAGE_VERSION } from './storageKey'
import {
  WORKSPACE_LAYOUTS,
  type WorkspaceLayout,
  type WorkspaceReviewSource,
  type WorkspaceTab,
} from './types'

/**
 * Versioned, self-contained storage for workspace *navigation* state.
 *
 * What is deliberately NOT in here: page content, file bytes, cookies,
 * `webContents` ids, PTY handles and React state. A restart restores the shape
 * of the workspace and reloads content on demand; it never pretends a process
 * survived. Terminals in particular come back stopped and restartable — the one
 * thing a restored shell must never do is replay the command history.
 */


export { WORKSPACE_STORAGE_KEY, WORKSPACE_STORAGE_VERSION }

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/**
 * Upper bound on restored tabs per task. A hand-edited or corrupted entry
 * holding tens of thousands of descriptors would otherwise mint a resource id
 * for each one and render them all — and then write them straight back.
 */
const MAX_RESTORED_TABS_PER_SESSION = 200

export type PersistedWorkspace = {
  version: number
  sideWidth: number
  bottomHeight: number
  sessions: Record<string, PersistedWorkspaceSession>
}

export type PersistedWorkspaceSession = {
  layout: WorkspaceLayout
  bottomOpen: boolean
  activeSideTabId: string | null
  activeBottomTabId: string | null
  nextTerminalOrdinal: number
  tabs: PersistedWorkspaceTab[]
}

/**
 * Tab descriptors, not tabs. `browserTabId` and `runtimeId` are absent on
 * purpose: they name live host resources, and a value read back from disk would
 * address a process that no longer exists.
 */
export type PersistedWorkspaceTab =
  | { kind: 'file'; id: string; preview: boolean; path: string; line?: number }
  | {
      kind: 'browser'
      id: string
      preview: boolean
      storageId: string
      /** Where the page was; reloaded lazily when the tab is first shown. */
      restoreUrl: string | null
      title: string | null
    }
  | {
      kind: 'review'
      id: string
      source: WorkspaceReviewSource
      selectedPath: string | null
      viewedPaths: string[]
      viewedSnapshot?: string
    }
  | {
      kind: 'terminal'
      id: string
      dock: 'side' | 'bottom'
      cwd: string
      ordinal: number
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asReviewSource(value: unknown): WorkspaceReviewSource | null {
  if (!isRecord(value)) return null
  switch (value.kind) {
    case 'unstaged':
    case 'staged':
    case 'uncommitted':
      return { kind: value.kind }
    case 'branch':
      return typeof value.baseRef === 'string' ? { kind: 'branch', baseRef: value.baseRef } : null
    case 'turn':
      return typeof value.turnKey === 'string'
        ? {
            kind: 'turn',
            turnKey: value.turnKey,
            ...(typeof value.userMessageIndex === 'number' && Number.isInteger(value.userMessageIndex) && value.userMessageIndex >= 0
              ? { userMessageIndex: value.userMessageIndex }
              : {}),
          }
        : null
    case 'commit':
      return typeof value.commit === 'string' ? { kind: 'commit', commit: value.commit } : null
    default:
      return null
  }
}

export function serializeWorkspaceTab(tab: WorkspaceTab): PersistedWorkspaceTab | null {
  switch (tab.kind) {
    case 'file':
      return {
        kind: 'file',
        id: tab.id,
        preview: tab.preview,
        path: tab.path,
        ...(tab.reveal ? { line: tab.reveal.line } : {}),
      }
    case 'browser':
      return {
        kind: 'browser',
        id: tab.id,
        preview: tab.preview,
        storageId: tab.storageId,
        restoreUrl: tab.url,
        title: tab.title,
      }
    case 'review':
      return {
        kind: 'review',
        id: tab.id,
        source: tab.source,
        selectedPath: tab.selectedPath,
        viewedPaths: tab.viewedSnapshot ? tab.viewedPaths ?? [] : [],
        ...(tab.viewedSnapshot ? { viewedSnapshot: tab.viewedSnapshot } : {}),
      }
    case 'terminal':
      return {
        kind: 'terminal',
        id: tab.id,
        dock: tab.dock,
        cwd: tab.cwd,
        ordinal: tab.ordinal,
      }
  }
}

export function serializeWorkspace(
  bySession: Record<string, WorkspaceSessionState | undefined>,
  sizes: { sideWidth: number; bottomHeight: number },
): PersistedWorkspace {
  const sessions: Record<string, PersistedWorkspaceSession> = {}
  for (const [sessionId, state] of Object.entries(bySession)) {
    if (!state || state.tabs.length === 0) continue
    sessions[sessionId] = {
      layout: state.layout,
      bottomOpen: state.bottomOpen,
      activeSideTabId: state.activeSideTabId,
      activeBottomTabId: state.activeBottomTabId,
      nextTerminalOrdinal: state.nextTerminalOrdinal,
      tabs: state.tabs
        .map(serializeWorkspaceTab)
        .filter((tab): tab is PersistedWorkspaceTab => tab !== null),
    }
  }
  return {
    version: WORKSPACE_STORAGE_VERSION,
    sideWidth: sizes.sideWidth,
    bottomHeight: sizes.bottomHeight,
    sessions,
  }
}

/**
 * Rebuild live tabs from descriptors. `makeResourceId` is injected so the
 * caller (and the tests) control identity generation; every browser and
 * terminal gets a *fresh* resource id, because nothing from the previous run
 * is still alive.
 */
export function hydrateWorkspaceTab(
  descriptor: unknown,
  makeResourceId: (prefix: string) => string,
): WorkspaceTab | null {
  if (!isRecord(descriptor)) return null
  const id = asString(descriptor.id)
  if (!id) return null
  const createdAt = 0

  switch (descriptor.kind) {
    case 'file': {
      const path = asString(descriptor.path)
      // Files opens as an empty, valid picker before the user selects a file.
      if (path === null) return null
      const line = typeof descriptor.line === 'number' && Number.isFinite(descriptor.line)
        ? descriptor.line
        : null
      return {
        kind: 'file',
        id,
        dock: 'side',
        preview: descriptor.preview === true,
        createdAt,
        path,
        ...(line !== null ? { reveal: { line, nonce: 0 } } : {}),
      }
    }
    case 'browser': {
      const storageId = asString(descriptor.storageId)
      if (!storageId) return null
      return {
        kind: 'browser',
        id,
        dock: 'side',
        preview: descriptor.preview === true,
        createdAt,
        browserTabId: makeResourceId('wb'),
        storageId,
        url: asString(descriptor.restoreUrl),
        title: asString(descriptor.title),
        loadError: null,
      }
    }
    case 'review': {
      const source = asReviewSource(descriptor.source)
      if (!source) return null
      return {
        kind: 'review',
        id,
        dock: 'side',
        preview: false,
        createdAt,
        source,
        selectedPath: asString(descriptor.selectedPath),
        viewedSnapshot: typeof descriptor.viewedSnapshot === 'string' ? descriptor.viewedSnapshot : undefined,
        viewedPaths: typeof descriptor.viewedSnapshot === 'string' && Array.isArray(descriptor.viewedPaths)
          ? [...new Set(descriptor.viewedPaths.filter((path): path is string => typeof path === 'string'))]
          : [],
      }
    }
    case 'terminal': {
      // An empty cwd is not "restore wherever": the host's fallback chain ends
      // at `CLAUDE_CONFIG_DIR`/`HOME`, so restoring one would silently open a
      // shell in the user's config directory instead of their project.
      const cwd = asString(descriptor.cwd)
      if (!cwd) return null
      const ordinal = typeof descriptor.ordinal === 'number' && descriptor.ordinal > 0
        ? descriptor.ordinal
        : 1
      return {
        kind: 'terminal',
        id,
        dock: descriptor.dock === 'bottom' ? 'bottom' : 'side',
        preview: false,
        createdAt,
        runtimeId: makeResourceId('wterm'),
        cwd,
        // Always stopped. A restored terminal offers a restart button; it does
        // not re-run whatever produced the output the user last saw.
        status: 'exited',
        ordinal,
      }
    }
    default:
      return null
  }
}

export function hydrateWorkspace(
  raw: unknown,
  makeResourceId: (prefix: string) => string,
): { bySession: Record<string, WorkspaceSessionState>; sideWidth: number; bottomHeight: number } {
  const fallback = {
    bySession: {} as Record<string, WorkspaceSessionState>,
    sideWidth: clampWorkspaceSideWidth(Number.NaN),
    bottomHeight: clampWorkspaceBottomHeight(Number.NaN),
  }
  if (!isRecord(raw)) return fallback
  if (raw.version !== WORKSPACE_STORAGE_VERSION) return fallback
  if (!isRecord(raw.sessions)) return fallback

  const bySession: Record<string, WorkspaceSessionState> = {}
  for (const [sessionId, value] of Object.entries(raw.sessions)) {
    if (!isRecord(value) || !Array.isArray(value.tabs)) continue

    const seenIds = new Set<string>()
    const restoredTabs = value.tabs
      .slice(0, MAX_RESTORED_TABS_PER_SESSION)
      .map((descriptor) => hydrateWorkspaceTab(descriptor, makeResourceId))
      .filter((tab): tab is WorkspaceTab => tab !== null)
      // Duplicate ids are not merely untidy: `closeTab` addresses tabs by id, so
      // two tabs sharing one would close together and only one would ever be
      // reachable for activation.
      .filter((tab) => {
        if (seenIds.has(tab.id)) return false
        seenIds.add(tab.id)
        return true
      })
    const fileIds = new Map<string, string>()
    for (const tab of restoredTabs) {
      if (tab.kind === 'file' && (!fileIds.has(tab.path) || tab.id === value.activeSideTabId)) fileIds.set(tab.path, tab.id)
    }
    const uniqueTabs = restoredTabs.filter((tab) => tab.kind !== 'file' || fileIds.get(tab.path) === tab.id)
    const previewId = uniqueTabs.find((tab) => tab.preview && tab.id === value.activeSideTabId)?.id
      ?? uniqueTabs.find((tab) => tab.preview)?.id
    // Older undo-close behavior could persist duplicate files or preview
    // slots. Restore one file identity and pin any additional previews.
    const tabs = uniqueTabs.map((tab) => tab.preview && tab.id !== previewId ? { ...tab, preview: false } : tab)
    if (tabs.length === 0) continue

    const layout = WORKSPACE_LAYOUTS.includes(value.layout as WorkspaceLayout)
      ? (value.layout as WorkspaceLayout)
      : 'hidden'
    const sideTabs = tabs.filter((tab) => tab.dock === 'side')
    const bottomTabs = tabs.filter((tab) => tab.dock === 'bottom')
    const sideIds = new Set(sideTabs.map((tab) => tab.id))
    const bottomIds = new Set(bottomTabs.map((tab) => tab.id))
    const activeSideTabId = asString(value.activeSideTabId)
    const activeBottomTabId = asString(value.activeBottomTabId)
    const maxOrdinal = tabs.reduce(
      (max, tab) => (tab.kind === 'terminal' ? Math.max(max, tab.ordinal) : max),
      0,
    )

    bySession[sessionId] = {
      ...EMPTY_WORKSPACE_SESSION,
      // A layout that claims to be showing a side panel with no side tabs is a
      // corrupt entry, not a reason to render an empty frame.
      layout: sideTabs.length === 0 ? 'hidden' : layout,
      bottomOpen: bottomTabs.length > 0 && value.bottomOpen === true,
      tabs,
      // Validated against the tab's *own* dock. An id that names the other
      // dock's tab passes a flat check and then renders a populated strip over
      // a blank pane, with no way out but clicking a tab.
      activeSideTabId: activeSideTabId && sideIds.has(activeSideTabId)
        ? activeSideTabId
        : sideTabs[0]?.id ?? null,
      activeBottomTabId: activeBottomTabId && bottomIds.has(activeBottomTabId)
        ? activeBottomTabId
        : bottomTabs[0]?.id ?? null,
      // `typeof NaN === 'number'`, and `Math.max(NaN, n)` is `NaN` — which then
      // labels every terminal "Terminal NaN" and persists that forever.
      nextTerminalOrdinal: Math.max(
        Number.isFinite(value.nextTerminalOrdinal) ? Number(value.nextTerminalOrdinal) : 1,
        maxOrdinal + 1,
      ),
      closed: [],
      focus: null,
    }
  }

  return {
    bySession,
    sideWidth: clampWorkspaceSideWidth(
      typeof raw.sideWidth === 'number' ? raw.sideWidth : Number.NaN,
    ),
    bottomHeight: clampWorkspaceBottomHeight(
      typeof raw.bottomHeight === 'number' ? raw.bottomHeight : Number.NaN,
    ),
  }
}

export function readWorkspaceStorage(storage: StorageLike | null): unknown {
  if (!storage) return null
  try {
    const raw = storage.getItem(WORKSPACE_STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    // A corrupt entry must not take the app down with it. The workspace simply
    // starts empty, which is also what a fresh install looks like.
    return null
  }
}

export function writeWorkspaceStorage(storage: StorageLike | null, value: PersistedWorkspace): void {
  if (!storage) return
  try {
    // Written even with no sessions: `sideWidth`/`bottomHeight` live on the same
    // document, and dropping it because the last tab closed would silently
    // reset a panel the user had resized.
    storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Private-mode storage and quota failures are not worth losing a keystroke
    // over; the workspace keeps working for this run.
  }
}
