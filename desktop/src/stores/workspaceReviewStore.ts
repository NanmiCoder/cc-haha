import { create } from 'zustand'
import { parseWorkspaceDiff } from '@/components/workspace/workspaceDiffModel'
import { sessionsApi } from '../api/sessions'
import {
  reviewApi,
  type GitReviewSource,
  type ResolvedReviewSource,
  type ReviewDiffResult,
  type ReviewStatusResult,
  type ReviewWriteResult,
} from '../api/review'
import {
  isWritableReviewSource,
  reviewSourceKey,
  type WorkspaceReviewSource,
} from '../lib/workspace/types'

/**
 * Review content, one entry per (task, comparison).
 *
 * The comparison is part of the key because "unstaged" and "staged" are
 * genuinely different data for the same repository — the old status/diff pair
 * had a single cache and therefore could not show both without one overwriting
 * the other.
 */

/**
 * The comparison an entry describes, as the panel should label it.
 *
 * Wider than `ResolvedReviewSource` because the `turn` entry is not served by
 * the Git review service and must not be re-labelled as one of its sources.
 * `resolvedBase` is declared on the `turn` arm too (always absent) so the union
 * stays a single readable shape for consumers.
 */
export type WorkspaceReviewSourceDescriptor =
  | ResolvedReviewSource
  | { kind: 'turn'; turnKey: string; userMessageIndex?: number; resolvedBase?: undefined }

export type WorkspaceReviewStatus = Omit<ReviewStatusResult, 'source'> & {
  source: WorkspaceReviewSourceDescriptor
}

export type WorkspaceReviewDiff = Omit<ReviewDiffResult, 'source'> & {
  source: WorkspaceReviewSourceDescriptor
}

/** Why the store declined a write before it reached the network. */
export type WorkspaceReviewRefusalReason =
  /** `branch`, `commit` and `turn` compare against something already written. */
  | 'read_only_source'
  /** No status has been read, so the server's staleness guard would be inert. */
  | 'no_snapshot'
  | 'no_paths'
  | 'wrong_source'

/**
 * Returned instead of `null` so a refusal is something the caller can render.
 * Shares `state`/`snapshot`/`results` with `ReviewWriteResult` so both arms of
 * the union can be read the same way.
 */
export type WorkspaceReviewRefusal = {
  state: 'refused'
  refusal: WorkspaceReviewRefusalReason
  snapshot: string
  results: []
}

export type WorkspaceReviewWriteOutcome = ReviewWriteResult | WorkspaceReviewRefusal

/**
 * What a revert is about to do, split by outcome, so the confirmation can name
 * the deletion instead of describing everything as "discard changes".
 */
export type WorkspaceReviewRevertPlan = {
  /** Tracked files: Git restores the content and the file stays on disk. */
  revertPaths: string[]
  /**
   * Untracked files: **deleted from disk**. Git has never stored them, so the
   * backup the server writes first is the only copy that survives.
   */
  deletePaths: string[]
  /** Paths the loaded status does not describe; the caller should re-read. */
  unknownPaths: string[]
}

export type WorkspaceReviewEntry = {
  status: WorkspaceReviewStatus | null
  loading: boolean
  error: string | null
  /** Set when a write was rejected because the working tree moved underneath. */
  stale: boolean
  /**
   * The comparison accepts no writes. `branch`/`commit` compare against
   * history and `turn` is not Git data at all; the server refuses all three,
   * and this is what lets the panel stop offering the buttons.
   */
  readOnly: boolean
  diffsByPath: Record<string, WorkspaceReviewDiff | undefined>
  diffLoadingByPath: Record<string, boolean | undefined>
  viewedPaths: string[]
  viewedSnapshot: string | null
  /** Where the last revert stashed recoverable copies. */
  lastBackupDir: string | null
  /** Paths the last revert deleted from disk rather than restored. */
  lastDeletedPaths: string[]
}

