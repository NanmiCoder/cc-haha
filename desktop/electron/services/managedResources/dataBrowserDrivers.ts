import { Buffer } from 'node:buffer'
import type { DataConnection, SqlConnection } from '../../../src/features/managed-resources/types/dataConnectionTypes.js'
import type { ResourceDocumentStore } from './repositories/resourceDocumentStore.js'
import type { CredentialVault } from './vault/credentialVault.js'
import { runtimeSecrets, tlsOptions } from './dataConnectionRuntime.js'
import { dedicatedSqlAdapter } from './dedicatedSqlAdapter.js'
import type {
  DataBrowserAdapterFactory,
  RedisBrowserAdapter,
  RedisRawValue,
  SqlBrowserAdapter,
  SqlRawBatch,
} from './dataBrowserService.js'
import type { RedisReadType } from '../../../src/features/managed-resources/api/dataConnectionsApi.js'

const CONNECT_TIMEOUT_MS = 10_000
const SQL_BATCH_ROWS = 200
const METADATA_LIMIT = 10_000
const REDIS_BLOB_STRING = 36

export type DataBrowserDriverFactoryOptions = {
  store: ResourceDocumentStore
  vault: CredentialVault
}

type MysqlField = { name?: string; columnType?: number; type?: number }
type MysqlReadable = AsyncIterable<unknown> & { destroy(error?: Error): void }
type MysqlQuery = {
  on(event: string, listener: (...args: unknown[]) => void): MysqlQuery
  stream(options?: { highWaterMark?: number }): MysqlReadable
}
type MysqlPromiseConnection = {
  query(options: { sql: string; rowsAsArray?: boolean }, values?: unknown[]): Promise<[unknown, MysqlField[]]>
}
type MysqlConnection = {
  connect(callback: (error: Error | null) => void): void
  query(options: { sql: string; rowsAsArray?: boolean }, values?: unknown[]): MysqlQuery
  promise(): MysqlPromiseConnection
  end(callback: (error?: Error | null) => void): void
  destroy(): void
}

type PgField = { name: string; dataTypeID?: number }
type PgQueryResult = { rows: unknown[]; fields?: PgField[] }
type PgCursor = {
  read(maxRows: number, callback: (error: Error | undefined, rows: unknown[], result: PgQueryResult) => void): void
  close(): Promise<void>
}
type PgClient = {
  connect(): Promise<void>
  query(input: unknown): unknown
  end(): Promise<void>
}
type PgCursorConstructor = new (sql: string, values?: unknown[], config?: { rowMode?: 'array' }) => unknown

type RedisClient = {
  on(event: 'error', listener: (error: unknown) => void): unknown
  connect(): Promise<unknown>
  sendCommand<T = unknown>(args: ReadonlyArray<string | Buffer>, options?: { typeMapping?: Record<number, BufferConstructor> }): Promise<T>
  quit(): Promise<unknown>
  disconnect(): void
}

function mysqlTypeName(field: MysqlField): string | null {
  const type = field.columnType ?? field.type
  if (type === 8) return 'bigint'
  if (type === 246) return 'decimal'
  if (type === 7) return 'timestamp'
  if (type === 10) return 'date'
  if (type === 12) return 'datetime'
  return type === undefined ? null : `mysql:${type}`
}

function postgresTypeName(oid: number | undefined): string | null {
  if (oid === 20) return 'bigint'
  if (oid === 1700) return 'numeric'
  if (oid === 1082) return 'date'
  if (oid === 1114 || oid === 1184) return 'timestamp'
  if (oid === 17) return 'bytea'
  return oid === undefined ? null : `postgres:${oid}`
}

function quoteMysql(identifier: string): string {
  return `\`${identifier.replace(/`/g, '``')}\``
}
function quotePostgres(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}
function asRows(value: unknown): unknown[][] {
  return Array.isArray(value)
    ? value.map(row => Array.isArray(row) ? row : Object.values(row as Record<string, unknown>))
    : []
}
function asBuffers(value: unknown): Buffer[] {
  return Array.isArray(value) ? value.filter((item): item is Buffer => Buffer.isBuffer(item)) : []
}
function asCursor(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString('ascii')
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  return '0'
}
function asBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  return Buffer.from(String(value ?? ''), 'utf8')
}

