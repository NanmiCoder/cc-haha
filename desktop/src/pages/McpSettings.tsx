import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../components/shared/Button'
import { Input } from '../components/shared/Input'
import { Modal } from '../components/shared/Modal'
import { useTranslation } from '../i18n'
import { useUIStore } from '../stores/uiStore'
import { useMcpStore } from '../stores/mcpStore'
import { useSessionStore } from '../stores/sessionStore'
import type { McpServerRecord, McpUpsertPayload } from '../types/mcp'

type EditorMode =
  | { type: 'list' }
  | { type: 'create' }
  | { type: 'edit'; server: McpServerRecord }
  | { type: 'details'; server: McpServerRecord }

type TransportKind = 'stdio' | 'http' | 'sse'

type StringRow = {
  id: string
  value: string
}

type KeyValueRow = {
  id: string
  key: string
  value: string
}

type McpDraft = {
  name: string
  transport: TransportKind
  command: string
  args: StringRow[]
  env: KeyValueRow[]
  url: string
  headers: KeyValueRow[]
  headersHelper: string
  oauthClientId: string
  oauthCallbackPort: string
}

type McpGroupKey =
  | 'plugin'
  | 'user'
  | 'project'
  | 'local'
  | 'managed'
  | 'enterprise'
  | 'claudeai'
  | 'dynamic'

const MCP_GROUP_ORDER: McpGroupKey[] = [
  'plugin',
  'user',
  'project',
  'local',
  'managed',
  'enterprise',
  'claudeai',
  'dynamic',
]

const STATUS_TONE: Record<McpServerRecord['status'], string> = {
  connected: 'bg-[var(--color-inspector-success-bg)] text-[var(--color-inspector-success)] border-[var(--color-border)]',
  checking: 'bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] border-[var(--color-border)]',
  'needs-auth': 'bg-[var(--color-surface-container-low)] text-[var(--color-warning)] border-[var(--color-border)]',
  failed: 'bg-[var(--color-inspector-danger-bg)] text-[var(--color-inspector-danger)] border-[var(--color-border)]',
  disabled: 'bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] border-[var(--color-border)]',
}

function createId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function createStringRow(value = ''): StringRow {
  return { id: createId(), value }
}

function createKeyValueRow(key = '', value = ''): KeyValueRow {
  return { id: createId(), key, value }
}

function createEmptyDraft(): McpDraft {
  return {
    name: '',
    transport: 'stdio',
    command: '',
    args: [createStringRow('')],
    env: [createKeyValueRow()],
    url: '',
    headers: [createKeyValueRow()],
    headersHelper: '',
    oauthClientId: '',
    oauthCallbackPort: '',
  }
}

function isStdioConfig(config: McpServerRecord['config']): config is Extract<McpServerRecord['config'], { type: 'stdio' }> {
  return config.type === 'stdio'
}

function isRemoteConfig(config: McpServerRecord['config']): config is Extract<McpServerRecord['config'], { type: 'http' | 'sse' }> {
  return config.type === 'http' || config.type === 'sse'
}

function draftFromServer(server: McpServerRecord): McpDraft {
  const base = createEmptyDraft()
  base.name = server.name

  if (isStdioConfig(server.config)) {
    return {
      ...base,
      transport: 'stdio',
      command: server.config.command,
      args: (server.config.args.length ? server.config.args : ['']).map((value) => createStringRow(value)),
      env: Object.entries(server.config.env ?? {}).map(([key, value]) => createKeyValueRow(key, value)).concat(
        Object.keys(server.config.env ?? {}).length === 0 ? [createKeyValueRow()] : [],
      ),
    }
  }

  if (isRemoteConfig(server.config)) {
    return {
      ...base,
      transport: server.config.type,
      url: server.config.url,
      headers: Object.entries(server.config.headers ?? {}).map(([key, value]) => createKeyValueRow(key, value)).concat(
        Object.keys(server.config.headers ?? {}).length === 0 ? [createKeyValueRow()] : [],
      ),
      headersHelper: server.config.headersHelper ?? '',
      oauthClientId: server.config.oauth?.clientId ?? '',
      oauthCallbackPort: server.config.oauth?.callbackPort ? String(server.config.oauth.callbackPort) : '',
    }
  }

  return base
}

