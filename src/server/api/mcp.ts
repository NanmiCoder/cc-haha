import {
  clearMcpClientConfig,
  clearServerTokensFromLocalStorage,
} from '../../services/mcp/auth.js'
import {
  clearServerCache,
  connectToServer,
  fetchToolsForClient,
  listRawToolsForServer,
  reconnectMcpServerImpl,
  type RawMcpToolInfo,
} from '../../services/mcp/client.js'
import {
  addMcpConfig,
  getAllMcpConfigs,
  getClaudeCodeMcpConfigs,
  getMcpConfigByName,
  isMcpServerDisabled,
  removeMcpConfig,
  setMcpServerEnabled,
} from '../../services/mcp/config.js'
import {
  isMcpToolDisabled,
  setMcpToolEnabled,
} from '../../services/mcp/toolOverrides.js'
import {
  addMarketplaceSource,
  getMarketplaceCatalog,
  refreshMarketplaceSources,
  removeMarketplaceSource,
} from '../services/mcpMarketplace.js'
import { inspectMcpHostCommand } from '../services/mcpHostPreflight.js'
import type {
  ConfigScope,
  McpHTTPServerConfig,
  McpSSEServerConfig,
  McpServerConfig,
  McpStdioServerConfig,
  ScopedMcpServerConfig,
} from '../../services/mcp/types.js'
import { describeMcpConfigFilePath, ensureConfigScope } from '../../services/mcp/utils.js'
import { enableConfigs, getGlobalConfig } from '../../utils/config.js'
import { getCwd, runWithCwdOverride } from '../../utils/cwd.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { conversationService } from '../services/conversationService.js'

type McpEditableConfigDto =
  | {
      type: 'stdio'
      command: string
      args: string[]
      env: Record<string, string>
    }
  | {
      type: 'http' | 'sse'
      url: string
      headers: Record<string, string>
      headersHelper?: string
      oauth?: {
        clientId?: string
        callbackPort?: number
      }
    }
  | {
      type: string
    }

type McpServerDto = {
  name: string
  scope: string
  transport: string
  enabled: boolean
  status: 'connected' | 'needs-auth' | 'failed' | 'disabled' | 'checking'
  statusLabel: string
  statusDetail?: string
  configLocation: string
  summary: string
  canEdit: boolean
  canRemove: boolean
  canReconnect: boolean
  canToggle: boolean
  config: McpEditableConfigDto
}

type McpMutationBody = {
  cwd?: string
  previousCwd?: string
  scope?: string
  sessionId?: string
  config?: unknown
}

type McpSessionSyncDto = {
  applied: boolean
  reason?: 'not_running' | 'failed'
  error?: string
}

const EDITABLE_SCOPES = new Set<ConfigScope>(['local', 'project', 'user'])

function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  return req
    .json()
    .then((body) => body as Record<string, unknown>)
    .catch(() => {
      throw ApiError.badRequest('Invalid JSON body')
    })
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