const EMPTY_ENTRY: WorkspaceReviewEntry = {
  status: null,
  loading: false,
  error: null,
  stale: false,
  readOnly: false,
  diffsByPath: {},
  diffLoadingByPath: {},
  viewedPaths: [],
  viewedSnapshot: null,
  lastBackupDir: null,
  lastDeletedPaths: [],
}

const EMPTY_READ_ONLY_ENTRY: WorkspaceReviewEntry = { ...EMPTY_ENTRY, readOnly: true }

/**
 * Both are module constants on purpose: `getEntry` is used as a Zustand
 * selector, so returning a freshly built object for an unseen key would make
 * every render produce a new snapshot.
 */
function emptyEntryFor(source: WorkspaceReviewSource): WorkspaceReviewEntry {
  return isWritableReviewSource(source) ? EMPTY_ENTRY : EMPTY_READ_ONLY_ENTRY
}

type WorkspaceReviewStore = {
  byKey: Record<string, WorkspaceReviewEntry | undefined>
  revisionBySession: Record<string, number | undefined>
  invalidateSession: (sessionId: string) => void
  isWriting: (sessionId: string) => boolean

  getEntry: (sessionId: string, source: WorkspaceReviewSource) => WorkspaceReviewEntry
  load: (
    sessionId: string,
    source: WorkspaceReviewSource,
    options?: { force?: boolean; signal?: AbortSignal },
  ) => Promise<void>
  loadDiff: (sessionId: string, source: WorkspaceReviewSource, path: string, oldPath?: string) => Promise<void>
  restoreViewed: (sessionId: string, source: WorkspaceReviewSource, paths: string[], snapshot?: string) => void
  toggleViewed: (sessionId: string, source: WorkspaceReviewSource, path: string) => void
  /**
   * Classifies the paths a revert would touch, from the status already loaded.
   * Call this before confirming: `deletePaths` is not recoverable from Git.
   */
  describeRevert: (
    sessionId: string,
    source: WorkspaceReviewSource,
    paths: string[],
  ) => WorkspaceReviewRevertPlan
  stage: (sessionId: string, source: WorkspaceReviewSource, paths: string[]) => Promise<WorkspaceReviewWriteOutcome>
  unstage: (sessionId: string, source: WorkspaceReviewSource, paths: string[]) => Promise<WorkspaceReviewWriteOutcome>
  revert: (sessionId: string, source: WorkspaceReviewSource, paths: string[]) => Promise<WorkspaceReviewWriteOutcome>
  stageHunk: (sessionId: string, source: WorkspaceReviewSource, patch: string) => Promise<WorkspaceReviewWriteOutcome>
  unstageHunk: (sessionId: string, source: WorkspaceReviewSource, patch: string) => Promise<WorkspaceReviewWriteOutcome>
  clearSession: (sessionId: string) => void
}

/** `turn` history is not Git data and never reaches this service. */
export function toGitReviewSource(source: WorkspaceReviewSource): GitReviewSource | null {
  return source.kind === 'turn' ? null : source
}

function entryKey(sessionId: string, source: WorkspaceReviewSource) {
  return `${sessionId}::${reviewSourceKey(source)}`
}

function refuse(reason: WorkspaceReviewRefusalReason): WorkspaceReviewRefusal {
  return { state: 'refused', refusal: reason, snapshot: '', results: [] }
}

const requests = new Map<string, number>()
const writesBySession = new Map<string, number>()

async function withReviewWrite<T>(sessionId: string, write: () => Promise<T>): Promise<T> {
  writesBySession.set(sessionId, (writesBySession.get(sessionId) ?? 0) + 1)
  try {
    return await write()
  } finally {
    const remaining = (writesBySession.get(sessionId) ?? 1) - 1
    if (remaining) writesBySession.set(sessionId, remaining)
    else writesBySession.delete(sessionId)
    useWorkspaceReviewStore.getState().invalidateSession(sessionId)
  }
}

function nextRequest(key: string) {
  const next = (requests.get(key) ?? 0) + 1
  requests.set(key, next)
  return next
}

