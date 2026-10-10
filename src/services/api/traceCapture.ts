import { createHash, randomUUID } from 'crypto'
import { existsSync, readFileSync, statSync } from 'fs'
import { promises as fs } from 'fs'
import type { Stats } from 'fs'
import { dirname, join } from 'path'
import { getClaudeConfigHomeDir, isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import {
  openTraceIndexDatabase,
  type TraceIndexDatabase,
} from '../../server/services/localIndex/traceDatabase.js'
import {
  createTraceIndex,
  type TraceCallLocator,
  type TraceEventLocator,
  type TraceIndex,
  type TraceSessionOverview,
} from '../../server/services/localIndex/traceIndex.js'
import { resolveLocalIndexMode } from '../../server/services/localIndex/config.js'
import type { LocalIndexMode } from '../../server/services/localIndex/types.js'
import {
  captureSourceFingerprint,
  deserializeSourceFingerprint,
  detectSourceChange,
  serializeSourceFingerprint,
  type LocalIndexIoMetrics,
  type SourceFingerprint,
} from '../../server/services/localIndex/sourceFingerprint.js'

const TRACE_PREVIEW_CHARS = 240_000
export const TRACE_STREAM_CAPTURE_BYTES = 1024 * 1024
export const TRACE_LIST_PREVIEW_CHARS = 2048
const TRACE_SETTINGS_KEY = 'traceCapture'
const TRACE_INDEX_PARSER_VERSION = 2
const TRACE_FINGERPRINT_WINDOW_BYTES = 64 * 1024
export const TRACE_RECORD_BYTES_LIMIT = 2 * 1024 * 1024
export const TRACE_WINDOW_RECORD_LIMIT = 10_000
export const TRACE_WINDOW_BYTES_LIMIT = 64 * 1024 * 1024
export const TRACE_OVERVIEW_LIMIT = 100
const TRACE_LEGACY_FULL_BYTES_LIMIT = 8 * 1024 * 1024
export type TraceOverviewOptions = {
  offset?: number
  limit?: number
  revisionToken?: string
  scanCursor?: string
  signal?: AbortSignal
}
/** Hard ceilings of the time-window call lookup (`getSessionTraceCallsNear`). */
export const TRACE_NEAR_LIMIT = 50
export const TRACE_NEAR_MAX_WINDOW_MS = 60 * 60 * 1000
export const TRACE_NEAR_SCAN_BYTES = 32 * 1024 * 1024
export const TRACE_NEAR_SCAN_RECORDS = 4000
export type TraceCallsNearResult = {
  calls: TraceCallRecord[]
  revisionToken?: string
  captured: boolean
  /** callId → `start-end` byte range for the call-detail `at` hint. */
  locs?: Record<string, string>
  /** The scan budget or the result cap was hit; more calls may exist in the window. */
  limited?: boolean
}
export type TraceSessionWindow = {
  offset: number
  limit: number
  totalCalls: number
  totalEvents: number
  hasMore: boolean
  revisionToken: string
  state: 'ready' | 'indexing' | 'limited'
  oversizedRecords: number
  startByte: number
  scannedBytes: number
  fileBytes: number
  recordLimit: number
  recordBytesLimit: number
  nextScanCursor?: string
}
function traceResourceError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}
// `token(?!s)` keeps secret-bearing keys (token, access_token, api_token) redacted while
// letting token-count fields (input_tokens, max_tokens, prompt_tokens) through.
// `session` covers stable per-conversation identifiers (x-opencode-session,
// x-session-affinity) that gateways take as routing keys: not credentials, but the
// same value the local transcript and trace files are named after, and traces are
// meant to be shareable when reporting a bug.
const SENSITIVE_KEY_RE = /authorization|api[-_]?key|secret|token(?!s)|cookie|password|bearer|session/i

export type TraceCaptureSettings = {
  enabled: boolean
  storageDir: string
}

export type TraceProviderInfo = {
  id: string | null
  name: string
  format: string
}

export type TraceBodySnapshot = {
  contentType: 'json' | 'text' | 'empty'
  bytes: number
  sha256: string
  preview: string
  truncated: boolean
  captureOmitted?: string
}

export type TraceCallStatus = 'pending' | 'ok' | 'error'

export type TraceEventSeverity = 'info' | 'warning' | 'error'

export type TraceCallUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}

export type TraceRequestSemantic = {
  version: 1
  request: Record<string, unknown>
}

export type TraceCallRecord = {
  id: string
  sessionId: string
  source: 'anthropic' | 'proxy'
  querySource?: string
  provider?: TraceProviderInfo
  model?: string
  status?: TraceCallStatus
  startedAt: string
  completedAt?: string
  durationMs?: number
  usage?: TraceCallUsage
  metadata?: Record<string, unknown>
  request: {
    method: string
    url: string
    headers: Record<string, string>
    body: TraceBodySnapshot
    semantic?: TraceRequestSemantic
  }
  response?: {
    status: number
    headers: Record<string, string>
    body: TraceBodySnapshot
  }
  error?: {
    name: string
    message: string
    code?: string
    stack?: string
    cause?: string
  }
}

export type TraceEventRecord = {
  id: string
  sessionId: string
  timestamp: string
  phase: string
  severity: TraceEventSeverity
  callId?: string
  source?: TraceCallRecord['source']
  provider?: TraceProviderInfo
  model?: string
  title?: string
  message?: string
  metadata?: Record<string, unknown>
}

export type TraceSessionSummary = {
  apiCalls: number
  failedCalls: number
  totalDurationMs: number
  totalInputTokens: number
  totalOutputTokens: number
  models: Array<{ model: string; calls: number }>
  updatedAt: string | null
}

export type TraceSession = {
  window?: TraceSessionWindow
  sessionId: string
  summary: TraceSessionSummary
  calls: TraceCallRecord[]
  events: TraceEventRecord[]
}

export type TraceSessionListItem = {
  window?: TraceSessionWindow
  sessionId: string
  summary: TraceSessionSummary
  fileSize: number
  fileUpdatedAt: string
}

export type TraceSessionFileItem = {
  sessionId: string
  fileSize: number
  fileUpdatedAt: string
}

export type TraceSessionFileList = {
  files: TraceSessionFileItem[]
  total: number
  storageDir: string
  settings: TraceCaptureSettings
}

export type TraceSessionList = {
  traces: TraceSessionListItem[]
  total: number
  storageDir: string
  settings: TraceCaptureSettings
}

export type TraceSessionDeleteResult = {
  sessionId: string
  deleted: boolean
}

export type TraceSessionRevision = {
  sessionId: string
  revision: number
  revisionToken: string
  changed: boolean
  reset: boolean
}

export type RecordTraceCallInput = {
  id?: string
  sessionId: string
  source: TraceCallRecord['source']
  querySource?: string
  provider?: TraceProviderInfo
  model?: string
  status?: TraceCallStatus
  startedAt?: string
  completedAt?: string
  durationMs?: number
  metadata?: Record<string, unknown>
  request: {
    method?: string
    url?: string
    headers?: Headers | Record<string, string> | null
    body?: unknown
    bodySnapshot?: TraceBodySnapshot
  }
  response?: {
    status: number
    headers?: Headers | Record<string, string> | null
    body?: unknown
    bodySnapshot?: TraceBodySnapshot
  }
  error?: unknown
}

export type RecordTraceEventInput = {
  id?: string
  sessionId: string
  timestamp?: string
  phase: string
  severity?: TraceEventSeverity
  callId?: string
  source?: TraceCallRecord['source']
  provider?: TraceProviderInfo
  model?: string
  title?: string
  message?: string
  metadata?: Record<string, unknown>
}

type TraceFileEntry =
  | TraceCallRecord
  | { type: 'call'; record: TraceCallRecord }
  | { type: 'event'; event: TraceEventRecord }

type TraceReadCacheEntry = {
  mtimeMs: number
  size: number
  fingerprint: SourceFingerprint
  calls: TraceCallRecord[]
  events: TraceEventRecord[]
}

type CanonicalTraceRevisionState = {
  fingerprint: SourceFingerprint
  resetToken: string
  revision: number
}

export type TraceIndexTarget = {
  path: string
  scope: string
}

type TraceScopeContext = {
  scope: string
  storageDir: string
  target: TraceIndexTarget
}

const traceWriteQueues = new Map<string, Promise<void>>()
const traceReadCache = new Map<string, TraceReadCacheEntry>()
const canonicalTraceRevisions = new Map<string, CanonicalTraceRevisionState>()
const traceBackfillScheduled = new Set<string>()
let traceBackfillQueue: Promise<void> = Promise.resolve()
// Only a small bounded number of small list sources backfill without an
// overview consumer. Large files require a cancellable overview request.
const TRACE_BACKFILL_MAX_PENDING = 8
type TraceIndexState = {
  path: string
  database: TraceIndexDatabase
  index: TraceIndex
}

const traceIndexStates = new Map<string, TraceIndexState>()
const unavailableTraceIndexPaths = new Set<string>()
const traceIndexBusyCooldownUntil = new Map<string, number>()
let traceAppendBeforeWriteHookForTests: (() => Promise<void>) | null = null
let traceProjectionAfterIndexHookForTests: ((target: TraceIndexTarget) => Promise<void>) | null = null
let traceFullSnapshotAfterReadHookForTests: (() => Promise<void>) | null = null
const traceCaptureDiagnostics = {
  fullJsonlBytesRead: 0,
  incrementalJsonlBytesRead: 0,
  fingerprintBytesRead: 0,
  appendedEntriesProjected: 0,
  shadowComparisons: 0,
  shadowMismatches: 0,
}

export function shouldCaptureApiTrace(): boolean {
  if (isEnvDefinedFalsy(process.env.CC_HAHA_TRACE_API_CALLS)) return false
  if (isEnvTruthy(process.env.CC_HAHA_TRACE_API_CALLS)) return true
  return readTraceCaptureSettingsSync().enabled &&
    process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop'
}

export function isTraceCaptureEnabled(): boolean {
  if (isEnvDefinedFalsy(process.env.CC_HAHA_TRACE_API_CALLS)) return false
  if (isEnvTruthy(process.env.CC_HAHA_TRACE_API_CALLS)) return true
  return readTraceCaptureSettingsSync().enabled
}

export function getTraceStorageDir(): string {
  return join(getClaudeConfigHomeDir(), 'cc-haha', 'traces')
}

function currentTraceScopeContext(): TraceScopeContext {
  const scope = getClaudeConfigHomeDir()
  return {
    scope,
    storageDir: join(scope, 'cc-haha', 'traces'),
    target: {
      path: join(scope, 'cc-haha', 'db', 'trace-index-v1.sqlite'),
      scope,
    },
  }
}

function currentTraceIndexTarget(): TraceIndexTarget {
  return currentTraceScopeContext().target
}

export function readTraceCaptureSettingsSync(): TraceCaptureSettings {
  const scope = getClaudeConfigHomeDir()
  const settings = readManagedSettingsSync(scope)
  return normalizeTraceCaptureSettings(settings, scope)
}

export async function readTraceCaptureSettings(): Promise<TraceCaptureSettings> {
  const scope = getClaudeConfigHomeDir()
  const settings = await readManagedSettings(scope)
  return normalizeTraceCaptureSettings(settings, scope)
}

export async function updateTraceCaptureSettings(input: Partial<Pick<TraceCaptureSettings, 'enabled'>>): Promise<TraceCaptureSettings> {
  const scope = getClaudeConfigHomeDir()
  const current = await readManagedSettings(scope)
  const traceCapture = current[TRACE_SETTINGS_KEY]
  const previous = traceCapture && typeof traceCapture === 'object' && !Array.isArray(traceCapture)
    ? traceCapture as Record<string, unknown>
    : {}
  const nextTraceCapture = {
    ...previous,
    ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
  }
  const nextSettings = {
    ...current,
    [TRACE_SETTINGS_KEY]: nextTraceCapture,
  }
  await writeManagedSettings(nextSettings, scope)
  return normalizeTraceCaptureSettings(nextSettings, scope)
}

export const TRACE_CAPTURE_NODE_LIMIT = 4096
export const TRACE_CAPTURE_DEPTH_LIMIT = 32
export const TRACE_CAPTURE_CHAR_LIMIT = 1024 * 1024

type BoundedTraceValue = { value: unknown; omitted?: string }
function boundedTraceValue(input: unknown): BoundedTraceValue {
  let nodes = 0
  let chars = 0
  let bytes = 0
  const countText = (text: string) => {
    chars += text.length
    if (chars > TRACE_CAPTURE_CHAR_LIMIT) throw new Error('string-budget')
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      bytes += code < 0x20 ? 6 : code === 0x22 || code === 0x5c ? 2 : code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdfff ? 6 : 3
      if (bytes > TRACE_RECORD_BYTES_LIMIT - 128 * 1024) throw new Error('byte-budget')
    }
  }
  const seen = new WeakSet<object>()
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > TRACE_CAPTURE_NODE_LIMIT) throw new Error('node-budget')
    bytes += 16
    if (depth > TRACE_CAPTURE_DEPTH_LIMIT) throw new Error('depth-budget')
    if (typeof value === 'string') {
      countText(value)
      return value
    }
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new Error('unsupported-value')
    if (value === null || typeof value !== 'object') return value
    if (seen.has(value)) throw new Error('cycle')
    seen.add(value)
    if (Array.isArray(value)) {
      if (value.length > TRACE_CAPTURE_NODE_LIMIT - nodes) throw new Error('node-budget')
      const result: unknown[] = []
      for (let i = 0; i < value.length; i++) {
        const property = Object.getOwnPropertyDescriptor(value, String(i))
        if (property?.get || property?.set) throw new Error('accessor')
        result.push(visit(property?.value, depth + 1))
      }
      seen.delete(value)
      return result
    }
    const result: Record<string, unknown> = {}
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue
      if (nodes >= TRACE_CAPTURE_NODE_LIMIT) throw new Error('node-budget')
      countText(key)
      const property = Object.getOwnPropertyDescriptor(value, key)
      if (property?.get || property?.set) throw new Error('accessor')
      Object.defineProperty(result, key, { value: visit(property?.value, depth + 1), enumerable: true, configurable: true, writable: true })
    }
    seen.delete(value)
    return result
  }
  try { return { value: visit(input, 0) } }
  catch (error) {
    const omitted = (error instanceof Error ? error.message : 'unsupported-value').slice(0, 128)
    return { omitted, value: { traceCaptureOmitted: { reason: omitted, nodeLimit: TRACE_CAPTURE_NODE_LIMIT, depthLimit: TRACE_CAPTURE_DEPTH_LIMIT, charLimit: TRACE_CAPTURE_CHAR_LIMIT } } }
  }
}

