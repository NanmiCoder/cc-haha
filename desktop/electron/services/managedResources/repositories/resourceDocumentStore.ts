import type { ResourceDocument } from '../../../../src/features/managed-resources/types/resourceTypes.js'
import type { ResourceDocumentAtomicWriterDependencies } from './resourceDocumentAtomicWriter.js'
import { createResourceDocumentAtomicWriter } from './resourceDocumentAtomicWriter.js'
import type { ResourceDocumentLoadResult } from './resourceDocumentRepository.js'
import { createResourceDocumentRepository } from './resourceDocumentRepository.js'

export type ResourceDocumentMutation<T> =
  | { commit: true; value: T }
  | { commit: false; value: T }

export type ResourceDocumentTransactionResult<T> =
  | {
      status: 'committed'
      value: T
      document: ResourceDocument
      previousRevision: number
      revision: number
    }
  | { status: 'aborted'; value: T; revision: number }
  | {
      status: 'rejected'
      code: 'REVISION_CONFLICT'
      expectedRevision: number
      actualRevision: number
    }
  | {
      status: 'rejected'
      code:
        | 'READ_ONLY'
        | 'MUTATION_FAILED'
        | 'INVALID_DOCUMENT'
        | 'WRITE_FAILED'
        | 'REVISION_OVERFLOW'
      loadStatus?: Exclude<ResourceDocumentLoadResult['status'], 'ready'>
    }

export type ResourceDocumentStoreOptions = {
  activeConfigDir: string
  maxBytes?: number
  writerDependencies?: ResourceDocumentAtomicWriterDependencies
}

export type ResourceDocumentStore = {
  readonly filePath: string
  load(): Promise<ResourceDocumentLoadResult>
  transact<T>(input: {
    expectedDocumentRevision?: number
    mutate(draft: ResourceDocument): ResourceDocumentMutation<T> | Promise<ResourceDocumentMutation<T>>
  }): Promise<ResourceDocumentTransactionResult<T>>
}

export function createResourceDocumentStore(
  options: ResourceDocumentStoreOptions,
): ResourceDocumentStore {
  const repository = createResourceDocumentRepository(options)
  const writer = createResourceDocumentAtomicWriter({
    activeConfigDir: options.activeConfigDir,
    maxBytes: options.maxBytes,
    dependencies: options.writerDependencies,
  })
  let queue: Promise<void> = Promise.resolve()

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task, task)
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  return {
    filePath: repository.filePath,
    load: () => repository.load(),
    transact<T>(input: {
      expectedDocumentRevision?: number
      mutate(draft: ResourceDocument):
        | ResourceDocumentMutation<T>
        | Promise<ResourceDocumentMutation<T>>
    }): Promise<ResourceDocumentTransactionResult<T>> {
      return enqueue(async () => {
        const loaded = await repository.load()
        if (loaded.status !== 'ready') {
          return {
            status: 'rejected',
            code: 'READ_ONLY',
            loadStatus: loaded.status,
          }
        }

        const previousRevision = loaded.document.revision
        if (
          input.expectedDocumentRevision !== undefined &&
          input.expectedDocumentRevision !== previousRevision
        ) {
          return {
            status: 'rejected',
            code: 'REVISION_CONFLICT',
            expectedRevision: input.expectedDocumentRevision,
            actualRevision: previousRevision,
          }
        }

        if (previousRevision === Number.MAX_SAFE_INTEGER) {
          return { status: 'rejected', code: 'REVISION_OVERFLOW' }
        }

        const draft = structuredClone(loaded.document)
        let mutation: ResourceDocumentMutation<T>
        try {
          mutation = await input.mutate(draft)
        } catch {
          return { status: 'rejected', code: 'MUTATION_FAILED' }
        }

        if (!mutation.commit) {
          return { status: 'aborted', revision: previousRevision, value: mutation.value }
        }

        draft.revision = previousRevision + 1
        const written = await writer.write(draft)
        if (written.status !== 'written') {
          return {
            status: 'rejected',
            code: written.reason === 'invalid-schema' ? 'INVALID_DOCUMENT' : 'WRITE_FAILED',
          }
        }

        return {
          status: 'committed',
          value: mutation.value,
          document: draft,
          previousRevision,
          revision: draft.revision,
        }
      })
    },
  }
}
