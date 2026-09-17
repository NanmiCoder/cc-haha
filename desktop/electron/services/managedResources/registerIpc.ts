import { HostToolsInputSchema } from '../../../src/features/managed-resources/api/hostToolsApi.js'
import { createHostToolsPreferences } from './hostToolsPreferences.js'
import { createHostToolsService } from './hostToolsService.js'
import { ApplicationOperationInputSchema } from '../../../src/features/managed-resources/api/applicationOperationsApi.js'
import { createApplicationOperationsService } from './applicationOperationsService.js'
import { applicationError } from './applicationOperationsIo.js'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import {
  BaseIpcPayloadSchema,
  ConceptInputSchema,
  DeleteConceptInputSchema,
  DeleteApplicationInputSchema,
  DeleteResourceInputSchema,
  GetResourceInputSchema,
  ListHostsInputSchema,
  ListTagsInputSchema,
  RevealCredentialInputSchema,
  SaveApplicationInputSchema,
  SaveCredentialInputSchema,
  SaveHostInputSchema,
  SaveTagInputSchema,
  TemporaryCredentialInputSchema,
  CreateConnectionInputSchema,
  StartConnectionInputSchema,
  AnswerHostKeyInputSchema,
  WriteConnectionInputSchema,
  ResizeConnectionInputSchema,
  AckOutputInputSchema,
  DisconnectConnectionInputSchema,
  MintTokenInputSchema,
  ResolveTokenInputSchema,
  RevokeTokenInputSchema,
  SftpListInputSchema,
  SftpStatInputSchema,
  TransferStartDownloadInputSchema,
  TransferStartUploadInputSchema,
  FolderTransferInputSchema,
  TransferCancelInputSchema,
  TransferGetInputSchema,
  RemoteEditOpenInputSchema,
  RemoteEditSaveInputSchema,
  RemoteEditCloseInputSchema,
  PrepareManagedContextInputSchema,
  type HostManagementError,
  type HostManagementResult,
} from '../../../src/features/managed-resources/api/hostManagementApi.js'
import type { ResourceCommandResult, ResourceLibraryService } from './repositories/resourceLibraryService.js'
import { createResourceLibraryService } from './repositories/resourceLibraryService.js'
import type { ResourceDocumentStore } from './repositories/resourceDocumentStore.js'
import type { ResourceDocument } from '../../../src/features/managed-resources/types/resourceTypes.js'
import type { CredentialVault, TemporaryCredentialStore } from './vault/credentialVault.js'
import type { CredentialRecordService } from './vault/credentialRecordService.js'
import type { ContextSelectionsRepository } from './contextSelections/contextSelectionsRepository.js'
import type { KnownHostsService } from './knownHosts.js'
import type { SshSessionService } from './sshSessionService.js'
import { ELECTRON_EVENT_CHANNELS } from '../../ipc/channels.js'
import { executeExportMetadata } from './importExport/exportMetadata.js'
import { executeImportMetadata } from './importExport/importMetadata.js'
import { prepareManagedContextStageRequest } from './managedContextPrepare.js'
import type { ContextTicketClient } from './contextTicketClient.js'
import {
  CloseDataSessionInputSchema,
  DeleteDataConnectionInputSchema,
  GetDataConnectionInputSchema,
  ListDataConnectionsInputSchema,
  OpenDataSessionInputSchema,
  RedisReadInputSchema,
  RedisScanInputSchema,
  SaveDataConnectionInputSchema,
  SqlCancelInputSchema,
  SqlDescribeTableInputSchema,
  SqlExecuteInputSchema,
  SqlListDatabasesInputSchema,
  SqlListSchemasInputSchema,
  SqlListTablesInputSchema,
  SqlPreviewInputSchema,
  TestDataConnectionInputSchema,
} from '../../../src/features/managed-resources/api/dataConnectionsApi.js'
import type { DataConnectionRuntime } from './dataConnectionRuntime.js'
import type { DataBrowserService } from './dataBrowserService.js'
import type { CredentialRevealAuthorizer } from './windowsCredentialReauth.js'

export const MANAGED_RESOURCES_IPC_CHANNELS = {
  getCapabilities: 'desktop:managed-resources:get-capabilities',
  listHosts: 'desktop:managed-resources:list-hosts',
  getHost: 'desktop:managed-resources:get-host',
  saveHost: 'desktop:managed-resources:save-host',
  deleteHost: 'desktop:managed-resources:delete-host',
  saveApplication: 'desktop:managed-resources:save-application',
  deleteApplication: 'desktop:managed-resources:delete-application',
  listTags: 'desktop:managed-resources:list-tags',
  saveTag: 'desktop:managed-resources:save-tag',
  deleteTag: 'desktop:managed-resources:delete-tag',
  saveCredential: 'desktop:managed-resources:save-credential',
  deleteCredential: 'desktop:managed-resources:delete-credential',
  revealCredential: 'desktop:managed-resources:reveal-credential',
  provideTemporaryCredential: 'desktop:managed-resources:provide-temporary-credential',
  listConcepts: 'desktop:managed-resources:list-concepts',
  getConcept: 'desktop:managed-resources:get-concept',
  saveConcept: 'desktop:managed-resources:save-concept',
  deleteConcept: 'desktop:managed-resources:delete-concept',
  listDataConnections: 'desktop:managed-resources:list-data-connections',
  getDataConnection: 'desktop:managed-resources:get-data-connection',
  saveDataConnection: 'desktop:managed-resources:save-data-connection',
  deleteDataConnection: 'desktop:managed-resources:delete-data-connection',
  testDataConnection: 'desktop:managed-resources:test-data-connection',
  openDataSession: 'desktop:managed-resources:open-data-session',
  closeDataSession: 'desktop:managed-resources:close-data-session',
  listDatabases: 'desktop:managed-resources:list-databases',
  listSchemas: 'desktop:managed-resources:list-schemas',
  listTables: 'desktop:managed-resources:list-tables',
  describeTable: 'desktop:managed-resources:describe-table',
  previewTable: 'desktop:managed-resources:preview-table',
  executeQuery: 'desktop:managed-resources:execute-query',
  cancelQuery: 'desktop:managed-resources:cancel-query',
  scanRedisKeys: 'desktop:managed-resources:scan-redis-keys',
  readRedisKey: 'desktop:managed-resources:read-redis-key',
  getSelection: 'desktop:managed-resources:get-selection',
  saveSelection: 'desktop:managed-resources:save-selection',
  deleteSelection: 'desktop:managed-resources:delete-selection',
  prepareContext: 'desktop:managed-resources:prepare-context',
  exportMetadata: 'desktop:managed-resources:export-metadata',
  importMetadata: 'desktop:managed-resources:import-metadata',
  createConnection: 'desktop:managed-resources:create-connection',
  startConnection: 'desktop:managed-resources:start-connection',
  answerHostKey: 'desktop:managed-resources:answer-host-key',
  writeConnection: 'desktop:managed-resources:write-connection',
  resizeConnection: 'desktop:managed-resources:resize-connection',
  ackOutput: 'desktop:managed-resources:ack-output',
  disconnect: 'desktop:managed-resources:disconnect',
  sftpList: 'desktop:managed-resources:sftp-list',
  mintUploadToken: 'desktop:managed-resources:mint-upload-token',
  mintDownloadToken: 'desktop:managed-resources:mint-download-token',
  resolveLocalToken: 'desktop:managed-resources:resolve-local-token',
  revokeLocalToken: 'desktop:managed-resources:revoke-local-token',
  sftpStat: 'desktop:managed-resources:sftp-stat',
  transferStartDownload: 'desktop:managed-resources:transfer-start-download',
  transferStartUpload: 'desktop:managed-resources:transfer-start-upload',
  transferUploadFolder: 'desktop:managed-resources:transfer-upload-folder',
  transferDownloadFolder: 'desktop:managed-resources:transfer-download-folder',
  transferCancel: 'desktop:managed-resources:transfer-cancel',
  transferGet: 'desktop:managed-resources:transfer-get',
  remoteEditOpen: 'desktop:managed-resources:remote-edit-open',
  remoteEditSave: 'desktop:managed-resources:remote-edit-save',
  remoteEditClose: 'desktop:managed-resources:remote-edit-close',
  applicationOperation: 'desktop:managed-resources:application-operation',
  hostTools: 'desktop:managed-resources:host-tools',
} as const

export type ManagedResourcesServices = {
  store: ResourceDocumentStore
  libService: ResourceLibraryService
  vault: CredentialVault
  credentialService: CredentialRecordService
  credentialRevealAuthorizer?: CredentialRevealAuthorizer
  selectionsRepo: ContextSelectionsRepository
  temporaryCredentials: TemporaryCredentialStore
  knownHosts: KnownHostsService
  sshService: SshSessionService
  sftpService: ReturnType<typeof import('./sftpService.js').createSftpService>
  localPathService: ReturnType<typeof import('./sftpService.js').createLocalPathService>
  transferService: ReturnType<typeof import('./sftpService.js').createTransferService>
  remoteEditService: ReturnType<typeof import('./sftpService.js').createRemoteEditService>
  dataConnectionRuntime?: DataConnectionRuntime
  dataBrowserService?: DataBrowserService
  dispose: () => void
}

