import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createResourceDocumentStore } from './repositories/resourceDocumentStore.js'
import { createResourceLibraryService } from './repositories/resourceLibraryService.js'
import {
  createDataBrowserService,
  type DataBrowserAdapterFactory,
  type RedisBrowserAdapter,
  type SqlBrowserAdapter,
  type SqlRawBatch,
} from './dataBrowserService.js'
import type { DataConnection } from '../../../src/features/managed-resources/types/dataConnectionTypes.js'

const tempDirs: string[] = []
const OWNER = 'owner-a'

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'm10-browser-'))
  tempDirs.push(dir)
  const store = createResourceDocumentStore({ activeConfigDir: dir })
  const library = createResourceLibraryService({ store })
  return { store, library }
}

function common(kind: 'database' | 'redis') {
  return {
    name: `${kind}-fixture`,
    address: '127.0.0.1',
    port: kind === 'database' ? 5432 : 6379,
    username: kind === 'database' ? 'reader' : 'default',
    credentialId: null,
    tagIds: [],
    relatedHostId: null,
    environment: 'test' as const,
    tls: { enabled: false, serverName: null, caCertificate: null, clientCertificate: null, clientKeyCredentialId: null },
    description: '',
    accessInstructions: '',
  }
}

async function databaseFixture(library: Awaited<ReturnType<typeof setup>>['library'], mode: 'inspection' | 'query' = 'query') {
  const result = await library.createDataConnection({
    ...common('database'), kind: 'database', engine: 'postgresql', database: 'appdb', schema: 'public', mode,
  })
  if (result.status !== 'created') throw new Error(`db fixture: ${JSON.stringify(result)}`)
  return result.value
}

async function redisFixture(library: Awaited<ReturnType<typeof setup>>['library']) {
  const result = await library.createDataConnection({
    ...common('redis'), kind: 'redis', topology: 'standalone', databaseIndex: 0, keyPrefixDescription: '',
  })
  if (result.status !== 'created') throw new Error(`redis fixture: ${JSON.stringify(result)}`)
  return result.value
}

function sqlAdapter(overrides: Partial<SqlBrowserAdapter> = {}): SqlBrowserAdapter {
  return {
    listDatabases: async () => [{ name: 'appdb' }],
    listSchemas: async () => [{ name: 'public' }],
    listTables: async schema => [{ schema, name: 'orders', kind: 'table' }],
    describeTable: async (schema, table) => ({ table: { schema, name: table, kind: 'table' }, columns: [{ ordinal: 1, name: 'id', dataType: 'bigint', nullable: false }] }),
    previewTable: async function* () { yield { columns: [{ name: 'id', dataType: 'bigint' }], rows: [['1']] } },
    executeQuery: async function* () { yield { columns: [{ name: 'ok', dataType: 'text' }], rows: [['ok']] } },
    close: async () => undefined,
    ...overrides,
  }
}

function redisAdapter(overrides: Partial<RedisBrowserAdapter> = {}): RedisBrowserAdapter {
  return {
    scan: async () => ({ cursor: '0', keys: [] }),
    type: async () => 'string',
    ttl: async () => -1,
    readString: async () => ({ value: Buffer.from('value'), byteLength: 5 }),
    scanHash: async () => ({ cursor: '0', entries: [] }),
    readList: async () => [],
    scanSet: async () => ({ cursor: '0', values: [] }),
    scanZSet: async () => ({ cursor: '0', values: [] }),
    readStream: async () => ({ nextCursor: null, values: [] }),
    close: async () => undefined,
    ...overrides,
  }
}

