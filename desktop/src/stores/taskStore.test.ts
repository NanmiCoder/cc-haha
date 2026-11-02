import { afterEach, expect, it, vi } from 'vitest'
import { useTaskStore } from './taskStore'
import { tasksApi } from '@/api/tasks'
import type { CronTask } from '@/types/task'

const task: CronTask = { id: 'task', name: 'Check', prompt: 'Check', cron: '0 9 * * *', enabled: true, createdAt: 1 }
afterEach(() => { vi.restoreAllMocks(); useTaskStore.setState(useTaskStore.getInitialState(), true) })

it('does not resurrect a deleted task from a request started before deletion', async () => {
  let resolve!: (value: { tasks: CronTask[] }) => void
  vi.spyOn(tasksApi, 'list').mockImplementationOnce(() => new Promise(r => { resolve = r })).mockResolvedValue({ tasks: [] })
  vi.spyOn(tasksApi, 'delete').mockResolvedValue({ ok: true })
  useTaskStore.setState({ tasks: [task], loaded: true })
  const fetch = useTaskStore.getState().fetchTasks()
  await useTaskStore.getState().deleteTask(task.id)
  resolve({ tasks: [task] })
  await fetch
  expect(useTaskStore.getState().tasks).toEqual([])
  expect(useTaskStore.getState().loaded).toBe(true)
})

it('keeps stale tasks on failure and does not interpret a failed initial load as empty', async () => {
  vi.spyOn(tasksApi, 'list').mockRejectedValue(new Error('offline'))
  useTaskStore.setState({ tasks: [task] })
  await useTaskStore.getState().fetchTasks()
  expect(useTaskStore.getState()).toMatchObject({ loaded: false, tasks: [task], error: 'offline', isLoading: false })
})

it('ignores an older list response after a newer response completes', async () => {
  let resolve!: (value: { tasks: CronTask[] }) => void
  vi.spyOn(tasksApi, 'list').mockImplementationOnce(() => new Promise(r => { resolve = r })).mockResolvedValue({ tasks: [] })
  const first = useTaskStore.getState().fetchTasks()
  await useTaskStore.getState().fetchTasks()
  resolve({ tasks: [task] })
  await first
  expect(useTaskStore.getState().tasks).toEqual([])
})