function boundedTraceEntry(entry: TraceFileEntry): TraceFileEntry {
  const bounded = boundedTraceValue(entry)
  if (!bounded.omitted) return bounded.value as TraceFileEntry
  const metadata = { traceCaptureOmitted: { reason: bounded.omitted } }
  if ('type' in entry && entry.type === 'event') {
    const event = entry.event
    return { type: 'event', event: {
      id: event.id.slice(0, 512), sessionId: event.sessionId.slice(0, 512),
      timestamp: event.timestamp.slice(0, 128), phase: event.phase.slice(0, 128), severity: event.severity,
      ...(event.callId ? { callId: event.callId.slice(0, 512) } : {}),
      title: event.title?.slice(0, 256), message: '[trace event details omitted: resource budget]', metadata,
    } }
  }
  const record = 'type' in entry && entry.type === 'call' ? entry.record : entry as TraceCallRecord
  return { type: 'call', record: {
    id: record.id.slice(0, 512), sessionId: record.sessionId.slice(0, 512),
    source: record.source.slice(0, 128) as TraceCallRecord['source'], startedAt: record.startedAt.slice(0, 128),
    completedAt: record.completedAt?.slice(0, 128), status: record.status,
    model: record.model?.slice(0, 128), durationMs: record.durationMs, metadata,
    request: { method: record.request.method.slice(0, 32), url: record.request.url.slice(0, 8192), headers: {},
      body: { ...emptyTraceBodySnapshot(record.request.body.bytes), truncated: true, captureOmitted: bounded.omitted } },
    ...(record.response ? { response: { status: record.response.status, headers: {},
      body: { ...emptyTraceBodySnapshot(record.response.body.bytes), truncated: true, captureOmitted: bounded.omitted } } } : {}),
  } }
}

function boundedBodySnapshot(snapshot: TraceBodySnapshot): TraceBodySnapshot {
  return {
    contentType: snapshot.contentType,
    bytes: snapshot.bytes,
    sha256: snapshot.sha256.slice(0, 128),
    preview: snapshot.preview.slice(0, TRACE_PREVIEW_CHARS),
    truncated: snapshot.truncated || snapshot.preview.length > TRACE_PREVIEW_CHARS,
    ...(snapshot.captureOmitted ? { captureOmitted: snapshot.captureOmitted.slice(0, 128) } : {}),
  }
}

export function createTraceBodySnapshot(
  body: unknown,
  options?: { maxPreviewChars?: number; alreadyTruncated?: boolean },
): TraceBodySnapshot {
  const maxPreviewChars = options?.maxPreviewChars ?? TRACE_PREVIEW_CHARS
  const bounded = boundedTraceValue(body)
  const { serialized, contentType } = serializeTraceBody(bounded.value)
  const bytes = Buffer.byteLength(serialized)
  const preview = serialized.length > maxPreviewChars
    ? serialized.slice(0, maxPreviewChars)
    : serialized

  return {
    contentType,
    bytes,
    sha256: createHash('sha256').update(serialized).digest('hex'),
    preview,
    truncated: Boolean(bounded.omitted) || Boolean(options?.alreadyTruncated) || serialized.length > maxPreviewChars,
    ...(bounded.omitted ? { captureOmitted: bounded.omitted } : {}),
  }
}

export function trimTraceCallPreviews(
  call: TraceCallRecord,
  maxPreviewChars = TRACE_LIST_PREVIEW_CHARS,
): TraceCallRecord {
  const requestBody = trimBodySnapshotPreview(call.request.body, maxPreviewChars)
  const responseBody = call.response
    ? trimBodySnapshotPreview(call.response.body, maxPreviewChars)
    : undefined
  if (
    requestBody === call.request.body &&
    call.request.semantic === undefined &&
    (!call.response || responseBody === call.response.body)
  ) {
    return call
  }
  return {
    ...call,
    request: {
      method: call.request.method,
      url: call.request.url,
      headers: call.request.headers,
      body: requestBody,
    },
    ...(call.response && responseBody ? { response: { ...call.response, body: responseBody } } : {}),
  }
}

function trimBodySnapshotPreview(body: TraceBodySnapshot, maxPreviewChars: number): TraceBodySnapshot {
  if (body.preview.length <= maxPreviewChars) return body
  return {
    ...body,
    preview: body.preview.slice(0, maxPreviewChars),
    truncated: true,
  }
}

type TraceJsonRecord = Record<string, unknown>

function createRequestSemanticField(
  body: unknown,
  source: TraceCallRecord['source'],
): { semantic: TraceRequestSemantic } | Record<string, never> {
  const semantic = createTraceRequestSemantic(body, source)
  return semantic ? { semantic } : {}
}

/**
 * Preserve the structured request before its raw preview is truncated. The
 * desktop owns semantic parsing and context classification; capture only
 * removes binary image payloads so that parser stays the single source of
 * truth for Anthropic, Chat Completions, and Responses request shapes.
 */
export function createTraceRequestSemantic(
  body: unknown,
  source: TraceCallRecord['source'],
): TraceRequestSemantic | null {
  const bounded = boundedTraceValue(body)
  if (bounded.omitted) return { version: 1, request: bounded.value as TraceJsonRecord }
  const parsed = parseTraceRequestValue(bounded.value)
  if (!parsed) return null
  const request = source === 'proxy' && isTraceRecord(parsed.anthropic)
    ? parsed.anthropic
    : parsed
  if (
    !Array.isArray(request.messages) &&
    !Array.isArray(request.input) &&
    request.system === undefined &&
    request.instructions === undefined
  ) {
    return null
  }
  return {
    version: 1,
    request: compactTraceSemanticValue(boundedTraceValue(request).value) as TraceJsonRecord,
  }
}

function parseTraceRequestValue(body: unknown): TraceJsonRecord | null {
  if (isTraceRecord(body)) return body
  if (typeof body !== 'string') return null
  const trimmed = body.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return isTraceRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function compactTraceSemanticValue(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY_RE.test(key)) return '[redacted]'
  if (Array.isArray(value)) return value.map(entry => compactTraceSemanticValue(entry))
  if (!isTraceRecord(value)) {
    return typeof value === 'string' ? redactSecretsInText(value) : value
  }

  if (value.type === 'image' && isTraceRecord(value.source)) {
    const source = value.source
    if (source.type === 'base64' && typeof source.data === 'string') {
      const decoded = Buffer.from(source.data, 'base64')
      return {
        ...Object.fromEntries(
          Object.entries(value)
            .filter(([entryKey]) => entryKey !== 'source')
            .map(([entryKey, entryValue]) => [entryKey, compactTraceSemanticValue(entryValue, entryKey)]),
        ),
        source: {
          type: 'base64',
          ...(typeof source.media_type === 'string' ? { media_type: source.media_type } : {}),
          bytes: decoded.byteLength,
          sha256: createHash('sha256').update(decoded).digest('hex'),
        },
      }
    }
  }

  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      compactTraceSemanticValue(entryValue, entryKey),
    ]),
  )
}

function isTraceRecord(value: unknown): value is TraceJsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Wait for all in-flight trace appends (including their index projections) to
 * finish. Test teardown should drain before clearing state: a background
 * projection still running after `clearTraceCaptureStateForTests` would
 * re-open the index database and hold a file handle past the temp dir
 * removal on Windows.
 */
export async function drainTraceCaptureForTests(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const pending = [...traceWriteQueues.values(), ...[...projectionJobs.values()].map(job => job.promise)]
    if (pending.length === 0 && traceBackfillScheduled.size === 0) return
    await Promise.allSettled([...pending, traceBackfillQueue])
  }
}
export function clearTraceCaptureStateForTests(): void {
  traceWriteQueues.clear()
  traceReadCache.clear()
  canonicalTraceRevisions.clear()
  traceBackfillScheduled.clear()
  for (const job of projectionJobs.values()) job.controller.abort()
  projectionJobs.clear()
  projectionWorkQueues.clear()
  traceBackfillQueue = Promise.resolve()
  for (const state of traceIndexStates.values()) state.database.close()
  traceIndexStates.clear()
  unavailableTraceIndexPaths.clear()
  traceIndexBusyCooldownUntil.clear()
  traceAppendBeforeWriteHookForTests = null
  traceProjectionAfterIndexHookForTests = null
  traceFullSnapshotAfterReadHookForTests = null
  traceCaptureDiagnostics.fullJsonlBytesRead = 0
  traceCaptureDiagnostics.incrementalJsonlBytesRead = 0
  traceCaptureDiagnostics.fingerprintBytesRead = 0
  traceCaptureDiagnostics.appendedEntriesProjected = 0
  traceCaptureDiagnostics.shadowComparisons = 0
  traceCaptureDiagnostics.shadowMismatches = 0
}

export function setTraceAppendBeforeWriteHookForTests(
  hook: (() => Promise<void>) | null,
): void {
  traceAppendBeforeWriteHookForTests = hook
}

export function setTraceProjectionAfterIndexHookForTests(
  hook: ((target: TraceIndexTarget) => Promise<void>) | null,
): void {
  traceProjectionAfterIndexHookForTests = hook
}

export function setTraceFullSnapshotAfterReadHookForTests(
  hook: (() => Promise<void>) | null,
): void {
  traceFullSnapshotAfterReadHookForTests = hook
}

export function getTraceCaptureDiagnosticsForTests(): Readonly<typeof traceCaptureDiagnostics> {
  return { ...traceCaptureDiagnostics }
}

export function createTraceCallId(): string {
  return randomUUID()
}

