import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { HostSchema } from '../../../src/features/managed-resources/types/resourceSchemas.js'
import {
  createResourceDocumentStore,
} from './repositories/resourceDocumentStore.js'
import {
  createResourceLibraryService,
} from './repositories/resourceLibraryService.js'
import {
  createCredentialVault,
  createTemporaryCredentialStore,
  type SafeStorageAdapter,
} from './vault/credentialVault.js'
import {
  createCredentialRecordService,
} from './vault/credentialRecordService.js'
import {
  createContextSelectionsRepository,
} from './contextSelections/contextSelectionsRepository.js'
import { createKnownHostsService } from './knownHosts.js'
import { createSshSessionService } from './sshSessionService.js'
import { createSftpService, createTransferService, createRemoteEditService, createLocalPathService } from './sftpService.js'
import {
  registerManagedResourcesIpc,
  MANAGED_RESOURCES_IPC_CHANNELS,
  type ManagedResourcesServices,
} from './registerIpc.js'
import { createFakeSftpTransport, type FakeSftpTransport } from './sftpTestTransport.js'

function createFakeSafeStorage(available: boolean = true): SafeStorageAdapter {
  return {
    isEncryptionAvailable() {
      return available
    },
    encryptString(plainText: string) {
      if (!available) throw new Error('SafeStorage unavailable')
      return Buffer.from(`ENC:${plainText}`, 'utf8')
    },
    decryptString(cipherText: Buffer) {
      if (!available) throw new Error('SafeStorage unavailable')
      const str = cipherText.toString('utf8')
      if (!str.startsWith('ENC:')) throw new Error('Bad ciphertext')
      return str.slice(4)
    },
  }
}

