import fs from 'node:fs/promises'
import { PublicImportDocumentSchema as ImportDocumentSchema } from './publicImportSchema.js'
import { hasImportRevisionConflict, mergePublicMetadata } from './publicMetadataMerge.js'
import type { BrowserWindow } from 'electron'
import type { ManagedResourcesServices, ManagedResourcesDialogService } from '../registerIpc.js'
import type { HostManagementResult } from '../../../../src/features/managed-resources/api/hostManagementApi.js'
import { scanForSecrets } from './secretDenylist.js'
import type { Host, DataConnection } from '../../../../src/features/managed-resources/types/resourceTypes.js'
import { validateResourceDocumentIntegrity, type ResourceIntegrityIssue } from '../repositories/resourceDocumentIntegrity.js'
import { RESOURCE_DOCUMENT_MAX_BYTES } from '../repositories/resourceDocumentRepository.js'

export type ImportMetadataResult = {
  importedCount: number
  filePath: string
}

export async function executeImportMetadata(
  mainWindow: BrowserWindow | null,
  services: ManagedResourcesServices,
  dialogService?: ManagedResourcesDialogService,
): Promise<HostManagementResult<ImportMetadataResult>> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return {
      ok: false,
      error: { code: 'UNAUTHORIZED_OWNER', messageKey: 'managedResources.errors.windowDestroyed' },
    }
  }

  if (!dialogService) {
    return {
      ok: false,
      error: { code: 'UNAVAILABLE', messageKey: 'managedResources.errors.dialogUnavailable' },
    }
  }

  const openDialogResult = await dialogService.showOpenDialog(mainWindow, {
    title: 'Import Managed Resources Metadata',
    filters: [{ name: 'JSON Files', extensions: ['json'] }],
    properties: ['openFile'],
  })

  if (openDialogResult.canceled || !openDialogResult.filePaths || openDialogResult.filePaths.length === 0) {
    return {
      ok: false,
      error: { code: 'CANCELLED', messageKey: 'managedResources.errors.cancelled' },
    }
  }

  const targetPath = openDialogResult.filePaths[0]!

  let stats: Awaited<ReturnType<typeof fs.stat>>
  try {
    stats = await fs.stat(targetPath)
  } catch (err: any) {
    return {
      ok: false,
      error: { code: 'RESOURCE_NOT_FOUND', messageKey: 'managedResources.errors.fileNotFound' },
    }
  }

  if (stats.size > RESOURCE_DOCUMENT_MAX_BYTES) {
    return {
      ok: false,
      error: { code: 'FILE_TOO_LARGE', messageKey: 'managedResources.errors.fileTooLarge' },
    }
  }

  let fileContent: string
  try {
    const rawBytes = await fs.readFile(targetPath)
    if (rawBytes.byteLength > RESOURCE_DOCUMENT_MAX_BYTES) {
      return { ok: false, error: { code: 'FILE_TOO_LARGE', messageKey: 'managedResources.errors.fileTooLarge' } }
    }
    const decoder = new TextDecoder('utf-8', { fatal: true })
    fileContent = decoder.decode(rawBytes)
  } catch {
    return {
      ok: false,
      error: { code: 'VALIDATION_FAILED', messageKey: 'managedResources.errors.invalidUtf8' },
    }
  }

  let rawJson: unknown
  try {
    rawJson = JSON.parse(fileContent)
  } catch {
    return {
      ok: false,
      error: { code: 'INVALID_ARGUMENT', messageKey: 'managedResources.errors.invalidJson' },
    }
  }

  if (typeof rawJson !== 'object' || rawJson === null || Array.isArray(rawJson)) {
    return {
      ok: false,
      error: { code: 'INVALID_ARGUMENT', messageKey: 'managedResources.errors.invalidDocumentShape' },
    }
  }

  // Check secret denylist (recursively scans all keys and string values including URLs with userinfo)
  const secretCheck = scanForSecrets(rawJson)
  if (secretCheck.detected) {
    return {
      ok: false,
      error: {
        code: 'CREDENTIAL_LEAK_DETECTED',
        messageKey: 'managedResources.errors.credentialLeakDetected',
        params: { path: secretCheck.path, reason: secretCheck.reason },
      },
    }
  }

  // Check version
  const candidateVersion = (rawJson as any).schemaVersion
  if (typeof candidateVersion === 'number' && candidateVersion > 2) {
    return {
      ok: false,
      error: { code: 'NEWER_SCHEMA_VERSION', messageKey: 'managedResources.errors.newerSchemaVersion' },
    }
  }

  // Strict schema validation (must have all collections, schemaVersion === 2)
  const parsed = ImportDocumentSchema.safeParse(rawJson)
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION_FAILED',
        messageKey: 'managedResources.errors.invalidImportSchema',
        params: { issues: parsed.error.issues },
      },
    }
  }

  const importDoc = parsed.data

  const loaded = await services.store.load()
  if (loaded.status !== 'ready') {
    return {
      ok: false,
      error: { code: loaded.status.toUpperCase(), messageKey: `managedResources.status.${loaded.status}` },
    }
  }

  type ImportTxResult =
    | { success: true; totalImported: number }
    | { success: false; code: 'REVISION_CONFLICT'; message: string; issues: ResourceIntegrityIssue[] }
    | { success: false; code: 'NAMESPACE_CONFLICT'; message: string; issues: ResourceIntegrityIssue[] }
    | { success: false; code: 'INTEGRITY_FAILED'; message?: string; issues: ResourceIntegrityIssue[] }

  // Perform atomic transactional commit bound to expectedDocumentRevision
  const txResult = await services.store.transact<ImportTxResult>({
    expectedDocumentRevision: loaded.document.revision,
    mutate(draft) {
      // 1. Preserve all existing credentials untouched
      const existingCredentials = [...draft.credentials]

      // 2. Map existing credentials by host / app / dataConnection
      const existingHostAuthCreds = new Map<string, string | null>()
      const existingAppCreds = new Map<string, string | null>()
      const existingDataConnectionCreds = new Map<string, string | null>()

      for (const host of draft.hosts) {
        if (host.auth.credentialId) {
          existingHostAuthCreds.set(host.id, host.auth.credentialId)
        }
        for (const app of host.applications) {
          for (const acc of app.accounts) {
            if (acc.credentialId) {
              existingAppCreds.set(`${host.id}:${app.id}:${acc.id}`, acc.credentialId)
            }
          }
        }
      }
      for (const dc of draft.dataConnections) {
        if (dc.credentialId) {
          existingDataConnectionCreds.set(dc.id, dc.credentialId)
        }
      }

      // 3. Stale revision & Merge Hosts
      const hostMap = new Map(draft.hosts.map(h => [h.id, h]))
      for (const host of importDoc.hosts) {
        const existing = hostMap.get(host.id)
        if (existing && hasImportRevisionConflict(existing, host)) {
          return {
            commit: false,
            value: {
              success: false,
              code: 'REVISION_CONFLICT',
              message: `Host revision conflict for ${host.id}: incoming ${host.revision}, existing ${existing.revision}`,
              issues: [],
            },
          }
        }
        const mergedHost: Host = {
          ...host,
          auth: {
            ...host.auth,
            credentialId: existingHostAuthCreds.get(host.id) ?? null,
          },
          applications: host.applications.map(app => ({
            ...app,
            accounts: app.accounts.map(acc => ({
              ...acc,
              credentialId: existingAppCreds.get(`${host.id}:${app.id}:${acc.id}`) ?? null,
            })),
          })),
        }
        hostMap.set(host.id, mergePublicMetadata(existing, mergedHost))
      }
      draft.hosts = Array.from(hostMap.values())

      // 4. Stale revision & Merge Tags
      const tagMap = new Map(draft.tags.map(t => [t.id, t]))
      for (const tag of importDoc.tags) {
        const existing = tagMap.get(tag.id)
        if (existing && hasImportRevisionConflict(existing, tag)) {
          return {
            commit: false,
            value: {
              success: false,
              code: 'REVISION_CONFLICT',
              message: `Tag revision conflict for ${tag.id}: incoming ${tag.revision}, existing ${existing.revision}`,
              issues: [],
            },
          }
        }
        tagMap.set(tag.id, mergePublicMetadata(existing, tag))
      }
      draft.tags = Array.from(tagMap.values())

      // Check tag normalizedName uniqueness per namespace
      const seenTagNormalized = new Map<string, string>()
      for (const tag of draft.tags) {
        const key = `${tag.namespace}:${tag.normalizedName}`
        const existingId = seenTagNormalized.get(key)
        if (existingId && existingId !== tag.id) {
          return {
            commit: false,
            value: {
              success: false,
              code: 'NAMESPACE_CONFLICT',
              message: `Tag normalized name conflict in namespace ${tag.namespace}: ${tag.name} (${tag.normalizedName}) conflicts with tag id ${existingId}`,
              issues: [],
            },
          }
        }
        seenTagNormalized.set(key, tag.id)
      }

      // 5. Stale revision & Merge Concepts
      const conceptMap = new Map(draft.concepts.map(c => [c.id, c]))
      for (const concept of importDoc.concepts) {
        const existing = conceptMap.get(concept.id)
        if (existing && hasImportRevisionConflict(existing, concept)) {
          return {
            commit: false,
            value: {
              success: false,
              code: 'REVISION_CONFLICT',
              message: `Concept revision conflict for ${concept.id}: incoming ${concept.revision}, existing ${existing.revision}`,
              issues: [],
            },
          }
        }
        conceptMap.set(concept.id, mergePublicMetadata(existing, concept))
      }
      draft.concepts = Array.from(conceptMap.values())

      // 6. Stale revision & Merge DataConnections
      const dcMap = new Map(draft.dataConnections.map(dc => [dc.id, dc]))
      for (const dc of importDoc.dataConnections) {
        const existing = dcMap.get(dc.id)
        if (existing && hasImportRevisionConflict(existing, dc)) {
          return {
            commit: false,
            value: {
              success: false,
              code: 'REVISION_CONFLICT',
              message: `Data connection revision conflict for ${dc.id}: incoming ${dc.revision}, existing ${existing.revision}`,
              issues: [],
            },
          }
        }
        const mergedDc: DataConnection = {
          ...dc,
          credentialId: existingDataConnectionCreds.get(dc.id) ?? null,
        }
        dcMap.set(dc.id, mergePublicMetadata(existing, mergedDc))
      }
      draft.dataConnections = Array.from(dcMap.values())

      // 7. Merge KnownHostKeys
      const khkMap = new Map(draft.knownHostKeys.map(k => [`${k.endpoint}:${k.algorithm}`, k]))
      for (const khk of importDoc.knownHostKeys) {
        const key = `${khk.endpoint}:${khk.algorithm}`
        const existing = khkMap.get(key)
        if (existing && existing.sha256 !== khk.sha256) {
          return { commit: false, value: { success: false, code: 'REVISION_CONFLICT', message: 'Import cannot replace a trusted host key', issues: [] } }
        }
        khkMap.set(key, existing ?? khk)
      }
      draft.knownHostKeys = Array.from(khkMap.values())

      // Re-assert existing credentials untouched
      draft.credentials = existingCredentials

      // 8. Referential integrity validation
      const integrityIssues = validateResourceDocumentIntegrity(draft)
      if (integrityIssues.length > 0) {
        return {
          commit: false,
          value: { success: false, code: 'INTEGRITY_FAILED', issues: integrityIssues },
        }
      }

      const totalImported = importDoc.hosts.length + importDoc.tags.length + importDoc.concepts.length + importDoc.dataConnections.length
      return {
        commit: true,
        value: { success: true, totalImported },
      }
    },
  })

  if (txResult.status === 'committed') {
    return {
      ok: true,
      data: {
        importedCount: txResult.value.success ? txResult.value.totalImported : 0,
        filePath: targetPath,
      },
    }
  }

  if (txResult.status === 'aborted') {
    const val = txResult.value
    if (val && !val.success) {
      if (val.code === 'REVISION_CONFLICT') {
        return {
          ok: false,
          error: {
            code: 'REVISION_CONFLICT',
            messageKey: 'managedResources.errors.staleRevision',
            params: { message: val.message },
          },
        }
      }
      if (val.code === 'NAMESPACE_CONFLICT') {
        return {
          ok: false,
          error: {
            code: 'VALIDATION_FAILED',
            messageKey: 'managedResources.errors.namespaceConflict',
            params: { message: val.message },
          },
        }
      }
      return {
        ok: false,
        error: {
          code: 'VALIDATION_FAILED',
          messageKey: 'managedResources.errors.integrityCheckFailed',
          params: { issues: val.issues },
        },
      }
    }
  }

  if (txResult.status === 'rejected') {
    return {
      ok: false,
      error: {
        code: txResult.code,
        messageKey: txResult.code === 'REVISION_CONFLICT' ? 'managedResources.errors.revisionConflict' : 'managedResources.errors.importFailed',
      },
    }
  }

  return {
    ok: false,
    error: {
      code: 'WRITE_FAILED',
      messageKey: 'managedResources.errors.importFailed',
    },
  }
}