class TraceCaptureService {
  async recordCall(input: RecordTraceCallInput): Promise<TraceCallRecord | null> {
    if (input.sessionId.length > 512 || !input.sessionId.trim()) return null
    if (!isTraceCaptureEnabled()) return null

    const startedAt = input.startedAt ?? new Date().toISOString()
    const completedAt = input.completedAt
    const record: TraceCallRecord = {
      id: input.id ?? createTraceCallId(),
      sessionId: input.sessionId,
      source: input.source,
      ...(input.querySource ? { querySource: input.querySource } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
      status: input.status ?? inferCallStatus(input),
      startedAt,
      ...(completedAt ? { completedAt } : {}),
      ...(typeof input.durationMs === 'number' ? { durationMs: input.durationMs } : {}),
      ...(input.metadata ? { metadata: sanitizeMetadata(input.metadata) } : {}),
      request: {
        method: input.request.method ?? 'POST',
        url: sanitizeUrl(input.request.url ?? ''),
        headers: sanitizeHeaders(input.request.headers),
        body: input.request.bodySnapshot ? boundedBodySnapshot(input.request.bodySnapshot) : createTraceBodySnapshot(input.request.body ?? null),
        ...createRequestSemanticField(input.request.body, input.source),
      },
      ...(input.response
        ? {
            response: {
              status: input.response.status,
              headers: sanitizeHeaders(input.response.headers),
              body: input.response.bodySnapshot ? boundedBodySnapshot(input.response.bodySnapshot) : createTraceBodySnapshot(input.response.body ?? null),
            },
          }
        : {}),
      ...(input.error ? { error: normalizeTraceError(input.error) } : {}),
    }

    await appendTraceEntry(record.sessionId, { type: 'call', record })
    return record
  }

  async recordEvent(input: RecordTraceEventInput): Promise<TraceEventRecord | null> {
    if (input.sessionId.length > 512 || !input.sessionId.trim()) return null
    if (!isTraceCaptureEnabled()) return null

    const event: TraceEventRecord = {
      id: input.id ?? randomUUID(),
      sessionId: input.sessionId,
      timestamp: input.timestamp ?? new Date().toISOString(),
      phase: input.phase,
      severity: input.severity ?? 'info',
      ...(input.callId ? { callId: input.callId } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.title ? { title: input.title.slice(0, 256) } : {}),
      ...(input.message ? { message: redactSecretsInText(input.message) } : {}),
      ...(input.metadata ? { metadata: sanitizeMetadata(input.metadata) } : {}),
    }

    await appendTraceEntry(event.sessionId, { type: 'event', event })
    return event
  }

  async getSessionTrace(sessionId: string): Promise<TraceSession> {
    syncTraceIndexMode()
    const context = currentTraceScopeContext()
    const { calls, events } = await readTraceEntries(sessionId, context)
    return {
      sessionId,
      summary: summarizeCalls(calls),
      calls,
      events,
    }
  }

  /**
   * Trace page read path. Unlike `getSessionTrace`, this does not hydrate the
   * complete JSONL: calls come back as locator shells (identity/timing/status/body
   * sizes only) and the detail pane fetches one full call at a time through
   * `getSessionTraceCall`.
   * When the index is off or the projection cannot be served, a streaming scan returns
   * the same lightweight shape without retaining full call bodies.
   */
  async getSessionTraceFile(sessionId: string): Promise<{ path: string } | null> {
    const filePath = getTraceFilePath(sanitizeTraceFileName(sessionId), currentTraceScopeContext())
    try { await fs.stat(filePath); return { path: filePath } }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async getSessionTraceOverview(sessionId: string, options: TraceOverviewOptions = {}): Promise<TraceSession> {
    options.signal?.throwIfAborted()
    const mode = syncTraceIndexMode()
    const context = currentTraceScopeContext()
    const normalizedSessionId = sanitizeTraceFileName(sessionId)
    const filePath = getTraceFilePath(normalizedSessionId, context)
    const scan = await resolveTraceScan(filePath, options)
    try {
      if (mode === 'on') {
        const projected = await readProjectedSessionTrace(sessionId, context, options, scan)
        if (projected) return projected
      }
      const snapshot = await readStableTraceProjection(filePath, undefined, scan)
      if (!snapshot) throw new Error('Trace changed while loading; retry the request')
      const window = traceWindowMetadata(snapshot, snapshot.calls.length, snapshot.events.length, options)
      const calls = snapshot.calls.map(locator => shellTraceCallFromLocator(normalizedSessionId, locator))
      const summary = summarizeCalls(calls)
      return {
        sessionId: normalizedSessionId, window,
        summary: { ...summary, models: summary.models.slice(0, 64), failedCalls: snapshot.calls.filter(call => call.failed).length },
        calls: calls.slice(window.offset, window.offset + window.limit),
        events: snapshot.events.slice(window.offset, window.offset + window.limit).map(event => traceEventShell(normalizedSessionId, event)),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { sessionId: normalizedSessionId, summary: emptyTraceSummary(), calls: [], events: [] }
      }
      throw error
    }
  }

  /**
   * Captured calls whose start time lies in `[from, to]`, oldest first, at
   * most `TRACE_NEAR_LIMIT`. Small, fully indexed captures answer from the
   * SQLite index; everything else (index off, capture larger than one index
   * window) uses a time-directed bounded scan, so the lookup does not depend
   * on which overview window happens to be indexed.
   */
  async getSessionTraceCallsNear(
    sessionId: string,
    options: { from: string; to: string; signal?: AbortSignal },
  ): Promise<TraceCallsNearResult> {
    options.signal?.throwIfAborted()
    const fromMs = Date.parse(options.from)
    const toMs = Date.parse(options.to)
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs || toMs - fromMs > TRACE_NEAR_MAX_WINDOW_MS) {
      throw traceResourceError('TRACE_NEAR_INVALID_WINDOW', 'from/to must be ISO timestamps with from <= to and a window of at most one hour')
    }
    const mode = syncTraceIndexMode()
    const context = currentTraceScopeContext()
    const normalizedSessionId = sanitizeTraceFileName(sessionId)
    const filePath = getTraceFilePath(normalizedSessionId, context)
    let stat: Stats
    try {
      stat = await fs.stat(filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { calls: [], captured: false }
      throw error
    }
    const window = { fromMs, toMs, fromIso: new Date(fromMs).toISOString(), toIso: new Date(toMs).toISOString() }
    if (mode === 'on' && stat.size <= TRACE_WINDOW_BYTES_LIMIT) {
      const indexed = await readIndexedTraceCallsNear(normalizedSessionId, filePath, stat, window, context.target, options.signal)
      if (indexed) return indexed
    }
    try {
      return await scanTraceCallsNear(normalizedSessionId, filePath, window, options.signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { calls: [], captured: false }
      throw error
    }
  }

  async getSessionTraceCall(sessionId: string, callId: string, options: Pick<TraceOverviewOptions, 'scanCursor' | 'signal'> & { at?: [number, number] } = {}): Promise<TraceCallRecord | null> {
    const mode = syncTraceIndexMode()
    const context = currentTraceScopeContext()
    // A byte locator from the near lookup reaches calls outside the indexed
    // overview window; a stale or mismatched locator falls through.
    if (options.at) {
      const located = await readTraceCallAt(sessionId, callId, options.at, context)
      if (located) return located
    }
    const scan = options.scanCursor
      ? await resolveTraceScan(getTraceFilePath(sanitizeTraceFileName(sessionId), context), options)
      : { signal: options.signal }
    if (mode === 'off') return readCanonicalTraceCall(sessionId, callId, context, scan)

    if (mode === 'shadow') {
      const canonical = await readCanonicalTraceCall(sessionId, callId, context, scan)
      const projected = await readProjectedTraceCall(sessionId, callId, context, scan)
      recordTraceShadowComparison(traceCallMatches(canonical, projected))
      return canonical
    }

    return await readProjectedTraceCall(sessionId, callId, context, scan)
      ?? await readCanonicalTraceCall(sessionId, callId, context, scan)
  }

  async getSessionTraceRevision(
    sessionId: string,
    sinceRevision?: number,
    sinceRevisionToken?: string,
  ): Promise<TraceSessionRevision> {
    const normalizedSessionId = sanitizeTraceFileName(sessionId)
    const context = currentTraceScopeContext()
    const target = context.target
    const filePath = getTraceFilePath(normalizedSessionId, context)
    let stat: Stats
    try {
      stat = await fs.stat(filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      withTraceIndex(index => index.deleteSession(normalizedSessionId), target)
      canonicalTraceRevisions.delete(filePath)
      return traceRevisionResult(
        normalizedSessionId,
        0,
        'missing',
        sinceRevision,
        sinceRevisionToken,
        sinceRevision !== undefined && sinceRevision !== 0,
      )
    }

    const mode = syncTraceIndexMode()
    if (mode !== 'on') {
      const canonical = await ensureCanonicalTraceRevision(filePath, stat)
      if (mode === 'shadow') {
        const projection = await ensureTraceProjection(
          normalizedSessionId,
          filePath,
          stat,
          0,
          target,
        )
        recordTraceShadowComparison(Boolean(
          projection &&
          projection.size === canonical.fingerprint.size &&
          projection.mtimeMs === canonical.fingerprint.mtimeMs &&
          projection.fileIdentity === canonical.fingerprint.fileIdentity,
        ))
      }
      return traceRevisionResult(
        normalizedSessionId,
        canonical.revision,
        canonicalRevisionToken(canonical),
        sinceRevision,
        sinceRevisionToken,
        false,
      )
    }

    // Polling a continuation window must not silently replace it with the
    // first window and force the UI into rebuilding both on every poll.
    const currentWindow = getTraceIndex(target)?.getSource(normalizedSessionId)?.windowStartByte ?? 0
    const projection = await ensureTraceProjection(
      normalizedSessionId,
      filePath,
      stat,
      0,
      target,
      { byteStart: currentWindow },
    )
    if (projection) {
      return traceRevisionResult(
        normalizedSessionId,
        projection.revision,
        projectedRevisionToken(projection),
        sinceRevision,
        sinceRevisionToken,
        sinceRevision !== undefined && (
          sinceRevision < projection.lastResetRevision || sinceRevision > projection.revision
        ),
      )
    }

    const canonical = await ensureCanonicalTraceRevision(filePath, stat)
    return traceRevisionResult(
      normalizedSessionId,
      canonical.revision,
      canonicalRevisionToken(canonical),
      sinceRevision,
      sinceRevisionToken,
      sinceRevision !== undefined && sinceRevision !== canonical.revision,
    )
  }

  async deleteSessionTrace(sessionId: string): Promise<TraceSessionDeleteResult> {
    syncTraceIndexMode()
    const normalizedSessionId = sanitizeTraceFileName(sessionId)
    if (!normalizedSessionId) return { sessionId: normalizedSessionId, deleted: false }

    const context = currentTraceScopeContext()
    const { scope, target } = context
    const pendingWrite = traceWriteQueues.get(`${scope}\0${normalizedSessionId}`)
    if (pendingWrite) await pendingWrite.catch(() => {})

    const filePath = getTraceFilePath(normalizedSessionId, context)
    try {
      await fs.unlink(filePath)
      traceReadCache.delete(filePath)
      canonicalTraceRevisions.delete(filePath)
      withTraceIndex(index => index.deleteSession(normalizedSessionId), target)
      return { sessionId: normalizedSessionId, deleted: true }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        traceReadCache.delete(filePath)
        canonicalTraceRevisions.delete(filePath)
        withTraceIndex(index => index.deleteSession(normalizedSessionId), target)
        return { sessionId: normalizedSessionId, deleted: false }
      }
      throw error
    }
  }

  async listSessionTraces(options?: {
    limit?: number
    offset?: number
    query?: string
    all?: boolean
    sessionIds?: string[]
  }): Promise<TraceSessionList> {
    const mode = syncTraceIndexMode()
    const context = currentTraceScopeContext()
    const { target, storageDir } = context
    const settings = normalizeTraceCaptureSettings(
      await readManagedSettings(context.scope),
      context.scope,
    )
    const all = options?.all === true
    const limit = all ? Number.POSITIVE_INFINITY : clampListLimit(options?.limit ?? 50)
    const offset = all ? 0 : Math.max(0, options?.offset ?? 0)
    const query = options?.query?.trim().toLowerCase() ?? ''
    const sessionIdFilter = options?.sessionIds?.length
      ? new Set(options.sessionIds.map((sessionId) => sanitizeTraceFileName(sessionId)))
      : null
    const files = (await listTraceFiles(storageDir))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const filteredFiles = sessionIdFilter
      ? files.filter((file) => sessionIdFilter.has(file.name.replace(/\.jsonl$/, '')))
      : files
    const matchingFiles = query
      ? filteredFiles.filter((file) => file.name.replace(/\.jsonl$/, '').toLowerCase().includes(query))
      : filteredFiles
    const pageFiles = all ? matchingFiles : matchingFiles.slice(offset, offset + limit)
    const items: TraceSessionListItem[] = []

    for (const file of pageFiles) {
      const sessionId = file.name.replace(/\.jsonl$/, '')
      let trace: Pick<TraceSession, 'sessionId' | 'summary' | 'window'>
      if (mode === 'off') {
        trace = await readCanonicalTraceSummary(sessionId, file.path)
      } else if (mode === 'shadow') {
        const projection = await ensureTraceProjection(
          sessionId,
          file.path,
          file.stat,
          0,
          target,
        )
        const canonical = await readCanonicalTraceSummary(sessionId, file.path)
        recordTraceShadowComparison(Boolean(
          projection && traceSummaryMatches(canonical.summary, projection.summary),
        ))
        trace = canonical
      } else {
        // Read-only: never rebuild a projection on the request path. A page
        // containing unindexed GB-scale JSONL must answer from SQLite (or an
        // empty summary) immediately; the serialized background queue fills
        // the projection in and the next poll picks it up. In-process appends
        // update the index synchronously, so a size/mtime mismatch means an
        // external write the writer path never saw.
        const index = getTraceIndex(target)
        const source = index?.getSource(sessionId) ?? null
        const projection = source && index ? index.getSummary(sessionId) : null
        if (projection) {
          const fingerprint = storedTraceFingerprint(projection)
          trace = { sessionId, summary: projection.summary,
            ...(fingerprint ? { window: traceWindowMetadata({ ...projection, fingerprint }, projection.summary.apiCalls, 0, {}) } : {}),
          }
          if (
            source.state !== 'ready' ||
            source.size !== file.size ||
            source.mtimeMs !== file.stat.mtimeMs
          ) {
            scheduleTraceProjectionBackfill(sessionId, file.path, file.stat, target)
          }
        } else {
          scheduleTraceProjectionBackfill(sessionId, file.path, file.stat, target)
          trace = { sessionId, summary: emptyTraceSummary() }
        }
      }
      const updatedAt = trace.summary.updatedAt ?? file.updatedAt
      items.push({
        sessionId: trace.sessionId || sessionId,
        ...(trace.window ? { window: trace.window } : {}),
        summary: trace.summary.updatedAt
          ? trace.summary
          : { ...trace.summary, updatedAt },
        fileSize: file.size,
        fileUpdatedAt: file.updatedAt,
      })
    }

    items.sort((a, b) => {
      const aTime = a.summary.updatedAt ?? a.fileUpdatedAt
      const bTime = b.summary.updatedAt ?? b.fileUpdatedAt
      return bTime.localeCompare(aTime)
    })

    return {
      traces: items,
      total: matchingFiles.length,
      storageDir,
      settings,
    }
  }

  async listSessionTraceFiles(): Promise<TraceSessionFileList> {
    const context = currentTraceScopeContext()
    const { storageDir } = context
    const settings = normalizeTraceCaptureSettings(
      await readManagedSettings(context.scope),
      context.scope,
    )
    const files = (await listTraceFiles(storageDir))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

    return {
      files: files.map((file) => ({
        sessionId: file.name.replace(/\.jsonl$/, ''),
        fileSize: file.size,
        fileUpdatedAt: file.updatedAt,
      })),
      total: files.length,
      storageDir,
      settings,
    }
  }
}

export const traceCaptureService = new TraceCaptureService()

export type TraceResponseCapture = {
  snapshot: TraceBodySnapshot
  aborted: boolean
  abortReason?: unknown
}

export const TRACE_ABORT_CAPTURE_GRACE_MS = 2000

export async function readResponseTraceSnapshot(response: Response): Promise<TraceBodySnapshot> {
  return (await captureResponseTraceSnapshot(response)).snapshot
}

/**
 * Reads a response body into a trace snapshot, ending promptly when `signal`
 * aborts (SDK client timeout, stream idle watchdog, user cancellation).
 * Without this, an aborted upstream stream can leave the read pending forever
 * and the trace call stuck in `pending` (#766). On abort the partial body is
 * returned with `aborted: true` so callers can record an error-state call.
 */
export async function captureResponseTraceSnapshot(
  response: Response,
  options?: { signal?: AbortSignal; abortGraceMs?: number },
): Promise<TraceResponseCapture> {
  const signal = options?.signal
  const contentType = response.headers.get('content-type') ?? ''
  const isEventStream = contentType.toLowerCase().includes('text/event-stream')
  if (!response.body) {
    return { snapshot: createTraceBodySnapshot(null), aborted: false }
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  let truncated = false
  let completed = false
  let interrupted = false
  let onAbort: (() => void) | undefined
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let sseBuffer = ''
  let sseEvent = ''
  let sseDataLines: string[] = []

  const observeResponsesTerminal = (chunk: string): boolean => {
    if (!isEventStream) return false
    sseBuffer += chunk
    let newline = sseBuffer.indexOf('\n')
    while (newline !== -1) {
      const rawLine = sseBuffer.slice(0, newline)
      sseBuffer = sseBuffer.slice(newline + 1)
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (line === '') {
        let event = sseEvent
        if (!event && sseDataLines.length > 0) {
          try {
            const data = JSON.parse(sseDataLines.join('\n')) as { type?: unknown }
            if (typeof data.type === 'string') event = data.type
          } catch {
            // A malformed or non-JSON SSE event cannot be a Responses terminal.
          }
        }
        sseEvent = ''
        sseDataLines = []
        if (
          event === 'response.completed' ||
          event === 'response.failed' ||
          event === 'response.incomplete' ||
          event === 'response.cancelled' ||
          event === 'error'
        ) {
          return true
        }
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        let value = colon === -1 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'event') sseEvent = value
        if (field === 'data') sseDataLines.push(value)
      }
      newline = sseBuffer.indexOf('\n')
    }
    return false
  }

  const readAll = async (): Promise<'done'> => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        completed = true
        break
      }
      const remaining = TRACE_STREAM_CAPTURE_BYTES - bytes
      const captured = value.subarray(0, Math.max(0, remaining))
      bytes += captured.byteLength
      const decoded = decoder.decode(captured, { stream: true })
      text += decoded
      const budgetReached = value.byteLength > remaining || bytes >= TRACE_STREAM_CAPTURE_BYTES
      if (budgetReached) truncated = true
      // OpenAI Responses defines its own terminal event. Treat that as the
      // request's one-shot terminal state instead of waiting for HTTP EOF:
      // callers commonly cancel/drop the body immediately after completed,
      // and some upstreams keep the socket open indefinitely afterwards.
      if (observeResponsesTerminal(decoded)) {
        completed = true
        void reader.cancel('Responses terminal event captured').catch(() => {})
        break
      }
      if (budgetReached) {
        completed = true
        void reader.cancel('Trace capture byte budget reached').catch(() => {})
        break
      }
    }
    return 'done'
  }

  // Resolves only when the abort grace period expires with the read still
  // hung. Spec-compliant runtimes resolve the pending read() with done after
  // reader.cancel(), letting readAll() win the race; the timer is the
  // backstop for runtimes where cancel() does not wake a pending read.
  const forcedAbort = new Promise<'forced'>((resolve) => {
    if (!signal) return
    onAbort = () => {
      if (completed) return
      interrupted = true
      void reader.cancel().catch(() => {})
      // This promise awaits the backstop; keep its timer referenced so Bun on
      // Windows can fire it even when the pending stream read never settles.
      graceTimer = setTimeout(() => resolve('forced'), options?.abortGraceMs ?? TRACE_ABORT_CAPTURE_GRACE_MS)
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })

  try {
    await Promise.race([readAll(), forcedAbort])
  } catch (err) {
    // Some runtimes reject the pending read() on abort instead of resolving
    // it after cancel(); fold that into the aborted outcome. Genuine read
    // failures (no abort in flight) propagate to the caller.
    if (!interrupted && !signal?.aborted) throw err
    interrupted = true
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
    if (graceTimer) clearTimeout(graceTimer)
    try {
      reader.releaseLock()
    } catch {
      // A still-pending read keeps the lock; the reader is abandoned with it.
    }
  }

  text += decoder.decode()
  const snapshot = createTraceBodySnapshot(
    contentType.includes('application/json') ? parseJsonOrText(text) : text,
    { alreadyTruncated: truncated || interrupted },
  )
  return {
    snapshot,
    aborted: interrupted,
    ...(interrupted && signal?.reason !== undefined ? { abortReason: signal.reason } : {}),
  }
}

function serializeTraceBody(body: unknown): { serialized: string; contentType: TraceBodySnapshot['contentType'] } {
  if (body === null || body === undefined) {
    return { serialized: '', contentType: 'empty' }
  }

  if (typeof body === 'string') {
    const parsed = parseJsonOrText(body)
    if (typeof parsed !== 'string') {
      return {
        serialized: JSON.stringify(redactSensitiveValue(parsed), null, 2),
        contentType: 'json',
      }
    }
    return { serialized: redactSecretsInText(body), contentType: 'text' }
  }

  try {
    return {
      serialized: JSON.stringify(redactSensitiveValue(body), null, 2),
      contentType: 'json',
    }
  } catch {
    return { serialized: redactSecretsInText(String(body)), contentType: 'text' }
  }
}

function parseJsonOrText(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return text
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text
  try {
    return JSON.parse(trimmed)
  } catch {
    return text
  }
}

function redactSensitiveValue(value: unknown, key = ''): unknown {
  return redactBoundedValue(boundedTraceValue(value).value, key)
}

function redactBoundedValue(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY_RE.test(key)) return '[redacted]'
  if (Array.isArray(value)) return value.map((entry) => redactBoundedValue(entry))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactBoundedValue(entryValue, entryKey),
      ]),
    )
  }
  if (typeof value === 'string') return redactSecretsInText(value)
  return value
}

