/**
 * In-memory managed-context ticket store and receipt skeleton (M7.2 / M7.3).
 *
 * Everything here lives in process memory: staged snapshots, tickets and
 * receipts are never written to disk (receipt persistence is M7-B). The store
 * enforces the §8.2 limits: 120 s TTL, 4 tickets per session, 64 global, and
 * an 8 MiB total staged-snapshot budget.
 *
 * Receipts carry only public data: the request/session identity, the runtime
 * revision, the ticket binding hashes and a status. The staged model context
 * never appears in a receipt.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { canonicalJson, sha256Hex } from '../../../services/managedContext/canonicalSerializer.js'
import type { PublicContextManifestV2 } from '../../../services/managedContext/types.js'

export const CONTEXT_TICKET_TTL_MS = 120_000
export const CONTEXT_TICKETS_PER_SESSION_LIMIT = 4
export const CONTEXT_TICKETS_GLOBAL_LIMIT = 64
export const CONTEXT_SNAPSHOT_TOTAL_BYTES_LIMIT = 8 * 1024 * 1024
/** POST body ceiling for the staging route. */
export const CONTEXT_STAGE_BODY_BYTES_LIMIT = 512 * 1024
/** modelContext ceiling (the injected context itself, §7.1/§8.2). */
export const CONTEXT_MODEL_CONTEXT_BYTES_LIMIT = 64 * 1024

export type ContextTicketReceiptStatus =
  | 'prepared'
  | 'dispatching'
  | 'accepted'
  | 'observed'
  | 'rejected'
  | 'delivery-unknown'

/** Legal receipt transitions (§8.3). Exported so the durable M7-B receipt store shares one map. */
export const CONTEXT_RECEIPT_TRANSITIONS: Record<
  ContextTicketReceiptStatus,
  ContextTicketReceiptStatus[]
> = {
  prepared: ['dispatching', 'rejected'],
  dispatching: ['accepted', 'rejected', 'delivery-unknown'],
  accepted: ['observed'],
  observed: [],
  rejected: [],
  // Process recovery re-checks the SDK transcript: found -> accepted, gone -> rejected.
  'delivery-unknown': ['accepted', 'rejected'],
}

export type ContextTicketRecord = {
  ticketId: string
  sidecarInstanceId: string
  sessionId: string
  requestId: string
  runtimeRevision: number
  contentBinding: string
  contextBinding: string
  publicManifest: PublicContextManifestV2
  /** main -> sidecar only; never logged, never returned by the API. */
  modelContext: string
  stagedAtMs: number
  expiresAt: string
  snapshotBytes: number
}

export type ContextTicketReceipt = {
  requestId: string
  sessionId: string
  runtimeRevision: number
  ticketId: string
  contentBinding: string
  contextBinding: string
  /** SHA-256 over ticketId + requestId + both bindings. */
  ticketBindingHash: string
  status: ContextTicketReceiptStatus
  createdAt: string
  updatedAt: string
  rejection?: { code: string; retryable: boolean }
}

export type ContextTicketStageInput = {
  sessionId: string
  requestId: string
  runtimeRevision: number
  contentBinding: string
  contextBinding: string
  publicManifest: PublicContextManifestV2
  modelContext: string
}

export type StageTicketFailureCode =
  | 'TICKET_SESSION_LIMIT_REACHED'
  | 'TICKET_GLOBAL_LIMIT_REACHED'
  | 'TICKET_SNAPSHOT_LIMIT_REACHED'

export type StageTicketResult =
  | { ok: true; ticket: ContextTicketRecord }
  | { ok: false; code: StageTicketFailureCode; message: string }

export type ConsumeTicketFailureCode =
  | 'TICKET_NOT_FOUND'
  | 'TICKET_EXPIRED'
  | 'TICKET_BINDING_MISMATCH'
  | 'RUNTIME_REVISION_MISMATCH'

export type ConsumeTicketResult =
  | { ok: true; ticket: ContextTicketRecord }
  | { ok: false; code: ConsumeTicketFailureCode; message: string }

export type ContextTicketStoreOptions = {
  now?: () => number
  generateTicketId?: () => string
  sidecarInstanceId?: string
  /** Test seam only; production uses the §8.2 constants. */
  limits?: {
    ttlMs?: number
    perSession?: number
    global?: number
    snapshotBytesTotal?: number
  }
}

