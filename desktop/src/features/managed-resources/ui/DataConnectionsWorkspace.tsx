import { useEffect, useMemo, useRef, useState } from 'react'
import { getDesktopHost } from '../../../lib/desktopHost'
import { useTranslation } from '../../../i18n'
import type {
  CreateDataConnectionInput,
  DataConnectionTestResult,
} from '../api/dataConnectionsApi'
import type { DataConnection } from '../types/dataConnectionTypes'
import { SqlQueryPanel } from './dataConnections/SqlQueryPanel'
import { RedisBrowser } from './dataConnections/RedisBrowser'
import { DataConnectionRelations } from './dataConnections/DataConnectionRelations'
import { ProtectedPasswordReveal } from './ProtectedPasswordReveal'

type Draft = CreateDataConnectionInput
type DatabaseDraft = Extract<Draft, { kind: 'database' }>
type RedisDraft = Extract<Draft, { kind: 'redis' }>
type DraftField = keyof DatabaseDraft | keyof RedisDraft
type DraftFieldValue<K extends DraftField> =
  K extends keyof DatabaseDraft ? DatabaseDraft[K]
    : K extends keyof RedisDraft ? RedisDraft[K]
      : never

type KindFilter = 'all' | 'database' | 'redis'

function defaultTls() {
  return {
    enabled: false,
    serverName: null,
    caCertificate: null,
    clientCertificate: null,
    clientKeyCredentialId: null,
  }
}

function createDraft(kind: 'database' | 'redis'): Draft {
  const common = {
    name: '',
    address: '127.0.0.1',
    port: kind === 'database' ? 3306 : 6379,
    username: null,
    credentialId: null,
    tagIds: [],
    relatedHostId: null,
    environment: 'unspecified' as const,
    tls: defaultTls(),
    description: '',
    accessInstructions: '',
  }
  return kind === 'database'
    ? {
        ...common,
        kind: 'database',
        engine: 'mysql',
        database: '',
        schema: null,
        mode: 'inspection',
      }
    : {
        ...common,
        kind: 'redis',
        topology: 'standalone',
        databaseIndex: 0,
        keyPrefixDescription: '',
      }
}

function draftFromConnection(connection: DataConnection): Draft {
  const common = {
    name: connection.name,
    address: connection.address,
    port: connection.port,
    username: connection.username,
    credentialId: connection.credentialId,
    tagIds: [...connection.tagIds],
    relatedHostId: connection.relatedHostId,
    environment: connection.environment,
    tls: { ...connection.tls },
    description: connection.description,
    accessInstructions: connection.accessInstructions,
  }
  return connection.kind === 'database'
    ? {
        ...common,
        kind: 'database',
        engine: connection.engine,
        database: connection.database,
        schema: connection.schema,
        mode: connection.mode,
      }
    : {
        ...common,
        kind: 'redis',
        topology: 'standalone',
        databaseIndex: connection.databaseIndex,
        keyPrefixDescription: connection.keyPrefixDescription,
      }
}

function Field(props: {
  label: string
  value: string | number
  type?: 'text' | 'number' | 'password'
  onChange: (value: string) => void
  placeholder?: string
  testId?: string
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--color-text-secondary)]">
      <span>{props.label}</span>
      <input
        data-testid={props.testId}
        className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-border-focus)]"
        type={props.type ?? 'text'}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      />
    </label>
  )
}

function SelectField(props: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--color-text-secondary)]">
      <span>{props.label}</span>
      <select
        className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text-primary)]"
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  )
}

function statusText(result: DataConnectionTestResult | null): string {
  if (!result) return ''
  if (!result.ok) return result.errorCode ?? 'CONNECTION_FAILED'
  return result.serverVersion
    ? `${result.latencyMs} ms · ${result.serverVersion}`
    : `${result.latencyMs} ms`
}

