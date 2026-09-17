import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  registerManagedResourcesIpc,
  type ManagedResourcesServices,
} from '../../electron/services/managedResources/registerIpc.js'
import { createResourceDocumentStore } from '../../electron/services/managedResources/repositories/resourceDocumentStore.js'
import { createResourceLibraryService } from '../../electron/services/managedResources/repositories/resourceLibraryService.js'
import {
  createCredentialVault,
  createTemporaryCredentialStore,
} from '../../electron/services/managedResources/vault/credentialVault.js'
import { createCredentialRecordService } from '../../electron/services/managedResources/vault/credentialRecordService.js'
import { createContextSelectionsRepository } from '../../electron/services/managedResources/contextSelections/contextSelectionsRepository.js'
import { createKnownHostsService } from '../../electron/services/managedResources/knownHosts.js'
import { createSshSessionService } from '../../electron/services/managedResources/sshSessionService.js'
import {
  createLocalPathService,
  createRemoteEditService,
  createSftpService,
  createTransferService,
} from '../../electron/services/managedResources/sftpService.js'
import { createElectronHost } from '../lib/desktopHost/electronHost.js'
import type { ElectronIpcChannel } from '../../electron/ipc/channels.js'
import type { DesktopHost } from '../lib/desktopHost/types.js'
import type { Concept } from '../features/managed-resources/types/resourceTypes.js'
import type {
  CreateConceptInput,
  ManagedContextStageRequest,
} from '../features/managed-resources/api/hostManagementApi.js'
import { useConceptKnowledgeStore } from '../features/managed-resources/stores/conceptKnowledgeStore.js'

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

export type ConceptHarness = {
  /** Real `registerManagedResourcesIpc` handlers behind the real Electron host. */
  host: DesktopHost
  services: ManagedResourcesServices
  tempDir: string
  /** Trusted main-process stage requests captured immediately before loopback staging. */
  stagedContextRequests: ManagedContextStageRequest[]
  seedConcept: (input: CreateConceptInput) => Promise<Concept>
  dispose: () => Promise<void>
}

/**
 * Concept-knowledge join harness: real repository + real IPC handlers + real
 * `createElectronHost`, over a throwaway temp config dir. Nothing here fakes a
 * service the code under test would otherwise call.
 */
export async function createConceptHarness(prefix = 'mr-concept-harness-'): Promise<ConceptHarness> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const store = createResourceDocumentStore({ activeConfigDir: tempDir })
  const libService = createResourceLibraryService({ store })
  const safeStorage = createFakeSafeStorage()
  const vault = createCredentialVault({ safeStorage })
  const sftpService = createSftpService({
    resolveSession: () => {
      throw new Error('SFTP_UNAVAILABLE')
    },
    tempDir,
  })
  const localPathService = createLocalPathService({ userDataDir: tempDir })
  // The transfer and remote-edit services share this local-path service, so it
  // cannot be created inline inside `services` below.
  const services: ManagedResourcesServices = {
    store,
    libService,
    vault,
    credentialService: createCredentialRecordService({ store, vault }),
    selectionsRepo: createContextSelectionsRepository({ activeConfigDir: tempDir }),
    temporaryCredentials: createTemporaryCredentialStore(),
    knownHosts: createKnownHostsService(store),
    sshService: createSshSessionService({
      store,
      knownHosts: createKnownHostsService(store),
      vault,
      resolveTemporaryCredential: () => null,
    }),
    sftpService,
    localPathService,
    transferService: createTransferService({
      resolveSession: () => {
        throw new Error('SFTP_UNAVAILABLE')
      },
      sftpService,
      localPathService,
    }),
    remoteEditService: createRemoteEditService({
      resolveSession: () => {
        throw new Error('SFTP_UNAVAILABLE')
      },
      sftpService,
      localPathService,
    }),
    dispose() {
      // no temporary credentials were provided in these tests
    },
  }

  const ipcHandlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>()
  const fakeIpcMain = {
    handle(channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) {
      ipcHandlers.set(channel, handler)
    },
    removeHandler(channel: string) {
      ipcHandlers.delete(channel)
    },
  }
  const fakeMainFrame = { id: 1 }
  const fakeWebContents = { id: 42, mainFrame: fakeMainFrame }
  const fakeMainWindow = {
    id: 99,
    isDestroyed: () => false,
    webContents: fakeWebContents,
  }

  const stagedContextRequests: ManagedContextStageRequest[] = []

  const unregister = registerManagedResourcesIpc({
    // kept in this harness only: it observes the same trusted-main payload the
    // real ContextTicketClient sends to loopback, never renderer IPC output.
    // The fake mirrors only the slice `registerManagedResourcesIpc` uses.
    ipcMain: fakeIpcMain as never,
    getMainWindow: () => fakeMainWindow as never,
    services,
    contextTicketClient: {
      stage: async request => {
        stagedContextRequests.push(structuredClone(request))
        return {
          ok: true as const,
          data: {
          ticketId: `fixture-ticket-${crypto.randomUUID()}`,
          sidecarInstanceId: 'sidecar-test-instance',
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        }
      },
    },
  })

  const host = createElectronHost({
    invoke: async <T>(channel: ElectronIpcChannel, payload?: unknown): Promise<T> => {
      const handler = ipcHandlers.get(channel)
      if (!handler) throw new Error(`No IPC handler registered for channel: ${channel}`)
      return (await handler({ sender: fakeWebContents, senderFrame: fakeMainFrame }, payload)) as T
    },
    subscribe: async () => () => undefined,
  })

  if (typeof window === 'undefined') {
    ;(globalThis as unknown as { window: unknown }).window = globalThis
  }
  ;(window as unknown as { desktopHost: DesktopHost }).desktopHost = host

  resetConceptKnowledgeStore()

  return {
    host,
    services,
    tempDir,
    stagedContextRequests,
    async seedConcept(input: CreateConceptInput) {
      const result = await libService.createConcept(input)
      if (result.status !== 'created') {
        throw new Error(`seed failed: ${JSON.stringify(result)}`)
      }
      return result.value
    },
    async dispose() {
      unregister()
      delete (window as unknown as { desktopHost?: DesktopHost }).desktopHost
      await fs.rm(tempDir, { recursive: true, force: true })
    },
  }
}

/** Back to the store's initial, empty state — never a hand-written graph. */
export function resetConceptKnowledgeStore(): void {
  useConceptKnowledgeStore.setState({
    concepts: [],
    tags: [],
    selectedConceptId: null,
    searchQuery: '',
    loading: false,
    saving: false,
    error: null,
    deleteBlocked: null,
  })
}
