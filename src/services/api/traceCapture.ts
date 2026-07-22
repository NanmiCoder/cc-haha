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
const TRACE_INDEX_PARSER_VERSION = 1
const TRACE_FINGERPRINT_WINDOW_BYTES = 64 * 1024
// `token(?!s)` keeps secret-bearing keys (token, access_token, api_token) redacted while
// letting token-count fields (input_tokens, max_tokens, prompt_tokens) through.
const SENSITIVE_KEY_RE = /authorization|api[-_]?key|secret|token(?!s)|cookie|password|bearer/i

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
}

export type TraceCallStatus = 'pending' | 'ok' | 'error'

export type TraceEventSeverity = 'info' | 'warning' | 'error'

export type TraceCallUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
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
  sessionId: string
  summary: TraceSessionSummary
  calls: TraceCallRecord[]
  events: TraceEventRecord[]
}

export type TraceSessionListItem = {
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

export function createTraceBodySnapshot(
  body: unknown,
  options?: { maxPreviewChars?: number; alreadyTruncated?: boolean },
): TraceBodySnapshot {
  const maxPreviewChars = options?.maxPreviewChars ?? TRACE_PREVIEW_CHARS
  const { serialized, contentType } = serializeTraceBody(body)
  const bytes = Buffer.byteLength(serialized)
  const preview = serialized.length > maxPreviewChars
    ? serialized.slice(0, maxPreviewChars)
    : serialized

  return {
    contentType,
    bytes,
    sha256: createHash('sha256').update(serialized).digest('hex'),
    preview,
    truncated: Boolean(options?.alreadyTruncated) || serialized.length > maxPreviewChars,
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
  if (requestBody === call.request.body && (!call.response || responseBody === call.response.body)) {
    return call
  }
  return {
    ...call,
    request: { ...call.request, body: requestBody },
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

export function clearTraceCaptureStateForTests(): void {
  traceWriteQueues.clear()
  traceReadCache.clear()
  canonicalTraceRevisions.clear()
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
    if (!input.sessionId.trim()) return null
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
        body: input.request.bodySnapshot ?? createTraceBodySnapshot(input.request.body ?? null),
      },
      ...(input.response
        ? {
            response: {
              status: input.response.status,
              headers: sanitizeHeaders(input.response.headers),
              body: input.response.bodySnapshot ?? createTraceBodySnapshot(input.response.body ?? null),
            },
          }
        : {}),
      ...(input.error ? { error: normalizeTraceError(input.error) } : {}),
    }

    await appendTraceEntry(record.sessionId, { type: 'call', record })
    return record
  }

  async recordEvent(input: RecordTraceEventInput): Promise<TraceEventRecord | null> {
    if (!input.sessionId.trim()) return null
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
      ...(input.title ? { title: input.title } : {}),
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

  async getSessionTraceCall(sessionId: string, callId: string): Promise<TraceCallRecord | null> {
    const mode = syncTraceIndexMode()
    const context = currentTraceScopeContext()
    if (mode === 'off') return readCanonicalTraceCall(sessionId, callId, context)

    if (mode === 'shadow') {
      const canonical = await readCanonicalTraceCall(sessionId, callId, context)
      const projected = await readProjectedTraceCall(sessionId, callId, context)
      recordTraceShadowComparison(traceCallMatches(canonical, projected))
      return canonical
    }

    return await readProjectedTraceCall(sessionId, callId, context)
      ?? await readCanonicalTraceCall(sessionId, callId, context)
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

    const projection = await ensureTraceProjection(
      normalizedSessionId,
      filePath,
      stat,
      0,
      target,
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
      let trace: Pick<TraceSession, 'sessionId' | 'summary'>
      if (mode === 'off') {
        const canonical = await readTraceEntries(sessionId, context)
        trace = { sessionId, summary: summarizeCalls(canonical.calls) }
      } else if (mode === 'shadow') {
        const projection = await ensureTraceProjection(
          sessionId,
          file.path,
          file.stat,
          0,
          target,
        )
        const entries = await readTraceEntries(sessionId, context)
        const canonical = {
          sessionId,
          summary: summarizeCalls(entries.calls),
        }
        recordTraceShadowComparison(Boolean(
          projection && traceSummaryMatches(canonical.summary, projection.summary),
        ))
        trace = canonical
      } else {
        const projection = await ensureTraceProjection(
          sessionId,
          file.path,
          file.stat,
          0,
          target,
        )
        trace = projection
          ? { sessionId, summary: projection.summary }
          : {
              sessionId,
              summary: summarizeCalls((await readTraceEntries(
                sessionId,
                context,
              )).calls),
            }
      }
      const updatedAt = trace.summary.updatedAt ?? file.updatedAt
      items.push({
        sessionId: trace.sessionId || sessionId,
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

  const readAll = async (): Promise<'done'> => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        completed = true
        break
      }
      bytes += value.byteLength
      if (text.length < TRACE_STREAM_CAPTURE_BYTES) {
        text += decoder.decode(value, { stream: true })
      } else {
        truncated = true
      }
      if (bytes > TRACE_STREAM_CAPTURE_BYTES) {
        truncated = true
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
  if (SENSITIVE_KEY_RE.test(key)) return '[redacted]'
  if (Array.isArray(value)) return value.map((entry) => redactSensitiveValue(entry))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactSensitiveValue(entryValue, entryKey),
      ]),
    )
  }
  if (typeof value === 'string') return redactSecretsInText(value)
  return value
}

function redactSecretsInText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/g, 'sk-[redacted]')
}

