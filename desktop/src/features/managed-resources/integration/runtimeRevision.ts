const revisions = new Map<string, number>()

export function recordManagedRuntimeRevision(sessionId: string, revision: number | undefined): void {
  if (!Number.isInteger(revision) || (revision ?? 0) < 1) return
  revisions.set(sessionId, revision!)
}

export function getManagedRuntimeRevision(sessionId: string): number | null {
  return revisions.get(sessionId) ?? null
}

export function clearManagedRuntimeRevision(sessionId?: string): void {
  if (sessionId === undefined) revisions.clear()
  else revisions.delete(sessionId)
}
