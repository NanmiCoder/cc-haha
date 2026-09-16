import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Switch } from '@/components/ui/Switch'
import { LoadingState } from '@/components/ui/LoadingState'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { IconButton } from '@/components/ui/IconButton'
import { mcpStatusTone } from '@/lib/mcpStatus'
import { getMcpServerIdentityKey } from '@/lib/mcpIdentity'
import { DirectoryPicker } from '@/components/composite/DirectoryPicker'
import { SettingsPageHeader } from '@/components/settings/SettingsSection'
import { Input } from '@/components/ui/Input'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useTranslation } from '../i18n'
import { useUIStore } from '../stores/uiStore'
import { useMcpStore } from '../stores/mcpStore'
import { useSessionStore } from '../stores/sessionStore'
import type { McpServerRecord, McpUpsertPayload, McpWritableScope } from '../types/mcp'

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
  scope: McpWritableScope
  projectPath: string
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

const WRITABLE_SCOPES: McpWritableScope[] = ['local', 'project', 'user']

const SENSITIVE_MCP_FIELD = /(?:api[_-]?key|auth[_-]?token|authorization|bearer|token|secret|password|credential)/i
const SENSITIVE_CLI_FLAG = /^--(?:api-key|api_key|auth-token|auth_token|authorization|bearer|token|secret|password|credential)$/i
const REDACTED_INPUT_VALUE = '[redacted]'

function isMcpServerNameValid(name: string): boolean {
  const trimmed = name.trim()
  return trimmed.length > 0 && !/[^\p{L}\p{N}_-]/u.test(trimmed)
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/(bearer\s+)(?:"[^"]+"|'[^']+'|[^\s"',}]+)/gi, '$1[redacted]')
    .replace(/(--(?:api-key|api_key|auth-token|auth_token|authorization|bearer|token|secret|password|credential)(?:=|\s+))(?:"[^"]+"|'[^']+'|[^\s"',}]+)/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|auth[_-]?token|authorization|bearer|token|secret|password|credential)(?:["']?\s*[:=]\s*["']?))([^"',\s}]+)/gi, '$1[redacted]')
    .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{5,}\b/g, '[redacted]')
}

function redactMcpDisplayValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveText(value)
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const previous = value[index - 1]
      if (typeof previous === 'string' && SENSITIVE_CLI_FLAG.test(previous)) return '[redacted]'
      return redactMcpDisplayValue(item)
    })
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        SENSITIVE_MCP_FIELD.test(key) ? '[redacted]' : redactMcpDisplayValue(nested),
      ]),
    )
  }
  return value
}

function displayMcpArgumentValue(rows: StringRow[], index: number): string {
  const row = rows[index]
  if (!row) return ''
  const previous = rows[index - 1]?.value
  if (row.value && previous && SENSITIVE_CLI_FLAG.test(previous.trim())) return REDACTED_INPUT_VALUE
  return redactSensitiveText(row.value)
}