async function syncMcpToggleToSession(
  sessionId: string | undefined,
  serverName: string,
  enabled: boolean,
): Promise<McpSessionSyncDto | undefined> {
  if (!sessionId) return undefined
  if (!conversationService.hasSession(sessionId)) {
    return { applied: false, reason: 'not_running' }
  }

  try {
    await conversationService.requestControl(
      sessionId,
      { subtype: 'mcp_toggle', serverName, enabled },
      120_000,
    )
    return { applied: true }
  } catch (error) {
    return {
      applied: false,
      reason: 'failed',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function resolveRequestCwd(url: URL, body?: Record<string, unknown>): string {
  const cwd = url.searchParams.get('cwd') || (typeof body?.cwd === 'string' ? body.cwd : undefined)
  return cwd || getCwd()
}

function stripScope(config: ScopedMcpServerConfig): McpServerConfig {
  const { scope: _scope, pluginSource: _pluginSource, ...rest } = config
  return rest
}

function isVisibleServer(name: string, config: ScopedMcpServerConfig): boolean {
  if (name === 'ide') return false
  if (config.type === 'sse-ide' || config.type === 'ws-ide') return false
  return true
}

function serializeEditableConfig(config: ScopedMcpServerConfig): McpEditableConfigDto {
  if (!config.type || config.type === 'stdio') {
    const stdioConfig = config as McpStdioServerConfig
    return {
      type: 'stdio',
      command: stdioConfig.command,
      args: Array.isArray(stdioConfig.args) ? stdioConfig.args : [],
      env: stdioConfig.env ?? {},
    }
  }

  if (config.type === 'http' || config.type === 'sse') {
    const remoteConfig = config as McpHTTPServerConfig | McpSSEServerConfig
    return {
      type: config.type,
      url: remoteConfig.url,
      headers: remoteConfig.headers ?? {},
      headersHelper: remoteConfig.headersHelper,
      oauth: remoteConfig.oauth
        ? {
            clientId: remoteConfig.oauth.clientId,
            callbackPort: remoteConfig.oauth.callbackPort,
          }
        : undefined,
    }
  }

  return { type: config.type }
}

function getSummary(config: ScopedMcpServerConfig): string {
  if (!config.type || config.type === 'stdio') {
    const stdioConfig = config as McpStdioServerConfig
    return [stdioConfig.command, ...(stdioConfig.args ?? [])].join(' ').trim()
  }

  if ('url' in config && typeof config.url === 'string') {
    return config.url
  }

  return config.type
}

function getStatusLabel(status: McpServerDto['status']): string {
  switch (status) {
    case 'connected':
      return 'Connected'
    case 'needs-auth':
      return 'Needs auth'
    case 'failed':
      return 'Unavailable'
    case 'disabled':
      return 'Disabled'
    case 'checking':
      return 'Checking'
    default:
      return status
  }
}

function getInitialStatus(
  enabled: boolean,
): Pick<McpServerDto, 'status' | 'statusDetail' | 'statusLabel'> {
  if (!enabled) {
    return {
      status: 'disabled',
      statusLabel: getStatusLabel('disabled'),
      statusDetail: 'Server disabled for the current project',
    }
  }

  return {
    status: 'checking',
    statusLabel: getStatusLabel('checking'),
  }
}

async function getHostPreflightStatus(
  config: ScopedMcpServerConfig | McpServerConfig,
  enabled: boolean,
): Promise<Pick<McpServerDto, 'status' | 'statusDetail' | 'statusLabel'> | null> {
  if (!enabled) {
    return null
  }

  if ((config.type ?? 'stdio') !== 'stdio') {
    return null
  }

  const stdioConfig = config as McpStdioServerConfig
  const result = await inspectMcpHostCommand(
    stdioConfig.command,
    getCwd(),
    stdioConfig.env,
  )
  if (result.ok) {
    return null
  }

  return {
    status: 'failed',
    statusLabel: getStatusLabel('failed'),
    statusDetail: result.message,
  }
}

async function inspectServerStatus(
  name: string,
  config: ScopedMcpServerConfig,
  enabled: boolean,
): Promise<Pick<McpServerDto, 'status' | 'statusDetail' | 'statusLabel'>> {
  if (!enabled) {
    return {
      status: 'disabled',
      statusLabel: getStatusLabel('disabled'),
      statusDetail: 'Server disabled for the current project',
    }
  }

  const hostPreflightStatus = await getHostPreflightStatus(config, enabled)
  if (hostPreflightStatus) {
    return hostPreflightStatus
  }

  try {
    const client = await connectToServer(name, config)
    await clearServerCache(name, config).catch(() => {})

    const status: McpServerDto['status'] =
      client.type === 'connected'
        ? 'connected'
        : client.type === 'needs-auth'
          ? 'needs-auth'
          : 'failed'

    return {
      status,
      statusLabel: getStatusLabel(status),
      statusDetail: 'error' in client ? client.error : undefined,
    }
  } catch (error) {
    await clearServerCache(name, config).catch(() => {})
    return {
      status: 'failed',
      statusLabel: getStatusLabel('failed'),
      statusDetail: error instanceof Error ? error.message : String(error),
    }
  }
}

function buildServerDto(
  name: string,
  config: ScopedMcpServerConfig,
  status: Pick<McpServerDto, 'status' | 'statusDetail' | 'statusLabel'>,
): McpServerDto {
  const enabled = !isMcpServerDisabled(name)
  const transport = config.type ?? 'stdio'
  const canEdit = EDITABLE_SCOPES.has(config.scope) && (transport === 'stdio' || transport === 'http' || transport === 'sse')

  return {
    name,
    scope: config.scope,
    transport,
    enabled: !isMcpServerDisabled(name),
    status: status.status,
    statusLabel: status.statusLabel,
    statusDetail: status.statusDetail,
    configLocation: describeMcpConfigFilePath(config.scope),
    summary: getSummary(config),
    canEdit,
    canRemove: EDITABLE_SCOPES.has(config.scope),
    canReconnect: enabled,
    canToggle: true,
    config: serializeEditableConfig(config),
  }
}

function serializeServerSnapshot(
  name: string,
  config: ScopedMcpServerConfig,
): McpServerDto {
  return buildServerDto(name, config, getInitialStatus(!isMcpServerDisabled(name)))
}

async function serializeServerWithLiveStatus(
  name: string,
  config: ScopedMcpServerConfig,
): Promise<McpServerDto> {
  const enabled = !isMcpServerDisabled(name)
  const status = await inspectServerStatus(name, config, enabled)
  return buildServerDto(name, config, status)
}

async function resolveServerForRuntimeAction(
  name: string,
): Promise<ScopedMcpServerConfig | null> {
  const configured = getMcpConfigByName(name)
  if (configured) {
    return configured
  }

  const { servers } = await getAllMcpConfigs()
  return servers[name] ?? null
}

function buildServerConfig(config: unknown): McpServerConfig {
  if (!config || typeof config !== 'object') {
    throw ApiError.badRequest('Missing or invalid "config" in request body')
  }

  const raw = config as Record<string, unknown>
  const type = raw.type

  if (!type || type === 'stdio') {
    const command = typeof raw.command === 'string' ? raw.command.trim() : ''
    if (!command) {
      throw ApiError.badRequest('Command is required for stdio MCP servers')
    }

    const args = Array.isArray(raw.args)
      ? raw.args.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : []

    const envEntries = raw.env && typeof raw.env === 'object'
      ? Object.entries(raw.env as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string' && entry[0].trim().length > 0,
        )
      : []

    return {
      type: 'stdio',
      command,
      args,
      ...(envEntries.length > 0 ? { env: Object.fromEntries(envEntries) } : {}),
    }
  }

  if (type === 'http' || type === 'sse') {
    const url = typeof raw.url === 'string' ? raw.url.trim() : ''
    if (!url) {
      throw ApiError.badRequest('URL is required for remote MCP servers')
    }

    const headersEntries = raw.headers && typeof raw.headers === 'object'
      ? Object.entries(raw.headers as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string' && entry[0].trim().length > 0,
        )
      : []

    const oauthRaw = raw.oauth && typeof raw.oauth === 'object' ? (raw.oauth as Record<string, unknown>) : undefined
    const clientId = typeof oauthRaw?.clientId === 'string' ? oauthRaw.clientId.trim() : ''
    const callbackPort =
      typeof oauthRaw?.callbackPort === 'number'
        ? oauthRaw.callbackPort
        : typeof oauthRaw?.callbackPort === 'string' && oauthRaw.callbackPort.trim()
          ? Number(oauthRaw.callbackPort)
          : undefined

    return {
      type,
      url,
      ...(headersEntries.length > 0 ? { headers: Object.fromEntries(headersEntries) } : {}),
      ...(typeof raw.headersHelper === 'string' && raw.headersHelper.trim()
        ? { headersHelper: raw.headersHelper.trim() }
        : {}),
      ...(clientId || callbackPort
        ? {
            oauth: {
              ...(clientId ? { clientId } : {}),
              ...(callbackPort ? { callbackPort } : {}),
            },
          }
        : {}),
    }
  }

  throw ApiError.badRequest(`Unsupported MCP transport: ${String(type)}`)
}

function cleanupSecureStorage(name: string, config: ScopedMcpServerConfig) {
  if (config.type !== 'sse' && config.type !== 'http') return
  clearServerTokensFromLocalStorage(name, config)
  clearMcpClientConfig(name, config)
}

async function listServers(): Promise<Response> {
  const { servers } = await getAllMcpConfigs()
  const visibleServers = Object.entries(servers)
    .filter(([name, config]) => isVisibleServer(name, config))
    .sort((a, b) => a[0].localeCompare(b[0]))
  return Response.json({
    servers: visibleServers.map(([name, config]) => serializeServerSnapshot(name, config)),
  })
}

function listProjectPathsWithPrivateMcp(): Response {
  const projects = getGlobalConfig().projects ?? {}
  const projectPaths = Object.entries(projects)
    .filter(([, projectConfig]) => Object.keys(projectConfig.mcpServers ?? {}).length > 0)
    .map(([projectPath]) => projectPath)
    .sort((a, b) => a.localeCompare(b))

  return Response.json({ projectPaths })
}

async function getServerStatus(name: string): Promise<Response> {
  const existing = await resolveServerForRuntimeAction(name)
  if (!existing) {
    throw ApiError.notFound(`MCP server not found: ${name}`)
  }

  return Response.json({
    server: await serializeServerWithLiveStatus(name, existing),
  })
}

type McpToolsResponseDto = {
  serverName: string
  status: 'connected' | 'needs-auth' | 'failed' | 'disabled'
  tools: RawMcpToolInfo[]
  error?: string
}

async function listServerTools(name: string): Promise<Response> {
  const existing = await resolveServerForRuntimeAction(name)
  if (!existing) {
    throw ApiError.notFound(`MCP server not found: ${name}`)
  }

  if (isMcpServerDisabled(name)) {
    const body: McpToolsResponseDto = {
      serverName: name,
      status: 'disabled',
      tools: [],
    }
    return Response.json(body)
  }

  // Stdio servers fail loudly on PATH issues — surface that the same way
  // status/reconnect do, instead of letting connectToServer hang on spawn.
  const hostPreflight = await getHostPreflightStatus(existing, true)
  if (hostPreflight) {
    const body: McpToolsResponseDto = {
      serverName: name,
      status: 'failed',
      tools: [],
      ...(hostPreflight.statusDetail ? { error: hostPreflight.statusDetail } : {}),
    }
    return Response.json(body)
  }

  try {
    const client = await connectToServer(name, existing)

    if (client.type !== 'connected') {
      const body: McpToolsResponseDto = {
        serverName: name,
        status: client.type === 'needs-auth' ? 'needs-auth' : 'failed',
        tools: [],
        ...('error' in client && client.error ? { error: client.error } : {}),
      }
      return Response.json(body)
    }

    const tools = await listRawToolsForServer(client)
    const body: McpToolsResponseDto = {
      serverName: name,
      status: 'connected',
      tools,
    }
    return Response.json(body)
  } catch (error) {
    const body: McpToolsResponseDto = {
      serverName: name,
      status: 'failed',
      tools: [],
      error: error instanceof Error ? error.message : String(error),
    }
    return Response.json(body)
  }
}

async function toggleServerTool(
  serverName: string,
  toolName: string,
  body: Record<string, unknown> | undefined,
): Promise<Response> {
  if (!toolName) {
    throw ApiError.badRequest('Tool name is required')
  }

  const existing = await resolveServerForRuntimeAction(serverName)
  if (!existing) {
    throw ApiError.notFound(`MCP server not found: ${serverName}`)
  }

  // Default to flipping the current state when the body omits `enabled`. This
  // matches the server-level toggle endpoint's behavior and lets the UI fire a
  // single click without having to read state first.
  const requestedEnabled =
    typeof body?.enabled === 'boolean'
      ? body.enabled
      : isMcpToolDisabled(serverName, toolName)

  setMcpToolEnabled(serverName, toolName, requestedEnabled)

  // Drop the cached `Tool[]` for this server so the agent loop picks up the
  // override on next call. `connectToServer` is left alone — the underlying
  // transport is still healthy, only the visible-tool projection changed.
  fetchToolsForClient.cache.delete(serverName)

  return Response.json({
    serverName,
    toolName,
    enabled: requestedEnabled,
  })
}

async function listMarketplace(): Promise<Response> {
  return Response.json(await getMarketplaceCatalog())
}

async function refreshMarketplace(
  body: Record<string, unknown> | undefined,
): Promise<Response> {
  const requested = body?.sourceIds
  const sourceIds = Array.isArray(requested)
    ? requested.filter((id): id is string => typeof id === 'string')
    : undefined
  return Response.json(await refreshMarketplaceSources(sourceIds))
}

async function createMarketplaceSource(
  body: Record<string, unknown> | undefined,
): Promise<Response> {
  const url = typeof body?.url === 'string' ? body.url : ''
  const label = typeof body?.label === 'string' ? body.label : undefined
  const enabled = typeof body?.enabled === 'boolean' ? body.enabled : undefined
  const source = await addMarketplaceSource({ url, label, enabled })
  return Response.json({ source }, { status: 201 })
}

async function deleteMarketplaceSource(id: string): Promise<Response> {
  await removeMarketplaceSource(id)
  return Response.json({ ok: true })
}

async function assertHostPrerequisites(config: McpServerConfig) {
  const hostPreflightStatus = await getHostPreflightStatus(config, true)
  if (hostPreflightStatus?.statusDetail) {
    throw ApiError.badRequest(hostPreflightStatus.statusDetail)
  }
}

async function createServer(body: Record<string, unknown>): Promise<Response> {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) {
    throw ApiError.badRequest('Missing or invalid "name" in request body')
  }

  const scope = ensureConfigScope(typeof body.scope === 'string' ? body.scope : undefined)
  const config = buildServerConfig(body.config)
  await assertHostPrerequisites(config)

  try {
    await addMcpConfig(name, config, scope)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('already exists')) {
      throw ApiError.conflict(message)
    }
    throw ApiError.badRequest(message)
  }

  const created = getMcpConfigByName(name)
  if (!created) {
    throw ApiError.internal(`Created MCP server "${name}" could not be reloaded`)
  }

  return Response.json({ server: serializeServerSnapshot(name, created) }, { status: 201 })
}

async function updateServer(name: string, body: Record<string, unknown>): Promise<Response> {
  const targetCwd = getCwd()
  const previousCwd = optionalString(body.previousCwd)
  const previousLookupCwd = previousCwd ?? targetCwd
  const existing = runWithCwdOverride(previousLookupCwd, () => getMcpConfigByName(name))
  if (!existing) {
    throw ApiError.notFound(`MCP server not found: ${name}`)
  }

  if (!EDITABLE_SCOPES.has(existing.scope)) {
    throw ApiError.badRequest(`MCP server "${name}" cannot be edited from scope "${existing.scope}"`)
  }

  const nextScope = ensureConfigScope(typeof body.scope === 'string' ? body.scope : existing.scope)
  const nextConfig = buildServerConfig(body.config)
  await assertHostPrerequisites(nextConfig)
  const previousConfig = stripScope(existing)
  const previousScope = existing.scope

  try {
    await runWithCwdOverride(previousLookupCwd, () => removeMcpConfig(name, previousScope))
    await addMcpConfig(name, nextConfig, nextScope)
  } catch (error) {
    try {
      const restored = runWithCwdOverride(previousLookupCwd, () => getMcpConfigByName(name))
      if (!restored) {
        await runWithCwdOverride(previousLookupCwd, () => addMcpConfig(name, previousConfig, previousScope))
      }
    } catch {
      // Preserve the original update error below.
    }

    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('already exists')) {
      throw ApiError.conflict(message)
    }
    throw ApiError.badRequest(message)
  }

  const updated = getMcpConfigByName(name)
  if (!updated) {
    throw ApiError.internal(`Updated MCP server "${name}" could not be reloaded`)
  }

  return Response.json({ server: serializeServerSnapshot(name, updated) })
}

