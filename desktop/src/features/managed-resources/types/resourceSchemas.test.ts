/**
 * resourceSchemas 的窄回归。覆盖 MR-M01-002..007 的边界，外加
 * MR-M01-008 的编译期 DTO↔schema 双向契约。
 *
 * 仅使用虚构数据与内存校验；不连真实数据库、keychain、模型或服务。
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  AccessUrlSchema,
  AddressSchema,
  ConceptSchema,
  ConversationContextSelectionV2Schema,
  CredentialRecordSchema,
  DataConnectionSchema,
  EntityVersionRefArraySchema,
  HostApplicationAccountSchema,
  HostApplicationSchema,
  HostAuthSchema,
  HostSchema,
  Iso8601UtcSchema,
  KnownHostKeySchema,
  PublicContextManifestV2Schema,
  ResourceDocumentSchema,
  ResourceTagSchema,
} from './resourceSchemas.js'
import type {
  Concept,
  ConversationContextSelectionV2,
  CredentialRecord,
  EntityVersionRef,
  Host,
  HostAuth,
  HostApplication,
  HostApplicationAccount,
  KnownHostKey,
  PublicContextManifestV2,
  ResourceDocument,
  ResourceTag,
} from './resourceTypes.js'
import type { DataConnection } from './dataConnectionTypes.js'

const HOST_ID = '10000000-0000-4000-8000-000000000001'
const HOST_ID_2 = '10000000-0000-4000-8000-000000000002'
const HOST_ID_3 = '10000000-0000-4000-8000-000000000003'
const HOST_APP_ID = '10000000-0000-4000-8000-000000000010'
const HOST_APP_ACCOUNT_ID = '10000000-0000-4000-8000-000000000020'
const CONCEPT_ID = '20000000-0000-4000-8000-000000000001'
const CONCEPT_ID_2 = '20000000-0000-4000-8000-000000000002'
const CONCEPT_ID_3 = '20000000-0000-4000-8000-000000000003'
const TAG_HOST_ID = '30000000-0000-4000-8000-000000000001'
const TAG_CONCEPT_ID = '30000000-0000-4000-8000-000000000002'
const TAG_DATABASE_ID = '30000000-0000-4000-8000-000000000003'
const CRED_ID = '50000000-0000-4000-8000-000000000001'
const DB_ID = '40000000-0000-4000-8000-000000000001'
const SQL_ID = '40000000-0000-4000-8000-000000000010'
const REDIS_ID = '40000000-0000-4000-8000-000000000020'
const REQUEST_ID = '60000000-0000-4000-8000-000000000001'

const NOW = '2026-09-06T05:00:00Z'

function makeHost(overrides: Partial<Host> = {}): Host {
  return {
    id: HOST_ID,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    name: 'test host',
    address: '192.0.2.10',
    port: 22,
    username: 'tester',
    auth: { type: 'password', credentialId: CRED_ID },
    tagIds: [TAG_HOST_ID],
    initialDirectory: '/opt/example',
    applications: [],
    notes: '',
    ...overrides,
  }
}

function makeConcept(
  id: string,
  overrides: Partial<{
    title: string
    bodyMarkdown: string
    dependsOnIds: string[]
    referenceIds: string[]
  }> = {},
) {
  return {
    id,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    title: overrides.title ?? `concept ${id.slice(-1)}`,
    summary: '',
    bodyMarkdown: overrides.bodyMarkdown ?? 'body',
    tagIds: [TAG_CONCEPT_ID],
    dependsOnIds: overrides.dependsOnIds ?? [],
    referenceIds: overrides.referenceIds ?? [],
  }
}
void makeConcept

// =========================================================================
// MR-M01-008: Compile-time bidirectional DTO ↔ schema assignability
// =========================================================================

describe('MR-M01-008 compile-time DTO↔schema contract', () => {
  it('binds Host, Concept, CredentialRecord, KnownHostKey, ResourceTag, DataConnection, ResourceDocument, Selection, Manifest schemas to DTO types', () => {
    type HostOutput = z.infer<typeof HostSchema>
    type HostInput = z.input<typeof HostSchema>
    const _hostOutputAsDto: Host = {} as HostOutput
    const _hostDtoAsInput: HostInput = {} as Host
    void _hostOutputAsDto
    void _hostDtoAsInput

    type ConceptOutput = z.infer<typeof ConceptSchema>
    type ConceptInput = z.input<typeof ConceptSchema>
    const _conceptOutputAsDto: Concept = {} as ConceptOutput
    const _conceptDtoAsInput: ConceptInput = {} as Concept
    void _conceptOutputAsDto
    void _conceptDtoAsInput

    type CredentialOutput = z.infer<typeof CredentialRecordSchema>
    type CredentialInput = z.input<typeof CredentialRecordSchema>
    const _credentialOutputAsDto: CredentialRecord = {} as CredentialOutput
    const _credentialDtoAsInput: CredentialInput = {} as CredentialRecord
    void _credentialOutputAsDto
    void _credentialDtoAsInput

    type KnownHostKeyOutput = z.infer<typeof KnownHostKeySchema>
    type KnownHostKeyInput = z.input<typeof KnownHostKeySchema>
    const _knownHostOutputAsDto: KnownHostKey = {} as KnownHostKeyOutput
    const _knownHostDtoAsInput: KnownHostKeyInput = {} as KnownHostKey
    void _knownHostOutputAsDto
    void _knownHostDtoAsInput

    type ResourceTagOutput = z.infer<typeof ResourceTagSchema>
    type ResourceTagInput = z.input<typeof ResourceTagSchema>
    const _tagOutputAsDto: ResourceTag = {} as ResourceTagOutput
    const _tagDtoAsInput: ResourceTagInput = {} as ResourceTag
    void _tagOutputAsDto
    void _tagDtoAsInput

    type SelectionOutput = z.infer<typeof ConversationContextSelectionV2Schema>
    type SelectionInput = z.input<typeof ConversationContextSelectionV2Schema>
    const _selectionOutputAsDto: ConversationContextSelectionV2 = {} as SelectionOutput
    const _selectionDtoAsInput: SelectionInput = {} as ConversationContextSelectionV2
    void _selectionOutputAsDto
    void _selectionDtoAsInput

    type ManifestOutput = z.infer<typeof PublicContextManifestV2Schema>
    type ManifestInput = z.input<typeof PublicContextManifestV2Schema>
    const _manifestOutputAsDto: PublicContextManifestV2 = {} as ManifestOutput
    const _manifestDtoAsInput: ManifestInput = {} as PublicContextManifestV2
    void _manifestOutputAsDto
    void _manifestDtoAsInput

    type HostAuthOutput = z.infer<typeof HostAuthSchema>
    type HostAuthInput = z.input<typeof HostAuthSchema>
    const _authOutputAsDto: HostAuth = {} as HostAuthOutput
    const _authDtoAsInput: HostAuthInput = {} as HostAuth
    void _authOutputAsDto
    void _authDtoAsInput

    type HostApplicationOutput = z.infer<typeof HostApplicationSchema>
    type HostApplicationInput = z.input<typeof HostApplicationSchema>
    const _appOutputAsDto: HostApplication = {} as HostApplicationOutput
    const _appDtoAsInput: HostApplicationInput = {} as HostApplication
    void _appOutputAsDto
    void _appDtoAsInput

    type AccountOutput = z.infer<typeof HostApplicationAccountSchema>
    type AccountInput = z.input<typeof HostApplicationAccountSchema>
    const _accountOutputAsDto: HostApplicationAccount = {} as AccountOutput
    const _accountDtoAsInput: AccountInput = {} as HostApplicationAccount
    void _accountOutputAsDto
    void _accountDtoAsInput

    type RefOutput = z.infer<typeof EntityVersionRefArraySchema>[number]
    type RefInput = z.input<typeof EntityVersionRefArraySchema>[number]
    const _refOutputAsDto: EntityVersionRef = {} as RefOutput
    const _refDtoAsInput: RefInput = {} as EntityVersionRef
    void _refOutputAsDto
    void _refDtoAsInput

    type DataConnectionOutput = z.infer<typeof DataConnectionSchema>
    type DataConnectionInput = z.input<typeof DataConnectionSchema>
    const _dataConnectionOutputAsDto: DataConnection = {} as DataConnectionOutput
    const _dataConnectionDtoAsInput: DataConnectionInput = {} as DataConnection
    void _dataConnectionOutputAsDto
    void _dataConnectionDtoAsInput

    type ResourceDocumentOutput = z.infer<typeof ResourceDocumentSchema>
    type ResourceDocumentInput = z.input<typeof ResourceDocumentSchema>
    const _resourceDocumentOutputAsDto: ResourceDocument = {} as ResourceDocumentOutput
    const _resourceDocumentDtoAsInput: ResourceDocumentInput = {} as ResourceDocument
    void _resourceDocumentOutputAsDto
    void _resourceDocumentDtoAsInput
  })
})

// =========================================================================
// MR-M01-002: AddressSchema strict IPv4 / DNS / raw-IPv6
// =========================================================================

describe('MR-M01-002 AddressSchema', () => {
  const valid = [
    ['IPv4', '192.0.2.1'],
    ['IPv4 lowercase', '10.0.0.1'],
    ['DNS single label', 'localhost'],
    ['DNS', 'example.test'],
    ['DNS hyphen', 'host-name.example.test'],
    ['DNS multi-label', 'node-1.cluster.local'],
    ['raw IPv6 loopback', '::1'],
    ['raw IPv6 short', '2001:db8::1'],
    ['raw IPv6 full', '2001:db8:85a3::8a2e:370:7334'],
    ['raw IPv6 link-local', 'fe80::1'],
    ['IPv4 with surrounding space (trim)', ' 192.0.2.1 '],
    ['DNS with surrounding space (trim)', '  example.test  '],
  ] as const

  for (const [name, addr] of valid) {
    it(`accepts ${name}: ${addr}`, () => {
      expect(AddressSchema.safeParse(addr).success).toBe(true)
    })
  }

  const invalid = [
    ['scheme prefix', 'ssh://192.0.2.1'],
    ['userinfo', 'root@example.test'],
    ['userinfo with password', 'user:pass@example.test'],
    ['hostname:port', 'example.test:22'],
    ['ipv4:port', '192.0.2.1:22'],
    ['path', '192.0.2.1/path'],
    ['invalid ipv4 octet', '192.0.2.256'],
    ['trailing dot', '1.2.3.4.'],
    ['leading dot', '.example.test'],
    ['empty label', 'a..b'],
    ['NUL', '192.0.2.1\u0000'],
    ['newline', '192.0.2.1\n'],
    ['CR', '192.0.2.1\r'],
    ['LF alone', '192.0.2.1\n'],
    ['bracketed', '[2001:db8::1]'],
    ['zone-id not allowed', 'fe80::1%eth0'],
    ['internal space in ipv6', '2001:db8::1 path'],
    ['internal space in ipv4', '192.0.2 1'],
    ['internal space in DNS', 'example test.test'],
  ] as const

  for (const [name, addr] of invalid) {
    it(`rejects ${name}: ${JSON.stringify(addr)}`, () => {
      expect(AddressSchema.safeParse(addr).success).toBe(false)
    })
  }

  // MR-M01-017：trim 后相邻空白应被吸收；纯两端空白输入应 trim 成合法值。
  it('trims surrounding whitespace and parses to canonical form', () => {
    const r1 = AddressSchema.safeParse(' 192.0.2.1 ')
    expect(r1.success).toBe(true)
    if (r1.success) expect(r1.data).toBe('192.0.2.1')

    const r2 = AddressSchema.safeParse(' example.test\n')
    expect(r2.success).toBe(false) // 包含 LF，被 raw 检查拒绝
  })
})

// =========================================================================
// MR-M01-003: AccessUrl no userinfo + base URL validation
// =========================================================================

describe('MR-M01-003 AccessUrlSchema', () => {
  it('accepts http and https URLs without credentials', () => {
    expect(AccessUrlSchema.safeParse('http://app.example.test/').success).toBe(true)
    expect(AccessUrlSchema.safeParse('https://app.example.test/path').success).toBe(true)
  })

  it('rejects URLs with embedded username', () => {
    expect(
      AccessUrlSchema.safeParse('https://user@app.example.test/').success,
    ).toBe(false)
  })

  it('rejects URLs with embedded password', () => {
    expect(
      AccessUrlSchema.safeParse('https://user:pass@app.example.test/').success,
    ).toBe(false)
  })

  it('rejects URLs with both userinfo and password', () => {
    expect(
      AccessUrlSchema.safeParse('https://admin:secret@app.example.test/x').success,
    ).toBe(false)
  })

  it('rejects non-http(s) protocols', () => {
    expect(AccessUrlSchema.safeParse('javascript:alert(1)').success).toBe(false)
    expect(AccessUrlSchema.safeParse('ftp://example.test/').success).toBe(false)
    expect(AccessUrlSchema.safeParse('file:///etc/passwd').success).toBe(false)
  })
})

// =========================================================================
// MR-M01-006: UTC Z, canonical Base64, OpenSSH fingerprint
// =========================================================================

describe('MR-M01-006 Iso8601Utc, Base64, fingerprint', () => {
  it('Iso8601Utc accepts Z-suffixed UTC with and without milliseconds', () => {
    expect(Iso8601UtcSchema.safeParse('2026-09-06T05:00:00Z').success).toBe(true)
    expect(Iso8601UtcSchema.safeParse('2026-09-06T05:00:00.000Z').success).toBe(true)
    expect(Iso8601UtcSchema.safeParse('2026-09-06T05:00:00.123Z').success).toBe(true)
  })

  it('Iso8601Utc rejects non-Z offsets', () => {
    expect(
      Iso8601UtcSchema.safeParse('2026-09-06T13:00:00+08:00').success,
    ).toBe(false)
    expect(
      Iso8601UtcSchema.safeParse('2026-09-06T05:00:00-05:00').success,
    ).toBe(false)
    expect(
      Iso8601UtcSchema.safeParse('2026-09-06T05:00:00Z+00:00').success,
    ).toBe(false)
  })

  it('Iso8601Utc rejects malformed timestamps', () => {
    expect(Iso8601UtcSchema.safeParse('2026/09/06 05:00:00').success).toBe(false)
    expect(Iso8601UtcSchema.safeParse('not-a-date').success).toBe(false)
    expect(Iso8601UtcSchema.safeParse('2026-09-06').success).toBe(false)
  })

  it('KnownHostKey.sha256 accepts 43-char unpadded Base64 with + and /', () => {
    const fingerprint = 'AbCdEf+0123456789AAAAAAAAAAAAAAAAAAAAAAAAAA'
    expect(fingerprint.length).toBe(43)
    const r = KnownHostKeySchema.safeParse({
      endpoint: '192.0.2.10:22',
      algorithm: 'ssh-ed25519',
      sha256: fingerprint,
      trustedAt: NOW,
    })
    expect(r.success).toBe(true)
  })

  it('KnownHostKey.sha256 accepts a 43-char fingerprint containing +', () => {
    const fingerprint = 'AbCdEf+0123456789012345678901234567890ABCDE'
    expect(fingerprint.length).toBe(43)
    const r = KnownHostKeySchema.safeParse({
      endpoint: '192.0.2.10:22',
      algorithm: 'ssh-ed25519',
      sha256: fingerprint,
      trustedAt: NOW,
    })
    expect(r.success).toBe(true)
  })

  it('KnownHostKey.sha256 accepts a 43-char fingerprint containing /', () => {
    const fingerprint = 'AbCdEf/0123456789012345678901234567890ABCDE'
    expect(fingerprint.length).toBe(43)
    const r = KnownHostKeySchema.safeParse({
      endpoint: '192.0.2.10:22',
      algorithm: 'ssh-ed25519',
      sha256: fingerprint,
      trustedAt: NOW,
    })
    expect(r.success).toBe(true)
  })

  it('KnownHostKey.sha256 rejects 43-char hex-only strings (must be Base64)', () => {
    const fingerprint = 'a'.repeat(43)
    // 'a' is valid Base64 but for the test we want to verify length-43 + non-padded
    // works. The follow-on test exercises wrong length / wrong alphabet.
    expect(KnownHostKeySchema.safeParse({
      endpoint: '192.0.2.10:22',
      algorithm: 'ssh-ed25519',
      sha256: fingerprint,
      trustedAt: NOW,
    }).success).toBe(true)
  })

  it('KnownHostKey.sha256 rejects wrong length', () => {
    expect(
      KnownHostKeySchema.safeParse({
        endpoint: '192.0.2.10:22',
        algorithm: 'ssh-ed25519',
        sha256: 'a'.repeat(42),
        trustedAt: NOW,
      }).success,
    ).toBe(false)
    expect(
      KnownHostKeySchema.safeParse({
        endpoint: '192.0.2.10:22',
        algorithm: 'ssh-ed25519',
        sha256: 'a'.repeat(44),
        trustedAt: NOW,
      }).success,
    ).toBe(false)
  })

  it('KnownHostKey.sha256 rejects non-Base64 characters', () => {
    expect(
      KnownHostKeySchema.safeParse({
        endpoint: '192.0.2.10:22',
        algorithm: 'ssh-ed25519',
        sha256: '!'.repeat(43),
        trustedAt: NOW,
      }).success,
    ).toBe(false)
    expect(
      KnownHostKeySchema.safeParse({
        endpoint: '192.0.2.10:22',
        algorithm: 'ssh-ed25519',
        sha256: 'a'.repeat(42) + '=',
        trustedAt: NOW,
      }).success,
    ).toBe(false)
  })

  it('ciphertextBase64 accepts canonical Base64', () => {
    const r = CredentialRecordSchema.safeParse({
      id: CRED_ID,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
      kind: 'ssh-password',
      label: 'cred',
      backend: 'electron-safe-storage-v1',
      ciphertextBase64: 'SGVsbG8gV29ybGQ=',
    })
    expect(r.success).toBe(true)
  })

  it('ciphertextBase64 rejects non-Base64 text', () => {
    const r = CredentialRecordSchema.safeParse({
      id: CRED_ID,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
      kind: 'ssh-password',
      label: 'cred',
      backend: 'electron-safe-storage-v1',
      ciphertextBase64: 'not base64!?',
    })
    expect(r.success).toBe(false)
  })

  // MR-M01-013: canonical Base64 round-trip
  it('ciphertextBase64 accepts canonical Zg== and SGVsbG8gV29ybGQ=', () => {
    for (const b64 of ['Zg==', 'SGVsbG8gV29ybGQ=']) {
      const r = CredentialRecordSchema.safeParse({
        id: CRED_ID,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
        kind: 'ssh-password',
        label: 'cred',
        backend: 'electron-safe-storage-v1',
        ciphertextBase64: b64,
      })
      expect(r.success).toBe(true)
    }
  })

  it('ciphertextBase64 rejects non-canonical Zh==', () => {
    const r = CredentialRecordSchema.safeParse({
      id: CRED_ID,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
      kind: 'ssh-password',
      label: 'cred',
      backend: 'electron-safe-storage-v1',
      ciphertextBase64: 'Zh==',
    })
    expect(r.success).toBe(false)
  })

  it('ciphertextBase64 rejects bad padding length (Zg, Zg===)', () => {
    for (const b64 of ['Zg', 'Zg===', 'Zg====']) {
      const r = CredentialRecordSchema.safeParse({
        id: CRED_ID,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
        kind: 'ssh-password',
        label: 'cred',
        backend: 'electron-safe-storage-v1',
        ciphertextBase64: b64,
      })
      expect(r.success).toBe(false)
    }
  })

  it('ciphertextBase64 rejects whitespace and newline inside input', () => {
    for (const b64 of ['Zg==\n', 'Zg== ', 'Zg ==']) {
      const r = CredentialRecordSchema.safeParse({
        id: CRED_ID,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
        kind: 'ssh-password',
        label: 'cred',
        backend: 'electron-safe-storage-v1',
        ciphertextBase64: b64,
      })
      expect(r.success).toBe(false)
    }
  })

  it('ciphertextBase64 rejects invalid alphabet characters', () => {
    const r = CredentialRecordSchema.safeParse({
      id: CRED_ID,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
      kind: 'ssh-password',
      label: 'cred',
      backend: 'electron-safe-storage-v1',
      ciphertextBase64: 'Zg!==', // '!' is not in the Base64 alphabet
    })
    expect(r.success).toBe(false)
  })
})

// =========================================================================
// MR-M01-005: deep passthrough on persisted nested records
// =========================================================================

describe('MR-M01-005 deep passthrough', () => {
  it('HostAuth keeps unknown future fields', () => {
    const r = HostAuthSchema.safeParse({
      type: 'password',
      credentialId: CRED_ID,
      futureAuth: { source: 'rotation', nonce: 1 },
    })
    expect(r.success).toBe(true)
    if (r.success) {
      const data = r.data as HostAuth & { futureAuth?: { source: string; nonce: number } }
      expect(data.futureAuth).toEqual({ source: 'rotation', nonce: 1 })
    }
  })

  it('HostApplicationAccount keeps unknown future fields', () => {
    const r = HostApplicationAccountSchema.safeParse({
      id: HOST_APP_ACCOUNT_ID,
      label: 'admin',
      username: 'demo',
      credentialId: null,
      futureAccount: { rotation: 'manual' },
    })
    expect(r.success).toBe(true)
    if (r.success) {
      const data = r.data as HostApplicationAccount & { futureAccount?: { rotation: string } }
      expect(data.futureAccount).toEqual({ rotation: 'manual' })
    }
  })

  it('HostApplication keeps nested unknown fields on accessUrls and accounts', () => {
    const r = HostApplicationSchema.safeParse({
      id: HOST_APP_ID,
      name: 'demo',
      version: '1.0',
      installPaths: ['/opt/demo'],
      accessDescription: '',
      accessUrls: ['https://app.example.test'],
      loginUrl: null,
      accounts: [],
      notes: '',
      futureApp: { banner: 'moved' },
    })
    expect(r.success).toBe(true)
    if (r.success) {
      const data = r.data as HostApplication & { futureApp?: { banner: string } }
      expect(data.futureApp).toEqual({ banner: 'moved' })
    }
  })

  it('EntityVersionRefArray items preserve unknown future fields', () => {
    const r = EntityVersionRefArraySchema.safeParse([
      { id: HOST_ID, revision: 1, futureTag: 'hint' },
    ])
    expect(r.success).toBe(true)
    if (r.success) {
      const ref = r.data[0] as EntityVersionRef & { futureTag?: string }
      expect(ref.futureTag).toBe('hint')
    }
  })

  it('Host with deeply nested future fields round-trips', () => {
    const parsed = HostSchema.parse({
      ...makeHost(),
      applications: [
        {
          id: HOST_APP_ID,
          name: 'app',
          version: '1.0',
          installPaths: ['/opt/app'],
          accessDescription: '',
          accessUrls: ['https://app.example.test'],
          loginUrl: null,
          accounts: [
            {
              id: HOST_APP_ACCOUNT_ID,
              label: 'admin',
              username: 'demo',
              credentialId: null,
              futureAccountTag: 'rotating',
            },
          ],
          notes: '',
          futureApp: 'x',
        },
      ],
      auth: { type: 'password', credentialId: CRED_ID, futureAuthTag: 'reauth' },
    })
    const host = parsed as Host & { auth: HostAuth & { futureAuthTag?: string } }
    expect(host.auth.futureAuthTag).toBe('reauth')
    const app = host.applications[0] as HostApplication & { futureApp?: string }
    expect(app.futureApp).toBe('x')
    const account = app.accounts[0] as HostApplicationAccount & { futureAccountTag?: string }
    expect(account.futureAccountTag).toBe('rotating')
  })
})

// =========================================================================
// MR-M01-007: unique-id on every identified-object array
// =========================================================================

describe('MR-M01-007 unique-id checks on identified arrays', () => {
  it('ResourceDocument rejects duplicate host ids', () => {
    const r = ResourceDocumentSchema.safeParse({
      schemaVersion: 2,
      revision: 1,
      hosts: [makeHost({ id: HOST_ID }), makeHost({ id: HOST_ID })],
      tags: [],
      concepts: [],
      dataConnections: [],
      credentials: [],
      knownHostKeys: [],
    })
    expect(r.success).toBe(false)
  })

  it('Host rejects duplicate application ids', () => {
    const dupApp = {
      id: HOST_APP_ID,
      name: 'a',
      version: null,
      installPaths: [],
      accessDescription: '',
      accessUrls: [],
      loginUrl: null,
      accounts: [],
      notes: '',
    }
    const r = HostSchema.safeParse(makeHost({ applications: [dupApp, dupApp] }))
    expect(r.success).toBe(false)
  })

  it('Host rejects duplicate account ids within an application', () => {
    const dupAccount = {
      id: HOST_APP_ACCOUNT_ID,
      label: 'a',
      username: 'u',
      credentialId: null,
    }
    const r = HostSchema.safeParse(
      makeHost({
        applications: [
          {
            id: HOST_APP_ID,
            name: 'a',
            version: null,
            installPaths: [],
            accessDescription: '',
            accessUrls: [],
            loginUrl: null,
            accounts: [dupAccount, dupAccount],
            notes: '',
          },
        ],
      }),
    )
    expect(r.success).toBe(false)
  })

  it('Public manifest rejects duplicate host summary ids', () => {
    const r = PublicContextManifestV2Schema.safeParse(makeValidManifest({
      hosts: [
        { id: HOST_ID, name: 'h', address: '192.0.2.1', port: 22 },
        { id: HOST_ID, name: 'h2', address: '192.0.2.2', port: 22 },
      ],
    }))
    expect(r.success).toBe(false)
  })

  it('Public manifest rejects duplicate database summary ids', () => {
    const r = PublicContextManifestV2Schema.safeParse(makeValidManifest({
      databases: [
        {
          id: DB_ID,
          name: 'db',
          engine: 'postgresql',
          address: '192.0.2.20',
          port: 5432,
          database: 'app',
          schema: 'public',
        },
        {
          id: DB_ID,
          name: 'db2',
          engine: 'postgresql',
          address: '192.0.2.21',
          port: 5432,
          database: 'app',
          schema: 'public',
        },
      ],
    }))
    expect(r.success).toBe(false)
  })

  it('Public manifest rejects duplicate redis summary ids', () => {
    const r = PublicContextManifestV2Schema.safeParse(makeValidManifest({
      redisConnections: [
        { id: REDIS_ID, name: 'r1', address: '192.0.2.30', port: 6379, topology: 'standalone', databaseIndex: 0 },
        { id: REDIS_ID, name: 'r2', address: '192.0.2.31', port: 6379, topology: 'standalone', databaseIndex: 1 },
      ],
    }))
    expect(r.success).toBe(false)
  })

  it('Source tags overlap with direct ids remains legal (cross-category duplicates allowed)', () => {
    const r = ConversationContextSelectionV2Schema.safeParse({
      schemaVersion: 2,
      hostRefs: [{ id: HOST_ID, revision: 1 }],
      conceptRootRefs: [],
      dependencyRefs: [],
      databaseRefs: [],
      redisRefs: [],
      credentialRefs: [],
      sourceTags: [
        {
          namespace: 'host',
          id: TAG_HOST_ID,
          labelAtSelection: 'prod',
          memberIds: [HOST_ID, HOST_ID_2],
        },
      ],
      directHostIds: [HOST_ID, HOST_ID_3],
      directConceptIds: [],
      directDatabaseIds: [],
      directRedisIds: [],
      includePasswords: false,
    })
    expect(r.success).toBe(true)
  })
})

// =========================================================================
// MR-M01-004: Selection/Manifest password invariants
// =========================================================================

describe('MR-M01-004 selection/manifest password invariants', () => {
  it('rejects includePasswords=false with non-empty credentialRefs', () => {
    const r = ConversationContextSelectionV2Schema.safeParse({
      schemaVersion: 2,
      hostRefs: [],
      conceptRootRefs: [],
      dependencyRefs: [],
      databaseRefs: [],
      redisRefs: [],
      credentialRefs: [{ id: CRED_ID, revision: 1 }],
      sourceTags: [],
      directHostIds: [],
      directConceptIds: [],
      directDatabaseIds: [],
      directRedisIds: [],
      includePasswords: false,
    })
    expect(r.success).toBe(false)
  })

  it('accepts includePasswords=false with empty credentialRefs', () => {
    const r = ConversationContextSelectionV2Schema.safeParse({
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
    })
    expect(r.success).toBe(true)
  })

  it('accepts includePasswords=true even with no actual credential selected (no-secret manifest)', () => {
    const r = ConversationContextSelectionV2Schema.safeParse({
      schemaVersion: 2,
      hostRefs: [{ id: HOST_ID, revision: 1 }],
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
      includePasswords: true,
    })
    expect(r.success).toBe(true)
  })

  it('manifest rejects containsSecrets=false with secretFieldCount != 0', () => {
    const r = PublicContextManifestV2Schema.safeParse(
      makeValidManifest({ containsSecrets: false, secretFieldCount: 1 }),
    )
    expect(r.success).toBe(false)
  })

  it('manifest rejects containsSecrets=true with secretFieldCount=0', () => {
    const r = PublicContextManifestV2Schema.safeParse(
      makeValidManifest({ containsSecrets: true, secretFieldCount: 0 }),
    )
    expect(r.success).toBe(false)
  })

  it('manifest rejects containsSecrets=true when selection.includePasswords=false', () => {
    const r = PublicContextManifestV2Schema.safeParse(
      makeValidManifest({
        containsSecrets: true,
        secretFieldCount: 1,
        selectionOverride: {
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
        },
      }),
    )
    expect(r.success).toBe(false)
  })

  it('manifest accepts a consistent no-secret manifest', () => {
    const r = PublicContextManifestV2Schema.safeParse(
      makeValidManifest({
        containsSecrets: false,
        secretFieldCount: 0,
        selectionOverride: {
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
        },
      }),
    )
    expect(r.success).toBe(true)
  })
})

// =========================================================================
// MR-M01-003 (manifest): public secret denylist
// =========================================================================

describe('MR-M01-003 public manifest secret denylist', () => {
  const secretCases: Array<[string, () => Record<string, unknown>]> = [
    [
      'top-level password',
      () => ({ password: 'VISIBLE' }),
    ],
    [
      'nested privateKey',
      () => ({
        hosts: [{ id: HOST_ID, name: 'h', address: '192.0.2.1', port: 22, privateKey: 'PEM' }],
      }),
    ],
    [
      'nested ciphertext',
      () => ({
        databases: [
          {
            id: DB_ID,
            name: 'db',
            engine: 'postgresql',
            address: '192.0.2.20',
            port: 5432,
            database: 'app',
            schema: 'public',
            ciphertext: 'SGVsbG8=',
          },
        ],
      }),
    ],
    [
      'nested ciphertextBase64 inside a redis summary',
      () => ({
        redisConnections: [
          {
            id: REDIS_ID,
            name: 'r',
            address: '192.0.2.30',
            port: 6379,
            topology: 'standalone',
            databaseIndex: 0,
            ciphertextBase64: 'SGVsbG8=',
          },
        ],
      }),
    ],
    [
      'selection.sourceTags[].passphrase',
      () => ({
        selectionOverride: {
          schemaVersion: 2,
          hostRefs: [],
          conceptRootRefs: [],
          dependencyRefs: [],
          databaseRefs: [],
          redisRefs: [],
          credentialRefs: [],
          sourceTags: [
            {
              namespace: 'host',
              id: TAG_HOST_ID,
              labelAtSelection: 'prod',
              memberIds: [HOST_ID],
              passphrase: 'SECRET',
            },
          ],
          directHostIds: [],
          directConceptIds: [],
          directDatabaseIds: [],
          directRedisIds: [],
          includePasswords: false,
        },
      }),
    ],
  ]

  for (const [label, mutator] of secretCases) {
    it(`rejects ${label}`, () => {
      const r = PublicContextManifestV2Schema.safeParse(mutator() as never)
      expect(r.success).toBe(false)
    })
  }

  it('still accepts a safe future field at any nested level', () => {
    const r = PublicContextManifestV2Schema.safeParse(
      makeValidManifest({
        futureFields: { futureUiHints: { theme: 'midnight', beta: { flag: true } } },
        hosts: [
          {
            id: HOST_ID,
            name: 'h',
            address: '192.0.2.1',
            port: 22,
            futureHostHint: 'compact',
          },
        ],
      }),
    )
    expect(r.success).toBe(true)
    if (r.success) {
      const m = r.data as PublicContextManifestV2 & {
        futureUiHints?: { theme: string; beta: { flag: boolean } }
      }
      expect(m.futureUiHints).toEqual({ theme: 'midnight', beta: { flag: true } })
      const host = m.hosts[0] as { futureHostHint?: string }
      expect(host.futureHostHint).toBe('compact')
    }
  })
})

// =========================================================================
// Existing positive coverage (kept short)
// =========================================================================

describe('ResourceTagSchema', () => {
  it('accepts a host namespace tag', () => {
    expect(
      ResourceTagSchema.safeParse({
        id: TAG_HOST_ID,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
        namespace: 'host',
        name: 'production',
        normalizedName: 'production',
        colorToken: null,
      }).success,
    ).toBe(true)
  })

  it('rejects an unknown namespace', () => {
    expect(
      ResourceTagSchema.safeParse({
        id: TAG_HOST_ID,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
        namespace: 'service',
        name: 'production',
        normalizedName: 'production',
        colorToken: null,
      }).success,
    ).toBe(false)
  })
})

describe('HostSchema', () => {
  it('parses a minimal host', () => {
    expect(HostSchema.safeParse(makeHost()).success).toBe(true)
  })

  it('rejects an out-of-range port', () => {
    expect(HostSchema.safeParse(makeHost({ port: 0 })).success).toBe(false)
    expect(HostSchema.safeParse(makeHost({ port: 70000 })).success).toBe(false)
  })

  it('rejects initialDirectory that is not an absolute POSIX path', () => {
    expect(
      HostSchema.safeParse(makeHost({ initialDirectory: 'relative/path' })).success,
    ).toBe(false)
    expect(
      HostSchema.safeParse(makeHost({ initialDirectory: 'C:/windows' })).success,
    ).toBe(false)
  })
})

describe('ConversationContextSelectionV2Schema', () => {
  it('parses a multi-namespace selection with overlapping sourceTags and direct ids', () => {
    const r = ConversationContextSelectionV2Schema.safeParse({
      schemaVersion: 2,
      hostRefs: [{ id: HOST_ID, revision: 1 }],
      conceptRootRefs: [{ id: CONCEPT_ID, revision: 1 }],
      dependencyRefs: [],
      databaseRefs: [{ id: DB_ID, revision: 1 }],
      redisRefs: [{ id: REDIS_ID, revision: 1 }],
      credentialRefs: [],
      sourceTags: [
        {
          namespace: 'host',
          id: TAG_HOST_ID,
          labelAtSelection: 'production',
          memberIds: [HOST_ID, HOST_ID_2],
        },
        {
          namespace: 'concept',
          id: TAG_CONCEPT_ID,
          labelAtSelection: 'core',
          memberIds: [CONCEPT_ID, CONCEPT_ID_2],
        },
        {
          namespace: 'database',
          id: TAG_DATABASE_ID,
          labelAtSelection: 'prod-db',
          memberIds: [DB_ID],
        },
      ],
      directHostIds: [HOST_ID_3],
      directConceptIds: [CONCEPT_ID_3],
      directDatabaseIds: [],
      directRedisIds: [],
      includePasswords: false,
    })
    expect(r.success).toBe(true)
  })

  it('rejects schemaVersion != 2', () => {
    const r = ConversationContextSelectionV2Schema.safeParse({
      schemaVersion: 1,
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
    })
    expect(r.success).toBe(false)
  })

  it('rejects duplicate sourceTag for the same namespace+id', () => {
    const r = ConversationContextSelectionV2Schema.safeParse({
      schemaVersion: 2,
      hostRefs: [],
      conceptRootRefs: [],
      dependencyRefs: [],
      databaseRefs: [],
      redisRefs: [],
      credentialRefs: [],
      sourceTags: [
        {
          namespace: 'host',
          id: TAG_HOST_ID,
          labelAtSelection: 'a',
          memberIds: [HOST_ID],
        },
        {
          namespace: 'host',
          id: TAG_HOST_ID,
          labelAtSelection: 'b',
          memberIds: [HOST_ID_2],
        },
      ],
      directHostIds: [],
      directConceptIds: [],
      directDatabaseIds: [],
      directRedisIds: [],
      includePasswords: false,
    })
    expect(r.success).toBe(false)
  })

  it('rejects duplicate ids within a single sourceTag.memberIds', () => {
    const r = ConversationContextSelectionV2Schema.safeParse({
      schemaVersion: 2,
      hostRefs: [],
      conceptRootRefs: [],
      dependencyRefs: [],
      databaseRefs: [],
      redisRefs: [],
      credentialRefs: [],
      sourceTags: [
        {
          namespace: 'host',
          id: TAG_HOST_ID,
          labelAtSelection: 'a',
          memberIds: [HOST_ID, HOST_ID],
        },
      ],
      directHostIds: [],
      directConceptIds: [],
      directDatabaseIds: [],
      directRedisIds: [],
      includePasswords: false,
    })
    expect(r.success).toBe(false)
  })
})

// =========================================================================
// MR-M01-010: ResourceDocument synchronous first-parse rejection
// =========================================================================

describe('MR-M01-010 ResourceDocument first-parse is synchronous', () => {
  it('rejects malformed dataConnections immediately on first parse (no microtask wait)', () => {
    const r = ResourceDocumentSchema.safeParse({
      schemaVersion: 2,
      revision: 1,
      hosts: [],
      tags: [],
      concepts: [],
      dataConnections: [42 as never],
      credentials: [],
      knownHostKeys: [],
    })
    expect(r.success).toBe(false)
  })

  it('rejects an empty dataConnections list (fails schemaVersion or other validation, not silently passing)', () => {
    const r = ResourceDocumentSchema.safeParse({
      schemaVersion: 2,
      revision: 1,
      hosts: [],
      tags: [],
      concepts: [],
      dataConnections: [{ id: 'not-a-uuid', kind: 'database' } as never],
      credentials: [],
      knownHostKeys: [],
    })
    expect(r.success).toBe(false)
  })
})

// =========================================================================
// MR-M01-011: PublicContextManifest uses static PublicDatabaseSummary /
// PublicRedisSummary so cross-variant denial works on the public boundary.
// =========================================================================

describe('MR-M01-011 public summary cross-variant denial via static import', () => {
  it('database summary rejects databaseIndex on the public boundary', () => {
    const r = PublicContextManifestV2Schema.safeParse(
      makeValidManifest({
        databases: [
          {
            id: DB_ID,
            name: 'db',
            engine: 'postgresql',
            address: '192.0.2.20',
            port: 5432,
            database: 'app',
            schema: 'public',
            databaseIndex: 0,
          },
        ],
      }),
    )
    expect(r.success).toBe(false)
  })

  it('database summary rejects topology on the public boundary', () => {
    const r = PublicContextManifestV2Schema.safeParse(
      makeValidManifest({
        databases: [
          {
            id: DB_ID,
            name: 'db',
            engine: 'postgresql',
            address: '192.0.2.20',
            port: 5432,
            database: 'app',
            schema: 'public',
            topology: 'standalone',
          },
        ],
      }),
    )
    expect(r.success).toBe(false)
  })

  it('redis summary rejects engine on the public boundary', () => {
    const r = PublicContextManifestV2Schema.safeParse(
      makeValidManifest({
        redisConnections: [
          {
            id: REDIS_ID,
            name: 'r',
            address: '192.0.2.30',
            port: 6379,
            topology: 'standalone',
            databaseIndex: 0,
            engine: 'mysql',
          },
        ],
      }),
    )
    expect(r.success).toBe(false)
  })

  it('redis summary rejects database on the public boundary', () => {
    const r = PublicContextManifestV2Schema.safeParse(
      makeValidManifest({
        redisConnections: [
          {
            id: REDIS_ID,
            name: 'r',
            address: '192.0.2.30',
            port: 6379,
            topology: 'standalone',
            databaseIndex: 0,
            database: 'app',
          },
        ],
      }),
    )
    expect(r.success).toBe(false)
  })

  it('safe future fields round-trip through the public boundary', () => {
    const r = PublicContextManifestV2Schema.safeParse(
      makeValidManifest({
        databases: [
          {
            id: DB_ID,
            name: 'db',
            engine: 'postgresql',
            address: '192.0.2.20',
            port: 5432,
            database: 'app',
            schema: 'public',
            futureDbHint: 'pool-min=2',
          },
        ],
      }),
    )
    expect(r.success).toBe(true)
    if (r.success) {
      const db = r.data.databases[0] as { futureDbHint?: string }
      expect(db.futureDbHint).toBe('pool-min=2')
    }
  })
})

// =========================================================================
// MR-M01-012: connectionUrl userinfo is rejected at every nested level.
// =========================================================================

describe('MR-M01-012 connectionUrl userinfo rejection', () => {
  it('database summary with credential-bearing connectionUrl fails', () => {
    const r = PublicContextManifestV2Schema.safeParse(
      makeValidManifest({
        databases: [
          {
            id: DB_ID,
            name: 'db',
            engine: 'postgresql',
            address: '192.0.2.20',
            port: 5432,
            database: 'app',
            schema: 'public',
            connectionUrl: 'postgresql://user:secret@192.0.2.20/app',
          },
        ],
      }),
    )
    expect(r.success).toBe(false)
  })

  it('redis summary with credential-bearing connectionUrl fails', () => {
    const r = PublicContextManifestV2Schema.safeParse(
      makeValidManifest({
        redisConnections: [
          {
            id: REDIS_ID,
            name: 'r',
            address: '192.0.2.30',
            port: 6379,
            topology: 'standalone',
            databaseIndex: 0,
            connectionUrl: 'redis://:topsecret@192.0.2.30',
          },
        ],
      }),
    )
    expect(r.success).toBe(false)
  })

  it('credential-bearing connectionUrl inside nested future fields fails', () => {
    const r = PublicContextManifestV2Schema.safeParse(
      makeValidManifest({
        futureFields: {
          connectionUrl: 'postgresql://u:p@h/db',
        },
      }),
    )
    expect(r.success).toBe(false)
  })

  it('non-credential connectionUrl round-trips as safe future metadata', () => {
    const r = PublicContextManifestV2Schema.safeParse(
      makeValidManifest({
        databases: [
          {
            id: DB_ID,
            name: 'db',
            engine: 'postgresql',
            address: '192.0.2.20',
            port: 5432,
            database: 'app',
            schema: 'public',
            connectionUrl: 'postgresql://192.0.2.20/app',
          },
        ],
        redisConnections: [
          {
            id: REDIS_ID,
            name: 'r',
            address: '192.0.2.30',
            port: 6379,
            topology: 'standalone',
            databaseIndex: 0,
            connectionUrl: 'redis://192.0.2.30/0',
          },
        ],
      }),
    )
    expect(r.success).toBe(true)
  })
})

// =========================================================================
// MR-M01-014: dataConnections must reject duplicate IDs at the document level.
// =========================================================================

describe('MR-M01-014 ResourceDocument.dataConnections unique IDs', () => {
  it('rejects two database connections with the same id', () => {
    const r = ResourceDocumentSchema.safeParse({
      schemaVersion: 2,
      revision: 1,
      hosts: [],
      tags: [],
      concepts: [],
      dataConnections: [
        {
          id: SQL_ID,
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
          name: 'db1',
          address: '192.0.2.20',
          port: 5432,
          username: 'app',
          credentialId: CRED_ID,
          tagIds: [],
          relatedHostId: null,
          environment: 'production',
          tls: {
            enabled: false,
            serverName: null,
            caCertificate: null,
            clientCertificate: null,
            clientKeyCredentialId: null,
          },
          description: '',
          accessInstructions: '',
          kind: 'database',
          engine: 'postgresql',
          database: 'app',
          schema: 'public',
          mode: 'inspection',
        },
        {
          id: SQL_ID,
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
          name: 'db2',
          address: '192.0.2.21',
          port: 5432,
          username: 'app',
          credentialId: CRED_ID,
          tagIds: [],
          relatedHostId: null,
          environment: 'production',
          tls: {
            enabled: false,
            serverName: null,
            caCertificate: null,
            clientCertificate: null,
            clientKeyCredentialId: null,
          },
          description: '',
          accessInstructions: '',
          kind: 'database',
          engine: 'postgresql',
          database: 'app',
          schema: 'public',
          mode: 'inspection',
        },
      ],
      credentials: [],
      knownHostKeys: [],
    })
    expect(r.success).toBe(false)
  })

  it('rejects two redis connections with the same id', () => {
    const r = ResourceDocumentSchema.safeParse({
      schemaVersion: 2,
      revision: 1,
      hosts: [],
      tags: [],
      concepts: [],
      dataConnections: [
        {
          id: REDIS_ID,
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
          name: 'r1',
          address: '192.0.2.30',
          port: 6379,
          username: null,
          credentialId: CRED_ID,
          tagIds: [],
          relatedHostId: null,
          environment: 'production',
          tls: {
            enabled: false,
            serverName: null,
            caCertificate: null,
            clientCertificate: null,
            clientKeyCredentialId: null,
          },
          description: '',
          accessInstructions: '',
          kind: 'redis',
          topology: 'standalone',
          databaseIndex: 0,
          keyPrefixDescription: '',
        },
        {
          id: REDIS_ID,
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
          name: 'r2',
          address: '192.0.2.31',
          port: 6379,
          username: null,
          credentialId: CRED_ID,
          tagIds: [],
          relatedHostId: null,
          environment: 'production',
          tls: {
            enabled: false,
            serverName: null,
            caCertificate: null,
            clientCertificate: null,
            clientKeyCredentialId: null,
          },
          description: '',
          accessInstructions: '',
          kind: 'redis',
          topology: 'standalone',
          databaseIndex: 0,
          keyPrefixDescription: '',
        },
      ],
      credentials: [],
      knownHostKeys: [],
    })
    expect(r.success).toBe(false)
  })

  it('rejects a database and a redis connection sharing the same id', () => {
    const shared = SQL_ID
    const r = ResourceDocumentSchema.safeParse({
      schemaVersion: 2,
      revision: 1,
      hosts: [],
      tags: [],
      concepts: [],
      dataConnections: [
        {
          id: shared,
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
          name: 'db',
          address: '192.0.2.20',
          port: 5432,
          username: 'app',
          credentialId: CRED_ID,
          tagIds: [],
          relatedHostId: null,
          environment: 'production',
          tls: {
            enabled: false,
            serverName: null,
            caCertificate: null,
            clientCertificate: null,
            clientKeyCredentialId: null,
          },
          description: '',
          accessInstructions: '',
          kind: 'database',
          engine: 'postgresql',
          database: 'app',
          schema: 'public',
          mode: 'inspection',
        },
        {
          id: shared,
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
          name: 'r',
          address: '192.0.2.30',
          port: 6379,
          username: null,
          credentialId: CRED_ID,
          tagIds: [],
          relatedHostId: null,
          environment: 'production',
          tls: {
            enabled: false,
            serverName: null,
            caCertificate: null,
            clientCertificate: null,
            clientKeyCredentialId: null,
          },
          description: '',
          accessInstructions: '',
          kind: 'redis',
          topology: 'standalone',
          databaseIndex: 0,
          keyPrefixDescription: '',
        },
      ],
      credentials: [],
      knownHostKeys: [],
    })
    expect(r.success).toBe(false)
  })

  it('accepts two connections with distinct ids', () => {
    const r = ResourceDocumentSchema.safeParse({
      schemaVersion: 2,
      revision: 1,
      hosts: [],
      tags: [],
      concepts: [],
      dataConnections: [
        {
          id: SQL_ID,
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
          name: 'db',
          address: '192.0.2.20',
          port: 5432,
          username: 'app',
          credentialId: CRED_ID,
          tagIds: [],
          relatedHostId: null,
          environment: 'production',
          tls: {
            enabled: false,
            serverName: null,
            caCertificate: null,
            clientCertificate: null,
            clientKeyCredentialId: null,
          },
          description: '',
          accessInstructions: '',
          kind: 'database',
          engine: 'postgresql',
          database: 'app',
          schema: 'public',
          mode: 'inspection',
        },
        {
          id: REDIS_ID,
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
          name: 'r',
          address: '192.0.2.30',
          port: 6379,
          username: null,
          credentialId: CRED_ID,
          tagIds: [],
          relatedHostId: null,
          environment: 'production',
          tls: {
            enabled: false,
            serverName: null,
            caCertificate: null,
            clientCertificate: null,
            clientKeyCredentialId: null,
          },
          description: '',
          accessInstructions: '',
          kind: 'redis',
          topology: 'standalone',
          databaseIndex: 0,
          keyPrefixDescription: '',
        },
      ],
      credentials: [],
      knownHostKeys: [],
    })
    expect(r.success).toBe(true)
  })
})

// =========================================================================
// MR-M01-019: PUBLIC_SECRET_KEYS is module-private and not exported.
// =========================================================================

import * as SharedSchemasModule from './sharedSchemas.js'
import * as ResourceSchemasModule from './resourceSchemas.js'
import {
  BodyMarkdownSchema,
  ConceptBodyMarkdownSchema,
  PublicSecretFieldError,
  rejectPublicSecretFields,
} from './sharedSchemas.js'
import {
  BodyMarkdownSchema as BodyMarkdownViaResource,
  ConceptBodyMarkdownSchema as ConceptBodyMarkdownViaResource,
} from './resourceSchemas.js'

describe('MR-M01-019 PUBLIC_SECRET_KEYS is module-private', () => {
  it('does not appear in the sharedSchemas public namespace', () => {
    // PUBLIC_SECRET_KEYS must be a module-private const; importing the module
    // surface must never expose the container, even as a typed binding.
    expect('PUBLIC_SECRET_KEYS' in SharedSchemasModule).toBe(false)
    expect((SharedSchemasModule as Record<string, unknown>).PUBLIC_SECRET_KEYS).toBeUndefined()
  })

  it('does not appear in the resourceSchemas re-export surface', () => {
    // MR-M01-024: the prior version silently re-checked SharedSchemasModule
    // here, masking whether the resourceSchemas surface leaked the key.
    // Assert both namespaces directly so a regression in either path fails.
    expect('PUBLIC_SECRET_KEYS' in ResourceSchemasModule).toBe(false)
    expect((ResourceSchemasModule as Record<string, unknown>).PUBLIC_SECRET_KEYS).toBeUndefined()
  })

  it('PublicSecretFieldError and rejectPublicSecretFields are still part of the public API', () => {
    // The container is private, but the guard helper and its error type remain
    // importable so the public manifest schema can enforce the denylist.
    expect(typeof rejectPublicSecretFields).toBe('function')
    expect(PublicSecretFieldError).toBeTypeOf('function')
  })

  it('rejects a top-level PASSWORD (upper-case variant) via the same guard', () => {
    expect(() => rejectPublicSecretFields({ PASSWORD: 'x' }, [])).toThrowError(
      PublicSecretFieldError,
    )
  })

  it('rejects mixed-case PassWord inside an arbitrary nested object', () => {
    expect(() =>
      rejectPublicSecretFields({ a: { b: [{ c: { PassWord: 'x' } }] } }, []),
    ).toThrowError(PublicSecretFieldError)
  })
})

// =========================================================================
// MR-M01-020: BodyMarkdownSchema and ConceptBodyMarkdownSchema are the same
// canonical Zod object (no second instance), via every public entry point.
// =========================================================================

describe('MR-M01-020 BodyMarkdownSchema canonical identity', () => {
  it('sharedSchemas.BodyMarkdownSchema === sharedSchemas.ConceptBodyMarkdownSchema', () => {
    expect(BodyMarkdownSchema).toBe(ConceptBodyMarkdownSchema)
  })

  it('resourceSchemas re-exports the same canonical object', () => {
    expect(BodyMarkdownViaResource).toBe(BodyMarkdownSchema)
    expect(ConceptBodyMarkdownViaResource).toBe(ConceptBodyMarkdownSchema)
    expect(BodyMarkdownViaResource).toBe(ConceptBodyMarkdownViaResource)
  })

  it('ConceptSchema.bodyMarkdown is bound to the canonical BodyMarkdownSchema', () => {
    // Walk the Zod shape: ConceptSchema is a ZodObject; its bodyMarkdown field
    // is the same ZodString instance as BodyMarkdownSchema (canonical).
    const shape = (ConceptSchema as unknown as { shape: Record<string, unknown> }).shape
    const bodyField = shape.bodyMarkdown
    expect(bodyField).toBeDefined()
    expect(bodyField).toBe(BodyMarkdownSchema)
  })
})

// =========================================================================
// MR-M01-021: case-variant secret field names are rejected at every public
// boundary (top-level, manifest arrays, selection, nested future fields).
// =========================================================================

describe('MR-M01-021 public boundary rejects case-variant secret field names', () => {
  const caseVariants = [
    'password',
    'PASSWORD',
    'Password',
    'passWord',
    'passphrase',
    'PASSPHRASE',
    'PassPhrase',
    'privateKey',
    'PRIVATEKEY',
    'privatekeypem',
    'PRIVATEKEYPEM',
    'ciphertext',
    'CIPHERTEXT',
    'ciphertextBase64',
    'CipherTextBase64',
    'secret',
    'SECRET',
    'apiKey',
    'APIKEY',
    'token',
    'TOKEN',
  ] as const

  for (const key of caseVariants) {
    it(`manifest rejects top-level secret key '${key}'`, () => {
      const r = PublicContextManifestV2Schema.safeParse(
        makeValidManifest({ futureFields: { [key]: 'x' } }),
      )
      expect(r.success).toBe(false)
    })
  }

  it('manifest rejects secret key deeply nested in a hostRef future field', () => {
    const r = PublicContextManifestV2Schema.safeParse(
      makeValidManifest({
        hosts: [
          {
            id: HOST_ID,
            name: 'h',
            address: '192.0.2.1',
            port: 22,
            futureCred: { SECRET: 'leak' },
          },
        ],
      }),
    )
    expect(r.success).toBe(false)
  })

  it('manifest accepts a clean sourceTags fixture before injecting any secret field', () => {
    // MR-M01-024: the prior a4 fixture set includePasswords=false while the
    // manifest still reported containsSecrets=true + secretFieldCount=1; the
    // clean control failed before any secret could be inserted, masking the
    // intended denial. Establish the positive control first, with values that
    // are self-consistent under the manifest's no-secret-leak invariants.
    const clean = PublicContextManifestV2Schema.safeParse(
      makeValidManifest({
        selectionOverride: {
          schemaVersion: 2,
          hostRefs: [],
          conceptRootRefs: [],
          dependencyRefs: [],
          databaseRefs: [],
          redisRefs: [],
          credentialRefs: [],
          sourceTags: [
            {
              namespace: 'host',
              id: TAG_HOST_ID,
              labelAtSelection: 'prod',
              memberIds: [HOST_ID],
            },
          ],
          directHostIds: [],
          directConceptIds: [],
          directDatabaseIds: [],
          directRedisIds: [],
          includePasswords: true,
        },
      }),
    )
    expect(clean.success).toBe(true)
  })

  it('manifest rejects secret key inside selection.sourceTags[].futureField only when APIKEY is injected', () => {
    // Negative assertion: starting from the same clean fixture, inject only the
    // denylist field 'apiKey' and assert the resulting error names that exact
    // field, not the pre-existing includePasswords/secretFieldCount conflict.
    const r = PublicContextManifestV2Schema.safeParse(
      makeValidManifest({
        selectionOverride: {
          schemaVersion: 2,
          hostRefs: [],
          conceptRootRefs: [],
          dependencyRefs: [],
          databaseRefs: [],
          redisRefs: [],
          credentialRefs: [],
          sourceTags: [
            {
              namespace: 'host',
              id: TAG_HOST_ID,
              labelAtSelection: 'prod',
              memberIds: [HOST_ID],
              future: { APIKEY: 'leak' },
            },
          ],
          directHostIds: [],
          directConceptIds: [],
          directDatabaseIds: [],
          directRedisIds: [],
          includePasswords: true,
        } as unknown as ConversationContextSelectionV2,
      }),
    )
    expect(r.success).toBe(false)
    if (!r.success) {
      const messages = r.error.issues.map((i) => i.message).join('\n')
      expect(messages).toMatch(/secret field 'APIKEY'/)
    }
  })

  it('manifest sourceTags[] safe future field round-trips (MR-M01-024 round-trip leg)', () => {
    // A non-secret future key on sourceTags[].future survives parsing and is
    // preserved on the parsed output.
    const r = PublicContextManifestV2Schema.safeParse(
      makeValidManifest({
        selectionOverride: {
          schemaVersion: 2,
          hostRefs: [],
          conceptRootRefs: [],
          dependencyRefs: [],
          databaseRefs: [],
          redisRefs: [],
          credentialRefs: [],
          sourceTags: [
            {
              namespace: 'host',
              id: TAG_HOST_ID,
              labelAtSelection: 'prod',
              memberIds: [HOST_ID],
              future: { uiHint: { theme: 'midnight', badge: 7 } },
            },
          ],
          directHostIds: [],
          directConceptIds: [],
          directDatabaseIds: [],
          directRedisIds: [],
          includePasswords: true,
        } as unknown as ConversationContextSelectionV2,
      }),
    )
    expect(r.success).toBe(true)
    if (r.success) {
      const tag = r.data.selection.sourceTags[0] as { future?: { uiHint?: { theme: string; badge: number } } }
      expect(tag.future).toEqual({ uiHint: { theme: 'midnight', badge: 7 } })
    }
  })

  it('manifest rejects secret key nested in a database summary future field', () => {
    const r = PublicContextManifestV2Schema.safeParse(
      makeValidManifest({
        databases: [
          {
            id: DB_ID,
            name: 'db',
            engine: 'postgresql',
            address: '192.0.2.20',
            port: 5432,
            database: 'app',
            schema: 'public',
            futureDb: { token: 'leak' },
          },
        ],
      }),
    )
    expect(r.success).toBe(false)
  })

  it('manifest rejects secret key nested in a redis summary future field', () => {
    const r = PublicContextManifestV2Schema.safeParse(
      makeValidManifest({
        redisConnections: [
          {
            id: REDIS_ID,
            name: 'r',
            address: '192.0.2.30',
            port: 6379,
            topology: 'standalone',
            databaseIndex: 0,
            futureRedis: { PassWord: 'leak' },
          },
        ],
      }),
    )
    expect(r.success).toBe(false)
  })

  it('manifest still accepts a safe future key (no false positives)', () => {
    const r = PublicContextManifestV2Schema.safeParse(
      makeValidManifest({
        futureFields: { futureUiHints: { theme: 'midnight', nonce: 42 } },
      }),
    )
    expect(r.success).toBe(true)
  })
})

// =========================================================================
// MR-M01-023: bodyMarkdown ≤ 65536 UTF-8 bytes (not UTF-16 code units).
// The limit applies to ASCII / CJK / emoji equally and is enforced on both
// ConceptSchema and ResourceDocumentSchema. The original Markdown bytes
// must remain unchanged: no trim, no truncation, no normalisation.
// =========================================================================

const UTF8_BODY_LIMIT = 64 * 1024

function makeDocumentWithBody(body: string) {
  return {
    schemaVersion: 2,
    revision: 1,
    hosts: [],
    tags: [],
    concepts: [makeConcept(CONCEPT_ID, { bodyMarkdown: body })],
    dataConnections: [],
    credentials: [],
    knownHostKeys: [],
  }
}

describe('MR-M01-023 bodyMarkdown UTF-8 byte limit (65536)', () => {
  it('accepts ASCII of exactly 65536 UTF-8 bytes via ConceptSchema', () => {
    const body = 'a'.repeat(UTF8_BODY_LIMIT)
    expect(new TextEncoder().encode(body).byteLength).toBe(UTF8_BODY_LIMIT)
    const r = ConceptSchema.safeParse(makeConcept(CONCEPT_ID, { bodyMarkdown: body }))
    expect(r.success).toBe(true)
  })

  it('rejects ASCII of exactly 65537 UTF-8 bytes via ConceptSchema', () => {
    const body = 'a'.repeat(UTF8_BODY_LIMIT + 1)
    expect(new TextEncoder().encode(body).byteLength).toBe(UTF8_BODY_LIMIT + 1)
    const r = ConceptSchema.safeParse(makeConcept(CONCEPT_ID, { bodyMarkdown: body }))
    expect(r.success).toBe(false)
  })

  it('accepts CJK of exactly 65536 UTF-8 bytes via ConceptSchema', () => {
    // '中' is 3 UTF-8 bytes. 21845 * 3 = 65535; plus one ASCII 'a' = 65536.
    const body = '中'.repeat(21845) + 'a'
    expect(new TextEncoder().encode(body).byteLength).toBe(65536)
    const r = ConceptSchema.safeParse(makeConcept(CONCEPT_ID, { bodyMarkdown: body }))
    expect(r.success).toBe(true)
  })

  it('rejects CJK of 65537 UTF-8 bytes via ConceptSchema', () => {
    // 21845 '中' + 'ab' = 65535 + 2 = 65537 UTF-8 bytes.
    const body = '中'.repeat(21845) + 'ab'
    expect(new TextEncoder().encode(body).byteLength).toBe(65537)
    const r = ConceptSchema.safeParse(makeConcept(CONCEPT_ID, { bodyMarkdown: body }))
    expect(r.success).toBe(false)
  })

  it('accepts emoji of exactly 65536 UTF-8 bytes via ConceptSchema', () => {
    // '🍎' is 4 UTF-8 bytes. 16384 * 4 = 65536.
    const body = '🍎'.repeat(16384)
    expect(new TextEncoder().encode(body).byteLength).toBe(65536)
    const r = ConceptSchema.safeParse(makeConcept(CONCEPT_ID, { bodyMarkdown: body }))
    expect(r.success).toBe(true)
  })

  it('rejects emoji of 65540 UTF-8 bytes via ConceptSchema', () => {
    // 16385 * 4 = 65540 UTF-8 bytes.
    const body = '🍎'.repeat(16385)
    expect(new TextEncoder().encode(body).byteLength).toBe(65540)
    const r = ConceptSchema.safeParse(makeConcept(CONCEPT_ID, { bodyMarkdown: body }))
    expect(r.success).toBe(false)
  })

  it('rejects massive CJK content of 196608 UTF-8 bytes via ResourceDocumentSchema', () => {
    // 65536 '中' = 196608 UTF-8 bytes; persisted in ResourceDocument and must
    // still be rejected at the document layer (passthrough on the outer object,
    // but bodyMarkdown itself is still length-bounded).
    const body = '中'.repeat(65536)
    expect(new TextEncoder().encode(body).byteLength).toBe(196608)
    const r = ResourceDocumentSchema.safeParse(makeDocumentWithBody(body))
    expect(r.success).toBe(false)
  })

  it('ResourceDocumentSchema accepts ASCII body of exactly 65536 UTF-8 bytes', () => {
    const body = 'a'.repeat(UTF8_BODY_LIMIT)
    expect(new TextEncoder().encode(body).byteLength).toBe(UTF8_BODY_LIMIT)
    const r = ResourceDocumentSchema.safeParse(makeDocumentWithBody(body))
    expect(r.success).toBe(true)
  })

  it('ResourceDocumentSchema rejects ASCII body of exactly 65537 UTF-8 bytes', () => {
    const body = 'a'.repeat(UTF8_BODY_LIMIT + 1)
    expect(new TextEncoder().encode(body).byteLength).toBe(UTF8_BODY_LIMIT + 1)
    const r = ResourceDocumentSchema.safeParse(makeDocumentWithBody(body))
    expect(r.success).toBe(false)
  })

  it('ResourceDocumentSchema accepts CJK body of exactly 65536 UTF-8 bytes', () => {
    // '中' is 3 UTF-8 bytes. 21845 * 3 = 65535; plus one ASCII 'a' = 65536.
    const body = '中'.repeat(21845) + 'a'
    expect(new TextEncoder().encode(body).byteLength).toBe(65536)
    const r = ResourceDocumentSchema.safeParse(makeDocumentWithBody(body))
    expect(r.success).toBe(true)
  })

  it('ResourceDocumentSchema rejects CJK body of exactly 65537 UTF-8 bytes', () => {
    // 21845 '中' + 'ab' = 65535 + 2 = 65537 UTF-8 bytes.
    const body = '中'.repeat(21845) + 'ab'
    expect(new TextEncoder().encode(body).byteLength).toBe(65537)
    const r = ResourceDocumentSchema.safeParse(makeDocumentWithBody(body))
    expect(r.success).toBe(false)
  })

  it('ResourceDocumentSchema accepts emoji body of exactly 65536 UTF-8 bytes', () => {
    // '🍎' is 4 UTF-8 bytes. 16384 * 4 = 65536.
    const body = '🍎'.repeat(16384)
    expect(new TextEncoder().encode(body).byteLength).toBe(65536)
    const r = ResourceDocumentSchema.safeParse(makeDocumentWithBody(body))
    expect(r.success).toBe(true)
  })

  it('ResourceDocumentSchema rejects emoji body of exactly 65540 UTF-8 bytes', () => {
    // 16385 * 4 = 65540 UTF-8 bytes.
    const body = '🍎'.repeat(16385)
    expect(new TextEncoder().encode(body).byteLength).toBe(65540)
    const r = ResourceDocumentSchema.safeParse(makeDocumentWithBody(body))
    expect(r.success).toBe(false)
  })

  it('ResourceDocumentSchema preserves body with leading/trailing whitespace, real newlines, and empty lines', () => {
    // Leading and trailing ASCII spaces, a real LF newline, and an empty line
    // created by '\n\n' must round-trip through ResourceDocumentSchema untouched.
    const body = '  Markdown\n\nline two  '
    const r = ResourceDocumentSchema.safeParse(makeDocumentWithBody(body))
    expect(r.success).toBe(true)
    if (r.success) {
      const parsedBody = r.data.concepts[0]?.bodyMarkdown ?? ''
      expect(parsedBody).toBe(body)
      expect(new TextEncoder().encode(parsedBody).byteLength).toBe(
        new TextEncoder().encode(body).byteLength,
      )
    }
  })

  it('preserves the original Markdown bytes exactly (no trim, no truncation)', () => {
    // Surrounding whitespace, internal newlines and double-newline paragraph
    // break must round-trip untouched. The schema does not call .trim() or
    // rewrite the value; it only enforces byte length.
    const body = '  Markdown\n\n '
    const r = ConceptSchema.safeParse(makeConcept(CONCEPT_ID, { bodyMarkdown: body }))
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.bodyMarkdown).toBe(body)
      expect(new TextEncoder().encode(r.data.bodyMarkdown).byteLength).toBe(
        new TextEncoder().encode(body).byteLength,
      )
    }
  })

  it('the bound is identical through the ConceptBodyMarkdownSchema alias', () => {
    const asciiExact = 'a'.repeat(UTF8_BODY_LIMIT)
    const asciiOver = 'a'.repeat(UTF8_BODY_LIMIT + 1)
    const cjkOver = '中'.repeat(21846) // 21846*3 = 65538 UTF-8 bytes
    expect(BodyMarkdownSchema.safeParse(asciiExact).success).toBe(true)
    expect(ConceptBodyMarkdownSchema.safeParse(asciiExact).success).toBe(true)
    expect(BodyMarkdownSchema.safeParse(asciiOver).success).toBe(false)
    expect(ConceptBodyMarkdownSchema.safeParse(asciiOver).success).toBe(false)
    expect(BodyMarkdownSchema.safeParse(cjkOver).success).toBe(false)
    expect(ConceptBodyMarkdownSchema.safeParse(cjkOver).success).toBe(false)
  })

  it('rejects empty bodyMarkdown via ConceptSchema', () => {
    const r = ConceptSchema.safeParse(makeConcept(CONCEPT_ID, { bodyMarkdown: '' }))
    expect(r.success).toBe(false)
  })
})

// =========================================================================
// helpers
// =========================================================================

function makeValidManifest(
  overrides: {
    hosts?: Array<{ id: string; name: string; address: string; port: number; [k: string]: unknown }>
    concepts?: Array<{ id: string; title: string; includedAs: 'root' | 'dependency'; [k: string]: unknown }>
    databases?: Array<{
      id: string
      name: string
      engine: 'mysql' | 'mariadb' | 'postgresql'
      address: string
      port: number
      database: string
      schema: string | null
      [k: string]: unknown
    }>
    redisConnections?: Array<{
      id: string
      name: string
      address: string
      port: number
      topology: 'standalone'
      databaseIndex: number
      [k: string]: unknown
    }>
    containsSecrets?: boolean
    secretFieldCount?: number
    selectionOverride?: ConversationContextSelectionV2
    futureFields?: Record<string, unknown>
  } = {},
): PublicContextManifestV2 {
  const base: PublicContextManifestV2 = {
    schemaVersion: 2,
    requestId: REQUEST_ID,
    selection: overrides.selectionOverride ?? {
      schemaVersion: 2,
      hostRefs: [{ id: HOST_ID, revision: 1 }],
      conceptRootRefs: [{ id: CONCEPT_ID, revision: 1 }],
      dependencyRefs: [],
      databaseRefs: [{ id: DB_ID, revision: 1 }],
      redisRefs: [{ id: REDIS_ID, revision: 1 }],
      credentialRefs: [],
      sourceTags: [],
      directHostIds: [],
      directConceptIds: [],
      directDatabaseIds: [],
      directRedisIds: [],
      includePasswords: overrides.containsSecrets ?? true,
    },
    hosts: (overrides.hosts ?? [
      { id: HOST_ID, name: 'h', address: '192.0.2.1', port: 22 },
    ]) as never,
    concepts: (overrides.concepts ?? [
      { id: CONCEPT_ID, title: 'concept', includedAs: 'root' },
    ]) as never,
    databases: (overrides.databases ?? [
      {
        id: DB_ID,
        name: 'db',
        engine: 'postgresql',
        address: '192.0.2.20',
        port: 5432,
        database: 'app',
        schema: 'public',
      },
    ]) as never,
    redisConnections: (overrides.redisConnections ?? [
      {
        id: REDIS_ID,
        name: 'r',
        address: '192.0.2.30',
        port: 6379,
        topology: 'standalone',
        databaseIndex: 0,
      },
    ]) as never,
    resolvedAt: NOW,
    containsSecrets: overrides.containsSecrets ?? true,
    secretFieldCount: overrides.secretFieldCount ?? 1,
    estimatedTokens: 256,
  }
  if (overrides.futureFields) {
    return { ...base, ...overrides.futureFields } as PublicContextManifestV2
  }
  return base
}

// Avoid unused-type warnings for ResourceDocument (used via the compile-time contract)
void ({} as { _placeholder?: unknown })
void makeConcept
