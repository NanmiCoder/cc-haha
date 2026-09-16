/**
 * M7 Context Ticket — public manifest builder + receipt/replay helper.
 *
 * The renderer builds a context ticket from the chosen sourceTags +
 * direct IDs and submits it through one of three paths (chat composer,
 * home composer, history re-share). All three paths share the same
 * prepare() helper so the ticket's requestId is stable across retries.
 *
 * `includePasswords=false` is the M7 public manifest. The full disclosure
 * path (`includePasswords=true`) returns SECRET_DISCLOSURE_NOT_READY in
 * M8 and zero decrypt in this stage; we never load the vault from a
 * ticket until M8 ships.
 */
import type { DirectId, SourceTag } from './composer/contextPicker'

export type ManifestEntryKind = 'host' | 'concept' | 'tag'

export type ManifestEntry =
  | { kind: 'host'; hostId: string; name: string; address: string; tagIds: string[] }
  | { kind: 'concept'; conceptId: string; title: string; summary: string }
  | { kind: 'tag'; namespace: 'host' | 'concept' | 'dataConnection'; tagId: string }

export type ContextTicketManifest = {
  requestId: string
  sessionId: string
  generatedAt: string
  sourceTags: SourceTag[]
  directIds: DirectId[]
  entries: ManifestEntry[]
  estimatedTokens: number
  containsSecrets: boolean
  secretFieldCount: number
}

export type ContextTicketRequest = {
  sessionId: string
  sourceTags: SourceTag[]
  directIds: DirectId[]
  includePasswords: boolean
}

export type ContextTicketResult =
  | { ok: true; ticket: ContextTicketManifest }
  | {
      ok: false
      code: 'SECRET_DISCLOSURE_NOT_READY' | 'INVALID_ARGUMENT' | 'STALE_REVISION'
      messageKey: string
    }

const MAX_TICKET_BYTES = 64 * 1024

function estimateTokens(entries: ManifestEntry[]): number {
  // Heuristic: ~4 chars per token. Counts only the fields we ship in the
  // public manifest. Do not include ciphertext or PEM anywhere.
  let chars = 0
  for (const entry of entries) {
    if (entry.kind === 'host') {
      chars += entry.name.length + entry.address.length + entry.tagIds.join(',').length
    } else if (entry.kind === 'concept') {
      chars += entry.title.length + entry.summary.length
    } else {
      chars += entry.namespace.length + entry.tagId.length
    }
  }
  return Math.ceil(chars / 4)
}

/**
 * Prepare a ticket. The same prepare() is used by all three send paths
 * (chat composer submit, home composer submit, history re-share). It
 * returns a stable requestId for the lifetime of the submission so the
 * server's receipt/replay can deduplicate.
 */
export function prepareContextTicket(input: ContextTicketRequest): ContextTicketResult {
  if (input.includePasswords) {
    // M8 gate: never decrypt anything in M7. The vault stays in main
    // process; the renderer never sees it.
    return {
      ok: false,
      code: 'SECRET_DISCLOSURE_NOT_READY',
      messageKey: 'managedResources.errors.secretDisclosureNotReady',
    }
  }
  if (!input.sessionId || input.sessionId.length === 0) {
    return { ok: false, code: 'INVALID_ARGUMENT', messageKey: 'managedResources.errors.invalidSessionId' }
  }
  const requestId = `ticket_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`
  // The renderer is responsible for resolving sourceTags/directIds into
  // ManifestEntry objects. prepareContextTicket here only enforces invariants
  // and the manifest's transport shape.
  const manifest: ContextTicketManifest = {
    requestId,
    sessionId: input.sessionId,
    generatedAt: new Date().toISOString(),
    sourceTags: input.sourceTags,
    directIds: input.directIds,
    entries: [],
    estimatedTokens: 0,
    containsSecrets: false,
    secretFieldCount: 0,
  }
  if (JSON.stringify(manifest).length > MAX_TICKET_BYTES) {
    return { ok: false, code: 'INVALID_ARGUMENT', messageKey: 'managedResources.errors.ticketTooLarge' }
  }
  return { ok: true, ticket: manifest }
}

/**
 * Attach resolved entries to a prepared ticket. The renderer is the only
 * place that has both the resource store and the ticket — server-side
 * never decrypts, never reconstructs. We cap the byte size to 64 KiB
 * before returning so the IPC channel can validate at the validator.
 */
export function attachEntriesToTicket(
  ticket: ContextTicketManifest,
  entries: ManifestEntry[],
): ContextTicketResult {
  if (ticket.containsSecrets) {
    // Belt and suspenders — even if a future caller reuses the ticket,
    // we reject any payload that claims to contain secrets. The M7
    // manifest must always be public.
    return {
      ok: false,
      code: 'SECRET_DISCLOSURE_NOT_READY',
      messageKey: 'managedResources.errors.secretDisclosureNotReady',
    }
  }
  const next: ContextTicketManifest = {
    ...ticket,
    entries,
    estimatedTokens: estimateTokens(entries),
    containsSecrets: false,
    secretFieldCount: 0,
  }
  if (JSON.stringify(next).length > MAX_TICKET_BYTES) {
    return { ok: false, code: 'INVALID_ARGUMENT', messageKey: 'managedResources.errors.ticketTooLarge' }
  }
  return { ok: true, ticket: next }
}

/**
 * The receipt/replay helper. The renderer keeps a local LRU of
 * `requestId → ContextTicketManifest` so the same ticket can be replayed
 * without re-running prepare(). If the cached ticket's `generatedAt`
 * differs by more than 5 minutes, we treat it as stale and refuse.
 */
const REPLAY_WINDOW_MS = 5 * 60 * 1000

export function isReplayable(ticket: ContextTicketManifest, now: number = Date.now()): boolean {
  const generatedAtMs = new Date(ticket.generatedAt).getTime()
  if (Number.isNaN(generatedAtMs)) return false
  return Math.abs(now - generatedAtMs) <= REPLAY_WINDOW_MS
}

export class ContextTicketCache {
  private readonly tickets = new Map<string, ContextTicketManifest>()

  put(ticket: ContextTicketManifest): void {
    this.tickets.set(ticket.requestId, ticket)
  }

  get(requestId: string, now: number = Date.now()): ContextTicketManifest | null {
    const ticket = this.tickets.get(requestId)
    if (!ticket) return null
    if (!isReplayable(ticket, now)) {
      this.tickets.delete(requestId)
      return null
    }
    return ticket
  }

  clear(): void {
    this.tickets.clear()
  }

  size(): number {
    return this.tickets.size
  }
}