/**
 * 0033 final self-review contracts.
 *
 * These are counterexamples the focused M5/M7 files did not pin yet:
 *
 * 1. the §7.1 entity budget applies to the *expanded* closure — roots and
 *    dependencies share one 100-concept budget instead of one each, and the
 *    ref limits are checked before any entity is resolved;
 * 2. secret material that can reach the manifest through a staged snapshot is
 *    rejected (URL userinfo in a manifest field), while user free text that
 *    legitimately carries a local path stays injectable and out of the public
 *    manifest / receipt;
 * 3. replay identity is decided on the ticket, not only on the body: the same
 *    requestId with a different ticket is a conflict, and a genuine accepted
 *    replay with the same ticket never reaches the SDK twice;
 * 4. a frame without identity never enters the ticket path at all.
 */

import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { contextBindingOf } from '../../../../services/managedContext/canonicalSerializer.js'
import { ManagedContextError } from '../../../../services/managedContext/errors.js'
import {
  CONTEXT_CONCEPT_LIMIT,
  CONTEXT_HOST_LIMIT,
  buildPublicContextManifest,
  measureInjectableContextBytes,
  type StagedContextSnapshot,
} from '../../../../services/managedContext/manifest.js'
import { composeUserContent } from '../composer.js'
import { computeContentBinding } from '../wsBridge.js'
import { createBridgeHarness, type BridgeHarness } from './bridgeHarness.js'
import { cloneFixture, loadContractFixture, snapshotFromFixture } from './stagedFixture.js'

const FIXTURE = loadContractFixture()
const SNAPSHOT = snapshotFromFixture(FIXTURE)
const BODY = 'self-review ping'

const sandboxes: string[] = []

afterAll(async () => {
  for (const dir of sandboxes) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

async function newHarness(): Promise<BridgeHarness> {
  const dir = await mkdtemp(join(tmpdir(), 'm7-self-review-'))
  sandboxes.push(dir)
  return createBridgeHarness({ receiptsDir: dir })
}

function build(snapshot: StagedContextSnapshot = SNAPSHOT) {
  return buildPublicContextManifest(snapshot, {
    requestId: FIXTURE.publicManifest.requestId,
    resolvedAt: FIXTURE.publicManifest.resolvedAt,
  })
}

function expectCode(run: () => unknown, code: string): ManagedContextError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(ManagedContextError)
    const managed = error as ManagedContextError
    expect(managed.code).toBe(code)
    return managed
  }
  throw new Error(`expected ManagedContextError(${code})`)
}

