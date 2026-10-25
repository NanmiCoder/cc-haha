import type { BackgroundAgentTask } from '../types/chat'
import type { TranslationKey } from '../i18n'

type Translator = (key: TranslationKey, params?: Record<string, string | number>) => string

/** A teammate runtime is the member container, not a user-facing activity row. */
export function isVisibleSessionBackgroundTask(
  task: Pick<BackgroundAgentTask, 'taskType'>,
): boolean {
  return task.taskType !== 'in_process_teammate'
}

function isBusyBackgroundTask(task: BackgroundAgentTask): boolean {
  // AutoDream is detached maintenance work: it remains visible and stoppable
  // in Activity, but must not keep the foreground conversation marked busy.
  return isVisibleSessionBackgroundTask(task) &&
    !task.ambient && !task.skipTranscript && task.isBackgrounded !== false && task.nativeStatus !== 'paused' &&
    task.status === 'running' &&
    task.taskType !== 'dream'
}

export function hasRunningBackgroundTasks(tasks?: Record<string, BackgroundAgentTask>): boolean {
  return Object.values(tasks ?? {}).some(isBusyBackgroundTask)
}

/**
 * The tasks `hasRunningBackgroundTasks` counted, for a caller that has been told
 * to stop them. Asking "is this session running?" and stopping it share one
 * definition so a confirmation can never offer a Stop that leaves running the
 * very task that raised it.
 */
export function listRunningBackgroundTasks(tasks?: Record<string, BackgroundAgentTask>): BackgroundAgentTask[] {
  return Object.values(tasks ?? {}).filter(isBusyBackgroundTask)
}

export function hasRunningSubagentTasks(tasks?: Record<string, BackgroundAgentTask>): boolean {
  return Object.values(tasks ?? {}).some(
    (task) => isVisibleSessionBackgroundTask(task) &&
      !task.ambient && !task.skipTranscript && task.isBackgrounded !== false && task.nativeStatus !== 'paused' &&
      task.status === 'running' &&
      (task.taskType === 'local_agent' || task.taskType === 'remote_agent'),
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
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) {
    return t('chat.duration.minutesSeconds', {
      minutes: totalMinutes,
      seconds: totalSeconds % 60,
    })
  }
  // Past an hour "125 min 3 s" makes the reader divide by 60 themselves. Seconds
  // stop being interesting at that scale, so they are dropped rather than kept.
  return t('chat.duration.hoursMinutes', {
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
  })
}

export function formatDurationMs(durationMs: number | undefined, t: Translator): string | null {
  if (typeof durationMs !== 'number' || durationMs < 0) return null
  return formatDurationSeconds(durationMs / 1000, t)
}