export const useWorkspaceReviewStore = create<WorkspaceReviewStore>((set, get) => ({
  byKey: {},
  revisionBySession: {},
  invalidateSession: (sessionId) => set(state => ({ revisionBySession: {
    ...state.revisionBySession,
    [sessionId]: (state.revisionBySession[sessionId] ?? 0) + 1,
  } })),
  isWriting: (sessionId) => writesBySession.has(sessionId),

  getEntry: (sessionId, source) =>
    get().byKey[entryKey(sessionId, source)] ?? emptyEntryFor(source),

  load: async (sessionId, source, options) => {
    if (options?.signal?.aborted) return
    const git = toGitReviewSource(source)
    if (!git) return loadSessionChangeStatus(set, get, sessionId, source, options)
    const key = entryKey(sessionId, source)
    const current = get().byKey[key]
    if (current?.status && !options?.force) return

    const request = nextRequest(key)
    const base = emptyEntryFor(source)
    set((state) => ({
      byKey: {
        ...state.byKey,
        [key]: { ...(state.byKey[key] ?? base), loading: true, error: null },
      },
    }))

    try {
      const status = await (options?.signal ? reviewApi.getStatus(sessionId, git, { signal: options.signal }) : reviewApi.getStatus(sessionId, git))
      if (requests.get(key) !== request) return
      if (options?.signal?.aborted) {
        set(state => ({ byKey: { ...state.byKey, [key]: { ...(state.byKey[key] ?? base), loading: false } } }))
        return
      }
      set((state) => {
        const entry = state.byKey[key] ?? base
        // A new snapshot invalidates every cached diff: the per-file payloads
        // were read against the old one and applying a hunk from them would be
        // applying it to content the user never saw.
        const snapshotChanged = entry.status?.snapshot !== status.snapshot
        return {
          byKey: {
            ...state.byKey,
            [key]: {
              ...entry,
              status,
              viewedPaths: entry.viewedSnapshot === status.snapshot ? entry.viewedPaths : [],
              viewedSnapshot: status.snapshot,
              loading: false,
              stale: false,
              readOnly: base.readOnly,
              // A read that ended in a terminal state is not "no changes".
              // `missing_workdir` in particular used to arrive with no message
              // at all, and the panel drew a green check over a deleted
              // worktree.
              error: status.error ?? null,
              diffsByPath: snapshotChanged ? {} : entry.diffsByPath,
              diffLoadingByPath: {},
            },
          },
        }
      })
    } catch (error) {
      if (requests.get(key) !== request) return
      set((state) => ({
        byKey: {
          ...state.byKey,
          [key]: {
            ...(state.byKey[key] ?? base),
            loading: false,
            error: options?.signal?.aborted ? state.byKey[key]?.error ?? null : error instanceof Error ? error.message : 'Failed to load review',
          },
        },
      }))
    }
  },

  loadDiff: async (sessionId, source, path, oldPath) => {
    const git = toGitReviewSource(source)
    if (!git) return loadSessionChangeDiff(set, get, sessionId, source, path)
    const key = entryKey(sessionId, source)
    const existing = get().byKey[key]
    // The in-flight check matters as much as the cache one: a re-render while
    // the first request is open would otherwise issue a second request for the
    // same file, and a large review re-renders on every arriving diff.
    if (existing?.stale || existing?.loading || existing?.diffsByPath[path] || existing?.diffLoadingByPath[path]) return

    const generation = requests.get(key)
    const base = emptyEntryFor(source)
    set((state) => {
      const entry = state.byKey[key] ?? base
      return {
        byKey: {
          ...state.byKey,
          [key]: {
            ...entry,
            diffLoadingByPath: { ...entry.diffLoadingByPath, [path]: true },
          },
        },
      }
    })

    try {
      const diff = await reviewApi.getDiff(sessionId, git, path, oldPath)
      if (requests.get(key) !== generation || !get().byKey[key]) return
      set((state) => {
        const entry = state.byKey[key] ?? base
        // Drop a diff that arrived for a snapshot we have already moved past.
        if (entry.status && diff.snapshot && entry.status.snapshot !== diff.snapshot) {
          return {
            byKey: {
              ...state.byKey,
              [key]: {
                ...entry,
                stale: true,
                diffLoadingByPath: { ...entry.diffLoadingByPath, [path]: false },
              },
            },
          }
        }
        return {
          byKey: {
            ...state.byKey,
            [key]: {
              ...entry,
              diffsByPath: { ...entry.diffsByPath, [path]: diff },
              diffLoadingByPath: { ...entry.diffLoadingByPath, [path]: false },
            },
          },
        }
      })
    } catch (error) {
      if (requests.get(key) !== generation || !get().byKey[key]) return
      set((state) => {
        const entry = state.byKey[key] ?? base
        return {
          byKey: {
            ...state.byKey,
            [key]: {
              ...entry,
              diffLoadingByPath: { ...entry.diffLoadingByPath, [path]: false },
              diffsByPath: {
                ...entry.diffsByPath,
                [path]: {
                  state: 'error',
                  source: git,
                  snapshot: entry.status?.snapshot ?? '',
                  path,
                  error: error instanceof Error ? error.message : 'Failed to load diff',
                },
              },
            },
          },
        }
      })
    }
  },

  restoreViewed: (sessionId, source, paths, snapshot) => set(state => {
    const key = entryKey(sessionId, source)
    return { byKey: { ...state.byKey, [key]: { ...(state.byKey[key] ?? emptyEntryFor(source)), viewedPaths: snapshot ? paths : [], viewedSnapshot: snapshot ?? null } } }
  }),

  toggleViewed: (sessionId, source, path) =>
    set((state) => {
      const key = entryKey(sessionId, source)
      const entry = state.byKey[key] ?? emptyEntryFor(source)
      const viewedPaths = entry.viewedPaths.includes(path)
        ? entry.viewedPaths.filter((candidate) => candidate !== path)
        : [...entry.viewedPaths, path]
      return { byKey: { ...state.byKey, [key]: { ...entry, viewedPaths, viewedSnapshot: entry.status?.snapshot ?? null } } }
    }),

  describeRevert: (sessionId, source, paths) => {
    const status = get().byKey[entryKey(sessionId, source)]?.status
    const untracked = new Set(status?.untracked ?? [])
    const known = new Set(status?.files.map((file) => file.path) ?? [])

    const plan: WorkspaceReviewRevertPlan = { revertPaths: [], deletePaths: [], unknownPaths: [] }
    for (const path of paths) {
      if (untracked.has(path)) plan.deletePaths.push(path)
      else if (known.has(path)) plan.revertPaths.push(path)
      else plan.unknownPaths.push(path)
    }
    return plan
  },

  stage: (sessionId, source, paths) => runWrite(set, get, sessionId, source, paths, 'stage'),
  unstage: (sessionId, source, paths) => runWrite(set, get, sessionId, source, paths, 'unstage'),
  revert: (sessionId, source, paths) => runWrite(set, get, sessionId, source, paths, 'revert'),

  stageHunk: (sessionId, source, patch) => runHunkWrite(set, get, sessionId, source, patch, 'stageHunk'),
  unstageHunk: (sessionId, source, patch) => runHunkWrite(set, get, sessionId, source, patch, 'unstageHunk'),

  clearSession: (sessionId) =>
    set((state) => {
      const prefix = `${sessionId}::`
      for (const key of requests.keys()) {
        if (key.startsWith(prefix)) requests.set(key, (requests.get(key) ?? 0) + 1)
      }
      const { [sessionId]: _revision, ...revisionBySession } = state.revisionBySession
      return {
        revisionBySession,
        byKey: Object.fromEntries(
          Object.entries(state.byKey).filter(([key]) => !key.startsWith(prefix)),
        ),
      }
    }),
}))

