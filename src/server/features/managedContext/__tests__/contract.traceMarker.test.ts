/**
 * M7-B contract: the §8.4 sensitivity policy.
 *
 * One secret-bearing dispatch marks the session; a public-manifest-only
 * dispatch never does. The mark is consulted by the title gate, by Trace body
 * capture and by the search projection. Trace is asserted against the real
 * capture service (sandboxed config dir), the other two through the exact
 * delegate their call sites use.
 */

import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import {
  isSecretBearingStagedContext,
  isSessionSensitivityMarked,
  markSessionSensitive,
  resetSensitivityPolicyForTests,
  shouldSuppressSearchContentCapture,
  shouldSuppressTitleGeneration,
  shouldSuppressTraceBodyCapture,
} from '../../../../services/managedContext/sensitivityPolicy.js'
import {
  traceCaptureService,
  createSuppressedTraceBodySnapshot,
} from '../../../../services/api/traceCapture.js'
import { contextBindingOf } from '../../../../services/managedContext/canonicalSerializer.js'
import { createTestDeps, loadContractFixture } from './stagedFixture.js'
import { computeContentBinding, prepareUserMessage } from '../wsBridge.js'
import { ContextTurnReceiptStore } from '../receipts.js'

const contract = loadContractFixture()
const PUBLIC_MANIFEST = contract.publicManifest

let sandbox = ''

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'm7b-trace-'))
  process.env.CLAUDE_CONFIG_DIR = sandbox
  process.env.CC_HAHA_TRACE_API_CALLS = 'true'
})

afterAll(async () => {
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.CC_HAHA_TRACE_API_CALLS
  await rm(sandbox, { recursive: true, force: true }).catch(() => undefined)
})

const BODY = 'rotate the database password on doc-target-1'

describe('M7-B sensitivity — classification', () => {
  it('classifies from the public manifest counters only', () => {
    expect(
      isSecretBearingStagedContext({ containsSecrets: false, secretFieldCount: 0 }),
    ).toBe(false)
    expect(
      isSecretBearingStagedContext({ containsSecrets: true, secretFieldCount: 0 }),
    ).toBe(true)
    expect(
      isSecretBearingStagedContext({ containsSecrets: false, secretFieldCount: 2 }),
    ).toBe(true)
  })

  it('never classifies the public manifest itself as secret-bearing', () => {
    expect(PUBLIC_MANIFEST.containsSecrets).toBe(false)
    expect(isSecretBearingStagedContext(PUBLIC_MANIFEST)).toBe(false)
  })

  it('marks monotonically and only for the marked session', () => {
    resetSensitivityPolicyForTests()
    const sensitive = `session-${randomUUID()}`
    const plain = `session-${randomUUID()}`
    markSessionSensitive(sensitive)
    markSessionSensitive(sensitive)
    expect(isSessionSensitivityMarked(sensitive)).toBe(true)
    expect(isSessionSensitivityMarked(plain)).toBe(false)
    expect(shouldSuppressTraceBodyCapture(sensitive)).toBe(true)
    expect(shouldSuppressTitleGeneration(plain)).toBe(false)
  })
})

