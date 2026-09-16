import { create } from 'zustand'
import {
  sessionsApi,
  type WorkspaceReadFileResult,
  type WorkspaceStatusResult,
  type WorkspaceTreeResult,
} from '../api/sessions'

/**
 * Layer 2 of the workspace: content data.
 *
 * It knows nothing about panels, docks or which tab is active — those belong to
 * `workspaceStore`. Keeping them apart is what lets a file stay loaded while
 * its panel is hidden, and lets a tab be closed without cancelling an unrelated
 * read.
 *
 * Everything is keyed by `sessionId::path` rather than by tab id, because the
 * same file opened from two entry points is one piece of content.
 */

export type WorkspaceFileState = WorkspaceReadFileResult['state'] | 'loading'

export type WorkspaceFileEntry = {
  path: string
  /** Server-validated identity used by watch events; the cache keeps its request path. */
  watchPath?: string
  state: WorkspaceFileState
  content?: string
  dataUrl?: string
  mimeType?: string
  previewType?: 'text' | 'image'
  language?: string
  size?: number
  truncated?: boolean
  error?: string
  /** Set when a refresh failed while a good payload is still on screen. */
  refreshError?: string | null
}

export type WorkspaceTreeView = {
  filter: string
  mode: 'all' | 'changed'
  scrollTop: number
  open: boolean
}

export const EMPTY_WORKSPACE_TREE_VIEW: WorkspaceTreeView = { filter: '', mode: 'all', scrollTop: 0, open: true }
export type WorkspaceFileView = { scrollTop: number; scrollLeft: number; revealNonce?: number }

type WorkspaceContentStore = {
  filesByKey: Record<string, WorkspaceFileEntry | undefined>
  treeByKey: Record<string, WorkspaceTreeResult | undefined>
  treeLoadingByKey: Record<string, boolean | undefined>
  expandedBySession: Record<string, string[] | undefined>
  statusBySession: Record<string, WorkspaceStatusResult | undefined>
  treeViewBySession: Record<string, WorkspaceTreeView | undefined>
  fileViewByKey: Record<string, WorkspaceFileView | undefined>
  setTreeView: (sessionId: string, patch: Partial<WorkspaceTreeView>) => void
  setFileView: (sessionId: string, path: string, view: WorkspaceFileView) => void

  getFile: (sessionId: string, path: string) => WorkspaceFileEntry | undefined
  getTree: (sessionId: string, path: string) => WorkspaceTreeResult | undefined
  isTreeLoading: (sessionId: string, path: string) => boolean
  isExpanded: (sessionId: string, path: string) => boolean

  loadStatus: (sessionId: string, options?: { force?: boolean; signal?: AbortSignal }) => Promise<void>
  loadFile: (sessionId: string, path: string, options?: { force?: boolean; signal?: AbortSignal }) => Promise<void>
  loadTree: (sessionId: string, path?: string, options?: { force?: boolean; signal?: AbortSignal }) => Promise<void>
  toggleDirectory: (sessionId: string, path: string) => Promise<void>
  /** Drop caches for paths a watcher reported as changed, keeping tree shape. */
  invalidatePaths: (sessionId: string, paths: string[]) => void
  refreshWatchedPaths: (sessionId: string, paths: string[], directories: string[], signal: AbortSignal) => Promise<void>
  forgetFile: (sessionId: string, path: string) => void
  clearSession: (sessionId: string) => void
}

function key(sessionId: string, path: string) {
  return `${sessionId}::${path}`
}

const fileRequests = new Map<string, number>()
const treeRequests = new Map<string, number>()
/** Sessions whose status probe has been attempted, successfully or not. */
const statusRequests = new Set<string>()

function nextRequest(store: Map<string, number>, id: string) {
  const next = (store.get(id) ?? 0) + 1
  store.set(id, next)
  return next
}

function isCurrent(store: Map<string, number>, id: string, request: number) {
  return store.get(id) === request
}

function invalidate(store: Map<string, number>, id: string) {
  store.set(id, (store.get(id) ?? 0) + 1)
}

function dropSessionKeys<T>(record: Record<string, T>, sessionId: string) {
  const prefix = `${sessionId}::`
  return Object.fromEntries(
    Object.entries(record).filter(([entryKey]) => !entryKey.startsWith(prefix)),
  ) as Record<string, T>
}

