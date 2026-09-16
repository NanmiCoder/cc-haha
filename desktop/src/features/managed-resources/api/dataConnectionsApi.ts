import { z } from 'zod'
import type { DataConnection } from '../types/dataConnectionTypes.js'
import type { HostManagementResult } from './hostManagementApi.js'
import {
  AddressSchema,
  IdSchema,
  NameSchema,
  PortSchema,
} from '../types/sharedSchemas.js'
import {
  ConnectionEnvironmentSchema,
  ConnectionModeSchema,
  ConnectionTlsSchema,
  DatabaseEngineSchema,
} from '../types/dataConnectionSchemas.js'

const UsernameWriteSchema = z.string().min(1).max(64).nullable()
const PasswordWriteSchema = z.string().min(1).max(16 * 1024).optional()
const OptionalOwnerIdSchema = z.string().min(1).max(256).optional()
const CommonWriteShape = {
  name: NameSchema,
  address: AddressSchema,
  port: PortSchema,
  username: UsernameWriteSchema,
  credentialId: IdSchema.nullable(),
  password: PasswordWriteSchema,
  tagIds: z.array(IdSchema).max(50),
  relatedHostId: IdSchema.nullable(),
  environment: ConnectionEnvironmentSchema,
  tls: ConnectionTlsSchema,
  description: z.string().max(16 * 1024),
  accessInstructions: z.string().max(16 * 1024),
}

export const CreateDataConnectionInputSchema = z.discriminatedUnion('kind', [
  z.object({
    ...CommonWriteShape,
    kind: z.literal('database'),
    engine: DatabaseEngineSchema,
    database: z.string().min(1).max(128),
    schema: z.string().min(1).max(128).nullable(),
    mode: ConnectionModeSchema,
  }).strict(),
  z.object({
    ...CommonWriteShape,
    kind: z.literal('redis'),
    topology: z.literal('standalone'),
    databaseIndex: z.number().int().min(0).max(15),
    keyPrefixDescription: z.string().max(1024),
  }).strict(),
])

export type CreateDataConnectionInput = z.infer<typeof CreateDataConnectionInputSchema>

export const SaveDataConnectionInputSchema = z.union([
  z.object({
    ownerId: OptionalOwnerIdSchema,
    mode: z.literal('create'),
    connection: CreateDataConnectionInputSchema,
  }).strict(),
  z.object({
    ownerId: OptionalOwnerIdSchema,
    mode: z.literal('update'),
    id: IdSchema,
    expectedRevision: z.number().int().min(1),
    connection: CreateDataConnectionInputSchema,
  }).strict(),
])

export type SaveDataConnectionInput =
  | { mode: 'create'; connection: CreateDataConnectionInput }
  | { mode: 'update'; id: string; expectedRevision: number; connection: CreateDataConnectionInput }

export const ListDataConnectionsInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  kind: z.enum(['database', 'redis']).optional(),
  query: z.string().max(100).optional(),
}).strict()

export const GetDataConnectionInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  id: IdSchema,
}).strict()

export const DeleteDataConnectionInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  id: IdSchema,
  expectedRevision: z.number().int().min(1),
}).strict()

export const TestDataConnectionInputSchema = z.union([
  z.object({ ownerId: OptionalOwnerIdSchema, id: IdSchema }).strict(),
  z.object({ ownerId: OptionalOwnerIdSchema, connection: CreateDataConnectionInputSchema }).strict(),
])

export type DataConnectionTestResult = {
  ok: boolean
  latencyMs: number
  serverVersion: string | null
  errorCode: string | null
}

export const DATA_QUERY_DEFAULT_ROWS = 1_000
export const DATA_QUERY_HARD_ROWS = 10_000
export const DATA_QUERY_HARD_BYTES = 10 * 1024 * 1024
export const DATA_QUERY_BATCH_ROWS = 200
export const DATA_QUERY_DEFAULT_TIMEOUT_MS = 30_000
export const DATA_QUERY_MAX_TIMEOUT_MS = 300_000
export const REDIS_PAGE_HARD_BYTES = 1024 * 1024
export const REDIS_VALUE_PREVIEW_BYTES = 64 * 1024

export type DataSessionRef = {
  dataSessionId: string
  generation: number
  connectionId: string
  connectionRevision: number
  kind: 'database' | 'redis'
}

export type SqlDatabaseInfo = { name: string }
export type SqlSchemaInfo = { name: string }
export type SqlTableInfo = { schema: string | null; name: string; kind: 'table' | 'view' }
export type SqlColumnInfo = {
  ordinal: number
  name: string
  dataType: string
  nullable: boolean
}
export type SqlTableDescription = { table: SqlTableInfo; columns: SqlColumnInfo[] }

export type DataCell =
  | { kind: 'null' }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'bigint' | 'decimal' | 'date'; value: string }
  | { kind: 'binary'; base64Preview: string; byteLength: number; truncated: boolean }
  | { kind: 'json'; value: string }

export type SqlResultColumn = { index: number; name: string; dataType: string | null }
export type SqlQueryResult = {
  columns: SqlResultColumn[]
  rows: DataCell[][]
  rowCount: number
  byteCount: number
  truncated: boolean
  durationMs: number
}

export type SqlQueryLimits = {
  maxRows?: number
  maxBytes?: number
  timeoutMs?: number
}

export type SqlPreviewInput = SqlQueryLimits & {
  dataSessionId: string
  generation: number
  schema: string | null
  table: string
  limit?: number
}

export type SqlExecuteInput = SqlQueryLimits & {
  dataSessionId: string
  generation: number
  queryId: string
  sql: string
  params?: Array<string | number | boolean | null>
}

export type SqlCancelResult = {
  queryId: string
  localStopped: boolean
  serverCancelled: boolean
  outcomeUnknown: boolean
}

