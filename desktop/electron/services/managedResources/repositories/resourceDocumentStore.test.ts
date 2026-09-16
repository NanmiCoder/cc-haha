import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ResourceDocument } from '../../../../src/features/managed-resources/types/resourceTypes.js'
import { createResourceDocumentAtomicWriter } from './resourceDocumentAtomicWriter.js'
import { createResourceDocumentStore } from './resourceDocumentStore.js'

function emptyDocument(revision = 1): ResourceDocument {
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

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('resourceDocumentStore', () => {
  let tempDirs: string[] = []

  async function createTempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-store-test-'))
    tempDirs.push(dir)
    return dir
  }

  afterEach(async () => {
    for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true })
    tempDirs = []
  })

  it('serializes concurrent transactions and rejects the stale document revision', async () => {
    const tempDir = await createTempDir()
    const store = createResourceDocumentStore({ activeConfigDir: tempDir })

    const first = store.transact({
      expectedDocumentRevision: 1,
      mutate: draft => {
        ;(draft as ResourceDocument & { first?: string }).first = 'committed'
        return { commit: true as const, value: 'first' }
      },
    })
    const stale = store.transact({
      expectedDocumentRevision: 1,
      mutate: draft => {
        ;(draft as ResourceDocument & { stale?: string }).stale = 'must-not-run'
        return { commit: true as const, value: 'stale' }
      },
    })

    const [firstResult, staleResult] = await Promise.all([first, stale])
    expect(firstResult).toMatchObject({
      status: 'committed',
      previousRevision: 1,
      revision: 2,
      value: 'first',
    })
    expect(staleResult).toEqual({
      status: 'rejected',
      code: 'REVISION_CONFLICT',
      expectedRevision: 1,
      actualRevision: 2,
    })

    const loaded = await store.load()
    expect(loaded.status).toBe('ready')
    if (loaded.status !== 'ready') return
    expect((loaded.document as ResourceDocument & { first?: string }).first).toBe('committed')
    expect('stale' in loaded.document).toBe(false)
  })

  it('lets a later queued transaction observe the preceding committed revision', async () => {
    const tempDir = await createTempDir()
    const store = createResourceDocumentStore({ activeConfigDir: tempDir })

    const first = store.transact({
      expectedDocumentRevision: 1,
      mutate: () => ({ commit: true as const, value: 1 }),
    })
    const second = store.transact({
      expectedDocumentRevision: 2,
      mutate: () => ({ commit: true as const, value: 2 }),
    })

    const [, secondResult] = await Promise.all([first, second])
    expect(secondResult).toMatchObject({ status: 'committed', previousRevision: 2, revision: 3 })
  })

  it('preserves JSON unknown fields and owns the root revision increment', async () => {
    const tempDir = await createTempDir()
    const writer = createResourceDocumentAtomicWriter({ activeConfigDir: tempDir })
    await writer.write({
      ...emptyDocument(7),
      futureRoot: { enabled: true, list: [1, 'two', null] },
    })
    const store = createResourceDocumentStore({ activeConfigDir: tempDir })

    const result = await store.transact({
      expectedDocumentRevision: 7,
      mutate: draft => {
        draft.revision = 99
        return { commit: true as const, value: undefined }
      },
    })

    expect(result).toMatchObject({ status: 'committed', previousRevision: 7, revision: 8 })
    const restarted = createResourceDocumentStore({ activeConfigDir: tempDir })
    const loaded = await restarted.load()
    expect(loaded.status).toBe('ready')
    if (loaded.status !== 'ready') return
    expect(loaded.document.revision).toBe(8)
    expect((loaded.document as ResourceDocument & { futureRoot?: unknown }).futureRoot).toEqual({
      enabled: true,
      list: [1, 'two', null],
    })
  })

  it('does not write an explicitly aborted mutation', async () => {
    const tempDir = await createTempDir()
    const store = createResourceDocumentStore({ activeConfigDir: tempDir })
    const result = await store.transact({
      expectedDocumentRevision: 1,
      mutate: draft => {
        ;(draft as ResourceDocument & { discarded?: boolean }).discarded = true
        return { commit: false as const, value: 'validation-error' }
      },
    })

    expect(result).toEqual({
      status: 'aborted',
      revision: 1,
      value: 'validation-error',
    })
    await expect(fs.stat(store.filePath)).rejects.toThrow()
  })

  it('continues the queue after a mutation throws', async () => {
    const tempDir = await createTempDir()
    const store = createResourceDocumentStore({ activeConfigDir: tempDir })

    const failed = store.transact({
      expectedDocumentRevision: 1,
      mutate: () => {
        throw new Error('secret callback details must not escape')
      },
    })
    const succeeding = store.transact({
      expectedDocumentRevision: 1,
      mutate: () => ({ commit: true as const, value: 'ok' }),
    })

    expect(await failed).toEqual({ status: 'rejected', code: 'MUTATION_FAILED' })
    expect(await succeeding).toMatchObject({ status: 'committed', revision: 2 })
  })

  it('preserves old bytes and continues the queue after an injected replace failure', async () => {
    const tempDir = await createTempDir()
    const initialWriter = createResourceDocumentAtomicWriter({ activeConfigDir: tempDir })
    await initialWriter.write({ ...emptyDocument(4), marker: 'original' })
    const before = await fs.readFile(initialWriter.filePath)
    let replaceCalls = 0
    const store = createResourceDocumentStore({
      activeConfigDir: tempDir,
      writerDependencies: {
        replaceFile: async (source, target) => {
          replaceCalls += 1
          if (replaceCalls === 1) throw new Error('injected replace failure')
          await fs.rename(source, target)
        },
      },
    })

    const failed = store.transact({
      expectedDocumentRevision: 4,
      mutate: draft => {
        ;(draft as ResourceDocument & { marker?: string }).marker = 'failed'
        return { commit: true as const, value: 'failed' }
      },
    })
    const succeeding = store.transact({
      expectedDocumentRevision: 4,
      mutate: draft => {
        ;(draft as ResourceDocument & { marker?: string }).marker = 'succeeded'
        return { commit: true as const, value: 'succeeded' }
      },
    })

    expect(await failed).toEqual({ status: 'rejected', code: 'WRITE_FAILED' })
    expect(hash(await fs.readFile(store.filePath))).toBe(hash(before))
    expect(await succeeding).toMatchObject({ status: 'committed', revision: 5 })
    const loaded = await store.load()
    expect(loaded.status).toBe('ready')
    if (loaded.status === 'ready') {
      expect((loaded.document as ResourceDocument & { marker?: string }).marker).toBe('succeeded')
    }
  })

  it.each([
    ['migration-required', { schemaVersion: 1, revision: 1 }],
    ['newer-schema', { schemaVersion: 3, revision: 1 }],
    ['corrupt', '{invalid-json'],
  ])('keeps %s documents read-only and byte-for-byte unchanged', async (_label, raw) => {
    const tempDir = await createTempDir()
    const store = createResourceDocumentStore({ activeConfigDir: tempDir })
    await fs.mkdir(path.dirname(store.filePath), { recursive: true })
    const bytes = Buffer.from(typeof raw === 'string' ? raw : JSON.stringify(raw), 'utf8')
    await fs.writeFile(store.filePath, bytes)
    let mutationCalled = false

    const result = await store.transact({
      expectedDocumentRevision: 1,
      mutate: () => {
        mutationCalled = true
        return { commit: true as const, value: undefined }
      },
    })

    expect(result).toMatchObject({ status: 'rejected', code: 'READ_ONLY' })
    expect(mutationCalled).toBe(false)
    expect(hash(await fs.readFile(store.filePath))).toBe(hash(bytes))
  })
})
