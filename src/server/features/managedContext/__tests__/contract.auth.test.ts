/**
 * M7-A contract tests for the loopback-only staging API: peer, bearer, size,
 * capacity, TTL, binding and receipt behaviour. The staged request comes from
 * `fixtures/managed-resources/contract-v2.fixture.json`.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleApiRequest } from '../../../router.js'
import {
  CONTEXT_MODEL_CONTEXT_BYTES_LIMIT,
  CONTEXT_STAGE_BODY_BYTES_LIMIT,
} from '../ticketStore.js'
import { handleManagedContextApi, type ManagedContextApiDeps } from '../api.js'
import { contextBindingOf } from '../../../../services/managedContext/canonicalSerializer.js'
import {
  LOCAL_ACCESS_TOKEN_ENV,
  TEST_LOCAL_TOKEN,
  TEST_ORIGIN,
  TEST_PEER,
  createSpyVault,
  createStubSessionGate,
  createTestDeps,
  loadContractFixture,
  stageRequestBody,
  type ContractFixture,
} from './stagedFixture.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE: ContractFixture = loadContractFixture()
const SESSION_ID = FIXTURE.ticketWire.stageContextRequest.sessionId
const REQUEST_ID = FIXTURE.ticketWire.stageContextRequest.requestId
const RUNTIME_REVISION = FIXTURE.ticketWire.stageContextRequest.runtimeRevision
const FIXED_NOW = Date.parse('2026-09-12T00:00:00.000Z')

const previousToken = process.env[LOCAL_ACCESS_TOKEN_ENV]

beforeEach(() => {
  process.env[LOCAL_ACCESS_TOKEN_ENV] = TEST_LOCAL_TOKEN
})

afterAll(() => {
  if (previousToken === undefined) delete process.env[LOCAL_ACCESS_TOKEN_ENV]
  else process.env[LOCAL_ACCESS_TOKEN_ENV] = previousToken
})

type CallInit = {
  method: 'GET' | 'POST' | 'DELETE'
  body?: string
  peer?: string | null
  /** `undefined` sends the test bearer; `null` sends none. */
  token?: string | null
  headers?: Record<string, string>
}

function segmentList(path: string): string[] {
  return path.split('/').filter(Boolean)
}

async function call(
  path: string,
  init: CallInit,
  deps: ManagedContextApiDeps,
): Promise<Response> {
  const url = new URL(`${TEST_ORIGIN}${path}`)
  const headers = new Headers(init.headers)
  if (init.token !== null) {
    headers.set('Authorization', `Bearer ${init.token ?? TEST_LOCAL_TOKEN}`)
  }
  const request = new Request(url, { method: init.method, headers, body: init.body })
  return handleManagedContextApi(request, url, segmentList(url.pathname), {
    clientAddress: init.peer === undefined ? TEST_PEER : init.peer,
  }, deps)
}

function stageDeps(options: { now?: () => number; sessions?: Record<string, number | null> } = {}) {
  return createTestDeps({
    now: options.now ?? (() => FIXED_NOW),
    sessions: createStubSessionGate(options.sessions ?? { [SESSION_ID]: RUNTIME_REVISION }),
  })
}

function requestFor(overrides: {
  sessionId?: string
  requestId?: string
  contextBinding?: string
  includePasswords?: boolean
  modelContext?: string
} = {}): string {
  const body = stageRequestBody(FIXTURE)
  if (overrides.sessionId) body.sessionId = overrides.sessionId
  if (overrides.requestId) body.requestId = overrides.requestId
  if (overrides.contextBinding) body.contextBinding = overrides.contextBinding
  if (overrides.modelContext !== undefined) body.modelContext = overrides.modelContext
  if (overrides.includePasswords) {
    body.publicManifest.selection.includePasswords = true
    body.publicManifest.selection.credentialRefs = [
      { id: '50000000-0000-4000-8000-000000000001', revision: 1 },
    ]
    body.contextBinding = contextBindingOf(body.publicManifest.selection)
  }
  return JSON.stringify(body)
}

