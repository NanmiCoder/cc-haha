import { statSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { getCcHahaDir, getClaudeConfigHomeDir } from '../../../utils/envUtils.js'
import {
  LOCAL_INDEX_BUSY_TIMEOUT_MS,
  prepareManagedDatabasePath,
} from './managedDatabasePath.js'
import {
  assertSearchContentSchemaHealthy,
  assertSearchContentSchemaSupported,
  migrateSearchContentDatabase,
} from './searchContentMigrations.js'

export type SearchContentBinding =
  | bigint
  | boolean
  | number
  | string
  | null
  | Uint8Array

export type SearchContentRunResult = {
  changes: number
  lastInsertRowid: bigint | number
}

export type SearchContentReadOperation = {
  get<T>(sql: string, ...bindings: SearchContentBinding[]): T | null
  all<T>(sql: string, ...bindings: SearchContentBinding[]): T[]
}

export type SearchContentWriteOperation = SearchContentReadOperation & {
  run(sql: string, ...bindings: SearchContentBinding[]): SearchContentRunResult
  exec(sql: string): void
}

export type SearchContentCheckpointResult = {
  busy: number
  logFrames: number
  checkpointedFrames: number
}

export type SearchContentStorageStats = {
  databaseBytes: number
  walBytes: number
}

export type SearchContentDatabase = {
  readonly path?: string
  read<T>(operation: (database: SearchContentReadOperation) => T): T
  write<T>(operation: (database: SearchContentWriteOperation) => T): T
  transaction<T>(operation: (database: SearchContentWriteOperation) => T): T
  checkpointPassive(): SearchContentCheckpointResult
  getStorageStats(): SearchContentStorageStats
  close(): void
}

type OwnedStatement = {
  get(...bindings: SearchContentBinding[]): unknown
  all(...bindings: SearchContentBinding[]): unknown[]
  run(...bindings: SearchContentBinding[]): SearchContentRunResult
  finalize?(): void
}

const ASYNC_TRANSACTION_ERROR =
  'Search content transactions must be synchronous'
const NESTED_TRANSACTION_ERROR =
  'Search content transactions cannot be nested'

export function getSearchContentDatabasePath(): string {
  return join(getCcHahaDir(), 'db', 'search-index-v1.sqlite')
}

function fileSize(path: string): number {
  try {
    const snapshot = statSync(path)
    return snapshot.isFile() ? snapshot.size : 0
  } catch {
    return 0
  }
}

function configureConnection(database: Database): void {
  database.exec(`PRAGMA busy_timeout = ${LOCAL_INDEX_BUSY_TIMEOUT_MS}`)
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA synchronous = NORMAL')
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('PRAGMA wal_autocheckpoint = 1000')
  database.exec(`PRAGMA journal_size_limit = ${16 * 1024 * 1024}`)
}

function isThenable(value: unknown): boolean {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return false
  }
  try {
    return typeof (value as { then?: unknown }).then === 'function'
  } catch {
    return true
  }
}

export function openSearchContentDatabase(options?: {
  path?: string
  scope?: string
}): SearchContentDatabase {
  const databasePath = options?.path ?? getSearchContentDatabasePath()
  prepareManagedDatabasePath({
    databasePath,
    filename: 'search-index-v1.sqlite',
    scope: options?.scope ?? (options?.path ? undefined : getClaudeConfigHomeDir()),
  })
  const database = new Database(databasePath)

  try {
    assertSearchContentSchemaSupported(database)
    configureConnection(database)
    migrateSearchContentDatabase(database)
    assertSearchContentSchemaHealthy(database)
  } catch (error) {
    database.clearQueryCache()
    database.close(true)
    throw error
  }

  const statements = new Map<string, OwnedStatement>()
  let closed = false
  let transactionDepth = 0

  const assertOpen = (): void => {
    if (closed) throw new Error('Search content database is closed')
  }
  const statement = (sql: string): OwnedStatement => {
    const cached = statements.get(sql)
    if (cached) return cached
    const created = database.query(sql) as unknown as OwnedStatement
    statements.set(sql, created)
    return created
  }
  const createReadOperation = (): SearchContentReadOperation => ({
    get<T>(sql: string, ...bindings: SearchContentBinding[]): T | null {
      assertOpen()
      return statement(sql).get(...bindings) as T | null
    },
    all<T>(sql: string, ...bindings: SearchContentBinding[]): T[] {
      assertOpen()
      return statement(sql).all(...bindings) as T[]
    },
  })
  const createWriteOperation = (): SearchContentWriteOperation => ({
    ...createReadOperation(),
    run(sql: string, ...bindings: SearchContentBinding[]) {
      assertOpen()
      return statement(sql).run(...bindings)
    },
    exec(sql: string) {
      assertOpen()
      database.exec(sql)
    },
  })

  return {
    path: databasePath === ':memory:' ? undefined : databasePath,
    read(operation) {
      assertOpen()
      return operation(createReadOperation())
    },
    write(operation) {
      assertOpen()
      return operation(createWriteOperation())
    },
    transaction(operation) {
      assertOpen()
      if (transactionDepth > 0) throw new Error(NESTED_TRANSACTION_ERROR)
      transactionDepth += 1
      let started = false
      try {
        database.exec('BEGIN IMMEDIATE')
        started = true
        const result = operation(createWriteOperation())
        if (isThenable(result)) throw new Error(ASYNC_TRANSACTION_ERROR)
        database.exec('COMMIT')
        started = false
        return result
      } catch (error) {
        if (started) {
          try {
            database.exec('ROLLBACK')
          } catch {
            // Preserve the original transaction or COMMIT failure.
          }
        }
        throw error
      } finally {
        transactionDepth -= 1
      }
    },
    checkpointPassive() {
      assertOpen()
      const row = database.query<{
        busy: number
        log: number
        checkpointed: number
      }, []>('PRAGMA wal_checkpoint(PASSIVE)').get()
      return {
        busy: row?.busy ?? 0,
        logFrames: row?.log ?? 0,
        checkpointedFrames: row?.checkpointed ?? 0,
      }
    },
    getStorageStats() {
      assertOpen()
      return {
        databaseBytes: fileSize(databasePath),
        walBytes: fileSize(`${databasePath}-wal`),
      }
    },
    close() {
      if (closed) return
      for (const owned of statements.values()) owned.finalize?.()
      statements.clear()
      database.clearQueryCache()
      database.close(true)
      closed = true
    },
  }
}
