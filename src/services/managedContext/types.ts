/**
 * Managed-context contract types (M7).
 *
 * These mirror the renderer-facing contract pinned by
 * `fixtures/managed-resources/contract-v2.fixture.json` and
 * `desktop/src/features/managed-resources/types/resourceTypes.ts`. The server
 * keeps its own copy because `src/**` must not import desktop renderer modules
 * at runtime; `src/server/__tests__/managedResourcesContractFixture.test.ts`
 * plus the managed-context tests are what keep the two copies equal.
 *
 * `PublicContextManifestV2` never contains a password, private key,
 * passphrase, vault handle, temporary credential or local absolute path.
 */

export type Id = string
export type Iso8601Utc = string

export type EntityVersionRef = {
  id: Id
  revision: number
}

export type TagNamespace = 'host' | 'database' | 'redis' | 'concept'

export type SourceTag = {
  namespace: TagNamespace
  id: Id
  labelAtSelection: string
  memberIds: Id[]
}

export type ConversationContextSelectionV2 = {
  schemaVersion: 2
  hostRefs: EntityVersionRef[]
  conceptRootRefs: EntityVersionRef[]
  dependencyRefs: EntityVersionRef[]
  databaseRefs: EntityVersionRef[]
  redisRefs: EntityVersionRef[]
  credentialRefs: EntityVersionRef[]
  sourceTags: SourceTag[]
  directHostIds: Id[]
  directConceptIds: Id[]
  directDatabaseIds: Id[]
  directRedisIds: Id[]
  includePasswords: boolean
}

export type PublicDatabaseSummary = {
  id: Id
  name: string
  engine: 'mysql' | 'mariadb' | 'postgresql'
  address: string
  port: number
  database: string
  schema: string | null
}

export type PublicRedisSummary = {
  id: Id
  name: string
  address: string
  port: number
  topology: 'standalone'
  databaseIndex: number
}

export type PublicContextManifestV2 = {
  schemaVersion: 2
  requestId: Id
  selection: ConversationContextSelectionV2
  hosts: { id: Id; name: string; address: string; port: number }[]
  concepts: {
    id: Id
    title: string
    includedAs: 'root' | 'dependency'
  }[]
  databases: PublicDatabaseSummary[]
  redisConnections: PublicRedisSummary[]
  resolvedAt: Iso8601Utc
  containsSecrets: boolean
  secretFieldCount: number
  estimatedTokens: number
}

/** Staging protocol version; the embedded resources/selection/manifest are v2. */
export type StageContextRequest = {
  schemaVersion: 1
  sessionId: string
  requestId: string
  runtimeRevision: number
  contentBinding: string
  contextBinding: string
  publicManifest: PublicContextManifestV2
  /** main -> sidecar only; never logged, never returned. */
  modelContext: string
}

export type ContextTicket = {
  ticketId: string
  sidecarInstanceId: string
  expiresAt: Iso8601Utc
  publicManifest: PublicContextManifestV2
}
