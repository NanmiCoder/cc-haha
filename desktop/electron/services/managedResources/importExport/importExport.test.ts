import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { scanForSecrets } from './secretDenylist.js'
import { executeExportMetadata } from './exportMetadata.js'
import { executeImportMetadata } from './importMetadata.js'
import { createResourceDocumentStore } from '../repositories/resourceDocumentStore.js'
import { createResourceLibraryService } from '../repositories/resourceLibraryService.js'
import { createCredentialVault, createTemporaryCredentialStore } from '../vault/credentialVault.js'
import { createCredentialRecordService } from '../vault/credentialRecordService.js'
import { createContextSelectionsRepository } from '../contextSelections/contextSelectionsRepository.js'
import { createKnownHostsService } from '../knownHosts.js'
import { createSshSessionService } from '../sshSessionService.js'
import { createSftpService, createTransferService, createRemoteEditService, createLocalPathService } from '../sftpService.js'
import type { ManagedResourcesServices } from '../registerIpc.js'

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function createFakeSafeStorage(): any {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) => Buffer.from(`sealed:${plainText}`, 'utf8'),
    decryptString: (ciphertext: Buffer) => {
      const value = ciphertext.toString('utf8')
      if (!value.startsWith('sealed:')) throw new Error('fake decrypt failure')
      return value.slice('sealed:'.length)
    },
  }
}

function buildServices(tempDir: string): ManagedResourcesServices & {
  store: ReturnType<typeof createResourceDocumentStore>
  libService: ReturnType<typeof createResourceLibraryService>
  credentialService: ReturnType<typeof createCredentialRecordService>
} {
  const store = createResourceDocumentStore({ activeConfigDir: tempDir })
  const libService = createResourceLibraryService({ store })
  const fakeSafeStorage = createFakeSafeStorage()
  const vault = createCredentialVault({ safeStorage: fakeSafeStorage })
  const credentialService = createCredentialRecordService({ store, vault })
  const selectionsRepo = createContextSelectionsRepository({ activeConfigDir: tempDir })
  const temporaryCredentials = createTemporaryCredentialStore()
  const knownHosts = createKnownHostsService(store)
  const sshService = createSshSessionService({
    store,
    knownHosts,
    vault,
    resolveTemporaryCredential: () => null,
  })
  return {
    store,
    libService,
    vault,
    credentialService,
    selectionsRepo,
    temporaryCredentials,
    knownHosts,
    sshService,
    sftpService: createSftpService({ resolveSession: () => { throw new Error('SFTP_UNAVAILABLE') }, tempDir }),
    localPathService: createLocalPathService({ userDataDir: tempDir }),
    transferService: createTransferService({
      resolveSession: () => { throw new Error('SFTP_UNAVAILABLE') },
      sftpService: createSftpService({ resolveSession: () => { throw new Error('SFTP_UNAVAILABLE') }, tempDir }),
      localPathService: createLocalPathService({ userDataDir: tempDir }),
    }),
    remoteEditService: createRemoteEditService({
      resolveSession: () => { throw new Error('SFTP_UNAVAILABLE') },
      sftpService: createSftpService({ resolveSession: () => { throw new Error('SFTP_UNAVAILABLE') }, tempDir }),
      localPathService: createLocalPathService({ userDataDir: tempDir }),
    }),
    dispose() {
      void sshService.dispose().catch(() => undefined)
      temporaryCredentials.dispose()
    },
  }
}

