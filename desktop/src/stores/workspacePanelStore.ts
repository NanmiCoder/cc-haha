import { create } from 'zustand'
import {
  sessionsApi,
  type WorkspaceDiffResult,
  type WorkspaceLspConfigInput,
  type WorkspaceReadFileResult,
  type WorkspaceLspDiagnosticsResult,
  type WorkspaceLspSyncInput,
  type WorkspaceStatusResult,
  type WorkspaceTreeResult,
} from '../api/sessions'
import type { WorkspaceLspState } from '../types/lsp'
import { useSettingsStore } from './settingsStore'

export const WORKSPACE_PANEL_DEFAULT_WIDTH = 860
export const WORKSPACE_PANEL_MIN_WIDTH = 640
export const WORKSPACE_PANEL_MAX_WIDTH = 1120

export type WorkspacePanelView = 'changed' | 'all'
export type WorkbenchMode = 'workspace' | 'browser'
export type WorkspacePreviewKind = 'file' | 'diff'
export type WorkspacePreviewCloseScope = 'current' | 'others' | 'left' | 'right' | 'all'
export type WorkspacePreviewState =
  | 'loading'
  | WorkspaceReadFileResult['state']
  | WorkspaceDiffResult['state']

export type WorkspacePreviewTab = {
  id: string
  path: string
  kind: WorkspacePreviewKind
  title: string
  language?: string
  content?: string
  dataUrl?: string
  mimeType?: string
  previewType?: 'text' | 'image'
  diff?: string
  state?: WorkspacePreviewState
  error?: string
  size?: number
}

export type WorkspacePanelSessionState = {
  isOpen: boolean
  activeView: WorkspacePanelView
  hasUserSelectedView?: boolean
}

export type WorkspaceFileEncoding = 'utf-8' | 'utf-8-bom'
export type WorkspaceFileLineEnding = 'LF' | 'CRLF' | 'CR'

export type WorkspaceConflictSource = 'user' | 'agent'

export type WorkspaceBufferConflict = {
  source: WorkspaceConflictSource
  hash: string
  timestamp: number
  actor?: string
}

/**
 * Editable-buffer state for a single open file tab.
 *
 * `baseHash` / `baseContent` capture the snapshot the editor opened with.
 * `currentContent` tracks the in-memory edits. `conflict` is set when the
 * file has been modified externally (another window saving the same path
 * for `source: 'user'`, or an agent edit for `source: 'agent'`). Phase 2
 * (this PR) populates `'user'` only — agent-source events ship in PR-4.
 */
export type WorkspaceBufferState = {
  tabId: string
  path: string
  baseHash: string
  baseContent: string
  currentContent: string
  isDirty: boolean
  encoding: WorkspaceFileEncoding
  lineEnding: WorkspaceFileLineEnding
  conflict: WorkspaceBufferConflict | null
}

export type WorkspaceBufferInit = Omit<
  WorkspaceBufferState,
  'currentContent' | 'isDirty' | 'conflict'
>

export type WorkspaceExternalSavePayload = {
  source: WorkspaceConflictSource
  hash: string
  timestamp: number
  actor?: string
  content?: string
}

type WorkspacePanelLoadingState = {
  statusBySession: Record<string, boolean | undefined>
  treeBySessionPath: Record<string, boolean | undefined>
  previewByTabId: Record<string, boolean | undefined>
}

type WorkspacePanelErrorState = {
  statusBySession: Record<string, string | null | undefined>
  treeBySessionPath: Record<string, string | null | undefined>
  previewByTabId: Record<string, string | null | undefined>
}