function sessionIdFor(index: number): string {
  return `70000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

describe('M7-A staging route wiring', () => {
  it('registers POST /api/context-tickets and rejects a non-loopback peer through the router', async () => {
    const url = new URL(`${TEST_ORIGIN}/api/context-tickets`)
    const request = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestFor(),
    })
    const response = await handleApiRequest(request, url, { clientAddress: '203.0.113.7' })
    expect(response.status).toBe(403)
    expect((await readJson(response)).code).toBe('FORBIDDEN_PEER')
  })

  it.each(['/api/context-tickets', '/api//context-tickets', '//api/context-tickets'])('rejects a remote-browser staging request at %s even with a loopback peer and valid bearer', async pathname => {
    const url = new URL(`${TEST_ORIGIN}${pathname}`)
    const request = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${TEST_LOCAL_TOKEN}` },
      body: requestFor(),
    })
    const response = await handleApiRequest(request, url, { clientAddress: TEST_PEER, remoteBrowser: true })
    expect(response.status).toBe(403)
    expect((await readJson(response)).error).toBe('Desktop-only capability')
  })

  it('requires the local bearer through the router', async () => {
    const url = new URL(`${TEST_ORIGIN}/api/context-tickets`)
    const request = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestFor(),
    })
    const response = await handleApiRequest(request, url, { clientAddress: TEST_PEER })
    expect(response.status).toBe(401)
    expect((await readJson(response)).code).toBe('UNAUTHORIZED')
  })
})