export const useWorkspaceContentStore = create<WorkspaceContentStore>((set, get) => ({
  filesByKey: {},
  treeByKey: {},
  treeLoadingByKey: {},
  expandedBySession: {},
  statusBySession: {},
  treeViewBySession: {},
  fileViewByKey: {},

  setTreeView: (sessionId, patch) => set((state) => ({
    treeViewBySession: {
      ...state.treeViewBySession,
      [sessionId]: { ...EMPTY_WORKSPACE_TREE_VIEW, ...state.treeViewBySession[sessionId], ...patch },
    },
  })),
  setFileView: (sessionId, path, view) => set((state) => ({
    fileViewByKey: { ...state.fileViewByKey, [key(sessionId, path)]: view },
  })),

  getFile: (sessionId, path) => get().filesByKey[key(sessionId, path)],
  getTree: (sessionId, path) => get().treeByKey[key(sessionId, path)],
  isTreeLoading: (sessionId, path) => get().treeLoadingByKey[key(sessionId, path)] === true,
  isExpanded: (sessionId, path) => (get().expandedBySession[sessionId] ?? []).includes(path),

  loadStatus: async (sessionId, options) => {
    if (options?.signal?.aborted) return
    const key = `${sessionId}::status`
    if (get().statusBySession[sessionId] && !options?.force) return
    // Guard the *request*, not just the result: a probe that fails caches
    // nothing, so without this every remount of the file tab fires another one.
    if (statusRequests.has(sessionId) && !options?.force) return
    statusRequests.add(sessionId)
    const request = nextRequest(fileRequests, key)
    try {
      const result = await sessionsApi.getWorkspaceStatus(sessionId, options?.signal)
      if (options?.signal?.aborted || !isCurrent(fileRequests, key, request)) return
      set((state) => ({ statusBySession: { ...state.statusBySession, [sessionId]: result } }))
    } catch {
      // The launcher only needs this to explain why review is unavailable; a
      // failed probe leaves the entry enabled rather than blaming the folder.
    }
  },

  loadFile: async (sessionId, path, options) => {
    if (options?.signal?.aborted) return
    const entryKey = key(sessionId, path)
    const existing = get().filesByKey[entryKey]
    if (existing && existing.state !== 'loading' && !options?.force) return

    const request = nextRequest(fileRequests, entryKey)
    set((state) => ({
      filesByKey: {
        ...state.filesByKey,
        [entryKey]: existing
          ? { ...existing, refreshError: null }
          : { path, state: 'loading', refreshError: null },
      },
    }))

    try {
      const result = await sessionsApi.getWorkspaceFile(sessionId, path, options?.signal)
      if (options?.signal?.aborted || !isCurrent(fileRequests, entryKey, request)) return
      set((state) => {
        const current = state.filesByKey[entryKey]
        // A failed refresh must not blank a file the user is reading; keep the
        // last good payload and surface the failure alongside it.
        if (current?.state === 'ok' && result.state !== 'ok') {
          return {
            filesByKey: {
              ...state.filesByKey,
              [entryKey]: { ...current, refreshError: result.error ?? result.state },
            },
          }
        }
        return {
          filesByKey: {
            ...state.filesByKey,
            [entryKey]: {
              path,
              watchPath: result.path,
              state: result.state,
              content: result.content,
              dataUrl: result.dataUrl,
              mimeType: result.mimeType,
              previewType: result.previewType ?? 'text',
              language: result.language,
              size: result.size,
              truncated: result.truncated,
              error: result.error,
              refreshError: null,
            },
          },
        }
      })
    } catch (error) {
      if (options?.signal?.aborted || !isCurrent(fileRequests, entryKey, request)) return
      const message = error instanceof Error ? error.message : 'Failed to read file'
      set((state) => {
        const current = state.filesByKey[entryKey]
        if (current?.state === 'ok') {
          return {
            filesByKey: { ...state.filesByKey, [entryKey]: { ...current, refreshError: message } },
          }
        }
        return {
          filesByKey: {
            ...state.filesByKey,
            [entryKey]: { path, state: 'error', error: message, refreshError: null },
          },
        }
      })
    }
  },

  loadTree: async (sessionId, path = '', options) => {
    if (options?.signal?.aborted) return
    const entryKey = key(sessionId, path)
    if (get().treeByKey[entryKey] && !options?.force) return

    const request = nextRequest(treeRequests, entryKey)
    set((state) => ({
      treeLoadingByKey: { ...state.treeLoadingByKey, [entryKey]: true },
    }))

    try {
      const result = await sessionsApi.getWorkspaceTree(sessionId, path, options?.signal)
      if (options?.signal?.aborted || !isCurrent(treeRequests, entryKey, request)) return
      set((state) => ({
        treeByKey: { ...state.treeByKey, [entryKey]: result },
        treeLoadingByKey: { ...state.treeLoadingByKey, [entryKey]: false },
      }))
    } catch (error) {
      if (options?.signal?.aborted || !isCurrent(treeRequests, entryKey, request)) return
      set((state) => ({
        treeByKey: {
          ...state.treeByKey,
          [entryKey]: {
            state: 'error',
            path,
            entries: [],
            error: error instanceof Error ? error.message : 'Failed to read directory',
          },
        },
        treeLoadingByKey: { ...state.treeLoadingByKey, [entryKey]: false },
      }))
    } finally {
      if (options?.signal?.aborted && isCurrent(treeRequests, entryKey, request)) {
        set((state) => ({ treeLoadingByKey: { ...state.treeLoadingByKey, [entryKey]: false } }))
      }
    }
  },

  toggleDirectory: async (sessionId, path) => {
    let shouldLoad = false
    set((state) => {
      const expanded = new Set(state.expandedBySession[sessionId] ?? [])
      if (expanded.has(path)) {
        expanded.delete(path)
      } else {
        expanded.add(path)
        if (!state.treeByKey[key(sessionId, path)]) shouldLoad = true
      }
      return { expandedBySession: { ...state.expandedBySession, [sessionId]: [...expanded] } }
    })
    if (shouldLoad) await get().loadTree(sessionId, path)
  },

  invalidatePaths: (sessionId, paths) => {
    if (paths.length === 0) return
    set((state) => {
      const filesByKey = { ...state.filesByKey }
      const treeByKey = { ...state.treeByKey }
      for (const path of paths) {
        const entryKey = key(sessionId, path)
        invalidate(fileRequests, entryKey)
        delete filesByKey[entryKey]
        // The directory listing that contains the path is stale too, but the
        // expansion state is not: re-reading a directory must not collapse the
        // tree the user is looking at.
        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
        const parentKey = key(sessionId, parent)
        invalidate(treeRequests, parentKey)
        delete treeByKey[parentKey]
      }
      return { filesByKey, treeByKey }
    })
  },

  refreshWatchedPaths: async (sessionId, paths, directories, signal) => {
    if (signal.aborted) return
    const prefix = `${sessionId}::`
    const changed = (candidate: string) => paths.some((path) => candidate === path || candidate.startsWith(`${path}/`))
    // Directory invalidations remain authoritative when either batching layer
    // also receives named paths. An unnamed child can be a replaced directory,
    // so refresh cached descendants too; never enumerate unopened descendants.
    const inChangedDirectory = (candidate: string) => directories.some((directory) => directory === ''
      ? !/^(?:[\\/]|[a-z]:[\\/])/i.test(candidate)
      : candidate === directory || candidate.startsWith(`${directory}/`))
    const state = get()
    // Refresh in place. Dropping the cache first would unmount the code/tree
    // surfaces and lose scroll, selection, and expanded-directory context.
    const reads: Promise<void>[] = []
    for (const entryKey of Object.keys(state.filesByKey)) {
      if (!entryKey.startsWith(prefix)) continue
      const path = entryKey.slice(prefix.length)
      const watchPath = state.filesByKey[entryKey]?.watchPath ?? path
      if (changed(path) || changed(watchPath) || inChangedDirectory(path) || inChangedDirectory(watchPath)) {
        reads.push(get().loadFile(sessionId, path, { force: true, signal }))
      }
    }
    for (const entryKey of Object.keys(state.treeByKey)) {
      if (!entryKey.startsWith(prefix)) continue
      const path = entryKey.slice(prefix.length)
      const watchPath = state.treeByKey[entryKey]?.path ?? path
      if (changed(path) || changed(watchPath) || inChangedDirectory(path) || inChangedDirectory(watchPath)) {
        reads.push(get().loadTree(sessionId, path, { force: true, signal }))
      }
    }
    reads.push(get().loadStatus(sessionId, { force: true, signal }))
    await Promise.allSettled(reads)
  },

  forgetFile: (sessionId, path) => {
    const entryKey = key(sessionId, path)
    invalidate(fileRequests, entryKey)
    set((state) => {
      if (!(entryKey in state.filesByKey)) return state
      const { [entryKey]: _removed, ...rest } = state.filesByKey
      return { filesByKey: rest }
    })
  },

  clearSession: (sessionId) => {
    statusRequests.delete(sessionId)
    const prefix = `${sessionId}::`
    for (const store of [fileRequests, treeRequests]) {
      for (const entryKey of store.keys()) {
        if (entryKey.startsWith(prefix)) invalidate(store, entryKey)
      }
    }
    set((state) => {
      const { [sessionId]: _removed, ...expandedBySession } = state.expandedBySession
      const { [sessionId]: _status, ...statusBySession } = state.statusBySession
      const { [sessionId]: _treeView, ...treeViewBySession } = state.treeViewBySession
      return {
        filesByKey: dropSessionKeys(state.filesByKey, sessionId),
        treeByKey: dropSessionKeys(state.treeByKey, sessionId),
        treeLoadingByKey: dropSessionKeys(state.treeLoadingByKey, sessionId),
        expandedBySession,
        statusBySession,
        treeViewBySession,
        fileViewByKey: dropSessionKeys(state.fileViewByKey, sessionId),
      }
    })
  },
}))