function sanitizeHeaders(headers: Headers | Record<string, string> | null | undefined): Record<string, string> {
  if (!headers) return {}
  const entries = headers instanceof Headers
    ? Array.from(headers.entries())
    : Object.entries(headers)

  return Object.fromEntries(
    entries.map(([key, value]) => [
      key,
      SENSITIVE_KEY_RE.test(key) ? '[redacted]' : redactSecretsInText(String(value)),
    ]),
  )
}

function sanitizeUrl(url: string): string {
  if (!url) return ''
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

function hashBufferedTraceWindow(
  end: number,
  rangeStart: number,
  prefix: Buffer,
  range: Buffer,
): string | null {
  const contextStart = rangeStart - prefix.byteLength
  const contextEnd = rangeStart + range.byteLength
  const length = Math.min(TRACE_FINGERPRINT_WINDOW_BYTES, end)
  const windowStart = end - length
  if (windowStart < contextStart || end > contextEnd) return null

  const hash = createHash('sha256')
  if (windowStart < rangeStart) {
    hash.update(prefix.subarray(
      windowStart - contextStart,
      Math.min(end, rangeStart) - contextStart,
    ))
  }
  if (end > rangeStart) {
    hash.update(range.subarray(
      Math.max(windowStart, rangeStart) - rangeStart,
      end - rangeStart,
    ))
  }
  return hash.digest('hex')
}

function fingerprintMatchesAppendBuffers(
  previous: SourceFingerprint,
  fingerprint: SourceFingerprint,
  rangeStart: number,
  prefix: Buffer,
  range: Buffer,
): boolean {
  const previousFirstWindowHash = rangeStart <= TRACE_FINGERPRINT_WINDOW_BYTES
    ? hashBufferedTraceWindow(
        Math.min(TRACE_FINGERPRINT_WINDOW_BYTES, previous.size),
        rangeStart,
        prefix,
        range,
      )
    : previous.firstWindowHash
  const firstWindowHash = rangeStart <= TRACE_FINGERPRINT_WINDOW_BYTES
    ? hashBufferedTraceWindow(
        Math.min(TRACE_FINGERPRINT_WINDOW_BYTES, fingerprint.size),
        rangeStart,
        prefix,
        range,
      )
    : previous.firstWindowHash
  return previousFirstWindowHash === previous.firstWindowHash &&
    hashBufferedTraceWindow(
      previous.size,
      rangeStart,
      prefix,
      range,
    ) === previous.lastWindowHash &&
    hashBufferedTraceWindow(
      previous.indexedBytes,
      rangeStart,
      prefix,
      range,
    ) === previous.boundaryWindowHash &&
    firstWindowHash === fingerprint.firstWindowHash &&
    hashBufferedTraceWindow(
      fingerprint.size,
      rangeStart,
      prefix,
      range,
    ) === fingerprint.lastWindowHash &&
    hashBufferedTraceWindow(
      fingerprint.indexedBytes,
      rangeStart,
      prefix,
      range,
    ) === fingerprint.boundaryWindowHash &&
    (
      previous.fileIdentity === null ||
      fingerprint.fileIdentity === null ||
      previous.fileIdentity === fingerprint.fileIdentity
    )
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

async function readCanonicalTraceCall(
  sessionId: string,
  callId: string,
  context = currentTraceScopeContext(),
): Promise<TraceCallRecord | null> {
  const { calls } = await readTraceEntries(sessionId, context)
  return calls.find(call => call.id === callId) ?? null
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
): Promise<TraceCallRecord | null> {
  const normalizedSessionId = sanitizeTraceFileName(sessionId)
  const { target } = context
  const filePath = getTraceFilePath(normalizedSessionId, context)
  try {
    const stat = await fs.stat(filePath)
    const projection = await ensureTraceProjection(
      normalizedSessionId,
      filePath,
      stat,
      0,
      target,
    )
    const index = getTraceIndex(target)
    if (!projection || !index) return null
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
    if (isTraceIndexSqliteFailure(error)) quarantineTraceIndexFailure(target, error)
    return null
  }
}

async function rebuildTraceProjection(
  index: TraceIndex,
  sessionId: string,
  filePath: string,
): Promise<TraceSessionOverview | null> {
  const snapshot = await readStableFullTraceSnapshot(filePath)
  const { parsed, fingerprint } = snapshot
  if (!fingerprint) return null
  index.replaceSession({
    source: traceSourceInput(sessionId, filePath, fingerprint, parsed.nextOrdinal),
    calls: parsed.callLocators,
    events: parsed.eventLocators,
  })
  return index.getSummary(sessionId)
}

async function appendTraceProjection(
  index: TraceIndex,
  source: NonNullable<ReturnType<TraceIndex['getSource']>>,
  previousFingerprint: SourceFingerprint,
  filePath: string,
): Promise<TraceSessionOverview | null> {
  const target = await fs.stat(filePath)
  if (target.size < source.indexedBytes) return null
  const prefixStart = Math.max(0, source.indexedBytes - TRACE_FINGERPRINT_WINDOW_BYTES)
  const prefix = await readTraceRange(
    filePath,
    prefixStart,
    source.indexedBytes,
    'fingerprint',
  )
  const raw = await readTraceRange(filePath, source.indexedBytes, target.size)
  const parsed = parseTraceBuffer(raw, {
    byteStart: source.indexedBytes,
    ordinal: source.nextOrdinal,
  })
  const fingerprint = await captureTraceFingerprint(filePath, parsed.indexedBytes)
  if (
    fingerprint.size !== target.size ||
    fingerprint.mtimeMs !== target.mtimeMs ||
    !fingerprintMatchesAppendBuffers(
      previousFingerprint,
      fingerprint,
      source.indexedBytes,
      prefix,
      raw,
    )
  ) {
    return null
  }
  index.appendEntries({
    source: traceSourceInput(source.sessionId, filePath, fingerprint, parsed.nextOrdinal),
    calls: parsed.callLocators,
    events: parsed.eventLocators,
  })
  return index.getSummary(source.sessionId)
}

async function ensureTraceProjection(
  sessionId: string,
  filePath: string,
  _stat: Stats,
  attempt = 0,
  target?: TraceIndexTarget,
): Promise<TraceSessionOverview | null> {
  const index = getTraceIndex(target)
  if (!index) return null
  try {
    await traceProjectionAfterIndexHookForTests?.(
      target ?? currentTraceIndexTarget(),
    )
    const source = index.getSource(sessionId)
    const fingerprint = source?.state === 'ready' && source.filePath === filePath
      ? storedTraceFingerprint(source)
      : null
    if (!source || !fingerprint) {
      traceReadCache.delete(filePath)
      const rebuilt = await rebuildTraceProjection(index, sessionId, filePath)
      if (!rebuilt && attempt < 1) {
        return ensureTraceProjection(
          sessionId,
          filePath,
          await fs.stat(filePath),
          attempt + 1,
          target,
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
      const appended = await appendTraceProjection(index, source, fingerprint, filePath)
      if (!appended && attempt < 1) {
        return ensureTraceProjection(
          sessionId,
          filePath,
          await fs.stat(filePath),
          attempt + 1,
          target,
        )
      }
      return appended
    }
    if (change.kind === 'rebuild') {
      const rebuilt = await rebuildTraceProjection(index, sessionId, filePath)
      if (!rebuilt && attempt < 1) {
        return ensureTraceProjection(
          sessionId,
          filePath,
          await fs.stat(filePath),
          attempt + 1,
          target,
        )
      }
      return rebuilt
    }
    return null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      withTraceIndex(activeIndex => activeIndex.deleteSession(sessionId), target)
      return null
    }
    if (isTraceIndexBusy(error)) {
      quarantineTraceIndexFailure(target ?? currentTraceIndexTarget(), error)
      return null
    }
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
  } catch {
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
      const line = Buffer.from(`${JSON.stringify(entry)}\n`, 'utf-8')
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
