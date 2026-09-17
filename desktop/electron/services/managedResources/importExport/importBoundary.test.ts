import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { executeImportMetadata } from './importMetadata.js'
import { scanForSecrets } from './secretDenylist.js'
import { createResourceDocumentStore } from '../repositories/resourceDocumentStore.js'
import { createResourceLibraryService } from '../repositories/resourceLibraryService.js'
import type { ManagedResourcesServices } from '../registerIpc.js'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-import-boundary-'))
  directories.push(directory)
  const store = createResourceDocumentStore({ activeConfigDir: directory })
  const library = createResourceLibraryService({ store })
  const created = await library.createHost({ name: 'fixture', address: 'fixture.invalid', port: 22, username: 'fixture', auth: { type: 'password', credentialId: null }, tagIds: [], initialDirectory: null, applications: [], notes: 'original' })
  if (created.status !== 'created') throw new Error('fixture creation failed')
  const host = created.value
  const inputPath = path.join(directory, 'import.json')
  const document = () => ({ schemaVersion: 2, hosts: [structuredClone(host)], tags: [], concepts: [], dataConnections: [], knownHostKeys: [] })
  return {
    store, host, document,
    async importDocument(value: unknown) {
      await fs.writeFile(inputPath, JSON.stringify(value), 'utf8')
      return executeImportMetadata(
        { isDestroyed: () => false } as BrowserWindow,
        { store } as ManagedResourcesServices,
        { showOpenDialog: async () => ({ canceled: false, filePaths: [inputPath] }), showSaveDialog: async () => ({ canceled: true }) },
      )
    },
  }
}

describe('M2 public import boundary regression', () => {
  it.each([
    { colorToken: { password: 'M2_FAKE_SENTINEL_ONLY' } },
    { colorToken: [{ password: 'M2_FAKE_SENTINEL_ONLY' }] },
    { colorToken: 'https://fixture:M2_FAKE_SENTINEL_ONLY@example.invalid/' },
  ])('rejects colorToken subtree bypass without changing disk', async extensionMetadata => {
    const f = await fixture()
    const before = await fs.readFile(f.store.filePath)
    const doc = f.document()
    Object.assign(doc.hosts[0]!, { extensionMetadata })
    const result = await f.importDocument(doc)
    expect(result.ok).toBe(false)
    expect(await fs.readFile(f.store.filePath)).toEqual(before)
  })

  it('allows real tag color tokens but scans their contents', () => {
    expect(scanForSecrets({ tags: [{ colorToken: 'teal' }] }).detected).toBe(false)
    expect(scanForSecrets({ tags: [{ colorToken: null }] }).detected).toBe(false)
    expect(scanForSecrets({ tags: [{ colorToken: 'https://fake:secret@example.invalid/' }] }).detected).toBe(true)
  })

  it('rejects unknown fields at nested public import boundaries', async () => {
    const f = await fixture()
    const before = await fs.readFile(f.store.filePath)
    const doc = f.document()
    Object.assign(doc.hosts[0]!.auth, { arbitraryFutureField: 'not an import field' })
    expect((await f.importDocument(doc)).ok).toBe(false)
    expect(await fs.readFile(f.store.filePath)).toEqual(before)
  })

  it('rejects different content with the same entity revision', async () => {
    const f = await fixture()
    const before = await fs.readFile(f.store.filePath)
    const doc = f.document()
    doc.hosts[0]!.notes = 'different'
    const result = await f.importDocument(doc)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('REVISION_CONFLICT')
    expect(await fs.readFile(f.store.filePath)).toEqual(before)
  })

  it('permits identical public metadata and preserves internal unknown fields', async () => {
    const f = await fixture()
    await f.store.transact({ mutate(draft) {
      Object.assign(draft.hosts[0]!, { futureInternalMetadata: { preserved: true } })
      return { commit: true, value: null }
    } })
    expect((await f.importDocument(f.document())).ok).toBe(true)
    const loaded = await f.store.load()
    expect(loaded.status).toBe('ready')
    if (loaded.status === 'ready') expect(loaded.document.hosts[0]).toMatchObject({ revision: 1, futureInternalMetadata: { preserved: true } })
  })

  it('accepts an explicit newer revision without changing unrelated resources', async () => {
    const f = await fixture()
    const doc = f.document()
    doc.hosts[0]!.revision = 2
    doc.hosts[0]!.notes = 'explicit update'
    expect((await f.importDocument(doc)).ok).toBe(true)
    const loaded = await f.store.load()
    if (loaded.status !== 'ready') throw new Error('fixture read failed')
    expect(loaded.document.hosts[0]).toMatchObject({ revision: 2, notes: 'explicit update' })
    expect(loaded.document.hosts).toHaveLength(1)
  })
})
