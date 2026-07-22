import { api } from './client'

export type AgentSource =
  | 'built-in'
  | 'plugin'
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'flagSettings'
  | 'policySettings'

export type AgentDefinition = {
  agentType: string
  description?: string
  model?: string
  modelDisplay?: string
  effort?: string | number
  tools?: string[]
  systemPrompt?: string
  color?: string
  source: AgentSource
  baseDir?: string
  target?: string
  overriddenBy?: AgentSource
  isActive: boolean
  editable?: boolean
}

export type AgentScope = 'user' | 'project'

export type AgentMutationInput = {
  scope: AgentScope
  cwd?: string
  target?: string
  name: string
  description: string
  systemPrompt: string
  model?: string | null
  effort?: string | number | null
  tools?: string[] | null
  color?: string | null
}

export type AgentListResponse = {
  activeAgents: AgentDefinition[]
  allAgents: AgentDefinition[]
  availableTools?: string[]
}

export type AgentMutationResponse = {
  agent: AgentDefinition
}

export type AgentSessionReloadSummary = {
  applied: boolean
  reason?: 'not_running' | 'failed'
  commands: number
  agents: number
  plugins: number
  mcpServers: number
  errors: number
  error?: string
}

export type AgentReloadResponse = {
  ok: true
  session: AgentSessionReloadSummary
}

export const agentsApi = {
  list: (cwd?: string) => {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
    return api.get<AgentListResponse>(`/api/agents${query}`)
  },
  create: (input: AgentMutationInput) =>
    api.post<AgentMutationResponse>('/api/agents', input),
  update: (name: string, input: AgentMutationInput) =>
    api.put<AgentMutationResponse>(`/api/agents/${encodeURIComponent(name)}`, input),
  delete: (name: string, scope: AgentScope, cwd?: string, target?: string) => {
    const query = new URLSearchParams({ scope })
    if (cwd) query.set('cwd', cwd)
    if (target) query.set('target', target)
    return api.delete<void>(`/api/agents/${encodeURIComponent(name)}?${query.toString()}`)
  },
  reload: (sessionId: string) =>
    api.post<AgentReloadResponse>(
      `/api/agents/reload?sessionId=${encodeURIComponent(sessionId)}`,
      undefined,
      { timeout: 120_000 },
    ),
}
