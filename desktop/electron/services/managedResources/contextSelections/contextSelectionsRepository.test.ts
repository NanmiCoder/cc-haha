import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createContextSelectionsRepository,
  migrateContextSelectionsDocument,
  validateCredentialRevisions,
} from './contextSelectionsRepository.js'

const SESSION_ID = '70000000-0000-4000-8000-000000000001'
const SESSION_ID_2 = '70000000-0000-4000-8000-000000000002'
const HOST_ID = '10000000-0000-4000-8000-000000000001'
const CONCEPT_ID = '20000000-0000-4000-8000-000000000001'
const CREDENTIAL_ID = '50000000-0000-4000-8000-000000000001'
const HOST_TAG_ID = '30000000-0000-4000-8000-000000000001'
const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', '..', '..',
  'fixtures', 'managed-resources',
)

function hash(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function selection(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    hostRefs: [{ id: HOST_ID, revision: 1 }],
    conceptRootRefs: [{ id: CONCEPT_ID, revision: 1 }],
    dependencyRefs: [],
    databaseRefs: [],
    redisRefs: [],
    credentialRefs: [{ id: CREDENTIAL_ID, revision: 1 }],
    sourceTags: [{
      namespace: 'host',
      id: HOST_TAG_ID,
      labelAtSelection: 'FAKE_ONLY_HOST_TAG',
      memberIds: [HOST_ID],
    }],
    directHostIds: [],
    directConceptIds: [CONCEPT_ID],
    directDatabaseIds: [],
    directRedisIds: [],
    includePasswords: true,
    ...overrides,
  }
}

function v2Document(selections: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    selections,
  }
}

