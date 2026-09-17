/**
 * M7-B contract: session / runtime / ticket binding.
 *
 * Every refusal must be structured, and none of them may send a stale
 * selection: the assertion is always "the dispatcher's attempt log stayed
 * empty" (or received the re-prepared context, never the old one).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { contextBindingOf } from '../../../../services/managedContext/canonicalSerializer.js'
import { createTestDeps, loadContractFixture } from './stagedFixture.js'
import { createBridgeHarness, createSandboxDir, type BridgeHarness } from './bridgeHarness.js'
import { computeContentBinding, failUserMessage, prepareUserMessage } from '../wsBridge.js'
import { ContextTurnReceiptStore } from '../receipts.js'

const fixture = loadContractFixture()
const MANIFEST = fixture.publicManifest
const CONTEXT_BINDING = contextBindingOf(MANIFEST.selection)
const BODY = 'reload nginx on doc-target-1'

let sandbox = ''

beforeAll(async () => {
  sandbox = await createSandboxDir()
})

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true }).catch(() => undefined)
})

type Clock = { now: () => number; advance: (ms: number) => void }

function createClock(start = Date.now()): Clock {
  let current = start
  return {
    now: () => current,
    advance: (ms) => {
      current += ms
    },
  }
}

function stageTicket(
  harness: BridgeHarness,
  sessionId: string,
  requestId: string,
  modelContext: string,
  runtimeRevision = 1,
) {
  const staged = harness.ticketStore.stage({
    sessionId,
    requestId,
    runtimeRevision,
    contentBinding: computeContentBinding(BODY, undefined),
    contextBinding: CONTEXT_BINDING,
    publicManifest: MANIFEST,
    modelContext,
  })
  if (!staged.ok) throw new Error(`stage failed: ${staged.code}`)
  return staged.ticket
}

function frameFor(requestId: string, ticketId: string, sidecarInstanceId: string) {
  return {
    content: BODY,
    requestId,
    contextTicket: { ticketId, sidecarInstanceId },
  }
}

describe('M7-B session match — wrong session or request', () => {
  it('refuses a ticket staged for another session and keeps it staged', async () => {
    const harness = createBridgeHarness({ receiptsDir: join(sandbox, `s-${randomUUID()}`) })
    const requestId = randomUUID()
    const ticket = stageTicket(harness, `session-${randomUUID()}`, requestId, '{"hosts":[]}')

    const result = await harness.send(
      `session-${randomUUID()}`,
      frameFor(requestId, ticket.ticketId, harness.ticketStore.sidecarInstanceId),
    )

    expect(result.dispatched).toBe(false)
    expect(result.preparation.kind).toBe('rejected')
    if (result.preparation.kind === 'rejected') {
      expect(result.preparation.code).toBe('CONTEXT_SESSION_MISMATCH')
      expect(result.preparation.retryable).toBe(false)
    }
    expect(harness.ticketStore.getTicket(ticket.ticketId)).not.toBeNull()
    expect(harness.attempts).toHaveLength(0)
  })

  it('refuses a frame whose requestId is not the staged one', async () => {
    const harness = createBridgeHarness({ receiptsDir: join(sandbox, `r-${randomUUID()}`) })
    const sessionId = `session-${randomUUID()}`
    const stagedRequestId = randomUUID()
    const ticket = stageTicket(harness, sessionId, stagedRequestId, '{"hosts":[]}')

    const result = await harness.send(
      sessionId,
      frameFor(randomUUID(), ticket.ticketId, harness.ticketStore.sidecarInstanceId),
    )

    expect(result.dispatched).toBe(false)
    expect(result.preparation.kind).toBe('rejected')
    if (result.preparation.kind === 'rejected') {
      expect(result.preparation.code).toBe('CONTEXT_SESSION_MISMATCH')
    }
    expect(harness.attempts).toHaveLength(0)
  })
})

describe('M7-B session match — stale ticket', () => {
  it('refuses an expired ticket, then accepts a freshly prepared one', async () => {
    const clock = createClock()
    const receiptsDir = join(sandbox, `e-${randomUUID()}`)
    const ticketStore = createTestDeps({ now: clock.now }).store
    const harness = createBridgeHarness({ receiptsDir, ticketStore, now: clock.now })
    const sessionId = `session-${randomUUID()}`
    const requestId = randomUUID()
    const expired = stageTicket(harness, sessionId, requestId, '{"hosts":["stale"]}')

    clock.advance(121_000)

    const refused = await harness.send(
      sessionId,
      frameFor(requestId, expired.ticketId, harness.ticketStore.sidecarInstanceId),
    )
    expect(refused.dispatched).toBe(false)
    expect(refused.preparation.kind).toBe('rejected')
    if (refused.preparation.kind === 'rejected') {
      expect(refused.preparation.code).toBe('CONTEXT_TICKET_EXPIRED')
      expect(refused.preparation.retryable).toBe(true)
    }
    expect(harness.attempts).toHaveLength(0)

    // Re-prepare: a new requestId with a fresh ticket dispatches normally.
    const freshRequestId = randomUUID()
    const fresh = stageTicket(harness, sessionId, freshRequestId, '{"hosts":["fresh"]}')
    const accepted = await harness.send(
      sessionId,
      frameFor(freshRequestId, fresh.ticketId, harness.ticketStore.sidecarInstanceId),
    )
    expect(accepted.dispatched).toBe(true)
    expect(harness.attempts).toHaveLength(1)
    expect(harness.attempts[0]!.contextText).toContain('fresh')
    expect(harness.attempts[0]!.composed).not.toContain('stale')
  })

  it('refuses a ticket staged by another sidecar instance', async () => {
    const harness = createBridgeHarness({ receiptsDir: join(sandbox, `i-${randomUUID()}`) })
    const sessionId = `session-${randomUUID()}`
    const requestId = randomUUID()
    const ticket = stageTicket(harness, sessionId, requestId, '{"hosts":[]}')

    const result = await harness.send(
      sessionId,
      frameFor(requestId, ticket.ticketId, randomUUID()),
    )

    expect(result.dispatched).toBe(false)
    expect(result.preparation.kind).toBe('rejected')
    if (result.preparation.kind === 'rejected') {
      expect(result.preparation.code).toBe('SIDECAR_INSTANCE_CHANGED')
      expect(result.preparation.retryable).toBe(true)
    }
    expect(harness.attempts).toHaveLength(0)
  })
})

describe('M7-B session match — changed runtime revision', () => {
  it('refuses a ticket staged against an older revision without sending it', async () => {
    const receiptsDir = join(sandbox, `v-${randomUUID()}`)
    const ticketStore = createTestDeps().store
    const harness = createBridgeHarness({ receiptsDir, ticketStore, runtimeRevision: 1 })
    const sessionId = `session-${randomUUID()}`
    const requestId = randomUUID()
    const ticket = stageTicket(harness, sessionId, requestId, '{"hosts":["stale"]}', 1)

    // A runtime config was applied after staging: the session is now at 2.
    const bumped = createBridgeHarness({ receiptsDir, ticketStore, runtimeRevision: 2 })
    const result = await bumped.send(
      sessionId,
      frameFor(requestId, ticket.ticketId, ticketStore.sidecarInstanceId),
    )

    expect(result.dispatched).toBe(false)
    expect(result.preparation.kind).toBe('rejected')
    if (result.preparation.kind === 'rejected') {
      expect(result.preparation.code).toBe('CONTEXT_RUNTIME_REVISION_CHANGED')
      expect(result.preparation.retryable).toBe(true)
    }
    expect(bumped.attempts).toHaveLength(0)
    expect(ticketStore.getTicket(ticket.ticketId)).not.toBeNull()
  })

  it('refuses when the server has no applied revision at all', async () => {
    const receiptsDir = join(sandbox, `n-${randomUUID()}`)
    const ticketStore = createTestDeps().store
    const harness = createBridgeHarness({ receiptsDir, ticketStore, runtimeRevision: null })
    const sessionId = `session-${randomUUID()}`
    const requestId = randomUUID()
    const ticket = stageTicket(harness, sessionId, requestId, '{"hosts":[]}')

    const result = await harness.send(
      sessionId,
      frameFor(requestId, ticket.ticketId, ticketStore.sidecarInstanceId),
    )
    expect(result.dispatched).toBe(false)
    expect(result.preparation.kind).toBe('rejected')
    if (result.preparation.kind === 'rejected') {
      expect(result.preparation.code).toBe('RUNTIME_REVISION_UNAVAILABLE')
      expect(result.preparation.retryable).toBe(true)
    }
    expect(harness.attempts).toHaveLength(0)
  })
})

describe('M7-B session match — cancel race', () => {
  it('rejects a dispatch revoked before delivery and re-prepares cleanly', async () => {
    const receiptsDir = join(sandbox, `c-${randomUUID()}`)
    const harness = createBridgeHarness({ receiptsDir })
    const receipts = new ContextTurnReceiptStore({ dir: receiptsDir })
    const sessionId = `session-${randomUUID()}`
    const requestId = randomUUID()
    const staleTicket = stageTicket(harness, sessionId, requestId, '{"hosts":["stale"]}')

    const prepared = await prepareUserMessage({
      sessionId,
      frame: frameFor(requestId, staleTicket.ticketId, harness.ticketStore.sidecarInstanceId),
      deps: harness.deps,
    })
    expect(prepared.kind).toBe('accepted')

    // The turn was revoked before the socket write: retryable, nothing sent.
    const failed = await failUserMessage({
      sessionId,
      requestId,
      code: 'TURN_CANCELLED_BEFORE_DELIVERY',
      retryable: true,
      ticketId: prepared.kind === 'accepted' ? prepared.ticketId : null,
      deps: harness.deps,
    })
    expect(failed?.status).toBe('rejected')
    expect(failed?.rejection).toEqual({
      code: 'TURN_CANCELLED_BEFORE_DELIVERY',
      retryable: true,
    })
    expect(harness.attempts).toHaveLength(0)
    expect(harness.ticketStore.getTicket(staleTicket.ticketId)).toBeNull()

    // The client re-prepares the same requestId with a fresh ticket.
    const freshTicket = stageTicket(harness, sessionId, requestId, '{"hosts":["fresh"]}')
    const retried = await harness.send(
      sessionId,
      frameFor(requestId, freshTicket.ticketId, harness.ticketStore.sidecarInstanceId),
    )
    expect(retried.dispatched).toBe(true)
    expect(harness.attempts).toHaveLength(1)
    expect(harness.attempts[0]!.contextText).toContain('fresh')
    expect(harness.attempts[0]!.composed).not.toContain('stale')

    const record = await receipts.read(sessionId, requestId)
    expect(record?.status).toBe('accepted')
  })
})
