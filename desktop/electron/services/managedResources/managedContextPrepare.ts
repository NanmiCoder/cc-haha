import type {
  HostManagementResult,
  ManagedContextPrepareInput,
  ManagedContextStageRequest,
} from '../../../src/features/managed-resources/api/hostManagementApi.js'
import type {
  CredentialRecord,
  ResourceDocument,
} from '../../../src/features/managed-resources/types/resourceTypes.js'
import type { ResourceDocumentStore } from './repositories/resourceDocumentStore.js'
import { resolveContextSelection } from './contextResolver.js'
import {
  buildModelContext,
  buildPublicContextManifest,
  type StagedContextSnapshot,
  type StagedHost,
  type StagedConcept,
  type StagedDatabase,
  type StagedRedisConnection,
} from '../../../../src/services/managedContext/manifest.js'
import {
  canonicalJson,
  contextBindingOf,
  sha256Hex,
} from '../../../../src/services/managedContext/canonicalSerializer.js'
import { ManagedContextError } from '../../../../src/services/managedContext/errors.js'
import type { CredentialVault } from './vault/credentialVault.js'

function failure<T>(code: string, params?: Record<string, unknown>): HostManagementResult<T> {
  return {
    ok: false,
    error: {
      code,
      messageKey: `managedResources.errors.${code}`,
      ...(params ? { params } : {}),
    },
  }
}

function stagedHosts(document: ResourceDocument, ids: string[]): StagedHost[] {
  const byId = new Map(document.hosts.map(host => [host.id, host]))
  return ids.map(id => byId.get(id)).filter((host): host is NonNullable<typeof host> => Boolean(host)).map(host => ({
    id: host.id,
    revision: host.revision,
    name: host.name,
    address: host.address,
    port: host.port,
    username: host.username,
    tagIds: [...host.tagIds],
    applications: host.applications.map(application => ({
      name: application.name,
      version: application.version,
      installPaths: [...application.installPaths],
      accessDescription: application.accessDescription,
      accessUrls: [...application.accessUrls],
      loginUrl: application.loginUrl,
      accounts: application.accounts.map(account => ({
        username: account.username,
        credentialId: account.credentialId,
      })),
      notes: application.notes,
    })),
    notes: host.notes,
  }))
}

function stagedConcepts(document: ResourceDocument, ids: string[]): StagedConcept[] {
  const byId = new Map(document.concepts.map(concept => [concept.id, concept]))
  return ids.map(id => byId.get(id)).filter((concept): concept is NonNullable<typeof concept> => Boolean(concept)).map(concept => ({
    id: concept.id,
    revision: concept.revision,
    title: concept.title,
    bodyMarkdown: concept.bodyMarkdown,
    dependsOnIds: [...concept.dependsOnIds],
    referenceIds: [...concept.referenceIds],
    tagIds: [...concept.tagIds],
  }))
}

function stagedDataConnections(document: ResourceDocument, input: ManagedContextPrepareInput) {
  const byId = new Map(document.dataConnections.map(connection => [connection.id, connection]))
  const databases: StagedDatabase[] = []
  for (const ref of input.selection.databaseRefs) {
    const connection = byId.get(ref.id)
    if (!connection || connection.kind !== 'database') continue
    databases.push({
      id: connection.id,
      revision: connection.revision,
      name: connection.name,
      engine: connection.engine,
      address: connection.address,
      port: connection.port,
      username: connection.username,
      credentialId: connection.credentialId,
      database: connection.database,
      schema: connection.schema,
      environment: connection.environment,
      tls: { enabled: connection.tls.enabled, serverName: connection.tls.serverName },
      tagIds: [...connection.tagIds],
      relatedHostId: connection.relatedHostId,
      description: connection.description,
      accessInstructions: connection.accessInstructions,
    })
  }
  const redisConnections: StagedRedisConnection[] = []
  for (const ref of input.selection.redisRefs) {
    const connection = byId.get(ref.id)
    if (!connection || connection.kind !== 'redis') continue
    redisConnections.push({
      id: connection.id,
      revision: connection.revision,
      name: connection.name,
      address: connection.address,
      port: connection.port,
      topology: connection.topology,
      databaseIndex: connection.databaseIndex,
      username: connection.username,
      credentialId: connection.credentialId,
      environment: connection.environment,
      tls: { enabled: connection.tls.enabled, serverName: connection.tls.serverName },
      tagIds: [...connection.tagIds],
      relatedHostId: connection.relatedHostId,
      keyPrefixDescription: connection.keyPrefixDescription,
      description: connection.description,
      accessInstructions: connection.accessInstructions,
    })
  }
  return { databases, redisConnections }
}

