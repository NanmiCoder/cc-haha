/**
 * Shared harness for the M7-A managed-context tests.
 *
 * The staged snapshot and the staging request are derived from the repository's
 * pinned contract fixture, so the tests fail if the route drifts from
 * `fixtures/managed-resources/contract-v2.fixture.json` rather than from a
 * hand-written local shape.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { contextBindingOf } from '../../../../services/managedContext/canonicalSerializer.js'
import type { StagedContextSnapshot } from '../../../../services/managedContext/manifest.js'
import type {
  ConversationContextSelectionV2,
  PublicContextManifestV2,
  StageContextRequest,
  TagNamespace,
} from '../../../../services/managedContext/types.js'
import { createUnreachableVaultGateway, type SecretRevealGateway } from '../../../../services/managedContext/vaultGateway.js'
import type { ManagedContextApiDeps } from '../api.js'
import type { ManagedContextSessionGate, StageSessionResolution } from '../sessionGate.js'
import { ContextTicketStore } from '../ticketStore.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..')
export const CONTRACT_FIXTURE_PATH = resolve(
  REPO_ROOT,
  'fixtures',
  'managed-resources',
  'contract-v2.fixture.json',
)

export const LOCAL_ACCESS_TOKEN_ENV = 'CC_HAHA_LOCAL_ACCESS_TOKEN'
export const TEST_LOCAL_TOKEN = 'test-only-local-access-token'
export const TEST_PEER = '127.0.0.1'
export const TEST_ORIGIN = 'http://127.0.0.1:3456'

/** Minimal shape of the pinned fixture — no production schema is imported. */
export type ContractFixture = {
  fixtureVersion: number
  resourceDocument: {
    tags: Array<{ id: string; namespace: TagNamespace; name: string }>
    hosts: Array<{
      id: string
      revision: number
      name: string
      address: string
      port: number
      username: string
      tagIds: string[]
      initialDirectory: string | null
      applications: Array<{
        name: string
        version: string | null
        installPaths: string[]
        accessDescription: string
        accessUrls: string[]
        loginUrl: string | null
        accounts: Array<{ username: string; credentialId: string | null }>
        notes: string
      }>
      notes: string
    }>
    concepts: Array<{
      id: string
      revision: number
      title: string
      bodyMarkdown: string
      tagIds: string[]
      dependsOnIds: string[]
      referenceIds: string[]
    }>
    dataConnections: Array<Record<string, unknown> & { id: string; revision: number; kind: string }>
    credentials: Array<{ id: string; revision: number; kind: string; label: string }>
  }
  selection: ConversationContextSelectionV2
  publicManifest: PublicContextManifestV2
  ticketWire: { stageContextRequest: StageContextRequest }
}

export function loadContractFixture(): ContractFixture {
  return JSON.parse(readFileSync(CONTRACT_FIXTURE_PATH, 'utf8')) as ContractFixture
}

