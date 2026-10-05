import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Plus, RefreshCw, Server, Settings, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Badge, StatusDot, type Tone } from '@/components/ui/Badge'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Switch } from '@/components/ui/Switch'
import { LoadingState } from '@/components/ui/LoadingState'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { IconButton } from '@/components/ui/IconButton'
import { mcpStatusTone } from '@/lib/mcpStatus'
import { getMcpServerIdentityKey } from '@/lib/mcpIdentity'
import { DirectoryPicker } from '@/components/composite/DirectoryPicker'
import {
  SettingsBlock,
  SettingsGroup,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsStat,
} from '@/components/settings/SettingsSection'
import { Input } from '@/components/ui/Input'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { cx } from '@/lib/cx'
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
const TRANSPORTS: TransportKind[] = ['stdio', 'http', 'sse']

/** The settings frame (`pages/Settings.tsx`) owns width and gutters; a pane never sets its own. */
const PAGE_CLASS = 'w-full min-w-0'
const ICON_PROPS = { size: 14, strokeWidth: 1.75, 'aria-hidden': true } as const

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

function statusTone(server: McpServerRecord): Tone {
  return isActiveInCurrentContext(server) ? mcpStatusTone(server.status) : 'neutral'
}

/** The dot leading a server row. A check in flight is "in progress", which reads as info. */
function statusDotTone(server: McpServerRecord): Tone {
  if (isActiveInCurrentContext(server) && server.status === 'checking') return 'info'
  return statusTone(server)
}

function StatusBadge({ server, t }: { server: McpServerRecord; t: ReturnType<typeof useTranslation> }) {
  return (
    <Badge tone={statusTone(server)} size="xs">
      {statusLabel(server, t)}
    </Badge>
  )
}

/** Badge plus the one-line reason, shown under a sub-view's title. */
function StatusLine({ server, t }: { server: McpServerRecord; t: ReturnType<typeof useTranslation> }) {
  const active = isActiveInCurrentContext(server)
  return (
    <span className="mt-2.5 flex flex-wrap items-center gap-2">
      <StatusBadge server={server} t={t} />
      {active && server.statusDetail && (
        <span className="text-xs text-[var(--color-text-tertiary)]">{server.statusDetail}</span>
      )}
      {!active && (
        <span className="text-xs text-[var(--color-text-tertiary)]">
          {t('settings.mcp.status.configuredElsewhere')}
        </span>
      )}
    </span>
  )
}

