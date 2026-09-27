import { open, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { withHistoryReadBudget } from './boundedSessionHistory.js'
import type { MessageEntry } from './sessionService.js'

const MAX_RECORD_BYTES = 1024 * 1024
const MAX_PROJECTION_BYTES = 3 * 1024 * 1024
const MAX_PROJECTION_ENTRIES = 10_000
const WINDOW_BYTES = 4096
const TEAM_TOOLS = new Set(['TeamCreate', 'TeamDelete', 'Agent', 'TaskCreate', 'TaskUpdate', 'TaskList', 'SendMessage'])
type Projection = {
  messages: MessageEntry[]
  complete: boolean
  sourceVersion: string
  readBytes: number
}
type CachedProjection = Projection & {
  completeRecords: boolean
  teamSeen: boolean
  identity: string
  size: number
  mtime: string
  indexedBytes: number
  firstHash: string
  boundaryHash: string
  bytes: number
  toolIds: Set<string>
}
const cache = new Map<string, CachedProjection>()
const pending = new Map<string, Promise<Projection>>()

/** A bounded, incremental source for legacy Team migration and terminal replay. */
export async function readTeamTranscriptProjection(filePath: string): Promise<Projection> {
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
      if (result.bytesRead !== length) throw new Error('Team transcript changed during projection')
      return createHash('sha256').update(bytes).digest('hex')
    }
    const canAppend = previous?.identity === identity && size > previous.size &&
      await windowHash(Math.min(WINDOW_BYTES, previous.size)) === previous.firstHash &&
      await windowHash(previous.indexedBytes) === previous.boundaryHash
    const state: CachedProjection = {
      messages: canAppend ? [...previous.messages] : [],
      toolIds: new Set(canAppend ? previous.toolIds : []),
      complete: canAppend ? previous.completeRecords : true,
      completeRecords: canAppend ? previous.completeRecords : true,
      teamSeen: canAppend ? previous.teamSeen : false,
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
      if (!bytesRead) throw new Error('Team transcript changed during projection')
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
            if (entry && typeof entry === 'object') collectTeamEvidence(entry as Record<string, unknown>, state)
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
      throw new Error('Team transcript changed during projection')
    }
    state.firstHash = await windowHash(Math.min(WINDOW_BYTES, size))
    state.boundaryHash = await windowHash(state.indexedBytes)
    cache.delete(filePath)
    cache.set(filePath, state)
    while (cache.size > 4) cache.delete(cache.keys().next().value!)
    return state
  } finally { await handle.close() }
}

function collectTeamEvidence(entry: Record<string, unknown>, state: CachedProjection) {
  if (state.bytes >= MAX_PROJECTION_BYTES || state.messages.length >= MAX_PROJECTION_ENTRIES) { state.complete = false; return }
  const raw = entry.message as { role?: string; content?: unknown } | undefined
  if (!raw || typeof raw !== 'object') return
  const blocks = Array.isArray(raw.content) ? raw.content : []
  if (blocks.some(block => block?.type === 'tool_use' && block.name === 'TeamCreate')) state.teamSeen = true
  const tools = blocks.filter((block): block is Record<string, unknown> => Boolean(block && typeof block === 'object' && block.type === 'tool_use' && state.teamSeen && TEAM_TOOLS.has(block.name)))
  for (const block of tools) if (typeof block.id === 'string') state.toolIds.add(block.id)
  const results = blocks.filter((block): block is Record<string, unknown> => Boolean(block && typeof block === 'object' && block.type === 'tool_result' && state.toolIds.has(block.tool_use_id)))
  const text = typeof raw.content === 'string' ? raw.content : blocks.filter(block => block?.type === 'text').map(block => block.text ?? '').join('\n')
  const teammate = raw.role === 'user' && text.includes('<teammate-message')
  const content = tools.length ? tools : results.length ? results : teammate ? raw.content : undefined
  if (content === undefined) return
  const message: MessageEntry = {
    id: typeof entry.uuid === 'string' ? entry.uuid : `team:${state.indexedBytes}:${state.messages.length}`,
    type: tools.length ? 'tool_use' : results.length ? 'tool_result' : 'user',
    content,
    timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : new Date(0).toISOString(),
    ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}),
    ...(entry.toolUseResult !== undefined ? { toolUseResult: entry.toolUseResult } : {}),
    ...(typeof entry.parent_tool_use_id === 'string' ? { parentToolUseId: entry.parent_tool_use_id } : {}),
  }
  const bytes = Buffer.byteLength(JSON.stringify(message))
  if (state.bytes + bytes > MAX_PROJECTION_BYTES) { state.complete = false; state.bytes = MAX_PROJECTION_BYTES; return }
  state.bytes += bytes
  state.messages.push(message)
}
