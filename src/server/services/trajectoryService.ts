/**
 * Trajectory (轨迹) read model: bounded pages of projected transcript rows,
 * live appends, per-row detail by byte locator, and prompt snapshot rows from
 * the `prompt-snapshots.jsonl` sidecar.
 *
 * Every read is bounded and admitted through `withHistoryReadBudget`; nothing
 * here returns a whole transcript or inlines a subagent transcript, and the
 * chat `/messages` projection is never consulted.
 */

import { createHash } from 'node:crypto'
import { open, type FileHandle } from 'node:fs/promises'
import * as path from 'node:path'
import { ApiError } from '../middleware/errorHandler.js'
import {
  HISTORY_OVERSIZED_HEAD_BYTES,
  HISTORY_SEMANTIC_RECORD_BYTES,
  readBoundedHistoryPage,
  withHistoryReadBudget,
  type OversizedHistoryRecord,
} from './boundedSessionHistory.js'
import { sessionService } from './sessionService.js'
import {
  isProjectionSkipped,
  isRealUserPrompt,
  oversizedProjectionEntry,
  projectTrajectoryRows,
  SESSION_MESSAGE_META_MARKER,
  START_TS_LOOKBACK,
  type ProjectionEntry,
} from './trajectoryProjection.js'
import type {
  TrajectoryPage,
  TrajectoryRow,
  TrajectoryRowDetail,
  TrajectorySnapshotBlob,
  TrajectorySnapshotChange,
} from './trajectoryTypes.js'

/** Wider than the chat page: ledger rows are compact. */
export const TRAJECTORY_PAGE_BUDGET = { records: 1000, bytes: 2 * 1024 * 1024, rows: 2000 }
/** An `after` read beyond this many new bytes answers 409 so the client reloads the tail. */
export const TRAJECTORY_APPEND_MAX_BYTES = 4 * 1024 * 1024
export const TRAJECTORY_DETAIL_MAX_RANGES = 64
export const TRAJECTORY_DETAIL_MAX_BYTES = 8 * 1024 * 1024
export const TRAJECTORY_DETAIL_STRING_CHARS = 256 * 1024
export const TRAJECTORY_DETAIL_TOTAL_CHARS = 4 * 1024 * 1024
/** The turn index gives up (turnBase null → relative turns) past this scan. */
export const TURN_INDEX_MAX_SCAN_BYTES = 256 * 1024 * 1024
/** Backward read for the timestamps of records right before a page or append. */
export const PRECEDING_SCAN_BYTES = 256 * 1024
/** Strings count at most this many chars toward a trajectory page's byte budget. */
export const TRAJECTORY_COST_STRING_CHARS = 2048
const TRAJECTORY_COST_NODES = 20_000
const TURN_CHECKPOINT_PROMPTS = 256
const TURN_CHECKPOINT_BYTES = 4 * 1024 * 1024
const ANCHOR_BYTES = 4096
const CACHE_FILES = 8
const SNAPSHOT_ROWS_PER_SCOPE = 2000
const SNAPSHOT_BLOB_RE = /^[0-9a-f]{16}$/
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const ROW_ID_RE = /^([ucmat]):(.{1,1024})$/s

/**
 * Prompt snapshot markers that represent the conversation's own requests.
 * `repl_main_thread[:outputStyle:*]` is the interactive main loop, `sdk` is
 * the headless/stream-json main loop the desktop app drives (QueryEngine),
 * `agent:*` are subagent loops, and an absent querySource is treated as main.
 * Every other source (compact, title/summary generation, prompt suggestion,
 * classifiers, hook agents, side questions, ...) is a side query and would
 * otherwise flap the system prompt / tool rows.
 */
export function isConversationQuerySource(qs: unknown): boolean {
  if (qs === undefined || qs === null) return true
  if (typeof qs !== 'string') return false
  return qs === 'sdk' || qs === 'repl_main_thread' || qs.startsWith('repl_main_thread:') || qs.startsWith('agent:')
}

function aborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
}