function factory(map: Map<string, SqlBrowserAdapter | RedisBrowserAdapter>): DataBrowserAdapterFactory {
  return {
    async open(connection: DataConnection) {
      const adapter = map.get(connection.id)
      if (!adapter) throw new Error('missing fake adapter')
      return connection.kind === 'database'
        ? { kind: 'database' as const, sql: adapter as SqlBrowserAdapter }
        : { kind: 'redis' as const, redis: adapter as RedisBrowserAdapter }
    },
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

describe('M10 data browser service — session binding', () => {
  it('binds every operation to owner, connection revision and generation', async () => {
    const { store, library } = await setup()
    const db = await databaseFixture(library)
    const close = vi.fn(async () => undefined)
    const adapters = new Map([[db.id, sqlAdapter({ close })]])
    const service = createDataBrowserService({ store, adapters: factory(adapters), createId: () => '11111111-1111-4111-8111-111111111111' })

    const stale = await service.openConnection({ ownerId: OWNER, connectionId: db.id, expectedRevision: db.revision + 1 })
    expect(stale).toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } })

    const opened = await service.openConnection({ ownerId: OWNER, connectionId: db.id, expectedRevision: db.revision })
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    expect(await service.listSchemas({ ownerId: 'owner-b', dataSessionId: opened.data.dataSessionId, generation: 1 })).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED_OWNER' } })
    expect(await service.listSchemas({ ownerId: OWNER, dataSessionId: opened.data.dataSessionId, generation: 2 })).toMatchObject({ ok: false, error: { code: 'STALE_GENERATION' } })
    expect(await service.listDatabases({ ownerId: OWNER, dataSessionId: opened.data.dataSessionId, generation: 1 })).toEqual({ ok: true, data: [{ name: 'appdb' }] })

    expect(await service.closeConnection({ ownerId: OWNER, dataSessionId: opened.data.dataSessionId, generation: 1 })).toEqual({ ok: true, data: { closed: true } })
    expect(close).toHaveBeenCalledTimes(1)
    expect(await service.listDatabases({ ownerId: OWNER, dataSessionId: opened.data.dataSessionId, generation: 1 })).toMatchObject({ ok: false, error: { code: 'RESOURCE_NOT_FOUND' } })
  })
})

