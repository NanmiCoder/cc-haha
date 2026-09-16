import fs from 'node:fs/promises'
import path from 'node:path'
import type { ResourceDocument } from '../../../../src/features/managed-resources/types/resourceTypes.js'
import { ResourceDocumentSchema } from '../../../../src/features/managed-resources/types/resourceSchemas.js'

export const RESOURCE_DOCUMENT_MAX_BYTES = 64 * 1024 * 1024

export type ResourceDocumentReadyResult = {
  status: 'ready'
  source: 'missing' | 'disk'
  readOnly: false
  filePath: string
  document: ResourceDocument
}

export type ResourceDocumentMigrationRequiredResult = {
  status: 'migration-required'
  source: 'disk'
  readOnly: true
  filePath: string
  schemaVersion: 0 | 1
}

export type ResourceDocumentNewerSchemaResult = {
  status: 'newer-schema'
  source: 'disk'
  readOnly: true
  filePath: string
  schemaVersion: number
}

export type ResourceDocumentCorruptReason =
  | 'too-large'
  | 'invalid-utf8'
  | 'invalid-json'
  | 'invalid-schema'
  | 'io-error'

export type ResourceDocumentCorruptResult = {
  status: 'corrupt'
  source: 'disk'
  readOnly: true
  filePath: string
  reason: ResourceDocumentCorruptReason
  message: string
}

export type ResourceDocumentLoadResult =
  | ResourceDocumentReadyResult
  | ResourceDocumentMigrationRequiredResult
  | ResourceDocumentNewerSchemaResult
  | ResourceDocumentCorruptResult

export type ResourceDocumentRepositoryOptions = {
  activeConfigDir: string
  maxBytes?: number
}

export type ResourceDocumentRepository = {
  readonly filePath: string
  load(): Promise<ResourceDocumentLoadResult>
}

function createEmptyResourceDocument(): ResourceDocument {
  return {
    schemaVersion: 2,
    revision: 1,
    hosts: [],
    tags: [],
    concepts: [],
    dataConnections: [],
    credentials: [],
    knownHostKeys: [],
  }
}

function sanitizeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.name ? `${err.name}: ${err.message}` : err.message
  }
  return 'Unknown filesystem error'
}

export function createResourceDocumentRepository(
  options: ResourceDocumentRepositoryOptions,
): ResourceDocumentRepository {
  if (!options || typeof options !== 'object') {
    throw new TypeError('Options must be an object')
  }

  const { activeConfigDir, maxBytes = RESOURCE_DOCUMENT_MAX_BYTES } = options

  if (typeof activeConfigDir !== 'string' || activeConfigDir.trim().length === 0) {
    throw new Error('activeConfigDir must be a non-empty string')
  }

  if (!path.isAbsolute(activeConfigDir)) {
    throw new Error(`activeConfigDir must be an absolute path: ${activeConfigDir}`)
  }

  if (
    typeof maxBytes !== 'number' ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > RESOURCE_DOCUMENT_MAX_BYTES
  ) {
    throw new Error(
      `maxBytes must be a positive safe integer <= ${RESOURCE_DOCUMENT_MAX_BYTES}`,
    )
  }

  const filePath = path.join(activeConfigDir, 'cc-haha', 'host-management', 'resources.json')

  return {
    filePath,
    async load(): Promise<ResourceDocumentLoadResult> {
      let stats: Awaited<ReturnType<typeof fs.stat>>
      try {
        stats = await fs.stat(filePath)
      } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException
        if (nodeErr && nodeErr.code === 'ENOENT') {
          return {
            status: 'ready',
            source: 'missing',
            readOnly: false,
            filePath,
            document: createEmptyResourceDocument(),
          }
        }
        return {
          status: 'corrupt',
          source: 'disk',
          readOnly: true,
          filePath,
          reason: 'io-error',
          message: sanitizeErrorMessage(err),
        }
      }

      if (!stats.isFile()) {
        return {
          status: 'corrupt',
          source: 'disk',
          readOnly: true,
          filePath,
          reason: 'io-error',
          message: 'Target path is not a regular file',
        }
      }

      if (stats.size > maxBytes) {
        return {
          status: 'corrupt',
          source: 'disk',
          readOnly: true,
          filePath,
          reason: 'too-large',
          message: `File size (${stats.size} bytes) exceeds maximum allowed size (${maxBytes} bytes)`,
        }
      }

      let rawBytes: Buffer
      try {
        rawBytes = await fs.readFile(filePath)
      } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException
        if (nodeErr && nodeErr.code === 'ENOENT') {
          return {
            status: 'ready',
            source: 'missing',
            readOnly: false,
            filePath,
            document: createEmptyResourceDocument(),
          }
        }
        return {
          status: 'corrupt',
          source: 'disk',
          readOnly: true,
          filePath,
          reason: 'io-error',
          message: sanitizeErrorMessage(err),
        }
      }

      if (rawBytes.byteLength > maxBytes) {
        return {
          status: 'corrupt',
          source: 'disk',
          readOnly: true,
          filePath,
          reason: 'too-large',
          message: `File byte length (${rawBytes.byteLength} bytes) exceeds maximum allowed size (${maxBytes} bytes)`,
        }
      }

      let text: string
      try {
        const decoder = new TextDecoder('utf-8', { fatal: true })
        text = decoder.decode(rawBytes)
      } catch {
        return {
          status: 'corrupt',
          source: 'disk',
          readOnly: true,
          filePath,
          reason: 'invalid-utf8',
          message: 'File content is not valid UTF-8',
        }
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return {
          status: 'corrupt',
          source: 'disk',
          readOnly: true,
          filePath,
          reason: 'invalid-json',
          message: 'Invalid JSON syntax',
        }
      }

      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return {
          status: 'corrupt',
          source: 'disk',
          readOnly: true,
          filePath,
          reason: 'invalid-schema',
          message: 'Root JSON value must be an object',
        }
      }

      const version = (parsed as { schemaVersion?: unknown }).schemaVersion

      if (version === 0 || version === 1) {
        return {
          status: 'migration-required',
          source: 'disk',
          readOnly: true,
          filePath,
          schemaVersion: version,
        }
      }

      if (typeof version === 'number' && Number.isSafeInteger(version) && version > 2) {
        return {
          status: 'newer-schema',
          source: 'disk',
          readOnly: true,
          filePath,
          schemaVersion: version,
        }
      }

      if (version === 2) {
        const validation = ResourceDocumentSchema.safeParse(parsed)
        if (validation.success) {
          return {
            status: 'ready',
            source: 'disk',
            readOnly: false,
            filePath,
            document: validation.data as ResourceDocument,
          }
        }
        return {
          status: 'corrupt',
          source: 'disk',
          readOnly: true,
          filePath,
          reason: 'invalid-schema',
          message: 'Invalid resource document schema',
        }
      }

      return {
        status: 'corrupt',
        source: 'disk',
        readOnly: true,
        filePath,
        reason: 'invalid-schema',
        message: 'Unsupported or invalid schemaVersion',
      }
    },
  }
}