function displayMcpKeyValueRowValue(row: KeyValueRow): string {
  if (row.value && SENSITIVE_MCP_FIELD.test(row.key)) return REDACTED_INPUT_VALUE
  return redactSensitiveText(row.value)
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
    scope: 'local',
    projectPath: '',
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

function asWritableScope(scope: string): McpWritableScope {
  return scope === 'project' || scope === 'user' ? scope : 'local'
}

function scopeRequiresProject(scope: McpWritableScope) {
  return scope === 'local' || scope === 'project'
}

function serverHasProjectContext(server: Pick<McpServerRecord, 'scope' | 'projectPath'>) {
  return (server.scope === 'local' || server.scope === 'project') && !!server.projectPath
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
  base.scope = asWritableScope(server.scope)
  base.projectPath = scopeRequiresProject(base.scope) ? server.projectPath ?? '' : ''

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
      scope: draft.scope,
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
    scope: draft.scope,
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
  if (!isMcpServerNameValid(draft.name)) return false
  if (scopeRequiresProject(draft.scope) && !draft.projectPath.trim()) return false
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

function isActiveInCurrentContext(server: McpServerRecord) {
  return server.activeInCurrentContext !== false
}

function statusLabel(server: McpServerRecord, t: ReturnType<typeof useTranslation>) {
  return isActiveInCurrentContext(server)
    ? server.statusLabel
    : t('settings.mcp.status.configured')
}

function StatusBadge({ server, t }: { server: McpServerRecord; t: ReturnType<typeof useTranslation> }) {
  const activeInCurrentContext = isActiveInCurrentContext(server)
  return (
    <Badge tone={activeInCurrentContext ? mcpStatusTone(server.status) : 'neutral'} size="md" bordered className="font-semibold">
      {statusLabel(server, t)}
    </Badge>
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
  displayValue,
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
  displayValue?: (row: KeyValueRow | StringRow, index: number) => string
}) {
  return (
    <section className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="text-sm font-semibold text-[var(--color-text-primary)] mb-4">{title}</div>
      <div className="space-y-3">
        {rows.map((row, index) => (
          <div key={row.id} className={`grid gap-3 ${singleValue ? 'grid-cols-[minmax(0,1fr)_32px]' : 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_32px]'}`}>
            {!singleValue && 'key' in row && (
              <Input
                value={row.key}
                onChange={(event) => onChange(row.id, 'key', event.target.value)}
                placeholder={keyPlaceholder}
              />
            )}
            <Input
              value={displayValue ? displayValue(row, index) : row.value}
              onChange={(event) => onChange(row.id, 'value', event.target.value)}
              placeholder={valuePlaceholder}
            />
            <IconButton
              icon="delete"
              label={addLabel}
              showTooltip={false}
              size="md"
              tone="muted"
              className="mt-1 h-10"
              onClick={() => onRemove(row.id)}
            />
          </div>
        ))}
        <Button
          variant="secondary"
          size="lg"
          block
          className="h-12"
          onClick={onAdd}
          icon={<span className="material-symbols-outlined text-[18px]">add</span>}
        >
          {addLabel}
        </Button>
      </div>
    </section>
  )
}

function StatCard({ label, value, icon }: { label: string; value: number; icon: string }) {
  return (
    <div className="rounded-[var(--radius-2xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-5 py-4">
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
          <StatusBadge server={server} t={t} />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-tertiary)]">
          <span className="rounded-full bg-[var(--color-surface-hover)] px-2 py-1 font-medium text-[var(--color-text-secondary)]">
            {transportLabel(server.transport, t)}
          </span>
          <span className="rounded-full bg-[var(--color-surface-hover)] px-2 py-1 font-medium text-[var(--color-text-secondary)]">
            {scopeLabel(server, t)}
          </span>
          {serverHasProjectContext(server) && (
            <span
              className="max-w-full truncate rounded-full bg-[var(--color-surface-hover)] px-2 py-1 font-mono text-[11px] text-[var(--color-text-tertiary)]"
              title={server.projectPath}
            >
              {server.projectPath}
            </span>
          )}
          <span className="truncate">{redactSensitiveText(server.summary)}</span>
        </div>
        {!isActiveInCurrentContext(server) && (
          <div className="mt-2 text-xs text-[var(--color-text-tertiary)]">
            {t('settings.mcp.status.configuredElsewhere')}
          </div>
        )}
        {isActiveInCurrentContext(server) && server.statusDetail && (
          <div className="mt-2 text-xs text-[var(--color-text-tertiary)] truncate">{server.statusDetail}</div>
        )}
      </div>

      <IconButton
        icon="settings"
        label={t('settings.mcp.openServer', { name: server.name })}
        showTooltip={false}
        size="xl"
        shape="circle"
        tone="secondary"
        onClick={onOpen}
      />

      <Switch
        label={server.name}
        labelHidden
        checked={server.enabled}
        disabled={isBusy || !server.canToggle}
        onChange={onToggle}
      />
    </div>
  )
}