function changed(message: string, code = 'HISTORY_CHANGED'): ApiError {
  return new ApiError(409, message, code)
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readExact(handle: FileHandle, start: number, length: number, signal?: AbortSignal): Promise<Buffer> {
  const buffer = Buffer.alloc(Math.max(0, length))
  let read = 0
  while (read < buffer.length) {
    aborted(signal)
    const part = await handle.read(buffer, read, buffer.length - read, start + read)
    if (!part.bytesRead) throw changed('Trajectory source changed during read')
    read += part.bytesRead
  }
  return buffer
}

async function hashRange(handle: FileHandle, start: number, end: number, signal?: AbortSignal): Promise<string> {
  return sha256(await readExact(handle, start, end - start, signal))
}

function isMissing(error: unknown): boolean {
  return Boolean(error) && typeof error === 'object' && (error as { code?: string }).code === 'ENOENT'
}

/**
 * Forward line scanner over `[start, end)` with exact byte offsets. Lines
 * above `maxRecordBytes` are reported with `bytes: null` and never retained.
 * A trailing line without a newline is not reported; the return value is the
 * offset right after the last complete line.
 */
export async function scanLines(
  handle: FileHandle,
  start: number,
  end: number,
  onLine: (lineStart: number, lineEnd: number, bytes: Buffer | null, head?: Buffer) => void,
  signal?: AbortSignal,
  maxRecordBytes = HISTORY_SEMANTIC_RECORD_BYTES,
  /** When > 0, an oversized line also reports its first `headBytes` bytes. */
  headBytes = 0,
): Promise<number> {
  const chunk = Buffer.allocUnsafe(256 * 1024)
  let parts: Buffer[] = []
  let length = 0
  let oversized = false
  let head: Buffer | undefined
  let lineStart = start
  for (let offset = start; offset < end;) {
    aborted(signal)
    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, end - offset), offset)
    if (!bytesRead) throw changed('Trajectory source changed during read')
    let local = 0
    while (local < bytesRead) {
      const newline = chunk.indexOf(10, local)
      const stop = newline >= 0 && newline < bytesRead ? newline : bytesRead
      if (!oversized) {
        length += stop - local
        if (length > maxRecordBytes) {
          if (headBytes > 0) {
            // Copy only the leading parts; `chunk` is reused by the next read.
            const leading: Buffer[] = []
            let taken = 0
            for (const part of [...parts, chunk.subarray(local, stop)]) {
              if (taken >= headBytes) break
              leading.push(part)
              taken += part.length
            }
            head = Buffer.concat(leading).subarray(0, headBytes)
          }
          oversized = true; parts = []
        } else if (stop > local) parts.push(Buffer.from(chunk.subarray(local, stop)))
      }
      if (stop === bytesRead) break
      const lineEnd = offset + stop
      onLine(lineStart, lineEnd, oversized ? null : parts.length === 1 ? parts[0]! : Buffer.concat(parts, length), oversized ? head : undefined)
      parts = []; length = 0; oversized = false; head = undefined
      lineStart = lineEnd + 1
      local = stop + 1
    }
    offset += bytesRead
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  return lineStart
}

function parseObject(bytes: Buffer): Record<string, unknown> | null {
  try {
    const value = JSON.parse(bytes.toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch { return null }
}

class Lru<V> {
  private map = new Map<string, V>()
  constructor(private capacity: number) {}
  get(key: string): V | undefined {
    const value = this.map.get(key)
    if (value !== undefined) { this.map.delete(key); this.map.set(key, value) }
    return value
  }
  set(key: string, value: V) {
    this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value!)
  }
  delete(key: string) { this.map.delete(key) }
  clear() { this.map.clear() }
}

/** Serialize index refreshes per file so concurrent requests never interleave mutations. */
const locks = new Map<string, Promise<unknown>>()
async function withFileLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(run)
  locks.set(key, next)
  try { return await next } finally { if (locks.get(key) === next) locks.delete(key) }
}

// ---------------------------------------------------------------------------
// Turn index
// ---------------------------------------------------------------------------

type TurnIndex = {
  dev: string
  ino: string
  /** Offset right after the last complete line scanned. */
  scannedTo: number
  prefixLength: number
  prefixHash: string
  boundaryHash: string
  total: number
  /** `[lineStartOffset, promptsBefore]`, ascending; always starts with [0, 0]. */
  checkpoints: Array<[number, number]>
  tooLarge?: boolean
}

const turnIndexes = new Lru<TurnIndex>(CACHE_FILES)
const USER_TYPE_MARKER = Buffer.from('"type":"user"')
const META_MARKER = Buffer.from('"isMeta":true')
const SESSION_MESSAGE_MARKER = Buffer.from(SESSION_MESSAGE_META_MARKER)

function lineIsPrompt(bytes: Buffer | null, skipSidechain: boolean): boolean {
  // Transcript lines are compact JSON.stringify output, so the prefilter can
  // match exact key/value spellings before paying for a parse. Meta records
  // are never prompts except a delivered session message.
  if (!bytes || !bytes.includes(USER_TYPE_MARKER) || (bytes.includes(META_MARKER) && !bytes.includes(SESSION_MESSAGE_MARKER))) return false
  const entry = parseObject(bytes)
  return Boolean(entry) && !isProjectionSkipped(entry!, skipSidechain) && isRealUserPrompt(entry!)
}

async function countPrompts(handle: FileHandle, start: number, end: number, skipSidechain: boolean, signal?: AbortSignal): Promise<number> {
  let count = 0
  await scanLines(handle, start, end, (_s, _e, bytes) => { if (lineIsPrompt(bytes, skipSidechain)) count++ }, signal)
  return count
}