async function deleteServer(name: string, url: URL): Promise<Response> {
  const scope = ensureConfigScope(url.searchParams.get('scope') || undefined)
  const existing = getMcpConfigByName(name)
  if (!existing) {
    throw ApiError.notFound(`MCP server not found: ${name}`)
  }

  await removeMcpConfig(name, scope)
  cleanupSecureStorage(name, existing)
  await clearServerCache(name, existing).catch(() => {})

  return Response.json({ ok: true })
}

async function toggleServer(name: string, sessionId?: string): Promise<Response> {
  const existing = await resolveServerForRuntimeAction(name)
  if (!existing) {
    throw ApiError.notFound(`MCP server not found: ${name}`)
  }

  const enabled = isMcpServerDisabled(name)
  setMcpServerEnabled(name, enabled)
  const sessionSync = await syncMcpToggleToSession(sessionId, name, enabled)

  if (!enabled) {
    await clearServerCache(name, existing).catch(() => {})
    const updated = serializeServerSnapshot(name, existing)
    return Response.json({ server: updated, ...(sessionSync ? { sessionSync } : {}) })
  }

  const hostPreflightStatus = await getHostPreflightStatus(existing, true)
  if (hostPreflightStatus) {
    await clearServerCache(name, existing).catch(() => {})
    return Response.json({
      server: buildServerDto(name, existing, hostPreflightStatus),
    })
  }

  const result = await reconnectMcpServerImpl(name, existing)
  await clearServerCache(name, existing).catch(() => {})

  const updated = await serializeServerWithLiveStatus(name, existing)
  const statusDetail =
    result.client.type === 'failed' && 'error' in result.client ? result.client.error : undefined

  return Response.json({
    server: {
      ...updated,
      ...(statusDetail ? { statusDetail } : {}),
    },
    ...(sessionSync ? { sessionSync } : {}),
  })
}

