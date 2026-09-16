import { useEffect, useRef, useState } from 'react'
import { getDesktopHost } from '../../../../lib/desktopHost'
import { useTranslation } from '../../../../i18n'
import type { DataSessionRef, SqlQueryResult, SqlSchemaInfo, SqlTableInfo, SqlTableDescription } from '../../api/dataConnectionsApi'
import type { SqlConnection } from '../../types/dataConnectionTypes'
import { QueryResultGrid } from './QueryResultGrid'
import { dataBrowserMessage } from './dataBrowserMessage'

export function SqlQueryPanel({ connection }: { connection: SqlConnection }) {
  const host = getDesktopHost()
  const t = useTranslation()
  const [session, setSession] = useState<DataSessionRef | null>(null)
  const sessionRef = useRef<DataSessionRef | null>(null)
  const lifecycle = useRef(0)
  const disconnecting = useRef(false)
  const [description, setDescription] = useState<SqlTableDescription | null>(null)
  const [cancelNotice, setCancelNotice] = useState<string | null>(null)
  const [schemas, setSchemas] = useState<SqlSchemaInfo[]>([])
  const [tables, setTables] = useState<SqlTableInfo[]>([])
  const [schema, setSchema] = useState<string | null>(connection.schema)
  const [table, setTable] = useState('')
  const [sql, setSql] = useState('')
  const [result, setResult] = useState<SqlQueryResult | null>(null)
  const [queryId, setQueryId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    lifecycle.current += 1
    setBusy(false)
    disconnecting.current = false
    setDescription(null)
    setCancelNotice(null)
    setSession(null)
    setSchemas([])
    setTables([])
    setSchema(connection.schema)
    setTable('')
    setSql('')
    setResult(null)
    setQueryId(null)
    setError(null)
    return () => {
      lifecycle.current += 1
      const current = sessionRef.current
      sessionRef.current = null
      if (current) void host.dataConnections.closeConnection(current.dataSessionId, current.generation).catch(() => undefined)
    }
  // `connection.id/revision` are the execution identity. A saved edit requires reconnect.
  }, [connection.id, connection.revision, connection.schema, host])

  const loadTables = async (active: DataSessionRef, nextSchema: string | null) => {
    const response = await host.dataConnections.listTables(active.dataSessionId, active.generation, nextSchema)
    if (sessionRef.current !== active) return
    if (!response.ok) {
      setError(response.error.code)
      return
    }
    setTables(response.data)
    setTable(response.data[0]?.name ?? '')
  }

  const connect = async () => {
    const epoch = lifecycle.current
    setBusy(true)
    setError(null)
    try {
      const opened = await host.dataConnections.openConnection(connection.id, connection.revision)
      if (epoch !== lifecycle.current) {
        if (opened.ok) await host.dataConnections.closeConnection(opened.data.dataSessionId, opened.data.generation)
        return
      }
      if (!opened.ok) {
        setError(opened.error.code)
        return
      }
      setSession(opened.data)
      sessionRef.current = opened.data
      const schemaResponse = await host.dataConnections.listSchemas(opened.data.dataSessionId, opened.data.generation)
      if (epoch !== lifecycle.current) return
      if (!schemaResponse.ok) {
        setError(schemaResponse.error.code)
        return
      }
      setSchemas(schemaResponse.data)
      const preferred = connection.schema ?? schemaResponse.data[0]?.name ?? null
      setSchema(preferred)
      await loadTables(opened.data, preferred)
    } catch {
      if (epoch === lifecycle.current) setError('INTERNAL_ERROR')
    } finally {
      if (epoch === lifecycle.current) setBusy(false)
    }
  }

  const disconnect = async () => {
    if (!session || disconnecting.current) return
    disconnecting.current = true
    setBusy(true)
    setError(null)
    try {
      const response = await host.dataConnections.closeConnection(session.dataSessionId, session.generation)
      if (sessionRef.current !== session) return
      if (!response.ok) { setError(response.error.code); return }
      sessionRef.current = null
      setSession(null)
      setResult(null)
      setSchemas([])
      setTables([])
      setTable('')
      setDescription(null)
      setQueryId(null)
      setCancelNotice(null)
    } catch { if (sessionRef.current === session) setError('INTERNAL_ERROR') }
    finally { disconnecting.current = false; setBusy(false) }
  }

  const changeSchema = async (value: string) => {
    if (!session || busy) return
    const next = value || null
    setSchema(next)
    setTable('')
    setDescription(null)
    setResult(null)
    setBusy(true)
    try { await loadTables(session, next) }
    catch { if (sessionRef.current === session) setError('INTERNAL_ERROR') }
    finally { if (sessionRef.current === session) setBusy(false) }
  }

  const describe = async () => {
    if (!session || !table || busy) return
    setBusy(true)
    setError(null)
    try {
      const response = await host.dataConnections.describeTable(session.dataSessionId, session.generation, schema, table)
      if (sessionRef.current !== session) return
      if (response.ok) setDescription(response.data)
      else setError(response.error.code)
    } catch { if (sessionRef.current === session) setError('INTERNAL_ERROR') }
    finally { if (sessionRef.current === session) setBusy(false) }
  }

  const preview = async () => {
    if (!session || !table) return
    setBusy(true)
    setError(null)
    try {
      const response = await host.dataConnections.previewTable({
        dataSessionId: session.dataSessionId,
        generation: session.generation,
        schema,
        table,
        limit: 100,
        maxRows: 100,
      })
      if (sessionRef.current !== session) return
      if (!response.ok) setError(response.error.code)
      else setResult(response.data)
    } catch { if (sessionRef.current === session) setError('INTERNAL_ERROR') }
    finally { if (sessionRef.current === session) setBusy(false) }
  }

  const execute = async () => {
    if (!session || !sql.trim()) return
    const nextQueryId = crypto.randomUUID()
    setCancelNotice(null)
    setQueryId(nextQueryId)
    setBusy(true)
    setError(null)
    try {
      const response = await host.dataConnections.executeQuery({
        dataSessionId: session.dataSessionId,
        generation: session.generation,
        queryId: nextQueryId,
        sql,
      })
      if (sessionRef.current !== session) return
      if (!response.ok) setError(response.error.code)
      else setResult(response.data)
    } catch { if (sessionRef.current === session) setError('INTERNAL_ERROR') }
    finally {
      if (sessionRef.current === session) { setBusy(false); setQueryId(null) }
    }
  }

  const cancel = async () => {
    if (!session || !queryId) return
    try {
      const response = await host.dataConnections.cancelQuery(session.dataSessionId, session.generation, queryId)
      if (sessionRef.current !== session) return
      if (!response.ok) setError(response.error.code)
      else if (response.data.outcomeUnknown) setCancelNotice('QUERY_CANCEL_OUTCOME_UNKNOWN')
    } catch { if (sessionRef.current === session) setError('INTERNAL_ERROR') }
  }

  return (
    <section data-testid="sql-query-panel" className="mt-6 border-t border-[var(--color-border)] pt-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{t('managedResources.dataBrowser.sqlTitle')}</h3>
          <p className="text-xs text-[var(--color-text-secondary)]">{t('managedResources.dataBrowser.sqlHint')}</p>
        </div>
        {session
          ? <button type="button" data-testid="data-browser-disconnect" className="rounded-md border border-[var(--color-border)] px-3 py-2 text-xs" onClick={() => void disconnect()}>{t('managedResources.dataBrowser.disconnect')}</button>
          : <button type="button" data-testid="data-browser-connect" className="rounded-md bg-[var(--color-brand)] px-3 py-2 text-xs text-[var(--color-on-primary)]" disabled={busy} onClick={() => void connect()}>{t('managedResources.dataBrowser.connect')}</button>}
      </div>
      {error && <div role="alert" className="mb-3 text-xs text-[var(--color-error)]">{dataBrowserMessage(error)}</div>}
      {cancelNotice && <div role="status" className="mb-3 text-xs text-[var(--color-text-secondary)]">{dataBrowserMessage(cancelNotice)}</div>}
      {session && (
        <>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_1fr_auto]">
            <select aria-label={t('managedResources.dataConnections.schema')} disabled={busy} data-testid="sql-schema" className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm" value={schema ?? ''} onChange={(event) => void changeSchema(event.currentTarget.value)}>
              {schema && !schemas.some(item => item.name === schema) && <option value={schema}>{schema}</option>}
              {schemas.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
            </select>
            <select aria-label={t('managedResources.dataBrowser.table')} disabled={busy} data-testid="sql-table" className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm" value={table} onChange={(event) => { setTable(event.currentTarget.value); setDescription(null); setResult(null) }}>
              {tables.map(item => <option key={`${item.schema ?? ''}.${item.name}`} value={item.name}>{item.name}</option>)}
            </select>
            <button type="button" data-testid="sql-preview" className="rounded-md border border-[var(--color-border)] px-3 text-xs" disabled={busy || !table} onClick={() => void preview()}>{t('managedResources.dataBrowser.preview')}</button>
          </div>
          <button type="button" data-testid="sql-describe" className="mt-2 rounded-md border border-[var(--color-border)] px-3 py-1 text-xs" disabled={busy || !table} onClick={() => void describe()}>{t('managedResources.dataBrowser.columns')}</button>
          {description && <div data-testid="sql-column-structure" className="mt-2 max-h-48 overflow-auto text-xs" aria-label={t('managedResources.dataBrowser.columns')}>
            {description.columns.map(column => <div key={column.ordinal} className="flex gap-3 border-b border-[var(--color-border)] py-1"><span>{column.ordinal}</span><span>{column.name}</span><span>{column.dataType}</span><span>{column.nullable ? 'NULL' : 'NOT NULL'}</span></div>)}
          </div>}
          {connection.mode === 'query' && (
            <div className="mt-4">
              <label className="text-xs text-[var(--color-text-secondary)]" htmlFor="managed-sql-query">{t('managedResources.dataBrowser.query')}</label>
              <textarea id="managed-sql-query" data-testid="sql-query-input" className="mt-1 min-h-28 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 font-mono text-xs" value={sql} onChange={(event) => setSql(event.currentTarget.value)} />
              <div className="mt-2 flex gap-2">
                <button type="button" data-testid="sql-execute" className="rounded-md bg-[var(--color-brand)] px-3 py-2 text-xs text-[var(--color-on-primary)] disabled:opacity-50" disabled={busy || !sql.trim()} onClick={() => void execute()}>{t('managedResources.dataBrowser.execute')}</button>
                {queryId && <button type="button" data-testid="sql-cancel" className="rounded-md border border-[var(--color-border)] px-3 py-2 text-xs" onClick={() => void cancel()}>{t('common.cancel')}</button>}
              </div>
            </div>
          )}
          <QueryResultGrid result={result} />
        </>
      )}
    </section>
  )
}
