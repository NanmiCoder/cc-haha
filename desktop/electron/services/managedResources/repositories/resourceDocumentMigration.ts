import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { ResourceDocument } from '../../../../src/features/managed-resources/types/resourceTypes.js'
import {
  ConceptSchema,
  HostSchema,
  ResourceDocumentSchema,
  ResourceTagSchema,
  RevisionSchema,
  UniqueIdObjectArraySchema,
} from '../../../../src/features/managed-resources/types/resourceSchemas.js'
import {
  createResourceDocumentAtomicWriter,
  type ResourceDocumentAtomicWriter,
} from './resourceDocumentAtomicWriter.js'
import {
  createResourceDocumentRepository,
  type ResourceDocumentRepositoryOptions,
} from './resourceDocumentRepository.js'

/**
 * The only supported resource v1 shape is the foundational host/concept library.
 * v2 introduced dataConnections, credentials and knownHostKeys. Unknown fields
 * remain allowed and are copied through unchanged during the version upgrade.
 */
const ResourceDocumentV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    revision: RevisionSchema,
    hosts: UniqueIdObjectArraySchema(HostSchema, 10_000),
    tags: UniqueIdObjectArraySchema(ResourceTagSchema, 10_000),
    concepts: UniqueIdObjectArraySchema(ConceptSchema, 10_000),
  })
  .passthrough()
  .superRefine((document, ctx) => {
    for (const key of ['dataConnections', 'credentials', 'knownHostKeys']) {
      if (Object.prototype.hasOwnProperty.call(document, key)) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is only valid in resource schema v2`,
        })
      }
    }
  })

export type ResourceDocumentMigrationDependencies = {
  writer?: ResourceDocumentAtomicWriter
}

export type ResourceDocumentMigrationOptions = ResourceDocumentRepositoryOptions & {
  dependencies?: ResourceDocumentMigrationDependencies
}

export type ResourceDocumentMigratedResult = {
  status: 'migrated'
  filePath: string
  backupPath: string
  document: ResourceDocument
}

export type ResourceDocumentNotMigratedReason =
  | 'not-required'
  | 'unsupported-version'
  | 'newer-schema'
  | 'corrupt'
  | 'invalid-v1-schema'
  | 'backup-failed'
  | 'write-failed'
  | 'io-error'

export type ResourceDocumentNotMigratedResult = {
  status: 'not-migrated'
  filePath: string
  reason: ResourceDocumentNotMigratedReason
  message: string
}

export type ResourceDocumentMigrationResult =
  | ResourceDocumentMigratedResult
  | ResourceDocumentNotMigratedResult

export type ResourceDocumentMigration = {
  readonly filePath: string
  migrateV1ToV2(): Promise<ResourceDocumentMigrationResult>
}

function notMigrated(
  filePath: string,
  reason: ResourceDocumentNotMigratedReason,
  message: string,
): ResourceDocumentNotMigratedResult {
  return { status: 'not-migrated', filePath, reason, message }
}

async function writeBackupIfNeeded(
  sourcePath: string,
  backupPath: string,
  sourceBytes: Buffer,
): Promise<boolean> {
  try {
    await fs.copyFile(sourcePath, backupPath, constants.COPYFILE_EXCL)
    return true
  } catch (err: unknown) {
    const nodeError = err as NodeJS.ErrnoException
    if (nodeError?.code !== 'EEXIST') return false

    try {
      const existingBytes = await fs.readFile(backupPath)
      return existingBytes.equals(sourceBytes)
    } catch {
      return false
    }
  }
}

export function createResourceDocumentMigration(
  options: ResourceDocumentMigrationOptions,
): ResourceDocumentMigration {
  if (!options || typeof options !== 'object') {
    throw new TypeError('Options must be an object')
  }

  if (options.dependencies !== undefined) {
    if (!options.dependencies || typeof options.dependencies !== 'object') {
      throw new TypeError('dependencies must be an object')
    }
    const extraKeys = Object.keys(options.dependencies).filter(key => key !== 'writer')
    if (extraKeys.length > 0) {
      throw new Error(`Unsupported dependencies property: ${extraKeys.join(', ')}`)
    }
    if (
      options.dependencies.writer !== undefined &&
      (typeof options.dependencies.writer !== 'object' ||
        options.dependencies.writer === null ||
        typeof options.dependencies.writer.write !== 'function')
    ) {
      throw new TypeError('writer dependency must be a ResourceDocumentAtomicWriter')
    }
  }

  const repository = createResourceDocumentRepository({
    activeConfigDir: options.activeConfigDir,
    maxBytes: options.maxBytes,
  })
  const writer =
    options.dependencies?.writer ??
    createResourceDocumentAtomicWriter({
      activeConfigDir: options.activeConfigDir,
      maxBytes: options.maxBytes,
    })

  if (writer.filePath !== repository.filePath) {
    throw new Error('writer dependency filePath must match the resource document filePath')
  }

  const filePath = repository.filePath
  const backupPath = path.join(path.dirname(filePath), 'resources.v1.backup.json')

  return {
    filePath,
    async migrateV1ToV2(): Promise<ResourceDocumentMigrationResult> {
      const loaded = await repository.load()
      if (loaded.status === 'ready') {
        return notMigrated(filePath, 'not-required', 'Resource document does not require migration')
      }
      if (loaded.status === 'newer-schema') {
        return notMigrated(filePath, 'newer-schema', 'Resource document uses a newer schema version')
      }
      if (loaded.status === 'corrupt') {
        return notMigrated(filePath, 'corrupt', 'Resource document is corrupt and must not be overwritten')
      }
      if (loaded.schemaVersion !== 1) {
        return notMigrated(
          filePath,
          'unsupported-version',
          'Only resource schema v1 can be migrated to v2',
        )
      }

      let sourceBytes: Buffer
      try {
        sourceBytes = await fs.readFile(filePath)
      } catch {
        return notMigrated(filePath, 'io-error', 'Unable to read the resource document for migration')
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes))
      } catch {
        return notMigrated(filePath, 'corrupt', 'Resource document is corrupt and must not be overwritten')
      }

      const v1Validation = ResourceDocumentV1Schema.safeParse(parsed)
      if (!v1Validation.success) {
        return notMigrated(filePath, 'invalid-v1-schema', 'Resource document does not match the supported v1 schema')
      }

      const candidate: unknown = {
        ...v1Validation.data,
        schemaVersion: 2,
        dataConnections: [],
        credentials: [],
        knownHostKeys: [],
      }
      const v2Validation = ResourceDocumentSchema.safeParse(candidate)
      if (!v2Validation.success) {
        return notMigrated(filePath, 'invalid-v1-schema', 'Resource document cannot be safely migrated to v2')
      }

      if (!(await writeBackupIfNeeded(filePath, backupPath, sourceBytes))) {
        return notMigrated(filePath, 'backup-failed', 'Unable to create a verified v1 resource backup')
      }

      const writeResult = await writer.write(v2Validation.data)
      if (writeResult.status !== 'written') {
        return notMigrated(
          filePath,
          'write-failed',
          'Atomic replacement of the migrated resource document failed',
        )
      }

      return {
        status: 'migrated',
        filePath,
        backupPath,
        document: v2Validation.data as ResourceDocument,
      }
    },
  }
}
