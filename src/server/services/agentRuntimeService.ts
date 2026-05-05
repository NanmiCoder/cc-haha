import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { getClaudeCodeMcpConfigs } from '../../services/mcp/config.js'
import { getAgentDefinitionsWithOverrides } from '../../tools/AgentTool/loadAgentsDir.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { ApiError } from '../middleware/errorHandler.js'
import { PluginService } from './pluginService.js'
import { ProviderService } from './providerService.js'

export type AgentRuntimeConcept =
  | 'Gateway'
  | 'AgentHarness'
  | 'PluginRegistry'
  | 'ToolAssembly'
  | 'MultiAgentSession'
  | 'SessionQueue'

export type AgentRuntimeConceptMapping = {
  openClawConcept: AgentRuntimeConcept
  yuanclawSurfaces: string[]
  status: 'available'
}

export type AgentRuntimeProfile = {
  id: 'yuanclaw-general-agent-runtime'
  cwd: string
  controlPlane: {
    mode: 'gateway-like-server'
    transports: string[]
    endpoints: string[]
  }
  harnessSelection: {
    mode: 'provider-backed'
    providerSurface: '/api/providers'
  }
  capabilityRegistry: {
    concepts: AgentRuntimeConceptMapping[]
  }
  sessionPolicy: {
    isolation: 'config-and-workspace-scoped'
    identityKeys: string[]
    queuePolicy: 'session-keyed-task-lanes'
  }
}

export type AgentRuntimeRegistryKind =
  | 'agentHarness'
  | 'toolAssembly'
  | 'pluginSource'
  | 'sessionPolicy'

export type AgentRuntimeEntryOrigin =
  | 'builtin'
  | 'api'
  | 'plugin'
  | 'project'
  | 'user'
  | 'managed'
  | 'local'

export type AgentRuntimeRegistryEntry = {
  kind: AgentRuntimeRegistryKind
  id: string
  displayName: string
  description?: string
  origin: AgentRuntimeEntryOrigin
  enabled: boolean
  surfaces: string[]
  capabilities: string[]
  metadata?: Record<string, unknown>
  registeredAt: string
  updatedAt: string
}

export type AgentRuntimeRegistrationInput = {
  kind: AgentRuntimeRegistryKind
  id: string
  displayName?: string
  description?: string
  source?: Exclude<AgentRuntimeEntryOrigin, 'builtin'>
  enabled?: boolean
  surfaces: string[]
  capabilities: string[]
  metadata?: Record<string, unknown>
}

export type AgentRuntimeRegistry = {
  id: 'yuanclaw-agent-runtime-registry'
  version: 1
  cwd: string
  controlPlane: {
    mode: 'gateway-like-server'
    transports: string[]
    endpoints: string[]
  }
  entries: AgentRuntimeRegistryEntry[]
  liveSources: AgentRuntimeLiveSources
  extensionKinds: AgentRuntimeRegistryKind[]
  persistence: {
    scope: 'config'
    path: 'yuanclaw/agent-runtime-registry.json'
  }
}

export type AgentRuntimeLiveSources = {
  providers: {
    endpoint: '/api/providers'
    providerCount: number
    activeId: string | null
    error?: string
  }
  plugins: {
    endpoint: '/api/plugins'
    total: number
    enabled: number
    errorCount: number
    marketplaceCount: number
    error?: string
  }
  agents: {
    endpoint: '/api/agents'
    activeCount: number
    total: number
    sourceCounts: Record<string, number>
    error?: string
  }
  mcp: {
    endpoint: '/api/mcp'
    mode: 'config-backed'
    serverCount: number
    errorCount: number
    error?: string
  }
}

type PersistedAgentRuntimeRegistry = {
  version: 1
  entries: AgentRuntimeRegistryEntry[]
}

