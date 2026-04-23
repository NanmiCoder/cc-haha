import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cliTasksApi } from '../api/cliTasks'
import type { CLITask, TaskStatus } from '../types/cliTask'
import { useCLITaskStore } from './cliTaskStore'

vi.mock('../api/cliTasks', () => ({
  cliTasksApi: {
    getTasksForList: vi.fn(),
    resetTaskList: vi.fn(),
  },
}))

function makeTask(taskListId: string, status: TaskStatus = 'in_progress'): CLITask {
  return {
    id: '1',
    subject: 'Keep current session isolated',
    description: '',
    status,
    blocks: [],
    blockedBy: [],
    taskListId,
  }
}

describe('cliTaskStore', () => {
  beforeEach(() => {
    useCLITaskStore.getState().clearTasks()
    vi.clearAllMocks()
  })

  afterEach(() => {
    useCLITaskStore.getState().clearTasks()
  })

  it('clears stale tasks immediately when switching tracked sessions', async () => {
    let resolveRequest: ((value: { tasks: ReturnType<typeof makeTask>[] }) => void) | null = null

    vi.mocked(cliTasksApi.getTasksForList).mockImplementation(
      (sessionId: string) =>
        new Promise<{ tasks: ReturnType<typeof makeTask>[] }>((resolve) => {
          if (sessionId === 'session-2') resolveRequest = resolve
        }),
    )

    useCLITaskStore.setState({
      sessionId: 'session-1',
      tasks: [makeTask('session-1')],
      expanded: true,
      completedAndDismissed: true,
      dismissedCompletionKey: 'session-1::done',
    })

    const fetchPromise = useCLITaskStore.getState().fetchSessionTasks('session-2')

    expect(useCLITaskStore.getState()).toMatchObject({
      sessionId: 'session-2',
      tasks: [],
      expanded: false,
      completedAndDismissed: false,
      dismissedCompletionKey: null,
    })

    expect(resolveRequest).not.toBeNull()
    resolveRequest!({ tasks: [makeTask('session-2', 'completed')] })
    await fetchPromise

    expect(useCLITaskStore.getState().tasks).toMatchObject([
      { taskListId: 'session-2', status: 'completed' },
    ])
  })

  it('resets a completed task list locally before clearing it remotely', async () => {
    let resolveReset: ((value: { ok: true }) => void) | null = null

    vi.mocked(cliTasksApi.resetTaskList).mockImplementation(
      () => new Promise<{ ok: true }>((resolve) => {
        resolveReset = resolve
      }),
    )

    useCLITaskStore.setState({
      sessionId: 'session-1',
      tasks: [
        makeTask('session-1', 'completed'),
        { ...makeTask('session-1', 'completed'), id: '2', subject: 'Second completed task' },
      ],
      expanded: true,
      completedAndDismissed: true,
      dismissedCompletionKey: 'session-1::done',
    })

    const resetPromise = useCLITaskStore.getState().resetCompletedTasks()

    expect(vi.mocked(cliTasksApi.resetTaskList)).toHaveBeenCalledWith('session-1')
    expect(useCLITaskStore.getState()).toMatchObject({
      tasks: [],
      resetting: true,
      completedAndDismissed: false,
      dismissedCompletionKey: null,
      expanded: false,
    })

    expect(resolveReset).not.toBeNull()
    resolveReset!({ ok: true })
    await resetPromise

    expect(useCLITaskStore.getState().resetting).toBe(false)
  })
})