async function refreshTurnIndex(filePath: string, skipSidechain: boolean, signal?: AbortSignal): Promise<TurnIndex | null> {
  const key = `${skipSidechain ? 'main' : 'side'}\0${filePath}`
  return withFileLock(key, async () => {
    const handle = await open(filePath, 'r')
    try {
      const stat = await handle.stat({ bigint: true })
      const dev = String(stat.dev)
      const ino = String(stat.ino)
      const size = Number(stat.size)
      let index = turnIndexes.get(key)
      if (index) {
        const valid = index.dev === dev && index.ino === ino && size >= index.scannedTo &&
          await hashRange(handle, 0, index.prefixLength, signal) === index.prefixHash &&
          await hashRange(handle, Math.max(0, index.scannedTo - ANCHOR_BYTES), index.scannedTo, signal) === index.boundaryHash
        if (!valid) { turnIndexes.delete(key); index = undefined }
      }
      if (index?.tooLarge) return null
      const base: TurnIndex = index ?? { dev, ino, scannedTo: 0, prefixLength: 0, prefixHash: '', boundaryHash: '', total: 0, checkpoints: [[0, 0]] }
      if (size - base.scannedTo > TURN_INDEX_MAX_SCAN_BYTES) {
        turnIndexes.set(key, { ...base, tooLarge: true })
        return null
      }
      if (size > base.scannedTo) {
        // Work on a copy; only a completed scan replaces the cached index.
        const next: TurnIndex = { ...base, checkpoints: [...base.checkpoints] }
        let [lastCheckpointOffset, lastCheckpointTotal] = next.checkpoints[next.checkpoints.length - 1]!
        next.scannedTo = await scanLines(handle, base.scannedTo, size, (lineStart, _end, bytes) => {
          if (next.total - lastCheckpointTotal >= TURN_CHECKPOINT_PROMPTS || lineStart - lastCheckpointOffset >= TURN_CHECKPOINT_BYTES) {
            next.checkpoints.push([lineStart, next.total])
            lastCheckpointOffset = lineStart; lastCheckpointTotal = next.total
          }
          if (lineIsPrompt(bytes, skipSidechain)) next.total++
        }, signal)
        next.prefixLength = Math.min(ANCHOR_BYTES, next.scannedTo)
        next.prefixHash = await hashRange(handle, 0, next.prefixLength, signal)
        next.boundaryHash = await hashRange(handle, Math.max(0, next.scannedTo - ANCHOR_BYTES), next.scannedTo, signal)
        index = next
        turnIndexes.set(key, next)
      } else if (!index) {
        index = { ...base, prefixHash: sha256(Buffer.alloc(0)), boundaryHash: sha256(Buffer.alloc(0)) }
        turnIndexes.set(key, index)
      }
      return index
    } finally { await handle.close() }
  })
}

/**
 * Number of real user prompts in `[0, byteOffset)`; `byteOffset` must be a
 * line start. Null when the file is too large to index within budget.
 */
export async function turnsBefore(filePath: string, byteOffset: number, signal?: AbortSignal, options: { skipSidechain?: boolean } = {}): Promise<number | null> {
  const skipSidechain = options.skipSidechain ?? true
  return withHistoryReadBudget(signal, async () => {
    const index = await refreshTurnIndex(filePath, skipSidechain, signal)
    if (!index) return null
    const handle = await open(filePath, 'r')
    try {
      if (byteOffset >= index.scannedTo) {
        return index.total + (byteOffset > index.scannedTo ? await countPrompts(handle, index.scannedTo, byteOffset, skipSidechain, signal) : 0)
      }
      let low = 0
      let high = index.checkpoints.length - 1
      while (low < high) {
        const mid = (low + high + 1) >> 1
        if (index.checkpoints[mid]![0] <= byteOffset) low = mid
        else high = mid - 1
      }
      const [offset, before] = index.checkpoints[low]!
      return before + await countPrompts(handle, offset, byteOffset, skipSidechain, signal)
    } finally { await handle.close() }
  }, 'metadata')
}

export function resetTrajectoryCachesForTests() {
  turnIndexes.clear()
  snapshotIndexes.clear()
}

// ---------------------------------------------------------------------------
// Prompt snapshot sidecar
// ---------------------------------------------------------------------------

type ScopeState = {
  markers: number
  sys?: string
  tools?: string
  ctx?: string
  rows: TrajectoryRow[]
}

type SnapshotIndex = {
  dev: string
  ino: string
  scannedTo: number
  prefixLength: number
  prefixHash: string
  boundaryHash: string
  blobs: Map<string, { kind: 'sys' | 'tools' | 'ctx'; start: number; end: number }>
  scopes: Map<string, ScopeState>
}

