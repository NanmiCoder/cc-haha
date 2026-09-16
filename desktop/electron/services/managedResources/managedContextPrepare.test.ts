import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Buffer } from 'node:buffer'

import { createResourceDocumentStore } from './repositories/resourceDocumentStore.js'
import { createResourceLibraryService } from './repositories/resourceLibraryService.js'
import { prepareManagedContextStageRequest } from './managedContextPrepare.js'
import { createCredentialRecordService } from './vault/credentialRecordService.js'
import { createCredentialVault, type SafeStorageAdapter } from './vault/credentialVault.js'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const REQUEST_ID = '22222222-2222-4222-8222-222222222222'
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

function fakeSafeStorage(): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => true,
    encryptString: plaintext => Buffer.from(`sealed:${plaintext}`, 'utf8'),
    decryptString: ciphertext => {
      const text = ciphertext.toString('utf8')
      if (!text.startsWith('sealed:')) throw new Error('invalid fake ciphertext')
      return text.slice('sealed:'.length)
    },
  }
}

async function fixture() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'm7-prepare-'))
  tempDirs.push(tempDir)
  const store = createResourceDocumentStore({ activeConfigDir: tempDir })
  const library = createResourceLibraryService({ store })
  const vault = createCredentialVault({ safeStorage: fakeSafeStorage() })
  let credentialSequence = 1
  const credentialService = createCredentialRecordService({
    store,
    vault,
    createId: () => `50000000-0000-4000-8000-${String(credentialSequence++).padStart(12, '0')}`,
  })
  const credential = await credentialService.create({
    kind: 'ssh-password',
    label: 'selected host login',
    secret: { kind: 'ssh-password', password: 'fake-host-password-123' },
  })
  if (credential.status !== 'created') throw new Error(`credential fixture failed: ${JSON.stringify(credential)}`)
  const host = await library.createHost({
    name: 'public-host', address: '10.0.0.8', port: 22, username: 'deploy',
    auth: { type: 'password', credentialId: credential.credential.id }, tagIds: [], initialDirectory: '/secret/local/path', applications: [], notes: '',
  })
  const reference = await library.createConcept({
    title: 'Reference only', summary: 'ref', bodyMarkdown: 'REFERENCE_BODY_MUST_NOT_EXPAND',
    tagIds: [], dependsOnIds: [], referenceIds: [],
  })
  const dependency = await library.createConcept({
    title: 'Dependency', summary: 'dep', bodyMarkdown: 'dependency body',
    tagIds: [], dependsOnIds: [], referenceIds: [],
  })
  if (dependency.status !== 'created' || reference.status !== 'created') throw new Error('fixture concept create failed')
  const root = await library.createConcept({
    title: 'Root', summary: 'root', bodyMarkdown: 'root body', tagIds: [],
    dependsOnIds: [dependency.value.id], referenceIds: [reference.value.id],
  })
  if (host.status !== 'created' || root.status !== 'created') throw new Error('fixture create failed')
  return {
    store,
    library,
    vault,
    credentialService,
    credential: credential.credential,
    host: host.value,
    root: root.value,
    dependency: dependency.value,
  }
}

function selection(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    schemaVersion: 2 as const,
    hostRefs: [{ id: f.host.id, revision: f.host.revision }],
    conceptRootRefs: [{ id: f.root.id, revision: f.root.revision }],
    dependencyRefs: [{ id: f.dependency.id, revision: f.dependency.revision }],
    databaseRefs: [], redisRefs: [], credentialRefs: [], sourceTags: [],
    directHostIds: [f.host.id], directConceptIds: [f.root.id], directDatabaseIds: [], directRedisIds: [],
    includePasswords: false,
  }
}

