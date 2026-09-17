/**
 * M0.3 contract fixture regression: server side reads the root
 * fixtures/managed-resources/contract-v2.fixture.json and validates the
 * positive example plus single-point deep-copy mutations using an
 * independent Zod contract declared inside this test file. The contract
 * here does NOT import any desktop module, shared validator, or production
 * schema; it stands alone so the two sides cannot drift through a
 * shared implementation.
 *
 * The test never opens a port, never reads the user's HOME, never
 * dynamic-imports any driver.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const FIXTURE_PATH = resolve(
  REPO_ROOT,
  'fixtures',
  'managed-resources',
  'contract-v2.fixture.json',
)

// ----- Canonical Base64 --------------------------------------------------------
//
// Matches the production CanonicalBase64Schema in desktop/src/features/managed-resources/types/sharedSchemas.ts.
// Hand-rolled because no Node Buffer is used; the alphabet table is built once.

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function canonicalBase64(input: string): boolean {
  if (input.length === 0 || input.length % 4 !== 0) return false
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i)
    const isAlpha =
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a) ||
      (c >= 0x30 && c <= 0x39) ||
      c === 0x2b ||
      c === 0x2f ||
      c === 0x3d
    if (!isAlpha) return false
  }
  const stripped = input.replace(/=+$/, '')
  if (stripped.length % 4 === 1) return false
  const table = new Int8Array(256).fill(-1)
  for (let i = 0; i < B64_ALPHABET.length; i += 1) table[B64_ALPHABET.charCodeAt(i)] = i
  let buffer = 0
  let bits = 0
  const bytes: number[] = []
  for (let i = 0; i < stripped.length; i += 1) {
    const v = table[stripped.charCodeAt(i)] ?? -1
    if (v < 0) return false
    buffer = (buffer << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) return false
  const paddingChars = input.length - stripped.length
  const expectedPadding = (3 - (bytes.length % 3)) % 3
  if (paddingChars !== expectedPadding) return false
  return true
}

const ServerUuidV4 = z.uuidv4() // zod's z.uuidv4() strictly enforces RFC 4122 UUID v4.
const ServerIsoUtc = z.string().datetime({ offset: 0 })
const ServerRevision = z.number().int().min(1)
const ServerPort = z.number().int().min(1).max(65535)
const ServerBase64Canonical = z
  .string()
  .min(1)
  .max(20 * 1024 * 1024)
  .refine(canonicalBase64, { message: 'must be canonical Base64' })

const ServerAddress = z
  .string()
  .min(1)
  .max(255)
  .refine((v) => /^[0-9.]+$/.test(v) || /^[A-Za-z0-9.-]+(\.[A-Za-z0-9-]+)+$/.test(v), {
    message: 'address must be IPv4 or DNS',
  })

const ServerEntityMeta = z.object({
  id: ServerUuidV4,
  revision: ServerRevision,
  createdAt: ServerIsoUtc,
  updatedAt: ServerIsoUtc,
})

const ServerHostApplicationAccount = z.object({
  id: ServerUuidV4,
  label: z.string().min(1).max(120),
  username: z.string().min(1).max(64),
  credentialId: ServerUuidV4.nullable(),
})

const ServerHostApplication = z.object({
  id: ServerUuidV4,
  name: z.string().min(1).max(120),
  version: z.string().nullable(),
  installPaths: z.array(z.string().min(1).max(4096)).max(64),
  accessDescription: z.string().max(16 * 1024),
  accessUrls: z.array(z.string().url()).max(64),
  loginUrl: z.string().url().nullable(),
  accounts: z.array(ServerHostApplicationAccount).max(64),
  notes: z.string().max(16 * 1024),
})

const ServerKnownHostKey = z.object({
  endpoint: z.string().min(1).max(512),
  algorithm: z.string().min(1).max(64),
  sha256: z
    .string()
    .regex(/^[A-Za-z0-9+/]{43}$/, 'sha256 must be 43-character unpadded Base64'),
  trustedAt: ServerIsoUtc,
})

const ServerHost = ServerEntityMeta.extend({
  name: z.string().min(1).max(120),
  address: ServerAddress,
  port: ServerPort,
  username: z.string().min(1).max(64),
  auth: z.object({
    type: z.enum(['password', 'privateKey']),
    credentialId: ServerUuidV4.nullable(),
  }),
  tagIds: z.array(ServerUuidV4).max(50),
  initialDirectory: z.string().regex(/^\/[^\u0000]*$/).nullable(),
  applications: z.array(ServerHostApplication).max(100),
  notes: z.string().max(16 * 1024),
})

const ServerConcept = ServerEntityMeta.extend({
  title: z.string().min(1).max(120),
  summary: z.string().max(1024),
  bodyMarkdown: z.string().min(1).max(64 * 1024),
  tagIds: z.array(ServerUuidV4).max(50),
  dependsOnIds: z.array(ServerUuidV4).max(100),
  referenceIds: z.array(ServerUuidV4).max(100),
})

const ServerSqlConnection = z.object({
  id: ServerUuidV4,
  revision: ServerRevision,
  createdAt: ServerIsoUtc,
  updatedAt: ServerIsoUtc,
  name: z.string().min(1).max(120),
  address: ServerAddress,
  port: ServerPort,
  username: z.string().min(1).max(64).nullable(),
  credentialId: ServerUuidV4.nullable(),
  tagIds: z.array(ServerUuidV4).max(50),
  relatedHostId: ServerUuidV4.nullable(),
  environment: z.enum(['development', 'test', 'staging', 'production', 'unspecified']),
  tls: z.object({
    enabled: z.boolean(),
    serverName: z.string().nullable(),
    caCertificate: z.string().nullable(),
    clientCertificate: z.string().nullable(),
    clientKeyCredentialId: ServerUuidV4.nullable(),
  }),
  description: z.string().max(16 * 1024),
  accessInstructions: z.string().max(16 * 1024),
  kind: z.literal('database'),
  engine: z.enum(['mysql', 'mariadb', 'postgresql']),
  database: z.string().min(1).max(128),
  schema: z.string().min(1).max(128).nullable(),
  mode: z.enum(['inspection', 'query']),
})

const ServerRedisConnection = z.object({
  id: ServerUuidV4,
  revision: ServerRevision,
  createdAt: ServerIsoUtc,
  updatedAt: ServerIsoUtc,
  name: z.string().min(1).max(120),
  address: ServerAddress,
  port: ServerPort,
  username: z.string().min(1).max(64).nullable(),
  credentialId: ServerUuidV4.nullable(),
  tagIds: z.array(ServerUuidV4).max(50),
  relatedHostId: ServerUuidV4.nullable(),
  environment: z.enum(['development', 'test', 'staging', 'production', 'unspecified']),
  tls: z.object({
    enabled: z.boolean(),
    serverName: z.string().nullable(),
    caCertificate: z.string().nullable(),
    clientCertificate: z.string().nullable(),
    clientKeyCredentialId: ServerUuidV4.nullable(),
  }),
  description: z.string().max(16 * 1024),
  accessInstructions: z.string().max(16 * 1024),
  kind: z.literal('redis'),
  topology: z.literal('standalone'),
  databaseIndex: z.number().int().min(0).max(15),
  keyPrefixDescription: z.string().max(1024),
})

const ServerDataConnection = z.union([ServerSqlConnection, ServerRedisConnection])

const ServerCredentialRecord = z.object({
  id: ServerUuidV4,
  revision: ServerRevision,
  createdAt: ServerIsoUtc,
  updatedAt: ServerIsoUtc,
  kind: z.enum([
    'ssh-password',
    'ssh-private-key',
    'application-password',
    'database-password',
    'redis-password',
    'tls-client-key',
  ]),
  label: z.string().min(1).max(120),
  backend: z.literal('electron-safe-storage-v1'),
  ciphertextBase64: ServerBase64Canonical,
})

const ServerTag = z.object({
  id: ServerUuidV4,
  revision: ServerRevision,
  createdAt: ServerIsoUtc,
  updatedAt: ServerIsoUtc,
  namespace: z.enum(['host', 'database', 'redis', 'concept']),
  name: z.string().min(1).max(120),
  normalizedName: z.string().min(1).max(80),
  colorToken: z.string().nullable(),
})

const ServerResourceDocument = z
  .object({
    schemaVersion: z.literal(2),
    revision: ServerRevision,
    tags: z.array(ServerTag).max(10_000),
    hosts: z.array(ServerHost).max(10_000),
    concepts: z.array(ServerConcept).max(10_000),
    dataConnections: z.array(ServerDataConnection).max(10_000),
    credentials: z.array(ServerCredentialRecord).max(10_000),
    knownHostKeys: z.array(ServerKnownHostKey),
  })
  .superRefine((value, ctx) => {
    function unique(arr: { id: string }[], label: string): void {
      const seen = new Set<string>()
      for (let i = 0; i < arr.length; i += 1) {
        if (seen.has(arr[i].id)) {
          ctx.addIssue({
            code: 'custom',
            path: [label, i],
            message: 'duplicate id within the same collection',
          })
          return
        }
        seen.add(arr[i].id)
      }
    }
    unique(value.tags, 'tags')
    unique(value.hosts, 'hosts')
    unique(value.concepts, 'concepts')
    unique(value.dataConnections, 'dataConnections')
    unique(value.credentials, 'credentials')
  })

const ServerEntityRef = z.object({
  id: ServerUuidV4,
  revision: ServerRevision,
})

const ServerSourceTag = z.object({
  namespace: z.enum(['host', 'database', 'redis', 'concept']),
  id: ServerUuidV4,
  labelAtSelection: z.string().min(1).max(120),
  memberIds: z.array(ServerUuidV4).max(500),
})

const ServerSelectionV2 = z
  .object({
    schemaVersion: z.literal(2),
    hostRefs: z.array(ServerEntityRef).max(20),
    conceptRootRefs: z.array(ServerEntityRef).max(100),
    dependencyRefs: z.array(ServerEntityRef).max(100),
    databaseRefs: z.array(ServerEntityRef).max(20),
    redisRefs: z.array(ServerEntityRef).max(20),
    credentialRefs: z.array(ServerEntityRef).max(40),
    sourceTags: z.array(ServerSourceTag).max(200),
    directHostIds: z.array(ServerUuidV4).max(20),
    directConceptIds: z.array(ServerUuidV4).max(100),
    directDatabaseIds: z.array(ServerUuidV4).max(20),
    directRedisIds: z.array(ServerUuidV4).max(20),
    includePasswords: z.boolean(),
  })
  .superRefine((value, ctx) => {
    function uniqueRefs(refs: { id: string }[], label: string): void {
      const seen = new Set<string>()
      for (let i = 0; i < refs.length; i += 1) {
        if (seen.has(refs[i].id)) {
          ctx.addIssue({
            code: 'custom',
            path: [label, i],
            message: 'duplicate ref id within the same collection',
          })
          return
        }
        seen.add(refs[i].id)
      }
    }
    uniqueRefs(value.hostRefs, 'hostRefs')
    uniqueRefs(value.conceptRootRefs, 'conceptRootRefs')
    uniqueRefs(value.dependencyRefs, 'dependencyRefs')
    uniqueRefs(value.databaseRefs, 'databaseRefs')
    uniqueRefs(value.redisRefs, 'redisRefs')
    uniqueRefs(value.credentialRefs, 'credentialRefs')
  })

const ServerPublicDatabaseSummary = z.object({
  id: ServerUuidV4,
  name: z.string().min(1).max(120),
  engine: z.enum(['mysql', 'mariadb', 'postgresql']),
  address: ServerAddress,
  port: ServerPort,
  database: z.string().min(1),
  schema: z.string().nullable(),
})

const ServerPublicRedisSummary = z.object({
  id: ServerUuidV4,
  name: z.string().min(1).max(120),
  address: ServerAddress,
  port: ServerPort,
  topology: z.literal('standalone'),
  databaseIndex: z.number().int().min(0).max(15),
})

const ServerPublicManifest = z.object({
  schemaVersion: z.literal(2),
  requestId: ServerUuidV4,
  selection: ServerSelectionV2,
  hosts: z
    .array(
      z.object({
        id: ServerUuidV4,
        name: z.string().min(1).max(120),
        address: ServerAddress,
        port: ServerPort,
      }),
    )
    .max(20),
  concepts: z
    .array(
      z.object({
        id: ServerUuidV4,
        title: z.string().min(1).max(120),
        includedAs: z.enum(['root', 'dependency']),
      }),
    )
    .max(100),
  databases: z.array(ServerPublicDatabaseSummary).max(20),
  redisConnections: z.array(ServerPublicRedisSummary).max(20),
  resolvedAt: ServerIsoUtc,
  containsSecrets: z.boolean(),
  secretFieldCount: z.number().int().min(0),
  estimatedTokens: z.number().int().min(0),
})

// AttachmentRef shape mirrors src/server/ws/events.ts. The fixture omits it,
// but we keep the shape for completeness; the schema permits its omission.
const ServerAttachmentRef = z
  .object({
    type: z.enum(['file', 'image']),
    name: z.string().optional(),
    path: z.string().optional(),
    data: z.string().optional(),
    mimeType: z.string().optional(),
    isDirectory: z.boolean().optional(),
  })
  .strict()

const ServerStageContextRequest = z.object({
  schemaVersion: z.literal(1),
  sessionId: ServerUuidV4,
  requestId: ServerUuidV4,
  runtimeRevision: ServerRevision,
  contentBinding: z.string().regex(/^[0-9a-f]{64}$/),
  contextBinding: z.string().regex(/^[0-9a-f]{64}$/),
  publicManifest: ServerPublicManifest,
  modelContext: z.string(),
})

const ServerContextTicket = z.object({
  ticketId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  sidecarInstanceId: ServerUuidV4,
  expiresAt: ServerIsoUtc,
  publicManifest: ServerPublicManifest,
})

const ServerContextUserMessage = z.object({
  type: z.literal('user_message'),
  content: z.string(),
  attachments: z.array(ServerAttachmentRef).optional(),
  requestId: ServerUuidV4.optional(),
  contextTicket: z.object({
    ticketId: z.string(),
    sidecarInstanceId: ServerUuidV4,
  }),
})

const ServerFixture = z.object({
  fixtureVersion: z.literal(1),
  resourceDocument: ServerResourceDocument,
  selection: ServerSelectionV2,
  publicManifest: ServerPublicManifest,
  ticketWire: z.object({
    stageContextRequest: ServerStageContextRequest,
    contextTicket: ServerContextTicket,
    userMessage: ServerContextUserMessage,
  }),
})

// ----- Helpers ----------------------------------------------------------------

let fixtureRaw: unknown
let fixture: z.infer<typeof ServerFixture>

beforeAll(() => {
  fixtureRaw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
  fixture = ServerFixture.parse(fixtureRaw)
})

afterAll(() => {
  fixtureRaw = undefined
  fixture = undefined as never
})

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

interface RevisionMap {
  hosts: Map<string, number>
  concepts: Map<string, number>
  databases: Map<string, number>
  redis: Map<string, number>
}

function buildRevisionMap(doc: z.infer<typeof ServerResourceDocument>): RevisionMap {
  const hosts = new Map<string, number>()
  const concepts = new Map<string, number>()
  const databases = new Map<string, number>()
  const redis = new Map<string, number>()
  for (const h of doc.hosts) hosts.set(h.id, h.revision)
  for (const c of doc.concepts) concepts.set(c.id, c.revision)
  for (const c of doc.dataConnections) {
    if (c.kind === 'database') databases.set(c.id, c.revision)
    else if (c.kind === 'redis') redis.set(c.id, c.revision)
  }
  return { hosts, concepts, databases, redis }
}

function assertRevisionExact(
  refs: ReadonlyArray<{ id: string; revision: number }>,
  entityMap: Map<string, number>,
  label: string,
): void {
  for (const ref of refs) {
    const expected = entityMap.get(ref.id)
    if (expected === undefined) throw new Error(`${label} ref id ${ref.id} must exist`)
    if (ref.revision !== expected) {
      throw new Error(`${label} ref id ${ref.id} revision ${ref.revision} !== entity ${expected}`)
    }
  }
}

describe('canonical Base64 helper', () => {
  const cases: Array<[string, boolean, string]> = [
    ['AAAA', true, 'three zero bytes'],
    ['RkFLRQ==', true, 'decodes to FAKE (fixture ciphertext)'],
    ['A===', false, 'one zero byte requires no padding (canonical uses zero padding for 1-byte remainder → AAAAAA== would be canonical; A=== is invalid)'],
    ['RkFLRQ=', false, 'length must be a multiple of 4'],
  ]
  for (const [input, expected, description] of cases) {
    it(`canonicalBase64(${JSON.stringify(input)}) → ${expected} (${description})`, () => {
      expect(canonicalBase64(input)).toBe(expected)
    })
  }

  it('accepts canonical fixture ciphertext RkFLRQ== via the Zod contract', () => {
    expect(ServerBase64Canonical.safeParse('RkFLRQ==').success).toBe(true)
  })

  it('rejects non-canonical Base64 via the Zod contract', () => {
    expect(ServerBase64Canonical.safeParse('AAAAA').success).toBe(false)
    expect(ServerBase64Canonical.safeParse('A===').success).toBe(false)
    expect(ServerBase64Canonical.safeParse('Zm9v').success).toBe(true) // foo (3 bytes)
  })
})

describe('UUID v4 helper', () => {
  it('accepts a v4 UUID with legal variant', () => {
    expect(ServerUuidV4.safeParse('10000000-0000-4000-8000-000000000001').success).toBe(true)
    expect(ServerUuidV4.safeParse('00000000-0000-4000-8000-000000000000').success).toBe(true)
  })

  it('rejects non-v4 UUIDs even when the variant nibble is legal', () => {
    // v1 UUID: time-based, not v4. Variant '8234' is legal (RFC 4122 §4.1.1
    // variant bits 10xx → nibble in {8,9,a,b}); only the version digit is wrong.
    expect(ServerUuidV4.safeParse('12345678-1234-1234-8234-123456789012').success).toBe(false)
    // v5 UUID: SHA-1 name-based, not v4. Same legal variant nibble.
    expect(ServerUuidV4.safeParse('12345678-1234-5234-8234-123456789012').success).toBe(false)
    // malformed
    expect(ServerUuidV4.safeParse('not-a-uuid').success).toBe(false)
  })
})

describe('M0.3 contract fixture (server)', () => {
  it('accepts the positive fixture through the independent server Zod contract', () => {
    expect(fixture.fixtureVersion).toBe(1)
    expect(fixture.resourceDocument.schemaVersion).toBe(2)
    expect(fixture.selection.schemaVersion).toBe(2)
    expect(fixture.publicManifest.schemaVersion).toBe(2)
    expect(fixture.ticketWire.stageContextRequest.schemaVersion).toBe(1)
  })

  it('covers Host + dependent Concepts + MySQL + PostgreSQL + standalone Redis exactly once each', () => {
    expect(fixture.resourceDocument.hosts).toHaveLength(1)
    expect(fixture.resourceDocument.concepts).toHaveLength(2)
    const concepts = new Set(fixture.resourceDocument.concepts.map((c) => c.id))
    for (const c of fixture.resourceDocument.concepts) {
      for (const dep of c.dependsOnIds) expect(concepts.has(dep)).toBe(true)
    }
    const engines = fixture.resourceDocument.dataConnections
      .filter((c) => c.kind === 'database')
      .map((c) => (c as z.infer<typeof ServerSqlConnection>).engine)
    expect(engines.sort()).toEqual(['mysql', 'postgresql'])
    expect(fixture.resourceDocument.dataConnections.filter((c) => c.kind === 'redis')).toHaveLength(1)
  })

  it('mirrors the four tag namespaces and the selection sourceTags + direct* shape', () => {
    const namespaces = new Set(fixture.resourceDocument.tags.map((t) => t.namespace))
    expect(namespaces).toEqual(new Set(['host', 'concept', 'database', 'redis']))
    expect(fixture.selection.sourceTags).toHaveLength(4)
    expect(fixture.selection.includePasswords).toBe(false)
    expect(fixture.selection.credentialRefs).toHaveLength(0)
    expect(fixture.selection.directConceptIds).toContain('20000000-0000-4000-8000-000000000002')

    const knownIds = new Set<string>([
      ...fixture.resourceDocument.hosts.map((h) => h.id),
      ...fixture.resourceDocument.concepts.map((c) => c.id),
      ...fixture.resourceDocument.dataConnections.map((c) => c.id),
    ])
    for (const ref of fixture.selection.hostRefs) expect(knownIds.has(ref.id)).toBe(true)
    for (const ref of fixture.selection.conceptRootRefs) expect(knownIds.has(ref.id)).toBe(true)
    for (const ref of fixture.selection.dependencyRefs) expect(knownIds.has(ref.id)).toBe(true)
    for (const ref of fixture.selection.databaseRefs) expect(knownIds.has(ref.id)).toBe(true)
    for (const ref of fixture.selection.redisRefs) expect(knownIds.has(ref.id)).toBe(true)
  })

  it('locks the revision of every ref to the entity revision', () => {
    const revMap = buildRevisionMap(fixture.resourceDocument)
    assertRevisionExact(fixture.selection.hostRefs, revMap.hosts, 'hostRefs')
    assertRevisionExact(fixture.selection.conceptRootRefs, revMap.concepts, 'conceptRootRefs')
    assertRevisionExact(fixture.selection.dependencyRefs, revMap.concepts, 'dependencyRefs')
    assertRevisionExact(fixture.selection.databaseRefs, revMap.databases, 'databaseRefs')
    assertRevisionExact(fixture.selection.redisRefs, revMap.redis, 'redisRefs')
  })

  it('asserts the top-level selection is deep-equal to publicManifest.selection', () => {
    expect(fixture.publicManifest.selection).toEqual(fixture.selection)
  })

  it('locks the three publicManifest copies + requestId + binding rules in the ticket wire', () => {
    const top = fixture.publicManifest
    const wireManifest = fixture.ticketWire.stageContextRequest.publicManifest
    const ticketManifest = fixture.ticketWire.contextTicket.publicManifest
    expect(wireManifest).toEqual(top)
    expect(ticketManifest).toEqual(top)
    expect(fixture.ticketWire.stageContextRequest.requestId).toBe(top.requestId)
    expect(fixture.ticketWire.userMessage.requestId).toBe(top.requestId)
    expect(fixture.ticketWire.userMessage.contextTicket.ticketId).toBe(
      fixture.ticketWire.contextTicket.ticketId,
    )
    expect(fixture.ticketWire.userMessage.contextTicket.sidecarInstanceId).toBe(
      fixture.ticketWire.contextTicket.sidecarInstanceId,
    )
    expect(fixture.ticketWire.contextTicket.ticketId).toHaveLength(43)
    expect(fixture.ticketWire.stageContextRequest.contentBinding).toHaveLength(64)
    expect(fixture.ticketWire.stageContextRequest.contextBinding).toHaveLength(64)
    expect(/^[0-9a-f]{64}$/.test(fixture.ticketWire.stageContextRequest.contentBinding)).toBe(true)
    expect(/^[0-9a-f]{64}$/.test(fixture.ticketWire.stageContextRequest.contextBinding)).toBe(true)
  })

  it('refuses a deep-copied positive fixture with port 0', () => {
    const mutated = deepClone(fixtureRaw) as { resourceDocument: { dataConnections: { port: number }[] } }
    mutated.resourceDocument.dataConnections[0]!.port = 0
    const r = ServerResourceDocument.safeParse(mutated.resourceDocument)
    expect(r.success).toBe(false)
  })

  it('refuses a deep-copied positive fixture with port 65536', () => {
    const mutated = deepClone(fixtureRaw) as { resourceDocument: { hosts: { port: number }[] } }
    mutated.resourceDocument.hosts[0]!.port = 65536
    const r = ServerResourceDocument.safeParse(mutated.resourceDocument)
    expect(r.success).toBe(false)
  })

  it('refuses a deep-copied positive fixture with an unknown database engine', () => {
    const mutated = deepClone(fixtureRaw) as { resourceDocument: { dataConnections: { engine?: string }[] } }
    const mysql = mutated.resourceDocument.dataConnections.find(
      (c) => (c as { kind?: string }).kind === 'database' && (c as { engine?: string }).engine === 'mysql',
    ) as { engine?: string }
    mysql.engine = 'sqlite'
    const r = ServerResourceDocument.safeParse(mutated.resourceDocument)
    expect(r.success).toBe(false)
  })

  it('refuses a deep-copied positive fixture with an unknown redis topology', () => {
    const mutated = deepClone(fixtureRaw) as { resourceDocument: { dataConnections: { topology?: string }[] } }
    const redis = mutated.resourceDocument.dataConnections.find(
      (c) => (c as { kind?: string }).kind === 'redis',
    ) as { topology?: string }
    redis.topology = 'cluster'
    const r = ServerResourceDocument.safeParse(mutated.resourceDocument)
    expect(r.success).toBe(false)
  })

  it('refuses a deep-copied positive fixture with duplicate host ids', () => {
    const mutated = deepClone(fixtureRaw) as { resourceDocument: { hosts: unknown[] } }
    mutated.resourceDocument.hosts.push(deepClone(mutated.resourceDocument.hosts[0]))
    const r = ServerResourceDocument.safeParse(mutated.resourceDocument)
    expect(r.success).toBe(false)
  })

  it('refuses a deep-copied positive fixture with a Host missing address', () => {
    const mutated = deepClone(fixtureRaw) as { resourceDocument: { hosts: { address?: string }[] } }
    delete mutated.resourceDocument.hosts[0]!.address
    const r = ServerResourceDocument.safeParse(mutated.resourceDocument)
    expect(r.success).toBe(false)
  })

  it('refuses a deep-copied positive fixture with a Concept missing bodyMarkdown', () => {
    const mutated = deepClone(fixtureRaw) as { resourceDocument: { concepts: { bodyMarkdown?: string }[] } }
    delete mutated.resourceDocument.concepts[0]!.bodyMarkdown
    const r = ServerResourceDocument.safeParse(mutated.resourceDocument)
    expect(r.success).toBe(false)
  })

  it('refuses a deep-copied positive fixture with selection missing includePasswords', () => {
    const mutated = deepClone(fixtureRaw) as { selection: { includePasswords?: boolean } }
    delete mutated.selection.includePasswords
    const r = ServerSelectionV2.safeParse(mutated.selection)
    expect(r.success).toBe(false)
  })

  it('refuses a deep-copied positive fixture with contextTicket missing ticketId', () => {
    const mutated = deepClone(fixtureRaw) as {
      ticketWire: { contextTicket: { ticketId?: string } }
    }
    delete mutated.ticketWire.contextTicket.ticketId
    const r = ServerContextTicket.safeParse(mutated.ticketWire.contextTicket)
    expect(r.success).toBe(false)
  })

  it('throws when a hostRef revision does not match the entity revision (positive control)', () => {
    const v = ServerSelectionV2.parse(deepClone(fixtureRaw).selection)
    const mutated = deepClone(v)
    mutated.hostRefs[0]!.revision = mutated.hostRefs[0]!.revision + 17
    const revMap = buildRevisionMap(fixture.resourceDocument)
    let threw = false
    try {
      assertRevisionExact(mutated.hostRefs, revMap.hosts, 'hostRefs')
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  it('detects a top-level selection copy that diverges from publicManifest.selection', () => {
    const mutated = deepClone(fixture.publicManifest) as {
      selection: { directConceptIds: string[] }
    }
    mutated.selection.directConceptIds.push('60000000-0000-4000-8000-000000000099')
    expect(mutated.selection).not.toEqual(fixture.selection)
  })
})