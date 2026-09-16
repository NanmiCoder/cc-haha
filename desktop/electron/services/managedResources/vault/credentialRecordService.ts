import type {
  CredentialKind,
  CredentialRecord,
  ResourceDocument,
} from '../../../../src/features/managed-resources/types/resourceTypes.js'
import { CredentialRecordSchema } from '../../../../src/features/managed-resources/types/resourceSchemas.js'
import {
  findResourceReferences,
  validateResourceDocumentIntegrity,
  type ResourceReference,
} from '../repositories/resourceDocumentIntegrity.js'
import type { ResourceDocumentStore } from '../repositories/resourceDocumentStore.js'
import type { CredentialSecretInput, CredentialVault } from './credentialVault.js'

export type CredentialRecordSummary = {
  id: string
  revision: number
  createdAt: string
  updatedAt: string
  kind: CredentialKind
  label: string
  backend: 'electron-safe-storage-v1'
  hasSecret: true
}

export type CredentialRecordServiceRejection = {
  status: 'rejected'
  code:
    | 'VAULT_UNAVAILABLE'
    | 'INVALID_CREDENTIAL_PAYLOAD'
    | 'NOT_FOUND'
    | 'REVISION_CONFLICT'
    | 'RESOURCE_IN_USE'
    | 'READ_ONLY'
    | 'WRITE_FAILED'
    | 'VALIDATION_FAILED'
  id?: string
  expectedRevision?: number
  actualRevision?: number
  references?: ResourceReference[]
}

export type CredentialRecordServiceResult =
  | {
      status: 'created' | 'updated'
      credential: CredentialRecordSummary
      documentRevision: number
    }
  | { status: 'deleted'; id: string; documentRevision: number }
  | CredentialRecordServiceRejection

export type CreateCredentialRecordInput = {
  kind: CredentialKind
  label: string
  secret: CredentialSecretInput
}

export type UpdateCredentialRecordInput = {
  id: string
  expectedRevision: number
  label?: string
  secret: CredentialSecretInput
}

export type CredentialRecordService = {
  create(input: CreateCredentialRecordInput): Promise<CredentialRecordServiceResult>
  update(input: UpdateCredentialRecordInput): Promise<CredentialRecordServiceResult>
  delete(input: { id: string; expectedRevision: number }): Promise<CredentialRecordServiceResult>
}

export type CreateCredentialRecordServiceOptions = {
  store: ResourceDocumentStore
  vault: CredentialVault
  now?: () => string
  createId?: () => string
}

type DraftAccepted =
  | { accepted: true; status: 'created' | 'updated'; credential: CredentialRecord }
  | { accepted: true; status: 'deleted'; id: string }

type DraftOutcome = DraftAccepted | CredentialRecordServiceRejection

function rejected(
  code: CredentialRecordServiceRejection['code'],
  extra: Omit<CredentialRecordServiceRejection, 'status' | 'code'> = {},
): CredentialRecordServiceRejection {
  return { status: 'rejected', code, ...extra }
}

function toSummary(record: CredentialRecord): CredentialRecordSummary {
  return {
    id: record.id,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    kind: record.kind,
    label: record.label,
    backend: record.backend,
    hasSecret: true,
  }
}

function mapStoreFailure(
  result: Awaited<ReturnType<ResourceDocumentStore['transact']>>,
): CredentialRecordServiceRejection {
  if (result.status === 'rejected') {
    if (result.code === 'READ_ONLY') return rejected('READ_ONLY')
    if (result.code === 'WRITE_FAILED' || result.code === 'INVALID_DOCUMENT') {
      return rejected('WRITE_FAILED')
    }
    if (result.code === 'REVISION_CONFLICT') {
      return rejected('REVISION_CONFLICT', {
        expectedRevision: result.expectedRevision,
        actualRevision: result.actualRevision,
      })
    }
  }
  return rejected('VALIDATION_FAILED')
}

function isAccepted(outcome: DraftOutcome): outcome is DraftAccepted {
  return 'accepted' in outcome && outcome.accepted
}

function validateCurrentDocument(document: ResourceDocument): CredentialRecordServiceRejection | null {
  return validateResourceDocumentIntegrity(document).length === 0
    ? null
    : rejected('VALIDATION_FAILED')
}