function redactSecretsInText(value: string): string {
  if (value.length > TRACE_CAPTURE_CHAR_LIMIT) return '[trace capture omitted: string-budget]'
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/g, 'sk-[redacted]')
}

function sanitizeHeaders(headers: Headers | Record<string, string> | null | undefined): Record<string, string> {
  if (!headers) return {}
  const entries = headers instanceof Headers
    ? Array.from(headers.entries())
    : Object.entries(boundedTraceValue(headers).value as Record<string, unknown>)

  return Object.fromEntries(
    entries.map(([key, value]) => [
      key,
      SENSITIVE_KEY_RE.test(key) ? '[redacted]' : redactSecretsInText(String(value)),
    ]),
  )
}

function sanitizeUrl(url: string): string {
  if (!url) return ''
  if (url.length > 8192) return '[trace URL omitted: string-budget]'
  try {
    const parsed = new URL(url)
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_KEY_RE.test(key)) {
        parsed.searchParams.set(key, '[redacted]')
      }
    }
    return parsed.toString()
  } catch {
    return url
  }
}

function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return redactSensitiveValue(metadata) as Record<string, unknown>
}

function inferCallStatus(input: RecordTraceCallInput): TraceCallStatus {
  if (input.status) return input.status
  if (input.error) return 'error'
  if (!input.response && !input.completedAt) return 'pending'
  if ((input.response?.status ?? 200) >= 400) return 'error'
  return 'ok'
}

function normalizeTraceError(error: unknown): TraceCallRecord['error'] {
  if (error instanceof Error) {
    const code = typeof (error as NodeJS.ErrnoException).code === 'string'
      ? (error as NodeJS.ErrnoException).code
      : undefined
    const cause = 'cause' in error && error.cause !== undefined
      ? redactSecretsInText(String(error.cause))
      : undefined
    return {
      name: error.name,
      message: redactSecretsInText(error.message),
      ...(code ? { code } : {}),
      ...(error.stack ? { stack: redactSecretsInText(error.stack) } : {}),
      ...(cause ? { cause } : {}),
    }
  }
  return { name: typeof error, message: redactSecretsInText(String(error)) }
}

function closeTraceIndexes(): void {
  const states = [...traceIndexStates.values()]
  traceIndexStates.clear()
  for (const state of states) {
    try {
      state.database.close()
    } catch {
      // The projection is disposable; canonical JSONL remains available.
    }
  }
}

const TRACE_INDEX_BUSY_COOLDOWN_MS = 5_000

function isTraceIndexBusy(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' && (
    code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')
  )
}

function isTraceIndexSqliteFailure(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' && code.startsWith('SQLITE_')
}

function quarantineTraceIndexFailure(
  target: TraceIndexTarget,
  error: unknown,
): void {
  const failed = traceIndexStates.get(target.path)
  traceIndexStates.delete(target.path)
  try {
    failed?.database.close()
  } catch {
    // JSONL remains canonical even if the projection cannot close cleanly.
  }
  if (isTraceIndexBusy(error)) {
    traceIndexBusyCooldownUntil.set(
      target.path,
      Date.now() + TRACE_INDEX_BUSY_COOLDOWN_MS,
    )
  } else {
    unavailableTraceIndexPaths.add(target.path)
  }
}

function syncTraceIndexMode(): LocalIndexMode {
  const mode = resolveLocalIndexMode().mode
  if (mode === 'off') {
    closeTraceIndexes()
    traceIndexBusyCooldownUntil.clear()
    unavailableTraceIndexPaths.clear()
  }
  return mode
}

function getTraceIndex(target = currentTraceIndexTarget()): TraceIndex | null {
  if (syncTraceIndexMode() === 'off') return null
  const databasePath = target.path
  if ((traceIndexBusyCooldownUntil.get(databasePath) ?? 0) > Date.now()) return null
  traceIndexBusyCooldownUntil.delete(databasePath)
  const existing = traceIndexStates.get(databasePath)
  if (existing) return existing.index
  if (unavailableTraceIndexPaths.has(databasePath)) return null

  try {
    const database = openTraceIndexDatabase({
      path: databasePath,
      scope: target.scope,
    })
    const index = createTraceIndex(database)
    traceIndexStates.set(databasePath, { path: databasePath, database, index })
    return index
  } catch (error) {
    quarantineTraceIndexFailure(target, error)
    return null
  }
}

function recordTraceShadowComparison(matches: boolean): void {
  traceCaptureDiagnostics.shadowComparisons += 1
  if (!matches) traceCaptureDiagnostics.shadowMismatches += 1
}

function traceSummaryMatches(
  canonical: TraceSessionSummary,
  projected: TraceSessionSummary,
): boolean {
  return JSON.stringify(canonical) === JSON.stringify(projected)
}

function traceCallMatches(
  canonical: TraceCallRecord | null,
  projected: TraceCallRecord | null,
): boolean {
  if (!canonical || !projected) return canonical === projected
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex') ===
    createHash('sha256').update(JSON.stringify(projected)).digest('hex')
}

function projectedRevisionToken(projection: TraceSessionOverview): string {
  return `db:${projection.resetToken}:${projection.revision}`
}

function canonicalRevisionToken(state: CanonicalTraceRevisionState): string {
  const fingerprintHash = createHash('sha256')
    .update(serializeSourceFingerprint(state.fingerprint))
    .digest('hex')
  return `file:${state.resetToken}:${fingerprintHash}`
}

function revisionResetKey(token: string): string {
  const separator = token.lastIndexOf(':')
  return separator < 0 ? token : token.slice(0, separator)
}

function traceRevisionResult(
  sessionId: string,
  revision: number,
  revisionToken: string,
  sinceRevision: number | undefined,
  sinceRevisionToken: string | undefined,
  legacyReset: boolean,
): TraceSessionRevision {
  const changed = sinceRevisionToken !== undefined
    ? sinceRevisionToken !== revisionToken
    : sinceRevision === undefined || sinceRevision !== revision
  const reset = !changed
    ? false
    : sinceRevisionToken !== undefined
      ? revisionResetKey(sinceRevisionToken) !== revisionResetKey(revisionToken)
      : sinceRevision !== undefined && legacyReset
  return { sessionId, revision, revisionToken, changed, reset }
}

function statDerivedTraceRevision(fingerprint: SourceFingerprint): number {
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.max(1, Math.trunc(fingerprint.mtimeMs * 1000) + fingerprint.size),
  )
}

async function ensureCanonicalTraceRevision(
  filePath: string,
  stat: Stats,
  attempt = 0,
): Promise<CanonicalTraceRevisionState> {
  const previous = canonicalTraceRevisions.get(filePath)
  if (previous) {
    const change = await detectTraceSourceChange(filePath, previous.fingerprint)
    if (change.kind === 'unchanged') return previous
    if (change.kind === 'deleted') {
      canonicalTraceRevisions.delete(filePath)
      throw Object.assign(new Error('Trace source deleted'), { code: 'ENOENT' })
    }
    if (change.kind === 'retry' && attempt < 1) {
      return ensureCanonicalTraceRevision(filePath, await fs.stat(filePath), attempt + 1)
    }
    const currentStat = await fs.stat(filePath)
    const fingerprint = await captureTraceFingerprint(filePath, currentStat.size)
    const derived = statDerivedTraceRevision(fingerprint)
    const state = {
      fingerprint,
      resetToken: change.kind === 'append' ? previous.resetToken : randomUUID(),
      revision: change.kind === 'append' && derived === previous.revision
        ? Math.min(Number.MAX_SAFE_INTEGER, previous.revision + 1)
        : derived,
    }
    canonicalTraceRevisions.set(filePath, state)
    return state
  }

  const fingerprint = await captureTraceFingerprint(filePath, stat.size)
  const state = {
    fingerprint,
    resetToken: randomUUID(),
    revision: statDerivedTraceRevision(fingerprint),
  }
  canonicalTraceRevisions.set(filePath, state)
  return state
}

function withTraceIndex<T>(
  operation: (index: TraceIndex) => T,
  target = currentTraceIndexTarget(),
): T | undefined {
  const index = getTraceIndex(target)
  if (!index) return undefined
  try {
    return operation(index)
  } catch (error) {
    quarantineTraceIndexFailure(target, error)
    return undefined
  }
}

function toTraceCallLocator(
  call: TraceCallRecord,
  ordinal: number,
  byteStart: number,
  byteLength: number,
  firstOrdinal = ordinal,
): TraceCallLocator {
  const hydrated = attachCallUsage(call)
  return {
    id: hydrated.id,
    ordinal,
    firstOrdinal,
    byteStart,
    byteLength,
    startedAt: hydrated.startedAt,
    completedAt: hydrated.completedAt ?? null,
    status: hydrated.status ?? 'ok',
    source: hydrated.source,
    model: hydrated.model ?? null,
    durationMs: hydrated.durationMs ?? null,
    failed: hydrated.status === 'error'
      || Boolean(hydrated.error)
      || (hydrated.response?.status ?? 200) >= 400,
    inputTokens: hydrated.usage?.inputTokens ?? 0,
    outputTokens: hydrated.usage?.outputTokens ?? 0,
    requestBytes: hydrated.request.body.bytes,
    responseBytes: hydrated.response?.body.bytes ?? null,
    responseStatus: hydrated.response?.status ?? null,
  }
}

function toTraceEventLocator(
  event: TraceEventRecord,
  ordinal: number,
  byteStart: number,
  byteLength: number,
): TraceEventLocator {
  return {
    id: event.id,
    ordinal,
    byteStart,
    byteLength,
    timestamp: event.timestamp,
    phase: event.phase,
    severity: event.severity,
    callId: event.callId ?? null,
    source: event.source ?? null,
    model: event.model ?? null,
    title: event.title ?? null,
    message: event.message ?? null,
  }
}

type ParsedTraceBuffer = {
  calls: TraceCallRecord[]
  events: TraceEventRecord[]
  callLocators: TraceCallLocator[]
  eventLocators: TraceEventLocator[]
  indexedBytes: number
  nextOrdinal: number
}

function parseTraceBuffer(
  raw: Buffer,
  options?: { byteStart?: number; ordinal?: number },
): ParsedTraceBuffer {
  const callsById = new Map<string, TraceCallRecord>()
  const callLocatorsById = new Map<string, TraceCallLocator>()
  const events: TraceEventRecord[] = []
  const eventLocators: TraceEventLocator[] = []
  const baseByteStart = options?.byteStart ?? 0
  let lineStart = 0
  let ordinal = options?.ordinal ?? 0
  let indexedBytes = baseByteStart
  let nextOrdinal = ordinal

  const parseLine = (end: number, complete: boolean) => {
    if (ordinal - (options?.ordinal ?? 0) >= TRACE_WINDOW_RECORD_LIMIT) {
      throw traceResourceError('TRACE_RECORD_TOO_LARGE', 'Full trace hydration exceeds the record budget; use overview pages or raw download')
    }
    if (end - lineStart > TRACE_RECORD_BYTES_LIMIT) {
      throw traceResourceError('TRACE_RECORD_TOO_LARGE', 'Trace record exceeds 2 MiB; use raw download')
    }
    const line = raw.subarray(lineStart, end).toString('utf-8')
    if (line.trim()) {
      let entry: TraceFileEntry | undefined
      try {
        entry = JSON.parse(line) as TraceFileEntry
      } catch {
        entry = undefined
      }
      if (entry && typeof entry === 'object') {
        const byteLength = end - lineStart + (complete ? 1 : 0)
        if ('type' in entry && entry.type === 'event') {
          if (isTraceEventRecordLike(entry.event)) {
            events.push(entry.event)
            if (complete) {
              eventLocators.push(toTraceEventLocator(
                entry.event,
                ordinal,
                baseByteStart + lineStart,
                byteLength,
              ))
            }
          }
        } else {
          const call = 'type' in entry && entry.type === 'call' ? entry.record : entry
          if (isTraceCallRecordLike(call)) {
            callsById.set(call.id, attachCallUsage(call))
            if (complete) {
              const firstOrdinal = callLocatorsById.get(call.id)?.firstOrdinal ?? ordinal
              callLocatorsById.set(
                call.id,
                toTraceCallLocator(
                  call,
                  ordinal,
                  baseByteStart + lineStart,
                  byteLength,
                  firstOrdinal,
                ),
              )
            }
          }
        }
      }
    }
    if (complete) nextOrdinal = ordinal + 1
    ordinal += 1
  }

  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== 0x0a) continue
    parseLine(index, true)
    indexedBytes = baseByteStart + index + 1
    lineStart = index + 1
  }
  if (lineStart < raw.length) parseLine(raw.length, false)

  return {
    calls: [...callsById.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    events: events.sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    callLocators: [...callLocatorsById.values()].sort((a, b) =>
      a.startedAt.localeCompare(b.startedAt) ||
      (a.firstOrdinal ?? a.ordinal) - (b.firstOrdinal ?? b.ordinal)),
    eventLocators: eventLocators.sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp) || a.ordinal - b.ordinal),
    indexedBytes,
    nextOrdinal,
  }
}

function emptyFingerprintMetrics(): LocalIndexIoMetrics {
  return { filesOpened: 0, bytesRead: 0, statCalls: 0 }
}

async function captureTraceFingerprint(
  filePath: string,
  indexedBytes: number,
): Promise<SourceFingerprint> {
  const metrics = emptyFingerprintMetrics()
  try {
    return await captureSourceFingerprint({
      path: filePath,
      indexedBytes,
      parserVersion: TRACE_INDEX_PARSER_VERSION,
      metrics,
    })
  } finally {
    traceCaptureDiagnostics.fingerprintBytesRead += metrics.bytesRead
  }
}

async function detectTraceSourceChange(
  filePath: string,
  previous: SourceFingerprint,
) {
  const metrics = emptyFingerprintMetrics()
  try {
    return await detectSourceChange({
      path: filePath,
      previous,
      parserVersion: TRACE_INDEX_PARSER_VERSION,
      metrics,
    })
  } finally {
    traceCaptureDiagnostics.fingerprintBytesRead += metrics.bytesRead
  }
}

function storedTraceFingerprint(
  source: ReturnType<TraceIndex['getSource']> & {},
): SourceFingerprint | null {
  if (!source?.fingerprint) return null
  const fingerprint = deserializeSourceFingerprint(source.fingerprint)
  if (!fingerprint) return null
  return fingerprint.size === source.size &&
    fingerprint.mtimeMs === source.mtimeMs &&
    fingerprint.fileIdentity === source.fileIdentity &&
    fingerprint.indexedBytes === source.indexedBytes &&
    fingerprint.parserVersion === TRACE_INDEX_PARSER_VERSION
    ? fingerprint
    : null
}

