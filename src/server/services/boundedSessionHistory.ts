import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { ApiError } from '../middleware/errorHandler.js'

export const HISTORY_SCAN_BYTES = 16 * 1024 * 1024
/** Scan ceiling for the full-history read. It may walk much further than a
 * single page because its output budget is `HISTORY_FULL_BYTES`, but the I/O
 * per request still needs a hard cap: one bounded read is a synchronous walk
 * with no other yield point. */
export const HISTORY_FULL_SCAN_BYTES = 64 * 1024 * 1024
export const HISTORY_SEMANTIC_RECORD_BYTES = 8 * 1024 * 1024
export const HISTORY_RECORD_BYTES = 1024 * 1024
export const HISTORY_PAGE_BYTES = 256 * 1024
export const HISTORY_PAGE_RECORDS = 200
export const HISTORY_PAGE_ROWS = 500
/** Single-request ceiling for the "load the whole transcript at once" path.
 * The desktop timeline reads this in one shot so it never has to stitch pages
 * together; past the budget the reader still returns the newest slice and
 * reports `historyComplete: false` instead of failing with 413. */
export const HISTORY_FULL_BYTES = 32 * 1024 * 1024
/** Row ceiling for the full-history path. The byte budget is the real bound;
 * this only stops pathological all-tiny-record transcripts from building a
 * six-figure-entry array. */
export const HISTORY_FULL_ROWS = 250_000

type Cursor = { version: 1; dev: string; ino: string; size: number; mtime: string; offset: number; skipping: boolean; direction?: 'older' | 'newer'; fingerprints?: { prefix: string; tail: string; boundary: string } }
export type HistoryPageInfo = {
  previousCursor?: string | null
  nextCursor: string | null
  hasMore: boolean
  contentTruncated?: boolean
  historyComplete: boolean
  sourceVersion: string
  scannedBytes: number
  contextScanBytes?: number
  omittedOversizedEntries: number
}
export type BoundedHistoryEntry = { entry: Record<string, unknown>; byteStart: number; byteEnd: number }

function aborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
}

// A fixed admission budget prevents repeated tab switches from queuing unlimited
// scans. Waiters are removed on abort, not just ignored when their scan completes.
type Waiter = { start: () => void; reject: (reason: unknown) => void; signal?: AbortSignal; abort: () => void }
const pools = {
  page: { active: 0, capacity: 2, queueCapacity: 8, waiting: [] as Waiter[] },
  context: { active: 0, capacity: 1, queueCapacity: 4, waiting: [] as Waiter[] },
  recovery: { active: 0, capacity: 1, queueCapacity: 2, waiting: [] as Waiter[] },
  metadata: { active: 0, capacity: 2, queueCapacity: 128, waiting: [] as Waiter[] },
}
async function acquire(signal: AbortSignal | undefined, lane: keyof typeof pools): Promise<() => void> {
  aborted(signal)
  const pool = pools[lane]
  if (pool.active >= pool.capacity) {
    if (pool.waiting.length >= pool.queueCapacity) throw new ApiError(429, 'History reader is busy; retry shortly', 'HISTORY_BUSY')
    await new Promise<void>((resolve, reject) => {
      const item: Waiter = { start: resolve, reject, signal, abort: () => {} }
      item.abort = () => {
        const index = pool.waiting.indexOf(item)
        if (index >= 0) pool.waiting.splice(index, 1)
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
      }
      pool.waiting.push(item)
      signal?.addEventListener('abort', item.abort, { once: true })
    })
  } else pool.active++
  return () => {
    const next = pool.waiting.shift()
    if (next) {
      next.signal?.removeEventListener('abort', next.abort)
      next.start()
    } else pool.active--
  }
}

export async function withHistoryReadBudget<T>(signal: AbortSignal | undefined, read: () => Promise<T>, lane: keyof typeof pools = 'page'): Promise<T> {
  const release = await acquire(signal, lane)
  try { aborted(signal); return await read() } finally { release() }
}

function decodeCursor(value: string): Cursor {
  try {
    if (value.length > 2048) throw new Error('long cursor')
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor
    if (cursor.version !== 1 || typeof cursor.dev !== 'string' || typeof cursor.ino !== 'string' || typeof cursor.mtime !== 'string' ||
      !Number.isSafeInteger(cursor.size) || cursor.size < 0 || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > cursor.size || typeof cursor.skipping !== 'boolean' || (cursor.direction !== undefined && cursor.direction !== 'older' && cursor.direction !== 'newer')) throw new Error('invalid cursor')
    if (cursor.fingerprints && !['prefix', 'tail', 'boundary'].every(key => /^[a-f0-9]{64}$/.test((cursor.fingerprints as Record<string, string>)[key] ?? ''))) throw new Error('invalid cursor fingerprints')
    return cursor
  } catch { throw ApiError.badRequest('Invalid history cursor') }
}

