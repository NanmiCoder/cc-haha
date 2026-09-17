import type { DataConnection } from '../../../src/features/managed-resources/types/dataConnectionTypes.js'
import type {
  CreateDataConnectionInput,
  DataConnectionTestResult,
} from '../../../src/features/managed-resources/api/dataConnectionsApi.js'
import type { ResourceDocumentStore } from './repositories/resourceDocumentStore.js'
import type { CredentialVault, CredentialSecretPayload } from './vault/credentialVault.js'

const CONNECT_TIMEOUT_MS = 10_000
const TEST_TIMEOUT_MS = 15_000

type MysqlConnection = {
  query(sql: string): Promise<[unknown, unknown]>
  end(): Promise<void>
}

type PgClient = {
  connect(): Promise<void>
  query(sql: string): Promise<{ rows?: unknown[] }>
  end(): Promise<void>
}

type RedisClient = {
  on(event: 'error', listener: (error: unknown) => void): unknown
  connect(): Promise<unknown>
  sendCommand(args: string[]): Promise<unknown>
  quit(): Promise<unknown>
  disconnect(): void
}

export type DataConnectionDriverLoader = {
  mysqlCreateConnection(config: Record<string, unknown>): Promise<MysqlConnection>
  createPostgresClient(config: Record<string, unknown>): PgClient
  createRedisClient(config: Record<string, unknown>): RedisClient
}

export type DataConnectionRuntime = {
  testConnection(input: DataConnection | CreateDataConnectionInput): Promise<DataConnectionTestResult>
}

export type DataConnectionRuntimeOptions = {
  store: ResourceDocumentStore
  vault: CredentialVault
  drivers?: DataConnectionDriverLoader
  now?: () => number
}

async function defaultDrivers(): Promise<DataConnectionDriverLoader> {
  const [mysqlModule, pgModule, redisModule] = await Promise.all([
    import('mysql2/promise'),
    import('pg'),
    import('@redis/client'),
  ])
  return {
    mysqlCreateConnection: config => mysqlModule.createConnection(config as any) as unknown as Promise<MysqlConnection>,
    createPostgresClient: config => new pgModule.Client(config as any) as unknown as PgClient,
    createRedisClient: config => redisModule.createClient(config as any) as unknown as RedisClient,
  }
}

function sanitizedErrorCode(error: unknown): string {
  const code = typeof (error as { code?: unknown })?.code === 'string'
    ? String((error as { code: string }).code).toUpperCase()
    : ''
  if (code.includes('AUTH') || code === '28P01' || code === 'ER_ACCESS_DENIED_ERROR' || code === 'WRONGPASS') return 'AUTH_FAILED'
  if (code.includes('TIMEOUT') || code === 'ETIMEDOUT') return 'CONNECT_TIMEOUT'
  if (code.includes('CERT') || code.includes('TLS') || code.includes('SSL')) return 'TLS_FAILED'
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'CONNECT_FAILED'
  return 'CONNECTION_FAILED'
}

function versionFromMysqlRows(rows: unknown): string | null {
  if (!Array.isArray(rows) || rows.length === 0) return null
  const first = rows[0]
  if (!first || typeof first !== 'object') return null
  for (const value of Object.values(first as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim()) return value.slice(0, 240)
  }
  return null
}

function versionFromPostgresRows(rows: unknown[] | undefined): string | null {
  const first = rows?.[0]
  if (!first || typeof first !== 'object') return null
  const value = (first as Record<string, unknown>).version
  return typeof value === 'string' ? value.slice(0, 240) : null
}

function versionFromRedisInfo(info: unknown): string | null {
  if (typeof info !== 'string') return null
  const match = /^redis_version:([^\r\n]+)/m.exec(info)
  return match?.[1]?.trim().slice(0, 240) ?? null
}

function timeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error('connection test timeout') as Error & { code?: string }
      error.code = 'ETIMEDOUT'
      reject(error)
    }, TEST_TIMEOUT_MS)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

function findCredentialRecord(document: Awaited<ReturnType<ResourceDocumentStore['load']>>, id: string) {
  if (document.status !== 'ready') return null
  return document.document.credentials.find(record => record.id === id) ?? null
}

async function credentialSecret(
  store: ResourceDocumentStore,
  vault: CredentialVault,
  credentialId: string | null,
): Promise<CredentialSecretPayload | null> {
  if (!credentialId) return null
  const loaded = await store.load()
  const record = findCredentialRecord(loaded, credentialId)
  if (!record) throw Object.assign(new Error('credential missing'), { code: 'CREDENTIAL_UNAVAILABLE' })
  const revealed = vault.decrypt(record)
  if (revealed.status !== 'decrypted') throw Object.assign(new Error('credential unavailable'), { code: revealed.code })
  return revealed.payload
}

