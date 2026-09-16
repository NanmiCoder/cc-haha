import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createResourceDocumentRepository,
  RESOURCE_DOCUMENT_MAX_BYTES,
} from './resourceDocumentRepository.js'

function hashBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

describe('resourceDocumentRepository', () => {
  let tempDirs: string[] = []

  async function createTempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-res-repo-test-'))
    tempDirs.push(dir)
    return dir
  }

  afterEach(async () => {
    for (const dir of tempDirs) {
      try {
        await fs.rm(dir, { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
    }
    tempDirs = []
  })

  describe('factory validation', () => {
    it('rejects relative, empty, whitespace, or non-string activeConfigDir', () => {
      expect(() =>
        createResourceDocumentRepository({ activeConfigDir: '' }),
      ).toThrow('activeConfigDir must be a non-empty string')

      expect(() =>
        createResourceDocumentRepository({ activeConfigDir: '   ' }),
      ).toThrow('activeConfigDir must be a non-empty string')

      expect(() =>
        // @ts-expect-error testing invalid type
        createResourceDocumentRepository({ activeConfigDir: null }),
      ).toThrow('activeConfigDir must be a non-empty string')

      expect(() =>
        createResourceDocumentRepository({ activeConfigDir: './relative/path' }),
      ).toThrow('activeConfigDir must be an absolute path')

      expect(() =>
        createResourceDocumentRepository({ activeConfigDir: 'relative/path' }),
      ).toThrow('activeConfigDir must be an absolute path')
    })

    it('rejects 0, negative, non-integer, or > 64MiB maxBytes', async () => {
      const tempDir = await createTempDir()

      expect(() =>
        createResourceDocumentRepository({ activeConfigDir: tempDir, maxBytes: 0 }),
      ).toThrow(`maxBytes must be a positive safe integer <= ${RESOURCE_DOCUMENT_MAX_BYTES}`)

      expect(() =>
        createResourceDocumentRepository({ activeConfigDir: tempDir, maxBytes: -1 }),
      ).toThrow(`maxBytes must be a positive safe integer <= ${RESOURCE_DOCUMENT_MAX_BYTES}`)

      expect(() =>
        createResourceDocumentRepository({ activeConfigDir: tempDir, maxBytes: 1.5 }),
      ).toThrow(`maxBytes must be a positive safe integer <= ${RESOURCE_DOCUMENT_MAX_BYTES}`)

      expect(() =>
        createResourceDocumentRepository({ activeConfigDir: tempDir, maxBytes: Number.NaN }),
      ).toThrow(`maxBytes must be a positive safe integer <= ${RESOURCE_DOCUMENT_MAX_BYTES}`)

      expect(() =>
        createResourceDocumentRepository({ activeConfigDir: tempDir, maxBytes: Number.POSITIVE_INFINITY }),
      ).toThrow(`maxBytes must be a positive safe integer <= ${RESOURCE_DOCUMENT_MAX_BYTES}`)

      expect(() =>
        createResourceDocumentRepository({
          activeConfigDir: tempDir,
          maxBytes: RESOURCE_DOCUMENT_MAX_BYTES + 1,
        }),
      ).toThrow(`maxBytes must be a positive safe integer <= ${RESOURCE_DOCUMENT_MAX_BYTES}`)
    })

    it('exposes exact fixed filePath and no extra public methods', async () => {
      const tempDir = await createTempDir()
      const repo = createResourceDocumentRepository({ activeConfigDir: tempDir })

      const expectedPath = path.join(tempDir, 'cc-haha', 'host-management', 'resources.json')
      expect(repo.filePath).toBe(expectedPath)

      const keys = Object.keys(repo)
      expect(keys.sort()).toEqual(['filePath', 'load'].sort())
    })
  })

  describe('missing file behavior', () => {
    it('returns empty v2 document without creating directories or files, with unshared references', async () => {
      const tempDir = await createTempDir()
      const repo = createResourceDocumentRepository({ activeConfigDir: tempDir })

      const ccHahaDir = path.join(tempDir, 'cc-haha')
      await expect(fs.stat(ccHahaDir)).rejects.toThrow()

      const result1 = await repo.load()
      expect(result1.status).toBe('ready')
      if (result1.status !== 'ready') return

      expect(result1.source).toBe('missing')
      expect(result1.readOnly).toBe(false)
      expect(result1.filePath).toBe(repo.filePath)
      expect(result1.document).toEqual({
        schemaVersion: 2,
        revision: 1,
        hosts: [],
        tags: [],
        concepts: [],
        dataConnections: [],
        credentials: [],
        knownHostKeys: [],
      })

      // Ensure no directory or file was created
      await expect(fs.stat(ccHahaDir)).rejects.toThrow()
      await expect(fs.stat(repo.filePath)).rejects.toThrow()

      // Consecutive load must return isolated references
      const result2 = await repo.load()
      expect(result2.status).toBe('ready')
      if (result2.status !== 'ready') return

      expect(result1.document).not.toBe(result2.document)
      expect(result1.document.hosts).not.toBe(result2.document.hosts)
      expect(result1.document.tags).not.toBe(result2.document.tags)
      expect(result1.document.concepts).not.toBe(result2.document.concepts)
      expect(result1.document.dataConnections).not.toBe(result2.document.dataConnections)
      expect(result1.document.credentials).not.toBe(result2.document.credentials)
      expect(result1.document.knownHostKeys).not.toBe(result2.document.knownHostKeys)
    })
  })

  describe('valid v2 reading and unknown field passthrough', () => {
    it('reads valid v2 document and preserves top-level and nested unknown fields', async () => {
      const tempDir = await createTempDir()
      const repo = createResourceDocumentRepository({ activeConfigDir: tempDir })

      const validDoc = {
        schemaVersion: 2,
        revision: 3,
        unknownTopLevelProperty: 'preserved-top-level-value',
        tags: [
          {
            id: '30000000-0000-4000-8000-000000000001',
            revision: 1,
            createdAt: '2026-09-01T00:00:00.000Z',
            updatedAt: '2026-09-01T00:00:00.000Z',
            namespace: 'host',
            name: 'prod',
            normalizedName: 'prod',
            colorToken: null,
            unknownTagField: 'preserved-tag-field',
          },
        ],
        hosts: [
          {
            id: '10000000-0000-4000-8000-000000000001',
            revision: 2,
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
            tagIds: ['30000000-0000-4000-8000-000000000001'],
            initialDirectory: '/var/log',
            applications: [],
            notes: 'Primary bastion host',
            unknownHostProperty: { customNested: 42 },
          },
        ],
        concepts: [],
        dataConnections: [],
        credentials: [],
        knownHostKeys: [],
      }

      await fs.mkdir(path.dirname(repo.filePath), { recursive: true })
      await fs.writeFile(repo.filePath, JSON.stringify(validDoc, null, 2), 'utf8')

      const result = await repo.load()
      expect(result.status).toBe('ready')
      if (result.status !== 'ready') return

      expect(result.source).toBe('disk')
      expect(result.readOnly).toBe(false)
      expect(result.filePath).toBe(repo.filePath)
      expect(result.document.schemaVersion).toBe(2)
      expect(result.document.revision).toBe(3)
      expect(result.document.hosts).toHaveLength(1)

      // Verify top-level unknown field preservation
      expect((result.document as Record<string, unknown>).unknownTopLevelProperty).toBe(
        'preserved-top-level-value',
      )

      // Verify nested unknown fields preservation
      expect((result.document.tags[0] as Record<string, unknown>).unknownTagField).toBe(
        'preserved-tag-field',
      )
      expect((result.document.hosts[0] as Record<string, unknown>).unknownHostProperty).toEqual({
        customNested: 42,
      })
    })
  })

  describe('schemaVersion classification and byte-for-byte immutability', () => {
    it('classifies schemaVersion 0 as migration-required and preserves disk bytes', async () => {
      const tempDir = await createTempDir()
      const repo = createResourceDocumentRepository({ activeConfigDir: tempDir })

      const rawContent = JSON.stringify({
        schemaVersion: 0,
        legacyField: 'legacy-data-v0',
        hosts: [],
      })
      await fs.mkdir(path.dirname(repo.filePath), { recursive: true })
      await fs.writeFile(repo.filePath, rawContent, 'utf8')
      const beforeBytes = await fs.readFile(repo.filePath)
      const beforeHash = hashBuffer(beforeBytes)

      const result = await repo.load()
      expect(result).toEqual({
        status: 'migration-required',
        source: 'disk',
        readOnly: true,
        filePath: repo.filePath,
        schemaVersion: 0,
      })
      expect('document' in result).toBe(false)

      const afterBytes = await fs.readFile(repo.filePath)
      expect(hashBuffer(afterBytes)).toBe(beforeHash)
    })

    it('classifies schemaVersion 1 as migration-required and preserves disk bytes', async () => {
      const tempDir = await createTempDir()
      const repo = createResourceDocumentRepository({ activeConfigDir: tempDir })

      const rawContent = JSON.stringify({
        schemaVersion: 1,
        hosts: [{ id: 'h1', name: 'v1host' }],
      })
      await fs.mkdir(path.dirname(repo.filePath), { recursive: true })
      await fs.writeFile(repo.filePath, rawContent, 'utf8')
      const beforeBytes = await fs.readFile(repo.filePath)
      const beforeHash = hashBuffer(beforeBytes)

      const result = await repo.load()
      expect(result).toEqual({
        status: 'migration-required',
        source: 'disk',
        readOnly: true,
        filePath: repo.filePath,
        schemaVersion: 1,
      })
      expect('document' in result).toBe(false)

      const afterBytes = await fs.readFile(repo.filePath)
      expect(hashBuffer(afterBytes)).toBe(beforeHash)
    })

    it('classifies schemaVersion 3 as newer-schema and preserves disk bytes', async () => {
      const tempDir = await createTempDir()
      const repo = createResourceDocumentRepository({ activeConfigDir: tempDir })

      const rawContent = JSON.stringify({
        schemaVersion: 3,
        revision: 10,
        futureField: 'v3-data',
      })
      await fs.mkdir(path.dirname(repo.filePath), { recursive: true })
      await fs.writeFile(repo.filePath, rawContent, 'utf8')
      const beforeBytes = await fs.readFile(repo.filePath)
      const beforeHash = hashBuffer(beforeBytes)

      const result = await repo.load()
      expect(result).toEqual({
        status: 'newer-schema',
        source: 'disk',
        readOnly: true,
        filePath: repo.filePath,
        schemaVersion: 3,
      })
      expect('document' in result).toBe(false)

      const afterBytes = await fs.readFile(repo.filePath)
      expect(hashBuffer(afterBytes)).toBe(beforeHash)
    })
  })

  describe('corruption classification and safety', () => {
    it('classifies invalid UTF-8 as corrupt with reason invalid-utf8 without modifying file', async () => {
      const tempDir = await createTempDir()
      const repo = createResourceDocumentRepository({ activeConfigDir: tempDir })

      // 0xff 0xfe is invalid UTF-8 sequence
      const invalidUtf8 = Buffer.from([0xff, 0xfe, 0xfd, 0x80])
      await fs.mkdir(path.dirname(repo.filePath), { recursive: true })
      await fs.writeFile(repo.filePath, invalidUtf8)
      const beforeHash = hashBuffer(invalidUtf8)

      const result = await repo.load()
      expect(result.status).toBe('corrupt')
      if (result.status !== 'corrupt') return

      expect(result.source).toBe('disk')
      expect(result.readOnly).toBe(true)
      expect(result.filePath).toBe(repo.filePath)
      expect(result.reason).toBe('invalid-utf8')
      expect(result.message).toBeTruthy()
      expect('document' in result).toBe(false)

      const afterBytes = await fs.readFile(repo.filePath)
      expect(hashBuffer(afterBytes)).toBe(beforeHash)
    })

    it('classifies truncated/corrupted JSON as corrupt with reason invalid-json without modifying file', async () => {
      const tempDir = await createTempDir()
      const repo = createResourceDocumentRepository({ activeConfigDir: tempDir })

      const truncatedJson = '{"schemaVersion": 2, "revision": 1, "hosts": ['
      await fs.mkdir(path.dirname(repo.filePath), { recursive: true })
      await fs.writeFile(repo.filePath, truncatedJson, 'utf8')
      const beforeBytes = await fs.readFile(repo.filePath)
      const beforeHash = hashBuffer(beforeBytes)

      const result = await repo.load()
      expect(result.status).toBe('corrupt')
      if (result.status !== 'corrupt') return

      expect(result.source).toBe('disk')
      expect(result.readOnly).toBe(true)
      expect(result.filePath).toBe(repo.filePath)
      expect(result.reason).toBe('invalid-json')
      expect(result.message).toContain('JSON')
      expect('document' in result).toBe(false)

      const afterBytes = await fs.readFile(repo.filePath)
      expect(hashBuffer(afterBytes)).toBe(beforeHash)
    })

    it('classifies malformed JSON containing secret sentinel as invalid-json without leaking body into message', async () => {
      const tempDir = await createTempDir()
      const repo = createResourceDocumentRepository({ activeConfigDir: tempDir })

      const sentinel = 'DO_NOT_LEAK_INVALID_JSON_SECRET_XYZ999'
      const malformedContent = `{"schemaVersion": 2, "secret": "${sentinel}", truncated:`
      await fs.mkdir(path.dirname(repo.filePath), { recursive: true })
      await fs.writeFile(repo.filePath, malformedContent, 'utf8')
      const beforeBytes = await fs.readFile(repo.filePath)
      const beforeHash = hashBuffer(beforeBytes)

      const result = await repo.load()
      expect(result.status).toBe('corrupt')
      if (result.status !== 'corrupt') return

      expect(result.source).toBe('disk')
      expect(result.readOnly).toBe(true)
      expect(result.filePath).toBe(repo.filePath)
      expect(result.reason).toBe('invalid-json')
      expect(result.message).toBe('Invalid JSON syntax')
      expect(result.message).not.toContain(sentinel)
      expect(result.message).not.toContain('truncated')
      expect('document' in result).toBe(false)

      const afterBytes = await fs.readFile(repo.filePath)
      expect(hashBuffer(afterBytes)).toBe(beforeHash)
    })

    it('classifies invalid schemaVersion containing long secret sentinel as invalid-schema without leaking sentinel', async () => {
      const tempDir = await createTempDir()
      const repo = createResourceDocumentRepository({ activeConfigDir: tempDir })

      const versionSentinel = 'DO_NOT_LEAK_SCHEMA_VERSION_SECRET_LONG_HASH_777777777'
      const rawContent = JSON.stringify({
        schemaVersion: versionSentinel,
        hosts: [],
      })
      await fs.mkdir(path.dirname(repo.filePath), { recursive: true })
      await fs.writeFile(repo.filePath, rawContent, 'utf8')
      const beforeBytes = await fs.readFile(repo.filePath)
      const beforeHash = hashBuffer(beforeBytes)

      const result = await repo.load()
      expect(result.status).toBe('corrupt')
      if (result.status !== 'corrupt') return

      expect(result.source).toBe('disk')
      expect(result.readOnly).toBe(true)
      expect(result.filePath).toBe(repo.filePath)
      expect(result.reason).toBe('invalid-schema')
      expect(result.message).toBe('Unsupported or invalid schemaVersion')
      expect(result.message).not.toContain(versionSentinel)
      expect('document' in result).toBe(false)

      const afterBytes = await fs.readFile(repo.filePath)
      expect(hashBuffer(afterBytes)).toBe(beforeHash)
    })

    it('classifies schema violation as corrupt with reason invalid-schema without modifying file', async () => {
      const tempDir = await createTempDir()
      const repo = createResourceDocumentRepository({ activeConfigDir: tempDir })

      // schemaVersion 2 but missing required fields
      const invalidSchemaJson = JSON.stringify({
        schemaVersion: 2,
        secretPayload: 'DO_NOT_LEAK_SECRET_12345',
      })
      await fs.mkdir(path.dirname(repo.filePath), { recursive: true })
      await fs.writeFile(repo.filePath, invalidSchemaJson, 'utf8')
      const beforeBytes = await fs.readFile(repo.filePath)
      const beforeHash = hashBuffer(beforeBytes)

      const result = await repo.load()
      expect(result.status).toBe('corrupt')
      if (result.status !== 'corrupt') return

      expect(result.source).toBe('disk')
      expect(result.readOnly).toBe(true)
      expect(result.filePath).toBe(repo.filePath)
      expect(result.reason).toBe('invalid-schema')
      expect(result.message).toBe('Invalid resource document schema')
      expect('document' in result).toBe(false)

      // Ensure secret message or entire file body is not leaked into message
      expect(result.message).not.toContain('DO_NOT_LEAK_SECRET_12345')

      const afterBytes = await fs.readFile(repo.filePath)
      expect(hashBuffer(afterBytes)).toBe(beforeHash)
    })

    it('classifies non-object JSON as corrupt with reason invalid-schema', async () => {
      const tempDir = await createTempDir()
      const repo = createResourceDocumentRepository({ activeConfigDir: tempDir })

      await fs.mkdir(path.dirname(repo.filePath), { recursive: true })
      await fs.writeFile(repo.filePath, JSON.stringify([1, 2, 3]), 'utf8')

      const result = await repo.load()
      expect(result.status).toBe('corrupt')
      if (result.status !== 'corrupt') return

      expect(result.reason).toBe('invalid-schema')
      expect(result.message).toBe('Root JSON value must be an object')
    })
  })

  describe('size limit and io-error handling', () => {
    it('classifies file exceeding maxBytes as corrupt with reason too-large without reading or parsing', async () => {
      const tempDir = await createTempDir()
      const repo = createResourceDocumentRepository({
        activeConfigDir: tempDir,
        maxBytes: 64,
      })

      const content = JSON.stringify({
        schemaVersion: 2,
        revision: 1,
        hosts: [],
        tags: [],
        concepts: [],
        dataConnections: [],
        credentials: [],
        knownHostKeys: [],
        padding: '012345678901234567890123456789012345678901234567890123456789',
      })
      expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(64)

      await fs.mkdir(path.dirname(repo.filePath), { recursive: true })
      await fs.writeFile(repo.filePath, content, 'utf8')
      const beforeBytes = await fs.readFile(repo.filePath)
      const beforeHash = hashBuffer(beforeBytes)

      const result = await repo.load()
      expect(result).toEqual({
        status: 'corrupt',
        source: 'disk',
        readOnly: true,
        filePath: repo.filePath,
        reason: 'too-large',
        message: expect.stringContaining('exceeds maximum allowed size'),
      })

      const afterBytes = await fs.readFile(repo.filePath)
      expect(hashBuffer(afterBytes)).toBe(beforeHash)
    })

    it('classifies directory occupying target path as corrupt with reason io-error', async () => {
      const tempDir = await createTempDir()
      const repo = createResourceDocumentRepository({ activeConfigDir: tempDir })

      // Create directory at resources.json path
      await fs.mkdir(repo.filePath, { recursive: true })

      const result = await repo.load()
      expect(result.status).toBe('corrupt')
      if (result.status !== 'corrupt') return

      expect(result.source).toBe('disk')
      expect(result.readOnly).toBe(true)
      expect(result.filePath).toBe(repo.filePath)
      expect(result.reason).toBe('io-error')
      expect(result.message).toBeTruthy()
      expect('document' in result).toBe(false)
    })
  })

  describe('non-caching behavior', () => {
    it('does not cache: returns missing initially, then reads disk on subsequent load', async () => {
      const tempDir = await createTempDir()
      const repo = createResourceDocumentRepository({ activeConfigDir: tempDir })

      // First load: missing
      const result1 = await repo.load()
      expect(result1.status).toBe('ready')
      if (result1.status !== 'ready') return
      expect(result1.source).toBe('missing')
      expect(result1.document.revision).toBe(1)

      // Now create valid file on disk
      const doc = {
        schemaVersion: 2,
        revision: 99,
        hosts: [],
        tags: [],
        concepts: [],
        dataConnections: [],
        credentials: [],
        knownHostKeys: [],
      }
      await fs.mkdir(path.dirname(repo.filePath), { recursive: true })
      await fs.writeFile(repo.filePath, JSON.stringify(doc), 'utf8')

      // Second load: must see disk content
      const result2 = await repo.load()
      expect(result2.status).toBe('ready')
      if (result2.status !== 'ready') return
      expect(result2.source).toBe('disk')
      expect(result2.document.revision).toBe(99)
    })
  })
})
