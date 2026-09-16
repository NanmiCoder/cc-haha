import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import type { ManagedResourcesServices, ManagedResourcesDialogService } from '../registerIpc.js'
import type { HostManagementResult } from '../../../../src/features/managed-resources/api/hostManagementApi.js'
import { scanForSecrets } from './secretDenylist.js'

export type ExportMetadataResult = {
  exportedCount: number
  filePath: string
}

export async function executeExportMetadata(
  mainWindow: BrowserWindow | null,
  services: ManagedResourcesServices,
  dialogService?: ManagedResourcesDialogService,
): Promise<HostManagementResult<ExportMetadataResult>> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return {
      ok: false,
      error: { code: 'UNAUTHORIZED_OWNER', messageKey: 'managedResources.errors.windowDestroyed' },
    }
  }

  const loaded = await services.store.load()
  if (loaded.status !== 'ready') {
    return {
      ok: false,
      error: { code: loaded.status.toUpperCase(), messageKey: `managedResources.status.${loaded.status}` },
    }
  }

  const doc = loaded.document

  // Explicit Public DTOs - strictly NO spreading unknown objects
  const publicTags = doc.tags.map(tag => ({
    id: tag.id,
    revision: tag.revision,
    namespace: tag.namespace,
    name: tag.name,
    normalizedName: tag.normalizedName,
    colorToken: tag.colorToken ?? null,
    createdAt: tag.createdAt,
    updatedAt: tag.updatedAt,
  }))

  const publicHosts = doc.hosts.map(host => ({
    id: host.id,
    revision: host.revision,
    name: host.name,
    address: host.address,
    port: host.port,
    username: host.username,
    auth: {
      type: host.auth.type,
      credentialId: null, // Always stripped
    },
    tagIds: [...host.tagIds],
    initialDirectory: host.initialDirectory ?? null,
    applications: host.applications.map(app => ({
      id: app.id,
      name: app.name,
      version: app.version ?? null,
      installPaths: [...app.installPaths],
      accessDescription: app.accessDescription,
      accessUrls: [...app.accessUrls],
      loginUrl: app.loginUrl ?? null,
      accounts: app.accounts.map(acc => ({
        id: acc.id,
        label: acc.label,
        username: acc.username,
        credentialId: null, // Always stripped
      })),
      notes: app.notes,
    })),
    notes: host.notes,
    createdAt: host.createdAt,
    updatedAt: host.updatedAt,
  }))

  const publicConcepts = doc.concepts.map(concept => ({
    id: concept.id,
    revision: concept.revision,
    title: concept.title,
    summary: concept.summary,
    bodyMarkdown: concept.bodyMarkdown,
    tagIds: [...concept.tagIds],
    dependsOnIds: [...concept.dependsOnIds],
    referenceIds: [...concept.referenceIds],
    createdAt: concept.createdAt,
    updatedAt: concept.updatedAt,
  }))

  const publicDataConnections = doc.dataConnections.map(dc => {
    const base = {
      id: dc.id,
      revision: dc.revision,
      name: dc.name,
      address: dc.address,
      port: dc.port,
      username: dc.username ?? null,
      credentialId: null, // Always stripped
      tagIds: [...dc.tagIds],
      relatedHostId: dc.relatedHostId ?? null,
      environment: dc.environment,
      tls: {
        enabled: dc.tls.enabled,
        serverName: dc.tls.serverName ?? null,
        caCertificate: dc.tls.caCertificate ?? null,
        clientCertificate: dc.tls.clientCertificate ?? null,
        clientKeyCredentialId: null, // Always stripped
      },
      description: dc.description,
      accessInstructions: dc.accessInstructions,
      createdAt: dc.createdAt,
      updatedAt: dc.updatedAt,
    }
    if (dc.kind === 'database') {
      return {
        ...base,
        kind: 'database' as const,
        engine: dc.engine,
        database: dc.database,
        schema: dc.schema ?? null,
        mode: dc.mode,
      }
    }
    return {
      ...base,
      kind: 'redis' as const,
      topology: dc.topology,
      databaseIndex: dc.databaseIndex,
      keyPrefixDescription: dc.keyPrefixDescription,
    }
  })

  const publicKnownHostKeys = doc.knownHostKeys.map(khk => ({
    endpoint: khk.endpoint,
    algorithm: khk.algorithm,
    sha256: khk.sha256,
    trustedAt: khk.trustedAt,
  }))

  const exportPayload = {
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    hosts: publicHosts,
    tags: publicTags,
    concepts: publicConcepts,
    dataConnections: publicDataConnections,
    knownHostKeys: publicKnownHostKeys,
    credentials: [], // Always empty
  }

  // Pre-serialization secret scan
  const secretCheck = scanForSecrets(exportPayload)
  if (secretCheck.detected) {
    return {
      ok: false,
      error: {
        code: 'CREDENTIAL_LEAK_DETECTED',
        messageKey: 'managedResources.errors.credentialLeakDetected',
        params: { path: secretCheck.path },
      },
    }
  }

  // File dialog
  if (!dialogService) {
    return {
      ok: false,
      error: { code: 'UNAVAILABLE', messageKey: 'managedResources.errors.dialogUnavailable' },
    }
  }

  const saveDialogResult = await dialogService.showSaveDialog(mainWindow, {
    title: 'Export Managed Resources Metadata',
    defaultPath: 'managed-resources-export.json',
    filters: [{ name: 'JSON Files', extensions: ['json'] }],
  })

  if (saveDialogResult.canceled || !saveDialogResult.filePath) {
    return {
      ok: false,
      error: { code: 'CANCELLED', messageKey: 'managedResources.errors.cancelled' },
    }
  }

  const targetPath = saveDialogResult.filePath
  const targetDir = path.dirname(targetPath)
  const tempPath = path.join(targetDir, `.mr-export.${randomUUID()}.tmp`)
  const jsonContent = JSON.stringify(exportPayload, null, 2)

  try {
    await fs.writeFile(tempPath, jsonContent, 'utf-8')
    await fs.rename(tempPath, targetPath)
  } catch (err: any) {
    await fs.unlink(tempPath).catch(() => undefined)
    return {
      ok: false,
      error: { code: 'WRITE_FAILED', messageKey: 'managedResources.errors.writeFailed', params: { detail: err?.message } },
    }
  }

  const totalCount = publicHosts.length + publicTags.length + publicConcepts.length + publicDataConnections.length
  return {
    ok: true,
    data: {
      exportedCount: totalCount,
      filePath: targetPath,
    },
  }
}
