import type { BackgroundAgentTask } from '../types/chat'
import type { TranslationKey } from '../i18n'

type Translator = (key: TranslationKey, params?: Record<string, string | number>) => string

export function hasRunningBackgroundTasks(tasks?: Record<string, BackgroundAgentTask>): boolean {
  // AutoDream is detached maintenance work: it remains visible and stoppable
  // in Activity, but must not keep the foreground conversation marked busy.
  return Object.values(tasks ?? {}).some(
    (task) => task.status === 'running' && task.taskType !== 'dream',
  )
}

export function createBackgroundTaskDismissKey(task: BackgroundAgentTask): string {
  return `${task.taskId}:${task.status}:${task.startedAt}`
}

export function formatDurationSeconds(
  seconds: number,
  t: Translator,
  minimumSeconds = 0,
): string {
  const totalSeconds = Math.max(minimumSeconds, Math.round(seconds))
  if (totalSeconds < 60) {
    return t('chat.duration.seconds', { seconds: totalSeconds })
  }
  const minutes = Math.floor(totalSeconds / 60)
  const remainingSeconds = totalSeconds % 60
  return t('chat.duration.minutesSeconds', { minutes, seconds: remainingSeconds })
}

export function formatDurationMs(durationMs: number | undefined, t: Translator): string | null {
  if (typeof durationMs !== 'number' || durationMs < 0) return null
  return formatDurationSeconds(durationMs / 1000, t)
}
