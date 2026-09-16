import type { DataConnection } from '../../../../src/features/managed-resources/types/dataConnectionTypes.js'
import type {
  Concept,
  Host,
  HostApplication,
  HostApplicationAccount,
  ResourceDocument,
  ResourceTag,
  TagNamespace,
} from '../../../../src/features/managed-resources/types/resourceTypes.js'
import { wouldCreateCycle } from '../conceptDependencyService.js'
import {
  ConceptSchema,
  DataConnectionSchema,
  HostSchema,
  HostApplicationSchema,
  ResourceTagSchema,
} from '../../../../src/features/managed-resources/types/resourceSchemas.js'
import {
  findResourceReferences,
  normalizeResourceTagName,
  validateResourceDocumentIntegrity,
  type ResourceIntegrityIssue,
  type ResourceReference,
} from './resourceDocumentIntegrity.js'
import type { ResourceDocumentStore } from './resourceDocumentStore.js'
import type { AccountPasswordWrite, HostCredentialWrite } from '../../../../src/features/managed-resources/api/credentialMutationContract.js'
import {
  applyHostCredential, createBoundCredential, CredentialMutationError,
  hostCredentialIds, removeNewlyUnreferencedCredentials,
  type CredentialMutationDependencies,
} from './credentialMutation.js'

export type ResourceCommandCode =
  | 'VAULT_UNAVAILABLE'
  | 'INVALID_CREDENTIAL_PAYLOAD'
  | 'INVALID_TEMPORARY_CREDENTIAL'
  | 'NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'RESOURCE_IN_USE'
  | 'VALIDATION_FAILED'
  | 'READ_ONLY'
  | 'WRITE_FAILED'
  | 'DEPENDENCY_CYCLE'

export type ResourceValidationIssue = ResourceIntegrityIssue | {
  code: 'SCHEMA_INVALID'
  path: string
}

export type ResourceCommandResult<T> =
  | { status: 'created' | 'updated' | 'deleted'; value: T; documentRevision: number }
  | {
      status: 'rejected'
      code: ResourceCommandCode
      resourceType?: 'tag' | 'host' | 'concept' | 'dataConnection'
      id?: string
      expectedRevision?: number
      actualRevision?: number
      references?: ResourceReference[]
      issues?: ResourceValidationIssue[]
      cycle?: string[]
    }

export type CreateTagInput = {
  namespace: TagNamespace
  name: string
  colorToken: string | null
}

export type CreateApplicationInput = Omit<HostApplication, 'id' | 'accounts'> & {
  accounts: (Omit<HostApplicationAccount, 'id'> & AccountPasswordWrite)[]
}

export type CreateHostInput = Omit<Host, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'applications'> & {
  credential?: HostCredentialWrite
  applications: CreateApplicationInput[]
}

export type UpdateHostInput = {
  credential?: HostCredentialWrite
  id: string
  expectedRevision: number
  changes: Partial<Omit<Host, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'applications'>>
}

export type CreateConceptInput = Omit<Concept, 'id' | 'revision' | 'createdAt' | 'updatedAt'>
export type UpdateConceptInput = {
  id: string
  expectedRevision: number
  changes: Partial<Omit<Concept, 'id' | 'revision' | 'createdAt' | 'updatedAt'>>
}

type WithoutEntityMeta<T> = T extends unknown
  ? Omit<T, 'id' | 'revision' | 'createdAt' | 'updatedAt'>
  : never

export type DataConnectionPasswordWrite = { password?: string }
export type CreateDataConnectionInput = WithoutEntityMeta<DataConnection> & DataConnectionPasswordWrite
export type UpdateDataConnectionInput = {
  id: string
  expectedRevision: number
  changes: Partial<WithoutEntityMeta<DataConnection>> & DataConnectionPasswordWrite
}

export type ResourceLibraryServiceOptions = CredentialMutationDependencies & {
  store: ResourceDocumentStore
  now?: () => string
  createId?: () => string
}