export type ManagedResourcesDialogService = {
  showSaveDialog: (window: BrowserWindow, options: any) => Promise<{ canceled: boolean; filePath?: string }>
  showOpenDialog: (window: BrowserWindow, options: any) => Promise<{ canceled: boolean; filePaths: string[] }>
}

export type RegisterManagedResourcesIpcOptions = {
  ipcMain: IpcMain
  getMainWindow: () => BrowserWindow | null
  services: ManagedResourcesServices
  expectedOwnerId?: string
  dialogService?: ManagedResourcesDialogService
  contextTicketClient?: ContextTicketClient
}

function errorResult<T>(
  code: string,
  messageKey: string,
  extra: Partial<Omit<HostManagementError, 'code' | 'messageKey'>> = {},
): HostManagementResult<T> {
  return {
    ok: false,
    error: {
      code,
      messageKey,
      ...extra,
    },
  }
}

function successResult<T>(data: T): HostManagementResult<T> {
  return { ok: true, data }
}

function safeChannelMessage(err: unknown): string {
  // Strip anything that looks like credentials or userinfo from error
  // messages before they reach the main-process log or the renderer.
  const raw = err instanceof Error ? err.message : String(err)
  if (!raw) return 'unknown error'
  return raw
    .replace(/[?&](?:password|passphrase|privateKey)=[^&]+/gi, '$&=[REDACTED]')
    .replace(/\/\/[^@/\s]+@/g, '//[REDACTED]@')
    .slice(0, 240)
}

async function enrichReferences(
  services: ManagedResourcesServices,
  references?: Array<{ id: string; resourceType?: string; type?: string; relation?: string }>,
) {
  if (!references || references.length === 0) return undefined
  let doc: ResourceDocument | null = null
  try {
    const loaded = await services.store.load()
    if (loaded.status === 'ready') {
      doc = loaded.document
    }
  } catch {
    // ignore
  }

  return references.map(r => {
    const type = r.resourceType ?? r.type ?? 'unknown'
    let name: string | undefined
    if (doc) {
      if (type === 'host') name = doc.hosts.find(h => h.id === r.id)?.name
      else if (type === 'dataConnection') name = doc.dataConnections.find(d => d.id === r.id)?.name
      else if (type === 'concept') name = doc.concepts.find(c => c.id === r.id)?.title
      else if (type === 'credential') name = doc.credentials.find(c => c.id === r.id)?.label
      else if (type === 'tag') name = doc.tags.find(t => t.id === r.id)?.name
    }
    return {
      id: r.id,
      type,
      name: name ?? r.id,
      description: r.relation,
    }
  })
}