async function loadSecretConfig(connection: DataConnection, options: DataBrowserDriverFactoryOptions) {
  const secrets = await runtimeSecrets(connection, options.store, options.vault)
  return { secrets, tls: tlsOptions(connection, secrets) }
}

async function connectMysql(connection: SqlConnection, options: DataBrowserDriverFactoryOptions): Promise<MysqlConnection> {
  const mysql = await import('mysql2')
  const { secrets, tls } = await loadSecretConfig(connection, options)
  const raw = mysql.createConnection({
    host: connection.address,
    port: connection.port,
    user: connection.username ?? undefined,
    password: secrets.password ?? undefined,
    database: connection.database,
    connectTimeout: CONNECT_TIMEOUT_MS,
    rowsAsArray: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    multipleStatements: false,
    ...(tls ? { ssl: tls } : {}),
  }) as unknown as MysqlConnection
  try { await new Promise<void>((resolve, reject) => raw.connect(error => error ? reject(error) : resolve())) }
  catch (error) { raw.destroy(); throw error }
  return raw
}

async function mysqlMetadata(connection: MysqlConnection, sql: string, params: unknown[] = []): Promise<{ rows: unknown[][]; fields: MysqlField[] }> {
  const [rows, fields] = await connection.promise().query({ sql, rowsAsArray: true }, params)
  return { rows: asRows(rows), fields: fields ?? [] }
}

