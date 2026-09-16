import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import type { DataConnection, SqlConnection } from '../../../src/features/managed-resources/types/dataConnectionTypes.js'
import type {
  DataCell,
  DataSessionRef,
  RedisReadResult,
  RedisReadType,
  RedisScanResult,
  RedisValueItem,
  SqlCancelResult,
  SqlDatabaseInfo,
  SqlExecuteInput,
  SqlPreviewInput,
  SqlQueryResult,
  SqlResultColumn,
  SqlSchemaInfo,
  SqlTableDescription,
  SqlTableInfo,
} from '../../../src/features/managed-resources/api/dataConnectionsApi.js'
import {
  DATA_QUERY_DEFAULT_ROWS,
  DATA_QUERY_DEFAULT_TIMEOUT_MS,
  DATA_QUERY_HARD_BYTES,
  DATA_QUERY_HARD_ROWS,
  DATA_QUERY_MAX_TIMEOUT_MS,
  REDIS_PAGE_HARD_BYTES,
  REDIS_VALUE_PREVIEW_BYTES,
} from '../../../src/features/managed-resources/api/dataConnectionsApi.js'
import type { HostManagementResult } from '../../../src/features/managed-resources/api/hostManagementApi.js'
import type { ResourceDocumentStore } from './repositories/resourceDocumentStore.js'

export type SqlRawColumn = { name: string; dataType?: string | null }
export type SqlRawBatch = { columns?: SqlRawColumn[]; rows: unknown[][] }

export type SqlBrowserAdapter = {
  listDatabases(): Promise<SqlDatabaseInfo[]>
  listSchemas(): Promise<SqlSchemaInfo[]>
  listTables(schema: string | null): Promise<SqlTableInfo[]>
  describeTable(schema: string | null, table: string): Promise<SqlTableDescription>
  previewTable(input: { schema: string | null; table: string; limit: number; signal: AbortSignal }): AsyncIterable<SqlRawBatch>
  executeQuery(input: { queryId: string; sql: string; params: Array<string | number | boolean | null>; signal: AbortSignal }): AsyncIterable<SqlRawBatch>
  cancelQuery?(queryId: string): Promise<boolean>
  close(): Promise<void>
}

export type RedisRawValue = Uint8Array | string | number | boolean | null
export type RedisBrowserAdapter = {
  scan(input: { cursor: string; match?: string; countHint: number }): Promise<{ cursor: string; keys: Uint8Array[] }>
  type(key: Uint8Array): Promise<RedisReadType | 'none'>
  ttl(key: Uint8Array): Promise<number>
  readString(key: Uint8Array, maxBytes: number): Promise<{ value: Uint8Array | null; byteLength: number }>
  scanHash(key: Uint8Array, cursor: string, countHint: number): Promise<{ cursor: string; entries: Array<[RedisRawValue, RedisRawValue]> }>
  readList(key: Uint8Array, start: number, count: number): Promise<RedisRawValue[]>
  scanSet(key: Uint8Array, cursor: string, countHint: number): Promise<{ cursor: string; values: RedisRawValue[] }>
  scanZSet(key: Uint8Array, cursor: string, countHint: number): Promise<{ cursor: string; values: Array<{ value: RedisRawValue; score: string }> }>
  readStream(key: Uint8Array, cursor: string, count: number): Promise<{ nextCursor: string | null; values: Array<{ id: string; fields: Array<[RedisRawValue, RedisRawValue]> }> }>
  close(): Promise<void>
}

export type DataBrowserAdapter =
  | { kind: 'database'; sql: SqlBrowserAdapter }
  | { kind: 'redis'; redis: RedisBrowserAdapter }

export type DataBrowserAdapterFactory = {
  open(connection: DataConnection): Promise<DataBrowserAdapter>
}

export type DataBrowserServiceOptions = {
  store: ResourceDocumentStore
  adapters: DataBrowserAdapterFactory
  now?: () => number
  createId?: () => string
}

