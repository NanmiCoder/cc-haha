/**
 * M7-B contract: request identity and idempotency.
 *
 * The invariant is about what the SDK receives, so every case asserts on the
 * dispatcher's attempt log, not on the returned tuple alone.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { contextBindingOf } from '../../../../services/managedContext/canonicalSerializer.js'
import { createBridgeHarness, createSandboxDir, type BridgeHarness } from './bridgeHarness.js'
import { computeContentBinding, prepareUserMessage } from '../wsBridge.js'
import { loadContractFixture } from './stagedFixture.js'

const fixture = loadContractFixture()
const MANIFEST = fixture.publicManifest
const CONTEXT_BINDING = contextBindingOf(MANIFEST.selection)
const BODY = 'summarise the last deploy on doc-target-1'

let sandbox = ''
let receiptsDir = ''

beforeAll(async () => {
  sandbox = await createSandboxDir()
  receiptsDir = join(sandbox, 'context-turns')
})

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true }).catch(() => undefined)
})

function newHarness(): BridgeHarness {
  return createBridgeHarness({ receiptsDir: join(receiptsDir, randomUUID()) })
}

function stageTicket(harness: BridgeHarness, sessionId: string, requestId: string, modelContext: string) {
  const staged = harness.ticketStore.stage({
    sessionId,
    requestId,
    runtimeRevision: 1,
    contentBinding: computeContentBinding(BODY, undefined),
    contextBinding: CONTEXT_BINDING,
    publicManifest: MANIFEST,
    modelContext,
  })
  if (!staged.ok) throw new Error(`stage failed: ${staged.code}`)
  return staged.ticket
}

describe('M7-B identity — no selection is a passthrough', () => {
  it('does not create a receipt and does not touch the identity path', async () => {
    const harness = newHarness()
    const sessionId = `session-${randomUUID()}`
    const preparation = await harness.send(sessionId, { content: BODY, attachments: [] })
    expect(preparation.preparation.kind).toBe('passthrough')
    expect(preparation.dispatched).toBe(false)
    expect(await harness.receipts.list(sessionId)).toEqual([])
  })
})

describe('M7-B identity — replay and conflict', () => {
  it('replays the same requestId with the same binding without calling the SDK again', async () => {
    const harness = newHarness()
    const sessionId = `session-${randomUUID()}`
    const requestId = randomUUID()
    const frame = { content: BODY, attachments: [], requestId }

    const first = await harness.send(sessionId, frame)
    const second = await harness.send(sessionId, frame)

    expect(first.dispatched).toBe(true)
    expect(first.preparation.kind).toBe('accepted')
    expect(second.dispatched).toBe(false)
    expect(second.preparation.kind).toBe('replayed')
    expect(harness.attempts).toHaveLength(1)
    if (second.preparation.kind === 'replayed') {
      expect(second.preparation.receipt.status).toBe('accepted')
      expect(second.preparation.receipt.requestId).toBe(requestId)
      expect(second.preparation.receipt.userBody).toBe(BODY)
    }
  })

  it('rejects the same requestId with a different body', async () => {
    const harness = newHarness()
    const sessionId = `session-${randomUUID()}`
    const requestId = randomUUID()

    const first = await harness.send(sessionId, { content: BODY, requestId })
    const second = await harness.send(sessionId, { content: `${BODY} (edited)`, requestId })

    expect(first.dispatched).toBe(true)
    expect(second.dispatched).toBe(false)
    expect(second.preparation.kind).toBe('rejected')
    if (second.preparation.kind === 'rejected') {
      expect(second.preparation.code).toBe('REQUEST_ID_CONFLICT')
      expect(second.preparation.retryable).toBe(false)
    }
    expect(harness.attempts).toHaveLength(1)
  })

  it('rejects the same requestId with a different attachment set', async () => {
    const harness = newHarness()
    const sessionId = `session-${randomUUID()}`
    const requestId = randomUUID()

    await harness.send(sessionId, { content: BODY, attachments: [], requestId })
    const second = await harness.send(sessionId, {
      content: BODY,
      attachments: [{ type: 'file', path: 'C:/tmp/other.txt' }],
      requestId,
    })

    expect(second.dispatched).toBe(false)
    expect(second.preparation.kind).toBe('rejected')
    if (second.preparation.kind === 'rejected') {
      expect(second.preparation.code).toBe('REQUEST_ID_CONFLICT')
    }
    expect(harness.attempts).toHaveLength(1)
  })

  it('treats identical text under a different requestId as two real messages', async () => {
    const harness = newHarness()
    const sessionId = `session-${randomUUID()}`

    const first = await harness.send(sessionId, { content: BODY, requestId: randomUUID() })
    const second = await harness.send(sessionId, { content: BODY, requestId: randomUUID() })

    expect(first.dispatched).toBe(true)
    expect(second.dispatched).toBe(true)
    expect(harness.attempts).toHaveLength(2)
    expect(harness.attempts.every((attempt) => attempt.composed === BODY)).toBe(true)
  })

  it('rejects a contextTicket that arrives without identity', async () => {
    const harness = newHarness()
    const sessionId = `session-${randomUUID()}`
    const ticket = stageTicket(harness, sessionId, randomUUID(), '{"hosts":[]}')
    const result = await harness.send(sessionId, {
      content: BODY,
      contextTicket: {
        ticketId: ticket.ticketId,
        sidecarInstanceId: harness.ticketStore.sidecarInstanceId,
      },
    })
    expect(result.preparation.kind).toBe('rejected')
    if (result.preparation.kind === 'rejected') {
      expect(result.preparation.code).toBe('REQUEST_ID_REQUIRED')
    }
    expect(harness.attempts).toHaveLength(0)
  })
})

describe('M7-B identity — restart is never a blind retry', () => {
  it('does not re-dispatch a request whose outcome was unknown across a restart', async () => {
    const harness = newHarness()
    const sessionId = `session-${randomUUID()}`
    const requestId = randomUUID()
    const ticket = stageTicket(harness, sessionId, requestId, '{"hosts":["doc-target-1"]}')
    const frame = {
      content: BODY,
      requestId,
      contextTicket: {
        ticketId: ticket.ticketId,
        sidecarInstanceId: harness.ticketStore.sidecarInstanceId,
      },
    }

    const first = prepareUserMessage({ sessionId, frame, deps: harness.deps })
    expect((await first).kind).toBe('accepted')
    // Crash before the SDK write: the durable receipt stays `dispatching` and
    // nothing reached the SDK.
    expect(harness.attempts).toHaveLength(0)

    // The process restarts between the socket write and the SDK's first event.
    const restarted = harness.restart()
    const replay = await restarted.send(sessionId, frame)
    expect(replay.dispatched).toBe(false)
    expect(replay.preparation.kind).toBe('replayed')
    if (replay.preparation.kind === 'replayed') {
      expect(replay.preparation.receipt.status).toBe('dispatching')
    }
    expect(restarted.attempts).toHaveLength(0)
  })

  it('refuses a staged ticket the restarted process never saw', async () => {
    const harness = newHarness()
    const sessionId = `session-${randomUUID()}`
    const requestId = randomUUID()
    const ticket = stageTicket(harness, sessionId, requestId, '{"hosts":["doc-target-1"]}')

    // Same durable receipts, empty in-memory ticket store.
    const restarted = harness.restart()
    const result = await restarted.send(sessionId, {
      content: BODY,
      requestId,
      contextTicket: {
        ticketId: ticket.ticketId,
        sidecarInstanceId: harness.ticketStore.sidecarInstanceId,
      },
    })

    expect(result.dispatched).toBe(false)
    expect(result.preparation.kind).toBe('rejected')
    if (result.preparation.kind === 'rejected') {
      expect(result.preparation.code).toBe('CONTEXT_TICKET_UNKNOWN')
      expect(result.preparation.retryable).toBe(true)
    }
    expect(restarted.attempts).toHaveLength(0)
  })

  it('survives a restart through the durable receipt file', async () => {
    const restartDir = join(sandbox, `restart-${randomUUID()}`)
    const first = createBridgeHarness({ receiptsDir: restartDir })
    const sessionId = `session-${randomUUID()}`
    const requestId = randomUUID()
    const frame = { content: BODY, requestId }
    await first.send(sessionId, frame)

    const restarted = createBridgeHarness({ receiptsDir: restartDir })
    const replay = await restarted.send(sessionId, frame)
    expect(replay.dispatched).toBe(false)
    expect(replay.preparation.kind).toBe('replayed')
    expect(restarted.attempts).toHaveLength(0)
  })
})

describe('M7-B identity — receipts never hold the expanded prompt', () => {
  it('stores the original body and the public manifest only', async () => {
    const harness = newHarness()
    const sessionId = `session-${randomUUID()}`
    const requestId = randomUUID()
    const modelContext = '{"hosts":[{"id":"10000000-0000-4000-8000-000000000001"}]}'
    const ticket = stageTicket(harness, sessionId, requestId, modelContext)

    await harness.send(sessionId, {
      content: BODY,
      requestId,
      contextTicket: {
        ticketId: ticket.ticketId,
        sidecarInstanceId: harness.ticketStore.sidecarInstanceId,
      },
    })

    const record = await harness.receipts.read(sessionId, requestId)
    expect(record).not.toBeNull()
    expect(record!.userBody).toBe(BODY)
    expect(record!.ticketId).toBe(ticket.ticketId)
    expect(record!.manifest?.containsSecrets).toBe(false)
    expect(JSON.stringify(record)).not.toContain(modelContext)
    expect(record!.status).toBe('accepted')
  })
})