function stageTags(document: ResourceDocument, snapshot: Omit<StagedContextSnapshot, 'tags'>) {
  const needed = new Set<string>()
  for (const source of snapshot.selection.sourceTags) needed.add(source.id)
  for (const host of snapshot.hosts) for (const id of host.tagIds) needed.add(id)
  for (const concept of snapshot.concepts) for (const id of concept.tagIds) needed.add(id)
  for (const connection of document.dataConnections) {
    if (
      snapshot.selection.databaseRefs.some(ref => ref.id === connection.id)
      || snapshot.selection.redisRefs.some(ref => ref.id === connection.id)
    ) {
      for (const id of connection.tagIds) needed.add(id)
    }
  }
  return document.tags
    .filter(tag => needed.has(tag.id))
    .map(tag => ({ id: tag.id, namespace: tag.namespace, name: tag.name }))
}

type DisclosedCredential = {
  credentialId: string
  kind: 'ssh-password' | 'application-password' | 'database-password' | 'redis-password'
  label: string
  password: string
}

const DISCLOSABLE_PASSWORD_KINDS = new Set<CredentialRecord['kind']>([
  'ssh-password',
  'application-password',
  'database-password',
  'redis-password',
])

function isDisclosablePasswordRecord(record: CredentialRecord): record is CredentialRecord & {
  kind: DisclosedCredential['kind']
} {
  return DISCLOSABLE_PASSWORD_KINDS.has(record.kind)
}

function credentialIdsReachableFromSelection(
  document: ResourceDocument,
  input: ManagedContextPrepareInput,
): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  const add = (id: string | null | undefined) => {
    if (!id || seen.has(id)) return
    seen.add(id)
    ids.push(id)
  }
  const selectedHostIds = new Set(input.selection.hostRefs.map(ref => ref.id))
  for (const host of document.hosts) {
    if (!selectedHostIds.has(host.id)) continue
    add(host.auth.credentialId)
    for (const application of host.applications) {
      for (const account of application.accounts) add(account.credentialId)
    }
  }
  const selectedConnectionIds = new Set([
    ...input.selection.databaseRefs.map(ref => ref.id),
    ...input.selection.redisRefs.map(ref => ref.id),
  ])
  for (const connection of document.dataConnections) {
    if (!selectedConnectionIds.has(connection.id)) continue
    add(connection.credentialId)
    add(connection.tls.clientKeyCredentialId)
  }
  return ids
}

function resolveCredentialSelection(
  document: ResourceDocument,
  input: ManagedContextPrepareInput,
): HostManagementResult<{ selection: ManagedContextPrepareInput['selection']; records: CredentialRecord[] }> {
  if (!input.selection.includePasswords) {
    if (input.selection.credentialRefs.length > 0) return failure('INVALID_CONTEXT_SELECTION')
    return { ok: true, data: { selection: input.selection, records: [] } }
  }

  const byId = new Map(document.credentials.map(record => [record.id, record]))
  const allowedIds = credentialIdsReachableFromSelection(document, input)
  const allowed = new Set(allowedIds)
  for (const supplied of input.selection.credentialRefs) {
    const record = byId.get(supplied.id)
    if (!allowed.has(supplied.id) || !record) return failure('INVALID_CONTEXT_SELECTION')
    if (record.revision !== supplied.revision) {
      return failure('CONTEXT_REVISION_CHANGED', {
        id: supplied.id,
        expectedRevision: supplied.revision,
        actualRevision: record.revision,
      })
    }
  }

  const records: CredentialRecord[] = []
  for (const id of allowedIds) {
    const record = byId.get(id)
    if (!record) return failure('CONTEXT_RESOURCE_MISSING', { id, kind: 'credential' })
    records.push(record)
  }
  return {
    ok: true,
    data: {
      selection: {
        ...input.selection,
        credentialRefs: records.map(record => ({ id: record.id, revision: record.revision })),
      },
      records,
    },
  }
}

function discloseCredentialRecords(
  records: CredentialRecord[],
  vault: CredentialVault | undefined,
): HostManagementResult<{ secrets: DisclosedCredential[]; secretFieldCount: number }> {
  // Private-key material (SSH PEM/passphrase and TLS client key) is connection-only.
  // Keep those records in credentialRefs for revision locking, but never decrypt or
  // serialize them into model knowledge.
  const passwordRecords = records.filter(isDisclosablePasswordRecord)
  if (passwordRecords.length === 0) {
    return { ok: true, data: { secrets: [], secretFieldCount: 0 } }
  }
  if (!vault || vault.initialize().status !== 'available') return failure('SECRET_VAULT_UNAVAILABLE')

  const secrets: DisclosedCredential[] = []
  for (const record of passwordRecords) {
    const revealed = vault.decrypt(record)
    if (revealed.status !== 'decrypted') return failure(revealed.code)
    const payload = revealed.payload
    if (!('password' in payload)) return failure('INVALID_CREDENTIAL_PAYLOAD')
    secrets.push({
      credentialId: record.id,
      kind: record.kind,
      label: record.label,
      password: payload.password,
    })
  }
  return { ok: true, data: { secrets, secretFieldCount: secrets.length } }
}