const RUNTIME_CONCEPTS: AgentRuntimeConceptMapping[] = [
  {
    openClawConcept: 'Gateway',
    yuanclawSurfaces: [
      'src/server/router.ts',
      'src/server/ws/handler.ts',
      'src/server/api/*',
    ],
    status: 'available',
  },
  {
    openClawConcept: 'AgentHarness',
    yuanclawSurfaces: [
      'src/tools/AgentTool/AgentTool.tsx',
      'src/tools/AgentTool/runAgent.ts',
      'src/server/services/providerService.ts',
    ],
    status: 'available',
  },
  {
    openClawConcept: 'PluginRegistry',
    yuanclawSurfaces: [
      'src/server/services/pluginService.ts',
      'src/plugins/builtinPlugins.ts',
      'src/utils/plugins/*',
    ],
    status: 'available',
  },
  {
    openClawConcept: 'ToolAssembly',
    yuanclawSurfaces: [
      'src/tools.ts',
      'src/services/tools/toolOrchestration.ts',
      'src/services/mcp/*',
    ],
    status: 'available',
  },
  {
    openClawConcept: 'MultiAgentSession',
    yuanclawSurfaces: [
      'src/tools/AgentTool/*',
      'src/tools/SendMessageTool/*',
      'src/server/services/sessionService.ts',
      'src/server/services/taskService.ts',
    ],
    status: 'available',
  },
  {
    openClawConcept: 'SessionQueue',
    yuanclawSurfaces: [
      'src/server/services/taskService.ts',
      'src/utils/concurrentSessions.ts',
      'src/tasks/LocalAgentTask/LocalAgentTask.tsx',
      'src/services/tools/StreamingToolExecutor.ts',
    ],
    status: 'available',
  },
]

const RUNTIME_EXTENSION_KINDS: AgentRuntimeRegistryKind[] = [
  'agentHarness',
  'toolAssembly',
  'pluginSource',
  'sessionPolicy',
]

const RUNTIME_ENTRY_ORIGINS: Exclude<AgentRuntimeEntryOrigin, 'builtin'>[] = [
  'api',
  'plugin',
  'project',
  'user',
  'managed',
  'local',
]

const RUNTIME_REGISTRY_PATH = 'yuanclaw/agent-runtime-registry.json'
const BUILTIN_TIMESTAMP = '1970-01-01T00:00:00.000Z'

const BUILTIN_RUNTIME_ENTRIES: AgentRuntimeRegistryEntry[] = [
  {
    kind: 'agentHarness',
    id: 'yuanclaw-agent-harness',
    displayName: 'yuanclaw Agent Harness',
    description: 'Provider-backed agent run surface with task wait semantics.',
    origin: 'builtin',
    enabled: true,
    surfaces: [
      '/api/agents',
      '/api/tasks',
      'src/tools/AgentTool/runAgent.ts',
      'src/tools/AgentTool/AgentTool.tsx',
    ],
    capabilities: ['agent.run', 'agent.wait', 'agent.fork-context'],
    registeredAt: BUILTIN_TIMESTAMP,
    updatedAt: BUILTIN_TIMESTAMP,
  },
  {
    kind: 'toolAssembly',
    id: 'yuanclaw-tool-assembly',
    displayName: 'yuanclaw Tool Assembly',
    description: 'Core tools plus MCP-backed tool invocation surfaces.',
    origin: 'builtin',
    enabled: true,
    surfaces: [
      '/api/mcp',
      'src/tools.ts',
      'src/services/tools/toolOrchestration.ts',
      'src/services/mcp/*',
    ],
    capabilities: ['tools.invoke', 'mcp.tools', 'mcp.resources', 'mcp.prompts'],
    registeredAt: BUILTIN_TIMESTAMP,
    updatedAt: BUILTIN_TIMESTAMP,
  },
  {
    kind: 'pluginSource',
    id: 'yuanclaw-plugin-registry',
    displayName: 'yuanclaw Plugin Registry',
    description: 'Installed plugin, skill, command, agent, hook, and MCP inventory.',
    origin: 'builtin',
    enabled: true,
    surfaces: [
      '/api/plugins',
      '/api/plugins/detail',
      'src/server/services/pluginService.ts',
      'src/utils/plugins/*',
    ],
    capabilities: [
      'plugins.list',
      'plugins.reload',
      'plugins.skills',
      'plugins.agents',
      'plugins.mcpServers',
    ],
    registeredAt: BUILTIN_TIMESTAMP,
    updatedAt: BUILTIN_TIMESTAMP,
  },
  {
    kind: 'sessionPolicy',
    id: 'yuanclaw-session-policy',
    displayName: 'yuanclaw Session Policy',
    description: 'Config and workspace scoped sessions with task-lane identity keys.',
    origin: 'builtin',
    enabled: true,
    surfaces: [
      '/api/sessions',
      '/api/tasks',
      'src/server/services/sessionService.ts',
      'src/server/services/taskService.ts',
    ],
    capabilities: ['sessions.list', 'sessions.history', 'sessions.send', 'sessions.queue'],
    metadata: {
      isolation: 'config-and-workspace-scoped',
      identityKeys: ['sessionId', 'cwd', 'agentType', 'taskId'],
      queuePolicy: 'session-keyed-task-lanes',
    },
    registeredAt: BUILTIN_TIMESTAMP,
    updatedAt: BUILTIN_TIMESTAMP,
  },
]