describe('M7 main-process managed context prepare', () => {
  it('builds a revision-bound public manifest and model context without local paths or reference bodies', async () => {
    const f = await fixture()
    const result = await prepareManagedContextStageRequest(f.store, {
      sessionId: SESSION_ID,
      requestId: REQUEST_ID,
      runtimeRevision: 3,
      content: 'inspect host',
      selection: selection(f),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.publicManifest.hosts).toEqual([
      { id: f.host.id, name: 'public-host', address: '10.0.0.8', port: 22 },
    ])
    expect(result.data.publicManifest.concepts.map(concept => concept.id)).toEqual([f.root.id, f.dependency.id])
    expect(result.data.modelContext).toContain('root body')
    expect(result.data.modelContext).toContain('dependency body')
    expect(result.data.modelContext).toContain('Reference only')
    expect(result.data.modelContext).not.toContain('REFERENCE_BODY_MUST_NOT_EXPAND')
    expect(JSON.stringify(result.data)).not.toContain('/secret/local/path')
    expect(result.data.publicManifest.containsSecrets).toBe(false)
    expect(result.data.publicManifest.secretFieldCount).toBe(0)
  })

  it('rejects a stale selected revision before staging old context', async () => {
    const f = await fixture()
    const stale = selection(f)
    stale.hostRefs[0]!.revision += 1
    const result = await prepareManagedContextStageRequest(f.store, {
      sessionId: SESSION_ID, requestId: REQUEST_ID, runtimeRevision: 1, content: 'x', selection: stale,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('CONTEXT_REVISION_CHANGED')
  })

  it('decrypts only credentials reachable from selected resources and keeps them out of the public manifest', async () => {
    const f = await fixture()
    const withPasswords = { ...selection(f), includePasswords: true }
    const result = await prepareManagedContextStageRequest(f.store, {
      sessionId: SESSION_ID, requestId: REQUEST_ID, runtimeRevision: 1, content: 'x', selection: withPasswords,
    }, f.vault)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.modelContext).toContain('fake-host-password-123')
    expect(result.data.publicManifest.containsSecrets).toBe(true)
    expect(result.data.publicManifest.secretFieldCount).toBe(1)
    expect(result.data.publicManifest.selection.credentialRefs).toEqual([
      { id: f.credential.id, revision: f.credential.revision },
    ])
    expect(JSON.stringify(result.data.publicManifest)).not.toContain('fake-host-password-123')
    expect(JSON.stringify(result.data.publicManifest)).not.toContain('ciphertextBase64')
  })

  it('injects database and Redis metadata with their own passwords exactly once without inheriting a related host secret', async () => {
    const f = await fixture()
    const dbSecret = 'fake-database-password-456'
    const redisSecret = 'fake-redis-password-789'
    const databaseCredential = await f.credentialService.create({
      kind: 'database-password',
      label: 'orders database password',
      secret: { kind: 'database-password', password: dbSecret },
    })
    const redisCredential = await f.credentialService.create({
      kind: 'redis-password',
      label: 'orders redis password',
      secret: { kind: 'redis-password', password: redisSecret },
    })
    expect(databaseCredential.status).toBe('created')
    expect(redisCredential.status).toBe('created')
    if (databaseCredential.status !== 'created' || redisCredential.status !== 'created') return

    const databaseTag = await f.library.createTag({ namespace: 'database', name: '生产数据库', colorToken: null })
    const redisTag = await f.library.createTag({ namespace: 'redis', name: '生产缓存', colorToken: null })
    expect(databaseTag.status).toBe('created')
    expect(redisTag.status).toBe('created')
    if (databaseTag.status !== 'created' || redisTag.status !== 'created') return

    const database = await f.library.createDataConnection({
      kind: 'database',
      name: 'orders-db',
      address: 'db.internal',
      port: 5432,
      username: 'orders_reader',
      credentialId: databaseCredential.credential.id,
      tagIds: [databaseTag.value.id],
      relatedHostId: f.host.id,
      environment: 'production',
      tls: {
        enabled: true,
        serverName: 'db.internal',
        caCertificate: null,
        clientCertificate: null,
        clientKeyCredentialId: null,
      },
      description: 'orders database',
      accessInstructions: 'read operations only',
      engine: 'postgresql',
      database: 'orders',
      schema: 'public',
      mode: 'inspection',
    })
    const redis = await f.library.createDataConnection({
      kind: 'redis',
      name: 'orders-cache',
      address: 'redis.internal',
      port: 6379,
      username: 'default',
      credentialId: redisCredential.credential.id,
      tagIds: [redisTag.value.id],
      relatedHostId: f.host.id,
      environment: 'production',
      tls: {
        enabled: false,
        serverName: null,
        caCertificate: null,
        clientCertificate: null,
        clientKeyCredentialId: null,
      },
      description: 'orders cache',
      accessInstructions: 'inspect selected keys only',
      topology: 'standalone',
      databaseIndex: 3,
      keyPrefixDescription: 'orders:*',
    })
    expect(database.status).toBe('created')
    expect(redis.status).toBe('created')
    if (database.status !== 'created' || redis.status !== 'created') return

    const result = await prepareManagedContextStageRequest(f.store, {
      sessionId: SESSION_ID,
      requestId: REQUEST_ID,
      runtimeRevision: 1,
      content: 'inspect orders data and cache',
      selection: {
        schemaVersion: 2,
        hostRefs: [], conceptRootRefs: [], dependencyRefs: [],
        databaseRefs: [{ id: database.value.id, revision: database.value.revision }],
        redisRefs: [{ id: redis.value.id, revision: redis.value.revision }],
        credentialRefs: [], sourceTags: [],
        directHostIds: [], directConceptIds: [], directDatabaseIds: [database.value.id], directRedisIds: [redis.value.id],
        includePasswords: true,
      },
    }, f.vault)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const model = JSON.parse(result.data.modelContext) as {
      managedResources: {
        databases: Array<Record<string, unknown>>
        redisConnections: Array<Record<string, unknown>>
      }
      credentialSecrets?: unknown
    }
    expect(model.managedResources.databases).toEqual([
      expect.objectContaining({
        id: database.value.id,
        name: 'orders-db',
        engine: 'postgresql',
        address: 'db.internal',
        port: 5432,
        username: 'orders_reader',
        password: dbSecret,
        database: 'orders',
        schema: 'public',
        environment: 'production',
        tls: { enabled: true, serverName: 'db.internal' },
        tags: ['生产数据库'],
        relatedHostId: f.host.id,
      }),
    ])
    expect(model.managedResources.redisConnections).toEqual([
      expect.objectContaining({
        id: redis.value.id,
        name: 'orders-cache',
        address: 'redis.internal',
        port: 6379,
        topology: 'standalone',
        databaseIndex: 3,
        username: 'default',
        password: redisSecret,
        environment: 'production',
        tls: { enabled: false, serverName: null },
        tags: ['生产缓存'],
        relatedHostId: f.host.id,
        keyPrefixDescription: 'orders:*',
      }),
    ])
    expect(model.credentialSecrets).toBeUndefined()
    expect(result.data.modelContext.split(dbSecret)).toHaveLength(2)
    expect(result.data.modelContext.split(redisSecret)).toHaveLength(2)
    expect(result.data.modelContext).not.toContain('fake-host-password-123')
    expect(result.data.publicManifest.containsSecrets).toBe(true)
    expect(result.data.publicManifest.secretFieldCount).toBe(2)
    expect(result.data.publicManifest.selection.credentialRefs).toEqual([
      { id: databaseCredential.credential.id, revision: databaseCredential.credential.revision },
      { id: redisCredential.credential.id, revision: redisCredential.credential.revision },
    ])
    expect(JSON.stringify(result.data.publicManifest)).not.toContain(dbSecret)
    expect(JSON.stringify(result.data.publicManifest)).not.toContain(redisSecret)
  })

  it('keeps SSH private keys revision-bound but never decrypts or injects PEM/passphrases', async () => {
    const f = await fixture()
    const keyCredential = await f.credentialService.create({
      kind: 'ssh-private-key',
      label: 'selected host private key',
      secret: {
        kind: 'ssh-private-key',
        privateKeyPem: '-----BEGIN PRIVATE KEY-----\nprivate-key-must-not-reach-model\n-----END PRIVATE KEY-----',
        passphrase: 'private-key-passphrase-must-not-reach-model',
      },
    })
    expect(keyCredential.status).toBe('created')
    if (keyCredential.status !== 'created') return
    const keyHost = await f.library.createHost({
      name: 'key-host',
      address: '10.0.0.9',
      port: 22,
      username: 'deploy',
      auth: { type: 'privateKey', credentialId: keyCredential.credential.id },
      tagIds: [],
      initialDirectory: null,
      applications: [],
      notes: '',
    })
    expect(keyHost.status).toBe('created')
    if (keyHost.status !== 'created') return

    const result = await prepareManagedContextStageRequest(f.store, {
      sessionId: SESSION_ID,
      requestId: REQUEST_ID,
      runtimeRevision: 1,
      content: 'inspect key host',
      selection: {
        schemaVersion: 2,
        hostRefs: [{ id: keyHost.value.id, revision: keyHost.value.revision }],
        conceptRootRefs: [], dependencyRefs: [], databaseRefs: [], redisRefs: [], credentialRefs: [], sourceTags: [],
        directHostIds: [keyHost.value.id], directConceptIds: [], directDatabaseIds: [], directRedisIds: [],
        includePasswords: true,
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.publicManifest.selection.credentialRefs).toEqual([
      { id: keyCredential.credential.id, revision: keyCredential.credential.revision },
    ])
    expect(result.data.publicManifest.containsSecrets).toBe(false)
    expect(result.data.publicManifest.secretFieldCount).toBe(0)
    expect(result.data.modelContext).not.toContain('private-key-must-not-reach-model')
    expect(result.data.modelContext).not.toContain('private-key-passphrase-must-not-reach-model')
    expect(result.data.modelContext).not.toContain('privateKeyPem')
  })

  it('fails closed when a selected credential exists but the main-process vault is unavailable', async () => {
    const f = await fixture()
    const result = await prepareManagedContextStageRequest(f.store, {
      sessionId: SESSION_ID,
      requestId: REQUEST_ID,
      runtimeRevision: 1,
      content: 'x',
      selection: { ...selection(f), includePasswords: true },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('SECRET_VAULT_UNAVAILABLE')
  })

  it('rejects credential refs that are not reachable from the selected resources', async () => {
    const f = await fixture()
    const result = await prepareManagedContextStageRequest(f.store, {
      sessionId: SESSION_ID,
      requestId: REQUEST_ID,
      runtimeRevision: 1,
      content: 'x',
      selection: {
        ...selection(f),
        includePasswords: true,
        credentialRefs: [{ id: '50000000-0000-4000-8000-000000000099', revision: 1 }],
      },
    }, f.vault)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_CONTEXT_SELECTION')
  })
})