async function runWrite(
  set: SetState,
  get: () => WorkspaceReviewStore,
  sessionId: string,
  source: WorkspaceReviewSource,
  paths: string[],
  operation: 'stage' | 'unstage' | 'revert',
): Promise<WorkspaceReviewWriteOutcome> {
  const git = toGitReviewSource(source)
  // `branch`, `commit` and `turn` all describe something already written: a
  // commit, a merge-base, or the session's own record. The server refuses them
  // too; refusing here keeps the request off the wire and gives the caller a
  // reason it can show instead of a silent no-op.
  if (!git || !isWritableReviewSource(source)) return refuse('read_only_source')
  if (source.kind === 'staged' && operation !== 'unstage') return refuse('wrong_source')
  if (paths.length === 0) return refuse('no_paths')

  const key = entryKey(sessionId, source)
  if (get().byKey[key]?.stale) return { state: 'stale', snapshot: get().byKey[key]?.status?.snapshot ?? '', results: [] }
  const snapshot = get().byKey[key]?.status?.snapshot
  // Without a snapshot there is nothing to compare against, so the guard that
  // stops a write landing on content the user never saw would be inert.
  if (!snapshot) return refuse('no_snapshot')

  const generation = nextRequest(key)
  const result = await withReviewWrite(sessionId, () => reviewApi[operation](sessionId, { paths, snapshot, source: git }))
  if (requests.get(key) !== generation || !get().byKey[key]) return result

  set((state) => {
    const entry = state.byKey[key] ?? emptyEntryFor(source)
    return {
      byKey: {
        ...state.byKey,
        [key]: {
          ...entry,
          stale: result.state === 'stale',
          error: result.state === 'stale' ? null : result.error ?? null,
          status: result.status ?? entry.status,
          viewedPaths: [],
          viewedSnapshot: result.snapshot,
          // Every write moves the snapshot, so cached diffs are worthless.
          diffsByPath: {},
          diffLoadingByPath: {},
          lastBackupDir: result.backupDir ?? entry.lastBackupDir,
          // Deletions are reported separately from restorations because only
          // one of the two is unrecoverable from Git.
          lastDeletedPaths: result.deletedPaths ?? [],
        },
      },
    }
  })

  return result
}