function traceSourceInput(
  sessionId: string,
  filePath: string,
  fingerprint: SourceFingerprint,
  nextOrdinal: number,
) {
  return {
    sessionId,
    filePath,
    size: fingerprint.size,
    mtimeMs: fingerprint.mtimeMs,
    indexedBytes: fingerprint.indexedBytes,
    fileIdentity: fingerprint.fileIdentity,
    fingerprint: serializeSourceFingerprint(fingerprint),
    pendingTailBytes: fingerprint.size - fingerprint.indexedBytes,
    nextOrdinal,
  }
}

function hashBufferWindow(raw: Buffer, end: number): string {
  const length = Math.min(TRACE_FINGERPRINT_WINDOW_BYTES, end)
  return createHash('sha256').update(raw.subarray(end - length, end)).digest('hex')
}

type StableFullTraceSnapshot = {
  raw: Buffer
  parsed: ParsedTraceBuffer
  fingerprint: SourceFingerprint | null
}

function traceFileIdentity(stats: Pick<Stats, 'dev' | 'ino'>): string | null {
  if (process.platform === 'win32' || stats.ino === 0) return null
  return `${stats.dev}:${stats.ino}`
}

function sameTraceFileSnapshot(left: Stats, right: Stats): boolean {
  const leftIdentity = traceFileIdentity(left)
  const rightIdentity = traceFileIdentity(right)
  return left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    (leftIdentity === null || rightIdentity === null || leftIdentity === rightIdentity)
}

async function readStableFullTraceSnapshot(
  filePath: string,
): Promise<StableFullTraceSnapshot> {
  const handle = await fs.open(filePath, 'r')
  let closed = false
  try {
    const before = await handle.stat()
    if (before.size > TRACE_LEGACY_FULL_BYTES_LIMIT) {
      throw traceResourceError('TRACE_RECORD_TOO_LARGE', 'Full trace hydration is limited to 8 MiB; use overview pages or raw download')
    }
    const raw = await handle.readFile()
    traceCaptureDiagnostics.fullJsonlBytesRead += raw.byteLength
    await traceFullSnapshotAfterReadHookForTests?.()
    const parsed = parseTraceBuffer(raw)
    const after = await handle.stat()
    await handle.close()
    closed = true
    const currentPath = await fs.stat(filePath)
    if (
      raw.byteLength !== before.size ||
      !sameTraceFileSnapshot(before, after) ||
      !sameTraceFileSnapshot(after, currentPath)
    ) return { raw, parsed, fingerprint: null }
    const fingerprint: SourceFingerprint = {
      size: before.size,
      mtimeMs: before.mtimeMs,
      ctimeMs: before.ctimeMs,
      fileIdentity: traceFileIdentity(before),
      firstWindowHash: hashBufferWindow(
        raw,
        Math.min(TRACE_FINGERPRINT_WINDOW_BYTES, raw.byteLength),
      ),
      lastWindowHash: hashBufferWindow(raw, raw.byteLength),
      boundaryWindowHash: hashBufferWindow(raw, parsed.indexedBytes),
      indexedBytes: parsed.indexedBytes,
      parserVersion: TRACE_INDEX_PARSER_VERSION,
    }
    return { raw, parsed, fingerprint }
  } finally {
    if (!closed) await handle.close()
  }
}

function fingerprintMatchesFullBuffer(
  fingerprint: SourceFingerprint,
  raw: Buffer,
): boolean {
  return fingerprint.size === raw.byteLength &&
    fingerprint.firstWindowHash === hashBufferWindow(
      raw,
      Math.min(TRACE_FINGERPRINT_WINDOW_BYTES, raw.byteLength),
    ) &&
    fingerprint.lastWindowHash === hashBufferWindow(raw, raw.byteLength) &&
    fingerprint.boundaryWindowHash === hashBufferWindow(raw, fingerprint.indexedBytes)
}

async function readTraceRange(
  filePath: string,
  start: number,
  end: number,
  metric: 'incremental' | 'fingerprint' = 'incremental',
): Promise<Buffer> {
  const length = end - start
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error('Invalid trace append range')
  }
  const buffer = Buffer.allocUnsafe(length)
  const handle = await fs.open(filePath, 'r')
  let offset = 0
  try {
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset)
      if (bytesRead < 1) throw new Error('Trace source changed during range read')
      offset += bytesRead
      if (metric === 'incremental') {
        traceCaptureDiagnostics.incrementalJsonlBytesRead += bytesRead
      } else {
        traceCaptureDiagnostics.fingerprintBytesRead += bytesRead
      }
    }
    return buffer
  } finally {
    await handle.close()
  }
}

async function resolveTraceScan(filePath: string, options: TraceOverviewOptions): Promise<TraceScanOptions> {
  if (!options.scanCursor) return { byteStart: 0, ordinal: 0, signal: options.signal }
  try {
    if (options.scanCursor.length > 4096) throw new Error('cursor too large')
    const cursor = JSON.parse(Buffer.from(options.scanCursor, 'base64url').toString('utf8'))
    const fingerprint = deserializeSourceFingerprint(cursor.fingerprint)
    if (!fingerprint || !Number.isSafeInteger(cursor.byteStart) || cursor.byteStart < 0 ||
      !Number.isSafeInteger(cursor.ordinal) || cursor.ordinal < 0 || cursor.byteStart !== fingerprint.indexedBytes ||
      (await detectTraceSourceChange(filePath, fingerprint)).kind !== 'unchanged') throw new Error('stale cursor')
    return { byteStart: cursor.byteStart, ordinal: cursor.ordinal, skipLine: cursor.skipLine === true, signal: options.signal }
  } catch {
    throw traceResourceError('TRACE_PAGE_STALE', 'Trace file changed or cursor is invalid; restart from the first window')
  }
}

function traceWindowMetadata(
  snapshot: { fingerprint: SourceFingerprint; nextOrdinal: number; windowStartByte: number; oversizedRecords: number; scanTruncated: boolean; oversizedContinuation?: boolean; lastErrorCode?: string | null },
  totalCalls: number,
  totalEvents: number,
  options: TraceOverviewOptions,
): TraceSessionWindow {
  const offset = Math.max(0, Math.trunc(options.offset ?? 0))
  const limit = Math.max(1, Math.min(TRACE_OVERVIEW_LIMIT, Math.trunc(options.limit ?? TRACE_OVERVIEW_LIMIT)))
  const fingerprint = serializeSourceFingerprint(snapshot.fingerprint)
  const revisionToken = createHash('sha256').update(`${snapshot.windowStartByte}:${fingerprint}`).digest('hex')
  if (options.revisionToken && options.revisionToken !== revisionToken) {
    throw traceResourceError('TRACE_PAGE_STALE', 'Trace file changed; reload this trace window before paging')
  }
  return {
    offset, limit, totalCalls, totalEvents,
    hasMore: offset + limit < Math.max(totalCalls, totalEvents),
    revisionToken,
    state: snapshot.scanTruncated || snapshot.oversizedRecords > 0 ? 'limited' : 'ready',
    oversizedRecords: snapshot.oversizedRecords,
    startByte: snapshot.windowStartByte,
    scannedBytes: snapshot.fingerprint.indexedBytes - snapshot.windowStartByte,
    fileBytes: snapshot.fingerprint.size,
    recordLimit: TRACE_WINDOW_RECORD_LIMIT,
    recordBytesLimit: TRACE_RECORD_BYTES_LIMIT,
    ...(snapshot.scanTruncated ? { nextScanCursor: Buffer.from(JSON.stringify({
      byteStart: snapshot.fingerprint.indexedBytes,
      ordinal: snapshot.nextOrdinal,
      skipLine: snapshot.oversizedContinuation ?? snapshot.lastErrorCode === 'TRACE_OVERSIZED_RECORD_CONTINUATION',
      fingerprint,
    })).toString('base64url') } : {}),
  }
}

function traceEventShell(sessionId: string, event: TraceEventLocator): TraceEventRecord {
  return {
    id: event.id, sessionId, timestamp: event.timestamp, phase: event.phase,
    severity: event.severity as TraceEventSeverity,
    ...(event.callId ? { callId: event.callId } : {}),
    ...(event.source ? { source: event.source as TraceCallRecord['source'] } : {}),
    ...(event.model ? { model: event.model } : {}),
    ...(event.title ? { title: event.title } : {}),
    ...(event.message ? { message: event.message } : {}),
    metadata: { traceDetailsOmitted: true, recordBytes: event.byteLength },
  }
}

async function readCanonicalTraceSummary(
  sessionId: string,
  filePath: string,
): Promise<Pick<TraceSession, 'sessionId' | 'summary' | 'window'>> {
  const snapshot = await readStableTraceProjection(filePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (snapshot === undefined) return { sessionId, summary: emptyTraceSummary() }
  if (!snapshot) throw new Error('Trace changed while loading; retry the request')
  const calls = snapshot.calls.map(locator => shellTraceCallFromLocator(sessionId, locator))
  const summary = summarizeCalls(calls)
  return {
    sessionId,
    window: traceWindowMetadata(snapshot, snapshot.calls.length, snapshot.events.length, {}),
    summary: { ...summary, models: summary.models.slice(0, 64), failedCalls: snapshot.calls.filter(call => call.failed).length },
  }
}

async function readCanonicalTraceCall(
  sessionId: string,
  callId: string,
  context = currentTraceScopeContext(),
  scan?: TraceScanOptions,
): Promise<TraceCallRecord | null> {
  const normalizedSessionId = sanitizeTraceFileName(sessionId)
  const filePath = getTraceFilePath(normalizedSessionId, context)
  try {
    // A missing/corrupt index (or a missing call ID) must not turn a detail
    // request into full-session body hydration and cache retention.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const snapshot = await readStableTraceProjection(filePath, undefined, scan)
      if (!snapshot) continue
      const locator = snapshot.calls.find(call => call.id === callId)
      if (!locator) {
        if (snapshot.oversizedRecords > 0) throw traceResourceError('TRACE_RECORD_TOO_LARGE', 'Call is unavailable in the bounded trace window; oversized records are preserved in the raw download')
        return null
      }
      if (locator.byteLength > TRACE_RECORD_BYTES_LIMIT) throw traceResourceError('TRACE_RECORD_TOO_LARGE', 'Trace record exceeds 2 MiB; download the raw trace')
      const raw = await readTraceRange(filePath, locator.byteStart, locator.byteStart + locator.byteLength)
      const parsed = parseTraceBuffer(raw, { byteStart: locator.byteStart, ordinal: locator.ordinal })
      const record = parsed.calls.find(call => call.id === callId)
      if (
        record && traceCallMatchesLocator(record, locator) &&
        (await detectTraceSourceChange(filePath, snapshot.fingerprint)).kind === 'unchanged'
      ) return record
    }
    return null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function traceCallMatchesLocator(
  record: TraceCallRecord,
  locator: TraceCallLocator,
): boolean {
  const hydrated = toTraceCallLocator(
    record,
    locator.ordinal,
    locator.byteStart,
    locator.byteLength,
  )
  return hydrated.id === locator.id &&
    hydrated.startedAt === locator.startedAt &&
    hydrated.completedAt === locator.completedAt &&
    hydrated.status === locator.status &&
    hydrated.source === locator.source &&
    hydrated.model === locator.model &&
    hydrated.durationMs === locator.durationMs &&
    hydrated.failed === locator.failed &&
    hydrated.inputTokens === locator.inputTokens &&
    hydrated.outputTokens === locator.outputTokens
}

async function readProjectedTraceCall(
  sessionId: string,
  callId: string,
  context = currentTraceScopeContext(),
  scan?: TraceScanOptions,
): Promise<TraceCallRecord | null> {
  const normalizedSessionId = sanitizeTraceFileName(sessionId)
  const { target } = context
  const filePath = getTraceFilePath(normalizedSessionId, context)
  try {
    const index = getTraceIndex(target)
    if (!index) return null
    const cached = index.getCallLocator(normalizedSessionId, callId)
    if (!cached || cached.source.state !== 'ready' ||
      (scan?.byteStart !== undefined && cached.source.windowStartByte !== scan.byteStart)) {
      const projection = await ensureTraceProjection(normalizedSessionId, filePath, await fs.stat(filePath), 0, target, scan)
      if (!projection) return null
    }
    const located = index.getCallLocator(normalizedSessionId, callId)
    if (!located) return null
    const { source, call } = located
    const fingerprint = storedTraceFingerprint(source)
    const end = call.byteStart + call.byteLength
    if (
      !fingerprint ||
      source.filePath !== filePath ||
      !Number.isSafeInteger(end) ||
      call.byteStart < 0 ||
      call.byteLength < 1 ||
      end > source.indexedBytes
    ) {
      return null
    }
    if ((await detectTraceSourceChange(filePath, fingerprint)).kind !== 'unchanged') {
      return null
    }

    if (call.byteLength > TRACE_RECORD_BYTES_LIMIT) throw traceResourceError('TRACE_RECORD_TOO_LARGE', 'Trace record exceeds 2 MiB; download the raw trace')
    scan?.signal?.throwIfAborted()
    const raw = await readTraceRange(filePath, call.byteStart, end)
    const parsed = parseTraceBuffer(raw, {
      byteStart: call.byteStart,
      ordinal: call.ordinal,
    })
    const hydrated = parsed.calls.find(record => record.id === callId) ?? null
    if (!hydrated || !traceCallMatchesLocator(hydrated, call)) return null
    if ((await detectTraceSourceChange(filePath, fingerprint)).kind !== 'unchanged') {
      return null
    }
    const current = index.getCallLocator(normalizedSessionId, callId)
    if (
      !current ||
      current.source.revision !== source.revision ||
      current.source.resetToken !== source.resetToken ||
      current.source.fingerprint !== source.fingerprint ||
      current.call.ordinal !== call.ordinal ||
      current.call.byteStart !== call.byteStart ||
      current.call.byteLength !== call.byteLength
    ) {
      return null
    }
    return hydrated
  } catch (error) {
    if (scan?.signal?.aborted) throw error
    if ((error as { code?: string }).code === 'TRACE_RECORD_TOO_LARGE') throw error
    if (isTraceIndexSqliteFailure(error)) quarantineTraceIndexFailure(target, error)
    return null
  }
}

type TraceNearWindow = { fromMs: number; toMs: number; fromIso: string; toIso: string }

const TRACE_NEAR_PROBE_BYTES = 64 * 1024
const TRACE_NEAR_HEAD_BYTES = 16 * 1024
/** Records are appended on completion; allow for clock/append races. */
const TRACE_NEAR_EARLY_SLACK_MS = 60 * 1000
/** A call that started inside the window may complete (and be appended) this much later. */
const TRACE_NEAR_LATE_SLACK_MS = 30 * 60 * 1000
const TRACE_NEAR_TIME_KEY_RE = /"(completedAt|startedAt|timestamp)":"([^"\\]{1,64})"/g

/**
 * Time key of a trace line from its bounded head: a call's `completedAt`
 * (else `startedAt`), an event's `timestamp`. These fields precede the
 * request/response bodies in the serialized record, and escaped JSON inside
 * body strings never matches the unescaped `"key":"` spelling.
 */