type WorkspacePanelStore = {
  panelBySession: Record<string, WorkspacePanelSessionState | undefined>
  modeBySession: Record<string, WorkbenchMode | undefined>
  width: number
  statusBySession: Record<string, WorkspaceStatusResult | undefined>
  expandedPathsBySession: Record<string, string[] | undefined>
  treeBySessionPath: Record<string, Record<string, WorkspaceTreeResult | undefined> | undefined>
  previewTabsBySession: Record<string, WorkspacePreviewTab[] | undefined>
  activePreviewTabIdBySession: Record<string, string | null | undefined>
  bufferStateByTabId: Record<string, WorkspaceBufferState | undefined>
  lspStateBySession: Record<string, WorkspaceLspState | undefined>
  lspDiagnosticsBySessionPath: Record<string, WorkspaceLspDiagnosticsResult | undefined>
  loading: WorkspacePanelLoadingState
  errors: WorkspacePanelErrorState

  isPanelOpen: (sessionId: string) => boolean
  getActiveView: (sessionId: string) => WorkspacePanelView
  getMode: (sessionId: string) => WorkbenchMode
  setMode: (sessionId: string, mode: WorkbenchMode) => void
  openPanel: (sessionId: string) => void
  closePanel: (sessionId: string) => void
  togglePanel: (sessionId: string) => void
  setWidth: (width: number) => void
  setActiveView: (sessionId: string, view: WorkspacePanelView) => void
  loadStatus: (sessionId: string) => Promise<void>
  loadTree: (sessionId: string, path?: string) => Promise<void>
  toggleTreeNode: (sessionId: string, path: string) => Promise<void>
  openPreview: (sessionId: string, path: string, kind: WorkspacePreviewKind) => Promise<void>
  closePreview: (sessionId: string, tabId: string) => void
  closePreviewTabs: (sessionId: string, tabId: string, scope: WorkspacePreviewCloseScope) => void
  initBuffer: (init: WorkspaceBufferInit) => void
  setBufferState: (tabId: string, content: string) => void
  applyExternalSave: (tabId: string, event: WorkspaceExternalSavePayload) => void
  acknowledgeConflict: (tabId: string, action: 'reload' | 'keepMine' | 'openConflict') => void
  syncLsp: (sessionId: string, input: WorkspaceLspSyncInput) => Promise<void>
  loadLspState: (sessionId: string, path?: string) => Promise<void>
  loadLspDiagnostics: (sessionId: string, path: string, refresh?: boolean) => Promise<void>
  /**
   * React to an agent (CLI) file edit observed via the chat tool stream.
   * Unlike `applyExternalSave`, no content hash is available — the agent
   * edit is surfaced through the tool_result event, not a workspace save
   * round-trip. So we (a) refresh the workspace status/diagnostics and
   * (b) flag any open buffer for the same path with an agent-source
   * conflict so the editor offers a reload.
   */
  notifyAgentFileEdit: (sessionId: string, absolutePath: string) => void
  clearBuffer: (tabId: string) => void
  clearSession: (sessionId: string) => void
  resetSessionUi: (sessionId: string) => void
}

const DEFAULT_PANEL_STATE: WorkspacePanelSessionState = {
  isOpen: false,
  activeView: 'all',
}

const DEFAULT_WORKBENCH_MODE: WorkbenchMode = 'workspace'

const statusRequestIds = new Map<string, number>()
const treeRequestIds = new Map<string, number>()
const previewRequestIds = new Map<string, number>()
const lspRequestIds = new Map<string, number>()

function nextRequestId(store: Map<string, number>, key: string) {
  const requestId = (store.get(key) ?? 0) + 1
  store.set(key, requestId)
  return requestId
}

function invalidateRequest(store: Map<string, number>, key: string) {
  store.set(key, (store.get(key) ?? 0) + 1)
}

function isLatestRequest(store: Map<string, number>, key: string, requestId: number) {
  return store.get(key) === requestId
}

export function clampWorkspacePanelWidth(width: number) {
  if (!Number.isFinite(width)) return WORKSPACE_PANEL_DEFAULT_WIDTH
  const rounded = Math.round(width)
  return Math.min(WORKSPACE_PANEL_MAX_WIDTH, Math.max(WORKSPACE_PANEL_MIN_WIDTH, rounded))
}

function getSessionPanelState(
  panelBySession: Record<string, WorkspacePanelSessionState | undefined>,
  sessionId: string,
) {
  return panelBySession[sessionId] ?? DEFAULT_PANEL_STATE
}

function makeTreeKey(sessionId: string, path: string) {
  return `${sessionId}::${path}`
}

export function getWorkspacePreviewTabId(path: string, kind: WorkspacePreviewKind) {
  return `${kind}:${path}`
}

/**
 * Sentinel hash for agent-originated edits. Agent edits are observed through
 * the chat tool stream (tool_result), which carries no file content hash, so
 * we can't compare against a buffer's baseHash. This sentinel is chosen to
 * never collide with a real sha-256 hex digest, guaranteeing the conflict
 * banner surfaces for an open buffer.
 */
export const AGENT_EDIT_SENTINEL_HASH = 'agent-edit'