/** Produce a display preview without dropping a message's identity. Durable
 * replay and semantic state reducers always receive the original record. */
export function displayPreview(entry: Record<string, unknown>): Record<string, unknown> {
  let truncated = false
  let remaining = 48 * 1024
  let nodes = 2048
  const preview = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') {
      const limit = Math.max(0, Math.min(16 * 1024, remaining))
      remaining -= Math.min(value.length, limit)
      if (value.length > limit) { truncated = true; return value.slice(0, limit) + '\n… [truncated preview]' }
      return value
    }
    if (!value || typeof value !== 'object') return value
    if (--nodes < 0) { truncated = true; return '[truncated preview]' }
    if (depth > 12) { truncated = true; return '[truncated preview]' }
    if (Array.isArray(value)) {
      if (value.length > 256) truncated = true
      return value.slice(0, 256).map(item => preview(item, depth + 1))
    }
    const pairs = Object.entries(value)
    if (pairs.length > 256) truncated = true
    return Object.fromEntries(pairs.slice(0, 256).map(([key, child]) => [key,
      ['id', 'type', 'role', 'name', 'tool_use_id', 'agentId', 'backgroundTaskId', 'background_task_id'].includes(key) && typeof child === 'string' && child.length <= 4096
        ? child : preview(child, depth + 1)]))
  }
  // Structural ids and usage are independent of the potentially huge body.
  const message = entry.message as Record<string, unknown> | undefined
  const result = { ...entry, ...(entry.content !== undefined ? { content: preview(entry.content, 0) } : {}), ...(message ? { message: { ...message, content: preview(message.content, 0) } } : {}),
    ...(entry.toolUseResult !== undefined ? { toolUseResult: preview(entry.toolUseResult, 0) } : {}) }
  return truncated ? { ...result, bodyTruncated: true } : result
}