describe('Managed Resources Import/Export Security & Integrity', () => {
  describe('scanForSecrets', () => {
    it('detects sensitive password fields at any depth', () => {
      const payload = {
        hosts: [
          {
            name: 'evil-host',
            nested: {
              password: 'super-secret-pw',
            },
          },
        ],
      }
      const res = scanForSecrets(payload)
      expect(res.detected).toBe(true)
      if (res.detected) {
        expect(res.path).toContain('password')
      }
    })

    it('detects PEM private key patterns in arbitrary strings', () => {
      const payload = {
        notes: 'Here is my key: -----BEGIN OPENSSH PRIVATE KEY-----\nsecret...\n-----END OPENSSH PRIVATE KEY-----',
      }
      const res = scanForSecrets(payload)
      expect(res.detected).toBe(true)
      if (res.detected) {
        expect(res.reason).toContain('Private key PEM pattern detected')
      }
    })

    it('detects non-empty credentials array', () => {
      const payload = {
        credentials: [{ id: 'c1', label: 'admin' }],
      }
      const res = scanForSecrets(payload)
      expect(res.detected).toBe(true)
    })

    it('allows null credentialId and empty credentials array', () => {
      const payload = {
        auth: { credentialId: null },
        credentials: [],
      }
      const res = scanForSecrets(payload)
      expect(res.detected).toBe(false)
    })
  })

  describe('executeExportMetadata', () => {
    it('exports public DTOs without spreading unknown sensitive fields or credentials', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-export-test-'))
      const exportFile = path.join(tempDir, 'exported.json')

      const services = buildServices(tempDir)

      // Create tag and host with credentials
      const tagRes = await services.libService.createTag({ namespace: 'host', name: 'Production', colorToken: 'blue' })
      expect(tagRes.status).toBe('created')

      const credRes = await services.credentialService.create({
        kind: 'ssh-password',
        label: 'Prod root password',
        secret: { kind: 'ssh-password', password: 'ultra-secret-password-123' },
      })
      if (credRes.status !== 'created') console.error('credRes rejected:', credRes)
      expect(credRes.status).toBe('created')

      const hostRes = await services.libService.createHost({
        name: 'prod-server',
        address: '192.168.1.100',
        port: 22,
        username: 'root',
        auth: { type: 'password', credentialId: (credRes as any).credential.id },
        tagIds: [(tagRes as any).value.id],
        initialDirectory: '/var/www',
        applications: [],
        notes: 'Prod environment',
      })
      expect(hostRes.status).toBe('created')

      const fakeWindow: any = { id: 1, isDestroyed: () => false, webContents: { id: 10 } }
      const fakeDialogService = {
        showSaveDialog: async () => ({ canceled: false, filePath: exportFile }),
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      }

      const result = await executeExportMetadata(fakeWindow, services, fakeDialogService)
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('Expected ok')
      expect(result.data.exportedCount).toBeGreaterThanOrEqual(2)

      const exportedContent = await fs.readFile(exportFile, 'utf-8')
      expect(exportedContent).not.toContain('ultra-secret-password-123')
      expect(exportedContent).not.toContain((credRes as any).credential.id)

      const parsedExport = JSON.parse(exportedContent)
      expect(parsedExport.credentials).toEqual([])
      expect(parsedExport.hosts[0].auth.credentialId).toBeNull()

      await fs.rm(tempDir, { recursive: true, force: true })
    })
  })

  describe('executeImportMetadata', () => {
    it('rejects import containing leaked secrets and reports CREDENTIAL_LEAK_DETECTED', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-import-leak-'))
      const maliciousFile = path.join(tempDir, 'malicious.json')

      const maliciousPayload = {
        schemaVersion: 2,
        hosts: [
          {
            id: 'host-1',
            revision: 1,
            name: 'malicious-host',
            address: '10.0.0.1',
            port: 22,
            username: 'root',
            auth: { type: 'password', credentialId: null },
            tagIds: [],
            applications: [],
            notes: 'hacked',
            password: 'leaked-in-json',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      }
      await fs.writeFile(maliciousFile, JSON.stringify(maliciousPayload), 'utf-8')

      const services = buildServices(tempDir)

      const fakeWindow: any = { id: 1, isDestroyed: () => false, webContents: { id: 10 } }
      const fakeDialogService = {
        showSaveDialog: async () => ({ canceled: true }),
        showOpenDialog: async () => ({ canceled: false, filePaths: [maliciousFile] }),
      }

      const result = await executeImportMetadata(fakeWindow, services, fakeDialogService)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('Expected not ok')
      expect(result.error.code).toBe('CREDENTIAL_LEAK_DETECTED')

      await fs.rm(tempDir, { recursive: true, force: true })
    })

    it('rejects import with higher schemaVersion', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-import-version-'))
      const futureFile = path.join(tempDir, 'future.json')

      await fs.writeFile(futureFile, JSON.stringify({ schemaVersion: 999 }), 'utf-8')

      const services = buildServices(tempDir)

      const fakeWindow: any = { id: 1, isDestroyed: () => false, webContents: { id: 10 } }
      const fakeDialogService = {
        showSaveDialog: async () => ({ canceled: true }),
        showOpenDialog: async () => ({ canceled: false, filePaths: [futureFile] }),
      }

      const result = await executeImportMetadata(fakeWindow, services, fakeDialogService)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('Expected not ok')
      expect(result.error.code).toBe('NEWER_SCHEMA_VERSION')

      await fs.rm(tempDir, { recursive: true, force: true })
    })

    it('leaves original target file byte-for-byte identical when referential integrity validation fails', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-import-integrity-'))
      const invalidFile = path.join(tempDir, 'invalid-refs.json')

      const services = buildServices(tempDir)

      // Populate store with valid initial host
      await services.libService.createTag({ namespace: 'host', name: 'ExistingTag', colorToken: null })
      const initialFileBytes = await fs.readFile(services.store.filePath)
      const initialHash = sha256(initialFileBytes)

      // Payload references non-existent tag
      const invalidPayload = {
        schemaVersion: 2,
        hosts: [
          {
            id: 'host-orphan-tag',
            revision: 1,
            name: 'orphan-host',
            address: '1.2.3.4',
            port: 22,
            username: 'root',
            auth: { type: 'password', credentialId: null },
            tagIds: ['non-existent-tag-id-12345'],
            applications: [],
            notes: '',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        tags: [],
        concepts: [],
        dataConnections: [],
        knownHostKeys: [],
      }
      await fs.writeFile(invalidFile, JSON.stringify(invalidPayload), 'utf-8')

      const fakeWindow: any = { id: 1, isDestroyed: () => false, webContents: { id: 10 } }
      const fakeDialogService = {
        showSaveDialog: async () => ({ canceled: true }),
        showOpenDialog: async () => ({ canceled: false, filePaths: [invalidFile] }),
      }

      const result = await executeImportMetadata(fakeWindow, services, fakeDialogService)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('Expected not ok')
      expect(result.error.code).toBe('VALIDATION_FAILED')

      // Prove byte-for-byte identical
      const postFileBytes = await fs.readFile(services.store.filePath)
      const postHash = sha256(postFileBytes)
      expect(postHash).toBe(initialHash)

      await fs.rm(tempDir, { recursive: true, force: true })
    })

    it('rejects import containing URL userinfo in unknown field and proves disk byte-for-byte identical', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-import-url-userinfo-'))
      const maliciousFile = path.join(tempDir, 'userinfo.json')

      const services = buildServices(tempDir)

      await services.libService.createTag({ namespace: 'host', name: 'SafeTag', colorToken: null })
      const initialFileBytes = await fs.readFile(services.store.filePath)
      const initialHash = sha256(initialFileBytes)

      // Malicious payload with URL userinfo in unknown field
      const maliciousPayload = {
        schemaVersion: 2,
        connectionUrl: 'https://audit-user:audit-secret@example.invalid/',
        hosts: [],
        tags: [],
        concepts: [],
        dataConnections: [],
        knownHostKeys: [],
      }
      await fs.writeFile(maliciousFile, JSON.stringify(maliciousPayload), 'utf-8')

      const fakeWindow: any = { id: 1, isDestroyed: () => false, webContents: { id: 10 } }
      const fakeDialogService = {
        showSaveDialog: async () => ({ canceled: true }),
        showOpenDialog: async () => ({ canceled: false, filePaths: [maliciousFile] }),
      }

      const result = await executeImportMetadata(fakeWindow, services, fakeDialogService)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('Expected not ok')
      expect(result.error.code).toBe('CREDENTIAL_LEAK_DETECTED')

      const postFileBytes = await fs.readFile(services.store.filePath)
      const postHash = sha256(postFileBytes)
      expect(postHash).toBe(initialHash)

      await fs.rm(tempDir, { recursive: true, force: true })
    })

    it('rejects stale entity revision on import and leaves disk byte-for-byte identical', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-import-stale-rev-'))
      const staleFile = path.join(tempDir, 'stale.json')

      const services = buildServices(tempDir)

      // Create host at revision 1
      const created = await services.libService.createHost({
        name: 'target-host',
        address: '10.0.0.1',
        port: 22,
        username: 'root',
        auth: { type: 'password', credentialId: null },
        tagIds: [],
        initialDirectory: null,
        applications: [],
        notes: 'initial',
      })
      const hostId = (created as any).value.id

      // Update host to revision 2
      await services.libService.updateHost({
        id: hostId,
        expectedRevision: 1,
        changes: {
          name: 'target-host-v2',
          address: '10.0.0.1',
          port: 22,
          username: 'root',
          auth: { type: 'password', credentialId: null },
          tagIds: [],
          initialDirectory: null,
          notes: 'updated',
        },
      })

      const initialFileBytes = await fs.readFile(services.store.filePath)
      const initialHash = sha256(initialFileBytes)

      // Incoming file has the same host at stale revision 1
      const stalePayload = {
        schemaVersion: 2,
        hosts: [
          {
            id: hostId,
            revision: 1, // Stale! Current store is revision 2
            name: 'stale-host',
            address: '10.0.0.1',
            port: 22,
            username: 'root',
            auth: { type: 'password', credentialId: null },
            tagIds: [],
            initialDirectory: null,
            applications: [],
            notes: 'stale-override',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        tags: [],
        concepts: [],
        dataConnections: [],
        knownHostKeys: [],
      }
      await fs.writeFile(staleFile, JSON.stringify(stalePayload), 'utf-8')

      const fakeWindow: any = { id: 1, isDestroyed: () => false, webContents: { id: 10 } }
      const fakeDialogService = {
        showSaveDialog: async () => ({ canceled: true }),
        showOpenDialog: async () => ({ canceled: false, filePaths: [staleFile] }),
      }

      const result = await executeImportMetadata(fakeWindow, services, fakeDialogService)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('Expected not ok')
      expect(result.error.code).toBe('REVISION_CONFLICT')

      const postFileBytes = await fs.readFile(services.store.filePath)
      const postHash = sha256(postFileBytes)
      expect(postHash).toBe(initialHash)

      await fs.rm(tempDir, { recursive: true, force: true })
    })

    it('rejects invalid UTF-8 byte sequences without modifying disk file', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-import-utf8-'))
      const invalidUtf8File = path.join(tempDir, 'invalid-utf8.json')

      const services = buildServices(tempDir)

      await services.libService.createTag({ namespace: 'host', name: 'SafeTag', colorToken: null })
      const initialFileBytes = await fs.readFile(services.store.filePath)
      const initialHash = sha256(initialFileBytes)

      // Write raw buffer with illegal UTF-8 byte 0xff
      const illegalBytes = Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d])
      await fs.writeFile(invalidUtf8File, illegalBytes)

      const fakeWindow: any = { id: 1, isDestroyed: () => false, webContents: { id: 10 } }
      const fakeDialogService = {
        showSaveDialog: async () => ({ canceled: true }),
        showOpenDialog: async () => ({ canceled: false, filePaths: [invalidUtf8File] }),
      }

      const result = await executeImportMetadata(fakeWindow, services, fakeDialogService)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('Expected not ok')
      expect(result.error.code).toBe('VALIDATION_FAILED')

      const postFileBytes = await fs.readFile(services.store.filePath)
      const postHash = sha256(postFileBytes)
      expect(postHash).toBe(initialHash)

      await fs.rm(tempDir, { recursive: true, force: true })
    })

    it('rejects document missing required top-level collections and leaves disk byte-for-byte identical', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-import-missing-colls-'))
      const incompleteFile = path.join(tempDir, 'incomplete.json')

      const services = buildServices(tempDir)

      await services.libService.createTag({ namespace: 'host', name: 'SafeTag', colorToken: null })
      const initialFileBytes = await fs.readFile(services.store.filePath)
      const initialHash = sha256(initialFileBytes)

      // Incomplete document: only schemaVersion, missing hosts, tags, concepts, dataConnections, knownHostKeys
      const incompletePayload = {
        schemaVersion: 2,
      }
      await fs.writeFile(incompleteFile, JSON.stringify(incompletePayload), 'utf-8')

      const fakeWindow: any = { id: 1, isDestroyed: () => false, webContents: { id: 10 } }
      const fakeDialogService = {
        showSaveDialog: async () => ({ canceled: true }),
        showOpenDialog: async () => ({ canceled: false, filePaths: [incompleteFile] }),
      }

      const result = await executeImportMetadata(fakeWindow, services, fakeDialogService)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('Expected not ok')
      expect(result.error.code).toBe('VALIDATION_FAILED')

      const postFileBytes = await fs.readFile(services.store.filePath)
      const postHash = sha256(postFileBytes)
      expect(postHash).toBe(initialHash)

      await fs.rm(tempDir, { recursive: true, force: true })
    })

    it('guarantees round-trip export -> import into empty temp repository preserves all metadata and relationships', async () => {
      const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-rt-source-'))
      const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-rt-target-'))
      const exportPath = path.join(sourceDir, 'exported.json')

      // 1. Setup source with host, tags, apps, concepts, dataConnections
      const srcStore = createResourceDocumentStore({ activeConfigDir: sourceDir })
      const srcLib = createResourceLibraryService({ store: srcStore })
      const fakeSafeStorage = createFakeSafeStorage()
      const srcVault = createCredentialVault({ safeStorage: fakeSafeStorage })
      const srcCreds = createCredentialRecordService({ store: srcStore, vault: srcVault })
      const srcSelections = createContextSelectionsRepository({ activeConfigDir: sourceDir })
      const srcTemp = createTemporaryCredentialStore()
      const srcKnownHosts = createKnownHostsService(srcStore)
      const srcSsh = createSshSessionService({
        store: srcStore,
        knownHosts: srcKnownHosts,
        vault: srcVault,
        resolveTemporaryCredential: () => null,
      })

      const srcServices: ManagedResourcesServices = {
        store: srcStore,
        libService: srcLib,
        vault: srcVault,
        credentialService: srcCreds,
        selectionsRepo: srcSelections,
        temporaryCredentials: srcTemp,
        knownHosts: srcKnownHosts,
        sshService: srcSsh,
        sftpService: createSftpService({ resolveSession: () => { throw new Error('SFTP_UNAVAILABLE') }, tempDir: sourceDir }),
        localPathService: createLocalPathService({ userDataDir: sourceDir }),
        transferService: createTransferService({
          resolveSession: () => { throw new Error('SFTP_UNAVAILABLE') },
          sftpService: createSftpService({ resolveSession: () => { throw new Error('SFTP_UNAVAILABLE') }, tempDir: sourceDir }),
          localPathService: createLocalPathService({ userDataDir: sourceDir }),
        }),
        remoteEditService: createRemoteEditService({
          resolveSession: () => { throw new Error('SFTP_UNAVAILABLE') },
          sftpService: createSftpService({ resolveSession: () => { throw new Error('SFTP_UNAVAILABLE') }, tempDir: sourceDir }),
          localPathService: createLocalPathService({ userDataDir: sourceDir }),
        }),
        dispose() {},
      }

      const tag1 = await srcLib.createTag({ namespace: 'host', name: 'DatabaseHost', colorToken: 'green' })
      const host1 = await srcLib.createHost({
        name: 'main-db-host',
        address: '10.10.0.1',
        port: 22,
        username: 'ubuntu',
        auth: { type: 'password', credentialId: null },
        tagIds: [(tag1 as any).value.id],
        initialDirectory: '/home/ubuntu',
        applications: [
          {
            name: 'Postgres',
            version: '15',
            installPaths: ['/usr/lib/postgresql/15'],
            accessDescription: 'Main DB',
            accessUrls: ['http://10.10.0.1:5432'],
            loginUrl: null,
            accounts: [{ label: 'postgres', username: 'postgres', credentialId: null }],
            notes: 'Primary database',
          },
        ],
        notes: 'Main DB Host notes',
      })
      await srcLib.createConcept({
        title: 'High Availability Guide',
        summary: 'How postgres HA works',
        bodyMarkdown: '# HA Guide\nPostgres clustering details',
        tagIds: [],
        dependsOnIds: [],
        referenceIds: [],
      })
      const dbTag = await srcLib.createTag({ namespace: 'database', name: 'app-db-tag', colorToken: null })
      const dc1 = await srcLib.createDataConnection({
        name: 'app-db',
        address: '10.10.0.1',
        port: 5432,
        username: 'postgres',
        credentialId: null,
        tagIds: [dbTag.status === 'created' ? dbTag.value.id : 'bad'],
        relatedHostId: (host1 as any).value.id,
        environment: 'unspecified',
        tls: { enabled: false, serverName: null, caCertificate: null, clientCertificate: null, clientKeyCredentialId: null },
        description: 'App primary connection',
        accessInstructions: '',
        kind: 'database',
        engine: 'postgresql',
        database: 'appdb',
        schema: null,
        mode: 'inspection',
      })
      expect(dc1.status).toBe('created')

      // Export from source
      const fakeWindow: any = { id: 1, isDestroyed: () => false, webContents: { id: 10 } }
      const exportDialog = {
        showSaveDialog: async () => ({ canceled: false, filePath: exportPath }),
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      }
      const exportRes = await executeExportMetadata(fakeWindow, srcServices, exportDialog)
      expect(exportRes.ok).toBe(true)

      // 2. Setup target empty repository
      const dstStore = createResourceDocumentStore({ activeConfigDir: targetDir })
      const dstLib = createResourceLibraryService({ store: dstStore })
      const dstVault = createCredentialVault({ safeStorage: fakeSafeStorage })
      const dstCreds = createCredentialRecordService({ store: dstStore, vault: dstVault })
      const dstSelections = createContextSelectionsRepository({ activeConfigDir: targetDir })
      const dstTemp = createTemporaryCredentialStore()
      const dstKnownHosts = createKnownHostsService(dstStore)
      const dstSsh = createSshSessionService({
        store: dstStore,
        knownHosts: dstKnownHosts,
        vault: dstVault,
        resolveTemporaryCredential: () => null,
      })

      const dstServices: ManagedResourcesServices = {
        store: dstStore,
        libService: dstLib,
        vault: dstVault,
        credentialService: dstCreds,
        selectionsRepo: dstSelections,
        temporaryCredentials: dstTemp,
        knownHosts: dstKnownHosts,
        sshService: dstSsh,
        sftpService: createSftpService({ resolveSession: () => { throw new Error('SFTP_UNAVAILABLE') }, tempDir: targetDir }),
        localPathService: createLocalPathService({ userDataDir: targetDir }),
        transferService: createTransferService({
          resolveSession: () => { throw new Error('SFTP_UNAVAILABLE') },
          sftpService: createSftpService({ resolveSession: () => { throw new Error('SFTP_UNAVAILABLE') }, tempDir: targetDir }),
          localPathService: createLocalPathService({ userDataDir: targetDir }),
        }),
        remoteEditService: createRemoteEditService({
          resolveSession: () => { throw new Error('SFTP_UNAVAILABLE') },
          sftpService: createSftpService({ resolveSession: () => { throw new Error('SFTP_UNAVAILABLE') }, tempDir: targetDir }),
          localPathService: createLocalPathService({ userDataDir: targetDir }),
        }),
        dispose() {},
      }

      const importDialog = {
        showSaveDialog: async () => ({ canceled: true }),
        showOpenDialog: async () => ({ canceled: false, filePaths: [exportPath] }),
      }
      const importRes = await executeImportMetadata(fakeWindow, dstServices, importDialog)
      if (!importRes.ok) {
        console.error('importRes error:', JSON.stringify(importRes.error, null, 2))
      }
      expect(importRes.ok).toBe(true)

      // Verify target has imported everything accurately
      const loadedDst = await dstStore.load()
      expect(loadedDst.status).toBe('ready')
      if (loadedDst.status === 'ready') {
        expect(loadedDst.document.hosts).toHaveLength(1)
        expect(loadedDst.document.hosts[0]!.name).toBe('main-db-host')
        expect(loadedDst.document.hosts[0]!.applications).toHaveLength(1)
        expect(loadedDst.document.hosts[0]!.applications[0]!.name).toBe('Postgres')
        expect(loadedDst.document.tags).toHaveLength(2)
        expect(loadedDst.document.tags.map(t => t.name)).toContain('DatabaseHost')
        expect(loadedDst.document.concepts).toHaveLength(1)
        expect(loadedDst.document.concepts[0]!.title).toBe('High Availability Guide')
        expect(loadedDst.document.dataConnections).toHaveLength(1)
        expect((loadedDst.document.dataConnections[0] as any).database).toBe('appdb')
      }

      await fs.rm(sourceDir, { recursive: true, force: true })
      await fs.rm(targetDir, { recursive: true, force: true })
    })
  })
})