const snapshotIndexes = new Lru<SnapshotIndex>(CACHE_FILES)
const BLOB_HEAD_RE = /^\{"t":"blob","k":"(sys|tools|ctx)","h":"([0-9a-f]{16})"/

function normalizeScope(scope: string): string {
  return scope.startsWith('agent-') ? scope.slice('agent-'.length) : scope
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function applySnapshotLine(index: SnapshotIndex, lineStart: number, lineEnd: number, bytes: Buffer | null) {
  if (!bytes) return
  // Blob bodies can be large; their identity sits at the head of the line.
  const head = BLOB_HEAD_RE.exec(bytes.subarray(0, 128).toString('utf8'))
  let record: Record<string, unknown> | null = null
  if (!head) {
    record = parseObject(bytes)
    if (!record) return
  }
  const type = head ? 'blob' : record!.t
  if (type === 'blob') {
    const kind = head ? head[1] : record!.k
    const hash = head ? head[2] : record!.h
    if ((kind === 'sys' || kind === 'tools' || kind === 'ctx') && typeof hash === 'string' && SNAPSHOT_BLOB_RE.test(hash) && !index.blobs.has(hash)) {
      index.blobs.set(hash, { kind, start: lineStart, end: lineEnd })
    }
    return
  }
  if (type !== 'req' && type !== 'ctx') return
  const scope = normalizeScope(str(record!.scope) ?? 'main')
  let state = index.scopes.get(scope)
  if (!state) { state = { markers: 0, rows: [] }; index.scopes.set(scope, state) }
  const markerIndex = state.markers++
  const ts = str(record!.ts) ?? ''
  const base = { id: `s:${scope}:${markerIndex}`, turn: null, ts, loc: [] } as const
  let row: TrajectoryRow | null = null
  if (type === 'req') {
    if (!isConversationQuerySource(record!.qs)) return
    const sys = str(record!.sys)
    const tools = str(record!.tools)
    if (!sys && !tools) return
    let change: TrajectorySnapshotChange | null
    if (state.sys === undefined && state.tools === undefined) change = 'initial'
    else {
      const sysChanged = sys !== state.sys
      const toolsChanged = tools !== state.tools
      change = sysChanged && toolsChanged ? 'system+tools' : sysChanged ? 'system' : toolsChanged ? 'tools' : null
    }
    if (change) {
      const toolCount = typeof record!.toolCount === 'number' ? record!.toolCount : undefined
      const sysChars = typeof record!.sysChars === 'number' ? record!.sysChars : undefined
      const counts = [sysChars !== undefined ? `${sysChars.toLocaleString('en-US')} chars` : '', toolCount !== undefined ? `${toolCount} tools` : ''].filter(Boolean).join(', ')
      row = {
        ...base, loc: [], kind: 'system', label: change,
        preview: `${change === 'tools' ? 'tools' : 'system prompt'}${counts ? ` (${counts})` : ''}`,
        snapshot: {
          scope, change,
          ...(sys ? { sys } : {}), ...(tools ? { tools } : {}),
          ...(change !== 'initial' && state.sys ? { prevSys: state.sys } : {}),
          ...(change !== 'initial' && state.tools ? { prevTools: state.tools } : {}),
          ...(str(record!.qs) ? { querySource: str(record!.qs) } : {}),
          ...(str(record!.model) ? { model: str(record!.model) } : {}),
          ...(toolCount !== undefined ? { toolCount } : {}),
          ...(sysChars !== undefined ? { sysChars } : {}),
        },
      }
    }
    state.sys = sys
    state.tools = tools
  } else {
    const ctx = str(record!.ctx)
    if (!ctx || ctx === state.ctx) return
    row = {
      ...base, loc: [], kind: 'context', label: 'user_context', preview: 'user context',
      snapshot: { scope, change: 'context', ctx, ...(state.ctx ? { prevCtx: state.ctx } : {}) },
    }
    state.ctx = ctx
  }
  if (row) {
    state.rows.push(row)
    if (state.rows.length > SNAPSHOT_ROWS_PER_SCOPE) state.rows.splice(0, state.rows.length - SNAPSHOT_ROWS_PER_SCOPE)
  }
}

function cloneSnapshotIndex(index: SnapshotIndex): SnapshotIndex {
  return {
    ...index,
    blobs: new Map(index.blobs),
    scopes: new Map([...index.scopes].map(([scope, state]) => [scope, { ...state, rows: [...state.rows] }])),
  }
}

async function loadSnapshotIndex(sidecarPath: string, signal?: AbortSignal): Promise<SnapshotIndex | null> {
  return withFileLock(`snap\0${sidecarPath}`, async () => {
    let handle: FileHandle
    try { handle = await open(sidecarPath, 'r') } catch (error) {
      if (isMissing(error)) { snapshotIndexes.delete(sidecarPath); return null }
      throw error
    }
    try {
      const stat = await handle.stat({ bigint: true })
      const dev = String(stat.dev)
      const ino = String(stat.ino)
      const size = Number(stat.size)
      let index = snapshotIndexes.get(sidecarPath)
      if (index) {
        const valid = index.dev === dev && index.ino === ino && size >= index.scannedTo &&
          await hashRange(handle, 0, index.prefixLength, signal) === index.prefixHash &&
          await hashRange(handle, Math.max(0, index.scannedTo - ANCHOR_BYTES), index.scannedTo, signal) === index.boundaryHash
        if (!valid) index = undefined
      }
      if (index && size === index.scannedTo) return index
      const next = index ? cloneSnapshotIndex(index) : {
        dev, ino, scannedTo: 0, prefixLength: 0, prefixHash: '', boundaryHash: '', blobs: new Map(), scopes: new Map(),
      } satisfies SnapshotIndex
      next.scannedTo = await scanLines(handle, next.scannedTo, size, (start, end, bytes) => applySnapshotLine(next, start, end, bytes), signal)
      next.prefixLength = Math.min(ANCHOR_BYTES, next.scannedTo)
      next.prefixHash = await hashRange(handle, 0, next.prefixLength, signal)
      next.boundaryHash = await hashRange(handle, Math.max(0, next.scannedTo - ANCHOR_BYTES), next.scannedTo, signal)
      snapshotIndexes.set(sidecarPath, next)
      return next
    } finally { await handle.close() }
  })
}

async function snapshotRows(sidecarPath: string, scope: string, signal?: AbortSignal): Promise<TrajectoryRow[]> {
  const index = await withHistoryReadBudget(signal, () => loadSnapshotIndex(sidecarPath, signal), 'metadata')
  return index?.scopes.get(scope)?.rows.map(row => ({ ...row, loc: [] })) ?? []
}

// ---------------------------------------------------------------------------
// Source resolution and tokens
// ---------------------------------------------------------------------------

type Source = { filePath: string; sidecarPath: string; scope: string; skipSidechain: boolean }

export function parseAgentIdParam(value: string | null): string | undefined {
  if (value === null || value === '') return undefined
  const id = value.startsWith('agent-') ? value.slice('agent-'.length) : value
  if (!AGENT_ID_RE.test(id)) throw ApiError.badRequest('Invalid agentId')
  return id
}

async function resolveSource(sessionId: string, agentId: string | undefined): Promise<Source> {
  const found = await sessionService.findSessionFile(sessionId)
  if (!found) throw ApiError.notFound(`Session not found: ${sessionId}`)
  const sessionDir = path.join(path.dirname(found.filePath), sessionId)
  return {
    filePath: agentId ? path.join(sessionDir, 'subagents', `agent-${agentId}.jsonl`) : found.filePath,
    sidecarPath: path.join(sessionDir, 'prompt-snapshots.jsonl'),
    scope: agentId ?? 'main',
    skipSidechain: !agentId,
  }
}

type TailToken = { v: 1; dev: string; ino: string; offset: number; prefix: string; boundary: string }

function decodeTailToken(value: string): TailToken {
  try {
    if (value.length > 1024) throw new Error('long token')
    const token = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as TailToken
    if (token.v !== 1 || typeof token.dev !== 'string' || typeof token.ino !== 'string' || !Number.isSafeInteger(token.offset) || token.offset < 0 ||
      !/^[a-f0-9]{64}$/.test(token.prefix) || !/^[a-f0-9]{64}$/.test(token.boundary)) throw new Error('invalid token')
    return token
  } catch { throw ApiError.badRequest('Invalid trajectory tail token') }
}

async function encodeTailToken(handle: FileHandle, dev: string, ino: string, offset: number, signal?: AbortSignal): Promise<string> {
  const token: TailToken = {
    v: 1, dev, ino, offset,
    prefix: await hashRange(handle, 0, Math.min(ANCHOR_BYTES, offset), signal),
    boundary: await hashRange(handle, Math.max(0, offset - ANCHOR_BYTES), offset, signal),
  }
  return Buffer.from(JSON.stringify(token)).toString('base64url')
}

/** Offset right after the last newline at or before `size` (bounded backward search). */
async function lastLineEnd(handle: FileHandle, size: number, signal?: AbortSignal): Promise<number> {
  let end = size
  while (end > 0 && size - end < HISTORY_SEMANTIC_RECORD_BYTES) {
    const start = Math.max(0, end - 64 * 1024)
    const chunk = await readExact(handle, start, end - start, signal)
    const newline = chunk.lastIndexOf(10)
    if (newline >= 0) return start + newline + 1
    end = start
  }
  return end === 0 ? 0 : size
}

function emptyPage(snapshots: TrajectoryRow[] | undefined): TrajectoryPage {
  return {
    rows: [], ...(snapshots ? { snapshots } : {}), turnBase: 0, olderCursor: null,
    tailToken: Buffer.from(JSON.stringify({ v: 1, dev: '', ino: '', offset: 0, prefix: sha256(Buffer.alloc(0)), boundary: sha256(Buffer.alloc(0)) })).toString('base64url'),
    historyComplete: true, omittedOversizedEntries: 0, sourceMissing: true,
  }
}

async function tailTokenFor(filePath: string, sourceVersion: string, signal?: AbortSignal): Promise<string> {
  const [dev = '', ino = '', sizeText = '0'] = sourceVersion.split(':')
  const size = Number(sizeText)
  return withHistoryReadBudget(signal, async () => {
    const handle = await open(filePath, 'r')
    try {
      const stat = await handle.stat({ bigint: true })
      if (String(stat.dev) !== dev || String(stat.ino) !== ino || Number(stat.size) < size) throw changed('Trajectory source changed during read')
      return await encodeTailToken(handle, dev, ino, await lastLineEnd(handle, size, signal), signal)
    } finally { await handle.close() }
  })
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/**
 * Page budget cost of one record, close to what it projects to: long strings
 * (base64 images, file bodies) count only their first
 * `TRAJECTORY_COST_STRING_CHARS`, so a page of screenshots still holds many
 * rows. Bounded walk; never serializes the record.
 */
export function trajectoryRecordCost(entry: Record<string, unknown>): number {
  let cost = 0
  let nodes = 0
  const stack: unknown[] = [entry]
  while (stack.length) {
    const value = stack.pop()
    if (++nodes > TRAJECTORY_COST_NODES) break
    if (typeof value === 'string') cost += Math.min(value.length, TRAJECTORY_COST_STRING_CHARS) + 2
    else if (Array.isArray(value)) { cost += 2 + value.length; for (const item of value) stack.push(item) }
    else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) { cost += key.length + 4; stack.push(child) }
    } else cost += 6
  }
  return cost
}

/** Oversized records become head-derived stubs placed among the parsed entries. */
function withOversized(entries: ProjectionEntry[], oversized: OversizedHistoryRecord[] | undefined): { entries: ProjectionEntry[]; represented: number } {
  if (!oversized?.length) return { entries, represented: 0 }
  let represented = 0
  const stubs: ProjectionEntry[] = oversized.map(record => {
    const entry = oversizedProjectionEntry(record.head)
    if (entry.type === 'user' && (entry.toolUseIds as string[]).length) represented++
    return { entry, byteStart: record.byteStart, byteEnd: record.byteEnd, oversizedBytes: record.byteEnd - record.byteStart }
  })
  return { entries: [...entries, ...stubs].sort((a, b) => a.byteStart - b.byteStart), represented }
}

/**
 * Timestamps of the projected records right before `offset` (a line start),
 * oldest first: a bounded backward read of whole lines only.
 */
async function precedingTimestamps(filePath: string, offset: number, skipSidechain: boolean, signal?: AbortSignal): Promise<string[]> {
  if (offset <= 0) return []
  return withHistoryReadBudget(signal, async () => {
    const handle = await open(filePath, 'r')
    try {
      const start = Math.max(0, offset - PRECEDING_SCAN_BYTES)
      const bytes = await readExact(handle, start, offset - start, signal)
      const found: string[] = []
      let end = bytes[bytes.length - 1] === 10 ? bytes.length - 1 : bytes.length
      for (let lines = 0; end > 0 && found.length < START_TS_LOOKBACK && lines < START_TS_LOOKBACK * 4; lines++) {
        const newline = bytes.lastIndexOf(10, end - 1)
        // The first line in the window is cut unless the window reaches the file head.
        if (newline < 0 && start > 0) break
        const entry = parseObject(bytes.subarray(newline + 1, end))
        end = newline
        if (!entry || isProjectionSkipped(entry, skipSidechain) || typeof entry.timestamp !== 'string' || !entry.timestamp) continue
        found.unshift(entry.timestamp)
      }
      return found
    } finally { await handle.close() }
  }, 'metadata')
}

export async function getTrajectoryPage(
  sessionId: string,
  options: { cursor?: string; after?: string; agentId?: string; signal?: AbortSignal } = {},
): Promise<TrajectoryPage> {
  if (options.cursor && options.after) throw ApiError.badRequest('cursor and after are mutually exclusive')
  const { signal } = options
  const source = await resolveSource(sessionId, options.agentId)
  const withSnapshots = !options.cursor
  const snapshots = withSnapshots ? await snapshotRows(source.sidecarPath, source.scope, signal) : undefined

  if (options.after) {
    try { return await readAppend(source, options.after, snapshots!, signal) } catch (error) {
      if (isMissing(error)) throw changed('Trajectory source was removed; reload the newest page')
      throw error
    }
  }

  let result: Awaited<ReturnType<typeof readBoundedHistoryPage>>
  try {
    result = await readBoundedHistoryPage(source.filePath, {
      cursor: options.cursor, signal, budget: TRAJECTORY_PAGE_BUDGET, captureOversized: true, measure: trajectoryRecordCost,
    })
  } catch (error) {
    if (isMissing(error)) {
      if (options.cursor) throw changed('Trajectory source was removed; reload the newest page')
      return emptyPage(snapshots)
    }
    throw error
  }
  const { page } = result
  const { entries, represented } = withOversized(result.entries, result.oversized)
  const firstOffset = entries[0]?.byteStart ?? Number(page.sourceVersion.split(':')[2] ?? 0)
  const [turnBase, preceding] = await Promise.all([
    turnsBefore(source.filePath, firstOffset, signal, { skipSidechain: source.skipSidechain }),
    entries.length ? precedingTimestamps(source.filePath, firstOffset, source.skipSidechain, signal) : [],
  ])
  // A tool result shown as `resultOmittedBytes` is not missing from the ledger.
  const omitted = page.omittedOversizedEntries - represented
  return {
    rows: projectTrajectoryRows(entries, { turnBase, skipSidechain: source.skipSidechain, precedingTimestamps: preceding }),
    ...(snapshots ? { snapshots } : {}),
    turnBase,
    olderCursor: page.nextCursor,
    // Older pages leave the client's live token alone.
    tailToken: options.cursor ? '' : await tailTokenFor(source.filePath, page.sourceVersion, signal),
    historyComplete: page.historyComplete ||
      (represented > 0 && omitted === 0 && page.nextCursor === null && !page.previousCursor && !page.contentTruncated),
    omittedOversizedEntries: omitted,
  }
}

async function readAppend(source: Source, tokenValue: string, snapshots: TrajectoryRow[], signal?: AbortSignal): Promise<TrajectoryPage> {
  const token = decodeTailToken(tokenValue)
  const read = await withHistoryReadBudget(signal, async () => {
    const handle = await open(source.filePath, 'r')
    try {
      const stat = await handle.stat({ bigint: true })
      const dev = String(stat.dev)
      const ino = String(stat.ino)
      const size = Number(stat.size)
      if (dev !== token.dev || ino !== token.ino || size < token.offset) throw changed('Session history was rewritten; reload the newest page')
      if (await hashRange(handle, 0, Math.min(ANCHOR_BYTES, token.offset), signal) !== token.prefix ||
        await hashRange(handle, Math.max(0, token.offset - ANCHOR_BYTES), token.offset, signal) !== token.boundary) {
        throw changed('Session history was rewritten; reload the newest page')
      }
      if (size - token.offset > TRAJECTORY_APPEND_MAX_BYTES) throw changed('Too much new history for a live append; reload the newest page', 'TRAJECTORY_APPEND_TOO_LARGE')
      const entries: ProjectionEntry[] = []
      const oversized: OversizedHistoryRecord[] = []
      let omitted = 0
      const nextOffset = await scanLines(handle, token.offset, size, (byteStart, byteEnd, bytes, head) => {
        if (!bytes) {
          omitted++
          if (head) oversized.push({ byteStart, byteEnd, head: head.toString('utf8') })
          return
        }
        if (!bytes.length) return
        const entry = parseObject(bytes)
        if (!entry) { omitted++; return }
        entries.push({ entry, byteStart, byteEnd })
      }, signal, HISTORY_SEMANTIC_RECORD_BYTES, HISTORY_OVERSIZED_HEAD_BYTES)
      const after = await handle.stat({ bigint: true })
      if (String(after.ino) !== ino || Number(after.size) < size) throw changed('Session history changed during read')
      return { ...withOversized(entries, oversized), omitted, nextOffset, tailToken: await encodeTailToken(handle, dev, ino, nextOffset, signal) }
    } finally { await handle.close() }
  })
  const [turnBase, preceding] = await Promise.all([
    turnsBefore(source.filePath, token.offset, signal, { skipSidechain: source.skipSidechain }),
    read.entries.length ? precedingTimestamps(source.filePath, token.offset, source.skipSidechain, signal) : [],
  ])
  const omitted = read.omitted - read.represented
  return {
    rows: projectTrajectoryRows(read.entries, { turnBase, skipSidechain: source.skipSidechain, precedingTimestamps: preceding }),
    snapshots,
    turnBase,
    olderCursor: null,
    tailToken: read.tailToken,
    historyComplete: omitted === 0,
    omittedOversizedEntries: omitted,
  }
}

// ---------------------------------------------------------------------------
// Row detail
// ---------------------------------------------------------------------------

export function parseLocParam(value: string | null): Array<[number, number]> {
  if (!value || value.length > 64 * 48 || !/^\d{1,15}-\d{1,15}(?:,\d{1,15}-\d{1,15})*$/.test(value)) throw ApiError.badRequest('Invalid loc parameter')
  const ranges = value.split(',').map(part => part.split('-').map(Number) as [number, number])
  if (ranges.length > TRAJECTORY_DETAIL_MAX_RANGES) throw ApiError.badRequest('Too many loc ranges')
  let total = 0
  for (const [start, end] of ranges) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) throw ApiError.badRequest('Invalid loc range')
    // An oversized record's range is accepted but never read in full (see
    // getTrajectoryRowDetail), so it does not count toward the budget.
    if (end - start <= HISTORY_SEMANTIC_RECORD_BYTES) total += end - start
  }
  if (total > TRAJECTORY_DETAIL_MAX_BYTES) throw ApiError.badRequest('loc ranges exceed the detail budget')
  return ranges
}