describe('registerManagedResourcesIpc (M2.1)', () => {
  let tempDir: string
  let services: ManagedResourcesServices
  let handlers: Map<string, (event: any, payload: any) => Promise<any>>
  let fakeIpcMain: any
  let fakeMainWindow: any
  let fakeMainWebContents: any
  let fakeMainFrame: any
  let ownerId: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-ipc-test-'))
    const store = createResourceDocumentStore({ activeConfigDir: tempDir })
    const libService = createResourceLibraryService({ store })
    const safeStorage = createFakeSafeStorage(true)
    const vault = createCredentialVault({ safeStorage })
    const credentialService = createCredentialRecordService({ store, vault })
    const selectionsRepo = createContextSelectionsRepository({ activeConfigDir: tempDir })
    const temporaryCredentials = createTemporaryCredentialStore()

    services = {
      store,
      libService,
      vault,
      credentialService,
      credentialRevealAuthorizer: { authorize: async () => ({ status: 'authorized' as const }) },
      selectionsRepo,
      temporaryCredentials,
      knownHosts: createKnownHostsService(store),
      sshService: createSshSessionService({
        store,
        knownHosts: createKnownHostsService(store),
        vault,
        resolveTemporaryCredential: () => null,
      }),
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
        temporaryCredentials.dispose()
      },
    }

    handlers = new Map()
    fakeIpcMain = {
      handle(channel: string, handler: (event: any, payload: any) => Promise<any>) {
        handlers.set(channel, handler)
      },
      removeHandler(channel: string) {
        handlers.delete(channel)
      },
    }

    fakeMainFrame = { id: 1 }
    fakeMainWebContents = {
      id: 42,
      mainFrame: fakeMainFrame,
    }
    fakeMainWindow = {
      id: 99,
      isDestroyed: () => false,
      webContents: fakeMainWebContents,
    }

    ownerId = 'window-owner-99'
  })

  it('registers all required IPC channels and unregisters them on cleanup', () => {
    const unregister = registerManagedResourcesIpc({
      ipcMain: fakeIpcMain,
      getMainWindow: () => fakeMainWindow,
      services,
      expectedOwnerId: ownerId,
    })

    expect(handlers.has(MANAGED_RESOURCES_IPC_CHANNELS.getCapabilities)).toBe(true)
    expect(handlers.has(MANAGED_RESOURCES_IPC_CHANNELS.listHosts)).toBe(true)
    expect(handlers.has(MANAGED_RESOURCES_IPC_CHANNELS.saveHost)).toBe(true)
    expect(handlers.has(MANAGED_RESOURCES_IPC_CHANNELS.deleteHost)).toBe(true)
    expect(handlers.has(MANAGED_RESOURCES_IPC_CHANNELS.saveTag)).toBe(true)
    expect(handlers.has(MANAGED_RESOURCES_IPC_CHANNELS.deleteTag)).toBe(true)

    unregister()
    expect(handlers.size).toBe(0)
  })

  it('reveals only password credentials after Windows re-authentication and attaches a short renderer deadline', async () => {
    const created = await services.credentialService.create({
      kind: 'ssh-password',
      label: 'fixture SSH password',
      secret: { kind: 'ssh-password', password: 'fixture-linux-secret' },
    })
    if (!('credential' in created)) throw new Error('fixture credential was not created')
    const authorize = vi.fn(async () => ({ status: 'authorized' as const }))
    services.credentialRevealAuthorizer = { authorize }
    registerManagedResourcesIpc({
      ipcMain: fakeIpcMain,
      getMainWindow: () => fakeMainWindow,
      services,
      expectedOwnerId: ownerId,
    })
    const before = Date.now()
    const result = await handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.revealCredential)!(
      { sender: fakeMainWebContents, senderFrame: fakeMainFrame },
      { id: created.credential.id },
    )

    expect(authorize).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({
      credentialId: created.credential.id,
      kind: 'ssh-password',
      password: 'fixture-linux-secret',
    })
    expect(result.data.expiresAt).toBeGreaterThanOrEqual(before + 14_000)
    expect(result.data.expiresAt).toBeLessThanOrEqual(Date.now() + 15_000)
  })

  it('does not decrypt a saved password when Windows re-authentication fails', async () => {
    const created = await services.credentialService.create({
      kind: 'application-password',
      label: 'fixture app password',
      secret: { kind: 'application-password', password: 'must-never-leave-vault' },
    })
    if (!('credential' in created)) throw new Error('fixture credential was not created')
    services.credentialRevealAuthorizer = { authorize: async () => ({ status: 'denied' as const }) }
    const decrypt = vi.spyOn(services.vault, 'decrypt')
    registerManagedResourcesIpc({
      ipcMain: fakeIpcMain,
      getMainWindow: () => fakeMainWindow,
      services,
      expectedOwnerId: ownerId,
    })
    const result = await handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.revealCredential)!(
      { sender: fakeMainWebContents, senderFrame: fakeMainFrame },
      { id: created.credential.id },
    )

    expect(result).toEqual({
      ok: false,
      error: { code: 'OS_AUTH_FAILED', messageKey: 'managedResources.errors.OS_AUTH_FAILED' },
    })
    expect(decrypt).not.toHaveBeenCalled()
  })

  it('refuses to expose private-key material even when the reveal authorizer would approve', async () => {
    const created = await services.credentialService.create({
      kind: 'ssh-private-key',
      label: 'fixture key',
      secret: { kind: 'ssh-private-key', privateKeyPem: '-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE\n-----END OPENSSH PRIVATE KEY-----' },
    })
    if (!('credential' in created)) throw new Error('fixture credential was not created')
    const authorize = vi.fn(async () => ({ status: 'authorized' as const }))
    services.credentialRevealAuthorizer = { authorize }
    registerManagedResourcesIpc({
      ipcMain: fakeIpcMain,
      getMainWindow: () => fakeMainWindow,
      services,
      expectedOwnerId: ownerId,
    })
    const result = await handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.revealCredential)!(
      { sender: fakeMainWebContents, senderFrame: fakeMainFrame },
      { id: created.credential.id },
    )

    expect(result).toEqual({
      ok: false,
      error: { code: 'CREDENTIAL_NOT_PASSWORD', messageKey: 'managedResources.errors.CREDENTIAL_NOT_PASSWORD' },
    })
    expect(authorize).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('FAKE')
  })

  it('M10 forwards only validated data-browser operations with the canonical window owner', async () => {
    const connectionId = randomUUID()
    const dataSessionId = randomUUID()
    const queryId = randomUUID()
    const observed: Array<Record<string, unknown>> = []
    services.dataBrowserService = {
      openConnection: async (input: Record<string, unknown>) => {
        observed.push({ op: 'open', ...input })
        return { ok: true, data: { dataSessionId, generation: 1, connectionId, connectionRevision: 3, kind: 'database' } }
      },
      executeQuery: async (input: Record<string, unknown>) => {
        observed.push({ op: 'query', ...input })
        return { ok: true, data: { columns: [], rows: [], rowCount: 0, byteCount: 0, truncated: false, durationMs: 1 } }
      },
      scanKeys: async (input: Record<string, unknown>) => {
        observed.push({ op: 'scan', ...input })
        return { ok: true, data: { nextCursor: '0', complete: true, keys: [] } }
      },
      dispose: async () => undefined,
    } as any
    registerManagedResourcesIpc({
      ipcMain: fakeIpcMain,
      getMainWindow: () => fakeMainWindow,
      services,
      expectedOwnerId: ownerId,
    })
    const event = { sender: fakeMainWebContents, senderFrame: fakeMainFrame }

    await handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.openDataSession)!(event, {
      ownerId: 'forged-owner', connectionId, expectedRevision: 3,
    })
    await handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.executeQuery)!(event, {
      ownerId: 'forged-owner', dataSessionId, generation: 1, queryId,
      sql: 'select 1', params: [], maxRows: 100, maxBytes: 4096, timeoutMs: 5000,
    })
    await handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.scanRedisKeys)!(event, {
      ownerId: 'forged-owner', dataSessionId, generation: 1, cursor: '0', countHint: 50,
    })

    expect(observed).toEqual([
      expect.objectContaining({ op: 'open', ownerId, connectionId, expectedRevision: 3 }),
      expect.objectContaining({ op: 'query', ownerId, dataSessionId, generation: 1, queryId, sql: 'select 1' }),
      expect.objectContaining({ op: 'scan', ownerId, dataSessionId, generation: 1, cursor: '0' }),
    ])
  })

  it('rejects calls when event.sender is not mainWindow.webContents', async () => {
    registerManagedResourcesIpc({
      ipcMain: fakeIpcMain,
      getMainWindow: () => fakeMainWindow,
      services,
      expectedOwnerId: ownerId,
    })

    const foreignWebContents = { id: 999, mainFrame: fakeMainFrame }
    const event = { sender: foreignWebContents, senderFrame: fakeMainFrame }
    const handler = handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.listHosts)!

    const res = await handler(event, { ownerId })
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe('UNAUTHORIZED_OWNER')
  })

  it('rejects calls when event.senderFrame is not mainWindow.webContents.mainFrame (e.g. iframe)', async () => {
    registerManagedResourcesIpc({
      ipcMain: fakeIpcMain,
      getMainWindow: () => fakeMainWindow,
      services,
      expectedOwnerId: ownerId,
    })

    const iframe = { id: 2 }
    const event = { sender: fakeMainWebContents, senderFrame: iframe }
    const handler = handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.listHosts)!

    const res = await handler(event, { ownerId })
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe('UNAUTHORIZED_OWNER')
  })

  it('M2 listHosts ignores a forged ownerId in the payload and uses the canonical owner (F29-02)', async () => {
    registerManagedResourcesIpc({
      ipcMain: fakeIpcMain,
      getMainWindow: () => fakeMainWindow,
      services,
      expectedOwnerId: ownerId,
    })

    const event = { sender: fakeMainWebContents, senderFrame: fakeMainFrame }
    const handler = handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.listHosts)!

    // F29-02: payload.ownerId is untrusted input; the handler uses the
    // canonical owner resolved from `requireMainWindow()`. The forged value
    // is silently dropped, the request proceeds.
    const res = await handler(event, { ownerId: 'forged-owner-id' })
    expect(res.ok).toBe(true)
    expect(Array.isArray(res.data)).toBe(true)
  })

  it('rejects calls with invalid schema: unknown fields, wrong port, invalid uuid, overlong text', async () => {
    registerManagedResourcesIpc({
      ipcMain: fakeIpcMain,
      getMainWindow: () => fakeMainWindow,
      services,
      expectedOwnerId: ownerId,
    })

    const event = { sender: fakeMainWebContents, senderFrame: fakeMainFrame }
    const saveHostHandler = handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.saveHost)!

    // 1. Unknown field
    const unknownFieldRes = await saveHostHandler(event, {
      ownerId,
      name: 'Server 1',
      address: '192.168.1.1',
      port: 22,
      username: 'root',
      auth: { type: 'password', credentialId: null },
      tagIds: [],
      initialDirectory: null,
      applications: [],
      notes: '',
      maliciousUnknownField: 'injected',
    })
    expect(unknownFieldRes.ok).toBe(false)
    expect(unknownFieldRes.error.code).toBe('INVALID_ARGUMENT')

    // 2. Illegal port (0 or negative or > 65535)
    const badPortRes = await saveHostHandler(event, {
      ownerId,
      name: 'Server 1',
      address: '192.168.1.1',
      port: 70000,
      username: 'root',
      auth: { type: 'password', credentialId: null },
      tagIds: [],
      initialDirectory: null,
      applications: [],
      notes: '',
    })
    expect(badPortRes.ok).toBe(false)
    expect(badPortRes.error.code).toBe('INVALID_ARGUMENT')

    // 3. Illegal revision on update
    const badRevisionRes = await saveHostHandler(event, {
      ownerId,
      id: randomUUID(),
      expectedRevision: 0,
      changes: { name: 'New Name' },
    })
    expect(badRevisionRes.ok).toBe(false)
    expect(badRevisionRes.error.code).toBe('INVALID_ARGUMENT')
  })

  it('executes real repository round-trip: saveHost -> listHosts -> getHost -> update -> delete', async () => {
    registerManagedResourcesIpc({
      ipcMain: fakeIpcMain,
      getMainWindow: () => fakeMainWindow,
      services,
      expectedOwnerId: ownerId,
    })

    const event = { sender: fakeMainWebContents, senderFrame: fakeMainFrame }
    const saveHostHandler = handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.saveHost)!
    const listHostsHandler = handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.listHosts)!
    const getHostHandler = handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.getHost)!
    const deleteHostHandler = handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.deleteHost)!

    const testHost = {
      name: 'Production Worker',
      address: '10.0.0.5',
      port: 22,
      username: 'deploy',
      auth: { type: 'password', credentialId: null },
      tagIds: [],
      initialDirectory: '/var/log',
      applications: [],
      notes: 'Test host',
      id: randomUUID(),
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const directParse = HostSchema.safeParse(testHost)
    console.log('directParse success:', directParse.success, directParse.error?.issues)

    // 1. Create host
    const createRes = await saveHostHandler(event, {
      ownerId,
      name: 'Production Worker',
      address: '10.0.0.5',
      port: 22,
      username: 'deploy',
      auth: { type: 'password', credentialId: null },
      tagIds: [],
      initialDirectory: '/var/log',
      applications: [],
      notes: 'Test host',
    })

    console.log('createRes:', JSON.stringify(createRes))
    expect(createRes.ok).toBe(true)
    const createdHost = createRes.data
    expect(createdHost.name).toBe('Production Worker')
    expect(createdHost.revision).toBe(1)

    // 2. List hosts
    const listRes = await listHostsHandler(event, { ownerId })
    expect(listRes.ok).toBe(true)
    expect(listRes.data.length).toBe(1)
    expect(listRes.data[0].id).toBe(createdHost.id)

    // 3. Get host
    const getRes = await getHostHandler(event, { ownerId, id: createdHost.id })
    expect(getRes.ok).toBe(true)
    expect(getRes.data.address).toBe('10.0.0.5')

    // 4. Update with expectedRevision
    const updateRes = await saveHostHandler(event, {
      ownerId,
      id: createdHost.id,
      expectedRevision: 1,
      changes: { name: 'Production Worker Updated' },
    })
    expect(updateRes.ok).toBe(true)
    expect(updateRes.data.name).toBe('Production Worker Updated')
    expect(updateRes.data.revision).toBe(2)

    // 5. Stale expectedRevision returns REVISION_CONFLICT
    const staleRes = await saveHostHandler(event, {
      ownerId,
      id: createdHost.id,
      expectedRevision: 1,
      changes: { name: 'Should fail' },
    })
    expect(staleRes.ok).toBe(false)
    expect(staleRes.error.code).toBe('REVISION_CONFLICT')

    // 6. Delete host
    const deleteRes = await deleteHostHandler(event, {
      ownerId,
      id: createdHost.id,
      expectedRevision: 2,
    })
    expect(deleteRes.ok).toBe(true)

    // 7. Verify deleted
    const listAfterDelete = await listHostsHandler(event, { ownerId })
    expect(listAfterDelete.ok).toBe(true)
    expect(listAfterDelete.data.length).toBe(0)
  })

  it('invocations without ownerId in payload automatically bind trusted owner and succeed', async () => {
    registerManagedResourcesIpc({
      ipcMain: fakeIpcMain,
      getMainWindow: () => fakeMainWindow,
      services,
      expectedOwnerId: ownerId,
    })

    const event = { sender: fakeMainWebContents, senderFrame: fakeMainFrame }
    const listHostsHandler = handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.listHosts)!
    const getCapsHandler = handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.getCapabilities)!

    // No payload passed
    const capsRes = await getCapsHandler(event, undefined)
    expect(capsRes.ok).toBe(true)

    // Empty object passed
    const listRes = await listHostsHandler(event, {})
    expect(listRes.ok).toBe(true)
    expect(Array.isArray(listRes.data)).toBe(true)
  })

  it('supports saveConcept and deleteConcept lifecycle via IPC', async () => {
    registerManagedResourcesIpc({
      ipcMain: fakeIpcMain,
      getMainWindow: () => fakeMainWindow,
      services,
      expectedOwnerId: ownerId,
    })

    const event = { sender: fakeMainWebContents, senderFrame: fakeMainFrame }
    const saveConceptHandler = handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.saveConcept)!
    const getConceptHandler = handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.getConcept)!
    const listConceptsHandler = handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.listConcepts)!
    const deleteConceptHandler = handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.deleteConcept)!

    // Create Concept
    const createRes = await saveConceptHandler(event, {
      mode: 'create',
      title: 'Linux Boot Process',
      summary: 'GRUB -> Kernel -> Systemd',
      bodyMarkdown: '# Linux Boot\nDetails of the bootloader and init system.',
      tagIds: [],
      dependsOnIds: [],
      referenceIds: [],
    })
    expect(createRes.ok).toBe(true)
    const concept = createRes.data
    expect(concept.title).toBe('Linux Boot Process')
    expect(concept.revision).toBe(1)

    // Get Concept
    const getRes = await getConceptHandler(event, { id: concept.id })
    expect(getRes.ok).toBe(true)
    expect(getRes.data.title).toBe('Linux Boot Process')

    // Update Concept
    const updateRes = await saveConceptHandler(event, {
      mode: 'update',
      id: concept.id,
      expectedRevision: 1,
      changes: {
        title: 'Linux Boot Process (UEFI)',
      },
    })
    expect(updateRes.ok).toBe(true)
    expect(updateRes.data.title).toBe('Linux Boot Process (UEFI)')
    expect(updateRes.data.revision).toBe(2)

    // Delete Concept
    const deleteRes = await deleteConceptHandler(event, {
      id: concept.id,
      expectedRevision: 2,
    })
    expect(deleteRes.ok).toBe(true)

    // List Concepts verify empty
    const listRes = await listConceptsHandler(event, undefined)
    expect(listRes.ok).toBe(true)
    expect(listRes.data).toHaveLength(0)
  })
})