async function runHunkWrite(
  set: SetState,
  get: () => WorkspaceReviewStore,
  sessionId: string,
  source: WorkspaceReviewSource,
  patch: string,
  operation: 'stageHunk' | 'unstageHunk',
): Promise<WorkspaceReviewWriteOutcome> {
  if (source.kind !== (operation === 'stageHunk' ? 'unstaged' : 'staged')) return refuse('wrong_source')
  const key = entryKey(sessionId, source)
  const entry = get().byKey[key]
  if (!entry?.status?.snapshot) return refuse('no_snapshot')
  if (entry.stale) return { state: 'stale', snapshot: entry.status.snapshot, results: [] }
  const generation = nextRequest(key)
  const result = await withReviewWrite(sessionId, () => reviewApi[operation](sessionId, { source, snapshot: entry.status!.snapshot, patch }))
  if (requests.get(key) !== generation || !get().byKey[key]) return result
  set(state => ({ byKey: { ...state.byKey, [key]: {
    ...state.byKey[key]!,
    status: result.status ?? state.byKey[key]!.status,
    viewedPaths: [],
    viewedSnapshot: result.snapshot,
    stale: result.state === 'stale',
    error: result.state === 'stale' ? null : result.error ?? null,
    diffsByPath: {},
    diffLoadingByPath: {},
  } } }))
  return result
}

type SetState = (updater: (state: { byKey: Record<string, WorkspaceReviewEntry | undefined> }) => {
  byKey: Record<string, WorkspaceReviewEntry | undefined>
}) => void

