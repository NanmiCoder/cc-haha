import type { ScheduledTaskResult } from '@/lib/scheduledTask'
import { create } from 'zustand'
import { tasksApi } from '../api/tasks'
import type { CronTask, CreateTaskInput, TaskRun } from '../types/task'

type TaskStore = {
  tasks: CronTask[]
  recentRuns: TaskRun[]
  loaded: boolean
  mutationVersion: number
  requestVersion: number
  editorTaskId: string | null
  openTaskEditor: (id: string) => void
  closeTaskEditor: () => void
  applyToolResult: (result: ScheduledTaskResult) => void
  isLoading: boolean
  error: string | null

  fetchTasks: () => Promise<void>
  createTask: (input: CreateTaskInput) => Promise<void>
  updateTask: (id: string, updates: Partial<CronTask>) => Promise<void>
  deleteTask: (id: string) => Promise<void>
  runTask: (taskId: string) => Promise<void>
  fetchRecentRuns: () => Promise<void>
  fetchTaskRuns: (taskId: string, options?: {
    limit?: number
    summaryOnly?: boolean
    nonterminalOnly?: boolean
  }) => Promise<TaskRun[]>
  fetchTaskRunDetail: (runId: string, options?: { signal?: AbortSignal }) => Promise<TaskRun>
}

export const useTaskStore = create<TaskStore>((set, get) => ({
  tasks: [],
  recentRuns: [],
  loaded: false,
  mutationVersion: 0,
  requestVersion: 0,
  editorTaskId: null,
  openTaskEditor: (id) => set({ editorTaskId: id }),
  closeTaskEditor: () => set({ editorTaskId: null }),
  applyToolResult: (result) => set(state => ({
    mutationVersion: state.mutationVersion + 1,
    tasks: result.operation === 'deleted'
      ? state.tasks.filter(task => task.id !== result.taskId)
      : [...state.tasks.filter(task => task.id !== result.taskId), result.task],
  })),
  isLoading: false,
  error: null,

  fetchTasks: async () => {
    const mutationVersion = get().mutationVersion
    const requestVersion = get().requestVersion + 1
    set({ isLoading: true, error: null, requestVersion })
    try {
      const { tasks } = await tasksApi.list()
      if (!Array.isArray(tasks)) throw new Error('Invalid scheduled task response')
      if (get().requestVersion !== requestVersion) return
      if (get().mutationVersion !== mutationVersion) {
        set({ isLoading: false })
        return get().fetchTasks()
      }
      set({ tasks, loaded: true, isLoading: false })
    } catch (err) {
      if (get().requestVersion === requestVersion) set({ error: (err as Error).message, isLoading: false })
    }
  },

  createTask: async (input) => {
    const { task } = await tasksApi.create(input)
    set((s) => ({ tasks: [...s.tasks.filter(t => t.id !== task.id), task], mutationVersion: s.mutationVersion + 1 }))
  },

  updateTask: async (id, updates) => {
    const { task } = await tasksApi.update(id, updates)
    set((s) => ({ tasks: s.tasks.some(t => t.id === id) ? s.tasks.map(t => t.id === id ? task : t) : [...s.tasks, task], mutationVersion: s.mutationVersion + 1 }))
  },

  deleteTask: async (id) => {
    await tasksApi.delete(id)
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id), mutationVersion: s.mutationVersion + 1 }))
  },

  runTask: async (taskId) => {
    await tasksApi.runTask(taskId)
  },

  fetchRecentRuns: async () => {
    try {
      const { runs } = await tasksApi.getRecentRuns()
      set({ recentRuns: runs })
    } catch {
      // ignore
    }
  },

  fetchTaskRuns: async (taskId, options) => {
    const { runs } = await tasksApi.getTaskRuns(taskId, options)
    return runs
  },

  fetchTaskRunDetail: async (runId, options) => {
    const { run } = await tasksApi.getRunDetail(runId, options)
    return run
  },
}))
