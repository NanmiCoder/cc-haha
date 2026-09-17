/**
 * Public context manifest builder (schema v2), M7.1.
 *
 * Input is a *staged* snapshot — the already resolved entities the caller
 * selected (hosts with their applications, concepts with their dependencies,
 * data connections, tags and credential *metadata*). Output is exactly the
 * `PublicContextManifestV2` shape pinned by
 * `fixtures/managed-resources/contract-v2.fixture.json`, in selection order.
 *
 * Guarantees:
 * - `includePasswords: true` returns `SECRET_DISCLOSURE_NOT_READY` and never
 *   touches the vault gateway (M7 ships no disclosure path);
 * - the manifest contains no password/private key/passphrase/vault handle and
 *   no local absolute path — both are verified by a scan of the built output,
 *   not only by the type;
 * - serialization is deterministic (§8.1 canonical serializer).
 */

import { ManagedContextError, type ManagedContextErrorCode } from './errors.js'
import { canonicalJson } from './canonicalSerializer.js'
import { findAbsolutePath, findSecretMaterial } from './secrets.js'
import type {
  ConversationContextSelectionV2,
  EntityVersionRef,
  PublicContextManifestV2,
  TagNamespace,
} from './types.js'

/** §7.1 limits. Per-selection entity caps mirror the v2 contract fixture. */
export const CONTEXT_HOST_LIMIT = 20
export const CONTEXT_CONCEPT_LIMIT = 100
export const CONTEXT_DATABASE_LIMIT = 20
export const CONTEXT_REDIS_LIMIT = 20
/** Total prompt-context ceiling: UTF-8 bytes, not "tokens". */
export const CONTEXT_PROMPT_CONTEXT_BYTES_LIMIT = 64 * 1024

/** The only fields a staged credential entry may carry — never material. */
const CREDENTIAL_METADATA_KEYS: ReadonlySet<string> = new Set([
  'id',
  'revision',
  'kind',
  'label',
])

export type StagedTag = {
  id: string
  namespace: TagNamespace
  name: string
}

/** Metadata only — the staged snapshot never carries ciphertext or plaintext. */
export type StagedCredentialMetadata = {
  id: string
  revision: number
  kind: string
  label: string
}

export type StagedHostApplicationAccount = {
  username: string
  credentialId: string | null
}

export type StagedHostApplication = {
  name: string
  version: string | null
  installPaths: string[]
  accessDescription: string
  accessUrls: string[]
  loginUrl: string | null
  accounts: StagedHostApplicationAccount[]
  notes: string
}

export type StagedHost = {
  id: string
  revision: number
  name: string
  address: string
  port: number
  username: string
  tagIds: string[]
  applications: StagedHostApplication[]
  notes: string
}

export type StagedConcept = {
  id: string
  revision: number
  title: string
  bodyMarkdown: string
  dependsOnIds: string[]
  referenceIds: string[]
  tagIds: string[]
}

export type StagedReference = {
  id: string
  title: string
}

export type StagedDatabase = {
  id: string
  revision: number
  name: string
  engine: 'mysql' | 'mariadb' | 'postgresql'
  address: string
  port: number
  username: string | null
  /** Internal binding metadata; omitted from model/public projections. */
  credentialId: string | null
  database: string
  schema: string | null
  environment: 'development' | 'test' | 'staging' | 'production' | 'unspecified'
  tls: { enabled: boolean; serverName: string | null }
  tagIds: string[]
  relatedHostId: string | null
  description: string
  accessInstructions: string
}

export type StagedRedisConnection = {
  id: string
  revision: number
  name: string
  address: string
  port: number
  topology: 'standalone'
  databaseIndex: number
  username: string | null
  /** Internal binding metadata; omitted from model/public projections. */
  credentialId: string | null
  environment: 'development' | 'test' | 'staging' | 'production' | 'unspecified'
  tls: { enabled: boolean; serverName: string | null }
  tagIds: string[]
  relatedHostId: string | null
  keyPrefixDescription: string
  description: string
  accessInstructions: string
}

export type StagedContextSnapshot = {
  selection: ConversationContextSelectionV2
  tags: StagedTag[]
  hosts: StagedHost[]
  concepts: StagedConcept[]
  references: StagedReference[]
  databases: StagedDatabase[]
  redisConnections: StagedRedisConnection[]
  credentials: StagedCredentialMetadata[]
}