export async function readBoundedHistoryPage(filePath: string, options: { cursor?: string; limit?: number; signal?: AbortSignal; full?: boolean } = {}): Promise<{ entries: BoundedHistoryEntry[]; page: HistoryPageInfo }> {
  if (options.limit !== undefined && (!Number.isFinite(options.limit) || options.limit < 1)) throw new ApiError(400, 'History limit must be a positive finite number', 'INVALID_HISTORY_LIMIT')
  const full = options.full === true
  return withHistoryReadBudget(options.signal, async () => {
    const handle = await open(filePath, 'r')
    try {
      aborted(options.signal)
      const stat = await handle.stat({ bigint: true })
      const current = { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size), mtime: String(stat.mtimeNs) }
      const cursor: Cursor = options.cursor ? decodeCursor(options.cursor) : { version: 1, ...current, offset: current.size, skipping: false }
      if (cursor.dev !== current.dev || cursor.ino !== current.ino || current.size < cursor.size || (current.size === cursor.size && current.mtime !== cursor.mtime)) throw new ApiError(409, 'Session history changed; reload the newest page', 'HISTORY_CHANGED')
      let scannedBytes = 0
      // Hash fixed-size anchors, never the whole transcript. Anchors include the
      // original EOF and the requested boundary so truncate/regrow cannot be
      // silently accepted merely because inode is unchanged and size increased.
      const fingerprint = async (start: number): Promise<string> => {
        const bytes = Buffer.alloc(Math.min(4096, cursor.size - start))
        let read = 0
        while (read < bytes.length) {
          aborted(options.signal)
          const part = await handle.read(bytes, read, bytes.length - read, start + read)
          if (!part.bytesRead) throw new ApiError(409, 'Session history changed during validation', 'HISTORY_CHANGED')
          read += part.bytesRead
        }
        scannedBytes += read
        return createHash('sha256').update(bytes).digest('hex')
      }
      const sourceFingerprints = async () => ({ prefix: await fingerprint(0), tail: await fingerprint(Math.max(0, cursor.size - 4096)) })
      const boundaryFingerprint = (offset: number) => fingerprint(Math.max(0, Math.min(offset - 2048, cursor.size - 4096)))
      if (!cursor.fingerprints && options.cursor && current.size > cursor.size) throw new ApiError(409, 'Legacy history cursor cannot validate append; reload the newest page', 'HISTORY_CHANGED')
      const sourceAnchors = await sourceFingerprints()
      if (cursor.fingerprints && (cursor.fingerprints.prefix !== sourceAnchors.prefix || cursor.fingerprints.tail !== sourceAnchors.tail || cursor.fingerprints.boundary !== await boundaryFingerprint(cursor.offset))) throw new ApiError(409, 'Session history was rewritten; reload the newest page', 'HISTORY_CHANGED')
      const newer = cursor.direction === 'newer'
      const sourceVersion = `${cursor.dev}:${cursor.ino}:${cursor.size}:${cursor.mtime}`
      let position = cursor.offset
      let buffer = Buffer.alloc(0)
      let bufferStart = -1
      let bufferEnd = -1
      let skipping = cursor.skipping
      let omitted = 0
      let outputBytes = 0
      let renderedRows = 0
      const entries: BoundedHistoryEntry[] = []
      // The page path stops at the first UI screenful; the full path keeps
      // walking to the head of the file, bounded by record/byte/row budgets
      // instead of a page boundary. Rows default high because the byte budget
      // is the real bound for ordinary transcripts.
      const recordLimit = Math.max(1, Math.min(options.full ? Number.MAX_SAFE_INTEGER : HISTORY_PAGE_RECORDS, Math.floor(options.limit ?? (options.full ? HISTORY_FULL_ROWS : HISTORY_PAGE_RECORDS))))
      const byteBudget = options.full ? HISTORY_FULL_BYTES : HISTORY_PAGE_BYTES
      const rowBudget = options.full ? HISTORY_FULL_ROWS : HISTORY_PAGE_ROWS
      const scanBudget = options.full ? HISTORY_FULL_SCAN_BYTES : HISTORY_SCAN_BYTES
      const load = async (): Promise<boolean> => {
        // Reserve enough I/O for post-read source anchors and both outgoing
        // boundary hashes; validation is part of the same request byte budget.
        const capacity = Math.min(64 * 1024, scanBudget - 64 * 1024 - scannedBytes)
        if (capacity <= 0) return false
        const start = newer ? position : Math.max(0, position - capacity)
        const end = newer ? Math.min(cursor.size, position + capacity) : position
        if (end <= start) return false
        buffer = Buffer.allocUnsafe(end - start)
        let read = 0
        while (read < buffer.length) {
          aborted(options.signal)
          const part = await handle.read(buffer, read, buffer.length - read, start + read)
          if (!part.bytesRead) throw new ApiError(409, 'History changed during read', 'HISTORY_CHANGED')
          read += part.bytesRead
        }
        scannedBytes += read
        bufferStart = start; bufferEnd = end
        return true
      }
      while ((newer ? position < cursor.size : position > 0) && entries.length < recordLimit) {
        aborted(options.signal)
        const boundary = position
        let parts: Buffer[] = []
        let bytes = 0
        let complete = false
        let oversized = skipping
        let end = position
        let start = position
        let first = true
        while (!complete) {
          if ((!buffer.length || (newer ? position >= bufferEnd : position <= bufferStart)) && !await load()) break
          if (newer) {
            const local = position - bufferStart
            const newline = buffer.indexOf(10, local)
            const stop = newline < 0 ? buffer.length : newline
            const part = buffer.subarray(local, stop)
            bytes += part.length
            if (!oversized && bytes <= HISTORY_SEMANTIC_RECORD_BYTES) parts.push(part)
            else if (!oversized) { oversized = true; parts = [] }
            position = bufferStart + stop + (newline < 0 ? 0 : 1)
            end = bufferStart + stop
            complete = newline >= 0 || position === cursor.size
          } else {
            let local = position - bufferStart
            if (first && local > 0 && buffer[local - 1] === 10) { local--; position--; end-- }
            const newline = local > 0 ? buffer.lastIndexOf(10, local - 1) : -1
            const stop = newline + 1
            const part = buffer.subarray(stop, local)
            bytes += part.length
            if (!oversized && bytes <= HISTORY_SEMANTIC_RECORD_BYTES) parts.push(part)
            else if (!oversized) { oversized = true; parts = [] }
            position = bufferStart + stop
            start = position
            complete = newline >= 0 || position === 0
          }
          first = false
        }
        if (!complete) {
          if (oversized) { if (!skipping) omitted++; skipping = true }
          else position = boundary
          break
        }
        if (oversized) { if (!skipping) omitted++; skipping = false; continue }
        if (!bytes) continue
        const raw = parts.length === 1 ? parts[0]! : Buffer.concat(newer ? parts : parts.reverse(), bytes)
        let entry: Record<string, unknown>
        try { entry = JSON.parse(raw.toString('utf8')) } catch { omitted++; continue }
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
        // Page whole records instead of shortening display fields. Image data,
        // tool inputs and trailing reference envelopes must remain parseable.
        // A record above the ordinary page budget owns its page; the reader's
        // semantic record and scan limits still bound memory and I/O.
        const entryBytes = Buffer.byteLength(JSON.stringify(entry))
        const content = (entry.message as { content?: unknown } | undefined)?.content
        // Each assistant block/tool result may become a separate UI row. Stop
        // before the complete record instead of clipping rows behind a cursor.
        const rowCost = Array.isArray(content) ? Math.max(1, content.length) : 1
        if ((outputBytes + entryBytes > byteBudget || renderedRows + rowCost > rowBudget) && entries.length) { position = boundary; break }
        renderedRows += rowCost
        entries.push({ entry, byteStart: newer ? boundary : start, byteEnd: end })
        outputBytes += entryBytes
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      const after = await handle.stat({ bigint: true })
      if (after.ino !== stat.ino || after.size < stat.size || (after.size === stat.size && after.mtimeNs !== stat.mtimeNs)) throw new ApiError(409, 'Session history changed during read', 'HISTORY_CHANGED')
      const lower = newer ? cursor.offset : position
      const upper = newer ? position : cursor.offset
      const afterAnchors = await sourceFingerprints()
      if (sourceAnchors.prefix !== afterAnchors.prefix || sourceAnchors.tail !== afterAnchors.tail) throw new ApiError(409, 'Session history was rewritten during read', 'HISTORY_CHANGED')
      const encode = async (offset: number, direction: 'older' | 'newer', continuation = false) => Buffer.from(JSON.stringify({ ...cursor, offset, direction, skipping: continuation, fingerprints: { ...sourceAnchors, boundary: await boundaryFingerprint(offset) } })).toString('base64url')
      const nextCursor = lower > 0 ? await encode(lower, 'older', !newer && skipping) : null
      const previousCursor = upper < cursor.size ? await encode(upper, 'newer', newer && skipping) : null
      const contentTruncated = entries.some(item => item.entry.bodyTruncated === true)
      return { entries: newer ? entries : entries.reverse(), page: {
        nextCursor, previousCursor,
        hasMore: lower > 0, historyComplete: lower === 0 && upper === cursor.size && omitted === 0 && !contentTruncated,
        ...(contentTruncated ? { contentTruncated: true } : {}),
        sourceVersion, scannedBytes, omittedOversizedEntries: omitted,
      } }
    } finally { await handle.close() }
  })
}

