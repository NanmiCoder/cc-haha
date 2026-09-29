import { createHash } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { mkdir, open, stat } from 'node:fs/promises'
import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getCcHahaDir } from '../../utils/envUtils.js'
import { HISTORY_SEMANTIC_RECORD_BYTES, streamBoundedHistory, withHistoryReadBudget } from './boundedSessionHistory.js'
import { ApiError } from '../middleware/errorHandler.js'

type Context = { owner?: string; suppressed: boolean }
type Cache = { database: Database; file: string; identity: string; size: number; mtime: string; offset: number; suppressed: boolean | null; fingerprint?: string }
type Flight = { promise: Promise<void>; controller: AbortController; users: number }
const cache = new Map<string, Cache>()
const flights = new Map<string, Flight>()
process.once('exit', () => { for (const entry of cache.values()) entry.database.close() })

/**
 * Where the per-transcript context indexes live.
 *
 * Durability is the point. Building one means streaming the entire transcript —
 * measured 2.9 s for a 146 MB session — and the build used to live in a
 * `mkdtemp` directory that was removed on eviction and at exit, so every
 * restart and every eviction paid that scan again; the abandoned directories
 * also leaked (634 of them, 92 MB, found under /tmp). Keying a file per
 * transcript under the config dir makes the scan a one-time cost.
 *
 * Nothing about staleness checking changes: an index is still trusted only for
 * the exact identity/size/mtime it was built from, and is discarded and rebuilt
 * whenever those disagree.
 */
const SCHEMA_VERSION = '1'
function contextDirectory(): string {
  return process.env.CC_HAHA_HISTORY_CONTEXT_DIR ?? join(getCcHahaDir(), 'db', 'history-context-v1')
}
function databasePathFor(filePath: string): string {
  return join(contextDirectory(), `${createHash('sha256').update(filePath).digest('hex').slice(0, 40)}.sqlite`)
}

const SCHEMA = `PRAGMA journal_mode=OFF; PRAGMA cache_size=-512; PRAGMA temp_store=FILE;
CREATE TABLE IF NOT EXISTS parents (id TEXT PRIMARY KEY, chain TEXT);
CREATE TABLE IF NOT EXISTS context (offset INTEGER PRIMARY KEY, owner TEXT, suppressed INTEGER, unowned_sidechain INTEGER);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`

type Meta = { schema: string; identity: string; size: number; mtime: string; offset: number; suppressed: boolean | null; fingerprint: string }

function readMeta(database: Database): Meta | null {
  try {
    const rows = database.query('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>
    if (rows.length === 0) return null
    const values = new Map(rows.map(row => [row.key, row.value]))
    const suppressed = values.get('suppressed')
    return {
      schema: values.get('schema') ?? '',
      identity: values.get('identity') ?? '',
      size: Number(values.get('size') ?? 0),
      mtime: values.get('mtime') ?? '',
      offset: Number(values.get('offset') ?? 0),
      suppressed: suppressed === 'null' ? null : suppressed === 'true',
      fingerprint: values.get('fingerprint') ?? '',
    }
  } catch {
    // No meta table (or an unreadable one) — treat the file as absent.
    return null
  }
}

function writeMeta(database: Database, values: Record<string, string | number>): void {
  const statement = database.query('INSERT OR REPLACE INTO meta VALUES (?, ?)')
  for (const [key, value] of Object.entries(values)) statement.run(key, String(value))
}

/**
 * Adopt the index already on disk when it still describes this file, so a fresh
 * process resumes from the stored snapshot instead of rescanning. The stored
 * scalars are the same ones the in-memory state carries: size and offset say
 * where to continue, `suppressed` is the running notification state at the last
 * complete line, and the fingerprint backs the rewritten-growth check.
 */
function openIndex(file: string, identity: string, size: number, mtime: string): Cache {
  try {
    const database = new Database(file)
    const meta = readMeta(database)
    if (
      meta
      && meta.schema === SCHEMA_VERSION
      && meta.identity === identity
      && meta.size <= size
      // Same size means the suffix is empty, so the mtime has to match exactly;
      // a shorter snapshot is fine to continue from and gets re-fingerprinted.
      && (meta.size < size || meta.mtime === mtime)
    ) {
      return {
        database,
        file,
        identity,
        size: meta.size,
        mtime: meta.mtime,
        offset: meta.offset,
        suppressed: meta.suppressed,
        ...(meta.fingerprint ? { fingerprint: meta.fingerprint } : {}),
      }
    }
    database.close()
  } catch {
    // Missing, or left in a shape we cannot read.
  }
  rmSync(file, { force: true })
  const database = new Database(file)
  database.exec(SCHEMA)
  writeMeta(database, { schema: SCHEMA_VERSION, identity, size: 0, mtime: '', offset: 0, suppressed: 'false', fingerprint: '' })
  return { database, file, identity, size: 0, mtime: '', offset: 0, suppressed: false }
}

/** Sweep indexes untouched for a week, at most once per process. */
let pruned = false
function pruneOnce(): void {
  if (pruned) return
  pruned = true
  try {
    const directory = contextDirectory()
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.sqlite')) continue
      const path = join(directory, name)
      // One unreadable file must not stop the sweep.
      try { if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true }) } catch { /* skip */ }
    }
  } catch { /* the directory may not exist yet */ }
}

