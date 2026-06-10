import { sessionsApi } from '../../api/sessions'
import type { TraceCallRecord } from '../../types/trace'

const callCache = new Map<string, TraceCallRecord>()

export async function fetchTraceCallDetail(sessionId: string, callId: string): Promise<TraceCallRecord | null> {
  const key = `${sessionId}:${callId}`
  const cached = callCache.get(key)
  if (cached) return cached
  try {
    const result = await sessionsApi.getTraceCall(sessionId, callId)
    const call = result?.call
    if (!call) return null
    if (isTerminalCall(call)) callCache.set(key, call)
    return call
  } catch {
    return null
  }
}

export function clearTraceCallCache(): void {
  callCache.clear()
}

function isTerminalCall(call: TraceCallRecord): boolean {
  if (call.status === 'ok' || call.status === 'error') return true
  if (call.status === 'pending') return false
  return Boolean(call.response || call.error)
}
