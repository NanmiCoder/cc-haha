import { describe, expect, it } from 'vitest'
import type { BackgroundAgentTask } from '../types/chat'
import { hasRunningBackgroundTasks } from './backgroundTasks'

function task(
  taskId: string,
  overrides: Partial<BackgroundAgentTask> = {},
): BackgroundAgentTask {
  return {
    taskId,
    status: 'running',
    startedAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('hasRunningBackgroundTasks', () => {
  it('does not treat AutoDream as foreground session activity', () => {
    expect(hasRunningBackgroundTasks({
      dream: task('dream', { taskType: 'dream' }),
    })).toBe(false)
  })

  it('still reports user-started background tasks as running', () => {
    expect(hasRunningBackgroundTasks({
      shell: task('shell', { taskType: 'local_bash' }),
      dream: task('dream', { taskType: 'dream' }),
    })).toBe(true)
  })
})
