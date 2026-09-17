import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { createHostWorkbenchHarness } from '../../../test/hostWorkbenchHarness'
import { useSettingsStore } from '../../../stores/settingsStore'
import { t } from '../../../i18n'
let DataConnectionsWorkspace: typeof import('../ui/DataConnectionsWorkspace')['DataConnectionsWorkspace']
let SqlQueryPanel: typeof import('../ui/dataConnections/SqlQueryPanel')['SqlQueryPanel']
let RedisBrowser: typeof import('../ui/dataConnections/RedisBrowser')['RedisBrowser']
import type { DataConnection, RedisConnection, SqlConnection } from '../types/dataConnectionTypes'
import type { DataBrowserAdapterFactory, RedisBrowserAdapter, SqlBrowserAdapter } from '../../../../electron/services/managedResources/dataBrowserService'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
let fixture: Awaited<ReturnType<typeof createHostWorkbenchHarness>>
let sql: SqlBrowserAdapter
let redis: RedisBrowserAdapter
let open: ReturnType<typeof vi.fn<DataBrowserAdapterFactory['open']>>
let openGate: ReturnType<typeof deferred<void>> | null
const closed: string[] = []
const testedConfigs: Record<string, unknown>[] = []

beforeAll(async () => {
  // Match Electron startup: install the native bridge before evaluating renderer modules.
  fixture = await createHostWorkbenchHarness({
    dataBrowserAdapters: { open: connection => open(connection) },
    dataConnectionDrivers: {
      mysqlCreateConnection: async () => { throw new Error('unexpected test driver') },
      createRedisClient: () => { throw new Error('unexpected test driver') },
      createPostgresClient: config => {
        testedConfigs.push(config)
        return { connect: async () => undefined, query: async () => ({ rows: [{ version: 'fixture-postgres' }] }), end: async () => { closed.push('tested-postgres') } }
      },
    },
  })
  DataConnectionsWorkspace = (await import('../ui/DataConnectionsWorkspace')).DataConnectionsWorkspace
  SqlQueryPanel = (await import('../ui/dataConnections/SqlQueryPanel')).SqlQueryPanel
  RedisBrowser = (await import('../ui/dataConnections/RedisBrowser')).RedisBrowser
})
afterAll(async () => { await fixture?.dispose() })

beforeEach(async () => {
  localStorage.clear()
  useSettingsStore.setState({ locale: 'en' })
  closed.length = 0
  testedConfigs.length = 0
  openGate = null
  sql = {
    listDatabases: async () => [{ name: 'fixture' }],
    listSchemas: async () => [{ name: 'public' }],
    listTables: async schema => [{ schema, name: 'orders', kind: 'table' }],
    describeTable: async (schema, table) => ({ table: { schema, name: table, kind: 'table' }, columns: [{ ordinal: 1, name: 'id', dataType: 'bigint', nullable: false }] }),
    previewTable: async function* () { yield { columns: [{ name: 'id', dataType: 'bigint' }, { name: 'id', dataType: 'numeric' }], rows: [['9007199254740993', '1.2500']] } },
    executeQuery: async function* () { yield { columns: [{ name: 'result' }], rows: [['executed-through-ipc']] } },
    cancelQuery: async () => true,
    close: async () => { closed.push('sql') },
  }
  redis = {
    scan: async () => ({ cursor: '0', keys: [Buffer.from('orders:1')] }),
    type: async () => 'list', ttl: async () => 60,
    readString: async () => ({ value: Buffer.from('fixture'), byteLength: 7 }),
    scanHash: async () => ({ cursor: '0', entries: [] }),
    readList: async (_key, start, count) => Array.from({ length: start === 0 ? count : 1 }, (_, index) => `row-${start + index}`),
    scanSet: async () => ({ cursor: '0', values: [] }),
    scanZSet: async () => ({ cursor: '0', values: [] }),
    readStream: async () => ({ nextCursor: null, values: [] }),
    close: async () => { closed.push('redis') },
  }
  open = vi.fn(async (connection: DataConnection) => {
    if (openGate) await openGate.promise
    return connection.kind === 'database' ? { kind: 'database' as const, sql } : { kind: 'redis' as const, redis }
  })
  const existing = await fixture.host.dataConnections.list()
  if (!existing.ok) throw new Error(existing.error.code)
  for (const connection of existing.data) {
    const removed = await fixture.host.dataConnections.delete(connection.id, connection.revision)
    if (!removed.ok) throw new Error(removed.error.code)
  }
})
afterEach(async () => { cleanup(); await act(async () => { openGate?.resolve() }) })