// ===========================================================================
// F29-02 鈥?M4 IPC owner + schema rework
// ---------------------------------------------------------------------------
// Every M4 channel uses an explicit strict Zod schema, resolves the canonical
// owner from `requireMainWindow()` BEFORE invoking the service, and never
// returns the local absolute path back to the renderer.
//
// Tests cover:
//   1. Renderer-supplied `ownerId: foreign-owner` is ignored; the service
//      receives the canonical owner.
//   2. Two-owner isolation: tokens / jobs / edits created by owner A cannot
//      be resolved / cancelled / fetched / closed by owner B.
//   3. Every M4 handler rejects unknown fields.
//   4. Identifier rules: bad UUIDs, negative generation, oversized remote
//      path, bad fileName (separators, drive letters, Windows-forbidden,
//      leading/trailing dots), and oversized text are rejected at the IPC
//      layer.
//   5. `resolveLocalToken` never returns the local absolute path.
// ===========================================================================

function makeFakeMainWindow(id: number) {
  const mainFrame = { id: id * 10 + 1 }
  const webContents = { id: id * 10 + 2, mainFrame }
  return { id, isDestroyed: () => false, webContents, mainFrame }
}

function makeEvent(window: any) {
  return { sender: window.webContents, senderFrame: window.mainFrame }
}

function makeFakeIpcMain() {
  const handlers = new Map<string, (event: any, payload: any) => Promise<any>>()
  return {
    handlers,
    handle(channel: string, handler: (event: any, payload: any) => Promise<any>) {
      handlers.set(channel, handler)
    },
    removeHandler(channel: string) {
      handlers.delete(channel)
    },
  }
}