type SessionState = {
  closing: boolean
  ref: DataSessionRef
  ownerId: string
  connection: DataConnection
  adapter: DataBrowserAdapter
  rawKeys: Map<string, Buffer>
  scannedKeyHashes: Set<string>
  reads: Set<AbortController>
}

type ActiveQuery = {
  dataSessionId: string
  generation: number
  controller: AbortController
  cancel: (() => Promise<boolean>) | null
}

export type DataBrowserService = {
  openConnection(input: { ownerId: string; connectionId: string; expectedRevision: number }): Promise<HostManagementResult<DataSessionRef>>
  closeConnection(input: { ownerId: string; dataSessionId: string; generation: number }): Promise<HostManagementResult<{ closed: boolean }>>
  listDatabases(input: { ownerId: string; dataSessionId: string; generation: number }): Promise<HostManagementResult<SqlDatabaseInfo[]>>
  listSchemas(input: { ownerId: string; dataSessionId: string; generation: number }): Promise<HostManagementResult<SqlSchemaInfo[]>>
  listTables(input: { ownerId: string; dataSessionId: string; generation: number; schema: string | null }): Promise<HostManagementResult<SqlTableInfo[]>>
  describeTable(input: { ownerId: string; dataSessionId: string; generation: number; schema: string | null; table: string }): Promise<HostManagementResult<SqlTableDescription>>
  previewTable(input: { ownerId: string } & SqlPreviewInput): Promise<HostManagementResult<SqlQueryResult>>
  executeQuery(input: { ownerId: string } & SqlExecuteInput): Promise<HostManagementResult<SqlQueryResult>>
  cancelQuery(input: { ownerId: string; dataSessionId: string; generation: number; queryId: string }): Promise<HostManagementResult<SqlCancelResult>>
  scanKeys(input: { ownerId: string; dataSessionId: string; generation: number; cursor: string; match?: string; countHint?: number }): Promise<HostManagementResult<RedisScanResult>>
  readKey(input: { ownerId: string; dataSessionId: string; generation: number; rawKeyToken: string; type?: RedisReadType; cursor?: string; start?: number; count?: number; maxBytes?: number }): Promise<HostManagementResult<RedisReadResult>>
  disposeOwner(ownerId: string): Promise<void>
  dispose(): Promise<void>
}

function failure<T>(code: string): HostManagementResult<T> {
  return { ok: false, error: { code, messageKey: `managedResources.errors.${code}` } }
}

function safeNumber(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(max, Math.trunc(value!)))
}

function binaryCell(bytes: Uint8Array, originalByteLength = bytes.byteLength): DataCell {
  const buffer = Buffer.from(bytes)
  const preview = buffer.subarray(0, REDIS_VALUE_PREVIEW_BYTES)
  return { kind: 'binary', base64Preview: preview.toString('base64'), byteLength: originalByteLength, truncated: originalByteLength > preview.byteLength }
}

function classifyString(value: string, dataType?: string | null): DataCell {
  const normalizedType = dataType?.toLowerCase() ?? ''
  if (/\b(?:bigint|int8|bigserial)\b/.test(normalizedType)) return { kind: 'bigint', value }
  if (/\b(?:decimal|numeric|money)\b/.test(normalizedType)) return { kind: 'decimal', value }
  if (/\b(?:date|time|timestamp|datetime)\b/.test(normalizedType)) return { kind: 'date', value }
  return { kind: 'string', value }
}

export function normalizeDataCell(value: unknown, dataType?: string | null): DataCell {
  if (value === null || value === undefined) return { kind: 'null' }
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return binaryCell(value as Uint8Array)
  if (typeof value === 'bigint') return { kind: 'bigint', value: value.toString() }
  if (value instanceof Date) return { kind: 'date', value: value.toISOString() }
  if (typeof value === 'string') return classifyString(value, dataType)
  if (typeof value === 'number') return Number.isSafeInteger(value) || !Number.isInteger(value) ? { kind: 'number', value } : { kind: 'bigint', value: String(value) }
  if (typeof value === 'boolean') return { kind: 'boolean', value }
  try { return { kind: 'json', value: JSON.stringify(value) } } catch { return { kind: 'string', value: String(value) } }
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function keyDisplay(bytes: Buffer): { displayKey: string; binary: boolean } {
  const decoded = bytes.toString('utf8')
  const roundTrips = Buffer.from(decoded, 'utf8').equals(bytes)
  const hasControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(decoded)
  if (roundTrips && !hasControl) return { displayKey: decoded, binary: false }
  const preview = bytes.subarray(0, 48).toString('base64')
  return { displayKey: `base64:${preview}${bytes.length > 48 ? '…' : ''}`, binary: true }
}

function untilAbort<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('CANCELLED'))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