export function McpSettings() {
  const { servers, selectedServer, isLoading, error, fetchServersForKnownProjects, createServer, updateServer, deleteServer, toggleServer, reconnectServer, refreshServerStatus, selectServer } = useMcpStore()
  const addToast = useUIStore((s) => s.addToast)
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const t = useTranslation()
  const [view, setView] = useState<EditorMode>({ type: 'list' })
  const [draft, setDraft] = useState<McpDraft>(createEmptyDraft)
  const [isSaving, setIsSaving] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [busyServerKey, setBusyServerKey] = useState<string | null>(null)
  const [pendingDeleteServer, setPendingDeleteServer] = useState<McpServerRecord | null>(null)
  const [isInitialLoading, setIsInitialLoading] = useState(true)
  const refreshInFlightRef = useRef(new Set<string>())

  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const currentWorkDir = activeSession?.workDir || undefined
  const resolveOperationCwd = (server?: McpServerRecord) => server?.projectPath ?? currentWorkDir

  useEffect(() => {
    let cancelled = false
    setIsInitialLoading(useMcpStore.getState().servers.length === 0)

    const loadServers = async () => {
      try {
        await fetchServersForKnownProjects(currentWorkDir)
      } finally {
        if (!cancelled) setIsInitialLoading(false)
      }
    }

    void loadServers()

    return () => {
      cancelled = true
    }
  }, [fetchServersForKnownProjects, currentWorkDir])

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
    connected: servers.filter((server) => isActiveInCurrentContext(server) && server.status === 'connected').length,
    attention: servers.filter((server) => (
      isActiveInCurrentContext(server) &&
      (server.status === 'failed' || server.status === 'needs-auth')
    )).length,
  }), [servers])
  const showListLoading = (isInitialLoading || isLoading) && servers.length === 0

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
      isActiveInCurrentContext(server) &&
      server.status === 'checking' &&
      !refreshInFlightRef.current.has(getMcpServerIdentityKey(server))
    ))

    if (pendingServers.length === 0) return

    let cancelled = false
    const queue = [...pendingServers]
    const workerCount = Math.min(2, queue.length)

    const runWorker = async () => {
      while (!cancelled) {
        const server = queue.shift()
        if (!server) return

        const key = getMcpServerIdentityKey(server)
        refreshInFlightRef.current.add(key)
        try {
          const updated = await refreshServerStatus(server, resolveOperationCwd(server))
          if (cancelled) return

          setView((current) => {
            if (current.type !== 'details' && current.type !== 'edit') return current
            if (getMcpServerIdentityKey(current.server) !== key) return current
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
    setBusyServerKey(getMcpServerIdentityKey(server))
    try {
      const { server: updated, sessionSync } = await toggleServer(server, resolveOperationCwd(server), activeSessionId ?? undefined)
      if (!sessionSync?.applied) {
        const detail = sessionSync?.reason === 'failed'
          ? t('settings.mcp.toast.syncFailed', { error: sessionSync.error || t('settings.mcp.toast.toggleFailed') })
          : sessionSync?.reason === 'not_running'
            ? t('settings.mcp.toast.syncNotRunning')
            : sessionSync?.reason === 'different_project'
              ? t('settings.mcp.toast.syncDifferentProject')
              : sessionSync?.reason === 'no_session' || !activeSessionId
                ? t('settings.mcp.toast.syncNoSession')
                : t('settings.mcp.toast.syncUnconfirmed')
        addToast({
          type: 'warning',
          message: `${t('settings.mcp.toast.saved', { name: server.name })}. ${detail}`,
        })
        return
      }
      if (updated.enabled && (updated.status === 'failed' || updated.status === 'needs-auth')) {
        addToast({ type: 'warning', message: updated.statusDetail || updated.statusLabel })
        return
      }
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
      setBusyServerKey(null)
    }
  }

  const handleReconnect = async (server: McpServerRecord) => {
    const optimistic = {
      ...server,
      status: 'checking' as const,
      statusLabel: t('status.reconnecting'),
      statusDetail: undefined,
    }

    setBusyServerKey(getMcpServerIdentityKey(server))
    setView((current) => {
      if (current.type !== 'details' && current.type !== 'edit') return current
      if (getMcpServerIdentityKey(current.server) !== getMcpServerIdentityKey(server)) return current
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
        if (getMcpServerIdentityKey(current.server) !== getMcpServerIdentityKey(server)) return current
        return { ...current, server }
      })
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('settings.mcp.toast.reconnectFailed'),
      })
    } finally {
      setBusyServerKey(null)
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
    <ConfirmDialog
      open={pendingDeleteServer !== null}
      onClose={() => {
        if (isDeleting) return
        setPendingDeleteServer(null)
      }}
      title={t('settings.mcp.form.deleteTitle')}
      body={pendingDeleteServer ? t('settings.mcp.form.deleteConfirmBody', { name: pendingDeleteServer.name }) : ''}
      confirmLabel={t('settings.mcp.form.confirmDelete')}
      cancelLabel={t('settings.mcp.form.cancel')}
      confirmVariant="danger"
      loading={isDeleting}
      onConfirm={confirmDelete}
    />
  )

  const handleSave = async () => {
    if (!isDraftValid(draft)) return
    setIsSaving(true)
    try {
      const payload = buildPayload(draft)
      const operationCwd = scopeRequiresProject(draft.scope) ? draft.projectPath.trim() : undefined
      const saved = view.type === 'edit'
        ? await updateServer(view.server, payload, operationCwd)
        : await createServer(draft.name.trim(), payload, operationCwd)

      await fetchServersForKnownProjects(currentWorkDir)

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
          <Button
            variant="ghost"
            size="md"
            className="mb-5"
            onClick={() => {
              setView({ type: 'list' })
              selectServer(null)
            }}
            icon={<span className="material-symbols-outlined text-[18px]">arrow_back</span>}
          >
            {t('settings.mcp.form.back')}
          </Button>

          <div className="flex items-start justify-between gap-4 mb-8">
            <div>
              <h2 className="text-[32px] font-semibold leading-tight text-[var(--color-text-primary)]" style={{ fontFamily: 'var(--font-headline)' }}>{server.name}</h2>
              <p className="mt-3 text-base text-[var(--color-text-secondary)]">{redactSensitiveText(server.summary)}</p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <StatusBadge server={server} t={t} />
                {isActiveInCurrentContext(server) && server.statusDetail && (
                  <span className="text-sm text-[var(--color-text-tertiary)]">{server.statusDetail}</span>
                )}
                {!isActiveInCurrentContext(server) && (
                  <span className="text-sm text-[var(--color-text-tertiary)]">
                    {t('settings.mcp.status.configuredElsewhere')}
                  </span>
                )}
              </div>
            </div>
            {server.canReconnect && (
              <Button variant="secondary" onClick={() => handleReconnect(server)} loading={busyServerKey === getMcpServerIdentityKey(server)}>
                <span className="material-symbols-outlined text-[16px]">sync</span>
                {t('settings.mcp.form.reconnect')}
              </Button>
            )}
          </div>

          <section className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
            <div className="grid gap-4 md:grid-cols-2">
              <InfoPair label={t('settings.mcp.form.transport')} value={transportLabel(server.transport, t)} />
              <InfoPair label={t('settings.mcp.form.scope')} value={scopeLabel(server, t)} />
              <InfoPair label={t('settings.mcp.form.status')} value={statusLabel(server, t)} />
              <InfoPair label={t('settings.mcp.form.location')} value={server.configLocation} />
            </div>
            <div className="mt-5">
              <div className="text-sm font-semibold text-[var(--color-text-primary)] mb-2">{t('settings.mcp.form.rawConfig')}</div>
              <pre className="overflow-x-auto rounded-[var(--radius-lg)] bg-[var(--color-surface-hover)] p-4 text-xs text-[var(--color-text-secondary)]">
                {JSON.stringify(redactMcpDisplayValue(server.config), null, 2)}
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
    const targetProjectPath = draft.projectPath.trim()
    const needsProjectTarget = scopeRequiresProject(draft.scope)
    const targetProjectHint = draft.scope === 'local'
      ? (targetProjectPath
          ? t('settings.mcp.targetProject.localSelected', { path: targetProjectPath })
          : currentWorkDir
            ? t('settings.mcp.targetProject.emptyWithCurrent', { path: currentWorkDir })
            : t('settings.mcp.targetProject.localEmpty'))
      : draft.scope === 'project'
        ? (targetProjectPath
            ? t('settings.mcp.targetProject.projectSelected', { path: targetProjectPath })
            : currentWorkDir
              ? t('settings.mcp.targetProject.emptyWithCurrent', { path: currentWorkDir })
              : t('settings.mcp.targetProject.projectEmpty'))
        : t('settings.mcp.targetProject.globalHint')

    return (
      <>
        <div className="max-w-5xl min-w-0">
          <Button
            variant="ghost"
            size="md"
            className="mb-5"
            onClick={() => {
              setView({ type: 'list' })
              selectServer(null)
            }}
            icon={<span className="material-symbols-outlined text-[18px]">arrow_back</span>}
          >
            {t('settings.mcp.form.back')}
          </Button>

          <div className="flex items-start justify-between gap-4 mb-8">
            <div>
              <h2 className="text-[32px] font-semibold leading-tight text-[var(--color-text-primary)]" style={{ fontFamily: 'var(--font-headline)' }}>
                {editing ? t('settings.mcp.form.editTitle', { name: targetServer!.name }) : t('settings.mcp.form.createTitle')}
              </h2>
              <p className="mt-3 text-base text-[var(--color-text-secondary)]">
                {editing ? t('settings.mcp.form.editHint') : t('settings.mcp.form.createHint')}
              </p>
              {editing && targetServer && (
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <StatusBadge server={targetServer} t={t} />
                  {isActiveInCurrentContext(targetServer) && targetServer.statusDetail && (
                    <span className="text-sm text-[var(--color-text-tertiary)]">{targetServer.statusDetail}</span>
                  )}
                  {!isActiveInCurrentContext(targetServer) && (
                    <span className="text-sm text-[var(--color-text-tertiary)]">
                      {t('settings.mcp.status.configuredElsewhere')}
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center gap-3">
              {editing && targetServer?.canReconnect && (
                <Button variant="secondary" onClick={() => handleReconnect(targetServer)} loading={busyServerKey === getMcpServerIdentityKey(targetServer)}>
                  <span className="material-symbols-outlined text-[16px]">sync</span>
                  {t('settings.mcp.form.reconnect')}
                </Button>
              )}
              {editing && targetServer?.canRemove && (
                <Button
                  variant="ghost"
                  className="text-[var(--color-error)] hover:text-[var(--color-error)] hover:bg-[var(--color-error-soft)]"
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
            <div className="grid gap-2 md:grid-cols-3">
              {WRITABLE_SCOPES.map((scope) => {
                const active = draft.scope === scope
                return (
                  <button
                    key={scope}
                    type="button"
                    onClick={() => setDraftField('scope', scope)}
                    className={`rounded-[var(--radius-md)] border p-3 text-left transition-colors ${
                      active
                        ? 'border-[var(--color-border-focus)] bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]'
                        : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
                    }`}
                  >
                    <span className="block text-sm font-semibold">{t(`settings.mcp.scope.${scope}`)}</span>
                    <span className="mt-1 block text-xs leading-5 text-[var(--color-text-tertiary)]">
                      {t(`settings.mcp.scopeDesc.${scope}`)}
                    </span>
                  </button>
                )
              })}
            </div>
          </section>

          <section className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-[var(--color-text-primary)]">
                  {needsProjectTarget ? t('settings.mcp.targetProject.title') : t('settings.mcp.targetProject.globalTitle')}
                </div>
                <p className="mt-1 text-xs leading-5 text-[var(--color-text-tertiary)]">
                  {targetProjectHint}
                </p>
              </div>
              {needsProjectTarget && (
                <DirectoryPicker
                  value={draft.projectPath}
                  onChange={(path) => setDraftField('projectPath', path)}
                />
              )}
            </div>
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
                displayValue={(_row, index) => displayMcpArgumentValue(draft.args, index)}
                valuePlaceholder={t('settings.mcp.form.argumentPlaceholder')}
                addLabel={t('settings.mcp.form.addArgument')}
              />

              <ArraySection
                title={t('settings.mcp.form.environmentVariables')}
                rows={draft.env}
                onChange={(id, field, value) => updateKeyValueRows('env', id, field, value)}
                onAdd={() => addRow('env')}
                onRemove={(id) => removeRow('env', id)}
                displayValue={(row) => ('key' in row ? displayMcpKeyValueRowValue(row) : row.value)}
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
                displayValue={(row) => ('key' in row ? displayMcpKeyValueRowValue(row) : row.value)}
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
      <SettingsPageHeader
        title={t('settings.mcp.title')}
        description={t('settings.mcp.description')}
        action={(
          <Button size="base" onClick={beginCreate}>
            <span className="material-symbols-outlined text-[16px]">add</span>
            {t('settings.mcp.addServer')}
          </Button>
        )}
      />

      {showListLoading ? (
        <LoadingState label={t('common.loading')} variant="dashed" size="lg" />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-3 mb-8">
            <StatCard label={t('settings.mcp.stats.total')} value={stats.total} icon="dns" />
            <StatCard label={t('settings.mcp.stats.connected')} value={stats.connected} icon="check_circle" />
            <StatCard label={t('settings.mcp.stats.attention')} value={stats.attention} icon="error" />
          </div>

          {error ? (
            <ErrorState
              size="lg"
              title={error}
              retryLabel={t('common.retry')}
              onRetry={() => void fetchServersForKnownProjects(currentWorkDir)}
            />
          ) : servers.length === 0 ? (
            <EmptyState
              size="md"
              icon={<span className="material-symbols-outlined text-[20px]" aria-hidden="true">dns</span>}
              title={t('settings.mcp.empty')}
              description={t('settings.mcp.emptyHint')}
            />
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
                          key={getMcpServerIdentityKey(server)}
                          server={server}
                          isBusy={busyServerKey === getMcpServerIdentityKey(server)}
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
        </>
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
