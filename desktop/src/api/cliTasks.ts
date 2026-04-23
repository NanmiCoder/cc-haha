import { api } from './client'
import type { CLITask, TaskListSummary } from '../types/cliTask'

type TaskListsResponse = { lists: TaskListSummary[] }
type TasksResponse = { tasks: CLITask[] }
type TaskResponse = { task: CLITask }

export const cliTasksApi = {
  /** List all task lists with summaries */
  listTaskLists() {
    return api.get<TaskListsResponse>('/api/tasks/lists')
  },

  /** Get all tasks for a specific task list */
  getTasksForList(taskListId: string) {
    return api.get<TasksResponse>(`/api/tasks/lists/${encodeURIComponent(taskListId)}`)
  },

  /** Get a single task */
  getTask(taskListId: string, taskId: string) {
    return api.get<TaskResponse>(`/api/tasks/lists/${encodeURIComponent(taskListId)}/${taskId}`)
  },

  /** Clear all persisted tasks for a completed task list */
  resetTaskList(taskListId: string) {
    return api.post<{ ok: true }>(`/api/tasks/lists/${encodeURIComponent(taskListId)}/reset`)
  },

  /** List all tasks across all task lists */
  listAll() {
    return api.get<TasksResponse>('/api/tasks')
  },
}