export type BuildPublicContextManifestOptions = {
  requestId: string
  resolvedAt: string
  /** Count only; secret values never enter the public manifest. */
  secretFieldCount?: number
}

function fail(
  code: ManagedContextErrorCode,
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new ManagedContextError(code, message, details)
}

function indexById<T extends { id: string }>(items: T[]): Map<string, T> {
  const map = new Map<string, T>()
  for (const item of items) {
    if (map.has(item.id)) {
      fail('INVALID_CONTEXT_SELECTION', `Duplicate staged entity id ${item.id}`)
    }
    map.set(item.id, item)
  }
  return map
}

function resolveRef<T extends { id: string; revision: number }>(
  map: Map<string, T>,
  ref: EntityVersionRef,
  label: string,
): T {
  const entity = map.get(ref.id)
  if (!entity) {
    fail('CONTEXT_RESOURCE_MISSING', `${label} ${ref.id} is not in the staged snapshot`, {
      id: ref.id,
      label,
    })
  }
  if (entity.revision !== ref.revision) {
    fail(
      'CONTEXT_REVISION_CHANGED',
      `${label} ${ref.id} revision ${ref.revision} does not match staged revision ${entity.revision}`,
      { id: ref.id, label, selectedRevision: ref.revision, stagedRevision: entity.revision },
    )
  }
  return entity
}

function assertRefLimit(refs: EntityVersionRef[], limit: number, label: string): void {
  if (refs.length > limit) {
    fail('INVALID_CONTEXT_SELECTION', `${label} exceeds the ${limit}-entity limit`, {
      count: refs.length,
      limit,
    })
  }
}

/** Non-secret payload that would be injected for this selection (§7.2). */
function injectablePayload(snapshot: StagedContextSnapshot): unknown {
  const tagNameById = new Map(snapshot.tags.map((tag) => [tag.id, tag.name]))
  const hostOrder = snapshot.selection.hostRefs.map((ref) => ref.id)
  const hostById = indexById(snapshot.hosts)
  return {
    hosts: hostOrder.map((id) => {
      const host = hostById.get(id)
      if (!host) return { id }
      return {
        id: host.id,
        name: host.name,
        address: host.address,
        port: host.port,
        username: host.username,
        tags: host.tagIds.map((tagId) => tagNameById.get(tagId) ?? null),
        applications: host.applications.map((application) => ({
          name: application.name,
          version: application.version,
          installPaths: application.installPaths,
          accessDescription: application.accessDescription,
          accessUrls: application.accessUrls,
          loginUrl: application.loginUrl,
          accountUsernames: application.accounts.map((account) => account.username),
          notes: application.notes,
        })),
        notes: host.notes,
      }
    }),
    concepts: snapshot.concepts.map((concept) => ({
      id: concept.id,
      title: concept.title,
      bodyMarkdown: concept.bodyMarkdown,
    })),
    references: snapshot.references.map((reference) => ({
      id: reference.id,
      title: reference.title,
    })),
    databases: snapshot.databases.map((connection) => ({
      id: connection.id,
      name: connection.name,
      engine: connection.engine,
      address: connection.address,
      port: connection.port,
      username: connection.username,
      database: connection.database,
      schema: connection.schema,
      environment: connection.environment,
      tls: { ...connection.tls },
      tags: connection.tagIds.map((tagId) => tagNameById.get(tagId) ?? null),
      relatedHostId: connection.relatedHostId,
      description: connection.description,
      accessInstructions: connection.accessInstructions,
    })),
    redisConnections: snapshot.redisConnections.map((connection) => ({
      id: connection.id,
      name: connection.name,
      address: connection.address,
      port: connection.port,
      topology: connection.topology,
      databaseIndex: connection.databaseIndex,
      username: connection.username,
      environment: connection.environment,
      tls: { ...connection.tls },
      tags: connection.tagIds.map((tagId) => tagNameById.get(tagId) ?? null),
      relatedHostId: connection.relatedHostId,
      keyPrefixDescription: connection.keyPrefixDescription,
      description: connection.description,
      accessInstructions: connection.accessInstructions,
    })),
  }
}

/** Deterministic non-secret context text sent to ConversationService. */
export function buildModelContext(snapshot: StagedContextSnapshot): string {
  return canonicalJson(injectablePayload(snapshot))
}