function rowsToRecord(rows: KeyValueRow[]) {
  const entries: Array<[string, string]> = []
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) continue
    entries.push([key, row.value])
  }
  return Object.fromEntries(entries)
}

function rowsToList(rows: StringRow[]) {
  return rows.map((row) => row.value.trim()).filter(Boolean)
}

function buildPayload(draft: McpDraft): McpUpsertPayload {
  if (draft.transport === 'stdio') {
    return {
      scope: 'user',
      config: {
        type: 'stdio',
        command: draft.command.trim(),
        args: rowsToList(draft.args),
        env: rowsToRecord(draft.env),
      },
    }
  }

  const oauthCallbackPort = draft.oauthCallbackPort.trim()
  const callbackPortNumber = oauthCallbackPort ? Number(oauthCallbackPort) : undefined
  const oauthClientId = draft.oauthClientId.trim()

  return {
    scope: 'user',
    config: {
      type: draft.transport,
      url: draft.url.trim(),
      headers: rowsToRecord(draft.headers),
      ...(draft.headersHelper.trim() ? { headersHelper: draft.headersHelper.trim() } : {}),
      ...(oauthClientId || callbackPortNumber
        ? {
            oauth: {
              ...(oauthClientId ? { clientId: oauthClientId } : {}),
              ...(callbackPortNumber ? { callbackPort: callbackPortNumber } : {}),
            },
          }
        : {}),
    },
  }
}

function isDraftValid(draft: McpDraft) {
  if (!draft.name.trim()) return false
  if (draft.transport === 'stdio') return draft.command.trim().length > 0
  return draft.url.trim().length > 0
}

function transportLabel(transport: string, t: ReturnType<typeof useTranslation>) {
  switch (transport) {
    case 'stdio':
      return 'STDIO'
    case 'http':
      return t('settings.mcp.transport.http')
    case 'sse':
      return 'SSE'
    default:
      return transport
  }
}

function getServerGroupKey(server: McpServerRecord): McpGroupKey {
  if (server.name.startsWith('plugin:')) return 'plugin'
  switch (server.scope) {
    case 'user':
    case 'project':
    case 'local':
    case 'managed':
    case 'enterprise':
    case 'claudeai':
    case 'dynamic':
      return server.scope
    default:
      return 'dynamic'
  }
}

function scopeLabel(server: McpServerRecord, t: ReturnType<typeof useTranslation>) {
  const group = getServerGroupKey(server)
  if (group === 'plugin') return t('settings.mcp.scope.plugin')
  return t(`settings.mcp.scope.${group}`)
}

function StatusBadge({ server }: { server: McpServerRecord }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${STATUS_TONE[server.status]}`}>
      {server.statusLabel}
    </span>
  )
}

function getServerIdentityKey(server: Pick<McpServerRecord, 'name' | 'scope' | 'projectPath'>) {
  if (server.scope === 'local' || server.scope === 'project') {
    return `${server.scope}:${server.projectPath ?? ''}:${server.name}`
  }

  return `${server.scope}:${server.name}`
}

function ToggleSwitch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  onChange: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex h-8 w-14 items-center rounded-full transition-colors ${
        checked ? 'bg-[var(--color-switch-checked-bg)]' : 'bg-[var(--color-border)]'
      } ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span
        className={`inline-block h-6 w-6 transform rounded-full bg-[var(--color-switch-thumb)] shadow-sm transition-transform ${
          checked ? 'translate-x-7' : 'translate-x-1'
        }`}
      />
    </button>
  )
}

function ArraySection({
  title,
  rows,
  onChange,
  onAdd,
  onRemove,
  keyPlaceholder,
  valuePlaceholder,
  singleValue = false,
  addLabel,
}: {
  title: string
  rows: KeyValueRow[] | StringRow[]
  onChange: (id: string, field: 'key' | 'value', value: string) => void
  onAdd: () => void
  onRemove: (id: string) => void
  keyPlaceholder?: string
  valuePlaceholder: string
  singleValue?: boolean
  addLabel: string
}) {
  return (
    <section className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="text-sm font-semibold text-[var(--color-text-primary)] mb-4">{title}</div>
      <div className="space-y-3">
        {rows.map((row) => (
          <div key={row.id} className={`grid gap-3 ${singleValue ? 'grid-cols-[minmax(0,1fr)_32px]' : 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_32px]'}`}>
            {!singleValue && 'key' in row && (
              <Input
                value={row.key}
                onChange={(event) => onChange(row.id, 'key', event.target.value)}
                placeholder={keyPlaceholder}
              />
            )}
            <Input
              value={row.value}
              onChange={(event) => onChange(row.id, 'value', event.target.value)}
              placeholder={valuePlaceholder}
            />
            <button
              type="button"
              onClick={() => onRemove(row.id)}
              className="mt-1 flex h-10 w-8 items-center justify-center rounded-[var(--radius-md)] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
              aria-label={addLabel}
            >
              <span className="material-symbols-outlined text-[18px]">delete</span>
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={onAdd}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-[var(--radius-lg)] bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
        >
          <span className="material-symbols-outlined text-[18px]">add</span>
          {addLabel}
        </button>
      </div>
    </section>
  )
}

