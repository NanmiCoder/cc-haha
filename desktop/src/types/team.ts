// Source: src/server/services/teamService.ts, src/server/ws/events.ts

export type TeamSummary = {
  name: string
  memberCount: number
  createdAt?: string
}

export type TeamMember = {
  agentId: string
  name?: string
  role: string
  status: 'running' | 'idle' | 'completed' | 'error'
  currentTask?: string
  color?: AgentColor
  sessionId?: string
}

export type TeamDetail = {
  name: string
  leadAgentId?: string
  leadSessionId?: string
  members: TeamMember[]
  createdAt?: string
}

export type AgentColor = 'red' | 'blue' | 'green' | 'yellow' | 'purple' | 'orange' | 'pink' | 'cyan'

export const AGENT_COLORS: AgentColor[] = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan']

/** Lifecycle message types that should be filtered from agent output display */
export const AGENT_LIFECYCLE_TYPES = new Set([
  'shutdown_approved',
  'shutdown_rejected',
  'shutdown_request',
  'teammate_terminated',
  'idle_notification',
])