function belongsToRow(rowKind: string, rowKey: string, entry: Record<string, unknown>, start: number): boolean {
  const message = entry.message && typeof entry.message === 'object' ? entry.message as Record<string, unknown> : undefined
  switch (rowKind) {
    case 'u':
    case 'c':
    case 'm':
      return entry.uuid === rowKey || (entry.uuid === undefined && rowKey === `@${start}`)
    case 'a':
      return message?.id === rowKey || (message?.id === undefined && (entry.uuid === rowKey || (entry.uuid === undefined && rowKey === `@${start}`)))
    case 't':
      return Array.isArray(message?.content) && message.content.some(block => block && typeof block === 'object' &&
        (((block as Record<string, unknown>).type === 'tool_use' && (block as Record<string, unknown>).id === rowKey) ||
          ((block as Record<string, unknown>).type === 'tool_result' && (block as Record<string, unknown>).tool_use_id === rowKey)))
    default:
      return false
  }
}

/** Only tool rows reference oversized records (their omitted result). */
function oversizedBelongsToRow(rowKind: string, rowKey: string, head: string): boolean {
  if (rowKind !== 't') return false
  const entry = oversizedProjectionEntry(head)
  return entry.type === 'user' && (entry.toolUseIds as string[]).includes(rowKey)
}