function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2 mb-3"
      onClick={onClick}
      icon={<ArrowLeft {...ICON_PROPS} />}
    >
      {label}
    </Button>
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
    <SettingsSection title={title}>
      <SettingsGroup>
        <SettingsBlock className="py-3.5">
          <div className="space-y-2">
            {rows.map((row, index) => (
              <div key={row.id} className={`grid gap-2 ${singleValue ? 'grid-cols-[minmax(0,1fr)_32px]' : 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_32px]'}`}>
                {!singleValue && 'key' in row && (
                  <Input
                    size="md"
                    value={row.key}
                    onChange={(event) => onChange(row.id, 'key', event.target.value)}
                    placeholder={keyPlaceholder}
                  />
                )}
                <Input
                  size="md"
                  value={displayValue ? displayValue(row, index) : row.value}
                  onChange={(event) => onChange(row.id, 'value', event.target.value)}
                  placeholder={valuePlaceholder}
                />
                <IconButton
                  icon={<Trash2 {...ICON_PROPS} />}
                  label={addLabel}
                  showTooltip={false}
                  size="md"
                  tone="muted"
                  hoverTone="danger"
                  onClick={() => onRemove(row.id)}
                />
              </div>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="-ml-1.5 mt-2"
            onClick={onAdd}
            icon={<Plus {...ICON_PROPS} />}
          >
            {addLabel}
          </Button>
        </SettingsBlock>
      </SettingsGroup>
    </SettingsSection>
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
  const active = isActiveInCurrentContext(server)
  return (
    <div className="flex items-start gap-3 px-4 py-3.5">
      <StatusDot
        tone={statusDotTone(server)}
        size="md"
        pulse={active && server.status === 'checking'}
        className="mt-[7px]"
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold text-[var(--color-text-primary)]">{server.name}</span>
          <StatusBadge server={server} t={t} />
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-[var(--color-text-tertiary)]">
          <span className="shrink-0">{transportLabel(server.transport, t)}</span>
          <span aria-hidden="true" className="shrink-0">·</span>
          <span className="shrink-0">{scopeLabel(server, t)}</span>
          {serverHasProjectContext(server) && (
            <>
              <span aria-hidden="true" className="shrink-0">·</span>
              <span className="min-w-0 truncate font-mono text-[11px]" title={server.projectPath}>
                {server.projectPath}
              </span>
            </>
          )}
        </div>
        <div className="mt-1 truncate font-mono text-[11px] text-[var(--color-text-tertiary)]">
          {redactSensitiveText(server.summary)}
        </div>
        {!active && (
          <div className="mt-1.5 text-xs leading-[1.5] text-[var(--color-text-tertiary)]">
            {t('settings.mcp.status.configuredElsewhere')}
          </div>
        )}
        {active && server.statusDetail && (
          <div
            className={cx(
              'mt-1.5 truncate text-xs',
              server.status === 'failed' ? 'text-[var(--color-error)]' : 'text-[var(--color-text-tertiary)]',
            )}
          >
            {server.statusDetail}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 self-center">
        <IconButton
          icon={<Settings {...ICON_PROPS} />}
          label={t('settings.mcp.openServer', { name: server.name })}
          showTooltip={false}
          size="sm"
          tone="muted"
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
        <div className={PAGE_CLASS}>
          <BackButton
            label={t('settings.mcp.form.back')}
            onClick={() => {
              setView({ type: 'list' })
              selectServer(null)
            }}
          />

          <SettingsPageHeader
            title={server.name}
            description={(
              <>
                <span className="block break-all font-mono text-xs">{redactSensitiveText(server.summary)}</span>
                <StatusLine server={server} t={t} />
              </>
            )}
            action={server.canReconnect ? (
              <Button
                variant="secondary"
                size="base"
                onClick={() => handleReconnect(server)}
                loading={busyServerKey === getMcpServerIdentityKey(server)}
                icon={<RefreshCw {...ICON_PROPS} />}
              >
                {t('settings.mcp.form.reconnect')}
              </Button>
            ) : undefined}
          />

          <SettingsGroup className="mt-6">
            <InfoRow label={t('settings.mcp.form.transport')} value={transportLabel(server.transport, t)} />
            <InfoRow label={t('settings.mcp.form.scope')} value={scopeLabel(server, t)} />
            <InfoRow label={t('settings.mcp.form.status')} value={statusLabel(server, t)} />
            <InfoRow label={t('settings.mcp.form.location')} value={server.configLocation} mono />
          </SettingsGroup>

          <SettingsSection title={t('settings.mcp.form.rawConfig')}>
            <pre className="overflow-x-auto rounded-[var(--radius-md)] bg-[var(--color-surface-container)] p-3 font-mono text-xs leading-[1.6] text-[var(--color-text-secondary)]">
              {JSON.stringify(redactMcpDisplayValue(server.config), null, 2)}
            </pre>
          </SettingsSection>
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
        <div className={PAGE_CLASS}>
          <BackButton
            label={t('settings.mcp.form.back')}
            onClick={() => {
              setView({ type: 'list' })
              selectServer(null)
            }}
          />

          <SettingsPageHeader
            title={editing ? t('settings.mcp.form.editTitle', { name: targetServer!.name }) : t('settings.mcp.form.createTitle')}
            description={(
              <>
                {editing ? t('settings.mcp.form.editHint') : t('settings.mcp.form.createHint')}
                {editing && targetServer && <StatusLine server={targetServer} t={t} />}
              </>
            )}
            action={editing && targetServer && (targetServer.canReconnect || targetServer.canRemove) ? (
              <>
                {targetServer.canReconnect && (
                  <Button
                    variant="secondary"
                    size="base"
                    onClick={() => handleReconnect(targetServer)}
                    loading={busyServerKey === getMcpServerIdentityKey(targetServer)}
                    icon={<RefreshCw {...ICON_PROPS} />}
                  >
                    {t('settings.mcp.form.reconnect')}
                  </Button>
                )}
                {targetServer.canRemove && (
                  <Button
                    variant="danger-ghost"
                    size="base"
                    onClick={() => handleDelete(targetServer)}
                    loading={isDeleting}
                    icon={<Trash2 {...ICON_PROPS} />}
                  >
                    {t('settings.mcp.form.uninstall')}
                  </Button>
                )}
              </>
            ) : undefined}
          />

          <SettingsGroup className="mt-6">
            <SettingsBlock className="py-3.5">
              <Input
                size="md"
                label={t('settings.mcp.form.name')}
                value={draft.name}
                onChange={(event) => setDraftField('name', event.target.value)}
                placeholder={t('settings.mcp.form.namePlaceholder')}
                disabled={editing}
                required
              />
            </SettingsBlock>

            <SettingsBlock className="py-3.5">
              <div className="text-[13px] font-medium leading-5 text-[var(--color-text-primary)]">
                {t('settings.mcp.form.scope')}
              </div>
              <div className="mt-2 grid gap-2 md:grid-cols-3">
                {WRITABLE_SCOPES.map((scope) => {
                  const active = draft.scope === scope
                  return (
                    <button
                      key={scope}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setDraftField('scope', scope)}
                      className={cx(
                        'flex flex-col justify-start rounded-[var(--radius-md)] border px-3 py-2.5 text-left transition-colors duration-150',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]',
                        active
                          ? 'border-[var(--color-brand)] bg-[var(--color-brand-soft)]'
                          : 'border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]',
                      )}
                    >
                      <span className="block text-[13px] font-medium text-[var(--color-text-primary)]">
                        {t(`settings.mcp.scope.${scope}`)}
                      </span>
                      <span className="mt-0.5 block text-xs leading-[1.5] text-[var(--color-text-tertiary)]">
                        {t(`settings.mcp.scopeDesc.${scope}`)}
                      </span>
                    </button>
                  )
                })}
              </div>
            </SettingsBlock>

            <SettingsRow
              title={needsProjectTarget ? t('settings.mcp.targetProject.title') : t('settings.mcp.targetProject.globalTitle')}
              description={targetProjectHint}
            >
              {needsProjectTarget && (
                <DirectoryPicker
                  value={draft.projectPath}
                  onChange={(path) => setDraftField('projectPath', path)}
                />
              )}
            </SettingsRow>

            <SettingsRow
              title={t('settings.mcp.form.transport')}
              description={editing ? t('settings.mcp.form.transportLocked') : undefined}
            >
              <SegmentedControl<TransportKind>
                label={t('settings.mcp.form.transport')}
                size="sm"
                value={draft.transport}
                onChange={(transport) => setDraftField('transport', transport)}
                items={TRANSPORTS.map((transport) => ({
                  value: transport,
                  label: transportLabel(transport, t),
                  disabled: transportLocked,
                }))}
              />
            </SettingsRow>
          </SettingsGroup>

          {draft.transport === 'stdio' ? (
            <>
              <SettingsGroup className="mt-7">
                <SettingsBlock className="py-3.5">
                  <Input
                    size="md"
                    label={t('settings.mcp.form.command')}
                    value={draft.command}
                    onChange={(event) => setDraftField('command', event.target.value)}
                    placeholder={t('settings.mcp.form.commandPlaceholder')}
                    required
                  />
                  <p className="mt-2 text-xs leading-[1.5] text-[var(--color-text-tertiary)]">
                    {t('settings.mcp.form.commandHostHint')}
                  </p>
                </SettingsBlock>
              </SettingsGroup>

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
              <SettingsGroup className="mt-7">
                <SettingsBlock className="py-3.5">
                  <Input
                    size="md"
                    label={draft.transport === 'http' ? t('settings.mcp.form.url') : t('settings.mcp.form.sseUrl')}
                    value={draft.url}
                    onChange={(event) => setDraftField('url', event.target.value)}
                    placeholder={t('settings.mcp.form.urlPlaceholder')}
                    required
                  />
                </SettingsBlock>
              </SettingsGroup>

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

              <SettingsGroup className="mt-7">
                <SettingsBlock className="space-y-4 py-3.5">
                  <div className="grid gap-4 md:grid-cols-2">
                    <Input
                      size="md"
                      label={t('settings.mcp.form.oauthClientId')}
                      value={draft.oauthClientId}
                      onChange={(event) => setDraftField('oauthClientId', event.target.value)}
                      placeholder={t('settings.mcp.form.oauthClientIdPlaceholder')}
                    />
                    <Input
                      size="md"
                      label={t('settings.mcp.form.oauthCallbackPort')}
                      value={draft.oauthCallbackPort}
                      onChange={(event) => setDraftField('oauthCallbackPort', event.target.value)}
                      placeholder={t('settings.mcp.form.oauthCallbackPortPlaceholder')}
                    />
                  </div>
                  <Input
                    size="md"
                    label={t('settings.mcp.form.headersHelper')}
                    value={draft.headersHelper}
                    onChange={(event) => setDraftField('headersHelper', event.target.value)}
                    placeholder={t('settings.mcp.form.headersHelperPlaceholder')}
                  />
                </SettingsBlock>
              </SettingsGroup>
            </>
          )}

          <div className="mt-7 flex justify-end">
            <Button
              variant="primary"
              size="base"
              onClick={handleSave}
              disabled={!isDraftValid(draft) || isBusy}
              loading={isSaving}
            >
              {t('settings.mcp.form.save')}
            </Button>
          </div>
        </div>
        {deleteModal}
      </>
    )
  }

  return (
    <div className={PAGE_CLASS}>
      <SettingsPageHeader
        title={t('settings.mcp.title')}
        description={t('settings.mcp.description')}
        action={(
          <Button variant="primary" size="base" onClick={beginCreate} icon={<Plus {...ICON_PROPS} />}>
            {t('settings.mcp.addServer')}
          </Button>
        )}
      />

      {showListLoading ? (
        <LoadingState label={t('common.loading')} variant="dashed" size="lg" className="mt-6" />
      ) : (
        <>
          <div className="mt-6 grid grid-cols-3 gap-3">
            <SettingsStat label={t('settings.mcp.stats.total')} value={stats.total} />
            <SettingsStat label={t('settings.mcp.stats.connected')} value={stats.connected} />
            <SettingsStat label={t('settings.mcp.stats.attention')} value={stats.attention} />
          </div>

          {error ? (
            <ErrorState
              size="lg"
              title={error}
              retryLabel={t('common.retry')}
              onRetry={() => void fetchServersForKnownProjects(currentWorkDir)}
              className="mt-7"
            />
          ) : servers.length === 0 ? (
            <EmptyState
              size="md"
              icon={<Server size={18} strokeWidth={1.75} aria-hidden />}
              title={t('settings.mcp.empty')}
              description={t('settings.mcp.emptyHint')}
              className="mt-7"
            />
          ) : (
            MCP_GROUP_ORDER.map((group) => {
              const groupServers = groupedServers[group]
              if (!groupServers?.length) return null

              return (
                <SettingsSection
                  key={group}
                  title={(
                    <>
                      {group === 'plugin' ? t('settings.mcp.scope.plugin') : t(`settings.mcp.scope.${group}`)}
                      <span className="ml-1.5 font-mono text-[11px] font-normal tabular-nums text-[var(--color-text-tertiary)]">
                        {groupServers.length}
                      </span>
                    </>
                  )}
                >
                  <SettingsGroup>
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
                  </SettingsGroup>
                </SettingsSection>
              )
            })
          )}
        </>
      )}
      {deleteModal}
    </div>
  )
}

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-h-[52px] items-center gap-6 px-4 py-3">
      <div className="w-32 shrink-0 text-[13px] font-medium text-[var(--color-text-primary)]">{label}</div>
      <div
        className={cx(
          'min-w-0 flex-1 break-all text-right',
          mono ? 'font-mono text-xs text-[var(--color-text-secondary)]' : 'text-[13px] text-[var(--color-text-secondary)]',
        )}
      >
        {value}
      </div>
    </div>
  )
}
