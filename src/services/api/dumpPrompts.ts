import type { ClientOptions } from '@anthropic-ai/sdk'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { getSessionId } from 'src/bootstrap/state.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import {
  captureResponseTraceSnapshot,
  createTraceCallId,
  createTraceBodySnapshot,
  shouldCaptureApiTrace,
  traceCaptureService,
} from './traceCapture.js'
import type { TraceBodySnapshot, TraceProviderInfo, TraceResponseCapture } from './traceCapture.js'

const TRACE_SESSION_HEADER = 'x-claude-code-session-id'

function hashString(str: string): string {
  return createHash('sha256').update(str).digest('hex')
}

// Cache last few API requests for ant users (e.g., for /issue command)
const MAX_CACHED_REQUESTS = 5
const cachedApiRequests: Array<{ timestamp: string; request: unknown }> = []

type DumpState = {
  initialized: boolean
  messageCountSeen: number
  lastInitDataHash: string
  // Cheap proxy for change detection — skips the expensive stringify+hash
  // when model/tools/system are structurally identical to the last call.
  lastInitFingerprint: string
}

// Track state per session to avoid duplicating data
const dumpState = new Map<string, DumpState>()

export function getLastApiRequests(): Array<{
  timestamp: string
  request: unknown
}> {
  return [...cachedApiRequests]
}

export function clearApiRequestCache(): void {
  cachedApiRequests.length = 0
}

export function clearDumpState(agentIdOrSessionId: string): void {
  dumpState.delete(agentIdOrSessionId)
}

export function clearAllDumpState(): void {
  dumpState.clear()
}

function getRequestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input)
}

function isLocalProviderProxyUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1') &&
      url.pathname.startsWith('/proxy/')
    )
  } catch {
    return false
  }
}

function getTraceProviderFromEnv(): TraceProviderInfo | undefined {
  const id = process.env.CC_HAHA_TRACE_PROVIDER_ID?.trim()
  const name = process.env.CC_HAHA_TRACE_PROVIDER_NAME?.trim()
  const format = process.env.CC_HAHA_TRACE_PROVIDER_FORMAT?.trim()
  if (!id && !name && !format) return undefined

  return {
    id: id || null,
    name: name || id || 'Provider',
    format: format || 'anthropic',
  }
}

export function addApiRequestToCache(requestData: unknown): void {
  if (process.env.USER_TYPE !== 'ant') return
  cachedApiRequests.push({
    timestamp: new Date().toISOString(),
    request: requestData,
  })
  if (cachedApiRequests.length > MAX_CACHED_REQUESTS) {
    cachedApiRequests.shift()
  }
}

export function getDumpPromptsPath(agentIdOrSessionId?: string): string {
  return join(
    getClaudeConfigHomeDir(),
    'dump-prompts',
    `${agentIdOrSessionId ?? getSessionId()}.jsonl`,
  )
}

function appendToFile(filePath: string, entries: string[]): void {
  if (entries.length === 0) return
  fs.mkdir(dirname(filePath), { recursive: true })
    .then(() => fs.appendFile(filePath, entries.join('\n') + '\n'))
    .catch(() => {})
}

function initFingerprint(req: Record<string, unknown>): string {
  const tools = req.tools as Array<{ name?: string }> | undefined
  const system = req.system as unknown[] | string | undefined
  const sysLen =
    typeof system === 'string'
      ? system.length
      : Array.isArray(system)
        ? system.reduce(
            (n: number, b) => n + ((b as { text?: string }).text?.length ?? 0),
            0,
          )
        : 0
  const toolNames = tools?.map(t => t.name ?? '').join(',') ?? ''
  return `${req.model}|${toolNames}|${sysLen}`
}

