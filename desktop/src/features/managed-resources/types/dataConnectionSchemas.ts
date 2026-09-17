/**
 * 数据库与 Redis 连接的 Zod 校验。
 *
 * 形状与 `dataConnectionTypes.ts` 的领域类型一一对应；顶层
 * `.passthrough()` 保留未来扩展字段（与 ResourceDocument 一致）。
 *
 * 关键约束：
 *  - 与 Host 共享同一 AddressSchema（来自 sharedSchemas）
 *  - 已知跨类型字段必须拒绝：SQL 上有 topology/databaseIndex/
 *    keyPrefixDescription；Redis 上有 engine/database/schema/mode；
 *    public summary 同理。安全的未知未来字段继续透传。
 *  - 静态导入 sharedSchemas；禁止 dynamic import、Promise、
 *    z.unknown 回退和 z.ZodTypeAny。
 */

import { z } from 'zod'
import {
  AddressSchema,
  IdSchema,
  Iso8601UtcSchema,
  NameSchema,
  PortSchema,
  UniqueIdArraySchema,
} from './sharedSchemas.js'

// ---------- 枚举 ----------

export const DatabaseEngineSchema = z.enum(['mysql', 'mariadb', 'postgresql'])
export const RedisTopologySchema = z.literal('standalone')
export const ConnectionEnvironmentSchema = z.enum([
  'development',
  'test',
  'staging',
  'production',
  'unspecified',
])
export const ConnectionModeSchema = z.enum(['inspection', 'query'])

// ---------- TLS ----------

export const ConnectionTlsSchema = z
  .object({
    enabled: z.boolean(),
    serverName: z.string().min(1).max(255).nullable(),
    caCertificate: z.string().min(1).max(64 * 1024).nullable(),
    clientCertificate: z.string().min(1).max(64 * 1024).nullable(),
    clientKeyCredentialId: IdSchema.nullable(),
  })
  .passthrough()
  .superRefine((tls, ctx) => {
    if (tls.enabled && tls.serverName === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['serverName'],
        message: 'TLS enabled requires serverName for certificate hostname validation',
      })
    }
  })

// ---------- 跨类型字段拒绝 ----------

const SQL_FORBIDDEN_KEYS = new Set(['topology', 'databaseIndex', 'keyPrefixDescription'])
const REDIS_FORBIDDEN_KEYS = new Set(['engine', 'database', 'schema', 'mode'])

function rejectForbiddenKeys(
  raw: Record<string, unknown>,
  forbidden: Set<string>,
  ctx: z.core.$RefinementCtx,
): void {
  for (const key of forbidden) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `${key} is not allowed on this variant`,
      })
    }
  }
}

// ---------- ConnectionBase ----------

const ConnectionRevisionSchema = z.number().int().min(1)

const ConnectionBaseObjectSchema = z
  .object({
    id: IdSchema,
    revision: ConnectionRevisionSchema,
    createdAt: Iso8601UtcSchema,
    updatedAt: Iso8601UtcSchema,
    name: NameSchema,
    address: AddressSchema,
    port: PortSchema,
    username: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[^\u0000-\u001f\u007f]+$/u, 'username must not contain control characters')
      .nullable(),
    credentialId: IdSchema.nullable(),
    tagIds: UniqueIdArraySchema.max(50),
    relatedHostId: IdSchema.nullable(),
    environment: ConnectionEnvironmentSchema,
    tls: ConnectionTlsSchema,
    description: z.string().max(16 * 1024),
    accessInstructions: z.string().max(16 * 1024),
  })
  .passthrough()

// ---------- SQL & Redis 判别 ----------

export const SqlConnectionSchema = ConnectionBaseObjectSchema.extend({
  kind: z.literal('database'),
  engine: DatabaseEngineSchema,
  database: z.string().min(1).max(128),
  schema: z.string().min(1).max(128).nullable(),
  mode: ConnectionModeSchema,
})
  .passthrough()
  .superRefine((value, ctx) => {
    rejectForbiddenKeys(value as Record<string, unknown>, SQL_FORBIDDEN_KEYS, ctx)
  })

export const RedisConnectionSchema = ConnectionBaseObjectSchema.extend({
  kind: z.literal('redis'),
  topology: RedisTopologySchema,
  databaseIndex: z.number().int().min(0).max(15),
  keyPrefixDescription: z.string().max(1024),
})
  .passthrough()
  .superRefine((value, ctx) => {
    rejectForbiddenKeys(value as Record<string, unknown>, REDIS_FORBIDDEN_KEYS, ctx)
  })

/**
 * 数据连接判别联合；kind 决定子类型。
 */
export const DataConnectionSchema = z
  .discriminatedUnion('kind', [SqlConnectionSchema, RedisConnectionSchema])
  .superRefine((value, ctx) => {
    const forbidden =
      value.kind === 'database' ? SQL_FORBIDDEN_KEYS : REDIS_FORBIDDEN_KEYS
    rejectForbiddenKeys(value as Record<string, unknown>, forbidden, ctx)
  })

/**
 * Public database summary 与 public redis summary：
 * 已知跨类型字段在边界被拒绝；safe unknown 字段继续透传。
 */
export const PublicDatabaseSummarySchema = z
  .object({
    id: IdSchema,
    name: NameSchema,
    engine: DatabaseEngineSchema,
    address: AddressSchema,
    port: PortSchema,
    database: z.string().min(1),
    schema: z.string().nullable(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    rejectForbiddenKeys(value as Record<string, unknown>, SQL_FORBIDDEN_KEYS, ctx)
  })

export const PublicRedisSummarySchema = z
  .object({
    id: IdSchema,
    name: NameSchema,
    address: AddressSchema,
    port: PortSchema,
    topology: z.literal('standalone'),
    databaseIndex: z.number().int().min(0).max(15),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    rejectForbiddenKeys(value as Record<string, unknown>, REDIS_FORBIDDEN_KEYS, ctx)
  })

// AccessUrlSchema 与 UniqueIdObjectArraySchema 由调用方从 sharedSchemas 导入；
// 这里不再 re-export 以保持依赖方向单一。
