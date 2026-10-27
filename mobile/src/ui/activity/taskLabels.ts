import { isAgent, taskElapsed, type BackgroundTask } from '../../core/operations'

export type TaskGlyph = 'running' | 'done' | 'stopped' | 'failed'

export function taskGlyph(status: BackgroundTask['status']): TaskGlyph {
  return status === 'completed' ? 'done' : status
}

export const taskTitle = (task: BackgroundTask) =>
  task.description?.trim() || task.taskId

/**
 * 行的第二行。电脑只给出开始时间，没有结束时间，所以只有运行中的任务带时长；
 * 已结束的任务不编造用时。后台命令的 summary/result 已经在输出预览里，
 * 第二行只放时长，避免同一段文字出现两次。
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
    return { text: text || '正在执行', mono: true, tone: 'muted' }
  }
  if (task.status === 'completed')
    return { text: ['完成', summary].filter(Boolean).join(' · '), mono: false, tone: 'muted' }
  if (task.status === 'stopped')
    return { text: '已停止', mono: false, tone: 'muted' }
  return { text: ['失败', summary].filter(Boolean).join(' · '), mono: false, tone: 'err' }
}

/** 运行中的后台命令在行下预览两行输出。 */
export function outputPreview(task: BackgroundTask): string[] {
  if (isAgent(task) || task.status !== 'running') return []
  return (task.result || task.summary || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .slice(0, 2)
}

/** 停止确认只针对仍在运行的任务。 */
export function stopTargets(selected: BackgroundTask[], current: BackgroundTask[]) {
  return selected.filter((task) =>
    current.some((item) => item.taskId === task.taskId && item.status === 'running')
  )
}
