import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createResourceDocumentStore } from './resourceDocumentStore.js'
import { createResourceLibraryService } from './resourceLibraryService.js'

const stamp = '2026-09-08T00:00:00.000Z'
const idValues = [
  '30000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '60000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
]

function hash(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('resourceLibraryService', () => {
  let tempDirs: string[] = []

  async function setup() {
    const activeConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-library-test-'))
    tempDirs.push(activeConfigDir)
    let next = 0
    const store = createResourceDocumentStore({ activeConfigDir })
    const service = createResourceLibraryService({
      store,
      now: () => stamp,
      createId: () => idValues[next++]!,
    })
    return { activeConfigDir, store, service }
  }

  afterEach(async () => {
    for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true })
    tempDirs = []
  })

  it('creates persisted tags, derives normalizedName, and rejects a same-namespace normalized duplicate without writing', async () => {
    const { activeConfigDir, store, service } = await setup()
    const first = await service.createTag({ namespace: 'host', name: '  ＰＲＯＤ\t Server ', colorToken: null })
    expect(first).toMatchObject({ status: 'created', documentRevision: 2, value: { normalizedName: 'prod server' } })
    const before = await fs.readFile(store.filePath)

    const duplicate = await service.createTag({ namespace: 'host', name: 'prod   server', colorToken: null })
    expect(duplicate).toMatchObject({ status: 'rejected', code: 'VALIDATION_FAILED' })
    expect(hash(await fs.readFile(store.filePath))).toBe(hash(before))

    const restarted = createResourceDocumentStore({ activeConfigDir })
    const loaded = await restarted.load()
    expect(loaded.status).toBe('ready')
    if (loaded.status === 'ready') expect(loaded.document.tags[0]!.normalizedName).toBe('prod server')
  })

  it('uses the parent Host revision for application CRUD and rejects a stale application edit', async () => {
    const { service } = await setup()
    const tag = await service.createTag({ namespace: 'host', name: 'test', colorToken: null })
    if (tag.status !== 'created') throw new Error('tag setup failed')
    const host = await service.createHost({
      name: 'host', address: '192.0.2.10', port: 22, username: 'root', auth: { type: 'password', credentialId: null }, tagIds: [tag.value.id], initialDirectory: null, applications: [], notes: '',
    })
    if (host.status !== 'created') throw new Error('host setup failed')

    const added = await service.createApplication({
      hostId: host.value.id,
      expectedHostRevision: 1,
      application: { name: 'app', version: null, installPaths: ['/opt/app'], accessDescription: '', accessUrls: [], loginUrl: null, accounts: [], notes: '' },
    })
    expect(added).toMatchObject({ status: 'created', documentRevision: 4, value: { revision: 2, applications: [{ name: 'app' }] } })
    const stale = await service.updateApplication({
      hostId: host.value.id,
      expectedHostRevision: 1,
      applicationId: idValues[2]!,
      changes: { name: 'renamed' },
    })
    expect(stale).toMatchObject({ status: 'rejected', code: 'REVISION_CONFLICT', expectedRevision: 1, actualRevision: 2 })
  })

  it('validates DataConnection host/tag/credential references, then blocks deleting a referenced Host', async () => {
    const { service } = await setup()
    const hostTag = await service.createTag({ namespace: 'host', name: 'host', colorToken: null })
    const host = await service.createHost({
      name: 'host', address: '192.0.2.11', port: 22, username: 'root', auth: { type: 'password', credentialId: null }, tagIds: [hostTag.status === 'created' ? hostTag.value.id : 'bad'], initialDirectory: null, applications: [], notes: '',
    })
    const wrongTag = await service.createTag({ namespace: 'concept', name: 'concept', colorToken: null })
    const rejected = await service.createDataConnection({
      name: 'db', address: '192.0.2.12', port: 3306, username: null, credentialId: null, tagIds: [wrongTag.status === 'created' ? wrongTag.value.id : 'bad'], relatedHostId: host.status === 'created' ? host.value.id : null,
      environment: 'unspecified', tls: { enabled: false, serverName: null, caCertificate: null, clientCertificate: null, clientKeyCredentialId: null }, description: '', accessInstructions: '', kind: 'database', engine: 'mysql', database: 'app', schema: null, mode: 'inspection',
    })
    expect(rejected).toMatchObject({ status: 'rejected', code: 'VALIDATION_FAILED' })

    const databaseTag = await service.createTag({ namespace: 'database', name: 'db', colorToken: null })
    const connection = await service.createDataConnection({
      name: 'db', address: '192.0.2.12', port: 3306, username: null, credentialId: null, tagIds: [databaseTag.status === 'created' ? databaseTag.value.id : 'bad'], relatedHostId: host.status === 'created' ? host.value.id : null,
      environment: 'unspecified', tls: { enabled: false, serverName: null, caCertificate: null, clientCertificate: null, clientKeyCredentialId: null }, description: '', accessInstructions: '', kind: 'database', engine: 'mysql', database: 'app', schema: null, mode: 'inspection',
    })
    if (host.status !== 'created' || connection.status !== 'created') throw new Error('connection setup failed')
    expect(await service.deleteHost({ id: host.value.id, expectedRevision: 1 })).toMatchObject({
      status: 'rejected', code: 'RESOURCE_IN_USE', references: [{ resourceType: 'dataConnection', id: connection.value.id, relation: 'relatedHostId' }],
    })
  })

  it('blocks deletion of a depended-on Concept and requires explicit reference-edge removal', async () => {
    const { service } = await setup()
    const tag = await service.createTag({ namespace: 'concept', name: 'concept', colorToken: null })
    if (tag.status !== 'created') throw new Error('tag setup failed')
    const base = await service.createConcept({ title: 'base', summary: '', bodyMarkdown: 'base', tagIds: [tag.value.id], dependsOnIds: [], referenceIds: [] })
    const dependent = await service.createConcept({ title: 'dependent', summary: '', bodyMarkdown: 'dependent', tagIds: [tag.value.id], dependsOnIds: [base.status === 'created' ? base.value.id : 'bad'], referenceIds: [] })
    if (base.status !== 'created' || dependent.status !== 'created') throw new Error('concept setup failed')
    expect(await service.deleteConcept({ id: base.value.id, expectedRevision: 1 })).toMatchObject({ status: 'rejected', code: 'RESOURCE_IN_USE' })

    const reference = await service.createConcept({ title: 'reference', summary: '', bodyMarkdown: 'reference', tagIds: [tag.value.id], dependsOnIds: [], referenceIds: [dependent.value.id] })
    if (reference.status !== 'created') throw new Error('reference setup failed')
    expect(await service.deleteConcept({ id: dependent.value.id, expectedRevision: 1 })).toMatchObject({ status: 'rejected', code: 'RESOURCE_IN_USE' })
    expect(await service.deleteConcept({ id: dependent.value.id, expectedRevision: 1, removeReferenceEdges: true })).toMatchObject({ status: 'deleted' })
  })

  it('deletes a tag by unlinking only its namespace resources within one persisted transaction', async () => {
    const { store, service } = await setup()
    const tag = await service.createTag({ namespace: 'host', name: 'host', colorToken: null })
    if (tag.status !== 'created') throw new Error('tag setup failed')
    const host = await service.createHost({ name: 'host', address: '192.0.2.13', port: 22, username: 'root', auth: { type: 'password', credentialId: null }, tagIds: [tag.value.id], initialDirectory: null, applications: [], notes: '' })
    if (host.status !== 'created') throw new Error('host setup failed')
    expect(await service.deleteTag({ id: tag.value.id, expectedRevision: 1 })).toMatchObject({ status: 'deleted', documentRevision: 4 })
    const loaded = await store.load()
    expect(loaded.status).toBe('ready')
    if (loaded.status === 'ready') {
      expect(loaded.document.tags).toEqual([])
      expect(loaded.document.hosts[0]).toMatchObject({ revision: 2, tagIds: [] })
    }
  })
})
