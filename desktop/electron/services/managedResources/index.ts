import path from 'node:path'
import type { BrowserWindow, IpcMain } from 'electron'
import { registerManagedResourcesIpc, type ManagedResourcesServices, type ManagedResourcesDialogService } from './registerIpc.js'
import { createResourceDocumentStore } from './repositories/resourceDocumentStore.js'
import { createResourceLibraryService } from './repositories/resourceLibraryService.js'
import { createCredentialVault, createTemporaryCredentialStore, type SafeStorageAdapter } from './vault/credentialVault.js'
import { createCredentialRecordService } from './vault/credentialRecordService.js'
import { createContextSelectionsRepository } from './contextSelections/contextSelectionsRepository.js'
import { createKnownHostsService } from './knownHosts.js'
import { createSshSessionService } from './sshSessionService.js'
import { createSftpService, createTransferService, createRemoteEditService, createLocalPathService } from './sftpService.js'
import { createContextTicketClient, type ContextTicketClient } from './contextTicketClient.js'
import { createDataConnectionRuntime, type DataConnectionDriverLoader } from './dataConnectionRuntime.js'
import { createDataBrowserService, type DataBrowserAdapterFactory } from './dataBrowserService.js'
import { createDataBrowserAdapterFactory } from './dataBrowserDrivers.js'
import { createWindowsCredentialRevealAuthorizer, type CredentialRevealAuthorizer } from './windowsCredentialReauth.js'

export type ManagedResourcesModule = {
  cleanup(): void
  services: ManagedResourcesServices
}

export type CreateManagedResourcesModuleOptions = {
  getMainWindow: () => BrowserWindow | null
  activeConfigDir?: string
  userDataDir?: string
  ipcMain?: IpcMain
  safeStorage?: SafeStorageAdapter
  dialogService?: ManagedResourcesDialogService
  expectedOwnerId?: string
  getServerUrl?: () => Promise<string>
  getLocalAccessToken?: () => string | null
  contextTicketClient?: ContextTicketClient
  dataBrowserAdapters?: DataBrowserAdapterFactory
  dataConnectionDrivers?: DataConnectionDriverLoader
  credentialRevealAuthorizer?: CredentialRevealAuthorizer
}

export function createManagedResourcesModule(
  options: CreateManagedResourcesModuleOptions,
): ManagedResourcesModule {
  const {
    getMainWindow,
    activeConfigDir: explicitConfigDir,
    userDataDir,
    dialogService,
    expectedOwnerId,
  } = options

  let ipcMain = options.ipcMain
  if (!ipcMain) {
    // Lazy require/import electron at runtime
    const electron = require('electron')
    ipcMain = electron.ipcMain
  }

  let safeStorage = options.safeStorage
  if (!safeStorage) {
    const electron = require('electron')
    safeStorage = electron.safeStorage
  }

  const activeConfigDir = explicitConfigDir || (userDataDir ? path.join(userDataDir, 'managed-resources') : '')
  if (!activeConfigDir) {
    throw new Error('activeConfigDir or userDataDir must be provided')
  }

  const store = createResourceDocumentStore({ activeConfigDir })
  const vault = createCredentialVault({ safeStorage: safeStorage! })
  const libService = createResourceLibraryService({ store, vault })
  const credentialService = createCredentialRecordService({ store, vault })
  const dataConnectionRuntime = createDataConnectionRuntime({ store, vault, drivers: options.dataConnectionDrivers })
  const dataBrowserService = createDataBrowserService({
    store,
    adapters: options.dataBrowserAdapters ?? createDataBrowserAdapterFactory({ store, vault }),
  })
  const selectionsRepo = createContextSelectionsRepository({ activeConfigDir })
  const temporaryCredentials = createTemporaryCredentialStore()
  const knownHosts = createKnownHostsService(store)
  const sshService = createSshSessionService({
    store,
    knownHosts,
    vault,
    resolveTemporaryCredential: (input) => {
      // Bind temporary credentials to owner+host so a second window cannot
      // piggy-back on a leaked secret. The store already enforces ownerId,
      // but we make the binding explicit here.
      const resolved = temporaryCredentials.resolveLatestForOwnerHost(input)
      if (resolved.status !== 'resolved') return null
      const payload = resolved.payload
      if ('password' in payload && typeof payload.password === 'string') {
        return { password: payload.password }
      }
      if ('privateKeyPem' in payload && typeof payload.privateKeyPem === 'string') {
        return {
          privateKeyPem: payload.privateKeyPem,
          passphrase: payload.passphrase,
        }
      }
      return null
    },
  })

  // SFTP subsystem: per-connection lazy init that reuses the SSH service's
  // already-authenticated client. The resolver function returns the
  // generation-stable view so transfers can refuse stale calls.
  const resolveSshSession = ({ connectionId, ownerId }: { connectionId: string; ownerId: string }) => {
    const session = sshService.getSession(connectionId)
    if (!session) throw new Error('RESOURCE_NOT_FOUND')
    if (session.status === 'closed' || session.status === 'closing' || session.status === 'failed') {
      throw new Error('DISCONNECTED')
    }
    const internals = sshService.getInternalsForOwner?.(connectionId, ownerId) ?? null
    if (!internals || internals.ownerId !== ownerId) throw new Error('UNAUTHORIZED_OWNER')
    return {
      session: internals.session,
      client: internals.client,
      generation: internals.generation,
    }
  }

  const sftpService = createSftpService({
    resolveSession: resolveSshSession,
    tempDir: activeConfigDir,
  })
  const localPathService = createLocalPathService({
    userDataDir: userDataDir || activeConfigDir,
  })
  const transferService = createTransferService({
    resolveSession: resolveSshSession,
    sftpService,
    localPathService,
  })
  const remoteEditService = createRemoteEditService({
    resolveSession: resolveSshSession,
    sftpService,
    localPathService,
  })

  const services: ManagedResourcesServices = {
    store,
    libService,
    vault,
    credentialService,
    credentialRevealAuthorizer: options.credentialRevealAuthorizer ?? createWindowsCredentialRevealAuthorizer(),
    dataConnectionRuntime,
    dataBrowserService,
    selectionsRepo,
    temporaryCredentials,
    knownHosts,
    sshService,
    sftpService,
    localPathService,
    transferService,
    remoteEditService,
    dispose() {
      temporaryCredentials.dispose()
      void sshService.dispose().catch(() => undefined)
      void dataBrowserService.dispose().catch(() => undefined)
      sftpService.dispose()
      transferService.dispose()
      localPathService.dispose()
    },
  }

  const contextTicketClient = options.contextTicketClient ?? (
    options.getServerUrl && options.getLocalAccessToken
      ? createContextTicketClient({
          getServerUrl: options.getServerUrl,
          getLocalAccessToken: options.getLocalAccessToken,
        })
      : undefined
  )

  const cleanup = registerManagedResourcesIpc({
    ipcMain: ipcMain!,
    getMainWindow,
    services,
    expectedOwnerId,
    dialogService,
    contextTicketClient,
  })

  return {
    cleanup() {
      cleanup()
      services.dispose()
    },
    services,
  }
}