function traceLineTimeKey(head: string): number | null {
  const event = head.startsWith('{"type":"event"')
  let started: number | null = null
  for (const match of head.matchAll(TRACE_NEAR_TIME_KEY_RE)) {
    const value = Date.parse(match[2]!)
    if (!Number.isFinite(value)) continue
    if (event) {
      if (match[1] === 'timestamp') return value
      continue
    }
    if (match[1] === 'completedAt') return value
    if (match[1] === 'startedAt' && started === null) started = value
  }
  return started
}

function traceNearRevisionToken(stat: Stats): string {
  return `file:${createHash('sha256').update(`${traceFileIdentity(stat) ?? ''}:${stat.size}:${stat.mtimeMs}`).digest('hex')}`
}

function traceNearResult(
  sessionId: string,
  locators: TraceCallLocator[],
  revisionToken: string,
  limited: boolean,
): TraceCallsNearResult {
  const calls = locators.slice(0, TRACE_NEAR_LIMIT)
  return {
    calls: calls.map(locator => shellTraceCallFromLocator(sessionId, locator)),
    revisionToken,
    captured: true,
    locs: Object.fromEntries(calls.map(locator => [locator.id, `${locator.byteStart}-${locator.byteStart + locator.byteLength}`])),
    ...(limited || locators.length > TRACE_NEAR_LIMIT ? { limited: true } : {}),
  }
}

async function readIndexedTraceCallsNear(
  sessionId: string,
  filePath: string,
  stat: Stats,
  window: TraceNearWindow,
  target: TraceIndexTarget,
  signal?: AbortSignal,
): Promise<TraceCallsNearResult | null> {
  try {
    const projection = await ensureTraceProjection(sessionId, filePath, stat, 0, target, { signal })
    const index = getTraceIndex(target)
    if (!projection || !index) return null
    const hit = index.getCallsInRange(sessionId, window.fromIso, window.toIso, TRACE_NEAR_LIMIT + 1)
    if (!hit) return null
    const { source } = hit
    const fingerprint = storedTraceFingerprint(source)
    // Only a projection of the whole file can prove that a call is absent.
    if (!fingerprint || source.state !== 'ready' || source.filePath !== filePath ||
      source.windowStartByte !== 0 || source.scanTruncated) return null
    if ((await detectTraceSourceChange(filePath, fingerprint)).kind !== 'unchanged') return null
    const revisionToken = createHash('sha256').update(`0:${serializeSourceFingerprint(fingerprint)}`).digest('hex')
    return traceNearResult(sessionId, hit.calls, revisionToken, false)
  } catch (error) {
    if (signal?.aborted) throw error
    if (isTraceIndexSqliteFailure(error)) quarantineTraceIndexFailure(target, error)
    return null
  }
}

/**
 * Time-directed bounded scan for `getSessionTraceCallsNear`. Lines are in
 * append (≈ completion) order, so a binary search over byte offsets on each
 * line's head time finds the first candidate; a forward scan then parses
 * whole records until the time keys pass the window or the budget runs out.
 */