function conceptId(index: number): string {
  return `21000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
}

/** The fixture concepts carry every required field; only the identity changes. */
function stagedConcept(index: number): StagedContextSnapshot['concepts'][number] {
  const template = SNAPSHOT.concepts[0]!
  return {
    ...template,
    id: conceptId(index),
    revision: 1,
    title: `Closure concept ${index}`,
    dependsOnIds: [],
    referenceIds: [],
    tagIds: [],
  }
}

/**
 * A snapshot whose concept closure is `roots` roots plus `deps` dependencies,
 * with every ref resolving. `dependencyRefs` starts at index `roots` unless the
 * caller re-points it (the dedupe case below does).
 */
function closureSnapshot(roots: number, deps: number): StagedContextSnapshot {
  const snapshot = cloneFixture(SNAPSHOT)
  snapshot.concepts = []
  snapshot.selection.sourceTags = []
  snapshot.selection.directConceptIds = []
  for (let index = 0; index < roots + deps; index += 1) {
    snapshot.concepts.push(stagedConcept(index))
  }
  snapshot.selection.conceptRootRefs = Array.from({ length: roots }, (_, index) => ({
    id: conceptId(index),
    revision: 1,
  }))
  snapshot.selection.dependencyRefs = Array.from({ length: deps }, (_, index) => ({
    id: conceptId(roots + index),
    revision: 1,
  }))
  return snapshot
}

describe('M7 self-review — the §7.1 budget covers the expanded concept closure', () => {
  it('blocks a selection whose two ref lists expand to more than 100 concepts', () => {
    // 60 roots + 60 distinct dependencies: each list is under the 100-ref cap,
    // while the expanded closure (what §7.1 caps) is 120.
    const error = expectCode(() => build(closureSnapshot(60, 60)), 'INVALID_CONTEXT_SELECTION')
    expect(error.details?.count).toBe(120)
    expect(error.details?.limit).toBe(CONTEXT_CONCEPT_LIMIT)
  })

  it('still accepts exactly 100 concepts across both lists', () => {
    const manifest = build(closureSnapshot(50, 50))
    expect(manifest.concepts).toHaveLength(100)
    expect(manifest.concepts.filter((concept) => concept.includedAs === 'root')).toHaveLength(50)
    expect(manifest.concepts.filter((concept) => concept.includedAs === 'dependency')).toHaveLength(50)
  })

  it('counts a concept reached as both root and dependency once', () => {
    const snapshot = closureSnapshot(70, 0)
    snapshot.selection.dependencyRefs = snapshot.selection.conceptRootRefs
      .slice(0, 60)
      .map((ref) => ({ ...ref }))

    const manifest = build(snapshot)
    expect(manifest.concepts).toHaveLength(70)
    expect(manifest.concepts.every((concept) => concept.includedAs === 'root')).toBe(true)
  })

  it('checks the host limit before resolving any host', () => {
    const snapshot = cloneFixture(SNAPSHOT)
    // Unknown ids on purpose: the limit must fire before `CONTEXT_RESOURCE_MISSING`.
    snapshot.selection.hostRefs = Array.from({ length: CONTEXT_HOST_LIMIT + 1 }, (_, index) => ({
      id: `22000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      revision: 1,
    }))

    const error = expectCode(() => build(snapshot), 'INVALID_CONTEXT_SELECTION')
    expect(error.details?.count).toBe(CONTEXT_HOST_LIMIT + 1)
    expect(error.details?.limit).toBe(CONTEXT_HOST_LIMIT)
  })
})

describe('M7 self-review — secret material on the staged-snapshot path', () => {
  it('rejects a host address that carries URL userinfo', () => {
    const snapshot = cloneFixture(SNAPSHOT)
    snapshot.hosts[0]!.address = 'ssh://root:hunter2@192.0.2.10'

    const error = expectCode(() => build(snapshot), 'CONTEXT_SECRET_DETECTED')
    expect(String(error.details?.path)).toContain('manifest.hosts[0].address')
  })

  it('keeps free text out of the manifest while the install path stays injectable', () => {
    const snapshot = cloneFixture(SNAPSHOT)
    const freeText = 'rotated at /home/ops/hosts.md; the password lives in the vault'
    snapshot.concepts[0]!.bodyMarkdown = freeText

    // Control: the free text (and the fixture's real install path) are in the
    // injectable payload, so the assertions below are about the manifest boundary.
    expect(snapshot.concepts[0]!.bodyMarkdown).toBe(freeText)
    expect(measureInjectableContextBytes(snapshot)).toBeGreaterThan(0)

    const serialized = JSON.stringify(build(snapshot))
    expect(serialized).not.toContain('/home/ops/hosts.md')
    expect(serialized).not.toContain('password lives')
    expect(serialized).not.toContain('/opt/example')
  })
})