export function DataConnectionsWorkspace() {
  const host = getDesktopHost()
  const t = useTranslation()
  const [connections, setConnections] = useState<DataConnection[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(() => createDraft('database'))
  const [secretInput, setSecretInput] = useState('')
  const [filter, setFilter] = useState<KindFilter>('all')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<DataConnectionTestResult | null>(null)
  const [relationsPending, setRelationsPending] = useState(false)
  const portEdited = useRef(false)
  const formBusy = saving || testing || relationsPending

  const selected = useMemo(
    () => connections.find((connection) => connection.id === selectedId) ?? null,
    [connections, selectedId],
  )

  const visibleConnections = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return connections.filter((connection) => {
      if (filter !== 'all' && connection.kind !== filter) return false
      if (!needle) return true
      return `${connection.name} ${connection.address} ${connection.description}`.toLowerCase().includes(needle)
    })
  }, [connections, filter, query])

  const load = async (nextSelectedId?: string | null) => {
    setLoading(true)
    setError(null)
    try {
      const result = await host.dataConnections.list()
      if (!result.ok) {
        setError(result.error.code)
        return
      }
      setConnections(result.data)
      const desired = nextSelectedId === undefined ? selectedId : nextSelectedId
      if (desired) {
        const found = result.data.find((connection) => connection.id === desired) ?? null
        if (found) {
          setSelectedId(found.id)
          setDraft(draftFromConnection(found))
        } else {
          setSelectedId(null)
        }
      }
    } catch { setError('INTERNAL_ERROR') }
    finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [])

  const select = (connection: DataConnection) => {
    portEdited.current = true
    setSelectedId(connection.id)
    setDraft(draftFromConnection(connection))
    setSecretInput('')
    setTestResult(null)
    setError(null)
  }

  const beginCreate = (kind: 'database' | 'redis') => {
    portEdited.current = false
    setSelectedId(null)
    setDraft(createDraft(kind))
    setSecretInput('')
    setTestResult(null)
    setError(null)
  }

  const update = <K extends DraftField>(key: K, value: DraftFieldValue<K>) => {
    if (key === 'port') portEdited.current = true
    setDraft((current) => ({ ...current, [key]: value }) as Draft)
  }

  const changeEngine = (engine: DatabaseDraft['engine']) => {
    setDraft(current => current.kind !== 'database' ? current : {
      ...current, engine, port: portEdited.current ? current.port : engine === 'postgresql' ? 5432 : 3306,
    })
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    setTestResult(null)
    try {
      const connection = {
        ...draft,
        ...(secretInput ? { password: secretInput } : {}),
      } as CreateDataConnectionInput
      const result = selected
        ? await host.dataConnections.save({
            mode: 'update',
            id: selected.id,
            expectedRevision: selected.revision,
            connection,
          })
        : await host.dataConnections.save({ mode: 'create', connection })
      if (!result.ok) {
        setError(result.error.code)
        return
      }
      setSecretInput('')
      await load(result.data.id)
    } catch { setError('INTERNAL_ERROR') }
    finally { setSaving(false) }
  }

  const remove = async () => {
    if (!selected) return
    setSaving(true)
    setError(null)
    try {
      const result = await host.dataConnections.delete(selected.id, selected.revision)
      if (!result.ok) {
        setError(result.error.code)
        return
      }
      beginCreate(selected.kind)
      await load(null)
    } catch { setError('INTERNAL_ERROR') }
    finally { setSaving(false) }
  }

  const testConnection = async () => {
    setTesting(true)
    setError(null)
    setTestResult(null)
    try {
      const connection = {
        ...draft,
        ...(secretInput ? { password: secretInput } : {}),
      } as CreateDataConnectionInput
      const result = await host.dataConnections.testConnection({ connection })
      if (!result.ok) {
        setError(result.error.code)
        return
      }
      setTestResult(result.data)
    } catch { setError('INTERNAL_ERROR') }
    finally { setTesting(false) }
  }

  return (
    <div data-testid="data-connections-workspace" className="flex min-h-0 flex-1 flex-col overflow-auto md:flex-row md:overflow-hidden">
      <aside className="flex max-h-64 w-full flex-shrink-0 flex-col border-r md:max-h-none md:w-80 border-[var(--color-border)] bg-[var(--color-surface-sidebar)]">
        <div className="border-b border-[var(--color-border)] p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold text-[var(--color-text-primary)]">{t('managedResources.dataConnections.title')}</h2>
            <div className="flex gap-1">
              <button type="button" disabled={formBusy} data-testid="new-database" className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs" onClick={() => beginCreate('database')}>+ DB</button>
              <button type="button" disabled={formBusy} data-testid="new-redis" className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs" onClick={() => beginCreate('redis')}>+ Redis</button>
            </div>
          </div>
          <input
            aria-label={t('managedResources.dataConnections.search')}
            className="mb-2 h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <div className="flex gap-1">
            {(['all', 'database', 'redis'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                className={`rounded-md px-2 py-1 text-xs ${filter === kind ? 'bg-[var(--color-surface-selected)]' : 'hover:bg-[var(--color-surface-hover)]'}`}
                onClick={() => setFilter(kind)}
              >
                {kind === 'all' ? t('managedResources.dataConnections.all') : kind === 'database' ? 'DB' : 'Redis'}
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loading && <div className="p-3 text-xs text-[var(--color-text-secondary)]">{t('common.loading')}</div>}
          {!loading && visibleConnections.map((connection) => (
            <button
              key={connection.id}
              disabled={formBusy}
              type="button"
              data-testid={`data-connection-row-${connection.id}`}
              className={`mb-1 w-full rounded-md px-3 py-2 text-left ${selectedId === connection.id ? 'bg-[var(--color-surface-selected)]' : 'hover:bg-[var(--color-surface-hover)]'}`}
              onClick={() => select(connection)}
            >
              <div className="truncate text-sm font-medium">{connection.name}</div>
              <div className="truncate text-xs text-[var(--color-text-secondary)]">{connection.kind === 'database' ? connection.engine : 'Redis'} · {connection.address}:{connection.port}</div>
            </button>
          ))}
          {!loading && visibleConnections.length === 0 && (
            <div className="p-3 text-xs text-[var(--color-text-secondary)]">{t('managedResources.dataConnections.empty')}</div>
          )}
        </div>
      </aside>

      <main className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-4xl">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">{selected ? selected.name : t('managedResources.dataConnections.new')}</h2>
              <p className="mt-1 text-xs text-[var(--color-text-secondary)]">{t('managedResources.dataConnections.secretHint')}</p>
            </div>
            <div className="flex gap-2">
              {selected && <button type="button" data-testid="delete-data-connection" className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm" disabled={formBusy} onClick={() => void remove()}>{t('common.delete')}</button>}
              <button type="button" data-testid="test-data-connection" className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm" disabled={formBusy || !draft.name || !draft.address || (draft.kind === 'database' && !draft.database)} onClick={() => void testConnection()}>{testing ? t('common.loading') : t('managedResources.dataConnections.test')}</button>
              <button type="button" data-testid="save-data-connection" className="rounded-md bg-[var(--color-brand)] px-3 py-2 text-sm text-[var(--color-on-primary)] disabled:opacity-50" disabled={formBusy || !draft.name || !draft.address || (draft.kind === 'database' && !draft.database)} onClick={() => void save()}>{saving ? t('common.loading') : t('common.save')}</button>
            </div>
          </div>

          {error && <div role="alert" className="mb-4 rounded-md border border-[var(--color-error)] p-3 text-sm text-[var(--color-error)]">{error}</div>}
          {testResult && (
            <div data-testid="data-connection-test-result" className={`mb-4 rounded-md border p-3 text-sm ${testResult.ok ? 'border-[var(--color-success)]' : 'border-[var(--color-error)]'}`}>
              {statusText(testResult)}
            </div>
          )}

          <fieldset disabled={formBusy} className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <SelectField
              label={t('managedResources.dataConnections.kind')}
              value={draft.kind}
              disabled={Boolean(selected)}
              options={[{ value: 'database', label: 'Database' }, { value: 'redis', label: 'Redis' }]}
              onChange={(value) => beginCreate(value === 'redis' ? 'redis' : 'database')}
            />
            <Field label={t('managedResources.dataConnections.name')} value={draft.name} testId="data-connection-name" onChange={(value) => update('name', value)} />
            <Field label={t('managedResources.dataConnections.address')} value={draft.address} testId="data-connection-address" onChange={(value) => update('address', value)} />
            <Field label={t('managedResources.dataConnections.port')} type="number" value={draft.port} testId="data-connection-port" onChange={(value) => update('port', Number(value))} />
            <Field label={t('managedResources.dataConnections.username')} value={draft.username ?? ''} onChange={(value) => update('username', value.trim() ? value : null)} />
            <div className="flex min-w-0 flex-col gap-2">
              <Field label={t('managedResources.dataConnections.password')} type="password" value={secretInput} testId="data-connection-secret" placeholder={selected?.credentialId ? t('managedResources.dataConnections.passwordKeep') : ''} onChange={setSecretInput} />
              {selected?.credentialId && (
                <ProtectedPasswordReveal
                  credentialId={selected.credentialId}
                  label={t('managedResources.passwordReveal.dataLabel' as never) || 'Connection password'}
                  compact
                />
              )}
            </div>

            {draft.kind === 'database' ? (
              <>
                <SelectField label={t('managedResources.dataConnections.engine')} value={draft.engine} options={[{ value: 'mysql', label: 'MySQL' }, { value: 'mariadb', label: 'MariaDB' }, { value: 'postgresql', label: 'PostgreSQL' }]} onChange={(value) => changeEngine(value as DatabaseDraft['engine'])} />
                <Field label={t('managedResources.dataConnections.database')} value={draft.database} testId="data-connection-database" onChange={(value) => update('database', value)} />
                <Field label={t('managedResources.dataConnections.schema')} value={draft.schema ?? ''} onChange={(value) => update('schema', value.trim() ? value : null)} />
                <SelectField label={t('managedResources.dataConnections.mode')} value={draft.mode} options={[{ value: 'inspection', label: t('managedResources.dataConnections.inspection') }, { value: 'query', label: t('managedResources.dataConnections.query') }]} onChange={(value) => update('mode', value as DatabaseDraft['mode'])} />
              </>
            ) : (
              <>
                <Field label={t('managedResources.dataConnections.databaseIndex')} type="number" value={draft.databaseIndex} onChange={(value) => update('databaseIndex', Number(value))} />
                <Field label={t('managedResources.dataConnections.keyPrefix')} value={draft.keyPrefixDescription} onChange={(value) => update('keyPrefixDescription', value)} />
              </>
            )}

            <SelectField label={t('managedResources.dataConnections.environment')} value={draft.environment} options={['unspecified', 'development', 'test', 'staging', 'production'].map(value => ({ value, label: value }))} onChange={(value) => update('environment', value as DatabaseDraft['environment'])} />
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input type="checkbox" checked={draft.tls.enabled} onChange={(event) => update('tls', { ...draft.tls, enabled: event.currentTarget.checked })} />
              {t('managedResources.dataConnections.tls')}
            </label>
            {draft.tls.enabled && (
              <>
                <Field label={t('managedResources.dataConnections.serverName')} value={draft.tls.serverName ?? ''} onChange={(value) => update('tls', { ...draft.tls, serverName: value.trim() ? value : null })} />
                <label className="flex flex-col gap-1 text-xs text-[var(--color-text-secondary)] md:col-span-2">
                  <span>{t('managedResources.dataConnections.caCertificate')}</span>
                  <textarea className="min-h-24 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 font-mono text-xs" value={draft.tls.caCertificate ?? ''} onChange={(event) => update('tls', { ...draft.tls, caCertificate: event.currentTarget.value || null })} />
                </label>
              </>
            )}
            <label className="flex flex-col gap-1 text-xs text-[var(--color-text-secondary)] md:col-span-2">
              <span>{t('managedResources.dataConnections.description')}</span>
              <textarea className="min-h-20 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm" value={draft.description} onChange={(event) => update('description', event.currentTarget.value)} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--color-text-secondary)] md:col-span-2">
              <span>{t('managedResources.dataConnections.accessInstructions')}</span>
              <textarea className="min-h-20 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm" value={draft.accessInstructions} onChange={(event) => update('accessInstructions', event.currentTarget.value)} />
            </label>
          </fieldset>
          <DataConnectionRelations key={`${draft.kind}:${selectedId ?? 'new'}`} namespace={draft.kind} tagIds={draft.tagIds} relatedHostId={draft.relatedHostId} disabled={formBusy} onTagsChange={ids => update('tagIds', ids)} onHostChange={id => update('relatedHostId', id)} onPendingChange={setRelationsPending} />
          {selected?.kind === 'database' && <SqlQueryPanel key={`${selected.id}:${selected.revision}`} connection={selected} />}
          {selected?.kind === 'redis' && <RedisBrowser key={`${selected.id}:${selected.revision}`} connection={selected} />}
        </div>
      </main>
    </div>
  )
}
