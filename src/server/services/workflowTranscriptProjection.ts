import { open, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { withHistoryReadBudget } from './boundedSessionHistory.js'

const MAX_RECORD_BYTES = 1024 * 1024
const MAX_PROJECTION_BYTES = 3 * 1024 * 1024
const MAX_PROJECTION_ENTRIES = 10_000
const WINDOW_BYTES = 4096
type Projection = {
  messages: Record<string, unknown>[]
  complete: boolean
  sourceVersion: string
  readBytes: number
}
type CachedProjection = Projection & {
  completeRecords: boolean
  identity: string
  size: number
  mtime: string
  indexedBytes: number
  firstHash: string
  boundaryHash: string
  bytes: number
}
const cache = new Map<string, CachedProjection>()
const pending = new Map<string, Promise<Projection>>()

/** A bounded, incremental source for workflow lifecycle reconstruction. */
export async function readWorkflowTranscriptProjection(filePath: string): Promise<Projection> {
  const existing = pending.get(filePath)
  if (existing) return existing
  const operation = withHistoryReadBudget(undefined, () => readProjection(filePath), 'metadata')
  pending.set(filePath, operation)
  try { return await operation } finally { if (pending.get(filePath) === operation) pending.delete(filePath) }
}

async function readProjection(filePath: string): Promise<Projection> {
  const handle = await open(filePath, 'r')
  try {
    const before = await handle.stat({ bigint: true })
    const size = Number(before.size)
    const identity = `${before.dev}:${before.ino}`
    const mtime = String(before.mtimeNs)
    const previous = cache.get(filePath)
    if (previous?.identity === identity && previous.size === size && previous.mtime === mtime) {
      cache.delete(filePath)
      cache.set(filePath, previous)
      return { ...previous, readBytes: 0 }
    }
    async function windowHash(end: number) {
      const length = Math.min(WINDOW_BYTES, end)
      const bytes = Buffer.alloc(length)
      const result = await handle.read(bytes, 0, length, end - length)
      if (result.bytesRead !== length) throw new Error('Workflow transcript changed during projection')
      return createHash('sha256').update(bytes).digest('hex')
    }
    const canAppend = previous?.identity === identity && size > previous.size &&
      await windowHash(Math.min(WINDOW_BYTES, previous.size)) === previous.firstHash &&
      await windowHash(previous.indexedBytes) === previous.boundaryHash
    const state: CachedProjection = {
      messages: canAppend ? [...previous.messages] : [],
      complete: canAppend ? previous.completeRecords : true,
      completeRecords: canAppend ? previous.completeRecords : true,
      bytes: canAppend ? previous.bytes : 0,
      indexedBytes: canAppend ? previous.indexedBytes : 0,
      sourceVersion: `${identity}:${size}:${mtime}`,
      identity, size, mtime, firstHash: '', boundaryHash: '', readBytes: 0,
    }
    let position = state.indexedBytes
    let parts: Buffer[] = []
    let lineBytes = 0
    let skipping = false
    const chunk = Buffer.allocUnsafe(128 * 1024)
    while (position < size) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - position), position)
      if (!bytesRead) throw new Error('Workflow transcript changed during projection')
      state.readBytes += bytesRead
      let start = 0
      while (start < bytesRead) {
        const newline = chunk.indexOf(10, start)
        const end = newline >= 0 && newline < bytesRead ? newline : bytesRead
        lineBytes += end - start
        if (lineBytes > MAX_RECORD_BYTES) { skipping = true; parts = [] }
        if (!skipping) parts.push(Buffer.from(chunk.subarray(start, end)))
        if (end < bytesRead) {
          if (skipping) state.complete = false
          else if (lineBytes) {
            let entry: unknown
            try { entry = JSON.parse(Buffer.concat(parts, lineBytes).toString('utf8')) } catch { state.complete = false }
            if (entry && typeof entry === 'object') collectWorkflowEvidence(entry as Record<string, unknown>, state)
          }
          state.indexedBytes = position + end + 1
          parts = []; lineBytes = 0; skipping = false
        }
        start = end + 1
      }
      position += bytesRead
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    // A partial tail is retried from its start on the next append.
    state.completeRecords = state.complete
    if (lineBytes) state.complete = false
    const after = await handle.stat({ bigint: true })
    const current = await stat(filePath, { bigint: true })
    if (after.dev !== before.dev || after.ino !== before.ino || current.dev !== before.dev || current.ino !== before.ino ||
      after.size < before.size || current.size < before.size ||
      (after.size === before.size && after.mtimeNs !== before.mtimeNs) ||
      (current.size === before.size && current.mtimeNs !== before.mtimeNs)) {
      throw new Error('Workflow transcript changed during projection')
    }
    state.firstHash = await windowHash(Math.min(WINDOW_BYTES, size))
    state.boundaryHash = await windowHash(state.indexedBytes)
    cache.delete(filePath)
    cache.set(filePath, state)
    while (cache.size > 4) cache.delete(cache.keys().next().value!)
    return state
  } finally { await handle.close() }
}

function collectWorkflowEvidence(entry: Record<string, unknown>, state: CachedProjection) {
  // Parse only bounded records; retain lifecycle evidence, never conversation bodies.
  // The existing service remains the structured interpreter for these candidates.
  const pending: unknown[] = [entry]
  let relevant = entry.type === 'cc-haha-task-notification'
  let nodes = 0
  while (pending.length && !relevant && nodes++ < 16_384) {
    const value = pending.pop()
    if (typeof value === 'string') {
      relevant = value.includes('<task-notification>') || value.includes('local_workflow') || value.includes('async_launched')
    } else if (value && typeof value === 'object') {
      for (const nested of Object.values(value)) pending.push(nested)
    }
  }
  if (pending.length && !relevant) state.complete = false
  if (!relevant) return
  const bytes = Buffer.byteLength(JSON.stringify(entry))
  if (state.bytes + bytes > MAX_PROJECTION_BYTES || state.messages.length >= MAX_PROJECTION_ENTRIES) {
    state.complete = false
    return
  }
  state.bytes += bytes
  state.messages.push(entry)
}