export type ResourceLibraryService = {
  createTag(input: CreateTagInput): Promise<ResourceCommandResult<ResourceTag>>
  updateTag(input: { id: string; expectedRevision: number; name: string; colorToken: string | null }): Promise<ResourceCommandResult<ResourceTag>>
  deleteTag(input: { id: string; expectedRevision: number }): Promise<ResourceCommandResult<{ id: string }>>
  createHost(input: CreateHostInput): Promise<ResourceCommandResult<Host>>
  updateHost(input: UpdateHostInput): Promise<ResourceCommandResult<Host>>
  deleteHost(input: { id: string; expectedRevision: number }): Promise<ResourceCommandResult<{ id: string }>>
  createApplication(input: { hostId: string; expectedHostRevision: number; application: CreateApplicationInput }): Promise<ResourceCommandResult<Host>>
  updateApplication(input: { hostId: string; expectedHostRevision: number; applicationId: string; changes: Partial<Omit<HostApplication, 'id' | 'accounts'>> & { accounts?: (HostApplicationAccount & AccountPasswordWrite)[] } }): Promise<ResourceCommandResult<Host>>
  deleteApplication(input: { hostId: string; expectedHostRevision: number; applicationId: string }): Promise<ResourceCommandResult<Host>>
  createConcept(input: CreateConceptInput): Promise<ResourceCommandResult<Concept>>
  updateConcept(input: UpdateConceptInput): Promise<ResourceCommandResult<Concept>>
  deleteConcept(input: { id: string; expectedRevision: number; removeReferenceEdges?: boolean }): Promise<ResourceCommandResult<{ id: string }>>
  createDataConnection(input: CreateDataConnectionInput): Promise<ResourceCommandResult<DataConnection>>
  updateDataConnection(input: UpdateDataConnectionInput): Promise<ResourceCommandResult<DataConnection>>
  deleteDataConnection(input: { id: string; expectedRevision: number }): Promise<ResourceCommandResult<{ id: string }>>
}

type DraftAccepted<T> = { accepted: true; status: 'created' | 'updated' | 'deleted'; value: T }
type DraftRejected = Extract<ResourceCommandResult<never>, { status: 'rejected' }>
type DraftOutcome<T> = DraftAccepted<T> | DraftRejected

function rejected(
  code: ResourceCommandCode,
  extra: Omit<DraftRejected, 'status' | 'code'> = {},
): DraftRejected {
  return { status: 'rejected', code, ...extra }
}

function accepted<T>(status: DraftAccepted<T>['status'], value: T): DraftAccepted<T> {
  return { accepted: true, status, value }
}

function schemaIssue(): ResourceValidationIssue[] {
  return [{ code: 'SCHEMA_INVALID', path: '' }]
}

function hasExpectedRevision(
  entity: { revision: number } | undefined,
  resourceType: DraftRejected['resourceType'],
  id: string,
  expectedRevision: number,
): DraftRejected | null {
  if (!entity) return rejected('NOT_FOUND', { resourceType, id })
  if (entity.revision !== expectedRevision) {
    return rejected('REVISION_CONFLICT', {
      resourceType,
      id,
      expectedRevision,
      actualRevision: entity.revision,
    })
  }
  return null
}

function updated<T extends { revision: number; updatedAt: string }>(entity: T, now: string): T {
  return { ...entity, revision: entity.revision + 1, updatedAt: now }
}

