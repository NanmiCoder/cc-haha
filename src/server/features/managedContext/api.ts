/**
 * Loopback-only staging API for managed context (M7.2).
 *
 * Routes (registered by `src/server/router.ts`):
 *   POST   /api/context-tickets
 *   DELETE /api/context-tickets/:ticketId
 *   GET    /api/context-tickets/receipts/:requestId?sessionId=…[&runtimeRevision=…]
 *
 * Guards, all evaluated before anything is read or staged:
 * - the socket peer reported by `Bun.serve` must be loopback. Proxy headers
 *   (`X-Forwarded-For`, `Forwarded`, …) are never consulted;
 * - a configured local access bearer token is required (`isLocalAccessAuthorized`,
 *   the same scheme the rest of the server uses; pet/H5 tokens are not enough);
 * - body ≤ 512 KiB, modelContext ≤ 64 KiB, 120 s TTL, ≤ 4 tickets per session,
 *   ≤ 64 globally, ≤ 8 MiB staged snapshots — all in memory, never on disk.
 *
 * `modelContext` is accepted, stored in memory and never returned by any route.
 */

import { isLoopbackHost } from '../../h5AccessPolicy.js'
import { isLocalAccessAuthorized } from '../../localAccessAuth.js'
import { contextBindingOf } from '../../../services/managedContext/canonicalSerializer.js'
import { ManagedContextError } from '../../../services/managedContext/errors.js'
import { assertPublicManifestSafe } from '../../../services/managedContext/manifest.js'
import type { StageContextRequest } from '../../../services/managedContext/types.js'
import {
  createUnreachableVaultGateway,
  type SecretRevealGateway,
} from '../../../services/managedContext/vaultGateway.js'
import { createServerSessionGate, type ManagedContextSessionGate } from './sessionGate.js'
import {
  CONTEXT_MODEL_CONTEXT_BYTES_LIMIT,
  CONTEXT_STAGE_BODY_BYTES_LIMIT,
  ContextTicketStore,
} from './ticketStore.js'

export type ManagedContextApiDeps = {
  store: ContextTicketStore
  sessions: ManagedContextSessionGate
  /** Only consulted when `allowSecretDisclosure` is true (M8). */
  vault: SecretRevealGateway
  /**
   * M7 composition root keeps this false: the disclosure path is not shipped,
   * so `includePasswords: true` is refused before the vault is ever consulted.
   */
  allowSecretDisclosure: boolean
}

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const BINDING_HEX = /^[0-9a-f]{64}$/

let defaultDeps: ManagedContextApiDeps | null = null

export function getManagedContextApiDeps(): ManagedContextApiDeps {
  defaultDeps ??= {
    store: new ContextTicketStore(),
    sessions: createServerSessionGate(),
    vault: createUnreachableVaultGateway(),
    allowSecretDisclosure: true,
  }
  return defaultDeps
}

function errorJson(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): Response {
  return Response.json(
    { error: code, code, message, ...(details ? { details } : {}) },
    { status, headers: NO_STORE_HEADERS },
  )
}

/**
 * M8 seam. M7 always takes the `SECRET_DISCLOSURE_NOT_READY` branch and never
 * calls `availability()`/`reveal()`; the vault is only reachable once
 * `allowSecretDisclosure` is turned on.
 */
function assertSecretDisclosureAvailable(deps: ManagedContextApiDeps): void {
  if (!deps.allowSecretDisclosure) {
    throw new ManagedContextError(
      'SECRET_DISCLOSURE_NOT_READY',
      'Secret disclosure is disabled for this staging endpoint',
    )
  }
  // M8 resolves/decrypts selected credentials in Electron main before this
  // loopback request. The sidecar deliberately has no vault access and must not
  // attempt a second reveal. It only validates public metadata consistency.
}

function methodNotAllowed(allowed: string[]): Response {
  return Response.json(
    { error: 'METHOD_NOT_ALLOWED', code: 'METHOD_NOT_ALLOWED', message: `Allowed: ${allowed.join(', ')}` },
    { status: 405, headers: { ...NO_STORE_HEADERS, Allow: allowed.join(', ') } },
  )
}

function authorizeContextTicketRequest(
  req: Request,
  clientAddress: string | null,
): Response | null {
  // The peer is the actual socket peer. X-Forwarded-For and friends are
  // deliberately ignored: a proxy header must never widen this route.
  if (!clientAddress || !isLoopbackHost(clientAddress)) {
    return errorJson(
      403,
      'FORBIDDEN_PEER',
      'Context staging is restricted to loopback peers',
    )
  }
  if (!isLocalAccessAuthorized(req)) {
    return errorJson(
      401,
      'UNAUTHORIZED',
      'A configured local access bearer token is required',
    )
  }
  return null
}

