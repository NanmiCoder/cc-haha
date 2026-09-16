/**
 * Server-owned runtime revision per session.
 *
 * §8.1 step 2: the client confirms its runtime configuration and receives a
 * server-incremented `runtimeRevision`; a staged ticket is bound to that
 * revision so a message cannot land after the session runtime changed.
 *
 * The repository had no such counter before M7 (the WS handler keeps a private
 * `runtimeOverrideVersions` map used for a different purpose). M7-A owns the
 * counter and its fail-closed default; M7-B must call `apply()`/`bump()` from
 * the WS `runtime_config_applied` path so a client-observed revision can be
 * compared with the server's own value. Until that wiring exists, a session
 * with no recorded revision is rejected with RUNTIME_REVISION_UNAVAILABLE.
 */

export class ServerRuntimeRevisions {
  private readonly revisions = new Map<string, number>()

  /** Current revision for a session, or null when none has been applied yet. */
  current(sessionId: string): number | null {
    return this.revisions.get(sessionId) ?? null
  }

  /** Ensure every live client session has a baseline revision before its first turn. */
  ensure(sessionId: string): number {
    const existing = this.revisions.get(sessionId)
    if (existing !== undefined) return existing
    this.revisions.set(sessionId, 1)
    return 1
  }

  /** Record the revision the server just applied; stale reports are ignored. */
  apply(sessionId: string, revision: number): number {
    const existing = this.revisions.get(sessionId) ?? 0
    const next = Math.max(existing, revision)
    this.revisions.set(sessionId, next)
    return next
  }

  /** Advance the session revision by one and return the new value. */
  bump(sessionId: string): number {
    const next = (this.revisions.get(sessionId) ?? 0) + 1
    this.revisions.set(sessionId, next)
    return next
  }

  clear(sessionId?: string): void {
    if (sessionId === undefined) {
      this.revisions.clear()
      return
    }
    this.revisions.delete(sessionId)
  }
}

export const serverRuntimeRevisions = new ServerRuntimeRevisions()