export function cloneFixture<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function snapshotFromFixture(fixture: ContractFixture): StagedContextSnapshot {
  const doc = fixture.resourceDocument
  return {
    selection: fixture.publicManifest.selection,
    tags: doc.tags.map((tag) => ({ id: tag.id, namespace: tag.namespace, name: tag.name })),
    hosts: doc.hosts.map((host) => ({
      id: host.id,
      revision: host.revision,
      name: host.name,
      address: host.address,
      port: host.port,
      username: host.username,
      tagIds: host.tagIds,
      applications: host.applications.map((application) => ({
        name: application.name,
        version: application.version,
        installPaths: application.installPaths,
        accessDescription: application.accessDescription,
        accessUrls: application.accessUrls,
        loginUrl: application.loginUrl,
        accounts: application.accounts.map((account) => ({
          username: account.username,
          credentialId: account.credentialId,
        })),
        notes: application.notes,
      })),
      notes: host.notes,
    })),
    concepts: doc.concepts.map((concept) => ({
      id: concept.id,
      revision: concept.revision,
      title: concept.title,
      bodyMarkdown: concept.bodyMarkdown,
      dependsOnIds: concept.dependsOnIds,
      referenceIds: concept.referenceIds,
      tagIds: concept.tagIds,
    })),
    references: [...new Set(doc.concepts.flatMap(concept => concept.referenceIds))].map((id) => ({
      id,
      title: doc.concepts.find(concept => concept.id === id)?.title ?? id,
    })),
    databases: doc.dataConnections
      .filter((connection) => connection.kind === 'database')
      .map((connection) => ({
        id: connection.id,
        revision: connection.revision,
        name: connection.name as string,
        engine: connection.engine as 'mysql' | 'mariadb' | 'postgresql',
        address: connection.address as string,
        port: connection.port as number,
        username: connection.username as string | null,
        credentialId: connection.credentialId as string | null,
        database: connection.database as string,
        schema: connection.schema as string | null,
        environment: connection.environment as 'development' | 'test' | 'staging' | 'production' | 'unspecified',
        tls: {
          enabled: (connection.tls as { enabled: boolean }).enabled,
          serverName: (connection.tls as { serverName: string | null }).serverName,
        },
        tagIds: connection.tagIds as string[],
        relatedHostId: connection.relatedHostId as string | null,
        description: connection.description as string,
        accessInstructions: connection.accessInstructions as string,
      })),
    redisConnections: doc.dataConnections
      .filter((connection) => connection.kind === 'redis')
      .map((connection) => ({
        id: connection.id,
        revision: connection.revision,
        name: connection.name as string,
        address: connection.address as string,
        port: connection.port as number,
        topology: 'standalone' as const,
        databaseIndex: connection.databaseIndex as number,
        username: connection.username as string | null,
        credentialId: connection.credentialId as string | null,
        environment: connection.environment as 'development' | 'test' | 'staging' | 'production' | 'unspecified',
        tls: {
          enabled: (connection.tls as { enabled: boolean }).enabled,
          serverName: (connection.tls as { serverName: string | null }).serverName,
        },
        tagIds: connection.tagIds as string[],
        relatedHostId: connection.relatedHostId as string | null,
        keyPrefixDescription: connection.keyPrefixDescription as string,
        description: connection.description as string,
        accessInstructions: connection.accessInstructions as string,
      })),
    credentials: doc.credentials.map((credential) => ({
      id: credential.id,
      revision: credential.revision,
      kind: credential.kind,
      label: credential.label,
    })),
  }
}

/**
 * The pinned stage request with a real contextBinding: the fixture pins the
 * binding field as all-zero placeholder, and the route re-derives it from the
 * submitted selection, so the request must carry the derived digest.
 */
export function stageRequestBody(fixture: ContractFixture): StageContextRequest {
  const body = cloneFixture(fixture.ticketWire.stageContextRequest)
  body.publicManifest = cloneFixture(fixture.publicManifest)
  body.contextBinding = contextBindingOf(body.publicManifest.selection)
  return body
}

export type SpyVault = {
  calls: { availability: number; reveal: number }
  gateway: SecretRevealGateway
}

export function createSpyVault(
  availability: 'available' | 'unavailable' = 'unavailable',
): SpyVault {
  const calls = { availability: 0, reveal: 0 }
  return {
    calls,
    gateway: {
      availability() {
        calls.availability += 1
        return availability
      },
      reveal(credentialId: string) {
        calls.reveal += 1
        throw new Error(`reveal must not be called (${credentialId})`)
      },
    },
  }
}

/** Session gate stub: ids absent from `revisions` do not exist on the server. */
export function createStubSessionGate(
  revisions: Record<string, number | null>,
): ManagedContextSessionGate & { resolved: Array<{ sessionId: string; runtimeRevision: number }> } {
  const resolved: Array<{ sessionId: string; runtimeRevision: number }> = []
  return {
    resolved,
    async resolve({ sessionId, runtimeRevision }): Promise<StageSessionResolution> {
      resolved.push({ sessionId, runtimeRevision })
      if (!(sessionId in revisions)) return { ok: false, code: 'SESSION_NOT_FOUND' }
      const current = revisions[sessionId] ?? null
      if (current === null) return { ok: false, code: 'RUNTIME_REVISION_UNAVAILABLE' }
      if (current !== runtimeRevision) return { ok: false, code: 'RUNTIME_REVISION_MISMATCH' }
      return { ok: true, runtimeRevision: current }
    },
  }
}

export type TestDepsOptions = {
  now?: () => number
  sessions?: ManagedContextSessionGate
  vault?: SecretRevealGateway
  allowSecretDisclosure?: boolean
}

export function createTestDeps(options: TestDepsOptions = {}): ManagedContextApiDeps {
  return {
    store: new ContextTicketStore({
      now: options.now,
      sidecarInstanceId: '80000000-0000-4000-8000-000000000001',
    }),
    sessions: options.sessions ?? createStubSessionGate({}),
    vault: options.vault ?? createUnreachableVaultGateway(),
    allowSecretDisclosure: options.allowSecretDisclosure ?? false,
  }
}