function dumpRequest(
  body: string,
  ts: string,
  state: DumpState,
  filePath: string,
): void {
  try {
    const req = jsonParse(body) as Record<string, unknown>
    addApiRequestToCache(req)

    if (process.env.USER_TYPE !== 'ant') return
    const entries: string[] = []
    const messages = (req.messages ?? []) as Array<{ role?: string }>

    // Write init data (system, tools, metadata) on first request,
    // and a system_update entry whenever it changes.
    // Cheap fingerprint first: system+tools don't change between turns,
    // so skip the 300ms stringify when the shape is unchanged.
    const fingerprint = initFingerprint(req)
    if (!state.initialized || fingerprint !== state.lastInitFingerprint) {
      const { messages: _, ...initData } = req
      const initDataStr = jsonStringify(initData)
      const initDataHash = hashString(initDataStr)
      state.lastInitFingerprint = fingerprint
      if (!state.initialized) {
        state.initialized = true
        state.lastInitDataHash = initDataHash
        // Reuse initDataStr rather than re-serializing initData inside a wrapper.
        // timestamp from toISOString() contains no chars needing JSON escaping.
        entries.push(
          `{"type":"init","timestamp":"${ts}","data":${initDataStr}}`,
        )
      } else if (initDataHash !== state.lastInitDataHash) {
        state.lastInitDataHash = initDataHash
        entries.push(
          `{"type":"system_update","timestamp":"${ts}","data":${initDataStr}}`,
        )
      }
    }

    // Write only new user messages (assistant messages captured in response)
    for (const msg of messages.slice(state.messageCountSeen)) {
      if (msg.role === 'user') {
        entries.push(
          jsonStringify({ type: 'message', timestamp: ts, data: msg }),
        )
      }
    }
    state.messageCountSeen = messages.length

    appendToFile(filePath, entries)
  } catch {
    // Ignore parsing errors
  }
}

function createRequestPendingSnapshot(body: unknown): TraceBodySnapshot {
  if (typeof body === 'string') {
    return createTraceBodySnapshot(body.slice(0, 4096), {
      alreadyTruncated: body.length > 4096,
    })
  }
  return createTraceBodySnapshot({
    pending: true,
    note: 'request body captured on call completion',
  })
}

function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

/**
 * Builds the error recorded for an aborted call. The fetch layer cannot see
 * which mechanism aborted the request (SDK client timeout surfaces upstream
 * as APIConnectionTimeoutError, the stream idle watchdog calls
 * stream.controller.abort(), user cancellation aborts the query signal), so
 * prefer the signal's abort reason when one was provided and otherwise name
 * the likely candidates.
 */
function normalizeAbortError(abortReason: unknown, fallback?: unknown): Error {
  if (abortReason instanceof Error) return abortReason
  if (abortReason !== undefined) return new Error(String(abortReason))
  if (fallback instanceof Error && isAbortLikeError(fallback)) return fallback
  const error = new Error(
    'Request aborted before the response completed (client timeout, stream idle watchdog, or user cancellation)',
  )
  error.name = 'AbortError'
  return error
}

