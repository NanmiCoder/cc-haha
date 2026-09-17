import { randomUUID } from 'node:crypto'
import type { SqlBrowserAdapter, SqlRawBatch } from './dataBrowserService.js'

/** The metadata connection is never reused for a potentially blocking user query. */
export function dedicatedSqlAdapter(metadata: SqlBrowserAdapter, open: () => Promise<SqlBrowserAdapter>): SqlBrowserAdapter {
  const active = new Map<string, SqlBrowserAdapter>()
  let closed = false

  const stream = async function* (id: string, signal: AbortSignal, start: (adapter: SqlBrowserAdapter) => AsyncIterable<SqlRawBatch>): AsyncIterable<SqlRawBatch> {
    if (closed || signal.aborted) throw new Error('SESSION_CLOSED')
    const adapter = await open()
    if (closed || signal.aborted) { await adapter.close(); throw new Error('SESSION_CLOSED') }
    active.set(id, adapter)
    let closing: Promise<void> | undefined
    const close = () => closing ??= Promise.resolve().then(() => adapter.close())
    const abort = () => { void close().catch(() => undefined) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      for await (const batch of start(adapter)) {
        if (closed || signal.aborted) throw new Error('CANCELLED')
        yield batch
      }
    } finally {
      signal.removeEventListener('abort', abort)
      active.delete(id)
      await close()
    }
  }

  return {
    listDatabases: () => metadata.listDatabases(),
    listSchemas: () => metadata.listSchemas(),
    listTables: schema => metadata.listTables(schema),
    describeTable: (schema, table) => metadata.describeTable(schema, table),
    previewTable: input => stream(randomUUID(), input.signal, adapter => adapter.previewTable(input)),
    executeQuery: input => stream(input.queryId, input.signal, adapter => adapter.executeQuery(input)),
    async cancelQuery(queryId) {
      const adapter = active.get(queryId)
      return adapter?.cancelQuery ? adapter.cancelQuery(queryId) : false
    },
    async close() {
      closed = true
      await Promise.all([metadata.close(), ...[...active.values()].map(adapter => adapter.close())])
      active.clear()
    },
  }
}
