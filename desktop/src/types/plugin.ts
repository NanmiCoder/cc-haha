export type PluginScope = 'user' | 'project' | 'local' | 'managed' | 'builtin'

export type PluginCapabilityKey =
  | 'commands'
  | 'agents'
  | 'skills'
  | 'hooks'
  | 'mcpServers'
  | 'lspServers'

export type PluginCapabilities = Record<PluginCapabilityKey, string[]>

export type PluginComponentCounts = Record<PluginCapabilityKey, number>

export type PluginSkillEntry = {
  name: string
  displayName?: string
  description: string
  version?: string
  pluginName?: string
}

export type PluginCommandEntry = {
  name: string
  description: string
}

export type PluginAgentEntry = {
  name: string
  displayName?: string
  description: string
}

export type PluginHookEntry = {
  event: string
  matcher?: string
  actions: string[]
}

export type PluginMcpServerEntry = {
  name: string
  displayName?: string
  transport: string
  summary: string
}

export type PluginSummary = {
  id: string
  name: string
  marketplace: string
  scope: PluginScope
  enabled: boolean
  hasErrors: boolean
  isBuiltin: boolean
  version?: string
  description?: string
  authorName?: string
  installPath?: string
  projectPath?: string
  componentCounts: PluginComponentCounts
  errors: string[]
}

export type PluginDetail = PluginSummary & {
  capabilities: PluginCapabilities
  commandEntries: PluginCommandEntry[]
  agentEntries: PluginAgentEntry[]
  hookEntries: PluginHookEntry[]
  skillEntries: PluginSkillEntry[]
  mcpServerEntries: PluginMcpServerEntry[]
  userConfig?: Record<string, { type: string; title?: string; description?: string; required?: boolean; sensitive?: boolean; default?: unknown }>
}

export type PluginMarketplaceSummary = {
  name: string
  source: string
  lastUpdated?: string
  autoUpdate: boolean
  installedCount: number
}

export type PluginListResponse = {
  plugins: PluginSummary[]
  marketplaces: PluginMarketplaceSummary[]
  summary: {
    total: number
    enabled: number
    errorCount: number
    marketplaceCount: number
  }
}

export type PluginReloadSummary = {
  enabled: number
  disabled: number
  skills: number
  agents: number
  hooks: number
  mcpServers: number
  lspServers: number
  errors: number
}

export type PluginSessionReloadSummary = {
  applied: boolean
  reason?: 'not_running' | 'failed'
  commands: number
  agents: number
  plugins: number
  mcpServers: number
  errors: number
  error?: string
}

export type CatalogPluginCategory =
  | 'official'
  | 'devops'
  | 'codeReview'
  | 'observability'
  | 'database'
  | 'frontend'
  | 'payments'
  | 'productivity'
  | 'browser'

export type CatalogPlugin = {
  id: string
  marketplace: string
  marketplaceSource: unknown
  displayName: string
  description: string
  category: CatalogPluginCategory
  installed: boolean
}

export type AddMarketplaceResponse = {
  ok: true
  name: string
  alreadyMaterialized: boolean
  source: unknown
}


// ─── Prerequisites (host-command availability) ────────────────────────────

export type PluginPrerequisiteInstallStep = {
  /** Free-form label like "winget" / "scoop" / "brew" / "shell". */
  manager: string
  /** Exact shell command to run; the modal offers copy + open-in-terminal. */
  cmd: string
}

/**
 * Per-platform install step lists. Keys are the same `process.platform`
 * values that the renderer compares against `navigator.userAgentData`
 * + a fallback heuristic — `win32` / `darwin` / `linux`.
 */
export type PluginPrerequisiteInstallMap = {
  win32?: PluginPrerequisiteInstallStep[]
  darwin?: PluginPrerequisiteInstallStep[]
  linux?: PluginPrerequisiteInstallStep[]
}

export type PluginPrerequisiteRow = {
  command: string
  label?: string
  homepage?: string
  installed: boolean
  resolvedPath: string | null
  install?: PluginPrerequisiteInstallMap
  affectedServers: Array<{ name: string; displayName?: string }>
}

export type PluginPrerequisitesResponse = {
  pluginId: string
  prerequisites: PluginPrerequisiteRow[]
}


// ─── Known language servers (host-binary detection) ───────────────────────

/**
 * A detected status row for one well-known language server. This is a
 * separate dimension from plugin-declared `lspServers` — it only reflects
 * whether the binary is resolvable on PATH, plus per-platform install
 * hints. Install commands run in a user-confirmed terminal, never
 * silently. Mirrors the server `KnownLanguageServerStatus` shape.
 */
export type KnownLanguageServerRow = {
  language: string
  label: string
  command: string
  candidates?: string[]
  homepage?: string
  install: PluginPrerequisiteInstallMap
  installed: boolean
  resolvedPath: string | null
  resolvedCommand: string | null
}

export type KnownLanguageServersResponse = {
  servers: KnownLanguageServerRow[]
}
