import type { ResourceDocument } from '../../../../src/features/managed-resources/types/resourceTypes.js'
import { describe, expect, it } from 'vitest'
import {
  findResourceReferences,
  normalizeResourceTagName,
  validateResourceDocumentIntegrity,
} from './resourceDocumentIntegrity.js'

const ids = {
  host: '10000000-0000-4000-8000-000000000001',
  concept: '20000000-0000-4000-8000-000000000001',
  hostTag: '30000000-0000-4000-8000-000000000001',
  conceptTag: '30000000-0000-4000-8000-000000000002',
  databaseTag: '30000000-0000-4000-8000-000000000003',
  database: '40000000-0000-4000-8000-000000000001',
  sshCredential: '50000000-0000-4000-8000-000000000001',
  databaseCredential: '50000000-0000-4000-8000-000000000002',
}
const stamp = '2026-09-01T00:00:00.000Z'

function validDocument(): ResourceDocument {
  return {
    schemaVersion: 2,
    revision: 1,
    tags: [
      { id: ids.hostTag, revision: 1, createdAt: stamp, updatedAt: stamp, namespace: 'host', name: 'Prod', normalizedName: 'prod', colorToken: null },
      { id: ids.conceptTag, revision: 1, createdAt: stamp, updatedAt: stamp, namespace: 'concept', name: 'Core', normalizedName: 'core', colorToken: null },
      { id: ids.databaseTag, revision: 1, createdAt: stamp, updatedAt: stamp, namespace: 'database', name: 'Primary', normalizedName: 'primary', colorToken: null },
    ],
    hosts: [
      {
        id: ids.host, revision: 1, createdAt: stamp, updatedAt: stamp, name: 'host', address: '192.0.2.1', port: 22, username: 'root',
        auth: { type: 'password', credentialId: ids.sshCredential }, tagIds: [ids.hostTag], initialDirectory: null, applications: [], notes: '',
      },
    ],
    concepts: [
      { id: ids.concept, revision: 1, createdAt: stamp, updatedAt: stamp, title: 'Concept', summary: '', bodyMarkdown: 'body', tagIds: [ids.conceptTag], dependsOnIds: [], referenceIds: [] },
    ],
    dataConnections: [
      {
        id: ids.database, revision: 1, createdAt: stamp, updatedAt: stamp, name: 'database', address: '192.0.2.2', port: 3306, username: 'root', credentialId: ids.databaseCredential,
        tagIds: [ids.databaseTag], relatedHostId: ids.host, environment: 'unspecified', tls: { enabled: false, serverName: null, caCertificate: null, clientCertificate: null, clientKeyCredentialId: null },
        description: '', accessInstructions: '', kind: 'database', engine: 'mysql', database: 'app', schema: null, mode: 'inspection',
      },
    ],
    credentials: [
      { id: ids.sshCredential, revision: 1, createdAt: stamp, updatedAt: stamp, kind: 'ssh-password', label: 'ssh', backend: 'electron-safe-storage-v1', ciphertextBase64: 'RkFLRQ==' },
      { id: ids.databaseCredential, revision: 1, createdAt: stamp, updatedAt: stamp, kind: 'database-password', label: 'db', backend: 'electron-safe-storage-v1', ciphertextBase64: 'RkFLRQ==' },
    ],
    knownHostKeys: [],
  }
}

describe('resourceDocumentIntegrity', () => {
  it('normalizes tag names with NFKC, trim, collapsed whitespace, and locale-independent lower case', () => {
    expect(normalizeResourceTagName('  ＰＲＯＤ\t  Server  ')).toBe('prod server')
  })

  it('accepts a fully connected document and finds typed reverse references', () => {
    const document = validDocument()
    expect(validateResourceDocumentIntegrity(document)).toEqual([])
    expect(findResourceReferences(document, { resourceType: 'host', id: ids.host })).toEqual([
      { resourceType: 'dataConnection', id: ids.database, relation: 'relatedHostId' },
    ])
    expect(findResourceReferences(document, { resourceType: 'credential', id: ids.sshCredential })).toEqual([
      { resourceType: 'host', id: ids.host, relation: 'auth.credentialId' },
    ])
  })

  it('reports tag normalization/namespace, missing references, wrong credential kinds, and concept self links', () => {
    const document = validDocument()
    document.tags.push({
      id: '30000000-0000-4000-8000-000000000099', revision: 1, createdAt: stamp, updatedAt: stamp,
      namespace: 'host', name: ' prod ', normalizedName: 'WRONG', colorToken: null,
    })
    document.hosts[0]!.tagIds = [ids.conceptTag]
    document.hosts[0]!.auth.credentialId = ids.databaseCredential
    document.concepts[0]!.dependsOnIds = [ids.concept]
    document.dataConnections[0]!.relatedHostId = '10000000-0000-4000-8000-000000000099'

    const codes = validateResourceDocumentIntegrity(document).map(issue => issue.code)
    expect(codes).toContain('TAG_NORMALIZED_NAME_MISMATCH')
    expect(codes).toContain('TAG_NORMALIZED_NAME_DUPLICATE')
    expect(codes).toContain('TAG_NAMESPACE_MISMATCH')
    expect(codes).toContain('CREDENTIAL_KIND_MISMATCH')
    expect(codes).toContain('CONCEPT_SELF_REFERENCE')
    expect(codes).toContain('MISSING_REFERENCE')
  })
})
