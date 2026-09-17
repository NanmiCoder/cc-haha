/**
 * M7-B §8.1–§8.3 — WS request identity, idempotency and dispatch reservations.
 *
 * This is the seam between a `user_message` WS frame and
 * `ConversationService.sendMessage`. It answers exactly one question per frame:
 *
 *   dispatch it once, replay it, or refuse it — never dispatch it twice and
 *   never send a stale selection.
 *
 * Frame shape:
 * - no `requestId` and no `contextTicket`      -> `passthrough` (today's path,
 *   byte-identical frame, no receipt, no disk write, no sensitivity mark);
 * - `requestId` only                           -> identity-only message: the
 *   request is deduplicated, but no context is injected;
 * - `requestId` + `contextTicket`              -> the staged model context is
 *   reserved once and composed exactly once downstream.
 *
 * Replay rule: the same `(sessionId, requestId)` with the same contentBinding,
 * contextBinding and password switch returns the original receipt and the SDK is
 * never called again. Any divergence is `REQUEST_ID_CONFLICT` (not retryable).
 * An unknown requestId is never resent blindly: without a staged ticket it is
 * refused with a retryable "prepare it again" code, and a `delivery-unknown`
 * request is refused outright.
 */

import { canonicalJson, contextBindingOf, sha256Hex } from '../../../services/managedContext/canonicalSerializer.js'
import {
  isSecretBearingStagedContext,
  persistSessionSensitive,
} from '../../../services/managedContext/sensitivityPolicy.js'
import type {
  ConversationContextSelectionV2,
  PublicContextManifestV2,
} from '../../../services/managedContext/types.js'
import { getManagedContextApiDeps } from './api.js'
import {
  ContextTurnReceiptStore,
  type ContextTurnReceiptRecord,
  type ContextTurnRejection,
} from './receipts.js'
import { serverRuntimeRevisions } from './runtimeRevision.js'
import type { ContextTicketReceiptStatus, ContextTicketStore } from './ticketStore.js'
import { searchContentCoordinator } from '../../services/localIndex/searchContentCoordinator.js'

export const EMPTY_CONTEXT_SELECTION: ConversationContextSelectionV2 = {
  schemaVersion: 2,
  hostRefs: [],
  conceptRootRefs: [],
  dependencyRefs: [],
  databaseRefs: [],
  redisRefs: [],
  credentialRefs: [],
  sourceTags: [],
  directHostIds: [],
  directConceptIds: [],
  directDatabaseIds: [],
  directRedisIds: [],
  includePasswords: false,
}

export type ContextTicketRef = {
  ticketId: string
  sidecarInstanceId: string
}

export type ManagedContextUserMessageFrame = {
  content: string
  attachments?: unknown[]
  requestId?: string
  contextTicket?: ContextTicketRef
}

export type ManagedContextRejectionCode =
  /** contextTicket without a requestId: identity is mandatory with a selection. */
  | 'REQUEST_ID_REQUIRED'
  | 'INVALID_REQUEST_ID'
  /** Same requestId, different body/attachments/selection/password switch. */
  | 'REQUEST_ID_CONFLICT'
  /** requestId is unknown to this sidecar and carries no staged ticket. */
  | 'CONTEXT_NOT_PREPARED'
  | 'CONTEXT_TICKET_UNKNOWN'
  | 'CONTEXT_TICKET_EXPIRED'
  /** Ticket staged by another sidecar instance (restart). */
  | 'SIDECAR_INSTANCE_CHANGED'
  /** Ticket staged for another session (or another request). */
  | 'CONTEXT_SESSION_MISMATCH'
  | 'CONTEXT_RUNTIME_REVISION_CHANGED'
  | 'RUNTIME_REVISION_UNAVAILABLE'
  | 'SENSITIVITY_POLICY_WRITE_FAILED'
  /** A previous dispatch outcome is unknown; resending could duplicate the turn. */
  | 'CONTEXT_DELIVERY_UNKNOWN'

