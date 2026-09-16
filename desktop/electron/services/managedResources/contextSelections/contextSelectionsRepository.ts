import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { ConversationContextSelectionV2 } from '../../../../src/features/managed-resources/types/resourceTypes.js'
import { ConversationContextSelectionV2Schema } from '../../../../src/features/managed-resources/types/resourceSchemas.js'
import {
  createResourceDocumentRepository,
  RESOURCE_DOCUMENT_MAX_BYTES,
} from '../repositories/resourceDocumentRepository.js'

export type ContextSelectionsDocumentV2 = {
  schemaVersion: 2
  selections: Record<string, ConversationContextSelectionV2>
} & Record<string, unknown>

type ContextSelectionsDocumentV2Input = z.input<typeof ContextSelectionsDocumentV2Schema>

export const ContextSelectionsDocumentV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    selections: z.record(z.string().min(1), ConversationContextSelectionV2Schema),
  })
  .passthrough()

export type ContextSelectionsLoadResult =
  | {
    status: 'ready'
    source: 'missing' | 'disk'
    readOnly: false
    filePath: string
    document: ContextSelectionsDocumentV2
  }
  | {
    status: 'migration-required'
    source: 'disk'
    readOnly: true
    filePath: string
    schemaVersion: 0 | 1
  }
  | {
    status: 'newer-schema'
    source: 'disk'
    readOnly: true
    filePath: string
    schemaVersion: number
  }
  | {
    status: 'corrupt'
    source: 'disk'
    readOnly: true
    filePath: string
    reason: 'too-large' | 'invalid-utf8' | 'invalid-json' | 'invalid-schema' | 'io-error'
    message: string
  }

export type ContextSelectionsSaveResult =
  | { status: 'written'; filePath: string; byteLength: number }
  | {
    status: 'not-written'
    filePath: string
    reason: 'invalid-selection' | 'read-only' | 'too-large' | 'io-error'
    message: string
  }

export type ContextSelectionsMigrationResult =
  | {
    status: 'migrated'
    fromVersion: 0 | 1
    document: ContextSelectionsDocumentV2
    requiresReselection: Record<string, string[]>
  }
  | { status: 'not-migratable'; message: string }

export type ContextSelectionsMigrationOptions = {
  namespaceByTagId?: ReadonlyMap<string, 'host' | 'database' | 'redis' | 'concept'>
}

export type ContextSelectionsRepositoryDependencies = {
  replaceFile?: (sourcePath: string, targetPath: string) => Promise<void>
}

export type ContextSelectionsRepositoryOptions = {
  activeConfigDir: string
  maxBytes?: number
  dependencies?: ContextSelectionsRepositoryDependencies
}

export type ContextSelectionsRepository = {
  readonly filePath: string
  load(): Promise<ContextSelectionsLoadResult>
  save(sessionId: string, selection: unknown): Promise<ContextSelectionsSaveResult>
  delete(sessionId: string): Promise<ContextSelectionsSaveResult>
  migrateLegacy(options?: ContextSelectionsMigrationOptions): Promise<ContextSelectionsMigrationResult | ContextSelectionsSaveResult>
}

export type CredentialRevisionValidationResult =
  | { status: 'ready' }
  | { status: 'invalid-selection' }
  | {
    status: 'credential-revision-changed'
    id: string
    expectedRevision: number
    actualRevision: number | null
  }

