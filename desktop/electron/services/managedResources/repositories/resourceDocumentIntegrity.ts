import type { DataConnection } from '../../../../src/features/managed-resources/types/dataConnectionTypes.js'
import type {
  CredentialKind,
  ResourceDocument,
  TagNamespace,
} from '../../../../src/features/managed-resources/types/resourceTypes.js'

export type ResourceIntegrityIssueCode =
  | 'DUPLICATE_RESOURCE_ID'
  | 'TAG_NORMALIZED_NAME_MISMATCH'
  | 'TAG_NORMALIZED_NAME_DUPLICATE'
  | 'TAG_NAMESPACE_MISMATCH'
  | 'MISSING_REFERENCE'
  | 'CREDENTIAL_KIND_MISMATCH'
  | 'CONCEPT_SELF_REFERENCE'

export type ResourceIntegrityIssue = {
  code: ResourceIntegrityIssueCode
  path: string
  id?: string
  expected?: string
}

export type ManagedResourceType =
  | 'tag'
  | 'host'
  | 'concept'
  | 'dataConnection'
  | 'credential'

export type ResourceReference = {
  resourceType: ManagedResourceType
  id: string
  relation: string
}

type ResourceTarget = {
  resourceType: ManagedResourceType
  id: string
}

type EntityIndex = {
  tags: Map<string, ResourceDocument['tags'][number]>
  hosts: Map<string, ResourceDocument['hosts'][number]>
  concepts: Map<string, ResourceDocument['concepts'][number]>
  dataConnections: Map<string, DataConnection>
  credentials: Map<string, ResourceDocument['credentials'][number]>
}

export function normalizeResourceTagName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
}

function buildIndex(document: ResourceDocument, issues: ResourceIntegrityIssue[]): EntityIndex {
  const ids = new Map<string, string>()
  const makeIndex = <T extends { id: string }>(kind: string, entities: T[]): Map<string, T> => {
    const index = new Map<string, T>()
    for (const entity of entities) {
      const existing = ids.get(entity.id)
      if (existing !== undefined) {
        issues.push({
          code: 'DUPLICATE_RESOURCE_ID',
          path: `${kind}[${entity.id}]`,
          id: entity.id,
          expected: existing,
        })
      } else {
        ids.set(entity.id, kind)
      }
      index.set(entity.id, entity)
    }
    return index
  }
  return {
    tags: makeIndex('tags', document.tags),
    hosts: makeIndex('hosts', document.hosts),
    concepts: makeIndex('concepts', document.concepts),
    dataConnections: makeIndex('dataConnections', document.dataConnections),
    credentials: makeIndex('credentials', document.credentials),
  }
}

function expectReference(
  issues: ResourceIntegrityIssue[],
  path: string,
  id: string | null,
  target: Map<string, unknown>,
): void {
  if (id !== null && !target.has(id)) {
    issues.push({ code: 'MISSING_REFERENCE', path, id })
  }
}

function expectTagNamespace(
  issues: ResourceIntegrityIssue[],
  index: EntityIndex,
  ids: string[],
  namespace: TagNamespace,
  path: string,
): void {
  for (const id of ids) {
    const tag = index.tags.get(id)
    if (!tag) {
      issues.push({ code: 'MISSING_REFERENCE', path, id })
    } else if (tag.namespace !== namespace) {
      issues.push({
        code: 'TAG_NAMESPACE_MISMATCH',
        path,
        id,
        expected: namespace,
      })
    }
  }
}

function expectCredential(
  issues: ResourceIntegrityIssue[],
  index: EntityIndex,
  path: string,
  id: string | null,
  expectedKind: CredentialKind,
): void {
  if (id === null) return
  const credential = index.credentials.get(id)
  if (!credential) {
    issues.push({ code: 'MISSING_REFERENCE', path, id })
  } else if (credential.kind !== expectedKind) {
    issues.push({
      code: 'CREDENTIAL_KIND_MISMATCH',
      path,
      id,
      expected: expectedKind,
    })
  }
}

function connectionNamespace(connection: DataConnection): TagNamespace {
  return connection.kind === 'database' ? 'database' : 'redis'
}