async function closeAdapter(adapter: DataBrowserAdapter): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('DISCONNECT_TIMEOUT')), 3_000)
  try {
    await untilAbort(adapter.kind === 'database' ? adapter.sql.close() : adapter.redis.close(), controller.signal)
  } finally { clearTimeout(timer) }
}

function readFailure(error: unknown, fallback: string): string {
  return error instanceof Error && ['QUERY_TIMEOUT', 'QUERY_CANCELLED', 'QUERY_LIMIT_REACHED'].includes(error.message) ? error.message : fallback
}

async function readOperation<T>(state: SessionState, operation: () => Promise<T>): Promise<T> {
  if (state.closing) throw new Error('QUERY_CANCELLED')
  if (state.reads.size >= 2) throw new Error('QUERY_LIMIT_REACHED')
  const controller = new AbortController()
  state.reads.add(controller)
  const timer = setTimeout(() => controller.abort(new Error('QUERY_TIMEOUT')), 10_000)
  try {
    return await untilAbort(Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason
      return operation()
    }), controller.signal)
  } finally { clearTimeout(timer); state.reads.delete(controller) }
}

function queryFailure(controller: AbortController): string {
  if (!controller.signal.aborted) return 'QUERY_FAILED'
  return controller.signal.reason instanceof Error && controller.signal.reason.message === 'QUERY_TIMEOUT' ? 'QUERY_TIMEOUT' : 'QUERY_CANCELLED'
}