export class AgentRuntimeService {
  private readonly providerService = new ProviderService()
  private readonly pluginService = new PluginService()

  getRuntimeProfile(cwd: string): AgentRuntimeProfile {
    return {
      id: 'yuanclaw-general-agent-runtime',
      cwd,
      controlPlane: {
        mode: 'gateway-like-server',
        transports: ['rest', 'websocket'],
        endpoints: [
          '/api/agent-runtime',
          '/api/agent-runtime/registry',
          '/api/agents',
          '/api/plugins',
          '/api/mcp',
          '/api/providers',
          '/api/sessions',
          '/api/tasks',
        ],
      },
      harnessSelection: {
        mode: 'provider-backed',
        providerSurface: '/api/providers',
      },
      capabilityRegistry: {
        concepts: RUNTIME_CONCEPTS.map((concept) => ({
          openClawConcept: concept.openClawConcept,
          yuanclawSurfaces: [...concept.yuanclawSurfaces],
          status: concept.status,
        })),
      },
      sessionPolicy: {
        isolation: 'config-and-workspace-scoped',
        identityKeys: ['sessionId', 'cwd', 'agentType', 'taskId'],
        queuePolicy: 'session-keyed-task-lanes',
      },
    }
  }

  async getRuntimeRegistry(cwd: string): Promise<AgentRuntimeRegistry> {
    const [customEntries, liveSources] = await Promise.all([
      this.readCustomEntries(),
      this.getLiveSources(cwd),
    ])

    return {
      id: 'yuanclaw-agent-runtime-registry',
      version: 1,
      cwd,
      controlPlane: {
        mode: 'gateway-like-server',
        transports: ['rest', 'websocket'],
        endpoints: [
          '/api/agent-runtime',
          '/api/agent-runtime/registry',
          '/api/agents',
          '/api/plugins',
          '/api/mcp',
          '/api/providers',
          '/api/sessions',
          '/api/tasks',
        ],
      },
      entries: [
        ...BUILTIN_RUNTIME_ENTRIES.map(cloneEntry),
        ...customEntries.map(cloneEntry),
      ],
      liveSources,
      extensionKinds: [...RUNTIME_EXTENSION_KINDS],
      persistence: {
        scope: 'config',
        path: RUNTIME_REGISTRY_PATH,
      },
    }
  }