function mysqlStream(connection: MysqlConnection, sql: string, params: unknown[], signal: AbortSignal): AsyncIterable<SqlRawBatch> {
  return (async function* () {
    let fields: MysqlField[] = []
    const query = connection.query({ sql, rowsAsArray: true }, params)
    query.on('fields', (...args) => {
      const candidate = args[0]
      if (Array.isArray(candidate)) fields = candidate as MysqlField[]
    })
    const stream = query.stream({ highWaterMark: SQL_BATCH_ROWS })
    const onAbort = () => stream.destroy(signal.reason instanceof Error ? signal.reason : new Error('CANCELLED'))
    signal.addEventListener('abort', onAbort, { once: true })
    let batch: unknown[][] = []
    let first = true
    try {
      for await (const row of stream) {
        if (signal.aborted) throw signal.reason ?? new Error('CANCELLED')
        batch.push(Array.isArray(row) ? [...row] : Object.values(row as Record<string, unknown>))
        if (batch.length >= SQL_BATCH_ROWS) {
          yield {
            ...(first ? { columns: fields.map((field, index) => ({ name: field.name ?? `column_${index + 1}`, dataType: mysqlTypeName(field) })) } : {}),
            rows: batch,
          }
          first = false
          batch = []
        }
      }
      if (batch.length > 0 || first) {
        yield {
          ...(first ? { columns: fields.map((field, index) => ({ name: field.name ?? `column_${index + 1}`, dataType: mysqlTypeName(field) })) } : {}),
          rows: batch,
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  })()
}

function createMysqlAdapter(connectionInfo: SqlConnection, connection: MysqlConnection): SqlBrowserAdapter {
  return {
    async listDatabases() {
      const result = await mysqlMetadata(connection, `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME LIMIT ${METADATA_LIMIT}`)
      return result.rows.flatMap(row => typeof row[0] === 'string' ? [{ name: row[0] }] : [])
    },
    async listSchemas() {
      return [{ name: connectionInfo.database }]
    },
    async listTables(schema) {
      const actual = schema ?? connectionInfo.database
      const result = await mysqlMetadata(connection, `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME LIMIT ${METADATA_LIMIT}`, [actual])
      return result.rows.flatMap(row => typeof row[1] === 'string' ? [{ schema: String(row[0]), name: row[1], kind: String(row[2]).toUpperCase().includes('VIEW') ? 'view' as const : 'table' as const }] : [])
    },
    async describeTable(schema, table) {
      const actual = schema ?? connectionInfo.database
      const result = await mysqlMetadata(connection, `SELECT ORDINAL_POSITION, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION LIMIT ${METADATA_LIMIT}`, [actual, table])
      return {
        table: { schema: actual, name: table, kind: 'table' },
        columns: result.rows.flatMap(row => typeof row[1] === 'string' ? [{ ordinal: Number(row[0]), name: row[1], dataType: String(row[2] ?? ''), nullable: String(row[3]).toUpperCase() === 'YES' }] : []),
      }
    },
    previewTable({ schema, table, limit, signal }) {
      const actual = schema ?? connectionInfo.database
      return mysqlStream(connection, `SELECT * FROM ${quoteMysql(actual)}.${quoteMysql(table)} LIMIT ${Math.max(1, Math.trunc(limit))}`, [], signal)
    },
    executeQuery({ sql, params, signal }) {
      return mysqlStream(connection, sql, params, signal)
    },
    async cancelQuery() { return false },
    close: async () => { connection.destroy() },
  }
}

async function connectPostgres(connection: SqlConnection, options: DataBrowserDriverFactoryOptions): Promise<{ client: PgClient; Cursor: PgCursorConstructor }> {
  const [pgModule, cursorModule] = await Promise.all([import('pg'), import('pg-cursor')])
  const { secrets, tls } = await loadSecretConfig(connection, options)
  const client = new pgModule.Client({
    host: connection.address,
    port: connection.port,
    user: connection.username ?? undefined,
    password: secrets.password ?? undefined,
    database: connection.database,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    ...(tls ? { ssl: tls } : {}),
  }) as unknown as PgClient
  try { await client.connect() } catch (error) { await client.end().catch(() => undefined); throw error }
  const Cursor = (cursorModule.default ?? cursorModule) as unknown as PgCursorConstructor
  return { client, Cursor }
}

async function pgMetadata(client: PgClient, text: string, values: unknown[] = []): Promise<PgQueryResult> {
  return await client.query({ text, values, rowMode: 'array' }) as PgQueryResult
}

function pgStream(client: PgClient, Cursor: PgCursorConstructor, sql: string, params: unknown[], signal: AbortSignal, active: Map<string, PgCursor>, queryId: string): AsyncIterable<SqlRawBatch> {
  return (async function* () {
    const cursor = client.query(new Cursor(sql, params, { rowMode: 'array' })) as PgCursor
    active.set(queryId, cursor)
    const onAbort = () => { void cursor.close().catch(() => undefined) }
    signal.addEventListener('abort', onAbort, { once: true })
    let first = true
    try {
      while (true) {
        if (signal.aborted) throw signal.reason ?? new Error('CANCELLED')
        const page = await new Promise<{ rows: unknown[]; fields: PgField[] }>((resolve, reject) => {
          cursor.read(SQL_BATCH_ROWS, (error, rows, result) => error ? reject(error) : resolve({ rows, fields: result.fields ?? [] }))
        })
        if (signal.aborted) throw signal.reason ?? new Error('CANCELLED')
        const rows = page.rows.map(row => Array.isArray(row) ? [...row] : Object.values(row as Record<string, unknown>))
        yield {
          ...(first ? { columns: page.fields.map((field, index) => ({ name: field.name ?? `column_${index + 1}`, dataType: postgresTypeName(field.dataTypeID) })) } : {}),
          rows,
        }
        first = false
        if (rows.length < SQL_BATCH_ROWS) break
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      active.delete(queryId)
      await cursor.close().catch(() => undefined)
    }
  })()
}

function createPostgresAdapter(connectionInfo: SqlConnection, client: PgClient, Cursor: PgCursorConstructor): SqlBrowserAdapter {
  const active = new Map<string, PgCursor>()
  let previewSeq = 0
  return {
    async listDatabases() {
      const result = await pgMetadata(client, `SELECT datname FROM pg_database WHERE datallowconn = true ORDER BY datname LIMIT ${METADATA_LIMIT}`)
      return result.rows.flatMap(row => Array.isArray(row) && typeof row[0] === 'string' ? [{ name: row[0] }] : [])
    },
    async listSchemas() {
      const result = await pgMetadata(client, `SELECT schema_name FROM information_schema.schemata ORDER BY schema_name LIMIT ${METADATA_LIMIT}`)
      return result.rows.flatMap(row => Array.isArray(row) && typeof row[0] === 'string' ? [{ name: row[0] }] : [])
    },
    async listTables(schema) {
      const actual = schema ?? connectionInfo.schema ?? 'public'
      const result = await pgMetadata(client, `SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name LIMIT ${METADATA_LIMIT}`, [actual])
      return result.rows.flatMap(row => Array.isArray(row) && typeof row[1] === 'string' ? [{ schema: String(row[0]), name: row[1], kind: String(row[2]).toUpperCase().includes('VIEW') ? 'view' as const : 'table' as const }] : [])
    },
    async describeTable(schema, table) {
      const actual = schema ?? connectionInfo.schema ?? 'public'
      const result = await pgMetadata(client, `SELECT ordinal_position, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position LIMIT ${METADATA_LIMIT}`, [actual, table])
      return {
        table: { schema: actual, name: table, kind: 'table' },
        columns: result.rows.flatMap(row => Array.isArray(row) && typeof row[1] === 'string' ? [{ ordinal: Number(row[0]), name: row[1], dataType: String(row[2] ?? ''), nullable: String(row[3]).toUpperCase() === 'YES' }] : []),
      }
    },
    previewTable({ schema, table, limit, signal }) {
      const actual = schema ?? connectionInfo.schema ?? 'public'
      return pgStream(client, Cursor, `SELECT * FROM ${quotePostgres(actual)}.${quotePostgres(table)} LIMIT ${Math.max(1, Math.trunc(limit))}`, [], signal, active, `preview-${++previewSeq}`)
    },
    executeQuery({ queryId, sql, params, signal }) {
      return pgStream(client, Cursor, sql, params, signal, active, queryId)
    },
    async cancelQuery(queryId) {
      const cursor = active.get(queryId)
      if (!cursor) return false
      await cursor.close().catch(() => undefined)
      active.delete(queryId)
      return false
    },
    close: () => client.end(),
  }
}

async function connectRedis(connection: Extract<DataConnection, { kind: 'redis' }>, options: DataBrowserDriverFactoryOptions): Promise<RedisClient> {
  const redisModule = await import('@redis/client')
  const { secrets, tls } = await loadSecretConfig(connection, options)
  const client = redisModule.createClient({
    socket: {
      host: connection.address,
      port: connection.port,
      connectTimeout: CONNECT_TIMEOUT_MS,
      reconnectStrategy: false,
      ...(tls ? { tls: true, ...tls } : {}),
    },
    username: connection.username ?? undefined,
    password: secrets.password ?? undefined,
    database: connection.databaseIndex,
  }) as unknown as RedisClient
  client.on('error', () => undefined)
  try { await client.connect() } catch (error) { client.disconnect(); throw error }
  return client
}

function createRedisAdapter(client: RedisClient): RedisBrowserAdapter {
  const bufferCommand = <T = unknown>(args: ReadonlyArray<string | Buffer>) => client.sendCommand<T>(args, { typeMapping: { [REDIS_BLOB_STRING]: Buffer } })
  const plainCommand = <T = unknown>(args: ReadonlyArray<string | Buffer>) => client.sendCommand<T>(args)
  const parseScan = (reply: unknown): { cursor: string; flat: Buffer[] } => {
    if (!Array.isArray(reply) || reply.length < 2) return { cursor: '0', flat: [] }
    return { cursor: asCursor(reply[0]), flat: asBuffers(reply[1]) }
  }
  return {
    async scan({ cursor, match, countHint }) {
      const args: Array<string | Buffer> = ['SCAN', cursor]
      if (match) args.push('MATCH', match)
      args.push('COUNT', String(countHint))
      const page = parseScan(await bufferCommand(args))
      return { cursor: page.cursor, keys: page.flat }
    },
    async type(key) {
      const value = await plainCommand<string | Buffer>(['TYPE', Buffer.from(key)])
      const type = Buffer.isBuffer(value) ? value.toString('ascii') : String(value)
      return ['string', 'hash', 'list', 'set', 'zset', 'stream'].includes(type) ? type as RedisReadType : 'none'
    },
    async ttl(key) {
      return Number(await plainCommand<number>(['TTL', Buffer.from(key)]))
    },
    async readString(key, maxBytes) {
      const length = Number(await plainCommand<number>(['STRLEN', Buffer.from(key)]))
      if (length === 0) {
        const exists = Number(await plainCommand<number>(['EXISTS', Buffer.from(key)]))
        if (exists === 0) return { value: null, byteLength: 0 }
      }
      const value = await bufferCommand<Buffer | null>(['GETRANGE', Buffer.from(key), '0', String(Math.max(0, maxBytes - 1))])
      return { value: value === null ? null : asBuffer(value), byteLength: length }
    },
    async scanHash(key, cursor, countHint) {
      const page = parseScan(await bufferCommand(['HSCAN', Buffer.from(key), cursor, 'COUNT', String(countHint)]))
      const entries: Array<[RedisRawValue, RedisRawValue]> = []
      for (let i = 0; i + 1 < page.flat.length; i += 2) entries.push([page.flat[i]!, page.flat[i + 1]!])
      return { cursor: page.cursor, entries }
    },
    async readList(key, start, count) {
      return asBuffers(await bufferCommand(['LRANGE', Buffer.from(key), String(start), String(start + count - 1)]))
    },
    async scanSet(key, cursor, countHint) {
      const page = parseScan(await bufferCommand(['SSCAN', Buffer.from(key), cursor, 'COUNT', String(countHint)]))
      return { cursor: page.cursor, values: page.flat }
    },
    async scanZSet(key, cursor, countHint) {
      const page = parseScan(await bufferCommand(['ZSCAN', Buffer.from(key), cursor, 'COUNT', String(countHint)]))
      const values: Array<{ value: RedisRawValue; score: string }> = []
      for (let i = 0; i + 1 < page.flat.length; i += 2) values.push({ value: page.flat[i]!, score: page.flat[i + 1]!.toString('ascii') })
      return { cursor: page.cursor, values }
    },
    async readStream(key, cursor, count) {
      const start = cursor === '0' ? '-' : `(${cursor}`
      const reply = await bufferCommand<unknown>(['XRANGE', Buffer.from(key), start, '+', 'COUNT', String(count)])
      if (!Array.isArray(reply)) return { nextCursor: null, values: [] }
      const values = reply.flatMap(item => {
        if (!Array.isArray(item) || item.length < 2) return []
        const id = asBuffer(item[0]).toString('ascii')
        const flat = asBuffers(item[1])
        const fields: Array<[RedisRawValue, RedisRawValue]> = []
        for (let i = 0; i + 1 < flat.length; i += 2) fields.push([flat[i]!, flat[i + 1]!])
        return [{ id, fields }]
      })
      return { nextCursor: values.length < count ? null : values.at(-1)?.id ?? null, values }
    },
    async close() { client.disconnect() },
  }
}

export function createDataBrowserAdapterFactory(options: DataBrowserDriverFactoryOptions): DataBrowserAdapterFactory {
  return {
    async open(connection) {
      if (connection.kind === 'redis') {
        return { kind: 'redis', redis: createRedisAdapter(await connectRedis(connection, options)) }
      }
      const connect = async (): Promise<SqlBrowserAdapter> => {
        if (connection.engine === 'postgresql') {
          const { client, Cursor } = await connectPostgres(connection, options)
          return createPostgresAdapter(connection, client, Cursor)
        }
        return createMysqlAdapter(connection, await connectMysql(connection, options))
      }
      return { kind: 'database', sql: dedicatedSqlAdapter(await connect(), connect) }
    },
  }
}