async function scanTraceCallsNear(
  sessionId: string,
  filePath: string,
  window: TraceNearWindow,
  signal?: AbortSignal,
): Promise<TraceCallsNearResult> {
  return withTraceScanSlot(signal, async () => {
    const handle = await fs.open(filePath, 'r')
    try {
      const stat = await handle.stat()
      const size = stat.size
      let scanned = 0
      const readAt = async (position: number, length: number): Promise<Buffer> => {
        signal?.throwIfAborted()
        const buffer = Buffer.allocUnsafe(Math.max(0, Math.min(length, size - position)))
        let read = 0
        while (read < buffer.length) {
          const { bytesRead } = await handle.read(buffer, read, buffer.length - read, position + read)
          if (bytesRead < 1) break
          read += bytesRead
        }
        scanned += read
        traceCaptureDiagnostics.incrementalJsonlBytesRead += read
        return buffer.subarray(0, read)
      }
      // First line starting at or after `offset`, with its head time key.
      const probe = async (offset: number): Promise<{ lineStart: number; key: number | null } | null> => {
        let lineStart = offset
        if (offset > 0) {
          let cursor = offset - 1
          for (;;) {
            if (cursor >= size || cursor - offset > TRACE_RECORD_BYTES_LIMIT) return null
            const bytes = await readAt(cursor, TRACE_NEAR_PROBE_BYTES)
            if (!bytes.length) return null
            const newline = bytes.indexOf(0x0a)
            if (newline !== -1) {
              lineStart = cursor + newline + 1
              break
            }
            cursor += bytes.length
          }
        }
        if (lineStart >= size) return null
        const head = await readAt(lineStart, TRACE_NEAR_HEAD_BYTES)
        const newline = head.indexOf(0x0a)
        return { lineStart, key: traceLineTimeKey(head.subarray(0, newline === -1 ? head.length : newline).toString('utf8')) }
      }

      // Unknown or unreadable heads count as "at or after" the target so the
      // search only ever moves the scan start earlier, never past a match.
      const target = window.fromMs - TRACE_NEAR_EARLY_SLACK_MS
      let low = 0
      let high = size
      while (high - low > TRACE_NEAR_PROBE_BYTES) {
        const mid = low + Math.floor((high - low) / 2)
        const found = await probe(mid)
        if (!found || found.lineStart >= high || found.key === null || found.key >= target) high = mid
        else low = found.lineStart + 1
        await new Promise<void>(resolve => setImmediate(resolve))
      }

      const matches = new Map<string, TraceCallLocator>()
      let position = low > 0 ? low - 1 : 0
      // `low` sits inside a line that is before the window; discard its rest.
      let skipping = low > 0
      let lineStart = position
      let fragments: Buffer[] = []
      let fragmentBytes = 0
      let records = 0
      let limited = false
      const scanStart = scanned
      scan: while (position < size) {
        if (scanned - scanStart >= TRACE_NEAR_SCAN_BYTES || records >= TRACE_NEAR_SCAN_RECORDS) {
          limited = true
          break
        }
        const bytes = await readAt(position, 256 * 1024)
        if (!bytes.length) break
        let start = 0
        let newline = bytes.indexOf(0x0a)
        while (newline !== -1) {
          const part = bytes.subarray(start, newline + 1)
          if (!skipping && fragmentBytes + part.length <= TRACE_RECORD_BYTES_LIMIT) {
            const line = fragments.length ? Buffer.concat([...fragments, part], fragmentBytes + part.length) : part
            records += 1
            const key = traceLineTimeKey(line.subarray(0, TRACE_NEAR_HEAD_BYTES).toString('utf8'))
            if (key !== null && key > window.toMs + TRACE_NEAR_LATE_SLACK_MS) break scan
            for (const call of parseTraceBuffer(line, { byteStart: lineStart }).callLocators) {
              const started = Date.parse(call.startedAt)
              if (started >= window.fromMs && started <= window.toMs && traceLocatorStringsFit(call)) matches.set(call.id, call)
            }
          }
          skipping = false
          fragments = []
          fragmentBytes = 0
          lineStart = position + newline + 1
          start = newline + 1
          newline = bytes.indexOf(0x0a, start)
        }
        if (start < bytes.length) {
          fragmentBytes += bytes.length - start
          if (fragmentBytes > TRACE_RECORD_BYTES_LIMIT) {
            skipping = true
            fragments = []
          } else if (!skipping) {
            fragments.push(Buffer.from(bytes.subarray(start)))
          }
        }
        position += bytes.length
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      const calls = [...matches.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.byteStart - b.byteStart)
      return traceNearResult(sessionId, calls, traceNearRevisionToken(stat), limited)
    } finally {
      await handle.close()
    }
  })
}

/** Hydrate one call from a byte locator (`[start, end)`, trailing newline optional). */
async function readTraceCallAt(
  sessionId: string,
  callId: string,
  at: [number, number],
  context = currentTraceScopeContext(),
): Promise<TraceCallRecord | null> {
  const [start, end] = at
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start ||
    end - start > TRACE_RECORD_BYTES_LIMIT + 1) return null
  const filePath = getTraceFilePath(sanitizeTraceFileName(sessionId), context)
  try {
    const { size } = await fs.stat(filePath)
    if (end > size) return null
    const readStart = Math.max(0, start - 1)
    const readEnd = Math.min(size, end + 1)
    const raw = await readTraceRange(filePath, readStart, readEnd)
    // The range must be exactly one JSONL line.
    if (start > 0 && raw[0] !== 0x0a) return null
    const body = raw.subarray(start - readStart, end - readStart)
    const line = body[body.length - 1] === 0x0a ? body.subarray(0, body.length - 1) : body
    if (line === body && readEnd > end && raw[raw.length - 1] !== 0x0a) return null
    if (line.includes(0x0a)) return null
    return parseTraceBuffer(line).calls.find(call => call.id === callId) ?? null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function traceLocatorStringsFit(locator: TraceCallLocator | TraceEventLocator): boolean {
  return Object.entries(locator).every(([key, value]) =>
    key === 'title' || key === 'message' || typeof value !== 'string' || value.length <= (key === 'id' || key === 'callId' ? 512 : 128),
  )
}

// Projection rebuilds must not hydrate the complete trace on the server event
// loop. Keep only locators across records and yield between bounded I/O chunks.
let activeTraceScans = 0
const traceScanWaiters: Array<() => void> = []
async function readStableTraceProjection(
  filePath: string,
  append?: { source: NonNullable<ReturnType<TraceIndex['getSource']>>; fingerprint: SourceFingerprint },
  scan?: TraceScanOptions,
): ReturnType<typeof readStableTraceProjectionNow> {
  return withTraceScanSlot(scan?.signal, () => readStableTraceProjectionNow(filePath, append, scan))
}

/** One bounded trace file scan at a time; a short queue, then 429-style busy. */
async function withTraceScanSlot<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  signal?.throwIfAborted()
  let reserved = false
  if (activeTraceScans >= 1) {
    if (traceScanWaiters.length >= 8) throw traceResourceError('TRACE_INDEX_BUSY', 'Trace reader queue is full; retry shortly')
    await new Promise<void>((resolve, reject) => {
      const ready = () => { signal?.removeEventListener('abort', cancelled); resolve() }
      const cancelled = () => {
        const at = traceScanWaiters.indexOf(ready)
        if (at !== -1) traceScanWaiters.splice(at, 1)
        reject(signal?.reason ?? new Error('Trace scan aborted'))
      }
      traceScanWaiters.push(ready)
      signal?.addEventListener('abort', cancelled, { once: true })
    })
    reserved = true
  }
  if (!reserved) activeTraceScans += 1
  try {
    signal?.throwIfAborted()
    return await run()
  } finally {
    const next = traceScanWaiters.shift()
    if (next) next()
    else activeTraceScans -= 1
  }
}

async function readStableTraceProjectionNow(
  filePath: string,
  append?: { source: NonNullable<ReturnType<TraceIndex['getSource']>>; fingerprint: SourceFingerprint },
  scan?: TraceScanOptions,
): Promise<{
  calls: TraceCallLocator[]
  events: TraceEventLocator[]
  nextOrdinal: number
  fingerprint: SourceFingerprint
  oversizedRecords: number
  scanTruncated: boolean
  windowStartByte: number
  oversizedContinuation: boolean
} | null> {
  const handle = await fs.open(filePath, 'r')
  let closed = false
  try {
    const before = await handle.stat()
    const calls = new Map<string, TraceCallLocator>()
    const events: TraceEventLocator[] = []
    scan?.signal?.throwIfAborted()
    let position = append?.source.indexedBytes ?? scan?.byteStart ?? 0
    if (position > before.size) throw traceResourceError('TRACE_PAGE_STALE', 'Trace file changed; restart from the first window')
    const windowStartByte = append?.source.windowStartByte ?? position
    // A truncated window is a frozen prefix of the file: later appends land
    // past it, so they only refresh the fingerprint (size, tail hash and the
    // continuation cursor). Rescanning the window per append cost O(64MB).
    const frozenWindow = append?.source.scanTruncated === true
    const startOrdinal = scan?.ordinal ?? 0
    let oversizedRecords = append?.source.oversizedRecords ?? 0
    let scanTruncated = frozenWindow
    let skippingOversizedLine = scan?.skipLine === true
    let oversizedContinuation = frozenWindow &&
      append.source.lastErrorCode === 'TRACE_OVERSIZED_RECORD_CONTINUATION'
    let recordsScanned = 0
    const recordBudget = scan?.remainingRecords ?? TRACE_WINDOW_RECORD_LIMIT
    let indexedBytes = position
    let ordinal = append?.source.nextOrdinal ?? startOrdinal
    let fragments: Buffer[] = []
    let fragmentBytes = 0
    let firstWindow = Buffer.alloc(0)
    let lastWindow = Buffer.alloc(0)
    let boundaryWindow = Buffer.alloc(0)
    if (append) {
      const identity = traceFileIdentity(before)
      if (
        append.fingerprint.fileIdentity !== null &&
        identity !== null &&
        identity !== append.fingerprint.fileIdentity
      ) return null
      if (before.size < append.fingerprint.size) return null
      const readWindow = (end: number) => readTraceRange(
        filePath, Math.max(0, end - TRACE_FINGERPRINT_WINDOW_BYTES), end, 'fingerprint',
      )
      const oldFirst = await readWindow(Math.min(append.fingerprint.size, TRACE_FINGERPRINT_WINDOW_BYTES))
      const oldLast = await readWindow(append.fingerprint.size)
      boundaryWindow = await readWindow(position)
      if (
        hashBufferWindow(oldFirst, oldFirst.length) !== append.fingerprint.firstWindowHash ||
        hashBufferWindow(oldLast, oldLast.length) !== append.fingerprint.lastWindowHash ||
        hashBufferWindow(boundaryWindow, boundaryWindow.length) !== append.fingerprint.boundaryWindowHash
      ) return null
      firstWindow = await readWindow(Math.min(before.size, TRACE_FINGERPRINT_WINDOW_BYTES))
      lastWindow = boundaryWindow
    }
    if (!append && position > 0) {
      firstWindow = await readTraceRange(filePath, 0, Math.min(before.size, TRACE_FINGERPRINT_WINDOW_BYTES), 'fingerprint')
      boundaryWindow = await readTraceRange(filePath, Math.max(0, position - TRACE_FINGERPRINT_WINDOW_BYTES), position, 'fingerprint')
      lastWindow = boundaryWindow
    }
    scanChunks: while (!frozenWindow && position < before.size) {
      scan?.signal?.throwIfAborted()
      if (recordsScanned >= recordBudget) { scanTruncated = true; break }
      // An append that starts at the byte limit truncates at the same boundary
      // a cold rebuild would, instead of growing the window one record at a time.
      if (indexedBytes - windowStartByte >= TRACE_WINDOW_BYTES_LIMIT) { scanTruncated = true; break }
      const chunk = Buffer.allocUnsafe(Math.min(256 * 1024, before.size - position))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
      if (bytesRead === 0) return null
      const bytes = chunk.subarray(0, bytesRead)
      if (append) traceCaptureDiagnostics.incrementalJsonlBytesRead += bytesRead
      else traceCaptureDiagnostics.fullJsonlBytesRead += bytesRead
      if (!append && windowStartByte === 0 && firstWindow.length < TRACE_FINGERPRINT_WINDOW_BYTES) {
        firstWindow = Buffer.concat([firstWindow, bytes.subarray(
          0, TRACE_FINGERPRINT_WINDOW_BYTES - firstWindow.length,
        )])
      }
      const window = Buffer.concat([lastWindow, bytes])
      let start = 0
      let end = bytes.indexOf(0x0a)
      while (end !== -1) {
        const part = bytes.subarray(start, end + 1)
        if (skippingOversizedLine || fragmentBytes + part.length > TRACE_RECORD_BYTES_LIMIT) {
          oversizedRecords += 1
          ordinal += 1
        } else {
          const line = fragments.length
            ? Buffer.concat([...fragments, part], fragmentBytes + part.length)
            : part
          const parsed = parseTraceBuffer(line, { byteStart: indexedBytes, ordinal })
          for (const call of parsed.callLocators) {
            if (!traceLocatorStringsFit(call)) { oversizedRecords += 1; continue }
            call.firstOrdinal = calls.get(call.id)?.firstOrdinal ?? call.firstOrdinal
            calls.set(call.id, call)
          }
          for (const event of parsed.eventLocators) {
            if (!traceLocatorStringsFit(event)) { oversizedRecords += 1; continue }
            events.push({ ...event, title: event.title?.slice(0, 256), message: event.message?.slice(0, 512) })
          }
          ordinal = parsed.nextOrdinal
        }
        skippingOversizedLine = false
        indexedBytes = position + end + 1
        const windowEnd = lastWindow.length + end + 1
        boundaryWindow = Buffer.from(window.subarray(
          Math.max(0, windowEnd - TRACE_FINGERPRINT_WINDOW_BYTES), windowEnd,
        ))
        fragments = []
        fragmentBytes = 0
        start = end + 1
        recordsScanned += 1
        if (recordsScanned >= recordBudget || indexedBytes - windowStartByte >= TRACE_WINDOW_BYTES_LIMIT) {
          scanTruncated = indexedBytes < before.size
          break scanChunks
        }
        end = bytes.indexOf(0x0a, start)
      }
      if (start < bytes.length) {
        fragmentBytes += bytes.length - start
        if (fragmentBytes > TRACE_RECORD_BYTES_LIMIT) {
          skippingOversizedLine = true
          fragments = []
        } else if (!skippingOversizedLine) {
          fragments.push(Buffer.from(bytes.subarray(start)))
        }
      }
      lastWindow = Buffer.from(window.subarray(-TRACE_FINGERPRINT_WINDOW_BYTES))
      position += bytesRead
      if (skippingOversizedLine && position - windowStartByte >= TRACE_WINDOW_BYTES_LIMIT) {
        // Oversized lines do not require an unbounded read to reach newline.
        // Persist byte progress plus skip state; continuation discards the
        // rest of this physical line before considering another record.
        oversizedRecords += 1
        indexedBytes = position
        boundaryWindow = lastWindow
        scanTruncated = position < before.size
        oversizedContinuation = scanTruncated
        if (!scanTruncated) ordinal += 1
        skippingOversizedLine = false
        break
      }
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    scan?.signal?.throwIfAborted()
    if (!scanTruncated && skippingOversizedLine) {
      oversizedRecords += 1
      indexedBytes = before.size
      ordinal += 1
    }
    if (scanTruncated) {
      lastWindow = await readTraceRange(filePath, Math.max(0, before.size - TRACE_FINGERPRINT_WINDOW_BYTES), before.size, 'fingerprint')
    }
    await traceFullSnapshotAfterReadHookForTests?.()
    const after = await handle.stat()
    await handle.close()
    closed = true
    const current = await fs.stat(filePath)
    if (!sameTraceFileSnapshot(before, after) || !sameTraceFileSnapshot(after, current)) {
      return null
    }
    return {
      calls: [...calls.values()].sort((a, b) =>
        a.startedAt.localeCompare(b.startedAt) ||
        (a.firstOrdinal ?? a.ordinal) - (b.firstOrdinal ?? b.ordinal)),
      events: events.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.ordinal - b.ordinal),
      nextOrdinal: ordinal,
      oversizedRecords,
      scanTruncated,
      windowStartByte,
      oversizedContinuation,
      fingerprint: {
        size: before.size,
        mtimeMs: before.mtimeMs,
        ctimeMs: before.ctimeMs,
        fileIdentity: traceFileIdentity(before),
        firstWindowHash: createHash('sha256').update(firstWindow).digest('hex'),
        lastWindowHash: createHash('sha256').update(lastWindow).digest('hex'),
        boundaryWindowHash: createHash('sha256').update(boundaryWindow).digest('hex'),
        indexedBytes,
        parserVersion: TRACE_INDEX_PARSER_VERSION,
      },
    }
  } finally {
    if (!closed) await handle.close()
  }
}

type TraceScanOptions = { byteStart?: number; ordinal?: number; signal?: AbortSignal; remainingRecords?: number; skipLine?: boolean }
type TraceScanSnapshot = NonNullable<Awaited<ReturnType<typeof readStableTraceProjection>>>

async function commitTraceProjection(
  index: TraceIndex,
  sessionId: string,
  filePath: string,
  snapshot: TraceScanSnapshot,
  append: boolean,
  signal?: AbortSignal,
): Promise<TraceSessionOverview | null> {
  const source = {
    ...traceSourceInput(sessionId, filePath, snapshot.fingerprint, snapshot.nextOrdinal),
    oversizedRecords: snapshot.oversizedRecords,
    scanTruncated: snapshot.scanTruncated,
    windowStartByte: snapshot.windowStartByte,
    oversizedContinuation: snapshot.oversizedContinuation,
  }
  const batches = Math.max(1, Math.ceil(Math.max(snapshot.calls.length, snapshot.events.length) / 256))
  for (let batch = 0; batch < batches; batch += 1) {
    signal?.throwIfAborted()
    const input = { source, calls: snapshot.calls.slice(batch * 256, (batch + 1) * 256), events: snapshot.events.slice(batch * 256, (batch + 1) * 256) }
    if (batch === 0 && !append) index.replaceSession(input)
    else index.appendEntries(input)
    if (batch < batches - 1) {
      index.markDegraded(sessionId, 'TRACE_INDEX_BUILDING')
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }
  return index.getSummary(sessionId)
}

async function rebuildTraceProjection(
  index: TraceIndex,
  sessionId: string,
  filePath: string,
  scan?: TraceScanOptions,
): Promise<TraceSessionOverview | null> {
  const snapshot = await readStableTraceProjection(filePath, undefined, scan)
  return snapshot ? commitTraceProjection(index, sessionId, filePath, snapshot, false, scan?.signal) : null
}

async function appendTraceProjection(
  index: TraceIndex,
  source: NonNullable<ReturnType<TraceIndex['getSource']>>,
  previousFingerprint: SourceFingerprint,
  filePath: string,
  scan?: TraceScanOptions,
): Promise<TraceSessionOverview | null> {
  const page = source.scanTruncated ? null : index.getSessionPage(source.sessionId, 0, 1)
  const remainingRecords = source.scanTruncated
    ? 0
    : Math.max(0, TRACE_WINDOW_RECORD_LIMIT - (page?.totalCalls ?? 0) - (page?.totalEvents ?? 0) - source.oversizedRecords)
  const snapshot = await readStableTraceProjection(filePath, { source, fingerprint: previousFingerprint }, { ...scan, remainingRecords })
  return snapshot ? commitTraceProjection(index, source.sessionId, filePath, snapshot, true, scan?.signal) : null
}

const projectionJobs = new Map<string, {
  controller: AbortController
  promise: Promise<TraceSessionOverview | null>
  consumers: number
}>()
const projectionWorkQueues = new Map<string, Promise<unknown>>()

async function ensureTraceProjection(
  sessionId: string,
  filePath: string,
  stat: Stats,
  attempt = 0,
  target?: TraceIndexTarget,
  scan?: TraceScanOptions,
): Promise<TraceSessionOverview | null> {
  scan?.signal?.throwIfAborted()
  const key = `${target?.path ?? ''}\0${filePath}\0${scan?.byteStart ?? 0}`
  let job = projectionJobs.get(key)
  if (!job) {
    if (projectionJobs.size >= 8) throw traceResourceError('TRACE_INDEX_BUSY', 'Trace indexing queue is full; retry shortly')
    const controller = new AbortController()
    const scopeKey = target?.path ?? currentTraceIndexTarget().path
    const promise = (projectionWorkQueues.get(scopeKey) ?? Promise.resolve()).catch(() => {}).then(async () => {
      controller.signal.throwIfAborted()
      return ensureTraceProjectionNow(sessionId, filePath, stat, attempt, target, { ...scan, signal: controller.signal })
    })
    job = { controller, promise, consumers: 0 }
    projectionJobs.set(key, job)
    const queueTail = promise.catch(() => {})
    projectionWorkQueues.set(scopeKey, queueTail)
    void queueTail.finally(() => { if (projectionWorkQueues.get(scopeKey) === queueTail) projectionWorkQueues.delete(scopeKey) })
    void promise.finally(() => { if (projectionJobs.get(key)?.promise === promise) projectionJobs.delete(key) }).catch(() => {})
  }
  const activeJob = job
  activeJob.consumers += 1
  return new Promise((resolve, reject) => {
    let finished = false
    const finish = (value: TraceSessionOverview | null, error?: unknown) => {
      if (finished) return
      finished = true
      scan?.signal?.removeEventListener('abort', onAbort)
      activeJob.consumers -= 1
      if (activeJob.consumers === 0) activeJob.controller.abort()
      if (error) reject(error)
      else resolve(value)
    }
    const onAbort = () => finish(null, scan?.signal?.reason ?? new Error('Trace request aborted'))
    scan?.signal?.addEventListener('abort', onAbort, { once: true })
    activeJob.promise.then(value => finish(value), error => finish(null, error))
  })
}

async function ensureTraceProjectionNow(
  sessionId: string,
  filePath: string,
  _stat: Stats,
  attempt = 0,
  target?: TraceIndexTarget,
  scan?: TraceScanOptions,
): Promise<TraceSessionOverview | null> {
  const index = getTraceIndex(target)
  if (!index) return null
  try {
    await traceProjectionAfterIndexHookForTests?.(
      target ?? currentTraceIndexTarget(),
    )
    scan?.signal?.throwIfAborted()
    const source = index.getSource(sessionId)
    const fingerprint = source?.state === 'ready' && source.filePath === filePath && source.windowStartByte === (scan?.byteStart ?? 0)
      ? storedTraceFingerprint(source)
      : null
    if (!source || !fingerprint) {
      traceReadCache.delete(filePath)
      const rebuilt = await rebuildTraceProjection(index, sessionId, filePath, scan)
      if (!rebuilt && attempt < 1) {
        return ensureTraceProjectionNow(
          sessionId,
          filePath,
          await fs.stat(filePath),
          attempt + 1,
          target,
          scan,
        )
      }
      return rebuilt
    }

    const change = await detectTraceSourceChange(filePath, fingerprint)
    if (change.kind === 'unchanged') return index.getSummary(sessionId)
    if (change.kind === 'deleted') {
      index.deleteSession(sessionId)
      return null
    }
    traceReadCache.delete(filePath)
    if (change.kind === 'append') {
      const appended = await appendTraceProjection(index, source, fingerprint, filePath, scan)
      if (!appended && attempt < 1) {
        return ensureTraceProjectionNow(
          sessionId,
          filePath,
          await fs.stat(filePath),
          attempt + 1,
          target,
          scan,
        )
      }
      // The window just filled up. Rebuild it once so it freezes at the
      // boundary a cold scan picks: append budgets count projected entries
      // while a cold scan counts lines, and windows from older builds could
      // overrun the byte limit. Later appends only refresh the fingerprint.
      if (appended && !source.scanTruncated && index.getSource(sessionId)?.scanTruncated) {
        const rebuilt = await rebuildTraceProjection(index, sessionId, filePath, scan)
        // A failed rebuild (the file moved under the read) must not freeze the
        // append-sized window; degrading makes the next access rebuild again.
        if (!rebuilt) index.markDegraded(sessionId, 'TRACE_INDEX_SYNC_FAILED')
        return rebuilt
      }
      return appended
    }
    if (change.kind === 'rebuild') {
      const rebuilt = await rebuildTraceProjection(index, sessionId, filePath, scan)
      if (!rebuilt && attempt < 1) {
        return ensureTraceProjectionNow(
          sessionId,
          filePath,
          await fs.stat(filePath),
          attempt + 1,
          target,
          scan,
        )
      }
      return rebuilt
    }
    return null
  } catch (error) {
    if (scan?.signal?.aborted) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      withTraceIndex(activeIndex => activeIndex.deleteSession(sessionId), target)
      return null
    }
    if (isTraceIndexBusy(error)) {
      quarantineTraceIndexFailure(target ?? currentTraceIndexTarget(), error)
      return null
    }
    // A full reader queue is transient; degrading would force the next append
    // to rebuild the whole window instead of catching up incrementally.
    if ((error as { code?: unknown })?.code === 'TRACE_INDEX_BUSY') return null
    withTraceIndex(
      activeIndex => activeIndex.markDegraded(sessionId, 'TRACE_INDEX_SYNC_FAILED'),
      target,
    )
    return null
  }
}

async function projectAppendedTraceEntry(
  sessionId: string,
  filePath: string,
  after: Stats,
  target: TraceIndexTarget,
): Promise<void> {
  const index = getTraceIndex(target)
  if (!index) return

  try {
    const previousRevision = index.getSource(sessionId)?.revision
    const projection = await ensureTraceProjection(
      sessionId,
      filePath,
      after,
      0,
      target,
    )
    if (previousRevision !== undefined && projection && projection.revision > previousRevision) {
      traceCaptureDiagnostics.appendedEntriesProjected += 1
    }
  } catch (error) {
    // A full projection queue is transient. Keeping the old fingerprint lets
    // the next append catch up incrementally; degrading forces a full rebuild.
    if ((error as { code?: unknown })?.code === 'TRACE_INDEX_BUSY') return
    // The JSONL append has already succeeded; projection failures are non-fatal.
    withTraceIndex(
      activeIndex => activeIndex.markDegraded(sessionId, 'TRACE_INDEX_APPEND_FAILED'),
      target,
    )
  }
}

async function appendTraceEntry(sessionId: string, entry: TraceFileEntry): Promise<void> {
  const normalizedSessionId = sanitizeTraceFileName(sessionId)
  const scope = getClaudeConfigHomeDir()
  const filePath = join(
    scope,
    'cc-haha',
    'traces',
    `${normalizedSessionId}.jsonl`,
  )
  const target: TraceIndexTarget = {
    scope,
    path: join(scope, 'cc-haha', 'db', 'trace-index-v1.sqlite'),
  }
  const queueKey = `${scope}\0${normalizedSessionId}`
  const previous = traceWriteQueues.get(queueKey) ?? Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(async () => {
      await traceAppendBeforeWriteHookForTests?.()
      await fs.mkdir(dirname(filePath), { recursive: true })
      const line = Buffer.from(`${JSON.stringify(boundedTraceEntry(entry))}\n`, 'utf-8')
      await fs.appendFile(filePath, line)
      const after = await fs.stat(filePath)
      traceReadCache.delete(filePath)
      await projectAppendedTraceEntry(normalizedSessionId, filePath, after, target)
    })
  traceWriteQueues.set(queueKey, next)
  try {
    await next
  } finally {
    if (traceWriteQueues.get(queueKey) === next) {
      traceWriteQueues.delete(queueKey)
    }
  }
}

type TraceFileSnapshot = {
  name: string
  path: string
  size: number
  updatedAt: string
  stat: Stats
}

async function listTraceFiles(storageDir: string): Promise<TraceFileSnapshot[]> {
  let entries: string[] = []
  try {
    entries = await fs.readdir(storageDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const files = await Promise.all(entries
    .filter((name) => name.endsWith('.jsonl'))
    .map(async (name) => {
      const stat = await fs.stat(join(storageDir, name)).catch(() => null)
      if (!stat?.isFile()) return null
      return {
        name,
        path: join(storageDir, name),
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
        stat,
      }
    }))
  return files.filter((file): file is TraceFileSnapshot => file !== null)
}

async function readTraceEntries(
  sessionId: string,
  context = currentTraceScopeContext(),
): Promise<{ calls: TraceCallRecord[]; events: TraceEventRecord[] }> {
  const { target } = context
  const filePath = getTraceFilePath(sessionId, context)
  let stat: Stats
  try {
    stat = await fs.stat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      traceReadCache.delete(filePath)
      return { calls: [], events: [] }
    }
    throw error
  }

  const cached = traceReadCache.get(filePath)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    const change = await detectTraceSourceChange(filePath, cached.fingerprint)
    if (change.kind === 'unchanged') {
      return { calls: cached.calls, events: cached.events }
    }
    traceReadCache.delete(filePath)
  }

  let snapshot: StableFullTraceSnapshot
  try {
    snapshot = await readStableFullTraceSnapshot(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      traceReadCache.delete(filePath)
      return { calls: [], events: [] }
    }
    throw error
  }
  const { raw, parsed, fingerprint } = snapshot
  const { calls, events: sortedEvents } = parsed
  if (fingerprint && fingerprintMatchesFullBuffer(fingerprint, raw)) {
    const source = traceSourceInput(sessionId, filePath, fingerprint, parsed.nextOrdinal)
    withTraceIndex(index => {
      const existing = index.getSource(sessionId)
      if (
        existing?.state === 'ready' &&
        existing.filePath === filePath &&
        existing.fingerprint === source.fingerprint &&
        existing.nextOrdinal === source.nextOrdinal
      ) {
        return
      }
      index.replaceSession({
        source,
        calls: parsed.callLocators,
        events: parsed.eventLocators,
      })
    }, target)
    // This legacy helper is not a UI transport. Even explicit callers may
    // retain only one bounded full snapshot; raw export always streams disk.
    traceReadCache.clear()
    traceReadCache.set(filePath, {
      mtimeMs: fingerprint.mtimeMs,
      size: fingerprint.size,
      fingerprint,
      calls,
      events: sortedEvents,
    })
  }

  return { calls, events: sortedEvents }
}

function emptyTraceSummary(): TraceSessionSummary {
  return {
    apiCalls: 0,
    failedCalls: 0,
    totalDurationMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    models: [],
    updatedAt: null,
  }
}

function emptyTraceBodySnapshot(bytes: number): TraceBodySnapshot {
  return {
    contentType: 'empty',
    bytes,
    sha256: '',
    preview: '',
    truncated: bytes > 0,
  }
}

/**
 * The trace tree only needs per-call identity, timing, status and body sizes.
 * Bodies stay on disk: the detail panel fetches a single call through
 * `getSessionTraceCall`, which reads just that call's byte range.
 */
function shellTraceCallFromLocator(
  sessionId: string,
  locator: TraceCallLocator,
): TraceCallRecord {
  return {
    id: locator.id,
    sessionId,
    source: locator.source as TraceCallRecord['source'],
    startedAt: locator.startedAt,
    ...(locator.completedAt ? { completedAt: locator.completedAt } : {}),
    ...(locator.durationMs !== null ? { durationMs: locator.durationMs } : {}),
    status: locator.status as TraceCallRecord['status'],
    ...(locator.model ? { model: locator.model } : {}),
    ...(locator.inputTokens > 0 || locator.outputTokens > 0
      ? {
          usage: {
            inputTokens: locator.inputTokens,
            outputTokens: locator.outputTokens,
          },
        }
      : {}),
    request: {
      method: '',
      url: '',
      headers: {},
      body: emptyTraceBodySnapshot(locator.requestBytes ?? 0),
    },
    ...(locator.responseStatus != null || locator.responseBytes != null
      ? {
          response: {
            status: locator.responseStatus ?? 0,
            headers: {},
            body: emptyTraceBodySnapshot(locator.responseBytes ?? 0),
          },
        }
      : {}),
  }
}

/**
 * Index-backed trace pages fetch scalar metadata with SQL LIMIT. Calls and
 * events are lightweight shells; raw export is the lossless detail surface.
 */
async function readProjectedSessionTrace(
  sessionId: string,
  context = currentTraceScopeContext(),
  options: TraceOverviewOptions = {},
  scan?: TraceScanOptions,
): Promise<TraceSession | null> {
  const { target } = context
  const normalizedSessionId = sanitizeTraceFileName(sessionId)
  const filePath = getTraceFilePath(normalizedSessionId, context)
  let stat: Stats
  try {
    stat = await fs.stat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        sessionId: normalizedSessionId,
        summary: emptyTraceSummary(),
        calls: [],
        events: [],
      }
    }
    throw error
  }

  const projection = await ensureTraceProjection(
    normalizedSessionId,
    filePath,
    stat,
    0,
    target,
    scan,
  )
  const index = getTraceIndex(target)
  if (!projection || !index) return null
  const projected = index.getSessionPage(normalizedSessionId, options.offset ?? 0, options.limit ?? TRACE_OVERVIEW_LIMIT)
  if (!projected) return null
  const fingerprint = storedTraceFingerprint(projected)
  if (!fingerprint) return null
  if ((await detectTraceSourceChange(filePath, fingerprint)).kind !== 'unchanged') {
    return null
  }

  const window = traceWindowMetadata({ ...projected, fingerprint }, projected.totalCalls, projected.totalEvents, options)

  return {
    sessionId: normalizedSessionId,
    window,
    summary: projected.summary,
    calls: projected.calls.map((locator) =>
      shellTraceCallFromLocator(normalizedSessionId, locator)
    ),
    events: projected.events.map(event => traceEventShell(normalizedSessionId, event)),
  }
}

