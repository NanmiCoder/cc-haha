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
