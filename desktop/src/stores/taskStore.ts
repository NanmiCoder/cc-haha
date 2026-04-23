import { create } from 'zustand'
import { tasksApi } from '../api/tasks'
import type { CronTask, CreateTaskInput, TaskRun } from '../types/task'

type TaskStore = {
  tasks: CronTask[]
  recentRuns: TaskRun[]
  isLoading: boolean
  error: string | null

  fetchTasks: () => Promise<void>
  createTask: (input: CreateTaskInput) => Promise<void>
  updateTask: (id: string, updates: Partial<CronTask>) => Promise<void>
  deleteTask: (id: string) => Promise<void>
  runTask: (taskId: string) => Promise<void>
  fetchRecentRuns: () => Promise<void>
  fetchTaskRuns: (taskId: string) => Promise<TaskRun[]>
}

export const useTaskStore = create<TaskStore>((set) => ({
  tasks: [],
  recentRuns: [],
  isLoading: false,
  error: null,

  fetchTasks: async () => {
    set({ isLoading: true, error: null })
    try {
      const { tasks } = await tasksApi.list()
      set({ tasks, isLoading: false })
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false })
    }
  },

  createTask: async (input) => {
    const { task } = await tasksApi.create(input)
    set((s) => ({ tasks: [...s.tasks, task] }))
  },

  updateTask: async (id, updates) => {
    const { task } = await tasksApi.update(id, updates)
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? task : t)) }))
  },

  deleteTask: async (id) => {
    await tasksApi.delete(id)
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }))
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

  fetchTaskRuns: async (taskId) => {
    const { runs } = await tasksApi.getTaskRuns(taskId)
    return runs
  },
}))