type StageValidationFailure = { ok: false; code: string; message: string; details?: Record<string, unknown> }
type StageValidationResult = { ok: true; value: StageContextRequest } | StageValidationFailure

function isEntityRefArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { id?: unknown }).id === 'string' &&
        typeof (entry as { revision?: unknown }).revision === 'number',
    )
  )
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function validateStageContextRequest(value: unknown): StageValidationResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, code: 'INVALID_STAGE_REQUEST', message: 'Body must be a JSON object' }
  }
  const body = value as Record<string, unknown>
  if (body.schemaVersion !== 1) {
    return { ok: false, code: 'INVALID_STAGE_REQUEST', message: 'schemaVersion must be 1' }
  }
  if (
    typeof body.sessionId !== 'string'
    || body.sessionId.length < 1
    || body.sessionId.length > 256
    || /[\u0000\r\n]/u.test(body.sessionId)
  ) {
    return { ok: false, code: 'INVALID_STAGE_REQUEST', message: 'sessionId is invalid' }
  }
  if (typeof body.requestId !== 'string' || !UUID_V4.test(body.requestId)) {
    return { ok: false, code: 'INVALID_STAGE_REQUEST', message: 'requestId must be a UUID v4' }
  }
  if (
    typeof body.runtimeRevision !== 'number' ||
    !Number.isInteger(body.runtimeRevision) ||
    body.runtimeRevision < 1
  ) {
    return { ok: false, code: 'INVALID_STAGE_REQUEST', message: 'runtimeRevision must be a positive integer' }
  }
  if (typeof body.contentBinding !== 'string' || !BINDING_HEX.test(body.contentBinding)) {
    return { ok: false, code: 'INVALID_STAGE_REQUEST', message: 'contentBinding must be lowercase hex SHA-256' }
  }
  if (typeof body.contextBinding !== 'string' || !BINDING_HEX.test(body.contextBinding)) {
    return { ok: false, code: 'INVALID_STAGE_REQUEST', message: 'contextBinding must be lowercase hex SHA-256' }
  }
  if (typeof body.modelContext !== 'string') {
    return { ok: false, code: 'INVALID_STAGE_REQUEST', message: 'modelContext must be a string' }
  }

  const manifest = body.publicManifest
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return { ok: false, code: 'INVALID_STAGE_REQUEST', message: 'publicManifest must be an object' }
  }
  const candidate = manifest as Record<string, unknown>
  if (candidate.schemaVersion !== 2) {
    return { ok: false, code: 'INVALID_STAGE_REQUEST', message: 'publicManifest.schemaVersion must be 2' }
  }
  if (typeof candidate.requestId !== 'string' || !UUID_V4.test(candidate.requestId)) {
    return { ok: false, code: 'INVALID_STAGE_REQUEST', message: 'publicManifest.requestId must be a UUID v4' }
  }
  if (typeof candidate.resolvedAt !== 'string') {
    return { ok: false, code: 'INVALID_STAGE_REQUEST', message: 'publicManifest.resolvedAt must be a string' }
  }
  if (typeof candidate.containsSecrets !== 'boolean' || typeof candidate.secretFieldCount !== 'number') {
    return { ok: false, code: 'INVALID_STAGE_REQUEST', message: 'publicManifest secret fields are malformed' }
  }
  if (!Array.isArray(candidate.hosts) || !Array.isArray(candidate.concepts)) {
    return { ok: false, code: 'INVALID_STAGE_REQUEST', message: 'publicManifest hosts/concepts are malformed' }
  }
  if (!Array.isArray(candidate.databases) || !Array.isArray(candidate.redisConnections)) {
    return { ok: false, code: 'INVALID_STAGE_REQUEST', message: 'publicManifest data connections are malformed' }
  }

  const selection = candidate.selection
  if (typeof selection !== 'object' || selection === null || Array.isArray(selection)) {
    return { ok: false, code: 'INVALID_STAGE_REQUEST', message: 'publicManifest.selection must be an object' }
  }
  const picked = selection as Record<string, unknown>
  if (picked.schemaVersion !== 2) {
    return { ok: false, code: 'INVALID_STAGE_REQUEST', message: 'selection.schemaVersion must be 2' }
  }
  if (typeof picked.includePasswords !== 'boolean') {
    return { ok: false, code: 'INVALID_STAGE_REQUEST', message: 'selection.includePasswords must be a boolean' }
  }
  for (const key of ['hostRefs', 'conceptRootRefs', 'dependencyRefs', 'databaseRefs', 'redisRefs', 'credentialRefs'] as const) {
    if (!isEntityRefArray(picked[key])) {
      return { ok: false, code: 'INVALID_STAGE_REQUEST', message: `selection.${key} must be an entity-ref array` }
    }
  }
  for (const key of ['directHostIds', 'directConceptIds', 'directDatabaseIds', 'directRedisIds'] as const) {
    if (!isStringArray(picked[key])) {
      return { ok: false, code: 'INVALID_STAGE_REQUEST', message: `selection.${key} must be a string array` }
    }
  }
  if (!Array.isArray(picked.sourceTags)) {
    return { ok: false, code: 'INVALID_STAGE_REQUEST', message: 'selection.sourceTags must be an array' }
  }

  return { ok: true, value: body as unknown as StageContextRequest }
}