describe('contextSelectionsRepository', () => {
  let tempDirs: string[] = []

  async function createTempDir(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-context-selection-test-'))
    tempDirs.push(directory)
    return directory
  }

  afterEach(async () => {
    for (const directory of tempDirs) {
      await fs.rm(directory, { recursive: true, force: true })
    }
    tempDirs = []
  })

  it('migrates a v0 raw session map to v2 without losing host, concept, credential, or unknown fields', () => {
    const legacy = {
      [SESSION_ID]: {
        hostRefs: [{ id: HOST_ID, revision: 1 }],
        conceptRootRefs: [{ id: CONCEPT_ID, revision: 1 }],
        dependencyRefs: [],
        credentialRefs: [{ id: CREDENTIAL_ID, revision: 1 }],
        sourceTags: [],
        includePasswords: true,
        futureSelectionField: { preserved: true },
      },
      futureWrapperField: 'FAKE_ONLY_V0_UNKNOWN',
    }

    const result = migrateContextSelectionsDocument(legacy)

    expect(result.status).toBe('migrated')
    if (result.status !== 'migrated') return
    expect(result.fromVersion).toBe(0)
    expect(result.document.schemaVersion).toBe(2)
    expect(result.document.selections[SESSION_ID]).toMatchObject({
      schemaVersion: 2,
      hostRefs: [{ id: HOST_ID, revision: 1 }],
      conceptRootRefs: [{ id: CONCEPT_ID, revision: 1 }],
      credentialRefs: [{ id: CREDENTIAL_ID, revision: 1 }],
      databaseRefs: [],
      redisRefs: [],
      directDatabaseIds: [],
      directRedisIds: [],
      directHostIds: [HOST_ID],
      directConceptIds: [CONCEPT_ID],
      futureSelectionField: { preserved: true },
    })
    expect((result.document as Record<string, unknown>).futureWrapperField).toBe('FAKE_ONLY_V0_UNKNOWN')
  })

  it.each([
    ['v0', 'context-selections-v0.fixture.json', 0],
    ['v1', 'context-selections-v1.fixture.json', 1],
  ])('migrates the checked-in %s fixture without fixture secrets', async (_name, filename, version) => {
    const raw = await fs.readFile(path.join(FIXTURES_DIR, filename), 'utf8')
    expect(raw).not.toMatch(/FAKE_(?:PASSWORD|SECRET)|ciphertext|privateKey/i)

    const result = migrateContextSelectionsDocument(JSON.parse(raw), {
      namespaceByTagId: new Map([[HOST_TAG_ID, 'host']]),
    })

    expect(result.status).toBe('migrated')
    if (result.status !== 'migrated') return
    expect(result.fromVersion).toBe(version)
    expect(result.document.selections[SESSION_ID]).toMatchObject({
      schemaVersion: 2,
      hostRefs: [{ id: HOST_ID, revision: 1 }],
      conceptRootRefs: [{ id: CONCEPT_ID, revision: 1 }],
      databaseRefs: [],
      redisRefs: [],
      directDatabaseIds: [],
      directRedisIds: [],
    })
  })

  it('migrates v1 source tags only when namespace resolution is unambiguous and marks ambiguous tags for reselection', () => {
    const legacy = {
      schemaVersion: 1,
      selections: {
        [SESSION_ID]: {
          schemaVersion: 1,
          hostRefs: [{ id: HOST_ID, revision: 1 }],
          conceptRootRefs: [],
          dependencyRefs: [],
          credentialRefs: [],
          sourceTags: [{
            id: HOST_TAG_ID,
            labelAtSelection: 'FAKE_ONLY_HOST_TAG',
            memberIds: [HOST_ID],
          }],
          includePasswords: false,
          legacyUnknown: 'keep-me',
        },
      },
      futureWrapper: { keep: true },
    }

    const ambiguous = migrateContextSelectionsDocument(legacy)
    expect(ambiguous.status).toBe('migrated')
    if (ambiguous.status !== 'migrated') return
    expect(ambiguous.requiresReselection[SESSION_ID]).toEqual([HOST_TAG_ID])
    expect(ambiguous.document.selections[SESSION_ID]?.sourceTags).toEqual([])
    expect(ambiguous.document.selections[SESSION_ID]?.directHostIds).toEqual([HOST_ID])

    const resolved = migrateContextSelectionsDocument(legacy, {
      namespaceByTagId: new Map([[HOST_TAG_ID, 'host']]),
    })
    expect(resolved.status).toBe('migrated')
    if (resolved.status !== 'migrated') return
    expect(resolved.requiresReselection).toEqual({})
    expect(resolved.document.selections[SESSION_ID]?.sourceTags).toEqual([{
      namespace: 'host',
      id: HOST_TAG_ID,
      labelAtSelection: 'FAKE_ONLY_HOST_TAG',
      memberIds: [HOST_ID],
    }])
    expect((resolved.document.selections[SESSION_ID] as Record<string, unknown> | undefined)?.legacyUnknown).toBe('keep-me')
    expect((resolved.document as Record<string, unknown>).futureWrapper).toEqual({ keep: true })
  })

  it('writes a v2 selection atomically and preserves unknown wrapper and selection fields across restart', async () => {
    const activeConfigDir = await createTempDir()
    const repository = createContextSelectionsRepository({ activeConfigDir })
    await fs.mkdir(path.dirname(repository.filePath), { recursive: true })
    const existing = v2Document({
      [SESSION_ID]: selection({ futureSelection: { stable: true } }),
    }) as Record<string, unknown>
    existing.futureWrapper = { stable: true }
    await fs.writeFile(repository.filePath, JSON.stringify(existing, null, 2), 'utf8')
    const before = await repository.load()
    expect(before.status).toBe('ready')
    if (before.status !== 'ready') return

    const write = await repository.save(SESSION_ID, selection({ includePasswords: false, credentialRefs: [] }))
    expect(write.status).toBe('written')

    const reloaded = await createContextSelectionsRepository({ activeConfigDir }).load()
    expect(reloaded.status).toBe('ready')
    if (reloaded.status !== 'ready') return
    expect((reloaded.document as Record<string, unknown>).futureWrapper).toEqual({ stable: true })
    expect(reloaded.document.selections[SESSION_ID]).toMatchObject({
      schemaVersion: 2,
      includePasswords: false,
      credentialRefs: [],
      futureSelection: { stable: true },
    })
  })

  it('serializes concurrent session saves so neither selection is lost', async () => {
    const activeConfigDir = await createTempDir()
    const repository = createContextSelectionsRepository({ activeConfigDir })

    const results = await Promise.all([
      repository.save(SESSION_ID, selection({ includePasswords: false, credentialRefs: [] })),
      repository.save(SESSION_ID_2, selection({ includePasswords: false, credentialRefs: [] })),
    ])

    expect(results.map(result => result.status)).toEqual(['written', 'written'])
    const reloaded = await repository.load()
    expect(reloaded.status).toBe('ready')
    if (reloaded.status !== 'ready') return
    expect(Object.keys(reloaded.document.selections).sort()).toEqual([SESSION_ID, SESSION_ID_2])
  })

  it('backs up a v1 file and atomically persists its v2 migration', async () => {
    const activeConfigDir = await createTempDir()
    const repository = createContextSelectionsRepository({ activeConfigDir })
    const legacy = {
      schemaVersion: 1,
      selections: {
        [SESSION_ID]: {
          schemaVersion: 1,
          hostRefs: [{ id: HOST_ID, revision: 1 }],
          conceptRootRefs: [],
          dependencyRefs: [],
          credentialRefs: [],
          sourceTags: [],
          includePasswords: false,
          futureSelection: 'preserve',
        },
      },
      futureWrapper: 'preserve',
    }
    const legacyBytes = Buffer.from(JSON.stringify(legacy, null, 2), 'utf8')
    await fs.mkdir(path.dirname(repository.filePath), { recursive: true })
    await fs.writeFile(repository.filePath, legacyBytes)

    const result = await repository.migrateLegacy()

    expect(result).toMatchObject({ status: 'migrated', fromVersion: 1 })
    const migrated = await repository.load()
    expect(migrated.status).toBe('ready')
    if (migrated.status !== 'ready') return
    expect(migrated.document.selections[SESSION_ID]).toMatchObject({
      schemaVersion: 2,
      directHostIds: [HOST_ID],
      futureSelection: 'preserve',
    })
    expect((migrated.document as Record<string, unknown>).futureWrapper).toBe('preserve')
    const backups = (await fs.readdir(path.dirname(repository.filePath)))
      .filter(name => name.startsWith('context-selections.json.bak-v1-'))
    expect(backups).toHaveLength(1)
    expect(await fs.readFile(path.join(path.dirname(repository.filePath), backups[0]!))).toEqual(legacyBytes)
  })

  it('treats corrupt and future documents as read-only without changing their bytes', async () => {
    const activeConfigDir = await createTempDir()
    const repository = createContextSelectionsRepository({ activeConfigDir })
    await fs.mkdir(path.dirname(repository.filePath), { recursive: true })

    await fs.writeFile(repository.filePath, '{"schemaVersion":2,"selections":', 'utf8')
    const corruptBefore = await fs.readFile(repository.filePath)
    const corrupt = await repository.load()
    expect(corrupt).toMatchObject({ status: 'corrupt', readOnly: true, reason: 'invalid-json' })
    expect(hash(await fs.readFile(repository.filePath))).toBe(hash(corruptBefore))

    await fs.writeFile(repository.filePath, JSON.stringify({ schemaVersion: 3, selections: {} }), 'utf8')
    const futureBefore = await fs.readFile(repository.filePath)
    const future = await repository.load()
    expect(future).toMatchObject({ status: 'newer-schema', readOnly: true, schemaVersion: 3 })
    expect(hash(await fs.readFile(repository.filePath))).toBe(hash(futureBefore))
  })

  it('keeps the old file untouched when the atomic replacement fails', async () => {
    const activeConfigDir = await createTempDir()
    const goodRepository = createContextSelectionsRepository({ activeConfigDir })
    const original = v2Document({ [SESSION_ID]: selection() })
    await fs.mkdir(path.dirname(goodRepository.filePath), { recursive: true })
    await fs.writeFile(goodRepository.filePath, JSON.stringify(original, null, 2), 'utf8')
    const before = await fs.readFile(goodRepository.filePath)

    const failingRepository = createContextSelectionsRepository({
      activeConfigDir,
      dependencies: {
        replaceFile: async () => {
          throw new Error('injected rename failure')
        },
      },
    })
    const result = await failingRepository.save(SESSION_ID, selection({ includePasswords: false, credentialRefs: [] }))

    expect(result).toMatchObject({ status: 'not-written', reason: 'io-error' })
    expect(hash(await fs.readFile(goodRepository.filePath))).toBe(hash(before))
  })

  it('continues its save queue after an injected replacement failure', async () => {
    const activeConfigDir = await createTempDir()
    let failFirstReplacement = true
    const repository = createContextSelectionsRepository({
      activeConfigDir,
      dependencies: {
        replaceFile: async (sourcePath, targetPath) => {
          if (failFirstReplacement) {
            failFirstReplacement = false
            throw new Error('injected failure')
          }
          await fs.rename(sourcePath, targetPath)
        },
      },
    })

    const failed = await repository.save(SESSION_ID, selection({ includePasswords: false, credentialRefs: [] }))
    const written = await repository.save(SESSION_ID_2, selection({ includePasswords: false, credentialRefs: [] }))

    expect(failed).toMatchObject({ status: 'not-written', reason: 'io-error' })
    expect(written).toMatchObject({ status: 'written' })
    const reloaded = await repository.load()
    expect(reloaded.status).toBe('ready')
    if (reloaded.status !== 'ready') return
    expect(Object.keys(reloaded.document.selections)).toEqual([SESSION_ID_2])
  })

  it('does not expose an operating-system I/O message when the target is a directory', async () => {
    const activeConfigDir = await createTempDir()
    const repository = createContextSelectionsRepository({ activeConfigDir })
    await fs.mkdir(repository.filePath, { recursive: true })

    const result = await repository.load()

    expect(result).toMatchObject({
      status: 'corrupt',
      reason: 'io-error',
      message: 'Filesystem I/O error',
    })
  })

  it('detects a credential revision change even when the host revision remains unchanged', () => {
    const result = validateCredentialRevisions(selection(), {
      credentials: [{ id: CREDENTIAL_ID, revision: 2 }],
    })

    expect(result).toEqual({
      status: 'credential-revision-changed',
      id: CREDENTIAL_ID,
      expectedRevision: 1,
      actualRevision: 2,
    })
  })

  it('rejects invalid selections before credential revision validation', () => {
    const result = validateCredentialRevisions(selection({
      includePasswords: false,
      credentialRefs: [{ id: CREDENTIAL_ID, revision: 1 }],
    }), {
      credentials: [{ id: CREDENTIAL_ID, revision: 1 }],
    })

    expect(result).toEqual({ status: 'invalid-selection' })
  })
})
