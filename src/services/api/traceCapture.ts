import { createHash, randomUUID } from 'crypto'
import { existsSync, readFileSync, statSync } from 'fs'
import { promises as fs } from 'fs'
import type { Stats } from 'fs'
import { dirname, join } from 'path'
import { getClaudeConfigHomeDir, isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'

const TRACE_PREVIEW_CHARS = 240_000
export const TRACE_STREAM_CAPTURE_BYTES = 1024 * 1024
export const TRACE_LIST_PREVIEW_CHARS = 2048
const TRACE_SETTINGS_KEY = 'traceCapture'
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
  calls: TraceCallRecord[]
  events: TraceEventRecord[]
}

const traceWriteQueues = new Map<string, Promise<void>>()
const traceReadCache = new Map<string, TraceReadCacheEntry>()

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

export function readTraceCaptureSettingsSync(): TraceCaptureSettings {
  const settings = readManagedSettingsSync()
  return normalizeTraceCaptureSettings(settings)
}

export async function readTraceCaptureSettings(): Promise<TraceCaptureSettings> {
  const settings = await readManagedSettings()
  return normalizeTraceCaptureSettings(settings)
}

export async function updateTraceCaptureSettings(input: Partial<Pick<TraceCaptureSettings, 'enabled'>>): Promise<TraceCaptureSettings> {
  const current = await readManagedSettings()
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
  await writeManagedSettings(nextSettings)
  return normalizeTraceCaptureSettings(nextSettings)
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
    const { calls, events } = await readTraceEntries(sessionId)
    return {
      sessionId,
      summary: summarizeCalls(calls),
      calls,
      events,
    }
  }

  async getSessionTraceCall(sessionId: string, callId: string): Promise<TraceCallRecord | null> {
    const { calls } = await readTraceEntries(sessionId)
    return calls.find((call) => call.id === callId) ?? null
  }

  async listSessionTraces(options?: {
    limit?: number
    offset?: number
    query?: string
    all?: boolean
    sessionIds?: string[]
  }): Promise<TraceSessionList> {
    const storageDir = getTraceStorageDir()
    const settings = await readTraceCaptureSettings()
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
      const trace = await this.getSessionTrace(sessionId)
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
    const storageDir = getTraceStorageDir()
    const settings = await readTraceCaptureSettings()
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
      graceTimer = setTimeout(() => resolve('forced'), options?.abortGraceMs ?? TRACE_ABORT_CAPTURE_GRACE_MS)
      graceTimer.unref?.()
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

async function appendTraceEntry(sessionId: string, entry: TraceFileEntry): Promise<void> {
  const previous = traceWriteQueues.get(sessionId) ?? Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(async () => {
      const filePath = getTraceFilePath(sessionId)
      await fs.mkdir(dirname(filePath), { recursive: true })
      await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf-8')
      traceReadCache.delete(filePath)
    })
  traceWriteQueues.set(sessionId, next)
  try {
    await next
  } finally {
    if (traceWriteQueues.get(sessionId) === next) {
      traceWriteQueues.delete(sessionId)
    }
  }
}

async function listTraceFiles(storageDir: string): Promise<Array<{ name: string; size: number; updatedAt: string }>> {
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
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
      }
    }))
  return files.filter((file): file is { name: string; size: number; updatedAt: string } => file !== null)
}

async function readTraceEntries(sessionId: string): Promise<{ calls: TraceCallRecord[]; events: TraceEventRecord[] }> {
  const filePath = getTraceFilePath(sessionId)
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
    return { calls: cached.calls, events: cached.events }
  }

  let raw = ''
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      traceReadCache.delete(filePath)
      return { calls: [], events: [] }
    }
    throw error
  }

  const callsById = new Map<string, TraceCallRecord>()
  const events: TraceEventRecord[] = []

  for (const entry of raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as TraceFileEntry]
      } catch {
        return []
      }
    })) {
    if (!entry || typeof entry !== 'object') continue

    if ('type' in entry && entry.type === 'event') {
      if (isTraceEventRecordLike(entry.event)) {
        events.push(entry.event)
      }
      continue
    }

    const call = 'type' in entry && entry.type === 'call' ? entry.record : entry
    if (isTraceCallRecordLike(call)) {
      callsById.set(call.id, call)
    }
  }

  const calls = Array.from(callsById.values())
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map((call) => attachCallUsage(call))
  const sortedEvents = events.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

  traceReadCache.set(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    calls,
    events: sortedEvents,
  })

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

function getTraceFilePath(sessionId: string): string {
  return join(getTraceStorageDir(), `${sanitizeTraceFileName(sessionId)}.jsonl`)
}

function sanitizeTraceFileName(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function getManagedSettingsPath(): string {
  return join(getClaudeConfigHomeDir(), 'cc-haha', 'settings.json')
}

function defaultTraceCaptureSettings(): TraceCaptureSettings {
  return {
    enabled: true,
    storageDir: getTraceStorageDir(),
  }
}

function normalizeTraceCaptureSettings(settings: Record<string, unknown>): TraceCaptureSettings {
  const defaultSettings = defaultTraceCaptureSettings()
  const traceCapture = settings[TRACE_SETTINGS_KEY]
  if (!traceCapture || typeof traceCapture !== 'object' || Array.isArray(traceCapture)) {
    return defaultSettings
  }

  return {
    ...defaultSettings,
    enabled: (traceCapture as Record<string, unknown>).enabled !== false,
  }
}

function readManagedSettingsSync(): Record<string, unknown> {
  const filePath = getManagedSettingsPath()
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

async function readManagedSettings(): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await fs.readFile(getManagedSettingsPath(), 'utf-8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    return {}
  }
}

async function writeManagedSettings(settings: Record<string, unknown>): Promise<void> {
  const filePath = getManagedSettingsPath()
  const tmpFile = `${filePath}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`
  await fs.mkdir(dirname(filePath), { recursive: true })
  await fs.writeFile(tmpFile, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
  await fs.rename(tmpFile, filePath)
}

function clampListLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 50
  return Math.min(Math.max(Math.round(limit), 1), 200)
}
