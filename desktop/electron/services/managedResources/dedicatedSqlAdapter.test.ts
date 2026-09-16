import { describe, expect, it, vi } from 'vitest'
import { dedicatedSqlAdapter } from './dedicatedSqlAdapter'
import type { SqlBrowserAdapter } from './dataBrowserService'

function fixture(value: string): SqlBrowserAdapter {
  return {
    listDatabases: async () => [{ name: value }], listSchemas: async () => [], listTables: async () => [],
    describeTable: async (schema, name) => ({ table: { schema, name, kind: 'table' }, columns: [] }),
    previewTable: async function* () { yield { rows: [[value]] } },
    executeQuery: async function* () { yield { rows: [[value]] } },
    cancelQuery: vi.fn(async () => false), close: vi.fn(async () => undefined),
  }
}

describe('SQL driver connection isolation', () => {
  it('runs concurrent queries on distinct connections, not the metadata connection', async () => {
    const metadata = fixture('metadata')
    const first = fixture('first')
    const second = fixture('second')
    const open = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const adapter = dedicatedSqlAdapter(metadata, open)
    const signal = new AbortController().signal
    const a = adapter.executeQuery({ queryId: 'A', sql: 'select fixture', params: [], signal })[Symbol.asyncIterator]()
    const b = adapter.executeQuery({ queryId: 'B', sql: 'select fixture', params: [], signal })[Symbol.asyncIterator]()
    expect((await a.next()).value).toEqual({ rows: [['first']] })
    expect((await b.next()).value).toEqual({ rows: [['second']] })
    expect(await adapter.listDatabases()).toEqual([{ name: 'metadata' }])
    await adapter.cancelQuery!('A')
    expect(first.cancelQuery).toHaveBeenCalledWith('A')
    expect(second.cancelQuery).not.toHaveBeenCalled()
    await a.return?.()
    await b.return?.()
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(second.close).toHaveBeenCalledTimes(1)
    expect(metadata.close).not.toHaveBeenCalled()
    await adapter.close()
    expect(metadata.close).toHaveBeenCalledTimes(1)
  })

  it('closes a dedicated query connection that completes opening after cancellation', async () => {
    let resolve!: (value: SqlBrowserAdapter) => void
    const connection = fixture('late')
    const adapter = dedicatedSqlAdapter(fixture('metadata'), () => new Promise(done => { resolve = done }))
    const controller = new AbortController()
    const iterator = adapter.executeQuery({ queryId: 'A', sql: 'select fixture', params: [], signal: controller.signal })[Symbol.asyncIterator]()
    const pending = iterator.next()
    controller.abort()
    resolve(connection)
    await expect(pending).rejects.toThrow('SESSION_CLOSED')
    expect(connection.close).toHaveBeenCalledTimes(1)
    await adapter.close()
  })
})