/** Forward reducer source: never retain an unbounded JSONL line or source file. */
export async function streamBoundedHistory(filePath: string, onEntry: (entry: Record<string, unknown>, completeLine: boolean, byteStart: number) => void, signal?: AbortSignal, options: { startOffset?: number; endOffset?: number; onSkipped?: () => void; maxRecordBytes?: number } = {}): Promise<{ sourceVersion: string; omittedRecords: number; oversizedRecords: number; scannedBytes: number; nextOffset: number }> {
  const handle = await open(filePath, 'r')
  try {
    const stat = await handle.stat({ bigint: true })
    const size = Math.min(Number(stat.size), options.endOffset ?? Number(stat.size))
    const firstOffset = options.startOffset ?? 0
    let lineStart = firstOffset
    let nextOffset = firstOffset
    const chunk = Buffer.allocUnsafe(64 * 1024)
    let parts: Buffer[] = []
    let length = 0
    let skipping = false
    let omittedRecords = 0
    let oversizedRecords = 0
    const flush = (completeLine = true) => {
      if (skipping) { omittedRecords++; oversizedRecords++; options.onSkipped?.() }
      else if (length) {
        let entry: unknown
        try {
          entry = JSON.parse((parts.length === 1 ? parts[0]! : Buffer.concat(parts, length)).toString('utf8'))
        } catch { omittedRecords++; options.onSkipped?.() }
        // Consumer failures (limits, cancellation, I/O) must propagate. They
        // are not malformed JSON and must never become a successful snapshot.
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) onEntry(entry as Record<string, unknown>, completeLine, lineStart)
      }
      parts = []; length = 0; skipping = false
    }
    for (let offset = firstOffset; offset < size;) {
      aborted(signal)
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - offset), offset)
      if (!bytesRead) throw new ApiError(409, 'Session history changed during recovery', 'HISTORY_CHANGED')
      offset += bytesRead
      let start = 0
      while (start < bytesRead) {
        aborted(signal)
        const found = chunk.indexOf(10, start)
        const end = found >= 0 && found < bytesRead ? found : bytesRead
        if (!skipping) {
          length += end - start
          if (length > (options.maxRecordBytes ?? HISTORY_RECORD_BYTES)) { skipping = true; parts = [] }
          else parts.push(Buffer.from(chunk.subarray(start, end)))
        }
        start = end + 1
        if (end < bytesRead) {
          flush()
          lineStart = offset - bytesRead + end + 1
          nextOffset = lineStart
          await new Promise<void>(resolve => setImmediate(resolve))
        }
      }
    }
    if (length || skipping) flush(false)
    const after = await handle.stat({ bigint: true })
    if (after.size < stat.size || (after.size === stat.size && after.mtimeNs !== stat.mtimeNs)) throw new ApiError(409, 'Session changed during recovery; retry', 'HISTORY_CHANGED')
    return { sourceVersion: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`, omittedRecords, oversizedRecords, scannedBytes: size - firstOffset, nextOffset }
  } finally { await handle.close() }
}