export function registerManagedResourcesIpc(options: RegisterManagedResourcesIpcOptions): () => void {
  const { ipcMain, getMainWindow, services, expectedOwnerId } = options
  const registeredChannels = new Set<string>()
  const pendingDownloadTargets = new Map<string, { ownerId: string; targetPath: string }>()

  async function finalizeNativeDownload(stagedPath: string, targetPath: string): Promise<void> {
    const targetDir = path.dirname(targetPath)
    const suffix = randomUUID()
    const tempPath = path.join(targetDir, `.${path.basename(targetPath)}.${suffix}.cc-haha-part`)
    const backupPath = path.join(targetDir, `.${path.basename(targetPath)}.${suffix}.cc-haha-backup`)
    let movedExisting = false
    try {
      await fsp.copyFile(stagedPath, tempPath)
      try {
        await fsp.rename(targetPath, backupPath)
        movedExisting = true
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error
      }
      try {
        await fsp.rename(tempPath, targetPath)
      } catch (error) {
        if (movedExisting) await fsp.rename(backupPath, targetPath).catch(() => undefined)
        throw error
      }
      if (movedExisting) await fsp.unlink(backupPath).catch(() => undefined)
      await fsp.unlink(stagedPath).catch(() => undefined)
    } finally {
      await fsp.unlink(tempPath).catch(() => undefined)
      if (movedExisting) await fsp.unlink(backupPath).catch(() => undefined)
    }
  }
  const credentialLibrary = (ownerId: string | undefined) => createResourceLibraryService({
    store: services.store, vault: services.vault,
    temporaryCredentials: services.temporaryCredentials, ownerId,
  })
  // SSH event subscriptions indexed by mainWindow.id so we can deliver
  // connection events only to the BrowserWindow that owns them. A stray
  // preview or pet window must never receive terminal bytes for a
  // connection it does not own.
  const sshSubscriptions = new Map<number, {
    unlisten: () => void
    connectionIds: Set<string>
  }>()
  // Connections owned by each mainWindow. Used both for delivery gating and
  // for releasing all subscriptions on window destroy.
  const ownerConnections = new Map<number, Set<string>>()
  // Per-connection start-time subscribeForConnection unlistens so disconnect
  // can release the gate binding cleanly.
  const pendingStartUnlistens = new Map<string, () => void>()

  function getOwnerIdForWindow(mainWindow: BrowserWindow): string {
    return expectedOwnerId || `window:${mainWindow.id}`
  }

  function releaseConnectionForOwner(connectionId: string, ownerId: string) {
    // Reverse lookup is fine here — mainWindow count is tiny.
    for (const [windowId, conns] of ownerConnections.entries()) {
      if (conns.has(connectionId)) {
        conns.delete(connectionId)
        const sub = sshSubscriptions.get(windowId)
        if (sub) sub.connectionIds.delete(connectionId)
        return
      }
    }
    void ownerId
  }

  function validateCaller(event: IpcMainInvokeEvent, _payload: unknown): HostManagementError | null {
    const mainWindow = getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { code: 'UNAUTHORIZED_OWNER', messageKey: 'managedResources.errors.windowDestroyed' }
    }

    if (event.sender !== mainWindow.webContents) {
      return { code: 'UNAUTHORIZED_OWNER', messageKey: 'managedResources.errors.unauthorizedSender' }
    }

    if (mainWindow.webContents.mainFrame && event.senderFrame !== mainWindow.webContents.mainFrame) {
      return { code: 'UNAUTHORIZED_OWNER', messageKey: 'managedResources.errors.unauthorizedFrame' }
    }

    // F29-02: payload.ownerId is no longer authoritative. It is overwritten
    // by the canonical owner (resolved from `requireMainWindow()`) inside
    // `handle()`. We do NOT reject a mismatched ownerId at this layer; that
    // responsibility moves into the canonical-owner override below and into
    // the per-handler strict Zod schema.

    return null
  }

  function handle<P, R>(
    channel: string,
    schema: { safeParse: (data: unknown) => { success: true; data: P } | { success: false; error: unknown } } | null,
    handler: (event: IpcMainInvokeEvent, payload: P) => Promise<HostManagementResult<R>>,
  ) {
    const fn = async (event: IpcMainInvokeEvent, rawPayload: unknown): Promise<HostManagementResult<R>> => {
      const callerErr = validateCaller(event, rawPayload)
      if (callerErr) return { ok: false, error: callerErr }

      const mainWindow = getMainWindow()!
      const trustedOwnerId = expectedOwnerId || `window:${mainWindow.id}`

      const normalizedPayload = (typeof rawPayload === 'object' && rawPayload !== null)
        ? { ...(rawPayload as object), ownerId: trustedOwnerId }
        : { ownerId: trustedOwnerId }

      let parsedPayload: P = normalizedPayload as unknown as P
      if (schema) {
        const parsed = schema.safeParse(normalizedPayload)
        if (!parsed.success) {
          // Never log write-only credential payloads or validation input.
          return errorResult('INVALID_ARGUMENT', 'managedResources.errors.invalidPayload')
        }
        parsedPayload = parsed.data
      }

      try {
        return await handler(event, parsedPayload)
      } catch (err: any) {
        return errorResult('INTERNAL_ERROR', 'managedResources.errors.internal')
      }
    }

    ipcMain.handle(channel, fn)
    registeredChannels.add(channel)
  }

  const hostToolsPreferences = createHostToolsPreferences(services.store)
  const hostTools = createHostToolsService(services, hostToolsPreferences)
  // handle() injects the canonical owner; it never comes from the renderer schema.
  const hostToolsSchema = { safeParse: (value: unknown) => {
    const { ownerId: _ownerId, ...input } = value as Record<string, unknown>
    return HostToolsInputSchema.safeParse(input)
  } }
  handle(MANAGED_RESOURCES_IPC_CHANNELS.hostTools, hostToolsSchema, async (_event, payload) => {
    const { ownerId } = requireMainWindow()
    try { return successResult(await hostTools.perform(payload, ownerId)) }
    catch (error) {
      const message = error instanceof Error ? error.message : ''
      const code = /^(PREFERENCES_INVALID|PREFERENCES_LIMIT|APPLICATION_CHANGED|RESOURCE_NOT_FOUND|CANCELLED|DISCONNECTED|STALE_GENERATION|UNAUTHORIZED_OWNER|PROCESS_QUERY_FAILED|PROCESS_RESPONSE_INVALID|PROCESS_OUTPUT_LIMIT|OPERATION_TIMEOUT|OPERATION_LIMIT)$/.test(message) ? message : 'HOST_TOOLS_FAILED'
      return errorResult(code, 'managedResources.errors.sshOperationFailed', { params: { reason: code } })
    }
  })
  const applicationOperations = createApplicationOperationsService(services, hostToolsPreferences)
  handle(MANAGED_RESOURCES_IPC_CHANNELS.applicationOperation, ApplicationOperationInputSchema, async (_event, payload) => {
    const { ownerId } = requireMainWindow()
    try { return successResult(await applicationOperations.perform(payload, ownerId)) }
    catch (error) {
      const code = applicationError(error)
      return errorResult(code, 'managedResources.errors.sshOperationFailed', { params: { reason: code } })
    }
  })

  // Capabilities
  handle(MANAGED_RESOURCES_IPC_CHANNELS.getCapabilities, BaseIpcPayloadSchema, async () => {
    const vaultInit = services.vault.initialize()
    return successResult({
      vaultAvailable: vaultInit.status === 'available',
      isWindows: process.platform === 'win32',
      sftpEditingAvailable: false,
    })
  })

  // List Hosts
  handle(MANAGED_RESOURCES_IPC_CHANNELS.listHosts, ListHostsInputSchema, async (_event, payload) => {
    const doc = await services.store.load()
    if (doc.status !== 'ready') {
      return errorResult(doc.status.toUpperCase(), `managedResources.status.${doc.status}`)
    }
    let hosts = doc.document.hosts
    if (payload.tagId) {
      hosts = hosts.filter(h => h.tagIds.includes(payload.tagId!))
    }
    if (payload.query) {
      const q = payload.query.toLowerCase()
      hosts = hosts.filter(h => h.name.toLowerCase().includes(q) || h.address.toLowerCase().includes(q))
    }
    return successResult(hosts)
  })

  // Get Host
  handle(MANAGED_RESOURCES_IPC_CHANNELS.getHost, GetResourceInputSchema, async (_event, payload) => {
    const doc = await services.store.load()
    if (doc.status !== 'ready') {
      return errorResult(doc.status.toUpperCase(), `managedResources.status.${doc.status}`)
    }
    const host = doc.document.hosts.find(h => h.id === payload.id)
    if (!host) {
      return errorResult('RESOURCE_NOT_FOUND', 'managedResources.errors.hostNotFound')
    }
    return successResult(host)
  })

  // Save Host
  handle(MANAGED_RESOURCES_IPC_CHANNELS.saveHost, SaveHostInputSchema, async (_event, payload) => {
    const library = credentialLibrary(payload.ownerId)
    if (payload.mode === 'create' || !('id' in payload)) {
      const createInput = {
        credential: payload.credential,
        name: payload.name,
        address: payload.address,
        port: payload.port,
        username: payload.username,
        auth: payload.auth,
        tagIds: payload.tagIds,
        initialDirectory: payload.initialDirectory ?? null,
        applications: (payload.applications ?? []).map(app => ({
          name: app.name,
          version: app.version ?? null,
          installPaths: app.installPaths,
          accessDescription: app.accessDescription,
          accessUrls: app.accessUrls,
          loginUrl: app.loginUrl ?? null,
          accounts: app.accounts.map(acc => ({
            label: acc.label,
            username: acc.username,
            credentialId: acc.credentialId ?? null,
            ...(acc.password === undefined ? {} : { password: acc.password }),
          })),
          notes: app.notes,
        })),
        notes: payload.notes,
      }
      const res = await library.createHost(createInput)
      if (res.status === 'created') return successResult(res.value)
      const rejection = res as { code: string; references?: any[] }
      return errorResult(rejection.code, `managedResources.errors.${rejection.code}`, {
        references: rejection.references?.map(r => ({ id: r.id, type: r.type, name: r.name })),
      })
    } else {
      const res = await library.updateHost({
        credential: payload.credential,
        id: payload.id,
        expectedRevision: payload.expectedRevision,
        changes: payload.changes,
      })
      if (res.status === 'updated') return successResult(res.value)
      const rejection = res as { code: string; references?: any[] }
      const enriched = await enrichReferences(services, rejection.references)
      return errorResult(rejection.code, `managedResources.errors.${rejection.code}`, {
        references: enriched,
      })
    }
  })

  // Delete Host
  handle(MANAGED_RESOURCES_IPC_CHANNELS.deleteHost, DeleteResourceInputSchema, async (_event, payload) => {
    const res = await services.libService.deleteHost({
      id: payload.id,
      expectedRevision: payload.expectedRevision,
    })
    if (res.status === 'deleted') return successResult({ id: payload.id })
    const rejection = res as { code: string; references?: any[] }
    const enriched = await enrichReferences(services, rejection.references)
    return errorResult(rejection.code, `managedResources.errors.${rejection.code}`, {
      references: enriched,
    })
  })

  // Save Application
  handle(MANAGED_RESOURCES_IPC_CHANNELS.saveApplication, SaveApplicationInputSchema, async (_event, payload) => {
    const library = credentialLibrary(payload.ownerId)
    if (payload.mode === 'create' || !('applicationId' in payload)) {
      const res = await library.createApplication({
        hostId: payload.hostId,
        expectedHostRevision: payload.expectedHostRevision,
        application: {
          name: payload.application.name,
          version: payload.application.version ?? null,
          installPaths: payload.application.installPaths,
          accessDescription: payload.application.accessDescription,
          accessUrls: payload.application.accessUrls,
          loginUrl: payload.application.loginUrl ?? null,
          accounts: payload.application.accounts.map(acc => ({
            label: acc.label,
            username: acc.username,
            credentialId: acc.credentialId ?? null,
            ...(acc.password === undefined ? {} : { password: acc.password }),
          })),
          notes: payload.application.notes,
        },
      })
      if (res.status === 'created' || res.status === 'updated') return successResult(res.value)
      const rejection = res as { code: string; references?: any[] }
      const enriched = await enrichReferences(services, rejection.references)
      return errorResult(rejection.code, `managedResources.errors.${rejection.code}`, {
        references: enriched,
      })
    } else {
      let changes = payload.changes
      if (payload.changes.accounts) {
        changes = {
          ...payload.changes,
          accounts: payload.changes.accounts.map(acc => ({
            id: acc.id ?? crypto.randomUUID(),
            label: acc.label,
            username: acc.username,
            credentialId: acc.credentialId ?? null,
            ...(acc.password === undefined ? {} : { password: acc.password }),
          })),
        }
      }
      const res = await library.updateApplication({
        hostId: payload.hostId,
        expectedHostRevision: payload.expectedHostRevision,
        applicationId: payload.applicationId,
        changes: changes as any,
      })
      if (res.status === 'updated') return successResult(res.value)
      const rejection = res as { code: string; references?: any[] }
      const enriched = await enrichReferences(services, rejection.references)
      return errorResult(rejection.code, `managedResources.errors.${rejection.code}`, {
        references: enriched,
      })
    }
  })

  // Delete Application
  handle(MANAGED_RESOURCES_IPC_CHANNELS.deleteApplication, DeleteApplicationInputSchema, async (_event, payload) => {
    const res = await services.libService.deleteApplication({
      hostId: payload.hostId,
      expectedHostRevision: payload.expectedHostRevision,
      applicationId: payload.applicationId,
    })
    if (res.status === 'deleted' || res.status === 'updated') return successResult(res.value)
    const rejection = res as { code: string; references?: any[] }
    const enriched = await enrichReferences(services, rejection.references)
    return errorResult(rejection.code, `managedResources.errors.${rejection.code}`, {
      references: enriched,
    })
  })

  // List Tags
  handle(MANAGED_RESOURCES_IPC_CHANNELS.listTags, ListTagsInputSchema, async (_event, payload) => {
    const doc = await services.store.load()
    if (doc.status !== 'ready') {
      return errorResult(doc.status.toUpperCase(), `managedResources.status.${doc.status}`)
    }
    let tags = doc.document.tags
    if (payload.namespace) {
      tags = tags.filter(t => t.namespace === payload.namespace)
    }
    return successResult(tags)
  })

  // Save Tag
  handle(MANAGED_RESOURCES_IPC_CHANNELS.saveTag, SaveTagInputSchema, async (_event, payload) => {
    if (payload.mode === 'create' || !('id' in payload)) {
      const res = await services.libService.createTag({
        namespace: payload.namespace,
        name: payload.name,
        colorToken: payload.colorToken ?? null,
      })
      if (res.status === 'created') return successResult(res.value)
      const rejection = res as { code: string; references?: any[] }
      const enriched = await enrichReferences(services, rejection.references)
      return errorResult(rejection.code, `managedResources.errors.${rejection.code}`, {
        references: enriched,
      })
    } else {
      const res = await services.libService.updateTag({
        id: payload.id,
        expectedRevision: payload.expectedRevision,
        name: payload.name,
        colorToken: payload.colorToken ?? null,
      })
      if (res.status === 'updated') return successResult(res.value)
      const rejection = res as { code: string; references?: any[] }
      const enriched = await enrichReferences(services, rejection.references)
      return errorResult(rejection.code, `managedResources.errors.${rejection.code}`, {
        references: enriched,
      })
    }
  })

  // Delete Tag
  handle(MANAGED_RESOURCES_IPC_CHANNELS.deleteTag, DeleteResourceInputSchema, async (_event, payload) => {
    const res = await services.libService.deleteTag({
      id: payload.id,
      expectedRevision: payload.expectedRevision,
    })
    if (res.status === 'deleted') return successResult({ id: payload.id })
    const rejection = res as { code: string; references?: any[] }
    const enriched = await enrichReferences(services, rejection.references)
    return errorResult(rejection.code, `managedResources.errors.${rejection.code}`, {
      references: enriched,
    })
  })

  // Save Credential
  handle(MANAGED_RESOURCES_IPC_CHANNELS.saveCredential, SaveCredentialInputSchema, async (_event, payload) => {
    if (payload.mode === 'create' || !('id' in payload)) {
      const res = await services.credentialService.create({
        kind: payload.kind,
        label: payload.label,
        secret: payload.secret,
      })
      if (res.status === 'created' || res.status === 'updated') return successResult(res.credential)
      const rejection = res as { code: string; references?: any[] }
      const enriched = await enrichReferences(services, rejection.references)
      return errorResult(rejection.code, `managedResources.errors.${rejection.code}`, {
        references: enriched,
      })
    } else {
      const res = await services.credentialService.update({
        id: payload.id,
        expectedRevision: payload.expectedRevision,
        label: payload.label,
        secret: payload.secret,
      })
      if (res.status === 'updated') return successResult(res.credential)
      const rejection = res as { code: string; references?: any[] }
      const enriched = await enrichReferences(services, rejection.references)
      return errorResult(rejection.code, `managedResources.errors.${rejection.code}`, {
        references: enriched,
      })
    }
  })

  // Delete Credential
  handle(MANAGED_RESOURCES_IPC_CHANNELS.deleteCredential, DeleteResourceInputSchema, async (_event, payload) => {
    const res = await services.credentialService.delete({
      id: payload.id,
      expectedRevision: payload.expectedRevision,
    })
    if (res.status === 'deleted') return successResult({ id: payload.id })
    const rejection = res as { code: string; references?: any[] }
    const enriched = await enrichReferences(services, rejection.references)
    return errorResult(rejection.code, `managedResources.errors.${rejection.code}`, {
      references: enriched,
    })
  })

  // Reveal password credential. The renderer never supplies an OS password:
  // Windows re-authentication happens in a separate native prompt boundary, and
  // only its allow/deny result reaches this process. Private-key material is
  // deliberately not revealable through this channel.
  handle(MANAGED_RESOURCES_IPC_CHANNELS.revealCredential, RevealCredentialInputSchema, async (_event, payload) => {
    const doc = await services.store.load()
    if (doc.status !== 'ready') {
      return errorResult(doc.status.toUpperCase(), `managedResources.status.${doc.status}`)
    }
    const record = doc.document.credentials.find(c => c.id === payload.id)
    if (!record) {
      return errorResult('RESOURCE_NOT_FOUND', 'managedResources.errors.credentialNotFound')
    }
    if (!['ssh-password', 'application-password', 'database-password', 'redis-password'].includes(record.kind)) {
      return errorResult('CREDENTIAL_NOT_PASSWORD', 'managedResources.errors.CREDENTIAL_NOT_PASSWORD')
    }

    let authorization: Awaited<ReturnType<CredentialRevealAuthorizer['authorize']>>
    try {
      authorization = services.credentialRevealAuthorizer
        ? await services.credentialRevealAuthorizer.authorize()
        : { status: 'unavailable' }
    } catch {
      authorization = { status: 'unavailable' }
    }
    if (authorization.status === 'cancelled') {
      return errorResult('OS_AUTH_CANCELLED', 'managedResources.errors.OS_AUTH_CANCELLED')
    }
    if (authorization.status === 'denied') {
      return errorResult('OS_AUTH_FAILED', 'managedResources.errors.OS_AUTH_FAILED')
    }
    if (authorization.status !== 'authorized') {
      return errorResult('OS_AUTH_UNAVAILABLE', 'managedResources.errors.OS_AUTH_UNAVAILABLE')
    }

    const decryptRes = services.vault.decrypt(record)
    if (decryptRes.status !== 'decrypted') {
      return errorResult(decryptRes.code, `managedResources.errors.${decryptRes.code}`)
    }
    if (!('password' in decryptRes.payload)) {
      return errorResult('CREDENTIAL_NOT_PASSWORD', 'managedResources.errors.CREDENTIAL_NOT_PASSWORD')
    }
    return successResult({
      credentialId: record.id,
      kind: decryptRes.payload.kind,
      password: decryptRes.payload.password,
      expiresAt: Date.now() + 15_000,
    })
  })

  // Provide Temporary Credential
  handle(MANAGED_RESOURCES_IPC_CHANNELS.provideTemporaryCredential, TemporaryCredentialInputSchema, async (_event, payload) => {
    const mainWindow = getMainWindow()!
    const trustedOwnerId = expectedOwnerId || `window:${mainWindow.id}`
    const res = services.temporaryCredentials.provide({
      ownerId: payload.ownerId || trustedOwnerId,
      hostId: payload.hostId,
      payload: payload.secret,
    })
    if (res.status === 'provided') return successResult({ handle: res.handle })
    return errorResult(res.code, `managedResources.errors.${res.code}`)
  })

  /**
   * Concept command rejections.
   *
   * Unlike the host/tag paths these must forward the full dependsOn cycle path
   * (`DEPENDENCY_CYCLE.cycle` — first id repeated at the end) plus the concrete
   * revision numbers, and delete-blocked referrers get real titles so the
   * blocked-referrer dialog can name them instead of printing bare ids.
   */
  async function conceptRejection(res: ResourceCommandResult<unknown>): Promise<HostManagementResult<never>> {
    if (res.status !== 'rejected') {
      // Callers only reach this for a rejected command.
      throw new Error('conceptRejection expects a rejected command result')
    }
    const params =
      res.expectedRevision !== undefined || res.actualRevision !== undefined
        ? { expectedRevision: res.expectedRevision, actualRevision: res.actualRevision }
        : undefined
    return errorResult(res.code, `managedResources.errors.${res.code.toLowerCase()}`, {
      references: await enrichReferences(services, res.references),
      cycle: res.cycle,
      params,
    })
  }

  // List Concepts
  handle(MANAGED_RESOURCES_IPC_CHANNELS.listConcepts, BaseIpcPayloadSchema, async () => {
    const doc = await services.store.load()
    if (doc.status !== 'ready') {
      return errorResult(doc.status.toUpperCase(), `managedResources.status.${doc.status}`)
    }
    return successResult(doc.document.concepts)
  })

  // Get Concept
  handle(MANAGED_RESOURCES_IPC_CHANNELS.getConcept, GetResourceInputSchema, async (_event, payload) => {
    const doc = await services.store.load()
    if (doc.status !== 'ready') {
      return errorResult(doc.status.toUpperCase(), `managedResources.status.${doc.status}`)
    }
    const concept = doc.document.concepts.find(c => c.id === payload.id)
    if (!concept) {
      return errorResult('RESOURCE_NOT_FOUND', 'managedResources.errors.conceptNotFound')
    }
    return successResult(concept)
  })

  // Save Concept
  handle(MANAGED_RESOURCES_IPC_CHANNELS.saveConcept, ConceptInputSchema, async (_event, payload) => {
    if (payload.mode === 'create') {
      const res = await services.libService.createConcept({
        title: payload.title,
        summary: payload.summary,
        bodyMarkdown: payload.bodyMarkdown,
        tagIds: payload.tagIds,
        dependsOnIds: payload.dependsOnIds,
        referenceIds: payload.referenceIds,
      })
      if (res.status === 'created') return successResult(res.value)
      return conceptRejection(res)
    } else {
      const res = await services.libService.updateConcept({
        id: payload.id,
        expectedRevision: payload.expectedRevision,
        changes: payload.changes,
      })
      if (res.status === 'updated') return successResult(res.value)
      return conceptRejection(res)
    }
  })

  // Delete Concept
  handle(MANAGED_RESOURCES_IPC_CHANNELS.deleteConcept, DeleteConceptInputSchema, async (_event, payload) => {
    const res = await services.libService.deleteConcept({
      id: payload.id,
      expectedRevision: payload.expectedRevision,
      removeReferenceEdges: payload.removeReferenceEdges,
    })
    if (res.status === 'deleted') return successResult(undefined)
    return conceptRejection(res)
  })

  // Data connections (M9): metadata CRUD and bounded connection test.
  handle(MANAGED_RESOURCES_IPC_CHANNELS.listDataConnections, ListDataConnectionsInputSchema, async (_event, payload) => {
    const loaded = await services.store.load()
    if (loaded.status !== 'ready') return errorResult(loaded.status.toUpperCase(), `managedResources.status.${loaded.status}`)
    let connections = loaded.document.dataConnections
    if (payload.kind) connections = connections.filter(connection => connection.kind === payload.kind)
    if (payload.query) {
      const query = payload.query.toLowerCase()
      connections = connections.filter(connection =>
        connection.name.toLowerCase().includes(query)
        || connection.address.toLowerCase().includes(query)
        || connection.description.toLowerCase().includes(query))
    }
    return successResult(connections)
  })

  handle(MANAGED_RESOURCES_IPC_CHANNELS.getDataConnection, GetDataConnectionInputSchema, async (_event, payload) => {
    const loaded = await services.store.load()
    if (loaded.status !== 'ready') return errorResult(loaded.status.toUpperCase(), `managedResources.status.${loaded.status}`)
    const connection = loaded.document.dataConnections.find(candidate => candidate.id === payload.id)
    return connection
      ? successResult(connection)
      : errorResult('RESOURCE_NOT_FOUND', 'managedResources.errors.dataConnectionNotFound')
  })

  handle(MANAGED_RESOURCES_IPC_CHANNELS.saveDataConnection, SaveDataConnectionInputSchema, async (_event, payload) => {
    const library = credentialLibrary(payload.ownerId)
    const result = payload.mode === 'create'
      ? await library.createDataConnection(payload.connection)
      : await library.updateDataConnection({
          id: payload.id,
          expectedRevision: payload.expectedRevision,
          changes: payload.connection,
        })
    if (result.status === 'created' || result.status === 'updated') return successResult(result.value)
    if (result.status !== 'rejected') throw new Error('Unexpected data connection command status')
    return errorResult(result.code, `managedResources.errors.${result.code.toLowerCase()}`, {
      references: await enrichReferences(services, result.references),
      params: result.expectedRevision === undefined && result.actualRevision === undefined
        ? undefined
        : { expectedRevision: result.expectedRevision, actualRevision: result.actualRevision },
    })
  })

  handle(MANAGED_RESOURCES_IPC_CHANNELS.deleteDataConnection, DeleteDataConnectionInputSchema, async (_event, payload) => {
    const result = await services.libService.deleteDataConnection({ id: payload.id, expectedRevision: payload.expectedRevision })
    if (result.status === 'deleted') return successResult({ id: payload.id })
    if (result.status !== 'rejected') throw new Error('Unexpected data connection delete status')
    return errorResult(result.code, `managedResources.errors.${result.code.toLowerCase()}`, {
      references: await enrichReferences(services, result.references),
    })
  })

  handle(MANAGED_RESOURCES_IPC_CHANNELS.testDataConnection, TestDataConnectionInputSchema, async (_event, payload) => {
    let connection
    if ('id' in payload) {
      const loaded = await services.store.load()
      if (loaded.status !== 'ready') return errorResult(loaded.status.toUpperCase(), `managedResources.status.${loaded.status}`)
      connection = loaded.document.dataConnections.find(candidate => candidate.id === payload.id)
      if (!connection) return errorResult('RESOURCE_NOT_FOUND', 'managedResources.errors.dataConnectionNotFound')
    } else {
      connection = payload.connection
    }
    if (!services.dataConnectionRuntime) {
      return errorResult('UNAVAILABLE', 'managedResources.errors.dataConnectionRuntimeUnavailable')
    }
    return successResult(await services.dataConnectionRuntime.testConnection(connection))
  })

  // M10: explicit owner-bound data sessions. These handlers expose only bounded
  // operations; there is no generic driver or raw-command IPC escape hatch.
  handle(MANAGED_RESOURCES_IPC_CHANNELS.openDataSession, OpenDataSessionInputSchema, async (_event, payload) => {
    if (!services.dataBrowserService) return errorResult('UNAVAILABLE', 'managedResources.errors.dataConnectionRuntimeUnavailable')
    return services.dataBrowserService.openConnection({ ownerId: payload.ownerId!, connectionId: payload.connectionId, expectedRevision: payload.expectedRevision })
  })
  handle(MANAGED_RESOURCES_IPC_CHANNELS.closeDataSession, CloseDataSessionInputSchema, async (_event, payload) => {
    if (!services.dataBrowserService) return errorResult('UNAVAILABLE', 'managedResources.errors.dataConnectionRuntimeUnavailable')
    return services.dataBrowserService.closeConnection({ ownerId: payload.ownerId!, dataSessionId: payload.dataSessionId, generation: payload.generation })
  })
  handle(MANAGED_RESOURCES_IPC_CHANNELS.listDatabases, SqlListDatabasesInputSchema, async (_event, payload) => {
    if (!services.dataBrowserService) return errorResult('UNAVAILABLE', 'managedResources.errors.dataConnectionRuntimeUnavailable')
    return services.dataBrowserService.listDatabases({ ownerId: payload.ownerId!, dataSessionId: payload.dataSessionId, generation: payload.generation })
  })
  handle(MANAGED_RESOURCES_IPC_CHANNELS.listSchemas, SqlListSchemasInputSchema, async (_event, payload) => {
    if (!services.dataBrowserService) return errorResult('UNAVAILABLE', 'managedResources.errors.dataConnectionRuntimeUnavailable')
    return services.dataBrowserService.listSchemas({ ownerId: payload.ownerId!, dataSessionId: payload.dataSessionId, generation: payload.generation })
  })
  handle(MANAGED_RESOURCES_IPC_CHANNELS.listTables, SqlListTablesInputSchema, async (_event, payload) => {
    if (!services.dataBrowserService) return errorResult('UNAVAILABLE', 'managedResources.errors.dataConnectionRuntimeUnavailable')
    return services.dataBrowserService.listTables({ ownerId: payload.ownerId!, dataSessionId: payload.dataSessionId, generation: payload.generation, schema: payload.schema })
  })
  handle(MANAGED_RESOURCES_IPC_CHANNELS.describeTable, SqlDescribeTableInputSchema, async (_event, payload) => {
    if (!services.dataBrowserService) return errorResult('UNAVAILABLE', 'managedResources.errors.dataConnectionRuntimeUnavailable')
    return services.dataBrowserService.describeTable({ ownerId: payload.ownerId!, dataSessionId: payload.dataSessionId, generation: payload.generation, schema: payload.schema, table: payload.table })
  })
  handle(MANAGED_RESOURCES_IPC_CHANNELS.previewTable, SqlPreviewInputSchema, async (_event, payload) => {
    if (!services.dataBrowserService) return errorResult('UNAVAILABLE', 'managedResources.errors.dataConnectionRuntimeUnavailable')
    return services.dataBrowserService.previewTable({ ...payload, ownerId: payload.ownerId! })
  })
  handle(MANAGED_RESOURCES_IPC_CHANNELS.executeQuery, SqlExecuteInputSchema, async (_event, payload) => {
    if (!services.dataBrowserService) return errorResult('UNAVAILABLE', 'managedResources.errors.dataConnectionRuntimeUnavailable')
    return services.dataBrowserService.executeQuery({ ...payload, ownerId: payload.ownerId! })
  })
  handle(MANAGED_RESOURCES_IPC_CHANNELS.cancelQuery, SqlCancelInputSchema, async (_event, payload) => {
    if (!services.dataBrowserService) return errorResult('UNAVAILABLE', 'managedResources.errors.dataConnectionRuntimeUnavailable')
    return services.dataBrowserService.cancelQuery({ ownerId: payload.ownerId!, dataSessionId: payload.dataSessionId, generation: payload.generation, queryId: payload.queryId })
  })
  handle(MANAGED_RESOURCES_IPC_CHANNELS.scanRedisKeys, RedisScanInputSchema, async (_event, payload) => {
    if (!services.dataBrowserService) return errorResult('UNAVAILABLE', 'managedResources.errors.dataConnectionRuntimeUnavailable')
    return services.dataBrowserService.scanKeys({ ...payload, ownerId: payload.ownerId! })
  })
  handle(MANAGED_RESOURCES_IPC_CHANNELS.readRedisKey, RedisReadInputSchema, async (_event, payload) => {
    if (!services.dataBrowserService) return errorResult('UNAVAILABLE', 'managedResources.errors.dataConnectionRuntimeUnavailable')
    return services.dataBrowserService.readKey({ ...payload, ownerId: payload.ownerId! })
  })

  // Context Selection: Get
  handle(MANAGED_RESOURCES_IPC_CHANNELS.getSelection, BaseIpcPayloadSchema.extend({ sessionId: z.string().min(1) }).strict(), async (_event, payload) => {
    const loaded = await services.selectionsRepo.load()
    if (loaded.status !== 'ready') {
      return errorResult(loaded.status.toUpperCase(), `managedResources.status.${loaded.status}`)
    }
    const selection = loaded.document.selections[payload.sessionId] ?? null
    return successResult(selection)
  })

  // Context Selection: Save
  handle(MANAGED_RESOURCES_IPC_CHANNELS.saveSelection, BaseIpcPayloadSchema.extend({ sessionId: z.string().min(1), selection: z.any() }).strict(), async (_event, payload) => {
    const saveRes = await services.selectionsRepo.save(payload.sessionId, payload.selection)
    if (saveRes.status === 'written') return successResult(undefined)
    return errorResult(saveRes.reason.toUpperCase(), `managedResources.errors.${saveRes.reason}`)
  })

  // Context Selection: Delete
  handle(MANAGED_RESOURCES_IPC_CHANNELS.deleteSelection, BaseIpcPayloadSchema.extend({ sessionId: z.string().min(1) }).strict(), async (_event, payload) => {
    const delRes = await services.selectionsRepo.delete(payload.sessionId)
    if (delRes.status === 'written') return successResult(undefined)
    return errorResult(delRes.reason.toUpperCase(), `managedResources.errors.${delRes.reason}`)
  })

  // Context Ticket: resolve and stage entirely in the trusted main process. The
  // renderer receives only the opaque ticket reference; modelContext never crosses IPC.
  handle(MANAGED_RESOURCES_IPC_CHANNELS.prepareContext, PrepareManagedContextInputSchema, async (_event, payload) => {
    const { ownerId: _ownerId, ...input } = payload
    const prepared = await prepareManagedContextStageRequest(services.store, input, services.vault)
    if (!prepared.ok) return prepared
    if (!options.contextTicketClient) {
      return errorResult('CONTEXT_STAGE_UNAVAILABLE', 'managedResources.errors.contextStageUnavailable')
    }
    return options.contextTicketClient.stage(prepared.data)
  })

  // Export Metadata
  handle(MANAGED_RESOURCES_IPC_CHANNELS.exportMetadata, BaseIpcPayloadSchema, async () => {
    const mainWindow = getMainWindow()
    const dlg = options.dialogService ?? ((await import('electron')).dialog as unknown as ManagedResourcesDialogService)
    return executeExportMetadata(mainWindow, services, dlg)
  })

  // Import Metadata
  handle(MANAGED_RESOURCES_IPC_CHANNELS.importMetadata, BaseIpcPayloadSchema, async () => {
    const mainWindow = getMainWindow()
    const dlg = options.dialogService ?? ((await import('electron')).dialog as unknown as ManagedResourcesDialogService)
    return executeImportMetadata(mainWindow, services, dlg)
  })

  // ==========================================
  // SSH Connection & Terminal (M3)
  // ==========================================
  //
  // Each SSH event is only forwarded to the BrowserWindow that owns the
  // connection. We register one global listener per mainWindow that filters
  // by connectionId before calling webContents.send. A second window
  // subscribing must NOT receive bytes for a connection it did not create.
  function ensureSshSubscription(mainWindow: BrowserWindow, ownerId: string) {
    const existing = sshSubscriptions.get(mainWindow.id)
    if (existing) return existing

    const ownedIds = new Set<string>()
    ownerConnections.set(mainWindow.id, ownedIds)

    const unlisten = services.sshService.subscribe((event) => {
      const id = (event as { connectionId?: unknown }).connectionId
      if (typeof id !== 'string') return
      if (!ownedIds.has(id)) return
      const target = mainWindow.webContents
      if (!target || target.isDestroyed()) return
      try {
        target.send(ELECTRON_EVENT_CHANNELS.mrEvent, event)
      } catch (sendErr) {
        // Scrub any address-shaped detail from upstream errors before logging.
        console.error('mrEvent send failed:', safeChannelMessage(sendErr))
      }
    })

    const sub = {
      unlisten: () => unlisten(),
      connectionIds: ownedIds,
    }
    sshSubscriptions.set(mainWindow.id, sub)
    void ownerId
    return sub
  }

  function mapSshError(err: unknown): HostManagementError {
    const msg = err instanceof Error ? err.message : String(err)
    const code = ((): string => {
      if (msg.includes('UNAUTHORIZED_OWNER')) return 'UNAUTHORIZED_OWNER'
      if (msg.includes('REVISION_CONFLICT')) return 'REVISION_CONFLICT'
      if (msg.includes('RESOURCE_NOT_FOUND') || msg.includes('Connection not found') || msg.includes('Host not found')) {
        return 'RESOURCE_NOT_FOUND'
      }
      if (msg.includes('STALE_GENERATION')) return 'DISCONNECTED'
      if (msg.includes('HOST_KEY_CHANGED')) return 'HOST_KEY_CHANGED'
      if (msg.includes('HOST_KEY_TIMEOUT') || msg.includes('HOST_VERIFICATION_ERROR')) return 'HOST_KEY_REQUIRED'
      if (msg.includes('NO_PENDING_CHALLENGE')) return 'HOST_KEY_REQUIRED'
      if (msg.includes('AUTH_FAILED') || msg.includes('All configured authentication methods failed')) return 'AUTH_FAILED'
      if (msg.includes('Connection limit exceeded')) return 'RESOURCE_IN_USE'
      if (msg.includes('Subscriber must be registered')) return 'DISCONNECTED'
      return 'INTERNAL_ERROR'
    })()
    // Strip any inline userinfo / password-like fragments from upstream
    // exception messages before they reach the renderer log.
    return {
      code,
      messageKey: 'managedResources.errors.sshOperationFailed',
      params: { reason: code },
    }
  }

  function requireMainWindow(): { mainWindow: BrowserWindow; ownerId: string } {
    const mainWindow = getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error('Main window unavailable')
    }
    return { mainWindow, ownerId: getOwnerIdForWindow(mainWindow) }
  }

  handle(MANAGED_RESOURCES_IPC_CHANNELS.createConnection, CreateConnectionInputSchema, async (_event, payload) => {
    const { mainWindow, ownerId } = requireMainWindow()
    const sub = ensureSshSubscription(mainWindow, ownerId)
    try {
      const res = await services.sshService.createConnection({
        hostId: payload.hostId,
        expectedRevision: payload.expectedRevision,
        cols: payload.cols ?? 80,
        rows: payload.rows ?? 24,
        ownerId,
      })
      sub.connectionIds.add(res.connectionId)
      return successResult(res)
    } catch (err) {
      const mapped = mapSshError(err)
      return errorResult(mapped.code, mapped.messageKey, mapped.params ? { params: mapped.params } : {})
    }
  })

  handle(MANAGED_RESOURCES_IPC_CHANNELS.startConnection, StartConnectionInputSchema, async (event, payload) => {
    const { mainWindow, ownerId } = requireMainWindow()
    const sub = ensureSshSubscription(mainWindow, ownerId)
    // Only createConnection grants ownership. A rejected start must never add
    // a foreign connection to the window's event-delivery allowlist.
    if (!sub.connectionIds.has(payload.connectionId)) {
      return errorResult('UNAUTHORIZED_OWNER', 'managedResources.errors.unauthorizedSender')
    }
    // ensureSshSubscription is the single IPC forwarding path. This binding
    // only authorizes start; forwarding here too duplicates every echoed byte.
    // Store it before awaiting so repeated/concurrent starts cannot leak binds.
    const existing = pendingStartUnlistens.get(payload.connectionId)
    const unlisten = existing ?? services.sshService.subscribeForConnection(
      payload.connectionId, ownerId, () => {},
    )
    if (!existing) pendingStartUnlistens.set(payload.connectionId, unlisten)
    try {
      await services.sshService.startConnection({
        connectionId: payload.connectionId,
        ownerId,
      })
      return successResult(undefined)
    } catch (err) {
      // Release only the binding this attempt installed.
      if (!existing && pendingStartUnlistens.get(payload.connectionId) === unlisten) {
        unlisten()
        pendingStartUnlistens.delete(payload.connectionId)
      }
      const mapped = mapSshError(err)
      return errorResult(mapped.code, mapped.messageKey, mapped.params ? { params: mapped.params } : {})
    } finally {
      void event
    }
  })

  handle(MANAGED_RESOURCES_IPC_CHANNELS.answerHostKey, AnswerHostKeyInputSchema, async (_event, payload) => {
    const { ownerId } = requireMainWindow()
    try {
      await services.sshService.answerHostKey({
        connectionId: payload.connectionId,
        challengeId: payload.challengeId,
        decision: payload.decision,
        ownerId,
      })
      return successResult(undefined)
    } catch (err) {
      const mapped = mapSshError(err)
      return errorResult(mapped.code, mapped.messageKey, mapped.params ? { params: mapped.params } : {})
    }
  })

  handle(MANAGED_RESOURCES_IPC_CHANNELS.writeConnection, WriteConnectionInputSchema, async (_event, payload) => {
    const { ownerId } = requireMainWindow()
    try {
      await services.sshService.write({
        connectionId: payload.connectionId,
        generation: payload.generation,
        data: payload.data,
        isBase64: payload.isBase64,
        ownerId,
      })
      return successResult(undefined)
    } catch (err) {
      const mapped = mapSshError(err)
      return errorResult(mapped.code, mapped.messageKey, mapped.params ? { params: mapped.params } : {})
    }
  })

  handle(MANAGED_RESOURCES_IPC_CHANNELS.resizeConnection, ResizeConnectionInputSchema, async (_event, payload) => {
    const { ownerId } = requireMainWindow()
    try {
      await services.sshService.resize({
        connectionId: payload.connectionId,
        generation: payload.generation,
        cols: payload.cols,
        rows: payload.rows,
        ownerId,
      })
      return successResult(undefined)
    } catch (err) {
      const mapped = mapSshError(err)
      return errorResult(mapped.code, mapped.messageKey, mapped.params ? { params: mapped.params } : {})
    }
  })

  handle(MANAGED_RESOURCES_IPC_CHANNELS.ackOutput, AckOutputInputSchema, async (_event, payload) => {
    const { ownerId } = requireMainWindow()
    try {
      await services.sshService.ackOutput({
        connectionId: payload.connectionId,
        generation: payload.generation,
        bytesAcked: payload.bytesAcked,
        ownerId,
      })
      return successResult(undefined)
    } catch (err) {
      const mapped = mapSshError(err)
      return errorResult(mapped.code, mapped.messageKey, mapped.params ? { params: mapped.params } : {})
    }
  })

  handle(MANAGED_RESOURCES_IPC_CHANNELS.disconnect, DisconnectConnectionInputSchema, async (_event, payload) => {
    const { mainWindow, ownerId } = requireMainWindow()
    try {
      await services.sshService.disconnect({
        connectionId: payload.connectionId,
        ownerId,
      })
      // Release any start-time subscription bind so the renderer can re-subscribe
      // for the next reconnect cleanly.
      const pendingUnlisten = pendingStartUnlistens.get(payload.connectionId)
      if (pendingUnlisten) {
        pendingUnlisten()
        pendingStartUnlistens.delete(payload.connectionId)
      }
      releaseConnectionForOwner(payload.connectionId, ownerId)
      const sub = sshSubscriptions.get(mainWindow.id)
      if (sub) sub.connectionIds.delete(payload.connectionId)
      return successResult(undefined)
    } catch (err) {
      const mapped = mapSshError(err)
      return errorResult(mapped.code, mapped.messageKey, mapped.params ? { params: mapped.params } : {})
    }
  })

  // ==========================================
  // SFTP / Transfer / Remote Edit (M4 — F29-02)
  // ==========================================
  //
  // Every M4 channel below uses an explicit strict Zod schema AND resolves
  // the canonical owner from `requireMainWindow()` BEFORE invoking the
  // service. The renderer's `payload.ownerId` is untrusted input: it is
  // overwritten by the canonical owner inside `handle()` and is not used to
  // authorize any operation.
  //
  // Service error codes are mapped to HostManagementError codes by
  // `mapM4Error`, which mirrors the typed `TransferError` union from
  // sftpService.ts.

  function mapM4Error(err: unknown): HostManagementError {
    const msg = err instanceof Error ? err.message : String(err ?? '')
    if (['ATOMIC_REPLACE_UNSUPPORTED', 'SAVE_REPLACE_FAILED', 'SAVE_IN_PROGRESS', 'REMOTE_IO_TIMEOUT', 'NO_SPACE', 'SFTP_OPERATION_FAILED'].includes(msg)) return { code: msg, messageKey: 'managedResources.errors.sshOperationFailed', params: { reason: msg } }
    if (['TARGET_EXISTS', 'TRANSFER_FINALIZING', 'TRANSFER_LIMIT', 'DUPLICATE_JOB_ID', 'CANCELLED'].includes(msg)) return { code: msg, messageKey: 'managedResources.errors.sshOperationFailed', params: { reason: msg } }
    if (msg.includes('UNAUTHORIZED_OWNER')) return { code: 'UNAUTHORIZED_OWNER', messageKey: 'managedResources.errors.sshOperationFailed', params: { reason: 'UNAUTHORIZED_OWNER' } }
    if (msg.includes('STALE_GENERATION')) return { code: 'STALE_GENERATION', messageKey: 'managedResources.errors.sshOperationFailed', params: { reason: 'STALE_GENERATION' } }
    if (msg.includes('CONNECTION_LOST') || msg.includes('ECONNRESET') || msg.includes('EPIPE')) {
      return { code: 'CONNECTION_LOST', messageKey: 'managedResources.errors.sshOperationFailed', params: { reason: 'CONNECTION_LOST' } }
    }
    if (msg.includes('CHECKSUM_MISMATCH')) return { code: 'CHECKSUM_MISMATCH', messageKey: 'managedResources.errors.sshOperationFailed', params: { reason: 'CHECKSUM_MISMATCH' } }
    if (msg.includes('SIZE_MISMATCH')) return { code: 'SIZE_MISMATCH', messageKey: 'managedResources.errors.sshOperationFailed', params: { reason: 'SIZE_MISMATCH' } }
    if (msg.includes('INVALID_LOCAL_PATH')) return { code: 'INVALID_LOCAL_PATH', messageKey: 'managedResources.errors.sshOperationFailed', params: { reason: 'INVALID_LOCAL_PATH' } }
    if (msg.includes('INVALID_REMOTE_PATH')) return { code: 'INVALID_REMOTE_PATH', messageKey: 'managedResources.errors.sshOperationFailed', params: { reason: 'INVALID_REMOTE_PATH' } }
    if (msg.includes('INVALID_ENCODING')) return { code: 'INVALID_ENCODING', messageKey: 'managedResources.errors.sshOperationFailed', params: { reason: 'INVALID_ENCODING' } }
    if (msg.includes('REVISION_CONFLICT')) return { code: 'REVISION_CONFLICT', messageKey: 'managedResources.errors.sshOperationFailed', params: { reason: 'REVISION_CONFLICT' } }
    if (msg.includes('NOT_A_DIRECTORY')) return { code: 'NOT_A_DIRECTORY', messageKey: 'managedResources.errors.sshOperationFailed', params: { reason: 'NOT_A_DIRECTORY' } }
    if (msg.includes('NOT_A_FILE') || msg.includes('EISDIR')) return { code: 'NOT_A_FILE', messageKey: 'managedResources.errors.sshOperationFailed', params: { reason: 'NOT_A_FILE' } }
    if (msg.includes('IS_SYMLINK')) return { code: 'IS_SYMLINK', messageKey: 'managedResources.errors.sshOperationFailed', params: { reason: 'IS_SYMLINK' } }
    if (msg.includes('FILE_TOO_LARGE')) return { code: 'FILE_TOO_LARGE', messageKey: 'managedResources.errors.sshOperationFailed', params: { reason: 'FILE_TOO_LARGE' } }
    if (msg.includes('PERMISSION_DENIED') || msg.includes('EACCES')) {
      return { code: 'PERMISSION_DENIED', messageKey: 'managedResources.errors.sshOperationFailed', params: { reason: 'PERMISSION_DENIED' } }
    }
    if (msg.includes('RESOURCE_NOT_FOUND')) return { code: 'RESOURCE_NOT_FOUND', messageKey: 'managedResources.errors.notFound' }
    if (msg.includes('DISCONNECTED')) return { code: 'DISCONNECTED', messageKey: 'managedResources.errors.sshOperationFailed', params: { reason: 'DISCONNECTED' } }
    if (msg.includes('SFTP_UNAVAILABLE')) return { code: 'INTERNAL_ERROR', messageKey: 'managedResources.errors.internal' }
    return { code: 'INTERNAL_ERROR', messageKey: 'managedResources.errors.internal' }
  }

  handle(MANAGED_RESOURCES_IPC_CHANNELS.mintUploadToken, MintTokenInputSchema, async (_event, payload) => {
    const { ownerId } = requireMainWindow()
    try {
      if (options.dialogService) {
        const mainWindow = getMainWindow()!
        const selected = await options.dialogService.showOpenDialog(mainWindow, {
          title: 'Select file to upload',
          properties: ['openFile'],
        })
        if (selected.canceled || selected.filePaths.length === 0) {
          return errorResult('CANCELLED', 'managedResources.errors.cancelled')
        }
        const sourcePath = selected.filePaths[0]!
        const token = await services.localPathService.mintUploadToken({
          ownerId,
          fileName: path.basename(sourcePath),
        })
        try {
          await fsp.copyFile(sourcePath, token.absolutePath)
          // The native disk copy may itself take minutes for a large file.
          services.localPathService.renewToken(token.token, ownerId)
        } catch (error) {
          services.localPathService.revokeToken(token.token, ownerId)
          await fsp.unlink(token.absolutePath).catch(() => undefined)
          throw error
        }
        return successResult(token)
      }
      const token = await services.localPathService.mintUploadToken({ ownerId, fileName: payload.fileName })
      return successResult(token)
    } catch (err) {
      const mapped = mapM4Error(err)
      if (mapped.code === 'INTERNAL_ERROR') return errorResult('LOCAL_IO_ERROR', 'managedResources.errors.sshOperationFailed', { params: { reason: 'LOCAL_IO_ERROR' } })
      return errorResult(mapped.code, mapped.messageKey, mapped.params ? { params: mapped.params } : {})
    }
  })
  handle(MANAGED_RESOURCES_IPC_CHANNELS.mintDownloadToken, MintTokenInputSchema, async (_event, payload) => {
    const { ownerId } = requireMainWindow()
    try {
      if (options.dialogService) {
        const mainWindow = getMainWindow()!
        const selected = await options.dialogService.showSaveDialog(mainWindow, {
          title: 'Save remote file',
          defaultPath: payload.fileName,
        })
        if (selected.canceled || !selected.filePath) {
          return errorResult('CANCELLED', 'managedResources.errors.cancelled')
        }
        const token = await services.localPathService.mintDownloadToken({
          ownerId,
          fileName: path.basename(selected.filePath) || payload.fileName,
        })
        pendingDownloadTargets.set(token.token, { ownerId, targetPath: selected.filePath })
        return successResult(token)
      }
      const token = await services.localPathService.mintDownloadToken({ ownerId, fileName: payload.fileName })
      return successResult(token)
    } catch (err) {
      const mapped = mapM4Error(err)
      return errorResult(mapped.code, mapped.messageKey, mapped.params ? { params: mapped.params } : {})
    }
  })
  // resolveLocalToken MUST NEVER return the absolute local path. The handler
  // only validates that the token is a UUID owned by the canonical owner;
  // the actual path resolution happens server-side inside transferService
  // when a start-download/start-upload request is received.
  handle(MANAGED_RESOURCES_IPC_CHANNELS.resolveLocalToken, ResolveTokenInputSchema, async (_event, payload) => {
    const { ownerId } = requireMainWindow()
    try {
      const resolved = services.localPathService.resolveToken(payload.token, ownerId, 'upload-source')
        ?? services.localPathService.resolveToken(payload.token, ownerId, 'download-target')
      if (!resolved) return errorResult('UNAUTHORIZED_OWNER', 'managedResources.errors.unauthorizedOwner')
      return successResult({ ok: true, token: payload.token })
    } catch (err) {
      const mapped = mapM4Error(err)
      return errorResult(mapped.code, mapped.messageKey, mapped.params ? { params: mapped.params } : {})
    }
  })
  handle(MANAGED_RESOURCES_IPC_CHANNELS.revokeLocalToken, RevokeTokenInputSchema, async (_event, payload) => {
    const { ownerId } = requireMainWindow()
    try {
      services.localPathService.revokeToken(payload.token, ownerId)
      const pendingTarget = pendingDownloadTargets.get(payload.token)
      if (pendingTarget?.ownerId === ownerId) pendingDownloadTargets.delete(payload.token)
      return successResult({ ok: true })
    } catch (err) {
      const mapped = mapM4Error(err)
      return errorResult(mapped.code, mapped.messageKey, mapped.params ? { params: mapped.params } : {})
    }
  })
  handle(MANAGED_RESOURCES_IPC_CHANNELS.sftpList, SftpListInputSchema, async (_event, payload) => {
    const { ownerId } = requireMainWindow()
    try {
      const result = await services.sftpService.listDirectory({
        connectionId: payload.connectionId,
        ownerId,
        generation: payload.generation,
        absolutePath: payload.absolutePath,
      })
      return successResult(result)
    } catch (err) {
      const mapped = mapM4Error(err)
      return errorResult(mapped.code, mapped.messageKey, mapped.params ? { params: mapped.params } : {})
    }
  })
  handle(MANAGED_RESOURCES_IPC_CHANNELS.sftpStat, SftpStatInputSchema, async (_event, payload) => {
    const { ownerId } = requireMainWindow()
    try {
      const result = await services.sftpService.stat({
        connectionId: payload.connectionId,
        ownerId,
        generation: payload.generation,
        absolutePath: payload.absolutePath,
      })
      return successResult(result)
    } catch (err) {
      const mapped = mapM4Error(err)
      return errorResult(mapped.code, mapped.messageKey, mapped.params ? { params: mapped.params } : {})
    }
  })
  handle(MANAGED_RESOURCES_IPC_CHANNELS.transferStartDownload, TransferStartDownloadInputSchema, async (_event, payload) => {
    const { ownerId } = requireMainWindow()
    try {
      const job = await services.transferService.startDownload({
        jobId: payload.jobId,
        connectionId: payload.connectionId,
        ownerId,
        generation: payload.generation,
        remotePath: payload.remotePath,
        localToken: payload.localToken,
      })
      const target = pendingDownloadTargets.get(payload.localToken)
      if (job.state === 'completed' && target?.ownerId === ownerId) {
        try {
          await finalizeNativeDownload(job.localPath, target.targetPath)
          pendingDownloadTargets.delete(payload.localToken)
        } catch {
          pendingDownloadTargets.delete(payload.localToken)
          return errorResult('LOCAL_IO_ERROR', 'managedResources.errors.sshOperationFailed', { params: { reason: 'LOCAL_IO_ERROR' } })
        }
      }
      return successResult(job)
    } catch (err) {
      const mapped = mapM4Error(err)
      return errorResult(mapped.code, mapped.messageKey, mapped.params ? { params: mapped.params } : {})
    }
  })
  handle(MANAGED_RESOURCES_IPC_CHANNELS.transferStartUpload, TransferStartUploadInputSchema, async (_event, payload) => {
    const { ownerId } = requireMainWindow()
    try {
      const job = await services.transferService.startUpload({
        jobId: payload.jobId,
        connectionId: payload.connectionId,
        ownerId,
        generation: payload.generation,
        remotePath: payload.remotePath,
        localToken: payload.localToken,
      })
      return successResult(job)
    } catch (err) {
      const mapped = mapM4Error(err)
      return errorResult(mapped.code, mapped.messageKey, mapped.params ? { params: mapped.params } : {})
    }
  })
  const pendingFolderPicks = new Map<string, { ownerId: string; cancelled: boolean }>()
  for (const direction of ['upload', 'download'] as const) {
    const channel = direction === 'upload' ? MANAGED_RESOURCES_IPC_CHANNELS.transferUploadFolder : MANAGED_RESOURCES_IPC_CHANNELS.transferDownloadFolder
    handle(channel, FolderTransferInputSchema, async (event, payload) => {
      const { mainWindow, ownerId } = requireMainWindow()
      if (pendingFolderPicks.has(payload.jobId) || services.transferService.getJob(payload.jobId, ownerId)) return errorResult('DUPLICATE_JOB_ID', 'managedResources.errors.internal')
      if (pendingFolderPicks.size >= 3) return errorResult('TRANSFER_LIMIT', 'managedResources.errors.internal')
      const pending = { ownerId, cancelled: false }
      pendingFolderPicks.set(payload.jobId, pending)
      try {
        // Validate the connection before asking for filesystem access.
        await services.sftpService.stat({ ...payload, ownerId, absolutePath: payload.remotePath })
        if (pending.cancelled) return errorResult('CANCELLED', 'managedResources.errors.cancelled')
        const dialogs = options.dialogService ?? ((await import('electron')).dialog as unknown as ManagedResourcesDialogService)
        const picked = await dialogs.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
        if (pending.cancelled || picked.canceled || picked.filePaths.length !== 1) return errorResult('CANCELLED', 'managedResources.errors.cancelled')
        const denied = validateCaller(event, payload)
        if (denied) return { ok: false, error: denied }
        const input = { ...payload, ownerId, localRoot: picked.filePaths[0]! }
        const job = direction === 'upload' ? await services.transferService.startFolderUpload(input) : await services.transferService.startFolderDownload(input)
        // Do not send the native selection or owner through IPC, even transiently.
        const { localPath: _local, ownerId: _owner, ...published } = job
        return successResult(published)
      } catch (error) {
        const mapped = mapM4Error(error)
        return errorResult(mapped.code, mapped.messageKey, mapped.params ? { params: mapped.params } : {})
      } finally {
        pendingFolderPicks.delete(payload.jobId)
      }
    })
  }

  handle(MANAGED_RESOURCES_IPC_CHANNELS.transferCancel, TransferCancelInputSchema, async (_event, payload) => {
    const { ownerId } = requireMainWindow()
    try {
      const pending = pendingFolderPicks.get(payload.jobId)
      if (pending?.ownerId === ownerId) pending.cancelled = true
      if (pending && !services.transferService.getJob(payload.jobId, ownerId)) return successResult({ ok: true })
      await services.transferService.cancel(payload.jobId, ownerId)
      return successResult({ ok: true })
    } catch (err) {
      const mapped = mapM4Error(err)
      return errorResult(mapped.code, mapped.messageKey, mapped.params ? { params: mapped.params } : {})
    }
  })
  handle(MANAGED_RESOURCES_IPC_CHANNELS.transferGet, TransferGetInputSchema, async (_event, payload) => {
    const { ownerId } = requireMainWindow()
    try {
      const job = services.transferService.getJob(payload.jobId, ownerId)
      if (!job) return errorResult('RESOURCE_NOT_FOUND', 'managedResources.errors.notFound', {})
      return successResult(job)
    } catch (err) {
      const mapped = mapM4Error(err)
      return errorResult(mapped.code, mapped.messageKey, mapped.params ? { params: mapped.params } : {})
    }
  })
  handle(MANAGED_RESOURCES_IPC_CHANNELS.remoteEditOpen, RemoteEditOpenInputSchema, async (_event, payload) => {
    const { ownerId } = requireMainWindow()
    try {
      const result = await services.remoteEditService.open({
        connectionId: payload.connectionId,
        ownerId,
        generation: payload.generation,
        absolutePath: payload.absolutePath,
      })
      return successResult(result)
    } catch (err) {
      const mapped = mapM4Error(err)
      return errorResult(mapped.code, mapped.messageKey, mapped.params ? { params: mapped.params } : {})
    }
  })
  handle(MANAGED_RESOURCES_IPC_CHANNELS.remoteEditSave, RemoteEditSaveInputSchema, async (_event, payload) => {
    const { ownerId } = requireMainWindow()
    try {
      const result = await services.remoteEditService.save({
        editId: payload.editId,
        baseRevision: payload.baseRevision,
        text: payload.text,
        ownerId,
      })
      return successResult(result)
    } catch (err) {
      const mapped = mapM4Error(err)
      return errorResult(mapped.code, mapped.messageKey, mapped.params ? { params: mapped.params } : {})
    }
  })
  handle(MANAGED_RESOURCES_IPC_CHANNELS.remoteEditClose, RemoteEditCloseInputSchema, async (_event, payload) => {
    const { ownerId } = requireMainWindow()
    try {
      await services.remoteEditService.close(payload.editId, ownerId)
      return successResult({ ok: true })
    } catch (err) {
      const mapped = mapM4Error(err)
      return errorResult(mapped.code, mapped.messageKey, mapped.params ? { params: mapped.params } : {})
    }
  })

  return () => {
    for (const ch of registeredChannels) {
      ipcMain.removeHandler(ch)
    }
    registeredChannels.clear()
    applicationOperations.dispose()
    hostTools.dispose()
    for (const pending of pendingFolderPicks.values()) pending.cancelled = true
    pendingFolderPicks.clear()
    for (const unlisten of pendingStartUnlistens.values()) unlisten()
    pendingStartUnlistens.clear()
    for (const sub of sshSubscriptions.values()) sub.unlisten()
    sshSubscriptions.clear()
    ownerConnections.clear()
    pendingDownloadTargets.clear()
    void services.dataBrowserService?.dispose().catch(() => undefined)
    void services.sshService.dispose().catch(() => undefined)
  }
}