async function buildM4Services(tempDir: string) {
  const store = createResourceDocumentStore({ activeConfigDir: tempDir })
  const libService = createResourceLibraryService({ store })
  const safeStorage = createFakeSafeStorage(true)
  const vault = createCredentialVault({ safeStorage })
  const credentialService = createCredentialRecordService({ store, vault })
  const selectionsRepo = createContextSelectionsRepository({ activeConfigDir: tempDir })
  const temporaryCredentials = createTemporaryCredentialStore()
  const sftpService = createSftpService({ resolveSession: () => { throw new Error('SFTP_UNAVAILABLE') }, tempDir })
  const localPathService = createLocalPathService({ userDataDir: tempDir })
  const transferService = createTransferService({
    resolveSession: () => { throw new Error('SFTP_UNAVAILABLE') },
    sftpService,
    localPathService,
  })
  const remoteEditService = createRemoteEditService({
    resolveSession: () => { throw new Error('SFTP_UNAVAILABLE') },
    sftpService,
    localPathService,
  })
  const services: ManagedResourcesServices = {
    store, libService, vault, credentialService, selectionsRepo,
    temporaryCredentials,
    knownHosts: createKnownHostsService(store),
    sshService: createSshSessionService({
      store, knownHosts: createKnownHostsService(store), vault,
      resolveTemporaryCredential: () => null,
    }),
    sftpService, localPathService, transferService, remoteEditService,
    dispose() { temporaryCredentials.dispose() },
  }
  return services
}

/**
 * Same services as `buildM4Services`, but the SFTP subsystem is an in-process
 * fake over a temp directory instead of a stub that always throws. Tests that
 * need REAL transfer/edit state (F30-03) use this builder so the state is
 * produced by `startDownload` / `startUpload` / `remoteEditService.open`.
 */
async function buildM4ServicesWithFakeSftp(
  tempDir: string,
  transport: FakeSftpTransport,
): Promise<ManagedResourcesServices> {
  const store = createResourceDocumentStore({ activeConfigDir: tempDir })
  const vault = createCredentialVault({ safeStorage: createFakeSafeStorage(true) })
  const temporaryCredentials = createTemporaryCredentialStore()
  const sftpService = createSftpService({ resolveSession: transport.resolveSession, tempDir })
  const localPathService = createLocalPathService({ userDataDir: tempDir })
  const services: ManagedResourcesServices = {
    store,
    libService: createResourceLibraryService({ store }),
    vault,
    credentialService: createCredentialRecordService({ store, vault }),
    selectionsRepo: createContextSelectionsRepository({ activeConfigDir: tempDir }),
    temporaryCredentials,
    knownHosts: createKnownHostsService(store),
    sshService: createSshSessionService({
      store, knownHosts: createKnownHostsService(store), vault,
      resolveTemporaryCredential: () => null,
    }),
    sftpService,
    localPathService,
    transferService: createTransferService({ resolveSession: transport.resolveSession, sftpService, localPathService }),
    remoteEditService: createRemoteEditService({ resolveSession: transport.resolveSession, sftpService, localPathService }),
    dispose() { temporaryCredentials.dispose() },
  }
  return services
}