function StatCard({ label, value, icon }: { label: string; value: number; icon: string }) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-5 py-4">
      <div className="flex items-center gap-2 text-[var(--color-text-tertiary)] mb-2">
        <span className="material-symbols-outlined text-[18px]">{icon}</span>
        <span className="text-xs uppercase tracking-[0.18em] font-semibold">{label}</span>
      </div>
      <div className="text-3xl font-semibold text-[var(--color-text-primary)]">{value}</div>
    </div>
  )
}

function ServerRow({
  server,
  isBusy,
  onOpen,
  onToggle,
  t,
}: {
  server: McpServerRecord
  isBusy: boolean
  onOpen: () => void
  onToggle: () => void
  t: ReturnType<typeof useTranslation>
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4 px-6 py-5 border-t border-[var(--color-border)] first:border-t-0">
      <div className="min-w-0">
        <div className="flex items-center gap-3 mb-2 min-w-0">
          <div className="text-[1.05rem] font-semibold text-[var(--color-text-primary)] truncate">{server.name}</div>
          <StatusBadge server={server} />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-tertiary)]">
          <span className="rounded-full bg-[var(--color-surface-hover)] px-2 py-1 font-medium text-[var(--color-text-secondary)]">
            {transportLabel(server.transport, t)}
          </span>
          <span className="rounded-full bg-[var(--color-surface-hover)] px-2 py-1 font-medium text-[var(--color-text-secondary)]">
            {scopeLabel(server, t)}
          </span>
          <span className="truncate">{server.summary}</span>
        </div>
        {server.statusDetail && (
          <div className="mt-2 text-xs text-[var(--color-text-tertiary)] truncate">{server.statusDetail}</div>
        )}
      </div>

      <button
        type="button"
        onClick={onOpen}
        className="flex h-10 w-10 items-center justify-center rounded-full text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
        aria-label={`Open ${server.name}`}
      >
        <span className="material-symbols-outlined text-[20px]">settings</span>
      </button>

      <ToggleSwitch checked={server.enabled} disabled={isBusy || !server.canToggle} onChange={onToggle} />
    </div>
  )
}