describe('M10 data browser service — bounded SQL', () => {
  it('preserves duplicate columns and losslessly normalizes bigint, decimal, dates, NULL and binary while enforcing the row limit', async () => {
    const { store, library } = await setup()
    const db = await databaseFixture(library)
    const query = sqlAdapter({
      executeQuery: async function* (): AsyncIterable<SqlRawBatch> {
        yield {
          columns: [
            { name: 'id', dataType: 'bigint' },
            { name: 'id', dataType: 'numeric' },
            { name: 'when', dataType: 'timestamp' },
            { name: 'payload', dataType: 'bytea' },
            { name: 'nullable', dataType: 'text' },
          ],
          rows: [
            [9007199254740993n, '1234567890.0123456789', new Date('2026-09-13T00:00:00.000Z'), Buffer.from([0, 255]), null],
            [2n, '2.50', new Date('2026-09-13T01:00:00.000Z'), Buffer.from('x'), null],
            [3n, '3.50', new Date('2026-09-13T02:00:00.000Z'), Buffer.from('y'), null],
          ],
        }
      },
    })
    const service = createDataBrowserService({ store, adapters: factory(new Map([[db.id, query]])), createId: (() => { let n = 0; return () => `11111111-1111-4111-8111-${String(++n).padStart(12, '0')}` })() })
    const opened = await service.openConnection({ ownerId: OWNER, connectionId: db.id, expectedRevision: db.revision })
    if (!opened.ok) throw new Error('open failed')

    const result = await service.executeQuery({
      ownerId: OWNER, dataSessionId: opened.data.dataSessionId, generation: 1,
      queryId: '22222222-2222-4222-8222-222222222222', sql: 'select * from orders', maxRows: 2,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.columns.map(column => [column.index, column.name])).toEqual([[0, 'id'], [1, 'id'], [2, 'when'], [3, 'payload'], [4, 'nullable']])
    expect(result.data.rows).toHaveLength(2)
    expect(result.data.truncated).toBe(true)
    expect(result.data.rows[0]).toEqual([
      { kind: 'bigint', value: '9007199254740993' },
      { kind: 'decimal', value: '1234567890.0123456789' },
      { kind: 'date', value: '2026-09-13T00:00:00.000Z' },
      { kind: 'binary', base64Preview: 'AP8=', byteLength: 2, truncated: false },
      { kind: 'null' },
    ])
  })

  it('does not allow arbitrary SQL in inspection mode but still allows bounded table preview', async () => {
    const { store, library } = await setup()
    const db = await databaseFixture(library, 'inspection')
    const previewTable = vi.fn(async function* () { yield { columns: [{ name: 'id', dataType: 'bigint' }], rows: [['1']] } })
    const service = createDataBrowserService({ store, adapters: factory(new Map([[db.id, sqlAdapter({ previewTable })]])), createId: () => '11111111-1111-4111-8111-111111111111' })
    const opened = await service.openConnection({ ownerId: OWNER, connectionId: db.id, expectedRevision: db.revision })
    if (!opened.ok) throw new Error('open failed')

    const arbitrary = await service.executeQuery({ ownerId: OWNER, dataSessionId: opened.data.dataSessionId, generation: 1, queryId: '22222222-2222-4222-8222-222222222222', sql: 'delete from orders' })
    expect(arbitrary).toMatchObject({ ok: false, error: { code: 'QUERY_MODE_REQUIRED' } })
    const preview = await service.previewTable({ ownerId: OWNER, dataSessionId: opened.data.dataSessionId, generation: 1, schema: 'public', table: 'orders', limit: 25 })
    expect(preview).toMatchObject({ ok: true, data: { rowCount: 1, truncated: false } })
    expect(previewTable).toHaveBeenCalledWith(expect.objectContaining({ schema: 'public', table: 'orders', limit: 25 }))
  })

  it('cancels only the query bound to the same data session and reports server outcome truthfully', async () => {
    const { store, library } = await setup()
    const dbA = await databaseFixture(library)
    const dbB = await databaseFixture(library)
    let release: (() => void) | null = null
    const executeQuery = async function* ({ signal }: { signal: AbortSignal }) {
      yield { columns: [{ name: 'id', dataType: 'bigint' }], rows: [] }
      await new Promise<void>((resolve, reject) => {
        release = resolve
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      yield { rows: [['1']] }
    }
    const cancelA = vi.fn(async () => true)
    const service = createDataBrowserService({
      store,
      adapters: factory(new Map([
        [dbA.id, sqlAdapter({ executeQuery: executeQuery as SqlBrowserAdapter['executeQuery'], cancelQuery: cancelA })],
        [dbB.id, sqlAdapter()],
      ])),
      createId: (() => { let n = 0; return () => `11111111-1111-4111-8111-${String(++n).padStart(12, '0')}` })(),
    })
    const openedA = await service.openConnection({ ownerId: OWNER, connectionId: dbA.id, expectedRevision: dbA.revision })
    const openedB = await service.openConnection({ ownerId: OWNER, connectionId: dbB.id, expectedRevision: dbB.revision })
    if (!openedA.ok || !openedB.ok) throw new Error('open failed')
    const queryId = '22222222-2222-4222-8222-222222222222'
    const pending = service.executeQuery({ ownerId: OWNER, dataSessionId: openedA.data.dataSessionId, generation: 1, queryId, sql: 'select pg_sleep(30)' })
    for (let i = 0; i < 100 && release === null; i += 1) await new Promise(resolve => setTimeout(resolve, 1))
    expect(release).not.toBeNull()

    expect(await service.cancelQuery({ ownerId: OWNER, dataSessionId: openedB.data.dataSessionId, generation: 1, queryId })).toMatchObject({ ok: false, error: { code: 'RESOURCE_NOT_FOUND' } })
    expect(await service.cancelQuery({ ownerId: OWNER, dataSessionId: openedA.data.dataSessionId, generation: 1, queryId })).toEqual({ ok: true, data: { queryId, localStopped: true, serverCancelled: true, outcomeUnknown: false } })
    expect(await pending).toMatchObject({ ok: false, error: { code: 'QUERY_CANCELLED' } })
    expect(cancelA).toHaveBeenCalledWith(queryId)
  })

  it('limits concurrent queries to two per data session', async () => {
    const { store, library } = await setup()
    const db = await databaseFixture(library)
    const releases: Array<() => void> = []
    const executeQuery = async function* ({ signal }: { signal: AbortSignal }) {
      yield { columns: [{ name: 'id', dataType: 'bigint' }], rows: [] }
      await new Promise<void>((resolve, reject) => {
        releases.push(resolve)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      yield { rows: [['1']] }
    }
    const service = createDataBrowserService({
      store,
      adapters: factory(new Map([[db.id, sqlAdapter({ executeQuery: executeQuery as SqlBrowserAdapter['executeQuery'] })]])),
      createId: () => '11111111-1111-4111-8111-111111111111',
    })
    const opened = await service.openConnection({ ownerId: OWNER, connectionId: db.id, expectedRevision: db.revision })
    if (!opened.ok) throw new Error('open failed')
    const base = { ownerId: OWNER, dataSessionId: opened.data.dataSessionId, generation: 1, sql: 'select 1' }
    const first = service.executeQuery({ ...base, queryId: '10000000-0000-4000-8000-000000000001' })
    const second = service.executeQuery({ ...base, queryId: '10000000-0000-4000-8000-000000000002' })
    for (let i = 0; i < 100 && releases.length < 2; i += 1) await new Promise(resolve => setTimeout(resolve, 1))
    expect(releases).toHaveLength(2)

    const third = await service.executeQuery({ ...base, queryId: '10000000-0000-4000-8000-000000000003' })
    expect(third).toMatchObject({ ok: false, error: { code: 'QUERY_LIMIT_REACHED' } })
    releases.forEach(release => release())
    expect((await first).ok).toBe(true)
    expect((await second).ok).toBe(true)
  })
})

describe('M10 bounded lifecycle under uncooperative drivers', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
  }
  async function bounded<T>(promise: Promise<T>): Promise<T | 'did-not-settle'> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([promise, new Promise<'did-not-settle'>(resolve => { timer = setTimeout(() => resolve('did-not-settle'), 300) })])
    } finally { clearTimeout(timer) }
  }

  it('returns QUERY_TIMEOUT even if a driver ignores AbortSignal and iterator.return', async () => {
    const { store, library } = await setup()
    const db = await databaseFixture(library)
    const never = deferred<IteratorResult<SqlRawBatch>>()
    const source: AsyncIterable<SqlRawBatch> = { [Symbol.asyncIterator]: () => ({ next: () => never.promise, return: () => never.promise }) }
    const service = createDataBrowserService({ store, adapters: factory(new Map([[db.id, sqlAdapter({ executeQuery: () => source })]])) })
    const opened = await service.openConnection({ ownerId: OWNER, connectionId: db.id, expectedRevision: db.revision })
    if (!opened.ok) throw new Error('open failed')
    const pending = service.executeQuery({ ownerId: OWNER, dataSessionId: opened.data.dataSessionId, generation: 1, queryId: crypto.randomUUID(), sql: 'select fixture', timeoutMs: 10 })
    try { expect(await bounded(pending)).toMatchObject({ ok: false, error: { code: 'QUERY_TIMEOUT' } }) }
    finally { never.resolve({ done: true, value: undefined }); await pending; await service.dispose() }
  })

  it('closes rather than registers a driver whose owner was disposed during open', async () => {
    const { store, library } = await setup()
    const db = await databaseFixture(library)
    const gate = deferred<void>()
    const started = deferred<void>()
    const close = vi.fn(async () => undefined)
    const service = createDataBrowserService({ store, adapters: { async open() { started.resolve(); await gate.promise; return { kind: 'database', sql: sqlAdapter({ close }) } } } })
    const pending = service.openConnection({ ownerId: OWNER, connectionId: db.id, expectedRevision: db.revision })
    await started.promise
    await service.disposeOwner(OWNER)
    gate.resolve()
    try {
      expect(await pending).toMatchObject({ ok: false, error: { code: 'SESSION_CLOSED' } })
      expect(close).toHaveBeenCalledTimes(1)
    } finally { await service.dispose() }
  })

  it('cancels an active preview on close without waiting for the next driver batch', async () => {
    const { store, library } = await setup()
    const db = await databaseFixture(library)
    const never = deferred<IteratorResult<SqlRawBatch>>()
    const started = deferred<void>()
    const source: AsyncIterable<SqlRawBatch> = { [Symbol.asyncIterator]: () => ({ next: () => { started.resolve(); return never.promise } }) }
    const service = createDataBrowserService({ store, adapters: factory(new Map([[db.id, sqlAdapter({ previewTable: () => source })]])) })
    const opened = await service.openConnection({ ownerId: OWNER, connectionId: db.id, expectedRevision: db.revision })
    if (!opened.ok) throw new Error('open failed')
    const session = { ownerId: OWNER, dataSessionId: opened.data.dataSessionId, generation: 1 }
    const pending = service.previewTable({ ...session, schema: 'public', table: 'orders' })
    await started.promise
    await service.closeConnection(session)
    try { expect(await bounded(pending)).toMatchObject({ ok: false, error: { code: 'QUERY_CANCELLED' } }) }
    finally { never.resolve({ done: true, value: undefined }); await pending; await service.dispose() }
  })

  it('does not report a failed driver close as success and allows a cleanup retry', async () => {
    const { store, library } = await setup()
    const db = await databaseFixture(library)
    const close = vi.fn().mockRejectedValueOnce(new Error('fixture-close-failure')).mockResolvedValue(undefined)
    const service = createDataBrowserService({ store, adapters: factory(new Map([[db.id, sqlAdapter({ close })]])) })
    const opened = await service.openConnection({ ownerId: OWNER, connectionId: db.id, expectedRevision: db.revision })
    if (!opened.ok) throw new Error('open failed')
    const session = { ownerId: OWNER, dataSessionId: opened.data.dataSessionId, generation: 1 }
    try {
      expect(await service.closeConnection(session)).toMatchObject({ ok: false, error: { code: 'DISCONNECT_FAILED' } })
      expect(await service.listSchemas(session)).toMatchObject({ ok: false, error: { code: 'SESSION_CLOSED' } })
      expect(await service.closeConnection(session)).toMatchObject({ ok: true, data: { closed: true } })
    } finally { await service.dispose() }
  })
})

describe('M10 metadata and Redis lifecycle bounds', () => {
  it('does not let a pending metadata read return data after the connection closes', async () => {
    const { store, library } = await setup()
    const db = await databaseFixture(library)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const service = createDataBrowserService({ store, adapters: factory(new Map([[db.id, sqlAdapter({ listSchemas: async () => { await gate; return [{ name: 'late' }] } })]])) })
    const opened = await service.openConnection({ ownerId: OWNER, connectionId: db.id, expectedRevision: db.revision })
    if (!opened.ok) throw new Error('open failed')
    const session = { ownerId: OWNER, dataSessionId: opened.data.dataSessionId, generation: 1 }
    const pending = service.listSchemas(session)
    await service.closeConnection(session)
    release()
    expect(await pending).toMatchObject({ ok: false, error: { code: 'QUERY_CANCELLED' } })
  })

  it('rejects an oversized SCAN batch without invalidating previous key tokens', async () => {
    const { store, library } = await setup()
    const connection = await redisFixture(library)
    let oversized = false
    const adapter = redisAdapter({ scan: async () => ({ cursor: '0', keys: oversized ? Array.from({ length: 10_001 }, (_, i) => Buffer.from('key-' + i)) : [Buffer.from('retained')] }) })
    const service = createDataBrowserService({ store, adapters: factory(new Map([[connection.id, adapter]])) })
    const opened = await service.openConnection({ ownerId: OWNER, connectionId: connection.id, expectedRevision: connection.revision })
    if (!opened.ok) throw new Error('open failed')
    const session = { ownerId: OWNER, dataSessionId: opened.data.dataSessionId, generation: 1 }
    const initial = await service.scanKeys({ ...session, cursor: '0' })
    if (!initial.ok) throw new Error('scan failed')
    oversized = true
    expect(await service.scanKeys({ ...session, cursor: '0' })).toMatchObject({ ok: false, error: { code: 'REDIS_KEY_LIMIT_REACHED' } })
    expect(await service.readKey({ ...session, rawKeyToken: initial.data.keys[0]!.rawKeyToken })).toMatchObject({ ok: true })
    await service.dispose()
  })
})

describe('M10 data browser service — Redis cursor and bounded values', () => {
  it('treats empty nonzero SCAN batches as non-terminal, dedupes raw keys and preserves binary key identity through opaque tokens', async () => {
    const { store, library } = await setup()
    const redis = await redisFixture(library)
    let call = 0
    const scan = vi.fn(async () => {
      call += 1
      if (call === 1) return { cursor: '7', keys: [Buffer.from('alpha'), Buffer.from('alpha'), Buffer.from([0xff, 0x00, 0x61])] }
      if (call === 2) return { cursor: '3', keys: [] }
      return { cursor: '0', keys: [Buffer.from('alpha')] }
    })
    const adapter = redisAdapter({ scan, type: async key => key[0] === 0xff ? 'string' : 'hash', readString: async key => ({ value: Buffer.from(key), byteLength: key.byteLength }) })
    const service = createDataBrowserService({ store, adapters: factory(new Map([[redis.id, adapter]])), createId: (() => { let n = 0; return () => `33333333-3333-4333-8333-${String(++n).padStart(12, '0')}` })() })
    const opened = await service.openConnection({ ownerId: OWNER, connectionId: redis.id, expectedRevision: redis.revision })
    if (!opened.ok) throw new Error('open failed')

    const first = await service.scanKeys({ ownerId: OWNER, dataSessionId: opened.data.dataSessionId, generation: 1, cursor: '0' })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.data.complete).toBe(false)
    expect(first.data.keys).toHaveLength(2)
    expect(first.data.keys[0]).toMatchObject({ displayKey: 'alpha', binary: false })
    expect(first.data.keys[1]?.binary).toBe(true)

    const second = await service.scanKeys({ ownerId: OWNER, dataSessionId: opened.data.dataSessionId, generation: 1, cursor: first.data.nextCursor })
    expect(second).toEqual({ ok: true, data: { nextCursor: '3', complete: false, keys: [] } })
    const third = await service.scanKeys({ ownerId: OWNER, dataSessionId: opened.data.dataSessionId, generation: 1, cursor: '3' })
    expect(third).toEqual({ ok: true, data: { nextCursor: '0', complete: true, keys: [] } })

    const binaryToken = first.data.keys[1]!.rawKeyToken
    const value = await service.readKey({ ownerId: OWNER, dataSessionId: opened.data.dataSessionId, generation: 1, rawKeyToken: binaryToken, type: 'string' })
    expect(value.ok).toBe(true)
    if (value.ok) expect(value.data.items[0]).toMatchObject({ kind: 'value', value: { kind: 'binary', byteLength: 3 } })

    const refreshed = await service.scanKeys({ ownerId: OWNER, dataSessionId: opened.data.dataSessionId, generation: 1, cursor: '0' })
    expect(refreshed.ok).toBe(true)
    if (refreshed.ok) expect(refreshed.data.keys.map(key => key.displayKey)).toEqual(['alpha'])
    expect(await service.readKey({ ownerId: OWNER, dataSessionId: opened.data.dataSessionId, generation: 1, rawKeyToken: binaryToken, type: 'string' })).toMatchObject({
      ok: false,
      error: { code: 'RESOURCE_NOT_FOUND' },
    })
  })

  it('advances list pagination from the opaque cursor instead of repeating the first page', async () => {
    const { store, library } = await setup()
    const redis = await redisFixture(library)
    const values = ['a', 'b', 'c'].map(value => Buffer.from(value))
    const adapter = redisAdapter({
      scan: async () => ({ cursor: '0', keys: [Buffer.from('queue')] }),
      type: async () => 'list',
      readList: async (_key, start, count) => values.slice(start, start + count),
    })
    const service = createDataBrowserService({ store, adapters: factory(new Map([[redis.id, adapter]])), createId: (() => { let n = 0; return () => `55555555-5555-4555-8555-${String(++n).padStart(12, '0')}` })() })
    const opened = await service.openConnection({ ownerId: OWNER, connectionId: redis.id, expectedRevision: redis.revision })
    if (!opened.ok) throw new Error('open failed')
    const scan = await service.scanKeys({ ownerId: OWNER, dataSessionId: opened.data.dataSessionId, generation: 1, cursor: '0' })
    if (!scan.ok) throw new Error('scan failed')
    const key = scan.data.keys[0]!

    const first = await service.readKey({ ownerId: OWNER, dataSessionId: opened.data.dataSessionId, generation: 1, rawKeyToken: key.rawKeyToken, type: 'list', count: 2 })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.data.nextCursor).toBe('2')
    expect(first.data.items).toEqual([
      { kind: 'value', value: { kind: 'binary', base64Preview: 'YQ==', byteLength: 1, truncated: false } },
      { kind: 'value', value: { kind: 'binary', base64Preview: 'Yg==', byteLength: 1, truncated: false } },
    ])

    const second = await service.readKey({ ownerId: OWNER, dataSessionId: opened.data.dataSessionId, generation: 1, rawKeyToken: key.rawKeyToken, type: 'list', cursor: first.data.nextCursor!, count: 2 })
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(second.data.nextCursor).toBeNull()
      expect(second.data.items).toEqual([
        { kind: 'value', value: { kind: 'binary', base64Preview: 'Yw==', byteLength: 1, truncated: false } },
      ])
    }
  })

  it('reports expired keys and bounds large values/pages without using full-collection commands', async () => {
    const { store, library } = await setup()
    const redis = await redisFixture(library)
    const huge = Buffer.alloc(100 * 1024, 65)
    let expired = false
    const readString = vi.fn(async (key: Uint8Array, maxBytes: number) => key.toString() === 'gone'
      ? { value: null, byteLength: 0 }
      : { value: huge.subarray(0, maxBytes), byteLength: huge.byteLength })
    const adapter = redisAdapter({
      scan: async () => ({ cursor: '0', keys: [Buffer.from('large'), Buffer.from('gone')] }),
      type: async () => 'string',
      ttl: async key => key.toString() === 'gone' || expired ? -2 : 60,
      readString,
    })
    const service = createDataBrowserService({ store, adapters: factory(new Map([[redis.id, adapter]])), createId: (() => { let n = 0; return () => `44444444-4444-4444-8444-${String(++n).padStart(12, '0')}` })() })
    const opened = await service.openConnection({ ownerId: OWNER, connectionId: redis.id, expectedRevision: redis.revision })
    if (!opened.ok) throw new Error('open failed')
    const page = await service.scanKeys({ ownerId: OWNER, dataSessionId: opened.data.dataSessionId, generation: 1, cursor: '0' })
    if (!page.ok) throw new Error('scan failed')
    const large = page.data.keys.find(key => key.displayKey === 'large')!
    const gone = page.data.keys.find(key => key.displayKey === 'gone')!

    const largeResult = await service.readKey({ ownerId: OWNER, dataSessionId: opened.data.dataSessionId, generation: 1, rawKeyToken: large.rawKeyToken, type: 'string' })
    expect(largeResult.ok).toBe(true)
    if (largeResult.ok) {
      expect(largeResult.data.ttlSeconds).toBe(60)
      expect(largeResult.data.items[0]).toMatchObject({ kind: 'value', value: { kind: 'binary', byteLength: 100 * 1024, truncated: true } })
      expect(readString).toHaveBeenCalledTimes(1)
      const [readKey, readLimit] = readString.mock.calls[0]!
      expect(Buffer.from(readKey).toString('utf8')).toBe('large')
      expect(readLimit).toBe(64 * 1024)
    }
    const goneResult = await service.readKey({ ownerId: OWNER, dataSessionId: opened.data.dataSessionId, generation: 1, rawKeyToken: gone.rawKeyToken })
    expect(goneResult).toEqual({ ok: true, data: { exists: false, type: null, ttlSeconds: -2, items: [], nextCursor: null, byteCount: 0, truncated: false } })
    expired = true
    const afterExpiry = await service.readKey({ ownerId: OWNER, dataSessionId: opened.data.dataSessionId, generation: 1, rawKeyToken: large.rawKeyToken })
    expect(afterExpiry).toMatchObject({ ok: true, data: { exists: false, ttlSeconds: -2 } })
  })
})
