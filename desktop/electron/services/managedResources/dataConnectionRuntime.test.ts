import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createResourceDocumentStore } from './repositories/resourceDocumentStore.js'
import { createResourceLibraryService } from './repositories/resourceLibraryService.js'
import { createCredentialVault, type SafeStorageAdapter } from './vault/credentialVault.js'
import { createDataConnectionRuntime, type DataConnectionDriverLoader } from './dataConnectionRuntime.js'

const tempDirs: string[] = []

function safeStorage(): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => true,
    encryptString: text => Buffer.from(`sealed:${text}`, 'utf8'),
    decryptString: encrypted => encrypted.toString('utf8').slice('sealed:'.length),
  }
}

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'm9-runtime-'))
  tempDirs.push(dir)
  const store = createResourceDocumentStore({ activeConfigDir: dir })
  const vault = createCredentialVault({ safeStorage: safeStorage() })
  const library = createResourceLibraryService({ store, vault })
  return { store, vault, library }
}

function base(kind: 'database' | 'redis') {
  return {
    name: `${kind}-test`,
    address: '127.0.0.1',
    port: kind === 'database' ? 3306 : 6379,
    username: 'app',
    credentialId: null,
    tagIds: [],
    relatedHostId: null,
    environment: 'test' as const,
    tls: {
      enabled: true,
      serverName: 'service.internal',
      caCertificate: 'FAKE_CA',
      clientCertificate: null,
      clientKeyCredentialId: null,
    },
    description: '',
    accessInstructions: '',
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

describe('M9 data connection runtime', () => {
  it('tests a saved MySQL connection using the vault secret, TLS verification, and closes the driver', async () => {
    const { store, vault, library } = await setup()
    const created = await library.createDataConnection({
      ...base('database'),
      kind: 'database',
      engine: 'mysql',
      database: 'appdb',
      schema: null,
      mode: 'inspection',
      password: 'fake-db-password',
    })
    expect(created.status).toBe('created')
    if (created.status !== 'created') return

    const end = vi.fn(async () => undefined)
    const query = vi.fn(async () => [[{ version: '8.0.fake' }], []] as [unknown, unknown])
    const mysqlCreateConnection = vi.fn(async () => ({ query, end }))
    const drivers: DataConnectionDriverLoader = {
      mysqlCreateConnection,
      createPostgresClient: () => { throw new Error('postgres not expected') },
      createRedisClient: () => { throw new Error('redis not expected') },
    }
    const runtime = createDataConnectionRuntime({ store, vault, drivers, now: (() => {
      let value = 10
      return () => value += 5
    })() })

    const result = await runtime.testConnection(created.value)
    expect(result).toEqual({ ok: true, latencyMs: 5, serverVersion: '8.0.fake', errorCode: null })
    expect(mysqlCreateConnection).toHaveBeenCalledWith(expect.objectContaining({
      host: '127.0.0.1',
      port: 3306,
      user: 'app',
      password: 'fake-db-password',
      database: 'appdb',
      ssl: expect.objectContaining({ rejectUnauthorized: true, servername: 'service.internal', ca: 'FAKE_CA' }),
    }))
    expect(query).toHaveBeenCalledWith('SELECT VERSION() AS version')
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('tests unsaved PostgreSQL and Redis drafts with inline passwords without persisting them', async () => {
    const { store, vault } = await setup()
    const pgConfig: Record<string, unknown>[] = []
    const redisConfig: Record<string, unknown>[] = []
    const pgEnd = vi.fn(async () => undefined)
    const redisQuit = vi.fn(async () => 'OK')
    const drivers: DataConnectionDriverLoader = {
      mysqlCreateConnection: async () => { throw new Error('mysql not expected') },
      createPostgresClient: config => {
        pgConfig.push(config)
        return {
          connect: async () => undefined,
          query: async () => ({ rows: [{ version: 'PostgreSQL fake' }] }),
          end: pgEnd,
        }
      },
      createRedisClient: config => {
        redisConfig.push(config)
        return {
          on: () => undefined,
          connect: async () => undefined,
          sendCommand: async () => 'redis_version:7.2.fake\r\n',
          quit: redisQuit,
          disconnect: () => undefined,
        }
      },
    }
    const runtime = createDataConnectionRuntime({ store, vault, drivers, now: () => 100 })
    const postgres = await runtime.testConnection({
      ...base('database'),
      kind: 'database', engine: 'postgresql', port: 5432, database: 'appdb', schema: 'public', mode: 'query',
      password: 'inline-pg-password',
    })
    const redis = await runtime.testConnection({
      ...base('redis'),
      kind: 'redis', topology: 'standalone', databaseIndex: 2, keyPrefixDescription: '',
      password: 'inline-redis-password',
    })

    expect(postgres).toMatchObject({ ok: true, serverVersion: 'PostgreSQL fake' })
    expect(redis).toMatchObject({ ok: true, serverVersion: '7.2.fake' })
    expect(pgConfig[0]).toMatchObject({ password: 'inline-pg-password', ssl: { rejectUnauthorized: true } })
    expect(redisConfig[0]).toMatchObject({ password: 'inline-redis-password', database: 2 })
    expect(pgEnd).toHaveBeenCalledTimes(1)
    expect(redisQuit).toHaveBeenCalledTimes(1)

    const loaded = await store.load()
    expect(loaded.status).toBe('ready')
    if (loaded.status === 'ready') {
      expect(loaded.document.dataConnections).toEqual([])
      expect(loaded.document.credentials).toEqual([])
    }
  })

  it('returns a structured error and still closes after a driver query failure without exposing the raw message', async () => {
    const { store, vault } = await setup()
    const end = vi.fn(async () => undefined)
    const failure = Object.assign(new Error('password=fake-secret host=db.internal'), { code: 'ER_ACCESS_DENIED_ERROR' })
    const drivers: DataConnectionDriverLoader = {
      mysqlCreateConnection: async () => ({
        query: async () => { throw failure },
        end,
      }),
      createPostgresClient: () => { throw new Error('not expected') },
      createRedisClient: () => { throw new Error('not expected') },
    }
    const runtime = createDataConnectionRuntime({ store, vault, drivers, now: () => 1 })
    const result = await runtime.testConnection({
      ...base('database'),
      kind: 'database', engine: 'mysql', database: 'appdb', schema: null, mode: 'inspection',
      password: 'fake-secret',
    })
    expect(result).toEqual({ ok: false, latencyMs: 0, serverVersion: null, errorCode: 'AUTH_FAILED' })
    expect(JSON.stringify(result)).not.toContain('fake-secret')
    expect(JSON.stringify(result)).not.toContain('db.internal')
    expect(end).toHaveBeenCalledTimes(1)
  })
})