function mergeConnectionSecrets(
  snapshot: StagedContextSnapshot,
  publicModelContext: string,
  secrets: DisclosedCredential[],
): string {
  if (secrets.length === 0) return publicModelContext
  const payload = JSON.parse(publicModelContext) as {
    databases: Array<Record<string, unknown>>
    redisConnections: Array<Record<string, unknown>>
    [key: string]: unknown
  }
  const secretByCredentialId = new Map(secrets.map(secret => [secret.credentialId, secret]))
  const used = new Set<string>()
  const databaseById = new Map(snapshot.databases.map(connection => [connection.id, connection]))
  const redisById = new Map(snapshot.redisConnections.map(connection => [connection.id, connection]))

  payload.databases = payload.databases.map((item) => {
    const connection = databaseById.get(String(item.id ?? ''))
    const secret = connection?.credentialId ? secretByCredentialId.get(connection.credentialId) : undefined
    if (!secret || secret.kind !== 'database-password') return item
    used.add(secret.credentialId)
    return { ...item, password: secret.password }
  })
  payload.redisConnections = payload.redisConnections.map((item) => {
    const connection = redisById.get(String(item.id ?? ''))
    const secret = connection?.credentialId ? secretByCredentialId.get(connection.credentialId) : undefined
    if (!secret || secret.kind !== 'redis-password') return item
    used.add(secret.credentialId)
    return { ...item, password: secret.password }
  })

  const remainingSecrets = secrets.filter(secret => !used.has(secret.credentialId))
  return canonicalJson({
    managedResources: payload,
    ...(remainingSecrets.length > 0 ? { credentialSecrets: remainingSecrets } : {}),
  })
}

export async function prepareManagedContextStageRequest(
  store: ResourceDocumentStore,
  input: ManagedContextPrepareInput,
  vault?: CredentialVault,
): Promise<HostManagementResult<ManagedContextStageRequest>> {
  const loaded = await store.load()
  if (loaded.status !== 'ready') return failure('CONTEXT_STORE_UNAVAILABLE', { status: loaded.status })
  const document = loaded.document
  const credentialSelection = resolveCredentialSelection(document, input)
  if (!credentialSelection.ok) return credentialSelection
  const selection = credentialSelection.data.selection
  const disclosure = discloseCredentialRecords(credentialSelection.data.records, vault)
  if (!disclosure.ok) return disclosure

  const resolved = resolveContextSelection({
    conceptRoots: selection.conceptRootRefs,
    conceptDependencies: selection.dependencyRefs,
    hostIds: selection.hostRefs.map(ref => ref.id),
  }, document)
  if (!resolved.ok) return failure(resolved.error.code, resolved.error.params)

  const hostIds = selection.hostRefs.map(ref => ref.id)
  const conceptIds = resolved.concepts.map(concept => concept.id)
  const data = stagedDataConnections(document, input)
  const withoutTags: Omit<StagedContextSnapshot, 'tags'> = {
    selection,
    hosts: stagedHosts(document, hostIds),
    concepts: stagedConcepts(document, conceptIds),
    references: resolved.references.map(reference => ({ ...reference })),
    databases: data.databases,
    redisConnections: data.redisConnections,
    credentials: credentialSelection.data.records.map(record => ({
      id: record.id,
      revision: record.revision,
      kind: record.kind,
      label: record.label,
    })),
  }
  const snapshot: StagedContextSnapshot = {
    ...withoutTags,
    tags: stageTags(document, withoutTags),
  }

  try {
    const publicManifest = buildPublicContextManifest(snapshot, {
      requestId: input.requestId,
      resolvedAt: new Date().toISOString(),
      secretFieldCount: disclosure.data.secretFieldCount,
    })
    const publicModelContext = buildModelContext(snapshot)
    const modelContext = mergeConnectionSecrets(snapshot, publicModelContext, disclosure.data.secrets)
    return {
      ok: true,
      data: {
        schemaVersion: 1,
        sessionId: input.sessionId,
        requestId: input.requestId,
        runtimeRevision: input.runtimeRevision,
        contentBinding: sha256Hex(canonicalJson({
          content: input.content,
          attachments: input.attachments ?? [],
        })),
        contextBinding: contextBindingOf(publicManifest.selection),
        publicManifest,
        modelContext,
      },
    }
  } catch (error) {
    if (error instanceof ManagedContextError) return failure(error.code, error.details)
    return failure('INVALID_CONTEXT_SELECTION')
  }
}
