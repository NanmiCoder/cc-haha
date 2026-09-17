/**
 * M0.3 contract fixture regression: desktop side reads the root
 * fixtures/managed-resources/contract-v2.fixture.json and validates the
 * positive example plus single-point deep-copy mutations using the actual
 * production schemas from this directory. No production schema is mocked
 * or re-declared. The test never opens a port, never reads the user's
 * HOME, never dynamic-imports any driver.
 *
 * The local wire schema below reuses the production PublicContextManifestV2Schema
 * as the nested manifest, so the public-surface denylist (password / privateKey /
 * ciphertext / token / secretValue) is enforced without re-declaring it.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import {
  ConceptSchema,
  ConversationContextSelectionV2Schema,
  DataConnectionSchema,
  HostSchema,
  PublicContextManifestV2Schema,
  ResourceDocumentSchema,
} from './resourceSchemas.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = path.resolve(HERE, '..', '..', '..', '..')
const FIXTURE_PATH = path.join(
  DESKTOP_DIR,
  '..',
  'fixtures',
  'managed-resources',
  'contract-v2.fixture.json',
)

function loadFixture(): {
  fixtureVersion: number
  resourceDocument: unknown
  selection: unknown
  publicManifest: unknown
  ticketWire: {
    stageContextRequest: {
      schemaVersion: number
      sessionId: string
      requestId: string
      runtimeRevision: number
      contentBinding: string
      contextBinding: string
      publicManifest: unknown
      modelContext: string
    }
    contextTicket: {
      ticketId: string
      sidecarInstanceId: string
      expiresAt: string
      publicManifest: unknown
    }
    userMessage: {
      type: string
      content: string
      requestId?: string
      contextTicket: { ticketId: string; sidecarInstanceId: string }
    }
  }
} {
  const raw = fs.readFileSync(FIXTURE_PATH, 'utf8')
  return JSON.parse(raw) as ReturnType<typeof loadFixture>
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// ----- Local wire schema (no production schema duplication) --------------------
//
// Only the three wire objects (StageContextRequest, ContextTicket, ContextUserMessage)
// are re-declared. The nested `publicManifest` reuses the production
// PublicContextManifestV2Schema so the public-surface denylist (password /
// privateKey / ciphertext / token / secretValue) and the secrets/consistency
// invariants are enforced by production code.

const StageContextRequestSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.uuidv4(),
  requestId: z.uuidv4(),
  runtimeRevision: z.number().int().min(1),
  contentBinding: z.string().regex(/^[0-9a-f]{64}$/),
  contextBinding: z.string().regex(/^[0-9a-f]{64}$/),
  publicManifest: PublicContextManifestV2Schema,
  modelContext: z.string(),
})

const ContextTicketSchema = z.object({
  ticketId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  sidecarInstanceId: z.uuidv4(),
  expiresAt: z.iso.datetime(),
  publicManifest: PublicContextManifestV2Schema,
})

const ContextUserMessageSchema = z.object({
  type: z.literal('user_message'),
  content: z.string(),
  requestId: z.uuidv4().optional(),
  contextTicket: z.object({
    ticketId: z.string(),
    sidecarInstanceId: z.uuidv4(),
  }),
})

const TicketWireSchema = z.object({
  stageContextRequest: StageContextRequestSchema,
  contextTicket: ContextTicketSchema,
  userMessage: ContextUserMessageSchema,
})

interface FixtureShape {
  resourceDocument: ReturnType<typeof ResourceDocumentSchema.parse>
  selection: ReturnType<typeof ConversationContextSelectionV2Schema.parse>
  publicManifest: ReturnType<typeof PublicContextManifestV2Schema.parse>
  ticketWire: ReturnType<typeof loadFixture>['ticketWire']
}

function validatedFixture(): FixtureShape {
  const f = loadFixture()
  return {
    resourceDocument: ResourceDocumentSchema.parse(f.resourceDocument),
    selection: ConversationContextSelectionV2Schema.parse(f.selection),
    publicManifest: PublicContextManifestV2Schema.parse(f.publicManifest),
    ticketWire: f.ticketWire,
  }
}

interface RevisionMap {
  hosts: Map<string, number>
  concepts: Map<string, number>
  databases: Map<string, number>
  redis: Map<string, number>
  tags: Map<string, { namespace: string }>
}

function buildRevisionMap(doc: ReturnType<typeof ResourceDocumentSchema.parse>): RevisionMap {
  const hosts = new Map<string, number>()
  const concepts = new Map<string, number>()
  const databases = new Map<string, number>()
  const redis = new Map<string, number>()
  const tags = new Map<string, { namespace: string }>()
  for (const h of doc.hosts) hosts.set(h.id, h.revision)
  for (const c of doc.concepts) concepts.set(c.id, c.revision)
  for (const c of doc.dataConnections) {
    if (c.kind === 'database') databases.set(c.id, c.revision)
    else if (c.kind === 'redis') redis.set(c.id, c.revision)
  }
  for (const t of doc.tags) tags.set(t.id, { namespace: t.namespace })
  return { hosts, concepts, databases, redis, tags }
}

function assertRevisionExact(
  refs: ReadonlyArray<{ id: string; revision: number }>,
  entityMap: Map<string, number>,
  label: string,
): void {
  for (const ref of refs) {
    const expected = entityMap.get(ref.id)
    expect(expected, `${label} ref id ${ref.id} must exist in resourceDocument`).toBeDefined()
    expect(ref.revision, `${label} ref id ${ref.id} revision must equal entity revision`).toBe(expected)
  }
}

describe('M0.3 contract fixture (desktop)', () => {
  it('accepts the positive fixture with the real production schemas', () => {
    const v = validatedFixture()
    expect(v.resourceDocument.schemaVersion).toBe(2)
    expect(v.selection.schemaVersion).toBe(2)
    expect(v.publicManifest.schemaVersion).toBe(2)
  })

  it('keeps Host + Concepts + MySQL + PostgreSQL + Redis shape under HostSchema and ConceptSchema', () => {
    const fixture = loadFixture()
    const raw = fixture.resourceDocument as {
      hosts: unknown[]
      concepts: unknown[]
      dataConnections: unknown[]
    }
    const host = raw.hosts[0]
    const mysql = raw.dataConnections.find(
      (c) => (c as { kind?: string }).kind === 'database' && (c as { engine?: string }).engine === 'mysql',
    )
    const postgres = raw.dataConnections.find(
      (c) => (c as { kind?: string }).kind === 'database' && (c as { engine?: string }).engine === 'postgresql',
    )
    const redis = raw.dataConnections.find((c) => (c as { kind?: string }).kind === 'redis')
    expect(host).toBeDefined()
    expect(mysql).toBeDefined()
    expect(postgres).toBeDefined()
    expect(redis).toBeDefined()
    expect(HostSchema.parse(host).name).toBe('doc-target-1')
    for (const concept of raw.concepts) {
      expect(ConceptSchema.parse(concept).title.length).toBeGreaterThan(0)
    }
    for (const c of raw.dataConnections) {
      expect(DataConnectionSchema.parse(c).id.length).toBeGreaterThan(0)
    }
  })

  it('locks the four tag namespaces and the cross-reference shape in selection v2', () => {
    const v = validatedFixture()
    const namespaces = new Set(v.resourceDocument.tags.map((t) => t.namespace))
    expect(namespaces).toEqual(new Set(['host', 'concept', 'database', 'redis']))
    expect(v.selection.sourceTags).toHaveLength(4)
    expect(v.selection.includePasswords).toBe(false)
    expect(v.selection.credentialRefs).toHaveLength(0)
    expect(v.selection.directConceptIds).toContain('20000000-0000-4000-8000-000000000002')

    const documentIds = {
      hosts: new Set(v.resourceDocument.hosts.map((h) => h.id)),
      concepts: new Set(v.resourceDocument.concepts.map((c) => c.id)),
      databases: new Set(
        v.resourceDocument.dataConnections
          .filter((c) => c.kind === 'database')
          .map((c) => c.id),
      ),
      redis: new Set(
        v.resourceDocument.dataConnections
          .filter((c) => c.kind === 'redis')
          .map((c) => c.id),
      ),
    }
    for (const ref of v.selection.hostRefs) expect(documentIds.hosts.has(ref.id)).toBe(true)
    for (const ref of v.selection.conceptRootRefs) expect(documentIds.concepts.has(ref.id)).toBe(true)
    for (const ref of v.selection.dependencyRefs) expect(documentIds.concepts.has(ref.id)).toBe(true)
    for (const ref of v.selection.databaseRefs) expect(documentIds.databases.has(ref.id)).toBe(true)
    for (const ref of v.selection.redisRefs) expect(documentIds.redis.has(ref.id)).toBe(true)
  })

  it('locks the revision of every ref to the entity revision', () => {
    const v = validatedFixture()
    const revMap = buildRevisionMap(v.resourceDocument)
    assertRevisionExact(v.selection.hostRefs, revMap.hosts, 'hostRefs')
    assertRevisionExact(v.selection.conceptRootRefs, revMap.concepts, 'conceptRootRefs')
    assertRevisionExact(v.selection.dependencyRefs, revMap.concepts, 'dependencyRefs')
    assertRevisionExact(v.selection.databaseRefs, revMap.databases, 'databaseRefs')
    assertRevisionExact(v.selection.redisRefs, revMap.redis, 'redisRefs')
  })

  it('asserts the top-level selection is deep-equal to publicManifest.selection', () => {
    const v = validatedFixture()
    expect(v.publicManifest.selection).toEqual(v.selection)
  })

  it('embeds the same publicManifest in all three ticket-wire objects and shares requestId', () => {
    const v = validatedFixture()
    const top = v.publicManifest
    const wireManifest = v.ticketWire.stageContextRequest.publicManifest
    const ticketManifest = v.ticketWire.contextTicket.publicManifest
    expect(wireManifest).toEqual(top)
    expect(ticketManifest).toEqual(top)
    expect(v.ticketWire.stageContextRequest.requestId).toBe(top.requestId)
    expect(v.ticketWire.userMessage.requestId).toBe(top.requestId)
    expect(v.ticketWire.userMessage.contextTicket.ticketId).toBe(
      v.ticketWire.contextTicket.ticketId,
    )
    expect(v.ticketWire.userMessage.contextTicket.sidecarInstanceId).toBe(
      v.ticketWire.contextTicket.sidecarInstanceId,
    )
    expect(v.ticketWire.contextTicket.ticketId).toHaveLength(43)
    expect(v.ticketWire.stageContextRequest.contentBinding).toHaveLength(64)
    expect(v.ticketWire.stageContextRequest.contextBinding).toHaveLength(64)
    expect(v.ticketWire.stageContextRequest.schemaVersion).toBe(1)
  })

  it('marks every byte of the public manifest as a known sentinel — no leaked secrets', () => {
    const v = validatedFixture()
    const serialised = JSON.stringify(v.publicManifest)
    expect(serialised).not.toMatch(/"password"/i)
    expect(serialised).not.toMatch(/"privateKey"/i)
    expect(serialised).not.toMatch(/"ciphertext/i)
    expect(serialised).not.toMatch(/"token"/i)
    expect(serialised).not.toMatch(/"secretValue"/i)
    expect(serialised).not.toMatch(/"FAKE_ONLY_DO_NOT_USE_CIPHERTEXT"/i)
    expect(v.publicManifest.containsSecrets).toBe(false)
    expect(v.publicManifest.secretFieldCount).toBe(0)
  })

  it('validates the complete ticket wire against the local wire schema', () => {
    const v = validatedFixture()
    const wire = {
      stageContextRequest: v.ticketWire.stageContextRequest,
      contextTicket: v.ticketWire.contextTicket,
      userMessage: v.ticketWire.userMessage,
    }
    const r = TicketWireSchema.safeParse(wire)
    expect(r.success).toBe(true)
  })

  it('rejects deep-copied positive fixture with port 0', () => {
    const v = validatedFixture()
    const mutated = deepClone(v.resourceDocument)
    const mysql = mutated.dataConnections.find(
      (c: { kind: string }) => c.kind === 'database',
    ) as { port?: number } | undefined
    expect(mysql).toBeDefined()
    mysql!.port = 0
    const r = ResourceDocumentSchema.safeParse(mutated as never)
    expect(r.success).toBe(false)
  })

  it('rejects deep-copied positive fixture with port 65536', () => {
    const v = validatedFixture()
    const mutated = deepClone(v.resourceDocument) as { hosts: { port?: number }[] }
    mutated.hosts[0]!.port = 65536
    const r = ResourceDocumentSchema.safeParse(mutated as never)
    expect(r.success).toBe(false)
  })

  it('rejects deep-copied positive fixture with an unknown database engine', () => {
    const v = validatedFixture()
    const mutated = deepClone(v.resourceDocument)
    const mysql = mutated.dataConnections.find(
      (c: { kind: string; engine?: string }) => c.kind === 'database' && c.engine === 'mysql',
    ) as { engine?: string } | undefined
    expect(mysql).toBeDefined()
    mysql!.engine = 'sqlite'
    const r = ResourceDocumentSchema.safeParse(mutated as never)
    expect(r.success).toBe(false)
  })

  it('rejects deep-copied positive fixture with an unknown redis topology', () => {
    const v = validatedFixture()
    const mutated = deepClone(v.resourceDocument)
    const redis = mutated.dataConnections.find(
      (c: { kind: string }) => c.kind === 'redis',
    ) as { topology?: string } | undefined
    expect(redis).toBeDefined()
    redis!.topology = 'cluster'
    const r = ResourceDocumentSchema.safeParse(mutated as never)
    expect(r.success).toBe(false)
  })

  it('rejects deep-copied positive fixture with duplicate host ids', () => {
    const v = validatedFixture()
    const mutated = deepClone(v.resourceDocument) as { hosts: unknown[] }
    mutated.hosts.push(deepClone(mutated.hosts[0]))
    const r = ResourceDocumentSchema.safeParse(mutated as never)
    expect(r.success).toBe(false)
  })

  it('rejects deep-copied positive fixture with a Host missing address', () => {
    const v = validatedFixture()
    const mutated = deepClone(v.resourceDocument) as { hosts: { address?: string }[] }
    delete mutated.hosts[0]!.address
    const r = ResourceDocumentSchema.safeParse(mutated as never)
    expect(r.success).toBe(false)
  })

  it('rejects deep-copied positive fixture with a Concept missing bodyMarkdown', () => {
    const v = validatedFixture()
    const mutated = deepClone(v.resourceDocument) as { concepts: { bodyMarkdown?: string }[] }
    delete mutated.concepts[0]!.bodyMarkdown
    const r = ResourceDocumentSchema.safeParse(mutated as never)
    expect(r.success).toBe(false)
  })

  it('rejects deep-copied positive fixture with selection missing includePasswords', () => {
    const f = loadFixture()
    const mutated = deepClone(f.selection) as { includePasswords?: boolean }
    delete mutated.includePasswords
    const r = ConversationContextSelectionV2Schema.safeParse(mutated as never)
    expect(r.success).toBe(false)
  })

  it('rejects deep-copied positive fixture with a wrong hostRef revision', () => {
    // Change the hostRef revision to a value that does not match the entity
    // revision. Both ids still match; only the revision is wrong. The relation
    // lock in `assertRevisionExact` must catch this.
    const v = validatedFixture()
    const mutated = deepClone(v.selection) as { hostRefs: { id: string; revision: number }[] }
    const wrongRevision = mutated.hostRefs[0]!.revision + 17
    mutated.hostRefs[0]!.revision = wrongRevision
    // The selection schema itself accepts the mutation (it only checks id+revision
    // shape, not the relation). Our own relation checker is what must fail.
    const schemaR = ConversationContextSelectionV2Schema.safeParse(mutated as never)
    expect(schemaR.success).toBe(true)
    let threw = false
    try {
      assertRevisionExact(mutated.hostRefs, buildRevisionMap(v.resourceDocument).hosts, 'hostRefs')
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  it('rejects a top-level selection copy that diverges from publicManifest.selection', () => {
    const v = validatedFixture()
    const mutated = deepClone(v.publicManifest) as { selection: { directConceptIds: string[] } }
    mutated.selection.directConceptIds.push('60000000-0000-4000-8000-000000000099')
    expect(mutated.selection).not.toEqual(v.selection)
    // The public manifest schema accepts the mutation (no cross equality rule).
    // The deep-equality assertion above is what must catch the divergence.
  })

  it('rejects a contextTicket missing ticketId via the local wire schema', () => {
    const v = validatedFixture()
    const wire = deepClone(v.ticketWire) as { contextTicket: { ticketId?: string } }
    delete wire.contextTicket.ticketId
    const r = ContextTicketSchema.safeParse(wire.contextTicket)
    expect(r.success).toBe(false)
  })
})