export function createCredentialRecordService(
  options: CreateCredentialRecordServiceOptions,
): CredentialRecordService {
  if (!options || typeof options !== 'object' || !options.store || !options.vault) {
    throw new TypeError('store and vault are required')
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new TypeError('now must be a function')
  }
  if (options.createId !== undefined && typeof options.createId !== 'function') {
    throw new TypeError('createId must be a function')
  }

  const now = options.now ?? (() => new Date().toISOString())
  const createId = options.createId ?? (() => crypto.randomUUID())

  async function execute(
    operation: (draft: ResourceDocument) => DraftOutcome,
  ): Promise<CredentialRecordServiceResult> {
    const transaction = await options.store.transact<DraftOutcome>({
      mutate: draft => {
        const currentFailure = validateCurrentDocument(draft)
        if (currentFailure) return { commit: false as const, value: currentFailure }

        const outcome = operation(draft)
        if (!isAccepted(outcome)) return { commit: false as const, value: outcome }

        const integrityFailure = validateCurrentDocument(draft)
        if (integrityFailure) return { commit: false as const, value: integrityFailure }
        return { commit: true as const, value: outcome }
      },
    })

    if (transaction.status === 'committed') {
      const outcome = transaction.value
      if (!isAccepted(outcome)) return rejected('VALIDATION_FAILED')
      if (outcome.status === 'deleted') {
        return { status: 'deleted', id: outcome.id, documentRevision: transaction.revision }
      }
      return {
        status: outcome.status,
        credential: toSummary(outcome.credential),
        documentRevision: transaction.revision,
      }
    }
    if (transaction.status === 'aborted') {
      return isAccepted(transaction.value) ? rejected('VALIDATION_FAILED') : transaction.value
    }
    return mapStoreFailure(transaction)
  }

  return {
    async create(input): Promise<CredentialRecordServiceResult> {
      let id: string
      let timestamp: string
      try {
        id = createId()
        timestamp = now()
      } catch {
        return rejected('VALIDATION_FAILED')
      }

      const metadata = CredentialRecordSchema.safeParse({
        id,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        kind: input.kind,
        label: input.label,
        backend: 'electron-safe-storage-v1',
        ciphertextBase64: 'RkFLRQ==',
      })
      if (!metadata.success) return rejected('VALIDATION_FAILED')

      const encrypted = options.vault.encrypt(metadata.data, input.secret)
      if (encrypted.status !== 'encrypted') return rejected(encrypted.code)
      const candidate = { ...metadata.data, ciphertextBase64: encrypted.ciphertextBase64 }

      return execute(draft => {
        if (draft.credentials.some(record => record.id === candidate.id)) {
          return rejected('VALIDATION_FAILED')
        }
        draft.credentials.push(candidate)
        return { accepted: true, status: 'created', credential: candidate }
      })
    },

    async update(input): Promise<CredentialRecordServiceResult> {
      const loaded = await options.store.load()
      if (loaded.status !== 'ready') return rejected('READ_ONLY')
      const existing = loaded.document.credentials.find(record => record.id === input.id)
      if (!existing) return rejected('NOT_FOUND', { id: input.id })
      if (existing.revision !== input.expectedRevision) {
        return rejected('REVISION_CONFLICT', {
          id: input.id,
          expectedRevision: input.expectedRevision,
          actualRevision: existing.revision,
        })
      }

      let timestamp: string
      try {
        timestamp = now()
      } catch {
        return rejected('VALIDATION_FAILED')
      }
      const metadata = CredentialRecordSchema.safeParse({
        ...existing,
        revision: existing.revision + 1,
        updatedAt: timestamp,
        label: input.label ?? existing.label,
      })
      if (!metadata.success) return rejected('VALIDATION_FAILED')

      const encrypted = options.vault.encrypt(existing, input.secret)
      if (encrypted.status !== 'encrypted') return rejected(encrypted.code)
      const candidate = { ...metadata.data, ciphertextBase64: encrypted.ciphertextBase64 }

      return execute(draft => {
        const index = draft.credentials.findIndex(record => record.id === input.id)
        const current = draft.credentials[index]
        if (!current) return rejected('NOT_FOUND', { id: input.id })
        if (current.revision !== input.expectedRevision) {
          return rejected('REVISION_CONFLICT', {
            id: input.id,
            expectedRevision: input.expectedRevision,
            actualRevision: current.revision,
          })
        }
        draft.credentials[index] = candidate
        return { accepted: true, status: 'updated', credential: candidate }
      })
    },

    delete(input): Promise<CredentialRecordServiceResult> {
      return execute(draft => {
        const index = draft.credentials.findIndex(record => record.id === input.id)
        const current = draft.credentials[index]
        if (!current) return rejected('NOT_FOUND', { id: input.id })
        if (current.revision !== input.expectedRevision) {
          return rejected('REVISION_CONFLICT', {
            id: input.id,
            expectedRevision: input.expectedRevision,
            actualRevision: current.revision,
          })
        }
        const references = findResourceReferences(draft, { resourceType: 'credential', id: input.id })
        if (references.length > 0) return rejected('RESOURCE_IN_USE', { id: input.id, references })
        draft.credentials.splice(index, 1)
        return { accepted: true, status: 'deleted', id: input.id }
      })
    },
  }
}
