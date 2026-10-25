import { api } from './client'
import type { SessionModelChoice } from '../../../src/shared/sessionDelegation'

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
  providerId?: string
  effort?: string | number
  tools?: string[]
  systemPrompt?: string
  color?: string
  source: AgentSource
  baseDir?: string
  target?: string
  overriddenBy?: AgentSource
  isActive: boolean
  /** The backing file can be rewritten. Never true for built-in agents. */
  editable?: boolean
  /** Built-in agents only: provider, model and effort can be changed via setOverride. */
  overridable?: boolean
  /**
   * Built-in agents only: what this build ships with, so the UI can name and
   * restore the default. Never hardcode it — it varies per agent and per build.
   */
  defaults?: { model?: string; effort?: string | number }
  /** Built-in agents only: the override currently in effect, if any. */
  override?: { providerId?: string; model?: string; effort?: string | number; source: AgentSource }
}

/** `null` clears that field; an omitted field is left unchanged. */
export type AgentOverrideInput = {
  cwd?: string
  providerId?: string | null
  model?: string | null
  effort?: string | number | null
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
  providerModels: (name: string, cwd?: string) => {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
    return api.get<{ models: SessionModelChoice[] }>(`/api/agents/${encodeURIComponent(name)}/provider-models${query}`)
  },
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
  setOverride: (name: string, input: AgentOverrideInput) =>
    api.put<AgentMutationResponse>(
      `/api/agents/${encodeURIComponent(name)}/override`,
      input,
    ),
  clearOverride: (name: string, cwd?: string) => {
    const query = new URLSearchParams()
    if (cwd) query.set('cwd', cwd)
    const suffix = query.toString() ? `?${query.toString()}` : ''
    return api.delete<AgentMutationResponse>(
      `/api/agents/${encodeURIComponent(name)}/override${suffix}`,
    )
  },
  reload: (sessionId: string) =>
    api.post<AgentReloadResponse>(
      `/api/agents/reload?sessionId=${encodeURIComponent(sessionId)}`,
      undefined,
      { timeout: 120_000 },
    ),
}