  async registerRuntimeEntry(
    input: unknown,
  ): Promise<{ entry: AgentRuntimeRegistryEntry; created: boolean }> {
    const registration = validateRegistrationInput(input)
    const customEntries = await this.readCustomEntries()

    if (
      BUILTIN_RUNTIME_ENTRIES.some(
        (entry) => entry.kind === registration.kind && entry.id === registration.id,
      )
    ) {
      throw ApiError.conflict(
        `Runtime entry is built-in and cannot be replaced: ${registration.kind}/${registration.id}`,
      )
    }

    const now = new Date().toISOString()
    const existingIndex = customEntries.findIndex(
      (entry) => entry.kind === registration.kind && entry.id === registration.id,
    )
    const existing = existingIndex >= 0 ? customEntries[existingIndex] : undefined
    const entry: AgentRuntimeRegistryEntry = {
      kind: registration.kind,
      id: registration.id,
      displayName: registration.displayName ?? registration.id,
      ...(registration.description !== undefined && { description: registration.description }),
      origin: registration.source ?? 'api',
      enabled: registration.enabled ?? true,
      surfaces: [...registration.surfaces],
      capabilities: [...registration.capabilities],
      ...(registration.metadata !== undefined && { metadata: registration.metadata }),
      registeredAt: existing?.registeredAt ?? now,
      updatedAt: now,
    }

    if (existingIndex >= 0) {
      customEntries[existingIndex] = entry
    } else {
      customEntries.push(entry)
    }

    await this.writeCustomEntries(customEntries)
    return { entry: cloneEntry(entry), created: existingIndex === -1 }
  }

  async deleteRuntimeEntry(
    kind: string,
    id: string,
  ): Promise<{ kind: AgentRuntimeRegistryKind; id: string }> {
    const normalizedKind = parseKind(kind)
    const normalizedId = validateId(id)

    if (
      BUILTIN_RUNTIME_ENTRIES.some(
        (entry) => entry.kind === normalizedKind && entry.id === normalizedId,
      )
    ) {
      throw ApiError.conflict(
        `Runtime entry is built-in and cannot be deleted: ${normalizedKind}/${normalizedId}`,
      )
    }

    const customEntries = await this.readCustomEntries()
    const nextEntries = customEntries.filter(
      (entry) => !(entry.kind === normalizedKind && entry.id === normalizedId),
    )

    if (nextEntries.length === customEntries.length) {
      throw ApiError.notFound(`Runtime entry not found: ${normalizedKind}/${normalizedId}`)
    }

    await this.writeCustomEntries(nextEntries)
    return { kind: normalizedKind, id: normalizedId }
  }

  private getConfigDir(): string {
    return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  }

  private getRegistryPath(): string {
    return path.join(this.getConfigDir(), RUNTIME_REGISTRY_PATH)
  }