describe('F29-02 — M4 IPC strict schema + canonical owner', () => {
  let tempDir: string
  let services: ManagedResourcesServices
  let ownerA: string
  let ownerB: string
  let windowA: any
  let windowB: any

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-m4-ipc-'))
    services = await buildM4Services(tempDir)
    windowA = makeFakeMainWindow(101)
    windowB = makeFakeMainWindow(202)
    ownerA = 'window-owner-101'
    ownerB = 'window-owner-202'
  })

  function registerFor(window: any, ownerId: string) {
    const ipc = makeFakeIpcMain()
    registerManagedResourcesIpc({
      ipcMain: ipc as any,
      getMainWindow: () => window as any,
      services,
      expectedOwnerId: ownerId,
    })
    return ipc
  }

  // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // (1) Forged ownerId in payload 鈥?canonical owner wins
  // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  it('mintUploadToken: payload ownerId is ignored, canonical owner mints', async () => {
    const ipc = registerFor(windowA, ownerA)
    const event = makeEvent(windowA)
    const handler = ipc.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.mintUploadToken)!

    const res = await handler(event, {
      ownerId: 'forged-attacker-owner',
      fileName: 'legit.txt',
    })
    expect(res.ok).toBe(true)
    // The token belongs to ownerA, NOT the forged owner.
    const resolved = services.localPathService.resolveToken(res.data.token, ownerA, 'upload-source')
    expect(resolved).toBe(res.data.absolutePath)
    expect(services.localPathService.resolveToken(res.data.token, 'forged-attacker-owner', 'upload-source')).toBeNull()
  })

  it('mintDownloadToken: payload ownerId is ignored, canonical owner mints', async () => {
    const ipc = registerFor(windowA, ownerA)
    const res = await ipc.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.mintDownloadToken)!(
      makeEvent(windowA),
      { ownerId: 'forged-owner', fileName: 'a.txt' },
    )
    expect(res.ok).toBe(true)
    expect(services.localPathService.resolveToken(res.data.token, ownerA, 'download-target')).toBe(res.data.absolutePath)
    expect(services.localPathService.resolveToken(res.data.token, 'forged-owner', 'download-target')).toBeNull()
  })

  it('resolveLocalToken: forged ownerId in payload is ignored', async () => {
    const ipc = registerFor(windowA, ownerA)
    const minted = await ipc.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.mintUploadToken)!(
      makeEvent(windowA),
      { ownerId: 'forged', fileName: 'a.txt' },
    )
    const res = await ipc.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.resolveLocalToken)!(
      makeEvent(windowA),
      { ownerId: 'forged', token: minted.data.token },
    )
    expect(res.ok).toBe(true)
  })

  it('revokeLocalToken: forged ownerId in payload is ignored', async () => {
    const ipc = registerFor(windowA, ownerA)
    const minted = await ipc.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.mintUploadToken)!(
      makeEvent(windowA),
      { fileName: 'a.txt' },
    )
    const res = await ipc.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.revokeLocalToken)!(
      makeEvent(windowA),
      { ownerId: 'forged-attacker', token: minted.data.token },
    )
    expect(res.ok).toBe(true)
    // The token is gone for ownerA (canonical). A "forged-attacker" payload
    // cannot block that.
    expect(services.localPathService.resolveToken(minted.data.token, ownerA, 'upload-source')).toBeNull()
  })

  it('sftpList: forged ownerId in payload is ignored (canonical owner is used)', async () => {
    const ipc = registerFor(windowA, ownerA)
    // The underlying sftpService throws SFTP_UNAVAILABLE because the session
    // shim throws. The important thing is the handler reaches the service
    // with canonical owner 鈥?i.e. it does NOT short-circuit on a forged
    // ownerId in the payload.
    const res = await ipc.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.sftpList)!(
      makeEvent(windowA),
      {
        ownerId: 'forged-owner',
        connectionId: randomUUID(),
        generation: 1,
        absolutePath: '/home/tester',
      },
    )
    expect(res.ok).toBe(false)
    // Service-level SFTP_UNAVAILABLE 鈥?the handler didn't reject on payload
    // ownerId.
    expect(res.error.code).not.toBe('UNAUTHORIZED_OWNER')
  })

  it('transferStartDownload/Upload: forged ownerId is dropped, canonical owner drives the job failure', async () => {
    const ipc = registerFor(windowA, ownerA)
    const event = makeEvent(windowA)
    const minted = await ipc.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.mintUploadToken)!(
      event,
      { fileName: 'src.bin' },
    )
    const jobId = randomUUID()
    const connId = randomUUID()

    // transferStartDownload: handler proceeds with canonical owner A; the
    // localToken was minted as upload-source (not download-target), so
    // resolveToken fails and the job is reported as failed with
    // INVALID_LOCAL_PATH.
    const downRes = await ipc.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.transferStartDownload)!(
      event,
      { ownerId: 'forged', jobId, connectionId: connId, generation: 1, remotePath: '/a', localToken: minted.data.token },
    )
    expect(downRes.ok).toBe(true)
    expect(downRes.data.state).toBe('failed')
    expect(downRes.data.error.code).toBe('INVALID_LOCAL_PATH')

    // transferStartUpload: handler proceeds with canonical owner A; the
    // SFTP subsystem throws SFTP_UNAVAILABLE because the test session shim
    // is a stub. The job fails with INTERNAL_ERROR, not UNAUTHORIZED_OWNER.
    const upRes = await ipc.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.transferStartUpload)!(
      event,
      { ownerId: 'forged', jobId: randomUUID(), connectionId: connId, generation: 1, remotePath: '/a', localToken: minted.data.token },
    )
    expect(upRes.ok).toBe(true)
    expect(upRes.data.state).toBe('failed')
    expect(upRes.data.error.code).not.toBe('UNAUTHORIZED_OWNER')
  })

  it('transferCancel/Get: forged ownerId in payload is dropped, canonical owner sees RESOURCE_NOT_FOUND', async () => {
    const ipc = registerFor(windowA, ownerA)
    const event = makeEvent(windowA)
    const jobId = randomUUID()

    const cancelRes = await ipc.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.transferCancel)!(
      event,
      { ownerId: 'forged', jobId },
    )
    expect(cancelRes.ok).toBe(false)
    expect(cancelRes.error.code).toBe('RESOURCE_NOT_FOUND')

    const getRes = await ipc.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.transferGet)!(
      event,
      { ownerId: 'forged', jobId },
    )
    expect(getRes.ok).toBe(false)
    expect(getRes.error.code).toBe('RESOURCE_NOT_FOUND')
  })

  it('remoteEdit open/save/close: forged ownerId in payload is ignored', async () => {
    const ipc = registerFor(windowA, ownerA)
    const event = makeEvent(windowA)
    const connId = randomUUID()
    const openRes = await ipc.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.remoteEditOpen)!(
      event,
      { ownerId: 'forged', connectionId: connId, generation: 1, absolutePath: '/home/tester/file.txt' },
    )
    expect(openRes.ok).toBe(false)
    expect(openRes.error.code).not.toBe('UNAUTHORIZED_OWNER')

    const saveRes = await ipc.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.remoteEditSave)!(
      event,
      { ownerId: 'forged', editId: randomUUID(), baseRevision: 'rev-1', text: 'x' },
    )
    expect(saveRes.ok).toBe(false)
    expect(saveRes.error.code).not.toBe('UNAUTHORIZED_OWNER')

    const closeRes = await ipc.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.remoteEditClose)!(
      event,
      { ownerId: 'forged', editId: randomUUID() },
    )
    expect(closeRes.ok).toBe(false)
    expect(closeRes.error.code).not.toBe('UNAUTHORIZED_OWNER')
  })

  // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // (2) Two-owner isolation 鈥?separate IPC registrations share services
  // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  it('two-owner token isolation: owner B cannot resolve or revoke owner A tokens', async () => {
    const ipcA = registerFor(windowA, ownerA)
    const ipcB = registerFor(windowB, ownerB)
    const eventA = makeEvent(windowA)
    const eventB = makeEvent(windowB)

    // Owner A mints two tokens
    const aUpload = await ipcA.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.mintUploadToken)!(
      eventA, { fileName: 'a.txt' },
    )
    const aDownload = await ipcA.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.mintDownloadToken)!(
      eventA, { fileName: 'b.txt' },
    )

    // Owner B mints its own (sanity: not blocked)
    const bUpload = await ipcB.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.mintUploadToken)!(
      eventB, { fileName: 'c.txt' },
    )
    expect(bUpload.ok).toBe(true)

    // Owner B tries to resolve owner A's upload token: must fail
    const bResolveA = await ipcB.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.resolveLocalToken)!(
      eventB, { token: aUpload.data.token },
    )
    expect(bResolveA.ok).toBe(false)
    expect(bResolveA.error.code).toBe('UNAUTHORIZED_OWNER')

    // Owner B tries to revoke owner A's download token: must be a no-op (handler
    // resolves canonical owner=B, who doesn't own the token, so revokeToken
    // silently does nothing). After B's revoke call, A's token still resolves.
    const bRevokeA = await ipcB.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.revokeLocalToken)!(
      eventB, { token: aDownload.data.token },
    )
    expect(bRevokeA.ok).toBe(true) // it returns ok because revoke is idempotent
    // Owner A still owns their token because canonical owner B was used.
    const aStillHasDownload = services.localPathService.resolveToken(
      aDownload.data.token, ownerA, 'download-target',
    )
    expect(aStillHasDownload).toBe(aDownload.data.absolutePath)
  })

  // The two-owner transfer / remote-edit isolation tests that used to live
  // here injected pre-authorized state through `TransferService.__seedJobForTest`
  // and `RemoteEditService.__seedEditForTest`, which proved nothing about the
  // real token -> transfer and open -> save -> close chains (audit finding
  // F30-03). Those seed helpers no longer exist on the production types; the
  // coverage now runs against state created by the registered handlers in the
  // "F30-03 - M4 owner isolation on real service state" describe below.

  it('rejects unknown fields on every M4 channel', async () => {
    const ipc = registerFor(windowA, ownerA)
    const event = makeEvent(windowA)
    const cases: Array<[string, Record<string, unknown>]> = [
      [MANAGED_RESOURCES_IPC_CHANNELS.mintUploadToken, { fileName: 'a.txt', bogus: 1 }],
      [MANAGED_RESOURCES_IPC_CHANNELS.mintDownloadToken, { fileName: 'a.txt', bogus: 1 }],
      [MANAGED_RESOURCES_IPC_CHANNELS.resolveLocalToken, { token: randomUUID(), bogus: 1 }],
      [MANAGED_RESOURCES_IPC_CHANNELS.revokeLocalToken, { token: randomUUID(), bogus: 1 }],
      [MANAGED_RESOURCES_IPC_CHANNELS.sftpList, { connectionId: randomUUID(), generation: 1, absolutePath: '/home/tester', bogus: 1 }],
      [MANAGED_RESOURCES_IPC_CHANNELS.sftpStat, { connectionId: randomUUID(), generation: 1, absolutePath: '/home/tester', bogus: 1 }],
      [MANAGED_RESOURCES_IPC_CHANNELS.transferStartDownload, { jobId: randomUUID(), connectionId: randomUUID(), generation: 1, remotePath: '/home/tester', localToken: randomUUID(), bogus: 1 }],
      [MANAGED_RESOURCES_IPC_CHANNELS.transferStartUpload, { jobId: randomUUID(), connectionId: randomUUID(), generation: 1, remotePath: '/home/tester', localToken: randomUUID(), bogus: 1 }],
      [MANAGED_RESOURCES_IPC_CHANNELS.transferCancel, { jobId: randomUUID(), bogus: 1 }],
      [MANAGED_RESOURCES_IPC_CHANNELS.transferGet, { jobId: randomUUID(), bogus: 1 }],
      [MANAGED_RESOURCES_IPC_CHANNELS.remoteEditOpen, { connectionId: randomUUID(), generation: 1, absolutePath: '/home/tester', bogus: 1 }],
      [MANAGED_RESOURCES_IPC_CHANNELS.remoteEditSave, { editId: randomUUID(), baseRevision: 'rev-1', text: 'x', bogus: 1 }],
      [MANAGED_RESOURCES_IPC_CHANNELS.remoteEditClose, { editId: randomUUID(), bogus: 1 }],
    ]
    for (const [channel, payload] of cases as Array<[string, Record<string, unknown>]>) {
      const res = await ipc.handlers.get(channel)!(event, payload)
      expect(res.ok, `unknown field not rejected on ${channel}`).toBe(false)
      expect(res.error.code, `unknown field not rejected on ${channel}`).toBe('INVALID_ARGUMENT')
    }
  })

  // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // (4) Identifier rules 鈥?bad UUIDs, negative generation, oversized path,
  //     bad fileName, oversized text are rejected at IPC
  // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  it('rejects non-UUID connectionId / jobId / editId / token / localToken', async () => {
    const ipc = registerFor(windowA, ownerA)
    const event = makeEvent(windowA)
    const cases: Array<[string, Record<string, unknown>]> = [
      [MANAGED_RESOURCES_IPC_CHANNELS.sftpList, { connectionId: 'not-a-uuid', generation: 1, absolutePath: '/x' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.sftpStat, { connectionId: 'not-a-uuid', generation: 1, absolutePath: '/x' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.transferStartDownload, { jobId: 'not-a-uuid', connectionId: randomUUID(), generation: 1, remotePath: '/x', localToken: randomUUID() }],
      [MANAGED_RESOURCES_IPC_CHANNELS.transferStartUpload, { jobId: 'not-a-uuid', connectionId: randomUUID(), generation: 1, remotePath: '/x', localToken: randomUUID() }],
      [MANAGED_RESOURCES_IPC_CHANNELS.transferCancel, { jobId: 'not-a-uuid' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.transferGet, { jobId: 'not-a-uuid' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.remoteEditOpen, { connectionId: 'not-a-uuid', generation: 1, absolutePath: '/x' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.remoteEditSave, { editId: 'not-a-uuid', baseRevision: 'rev', text: 'x' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.remoteEditClose, { editId: 'not-a-uuid' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.resolveLocalToken, { token: 'not-a-uuid' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.revokeLocalToken, { token: 'not-a-uuid' }],
    ]
    for (const [channel, payload] of cases as Array<[string, Record<string, unknown>]>) {
      const res = await ipc.handlers.get(channel)!(event, payload)
      expect(res.ok, `bad UUID not rejected on ${channel}`).toBe(false)
      expect(res.error.code, `bad UUID not rejected on ${channel}`).toBe('INVALID_ARGUMENT')
    }
  })

  it('rejects negative or zero generation on list/stat/edit/transfer', async () => {
    const ipc = registerFor(windowA, ownerA)
    const event = makeEvent(windowA)
    const cases: Array<[string, Record<string, unknown>]> = [
      [MANAGED_RESOURCES_IPC_CHANNELS.sftpList, { connectionId: randomUUID(), generation: 0, absolutePath: '/x' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.sftpStat, { connectionId: randomUUID(), generation: -1, absolutePath: '/x' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.transferStartDownload, { jobId: randomUUID(), connectionId: randomUUID(), generation: 0, remotePath: '/x', localToken: randomUUID() }],
      [MANAGED_RESOURCES_IPC_CHANNELS.transferStartUpload, { jobId: randomUUID(), connectionId: randomUUID(), generation: -1, remotePath: '/x', localToken: randomUUID() }],
      [MANAGED_RESOURCES_IPC_CHANNELS.remoteEditOpen, { connectionId: randomUUID(), generation: 0, absolutePath: '/x' }],
    ]
    for (const [channel, payload] of cases as Array<[string, Record<string, unknown>]>) {
      const res = await ipc.handlers.get(channel)!(event, payload)
      expect(res.ok, `bad generation not rejected on ${channel}`).toBe(false)
      expect(res.error.code).toBe('INVALID_ARGUMENT')
    }
  })

  it('rejects non-absolute, empty, NUL, double-slash, and oversized remote/absolute paths', async () => {
    const ipc = registerFor(windowA, ownerA)
    const event = makeEvent(windowA)
    const oversized = '/' + 'a'.repeat(4097)
    const cases: Array<[string, Record<string, unknown>]> = [
      [MANAGED_RESOURCES_IPC_CHANNELS.sftpList, { connectionId: randomUUID(), generation: 1, absolutePath: 'relative/path' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.sftpList, { connectionId: randomUUID(), generation: 1, absolutePath: '' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.sftpList, { connectionId: randomUUID(), generation: 1, absolutePath: '/has-nul-\u0000-byte' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.sftpList, { connectionId: randomUUID(), generation: 1, absolutePath: '/double//slash' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.sftpList, { connectionId: randomUUID(), generation: 1, absolutePath: oversized }],
      [MANAGED_RESOURCES_IPC_CHANNELS.sftpStat, { connectionId: randomUUID(), generation: 1, absolutePath: 'no-leading-slash' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.transferStartDownload, { jobId: randomUUID(), connectionId: randomUUID(), generation: 1, remotePath: '/has-nul-\u0000', localToken: randomUUID() }],
      [MANAGED_RESOURCES_IPC_CHANNELS.transferStartDownload, { jobId: randomUUID(), connectionId: randomUUID(), generation: 1, remotePath: 'no-slash', localToken: randomUUID() }],
      [MANAGED_RESOURCES_IPC_CHANNELS.transferStartUpload, { jobId: randomUUID(), connectionId: randomUUID(), generation: 1, remotePath: '/double//slash', localToken: randomUUID() }],
      [MANAGED_RESOURCES_IPC_CHANNELS.remoteEditOpen, { connectionId: randomUUID(), generation: 1, absolutePath: oversized }],
    ]
    for (const [channel, payload] of cases as Array<[string, Record<string, unknown>]>) {
      const res = await ipc.handlers.get(channel)!(event, payload)
      expect(res.ok, `bad path not rejected on ${channel}`).toBe(false)
      expect(res.error.code, `bad path not rejected on ${channel}`).toBe('INVALID_ARGUMENT')
    }
  })

  it('rejects bad fileName: empty, oversized, separators, drive letter, NUL, Windows-forbidden, dot segments and trailing dot', async () => {
    const ipc = registerFor(windowA, ownerA)
    const event = makeEvent(windowA)
    const oversized = 'a'.repeat(256)
    const cases: Array<[string, Record<string, unknown>]> = [
      [MANAGED_RESOURCES_IPC_CHANNELS.mintUploadToken, { fileName: '' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.mintUploadToken, { fileName: oversized }],
      [MANAGED_RESOURCES_IPC_CHANNELS.mintUploadToken, { fileName: 'a/b.txt' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.mintUploadToken, { fileName: 'a\\b.txt' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.mintUploadToken, { fileName: 'C:/abs.txt' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.mintUploadToken, { fileName: 'has-nul-\u0000.txt' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.mintUploadToken, { fileName: 'has<lt.txt' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.mintUploadToken, { fileName: 'has>gt.txt' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.mintUploadToken, { fileName: 'has:colon.txt' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.mintUploadToken, { fileName: 'has|pipe.txt' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.mintUploadToken, { fileName: 'has?q.txt' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.mintUploadToken, { fileName: 'has*star.txt' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.mintUploadToken, { fileName: '.' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.mintUploadToken, { fileName: '..' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.mintUploadToken, { fileName: 'NUL.txt' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.mintUploadToken, { fileName: 'trailing.' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.mintDownloadToken, { fileName: 'a/b.txt' }],
      [MANAGED_RESOURCES_IPC_CHANNELS.mintDownloadToken, { fileName: 'C:\\abs.txt' }],
    ]
    for (const [channel, payload] of cases as Array<[string, Record<string, unknown>]>) {
      const res = await ipc.handlers.get(channel)!(event, payload)
      expect(res.ok, `bad fileName not rejected on ${channel}`).toBe(false)
      expect(res.error.code, `bad fileName not rejected on ${channel}`).toBe('INVALID_ARGUMENT')
    }
  })

  it('accepts hidden Shell configuration filenames through the real token handlers', async () => {
    const ipc = registerFor(windowA, ownerA)
    const event = makeEvent(windowA)
    for (const fileName of ['.hidden', '.bashrc', '.profile']) {
      const result = await ipc.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.mintUploadToken)!(event, { fileName })
      expect(result.ok).toBe(true)
      expect(path.basename(result.data.absolutePath).endsWith(`__${fileName}`)).toBe(true)
    }
  })

  it('rejects oversized text on remoteEditSave', async () => {
    const ipc = registerFor(windowA, ownerA)
    const event = makeEvent(windowA)
    // 3 MiB of 'a' 鈥?exceeds the 2 MiB UTF-8 cap.
    const oversized = 'a'.repeat(3 * 1024 * 1024)
    const res = await ipc.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.remoteEditSave)!(
      event,
      { editId: randomUUID(), baseRevision: 'rev-1', text: oversized },
    )
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe('INVALID_ARGUMENT')
  })

  it('rejects NUL byte in edit text and edit baseRevision', async () => {
    const ipc = registerFor(windowA, ownerA)
    const event = makeEvent(windowA)
    const nulText = await ipc.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.remoteEditSave)!(
      event,
      { editId: randomUUID(), baseRevision: 'rev-1', text: 'has\u0000nul' },
    )
    expect(nulText.ok).toBe(false)
    expect(nulText.error.code).toBe('INVALID_ARGUMENT')

    const emptyBase = await ipc.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.remoteEditSave)!(
      event,
      { editId: randomUUID(), baseRevision: '', text: 'x' },
    )
    expect(emptyBase.ok).toBe(false)
    expect(emptyBase.error.code).toBe('INVALID_ARGUMENT')
  })

  // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // (5) resolveLocalToken never returns the local absolute path
  // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  it('resolveLocalToken returns only { ok: true, token } 鈥?never the absolute path', async () => {
    const ipc = registerFor(windowA, ownerA)
    const event = makeEvent(windowA)
    const minted = await ipc.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.mintUploadToken)!(
      event, { fileName: 'leak-check.bin' },
    )
    expect(minted.ok).toBe(true)
    expect(typeof minted.data.token).toBe('string')
    // The mint response itself includes `absolutePath` because the local
    // path service hands it out for the renderer's internal UI display.
    // What MUST NOT happen is the resolveLocalToken handler echoing it back.
    const res = await ipc.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.resolveLocalToken)!(
      event, { token: minted.data.token },
    )
    expect(res.ok).toBe(true)
    expect(res.data).toEqual({ ok: true, token: minted.data.token })
    expect(res.data.absolutePath).toBeUndefined()
    expect(res.data.path).toBeUndefined()
    // Serialized output contains no managed-resources landing dir segment
    const json = JSON.stringify(res.data)
    expect(json).not.toMatch(/managed-resources[\\/]transfers/)
    expect(json).not.toContain(tempDir.replace(/\\/g, '\\\\'))
  })

  it('resolveLocalToken returns UNAUTHORIZED_OWNER for a foreign owner\'s token', async () => {
    const ipcA = registerFor(windowA, ownerA)
    const ipcB = registerFor(windowB, ownerB)
    const eventA = makeEvent(windowA)
    const eventB = makeEvent(windowB)

    const aToken = await ipcA.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.mintUploadToken)!(
      eventA, { fileName: 'a.bin' },
    )

    // Owner B resolves owner A's token: must be UNAUTHORIZED_OWNER and never
    // echo a path.
    const bResolve = await ipcB.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.resolveLocalToken)!(
      eventB, { token: aToken.data.token },
    )
    expect(bResolve.ok).toBe(false)
    expect(bResolve.error.code).toBe('UNAUTHORIZED_OWNER')
    expect(bResolve.data).toBeUndefined()
  })
})

// ===========================================================================
// F29-02 鈥?M3 SSH isolation regression (must remain green)
// ===========================================================================

describe('F29-02 鈥?M3 SSH owner isolation still enforced', () => {
  let tempDir: string
  let services: ManagedResourcesServices

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-m3-regress-'))
    services = await buildM4Services(tempDir)
  })

  it('rejects IPC callers with mismatched ownerId on M3 SSH handlers (createConnection)', async () => {
    const fakeMainWindow = makeFakeMainWindow(303)
    const fakeIpcMain = makeFakeIpcMain()
    registerManagedResourcesIpc({
      ipcMain: fakeIpcMain as any,
      getMainWindow: () => fakeMainWindow as any,
      services,
      expectedOwnerId: 'window-owner-303',
    })
    const event = makeEvent(fakeMainWindow)
    const handler = fakeIpcMain.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.createConnection)!

    // Forged ownerId in payload: handler rejects as UNAUTHORIZED_OWNER
    const res = await handler(event, {
      ownerId: 'attacker',
      hostId: randomUUID(),
    })
    // F29-02: forged ownerId is dropped; canonical owner is used; the hostId
    // does not exist, so the service returns RESOURCE_NOT_FOUND.
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe('RESOURCE_NOT_FOUND')
  })

  it('rejects IPC callers whose event.senderFrame is not the main frame', async () => {
    const fakeMainWindow = makeFakeMainWindow(404)
    const fakeIpcMain = makeFakeIpcMain()
    registerManagedResourcesIpc({
      ipcMain: fakeIpcMain as any,
      getMainWindow: () => fakeMainWindow as any,
      services,
      expectedOwnerId: 'window-owner-404',
    })
    const event = {
      sender: fakeMainWindow.webContents,
      senderFrame: { id: 999 }, // foreign frame
    }
    const handler = fakeIpcMain.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.createConnection)!
    const res = await handler(event, { ownerId: 'window-owner-404', hostId: randomUUID() })
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe('UNAUTHORIZED_OWNER')
  })
})

// ===========================================================================
// F30-03 - M4 owner isolation on real service state (no seed APIs)
//
// Every job and edit session below is created by the registered IPC handler
// through the real service code path, against an in-process fake SFTP
// transport. That is what the audit asked for: prove the token -> transfer and
// open -> save -> close wiring, not that a map lookup rejects a foreign owner.
// ===========================================================================

describe('F30-03 - M4 owner isolation on real service state', () => {
  let tempDir: string
  let transport: FakeSftpTransport
  let services: ManagedResourcesServices
  let windowA: any
  let windowB: any
  const ownerA = 'window-owner-real-a'
  const ownerB = 'window-owner-real-b'

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-m4-real-'))
    transport = await createFakeSftpTransport()
    services = await buildM4ServicesWithFakeSftp(tempDir, transport)
    windowA = makeFakeMainWindow(501)
    windowB = makeFakeMainWindow(602)
  })

  afterEach(async () => {
    await transport.dispose()
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  })

  function registerFor(window: any, ownerId: string) {
    const ipc = makeFakeIpcMain()
    registerManagedResourcesIpc({
      ipcMain: ipc as any,
      getMainWindow: () => window as any,
      services,
      expectedOwnerId: ownerId,
    })
    return ipc
  }

  it('owner B cannot get or cancel jobs owner A created through start-download/start-upload', async () => {
    await transport.seedFile('/home/tester/remote.bin', 'remote-payload')

    const ipcA = registerFor(windowA, ownerA)
    const ipcB = registerFor(windowB, ownerB)
    const eventA = makeEvent(windowA)
    const eventB = makeEvent(windowB)

    // Owner A runs a real download: mint -> token resolve -> stat -> fastGet ->
    // sha256 -> size check -> atomic rename.
    const downloadToken = await ipcA.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.mintDownloadToken)!(
      eventA, { fileName: 'remote.bin' },
    )
    expect(downloadToken.ok).toBe(true)
    const downloadJobId = randomUUID()
    const downloadRes = await ipcA.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.transferStartDownload)!(
      eventA,
      {
        jobId: downloadJobId,
        connectionId: randomUUID(),
        generation: 1,
        remotePath: '/home/tester/remote.bin',
        localToken: downloadToken.data.token,
      },
    )
    expect(downloadRes.ok).toBe(true)
    expect(downloadRes.data.state).toBe('completed')
    expect(downloadRes.data.ownerId).toBe(ownerA)
    expect((await fs.readFile(downloadToken.data.absolutePath)).toString('utf8')).toBe('remote-payload')

    // Owner A runs a real upload of a local file into the fake remote.
    const uploadToken = await ipcA.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.mintUploadToken)!(
      eventA, { fileName: 'local.bin' },
    )
    expect(uploadToken.ok).toBe(true)
    await fs.writeFile(uploadToken.data.absolutePath, 'local-payload')
    const uploadJobId = randomUUID()
    const uploadRes = await ipcA.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.transferStartUpload)!(
      eventA,
      {
        jobId: uploadJobId,
        connectionId: randomUUID(),
        generation: 1,
        remotePath: '/home/tester/uploaded.bin',
        localToken: uploadToken.data.token,
      },
    )
    expect(uploadRes.ok).toBe(true)
    expect(uploadRes.data.state).toBe('completed')
    expect(uploadRes.data.ownerId).toBe(ownerA)
    expect((await transport.readFile('/home/tester/uploaded.bin')).toString('utf8')).toBe('local-payload')
    // The .part file was renamed, not left behind.
    expect(await transport.fileExists('/home/tester/uploaded.bin.part')).toBe(false)

    for (const jobId of [downloadJobId, uploadJobId]) {
      // Owner B cannot fetch it.
      const bGet = await ipcB.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.transferGet)!(eventB, { jobId })
      expect(bGet.ok).toBe(false)
      expect(bGet.error.code).toBe('RESOURCE_NOT_FOUND')

      // Owner B cannot cancel it: the job exists (owner A reads it below) and
      // belongs to someone else.
      const bCancel = await ipcB.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.transferCancel)!(eventB, { jobId })
      expect(bCancel.ok).toBe(false)
      expect(bCancel.error.code).toBe('UNAUTHORIZED_OWNER')

      // Owner A's job survived the rejected cross-owner cancel.
      const aGet = await ipcA.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.transferGet)!(eventA, { jobId })
      expect(aGet.ok).toBe(true)
      expect(aGet.data.id).toBe(jobId)
      expect(aGet.data.state).toBe('completed')
    }
  })

  it('owner B cannot save or close the edit session owner A opened, and owner A can finish it', async () => {
    await transport.seedFile('/home/tester/notes.txt', 'hello\n')

    const ipcA = registerFor(windowA, ownerA)
    const ipcB = registerFor(windowB, ownerB)
    const eventA = makeEvent(windowA)
    const eventB = makeEvent(windowB)

    const openRes = await ipcA.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.remoteEditOpen)!(
      eventA,
      { connectionId: randomUUID(), generation: 1, absolutePath: '/home/tester/notes.txt' },
    )
    expect(openRes.ok).toBe(true)
    expect(openRes.data.edit.ownerId).toBe(ownerA)
    expect(openRes.data.edit.text).toBe('hello\n')
    const editId = openRes.data.edit.id
    const baseRevision = openRes.data.edit.baseRevision
    expect(typeof baseRevision).toBe('string')

    // Owner B is rejected on both follow-up operations...
    const bSave = await ipcB.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.remoteEditSave)!(
      eventB, { editId, baseRevision, text: 'stolen\n' },
    )
    expect(bSave.ok).toBe(false)
    expect(bSave.error.code).toBe('UNAUTHORIZED_OWNER')

    const bClose = await ipcB.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.remoteEditClose)!(eventB, { editId })
    expect(bClose.ok).toBe(false)
    expect(bClose.error.code).toBe('UNAUTHORIZED_OWNER')

    // ...and the rejected write left the remote file untouched.
    expect((await transport.readFile('/home/tester/notes.txt')).toString('utf8')).toBe('hello\n')

    // Owner A completes the chain: save (draft -> sha256 -> atomic rename), then close.
    const aSave = await ipcA.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.remoteEditSave)!(
      eventA, { editId, baseRevision, text: 'hello from A\n' },
    )
    expect(aSave.ok).toBe(true)
    expect((await transport.readFile('/home/tester/notes.txt')).toString('utf8')).toBe('hello from A\n')
    expect(await transport.fileExists('/home/tester/notes.txt.editdraft')).toBe(false)

    const aClose = await ipcA.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.remoteEditClose)!(eventA, { editId })
    expect(aClose.ok).toBe(true)

    // A session that never existed would also reject owner B, so prove the
    // session is gone for its own owner after close.
    const aSaveAfterClose = await ipcA.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.remoteEditSave)!(
      eventA, { editId, baseRevision, text: 'after close\n' },
    )
    expect(aSaveAfterClose.ok).toBe(false)
    expect(aSaveAfterClose.error.code).toBe('RESOURCE_NOT_FOUND')
  })
})
