// Source: src/server/services/teamService.ts, src/server/ws/events.ts

export type TeamSummary = {
  name: string
  memberCount: number
  createdAt?: string
  incarnationId?: string
}

/**
 * Whether a teammate is mid-turn right now, as reported by the server. Distinct
 * from `status`, which says whether the member is still part of the run. Owning
 * an `in_progress` task is evidence of neither: a teammate marks a task started
 * and can then end its turn, and an umbrella task stays open underneath every
 * turn it covers.
 */
export type TeamMemberActivity = 'active' | 'idle' | 'exited' | 'unknown'

export type TeamMember = {
  agentId: string
  name?: string
  role: string
  status: 'running' | 'idle' | 'completed' | 'error'
  activity?: TeamMemberActivity
  currentTask?: string
  color?: AgentColor
  sessionId?: string
  model?: string
}

export type TeamDetail = {
  name: string
  incarnationId?: string
  leadAgentId?: string
  leadSessionId?: string
  members: TeamMember[]
  createdAt?: string
}

export type TeamWorkbenchTask = {
  id: string
  subject: string
  description: string
  activeForm?: string
  owner?: string
  status: 'pending' | 'in_progress' | 'completed'
  blocks: string[]
  blockedBy: string[]
  metadata?: Record<string, unknown>
  taskListId: string
}

export type TeamWorkbenchMessage = {
  id: string
  from: string
  to: string | '*'
  recipients: string[]
  kind: 'direct' | 'broadcast' | 'system'
  text: string
  summary?: string
  timestamp: string
  color?: string
  taskId?: string
  protocolType?: string
}

export type TeamWorkbenchSnapshot = {
  version: string
  generatedAt: string
  taskListRevision?: number
  terminalTaskFrameId?: string
  team: TeamDetail
  tasks: TeamWorkbenchTask[]
  messages: TeamWorkbenchMessage[]
  deletedAt?: string
}

export type TeamWorkbenchTimeline = {
  teamName: string
  snapshots: TeamWorkbenchSnapshot[]
  loading: boolean
  error: string | null
}

export type TeamWorkbenchSessionTimeline = {
  sessionId: string
  teamName: string
  incarnationId?: string
  snapshots: TeamWorkbenchSnapshot[]
  source: 'live' | 'archive' | 'transcript'
}

export type AgentColor = 'red' | 'blue' | 'green' | 'yellow' | 'purple' | 'orange' | 'pink' | 'cyan'

export const AGENT_COLORS: AgentColor[] = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan']

export function teamMemberSessionId(agentId: string, incarnationId?: string): string {
  if (!incarnationId) return `team-member:${agentId}`
  return `team-member:${encodeURIComponent(incarnationId)}:${encodeURIComponent(agentId)}`
}

/** Lifecycle message types that should be filtered from agent output display */
export const AGENT_LIFECYCLE_TYPES = new Set([
  'shutdown_approved',
  'shutdown_rejected',
  'shutdown_request',
  'teammate_terminated',
  'idle_notification',
])