export function createDumpPromptsFetch(
  agentIdOrSessionId: string,
  options?: {
    traceSessionId?: string
    querySource?: string
  },
): ClientOptions['fetch'] {
  const filePath = getDumpPromptsPath(agentIdOrSessionId)
  const traceEnabled = shouldCaptureApiTrace()
  const traceSessionId = options?.traceSessionId ?? agentIdOrSessionId

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const state = dumpState.get(agentIdOrSessionId) ?? {
      initialized: false,
      messageCountSeen: 0,
      lastInitDataHash: '',
      lastInitFingerprint: '',
    }
    dumpState.set(agentIdOrSessionId, state)

    let timestamp: string | undefined
    let traceStartedAtMs = 0
    let traceRequestBody: unknown

    if (init?.method === 'POST' && init.body) {
      timestamp = new Date().toISOString()
      traceStartedAtMs = Date.now()
      traceRequestBody = init.body
      // Parsing + stringifying the request (system prompt + tool schemas = MBs)
      // takes hundreds of ms. Defer so it doesn't block the actual API call —
      // this is debug tooling for /issue, not on the critical path.
      setImmediate(dumpRequest, init.body as string, timestamp, state, filePath)
    }

    const requestUrl = getRequestUrl(input)
    const isProviderProxyTrace = traceEnabled && isLocalProviderProxyUrl(requestUrl)
    const traceProvider = getTraceProviderFromEnv()
    const requestInit = isProviderProxyTrace
      ? {
          ...init,
          headers: (() => {
            const headers = new Headers(init?.headers)
            if (!headers.has(TRACE_SESSION_HEADER)) {
              headers.set(TRACE_SESSION_HEADER, traceSessionId)
            }
            return headers
          })(),
        }
      : init

    const traceModel = extractModelFromRequestBody(traceRequestBody)
    const traceCallId = timestamp && traceEnabled && !isProviderProxyTrace
      ? createTraceCallId()
      : undefined

    if (timestamp && traceCallId) {
      void traceCaptureService.recordCall({
        id: traceCallId,
        sessionId: traceSessionId,
        source: 'anthropic',
        querySource: options?.querySource,
        provider: traceProvider,
        model: traceModel,
        status: 'pending',
        startedAt: timestamp,
        request: {
          method: init?.method ?? 'POST',
          url: requestUrl,
          headers: requestInit?.headers as Headers | Record<string, string> | undefined,
          bodySnapshot: createRequestPendingSnapshot(traceRequestBody),
        },
        metadata: {
          phase: 'api_call_started',
        },
      })
      void traceCaptureService.recordEvent({
        sessionId: traceSessionId,
        callId: traceCallId,
        source: 'anthropic',
        provider: traceProvider,
        model: traceModel,
        timestamp,
        phase: 'api_call_started',
        severity: 'info',
        title: 'API call started',
        metadata: {
          url: requestUrl,
        },
      })
    }

    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    let response: Response
    try {
      response = await globalThis.fetch(input, requestInit)
    } catch (err) {
      if (timestamp && traceCallId) {
        const completedAt = new Date().toISOString()
        const aborted = Boolean(init?.signal?.aborted) || isAbortLikeError(err)
        void traceCaptureService.recordCall({
          id: traceCallId,
          sessionId: traceSessionId,
          source: 'anthropic',
          querySource: options?.querySource,
          provider: traceProvider,
          model: traceModel,
          status: 'error',
          startedAt: timestamp,
          completedAt,
          durationMs: Date.now() - traceStartedAtMs,
          request: {
            method: init?.method ?? 'POST',
            url: requestUrl,
            headers: requestInit?.headers as Headers | Record<string, string> | undefined,
            bodySnapshot: createRequestPendingSnapshot(traceRequestBody),
          },
          error: err,
          metadata: {
            phase: 'api_call_failed',
            ...(aborted ? { aborted: true } : {}),
          },
        })
        void traceCaptureService.recordEvent({
          sessionId: traceSessionId,
          callId: traceCallId,
          source: 'anthropic',
          provider: traceProvider,
          model: traceModel,
          timestamp: completedAt,
          phase: 'api_call_failed',
          severity: 'error',
          title: 'API call failed',
          message: err instanceof Error ? err.message : String(err),
          metadata: {
            url: requestUrl,
            ...(aborted ? { aborted: true } : {}),
          },
        })
      }
      throw err
    }

    if (timestamp && traceCallId) {
      const cloned = response.clone()
      const abortSignal = init?.signal ?? undefined
      void (async () => {
        const callBase = {
          id: traceCallId,
          sessionId: traceSessionId,
          source: 'anthropic' as const,
          querySource: options?.querySource,
          provider: traceProvider,
          model: traceModel,
          startedAt: timestamp,
          request: {
            method: init?.method ?? 'POST',
            url: requestUrl,
            headers: requestInit?.headers as Headers | Record<string, string> | undefined,
            body: traceRequestBody,
          },
        }
        const eventBase = {
          sessionId: traceSessionId,
          callId: traceCallId,
          source: 'anthropic' as const,
          provider: traceProvider,
          model: traceModel,
        }

        // captureResponseTraceSnapshot ends promptly when the request is
        // aborted mid-body (SDK client timeout, stream idle watchdog,
        // non-streaming fallback timeout). Waiting on the clone alone could
        // hang forever on a wedged stream, leaving this call pending in the
        // trace panel with no completion or error record (#766).
        let capture: TraceResponseCapture | undefined
        let captureFailure: unknown
        try {
          capture = await captureResponseTraceSnapshot(cloned, { signal: abortSignal })
        } catch (err) {
          captureFailure = err
        }

        if (capture && !capture.aborted) {
          await traceCaptureService.recordCall({
            ...callBase,
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - traceStartedAtMs,
            response: {
              status: response.status,
              headers: response.headers,
              bodySnapshot: capture.snapshot,
            },
            metadata: {
              phase: 'api_call_completed',
            },
          })
          await traceCaptureService.recordEvent({
            ...eventBase,
            phase: 'api_call_completed',
            severity: response.ok ? 'info' : 'warning',
            title: 'API call completed',
            metadata: {
              status: response.status,
              url: requestUrl,
            },
          })
          return
        }

        const completedAt = new Date().toISOString()
        const durationMs = Date.now() - traceStartedAtMs
        if (capture?.aborted) {
          const abortError = normalizeAbortError(capture.abortReason, captureFailure)
          await traceCaptureService.recordCall({
            ...callBase,
            status: 'error',
            completedAt,
            durationMs,
            response: {
              status: response.status,
              headers: response.headers,
              bodySnapshot: capture.snapshot,
            },
            error: abortError,
            metadata: {
              phase: 'api_call_aborted',
              aborted: true,
            },
          })
          await traceCaptureService.recordEvent({
            ...eventBase,
            timestamp: completedAt,
            phase: 'api_call_aborted',
            severity: 'error',
            title: 'API call aborted',
            message: abortError.message,
            metadata: {
              status: response.status,
              url: requestUrl,
              durationMs,
              aborted: true,
            },
          })
          return
        }

        await traceCaptureService.recordEvent({
          ...eventBase,
          timestamp: completedAt,
          phase: 'response_capture_failed',
          severity: 'warning',
          title: 'Response capture failed',
          message: captureFailure instanceof Error ? captureFailure.message : String(captureFailure),
          metadata: {
            status: response.status,
            url: requestUrl,
          },
        })
        // The clone shares the upstream source with the SDK's branch, so a
        // read failure here almost certainly failed the real request too.
        // Record an error state instead of letting the call sit pending.
        await traceCaptureService.recordCall({
          ...callBase,
          status: 'error',
          completedAt,
          durationMs,
          response: {
            status: response.status,
            headers: response.headers,
          },
          error: captureFailure,
          metadata: {
            phase: 'response_capture_failed',
            responseCaptureFailed: true,
          },
        })
      })()
    }

    // Save response async
    if (timestamp && response.ok && process.env.USER_TYPE === 'ant') {
      const cloned = response.clone()
      void (async () => {
        try {
          const isStreaming = cloned.headers
            .get('content-type')
            ?.includes('text/event-stream')

          let data: unknown
          if (isStreaming && cloned.body) {
            // Parse SSE stream into chunks
            const reader = cloned.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true })
              }
            } finally {
              reader.releaseLock()
            }
            const chunks: unknown[] = []
            for (const event of buffer.split('\n\n')) {
              for (const line of event.split('\n')) {
                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                  try {
                    chunks.push(jsonParse(line.slice(6)))
                  } catch {
                    // Ignore parse errors
                  }
                }
              }
            }
            data = { stream: true, chunks }
          } else {
            data = await cloned.json()
          }

          await fs.appendFile(
            filePath,
            jsonStringify({ type: 'response', timestamp, data }) + '\n',
          )
        } catch {
          // Best effort
        }
      })()
    }

    return response
  }
}

function extractModelFromRequestBody(body: unknown): string | undefined {
  try {
    const parsed = typeof body === 'string' ? jsonParse(body) : body
    if (parsed && typeof parsed === 'object' && 'model' in parsed && typeof parsed.model === 'string') {
      return parsed.model
    }
  } catch {
    // Best effort only.
  }
  return undefined
}
