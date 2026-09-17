import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { ResourceDocumentSchema } from '../../../../src/features/managed-resources/types/resourceSchemas.js'
import {
  createResourceDocumentRepository,
  RESOURCE_DOCUMENT_MAX_BYTES,
} from './resourceDocumentRepository.js'

export type ResourceDocumentAtomicWriteWrittenResult = {
  status: 'written'
  filePath: string
  byteLength: number
}

export type ResourceDocumentAtomicWriteNotWrittenReason =
  | 'invalid-schema'
  | 'too-large'
  | 'io-error'

export type ResourceDocumentAtomicWriteNotWrittenResult = {
  status: 'not-written'
  filePath: string
  reason: ResourceDocumentAtomicWriteNotWrittenReason
  message: string
}

export type ResourceDocumentAtomicWriteResult =
  | ResourceDocumentAtomicWriteWrittenResult
  | ResourceDocumentAtomicWriteNotWrittenResult

export type ResourceDocumentAtomicWriterDependencies = {
  replaceFile?: (sourcePath: string, targetPath: string) => Promise<void>
}

export type ResourceDocumentAtomicWriterOptions = {
  activeConfigDir: string
  maxBytes?: number
  dependencies?: ResourceDocumentAtomicWriterDependencies
}

export type ResourceDocumentAtomicWriter = {
  readonly filePath: string
  write(document: unknown): Promise<ResourceDocumentAtomicWriteResult>
}

export function createResourceDocumentAtomicWriter(
  options: ResourceDocumentAtomicWriterOptions,
): ResourceDocumentAtomicWriter {
  if (!options || typeof options !== 'object') {
    throw new TypeError('Options must be an object')
  }

  let replaceFile: (sourcePath: string, targetPath: string) => Promise<void> = fs.rename
  if (options.dependencies !== undefined) {
    if (!options.dependencies || typeof options.dependencies !== 'object') {
      throw new TypeError('dependencies must be an object')
    }
    const extraKeys = Object.keys(options.dependencies).filter(k => k !== 'replaceFile')
    if (extraKeys.length > 0) {
      throw new Error(`Unsupported dependencies property: ${extraKeys.join(', ')}`)
    }
    if (options.dependencies.replaceFile !== undefined) {
      if (typeof options.dependencies.replaceFile !== 'function') {
        throw new TypeError('replaceFile dependency must be a function')
      }
      replaceFile = options.dependencies.replaceFile
    }
  }

  // Reuse existing reader repository factory to validate activeConfigDir, maxBytes and resolve identical filePath
  const readerRepo = createResourceDocumentRepository({
    activeConfigDir: options.activeConfigDir,
    maxBytes: options.maxBytes,
  })

  const filePath = readerRepo.filePath
  const maxBytes = options.maxBytes ?? RESOURCE_DOCUMENT_MAX_BYTES
  const targetDir = path.dirname(filePath)

  return {
    filePath,
    async write(document: unknown): Promise<ResourceDocumentAtomicWriteResult> {
      const validation = ResourceDocumentSchema.safeParse(document)
      if (!validation.success) {
        return {
          status: 'not-written',
          filePath,
          reason: 'invalid-schema',
          message: 'Document failed schema validation',
        }
      }

      let payload: string
      try {
        payload = JSON.stringify(validation.data, null, 2)
        if (!isDeepStrictEqual(JSON.parse(payload), validation.data)) {
          throw new TypeError('Document contains values that JSON cannot preserve')
        }
      } catch {
        return {
          status: 'not-written',
          filePath,
          reason: 'invalid-schema',
          message: 'Document failed schema validation',
        }
      }

      if (typeof payload !== 'string') {
        return {
          status: 'not-written',
          filePath,
          reason: 'invalid-schema',
          message: 'Document failed schema validation',
        }
      }

      payload += '\n'

      const rawBytes = Buffer.from(payload, 'utf8')
      if (rawBytes.byteLength > maxBytes) {
        return {
          status: 'not-written',
          filePath,
          reason: 'too-large',
          message: 'Document byte length exceeds maximum allowed size',
        }
      }

      let fileHandle: fs.FileHandle | null = null
      let tempPath: string | null = null

      try {
        await fs.mkdir(targetDir, { recursive: true })
        tempPath = path.join(targetDir, `.resources.json.${randomUUID()}.tmp`)
        fileHandle = await fs.open(tempPath, 'wx', 0o600)
        await fileHandle.writeFile(rawBytes)
        await fileHandle.sync()
        await fileHandle.close()
        fileHandle = null

        await replaceFile(tempPath, filePath)
        tempPath = null

        return {
          status: 'written',
          filePath,
          byteLength: rawBytes.byteLength,
        }
      } catch {
        if (fileHandle) {
          try {
            await fileHandle.close()
          } catch {
            // ignore handle close error
          }
          fileHandle = null
        }
        if (tempPath) {
          try {
            await fs.unlink(tempPath)
          } catch {
            // ignore temp unlink error
          }
          tempPath = null
        }
        return {
          status: 'not-written',
          filePath,
          reason: 'io-error',
          message: 'Filesystem I/O error during atomic write',
        }
      }
    },
  }
}