describe('M7-A staging peer guard', () => {
  it('accepts the pinned contract-v2 stage request from the loopback peer', async () => {
    const deps = stageDeps()
    const response = await call('/api/context-tickets', {
      method: 'POST',
      body: requestFor(),
    }, deps)
    expect(response.status).toBe(201)
    const body = await readJson(response)
    expect(typeof body.ticketId).toBe('string')
    expect(String(body.ticketId)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(body.sidecarInstanceId).toBe('80000000-0000-4000-8000-000000000001')
    expect(body.expiresAt).toBe(new Date(FIXED_NOW + 120_000).toISOString())
    expect(body.publicManifest).toEqual(FIXTURE.publicManifest)
    // The staged model context is accepted but never echoed.
    expect(JSON.stringify(body)).not.toContain('FAKE_ONLY_DO_NOT_USE_MODEL_CONTEXT')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(deps.store.stats().tickets).toBe(1)
  })

  it('rejects a non-loopback peer', async () => {
    const response = await call('/api/context-tickets', {
      method: 'POST',
      body: requestFor(),
      peer: '192.0.2.5',
    }, stageDeps())
    expect(response.status).toBe(403)
    expect((await readJson(response)).code).toBe('FORBIDDEN_PEER')
  })

  it('rejects a request whose peer address is unknown', async () => {
    const response = await call('/api/context-tickets', {
      method: 'POST',
      body: requestFor(),
      peer: null,
    }, stageDeps())
    expect(response.status).toBe(403)
  })

  it('never trusts X-Forwarded-For', async () => {
    const spoofedPeer = await call('/api/context-tickets', {
      method: 'POST',
      body: requestFor(),
      peer: '203.0.113.9',
      headers: { 'X-Forwarded-For': '127.0.0.1' },
    }, stageDeps())
    expect(spoofedPeer.status).toBe(403)

    const spoofedHeader = await call('/api/context-tickets', {
      method: 'POST',
      body: requestFor(),
      headers: { 'X-Forwarded-For': '203.0.113.9' },
    }, stageDeps())
    expect(spoofedHeader.status).toBe(201)
  })
})

describe('M7-A staging bearer guard', () => {
  it('rejects a missing or wrong bearer token', async () => {
    const missing = await call('/api/context-tickets', {
      method: 'POST',
      body: requestFor(),
      token: null,
    }, stageDeps())
    expect(missing.status).toBe(401)
    expect((await readJson(missing)).code).toBe('UNAUTHORIZED')

    const wrong = await call('/api/context-tickets', {
      method: 'POST',
      body: requestFor(),
      token: 'not-the-local-token',
    }, stageDeps())
    expect(wrong.status).toBe(401)
  })

  it('rejects when no local token is configured on the server', async () => {
    delete process.env[LOCAL_ACCESS_TOKEN_ENV]
    const response = await call('/api/context-tickets', {
      method: 'POST',
      body: requestFor(),
    }, stageDeps())
    expect(response.status).toBe(401)
    process.env[LOCAL_ACCESS_TOKEN_ENV] = TEST_LOCAL_TOKEN
  })

  it('does not accept a pet token as the staging bearer', async () => {
    process.env.CC_HAHA_PET_ACCESS_TOKEN = 'pet-only-token'
    try {
      const response = await call('/api/context-tickets', {
        method: 'POST',
        body: requestFor(),
        token: 'pet-only-token',
      }, stageDeps())
      expect(response.status).toBe(401)
    } finally {
      delete process.env.CC_HAHA_PET_ACCESS_TOKEN
    }
  })
})

describe('M7-A staging limits and binding', () => {
  it('rejects a body above 512 KiB', async () => {
    const response = await call('/api/context-tickets', {
      method: 'POST',
      body: JSON.stringify({ padding: 'x'.repeat(CONTEXT_STAGE_BODY_BYTES_LIMIT + 1024) }),
    }, stageDeps())
    expect(response.status).toBe(413)
    expect((await readJson(response)).code).toBe('BODY_TOO_LARGE')
  })

  it('rejects a modelContext above 64 KiB', async () => {
    const response = await call('/api/context-tickets', {
      method: 'POST',
      body: requestFor({ modelContext: 'y'.repeat(CONTEXT_MODEL_CONTEXT_BYTES_LIMIT + 1) }),
    }, stageDeps())
    expect(response.status).toBe(413)
    expect((await readJson(response)).code).toBe('MODEL_CONTEXT_TOO_LARGE')
  })

  it('re-derives contextBinding from the submitted selection', async () => {
    const response = await call('/api/context-tickets', {
      method: 'POST',
      body: requestFor({ contextBinding: '0'.repeat(64) }),
    }, stageDeps())
    expect(response.status).toBe(400)
    expect((await readJson(response)).code).toBe('CONTEXT_BINDING_MISMATCH')
  })

  it('rejects unknown sessions, sessions without a runtime revision and revision mismatch', async () => {
    const unknown = await call('/api/context-tickets', {
      method: 'POST',
      body: requestFor(),
    }, stageDeps({ sessions: {} }))
    expect(unknown.status).toBe(404)
    expect((await readJson(unknown)).code).toBe('SESSION_NOT_FOUND')

    const unavailable = await call('/api/context-tickets', {
      method: 'POST',
      body: requestFor(),
    }, stageDeps({ sessions: { [SESSION_ID]: null } }))
    expect(unavailable.status).toBe(409)
    expect((await readJson(unavailable)).code).toBe('RUNTIME_REVISION_UNAVAILABLE')

    const mismatch = await call('/api/context-tickets', {
      method: 'POST',
      body: requestFor(),
    }, stageDeps({ sessions: { [SESSION_ID]: RUNTIME_REVISION + 1 } }))
    expect(mismatch.status).toBe(409)
    expect((await readJson(mismatch)).code).toBe('RUNTIME_REVISION_MISMATCH')
  })

  it('refuses the disclosure path without touching the vault', async () => {
    const spy = createSpyVault()
    const response = await call('/api/context-tickets', {
      method: 'POST',
      body: requestFor({ includePasswords: true }),
    }, createTestDeps({
      now: () => FIXED_NOW,
      sessions: createStubSessionGate({ [SESSION_ID]: RUNTIME_REVISION }),
      vault: spy.gateway,
    }))
    expect(response.status).toBe(400)
    expect((await readJson(response)).code).toBe('SECRET_DISCLOSURE_NOT_READY')
    expect(spy.calls).toEqual({ availability: 0, reveal: 0 })
  })

  it('accepts main-process-resolved disclosure without consulting the sidecar vault', async () => {
    const spy = createSpyVault('available')
    const response = await call('/api/context-tickets', {
      method: 'POST',
      body: requestFor({ includePasswords: true }),
    }, createTestDeps({
      now: () => FIXED_NOW,
      sessions: createStubSessionGate({ [SESSION_ID]: RUNTIME_REVISION }),
      vault: spy.gateway,
      allowSecretDisclosure: true,
    }))
    expect(response.status).toBe(201)
    expect(spy.calls).toEqual({ availability: 0, reveal: 0 })
  })

  it('accepts a non-UUID legacy session id while keeping requestId UUID-bound', async () => {
    const sessionId = 'legacy-session-id'
    const body = JSON.parse(requestFor({ sessionId })) as Record<string, unknown>
    const deps = createTestDeps({
      now: () => FIXED_NOW,
      sessions: createStubSessionGate({ [sessionId]: RUNTIME_REVISION }),
    })
    const response = await call('/api/context-tickets', {
      method: 'POST',
      body: JSON.stringify(body),
    }, deps)
    expect(response.status).toBe(201)
  })

  it('enforces four tickets per session', async () => {
    const deps = stageDeps()
    for (let i = 0; i < 4; i += 1) {
      const response = await call('/api/context-tickets', {
        method: 'POST',
        body: requestFor(),
      }, deps)
      expect(response.status).toBe(201)
    }
    const rejected = await call('/api/context-tickets', {
      method: 'POST',
      body: requestFor(),
    }, deps)
    expect(rejected.status).toBe(429)
    expect((await readJson(rejected)).code).toBe('TICKET_SESSION_LIMIT_REACHED')
    expect(deps.store.stats().tickets).toBe(4)
  })

  it('enforces the 64-ticket global limit', async () => {
    const sessions: Record<string, number | null> = {}
    for (let i = 0; i < 16; i += 1) sessions[sessionIdFor(i)] = RUNTIME_REVISION
    const deps = stageDeps({ sessions })

    for (let i = 0; i < 16; i += 1) {
      for (let slot = 0; slot < 4; slot += 1) {
        const response = await call('/api/context-tickets', {
          method: 'POST',
          body: requestFor({ sessionId: sessionIdFor(i), requestId: REQUEST_ID }),
        }, deps)
        expect(response.status).toBe(201)
      }
    }
    expect(deps.store.stats().tickets).toBe(64)

    sessions[sessionIdFor(16)] = RUNTIME_REVISION
    const rejected = await call('/api/context-tickets', {
      method: 'POST',
      body: requestFor({ sessionId: sessionIdFor(16) }),
    }, deps)
    expect(rejected.status).toBe(429)
    expect((await readJson(rejected)).code).toBe('TICKET_GLOBAL_LIMIT_REACHED')
  })

  it('keeps staged tickets and snapshots in memory only', () => {
    const files = ['api.ts', 'ticketStore.ts'].map((name) =>
      resolve(HERE, '..', name),
    )
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      expect(source).not.toContain('node:fs')
      expect(source).not.toContain('writeFile')
      expect(source).not.toContain('createWriteStream')
    }
  })
})

