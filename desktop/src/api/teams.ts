import { api } from './client'
import type {
  TeamSummary,
  TeamDetail,
  TeamWorkbenchSnapshot,
  TeamWorkbenchSessionTimeline,
} from '../types/team'
import type { AgentTaskNotification } from '../types/chat'

type TeamsResponse = { teams: TeamSummary[] }

type TranscriptMessage = {
  id: string
  type: string
  content: unknown
  timestamp: string
  model?: string
  parentToolUseId?: string
  toolUseResult?: unknown
}

type TranscriptResponse = {
  messages: TranscriptMessage[]
  /** Terminal notifications from this cursor page; merge by toolUseId. */
  taskNotifications?: AgentTaskNotification[]
  /** Physical transcript fragments that own this member's nested activity. */
  ownerAgentIds?: string[]
  /** Where this member's work on each team task starts and ends. */
  taskAnchors?: TeamTaskAnchor[]
  signature?: string
  cursor?: string
  afterOrdinal?: number
  reset?: boolean
}

type TranscriptOptions = {
  signature?: string
  cursor?: string
  afterOrdinal?: number
  leadSessionId?: string
  incarnationId?: string
}

export type TeamTaskAnchor = {
  taskId: string
  status: 'pending' | 'in_progress' | 'completed'
  messageId: string
  timestamp: string
}

export type { TranscriptMessage }

/** `providerId: null` is Claude Official. */
export type MemberRuntimeUpdate = {
  providerId: string | null
  modelId: string
  effortLevel?: string
}

export type MemberRuntimeUpdateResponse = {
  ok: true
  member: {
    agentId: string
    name?: string
    model?: string
    providerId?: string | null
    providerName?: string
  }
}

export const teamsApi = {
  list() {
    return api.get<TeamsResponse>('/api/teams')
  },

  get(name: string) {
    return api.get<TeamDetail>(`/api/teams/${encodeURIComponent(name)}`)
  },

  getWorkbench(name: string) {
    return api.get<TeamWorkbenchSnapshot>(
      `/api/teams/${encodeURIComponent(name)}/workbench`,
    )
  },

  getWorkbenchForSession(
    sessionId: string,
    options?: { teamName?: string; at?: number; incarnationId?: string },
  ) {
    const params = new URLSearchParams()
    if (options?.teamName) params.set('teamName', options.teamName)
    if (options?.at !== undefined) params.set('at', String(options.at))
    if (options?.incarnationId) params.set('incarnationId', options.incarnationId)
    const query = params.toString()
    return api.get<TeamWorkbenchSessionTimeline>(
      `/api/teams/session/${encodeURIComponent(sessionId)}/workbench${query ? `?${query}` : ''}`,
    )
  },

  getMemberTranscript(
    teamName: string,
    agentId: string,
    options?: TranscriptOptions,
  ) {
    const params = new URLSearchParams()
    if (options) {
      params.set('incremental', 'true')
      if (options.leadSessionId) params.set('leadSessionId', options.leadSessionId)
      if (options.incarnationId) params.set('incarnationId', options.incarnationId)
      if (options.signature) params.set('signature', options.signature)
      if (options.cursor) params.set('cursor', options.cursor)
      if (options.afterOrdinal !== undefined) {
        params.set('afterOrdinal', String(options.afterOrdinal))
      }
    }
    const query = params.toString()
    return api.get<TranscriptResponse>(
      `/api/teams/${encodeURIComponent(teamName)}/members/${encodeURIComponent(agentId)}/transcript${query ? `?${query}` : ''}`,
    )
  },

  sendMemberMessage(teamName: string, agentId: string, content: string) {
    return api.post<{ ok: true }>(
      `/api/teams/${encodeURIComponent(teamName)}/members/${encodeURIComponent(agentId)}/messages`,
      { content },
    )
  },

  /**
   * Switches a member's model through the team runtime, which restarts its CLI
   * as the same member. Never route this through the session runtime path.
   */
  updateMemberRuntime(teamName: string, agentId: string, runtime: MemberRuntimeUpdate) {
    return api.patch<MemberRuntimeUpdateResponse>(
      `/api/teams/${encodeURIComponent(teamName)}/members/${encodeURIComponent(agentId)}/runtime`,
      runtime,
    )
  },

  delete(name: string) {
    return api.delete<{ ok: true }>(`/api/teams/${encodeURIComponent(name)}`)
  },
}
