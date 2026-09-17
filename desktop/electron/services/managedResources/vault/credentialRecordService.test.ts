import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createResourceDocumentStore } from '../repositories/resourceDocumentStore.js'
import { createCredentialRecordService } from './credentialRecordService'
import { createCredentialVault, type SafeStorageAdapter } from './credentialVault'

const stamp = '2026-09-09T00:00:00.000Z'
const ids = {
  ssh: '50000000-0000-4000-8000-000000000001',
  application: '50000000-0000-4000-8000-000000000002',
  database: '50000000-0000-4000-8000-000000000003',
  tls: '50000000-0000-4000-8000-000000000004',
  host: '10000000-0000-4000-8000-000000000001',
  applicationId: '11000000-0000-4000-8000-000000000001',
  account: '12000000-0000-4000-8000-000000000001',
  databaseConnection: '40000000-0000-4000-8000-000000000001',
}

function createFakeSafeStorage(options: { available?: boolean; encryptThrows?: boolean } = {}): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => options.available ?? true,
    encryptString: plainText => {
      if (options.encryptThrows) throw new Error('fake encrypt failure')
      return Buffer.from(`sealed:${plainText}`, 'utf8')
    },
    decryptString: ciphertext => {
      const value = ciphertext.toString('utf8')
      if (!value.startsWith('sealed:')) throw new Error('fake decrypt failure')
      return value.slice('sealed:'.length)
    },
  }
}