function emptyDocument(): ContextSelectionsDocumentV2 {
  return { schemaVersion: 2, selections: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitizedIoMessage(err: unknown): string {
  void err
  return 'Filesystem I/O error'
}

function isLegacySelection(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Array.isArray(value.hostRefs) && Array.isArray(value.conceptRootRefs)
}

function safeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function legacyIdsOutsideResolvedTags(
  refs: unknown[],
  sourceTags: Array<{ namespace: string; memberIds: string[] }>,
  namespace: string,
): unknown[] {
  const resolvedIds = new Set(
    sourceTags
      .filter(tag => tag.namespace === namespace)
      .flatMap(tag => tag.memberIds),
  )
  return refs.filter(ref => (
    isRecord(ref) && typeof ref.id === 'string' && !resolvedIds.has(ref.id)
  )).map(ref => (ref as { id: string }).id)
}

function migrateSelection(
  input: Record<string, unknown>,
  options: ContextSelectionsMigrationOptions,
): { selection: ContextSelectionsDocumentV2['selections'][string]; pendingTags: string[] } | null {
  const oldSourceTags = safeArray(input.sourceTags)
  const pendingTags: string[] = []
  const sourceTags: Array<{ namespace: 'host' | 'database' | 'redis' | 'concept'; id: string; labelAtSelection: string; memberIds: string[] }> = []

  for (const sourceTag of oldSourceTags) {
    if (!isRecord(sourceTag) || typeof sourceTag.id !== 'string' ||
      typeof sourceTag.labelAtSelection !== 'string' || !Array.isArray(sourceTag.memberIds)) {
      return null
    }
    const explicitNamespace = sourceTag.namespace
    const namespace = explicitNamespace === 'host' || explicitNamespace === 'database' ||
      explicitNamespace === 'redis' || explicitNamespace === 'concept'
      ? explicitNamespace
      : options.namespaceByTagId?.get(sourceTag.id)
    if (!namespace) {
      pendingTags.push(sourceTag.id)
      continue
    }
    if (!sourceTag.memberIds.every(id => typeof id === 'string')) return null
    sourceTags.push({
      namespace,
      id: sourceTag.id,
      labelAtSelection: sourceTag.labelAtSelection,
      memberIds: [...sourceTag.memberIds] as string[],
    })
  }

  const directHostIds = Array.isArray(input.directHostIds)
    ? input.directHostIds
    : legacyIdsOutsideResolvedTags(safeArray(input.hostRefs), sourceTags, 'host')
  const directConceptIds = Array.isArray(input.directConceptIds)
    ? input.directConceptIds
    : legacyIdsOutsideResolvedTags(safeArray(input.conceptRootRefs), sourceTags, 'concept')

  const migrated: Record<string, unknown> = {
    ...input,
    schemaVersion: 2,
    hostRefs: safeArray(input.hostRefs),
    conceptRootRefs: safeArray(input.conceptRootRefs),
    dependencyRefs: safeArray(input.dependencyRefs),
    databaseRefs: safeArray(input.databaseRefs),
    redisRefs: safeArray(input.redisRefs),
    credentialRefs: safeArray(input.credentialRefs),
    sourceTags,
    directHostIds,
    directConceptIds,
    directDatabaseIds: safeArray(input.directDatabaseIds),
    directRedisIds: safeArray(input.directRedisIds),
    includePasswords: input.includePasswords,
  }
  if (pendingTags.length > 0) {
    migrated.migrationState = {
      requiresReselection: true,
      sourceTagIds: pendingTags,
    }
    migrated.legacySourceTags = oldSourceTags
  }

  const parsed = ConversationContextSelectionV2Schema.safeParse(migrated)
  return parsed.success
    ? { selection: parsed.data as ContextSelectionsDocumentV2['selections'][string], pendingTags }
    : null
}

export function migrateContextSelectionsDocument(
  input: unknown,
  options: ContextSelectionsMigrationOptions = {},
): ContextSelectionsMigrationResult {
  if (!isRecord(input)) {
    return { status: 'not-migratable', message: 'Legacy context selections must be a JSON object' }
  }

  const version = input.schemaVersion
  const fromVersion: 0 | 1 = version === 1 ? 1 : version === undefined || version === 0 ? 0 : -1 as never
  if (fromVersion !== 0 && fromVersion !== 1) {
    return { status: 'not-migratable', message: 'Unsupported context selections schemaVersion' }
  }

  const candidateSelections = fromVersion === 1
    ? input.selections
    : Object.fromEntries(Object.entries(input).filter(([, value]) => isLegacySelection(value)))
  if (!isRecord(candidateSelections)) {
    return { status: 'not-migratable', message: 'Legacy context selections are missing a selections object' }
  }

  const selections: Record<string, ContextSelectionsDocumentV2['selections'][string]> = {}
  const requiresReselection: Record<string, string[]> = {}
  for (const [sessionId, legacySelection] of Object.entries(candidateSelections)) {
    if (!isLegacySelection(legacySelection) || sessionId.length === 0) {
      return { status: 'not-migratable', message: 'Legacy context selection is invalid' }
    }
    const migrated = migrateSelection(legacySelection, options)
    if (!migrated) {
      return { status: 'not-migratable', message: 'Legacy context selection is invalid' }
    }
    selections[sessionId] = migrated.selection
    if (migrated.pendingTags.length > 0) requiresReselection[sessionId] = migrated.pendingTags
  }

  const document: Record<string, unknown> = fromVersion === 1
    ? { ...input, schemaVersion: 2, selections }
    : {
      ...Object.fromEntries(Object.entries(input).filter(([, value]) => !isLegacySelection(value))),
      schemaVersion: 2,
      selections,
    }
  const parsed = ContextSelectionsDocumentV2Schema.safeParse(document)
  if (!parsed.success) {
    return { status: 'not-migratable', message: 'Migrated context selections are invalid' }
  }
  return {
    status: 'migrated',
    fromVersion,
    document: parsed.data as ContextSelectionsDocumentV2,
    requiresReselection,
  }
}

export function validateCredentialRevisions(
  selection: unknown,
  resourceDocument: { credentials: ReadonlyArray<{ id: string; revision: number }> },
): CredentialRevisionValidationResult {
  const parsed = ConversationContextSelectionV2Schema.safeParse(selection)
  if (!parsed.success) return { status: 'invalid-selection' }
  if (parsed.data.includePasswords === false) return { status: 'ready' }
  const credentials = new Map(resourceDocument.credentials.map(credential => [credential.id, credential.revision]))
  for (const ref of parsed.data.credentialRefs) {
    const revision = credentials.get(ref.id)
    if (revision !== ref.revision) {
      return {
        status: 'credential-revision-changed',
        id: ref.id,
        expectedRevision: ref.revision,
        actualRevision: revision ?? null,
      }
    }
  }
  return { status: 'ready' }
}

export function createContextSelectionsRepository(
  options: ContextSelectionsRepositoryOptions,
): ContextSelectionsRepository {
  if (!options || typeof options !== 'object') throw new TypeError('Options must be an object')
  if (options.dependencies !== undefined && (!options.dependencies || typeof options.dependencies !== 'object')) {
    throw new TypeError('dependencies must be an object')
  }
  const extraDependencyKeys = Object.keys(options.dependencies ?? {}).filter(key => key !== 'replaceFile')
  if (extraDependencyKeys.length > 0) throw new Error(`Unsupported dependencies property: ${extraDependencyKeys.join(', ')}`)
  if (options.dependencies?.replaceFile !== undefined && typeof options.dependencies.replaceFile !== 'function') {
    throw new TypeError('replaceFile dependency must be a function')
  }

  createResourceDocumentRepository({ activeConfigDir: options.activeConfigDir, maxBytes: options.maxBytes })
  const maxBytes = options.maxBytes ?? RESOURCE_DOCUMENT_MAX_BYTES
  const filePath = path.join(options.activeConfigDir, 'cc-haha', 'host-management', 'context-selections.json')
  const directory = path.dirname(filePath)
  const replaceFile = options.dependencies?.replaceFile ?? fs.rename
  let operationQueue: Promise<void> = Promise.resolve()

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationQueue.then(operation, operation)
    operationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  async function rawLoad(): Promise<{ status: 'missing' } | { status: 'bytes'; bytes: Buffer } | { status: 'io-error'; message: string }> {
    try {
      const bytes = await fs.readFile(filePath)
      return { status: 'bytes', bytes }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
      return { status: 'io-error', message: sanitizedIoMessage(err) }
    }
  }

  async function writeDocument(document: ContextSelectionsDocumentV2): Promise<ContextSelectionsSaveResult> {
    let text: string
    try {
      text = JSON.stringify(document, null, 2)
      const reparsed = ContextSelectionsDocumentV2Schema.safeParse(JSON.parse(text))
      if (!reparsed.success || !isDeepStrictEqual(reparsed.data, document)) throw new Error('not JSON exact')
    } catch {
      return { status: 'not-written', filePath, reason: 'invalid-selection', message: 'Context selections are not JSON serializable' }
    }
    const bytes = Buffer.from(`${text}\n`, 'utf8')
    if (bytes.byteLength > maxBytes) {
      return { status: 'not-written', filePath, reason: 'too-large', message: 'Context selections exceed maximum byte length' }
    }
    let tempPath: string | null = null
    let fileHandle: fs.FileHandle | null = null
    try {
      await fs.mkdir(directory, { recursive: true })
      tempPath = path.join(directory, `.context-selections.json.${randomUUID()}.tmp`)
      fileHandle = await fs.open(tempPath, 'wx', 0o600)
      await fileHandle.writeFile(bytes)
      await fileHandle.sync()
      await fileHandle.close()
      fileHandle = null
      await replaceFile(tempPath, filePath)
      tempPath = null
      return { status: 'written', filePath, byteLength: bytes.byteLength }
    } catch {
      if (fileHandle) await fileHandle.close().catch(() => undefined)
      if (tempPath) await fs.unlink(tempPath).catch(() => undefined)
      return { status: 'not-written', filePath, reason: 'io-error', message: 'Filesystem I/O error during atomic write' }
    }
  }

  const repository: ContextSelectionsRepository = {
    filePath,
    async load(): Promise<ContextSelectionsLoadResult> {
      const raw = await rawLoad()
      if (raw.status === 'missing') {
        return { status: 'ready', source: 'missing', readOnly: false, filePath, document: emptyDocument() }
      }
      if (raw.status === 'io-error') {
        return { status: 'corrupt', source: 'disk', readOnly: true, filePath, reason: 'io-error', message: raw.message }
      }
      if (raw.bytes.byteLength > maxBytes) {
        return { status: 'corrupt', source: 'disk', readOnly: true, filePath, reason: 'too-large', message: 'File byte length exceeds maximum allowed size' }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.bytes))
      } catch (err) {
        const reason = err instanceof SyntaxError ? 'invalid-json' : 'invalid-utf8'
        return { status: 'corrupt', source: 'disk', readOnly: true, filePath, reason, message: reason === 'invalid-json' ? 'Invalid JSON syntax' : 'File content is not valid UTF-8' }
      }
      if (!isRecord(parsed)) {
        return { status: 'corrupt', source: 'disk', readOnly: true, filePath, reason: 'invalid-schema', message: 'Root JSON value must be an object' }
      }
      const version = parsed.schemaVersion
      if (version === undefined || version === 0 || version === 1) {
        return { status: 'migration-required', source: 'disk', readOnly: true, filePath, schemaVersion: version === 1 ? 1 : 0 }
      }
      if (typeof version === 'number' && Number.isSafeInteger(version) && version > 2) {
        return { status: 'newer-schema', source: 'disk', readOnly: true, filePath, schemaVersion: version }
      }
      const validation = ContextSelectionsDocumentV2Schema.safeParse(parsed)
      if (!validation.success) {
        return { status: 'corrupt', source: 'disk', readOnly: true, filePath, reason: 'invalid-schema', message: 'Invalid context selections schema' }
      }
      return { status: 'ready', source: 'disk', readOnly: false, filePath, document: validation.data as ContextSelectionsDocumentV2 }
    },
    async save(sessionId, selection): Promise<ContextSelectionsSaveResult> {
      return enqueue(async () => {
        if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
          return { status: 'not-written', filePath, reason: 'invalid-selection', message: 'sessionId must be a non-empty string' }
        }
        const parsedSelection = ConversationContextSelectionV2Schema.safeParse(selection)
        if (!parsedSelection.success) {
          return { status: 'not-written', filePath, reason: 'invalid-selection', message: 'Invalid context selection schema' }
        }
        const loaded = await repository.load()
        if (loaded.status !== 'ready') {
          return { status: 'not-written', filePath, reason: 'read-only', message: 'Context selections are read-only until repaired or migrated' }
        }
        const document = structuredClone(loaded.document) as ContextSelectionsDocumentV2Input
        document.selections[sessionId] = {
          ...(document.selections[sessionId] ?? {}),
          ...parsedSelection.data,
        }
        const validated = ContextSelectionsDocumentV2Schema.safeParse(document)
        if (!validated.success) {
          return { status: 'not-written', filePath, reason: 'invalid-selection', message: 'Invalid context selections schema' }
        }
        return writeDocument(validated.data as ContextSelectionsDocumentV2)
      })
    },
    async delete(sessionId): Promise<ContextSelectionsSaveResult> {
      return enqueue(async () => {
        const loaded = await repository.load()
        if (loaded.status !== 'ready') {
          return { status: 'not-written', filePath, reason: 'read-only', message: 'Context selections are read-only until repaired or migrated' }
        }
        const document = structuredClone(loaded.document) as ContextSelectionsDocumentV2Input
        delete document.selections[sessionId]
        return writeDocument(document as ContextSelectionsDocumentV2)
      })
    },
    async migrateLegacy(migrationOptions = {}): Promise<ContextSelectionsMigrationResult | ContextSelectionsSaveResult> {
      return enqueue(async () => {
        const raw = await rawLoad()
        if (raw.status === 'missing') return { status: 'not-migratable', message: 'No legacy context selections file exists' }
        if (raw.status === 'io-error') return { status: 'not-written', filePath, reason: 'io-error', message: raw.message }
        if (raw.bytes.byteLength > maxBytes) return { status: 'not-written', filePath, reason: 'read-only', message: 'Context selections exceed maximum byte length' }
        let legacy: unknown
        try {
          legacy = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.bytes))
        } catch {
          return { status: 'not-written', filePath, reason: 'read-only', message: 'Context selections are corrupt' }
        }
        const migrated = migrateContextSelectionsDocument(legacy, migrationOptions)
        if (migrated.status !== 'migrated') return migrated
        try {
          await fs.mkdir(directory, { recursive: true })
          await fs.writeFile(path.join(directory, `context-selections.json.bak-v${migrated.fromVersion}-${Date.now()}`), raw.bytes, { mode: 0o600, flag: 'wx' })
        } catch {
          return { status: 'not-written', filePath, reason: 'io-error', message: 'Failed to create migration backup' }
        }
        const write = await writeDocument(migrated.document)
        return write.status === 'written' ? migrated : write
      })
    },
  }
  return repository
}
