import { sessionsApi, type WorkspaceFileStat } from '../api/sessions'
import type { FileLinkVerifier } from './markdownAutolink'

const KEY_SEPARATOR = '\u0000'
// Existence rarely flips under a rendered reply; a remount while scrolling
// should answer from memory instead of asking again.
const STAT_TTL_MS = 10_000
// The server's stat route takes at most this many paths per request.
const STAT_BATCH_SIZE = 20
const MAX_CACHED_PATHS = 2_000

type CacheEntry = {
  at: number
  /** Settled answer, readable without waiting. `null` = the request failed. */
  value?: WorkspaceFileStat | null
  promise: Promise<WorkspaceFileStat | null>
}

const cache = new Map<string, CacheEntry>()
const queued = new Map<string, Map<string, (stat: WorkspaceFileStat | null) => void>>()
let flushScheduled = false

export function resetWorkspaceFileStatsForTests() {
  cache.clear()
  queued.clear()
  flushScheduled = false
}

function cacheKey(sessionId: string, path: string) {
  return `${sessionId}${KEY_SEPARATOR}${path}`
}

function freshEntry(sessionId: string, path: string): CacheEntry | undefined {
  const entry = cache.get(cacheKey(sessionId, path))
  return entry && Date.now() - entry.at < STAT_TTL_MS ? entry : undefined
}

function flush() {
  flushScheduled = false
  const batches = [...queued]
  queued.clear()
  for (const [sessionId, resolvers] of batches) {
    const paths = [...resolvers.keys()]
    for (let start = 0; start < paths.length; start += STAT_BATCH_SIZE) {
      const batch = paths.slice(start, start + STAT_BATCH_SIZE)
      // Started inside the chain, so even a call that throws on the spot settles
      // every waiting path instead of leaving it pending forever.
      void Promise.resolve()
        .then(() => sessionsApi.statWorkspaceFiles(sessionId, batch))
        .then(({ files }) => new Map(files.map((file) => [file.path, file])))
        .catch(() => null)
        .then((byPath) => {
          for (const path of batch) resolvers.get(path)!(byPath?.get(path) ?? null)
        })
    }
  }
}

function request(sessionId: string, path: string): CacheEntry {
  let resolve!: (stat: WorkspaceFileStat | null) => void
  const entry: CacheEntry = {
    at: Date.now(),
    promise: new Promise((settle) => {
      resolve = settle
    }),
  }
  void entry.promise.then((stat) => {
    entry.value = stat
  })
  cache.set(cacheKey(sessionId, path), entry)
  while (cache.size > MAX_CACHED_PATHS) cache.delete(cache.keys().next().value!)

  let resolvers = queued.get(sessionId)
  if (!resolvers) queued.set(sessionId, resolvers = new Map())
  resolvers.set(path, resolve)
  if (!flushScheduled) {
    flushScheduled = true
    // Every message that mounts in one render asks in the same tick; one
    // microtask later they share a request instead of each sending their own.
    queueMicrotask(flush)
  }
  return entry
}

/**
 * The stats already known for these paths, or `undefined` when any is not.
 * Lets a remounted message render its final state on the first paint.
 */
export function peekWorkspaceFileStats(
  sessionId: string,
  paths: string[],
): Map<string, WorkspaceFileStat | null> | undefined {
  const known = new Map<string, WorkspaceFileStat | null>()
  for (const path of paths) {
    const entry = freshEntry(sessionId, path)
    if (!entry || entry.value === undefined) return undefined
    known.set(path, entry.value)
  }
  return known
}

/**
 * Stat workspace paths through one shared, batched, briefly cached channel.
 * A path maps to `null` when its request failed — not known, as opposed to
 * known missing.
 */
export function statWorkspacePaths(
  sessionId: string,
  paths: string[],
): Promise<Map<string, WorkspaceFileStat | null>> {
  const unique = [...new Set(paths)]
  return Promise.all(unique.map(async (path) => {
    const entry = freshEntry(sessionId, path) ?? request(sessionId, path)
    return [path, await entry.promise] as const
  })).then((entries) => new Map(entries))
}

// `~` means the user's home on the machine that opens the file; the workspace
// route would read it as a folder named `~` and call every such file missing.
const HOME_RELATIVE_RE = /^~(?:[\\/]|$)/

/**
 * Judge a reply's file links against the session workspace.
 *
 * `resolve` maps a link's path to what a click on it would open, so the answer is
 * about the same file. Only `missing` counts as missing: a path the workspace
 * route may not look at (`unavailable` — outside the workspace) or could not be
 * asked about keeps its link, and the click decides.
 */
export function createWorkspaceFileLinkVerifier(
  sessionId: string,
  resolve: (path: string) => string,
): FileLinkVerifier {
  const targets = (paths: string[]) => paths.flatMap((path) => {
    const target = resolve(path)
    return HOME_RELATIVE_RE.test(target) ? [] : [[path, target] as const]
  })
  const missingFrom = (pairs: (readonly [string, string])[], stats: Map<string, WorkspaceFileStat | null>) =>
    new Set(pairs.filter(([, target]) => stats.get(target)?.state === 'missing').map(([path]) => path))

  return {
    peekMissing(paths) {
      const pairs = targets(paths)
      const stats = peekWorkspaceFileStats(sessionId, pairs.map(([, target]) => target))
      return stats ? missingFrom(pairs, stats) : undefined
    },
    async findMissing(paths) {
      const pairs = targets(paths)
      return missingFrom(pairs, await statWorkspacePaths(sessionId, pairs.map(([, target]) => target)))
    },
  }
}

/**
 * Whether the workspace says this file is not there — at once when it already
 * answered, otherwise once it does. A path it cannot judge is never missing.
 */
export function isWorkspaceFileMissing(sessionId: string, path: string): boolean | Promise<boolean> {
  const verifier = createWorkspaceFileLinkVerifier(sessionId, (target) => target)
  const known = verifier.peekMissing([path])
  return known ? known.has(path) : verifier.findMissing([path]).then((missing) => missing.has(path))
}