describe('credentialRecordService', () => {
  let tempDirs: string[] = []

  async function createTempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'credential-record-service-test-'))
    tempDirs.push(dir)
    return dir
  }

  afterEach(async () => {
    for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true })
    tempDirs = []
  })

  it('creates a credential in one transaction, persists only ciphertext, and survives a store restart', async () => {
    const tempDir = await createTempDir()
    const store = createResourceDocumentStore({ activeConfigDir: tempDir })
    const vault = createCredentialVault({ safeStorage: createFakeSafeStorage() })
    const service = createCredentialRecordService({
      store,
      vault,
      now: () => stamp,
      createId: () => ids.ssh,
    })

    const created = await service.create({
      kind: 'ssh-password',
      label: 'test ssh password',
      secret: { kind: 'ssh-password', password: 'fake-plaintext-password-sentinel' },
    })

    expect(created).toEqual({
      status: 'created',
      credential: {
        id: ids.ssh,
        revision: 1,
        createdAt: stamp,
        updatedAt: stamp,
        kind: 'ssh-password',
        label: 'test ssh password',
        backend: 'electron-safe-storage-v1',
        hasSecret: true,
      },
      documentRevision: 2,
    })
    const disk = await fs.readFile(store.filePath, 'utf8')
    expect(disk).not.toContain('fake-plaintext-password-sentinel')

    const restarted = createResourceDocumentStore({ activeConfigDir: tempDir })
    const loaded = await restarted.load()
    expect(loaded.status).toBe('ready')
    if (loaded.status !== 'ready') return
    expect(loaded.document.credentials).toHaveLength(1)
    expect(loaded.document.credentials[0]).toMatchObject({
      id: ids.ssh,
      revision: 1,
      kind: 'ssh-password',
      label: 'test ssh password',
      backend: 'electron-safe-storage-v1',
    })
    expect(loaded.document.credentials[0]!.ciphertextBase64).not.toContain('fake-plaintext-password-sentinel')
  })

  it('updates an existing credential with entity revision checking and replaces ciphertext only after a successful encrypt', async () => {
    const tempDir = await createTempDir()
    const store = createResourceDocumentStore({ activeConfigDir: tempDir })
    const vault = createCredentialVault({ safeStorage: createFakeSafeStorage() })
    const service = createCredentialRecordService({
      store,
      vault,
      now: () => stamp,
      createId: () => ids.ssh,
    })
    await service.create({
      kind: 'ssh-password',
      label: 'old label',
      secret: { kind: 'ssh-password', password: 'old-fake-plaintext-secret' },
    })
    const before = await store.load()
    expect(before.status).toBe('ready')
    if (before.status !== 'ready') return
    const oldCiphertext = before.document.credentials[0]!.ciphertextBase64

    const stale = await service.update({
      id: ids.ssh,
      expectedRevision: 9,
      label: 'must not save',
      secret: { kind: 'ssh-password', password: 'new-fake-plaintext-secret' },
    })
    expect(stale).toEqual({
      status: 'rejected',
      code: 'REVISION_CONFLICT',
      id: ids.ssh,
      expectedRevision: 9,
      actualRevision: 1,
    })

    const updated = await service.update({
      id: ids.ssh,
      expectedRevision: 1,
      label: 'new label',
      secret: { kind: 'ssh-password', password: 'new-fake-plaintext-secret' },
    })
    expect(updated).toMatchObject({
      status: 'updated',
      documentRevision: 3,
      credential: { id: ids.ssh, revision: 2, label: 'new label', hasSecret: true },
    })
    const loaded = await store.load()
    expect(loaded.status).toBe('ready')
    if (loaded.status !== 'ready') return
    expect(loaded.document.credentials[0]!.ciphertextBase64).not.toBe(oldCiphertext)
    expect(JSON.stringify(loaded.document)).not.toContain('old-fake-plaintext-secret')
    expect(JSON.stringify(loaded.document)).not.toContain('new-fake-plaintext-secret')
  })

  it('returns vault failure before opening a transaction and leaves an existing ciphertext unchanged', async () => {
    const tempDir = await createTempDir()
    const store = createResourceDocumentStore({ activeConfigDir: tempDir })
    const healthyService = createCredentialRecordService({
      store,
      vault: createCredentialVault({ safeStorage: createFakeSafeStorage() }),
      now: () => stamp,
      createId: () => ids.ssh,
    })
    await healthyService.create({
      kind: 'ssh-password',
      label: 'existing',
      secret: { kind: 'ssh-password', password: 'existing-fake-plaintext-secret' },
    })
    const before = await fs.readFile(store.filePath)
    const unavailableService = createCredentialRecordService({
      store,
      vault: createCredentialVault({ safeStorage: createFakeSafeStorage({ available: false }) }),
      now: () => stamp,
      createId: () => ids.ssh,
    })

    expect(await unavailableService.update({
      id: ids.ssh,
      expectedRevision: 1,
      secret: { kind: 'ssh-password', password: 'replacement-fake-plaintext-secret' },
    })).toEqual({ status: 'rejected', code: 'VAULT_UNAVAILABLE' })
    expect(await fs.readFile(store.filePath)).toEqual(before)
  })

  it('preserves the old ciphertext when the one resource transaction cannot write', async () => {
    const tempDir = await createTempDir()
    const healthyStore = createResourceDocumentStore({ activeConfigDir: tempDir })
    const healthyService = createCredentialRecordService({
      store: healthyStore,
      vault: createCredentialVault({ safeStorage: createFakeSafeStorage() }),
      now: () => stamp,
      createId: () => ids.ssh,
    })
    await healthyService.create({
      kind: 'ssh-password',
      label: 'existing',
      secret: { kind: 'ssh-password', password: 'existing-fake-plaintext-secret' },
    })
    const before = await fs.readFile(healthyStore.filePath)
    const failingStore = createResourceDocumentStore({
      activeConfigDir: tempDir,
      writerDependencies: {
        replaceFile: async () => {
          throw new Error('fake write failure with replacement-fake-plaintext-secret')
        },
      },
    })
    const service = createCredentialRecordService({
      store: failingStore,
      vault: createCredentialVault({ safeStorage: createFakeSafeStorage() }),
      now: () => stamp,
      createId: () => ids.ssh,
    })

    expect(await service.update({
      id: ids.ssh,
      expectedRevision: 1,
      secret: { kind: 'ssh-password', password: 'replacement-fake-plaintext-secret' },
    })).toEqual({ status: 'rejected', code: 'WRITE_FAILED' })
    expect(await fs.readFile(healthyStore.filePath)).toEqual(before)
  })

  it('blocks deletion for every reverse credential reference and deletes an unreferenced record', async () => {
    const tempDir = await createTempDir()
    const store = createResourceDocumentStore({ activeConfigDir: tempDir })
    const createIds = [ids.ssh, ids.application, ids.database, ids.tls]
    const service = createCredentialRecordService({
      store,
      vault: createCredentialVault({ safeStorage: createFakeSafeStorage() }),
      now: () => stamp,
      createId: () => createIds.shift()!,
    })
    await service.create({ kind: 'ssh-password', label: 'ssh', secret: { kind: 'ssh-password', password: 'ssh-secret' } })
    await service.create({ kind: 'application-password', label: 'app', secret: { kind: 'application-password', password: 'app-secret' } })
    await service.create({ kind: 'database-password', label: 'db', secret: { kind: 'database-password', password: 'db-secret' } })
    await service.create({ kind: 'tls-client-key', label: 'tls', secret: { kind: 'tls-client-key', privateKeyPem: 'tls-key-secret' } })
    await store.transact({
      mutate: draft => {
        draft.hosts.push({
          id: ids.host, revision: 1, createdAt: stamp, updatedAt: stamp,
          name: 'host', address: '192.0.2.10', port: 22, username: 'root',
          auth: { type: 'password', credentialId: ids.ssh }, tagIds: [], initialDirectory: null,
          applications: [{
            id: ids.applicationId, name: 'app', version: null, installPaths: [], accessDescription: '', accessUrls: [], loginUrl: null,
            accounts: [{ id: ids.account, label: 'app', username: 'root', credentialId: ids.application }], notes: '',
          }], notes: '',
        })
        draft.dataConnections.push({
          id: ids.databaseConnection, revision: 1, createdAt: stamp, updatedAt: stamp,
          name: 'db', address: '192.0.2.20', port: 3306, username: 'root', credentialId: ids.database,
          tagIds: [], relatedHostId: ids.host, environment: 'unspecified',
          tls: { enabled: true, serverName: 'db.example.test', caCertificate: null, clientCertificate: null, clientKeyCredentialId: ids.tls },
          description: '', accessInstructions: '', kind: 'database', engine: 'mysql', database: 'app', schema: null, mode: 'inspection',
        })
        return { commit: true as const, value: undefined }
      },
    })

    for (const id of [ids.ssh, ids.application, ids.database, ids.tls]) {
      expect(await service.delete({ id, expectedRevision: 1 })).toMatchObject({
        status: 'rejected',
        code: 'RESOURCE_IN_USE',
        id,
      })
    }

    const unreferencedId = '50000000-0000-4000-8000-000000000099'
    const unreferencedService = createCredentialRecordService({
      store,
      vault: createCredentialVault({ safeStorage: createFakeSafeStorage() }),
      now: () => stamp,
      createId: () => unreferencedId,
    })
    await unreferencedService.create({
      kind: 'redis-password', label: 'unused', secret: { kind: 'redis-password', password: 'unused-secret' },
    })
    expect(await unreferencedService.delete({ id: unreferencedId, expectedRevision: 1 })).toMatchObject({
      status: 'deleted',
      id: unreferencedId,
    })
  })

  it('does not leak secret or underlying exception text in a rejected result', async () => {
    const tempDir = await createTempDir()
    const store = createResourceDocumentStore({ activeConfigDir: tempDir })
    const service = createCredentialRecordService({
      store,
      vault: createCredentialVault({ safeStorage: createFakeSafeStorage({ encryptThrows: true }) }),
      now: () => stamp,
      createId: () => ids.ssh,
    })

    const result = await service.create({
      kind: 'ssh-password',
      label: 'safe label',
      secret: { kind: 'ssh-password', password: 'fake-plaintext-password-sentinel' },
    })
    expect(result).toEqual({ status: 'rejected', code: 'VAULT_UNAVAILABLE' })
    expect(JSON.stringify(result)).not.toContain('fake-plaintext-password-sentinel')
    expect(JSON.stringify(result)).not.toContain('fake encrypt failure')
    await expect(fs.stat(store.filePath)).rejects.toThrow()
  })
})
