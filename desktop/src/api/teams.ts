import { api } from './client'
import type { TeamSummary, TeamDetail } from '../types/team'

type TeamsResponse = { teams: TeamSummary[] }

type TranscriptMessage = {
  id: string
  type: string
  content: unknown
  timestamp: string
  model?: string
  parentToolUseId?: string
}

type TranscriptResponse = { messages: TranscriptMessage[] }

export type { TranscriptMessage }

export const teamsApi = {
  list() {
    return api.get<TeamsResponse>('/api/teams')
  },

  get(name: string) {
    return api.get<TeamDetail>(`/api/teams/${encodeURIComponent(name)}`)
  },

  getMemberTranscript(teamName: string, agentId: string) {
    return api.get<TranscriptResponse>(
      `/api/teams/${encodeURIComponent(teamName)}/members/${encodeURIComponent(agentId)}/transcript`,
    )
  },

  sendMemberMessage(teamName: string, agentId: string, content: string) {
    return api.post<{ ok: true }>(
      `/api/teams/${encodeURIComponent(teamName)}/members/${encodeURIComponent(agentId)}/messages`,
      { content },
    )
  },

  delete(name: string) {
    return api.delete<{ ok: true }>(`/api/teams/${encodeURIComponent(name)}`)
  },
}