function gateFailureResponse(code: string, message: string): Response {
  const status = code === 'SESSION_NOT_FOUND' ? 404 : 409
  return errorJson(status, code, message)
}

async function stageContextTicket(
  req: Request,
  deps: ManagedContextApiDeps,
): Promise<Response> {
  const declaredLength = Number(req.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declaredLength) && declaredLength > CONTEXT_STAGE_BODY_BYTES_LIMIT) {
    return errorJson(413, 'BODY_TOO_LARGE', 'Staging body exceeds the 512 KiB limit')
  }

  let raw: string
  try {
    raw = await req.text()
  } catch {
    return errorJson(400, 'INVALID_STAGE_REQUEST', 'Unable to read the request body')
  }
  const bodyBytes = Buffer.byteLength(raw, 'utf8')
  if (bodyBytes > CONTEXT_STAGE_BODY_BYTES_LIMIT) {
    return errorJson(413, 'BODY_TOO_LARGE', 'Staging body exceeds the 512 KiB limit', {
      bytes: bodyBytes,
      limit: CONTEXT_STAGE_BODY_BYTES_LIMIT,
    })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return errorJson(400, 'INVALID_STAGE_REQUEST', 'Body must be valid JSON')
  }

  const validation = validateStageContextRequest(parsed)
  // `'code' in validation` rather than `!validation.ok`: the root tsconfig does
  // not enable strictNullChecks, so boolean discriminants do not narrow unions.
  if ('code' in validation) {
    return errorJson(400, validation.code, validation.message, validation.details)
  }
  const request = validation.value

  if (request.publicManifest.requestId !== request.requestId) {
    return errorJson(
      400,
      'INVALID_STAGE_REQUEST',
      'publicManifest.requestId must equal requestId',
    )
  }

  const modelContextBytes = Buffer.byteLength(request.modelContext, 'utf8')
  if (modelContextBytes > CONTEXT_MODEL_CONTEXT_BYTES_LIMIT) {
    return errorJson(413, 'MODEL_CONTEXT_TOO_LARGE', 'modelContext exceeds the 64 KiB limit', {
      bytes: modelContextBytes,
      limit: CONTEXT_MODEL_CONTEXT_BYTES_LIMIT,
    })
  }

  const selection = request.publicManifest.selection
  const hasSecretFields = request.publicManifest.secretFieldCount > 0
  if (request.publicManifest.containsSecrets !== hasSecretFields) {
    return errorJson(400, 'INVALID_STAGE_REQUEST', 'containsSecrets must match secretFieldCount')
  }
  if (hasSecretFields && !selection.includePasswords) {
    return errorJson(400, 'INVALID_STAGE_REQUEST', 'Secret fields require includePasswords=true')
  }
  if (!selection.includePasswords && selection.credentialRefs.length > 0) {
    return errorJson(400, 'INVALID_STAGE_REQUEST', 'credentialRefs require includePasswords=true')
  }
  if (hasSecretFields && selection.credentialRefs.length === 0) {
    return errorJson(400, 'INVALID_STAGE_REQUEST', 'Secret fields require credentialRefs')
  }
  if (selection.includePasswords || request.publicManifest.containsSecrets || request.publicManifest.secretFieldCount > 0) {
    try {
      assertSecretDisclosureAvailable(deps)
    } catch (error) {
      if (error instanceof ManagedContextError) {
        return errorJson(400, error.code, error.message)
      }
      throw error
    }
  }

  try {
    assertPublicManifestSafe(request.publicManifest)
  } catch (error) {
    if (error instanceof ManagedContextError) {
      return errorJson(400, error.code, error.message, error.details)
    }
    throw error
  }

  // The route re-derives the context binding from the submitted selection and
  // refuses to trust a renderer-reported digest (§8.3).
  const expectedContextBinding = contextBindingOf(selection)
  if (expectedContextBinding !== request.contextBinding) {
    return errorJson(
      400,
      'CONTEXT_BINDING_MISMATCH',
      'contextBinding does not match the submitted selection',
      { expected: expectedContextBinding },
    )
  }

  const gate = await deps.sessions.resolve({
    sessionId: request.sessionId,
    runtimeRevision: request.runtimeRevision,
  })
  if ('code' in gate) {
    return gateFailureResponse(gate.code, `Staging rejected: ${gate.code}`)
  }

  const staged = deps.store.stage({
    sessionId: request.sessionId,
    requestId: request.requestId,
    runtimeRevision: request.runtimeRevision,
    contentBinding: request.contentBinding,
    contextBinding: request.contextBinding,
    publicManifest: request.publicManifest,
    modelContext: request.modelContext,
  })
  if ('code' in staged) {
    return errorJson(429, staged.code, staged.message)
  }

  return Response.json(
    {
      ticketId: staged.ticket.ticketId,
      sidecarInstanceId: staged.ticket.sidecarInstanceId,
      expiresAt: staged.ticket.expiresAt,
      publicManifest: staged.ticket.publicManifest,
    },
    { status: 201, headers: NO_STORE_HEADERS },
  )
}

