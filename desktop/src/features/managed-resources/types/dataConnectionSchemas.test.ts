/**
 * dataConnectionSchemas 的窄回归。
 *
 * 仅使用虚构数据；不连真实数据库。
 * 覆盖：合法 MySQL/MariaDB/PostgreSQL/Redis 解析；非法端口、未知
 * engine、未知 topology、缺失字段、SQL/Redis 字段互换被拒；
 * TLS 启用时 serverName 必填；单集合 tagIds 不重复；
 * 持久化未知字段透传；TLS 关闭时允许 serverName=null；
 * 已知跨类型字段（topology/databaseIndex/keyPrefixDescription 在 SQL 上，
 * engine/database/schema/mode 在 Redis 上）在判别联合和 public summary 上
 * 被拒绝；safe future 字段仍透传。
 *
 * MR-M01-008 的编译期 DTO↔schema 契约断言同样包含。
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  ConnectionEnvironmentSchema,
  ConnectionModeSchema,
  ConnectionTlsSchema,
  DataConnectionSchema,
  DatabaseEngineSchema,
  PublicDatabaseSummarySchema,
  PublicRedisSummarySchema,
  RedisConnectionSchema,
  SqlConnectionSchema,
} from './dataConnectionSchemas.js'
import type {
  ConnectionBase,
  ConnectionEnvironment,
  ConnectionMode,
  ConnectionTls,
  DataConnection,
  DatabaseEngine,
  RedisConnection,
  RedisTopology,
  SqlConnection,
} from './dataConnectionTypes.js'

const HOST_ID = '10000000-0000-4000-8000-000000000001'
const CRED_ID = '50000000-0000-4000-8000-000000000001'
const TAG_DB = '30000000-0000-4000-8000-000000000003'
const TAG_REDIS = '30000000-0000-4000-8000-000000000004'
const SQL_ID = '40000000-0000-4000-8000-000000000010'
const REDIS_ID = '40000000-0000-4000-8000-000000000020'
const NOW = '2026-09-06T05:00:00Z'

const sqlBase = {
  id: SQL_ID,
  revision: 1,
  createdAt: NOW,
  updatedAt: NOW,
  name: 'app db',
  address: '192.0.2.20',
  port: 5432,
  username: 'app',
  credentialId: CRED_ID,
  tagIds: [TAG_DB],
  relatedHostId: HOST_ID,
  environment: 'production' as const,
  tls: {
    enabled: false,
    serverName: null,
    caCertificate: null,
    clientCertificate: null,
    clientKeyCredentialId: null,
  },
  description: 'main application database',
  accessInstructions: '',
  kind: 'database' as const,
  engine: 'postgresql' as const,
  database: 'app',
  schema: 'public',
  mode: 'inspection' as const,
}

const redisBase = {
  id: REDIS_ID,
  revision: 1,
  createdAt: NOW,
  updatedAt: NOW,
  name: 'cache',
  address: '192.0.2.30',
  port: 6379,
  username: null,
  credentialId: CRED_ID,
  tagIds: [TAG_REDIS],
  relatedHostId: null,
  environment: 'production' as const,
  tls: {
    enabled: false,
    serverName: null,
    caCertificate: null,
    clientCertificate: null,
    clientKeyCredentialId: null,
  },
  description: '',
  accessInstructions: '',
  kind: 'redis' as const,
  topology: 'standalone' as const,
  databaseIndex: 0,
  keyPrefixDescription: '',
}

// =========================================================================
// MR-M01-008: compile-time DTO ↔ schema assignability
// =========================================================================

describe('MR-M01-008 compile-time DTO↔schema contract', () => {
  it('binds data connection schemas to their DTO types', () => {
    type SqlOutput = z.infer<typeof SqlConnectionSchema>
    type SqlInput = z.input<typeof SqlConnectionSchema>
    const _sqlOutAsDto: SqlConnection = {} as SqlOutput
    const _sqlDtoAsIn: SqlInput = {} as SqlConnection
    void _sqlOutAsDto
    void _sqlDtoAsIn

    type RedisOutput = z.infer<typeof RedisConnectionSchema>
    type RedisInput = z.input<typeof RedisConnectionSchema>
    const _redisOutAsDto: RedisConnection = {} as RedisOutput
    const _redisDtoAsIn: RedisInput = {} as RedisConnection
    void _redisOutAsDto
    void _redisDtoAsIn

    type DataOutput = z.infer<typeof DataConnectionSchema>
    type DataInput = z.input<typeof DataConnectionSchema>
    const _dataOutAsDto: DataConnection = {} as DataOutput
    const _dataDtoAsIn: DataInput = {} as DataConnection
    void _dataOutAsDto
    void _dataDtoAsIn

    type TlsOutput = z.infer<typeof ConnectionTlsSchema>
    type TlsInput = z.input<typeof ConnectionTlsSchema>
    const _tlsOutAsDto: ConnectionTls = {} as TlsOutput
    const _tlsDtoAsIn: TlsInput = {} as ConnectionTls
    void _tlsOutAsDto
    void _tlsDtoAsIn
  })
})

// =========================================================================
// Enum coverage
// =========================================================================

describe('DatabaseEngineSchema', () => {
  it.each(['mysql', 'mariadb', 'postgresql'] as const)('accepts %s', (engine) => {
    expect(DatabaseEngineSchema.safeParse(engine).success).toBe(true)
  })

  it('rejects unknown engine', () => {
    expect(DatabaseEngineSchema.safeParse('sqlite').success).toBe(false)
    expect(DatabaseEngineSchema.safeParse('mssql').success).toBe(false)
    expect(DatabaseEngineSchema.safeParse('oracle').success).toBe(false)
  })
})

describe('ConnectionEnvironmentSchema', () => {
  it.each(['development', 'test', 'staging', 'production', 'unspecified'] as const)(
    'accepts %s',
    (env) => {
      expect(ConnectionEnvironmentSchema.safeParse(env).success).toBe(true)
    },
  )

  it('rejects unknown environment', () => {
    expect(ConnectionEnvironmentSchema.safeParse('prod-like').success).toBe(false)
  })
})

describe('ConnectionModeSchema', () => {
  it.each(['inspection', 'query'] as const)('accepts %s', (mode) => {
    expect(ConnectionModeSchema.safeParse(mode).success).toBe(true)
  })

  it('rejects unknown mode', () => {
    expect(ConnectionModeSchema.safeParse('admin').success).toBe(false)
  })
})

// =========================================================================
// MR-M01-001: cross-variant denial (known conflicting fields rejected,
// safe future fields passthrough)
// =========================================================================

describe('MR-M01-001 SQL/Redis cross-variant denial', () => {
  describe('SqlConnectionSchema rejects Redis-only fields', () => {
    it('rejects topology on a SQL connection', () => {
      const r = SqlConnectionSchema.safeParse({
        ...sqlBase,
        topology: 'standalone',
      })
      expect(r.success).toBe(false)
    })

    it('rejects databaseIndex on a SQL connection', () => {
      const r = SqlConnectionSchema.safeParse({
        ...sqlBase,
        databaseIndex: 0,
      })
      expect(r.success).toBe(false)
    })

    it('rejects keyPrefixDescription on a SQL connection', () => {
      const r = SqlConnectionSchema.safeParse({
        ...sqlBase,
        keyPrefixDescription: 'cache:',
      })
      expect(r.success).toBe(false)
    })
  })

  describe('RedisConnectionSchema rejects SQL-only fields', () => {
    it('rejects engine on a Redis connection', () => {
      const r = RedisConnectionSchema.safeParse({
        ...redisBase,
        engine: 'mysql',
      })
      expect(r.success).toBe(false)
    })

    it('rejects database on a Redis connection', () => {
      const r = RedisConnectionSchema.safeParse({
        ...redisBase,
        database: 'app',
      })
      expect(r.success).toBe(false)
    })

    it('rejects schema on a Redis connection', () => {
      const r = RedisConnectionSchema.safeParse({
        ...redisBase,
        schema: 'public',
      })
      expect(r.success).toBe(false)
    })

    it('rejects mode on a Redis connection', () => {
      const r = RedisConnectionSchema.safeParse({
        ...redisBase,
        mode: 'inspection',
      })
      expect(r.success).toBe(false)
    })
  })

  describe('safe future fields still passthrough', () => {
    it('SqlConnectionSchema keeps an unknown future field', () => {
      const r = SqlConnectionSchema.safeParse({
        ...sqlBase,
        customDriverHint: 'pool-min=2',
      })
      expect(r.success).toBe(true)
      if (r.success) {
        const data = r.data as SqlConnection & { customDriverHint?: string }
        expect(data.customDriverHint).toBe('pool-min=2')
      }
    })

    it('RedisConnectionSchema keeps an unknown future field', () => {
      const r = RedisConnectionSchema.safeParse({
        ...redisBase,
        shardHints: { replicas: 1 },
      })
      expect(r.success).toBe(true)
      if (r.success) {
        const data = r.data as RedisConnection & { shardHints?: { replicas: number } }
        expect(data.shardHints).toEqual({ replicas: 1 })
      }
    })
  })

  describe('PublicDatabaseSummarySchema rejects Redis-only fields', () => {
    it('rejects databaseIndex', () => {
      const r = PublicDatabaseSummarySchema.safeParse({
        id: SQL_ID,
        name: 'db',
        engine: 'postgresql',
        address: '192.0.2.20',
        port: 5432,
        database: 'app',
        schema: 'public',
        databaseIndex: 0,
      })
      expect(r.success).toBe(false)
    })

    it('rejects topology', () => {
      const r = PublicDatabaseSummarySchema.safeParse({
        id: SQL_ID,
        name: 'db',
        engine: 'postgresql',
        address: '192.0.2.20',
        port: 5432,
        database: 'app',
        schema: 'public',
        topology: 'standalone',
      })
      expect(r.success).toBe(false)
    })

    it('rejects keyPrefixDescription', () => {
      const r = PublicDatabaseSummarySchema.safeParse({
        id: SQL_ID,
        name: 'db',
        engine: 'postgresql',
        address: '192.0.2.20',
        port: 5432,
        database: 'app',
        schema: 'public',
        keyPrefixDescription: 'cache:',
      })
      expect(r.success).toBe(false)
    })

    it('still keeps an unknown future field', () => {
      const r = PublicDatabaseSummarySchema.safeParse({
        id: SQL_ID,
        name: 'db',
        engine: 'postgresql',
        address: '192.0.2.20',
        port: 5432,
        database: 'app',
        schema: 'public',
        futureDbHint: 'pool-min=2',
      })
      expect(r.success).toBe(true)
      if (r.success) {
        const data = r.data as { futureDbHint?: string }
        expect(data.futureDbHint).toBe('pool-min=2')
      }
    })
  })

  describe('PublicRedisSummarySchema rejects SQL-only fields', () => {
    it('rejects engine', () => {
      const r = PublicRedisSummarySchema.safeParse({
        id: REDIS_ID,
        name: 'r',
        address: '192.0.2.30',
        port: 6379,
        topology: 'standalone',
        databaseIndex: 0,
        engine: 'mysql',
      })
      expect(r.success).toBe(false)
    })

    it('rejects database', () => {
      const r = PublicRedisSummarySchema.safeParse({
        id: REDIS_ID,
        name: 'r',
        address: '192.0.2.30',
        port: 6379,
        topology: 'standalone',
        databaseIndex: 0,
        database: 'app',
      })
      expect(r.success).toBe(false)
    })

    it('rejects schema', () => {
      const r = PublicRedisSummarySchema.safeParse({
        id: REDIS_ID,
        name: 'r',
        address: '192.0.2.30',
        port: 6379,
        topology: 'standalone',
        databaseIndex: 0,
        schema: 'public',
      })
      expect(r.success).toBe(false)
    })

    it('rejects mode', () => {
      const r = PublicRedisSummarySchema.safeParse({
        id: REDIS_ID,
        name: 'r',
        address: '192.0.2.30',
        port: 6379,
        topology: 'standalone',
        databaseIndex: 0,
        mode: 'inspection',
      })
      expect(r.success).toBe(false)
    })

    it('still keeps an unknown future field', () => {
      const r = PublicRedisSummarySchema.safeParse({
        id: REDIS_ID,
        name: 'r',
        address: '192.0.2.30',
        port: 6379,
        topology: 'standalone',
        databaseIndex: 0,
        futureRedisHint: 'pool-max=4',
      })
      expect(r.success).toBe(true)
      if (r.success) {
        const data = r.data as { futureRedisHint?: string }
        expect(data.futureRedisHint).toBe('pool-max=4')
      }
    })
  })
})

// =========================================================================
// TLS
// =========================================================================

describe('ConnectionTlsSchema', () => {
  it('accepts TLS disabled with null fields', () => {
    const r = ConnectionTlsSchema.safeParse({
      enabled: false,
      serverName: null,
      caCertificate: null,
      clientCertificate: null,
      clientKeyCredentialId: null,
    })
    expect(r.success).toBe(true)
  })

  it('accepts TLS enabled with serverName', () => {
    const r = ConnectionTlsSchema.safeParse({
      enabled: true,
      serverName: 'db.example.test',
      caCertificate: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
      clientCertificate: null,
      clientKeyCredentialId: null,
    })
    expect(r.success).toBe(true)
  })

  it('rejects TLS enabled without serverName (hostname validation impossible)', () => {
    const r = ConnectionTlsSchema.safeParse({
      enabled: true,
      serverName: null,
      caCertificate: null,
      clientCertificate: null,
      clientKeyCredentialId: null,
    })
    expect(r.success).toBe(false)
  })

  it('preserves unknown persisted fields via passthrough', () => {
    const r = ConnectionTlsSchema.safeParse({
      enabled: false,
      serverName: null,
      caCertificate: null,
      clientCertificate: null,
      clientKeyCredentialId: null,
      pinnedPublicKeySha256: 'abc',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      const data = r.data as { pinnedPublicKeySha256?: string }
      expect(data.pinnedPublicKeySha256).toBe('abc')
    }
  })
})

// =========================================================================
// SqlConnectionSchema
// =========================================================================

describe('SqlConnectionSchema', () => {
  it.each(['mysql', 'mariadb', 'postgresql'] as const)(
    'accepts %s connection with engine-specific defaults',
    (engine) => {
      const defaultPort = engine === 'postgresql' ? 5432 : 3306
      const r = SqlConnectionSchema.safeParse({
        ...sqlBase,
        engine,
        port: defaultPort,
      })
      expect(r.success).toBe(true)
    },
  )

  it('rejects an out-of-range port', () => {
    expect(SqlConnectionSchema.safeParse({ ...sqlBase, port: 0 }).success).toBe(false)
    expect(SqlConnectionSchema.safeParse({ ...sqlBase, port: 70000 }).success).toBe(false)
    expect(SqlConnectionSchema.safeParse({ ...sqlBase, port: 5432.5 }).success).toBe(false)
  })

  it('rejects a kind value other than database', () => {
    const r = SqlConnectionSchema.safeParse({ ...sqlBase, kind: 'redis' })
    expect(r.success).toBe(false)
  })

  it('rejects empty database name', () => {
    expect(SqlConnectionSchema.safeParse({ ...sqlBase, database: '' }).success).toBe(false)
  })

  it('accepts null schema (mysql/mariadb have no schema concept)', () => {
    const r = SqlConnectionSchema.safeParse({ ...sqlBase, engine: 'mysql', schema: null })
    expect(r.success).toBe(true)
  })

  it('rejects an unknown engine on a sql connection', () => {
    const r = SqlConnectionSchema.safeParse({ ...sqlBase, engine: 'sqlite' })
    expect(r.success).toBe(false)
  })

  it('rejects duplicate tag ids', () => {
    const r = SqlConnectionSchema.safeParse({ ...sqlBase, tagIds: [TAG_DB, TAG_DB] })
    expect(r.success).toBe(false)
  })

  it('rejects an invalid address (userinfo)', () => {
    const r = SqlConnectionSchema.safeParse({ ...sqlBase, address: 'root@db.example.test' })
    expect(r.success).toBe(false)
  })

  it('rejects hostname:port address', () => {
    const r = SqlConnectionSchema.safeParse({ ...sqlBase, address: 'db.example.test:5432' })
    expect(r.success).toBe(false)
  })
})

// =========================================================================
// RedisConnectionSchema
// =========================================================================

describe('RedisConnectionSchema', () => {
  it('accepts a standalone redis at default port 6379', () => {
    const r = RedisConnectionSchema.safeParse(redisBase)
    expect(r.success).toBe(true)
  })

  it('rejects a topology other than standalone', () => {
    const r = RedisConnectionSchema.safeParse({ ...redisBase, topology: 'sentinel' })
    expect(r.success).toBe(false)
    const r2 = RedisConnectionSchema.safeParse({ ...redisBase, topology: 'cluster' })
    expect(r2.success).toBe(false)
  })

  it('rejects a databaseIndex out of 0-15', () => {
    expect(
      RedisConnectionSchema.safeParse({ ...redisBase, databaseIndex: -1 }).success,
    ).toBe(false)
    expect(
      RedisConnectionSchema.safeParse({ ...redisBase, databaseIndex: 16 }).success,
    ).toBe(false)
    expect(
      RedisConnectionSchema.safeParse({ ...redisBase, databaseIndex: 1.5 }).success,
    ).toBe(false)
  })

  it('rejects a redis kind value other than redis', () => {
    const r = RedisConnectionSchema.safeParse({ ...redisBase, kind: 'database' })
    expect(r.success).toBe(false)
  })

  it('rejects an invalid address (path)', () => {
    const r = RedisConnectionSchema.safeParse({ ...redisBase, address: '192.0.2.30/path' })
    expect(r.success).toBe(false)
  })
})

// =========================================================================
// DataConnectionSchema (discriminated union)
// =========================================================================

describe('DataConnectionSchema (discriminated union)', () => {
  it('accepts both sql and redis connections', () => {
    expect(DataConnectionSchema.safeParse(sqlBase).success).toBe(true)
    expect(DataConnectionSchema.safeParse(redisBase).success).toBe(true)
  })

  it('rejects a connection without a discriminator', () => {
    const noKind = { ...sqlBase } as Record<string, unknown>
    delete noKind.kind
    expect(DataConnectionSchema.safeParse(noKind).success).toBe(false)
  })

  it('rejects a sql connection that is missing engine', () => {
    const broken = { ...sqlBase } as Record<string, unknown>
    delete broken.engine
    expect(DataConnectionSchema.safeParse(broken).success).toBe(false)
  })

  it('rejects a redis connection that is missing databaseIndex', () => {
    const broken = { ...redisBase } as Record<string, unknown>
    delete broken.databaseIndex
    expect(DataConnectionSchema.safeParse(broken).success).toBe(false)
  })

  it('rejects an unknown kind value', () => {
    const r = DataConnectionSchema.safeParse({ ...sqlBase, kind: 'kafka' as never })
    expect(r.success).toBe(false)
  })

  it('preserves unknown fields on the union result', () => {
    const r = DataConnectionSchema.safeParse({
      ...sqlBase,
      customDriverHint: 'pool-min=2',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      const data = r.data as DataConnection & { customDriverHint?: string }
      expect(data.customDriverHint).toBe('pool-min=2')
    }
  })

  it('rejects SQL connection that smuggles a Redis-only databaseIndex', () => {
    const r = DataConnectionSchema.safeParse({
      ...sqlBase,
      databaseIndex: 0,
    })
    expect(r.success).toBe(false)
  })

  it('rejects Redis connection that smuggles an SQL-only engine', () => {
    const r = DataConnectionSchema.safeParse({
      ...redisBase,
      engine: 'mysql',
    })
    expect(r.success).toBe(false)
  })
})

// =========================================================================
// Type-only usage so unused type imports stay meaningful
// =========================================================================

void ({} as ConnectionBase)
void ({} as DatabaseEngine)
void ({} as RedisTopology)
void ({} as ConnectionMode)
void ({} as ConnectionEnvironment)
