import { sessionsApi } from '../../api/sessions'
import { getBaseUrl } from '../../api/client'
import type { TraceCallRecord } from '../../types/trace'

const callCache = new Map<string, { call: TraceCallRecord; bytes: number }>()
let cachedBytes = 0
const TRACE_CALL_CACHE_MAX_BYTES = 16 * 1024 * 1024
const TRACE_CALL_CACHE_MAX_ENTRIES = 32

export async function fetchTraceCallDetail(
  sessionId: string,
  callId: string,
  revisionKey?: string,
): Promise<TraceCallRecord | null> {
  // revisionKey is the call's own content, not the session revision. Callers pass
  // the same key for an unchanged call, so a sibling span does not bust this cache.
  const prefix = `${getBaseUrl()}\0${sessionId}\0${callId}\0`
  const key = `${prefix}${revisionKey ?? 'legacy'}`
  const cached = callCache.get(key)
  if (cached) {
    callCache.delete(key)
    callCache.set(key, cached)
    return cached.call
  }
  for (const existingKey of callCache.keys()) {
    if (existingKey.startsWith(prefix)) removeCachedCall(existingKey)
  }
  try {
    const result = await sessionsApi.getTraceCall(sessionId, callId)
    const call = result?.call
    if (!call) return null
    const bytes = estimateRetainedBytes(call)
    if (isTerminalCall(call) && bytes <= TRACE_CALL_CACHE_MAX_BYTES) {
      removeCachedCall(key)
      callCache.set(key, { call, bytes })
      cachedBytes += bytes
      while (callCache.size > TRACE_CALL_CACHE_MAX_ENTRIES || cachedBytes > TRACE_CALL_CACHE_MAX_BYTES) {
        const oldestKey = callCache.keys().next().value
        if (oldestKey === undefined) break
        removeCachedCall(oldestKey)
      }
    }
    return call
  } catch {
    return null
  }
}

export function clearTraceCallCache(): void {
  callCache.clear()
  cachedBytes = 0
}

function isTerminalCall(call: TraceCallRecord): boolean {
  if (call.status === 'ok' || call.status === 'error') return true
  if (call.status === 'pending') return false
  return Boolean(call.response || call.error)
}


function removeCachedCall(key: string): void {
  const entry = callCache.get(key)
  if (!entry) return
  cachedBytes -= entry.bytes
  callCache.delete(key)
}

// Count strings and parsed semantic payloads without serializing a second copy.
// This is a conservative retention budget, not an exact JS heap measurement.
function estimateRetainedBytes(value: unknown): number {
  let bytes = 0
  const seen = new WeakSet<object>()
  function visit(item: unknown, depth: number): void {
    if (bytes > TRACE_CALL_CACHE_MAX_BYTES) return
    if (typeof item === 'string') bytes += 32 + item.length * 2
    else if (item && typeof item === 'object') {
      if (seen.has(item)) return
      seen.add(item)
      if (depth > 128) {
        bytes = TRACE_CALL_CACHE_MAX_BYTES + 1
        return
      }
      bytes += 64
      for (const key in item) {
        if (!Object.prototype.hasOwnProperty.call(item, key)) continue
        bytes += 16 + key.length * 2
        visit((item as Record<string, unknown>)[key], depth + 1)
        if (bytes > TRACE_CALL_CACHE_MAX_BYTES) break
      }
    } else bytes += 8
  }
  visit(value, 0)
  return bytes
}
