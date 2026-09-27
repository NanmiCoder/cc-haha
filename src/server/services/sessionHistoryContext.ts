import { createHash } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { mkdtemp, open, rm, stat } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HISTORY_SEMANTIC_RECORD_BYTES, streamBoundedHistory, withHistoryReadBudget } from './boundedSessionHistory.js'
import { ApiError } from '../middleware/errorHandler.js'

type Context = { owner?: string; suppressed: boolean }
type Cache = { database: Database; directory: string; identity: string; size: number; mtime: string; offset: number; suppressed: boolean | null; fingerprint?: string }
type Flight = { promise: Promise<void>; controller: AbortController; users: number }
const cache = new Map<string, Cache>()
const flights = new Map<string, Flight>()
process.once('exit', () => { for (const entry of cache.values()) { entry.database.close(); rmSync(entry.directory, { recursive: true, force: true }) } })

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
      await rm(state.directory, { recursive: true, force: true })
      state = undefined
    }
    if (!state) {
      while (cache.size >= 4) {
        const key = cache.keys().next().value!
        const evicted = cache.get(key)!
        cache.delete(key)
        evicted.database.close()
        await rm(evicted.directory, { recursive: true, force: true })
      }
      const directory = await mkdtemp(join(tmpdir(), 'claude-history-context-'))
      const database = new Database(join(directory, 'context.sqlite'))
      database.exec('PRAGMA journal_mode=OFF; PRAGMA cache_size=-512; PRAGMA temp_store=FILE; CREATE TABLE parents (id TEXT PRIMARY KEY, chain TEXT); CREATE TABLE context (offset INTEGER PRIMARY KEY, owner TEXT, suppressed INTEGER, unowned_sidechain INTEGER)')
      state = { database, directory, identity, size: 0, mtime: '', offset: 0, suppressed: false }
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
      await rm(state.directory, { recursive: true, force: true })
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
