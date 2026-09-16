import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { registerManagedResourcesIpc, type ManagedResourcesServices } from '../../../../electron/services/managedResources/registerIpc.js'
import { createResourceDocumentStore } from '../../../../electron/services/managedResources/repositories/resourceDocumentStore.js'
import { createResourceLibraryService } from '../../../../electron/services/managedResources/repositories/resourceLibraryService.js'
import { createCredentialVault, createTemporaryCredentialStore } from '../../../../electron/services/managedResources/vault/credentialVault.js'
import { createCredentialRecordService } from '../../../../electron/services/managedResources/vault/credentialRecordService.js'
import { createContextSelectionsRepository } from '../../../../electron/services/managedResources/contextSelections/contextSelectionsRepository.js'
import { createKnownHostsService } from '../../../../electron/services/managedResources/knownHosts.js'
import { createSshSessionService } from '../../../../electron/services/managedResources/sshSessionService.js'
import { createLocalPathService, createSftpService, createTransferService, createRemoteEditService } from '../../../../electron/services/managedResources/sftpService.js'
import { createElectronHost } from '../../../lib/desktopHost/electronHost.js'
import { useHostManagementStore } from '../stores/hostManagementStore.js'

function createFakeSafeStorage() {
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

describe('M2 Workbench Cross-Layer Join: Store -> DesktopHost -> IPC Bridge -> Repository', () => {
  let tempDir: string
  let unregisterIpc: () => void
  let services: ManagedResourcesServices

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-ipc-join-test-'))

    const store = createResourceDocumentStore({ activeConfigDir: tempDir })
    const libService = createResourceLibraryService({ store })
    const safeStorage = createFakeSafeStorage()
    const vault = createCredentialVault({ safeStorage })
    const credentialService = createCredentialRecordService({ store, vault })
    const selectionsRepo = createContextSelectionsRepository({ activeConfigDir: tempDir })
    const temporaryCredentials = createTemporaryCredentialStore()
    const localPathService = createLocalPathService({ userDataDir: tempDir })

    services = {
      store,
      libService,
      vault,
      credentialService,
      selectionsRepo,
      temporaryCredentials,
      localPathService,
      knownHosts: createKnownHostsService(store),
      sshService: createSshSessionService({
        store,
        knownHosts: createKnownHostsService(store),
        vault,
        resolveTemporaryCredential: () => null,
      }),
      sftpService: createSftpService({ resolveSession: () => { throw new Error('SFTP_UNAVAILABLE') }, tempDir }),
      transferService: createTransferService({
        resolveSession: () => { throw new Error('SFTP_UNAVAILABLE') },
        sftpService: createSftpService({ resolveSession: () => { throw new Error('SFTP_UNAVAILABLE') }, tempDir }),
        localPathService,
      }),
      remoteEditService: createRemoteEditService({
        resolveSession: () => { throw new Error('SFTP_UNAVAILABLE') },
        sftpService: createSftpService({ resolveSession: () => { throw new Error('SFTP_UNAVAILABLE') }, tempDir }),
        localPathService,
      }),
      dispose() {
        temporaryCredentials.dispose()
      },
    }

    // IPC Main stub simulating Electron ipcMain
    const ipcHandlers = new Map<string, (event: any, payload: any) => Promise<any>>()
    const fakeIpcMain: any = {
      handle(channel: string, handler: any) {
        ipcHandlers.set(channel, handler)
      },
      removeHandler(channel: string) {
        ipcHandlers.delete(channel)
      },
    }

    const fakeMainFrame = { id: 1 }
    const fakeWebContents = {
      id: 42,
      mainFrame: fakeMainFrame,
    }
    const fakeMainWindow: any = {
      id: 99,
      isDestroyed: () => false,
      webContents: fakeWebContents,
    }

    unregisterIpc = registerManagedResourcesIpc({
      ipcMain: fakeIpcMain,
      getMainWindow: () => fakeMainWindow,
      services,
    })

    // Preload / IPC Bridge layer: sends invocation with trusted sender and senderFrame
    const bridgeInvoke = async (channel: string, payload?: unknown) => {
      const handler = ipcHandlers.get(channel)
      if (!handler) throw new Error(`No IPC handler registered for channel: ${channel}`)
      const event = {
        sender: fakeWebContents,
        senderFrame: fakeMainFrame,
      }
      return handler(event, payload)
    }

    // Create real Electron DesktopHost connected to this bridge
    const host = createElectronHost({
      invoke: bridgeInvoke,
      subscribe: async () => () => {},
    })
    if (typeof window === 'undefined') {
      ;
      (globalThis as any).window = globalThis
    }
    window.desktopHost = host

    // Reset store state
    useHostManagementStore.setState({
      hosts: [],
      tags: [],
      selectedHostId: null,
      selectedTagId: null,
      searchQuery: '',
      loading: false,
      error: null,
    })
  })

  afterEach(async () => {
    unregisterIpc?.()
    services?.dispose()
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('loads initial data from real repository with no ownerId passed by renderer', async () => {
    const storeState = useHostManagementStore.getState()
    await storeState.fetchCapabilities()
    await storeState.fetchHosts()
    await storeState.fetchTags()

    const updated = useHostManagementStore.getState()
    expect(updated.loading).toBe(false)
    expect(updated.error).toBeNull()
    expect(updated.capabilities?.vaultAvailable).toBe(true)
    expect(updated.hosts).toEqual([])
    expect(updated.tags).toEqual([])
  })

  it('completes full host & tag CRUD lifecycle across the entire architecture seam', async () => {
    const store = useHostManagementStore.getState()
    await store.fetchCapabilities()
    await store.fetchHosts()
    await store.fetchTags()

    // 1. Create Tag via Store Action -> DesktopHost -> IPC -> LibService -> Store -> Disk
    const tagRes = await store.saveTag({
      namespace: 'host',
      name: 'Production Web',
      colorToken: 'teal',
    })
    expect(tagRes.success).toBe(true)

    // Verify tag exists in store and on disk
    expect(useHostManagementStore.getState().tags).toHaveLength(1)
    const tag = useHostManagementStore.getState().tags[0]!
    expect(tag.name).toBe('Production Web')

    const diskDoc1 = await services.store.load()
    expect(diskDoc1.status).toBe('ready')
    if (diskDoc1.status === 'ready') {
      expect(diskDoc1.document.tags).toHaveLength(1)
      expect(diskDoc1.document.tags[0]!.name).toBe('Production Web')
    }

    // 2. Create Host via Store Action
    const hostRes = await store.saveHost({
      name: 'web-prod-01',
      address: '10.0.1.15',
      port: 22,
      username: 'deploy',
      auth: {
        type: 'password',
        credentialId: null,
      },
      tagIds: [tag.id],
      initialDirectory: '/var/www/app',
      applications: [],
      notes: 'Primary web frontend',
    })
    expect(hostRes.success).toBe(true)

    expect(useHostManagementStore.getState().hosts).toHaveLength(1)
    const host = useHostManagementStore.getState().hosts[0]!
    expect(host.name).toBe('web-prod-01')
    expect(host.address).toBe('10.0.1.15')
    expect(host.tagIds).toEqual([tag.id])

    // 3. Update Host via Store Action
    const updateRes = await store.saveHost({
      id: host.id,
      expectedRevision: host.revision,
      changes: {
        name: 'web-prod-01-renamed',
        port: 2222,
      },
    })
    expect(updateRes.success).toBe(true)

    const updatedHost = useHostManagementStore.getState().hosts.find(h => h.id === host.id)!
    expect(updatedHost.name).toBe('web-prod-01-renamed')
    expect(updatedHost.port).toBe(2222)
    expect(updatedHost.revision).toBe(2)

    // Verify disk was updated
    const diskDoc2 = await services.store.load()
    if (diskDoc2.status === 'ready') {
      expect(diskDoc2.document.hosts[0]!.name).toBe('web-prod-01-renamed')
      expect(diskDoc2.document.hosts[0]!.port).toBe(2222)
    }

    // 4. Delete Host via Store Action
    const deleteRes = await store.deleteHost(updatedHost.id, updatedHost.revision)
    expect(deleteRes.success).toBe(true)
    expect(useHostManagementStore.getState().hosts).toHaveLength(0)

    // Verify deletion on disk
    const diskDoc3 = await services.store.load()
    if (diskDoc3.status === 'ready') {
      expect(diskDoc3.document.hosts).toHaveLength(0)
    }
  })
})