/** Approximate token estimate over the injectable payload (bytes/4, rounded up). */
export function estimateContextTokens(snapshot: StagedContextSnapshot): number {
  const bytes = Buffer.byteLength(canonicalJson(injectablePayload(snapshot)), 'utf8')
  return Math.ceil(bytes / 4)
}

/** UTF-8 size of the non-secret injectable payload — the authoritative limit. */
export function measureInjectableContextBytes(snapshot: StagedContextSnapshot): number {
  return Buffer.byteLength(canonicalJson(injectablePayload(snapshot)), 'utf8')
}

/** Reject a manifest that carries secret material or a local absolute path. */
export function assertPublicManifestSafe(manifest: PublicContextManifestV2): void {
  const secret = findSecretMaterial(manifest, '$manifest')
  if (secret) {
    fail('CONTEXT_SECRET_DETECTED', secret.reason, { path: secret.path })
  }
  const absolute = findAbsolutePath(manifest, '$manifest')
  if (absolute) {
    fail('CONTEXT_ABSOLUTE_PATH_DETECTED', absolute.reason, { path: absolute.path })
  }
}

export function buildPublicContextManifest(
  snapshot: StagedContextSnapshot,
  options: BuildPublicContextManifestOptions,
): PublicContextManifestV2 {
  const { selection } = snapshot

  if (selection.schemaVersion !== 2) {
    fail('INVALID_CONTEXT_SELECTION', 'Selection schemaVersion must be 2', {
      schemaVersion: selection.schemaVersion,
    })
  }

  if (!selection.includePasswords && selection.credentialRefs.length > 0) {
    fail(
      'INVALID_CONTEXT_SELECTION',
      'credentialRefs must be empty when includePasswords is false',
      { count: selection.credentialRefs.length },
    )
  }

  // The staged credential metadata must be metadata only. The shared scanner
  // matches key *suffixes*, so `ciphertextBase64` (the vault record's own field
  // name) would slip through an endsWith() rule; an allow-list closes that.
  const credentialSecret = findSecretMaterial(snapshot.credentials, '$credentials')
  if (credentialSecret) {
    fail('CONTEXT_SECRET_DETECTED', credentialSecret.reason, { path: credentialSecret.path })
  }
  for (const credential of snapshot.credentials) {
    for (const key of Object.keys(credential)) {
      if (!CREDENTIAL_METADATA_KEYS.has(key)) {
        fail(
          'CONTEXT_SECRET_DETECTED',
          `Staged credential metadata may only carry ${[...CREDENTIAL_METADATA_KEYS].join(', ')}`,
          { path: `$credentials.${key}` },
        )
      }
    }
  }
  indexById(snapshot.credentials)
  const credentialById = indexById(snapshot.credentials)
  for (const ref of selection.credentialRefs) resolveRef(credentialById, ref, 'Credential')

  assertRefLimit(selection.hostRefs, CONTEXT_HOST_LIMIT, 'hostRefs')
  assertRefLimit(selection.conceptRootRefs, CONTEXT_CONCEPT_LIMIT, 'conceptRootRefs')
  assertRefLimit(selection.dependencyRefs, CONTEXT_CONCEPT_LIMIT, 'dependencyRefs')
  assertRefLimit(selection.databaseRefs, CONTEXT_DATABASE_LIMIT, 'databaseRefs')
  assertRefLimit(selection.redisRefs, CONTEXT_REDIS_LIMIT, 'redisRefs')

  const hostById = indexById(snapshot.hosts)
  const conceptById = indexById(snapshot.concepts)
  const databaseById = indexById(snapshot.databases)
  const redisById = indexById(snapshot.redisConnections)
  const tagById = indexById(snapshot.tags)

  const hosts = selection.hostRefs.map((ref) => {
    const host = resolveRef(hostById, ref, 'Host')
    return { id: host.id, name: host.name, address: host.address, port: host.port }
  })

  for (const concept of snapshot.concepts) {
    for (const dependencyId of concept.dependsOnIds) {
      if (!conceptById.has(dependencyId)) {
        fail(
          'CONTEXT_RESOURCE_MISSING',
          `Concept ${concept.id} depends on ${dependencyId}, which is not in the staged snapshot`,
          { id: dependencyId, label: 'ConceptDependency' },
        )
      }
    }
  }

  // Roots first in selection order, then dependencies in selection order; a
  // concept reached both ways stays in the root slot (root wins, §7.1). The
  // dependency-before-root injection order lives in the model content, not in
  // this display list.
  const conceptEntries: { id: string; includedAs: 'root' | 'dependency' }[] = []
  const addedConcepts = new Set<string>()
  for (const ref of selection.conceptRootRefs) {
    resolveRef(conceptById, ref, 'ConceptRoot')
    if (addedConcepts.has(ref.id)) continue
    addedConcepts.add(ref.id)
    conceptEntries.push({ id: ref.id, includedAs: 'root' })
  }
  for (const ref of selection.dependencyRefs) {
    resolveRef(conceptById, ref, 'ConceptDependency')
    if (addedConcepts.has(ref.id)) continue
    addedConcepts.add(ref.id)
    conceptEntries.push({ id: ref.id, includedAs: 'dependency' })
  }
  // §7.1 caps the *expanded* closure at 100 concepts, so roots and dependencies
  // share one budget. The two ref-list checks above are per-list; without this
  // one, two 100-ref lists could stage a 200-concept manifest.
  if (conceptEntries.length > CONTEXT_CONCEPT_LIMIT) {
    fail(
      'INVALID_CONTEXT_SELECTION',
      `conceptRootRefs and dependencyRefs expand to ${conceptEntries.length} concepts, above the ${CONTEXT_CONCEPT_LIMIT}-concept limit`,
      { count: conceptEntries.length, limit: CONTEXT_CONCEPT_LIMIT },
    )
  }
  const concepts = conceptEntries.map(({ id, includedAs }) => ({
    id,
    title: conceptById.get(id)!.title,
    includedAs,
  }))

  const databases = selection.databaseRefs.map((ref) => {
    const connection = resolveRef(databaseById, ref, 'Database')
    return {
      id: connection.id,
      name: connection.name,
      engine: connection.engine,
      address: connection.address,
      port: connection.port,
      database: connection.database,
      schema: connection.schema,
    }
  })

  const redisConnections = selection.redisRefs.map((ref) => {
    const connection = resolveRef(redisById, ref, 'RedisConnection')
    return {
      id: connection.id,
      name: connection.name,
      address: connection.address,
      port: connection.port,
      topology: 'standalone' as const,
      databaseIndex: connection.databaseIndex,
    }
  })

  for (const sourceTag of selection.sourceTags) {
    const tag = tagById.get(sourceTag.id)
    if (!tag || tag.namespace !== sourceTag.namespace) {
      fail(
        'CONTEXT_RESOURCE_MISSING',
        `Source tag ${sourceTag.namespace}/${sourceTag.id} is not in the staged snapshot`,
        { id: sourceTag.id, namespace: sourceTag.namespace },
      )
    }
  }

  const injectableBytes = measureInjectableContextBytes(snapshot)
  if (injectableBytes > CONTEXT_PROMPT_CONTEXT_BYTES_LIMIT) {
    fail(
      'CONTEXT_TOO_LARGE',
      `Selected context is ${injectableBytes} bytes, above the ${CONTEXT_PROMPT_CONTEXT_BYTES_LIMIT}-byte prompt-context limit`,
      { bytes: injectableBytes, limit: CONTEXT_PROMPT_CONTEXT_BYTES_LIMIT },
    )
  }

  const secretFieldCount = options.secretFieldCount ?? 0
  if (!selection.includePasswords && secretFieldCount > 0) {
    fail('INVALID_CONTEXT_SELECTION', 'secretFieldCount requires includePasswords=true')
  }
  if (secretFieldCount > 0 && selection.credentialRefs.length === 0) {
    fail('INVALID_CONTEXT_SELECTION', 'secret-bearing context requires credentialRefs')
  }

  const manifest: PublicContextManifestV2 = {
    schemaVersion: 2,
    requestId: options.requestId,
    selection,
    hosts,
    concepts,
    databases,
    redisConnections,
    resolvedAt: options.resolvedAt,
    containsSecrets: secretFieldCount > 0,
    secretFieldCount,
    estimatedTokens: Math.ceil(injectableBytes / 4),
  }

  assertPublicManifestSafe(manifest)
  return manifest
}