/** A turn review only reads recorded checkpoint boundaries, never workspace Git. */
async function loadSessionChangeStatus(
  set: SetState,
  get: () => WorkspaceReviewStore,
  sessionId: string,
  source: WorkspaceReviewSource,
  options?: { force?: boolean },
): Promise<void> {
  if (source.kind !== 'turn') return
  const key = entryKey(sessionId, source)
  if (get().byKey[key]?.status && !options?.force) return
  const request = nextRequest(key)
  const base = emptyEntryFor(source)
  set(state => ({ byKey: { ...state.byKey, [key]: { ...(state.byKey[key] ?? base), loading: true, error: null, diffLoadingByPath: {} } } }))
  try {
    const result = await sessionsApi.getTurnCheckpoints(sessionId, undefined, true)
    if (requests.get(key) !== request) return
    const checkpoint = result.checkpoints.find(candidate =>
      (source.turnKey ? candidate.target.targetUserMessageId === source.turnKey : true) &&
      (source.userMessageIndex === undefined ? !!source.turnKey : candidate.target.userMessageIndex === source.userMessageIndex))
    if (!checkpoint) throw new Error('The recorded turn checkpoint is unavailable')
    const root = checkpoint.workDir?.replaceAll('\\', '/').replace(/\/+$/, '')
    const paths = checkpoint.code.filesChanged.map(path => {
      const normalized = path.replaceAll('\\', '/')
      return root && normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized
    })
    set(state => ({ byKey: { ...state.byKey, [key]: {
      ...(state.byKey[key] ?? base),
      loading: false,
      readOnly: true,
      stale: false,
      error: checkpoint.code.available === false ? checkpoint.code.reason ?? 'The recorded turn checkpoint is unavailable' : null,
      diffsByPath: {},
      diffLoadingByPath: {},
      status: {
        state: checkpoint.code.available === false ? 'error' : 'ok',
        source,
        snapshot: reviewSourceKey(source),
        untracked: [],
        files: paths.map(path => ({ path, status: 'modified', additions: 0, deletions: 0, binary: false, staged: false, unstaged: false, conflicted: false })),
        totals: { additions: checkpoint.code.insertions, deletions: checkpoint.code.deletions, files: paths.length },
      },
    } } }))
  } catch (error) {
    if (requests.get(key) !== request) return
    set(state => ({ byKey: { ...state.byKey, [key]: { ...(state.byKey[key] ?? base), loading: false, error: error instanceof Error ? error.message : 'Failed to load checkpoint' } } }))
  }
}

async function loadSessionChangeDiff(
  set: SetState,
  get: () => WorkspaceReviewStore,
  sessionId: string,
  source: WorkspaceReviewSource,
  path: string,
): Promise<void> {
  if (source.kind !== 'turn') return
  const key = entryKey(sessionId, source)
  const existing = get().byKey[key]
  if (!existing?.status || existing.loading || existing.diffsByPath[path] || existing.diffLoadingByPath[path]) return
  const generation = requests.get(key)
  set(state => ({ byKey: { ...state.byKey, [key]: { ...state.byKey[key]!, diffLoadingByPath: { ...state.byKey[key]!.diffLoadingByPath, [path]: true } } } }))
  const result = await sessionsApi.getTurnCheckpointDiff(sessionId, source.turnKey, path, source.userMessageIndex, true).catch((error: unknown) => ({
    state: 'error' as const, path, error: error instanceof Error ? error.message : 'Failed to load checkpoint diff',
  }))
  if (requests.get(key) !== generation || !get().byKey[key]) return
  const parsed = 'diff' in result && result.diff ? parseWorkspaceDiff(result.diff) : []
  const rows = parsed.flatMap(file => file.rows)
  set(state => ({ byKey: { ...state.byKey, [key]: {
    ...state.byKey[key]!,
    status: state.byKey[key]!.status ? {
      ...state.byKey[key]!.status!,
      files: state.byKey[key]!.status!.files.map(file => file.path === path ? {
        ...file,
        additions: rows.filter(row => row.kind === 'addition').length,
        deletions: rows.filter(row => row.kind === 'deletion').length,
      } : file),
    } : null,
    diffLoadingByPath: { ...state.byKey[key]!.diffLoadingByPath, [path]: false },
    diffsByPath: { ...state.byKey[key]!.diffsByPath, [path]: {
      state: result.state === 'ok' ? 'ok' : result.state === 'missing' ? 'missing' : 'error',
      source, snapshot: reviewSourceKey(source), path,
      diff: 'diff' in result ? result.diff : undefined,
      error: result.error,
    } },
  } } }))
}
