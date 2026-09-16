import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import {
  isSessionSensitivityMarked,
  persistSessionSensitive,
  reloadSensitivityPolicyForTests,
  resetSensitivityPolicyForTests,
} from '../../../../services/managedContext/sensitivityPolicy.js'
import { contextBindingOf } from '../../../../services/managedContext/canonicalSerializer.js'
import { computeContentBinding, prepareUserMessage } from '../wsBridge.js'
import { ContextTurnReceiptStore } from '../receipts.js'
import { createTestDeps, loadContractFixture } from './stagedFixture.js'

let sandbox = ''
const fixture = loadContractFixture()

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'm8-sensitive-'))
  process.env.CLAUDE_CONFIG_DIR = sandbox
})

afterAll(async () => {
  resetSensitivityPolicyForTests()
  delete process.env.CLAUDE_CONFIG_DIR
  await rm(sandbox, { recursive: true, force: true }).catch(() => undefined)
})

describe('M8 durable sensitivity', () => {
  it('survives an in-memory reset/reload', async () => {
    resetSensitivityPolicyForTests()
    const sessionId = `sensitive-${randomUUID()}`
    await persistSessionSensitive(sessionId)
    expect(isSessionSensitivityMarked(sessionId)).toBe(true)

    resetSensitivityPolicyForTests()
    expect(isSessionSensitivityMarked(sessionId)).toBe(false)
    reloadSensitivityPolicyForTests()
    expect(isSessionSensitivityMarked(sessionId)).toBe(true)
  })

  it('blocks a secret-bearing turn before ticket consumption when policy persistence fails', async () => {
    resetSensitivityPolicyForTests()
    const deps = createTestDeps()
    const sessionId = `sensitive-${randomUUID()}`
    const requestId = randomUUID()
    const body = 'use the selected credential'
    const manifest = {
      ...fixture.publicManifest,
      requestId,
      containsSecrets: true,
      secretFieldCount: 1,
    }
    const staged = deps.store.stage({
      sessionId,
      requestId,
      runtimeRevision: 1,
      contentBinding: computeContentBinding(body, undefined),
      contextBinding: contextBindingOf(manifest.selection),
      publicManifest: manifest,
      modelContext: JSON.stringify({ password: 'fake-host-password-123' }),
    })
    expect(staged.ok).toBe(true)
    if (!staged.ok) return

    const receipts = new ContextTurnReceiptStore({ dir: join(sandbox, 'failed-policy-receipts') })
    const result = await prepareUserMessage({
      sessionId,
      frame: {
        content: body,
        requestId,
        contextTicket: {
          ticketId: staged.ticket.ticketId,
          sidecarInstanceId: deps.store.sidecarInstanceId,
        },
      },
      deps: {
        store: deps.store,
        receipts,
        runtimeRevision: () => 1,
        persistSensitivity: async () => { throw new Error('disk full') },
      },
    })

    expect(result.kind).toBe('rejected')
    if (result.kind === 'rejected') {
      expect(result.code).toBe('SENSITIVITY_POLICY_WRITE_FAILED')
      expect(result.retryable).toBe(true)
    }
    expect(deps.store.getTicket(staged.ticket.ticketId)).not.toBeNull()
    expect(await receipts.read(sessionId, requestId)).toBeNull()
  })

  it('rejects a changed user body against the staged content binding', async () => {
    const deps = createTestDeps()
    const sessionId = `binding-${randomUUID()}`
    const requestId = randomUUID()
    const original = 'original user body'
    const staged = deps.store.stage({
      sessionId,
      requestId,
      runtimeRevision: 1,
      contentBinding: computeContentBinding(original, undefined),
      contextBinding: contextBindingOf(fixture.publicManifest.selection),
      publicManifest: { ...fixture.publicManifest, requestId },
      modelContext: '{"hosts":[]}',
    })
    expect(staged.ok).toBe(true)
    if (!staged.ok) return

    const result = await prepareUserMessage({
      sessionId,
      frame: {
        content: 'tampered body',
        requestId,
        contextTicket: {
          ticketId: staged.ticket.ticketId,
          sidecarInstanceId: deps.store.sidecarInstanceId,
        },
      },
      deps: {
        store: deps.store,
        receipts: new ContextTurnReceiptStore({ dir: join(sandbox, 'binding-receipts') }),
        runtimeRevision: () => 1,
        persistSensitivity: async () => undefined,
      },
    })
    expect(result.kind).toBe('rejected')
    if (result.kind === 'rejected') expect(result.code).toBe('REQUEST_ID_CONFLICT')
    expect(deps.store.getTicket(staged.ticket.ticketId)).not.toBeNull()
  })
})