function scheduleTraceProjectionBackfill(
  sessionId: string,
  filePath: string,
  stat: Stats,
  target: TraceIndexTarget,
): void {
  // Large cold sources are indexed only while an overview request consumes
  // the work; navigating away can then cancel actual reads and database work.
  if (stat.size > TRACE_WINDOW_BYTES_LIMIT) return
  const key = `${target.path}\0${sessionId}`
  if (traceBackfillScheduled.has(key)) return
  if (traceBackfillScheduled.size >= TRACE_BACKFILL_MAX_PENDING) return
  traceBackfillScheduled.add(key)
  traceBackfillQueue = traceBackfillQueue
    .catch(() => {})
    .then(async () => {
      try {
        await ensureTraceProjection(sessionId, filePath, stat, 0, target)
      } catch {
        // The list row already served an empty summary; the next poll retries.
      } finally {
        traceBackfillScheduled.delete(key)
      }
    })
}

function isTraceCallRecordLike(value: unknown): value is TraceCallRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<TraceCallRecord>
  return typeof record.id === 'string'
    && typeof record.sessionId === 'string'
    && typeof record.source === 'string'
    && typeof record.startedAt === 'string'
    && Boolean(record.request)
}

function isTraceEventRecordLike(value: unknown): value is TraceEventRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<TraceEventRecord>
  return typeof record.id === 'string'
    && typeof record.sessionId === 'string'
    && typeof record.timestamp === 'string'
    && typeof record.phase === 'string'
    && typeof record.severity === 'string'
}

function summarizeCalls(calls: TraceCallRecord[]): TraceSessionSummary {
  const modelCounts = new Map<string, number>()
  let failedCalls = 0
  let totalDurationMs = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let updatedAt: string | null = null

  for (const call of calls) {
    if (call.status === 'error' || call.error || (call.response?.status ?? 200) >= 400) failedCalls += 1
    if (typeof call.durationMs === 'number') totalDurationMs += call.durationMs
    if (call.model) modelCounts.set(call.model, (modelCounts.get(call.model) ?? 0) + 1)
    totalInputTokens += call.usage?.inputTokens ?? 0
    totalOutputTokens += call.usage?.outputTokens ?? 0
    updatedAt = call.completedAt ?? call.startedAt
  }

  return {
    apiCalls: calls.length,
    failedCalls,
    totalDurationMs,
    totalInputTokens,
    totalOutputTokens,
    models: Array.from(modelCounts.entries()).map(([model, count]) => ({ model, calls: count })),
    updatedAt,
  }
}

function attachCallUsage(call: TraceCallRecord): TraceCallRecord {
  const usage = extractTraceCallUsage(call)
  return usage ? { ...call, usage } : call
}

function extractTraceCallUsage(call: TraceCallRecord): TraceCallUsage | undefined {
  const preview = call.response?.body.preview
  if (!preview) return undefined
  try {
    if (looksLikeSseText(preview)) {
      return extractUsageFromSseText(preview)
    }
    const parsed = parseJsonOrText(preview)
    if (!parsed || typeof parsed !== 'object') return undefined
    return extractUsageFromJsonPayload(unwrapAnthropicResponsePayload(parsed))
  } catch {
    return undefined
  }
}

function looksLikeSseText(preview: string): boolean {
  for (const line of preview.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    return trimmed.startsWith('event:') || trimmed.startsWith('data:')
  }
  return false
}

function unwrapAnthropicResponsePayload(parsed: object): Record<string, unknown> {
  // Proxy responses persist as `{ upstream, anthropic }`; usage lives on the anthropic copy.
  const record = parsed as Record<string, unknown>
  if (record.anthropic && typeof record.anthropic === 'object' && !Array.isArray(record.anthropic)) {
    return record.anthropic as Record<string, unknown>
  }
  return record
}

function extractUsageFromJsonPayload(payload: Record<string, unknown>): TraceCallUsage | undefined {
  const hasUsageObject = Boolean(payload.usage && typeof payload.usage === 'object' && !Array.isArray(payload.usage))
  const usageSource = hasUsageObject
    ? payload.usage as Record<string, unknown>
    : payload
  const inputTokens = numberFromUnknown(usageSource.input_tokens) + numberFromUnknown(usageSource.prompt_tokens)
  const outputTokens = numberFromUnknown(usageSource.output_tokens) + numberFromUnknown(usageSource.completion_tokens)
  const cacheReadInputTokens = finiteNumberOrUndefined(usageSource.cache_read_input_tokens)
  const cacheCreationInputTokens = finiteNumberOrUndefined(usageSource.cache_creation_input_tokens)
  if (!hasUsageObject
    && inputTokens === 0
    && outputTokens === 0
    && cacheReadInputTokens === undefined
    && cacheCreationInputTokens === undefined) {
    return undefined
  }
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
  }
}

type TraceUsageAccumulator = {
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}

function extractUsageFromSseText(preview: string): TraceCallUsage | undefined {
  const accumulated: TraceUsageAccumulator = {}

  for (const line of preview.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice('data:'.length).trim()
    if (!payload || payload === '[DONE]') continue

    let event: unknown
    try {
      event = JSON.parse(payload)
    } catch {
      continue
    }
    if (!event || typeof event !== 'object') continue

    const record = event as Record<string, unknown>
    if (record.type === 'message_start') {
      const message = record.message
      accumulateUsageFields(
        accumulated,
        message && typeof message === 'object' ? (message as Record<string, unknown>).usage : undefined,
      )
    } else if (record.type === 'message_delta') {
      accumulateUsageFields(accumulated, record.usage)
    }
  }

  if (accumulated.inputTokens === undefined
    && accumulated.outputTokens === undefined
    && accumulated.cacheReadInputTokens === undefined
    && accumulated.cacheCreationInputTokens === undefined) {
    return undefined
  }
  return {
    inputTokens: accumulated.inputTokens ?? 0,
    outputTokens: accumulated.outputTokens ?? 0,
    ...(accumulated.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: accumulated.cacheReadInputTokens }
      : {}),
    ...(accumulated.cacheCreationInputTokens !== undefined
      ? { cacheCreationInputTokens: accumulated.cacheCreationInputTokens }
      : {}),
  }
}

function accumulateUsageFields(accumulated: TraceUsageAccumulator, usage: unknown): void {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return
  const record = usage as Record<string, unknown>
  accumulated.inputTokens = finiteNumberOrUndefined(record.input_tokens) ?? accumulated.inputTokens
  accumulated.outputTokens = finiteNumberOrUndefined(record.output_tokens) ?? accumulated.outputTokens
  accumulated.cacheReadInputTokens = finiteNumberOrUndefined(record.cache_read_input_tokens)
    ?? accumulated.cacheReadInputTokens
  accumulated.cacheCreationInputTokens = finiteNumberOrUndefined(record.cache_creation_input_tokens)
    ?? accumulated.cacheCreationInputTokens
}

function finiteNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function numberFromUnknown(value: unknown): number {
  return finiteNumberOrUndefined(value) ?? 0
}

function getTraceFilePath(
  sessionId: string,
  context = currentTraceScopeContext(),
): string {
  return join(context.storageDir, `${sanitizeTraceFileName(sessionId)}.jsonl`)
}

function sanitizeTraceFileName(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function getManagedSettingsPath(scope = getClaudeConfigHomeDir()): string {
  return join(scope, 'cc-haha', 'settings.json')
}

function defaultTraceCaptureSettings(
  scope = getClaudeConfigHomeDir(),
): TraceCaptureSettings {
  return {
    enabled: true,
    storageDir: join(scope, 'cc-haha', 'traces'),
  }
}

function normalizeTraceCaptureSettings(
  settings: Record<string, unknown>,
  scope = getClaudeConfigHomeDir(),
): TraceCaptureSettings {
  const defaultSettings = defaultTraceCaptureSettings(scope)
  const traceCapture = settings[TRACE_SETTINGS_KEY]
  if (!traceCapture || typeof traceCapture !== 'object' || Array.isArray(traceCapture)) {
    return defaultSettings
  }

  return {
    ...defaultSettings,
    enabled: (traceCapture as Record<string, unknown>).enabled !== false,
  }
}

function readManagedSettingsSync(
  scope = getClaudeConfigHomeDir(),
): Record<string, unknown> {
  const filePath = getManagedSettingsPath(scope)
  try {
    if (!existsSync(filePath)) return {}
    const stat = statSync(filePath)
    if (!stat.isFile()) return {}
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

async function readManagedSettings(
  scope = getClaudeConfigHomeDir(),
): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await fs.readFile(
      getManagedSettingsPath(scope),
      'utf-8',
    )) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    return {}
  }
}

async function writeManagedSettings(
  settings: Record<string, unknown>,
  scope = getClaudeConfigHomeDir(),
): Promise<void> {
  const filePath = getManagedSettingsPath(scope)
  const tmpFile = `${filePath}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`
  await fs.mkdir(dirname(filePath), { recursive: true })
  await fs.writeFile(tmpFile, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
  await fs.rename(tmpFile, filePath)
}

function clampListLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 50
  return Math.min(Math.max(Math.round(limit), 1), 200)
}