export type RedisKeySummary = {
  rawKeyToken: string
  displayKey: string
  binary: boolean
}

export type RedisScanResult = {
  nextCursor: string
  complete: boolean
  keys: RedisKeySummary[]
}

export type RedisReadType = 'string' | 'hash' | 'list' | 'set' | 'zset' | 'stream'
export type RedisValueItem =
  | { kind: 'value'; value: DataCell }
  | { kind: 'entry'; key: DataCell; value: DataCell }
  | { kind: 'scored'; value: DataCell; score: string }
  | { kind: 'stream'; id: string; fields: Array<{ key: DataCell; value: DataCell }> }

export type RedisReadResult = {
  exists: boolean
  type: RedisReadType | null
  ttlSeconds: number | null
  items: RedisValueItem[]
  nextCursor: string | null
  byteCount: number
  truncated: boolean
}

const DataSessionSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  dataSessionId: IdSchema,
  generation: z.number().int().min(1),
}).strict()

export const OpenDataSessionInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  connectionId: IdSchema,
  expectedRevision: z.number().int().min(1),
}).strict()
export const CloseDataSessionInputSchema = DataSessionSchema
export const SqlListDatabasesInputSchema = DataSessionSchema
export const SqlListSchemasInputSchema = DataSessionSchema
export const SqlListTablesInputSchema = DataSessionSchema.extend({ schema: z.string().min(1).max(128).nullable() }).strict()
export const SqlDescribeTableInputSchema = SqlListTablesInputSchema.extend({ table: z.string().min(1).max(256) }).strict()
export const SqlPreviewInputSchema = SqlDescribeTableInputSchema.extend({
  limit: z.number().int().min(1).max(DATA_QUERY_DEFAULT_ROWS).optional(),
  maxRows: z.number().int().min(1).max(DATA_QUERY_HARD_ROWS).optional(),
  maxBytes: z.number().int().min(1).max(DATA_QUERY_HARD_BYTES).optional(),
  timeoutMs: z.number().int().min(1_000).max(DATA_QUERY_MAX_TIMEOUT_MS).optional(),
}).strict()
export const SqlExecuteInputSchema = DataSessionSchema.extend({
  queryId: IdSchema,
  sql: z.string().min(1).max(1024 * 1024),
  params: z.array(z.union([z.string(), z.number().finite(), z.boolean(), z.null()])).max(1_000).optional(),
  maxRows: z.number().int().min(1).max(DATA_QUERY_HARD_ROWS).optional(),
  maxBytes: z.number().int().min(1).max(DATA_QUERY_HARD_BYTES).optional(),
  timeoutMs: z.number().int().min(1_000).max(DATA_QUERY_MAX_TIMEOUT_MS).optional(),
}).strict()
export const SqlCancelInputSchema = DataSessionSchema.extend({ queryId: IdSchema }).strict()
export const RedisScanInputSchema = DataSessionSchema.extend({
  cursor: z.string().max(20).regex(/^\d+$/).default('0'),
  match: z.string().max(512).optional(),
  countHint: z.number().int().min(1).max(1_000).optional(),
}).strict()
export const RedisReadInputSchema = DataSessionSchema.extend({
  rawKeyToken: IdSchema,
  type: z.enum(['string', 'hash', 'list', 'set', 'zset', 'stream']).optional(),
  cursor: z.string().max(41).regex(/^\d+(?:-\d+)?$/).optional(),
  start: z.number().int().min(0).optional(),
  count: z.number().int().min(1).max(DATA_QUERY_BATCH_ROWS).optional(),
  maxBytes: z.number().int().min(1).max(REDIS_PAGE_HARD_BYTES).optional(),
}).strict()

export type DataConnectionsHostApi = {
  list(params?: { kind?: 'database' | 'redis'; query?: string }): Promise<HostManagementResult<DataConnection[]>>
  get(id: string): Promise<HostManagementResult<DataConnection>>
  save(input: SaveDataConnectionInput): Promise<HostManagementResult<DataConnection>>
  delete(id: string, expectedRevision: number): Promise<HostManagementResult<{ id: string }>>
  testConnection(input: { id: string } | { connection: CreateDataConnectionInput }): Promise<HostManagementResult<DataConnectionTestResult>>
  openConnection(connectionId: string, expectedRevision: number): Promise<HostManagementResult<DataSessionRef>>
  closeConnection(dataSessionId: string, generation: number): Promise<HostManagementResult<{ closed: boolean }>>
  listDatabases(dataSessionId: string, generation: number): Promise<HostManagementResult<SqlDatabaseInfo[]>>
  listSchemas(dataSessionId: string, generation: number): Promise<HostManagementResult<SqlSchemaInfo[]>>
  listTables(dataSessionId: string, generation: number, schema: string | null): Promise<HostManagementResult<SqlTableInfo[]>>
  describeTable(dataSessionId: string, generation: number, schema: string | null, table: string): Promise<HostManagementResult<SqlTableDescription>>
  previewTable(input: SqlPreviewInput): Promise<HostManagementResult<SqlQueryResult>>
  executeQuery(input: SqlExecuteInput): Promise<HostManagementResult<SqlQueryResult>>
  cancelQuery(dataSessionId: string, generation: number, queryId: string): Promise<HostManagementResult<SqlCancelResult>>
  scanKeys(input: { dataSessionId: string; generation: number; cursor: string; match?: string; countHint?: number }): Promise<HostManagementResult<RedisScanResult>>
  readKey(input: { dataSessionId: string; generation: number; rawKeyToken: string; type?: RedisReadType; cursor?: string; start?: number; count?: number; maxBytes?: number }): Promise<HostManagementResult<RedisReadResult>>
}