export async function runtimeSecrets(
  input: DataConnection | CreateDataConnectionInput,
  store: ResourceDocumentStore,
  vault: CredentialVault,
): Promise<{ password: string | null; tlsKey: string | null; tlsPassphrase: string | null }> {
  const inlinePassword = 'password' in input && typeof input.password === 'string' ? input.password : null
  let password = inlinePassword
  if (!password && input.credentialId) {
    const secret = await credentialSecret(store, vault, input.credentialId)
    if (secret && 'password' in secret) password = secret.password
  }

  let tlsKey: string | null = null
  let tlsPassphrase: string | null = null
  if (input.tls.clientKeyCredentialId) {
    const secret = await credentialSecret(store, vault, input.tls.clientKeyCredentialId)
    if (!secret || !('privateKeyPem' in secret)) {
      throw Object.assign(new Error('tls client key unavailable'), { code: 'CREDENTIAL_UNAVAILABLE' })
    }
    tlsKey = secret.privateKeyPem
    tlsPassphrase = secret.passphrase ?? null
  }
  return { password, tlsKey, tlsPassphrase }
}

export function tlsOptions(
  input: DataConnection | CreateDataConnectionInput,
  secrets: { tlsKey: string | null; tlsPassphrase: string | null },
): Record<string, unknown> | undefined {
  if (!input.tls.enabled) return undefined
  return {
    rejectUnauthorized: true,
    servername: input.tls.serverName ?? undefined,
    ca: input.tls.caCertificate ?? undefined,
    cert: input.tls.clientCertificate ?? undefined,
    key: secrets.tlsKey ?? undefined,
    passphrase: secrets.tlsPassphrase ?? undefined,
  }
}

export function createDataConnectionRuntime(options: DataConnectionRuntimeOptions): DataConnectionRuntime {
  const now = options.now ?? (() => Date.now())
  let driversPromise: Promise<DataConnectionDriverLoader> | null = null
  const getDrivers = () => options.drivers
    ? Promise.resolve(options.drivers)
    : (driversPromise ??= defaultDrivers())

  return {
    async testConnection(input) {
      const startedAt = now()
      let close: (() => Promise<void>) | null = null
      try {
        const [drivers, secrets] = await Promise.all([
          getDrivers(),
          runtimeSecrets(input, options.store, options.vault),
        ])
        const tls = tlsOptions(input, secrets)
        let serverVersion: string | null = null

        if (input.kind === 'database' && (input.engine === 'mysql' || input.engine === 'mariadb')) {
          const connection = await timeout(drivers.mysqlCreateConnection({
            host: input.address,
            port: input.port,
            user: input.username ?? undefined,
            password: secrets.password ?? undefined,
            database: input.database,
            connectTimeout: CONNECT_TIMEOUT_MS,
            ...(tls ? { ssl: tls } : {}),
          }))
          close = async () => { await connection.end() }
          const [rows] = await timeout(connection.query('SELECT VERSION() AS version'))
          serverVersion = versionFromMysqlRows(rows)
        } else if (input.kind === 'database') {
          const client = drivers.createPostgresClient({
            host: input.address,
            port: input.port,
            user: input.username ?? undefined,
            password: secrets.password ?? undefined,
            database: input.database,
            connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
            statement_timeout: CONNECT_TIMEOUT_MS,
            ...(tls ? { ssl: tls } : {}),
          })
          close = async () => { await client.end() }
          await timeout(client.connect())
          const result = await timeout(client.query('SELECT version() AS version'))
          serverVersion = versionFromPostgresRows(result.rows)
        } else {
          const redis = drivers.createRedisClient({
            socket: {
              host: input.address,
              port: input.port,
              connectTimeout: CONNECT_TIMEOUT_MS,
              ...(tls ? { tls: true, ...tls } : {}),
            },
            username: input.username ?? undefined,
            password: secrets.password ?? undefined,
            database: input.databaseIndex,
          })
          redis.on('error', () => undefined)
          close = async () => {
            try { await redis.quit() } catch { redis.disconnect() }
          }
          await timeout(redis.connect())
          const info = await timeout(redis.sendCommand(['INFO', 'server']))
          serverVersion = versionFromRedisInfo(info)
        }

        return {
          ok: true,
          latencyMs: Math.max(0, now() - startedAt),
          serverVersion,
          errorCode: null,
        }
      } catch (error) {
        return {
          ok: false,
          latencyMs: Math.max(0, now() - startedAt),
          serverVersion: null,
          errorCode: sanitizedErrorCode(error),
        }
      } finally {
        if (close) await close().catch(() => undefined)
      }
    },
  }
}