describe('M7-A ticket store, receipts and TTL', () => {
  it('revokes a ticket through DELETE and marks the receipt rejected', async () => {
    const deps = stageDeps()
    const staged = await call('/api/context-tickets', {
      method: 'POST',
      body: requestFor(),
    }, deps)
    const { ticketId } = await readJson(staged)

    const revoked = await call(`/api/context-tickets/${ticketId}`, { method: 'DELETE' }, deps)
    expect(revoked.status).toBe(204)

    const again = await call(`/api/context-tickets/${ticketId}`, { method: 'DELETE' }, deps)
    expect(again.status).toBe(404)

    const receipt = await call(
      `/api/context-tickets/receipts/${REQUEST_ID}?sessionId=${SESSION_ID}`,
      { method: 'GET' },
      deps,
    )
    expect(receipt.status).toBe(200)
    const body = await readJson(receipt)
    expect(body.status).toBe('rejected')
    expect(body.rejection).toEqual({ code: 'TICKET_REVOKED', retryable: true })
  })

  it('returns a public receipt and never the model context', async () => {
    const deps = stageDeps()
    await call('/api/context-tickets', { method: 'POST', body: requestFor() }, deps)

    const receipt = await call(
      `/api/context-tickets/receipts/${REQUEST_ID}?sessionId=${SESSION_ID}`,
      { method: 'GET' },
      deps,
    )
    expect(receipt.status).toBe(200)
    const body = await readJson(receipt)
    expect(body).toMatchObject({
      requestId: REQUEST_ID,
      sessionId: SESSION_ID,
      runtimeRevision: RUNTIME_REVISION,
      status: 'prepared',
    })
    expect(typeof body.ticketBindingHash).toBe('string')
    expect(String(body.ticketBindingHash)).toMatch(/^[0-9a-f]{64}$/)
    expect(typeof body.contentBinding).toBe('string')
    expect(await receipt.clone().text()).not.toContain('FAKE_ONLY_DO_NOT_USE_MODEL_CONTEXT')

    const missingSession = await call(
      `/api/context-tickets/receipts/${REQUEST_ID}`,
      { method: 'GET' },
      deps,
    )
    expect(missingSession.status).toBe(400)
    expect((await readJson(missingSession)).code).toBe('SESSION_ID_REQUIRED')

    const otherSession = await call(
      `/api/context-tickets/receipts/${REQUEST_ID}?sessionId=${sessionIdFor(99)}`,
      { method: 'GET' },
      deps,
    )
    expect(otherSession.status).toBe(404)

    const wrongRuntime = await call(
      `/api/context-tickets/receipts/${REQUEST_ID}?sessionId=${SESSION_ID}&runtimeRevision=${RUNTIME_REVISION + 1}`,
      { method: 'GET' },
      deps,
    )
    expect(wrongRuntime.status).toBe(409)
    expect((await readJson(wrongRuntime)).code).toBe('RUNTIME_REVISION_MISMATCH')
  })

  it('expires staged tickets after the 120 s TTL', async () => {
    let clock = FIXED_NOW
    const deps = stageDeps({ now: () => clock })
    const staged = await call('/api/context-tickets', {
      method: 'POST',
      body: requestFor(),
    }, deps)
    const { ticketId } = await readJson(staged)
    expect(deps.store.getTicket(String(ticketId))).not.toBeNull()

    clock += 120_001

    const consumed = deps.store.consumeTicket(String(ticketId), {
      sessionId: SESSION_ID,
      requestId: REQUEST_ID,
      runtimeRevision: RUNTIME_REVISION,
    })
    expect(consumed.ok).toBe(false)
    if ('code' in consumed) expect(consumed.code).toBe('TICKET_EXPIRED')
    expect(deps.store.getTicket(String(ticketId))).toBeNull()

    const revoked = await call(`/api/context-tickets/${ticketId}`, { method: 'DELETE' }, deps)
    expect(revoked.status).toBe(404)
  })

  it('binds a staged ticket to its session, request and runtime revision', async () => {
    const deps = stageDeps()
    const staged = await call('/api/context-tickets', {
      method: 'POST',
      body: requestFor(),
    }, deps)
    const { ticketId } = await readJson(staged)

    const wrongSession = deps.store.consumeTicket(String(ticketId), {
      sessionId: sessionIdFor(7),
      requestId: REQUEST_ID,
      runtimeRevision: RUNTIME_REVISION,
    })
    expect(wrongSession.ok).toBe(false)
    if ('code' in wrongSession) expect(wrongSession.code).toBe('TICKET_BINDING_MISMATCH')

    const wrongRequest = deps.store.consumeTicket(String(ticketId), {
      sessionId: SESSION_ID,
      requestId: sessionIdFor(8),
      runtimeRevision: RUNTIME_REVISION,
    })
    expect(wrongRequest.ok).toBe(false)
    if ('code' in wrongRequest) expect(wrongRequest.code).toBe('TICKET_BINDING_MISMATCH')

    const wrongRuntime = deps.store.consumeTicket(String(ticketId), {
      sessionId: SESSION_ID,
      requestId: REQUEST_ID,
      runtimeRevision: RUNTIME_REVISION + 3,
    })
    expect(wrongRuntime.ok).toBe(false)
    if ('code' in wrongRuntime) expect(wrongRuntime.code).toBe('RUNTIME_REVISION_MISMATCH')

    const matched = deps.store.consumeTicket(String(ticketId), {
      sessionId: SESSION_ID,
      requestId: REQUEST_ID,
      runtimeRevision: RUNTIME_REVISION,
    })
    expect(matched.ok).toBe(true)
  })

  it('walks the receipt state machine and refuses illegal transitions', async () => {
    const deps = stageDeps()
    await call('/api/context-tickets', { method: 'POST', body: requestFor() }, deps)

    expect(deps.store.transitionReceipt(SESSION_ID, REQUEST_ID, 'dispatching')?.status).toBe('dispatching')
    expect(deps.store.transitionReceipt(SESSION_ID, REQUEST_ID, 'accepted')?.status).toBe('accepted')
    expect(deps.store.transitionReceipt(SESSION_ID, REQUEST_ID, 'observed')?.status).toBe('observed')
    expect(() => deps.store.transitionReceipt(SESSION_ID, REQUEST_ID, 'prepared')).toThrow(
      'Illegal context receipt transition observed -> prepared',
    )

    expect(deps.store.getReceipt(REQUEST_ID, SESSION_ID)?.status).toBe('observed')
  })

  it('supports delivery-unknown recovery', async () => {
    const deps = stageDeps()
    const staged = await call('/api/context-tickets', { method: 'POST', body: requestFor() }, deps)
    const { ticketId } = await readJson(staged)
    deps.store.transitionReceipt(SESSION_ID, REQUEST_ID, 'dispatching')
    deps.store.consumeSecretSnapshot(String(ticketId))

    const unknown = deps.store.transitionReceipt(SESSION_ID, REQUEST_ID, 'delivery-unknown')
    expect(unknown?.status).toBe('delivery-unknown')
    expect(deps.store.getReceipt(REQUEST_ID, SESSION_ID)?.ticketId).toBe(String(ticketId))
    expect(deps.store.transitionReceipt(SESSION_ID, REQUEST_ID, 'accepted')?.status).toBe('accepted')
  })
})
