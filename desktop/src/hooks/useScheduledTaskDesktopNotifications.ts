import { useEffect } from 'react'
import { tasksApi } from '../api/tasks'
import { notifyDesktop } from '../lib/desktopNotifications'
import type { CronTask, TaskRun } from '../types/task'

const POLL_INTERVAL_MS = 30_000
const NOTIFIED_RUNS_STORAGE_KEY = 'cc-haha.notifiedDesktopTaskRuns.v1'
const MAX_STORED_RUN_IDS = 200

function isTerminalRun(run: TaskRun): boolean {
  return run.status === 'completed' || run.status === 'failed' || run.status === 'timeout'
}

function hasDesktopNotification(task: CronTask | undefined): boolean {
  return !!task?.notification?.enabled && task.notification.channels.includes('desktop')
}

function readNotifiedRunIds(): Set<string> {
  try {
    const raw = localStorage.getItem(NOTIFIED_RUNS_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeNotifiedRunIds(runIds: Set<string>): void {
  try {
    const trimmed = [...runIds].slice(-MAX_STORED_RUN_IDS)
    localStorage.setItem(NOTIFIED_RUNS_STORAGE_KEY, JSON.stringify(trimmed))
  } catch {
    // Notification dedupe is best-effort; storage failures should not break the app.
  }
}

function formatTaskRunNotification(run: TaskRun): { title: string; body: string } {
  const status = run.status === 'completed'
    ? '完成'
    : run.status === 'failed'
      ? '失败'
      : '超时'
  const detail = run.error || run.output || run.prompt
  const body = detail
    ? `${status}: ${detail.slice(0, 160)}`
    : `状态: ${status}`

  return {
    title: `定时任务 ${run.taskName || run.taskId}`,
    body,
  }
}

export function collectDesktopNotifiableRuns(
  tasks: CronTask[],
  runs: TaskRun[],
  notifiedRunIds: Set<string>,
): TaskRun[] {
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  return runs
    .filter((run) => isTerminalRun(run))
    .filter((run) => hasDesktopNotification(taskById.get(run.taskId)))
    .filter((run) => !notifiedRunIds.has(run.id))
    .sort((a, b) => Date.parse(a.completedAt ?? a.startedAt) - Date.parse(b.completedAt ?? b.startedAt))
}

export function useScheduledTaskDesktopNotifications(): void {
  useEffect(() => {
    let stopped = false
    let initialized = false

    const poll = async () => {
      try {
        const [{ tasks }, { runs }] = await Promise.all([
          tasksApi.list(),
          tasksApi.getRecentRuns(50),
        ])
        if (stopped) return

        const notifiedRunIds = readNotifiedRunIds()
        const pendingRuns = collectDesktopNotifiableRuns(tasks, runs, notifiedRunIds)

        if (!initialized) {
          for (const run of pendingRuns) notifiedRunIds.add(run.id)
          writeNotifiedRunIds(notifiedRunIds)
          initialized = true
          return
        }

        for (const run of pendingRuns) {
          const notification = formatTaskRunNotification(run)
          const sent = await notifyDesktop({
            dedupeKey: `scheduled-task:${run.id}`,
            title: notification.title,
            body: notification.body,
            target: run.sessionId
              ? { type: 'session', sessionId: run.sessionId, title: run.taskName || run.taskId }
              : { type: 'scheduled' },
          })
          if (sent) notifiedRunIds.add(run.id)
        }
        writeNotifiedRunIds(notifiedRunIds)
      } catch (err) {
        if (typeof console !== 'undefined') {
          console.warn('[scheduledTaskNotifications] failed to poll task runs:', err)
        }
      }
    }

    void poll()
    const interval = window.setInterval(() => {
      void poll()
    }, POLL_INTERVAL_MS)

    return () => {
      stopped = true
      window.clearInterval(interval)
    }
  }, [])
}
