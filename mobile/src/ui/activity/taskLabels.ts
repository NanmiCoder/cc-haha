import { isAgent, taskElapsed, type BackgroundTask } from '../../core/operations'

export type TaskGlyph = 'running' | 'done' | 'stopped' | 'failed'

export function taskGlyph(status: BackgroundTask['status']): TaskGlyph {
  return status === 'completed' ? 'done' : status
}

export const taskTitle = (task: BackgroundTask) =>
  task.description?.trim() || task.taskId

/**
 * second line of the row. The computer only gives a start time, no end time, so only running tasks have a duration; 
 * finished tasks do not make up a duration. A background command's summary/result is already in the output preview, 
 * so the second line holds only the duration, avoiding the same text twice.
 */
export function taskSubline(
  task: BackgroundTask,
  now = Date.now()
): { text: string; mono: boolean; tone: 'muted' | 'err' } {
  const summary = task.summary?.trim()
  if (task.status === 'running') {
    const elapsed = taskElapsed(task, now)
    const parts = isAgent(task) ? [summary, elapsed] : [elapsed]
    const text = parts.filter(Boolean).join(' · ')
    return { text: text || 'Running', mono: true, tone: 'muted' }
  }
  if (task.status === 'completed')
    return { text: ['Done', summary].filter(Boolean).join(' · '), mono: false, tone: 'muted' }
  if (task.status === 'stopped')
    return { text: 'Stopped', mono: false, tone: 'muted' }
  return { text: ['Failed', summary].filter(Boolean).join(' · '), mono: false, tone: 'err' }
}

/** Running background commands preview two lines of output under the row. */
export function outputPreview(task: BackgroundTask): string[] {
  if (isAgent(task) || task.status !== 'running') return []
  return (task.result || task.summary || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .slice(0, 2)
}

/** Stop confirmation only targets tasks still running. */
export function stopTargets(selected: BackgroundTask[], current: BackgroundTask[]) {
  return selected.filter((task) =>
    current.some((item) => item.taskId === task.taskId && item.status === 'running')
  )
}
