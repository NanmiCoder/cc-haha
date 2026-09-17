import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  openConnection: vi.fn(),
  closeConnection: vi.fn(),
  listSchemas: vi.fn(),
  listTables: vi.fn(),
  previewTable: vi.fn(),
  executeQuery: vi.fn(),
  cancelQuery: vi.fn(),
  scanKeys: vi.fn(),
  readKey: vi.fn(),
}))

vi.mock('../../../../lib/desktopHost', () => {
  const host = { dataConnections: mocks }
  return { getDesktopHost: () => host }
})

import { SqlQueryPanel } from './SqlQueryPanel'
import { RedisBrowser } from './RedisBrowser'
import type { RedisConnection, SqlConnection } from '../../types/dataConnectionTypes'

const session = {
  dataSessionId: '11111111-1111-4111-8111-111111111111',
  generation: 1,
  connectionId: '22222222-2222-4222-8222-222222222222',
  connectionRevision: 1,
  kind: 'database' as const,
}

const common = {
  revision: 1,
  createdAt: '2026-09-13T00:00:00.000Z',
  updatedAt: '2026-09-13T00:00:00.000Z',
  address: '127.0.0.1',
  username: 'reader',
  credentialId: null,
  tagIds: [],
  relatedHostId: null,
  environment: 'test' as const,
  tls: { enabled: false, serverName: null, caCertificate: null, clientCertificate: null, clientKeyCredentialId: null },
  description: '',
  accessInstructions: '',
}

function sqlConnection(mode: 'inspection' | 'query' = 'query'): SqlConnection {
  return {
    ...common,
    id: '22222222-2222-4222-8222-222222222222',
    kind: 'database',
    name: 'orders-db',
    port: 5432,
    engine: 'postgresql',
    database: 'orders',
    schema: 'public',
    mode,
  }
}

function redisConnection(): RedisConnection {
  return {
    ...common,
    id: '33333333-3333-4333-8333-333333333333',
    kind: 'redis',
    name: 'orders-cache',
    port: 6379,
    topology: 'standalone',
    databaseIndex: 0,
    keyPrefixDescription: 'orders:*',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.openConnection.mockResolvedValue({ ok: true, data: session })
  mocks.closeConnection.mockResolvedValue({ ok: true, data: { closed: true } })
  mocks.listSchemas.mockResolvedValue({ ok: true, data: [{ name: 'public' }] })
  mocks.listTables.mockResolvedValue({ ok: true, data: [{ schema: 'public', name: 'orders', kind: 'table' }] })
  mocks.previewTable.mockResolvedValue({
    ok: true,
    data: {
      columns: [{ index: 0, name: 'id', dataType: 'bigint' }, { index: 1, name: 'id', dataType: 'numeric' }],
      rows: [[{ kind: 'bigint', value: '9007199254740993' }, { kind: 'decimal', value: '1.25' }]],
      rowCount: 1,
      byteCount: 42,
      truncated: false,
      durationMs: 3,
    },
  })
  mocks.executeQuery.mockResolvedValue({
    ok: true,
    data: { columns: [{ index: 0, name: 'ok', dataType: 'text' }], rows: [[{ kind: 'string', value: 'done' }]], rowCount: 1, byteCount: 8, truncated: false, durationMs: 2 },
  })
  mocks.scanKeys.mockResolvedValue({ ok: true, data: { nextCursor: '0', complete: true, keys: [] } })
  mocks.readKey.mockResolvedValue({ ok: true, data: { exists: true, type: 'string', ttlSeconds: 60, items: [{ kind: 'value', value: { kind: 'string', value: 'cached' } }], nextCursor: null, byteCount: 6, truncated: false } })
})

afterEach(() => cleanup())

describe('M10 SQL browser UI', () => {
  it('requires explicit connect, browses schema/table, previews rows and executes query-mode SQL', async () => {
    render(<SqlQueryPanel connection={sqlConnection('query')} />)
    expect(mocks.openConnection).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('data-browser-connect'))
    await waitFor(() => expect(mocks.listTables).toHaveBeenCalledWith(session.dataSessionId, 1, 'public'))
    expect((screen.getByTestId('sql-table') as HTMLSelectElement).value).toBe('orders')

    fireEvent.click(screen.getByTestId('sql-preview'))
    await waitFor(() => expect(mocks.previewTable).toHaveBeenCalledWith(expect.objectContaining({ table: 'orders', schema: 'public', maxRows: 100 })))
    const grid = await screen.findByTestId('sql-result-grid')
    expect(grid.textContent).toContain('9007199254740993')
    expect(grid.textContent).toContain('id#1')
    expect(grid.textContent).toContain('id#2')

    fireEvent.change(screen.getByTestId('sql-query-input'), { target: { value: 'select 1' } })
    fireEvent.click(screen.getByTestId('sql-execute'))
    await waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledWith(expect.objectContaining({ sql: 'select 1', dataSessionId: session.dataSessionId, generation: 1 })))
    expect(await screen.findByText('done')).not.toBeNull()
  })

  it('never exposes arbitrary SQL execution for an inspection-mode connection', async () => {
    render(<SqlQueryPanel connection={sqlConnection('inspection')} />)
    fireEvent.click(screen.getByTestId('data-browser-connect'))
    await screen.findByTestId('sql-preview')
    expect(screen.queryByTestId('sql-query-input')).toBeNull()
    expect(screen.queryByTestId('sql-execute')).toBeNull()
  })
})

describe('M10 Redis browser UI', () => {
  it('scans only on user action, keeps an empty nonterminal cursor pageable and reads a selected key', async () => {
    mocks.openConnection.mockResolvedValue({ ok: true, data: { ...session, connectionId: redisConnection().id, kind: 'redis' } })
    mocks.scanKeys
      .mockResolvedValueOnce({ ok: true, data: { nextCursor: '7', complete: false, keys: [{ rawKeyToken: '44444444-4444-4444-8444-444444444444', displayKey: 'orders:1', binary: false }] } })
      .mockResolvedValueOnce({ ok: true, data: { nextCursor: '3', complete: false, keys: [] } })

    render(<RedisBrowser connection={redisConnection()} />)
    expect(mocks.scanKeys).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('data-browser-connect'))
    const refresh = await screen.findByTestId('redis-refresh')
    expect(mocks.scanKeys).not.toHaveBeenCalled()

    fireEvent.click(refresh)
    expect(await screen.findByText('orders:1')).not.toBeNull()
    expect(screen.getByTestId('redis-scan-more')).not.toBeNull()

    fireEvent.click(screen.getByTestId('redis-scan-more'))
    await waitFor(() => expect(mocks.scanKeys).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('redis-scan-more')).not.toBeNull()

    fireEvent.click(screen.getByText('orders:1'))
    await waitFor(() => expect(mocks.readKey).toHaveBeenCalledWith(expect.objectContaining({ rawKeyToken: '44444444-4444-4444-8444-444444444444' })))
    expect((await screen.findByTestId('redis-value')).textContent).toContain('cached')
    expect(screen.getByText('TTL: 60')).not.toBeNull()
  })
})
