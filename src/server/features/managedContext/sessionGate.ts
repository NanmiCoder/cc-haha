/**
 * Session/runtime gate for context staging (§8.2: staging must be reconciled
 * with the server's current session and runtime state).
 *
 * Only two things are decided here: does the session exist on this server, and
 * does the revision the client staged against still match the server's own
 * runtime revision. Team/sub-agent session eligibility and the live WS
 * transition wait are M7-B work (they need the conversation/team services and
 * the WS lifecycle), so this gate does not pretend to cover them.
 */

import type { ServerRuntimeRevisions } from './runtimeRevision.js'
import { serverRuntimeRevisions } from './runtimeRevision.js'

export type StageSessionState = {
  exists: boolean
  runtimeRevision: number | null
}

export interface ManagedContextStageSessionSource {
  read(sessionId: string): Promise<StageSessionState>
}

export type StageSessionResolution =
  | { ok: true; runtimeRevision: number }
  | {
      ok: false
      code:
        | 'SESSION_NOT_FOUND'
        | 'RUNTIME_REVISION_UNAVAILABLE'
        | 'RUNTIME_REVISION_MISMATCH'
    }

export interface ManagedContextSessionGate {
  resolve(input: { sessionId: string; runtimeRevision: number }): Promise<StageSessionResolution>
}

/**
 * Default source: real session existence through `sessionService` (loaded
 * lazily so the staging route does not pull the whole session index into
 * routes that never stage context), plus the server runtime-revision counter.
 */
export function createServerStageSessionSource(
  revisions: ServerRuntimeRevisions = serverRuntimeRevisions,
): ManagedContextStageSessionSource {
  return {
    async read(sessionId: string): Promise<StageSessionState> {
      const { sessionService } = await import('../../services/sessionService.js')
      const session = await sessionService.getSession(sessionId)
      return {
        exists: session !== null,
        runtimeRevision: revisions.current(sessionId),
      }
    },
  }
}

export function createServerSessionGate(
  source: ManagedContextStageSessionSource = createServerStageSessionSource(),
): ManagedContextSessionGate {
  return {
    async resolve({ sessionId, runtimeRevision }) {
      const state = await source.read(sessionId)
      if (!state.exists) {
        return { ok: false, code: 'SESSION_NOT_FOUND' }
      }
      if (state.runtimeRevision === null) {
        return { ok: false, code: 'RUNTIME_REVISION_UNAVAILABLE' }
      }
      if (state.runtimeRevision !== runtimeRevision) {
        return { ok: false, code: 'RUNTIME_REVISION_MISMATCH' }
      }
      return { ok: true, runtimeRevision: state.runtimeRevision }
    },
  }
}
