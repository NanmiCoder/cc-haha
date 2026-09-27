import { api } from './client'
import type { CronTask, CreateTaskInput, TaskRun } from '../types/task'

type TasksResponse = { tasks: CronTask[] }
type TaskResponse = { task: CronTask }
type RunsResponse = {
  runs: TaskRun[]
  nextCursor?: string
  revision?: number
  revisionToken?: string
  reset?: boolean
}
type RunsOptions = {
  limit?: number
  cursor?: string
  summaryOnly?: boolean
  nonterminalOnly?: boolean
  completedAfterMs?: number
}

function runsQuery(options: RunsOptions): string {
  const params = new URLSearchParams()
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  if (options.cursor) params.set('cursor', options.cursor)
  if (options.summaryOnly) params.set('summaryOnly', 'true')
  if (options.nonterminalOnly) params.set('nonterminalOnly', 'true')
  if (options.completedAfterMs !== undefined) {
    params.set('completedAfterMs', String(options.completedAfterMs))
  }
  const query = params.toString()
  return query ? `?${query}` : ''
}

export const tasksApi = {
  list() {
    return api.get<TasksResponse>('/api/scheduled-tasks', { timeout: 15_000 })
  },

  create(input: CreateTaskInput) {
    return api.post<TaskResponse>('/api/scheduled-tasks', input)
  },

  update(id: string, updates: Partial<CronTask>) {
    return api.put<TaskResponse>(`/api/scheduled-tasks/${id}`, updates)
  },

  delete(id: string) {
    return api.delete<{ ok: true }>(`/api/scheduled-tasks/${id}`)
  },

  runTask(id: string) {
    return api.post<{ ok: true }>(`/api/scheduled-tasks/${id}/run`, {})
  },

  getRecentRuns(limit = 50, options: Omit<RunsOptions, 'limit'> = {}) {
    return api.get<RunsResponse>(`/api/scheduled-tasks/runs${runsQuery({ ...options, limit })}`)
  },

  getTaskRuns(taskId: string, options: RunsOptions = {}) {
    return api.get<RunsResponse>(`/api/scheduled-tasks/${taskId}/runs${runsQuery(options)}`)
  },

  getRunDetail(runId: string, options?: { signal?: AbortSignal }) {
    return api.get<{ run: TaskRun }>(`/api/scheduled-tasks/runs/${runId}`, options)
  },
}