export type ManagedContextUserMessagePreparation =
  | { kind: 'passthrough' }
  | {
      kind: 'accepted'
      requestId: string
      /** Reserved model context, or null for an identity-only message. */
      contextText: string | null
      receipt: ContextTurnReceiptRecord
      ticketId: string | null
      passwordDisclosure: boolean
      manifest: PublicContextManifestV2 | null
    }
  | { kind: 'replayed'; requestId: string; receipt: ContextTurnReceiptRecord }
  | {
      kind: 'rejected'
      requestId: string
      code: ManagedContextRejectionCode
      retryable: boolean
      message: string
    }

export type ManagedContextBridgeDeps = {
  store: ContextTicketStore
  receipts: ContextTurnReceiptStore
  runtimeRevision: (sessionId: string) => number | null
  persistSensitivity: (sessionId: string) => Promise<void>
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

let defaultReceipts: ContextTurnReceiptStore | null = null

/** Shared with the receipt-reader route so a WS ack and a GET agree. */
export function getDefaultContextTurnReceiptStore(): ContextTurnReceiptStore {
  defaultReceipts ??= new ContextTurnReceiptStore()
  return defaultReceipts
}

async function persistSensitivityGuards(sessionId: string): Promise<void> {
  await persistSessionSensitive(sessionId)
  await searchContentCoordinator.sanitizeSession(sessionId)
}

export function resolveManagedContextBridgeDeps(
  overrides: Partial<ManagedContextBridgeDeps> = {},
): ManagedContextBridgeDeps {
  return {
    store: overrides.store ?? getManagedContextApiDeps().store,
    receipts: overrides.receipts ?? getDefaultContextTurnReceiptStore(),
    runtimeRevision:
      overrides.runtimeRevision ?? ((sessionId) => serverRuntimeRevisions.current(sessionId)),
    persistSensitivity: overrides.persistSensitivity ?? persistSensitivityGuards,
  }
}

/** §8.1 contentBinding: the user-visible body + attachments, nothing else. */
export function computeContentBinding(content: string, attachments: unknown[] | undefined): string {
  return sha256Hex(
    canonicalJson({ content, attachments: attachments ?? [] }),
  )
}

/** §8.1 empty-selection contextBinding, used by identity-only messages. */
export const EMPTY_CONTEXT_BINDING = contextBindingOf(EMPTY_CONTEXT_SELECTION)

function rejected(
  requestId: string,
  code: ManagedContextRejectionCode,
  retryable: boolean,
  message: string,
): ManagedContextUserMessagePreparation {
  return { kind: 'rejected', requestId, code, retryable, message }
}

/**
 * Mirror the state into the M7-A in-memory receipt so the staging API's GET
 * receipt route and the WS ack agree. Best effort by design: the durable store
 * in `receipts.ts` is authoritative, and a re-prepare after `rejected` has no
 * legal in-memory transition.
 */
function syncTicketStoreReceipt(
  store: ContextTicketStore,
  sessionId: string,
  requestId: string,
  status: ContextTicketReceiptStatus,
  rejection?: ContextTurnRejection,
): void {
  try {
    store.transitionReceipt(sessionId, requestId, status, rejection)
  } catch {
    // Intentionally ignored: the durable receipt above is the record of truth.
  }
}

function identityConflict(requestId: string): ManagedContextUserMessagePreparation {
  return rejected(
    requestId,
    'REQUEST_ID_CONFLICT',
    false,
    'This requestId was already used with a different body, attachment set or context selection',
  )
}

export async function prepareUserMessage(input: {
  sessionId: string
  frame: ManagedContextUserMessageFrame
  deps?: Partial<ManagedContextBridgeDeps>
}): Promise<ManagedContextUserMessagePreparation> {
  const { sessionId, frame } = input
  const requestId = frame.requestId
  const ticketRef = frame.contextTicket

  if (requestId === undefined && ticketRef === undefined) {
    return { kind: 'passthrough' }
  }
  if (requestId === undefined) {
    return rejected(
      '',
      'REQUEST_ID_REQUIRED',
      false,
      'A contextTicket must be sent together with its requestId',
    )
  }
  if (!UUID_V4.test(requestId)) {
    return rejected(requestId, 'INVALID_REQUEST_ID', false, 'requestId must be a UUID v4')
  }

  const deps = resolveManagedContextBridgeDeps(input.deps)
  const contentBinding = computeContentBinding(frame.content, frame.attachments)
  const staged = ticketRef ? deps.store.getTicket(ticketRef.ticketId) : null

  // ---- identity: an existing durable receipt decides replay / conflict -------
  const existing = await deps.receipts.read(sessionId, requestId)
  if (existing) {
    // The user-visible body is the request's identity and never changes.
    if (existing.contentBinding !== contentBinding) return identityConflict(requestId)
    // A `rejected` receipt is retryable by design (§8.3): the client re-prepares
    // the same requestId, which legitimately produces a NEW ticket/snapshot.
    // Every other status records the identity of an in-flight or delivered
    // dispatch and must match exactly.
    if (existing.status !== 'rejected') {
      if (ticketRef) {
        if (existing.ticketId !== ticketRef.ticketId) return identityConflict(requestId)
        if (staged) {
          if (existing.contextBinding !== staged.contextBinding) return identityConflict(requestId)
          if (
            existing.passwordDisclosure !==
            (staged.publicManifest.selection.includePasswords === true)
          ) {
            return identityConflict(requestId)
          }
        }
      } else if (existing.contextBinding !== EMPTY_CONTEXT_BINDING || existing.passwordDisclosure) {
        return identityConflict(requestId)
      }
    }

    if (existing.status === 'accepted' || existing.status === 'observed' || existing.status === 'dispatching') {
      return { kind: 'replayed', requestId, receipt: existing }
    }
    if (existing.status === 'delivery-unknown') {
      return rejected(
        requestId,
        'CONTEXT_DELIVERY_UNKNOWN',
        false,
        'The previous dispatch of this requestId never reported delivery; it is never resent automatically',
      )
    }
    // `rejected` is retryable and falls through to a fresh dispatch below.
  }

  // ---- ticket validation (peek first: a rejected frame must not consume) -----
  if (ticketRef) {
    if (staged && staged.sidecarInstanceId !== deps.store.sidecarInstanceId) {
      return rejected(
        requestId,
        'SIDECAR_INSTANCE_CHANGED',
        true,
        'The context ticket belongs to another sidecar instance; prepare again',
      )
    }
    if (ticketRef.sidecarInstanceId !== deps.store.sidecarInstanceId) {
      return rejected(
        requestId,
        'SIDECAR_INSTANCE_CHANGED',
        true,
        'The context ticket belongs to another sidecar instance; prepare again',
      )
    }
    if (!staged && !existing) {
      // Either never staged here, or the process restarted and the in-memory
      // ticket is gone. Fail closed; the client re-prepares with a new requestId.
      return rejected(
        requestId,
        'CONTEXT_TICKET_UNKNOWN',
        true,
        'Unknown context ticket; stage the selection again',
      )
    }
    if (staged && staged.expiresAt <= new Date().toISOString()) {
      return rejected(requestId, 'CONTEXT_TICKET_EXPIRED', true, 'Context ticket expired; prepare again')
    }
    if (staged && (staged.sessionId !== sessionId || staged.requestId !== requestId)) {
      return rejected(
        requestId,
        'CONTEXT_SESSION_MISMATCH',
        false,
        'The context ticket was staged for another session or request',
      )
    }
  } else if (!existing) {
    // Identity-only messages still need to be recognisable after a restart, so
    // the receipt below is written. Nothing is composed for them.
  }

  // ---- reserve exactly once, then persist `dispatching` BEFORE the SDK call --
  let ticket = staged
  if (ticketRef) {
    const revision = deps.runtimeRevision(sessionId)
    if (revision === null) {
      return rejected(
        requestId,
        'RUNTIME_REVISION_UNAVAILABLE',
        true,
        'This server has not applied a runtime revision for the session yet',
      )
    }
    if (staged && staged.contentBinding !== contentBinding) {
      return identityConflict(requestId)
    }
    if (staged && staged.runtimeRevision !== revision) {
      return rejected(
        requestId,
        'CONTEXT_RUNTIME_REVISION_CHANGED',
        true,
        `Ticket was staged for runtime revision ${staged.runtimeRevision}`,
      )
    }
    if (staged && isSecretBearingStagedContext(staged.publicManifest)) {
      try {
        await deps.persistSensitivity(sessionId)
      } catch {
        return rejected(
          requestId,
          'SENSITIVITY_POLICY_WRITE_FAILED',
          true,
          'Sensitive-session policy could not be persisted; the turn was not dispatched',
        )
      }
    }
    const consumed = deps.store.consumeTicket(ticketRef.ticketId, {
      sessionId,
      requestId,
      runtimeRevision: revision,
    })
    if (!consumed.ok) {
      switch (consumed.code) {
        case 'TICKET_NOT_FOUND':
          return rejected(requestId, 'CONTEXT_TICKET_UNKNOWN', true, consumed.message)
        case 'TICKET_EXPIRED':
          return rejected(requestId, 'CONTEXT_TICKET_EXPIRED', true, consumed.message)
        case 'TICKET_BINDING_MISMATCH':
          return rejected(requestId, 'CONTEXT_SESSION_MISMATCH', false, consumed.message)
        case 'RUNTIME_REVISION_MISMATCH':
          return rejected(requestId, 'CONTEXT_RUNTIME_REVISION_CHANGED', true, consumed.message)
      }
    }
    ticket = consumed.ticket
  }

  const passwordDisclosure = ticket?.publicManifest.selection.includePasswords === true
  const receipt = await deps.receipts.beginDispatch({
    sessionId,
    requestId,
    contentBinding,
    contextBinding: ticket ? ticket.contextBinding : EMPTY_CONTEXT_BINDING,
    passwordDisclosure,
    ticketId: ticket?.ticketId ?? null,
    runtimeRevision: ticket?.runtimeRevision ?? null,
    userBody: frame.content,
    attachmentCount: frame.attachments?.length ?? 0,
    manifest: ticket?.publicManifest ?? null,
  })
  syncTicketStoreReceipt(deps.store, sessionId, requestId, 'dispatching')

  return {
    kind: 'accepted',
    requestId,
    contextText: ticket?.modelContext ?? null,
    receipt,
    ticketId: ticket?.ticketId ?? null,
    passwordDisclosure,
    manifest: ticket?.publicManifest ?? null,
  }
}

/** The SDK accepted the turn: `dispatching -> accepted`, snapshot dropped. */
export async function acknowledgeUserMessage(input: {
  sessionId: string
  requestId: string
  ticketId?: string | null
  deps?: Partial<ManagedContextBridgeDeps>
}): Promise<ContextTurnReceiptRecord | null> {
  const deps = resolveManagedContextBridgeDeps(input.deps)
  if (input.ticketId) deps.store.consumeSecretSnapshot(input.ticketId)
  const record = await deps.receipts.transition({
    sessionId: input.sessionId,
    requestId: input.requestId,
    status: 'accepted',
  })
  syncTicketStoreReceipt(deps.store, input.sessionId, input.requestId, 'accepted')
  return record
}

/**
 * The turn was refused/aborted before it could be handed to the SDK
 * (`rejected`, retryable) or the outcome is unknown (`delivery-unknown`,
 * never retried automatically).
 */
export async function failUserMessage(input: {
  sessionId: string
  requestId: string
  code: string
  retryable: boolean
  ticketId?: string | null
  deliveryUnknown?: boolean
  deps?: Partial<ManagedContextBridgeDeps>
}): Promise<ContextTurnReceiptRecord | null> {
  const deps = resolveManagedContextBridgeDeps(input.deps)
  if (input.ticketId) deps.store.consumeSecretSnapshot(input.ticketId)
  const rejection: ContextTurnRejection = { code: input.code, retryable: input.retryable }
  const status = input.deliveryUnknown ? 'delivery-unknown' : 'rejected'
  const record = await deps.receipts.transition({
    sessionId: input.sessionId,
    requestId: input.requestId,
    status,
    rejection,
  })
  syncTicketStoreReceipt(deps.store, input.sessionId, input.requestId, status, rejection)
  return record
}
