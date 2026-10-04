/**
 * Desktop-only prompt snapshot sidecar.
 *
 * Records the system prompt, the tool catalog actually sent, and the user
 * context (CLAUDE.md, currentDate, ...) per request into
 * `<projectDir>/<sessionId>/prompt-snapshots.jsonl` so the trajectory view can
 * show them per turn without changing the transcript format.
 *
 * Record format (one JSON object per line; a blob line is always written
 * before the first marker that references it):
 *   {"t":"blob","k":"sys","h","ts","text","truncated"?}
 *   {"t":"blob","k":"tools","h","ts","json":[{name,description,input_schema}],"truncated"?}
 *   {"t":"blob","k":"ctx","h","ts","json":{key:value},"truncated"?}
 *   {"t":"req","ts","scope","sys","tools","qs"?,"model","toolCount","sysChars"}
 *   {"t":"ctx","ts","scope","ctx"}
 *
 * Contract: zero cost when not running under the desktop entrypoint, never
 * awaited on the request path, never throws, and disables itself after
 * repeated write failures.
 */
import { createHash } from 'crypto'
import { appendFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import { logForDebugging } from '../../utils/debug.js'
import { getPromptSnapshotPath } from '../../utils/sessionStorage.js'

export const PROMPT_SNAPSHOT_MAX_BLOB_CHARS = 1024 * 1024
const MAX_CONSECUTIVE_FAILURES = 3
const MAIN_SCOPE = 'main'
const FALSY_FLAG_VALUES = new Set(['0', 'false', 'off'])

export type PromptSnapshotArgs = {
  systemPrompt: readonly string[]
  tools: readonly unknown[]
  model: string
  querySource?: string
  agentId?: string
}

export type UserContextSnapshotArgs = {
  userContext: Record<string, string>
  agentId?: string
}

type ToolEntry = {
  name: string
  description?: string
  input_schema?: unknown
}

type ToolHashCacheEntry = {
  name: string
  description: string | undefined
  hash: string
}

type PendingBlob = {
  key: string
  build: () => Record<string, unknown>
}

type SnapshotState = {
  disabled: boolean
  consecutiveFailures: number
  writeChain: Promise<void>
  createdDirs: Set<string>
  /** file path -> blob keys (`<kind>:<hash>`) already appended to that file */
  persistedBlobs: Map<string, Set<string>>
  /** `<path>\0<scope>` -> last req marker identity */
  lastReq: Map<string, string>
  /** `<path>\0<scope>` -> last ctx hash */
  lastCtx: Map<string, string>
}

function createState(): SnapshotState {
  return {
    disabled: false,
    consecutiveFailures: 0,
    writeChain: Promise.resolve(),
    createdDirs: new Set(),
    persistedBlobs: new Map(),
    lastReq: new Map(),
    lastCtx: new Map(),
  }
}

let state = createState()
// Keyed by the tool's input_schema object: toolToAPISchema returns a fresh
// per-request wrapper but reuses the session-cached input_schema object, so
// this keeps us from re-serializing large schemas on every request.
let toolHashCache = new WeakMap<object, ToolHashCacheEntry>()
let resolveSnapshotPath: () => string = getPromptSnapshotPath

function isEnabled(): boolean {
  if (process.env.CLAUDE_CODE_ENTRYPOINT !== 'claude-desktop') return false
  const flag = process.env.CC_HAHA_PROMPT_SNAPSHOT
  if (flag !== undefined && FALSY_FLAG_VALUES.has(flag.trim().toLowerCase())) {
    return false
  }
  return !state.disabled
}

function hash16(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toolHash(tool: unknown): string {
  if (!tool || typeof tool !== 'object') {
    return hash16(JSON.stringify([String(tool), null, null]))
  }
  const record = tool as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name : ''
  const description =
    typeof record.description === 'string' ? record.description : undefined
  const schema = record.input_schema
  const cacheKey = schema && typeof schema === 'object' ? schema : record
  const cached = toolHashCache.get(cacheKey)
  if (cached && cached.name === name && cached.description === description) {
    return cached.hash
  }
  const hash = hash16(JSON.stringify([name, description ?? null, schema ?? null]))
  toolHashCache.set(cacheKey, { name, description, hash })
  return hash
}

function toToolEntry(tool: unknown): ToolEntry {
  if (!tool || typeof tool !== 'object') return { name: String(tool) }
  const record = tool as Record<string, unknown>
  const entry: ToolEntry = {
    name: typeof record.name === 'string' ? record.name : '',
  }
  if (typeof record.description === 'string') {
    entry.description = record.description
  }
  if (record.input_schema !== undefined) {
    entry.input_schema = record.input_schema
  }
  return entry
}

function boundToolEntries(entries: ToolEntry[]): {
  json: ToolEntry[]
  truncated: boolean
} {
  const sizes = entries.map(entry => JSON.stringify(entry).length + 1)
  let total = sizes.reduce((sum, size) => sum + size, 2)
  if (total <= PROMPT_SNAPSHOT_MAX_BLOB_CHARS) {
    return { json: entries, truncated: false }
  }

  // Drop input_schema from the largest tools first.
  const bounded = entries.map(entry => ({ ...entry }))
  const bySchemaSize = bounded
    .map((entry, index) => ({
      index,
      schemaSize:
        entry.input_schema === undefined
          ? 0
          : JSON.stringify(entry.input_schema).length,
    }))
    .filter(item => item.schemaSize > 0)
    .sort((a, b) => b.schemaSize - a.schemaSize)
  for (const { index, schemaSize } of bySchemaSize) {
    if (total <= PROMPT_SNAPSHOT_MAX_BLOB_CHARS) break
    delete bounded[index]!.input_schema
    const saved = schemaSize + ',"input_schema":'.length
    sizes[index] = sizes[index]! - saved
    total -= saved
  }
  if (total <= PROMPT_SNAPSHOT_MAX_BLOB_CHARS) {
    return { json: bounded, truncated: true }
  }

  // Still too large (huge descriptions): keep the leading tools that fit.
  const kept: ToolEntry[] = []
  let used = 2
  for (let index = 0; index < bounded.length; index++) {
    const size = sizes[index]!
    if (used + size > PROMPT_SNAPSHOT_MAX_BLOB_CHARS) break
    kept.push(bounded[index]!)
    used += size
  }
  return { json: kept, truncated: true }
}

function boundContextEntries(entries: Array<[string, string]>): {
  json: Record<string, string>
  truncated: boolean
} {
  const total = entries.reduce(
    (sum, [key, value]) => sum + key.length + value.length,
    0,
  )
  if (total <= PROMPT_SNAPSHOT_MAX_BLOB_CHARS) {
    return { json: Object.fromEntries(entries), truncated: false }
  }
  const values = new Map(entries)
  let excess = total - PROMPT_SNAPSHOT_MAX_BLOB_CHARS
  const largestFirst = [...entries].sort((a, b) => b[1].length - a[1].length)
  for (const [key, value] of largestFirst) {
    if (excess <= 0) break
    const keep = Math.max(0, value.length - excess)
    values.set(key, value.slice(0, keep))
    excess -= value.length - keep
  }
  return {
    json: Object.fromEntries(entries.map(([key]) => [key, values.get(key)!])),
    truncated: true,
  }
}

function persistedBlobsFor(path: string): Set<string> {
  let persisted = state.persistedBlobs.get(path)
  if (!persisted) {
    persisted = new Set()
    state.persistedBlobs.set(path, persisted)
  }
  return persisted
}

function recordWriteFailure(error: unknown, path: string): void {
  state.consecutiveFailures += 1
  logForDebugging(
    `[promptSnapshot] failed to append ${path}: ${errorMessage(error)}`,
  )
  if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !state.disabled) {
    state.disabled = true
    logForDebugging(
      `[promptSnapshot] disabled after ${MAX_CONSECUTIVE_FAILURES} consecutive write failures`,
      { level: 'warn' },
    )
  }
}

/**
 * Queue one marker plus the blobs it references. Which blobs still need to be
 * written is decided at write time against what was successfully appended, so
 * a failed write never leaves a later marker pointing at a missing blob.
 */
function enqueue(
  path: string,
  blobs: PendingBlob[],
  marker: Record<string, unknown>,
  onFailure: () => void,
): void {
  state.writeChain = state.writeChain.then(async () => {
    if (state.disabled) return
    const dir = dirname(path)
    try {
      const persisted = persistedBlobsFor(path)
      const pending = blobs.filter(blob => !persisted.has(blob.key))
      let payload = ''
      for (const blob of pending) payload += `${JSON.stringify(blob.build())}\n`
      payload += `${JSON.stringify(marker)}\n`
      if (!state.createdDirs.has(dir)) {
        await mkdir(dir, { recursive: true })
        state.createdDirs.add(dir)
      }
      await appendFile(path, payload, 'utf8')
      for (const blob of pending) persisted.add(blob.key)
      state.consecutiveFailures = 0
    } catch (error) {
      // The directory may have been removed (e.g. session deleted); recreate
      // it on the next attempt.
      state.createdDirs.delete(dir)
      try {
        onFailure()
      } catch {
        // State rollback is best-effort.
      }
      recordWriteFailure(error, path)
    }
  })
}

export function recordPromptSnapshot(args: PromptSnapshotArgs): void {
  if (!isEnabled()) return
  try {
    const { systemPrompt, tools, model, querySource, agentId } = args
    const path = resolveSnapshotPath()
    const scope = agentId ?? MAIN_SCOPE
    const scopeKey = `${path}\0${scope}`

    const sysText = systemPrompt.join('\n\n')
    const sysHash = hash16(sysText)
    const toolsHash = hash16(JSON.stringify(tools.map(toolHash)))
    const reqIdentity = JSON.stringify([sysHash, toolsHash, querySource ?? null, model])
    if (state.lastReq.get(scopeKey) === reqIdentity) return
    state.lastReq.set(scopeKey, reqIdentity)

    const ts = new Date().toISOString()
    const toolList = [...tools]
    const blobs: PendingBlob[] = [
      {
        key: `sys:${sysHash}`,
        build: () => {
          const truncated = sysText.length > PROMPT_SNAPSHOT_MAX_BLOB_CHARS
          return {
            t: 'blob',
            k: 'sys',
            h: sysHash,
            ts,
            text: truncated
              ? sysText.slice(0, PROMPT_SNAPSHOT_MAX_BLOB_CHARS)
              : sysText,
            ...(truncated && { truncated: true }),
          }
        },
      },
      {
        key: `tools:${toolsHash}`,
        build: () => {
          const { json, truncated } = boundToolEntries(toolList.map(toToolEntry))
          return {
            t: 'blob',
            k: 'tools',
            h: toolsHash,
            ts,
            json,
            ...(truncated && { truncated: true }),
          }
        },
      },
    ]
    const marker = {
      t: 'req',
      ts,
      scope,
      sys: sysHash,
      tools: toolsHash,
      ...(querySource !== undefined && { qs: querySource }),
      model,
      toolCount: toolList.length,
      sysChars: sysText.length,
    }
    enqueue(path, blobs, marker, () => {
      if (state.lastReq.get(scopeKey) === reqIdentity) {
        state.lastReq.delete(scopeKey)
      }
    })
  } catch (error) {
    logForDebugging(
      `[promptSnapshot] failed to record prompt snapshot: ${errorMessage(error)}`,
    )
  }
}

export function recordUserContextSnapshot(args: UserContextSnapshotArgs): void {
  if (!isEnabled()) return
  try {
    const { userContext, agentId } = args
    const path = resolveSnapshotPath()
    const scope = agentId ?? MAIN_SCOPE
    const scopeKey = `${path}\0${scope}`

    const entries = Object.entries(userContext)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const ctxHash = hash16(JSON.stringify(entries))
    if (state.lastCtx.get(scopeKey) === ctxHash) return
    state.lastCtx.set(scopeKey, ctxHash)

    const ts = new Date().toISOString()
    enqueue(
      path,
      [
        {
          key: `ctx:${ctxHash}`,
          build: () => {
            const { json, truncated } = boundContextEntries(entries)
            return {
              t: 'blob',
              k: 'ctx',
              h: ctxHash,
              ts,
              json,
              ...(truncated && { truncated: true }),
            }
          },
        },
      ],
      { t: 'ctx', ts, scope, ctx: ctxHash },
      () => {
        if (state.lastCtx.get(scopeKey) === ctxHash) state.lastCtx.delete(scopeKey)
      },
    )
  } catch (error) {
    logForDebugging(
      `[promptSnapshot] failed to record user context snapshot: ${errorMessage(error)}`,
    )
  }
}

/** Test-only: resets all per-process state and optionally overrides the path. */
export function resetPromptSnapshotStateForTests(options?: {
  resolvePath?: () => string
}): void {
  state = createState()
  toolHashCache = new WeakMap()
  resolveSnapshotPath = options?.resolvePath ?? getPromptSnapshotPath
}

/** Test-only: resolves once every queued write has settled. */
export function flushPromptSnapshotWritesForTests(): Promise<void> {
  return state.writeChain
}