function receiptKey(sessionId: string, requestId: string): string {
  return `${sessionId}\u0000${requestId}`
}

function snapshotSize(manifest: PublicContextManifestV2, modelContext: string): number {
  return Buffer.byteLength(canonicalJson(manifest), 'utf8') + Buffer.byteLength(modelContext, 'utf8')
}

export class ContextTicketStore {
  private readonly tickets = new Map<string, ContextTicketRecord>()
  private readonly receipts = new Map<string, ContextTicketReceipt>()
  private readonly now: () => number
  private readonly generateTicketId: () => string
  private readonly ttlMs: number
  private readonly perSessionLimit: number
  private readonly globalLimit: number
  private readonly snapshotBytesLimit: number
  readonly sidecarInstanceId: string

  constructor(options: ContextTicketStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    // 256-bit random base64url id, per the pinned ticket contract.
    this.generateTicketId =
      options.generateTicketId ?? (() => randomBytes(32).toString('base64url'))
    this.sidecarInstanceId = options.sidecarInstanceId ?? randomUUID()
    this.ttlMs = options.limits?.ttlMs ?? CONTEXT_TICKET_TTL_MS
    this.perSessionLimit = options.limits?.perSession ?? CONTEXT_TICKETS_PER_SESSION_LIMIT
    this.globalLimit = options.limits?.global ?? CONTEXT_TICKETS_GLOBAL_LIMIT
    this.snapshotBytesLimit =
      options.limits?.snapshotBytesTotal ?? CONTEXT_SNAPSHOT_TOTAL_BYTES_LIMIT
  }

  /** Drop tickets whose TTL elapsed. Receipts are kept (public, tiny). */
  pruneExpired(nowMs = this.now()): number {
    let removed = 0
    for (const [ticketId, ticket] of this.tickets) {
      if (ticket.stagedAtMs + this.ttlMs <= nowMs) {
        this.tickets.delete(ticketId)
        removed += 1
      }
    }
    return removed
  }

  get snapshotBytesTotal(): number {
    let total = 0
    for (const ticket of this.tickets.values()) total += ticket.snapshotBytes
    return total
  }

  stage(input: ContextTicketStageInput): StageTicketResult {
    const nowMs = this.now()
    this.pruneExpired(nowMs)

    let sessionTickets = 0
    for (const ticket of this.tickets.values()) {
      if (ticket.sessionId === input.sessionId) sessionTickets += 1
    }
    if (sessionTickets >= this.perSessionLimit) {
      return {
        ok: false,
        code: 'TICKET_SESSION_LIMIT_REACHED',
        message: `Session already holds ${sessionTickets} uncommitted context tickets`,
      }
    }
    if (this.tickets.size >= this.globalLimit) {
      return {
        ok: false,
        code: 'TICKET_GLOBAL_LIMIT_REACHED',
        message: `Server already holds ${this.tickets.size} uncommitted context tickets`,
      }
    }

    const snapshotBytes = snapshotSize(input.publicManifest, input.modelContext)
    if (this.snapshotBytesTotal + snapshotBytes > this.snapshotBytesLimit) {
      return {
        ok: false,
        code: 'TICKET_SNAPSHOT_LIMIT_REACHED',
        message: 'Staged snapshot budget exhausted',
      }
    }

    const ticket: ContextTicketRecord = {
      ticketId: this.generateTicketId(),
      sidecarInstanceId: this.sidecarInstanceId,
      sessionId: input.sessionId,
      requestId: input.requestId,
      runtimeRevision: input.runtimeRevision,
      contentBinding: input.contentBinding,
      contextBinding: input.contextBinding,
      publicManifest: input.publicManifest,
      modelContext: input.modelContext,
      stagedAtMs: nowMs,
      expiresAt: new Date(nowMs + this.ttlMs).toISOString(),
      snapshotBytes,
    }
    this.tickets.set(ticket.ticketId, ticket)
    this.upsertPreparedReceipt(ticket)
    return { ok: true, ticket }
  }

  getTicket(ticketId: string): ContextTicketRecord | null {
    return this.tickets.get(ticketId) ?? null
  }

