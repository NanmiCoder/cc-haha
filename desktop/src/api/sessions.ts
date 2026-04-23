import { api } from './client'
import type { SessionListItem, MessageEntry } from '../types/session'

type SessionsResponse = { sessions: SessionListItem[]; total: number }
type MessagesResponse = { messages: MessageEntry[] }
type CreateSessionResponse = { sessionId: string }

export type RecentProject = {
  projectPath: string
  realPath: string
  projectName: string
  isGit: boolean
  repoName: string | null
  branch: string | null
  modifiedAt: string
  sessionCount: number
}

export const sessionsApi = {
  list(params?: { project?: string; limit?: number; offset?: number }) {
    const query = new URLSearchParams()
    if (params?.project) query.set('project', params.project)
    if (params?.limit) query.set('limit', String(params.limit))
    if (params?.offset) query.set('offset', String(params.offset))
    const qs = query.toString()
    return api.get<SessionsResponse>(`/api/sessions${qs ? `?${qs}` : ''}`)
  },

  getMessages(sessionId: string) {
    return api.get<MessagesResponse>(`/api/sessions/${sessionId}/messages`)
  },

  create(workDir?: string) {
    return api.post<CreateSessionResponse>('/api/sessions', workDir ? { workDir } : {})
  },

  delete(sessionId: string) {
    return api.delete<{ ok: true }>(`/api/sessions/${sessionId}`)
  },

  rename(sessionId: string, title: string) {
    return api.patch<{ ok: true }>(`/api/sessions/${sessionId}`, { title })
  },

  getRecentProjects(limit?: number) {
    const query = typeof limit === 'number' ? `?limit=${limit}` : ''
    return api.get<{ projects: RecentProject[] }>(`/api/sessions/recent-projects${query}`)
  },

  getGitInfo(sessionId: string) {
    return api.get<{ branch: string | null; repoName: string | null; workDir: string; changedFiles: number }>(`/api/sessions/${sessionId}/git-info`)
  },

  getSlashCommands(sessionId: string) {
    return api.get<{ commands: Array<{ name: string; description: string }> }>(`/api/sessions/${sessionId}/slash-commands`)
  },
}