export function validateResourceDocumentIntegrity(document: ResourceDocument): ResourceIntegrityIssue[] {
  const issues: ResourceIntegrityIssue[] = []
  const index = buildIndex(document, issues)
  const normalizedNames = new Map<string, string>()

  for (const tag of document.tags) {
    const normalized = normalizeResourceTagName(tag.name)
    if (tag.normalizedName !== normalized) {
      issues.push({
        code: 'TAG_NORMALIZED_NAME_MISMATCH',
        path: `tags[${tag.id}].normalizedName`,
        id: tag.id,
        expected: normalized,
      })
    }
    const key = `${tag.namespace}\u0000${normalized}`
    const existing = normalizedNames.get(key)
    if (existing !== undefined) {
      issues.push({
        code: 'TAG_NORMALIZED_NAME_DUPLICATE',
        path: `tags[${tag.id}].normalizedName`,
        id: tag.id,
        expected: existing,
      })
    } else {
      normalizedNames.set(key, tag.id)
    }
  }

  for (const host of document.hosts) {
    expectTagNamespace(issues, index, host.tagIds, 'host', `hosts[${host.id}].tagIds`)
    expectCredential(
      issues,
      index,
      `hosts[${host.id}].auth.credentialId`,
      host.auth.credentialId,
      host.auth.type === 'password' ? 'ssh-password' : 'ssh-private-key',
    )
    for (const application of host.applications) {
      for (const account of application.accounts) {
        expectCredential(
          issues,
          index,
          `hosts[${host.id}].applications[${application.id}].accounts[${account.id}].credentialId`,
          account.credentialId,
          'application-password',
        )
      }
    }
  }

  for (const concept of document.concepts) {
    expectTagNamespace(issues, index, concept.tagIds, 'concept', `concepts[${concept.id}].tagIds`)
    for (const [relation, values] of [
      ['dependsOnIds', concept.dependsOnIds],
      ['referenceIds', concept.referenceIds],
    ] as const) {
      for (const id of values) {
        if (id === concept.id) {
          issues.push({ code: 'CONCEPT_SELF_REFERENCE', path: `concepts[${concept.id}].${relation}`, id })
        }
        expectReference(issues, `concepts[${concept.id}].${relation}`, id, index.concepts)
      }
    }
  }

  for (const connection of document.dataConnections) {
    expectTagNamespace(
      issues,
      index,
      connection.tagIds,
      connectionNamespace(connection),
      `dataConnections[${connection.id}].tagIds`,
    )
    expectReference(
      issues,
      `dataConnections[${connection.id}].relatedHostId`,
      connection.relatedHostId,
      index.hosts,
    )
    expectCredential(
      issues,
      index,
      `dataConnections[${connection.id}].credentialId`,
      connection.credentialId,
      connection.kind === 'database' ? 'database-password' : 'redis-password',
    )
    expectCredential(
      issues,
      index,
      `dataConnections[${connection.id}].tls.clientKeyCredentialId`,
      connection.tls.clientKeyCredentialId,
      'tls-client-key',
    )
  }

  return issues
}

export function findResourceReferences(
  document: ResourceDocument,
  target: ResourceTarget,
): ResourceReference[] {
  const references: ResourceReference[] = []
  const add = (resourceType: ManagedResourceType, id: string, relation: string): void => {
    references.push({ resourceType, id, relation })
  }

  if (target.resourceType === 'tag') {
    for (const host of document.hosts) if (host.tagIds.includes(target.id)) add('host', host.id, 'tagIds')
    for (const concept of document.concepts) if (concept.tagIds.includes(target.id)) add('concept', concept.id, 'tagIds')
    for (const connection of document.dataConnections) {
      if (connection.tagIds.includes(target.id)) add('dataConnection', connection.id, 'tagIds')
    }
  }
  if (target.resourceType === 'host') {
    for (const connection of document.dataConnections) {
      if (connection.relatedHostId === target.id) add('dataConnection', connection.id, 'relatedHostId')
    }
  }
  if (target.resourceType === 'concept') {
    for (const concept of document.concepts) {
      if (concept.dependsOnIds.includes(target.id)) add('concept', concept.id, 'dependsOnIds')
      if (concept.referenceIds.includes(target.id)) add('concept', concept.id, 'referenceIds')
    }
  }
  if (target.resourceType === 'credential') {
    for (const host of document.hosts) {
      if (host.auth.credentialId === target.id) add('host', host.id, 'auth.credentialId')
      for (const application of host.applications) {
        for (const account of application.accounts) {
          if (account.credentialId === target.id) {
            add('host', host.id, `applications.${application.id}.accounts.${account.id}.credentialId`)
          }
        }
      }
    }
    for (const connection of document.dataConnections) {
      if (connection.credentialId === target.id) add('dataConnection', connection.id, 'credentialId')
      if (connection.tls.clientKeyCredentialId === target.id) {
        add('dataConnection', connection.id, 'tls.clientKeyCredentialId')
      }
    }
  }
  return references
}
