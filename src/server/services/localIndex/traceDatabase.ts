import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { getCcHahaDir, getClaudeConfigHomeDir } from '../../../utils/envUtils.js'
import {
  LOCAL_INDEX_BUSY_TIMEOUT_MS,
  prepareManagedDatabasePath,
} from './managedDatabasePath.js'
import {
  assertTraceIndexSchemaSupported,
  migrateTraceIndexDatabase,
} from './traceMigrations.js'

export type TraceIndexBinding = bigint | boolean | number | string | null | Uint8Array

export type TraceIndexReadOperation = {
  get<T>(sql: string, ...bindings: TraceIndexBinding[]): T | null
  all<T>(sql: string, ...bindings: TraceIndexBinding[]): T[]
}

export type TraceIndexWriteOperation = TraceIndexReadOperation & {
  run(sql: string, ...bindings: TraceIndexBinding[]): {
    changes: number
    lastInsertRowid: bigint | number
  }
  exec(sql: string): void
}

export type TraceIndexDatabase = {
  read<T>(operation: (database: TraceIndexReadOperation) => T): T
  write<T>(operation: (database: TraceIndexWriteOperation) => T): T
  transaction<T>(operation: (database: TraceIndexWriteOperation) => T): T
  close(): void
}

type OwnedStatement = {
  get(...bindings: TraceIndexBinding[]): unknown
  all(...bindings: TraceIndexBinding[]): unknown[]
  run(...bindings: TraceIndexBinding[]): {
    changes: number
    lastInsertRowid: bigint | number
  }
  finalize(): void
}

export function getTraceIndexDatabasePath(): string {
  return join(getCcHahaDir(), 'db', 'trace-index-v1.sqlite')
}

function configureConnection(database: Database): void {
  database.exec(`PRAGMA busy_timeout = ${LOCAL_INDEX_BUSY_TIMEOUT_MS}`)
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA synchronous = NORMAL')
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('PRAGMA wal_autocheckpoint = 1000')
  database.exec(`PRAGMA journal_size_limit = ${8 * 1024 * 1024}`)
}

export function openTraceIndexDatabase(options?: {
  path?: string
  scope?: string
}): TraceIndexDatabase {
  const databasePath = options?.path ?? getTraceIndexDatabasePath()
  prepareManagedDatabasePath({
    databasePath,
    filename: 'trace-index-v1.sqlite',
    scope: options?.scope ?? (options?.path ? undefined : getClaudeConfigHomeDir()),
  })
  const database = new Database(databasePath)

  try {
    assertTraceIndexSchemaSupported(database)
    configureConnection(database)
    migrateTraceIndexDatabase(database)
  } catch (error) {
    database.clearQueryCache()
    database.close(true)
    throw error
  }

  const statements = new Map<string, OwnedStatement>()
  let closed = false
  let transactionDepth = 0

  const assertOpen = () => {
    if (closed) throw new Error('Trace index database is closed')
  }
  const statement = (sql: string): OwnedStatement => {
    const cached = statements.get(sql)
    if (cached) return cached
    const created = database.query(sql) as unknown as OwnedStatement
    statements.set(sql, created)
    return created
  }
  const readOperation = (): TraceIndexReadOperation => ({
    get<T>(sql: string, ...bindings: TraceIndexBinding[]): T | null {
      assertOpen()
      return statement(sql).get(...bindings) as T | null
    },
    all<T>(sql: string, ...bindings: TraceIndexBinding[]): T[] {
      assertOpen()
      return statement(sql).all(...bindings) as T[]
    },
  })
  const writeOperation = (): TraceIndexWriteOperation => ({
    ...readOperation(),
    run(sql: string, ...bindings: TraceIndexBinding[]) {
      assertOpen()
      return statement(sql).run(...bindings)
    },
    exec(sql: string) {
      assertOpen()
      database.exec(sql)
    },
  })

  return {
    read: operation => {
      assertOpen()
      return operation(readOperation())
    },
    write: operation => {
      assertOpen()
      return operation(writeOperation())
    },
    transaction: operation => {
      assertOpen()
      if (transactionDepth > 0) {
        throw new Error('Trace index transactions cannot be nested')
      }
      transactionDepth += 1
      try {
        database.exec('BEGIN IMMEDIATE')
        try {
          const result = operation(writeOperation())
          if (result && typeof (result as { then?: unknown }).then === 'function') {
            throw new Error('Trace index transactions must be synchronous')
          }
          database.exec('COMMIT')
          return result
        } catch (error) {
          try {
            database.exec('ROLLBACK')
          } catch {
            // Preserve the original transaction failure.
          }
          throw error
        }
      } finally {
        transactionDepth -= 1
      }
    },
    close() {
      if (closed) return
      for (const statement of statements.values()) {
        try {
          statement.finalize()
        } catch {
          // Keep closing the database even if a cached statement was already finalized.
        }
      }
      statements.clear()
      database.clearQueryCache()
      database.close(true)
      closed = true
    },
  }
}