async function saved(kind: 'database' | 'redis' = 'database', mode: 'inspection' | 'query' = 'inspection') {
  const common = { name: `${kind}-fixture`, address: 'fixture.invalid', port: kind === 'database' ? 5432 : 6379, username: 'fixture', credentialId: null, relatedHostId: null, tagIds: [], environment: 'test' as const, tls: { enabled: false, serverName: null, caCertificate: null, clientCertificate: null, clientKeyCredentialId: null }, description: '', accessInstructions: '' }
  const connection = kind === 'database'
    ? { ...common, kind: 'database' as const, engine: 'postgresql' as const, database: 'fixture', schema: 'public', mode }
    : { ...common, kind: 'redis' as const, topology: 'standalone' as const, databaseIndex: 0, keyPrefixDescription: '' }
  const result = await fixture.host.dataConnections.save({ mode: 'create', connection })
  if (!result.ok) throw new Error(result.error.code)
  return result.data
}
async function connect() {
  fireEvent.click(screen.getByTestId('data-browser-connect'))
  await screen.findByTestId('data-browser-disconnect')
  await waitFor(() => expect(screen.queryByTestId('sql-preview') ?? screen.getByTestId('redis-refresh')).not.toBeDisabled())
}

// Real components, DesktopHost, IPC validation/handlers, repositories and service.
// Only the native transport/vault and network driver boundaries are fixtures.
describe('M9/M10 DOM -> DesktopHost -> IPC -> repository -> driver', () => {
  it('creates and reloads connection metadata without opening a driver', async () => {
    const view = render(<DataConnectionsWorkspace />)
    await screen.findByText(t('managedResources.dataConnections.empty'))
    fireEvent.change(screen.getByTestId('data-connection-name'), { target: { value: 'DOM database' } })
    fireEvent.change(screen.getByTestId('data-connection-address'), { target: { value: 'fixture.invalid' } })
    fireEvent.change(screen.getByTestId('data-connection-database'), { target: { value: 'fixture' } })
    fireEvent.click(screen.getByTestId('save-data-connection'))
    await screen.findByTestId('sql-query-panel')
    const doc = await fixture.document()
    expect(doc.dataConnections).toHaveLength(1)
    expect(open).not.toHaveBeenCalled()
    view.unmount()
    render(<DataConnectionsWorkspace />)
    fireEvent.click(await screen.findByTestId(`data-connection-row-${doc.dataConnections[0]!.id}`))
    expect(screen.getByTestId('data-connection-name')).toHaveValue('DOM database')
    expect(open).not.toHaveBeenCalled()
  })

  it('persists multiple existing and new tags plus an optional related host through the form', async () => {
    const linked = await fixture.host.hostManagement.saveHost({ name: 'Related fixture host', address: 'fixture.invalid', port: 22, username: 'fixture', auth: { type: 'password', credentialId: null }, tagIds: [], initialDirectory: null, applications: [], notes: '' })
    if (!linked.ok) throw new Error(linked.error.code)
    for (const name of ['Data A', 'Data B']) {
      const tag = await fixture.host.hostManagement.saveTag({ mode: 'create', namespace: 'database', name, colorToken: null })
      if (!tag.ok) throw new Error(tag.error.code)
    }
    const view = render(<DataConnectionsWorkspace />)
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Data A' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Data B' }))
    fireEvent.change(screen.getByTestId('data-connection-related-host'), { target: { value: linked.data.id } })
    fireEvent.change(screen.getByTestId('data-connection-new-tag'), { target: { value: 'Data C' } })
    fireEvent.click(screen.getByTestId('data-connection-add-tag'))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Data C' })).toBeChecked())
    fireEvent.change(screen.getByTestId('data-connection-name'), { target: { value: 'Tagged DB' } })
    fireEvent.change(screen.getByTestId('data-connection-database'), { target: { value: 'fixture' } })
    fireEvent.click(screen.getByTestId('save-data-connection'))
    await screen.findByTestId('sql-query-panel')
    const doc = await fixture.document()
    const connection = doc.dataConnections[0]!
    expect(connection.tagIds).toHaveLength(3)
    expect(connection.relatedHostId).toBe(linked.data.id)
    expect(open).not.toHaveBeenCalled()
    view.unmount()
    render(<DataConnectionsWorkspace />)
    fireEvent.click(await screen.findByTestId(`data-connection-row-${connection.id}`))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Data B' })).toBeChecked())
    expect(screen.getByTestId('data-connection-related-host')).toHaveValue(linked.data.id)
  })

  it('selects an engine default port without overwriting a manually entered port', async () => {
    render(<DataConnectionsWorkspace />)
    const engine = screen.getByLabelText(t('managedResources.dataConnections.engine'))
    fireEvent.change(engine, { target: { value: 'postgresql' } })
    expect(screen.getByTestId('data-connection-port')).toHaveValue(5432)
    fireEvent.change(screen.getByTestId('data-connection-port'), { target: { value: '15432' } })
    fireEvent.change(engine, { target: { value: 'mysql' } })
    expect(screen.getByTestId('data-connection-port')).toHaveValue(15432)
    expect(open).not.toHaveBeenCalled()
  })

  it('tests the edited endpoint rather than stale saved metadata and closes the test driver', async () => {
    const connection = await saved()
    render(<DataConnectionsWorkspace />)
    fireEvent.click(await screen.findByTestId(`data-connection-row-${connection.id}`))
    fireEvent.change(screen.getByTestId('data-connection-address'), { target: { value: 'edited.fixture.invalid' } })
    fireEvent.change(screen.getByTestId('data-connection-port'), { target: { value: '15432' } })
    fireEvent.click(screen.getByTestId('test-data-connection'))
    await screen.findByText(/fixture-postgres/)
    expect(testedConfigs).toHaveLength(1)
    expect(testedConfigs[0]).toMatchObject({ host: 'edited.fixture.invalid', port: 15432, database: 'fixture' })
    expect(closed).toContain('tested-postgres')
    expect((await fixture.document()).dataConnections[0]?.address).toBe('fixture.invalid')
    expect(open).not.toHaveBeenCalled()
  })

  it('previews lossless duplicate columns through the real IPC and refuses inspection-mode arbitrary SQL', async () => {
    const connection = await saved() as SqlConnection
    const view = render(<SqlQueryPanel connection={connection} />)
    await connect()
    fireEvent.click(screen.getByTestId('sql-preview'))
    expect(await screen.findByTestId('sql-result-grid')).toHaveTextContent('9007199254740993')
    expect(screen.getByTestId('sql-result-grid')).toHaveTextContent('1.2500')
    expect(screen.queryByTestId('sql-query-input')).toBeNull()
    const active = await fixture.host.dataConnections.openConnection(connection.id, connection.revision)
    if (!active.ok) throw new Error(active.error.code)
    expect(await fixture.host.dataConnections.executeQuery({ dataSessionId: active.data.dataSessionId, generation: active.data.generation, queryId: crypto.randomUUID(), sql: 'delete from orders' })).toMatchObject({ ok: false, error: { code: 'QUERY_MODE_REQUIRED' } })
    await fixture.host.dataConnections.closeConnection(active.data.dataSessionId, active.data.generation)
    view.unmount()
    await waitFor(() => expect(closed).toContain('sql'))
  })

  it('executes query mode and keeps business rows out of resources.json', async () => {
    render(<SqlQueryPanel connection={await saved('database', 'query') as SqlConnection} />)
    await connect()
    fireEvent.change(screen.getByTestId('sql-query-input'), { target: { value: 'select fixture' } })
    fireEvent.click(screen.getByTestId('sql-execute'))
    expect(await screen.findByText('executed-through-ipc')).toBeInTheDocument()
    expect(JSON.stringify(await fixture.document())).not.toContain('executed-through-ipc')
    fireEvent.click(screen.getByTestId('data-browser-disconnect'))
    await screen.findByTestId('data-browser-connect')
    expect(closed).toContain('sql')
    expect(screen.queryByTestId('sql-result-grid')).toBeNull()
  })

  it.each(['database', 'redis'] as const)('keeps the %s session visible when native disconnect fails and permits retry', async kind => {
    const connection = await saved(kind)
    let attempts = 0
    const close = async () => { if (++attempts === 1) throw new Error('fixture close failure'); closed.push(kind) }
    if (kind === 'database') sql.close = close
    else redis.close = close
    render(kind === 'database' ? <SqlQueryPanel connection={connection as SqlConnection} /> : <RedisBrowser connection={connection as RedisConnection} />)
    await connect()
    fireEvent.click(screen.getByTestId('data-browser-disconnect'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('DISCONNECT_FAILED'))
    expect(screen.getByTestId('data-browser-disconnect')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('data-browser-disconnect'))
    await screen.findByTestId('data-browser-connect')
    expect(attempts).toBe(2)
  })

  it('browses actual column metadata and truthfully reports cancellation without a server acknowledgement', async () => {
    const started = deferred<void>()
    const release = deferred<void>()
    sql.executeQuery = async function* () { started.resolve(); await release.promise; yield { rows: [['late-result']] } }
    sql.cancelQuery = async () => false
    render(<SqlQueryPanel connection={await saved('database', 'query') as SqlConnection} />)
    await connect()
    fireEvent.click(screen.getByTestId('sql-describe'))
    expect(await screen.findByTestId('sql-column-structure')).toHaveTextContent('bigint')
    fireEvent.change(screen.getByTestId('sql-query-input'), { target: { value: 'select fixture' } })
    fireEvent.click(screen.getByTestId('sql-execute'))
    await started.promise
    try {
      fireEvent.click(screen.getByTestId('sql-cancel'))
      await waitFor(() => expect(screen.getByTestId('sql-execute')).not.toBeDisabled())
      expect(await screen.findByText(t('managedResources.dataBrowser.cancelUnknown'))).toBeInTheDocument()
      expect(screen.queryByText('late-result')).toBeNull()
    } finally { await act(async () => { release.resolve() }) }
  })

  it.each(['database', 'redis'] as const)('closes a late %s connection after its panel was unmounted', async kind => {
    const connection = await saved(kind)
    openGate = deferred<void>()
    const view = render(kind === 'database' ? <SqlQueryPanel connection={connection as SqlConnection} /> : <RedisBrowser connection={connection as RedisConnection} />)
    fireEvent.click(screen.getByTestId('data-browser-connect'))
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    view.unmount()
    await act(async () => { openGate!.resolve() })
    await waitFor(() => expect(closed).toContain(kind === 'database' ? 'sql' : 'redis'))
  })

  it('passes stream-id cursors across native IPC for the next Redis stream page', async () => {
    redis.type = async () => 'stream'
    const cursors: string[] = []
    redis.readStream = async (_key, cursor) => {
      cursors.push(cursor)
      return { values: [{ id: cursor === '0' ? '1000-0' : '1001-0', fields: [['kind', 'fixture']] }], nextCursor: cursor === '0' ? '1000-0' : null }
    }
    render(<RedisBrowser connection={await saved('redis') as RedisConnection} />)
    await connect()
    fireEvent.click(screen.getByTestId('redis-refresh'))
    fireEvent.click(await screen.findByRole('button', { name: 'orders:1' }))
    await screen.findByTestId('redis-value')
    fireEvent.click(screen.getByTestId('redis-read-more'))
    await waitFor(() => expect(cursors).toEqual(['0', '1000-0']))
    expect(screen.queryByTestId('redis-read-more')).toBeNull()
  })

  it('keeps Redis list cursors advancing and refreshes keys without stale tokens', async () => {
    render(<RedisBrowser connection={await saved('redis') as RedisConnection} />)
    await connect()
    fireEvent.click(screen.getByTestId('redis-refresh'))
    fireEvent.click(await screen.findByRole('button', { name: 'orders:1' }))
    expect(await screen.findByTestId('redis-value')).toHaveTextContent('row-0')
    fireEvent.click(screen.getByTestId('redis-read-more'))
    await waitFor(() => expect(screen.getByTestId('redis-value')).toHaveTextContent('row-100'))
    expect(screen.queryByTestId('redis-read-more')).toBeNull()
    fireEvent.click(screen.getByTestId('redis-refresh'))
    await waitFor(() => expect(screen.queryByTestId('redis-value')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'orders:1' }))
    expect(await screen.findByTestId('redis-value')).toHaveTextContent('row-0')
  })
})