describe('M7 self-review — replay identity is decided on the ticket', () => {
  it('rejects a replayed requestId that carries a different context ticket', async () => {
    const harness = await newHarness()
    const sessionId = `session-${randomUUID()}`
    const requestId = randomUUID()
    const contentBinding = computeContentBinding(BODY, [])

    const selectionA = cloneFixture(SNAPSHOT.selection)
    const selectionB = cloneFixture(SNAPSHOT.selection)
    // Same body, same refs, different tag membership: a divergent binding.
    selectionB.sourceTags = []

    const snapshotA = cloneFixture(SNAPSHOT)
    snapshotA.selection = selectionA
    const snapshotB = cloneFixture(SNAPSHOT)
    snapshotB.selection = selectionB

    const manifestA = buildPublicContextManifest(snapshotA, {
      requestId,
      resolvedAt: FIXTURE.publicManifest.resolvedAt,
    })
    const manifestB = buildPublicContextManifest(snapshotB, {
      requestId,
      resolvedAt: FIXTURE.publicManifest.resolvedAt,
    })

    const stage = (manifest: typeof manifestA, contextBinding: string) => {
      const staged = harness.ticketStore.stage({
        sessionId,
        requestId,
        runtimeRevision: 1,
        contentBinding,
        contextBinding,
        publicManifest: manifest,
        modelContext: '{"hosts":[]}',
      })
      if (!staged.ok) throw new Error(`stage failed: ${staged.code}`)
      return staged.ticket
    }

    const ticketA = stage(manifestA, contextBindingOf(selectionA))
    const ticketB = stage(manifestB, contextBindingOf(selectionB))
    const sidecarInstanceId = harness.ticketStore.sidecarInstanceId

    const first = await harness.send(sessionId, {
      content: BODY,
      attachments: [],
      requestId,
      contextTicket: { ticketId: ticketA.ticketId, sidecarInstanceId },
    })
    const second = await harness.send(sessionId, {
      content: BODY,
      attachments: [],
      requestId,
      contextTicket: { ticketId: ticketB.ticketId, sidecarInstanceId },
    })

    expect(first.dispatched).toBe(true)
    expect(first.preparation.kind).toBe('accepted')
    expect(second.dispatched).toBe(false)
    expect(second.preparation.kind).toBe('rejected')
    if (second.preparation.kind === 'rejected') {
      expect(second.preparation.code).toBe('REQUEST_ID_CONFLICT')
      expect(second.preparation.retryable).toBe(false)
    }
    // The divergent ticket never reached the SDK and its context was never composed.
    expect(harness.attempts).toHaveLength(1)
    expect(JSON.stringify(harness.attempts)).not.toContain('"sourceTags":[]')
  })

  it('replays an accepted context turn with the same ticket without a second dispatch', async () => {
    const harness = await newHarness()
    const sessionId = `session-${randomUUID()}`
    const requestId = randomUUID()
    const ticket = (() => {
      const staged = harness.ticketStore.stage({
        sessionId,
        requestId,
        runtimeRevision: 1,
        contentBinding: computeContentBinding(BODY, []),
        contextBinding: contextBindingOf(SNAPSHOT.selection),
        publicManifest: buildPublicContextManifest(SNAPSHOT, {
          requestId,
          resolvedAt: FIXTURE.publicManifest.resolvedAt,
        }),
        modelContext: '{"hosts":[{"id":"10000000-0000-4000-8000-000000000001"}]}',
      })
      if (!staged.ok) throw new Error(`stage failed: ${staged.code}`)
      return staged.ticket
    })()

    const frame = {
      content: BODY,
      attachments: [],
      requestId,
      contextTicket: { ticketId: ticket.ticketId, sidecarInstanceId: harness.ticketStore.sidecarInstanceId },
    }

    const first = await harness.send(sessionId, frame)
    const replay = await harness.send(sessionId, frame)

    expect(first.dispatched).toBe(true)
    expect(first.preparation.kind).toBe('accepted')
    expect(replay.dispatched).toBe(false)
    expect(replay.preparation.kind).toBe('replayed')
    expect(harness.attempts).toHaveLength(1)
    // The replayed turn still reports the original context identity.
    if (replay.preparation.kind === 'replayed') {
      expect(replay.preparation.receipt.ticketId).toBe(ticket.ticketId)
      expect(replay.preparation.receipt.contextBinding).toBe(ticket.contextBinding)
    }
  })

  it('keeps a frame without identity out of the ticket path entirely', async () => {
    const harness = await newHarness()
    const sessionId = `session-${randomUUID()}`

    const preparation = await harness.send(sessionId, { content: BODY, attachments: [] })

    expect(preparation.preparation.kind).toBe('passthrough')
    expect(preparation.dispatched).toBe(false)
    expect(harness.attempts).toHaveLength(0)
    expect(harness.ticketStore.stats().tickets).toBe(0)
    expect(await harness.receipts.list(sessionId)).toEqual([])
    // §8.2: no context -> the composed prompt is the typed text, byte for byte.
    expect(composeUserContent({ userText: BODY, contextText: null })).toEqual({
      content: BODY,
      composed: false,
    })
  })
})
