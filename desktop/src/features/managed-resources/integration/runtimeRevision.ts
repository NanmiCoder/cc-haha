const revisions = new Map<string, number>()
const pendingRuntime = new Set<string>()
const listeners = new Map<string, Set<(revision: number | null) => void>>()

export function markManagedRuntimePending(sessionId: string): void {
  pendingRuntime.add(sessionId)
}

export function recordManagedRuntimeRevision(sessionId: string, revision: number | undefined, applied = false): void {
  if (!Number.isInteger(revision) || (revision ?? 0) < 1) return
  // A connected baseline cannot acknowledge an in-flight set_runtime_config.
  if (pendingRuntime.has(sessionId) && !applied) return
  pendingRuntime.delete(sessionId)
  revisions.set(sessionId, revision!)
  for (const listener of [...(listeners.get(sessionId) ?? [])]) listener(revision!)
}

export function getManagedRuntimeRevision(sessionId: string): number | null {
  return pendingRuntime.has(sessionId) ? null : revisions.get(sessionId) ?? null
}

export function waitForManagedRuntimeRevision(sessionId: string, signal: AbortSignal, timeoutMs = 10_000): Promise<number> {
  if (signal.aborted) return Promise.reject(new Error('CANCELLED'))
  const revision = getManagedRuntimeRevision(sessionId)
  if (revision !== null) return Promise.resolve(revision)
  return new Promise((resolve, reject) => {
    const waiting = listeners.get(sessionId) ?? new Set<(value: number | null) => void>()
    const finish = (value: number | null, code = 'CANCELLED') => {
      clearTimeout(timer)
      waiting.delete(onRevision)
      if (waiting.size === 0) listeners.delete(sessionId)
      signal.removeEventListener('abort', onAbort)
      if (value === null) reject(new Error(code))
      else resolve(value)
    }
    const onRevision = (value: number | null) => finish(value)
    const onAbort = () => finish(null)
    const timer = setTimeout(() => finish(null, 'RUNTIME_REVISION_UNAVAILABLE'), timeoutMs)
    waiting.add(onRevision)
    listeners.set(sessionId, waiting)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function clearManagedRuntimeRevision(sessionId?: string): void {
  if (sessionId === undefined) {
    revisions.clear(); pendingRuntime.clear()
    for (const waiting of listeners.values()) for (const listener of [...waiting]) listener(null)
    listeners.clear()
  } else {
    revisions.delete(sessionId); pendingRuntime.delete(sessionId)
    for (const listener of [...(listeners.get(sessionId) ?? [])]) listener(null)
    listeners.delete(sessionId)
  }
}
