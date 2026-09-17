import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createResourceDocumentRepository,
  RESOURCE_DOCUMENT_MAX_BYTES,
} from './resourceDocumentRepository.js'
import {
  createResourceDocumentAtomicWriter,
} from './resourceDocumentAtomicWriter.js'

function hashBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function createSampleV2Document(revision = 1): Record<string, unknown> {
  return {
    schemaVersion: 2,
    revision,
    hosts: [],
    tags: [],
    concepts: [],
    dataConnections: [],
    credentials: [],
    knownHostKeys: [],
  }
}

describe('resourceDocumentAtomicWriter', () => {
  let tempDirs: string[] = []

  async function createTempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-writer-test-'))
    tempDirs.push(dir)
    return dir
  }

  afterEach(async () => {
    for (const dir of tempDirs) {
      try {
        await fs.rm(dir, { recursive: true, force: true })
      } catch {
        // ignore cleanup error
      }
    }
    tempDirs = []
  })

  describe('factory validation and repository reuse', () => {
    it('rejects relative, empty, whitespace, or non-string activeConfigDir', () => {
      expect(() =>
        createResourceDocumentAtomicWriter({ activeConfigDir: '' }),
      ).toThrow('activeConfigDir must be a non-empty string')

      expect(() =>
        createResourceDocumentAtomicWriter({ activeConfigDir: '   ' }),
      ).toThrow('activeConfigDir must be a non-empty string')

      expect(() =>
        createResourceDocumentAtomicWriter({ activeConfigDir: './relative/path' }),
      ).toThrow('activeConfigDir must be an absolute path')

      expect(() =>
        createResourceDocumentAtomicWriter({ activeConfigDir: 'relative/path' }),
      ).toThrow('activeConfigDir must be an absolute path')
    })

    it('rejects 0, negative, non-integer, or > 64MiB maxBytes', async () => {
      const tempDir = await createTempDir()

      expect(() =>
        createResourceDocumentAtomicWriter({ activeConfigDir: tempDir, maxBytes: 0 }),
      ).toThrow(`maxBytes must be a positive safe integer <= ${RESOURCE_DOCUMENT_MAX_BYTES}`)

      expect(() =>
        createResourceDocumentAtomicWriter({ activeConfigDir: tempDir, maxBytes: -1 }),
      ).toThrow(`maxBytes must be a positive safe integer <= ${RESOURCE_DOCUMENT_MAX_BYTES}`)

      expect(() =>
        createResourceDocumentAtomicWriter({ activeConfigDir: tempDir, maxBytes: 1.5 }),
      ).toThrow(`maxBytes must be a positive safe integer <= ${RESOURCE_DOCUMENT_MAX_BYTES}`)

      expect(() =>
        createResourceDocumentAtomicWriter({
          activeConfigDir: tempDir,
          maxBytes: RESOURCE_DOCUMENT_MAX_BYTES + 1,
        }),
      ).toThrow(`maxBytes must be a positive safe integer <= ${RESOURCE_DOCUMENT_MAX_BYTES}`)
    })

    it('rejects invalid dependencies options', async () => {
      const tempDir = await createTempDir()

      expect(() =>
        createResourceDocumentAtomicWriter({
          activeConfigDir: tempDir,
          // @ts-expect-error testing invalid type
          dependencies: 'not-an-object',
        }),
      ).toThrow('dependencies must be an object')

      expect(() =>
        createResourceDocumentAtomicWriter({
          activeConfigDir: tempDir,
          // @ts-expect-error testing invalid type
          dependencies: { replaceFile: 'not-a-function' },
        }),
      ).toThrow('replaceFile dependency must be a function')

      expect(() =>
        createResourceDocumentAtomicWriter({
          activeConfigDir: tempDir,
          // @ts-expect-error testing extra keys
          dependencies: { extraHelper: () => {} },
        }),
      ).toThrow('Unsupported dependencies property')
    })

    it('repository and writer produce identical filePath and writer has only filePath and write', async () => {
      const tempDir = await createTempDir()
      const repo = createResourceDocumentRepository({ activeConfigDir: tempDir })
      const writer = createResourceDocumentAtomicWriter({ activeConfigDir: tempDir })

      expect(writer.filePath).toBe(repo.filePath)
      expect(writer.filePath).toBe(
        path.join(tempDir, 'cc-haha', 'host-management', 'resources.json'),
      )

      const keys = Object.keys(writer)
      expect(keys.sort()).toEqual(['filePath', 'write'].sort())
    })
  })

  describe('pre-flight validation before touching filesystem', () => {
    it('returns invalid-schema for invalid v2 documents without creating directories', async () => {
      const tempDir = await createTempDir()
      const writer = createResourceDocumentAtomicWriter({ activeConfigDir: tempDir })
      const ccHahaDir = path.join(tempDir, 'cc-haha')

      const invalidDoc = {
        schemaVersion: 2,
        revision: 'not-a-number',
      }

      const result = await writer.write(invalidDoc)
      expect(result).toEqual({
        status: 'not-written',
        filePath: writer.filePath,
        reason: 'invalid-schema',
        message: 'Document failed schema validation',
      })
      expect('byteLength' in result).toBe(false)

      await expect(fs.stat(ccHahaDir)).rejects.toThrow()
    })

    it('returns invalid-schema for un-serializable unknown values (BigInt) without creating directories', async () => {
      const tempDir = await createTempDir()
      const writer = createResourceDocumentAtomicWriter({ activeConfigDir: tempDir })
      const ccHahaDir = path.join(tempDir, 'cc-haha')

      const docWithBigInt = {
        ...createSampleV2Document(),
        unserializable: 123456789012345678901234567890n,
      }

      const result = await writer.write(docWithBigInt)
      expect(result).toEqual({
        status: 'not-written',
        filePath: writer.filePath,
        reason: 'invalid-schema',
        message: 'Document failed schema validation',
      })
      expect('byteLength' in result).toBe(false)

      await expect(fs.stat(ccHahaDir)).rejects.toThrow()
    })

    it.each([
      ['undefined', undefined],
      ['NaN', Number.NaN],
      ['positive Infinity', Number.POSITIVE_INFINITY],
      ['negative Infinity', Number.NEGATIVE_INFINITY],
      ['function', () => 'silently dropped'],
      ['symbol', Symbol('silently dropped')],
      ['Date', new Date('2026-09-08T00:00:00.000Z')],
      ['Map', new Map([['silently', 'dropped']])],
      ['sparse array', [1, , 3]],
      ['nested invalid value', { nested: { value: undefined } }],
    ])(
      'returns invalid-schema for JSON-lossy unknown value %s before touching filesystem',
      async (_label, lossyValue) => {
        const tempDir = await createTempDir()
        const writer = createResourceDocumentAtomicWriter({ activeConfigDir: tempDir })
        const ccHahaDir = path.join(tempDir, 'cc-haha')

        const result = await writer.write({
          ...createSampleV2Document(),
          unknownValue: lossyValue,
        })

        expect(result).toEqual({
          status: 'not-written',
          filePath: writer.filePath,
          reason: 'invalid-schema',
          message: 'Document failed schema validation',
        })
        await expect(fs.stat(ccHahaDir)).rejects.toThrow()
      },
    )

    it('returns too-large for documents exceeding maxBytes without creating directories or files', async () => {
      const tempDir = await createTempDir()
      const writer = createResourceDocumentAtomicWriter({
        activeConfigDir: tempDir,
        maxBytes: 64,
      })
      const ccHahaDir = path.join(tempDir, 'cc-haha')

      const doc = createSampleV2Document()
      const result = await writer.write(doc)

      expect(result).toEqual({
        status: 'not-written',
        filePath: writer.filePath,
        reason: 'too-large',
        message: 'Document byte length exceeds maximum allowed size',
      })
      expect('byteLength' in result).toBe(false)

      await expect(fs.stat(ccHahaDir)).rejects.toThrow()
    })
  })

  describe('atomic writing to missing target and reader roundtrip', () => {
    it('writes pretty JSON with trailing newline, preserves unknown fields, and reader returns disk ready', async () => {
      const tempDir = await createTempDir()
      const writer = createResourceDocumentAtomicWriter({ activeConfigDir: tempDir })
      const repo = createResourceDocumentRepository({ activeConfigDir: tempDir })

      const doc = {
        ...createSampleV2Document(5),
        customTopProperty: 'top-level-preserved',
        hosts: [
          {
            id: '10000000-0000-4000-8000-000000000001',
            revision: 1,
            createdAt: '2026-09-01T00:00:00.000Z',
            updatedAt: '2026-09-01T00:00:00.000Z',
            name: 'bastion',
            address: '192.0.2.1',
            port: 22,
            username: 'admin',
            auth: {
              type: 'password',
              credentialId: null,
            },
            tagIds: [],
            initialDirectory: '/var/log',
            applications: [],
            notes: 'Production bastion',
            nestedHostProperty: { deep: 'nested-value' },
          },
        ],
      }

      const result = await writer.write(doc)
      expect(result.status).toBe('written')
      if (result.status !== 'written') return

      expect(result.filePath).toBe(writer.filePath)

      const diskBytes = await fs.readFile(writer.filePath)
      expect(result.byteLength).toBe(diskBytes.byteLength)

      const diskText = diskBytes.toString('utf8')
      expect(diskText.endsWith('\n')).toBe(true)

      // Expected deterministic pretty JSON format
      const expectedText = `${JSON.stringify(doc, null, 2)}\n`
      expect(diskText).toBe(expectedText)

      // Verify no temporary files remain in directory
      const dirFiles = await fs.readdir(path.dirname(writer.filePath))
      expect(dirFiles).toEqual(['resources.json'])

      // Read back via reader repository
      const readResult = await repo.load()
      expect(readResult.status).toBe('ready')
      if (readResult.status !== 'ready') return

      expect(readResult.source).toBe('disk')
      expect(readResult.readOnly).toBe(false)
      expect(readResult.document.revision).toBe(5)
      expect((readResult.document as Record<string, unknown>).customTopProperty).toBe(
        'top-level-preserved',
      )
      expect(
        (readResult.document.hosts[0] as Record<string, unknown>).nestedHostProperty,
      ).toEqual({ deep: 'nested-value' })
    })
  })

  describe('replacing existing file and revision immutability', () => {
    it('replaces existing file completely and preserves callers revision without auto-increment', async () => {
      const tempDir = await createTempDir()
      const writer = createResourceDocumentAtomicWriter({ activeConfigDir: tempDir })
      const repo = createResourceDocumentRepository({ activeConfigDir: tempDir })

      // First write: revision 1
      const docV1 = {
        ...createSampleV2Document(1),
        oldOnlyField: 'old-payload-will-disappear',
      }
      const res1 = await writer.write(docV1)
      expect(res1.status).toBe('written')

      const read1 = await repo.load()
      expect(read1.status).toBe('ready')
      if (read1.status !== 'ready') return
      expect(read1.document.revision).toBe(1)
      expect((read1.document as Record<string, unknown>).oldOnlyField).toBe(
        'old-payload-will-disappear',
      )

      // Second write: caller provides revision 99
      const docV2 = {
        ...createSampleV2Document(99),
        newOnlyField: 'new-payload-here',
      }
      const res2 = await writer.write(docV2)
      expect(res2.status).toBe('written')

      const read2 = await repo.load()
      expect(read2.status).toBe('ready')
      if (read2.status !== 'ready') return
      expect(read2.document.revision).toBe(99)
      expect((read2.document as Record<string, unknown>).newOnlyField).toBe('new-payload-here')
      expect('oldOnlyField' in (read2.document as Record<string, unknown>)).toBe(false)

      // Verify writer itself does not increment or change the caller's revision
      const docV3 = createSampleV2Document(99)
      const res3 = await writer.write(docV3)
      expect(res3.status).toBe('written')

      const read3 = await repo.load()
      expect(read3.status).toBe('ready')
      if (read3.status !== 'ready') return
      expect(read3.document.revision).toBe(99)
    })
  })

  describe('temporary file naming and atomic replace behavior', () => {
    it('uses non-guessable random UUID temp file in same directory and leaves no temp files on success', async () => {
      const tempDir = await createTempDir()
      let observedSourcePath: string | null = null
      let observedTargetPath: string | null = null

      const writer = createResourceDocumentAtomicWriter({
        activeConfigDir: tempDir,
        dependencies: {
          replaceFile: async (source, target) => {
            observedSourcePath = source
            observedTargetPath = target
            // Verify file exists at source before rename
            const sourceStat = await fs.stat(source)
            expect(sourceStat.isFile()).toBe(true)
            await fs.rename(source, target)
          },
        },
      })

      const doc = createSampleV2Document(1)
      const result = await writer.write(doc)
      expect(result.status).toBe('written')

      expect(observedSourcePath).toBeTruthy()
      expect(observedTargetPath).toBe(writer.filePath)

      // Verify source is in the same directory as target
      expect(path.dirname(observedSourcePath!)).toBe(path.dirname(observedTargetPath!))

      // Verify source follows .resources.json.<UUID>.tmp pattern
      const sourceBasename = path.basename(observedSourcePath!)
      expect(
        /^\.resources\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/.test(
          sourceBasename,
        ),
      ).toBe(true)

      // Ensure no temporary files remain in the target directory
      const remainingFiles = await fs.readdir(path.dirname(writer.filePath))
      expect(remainingFiles).toEqual(['resources.json'])
    })
  })

  describe('replace failure and cleanup safety', () => {
    it('cleans up temp file, preserves existing file byte-for-byte, and does not leak secrets on replace failure', async () => {
      const tempDir = await createTempDir()
      const secretSentinel = 'CRITICAL_SECRET_SENTINEL_DO_NOT_LEAK_INTO_MESSAGES_99999'

      // Pre-create valid existing file
      const initialDoc = {
        ...createSampleV2Document(1),
        originalSecretData: 'ORIGINAL_DATA_MUST_NOT_BE_ALTERED',
      }
      await fs.mkdir(path.dirname(path.join(tempDir, 'cc-haha', 'host-management', 'resources.json')), {
        recursive: true,
      })
      const initialBytes = Buffer.from(`${JSON.stringify(initialDoc, null, 2)}\n`, 'utf8')
      const targetFilePath = path.join(tempDir, 'cc-haha', 'host-management', 'resources.json')
      await fs.writeFile(targetFilePath, initialBytes)
      const initialHash = hashBuffer(initialBytes)

      // Also create an unrelated sibling file to ensure only the writer's temp file is cleaned up
      const siblingPath = path.join(path.dirname(targetFilePath), 'unrelated-sibling.txt')
      await fs.writeFile(siblingPath, 'sibling-content-must-survive', 'utf8')

      let observedTempPath: string | null = null

      const writer = createResourceDocumentAtomicWriter({
        activeConfigDir: tempDir,
        dependencies: {
          replaceFile: async (source) => {
            observedTempPath = source
            throw new Error(`Injected failure with sentinel: ${secretSentinel}`)
          },
        },
      })

      const newDoc = {
        ...createSampleV2Document(2),
        newField: 'new-field-attempted',
      }

      const result = await writer.write(newDoc)
      expect(result.status).toBe('not-written')
      if (result.status !== 'not-written') return

      expect(result.filePath).toBe(targetFilePath)
      expect(result.reason).toBe('io-error')
      expect(result.message).toBe('Filesystem I/O error during atomic write')

      // Ensure sentinel string is not leaked into the returned message
      expect(result.message).not.toContain(secretSentinel)

      // Ensure existing target file is 100% byte-for-byte intact
      const currentBytes = await fs.readFile(targetFilePath)
      expect(hashBuffer(currentBytes)).toBe(initialHash)

      // Ensure unrelated sibling file is untouched
      const siblingContent = await fs.readFile(siblingPath, 'utf8')
      expect(siblingContent).toBe('sibling-content-must-survive')

      // Ensure the generated temp file was cleaned up
      expect(observedTempPath).toBeTruthy()
      await expect(fs.stat(observedTempPath!)).rejects.toThrow()

      // Ensure directory contains only the original target and the sibling file
      const dirContents = await fs.readdir(path.dirname(targetFilePath))
      expect(dirContents.sort()).toEqual(['resources.json', 'unrelated-sibling.txt'].sort())
    })
  })
})