export function createDataBrowserService(options: DataBrowserServiceOptions): DataBrowserService {
  const now = options.now ?? Date.now
  const createId = options.createId ?? randomUUID
  const sessions = new Map<string, SessionState>()
  const activeQueries = new Map<string, ActiveQuery>()
  const ownerEpochs = new Map<string, number>()
  let disposed = false
  const maxQueriesPerSession = 2
  const maxQueriesGlobal = 8

  const resolve = (input: { ownerId: string; dataSessionId: string; generation: number }, allowClosing = false): HostManagementResult<SessionState> => {
    const state = sessions.get(input.dataSessionId)
    if (!state) return failure('RESOURCE_NOT_FOUND')
    if (state.ownerId !== input.ownerId) return failure('UNAUTHORIZED_OWNER')
    if (state.ref.generation !== input.generation) return failure('STALE_GENERATION')
    if (state.closing && !allowClosing) return failure('SESSION_CLOSED')
    return { ok: true, data: state }
  }

  const sqlState = (input: { ownerId: string; dataSessionId: string; generation: number }): HostManagementResult<{ state: SessionState; adapter: SqlBrowserAdapter; connection: SqlConnection }> => {
    const resolved = resolve(input)
    if (!resolved.ok) return resolved
    if (resolved.data.connection.kind !== 'database' || resolved.data.adapter.kind !== 'database') return failure('INVALID_CONNECTION_KIND')
    return { ok: true, data: { state: resolved.data, adapter: resolved.data.adapter.sql, connection: resolved.data.connection } }
  }

  const redisState = (input: { ownerId: string; dataSessionId: string; generation: number }): HostManagementResult<{ state: SessionState; adapter: RedisBrowserAdapter }> => {
    const resolved = resolve(input)
    if (!resolved.ok) return resolved
    if (resolved.data.connection.kind !== 'redis' || resolved.data.adapter.kind !== 'redis') return failure('INVALID_CONNECTION_KIND')
    return { ok: true, data: { state: resolved.data, adapter: resolved.data.adapter.redis } }
  }

  const collectSql = async (source: AsyncIterable<SqlRawBatch>, limits: { maxRows?: number; maxBytes?: number; timeoutMs?: number }, startedAt: number, controller: AbortController): Promise<SqlQueryResult> => {
    const maxRows = safeNumber(limits.maxRows, DATA_QUERY_DEFAULT_ROWS, DATA_QUERY_HARD_ROWS)
    const maxBytes = safeNumber(limits.maxBytes, DATA_QUERY_HARD_BYTES, DATA_QUERY_HARD_BYTES)
    const timeoutMs = safeNumber(limits.timeoutMs, DATA_QUERY_DEFAULT_TIMEOUT_MS, DATA_QUERY_MAX_TIMEOUT_MS)
    const timer = setTimeout(() => controller.abort(new Error('QUERY_TIMEOUT')), timeoutMs)
    const rows: DataCell[][] = []
    let columns: SqlResultColumn[] = []
    let byteCount = 0
    let truncated = false
    const iterator = source[Symbol.asyncIterator]()
    let done = false
    try {
      while (true) {
        const next = await untilAbort(Promise.resolve().then(() => iterator.next()), controller.signal)
        if (next.done) { done = true; break }
        const batch = next.value
        if (controller.signal.aborted) throw controller.signal.reason ?? new Error('CANCELLED')
        if (columns.length === 0 && batch.columns) columns = batch.columns.map((column, index) => ({ index, name: column.name, dataType: column.dataType ?? null }))
        for (const rawRow of batch.rows) {
          const row = rawRow.map((value, index) => normalizeDataCell(value, columns[index]?.dataType))
          const rowBytes = encodedBytes(row)
          if (rows.length >= maxRows || byteCount + rowBytes > maxBytes) {
            truncated = true
            return { columns, rows, rowCount: rows.length, byteCount, truncated, durationMs: Math.max(0, now() - startedAt) }
          }
          rows.push(row)
          byteCount += rowBytes
        }
      }
      return { columns, rows, rowCount: rows.length, byteCount, truncated, durationMs: Math.max(0, now() - startedAt) }
    } finally {
      clearTimeout(timer)
      // Driver cleanup must be requested even on an early row/byte-limit return,
      // but an uncooperative iterator cannot keep the IPC caller waiting forever.
      if (!done) {
        if (!controller.signal.aborted) controller.abort(new Error('RESULT_LIMIT'))
        if (iterator.return) void Promise.resolve().then(() => iterator.return!()).catch(() => undefined)
      }
    }
  }

  const readRedisPage = (items: RedisValueItem[], maxBytes: number) => {
    const bounded: RedisValueItem[] = []
    let byteCount = 0
    for (const item of items) {
      const itemBytes = encodedBytes(item)
      if (byteCount + itemBytes > maxBytes) return { items: bounded, byteCount, truncated: true }
      bounded.push(item)
      byteCount += itemBytes
    }
    return { items: bounded, byteCount, truncated: false }
  }

  const service: DataBrowserService = {
    async openConnection(input) {
      if (disposed) return failure('SESSION_CLOSED')
      const ownerEpoch = ownerEpochs.get(input.ownerId) ?? 0
      const loaded = await options.store.load()
      if (loaded.status !== 'ready') return failure('CONTEXT_STORE_UNAVAILABLE')
      const connection = loaded.document.dataConnections.find(item => item.id === input.connectionId)
      if (!connection) return failure('RESOURCE_NOT_FOUND')
      if (connection.revision !== input.expectedRevision) return failure('REVISION_CONFLICT')
      let adapter: DataBrowserAdapter
      try { adapter = await options.adapters.open(connection) } catch { return failure('CONNECT_FAILED') }
      const current = await options.store.load()
      const currentRevision = current.status === 'ready' ? current.document.dataConnections.find(item => item.id === connection.id)?.revision : null
      if (disposed || ownerEpoch !== (ownerEpochs.get(input.ownerId) ?? 0) || currentRevision !== connection.revision) {
        await closeAdapter(adapter).catch(() => undefined)
        return failure(disposed || ownerEpoch !== (ownerEpochs.get(input.ownerId) ?? 0) ? 'SESSION_CLOSED' : 'REVISION_CONFLICT')
      }
      if (adapter.kind !== connection.kind) {
        await (adapter.kind === 'database' ? adapter.sql.close() : adapter.redis.close()).catch(() => undefined)
        return failure('INVALID_CONNECTION_KIND')
      }
      const dataSessionId = createId()
      const ref: DataSessionRef = { dataSessionId, generation: 1, connectionId: connection.id, connectionRevision: connection.revision, kind: connection.kind }
      sessions.set(dataSessionId, { ref, ownerId: input.ownerId, connection, adapter, closing: false, rawKeys: new Map(), scannedKeyHashes: new Set(), reads: new Set() })
      return { ok: true, data: ref }
    },

    async closeConnection(input) {
      const resolved = resolve(input, true)
      if (!resolved.ok) return resolved
      resolved.data.closing = true
      resolved.data.reads.forEach(controller => controller.abort(new Error('QUERY_CANCELLED')))
      for (const [queryId, query] of activeQueries) {
        if (query.dataSessionId !== input.dataSessionId) continue
        query.controller.abort(new Error('CANCELLED'))
        activeQueries.delete(queryId)
      }
      try { await closeAdapter(resolved.data.adapter) } catch { return failure('DISCONNECT_FAILED') }
      sessions.delete(input.dataSessionId)
      return { ok: true, data: { closed: true } }
    },

    async listDatabases(input) {
      const resolved = sqlState(input)
      if (!resolved.ok) return resolved
      try { return { ok: true, data: await readOperation(resolved.data.state, () => resolved.data.adapter.listDatabases()) } } catch (error) { return failure(readFailure(error, 'QUERY_FAILED')) }
    },
    async listSchemas(input) {
      const resolved = sqlState(input)
      if (!resolved.ok) return resolved
      try { return { ok: true, data: await readOperation(resolved.data.state, () => resolved.data.adapter.listSchemas()) } } catch (error) { return failure(readFailure(error, 'QUERY_FAILED')) }
    },
    async listTables(input) {
      const resolved = sqlState(input)
      if (!resolved.ok) return resolved
      try { return { ok: true, data: await readOperation(resolved.data.state, () => resolved.data.adapter.listTables(input.schema)) } } catch (error) { return failure(readFailure(error, 'QUERY_FAILED')) }
    },
    async describeTable(input) {
      const resolved = sqlState(input)
      if (!resolved.ok) return resolved
      try { return { ok: true, data: await readOperation(resolved.data.state, () => resolved.data.adapter.describeTable(input.schema, input.table)) } } catch (error) { return failure(readFailure(error, 'QUERY_FAILED')) }
    },

    async previewTable(input) {
      const resolved = sqlState(input)
      if (!resolved.ok) return resolved
      if (activeQueries.size >= maxQueriesGlobal || [...activeQueries.values()].filter(query => query.dataSessionId === input.dataSessionId).length >= maxQueriesPerSession) return failure('QUERY_LIMIT_REACHED')
      const controller = new AbortController()
      const previewId = randomUUID()
      activeQueries.set(previewId, { dataSessionId: input.dataSessionId, generation: input.generation, controller, cancel: null })
      const startedAt = now()
      try {
        const source = resolved.data.adapter.previewTable({ schema: input.schema, table: input.table, limit: safeNumber(input.limit, 100, DATA_QUERY_DEFAULT_ROWS), signal: controller.signal })
        return { ok: true, data: await collectSql(source, input, startedAt, controller) }
      } catch { return failure(queryFailure(controller)) }
      finally { activeQueries.delete(previewId) }
    },

    async executeQuery(input) {
      const resolved = sqlState(input)
      if (!resolved.ok) return resolved
      if (resolved.data.connection.mode !== 'query') return failure('QUERY_MODE_REQUIRED')
      if (activeQueries.has(input.queryId)) return failure('QUERY_ID_IN_USE')
      if (activeQueries.size >= maxQueriesGlobal) return failure('QUERY_LIMIT_REACHED')
      const sessionQueryCount = [...activeQueries.values()].filter(query => query.dataSessionId === input.dataSessionId).length
      if (sessionQueryCount >= maxQueriesPerSession) return failure('QUERY_LIMIT_REACHED')
      const controller = new AbortController()
      activeQueries.set(input.queryId, { dataSessionId: input.dataSessionId, generation: input.generation, controller, cancel: resolved.data.adapter.cancelQuery ? () => resolved.data.adapter.cancelQuery!(input.queryId) : null })
      const startedAt = now()
      try {
        const source = resolved.data.adapter.executeQuery({ queryId: input.queryId, sql: input.sql, params: input.params ?? [], signal: controller.signal })
        return { ok: true, data: await collectSql(source, input, startedAt, controller) }
      } catch { return failure(queryFailure(controller)) }
      finally { activeQueries.delete(input.queryId) }
    },

    async cancelQuery(input) {
      const resolved = sqlState(input)
      if (!resolved.ok) return resolved
      const active = activeQueries.get(input.queryId)
      if (!active || active.dataSessionId !== input.dataSessionId || active.generation !== input.generation) return failure('RESOURCE_NOT_FOUND')
      active.controller.abort(new Error('CANCELLED'))
      let serverCancelled = false
      if (active.cancel) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 1_000)
        try { serverCancelled = await untilAbort(active.cancel(), controller.signal).catch(() => false) }
        finally { clearTimeout(timer) }
      }
      return { ok: true, data: { queryId: input.queryId, localStopped: true, serverCancelled, outcomeUnknown: !serverCancelled } }
    },

    async scanKeys(input) {
      const resolved = redisState(input)
      if (!resolved.ok) return resolved
      try {
        const page = await readOperation(resolved.data.state, () => resolved.data.adapter.scan({ cursor: input.cursor, ...(input.match ? { match: input.match } : {}), countHint: safeNumber(input.countHint, 100, 1_000) }))
        if (page.keys.length > 10_000) return failure('REDIS_KEY_LIMIT_REACHED')
        const rawKeys = input.cursor === '0' ? new Map<string, Buffer>() : new Map(resolved.data.state.rawKeys)
        const hashes = input.cursor === '0' ? new Set<string>() : new Set(resolved.data.state.scannedKeyHashes)
        let bytesStored = [...rawKeys.values()].reduce((total, value) => total + value.byteLength, 0)
        const keys: RedisScanResult['keys'] = []
        for (const raw of page.keys) {
          if (raw.byteLength > REDIS_VALUE_PREVIEW_BYTES) return failure('REDIS_KEY_LIMIT_REACHED')
          const bytes = Buffer.from(raw)
          const hash = bytes.toString('hex')
          if (hashes.has(hash)) continue
          bytesStored += bytes.byteLength
          if (hashes.size >= 10_000 || bytesStored > 8 * REDIS_PAGE_HARD_BYTES) return failure('REDIS_KEY_LIMIT_REACHED')
          hashes.add(hash)
          const token = createId()
          rawKeys.set(token, bytes)
          keys.push({ rawKeyToken: token, ...keyDisplay(bytes) })
        }
        if (encodedBytes(keys) > REDIS_PAGE_HARD_BYTES) return failure('REDIS_KEY_LIMIT_REACHED')
        // Commit token replacement only after a successful, bounded refresh.
        resolved.data.state.scannedKeyHashes = hashes
        resolved.data.state.rawKeys = rawKeys
        return { ok: true, data: { nextCursor: page.cursor, complete: page.cursor === '0', keys } }
      } catch (error) { return failure(readFailure(error, 'REDIS_READ_FAILED')) }
    },

    async readKey(input) {
      const resolved = redisState(input)
      if (!resolved.ok) return resolved
      const rawKey = resolved.data.state.rawKeys.get(input.rawKeyToken)
      if (!rawKey) return failure('RESOURCE_NOT_FOUND')
      const maxBytes = safeNumber(input.maxBytes, REDIS_PAGE_HARD_BYTES, REDIS_PAGE_HARD_BYTES)
      const count = safeNumber(input.count, 100, 200)
      const cursor = input.cursor ?? '0'
      const cursorOffset = /^\d+$/.test(cursor) ? Number.parseInt(cursor, 10) : 0
      const start = Math.max(0, Math.trunc(input.start ?? cursorOffset))
      try {
        return await readOperation<HostManagementResult<RedisReadResult>>(resolved.data.state, async () => {
        const type = input.type ?? await resolved.data.adapter.type(rawKey)
        const ttl = await resolved.data.adapter.ttl(rawKey)
        if (type === 'none' || ttl === -2) return { ok: true, data: { exists: false, type: null, ttlSeconds: ttl === -2 ? -2 : null, items: [], nextCursor: null, byteCount: 0, truncated: false } }
        let items: RedisValueItem[] = []
        let nextCursor: string | null = null
        if (type === 'string') {
          const value = await resolved.data.adapter.readString(rawKey, Math.min(maxBytes, REDIS_VALUE_PREVIEW_BYTES))
          if (value.value === null) return { ok: true, data: { exists: false, type: null, ttlSeconds: -2, items: [], nextCursor: null, byteCount: 0, truncated: false } }
          items = [{ kind: 'value', value: binaryCell(value.value, value.byteLength) }]
        } else if (type === 'hash') {
          const page = await resolved.data.adapter.scanHash(rawKey, cursor, count)
          items = page.entries.map(([key, value]) => ({ kind: 'entry', key: normalizeDataCell(key), value: normalizeDataCell(value) }))
          nextCursor = page.cursor === '0' ? null : page.cursor
        } else if (type === 'list') {
          const values = await resolved.data.adapter.readList(rawKey, start, count)
          items = values.map(value => ({ kind: 'value', value: normalizeDataCell(value) }))
          nextCursor = values.length < count ? null : String(start + values.length)
        } else if (type === 'set') {
          const page = await resolved.data.adapter.scanSet(rawKey, cursor, count)
          items = page.values.map(value => ({ kind: 'value', value: normalizeDataCell(value) }))
          nextCursor = page.cursor === '0' ? null : page.cursor
        } else if (type === 'zset') {
          const page = await resolved.data.adapter.scanZSet(rawKey, cursor, count)
          items = page.values.map(value => ({ kind: 'scored', value: normalizeDataCell(value.value), score: value.score }))
          nextCursor = page.cursor === '0' ? null : page.cursor
        } else {
          const page = await resolved.data.adapter.readStream(rawKey, cursor, count)
          items = page.values.map(value => ({ kind: 'stream', id: value.id, fields: value.fields.map(([key, fieldValue]) => ({ key: normalizeDataCell(key), value: normalizeDataCell(fieldValue) })) }))
          nextCursor = page.nextCursor
        }
        const bounded = readRedisPage(items, maxBytes)
        return { ok: true, data: { exists: true, type, ttlSeconds: ttl, items: bounded.items, nextCursor, byteCount: bounded.byteCount, truncated: bounded.truncated } }
        })
      } catch (error) { return failure(readFailure(error, 'REDIS_READ_FAILED')) }
    },

    async disposeOwner(ownerId) {
      ownerEpochs.set(ownerId, (ownerEpochs.get(ownerId) ?? 0) + 1)
      const refs = [...sessions.values()].filter(state => state.ownerId === ownerId).map(state => state.ref)
      for (const ref of refs) await service.closeConnection({ ownerId, dataSessionId: ref.dataSessionId, generation: ref.generation })
    },
    async dispose() {
      disposed = true
      const values = [...sessions.values()]
      values.forEach(state => { state.closing = true; state.reads.forEach(controller => controller.abort(new Error('QUERY_CANCELLED'))) })
      sessions.clear()
      activeQueries.forEach(query => query.controller.abort(new Error('CANCELLED')))
      activeQueries.clear()
      await Promise.all(values.map(state => closeAdapter(state.adapter).catch(() => undefined)))
    },
  }

  return service
}