/** Bound every string (and the running total) without dropping structure. */
export function boundDetailStrings(value: unknown, state: { remaining: number; truncated: boolean }, depth = 0): unknown {
  if (typeof value === 'string') {
    const limit = Math.max(0, Math.min(TRAJECTORY_DETAIL_STRING_CHARS, state.remaining))
    state.remaining -= Math.min(value.length, limit)
    if (value.length <= limit) return value
    state.truncated = true
    return value.slice(0, limit) + '\n… [truncated]'
  }
  if (!value || typeof value !== 'object') return value
  if (depth > 64) { state.truncated = true; return '[truncated]' }
  if (Array.isArray(value)) return value.map(item => boundDetailStrings(item, state, depth + 1))
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, boundDetailStrings(child, state, depth + 1)]))
}

export async function getTrajectoryRowDetail(
  sessionId: string,
  rowId: string,
  locParam: string | null,
  options: { agentId?: string; signal?: AbortSignal } = {},
): Promise<TrajectoryRowDetail> {
  const match = ROW_ID_RE.exec(rowId)
  if (!match) throw ApiError.badRequest('Invalid trajectory row id')
  const [, rowKind, rowKey] = match as unknown as [string, string, string]
  const ranges = [...new Map(parseLocParam(locParam).map(range => [range[0], range])).values()].sort((a, b) => a[0] - b[0])
  const source = await resolveSource(sessionId, options.agentId)
  const { signal } = options
  return withHistoryReadBudget(signal, async () => {
    let handle: FileHandle
    try { handle = await open(source.filePath, 'r') } catch (error) {
      if (isMissing(error)) throw ApiError.notFound('Trajectory source not found')
      throw error
    }
    try {
      const size = Number((await handle.stat()).size)
      const state = { remaining: TRAJECTORY_DETAIL_TOTAL_CHARS, truncated: false }
      const entries: Record<string, unknown>[] = []
      for (const [start, end] of ranges) {
        if (end > size) throw ApiError.badRequest('loc range is outside the transcript')
        if (end - start > HISTORY_SEMANTIC_RECORD_BYTES) {
          // Oversized record (e.g. a screenshot tool_result): verify the line
          // boundaries and its head, then skip it so the rest still loads.
          const before = start > 0 ? (await readExact(handle, start - 1, 1, signal))[0] : 10
          const after = end < size ? (await readExact(handle, end, 1, signal))[0] : 10
          const head = (await readExact(handle, start, Math.min(HISTORY_OVERSIZED_HEAD_BYTES, end - start), signal)).toString('utf8')
          if (before !== 10 || after !== 10 || !oversizedBelongsToRow(rowKind, rowKey, head)) {
            throw new ApiError(409, 'Transcript record no longer matches this row; reload the trajectory', 'TRAJECTORY_ROW_MISMATCH')
          }
          state.truncated = true
          continue
        }
        // Read one byte on each side to prove the range is a whole JSONL line.
        const readStart = Math.max(0, start - 1)
        const readEnd = Math.min(size, end + 1)
        const bytes = await readExact(handle, readStart, readEnd - readStart, signal)
        const lead = start - readStart
        const body = bytes.subarray(lead, lead + (end - start))
        const before = lead ? bytes[0] : 10
        const after = readEnd > end ? bytes[bytes.length - 1] : 10
        const trimmed = body[body.length - 1] === 10 ? body.subarray(0, body.length - 1) : body
        const entry = before === 10 && (after === 10 || trimmed !== body) ? parseObject(trimmed) : null
        if (!entry || !belongsToRow(rowKind, rowKey, entry, start)) {
          throw new ApiError(409, 'Transcript record no longer matches this row; reload the trajectory', 'TRAJECTORY_ROW_MISMATCH')
        }
        entries.push(boundDetailStrings(entry, state) as Record<string, unknown>)
      }
      return { rowId, entries, truncated: state.truncated }
    } finally { await handle.close() }
  })
}

// ---------------------------------------------------------------------------
// Snapshot blobs
// ---------------------------------------------------------------------------

export async function getTrajectorySnapshotBlob(sessionId: string, hash: string, signal?: AbortSignal): Promise<TrajectorySnapshotBlob> {
  if (!SNAPSHOT_BLOB_RE.test(hash)) throw ApiError.badRequest('Invalid snapshot hash')
  const source = await resolveSource(sessionId, undefined)
  return withHistoryReadBudget(signal, async () => {
    const index = await loadSnapshotIndex(source.sidecarPath, signal)
    const locator = index?.blobs.get(hash)
    if (!locator) throw ApiError.notFound(`Snapshot not found: ${hash}`)
    const handle = await open(source.sidecarPath, 'r')
    try {
      const record = parseObject(await readExact(handle, locator.start, locator.end - locator.start, signal))
      if (!record || record.h !== hash) throw changed('Prompt snapshot file changed; retry')
      return {
        hash,
        kind: locator.kind,
        ...(typeof record.text === 'string' ? { text: record.text } : {}),
        ...(record.json !== undefined ? { json: record.json } : {}),
        ...(record.truncated === true ? { truncated: true } : {}),
      }
    } finally { await handle.close() }
  }, 'metadata')
}
