import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ResourceDocumentSchema } from '../../../../src/features/managed-resources/types/resourceSchemas.js'
import { createResourceDocumentAtomicWriter } from './resourceDocumentAtomicWriter.js'
import { createResourceDocumentMigration } from './resourceDocumentMigration.js'
import { createResourceDocumentRepository } from './resourceDocumentRepository.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..')
const V1_FIXTURE_PATH = path.join(
  REPOSITORY_ROOT,
  'fixtures',
  'managed-resources',
  'resources-v1.fixture.json',
)

function hashBuffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('resourceDocumentMigration', () => {
  let tempDirs: string[] = []

  async function createTempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-res-migration-test-'))
    tempDirs.push(dir)
    return dir
  }

  async function seedResourceFile(activeConfigDir: string, content: string | Buffer): Promise<string> {
    const repository = createResourceDocumentRepository({ activeConfigDir })
    await fs.mkdir(path.dirname(repository.filePath), { recursive: true })
    await fs.writeFile(repository.filePath, content)
    return repository.filePath
  }

  afterEach(async () => {
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true })
    }
    tempDirs = []
  })

  it('migrates the frozen v1 fixture to v2, retains host/concept/unknown fields, and backs up exact old bytes', async () => {
    const activeConfigDir = await createTempDir()
    const originalBytes = await fs.readFile(V1_FIXTURE_PATH)
    const filePath = await seedResourceFile(activeConfigDir, originalBytes)
    const migration = createResourceDocumentMigration({ activeConfigDir })

    const result = await migration.migrateV1ToV2()

    expect(result.status).toBe('migrated')
    if (result.status !== 'migrated') return

    expect(result.filePath).toBe(filePath)
    expect(result.backupPath).toBe(path.join(path.dirname(filePath), 'resources.v1.backup.json'))
    expect(result.document).toMatchObject({
      schemaVersion: 2,
      revision: 7,
      futureTopLevel: { migrationNote: 'preserve-me' },
      dataConnections: [],
      credentials: [],
      knownHostKeys: [],
    })
    expect((result.document.hosts[0] as Record<string, unknown>).futureHostField).toEqual({
      preserved: true,
    })
    expect((result.document.concepts[0] as Record<string, unknown>).futureConceptField).toBe(
      'preserve-me',
    )
    expect(ResourceDocumentSchema.safeParse(result.document).success).toBe(true)
    await expect(fs.readFile(result.backupPath)).resolves.toEqual(originalBytes)

    const reloaded = await createResourceDocumentRepository({ activeConfigDir }).load()
    expect(reloaded.status).toBe('ready')
    if (reloaded.status === 'ready') {
      expect(reloaded.document).toEqual(result.document)
    }
  })

  it('does not overwrite a v1 source file when atomic replacement fails after its backup was made', async () => {
    const activeConfigDir = await createTempDir()
    const originalBytes = await fs.readFile(V1_FIXTURE_PATH)
    const filePath = await seedResourceFile(activeConfigDir, originalBytes)
    const writer = createResourceDocumentAtomicWriter({
      activeConfigDir,
      dependencies: {
        replaceFile: async () => {
          throw new Error('injected replacement failure')
        },
      },
    })
    const migration = createResourceDocumentMigration({
      activeConfigDir,
      dependencies: { writer },
    })

    const result = await migration.migrateV1ToV2()

    expect(result).toEqual({
      status: 'not-migrated',
      filePath,
      reason: 'write-failed',
      message: 'Atomic replacement of the migrated resource document failed',
    })
    const afterBytes = await fs.readFile(filePath)
    expect(hashBuffer(afterBytes)).toBe(hashBuffer(originalBytes))
    await expect(
      fs.readFile(path.join(path.dirname(filePath), 'resources.v1.backup.json')),
    ).resolves.toEqual(originalBytes)
  })

  it.each([
    ['newer-schema', JSON.stringify({ schemaVersion: 3, revision: 1 })],
    ['corrupt', '{"schemaVersion": 1,'],
  ])('refuses %s input without writing a backup or changing source bytes', async (_kind, raw) => {
    const activeConfigDir = await createTempDir()
    const filePath = await seedResourceFile(activeConfigDir, raw)
    const beforeBytes = await fs.readFile(filePath)
    const migration = createResourceDocumentMigration({ activeConfigDir })

    const result = await migration.migrateV1ToV2()

    expect(result.status).toBe('not-migrated')
    if (result.status !== 'not-migrated') return
    expect(result.reason).toBe(_kind)
    expect(hashBuffer(await fs.readFile(filePath))).toBe(hashBuffer(beforeBytes))
    await expect(
      fs.stat(path.join(path.dirname(filePath), 'resources.v1.backup.json')),
    ).rejects.toThrow()
  })
})
