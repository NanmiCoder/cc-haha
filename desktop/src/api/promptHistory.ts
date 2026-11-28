import { api } from './client'

export type PromptHistoryItem = {
  display: string
  timestamp: number
  sessionId?: string
}

export type PromptHistoryListParams = {
  project?: string
  projectRoot?: string
  sessionId?: string
  limit?: number
  sessionOnly?: boolean
}

export type PromptHistoryAppendInput = {
  display: string
  project?: string
  sessionId?: string
}

export const promptHistoryApi = {
  list(params: PromptHistoryListParams) {
    const query = new URLSearchParams()
    if (params.project) query.set('project', params.project)
    if (params.projectRoot) query.set('projectRoot', params.projectRoot)
    if (params.sessionId) query.set('sessionId', params.sessionId)
    if (params.limit !== undefined) query.set('limit', String(params.limit))
    if (params.sessionOnly) query.set('sessionOnly', '1')
    const suffix = query.toString()
    return api.get<{ entries: PromptHistoryItem[] }>(
      `/api/sessions/prompt-history${suffix ? `?${suffix}` : ''}`,
    )
  },

  append(body: PromptHistoryAppendInput) {
    return api.post<{ ok: boolean }>('/api/sessions/prompt-history', body)
  },
}