/** Test-only: drop the in-memory handles so one process can exercise a cold start. */
export function __resetHistoryContextCacheForTests(): void {
  for (const entry of cache.values()) entry.database.close()
  cache.clear()
  flights.clear()
}

async function sourceAnchors(filePath: string, size: number, signal: AbortSignal): Promise<string> {
  const handle = await open(filePath, 'r')
  try {
    const hash = createHash('sha256')
    for (const offset of [0, Math.max(0, size - 4096)]) {
      const bytes = Buffer.alloc(Math.min(4096, size - offset))
      let read = 0
      while (read < bytes.length) {
        if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
        const result = await handle.read(bytes, read, bytes.length - read, offset + read)
        if (!result.bytesRead) throw new ApiError(409, 'History changed during context validation', 'HISTORY_CHANGED')
        read += result.bytesRead
      }
      hash.update(bytes)
    }
    return hash.digest('hex')
  } finally { await handle.close() }
}

/** Disk-backed visibility/ownership scalars. Payload records never enter this
 * index. Only append suffixes are scanned after the initial bounded build. */
export async function readHistoryContexts(options: {
  filePath: string
  sourceVersion: string
  offsets: number[]
  signal?: AbortSignal
  includeUnownedSidechains?: boolean
  classify: (entry: Record<string, unknown>) => { notification: boolean; reset: boolean; agentToolId?: string }
}): Promise<{ contexts: Map<number, Context>; scannedBytes: number }> {
  if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError')
  const [dev, ino, size, mtime] = options.sourceVersion.split(':')
  const targetSize = Number(size)
  const identity = `${dev}:${ino}`
  let scannedBytes = 0
  const ensure = async (signal: AbortSignal) => withHistoryReadBudget(signal, async () => {
    const current = await stat(options.filePath, { bigint: true })
    if (`${current.dev}:${current.ino}` !== identity || Number(current.size) < targetSize || (Number(current.size) === targetSize && String(current.mtimeNs) !== mtime)) {
      throw new ApiError(409, 'Session history changed during context lookup', 'HISTORY_CHANGED')
    }
    let state = cache.get(options.filePath)
    const rewrittenGrowth = state?.fingerprint && Number(current.size) > state.size
      ? state.fingerprint !== await sourceAnchors(options.filePath, state.size, signal) : false
    if (state && (rewrittenGrowth || state.identity !== identity || Number(current.size) < state.size || (Number(current.size) === state.size && String(current.mtimeNs) !== state.mtime))) {
      cache.delete(options.filePath)
      state.database.close()
      rmSync(state.file, { force: true })
      state = undefined
    }
    if (!state) {
      // Evict from memory only. The index is durable now, so dropping it here
      // must not destroy the file the next open would have reused; the sweep in
      // pruneOnce is what bounds the directory.
      while (cache.size >= 4) {
        const key = cache.keys().next().value!
        const evicted = cache.get(key)!
        cache.delete(key)
        evicted.database.close()
      }
      pruneOnce()
      await mkdir(contextDirectory(), { recursive: true, mode: 0o700 })
      state = openIndex(databasePathFor(options.filePath), identity, Number(current.size), mtime!)
      cache.set(options.filePath, state)
    }
    cache.delete(options.filePath)
    cache.set(options.filePath, state)
    if (state.size >= targetSize) return
    const getParent = state.database.query('SELECT chain FROM parents WHERE id = ?')
    const saveParent = state.database.query('INSERT OR REPLACE INTO parents VALUES (?, ?)')
    const saveContext = state.database.query('INSERT OR REPLACE INTO context VALUES (?, ?, ?, ?)')
    const originalOffset = state.offset
    let suppressed = state.suppressed
    let completeSuppression = suppressed
    try {
      const fingerprint = await sourceAnchors(options.filePath, targetSize, signal)
      state.database.exec('BEGIN')
      const result = await streamBoundedHistory(options.filePath, (entry, completeLine, offset) => {
        const classification = options.classify(entry)
        const inherited = typeof entry.parentUuid === 'string' ? (getParent.get(entry.parentUuid) as { chain?: string } | null)?.chain : undefined
        const explicit = typeof entry.parent_tool_use_id === 'string' && entry.parent_tool_use_id ? entry.parent_tool_use_id : undefined
        const owner = explicit ?? (entry.isSidechain === true ? inherited : undefined)
        const chain = classification.agentToolId ?? inherited
        if (typeof entry.uuid === 'string') saveParent.run(entry.uuid, chain ?? null)
        if (classification.notification) suppressed = true
        else if (classification.reset) suppressed = false
        // Keep root-only ownership filtering separate from notification state:
        // a dedicated child transcript legitimately lacks its parent's Agent call.
        saveContext.run(offset, owner ?? null, suppressed !== false ? 1 : 0, entry.isSidechain === true && !owner ? 1 : 0)
        if (completeLine) completeSuppression = suppressed
      }, signal, { startOffset: originalOffset, endOffset: targetSize, maxRecordBytes: HISTORY_SEMANTIC_RECORD_BYTES, onSkipped: () => { suppressed = null; completeSuppression = null } })
      if (fingerprint !== await sourceAnchors(options.filePath, targetSize, signal)) throw new ApiError(409, 'History was rewritten during context scan', 'HISTORY_CHANGED')
      // Persist the resumable scalars in the same transaction as the rows they
      // describe, so a reopened index can never disagree with its own contents.
      writeMeta(state.database, {
        schema: SCHEMA_VERSION,
        identity,
        size: targetSize,
        mtime: mtime!,
        offset: result.nextOffset,
        suppressed: completeSuppression === null ? 'null' : String(completeSuppression),
        fingerprint,
      })
      state.database.exec('COMMIT')
      state.fingerprint = fingerprint
      state.size = targetSize
      state.mtime = mtime!
      state.offset = result.nextOffset
      state.suppressed = completeSuppression
      scannedBytes += result.scannedBytes
    } catch (error) {
      try { state.database.exec('ROLLBACK') } catch { /* Validation may fail before BEGIN. */ }
      // journal_mode=OFF cannot guarantee rollback restoration after a failed
      // build; discard this regenerable index entirely.
      cache.delete(options.filePath)
      state.database.close()
      rmSync(state.file, { force: true })
      throw error
    }
  }, 'context')
  // Join one file build. Each caller may cancel independently; the scan is
  // aborted when the final interested caller goes away.
  while (!cache.get(options.filePath) || cache.get(options.filePath)!.size < targetSize || cache.get(options.filePath)!.identity !== identity || (cache.get(options.filePath)!.size === targetSize && cache.get(options.filePath)!.mtime !== mtime)) {
    let flight = flights.get(options.filePath)
    if (flight?.controller.signal.aborted) {
      await flight.promise.catch(() => {})
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError')
      continue
    }
    if (!flight) {
      if (flights.size >= 5) throw new ApiError(429, 'History context reader is busy', 'HISTORY_BUSY')
      const controller = new AbortController()
      flight = { controller, users: 0, promise: Promise.resolve() }
      const currentFlight = flight
      flight.promise = ensure(controller.signal).finally(() => { if (flights.get(options.filePath) === currentFlight) flights.delete(options.filePath) })
      flights.set(options.filePath, flight)
    }
    flight.users++
    const joined = flight
    await new Promise<void>((resolve, reject) => {
      let done = false
      const finish = (error?: unknown) => {
        if (done) return
        done = true
        options.signal?.removeEventListener('abort', abort)
        joined.users--
        if (!joined.users && error) joined.controller.abort(error)
        if (error) reject(error); else resolve()
      }
      const abort = () => finish(options.signal?.reason ?? new DOMException('Aborted', 'AbortError'))
      options.signal?.addEventListener('abort', abort, { once: true })
      joined.promise.then(() => finish(), error => finish(error))
      if (options.signal?.aborted) abort()
    })
  }
  const state = cache.get(options.filePath)!
  const query = state.database.query('SELECT owner, suppressed, unowned_sidechain FROM context WHERE offset = ?')
  const contexts = new Map<number, Context>()
  for (const offset of options.offsets) {
    const row = query.get(offset) as { owner: string | null; suppressed: number; unowned_sidechain: number } | null
    if (!row) throw new ApiError(409, 'History context is unavailable; reload the page', 'HISTORY_CHANGED')
    contexts.set(offset, { owner: row.owner ?? undefined, suppressed: row.suppressed === 1 || (!options.includeUnownedSidechains && row.unowned_sidechain === 1) })
  }
  return { contexts, scannedBytes }
}