describe('M7-B sensitivity — dispatch marks, public manifest does not', () => {
  it('marks exactly the session whose staged manifest is secret-bearing', async () => {
    resetSensitivityPolicyForTests()
    const deps = createTestDeps()
    const receipts = new ContextTurnReceiptStore({ dir: join(sandbox, 'context-turns-1') })
    const publicSession = `session-${randomUUID()}`
    const secretSession = `session-${randomUUID()}`
    const publicRequestId = randomUUID()
    const secretRequestId = randomUUID()
    const contextBinding = contextBindingOf(PUBLIC_MANIFEST.selection)

    const publicStage = deps.store.stage({
      sessionId: publicSession,
      requestId: publicRequestId,
      runtimeRevision: 1,
      contentBinding: computeContentBinding(BODY, undefined),
      contextBinding,
      publicManifest: PUBLIC_MANIFEST,
      modelContext: '{"hosts":[]}',
    })
    expect(publicStage.ok).toBe(true)

    const secretManifest = {
      ...PUBLIC_MANIFEST,
      containsSecrets: true,
      secretFieldCount: 1,
    }
    const secretStage = deps.store.stage({
      sessionId: secretSession,
      requestId: secretRequestId,
      runtimeRevision: 1,
      contentBinding: computeContentBinding(BODY, undefined),
      contextBinding,
      publicManifest: secretManifest,
      modelContext: '{"hosts":[],"credentials":["<redacted>"]}',
    })
    expect(secretStage.ok).toBe(true)

    const bridgeDeps = {
      store: deps.store,
      receipts,
      runtimeRevision: () => 1,
    }
    const publicPrep = await prepareUserMessage({
      sessionId: publicSession,
      frame: {
        content: BODY,
        requestId: publicRequestId,
        contextTicket: {
          ticketId: publicStage.ok ? publicStage.ticket.ticketId : '',
          sidecarInstanceId: deps.store.sidecarInstanceId,
        },
      },
      deps: bridgeDeps,
    })
    const secretPrep = await prepareUserMessage({
      sessionId: secretSession,
      frame: {
        content: BODY,
        requestId: secretRequestId,
        contextTicket: {
          ticketId: secretStage.ok ? secretStage.ticket.ticketId : '',
          sidecarInstanceId: deps.store.sidecarInstanceId,
        },
      },
      deps: bridgeDeps,
    })

    expect(publicPrep.kind).toBe('accepted')
    expect(secretPrep.kind).toBe('accepted')
    expect(isSessionSensitivityMarked(publicSession)).toBe(false)
    expect(isSessionSensitivityMarked(secretSession)).toBe(true)
    expect(shouldSuppressTitleGeneration(secretSession)).toBe(true)
    expect(shouldSuppressSearchContentCapture(secretSession)).toBe(true)
    expect(shouldSuppressTitleGeneration(publicSession)).toBe(false)
    expect(shouldSuppressSearchContentCapture(publicSession)).toBe(false)
  })
})

describe('M7-B sensitivity — Trace stop capturing body', () => {
  it('withholds the body for a marked session and captures it otherwise', async () => {
    resetSensitivityPolicyForTests()
    const markedSession = `session-${randomUUID()}`
    const plainSession = `session-${randomUUID()}`
    markSessionSensitive(markedSession)

    const marked = await traceCaptureService.recordCall({
      sessionId: markedSession,
      source: 'anthropic',
      status: 'ok',
      durationMs: 12,
      request: { body: { messages: [{ role: 'user', content: BODY }] } },
    })
    const plain = await traceCaptureService.recordCall({
      sessionId: plainSession,
      source: 'anthropic',
      status: 'ok',
      durationMs: 12,
      request: { body: { messages: [{ role: 'user', content: BODY }] } },
    })

    expect(marked).not.toBeNull()
    expect(plain).not.toBeNull()
    expect(marked!.request.body).toEqual(createSuppressedTraceBodySnapshot())
    expect(marked!.request.body.preview).not.toContain(BODY)
    // Metadata survives: the shape of the diagnostic system is unchanged.
    expect(marked!.status).toBe('ok')
    expect(marked!.durationMs).toBe(12)
    expect(plain!.request.body.preview).toContain(BODY)
  })

  it('drops trace event message text for a marked session only', async () => {
    const markedSession = `session-${randomUUID()}`
    const plainSession = `session-${randomUUID()}`
    markSessionSensitive(markedSession)

    const marked = await traceCaptureService.recordEvent({
      sessionId: markedSession,
      phase: 'turn',
      message: BODY,
      metadata: { count: 3 },
    })
    const plain = await traceCaptureService.recordEvent({
      sessionId: plainSession,
      phase: 'turn',
      message: BODY,
      metadata: { count: 3 },
    })
    expect(marked!.message).toBeUndefined()
    expect(marked!.metadata?.count).toBe(3)
    expect(plain!.message).toContain(BODY)
  })
})