  /** Revoke an uncommitted ticket; the prepared receipt turns `rejected`. */
  revokeTicket(ticketId: string): boolean {
    const ticket = this.tickets.get(ticketId)
    if (!ticket) return false
    this.tickets.delete(ticketId)
    const receipt = this.receipts.get(receiptKey(ticket.sessionId, ticket.requestId))
    if (receipt && (receipt.status === 'prepared' || receipt.status === 'dispatching')) {
      this.transitionReceipt(ticket.sessionId, ticket.requestId, 'rejected', {
        code: 'TICKET_REVOKED',
        retryable: true,
      })
    }
    return true
  }

  /**
   * Bind a user message to a staged ticket. This is the M7-B WS seam: session,
   * request id and runtime revision must all match what was staged.
   */
  consumeTicket(
    ticketId: string,
    binding: { sessionId: string; requestId: string; runtimeRevision: number },
  ): ConsumeTicketResult {
    const ticket = this.tickets.get(ticketId)
    if (!ticket) {
      return { ok: false, code: 'TICKET_NOT_FOUND', message: 'Unknown context ticket' }
    }
    if (ticket.stagedAtMs + this.ttlMs <= this.now()) {
      this.tickets.delete(ticketId)
      return { ok: false, code: 'TICKET_EXPIRED', message: 'Context ticket expired' }
    }
    if (ticket.sessionId !== binding.sessionId || ticket.requestId !== binding.requestId) {
      return {
        ok: false,
        code: 'TICKET_BINDING_MISMATCH',
        message: 'Ticket was staged for another session or request',
      }
    }
    if (ticket.runtimeRevision !== binding.runtimeRevision) {
      return {
        ok: false,
        code: 'RUNTIME_REVISION_MISMATCH',
        message: `Ticket was staged for runtime revision ${ticket.runtimeRevision}`,
      }
    }
    return { ok: true, ticket }
  }

  /** Remove the staged snapshot once the message has been handed to the SDK. */
  consumeSecretSnapshot(ticketId: string): void {
    this.tickets.delete(ticketId)
  }

  getReceipt(requestId: string, sessionId: string): ContextTicketReceipt | null {
    return this.receipts.get(receiptKey(sessionId, requestId)) ?? null
  }

  /**
   * Idempotent prepare receipt: re-staging the same (sessionId, requestId)
   * keeps the more advanced status. Full requestId conflict handling is M7-B.
   */
  private upsertPreparedReceipt(ticket: ContextTicketRecord): void {
    const key = receiptKey(ticket.sessionId, ticket.requestId)
    if (this.receipts.has(key)) return
    const timestamp = new Date(ticket.stagedAtMs).toISOString()
    this.receipts.set(key, {
      requestId: ticket.requestId,
      sessionId: ticket.sessionId,
      runtimeRevision: ticket.runtimeRevision,
      ticketId: ticket.ticketId,
      contentBinding: ticket.contentBinding,
      contextBinding: ticket.contextBinding,
      ticketBindingHash: canonicalTicketBindingHash(ticket),
      status: 'prepared',
      createdAt: timestamp,
      updatedAt: timestamp,
    })
  }

  transitionReceipt(
    sessionId: string,
    requestId: string,
    status: ContextTicketReceiptStatus,
    rejection?: { code: string; retryable: boolean },
  ): ContextTicketReceipt | null {
    const key = receiptKey(sessionId, requestId)
    const receipt = this.receipts.get(key)
    if (!receipt) return null
    if (!CONTEXT_RECEIPT_TRANSITIONS[receipt.status].includes(status)) {
      throw new Error(
        `Illegal context receipt transition ${receipt.status} -> ${status}`,
      )
    }
    const next: ContextTicketReceipt = {
      ...receipt,
      status,
      updatedAt: new Date(this.now()).toISOString(),
    }
    if (rejection) next.rejection = rejection
    this.receipts.set(key, next)
    return next
  }

  stats(): { tickets: number; receipts: number; snapshotBytes: number } {
    return {
      tickets: this.tickets.size,
      receipts: this.receipts.size,
      snapshotBytes: this.snapshotBytesTotal,
    }
  }

  /** Test seam: forget everything (never called from production code). */
  clear(): void {
    this.tickets.clear()
    this.receipts.clear()
  }
}

/** Lowercase-hex SHA-256 over the four ticket binding fields. */
export function canonicalTicketBindingHash(binding: {
  ticketId: string
  requestId: string
  contentBinding: string
  contextBinding: string
}): string {
  return sha256Hex(canonicalJson(binding))
}