export function createResourceLibraryService(
  options: ResourceLibraryServiceOptions,
): ResourceLibraryService {
  if (!options || typeof options !== 'object' || !options.store) {
    throw new TypeError('store is required')
  }
  if (options.now !== undefined && typeof options.now !== 'function') throw new TypeError('now must be a function')
  if (options.createId !== undefined && typeof options.createId !== 'function') {
    throw new TypeError('createId must be a function')
  }
  const now = options.now ?? (() => new Date().toISOString())
  const createId = options.createId ?? (() => crypto.randomUUID())

  function accountFromInput(draft: ResourceDocument, input: Omit<HostApplicationAccount, 'id'> & AccountPasswordWrite & { id?: string }): HostApplicationAccount {
    const { password, ...account } = input
    const credentialId = password === undefined
      ? account.credentialId
      : createBoundCredential(draft, options.vault, 'application-password', { kind: 'application-password', password }, account.label)
    return { ...account, id: account.id ?? createId(), credentialId }
  }

  function applicationFromInput(draft: ResourceDocument, input: CreateApplicationInput): HostApplication {
    return { ...input, id: createId(), accounts: input.accounts.map(account => accountFromInput(draft, account)) }
  }

  async function execute<T>(
    operation: (draft: ResourceDocument, afterCommit: Array<() => void>) => DraftOutcome<T>,
  ): Promise<ResourceCommandResult<T>> {
    const afterCommit: Array<() => void> = []
    const result = await options.store.transact<DraftOutcome<T>>({
      mutate: draft => {
        const currentIssues = validateResourceDocumentIntegrity(draft)
        if (currentIssues.length > 0) {
          return { commit: false as const, value: rejected('VALIDATION_FAILED', { issues: currentIssues }) }
        }
        const previousCredentials = hostCredentialIds(draft)
        let outcome: DraftOutcome<T>
        try {
          outcome = operation(draft, afterCommit)
        } catch (error) {
          if (error instanceof CredentialMutationError) return { commit: false as const, value: rejected(error.code) }
          throw error
        }
        if (!('accepted' in outcome)) return { commit: false as const, value: outcome }
        removeNewlyUnreferencedCredentials(draft, previousCredentials)
        const issues = validateResourceDocumentIntegrity(draft)
        if (issues.length > 0) {
          return { commit: false as const, value: rejected('VALIDATION_FAILED', { issues }) }
        }
        return { commit: true as const, value: outcome }
      },
    })
    if (result.status === 'committed') {
      if ('accepted' in result.value) {
        for (const publish of afterCommit) publish()
        return {
          status: result.value.status,
          value: result.value.value,
          documentRevision: result.revision,
        }
      }
      return result.value
    }
    if (result.status === 'aborted') {
      if (!('accepted' in result.value)) return result.value
      return rejected('VALIDATION_FAILED', { issues: schemaIssue() })
    }
    if (result.status === 'rejected') {
      if (result.code === 'READ_ONLY') return rejected('READ_ONLY')
      if (result.code === 'WRITE_FAILED' || result.code === 'INVALID_DOCUMENT') return rejected('WRITE_FAILED')
      if (result.code === 'REVISION_CONFLICT') {
        return rejected('REVISION_CONFLICT', {
          expectedRevision: result.expectedRevision,
          actualRevision: result.actualRevision,
        })
      }
    }
    return rejected('VALIDATION_FAILED', { issues: schemaIssue() })
  }

  return {
    createTag: input => execute(draft => {
      const timestamp = now()
      const tag = {
        id: createId(), revision: 1, createdAt: timestamp, updatedAt: timestamp,
        namespace: input.namespace, name: input.name, normalizedName: normalizeResourceTagName(input.name), colorToken: input.colorToken,
      }
      const parsed = ResourceTagSchema.safeParse(tag)
      if (!parsed.success) return rejected('VALIDATION_FAILED', { issues: schemaIssue() })
      draft.tags.push(parsed.data)
      return accepted('created', parsed.data)
    }),
    updateTag: input => execute(draft => {
      const index = draft.tags.findIndex(tag => tag.id === input.id)
      const existing = draft.tags[index]
      const conflict = hasExpectedRevision(existing, 'tag', input.id, input.expectedRevision)
      if (conflict) return conflict
      const candidate = updated({ ...existing!, name: input.name, normalizedName: normalizeResourceTagName(input.name), colorToken: input.colorToken }, now())
      const parsed = ResourceTagSchema.safeParse(candidate)
      if (!parsed.success) return rejected('VALIDATION_FAILED', { issues: schemaIssue() })
      draft.tags[index] = parsed.data
      return accepted('updated', parsed.data)
    }),
    deleteTag: input => execute(draft => {
      const index = draft.tags.findIndex(tag => tag.id === input.id)
      const tag = draft.tags[index]
      const conflict = hasExpectedRevision(tag, 'tag', input.id, input.expectedRevision)
      if (conflict) return conflict
      const timestamp = now()
      draft.tags.splice(index, 1)
      if (tag!.namespace === 'host') {
        draft.hosts = draft.hosts.map(host => host.tagIds.includes(input.id)
          ? updated({ ...host, tagIds: host.tagIds.filter(id => id !== input.id) }, timestamp) : host)
      } else if (tag!.namespace === 'concept') {
        draft.concepts = draft.concepts.map(concept => concept.tagIds.includes(input.id)
          ? updated({ ...concept, tagIds: concept.tagIds.filter(id => id !== input.id) }, timestamp) : concept)
      } else {
        draft.dataConnections = draft.dataConnections.map(connection =>
          connection.kind === tag!.namespace && connection.tagIds.includes(input.id)
            ? updated({ ...connection, tagIds: connection.tagIds.filter((id: string) => id !== input.id) }, timestamp)
            : connection,
        )
      }
      return accepted('deleted', { id: input.id })
    }),
    createHost: input => execute((draft, afterCommit) => {
      const timestamp = now()
      const { credential, ...metadata } = input
      const host = {
        ...metadata,
        applications: input.applications.map(application => applicationFromInput(draft, application)),
        id: createId(), revision: 1, createdAt: timestamp, updatedAt: timestamp,
      }
      const parsed = HostSchema.safeParse(applyHostCredential(draft, host, credential, options, afterCommit))
      if (!parsed.success) return rejected('VALIDATION_FAILED', { issues: schemaIssue() })
      draft.hosts.push(parsed.data)
      return accepted('created', parsed.data)
    }),
    updateHost: input => execute((draft, afterCommit) => {
      const index = draft.hosts.findIndex(host => host.id === input.id)
      const existing = draft.hosts[index]
      const conflict = hasExpectedRevision(existing, 'host', input.id, input.expectedRevision)
      if (conflict) return conflict
      const candidate = updated({ ...existing!, ...input.changes }, now())
      const parsed = HostSchema.safeParse(applyHostCredential(draft, candidate, input.credential, options, afterCommit))
      if (!parsed.success) return rejected('VALIDATION_FAILED', { issues: schemaIssue() })
      draft.hosts[index] = parsed.data
      return accepted('updated', parsed.data)
    }),
    deleteHost: input => execute(draft => {
      const index = draft.hosts.findIndex(host => host.id === input.id)
      const conflict = hasExpectedRevision(draft.hosts[index], 'host', input.id, input.expectedRevision)
      if (conflict) return conflict
      const references = findResourceReferences(draft, { resourceType: 'host', id: input.id })
      if (references.length > 0) return rejected('RESOURCE_IN_USE', { resourceType: 'host', id: input.id, references })
      draft.hosts.splice(index, 1)
      return accepted('deleted', { id: input.id })
    }),
    createApplication: input => execute(draft => {
      const index = draft.hosts.findIndex(host => host.id === input.hostId)
      const existing = draft.hosts[index]
      const conflict = hasExpectedRevision(existing, 'host', input.hostId, input.expectedHostRevision)
      if (conflict) return conflict
      const application = applicationFromInput(draft, input.application)
      const candidate = updated({ ...existing!, applications: [...existing!.applications, application] }, now())
      const parsed = HostSchema.safeParse(candidate)
      if (!parsed.success) return rejected('VALIDATION_FAILED', { issues: schemaIssue() })
      draft.hosts[index] = parsed.data
      return accepted('created', parsed.data)
    }),
    updateApplication: input => execute(draft => {
      const hostIndex = draft.hosts.findIndex(host => host.id === input.hostId)
      const host = draft.hosts[hostIndex]
      const conflict = hasExpectedRevision(host, 'host', input.hostId, input.expectedHostRevision)
      if (conflict) return conflict
      const applicationIndex = host!.applications.findIndex(application => application.id === input.applicationId)
      if (applicationIndex < 0) return rejected('NOT_FOUND', { resourceType: 'host', id: input.applicationId })
      const application = {
        ...host!.applications[applicationIndex]!, ...input.changes, id: input.applicationId,
        ...(input.changes.accounts ? { accounts: input.changes.accounts.map(account => accountFromInput(draft, account)) } : {}),
      }
      const parsedApplication = HostApplicationSchema.safeParse(application)
      if (!parsedApplication.success) return rejected('VALIDATION_FAILED', { issues: schemaIssue() })
      const applications = [...host!.applications]
      applications[applicationIndex] = parsedApplication.data
      const parsedHost = HostSchema.safeParse(updated({ ...host!, applications }, now()))
      if (!parsedHost.success) return rejected('VALIDATION_FAILED', { issues: schemaIssue() })
      draft.hosts[hostIndex] = parsedHost.data
      return accepted('updated', parsedHost.data)
    }),
    deleteApplication: input => execute(draft => {
      const hostIndex = draft.hosts.findIndex(host => host.id === input.hostId)
      const host = draft.hosts[hostIndex]
      const conflict = hasExpectedRevision(host, 'host', input.hostId, input.expectedHostRevision)
      if (conflict) return conflict
      if (!host!.applications.some(application => application.id === input.applicationId)) {
        return rejected('NOT_FOUND', { resourceType: 'host', id: input.applicationId })
      }
      const parsed = HostSchema.safeParse(updated({ ...host!, applications: host!.applications.filter(application => application.id !== input.applicationId) }, now()))
      if (!parsed.success) return rejected('VALIDATION_FAILED', { issues: schemaIssue() })
      draft.hosts[hostIndex] = parsed.data
      return accepted('deleted', parsed.data)
    }),
    createConcept: input => execute(draft => {
      const timestamp = now()
      const concept = { ...input, id: createId(), revision: 1, createdAt: timestamp, updatedAt: timestamp }
      const parsed = ConceptSchema.safeParse(concept)
      if (!parsed.success) return rejected('VALIDATION_FAILED', { issues: schemaIssue() })
      // M5: detect dependsOn cycles before committing. Self-reference is also
      // an instant cycle and is rejected here.
      if (parsed.data.dependsOnIds.includes(parsed.data.id)) {
        return rejected('DEPENDENCY_CYCLE', { cycle: [parsed.data.id, parsed.data.id] })
      }
      const cycleCheck = wouldCreateCycle(draft.concepts, parsed.data.id, parsed.data.dependsOnIds)
      if (!cycleCheck.ok) {
        return rejected('DEPENDENCY_CYCLE', { cycle: cycleCheck.cycle })
      }
      draft.concepts.push(parsed.data)
      return accepted('created', parsed.data)
    }),
    updateConcept: input => execute(draft => {
      const index = draft.concepts.findIndex(concept => concept.id === input.id)
      const existing = draft.concepts[index]
      const conflict = hasExpectedRevision(existing, 'concept', input.id, input.expectedRevision)
      if (conflict) return conflict
      const parsed = ConceptSchema.safeParse(updated({ ...existing!, ...input.changes }, now()))
      if (!parsed.success) return rejected('VALIDATION_FAILED', { issues: schemaIssue() })
      // M5: same cycle check on update.
      if (parsed.data.dependsOnIds.includes(parsed.data.id)) {
        return rejected('DEPENDENCY_CYCLE', { cycle: [parsed.data.id, parsed.data.id] })
      }
      const others = draft.concepts.filter(c => c.id !== parsed.data.id)
      const cycleCheck = wouldCreateCycle(others, parsed.data.id, parsed.data.dependsOnIds)
      if (!cycleCheck.ok) {
        return rejected('DEPENDENCY_CYCLE', { cycle: cycleCheck.cycle })
      }
      draft.concepts[index] = parsed.data
      return accepted('updated', parsed.data)
    }),
    deleteConcept: input => execute(draft => {
      const index = draft.concepts.findIndex(concept => concept.id === input.id)
      const conflict = hasExpectedRevision(draft.concepts[index], 'concept', input.id, input.expectedRevision)
      if (conflict) return conflict
      const references = findResourceReferences(draft, { resourceType: 'concept', id: input.id })
      const dependencies = references.filter(reference => reference.relation === 'dependsOnIds')
      if (dependencies.length > 0) return rejected('RESOURCE_IN_USE', { resourceType: 'concept', id: input.id, references })
      const referencesOnly = references.filter(reference => reference.relation === 'referenceIds')
      if (referencesOnly.length > 0 && !input.removeReferenceEdges) {
        return rejected('RESOURCE_IN_USE', { resourceType: 'concept', id: input.id, references })
      }
      if (referencesOnly.length > 0) {
        const timestamp = now()
        draft.concepts = draft.concepts.map(concept => concept.referenceIds.includes(input.id)
          ? updated({ ...concept, referenceIds: concept.referenceIds.filter(id => id !== input.id) }, timestamp) : concept)
      }
      draft.concepts = draft.concepts.filter(concept => concept.id !== input.id)
      return accepted('deleted', { id: input.id })
    }),
    createDataConnection: input => execute(draft => {
      const timestamp = now()
      const { password, ...rawInput } = input
      let credentialId = rawInput.credentialId
      if (password !== undefined) {
        const kind = rawInput.kind === 'database' ? 'database-password' : 'redis-password'
        credentialId = createBoundCredential(
          draft,
          options.vault,
          kind,
          { kind, password },
          rawInput.name,
        )
      }
      const connection = {
        ...rawInput,
        credentialId,
        id: createId(),
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      const parsed = DataConnectionSchema.safeParse(connection)
      if (!parsed.success) return rejected('VALIDATION_FAILED', { issues: schemaIssue() })
      draft.dataConnections.push(parsed.data)
      return accepted('created', parsed.data)
    }),
    updateDataConnection: input => execute(draft => {
      const index = draft.dataConnections.findIndex(connection => connection.id === input.id)
      const existing = draft.dataConnections[index]
      const conflict = hasExpectedRevision(existing, 'dataConnection', input.id, input.expectedRevision)
      if (conflict) return conflict
      const beforeCredentialIds = hostCredentialIds(draft)
      const { password, ...changes } = input.changes
      if (changes.kind !== undefined && changes.kind !== existing!.kind) {
        return rejected('VALIDATION_FAILED', { issues: schemaIssue() })
      }
      let credentialId = changes.credentialId ?? existing!.credentialId
      if (password !== undefined) {
        const kind = existing!.kind === 'database' ? 'database-password' : 'redis-password'
        credentialId = createBoundCredential(
          draft,
          options.vault,
          kind,
          { kind, password },
          changes.name ?? existing!.name,
        )
      }
      const parsed = DataConnectionSchema.safeParse(updated({
        ...existing!,
        ...changes,
        credentialId,
      }, now()))
      if (!parsed.success) return rejected('VALIDATION_FAILED', { issues: schemaIssue() })
      draft.dataConnections[index] = parsed.data
      removeNewlyUnreferencedCredentials(draft, beforeCredentialIds)
      return accepted('updated', parsed.data)
    }),
    deleteDataConnection: input => execute(draft => {
      const index = draft.dataConnections.findIndex(connection => connection.id === input.id)
      const conflict = hasExpectedRevision(draft.dataConnections[index], 'dataConnection', input.id, input.expectedRevision)
      if (conflict) return conflict
      const beforeCredentialIds = hostCredentialIds(draft)
      draft.dataConnections.splice(index, 1)
      removeNewlyUnreferencedCredentials(draft, beforeCredentialIds)
      return accepted('deleted', { id: input.id })
    }),
  }
}