  private async readCustomEntries(): Promise<AgentRuntimeRegistryEntry[]> {
    try {
      const raw = await fs.readFile(this.getRegistryPath(), 'utf-8')
      const parsed = JSON.parse(raw) as PersistedAgentRuntimeRegistry
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
        throw new Error('Unsupported registry file format')
      }
      return parsed.entries.map(normalizePersistedEntry)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw ApiError.internal(`Failed to read agent runtime registry: ${formatError(err)}`)
    }
  }

  private async writeCustomEntries(entries: AgentRuntimeRegistryEntry[]): Promise<void> {
    const filePath = this.getRegistryPath()
    const dir = path.dirname(filePath)
    await fs.mkdir(dir, { recursive: true })

    const tmpFile = `${filePath}.tmp.${Date.now()}`
    try {
      const payload: PersistedAgentRuntimeRegistry = {
        version: 1,
        entries: entries.map(cloneEntry),
      }
      await fs.writeFile(tmpFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
      await fs.rename(tmpFile, filePath)
    } catch (err) {
      await fs.unlink(tmpFile).catch(() => {})
      throw ApiError.internal(`Failed to write agent runtime registry: ${formatError(err)}`)
    }
  }

  private async getLiveSources(cwd: string): Promise<AgentRuntimeLiveSources> {
    const [providers, plugins, agents, mcp] = await Promise.all([
      this.getProviderSummary(),
      this.getPluginSummary(cwd),
      this.getAgentSummary(cwd),
      this.getMcpSummary(cwd),
    ])

    return { providers, plugins, agents, mcp }
  }

  private async getProviderSummary(): Promise<AgentRuntimeLiveSources['providers']> {
    try {
      const { providers, activeId } = await this.providerService.listProviders()
      return {
        endpoint: '/api/providers',
        providerCount: providers.length,
        activeId,
      }
    } catch (err) {
      return {
        endpoint: '/api/providers',
        providerCount: 0,
        activeId: null,
        error: formatError(err),
      }
    }
  }

  private async getPluginSummary(cwd: string): Promise<AgentRuntimeLiveSources['plugins']> {
    try {
      const result = await this.pluginService.listPlugins(cwd)
      return {
        endpoint: '/api/plugins',
        total: result.summary.total,
        enabled: result.summary.enabled,
        errorCount: result.summary.errorCount,
        marketplaceCount: result.summary.marketplaceCount,
      }
    } catch (err) {
      return {
        endpoint: '/api/plugins',
        total: 0,
        enabled: 0,
        errorCount: 1,
        marketplaceCount: 0,
        error: formatError(err),
      }
    }
  }

  private async getAgentSummary(cwd: string): Promise<AgentRuntimeLiveSources['agents']> {
    try {
      const { activeAgents, allAgents } = await getAgentDefinitionsWithOverrides(cwd)
      const sourceCounts: Record<string, number> = {}
      for (const agent of allAgents) {
        sourceCounts[agent.source] = (sourceCounts[agent.source] ?? 0) + 1
      }
      return {
        endpoint: '/api/agents',
        activeCount: activeAgents.length,
        total: allAgents.length,
        sourceCounts,
      }
    } catch (err) {
      return {
        endpoint: '/api/agents',
        activeCount: 0,
        total: 0,
        sourceCounts: {},
        error: formatError(err),
      }
    }
  }

  private async getMcpSummary(cwd: string): Promise<AgentRuntimeLiveSources['mcp']> {
    try {
      const { servers, errors } = await runWithCwdOverride(cwd, async () =>
        getClaudeCodeMcpConfigs(),
      )
      return {
        endpoint: '/api/mcp',
        mode: 'config-backed',
        serverCount: Object.keys(servers).length,
        errorCount: errors.length,
      }
    } catch (err) {
      return {
        endpoint: '/api/mcp',
        mode: 'config-backed',
        serverCount: 0,
        errorCount: 1,
        error: formatError(err),
      }
    }
  }
}

function validateRegistrationInput(input: unknown): AgentRuntimeRegistrationInput {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw ApiError.badRequest('Invalid runtime registration body')
  }

  const body = input as Record<string, unknown>
  const kind = parseKind(body.kind)
  const id = validateId(body.id)
  const displayName = readOptionalString(body.displayName, 'displayName', 120)
  const description = readOptionalString(body.description, 'description', 500)
  const source = parseOrigin(body.source)
  const enabled = parseOptionalBoolean(body.enabled, 'enabled')
  const surfaces = readStringArray(body.surfaces, 'surfaces', 20, 200)
  const capabilities = readStringArray(body.capabilities, 'capabilities', 40, 120)
  const metadata = readOptionalMetadata(body.metadata)

  return {
    kind,
    id,
    ...(displayName !== undefined && { displayName }),
    ...(description !== undefined && { description }),
    ...(source !== undefined && { source }),
    ...(enabled !== undefined && { enabled }),
    surfaces,
    capabilities,
    ...(metadata !== undefined && { metadata }),
  }
}

function normalizePersistedEntry(entry: AgentRuntimeRegistryEntry): AgentRuntimeRegistryEntry {
  const registration = validateRegistrationInput({
    kind: entry.kind,
    id: entry.id,
    displayName: entry.displayName,
    description: entry.description,
    source: entry.origin === 'builtin' ? 'api' : entry.origin,
    enabled: entry.enabled,
    surfaces: entry.surfaces,
    capabilities: entry.capabilities,
    metadata: entry.metadata,
  })

  return {
    kind: registration.kind,
    id: registration.id,
    displayName: registration.displayName ?? registration.id,
    ...(registration.description !== undefined && { description: registration.description }),
    origin: registration.source ?? 'api',
    enabled: registration.enabled ?? true,
    surfaces: [...registration.surfaces],
    capabilities: [...registration.capabilities],
    ...(registration.metadata !== undefined && { metadata: registration.metadata }),
    registeredAt: readTimestamp(entry.registeredAt, 'registeredAt'),
    updatedAt: readTimestamp(entry.updatedAt, 'updatedAt'),
  }
}