export function McpSettings() {
  const { servers, selectedServer, isLoading, error, fetchServers, createServer, updateServer, deleteServer, toggleServer, reconnectServer, refreshServerStatus, selectServer } = useMcpStore()
  const addToast = useUIStore((s) => s.addToast)
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const t = useTranslation()
  const [view, setView] = useState<EditorMode>({ type: 'list' })
  const [draft, setDraft] = useState<McpDraft>(createEmptyDraft)
  const [isSaving, setIsSaving] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [busyServerName, setBusyServerName] = useState<string | null>(null)
  const [pendingDeleteServer, setPendingDeleteServer] = useState<McpServerRecord | null>(null)
  const refreshInFlightRef = useRef(new Set<string>())

  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const currentWorkDir = activeSession?.workDir || undefined
  const resolveOperationCwd = (server?: McpServerRecord) => server?.projectPath ?? currentWorkDir

  useEffect(() => {
    void fetchServers(undefined, currentWorkDir)
  }, [fetchServers, currentWorkDir])

  const groupedServers = useMemo(() => {
    const groups: Partial<Record<McpGroupKey, McpServerRecord[]>> = {}
    for (const server of servers) {
      const key = getServerGroupKey(server)
      ;(groups[key] ??= []).push(server)
    }
    return groups
  }, [servers])

  const stats = useMemo(() => ({
    total: servers.length,
    connected: servers.filter((server) => server.status === 'connected').length,
    attention: servers.filter((server) => server.status === 'failed' || server.status === 'needs-auth').length,
  }), [servers])

  const beginCreate = () => {
    setDraft(createEmptyDraft())
    setView({ type: 'create' })
  }

  const beginEdit = (server: McpServerRecord) => {
    selectServer(server)
    if (!server.canEdit) {
      setView({ type: 'details', server })
      return
    }
    setDraft(draftFromServer(server))
    setView({ type: 'edit', server })
  }

  useEffect(() => {
    if (!selectedServer) return
    if (selectedServer.canEdit) {
      setDraft(draftFromServer(selectedServer))
      setView({ type: 'edit', server: selectedServer })
    } else {
      setView({ type: 'details', server: selectedServer })
    }
  }, [selectedServer])

  useEffect(() => {
    const pendingServers = servers.filter((server) => (
      server.enabled &&
      server.status === 'checking' &&
      !refreshInFlightRef.current.has(getServerIdentityKey(server))
    ))

    if (pendingServers.length === 0) return

    let cancelled = false
    const queue = [...pendingServers]
    const workerCount = Math.min(2, queue.length)

    const runWorker = async () => {
      while (!cancelled) {
        const server = queue.shift()
        if (!server) return

        const key = getServerIdentityKey(server)
        refreshInFlightRef.current.add(key)
        try {
          const updated = await refreshServerStatus(server, resolveOperationCwd(server))
          if (cancelled) return

          setView((current) => {
            if (current.type !== 'details' && current.type !== 'edit') return current
            if (getServerIdentityKey(current.server) !== key) return current
            return { ...current, server: updated }
          })
        } catch {
          // Keep passive checks silent. Explicit reconnect remains the action that
          // surfaces failures to the user.
        } finally {
          refreshInFlightRef.current.delete(key)
        }
      }
    }

    void Promise.all(Array.from({ length: workerCount }, () => runWorker()))

    return () => {
      cancelled = true
    }
  }, [servers, refreshServerStatus, currentWorkDir])

  const handleToggle = async (server: McpServerRecord) => {
    setBusyServerName(server.name)
    try {
      const updated = await toggleServer(server, resolveOperationCwd(server))
      addToast({
        type: 'success',
        message: updated.enabled ? t('settings.mcp.toast.enabled', { name: server.name }) : t('settings.mcp.toast.disabled', { name: server.name }),
      })
    } catch (error) {
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('settings.mcp.toast.toggleFailed'),
      })
    } finally {
      setBusyServerName(null)
    }
  }

  const handleReconnect = async (server: McpServerRecord) => {
    const optimistic = {
      ...server,
      status: 'checking' as const,
      statusLabel: t('status.reconnecting'),
      statusDetail: undefined,
    }

    setBusyServerName(server.name)
    setView((current) => {
      if (current.type !== 'details' && current.type !== 'edit') return current
      if (getServerIdentityKey(current.server) !== getServerIdentityKey(server)) return current
      return { ...current, server: optimistic }
    })
    try {
      const updated = await reconnectServer(server, resolveOperationCwd(server))
      addToast({
        type: updated.status === 'connected' ? 'success' : 'warning',
        message: updated.status === 'connected'
          ? t('settings.mcp.toast.reconnected', { name: server.name })
          : updated.statusDetail || updated.statusLabel,
      })
      if (view.type === 'edit') setView({ type: 'edit', server: updated })
      if (view.type === 'details') setView({ type: 'details', server: updated })
    } catch (error) {
      setView((current) => {
        if (current.type !== 'details' && current.type !== 'edit') return current
        if (getServerIdentityKey(current.server) !== getServerIdentityKey(server)) return current
        return { ...current, server }
      })
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('settings.mcp.toast.reconnectFailed'),
      })
    } finally {
      setBusyServerName(null)
    }
  }

  const handleDelete = (server: McpServerRecord) => {
    setPendingDeleteServer(server)
  }

  const confirmDelete = async () => {
    const server = pendingDeleteServer
    if (!server) return
    setIsDeleting(true)
    try {
      await deleteServer(server, resolveOperationCwd(server))
      addToast({
        type: 'success',
        message: t('settings.mcp.toast.deleted', { name: server.name }),
      })
      setView({ type: 'list' })
      selectServer(null)
      setPendingDeleteServer(null)
    } catch (error) {
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('settings.mcp.toast.deleteFailed'),
      })
    } finally {
      setIsDeleting(false)
    }
  }

  const deleteModal = (
    <Modal
      open={pendingDeleteServer !== null}
      onClose={() => {
        if (isDeleting) return
        setPendingDeleteServer(null)
      }}
      title={t('settings.mcp.form.deleteTitle')}
      footer={(
        <>
          <Button variant="ghost" onClick={() => setPendingDeleteServer(null)} disabled={isDeleting}>
            {t('settings.mcp.form.cancel')}
          </Button>
          <Button variant="danger" onClick={confirmDelete} loading={isDeleting}>
            {t('settings.mcp.form.confirmDelete')}
          </Button>
        </>
      )}
    >
      <p className="text-sm leading-6 text-[var(--color-text-secondary)]">
        {pendingDeleteServer ? t('settings.mcp.form.deleteConfirmBody', { name: pendingDeleteServer.name }) : ''}
      </p>
    </Modal>
  )

  const handleSave = async () => {
    if (!isDraftValid(draft)) return
    setIsSaving(true)
    try {
      const payload = buildPayload(draft)
      const saved = view.type === 'edit'
        ? await updateServer(view.server, payload, resolveOperationCwd(view.server))
        : await createServer(draft.name.trim(), payload, currentWorkDir)

      addToast({
        type: 'success',
        message: view.type === 'edit'
          ? t('settings.mcp.toast.saved', { name: saved.name })
          : t('settings.mcp.toast.created', { name: saved.name }),
      })
      setView({ type: 'list' })
      selectServer(null)
    } catch (error) {
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('settings.mcp.toast.saveFailed'),
      })
    } finally {
      setIsSaving(false)
    }
  }

  const setDraftField = <K extends keyof McpDraft>(key: K, value: McpDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  const updateStringRows = (key: 'args', id: string, value: string) => {
    setDraft((current) => ({
      ...current,
      [key]: current[key].map((row) => (row.id === id ? { ...row, value } : row)),
    }))
  }

  const updateKeyValueRows = (key: 'env' | 'headers', id: string, field: 'key' | 'value', value: string) => {
    setDraft((current) => ({
      ...current,
      [key]: current[key].map((row) => (row.id === id ? { ...row, [field]: value } : row)),
    }))
  }

  const addRow = (key: 'args' | 'env' | 'headers') => {
    setDraft((current) => ({
      ...current,
      [key]: [...current[key], key === 'args' ? createStringRow() : createKeyValueRow()],
    }))
  }

  const removeRow = (key: 'args' | 'env' | 'headers', id: string) => {
    setDraft((current) => {
      const next = current[key].filter((row) => row.id !== id)
      return {
        ...current,
        [key]: next.length > 0 ? next : [key === 'args' ? createStringRow() : createKeyValueRow()],
      }
    })
  }

  if (view.type === 'details') {
    const server = view.server
    return (
      <>
        <div className="max-w-5xl min-w-0">
          <button
            type="button"
            onClick={() => setView({ type: 'list' })}
            className="mb-5 inline-flex items-center gap-2 text-sm text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
          >
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
            {t('settings.mcp.form.back')}
          </button>

          <div className="flex items-start justify-between gap-4 mb-8">
            <div>
              <h2 className="text-[2.2rem] font-semibold tracking-[-0.03em] text-[var(--color-text-primary)]">{server.name}</h2>
              <p className="mt-3 text-base text-[var(--color-text-secondary)]">{server.summary}</p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <StatusBadge server={server} />
                {server.statusDetail && (
                  <span className="text-sm text-[var(--color-text-tertiary)]">{server.statusDetail}</span>
                )}
              </div>
            </div>
            {server.canReconnect && (
              <Button variant="secondary" onClick={() => handleReconnect(server)} loading={busyServerName === server.name}>
                <span className="material-symbols-outlined text-[16px]">sync</span>
                {t('settings.mcp.form.reconnect')}
              </Button>
            )}
          </div>

          <section className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
            <div className="grid gap-4 md:grid-cols-2">
              <InfoPair label={t('settings.mcp.form.transport')} value={transportLabel(server.transport, t)} />
              <InfoPair label={t('settings.mcp.form.scope')} value={scopeLabel(server, t)} />
              <InfoPair label={t('settings.mcp.form.status')} value={server.statusLabel} />
              <InfoPair label={t('settings.mcp.form.location')} value={server.configLocation} />
            </div>
            <div className="mt-5">
              <div className="text-sm font-semibold text-[var(--color-text-primary)] mb-2">{t('settings.mcp.form.rawConfig')}</div>
              <pre className="overflow-x-auto rounded-[var(--radius-lg)] bg-[var(--color-surface-hover)] p-4 text-xs text-[var(--color-text-secondary)]">
                {JSON.stringify(server.config, null, 2)}
              </pre>
            </div>
          </section>
        </div>
        {deleteModal}
      </>
    )
  }

  if (view.type === 'create' || view.type === 'edit') {
    const editing = view.type === 'edit'
    const targetServer = editing ? view.server : null
    const transportLocked = editing
    const isBusy = isSaving || isDeleting

    return (
      <>
        <div className="max-w-5xl min-w-0">
          <button
            type="button"
            onClick={() => setView({ type: 'list' })}
            className="mb-5 inline-flex items-center gap-2 text-sm text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
          >
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
            {t('settings.mcp.form.back')}
          </button>

          <div className="flex items-start justify-between gap-4 mb-8">
            <div>
              <h2 className="text-[2.2rem] font-semibold tracking-[-0.03em] text-[var(--color-text-primary)]">
                {editing ? t('settings.mcp.form.editTitle', { name: targetServer!.name }) : t('settings.mcp.form.createTitle')}
              </h2>
              <p className="mt-3 text-base text-[var(--color-text-secondary)]">
                {editing ? t('settings.mcp.form.editHint') : t('settings.mcp.form.createHint')}
              </p>
              {editing && targetServer && (
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <StatusBadge server={targetServer} />
                  {targetServer.statusDetail && (
                    <span className="text-sm text-[var(--color-text-tertiary)]">{targetServer.statusDetail}</span>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center gap-3">
              {editing && targetServer?.canReconnect && (
                <Button variant="secondary" onClick={() => handleReconnect(targetServer)} loading={busyServerName === targetServer.name}>
                  <span className="material-symbols-outlined text-[16px]">sync</span>
                  {t('settings.mcp.form.reconnect')}
                </Button>
              )}
              {editing && targetServer?.canRemove && (
                <Button
                  variant="ghost"
                  className="text-[var(--color-error)] hover:text-[var(--color-error)] hover:bg-[var(--color-error)]/8"
                  onClick={() => handleDelete(targetServer)}
                  loading={isDeleting}
                >
                  <span className="material-symbols-outlined text-[16px]">delete</span>
                  {t('settings.mcp.form.uninstall')}
                </Button>
              )}
            </div>
          </div>

          <div className="space-y-4">
          <section className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
            <Input
              label={t('settings.mcp.form.name')}
              value={draft.name}
              onChange={(event) => setDraftField('name', event.target.value)}
              placeholder={t('settings.mcp.form.namePlaceholder')}
              disabled={editing}
              required
            />
          </section>

          <section className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
            <div className="text-sm font-semibold text-[var(--color-text-primary)] mb-2">
              {t('settings.mcp.form.scope')}
            </div>
            <p className="text-xs leading-5 text-[var(--color-text-tertiary)]">
              {t('settings.mcp.globalOnlyHint')}
            </p>
          </section>

          <section className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
            <div className="grid grid-cols-3">
              {(['stdio', 'http', 'sse'] as TransportKind[]).map((transport) => {
                const active = draft.transport === transport
                return (
                  <button
                    key={transport}
                    type="button"
                    disabled={transportLocked}
                    onClick={() => setDraftField('transport', transport)}
                    className={`h-14 text-sm font-semibold transition-colors ${
                      active
                        ? 'bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]'
                        : 'bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
                    } ${transportLocked ? 'cursor-not-allowed opacity-70' : ''}`}
                  >
                    {transport === 'stdio' ? 'STDIO' : transportLabel(transport, t)}
                  </button>
                )
              })}
            </div>
          </section>

          {editing && (
            <div className="text-sm text-[var(--color-text-tertiary)]">
              {t('settings.mcp.form.transportLocked')}
            </div>
          )}

          {draft.transport === 'stdio' ? (
            <>
              <section className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
                <Input
                  label={t('settings.mcp.form.command')}
                  value={draft.command}
                  onChange={(event) => setDraftField('command', event.target.value)}
                  placeholder={t('settings.mcp.form.commandPlaceholder')}
                  required
                />
                <p className="mt-2 text-xs leading-5 text-[var(--color-text-tertiary)]">
                  {t('settings.mcp.form.commandHostHint')}
                </p>
              </section>

              <ArraySection
                title={t('settings.mcp.form.arguments')}
                rows={draft.args}
                onChange={(id, _field, value) => updateStringRows('args', id, value)}
                onAdd={() => addRow('args')}
                onRemove={(id) => removeRow('args', id)}
                singleValue
                valuePlaceholder={t('settings.mcp.form.argumentPlaceholder')}
                addLabel={t('settings.mcp.form.addArgument')}
              />

              <ArraySection
                title={t('settings.mcp.form.environmentVariables')}
                rows={draft.env}
                onChange={(id, field, value) => updateKeyValueRows('env', id, field, value)}
                onAdd={() => addRow('env')}
                onRemove={(id) => removeRow('env', id)}
                keyPlaceholder={t('settings.mcp.form.keyPlaceholder')}
                valuePlaceholder={t('settings.mcp.form.valuePlaceholder')}
                addLabel={t('settings.mcp.form.addEnv')}
              />
            </>
          ) : (
            <>
              <section className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
                <Input
                  label={draft.transport === 'http' ? t('settings.mcp.form.url') : t('settings.mcp.form.sseUrl')}
                  value={draft.url}
                  onChange={(event) => setDraftField('url', event.target.value)}
                  placeholder={t('settings.mcp.form.urlPlaceholder')}
                  required
                />
              </section>

              <ArraySection
                title={t('settings.mcp.form.headers')}
                rows={draft.headers}
                onChange={(id, field, value) => updateKeyValueRows('headers', id, field, value)}
                onAdd={() => addRow('headers')}
                onRemove={(id) => removeRow('headers', id)}
                keyPlaceholder={t('settings.mcp.form.keyPlaceholder')}
                valuePlaceholder={t('settings.mcp.form.valuePlaceholder')}
                addLabel={t('settings.mcp.form.addHeader')}
              />

              <section className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
                <div className="grid gap-4 md:grid-cols-2">
                  <Input
                    label={t('settings.mcp.form.oauthClientId')}
                    value={draft.oauthClientId}
                    onChange={(event) => setDraftField('oauthClientId', event.target.value)}
                    placeholder={t('settings.mcp.form.oauthClientIdPlaceholder')}
                  />
                  <Input
                    label={t('settings.mcp.form.oauthCallbackPort')}
                    value={draft.oauthCallbackPort}
                    onChange={(event) => setDraftField('oauthCallbackPort', event.target.value)}
                    placeholder={t('settings.mcp.form.oauthCallbackPortPlaceholder')}
                  />
                </div>
                <div className="mt-4">
                  <Input
                    label={t('settings.mcp.form.headersHelper')}
                    value={draft.headersHelper}
                    onChange={(event) => setDraftField('headersHelper', event.target.value)}
                    placeholder={t('settings.mcp.form.headersHelperPlaceholder')}
                  />
                </div>
              </section>
            </>
          )}

          <div className="flex justify-end pt-2">
            <Button onClick={handleSave} disabled={!isDraftValid(draft) || isBusy} loading={isSaving}>
              {t('settings.mcp.form.save')}
            </Button>
          </div>
        </div>
        </div>
        {deleteModal}
      </>
    )
  }

  return (
    <div className="max-w-5xl min-w-0">
      <div className="flex items-start justify-between gap-6 mb-8">
        <div>
          <h2 className="text-[2.2rem] font-semibold tracking-[-0.03em] text-[var(--color-text-primary)]">
            {t('settings.mcp.title')}
          </h2>
          <p className="mt-3 text-base text-[var(--color-text-secondary)]">
            {t('settings.mcp.description')}
          </p>
        </div>
        <Button variant="secondary" size="lg" onClick={beginCreate}>
          <span className="material-symbols-outlined text-[18px]">add</span>
          {t('settings.mcp.addServer')}
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-3 mb-8">
        <StatCard label={t('settings.mcp.stats.total')} value={stats.total} icon="dns" />
        <StatCard label={t('settings.mcp.stats.connected')} value={stats.connected} icon="check_circle" />
        <StatCard label={t('settings.mcp.stats.attention')} value={stats.attention} icon="error" />
      </div>

      {isLoading && servers.length === 0 ? (
        <div className="flex justify-center py-16">
          <div className="animate-spin h-6 w-6 rounded-full border-2 border-[var(--color-brand)] border-t-transparent" />
        </div>
      ) : error ? (
        <div className="text-center py-16 rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
          <span className="material-symbols-outlined text-[40px] text-[var(--color-error)] mb-3 block">error</span>
          <p className="text-sm text-[var(--color-error)] mb-3">{error}</p>
          <button
            type="button"
            onClick={() => void fetchServers(undefined, currentWorkDir)}
            className="text-sm text-[var(--color-text-accent)] hover:underline"
          >
            {t('common.retry')}
          </button>
        </div>
      ) : servers.length === 0 ? (
        <div className="text-center py-16 rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
          <span className="material-symbols-outlined text-[40px] text-[var(--color-text-tertiary)] mb-3 block">dns</span>
          <p className="text-sm text-[var(--color-text-secondary)] mb-1">{t('settings.mcp.empty')}</p>
          <p className="text-xs text-[var(--color-text-tertiary)]">{t('settings.mcp.emptyHint')}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {MCP_GROUP_ORDER.map((group) => {
            const groupServers = groupedServers[group]
            if (!groupServers?.length) return null

            return (
              <section key={group}>
                <div className="flex items-center justify-between mb-3">
                  <div className="text-[1.35rem] font-semibold text-[var(--color-text-primary)]">
                    {group === 'plugin' ? t('settings.mcp.scope.plugin') : t(`settings.mcp.scope.${group}`)}
                  </div>
                  <div className="text-sm text-[var(--color-text-tertiary)]">{groupServers.length}</div>
                </div>
                <div className="rounded-[28px] border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
                  {groupServers.map((server) => (
                    <ServerRow
                      key={`${server.scope}:${server.name}`}
                      server={server}
                      isBusy={busyServerName === server.name}
                      onOpen={() => beginEdit(server)}
                      onToggle={() => void handleToggle(server)}
                      t={t}
                    />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}
      {deleteModal}
    </div>
  )
}

function InfoPair({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-lg)] bg-[var(--color-surface-hover)] px-4 py-3">
      <div className="text-xs uppercase tracking-[0.16em] font-semibold text-[var(--color-text-tertiary)] mb-2">{label}</div>
      <div className="text-sm text-[var(--color-text-primary)] break-all">{value}</div>
    </div>
  )
}