function revokeContextTicket(url: URL, ticketId: string, deps: ManagedContextApiDeps): Response {
  const ticket = deps.store.getTicket(ticketId)
  if (!ticket) {
    return errorJson(404, 'TICKET_NOT_FOUND', 'Unknown context ticket')
  }
  const sessionId = url.searchParams.get('sessionId')
  if (sessionId !== null && sessionId !== ticket.sessionId) {
    return errorJson(404, 'TICKET_NOT_FOUND', 'Unknown context ticket')
  }
  deps.store.revokeTicket(ticketId)
  return new Response(null, { status: 204, headers: NO_STORE_HEADERS })
}

function readContextTicketReceipt(
  url: URL,
  requestId: string | undefined,
  deps: ManagedContextApiDeps,
): Response {
  if (!requestId) {
    return errorJson(400, 'INVALID_STAGE_REQUEST', 'A requestId path segment is required')
  }
  const sessionId = url.searchParams.get('sessionId')
  if (!sessionId) {
    return errorJson(400, 'SESSION_ID_REQUIRED', 'sessionId query parameter is required')
  }
  const receipt = deps.store.getReceipt(requestId, sessionId)
  if (!receipt) {
    return errorJson(404, 'RECEIPT_NOT_FOUND', 'No receipt for this requestId and sessionId')
  }
  const runtimeRevision = url.searchParams.get('runtimeRevision')
  if (runtimeRevision !== null && Number(runtimeRevision) !== receipt.runtimeRevision) {
    return errorJson(409, 'RUNTIME_REVISION_MISMATCH', 'Receipt belongs to another runtime revision')
  }
  // Public projection only: modelContext is not part of a receipt at all.
  return Response.json(
    {
      requestId: receipt.requestId,
      sessionId: receipt.sessionId,
      runtimeRevision: receipt.runtimeRevision,
      ticketId: receipt.ticketId,
      contentBinding: receipt.contentBinding,
      contextBinding: receipt.contextBinding,
      ticketBindingHash: receipt.ticketBindingHash,
      status: receipt.status,
      createdAt: receipt.createdAt,
      updatedAt: receipt.updatedAt,
      ...(receipt.rejection ? { rejection: receipt.rejection } : {}),
    },
    { status: 200, headers: NO_STORE_HEADERS },
  )
}

export async function handleManagedContextApi(
  req: Request,
  url: URL,
  segments: string[],
  options: { clientAddress: string | null },
  deps: ManagedContextApiDeps = getManagedContextApiDeps(),
): Promise<Response> {
  const authFailure = authorizeContextTicketRequest(req, options.clientAddress)
  if (authFailure) return authFailure

  const sub = segments[2]
  if (!sub) {
    if (req.method !== 'POST') return methodNotAllowed(['POST'])
    return stageContextTicket(req, deps)
  }
  if (sub === 'receipts') {
    if (req.method !== 'GET') return methodNotAllowed(['GET'])
    return readContextTicketReceipt(url, segments[3], deps)
  }
  if (req.method !== 'DELETE') return methodNotAllowed(['DELETE'])
  return revokeContextTicket(url, sub, deps)
}