function parseKind(value: unknown): AgentRuntimeRegistryKind {
  if (
    value === 'agentHarness' ||
    value === 'toolAssembly' ||
    value === 'pluginSource' ||
    value === 'sessionPolicy'
  ) {
    return value
  }
  throw ApiError.badRequest(
    `Invalid "kind". Expected one of: ${RUNTIME_EXTENSION_KINDS.join(', ')}`,
  )
}

function parseOrigin(
  value: unknown,
): Exclude<AgentRuntimeEntryOrigin, 'builtin'> | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw ApiError.badRequest('Invalid "source". Expected a string')
  }
  if (RUNTIME_ENTRY_ORIGINS.includes(value as Exclude<AgentRuntimeEntryOrigin, 'builtin'>)) {
    return value as Exclude<AgentRuntimeEntryOrigin, 'builtin'>
  }
  throw ApiError.badRequest(
    `Invalid "source". Expected one of: ${RUNTIME_ENTRY_ORIGINS.join(', ')}`,
  )
}

function validateId(value: unknown): string {
  if (typeof value !== 'string') {
    throw ApiError.badRequest('Invalid "id". Expected a string')
  }
  const id = value.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(id)) {
    throw ApiError.badRequest(
      'Invalid "id". Use 1-80 letters, numbers, dots, underscores, colons, or hyphens',
    )
  }
  return id
}

function readOptionalString(
  value: unknown,
  fieldName: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw ApiError.badRequest(`Invalid "${fieldName}". Expected a string`)
  }
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    throw ApiError.badRequest(
      `Invalid "${fieldName}". Expected 1-${maxLength} characters`,
    )
  }
  return trimmed
}

function parseOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw ApiError.badRequest(`Invalid "${fieldName}". Expected a boolean`)
  }
  return value
}

function readStringArray(
  value: unknown,
  fieldName: string,
  maxItems: number,
  maxLength: number,
): string[] {
  if (!Array.isArray(value)) {
    throw ApiError.badRequest(`Invalid "${fieldName}". Expected an array of strings`)
  }
  if (value.length === 0 || value.length > maxItems) {
    throw ApiError.badRequest(`Invalid "${fieldName}". Expected 1-${maxItems} items`)
  }

  const seen = new Set<string>()
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      throw ApiError.badRequest(`Invalid "${fieldName}". Expected string items`)
    }
    const trimmed = item.trim()
    if (trimmed.length === 0 || trimmed.length > maxLength) {
      throw ApiError.badRequest(
        `Invalid "${fieldName}". Expected item length 1-${maxLength}`,
      )
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed)
      items.push(trimmed)
    }
  }
  return items
}

function readOptionalMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest('Invalid "metadata". Expected an object')
  }

  const metadata = value as Record<string, unknown>
  try {
    const encoded = JSON.stringify(metadata)
    if (encoded.length > 4096) {
      throw ApiError.badRequest('Invalid "metadata". Expected at most 4096 JSON bytes')
    }
    return JSON.parse(encoded) as Record<string, unknown>
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw ApiError.badRequest('Invalid "metadata". Expected JSON-serializable values')
  }
}

function readTimestamp(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw ApiError.badRequest(`Invalid "${fieldName}". Expected an ISO timestamp`)
  }
  return value
}

function cloneEntry(entry: AgentRuntimeRegistryEntry): AgentRuntimeRegistryEntry {
  return {
    ...entry,
    surfaces: [...entry.surfaces],
    capabilities: [...entry.capabilities],
    ...(entry.metadata !== undefined && {
      metadata: JSON.parse(JSON.stringify(entry.metadata)) as Record<string, unknown>,
    }),
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