/** Normalize a path for agent-edit suffix matching: forward slashes, no trailing slash. */
function normalizeAgentEditPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * Whether an agent's (absolute) edited path refers to the same file as an
 * open buffer's (workspace-relative) path. The agent reports an absolute
 * path while buffers store workspace-relative paths, so we match by suffix
 * on a normalized segment boundary to avoid `foo/bar.ts` matching
 * `otherbar.ts`.
 */
function agentEditMatchesBufferPath(normalizedAbs: string, bufferPath: string): boolean {
  const normalizedBuffer = normalizeAgentEditPath(bufferPath)
  if (normalizedAbs === normalizedBuffer) return true
  return normalizedAbs.endsWith(`/${normalizedBuffer}`)
}

function makePreviewKey(sessionId: string, tabId: string) {
  return `${sessionId}::${tabId}`
}

function makeLspPathKey(sessionId: string, path: string) {
  return `${sessionId}::${path}`
}

function getPathTitle(path: string) {
  if (!path) return 'Workspace'
  const segments = path.split('/').filter(Boolean)
  return segments[segments.length - 1] ?? path
}

function stripSessionKeys<T>(record: Record<string, T>, sessionId: string) {
  const prefix = `${sessionId}::`
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !key.startsWith(prefix)),
  ) as Record<string, T>
}

function removeRecordKey<T>(record: Record<string, T>, key: string) {
  if (!(key in record)) return record
  const { [key]: _removed, ...rest } = record
  return rest
}

function removeRecordKeys<T>(record: Record<string, T>, keys: string[]) {
  let next = record
  for (const key of keys) {
    next = removeRecordKey(next, key)
  }
  return next
}

function invalidateSessionScopedRequests(store: Map<string, number>, sessionId: string) {
  const prefix = `${sessionId}::`
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      invalidateRequest(store, key)
    }
  }
}

function upsertPreviewTab(
  tabs: WorkspacePreviewTab[],
  tabId: string,
  update: WorkspacePreviewTab | ((current: WorkspacePreviewTab) => WorkspacePreviewTab),
) {
  const index = tabs.findIndex((tab) => tab.id === tabId)
  if (index < 0) return tabs

  const current = tabs[index]!
  const next = typeof update === 'function' ? update(current) : update
  const nextTabs = [...tabs]
  nextTabs[index] = next
  return nextTabs
}

function resolveWorkspaceLspConfig(): WorkspaceLspConfigInput | undefined {
  try {
    const config = useSettingsStore.getState().workspaceLsp
    return config.server ? config : undefined
  } catch {
    return undefined
  }
}