async function reconnectServer(name: string): Promise<Response> {
  const existing = await resolveServerForRuntimeAction(name)
  if (!existing) {
    throw ApiError.notFound(`MCP server not found: ${name}`)
  }

  const hostPreflightStatus = await getHostPreflightStatus(existing, !isMcpServerDisabled(name))
  if (hostPreflightStatus) {
    await clearServerCache(name, existing).catch(() => {})
    return Response.json({
      server: buildServerDto(name, existing, hostPreflightStatus),
    })
  }

  const result = await reconnectMcpServerImpl(name, existing)
  await clearServerCache(name, existing).catch(() => {})

  const server = await serializeServerWithLiveStatus(name, existing)
  const statusDetail =
    result.client.type === 'failed' && 'error' in result.client ? result.client.error : undefined

  return Response.json({
    server: {
      ...server,
      ...(statusDetail ? { statusDetail } : {}),
    },
  })
}

export async function handleMcpApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    enableConfigs()

    const serverName = segments[2] ? decodeURIComponent(segments[2]) : undefined
    const action = segments[3]
    const body =
      req.method === 'POST' || req.method === 'PUT'
        ? await parseJsonBody(req)
        : undefined

    return await runWithCwdOverride(resolveRequestCwd(url, body), async () => {
      // Marketplace routes share the /api/mcp prefix. Short-circuit before
      // serverName-shaped lookups so a server literally named "marketplace"
      // (extremely unlikely, but possible) cannot collide.
      if (serverName === 'marketplace') {
        if (req.method === 'GET' && !action) {
          return listMarketplace()
        }
        if (req.method === 'POST' && action === 'refresh') {
          return refreshMarketplace(body)
        }
        if (req.method === 'POST' && action === 'sources' && !segments[4]) {
          return createMarketplaceSource(body)
        }
        if (req.method === 'DELETE' && action === 'sources' && segments[4]) {
          return deleteMarketplaceSource(decodeURIComponent(segments[4]))
        }
        throw new ApiError(
          405,
          `Method ${req.method} not allowed on /api/mcp/marketplace`,
          'METHOD_NOT_ALLOWED',
        )
      }

      if (req.method === 'GET' && serverName === 'project-paths' && !action) {
        return listProjectPathsWithPrivateMcp()
      }

      if (req.method === 'GET' && !serverName) {
        return listServers()
      }

      if (req.method === 'GET' && serverName && action === 'status') {
        return getServerStatus(serverName)
      }

      if (req.method === 'GET' && serverName && action === 'tools') {
        return listServerTools(serverName)
      }

      // POST /api/mcp/:server/tools/:tool/toggle
      // Per-tool enable/disable. Storage lives at the user/global scope, so
      // the toggle is shared across all projects for the same MCP server.
      if (
        req.method === 'POST' &&
        serverName &&
        action === 'tools' &&
        segments[5] === 'toggle' &&
        segments[4]
      ) {
        return toggleServerTool(serverName, decodeURIComponent(segments[4]), body)
      }

      if (req.method === 'POST' && !serverName) {
        return createServer(body ?? {})
      }

      if (req.method === 'PUT' && serverName) {
        return updateServer(serverName, body ?? {})
      }

      if (req.method === 'DELETE' && serverName && !action) {
        return deleteServer(serverName, url)
      }

      if (req.method === 'POST' && serverName && action === 'toggle') {
        return toggleServer(serverName, optionalString(body?.sessionId))
      }

      if (req.method === 'POST' && serverName && action === 'reconnect') {
        return reconnectServer(serverName)
      }

      throw new ApiError(405, `Method ${req.method} not allowed`, 'METHOD_NOT_ALLOWED')
    })
  } catch (error) {
    return errorResponse(error)
  }
}