export const useWorkspacePanelStore = create<WorkspacePanelStore>((set, get) => ({
  panelBySession: {},
  modeBySession: {},
  width: WORKSPACE_PANEL_DEFAULT_WIDTH,
  statusBySession: {},
  expandedPathsBySession: {},
  treeBySessionPath: {},
  previewTabsBySession: {},
  activePreviewTabIdBySession: {},
  bufferStateByTabId: {},
  lspStateBySession: {},
  lspDiagnosticsBySessionPath: {},
  loading: {
    statusBySession: {},
    treeBySessionPath: {},
    previewByTabId: {},
  },
  errors: {
    statusBySession: {},
    treeBySessionPath: {},
    previewByTabId: {},
  },

  isPanelOpen: (sessionId) => getSessionPanelState(get().panelBySession, sessionId).isOpen,
  getActiveView: (sessionId) => getSessionPanelState(get().panelBySession, sessionId).activeView,
  getMode: (sessionId) => get().modeBySession[sessionId] ?? DEFAULT_WORKBENCH_MODE,

  setMode: (sessionId, mode) =>
    set((state) => ({
      modeBySession: {
        ...state.modeBySession,
        [sessionId]: mode,
      },
    })),

  openPanel: (sessionId) =>
    set((state) => ({
      panelBySession: {
        ...state.panelBySession,
        [sessionId]: {
          ...getSessionPanelState(state.panelBySession, sessionId),
          isOpen: true,
        },
      },
    })),

  closePanel: (sessionId) =>
    set((state) => ({
      panelBySession: {
        ...state.panelBySession,
        [sessionId]: {
          ...getSessionPanelState(state.panelBySession, sessionId),
          isOpen: false,
        },
      },
    })),

  togglePanel: (sessionId) =>
    set((state) => {
      const panel = getSessionPanelState(state.panelBySession, sessionId)
      return {
        panelBySession: {
          ...state.panelBySession,
          [sessionId]: {
            ...panel,
            isOpen: !panel.isOpen,
          },
        },
      }
    }),

  setWidth: (width) => set({ width: clampWorkspacePanelWidth(width) }),

  setActiveView: (sessionId, view) =>
    set((state) => ({
      panelBySession: {
        ...state.panelBySession,
        [sessionId]: {
          ...getSessionPanelState(state.panelBySession, sessionId),
          activeView: view,
          hasUserSelectedView: true,
        },
      },
    })),

  loadStatus: async (sessionId) => {
    const requestId = nextRequestId(statusRequestIds, sessionId)

    set((state) => ({
      loading: {
        ...state.loading,
        statusBySession: {
          ...state.loading.statusBySession,
          [sessionId]: true,
        },
      },
      errors: {
        ...state.errors,
        statusBySession: {
          ...state.errors.statusBySession,
          [sessionId]: null,
        },
      },
    }))

    try {
      const result = await sessionsApi.getWorkspaceStatus(sessionId)
      if (!isLatestRequest(statusRequestIds, sessionId, requestId)) return

      set((state) => {
        const panel = getSessionPanelState(state.panelBySession, sessionId)

        return {
          panelBySession: {
            ...state.panelBySession,
            [sessionId]: {
              ...panel,
            },
          },
          statusBySession: {
            ...state.statusBySession,
            [sessionId]: result,
          },
          loading: {
            ...state.loading,
            statusBySession: {
              ...state.loading.statusBySession,
              [sessionId]: false,
            },
          },
          errors: {
            ...state.errors,
            statusBySession: {
              ...state.errors.statusBySession,
              [sessionId]: result.error ?? null,
            },
          },
        }
      })
    } catch (error) {
      if (!isLatestRequest(statusRequestIds, sessionId, requestId)) return

      set((state) => ({
        loading: {
          ...state.loading,
          statusBySession: {
            ...state.loading.statusBySession,
            [sessionId]: false,
          },
        },
        errors: {
          ...state.errors,
          statusBySession: {
            ...state.errors.statusBySession,
            [sessionId]: error instanceof Error ? error.message : 'Failed to load workspace status',
          },
        },
      }))
    }
  },

  loadTree: async (sessionId, path = '') => {
    const treeKey = makeTreeKey(sessionId, path)
    const requestId = nextRequestId(treeRequestIds, treeKey)

    set((state) => ({
      loading: {
        ...state.loading,
        treeBySessionPath: {
          ...state.loading.treeBySessionPath,
          [treeKey]: true,
        },
      },
      errors: {
        ...state.errors,
        treeBySessionPath: {
          ...state.errors.treeBySessionPath,
          [treeKey]: null,
        },
      },
    }))

    try {
      const result = await sessionsApi.getWorkspaceTree(sessionId, path)
      if (!isLatestRequest(treeRequestIds, treeKey, requestId)) return

      set((state) => ({
        treeBySessionPath: {
          ...state.treeBySessionPath,
          [sessionId]: {
            ...state.treeBySessionPath[sessionId],
            [path]: result,
          },
        },
        loading: {
          ...state.loading,
          treeBySessionPath: {
            ...state.loading.treeBySessionPath,
            [treeKey]: false,
          },
        },
        errors: {
          ...state.errors,
          treeBySessionPath: {
            ...state.errors.treeBySessionPath,
            [treeKey]: result.error ?? null,
          },
        },
      }))
    } catch (error) {
      if (!isLatestRequest(treeRequestIds, treeKey, requestId)) return

      set((state) => ({
        loading: {
          ...state.loading,
          treeBySessionPath: {
            ...state.loading.treeBySessionPath,
            [treeKey]: false,
          },
        },
        errors: {
          ...state.errors,
          treeBySessionPath: {
            ...state.errors.treeBySessionPath,
            [treeKey]: error instanceof Error ? error.message : 'Failed to load workspace tree',
          },
        },
      }))
    }
  },

  toggleTreeNode: async (sessionId, path) => {
    let shouldLoad = false

    set((state) => {
      const expanded = new Set(state.expandedPathsBySession[sessionId] ?? [])
      if (expanded.has(path)) {
        expanded.delete(path)
      } else {
        expanded.add(path)
        if (!state.treeBySessionPath[sessionId]?.[path]) {
          shouldLoad = true
        }
      }

      return {
        expandedPathsBySession: {
          ...state.expandedPathsBySession,
          [sessionId]: [...expanded],
        },
      }
    })

    if (shouldLoad) {
      await get().loadTree(sessionId, path)
    }
  },

  openPreview: async (sessionId, path, kind) => {
    // Ensure the workspace panel is visible — openPreview is now triggered from places
    // where the panel may be closed (e.g. the chat "打开方式" menu / turn-changes card),
    // not only from inside the already-open file tree. Opening a file always switches the
    // unified workbench into file ("workspace") mode.
    get().openPanel(sessionId)
    get().setMode(sessionId, 'workspace')
    const tabId = getWorkspacePreviewTabId(path, kind)
    const requestKey = makePreviewKey(sessionId, tabId)
    const existing = get().previewTabsBySession[sessionId]?.find((tab) => tab.id === tabId)

    if (existing) {
      set((state) => ({
        activePreviewTabIdBySession: {
          ...state.activePreviewTabIdBySession,
          [sessionId]: tabId,
        },
      }))
      return
    }

    const requestId = nextRequestId(previewRequestIds, requestKey)
    const baseTab: WorkspacePreviewTab = {
      id: tabId,
      path,
      kind,
      title: getPathTitle(path),
      state: 'loading',
    }

    set((state) => ({
      previewTabsBySession: {
        ...state.previewTabsBySession,
        [sessionId]: [...(state.previewTabsBySession[sessionId] ?? []), baseTab],
      },
      activePreviewTabIdBySession: {
        ...state.activePreviewTabIdBySession,
        [sessionId]: tabId,
      },
      loading: {
        ...state.loading,
        previewByTabId: {
          ...state.loading.previewByTabId,
          [requestKey]: true,
        },
      },
      errors: {
        ...state.errors,
        previewByTabId: {
          ...state.errors.previewByTabId,
          [requestKey]: null,
        },
      },
    }))

    try {
      if (kind === 'diff') {
        const result = await sessionsApi.getWorkspaceDiff(sessionId, path)
        if (!isLatestRequest(previewRequestIds, requestKey, requestId)) return
        if (!get().previewTabsBySession[sessionId]?.some((tab) => tab.id === tabId)) return

        set((state) => {
          const tabs = state.previewTabsBySession[sessionId] ?? []
          return {
            previewTabsBySession: {
              ...state.previewTabsBySession,
              [sessionId]: upsertPreviewTab(tabs, tabId, (current) => ({
                ...current,
                diff: result.diff ?? '',
                content: undefined,
                language: undefined,
                size: undefined,
                state: result.state,
                error: result.error,
              })),
            },
            loading: {
              ...state.loading,
              previewByTabId: {
                ...state.loading.previewByTabId,
                [requestKey]: false,
              },
            },
            errors: {
              ...state.errors,
              previewByTabId: {
                ...state.errors.previewByTabId,
                [requestKey]: result.error ?? null,
              },
            },
          }
        })
        return
      }

      const result = await sessionsApi.getWorkspaceFile(sessionId, path)
      if (!isLatestRequest(previewRequestIds, requestKey, requestId)) return
      if (!get().previewTabsBySession[sessionId]?.some((tab) => tab.id === tabId)) return

      set((state) => {
        const tabs = state.previewTabsBySession[sessionId] ?? []
        return {
          previewTabsBySession: {
            ...state.previewTabsBySession,
            [sessionId]: upsertPreviewTab(tabs, tabId, (current) => ({
                ...current,
                content: result.content,
                dataUrl: result.dataUrl,
                mimeType: result.mimeType,
                previewType: result.previewType ?? 'text',
                diff: undefined,
                language: result.language,
              size: result.size,
              state: result.state,
              error: result.error,
            })),
          },
          loading: {
            ...state.loading,
            previewByTabId: {
              ...state.loading.previewByTabId,
              [requestKey]: false,
            },
          },
          errors: {
            ...state.errors,
            previewByTabId: {
              ...state.errors.previewByTabId,
              [requestKey]: result.error ?? null,
            },
          },
        }
      })
    } catch (error) {
      if (!isLatestRequest(previewRequestIds, requestKey, requestId)) return
      if (!get().previewTabsBySession[sessionId]?.some((tab) => tab.id === tabId)) return

      set((state) => {
        const tabs = state.previewTabsBySession[sessionId] ?? []
        const message = error instanceof Error ? error.message : 'Failed to load workspace preview'

        return {
          previewTabsBySession: {
            ...state.previewTabsBySession,
            [sessionId]: upsertPreviewTab(tabs, tabId, (current) => ({
              ...current,
              state: 'error',
              error: message,
            })),
          },
          loading: {
            ...state.loading,
            previewByTabId: {
              ...state.loading.previewByTabId,
              [requestKey]: false,
            },
          },
          errors: {
            ...state.errors,
            previewByTabId: {
              ...state.errors.previewByTabId,
              [requestKey]: message,
            },
          },
        }
      })
    }
  },

  closePreview: (sessionId, tabId) => {
    get().closePreviewTabs(sessionId, tabId, 'current')
  },

  closePreviewTabs: (sessionId, tabId, scope) => {
    set((state) => {
      const tabs = state.previewTabsBySession[sessionId] ?? []
      const index = tabs.findIndex((tab) => tab.id === tabId)
      if (index < 0) {
        const requestKey = makePreviewKey(sessionId, tabId)
        invalidateRequest(previewRequestIds, requestKey)
        return {
          bufferStateByTabId: removeRecordKey(state.bufferStateByTabId, tabId),
          loading: {
            ...state.loading,
            previewByTabId: removeRecordKey(state.loading.previewByTabId, requestKey),
          },
          errors: {
            ...state.errors,
            previewByTabId: removeRecordKey(state.errors.previewByTabId, requestKey),
          },
        }
      }

      let nextTabs: WorkspacePreviewTab[]
      switch (scope) {
        case 'others':
          nextTabs = [tabs[index]!]
          break
        case 'left':
          nextTabs = tabs.slice(index)
          break
        case 'right':
          nextTabs = tabs.slice(0, index + 1)
          break
        case 'all':
          nextTabs = []
          break
        case 'current':
        default:
          nextTabs = tabs.filter((tab) => tab.id !== tabId)
          break
      }

      const nextTabIds = new Set(nextTabs.map((tab) => tab.id))
      const closingTabIds = tabs.map((tab) => tab.id).filter((id) => !nextTabIds.has(id))
      const requestKeys = closingTabIds.map((id) => makePreviewKey(sessionId, id))
      for (const key of requestKeys) {
        invalidateRequest(previewRequestIds, key)
      }

      const activeTabId = state.activePreviewTabIdBySession[sessionId] ?? null

      let nextActiveTabId = activeTabId
      if (scope === 'all' || nextTabs.length === 0) {
        nextActiveTabId = null
      } else if (!activeTabId || !nextTabIds.has(activeTabId)) {
        const targetTab = nextTabs.find((tab) => tab.id === tabId)
        nextActiveTabId = targetTab?.id ?? nextTabs[Math.min(index, nextTabs.length - 1)]?.id ?? null
      } else if (scope === 'others') {
        nextActiveTabId = tabId
      } else if (activeTabId === tabId && scope === 'current') {
        if (nextTabs.length === 0) {
          nextActiveTabId = null
        } else if (index >= nextTabs.length) {
          nextActiveTabId = nextTabs[nextTabs.length - 1]!.id
        } else {
          nextActiveTabId = nextTabs[index]!.id
        }
      }

      return {
        previewTabsBySession: {
          ...state.previewTabsBySession,
          [sessionId]: nextTabs.length > 0 ? nextTabs : undefined,
        },
        activePreviewTabIdBySession: {
          ...state.activePreviewTabIdBySession,
          [sessionId]: nextActiveTabId,
        },
        bufferStateByTabId: removeRecordKeys(state.bufferStateByTabId, closingTabIds),
        loading: {
          ...state.loading,
          previewByTabId: removeRecordKeys(state.loading.previewByTabId, requestKeys),
        },
        errors: {
          ...state.errors,
          previewByTabId: removeRecordKeys(state.errors.previewByTabId, requestKeys),
        },
      }
    })
  },

  initBuffer: (init) =>
    set((state) => ({
      bufferStateByTabId: {
        ...state.bufferStateByTabId,
        [init.tabId]: {
          ...init,
          currentContent: init.baseContent,
          isDirty: false,
          conflict: null,
        },
      },
    })),

  setBufferState: (tabId, content) =>
    set((state) => {
      const existing = state.bufferStateByTabId[tabId]
      if (!existing) return state
      return {
        bufferStateByTabId: {
          ...state.bufferStateByTabId,
          [tabId]: {
            ...existing,
            currentContent: content,
            isDirty: content !== existing.baseContent,
          },
        },
      }
    }),

  applyExternalSave: (tabId, event) =>
    set((state) => {
      const existing = state.bufferStateByTabId[tabId]
      if (!existing) return state
      // Same hash as our base — nothing to do (echo of our own save).
      if (event.hash === existing.baseHash) return state

      // Clean buffer: silently rebase to the new content if provided; otherwise
      // surface a single-button "Reload" banner so the editor refetches.
      if (!existing.isDirty && typeof event.content === 'string') {
        return {
          bufferStateByTabId: {
            ...state.bufferStateByTabId,
            [tabId]: {
              ...existing,
              baseHash: event.hash,
              baseContent: event.content,
              currentContent: event.content,
              isDirty: false,
              conflict: null,
            },
          },
        }
      }

      // Dirty buffer (or clean buffer without content): surface conflict banner.
      return {
        bufferStateByTabId: {
          ...state.bufferStateByTabId,
          [tabId]: {
            ...existing,
            conflict: {
              source: event.source,
              hash: event.hash,
              timestamp: event.timestamp,
              actor: event.actor,
            },
          },
        },
      }
    }),

  acknowledgeConflict: (tabId, action) =>
    set((state) => {
      const existing = state.bufferStateByTabId[tabId]
      if (!existing || !existing.conflict) return state

      // 'reload' clears conflict + dirty marker — caller is expected to
      // refetch and re-init the buffer with fresh base content/hash.
      // 'keepMine' clears conflict but keeps dirty marker so the user can
      // overwrite on next save (with stale-base 409 risk acknowledged).
      // 'openConflict' is a UI-routing action; the store just dismisses the
      // banner so the caller can drive a side-by-side diff view.
      if (action === 'reload') {
        return {
          bufferStateByTabId: {
            ...state.bufferStateByTabId,
            [tabId]: {
              ...existing,
              currentContent: existing.baseContent,
              isDirty: false,
              conflict: null,
            },
          },
        }
      }

      return {
        bufferStateByTabId: {
          ...state.bufferStateByTabId,
          [tabId]: {
            ...existing,
            conflict: null,
          },
        },
      }
    }),

  loadLspDiagnostics: async (sessionId, path, refresh = false) => {
    const lspKey = makeLspPathKey(sessionId, path)
    const requestId = nextRequestId(lspRequestIds, lspKey)
    try {
      const result = await sessionsApi.getWorkspaceLspDiagnostics(sessionId, path, {
        refresh,
        config: resolveWorkspaceLspConfig(),
      })
      if (!isLatestRequest(lspRequestIds, lspKey, requestId)) return
      set((state) => ({
        lspDiagnosticsBySessionPath: {
          ...state.lspDiagnosticsBySessionPath,
          [lspKey]: result,
        },
      }))
    } catch (error) {
      if (!isLatestRequest(lspRequestIds, lspKey, requestId)) return
      set((state) => ({
        lspDiagnosticsBySessionPath: {
          ...state.lspDiagnosticsBySessionPath,
          [lspKey]: {
            state: 'unavailable',
            diagnostics: [],
            diagnosticsTotal: 0,
            diagnosticsTruncated: false,
            error: error instanceof Error ? error.message : 'Failed to load LSP diagnostics',
          },
        },
      }))
    }
  },

  loadLspState: async (sessionId, path) => {
    try {
      const result = await sessionsApi.getWorkspaceLspState(sessionId, path, resolveWorkspaceLspConfig())
      set((state) => ({
        lspStateBySession: {
          ...state.lspStateBySession,
          [sessionId]: result.state,
        },
      }))
    } catch (error) {
      set((state) => ({
        lspStateBySession: {
          ...state.lspStateBySession,
          [sessionId]: {
            state: 'unavailable',
            path: path ?? null,
            serverName: null,
            command: null,
            error: error instanceof Error ? error.message : 'Failed to load LSP state',
          },
        },
      }))
    }
  },

  syncLsp: async (sessionId, input) => {
    try {
      const result = await sessionsApi.syncWorkspaceLsp(sessionId, {
        ...input,
        ...resolveWorkspaceLspConfig(),
      })
      set((state) => ({
        lspStateBySession: {
          ...state.lspStateBySession,
          [sessionId]: result.state,
        },
      }))
      if (input.path) {
        void get().loadLspDiagnostics(sessionId, input.path, false)
      }
    } catch (error) {
      set((state) => ({
        lspStateBySession: {
          ...state.lspStateBySession,
          [sessionId]: {
            state: 'unavailable',
            path: input.path,
            serverName: null,
            command: null,
            error: error instanceof Error ? error.message : 'Failed to sync LSP document',
          },
        },
      }))
    }
  },

  notifyAgentFileEdit: (sessionId, absolutePath) => {
    // Refresh status/diagnostics for the session regardless of whether the
    // edited file is open — the file tree + changed set may have moved.
    if (get().isPanelOpen(sessionId)) {
      void get().loadStatus(sessionId)
      void get().syncLsp(sessionId, { path: absolutePath, event: 'change' })
    }

    // Flag any open buffer for the same path with an agent-source conflict.
    // Agent edits arrive without a content hash (they come from the chat
    // tool stream, not a workspace save), so we use a sentinel hash that can
    // never equal a real base hash — guaranteeing the conflict surfaces.
    const normalizedAbs = normalizeAgentEditPath(absolutePath)
    set((state) => {
      let changed = false
      const nextBuffers: Record<string, WorkspaceBufferState | undefined> = {
        ...state.bufferStateByTabId,
      }
      for (const [tabId, buffer] of Object.entries(state.bufferStateByTabId)) {
        if (!buffer) continue
        if (!agentEditMatchesBufferPath(normalizedAbs, buffer.path)) continue
        // Already showing a conflict — don't clobber the existing one.
        if (buffer.conflict) continue
        changed = true
        nextBuffers[tabId] = {
          ...buffer,
          conflict: {
            source: 'agent',
            hash: AGENT_EDIT_SENTINEL_HASH,
            timestamp: Date.now(),
          },
        }
      }
      return changed ? { bufferStateByTabId: nextBuffers } : state
    })
  },

  clearBuffer: (tabId) =>
    set((state) => ({
      bufferStateByTabId: removeRecordKey(state.bufferStateByTabId, tabId),
    })),

  clearSession: (sessionId) => {
    invalidateRequest(statusRequestIds, sessionId)
    invalidateSessionScopedRequests(treeRequestIds, sessionId)
    invalidateSessionScopedRequests(previewRequestIds, sessionId)

    set((state) => {
      const sessionTabs = state.previewTabsBySession[sessionId] ?? []
      const tabIdsToDrop = new Set(sessionTabs.map((tab) => tab.id))
      const nextBufferStateByTabId: Record<string, WorkspaceBufferState | undefined> = {}
      for (const [tabId, buffer] of Object.entries(state.bufferStateByTabId)) {
        if (!tabIdsToDrop.has(tabId)) nextBufferStateByTabId[tabId] = buffer
      }

      return {
        panelBySession: removeRecordKey(state.panelBySession, sessionId),
        modeBySession: removeRecordKey(state.modeBySession, sessionId),
        statusBySession: removeRecordKey(state.statusBySession, sessionId),
        expandedPathsBySession: removeRecordKey(state.expandedPathsBySession, sessionId),
        treeBySessionPath: removeRecordKey(state.treeBySessionPath, sessionId),
        previewTabsBySession: removeRecordKey(state.previewTabsBySession, sessionId),
        activePreviewTabIdBySession: removeRecordKey(state.activePreviewTabIdBySession, sessionId),
        bufferStateByTabId: nextBufferStateByTabId,
        lspStateBySession: removeRecordKey(state.lspStateBySession, sessionId),
        lspDiagnosticsBySessionPath: stripSessionKeys(state.lspDiagnosticsBySessionPath, sessionId),
        loading: {
          statusBySession: removeRecordKey(state.loading.statusBySession, sessionId),
          treeBySessionPath: stripSessionKeys(state.loading.treeBySessionPath, sessionId),
          previewByTabId: stripSessionKeys(state.loading.previewByTabId, sessionId),
        },
        errors: {
          statusBySession: removeRecordKey(state.errors.statusBySession, sessionId),
          treeBySessionPath: stripSessionKeys(state.errors.treeBySessionPath, sessionId),
          previewByTabId: stripSessionKeys(state.errors.previewByTabId, sessionId),
        },
      }
    })
  },

  resetSessionUi: (sessionId) => {
    get().clearSession(sessionId)
  },
}))
