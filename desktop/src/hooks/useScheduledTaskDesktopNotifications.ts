import { useEffect } from 'react'
import { tasksApi } from '../api/tasks'
import { notifyDesktop } from '../lib/desktopNotifications'
import { whenDesktopServerReady } from '../lib/desktopRuntime'
import { t } from '../i18n'
import type { CronTask, TaskRun } from '../types/task'

const POLL_INTERVAL_MS = 30_000
const NOTIFIED_RUNS_STORAGE_KEY = 'cc-haha.notifiedDesktopTaskRuns.v1'
const NOTIFICATION_SCAN_STORAGE_KEY = 'cc-haha.scheduledTaskNotificationScan.v1'
const MAX_STORED_RUN_IDS = 200
const NOTIFICATION_PAGE_SIZE = 50

type NotificationBoundary = {
  runId: string
  startedAtMs: number
  terminal: boolean
}

type NotificationScanState = {
  initializedAtMs: number
  initializationPending?: boolean
  revisionToken?: string
  continueBoundaryTies?: boolean
  boundary?: NotificationBoundary
  cursor?: string
  scanHead?: NotificationBoundary
  scanLowWater?: NotificationBoundary
}

function isTerminalRun(run: TaskRun): boolean {
  return run.status === 'completed' || run.status === 'failed' ||
    run.status === 'timeout' || run.status === 'missed'
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

function isBoundary(value: unknown): value is NotificationBoundary {
  if (!value || typeof value !== 'object') return false
  const boundary = value as Partial<NotificationBoundary>
  return typeof boundary.runId === 'string' &&
    boundary.runId.length > 0 &&
    typeof boundary.startedAtMs === 'number' &&
    Number.isFinite(boundary.startedAtMs) &&
    typeof boundary.terminal === 'boolean'
}

function readNotificationScanState(): NotificationScanState | null {
  try {
    const raw = localStorage.getItem(NOTIFICATION_SCAN_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<NotificationScanState>
    if (
      typeof parsed.initializedAtMs !== 'number' ||
      !Number.isFinite(parsed.initializedAtMs) ||
      (parsed.initializationPending !== undefined && typeof parsed.initializationPending !== 'boolean') ||
      (parsed.boundary !== undefined && !isBoundary(parsed.boundary)) ||
      (parsed.scanHead !== undefined && !isBoundary(parsed.scanHead)) ||
      (parsed.scanLowWater !== undefined && !isBoundary(parsed.scanLowWater)) ||
      (parsed.cursor !== undefined && typeof parsed.cursor !== 'string') ||
      (parsed.revisionToken !== undefined && typeof parsed.revisionToken !== 'string') ||
      (parsed.continueBoundaryTies !== undefined && typeof parsed.continueBoundaryTies !== 'boolean')
    ) return null
    return {
      initializedAtMs: parsed.initializedAtMs,
      ...(parsed.initializationPending ? { initializationPending: true } : {}),
      ...(parsed.revisionToken ? { revisionToken: parsed.revisionToken } : {}),
      ...(parsed.continueBoundaryTies ? { continueBoundaryTies: true } : {}),
      ...(parsed.boundary ? { boundary: parsed.boundary } : {}),
      ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
      ...(parsed.scanHead ? { scanHead: parsed.scanHead } : {}),
      ...(parsed.scanLowWater ? { scanLowWater: parsed.scanLowWater } : {}),
    }
  } catch {
    return null
  }
}

function writeNotificationScanState(state: NotificationScanState): void {
  try {
    localStorage.setItem(NOTIFICATION_SCAN_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Catch-up progress is best-effort; delivered IDs remain the final dedupe guard.
  }
}

function runStartedAtMs(run: TaskRun): number {
  const parsed = Date.parse(run.startedAt)
  return Number.isFinite(parsed) ? parsed : 0
}

function boundaryFromRun(run: TaskRun | undefined): NotificationBoundary | undefined {
  return run
    ? {
        runId: run.id,
        startedAtMs: runStartedAtMs(run),
        terminal: isTerminalRun(run),
      }
    : undefined
}

function oldestNonTerminalBoundary(
  desktopTasks: CronTask[],
  runs: TaskRun[],
): NotificationBoundary | undefined {
  const taskIds = new Set(desktopTasks.map(task => task.id))
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]
    if (run && taskIds.has(run.taskId) && !isTerminalRun(run)) {
      return boundaryFromRun(run)
    }
  }
  return undefined
}

function runsBeforeBoundary(
  runs: TaskRun[],
  boundary: NotificationBoundary | undefined,
  initializedAtMs: number,
  continueBoundaryTies = false,
): { candidates: TaskRun[]; reachedBoundary: boolean } {
  const candidates: TaskRun[] = []
  const oldestRelevantStartedAt = boundary && !boundary.terminal
    ? Math.min(initializedAtMs, boundary.startedAtMs)
    : initializedAtMs
  let boundaryTieTimestamp: number | null = null
  for (const run of runs) {
    const startedAtMs = runStartedAtMs(run)
    if (boundaryTieTimestamp !== null && startedAtMs < boundaryTieTimestamp) {
      return { candidates, reachedBoundary: true }
    }
    if (boundary && run.id === boundary.runId) {
      if (!boundary.terminal) candidates.push(run)
      if (continueBoundaryTies) {
        boundaryTieTimestamp = boundary.startedAtMs
        continue
      }
      return { candidates, reachedBoundary: true }
    }
    if (startedAtMs < oldestRelevantStartedAt) {
      return { candidates, reachedBoundary: true }
    }
    if (boundary && startedAtMs < boundary.startedAtMs) {
      return { candidates, reachedBoundary: true }
    }
    candidates.push(run)
  }
  return { candidates, reachedBoundary: false }
}

function completedAfterInitialization(run: TaskRun, initializedAtMs: number): boolean {
  const completedAtMs = Date.parse(run.completedAt ?? run.startedAt)
  return Number.isFinite(completedAtMs) && completedAtMs >= initializedAtMs
}

function formatTaskRunNotification(run: TaskRun): { title: string; body: string } {
  // A missed one-shot reservation is not a run outcome — the server never
  // spawned it. Surface dedicated, translated copy telling the user it can be
  // run now or rescheduled rather than reusing the completed/failed wording.
  if (run.status === 'missed') {
    return {
      title: t('scheduledTask.missedNotificationTitle', { name: run.taskName || run.taskId }),
      body: t('scheduledTask.missedNotificationBody'),
    }
  }

  const status = run.status === 'completed'
    ? '完成'
    : run.status === 'failed'
      ? '失败'
      : '超时'
  const detail = [run.error, run.errorPreview, run.output, run.outputPreview, run.prompt]
    .find(value => typeof value === 'string' && value.length > 0)
  const body = detail
    ? `${status}: ${detail.slice(0, 160)}`
    : `状态: ${status}`

  return {
    title: `定时任务 ${run.taskName || run.taskId}`,
    body,
  }
}

async function deliverTaskRunNotification(run: TaskRun): Promise<boolean> {
  const notification = formatTaskRunNotification(run)
  return notifyDesktop({
    dedupeKey: `scheduled-task:${run.id}`,
    title: notification.title,
    body: notification.body,
    target: run.sessionId
      ? { type: 'session', sessionId: run.sessionId, title: run.taskName || run.taskId }
      : { type: 'scheduled' },
  })
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
    .map((run) => {
      const taskName = taskById.get(run.taskId)?.name
      return taskName ? { ...run, taskName } : run
    })
    .sort((a, b) => Date.parse(a.completedAt ?? a.startedAt) - Date.parse(b.completedAt ?? b.startedAt))
}

export function useScheduledTaskDesktopNotifications(): void {
  useEffect(() => {
    let stopped = false
    let interval: number | undefined
    let pollInFlight = false

    const ensureNotificationScanInitialized = (): NotificationScanState => {
      let scanState = readNotificationScanState()
      if (!scanState) {
        scanState = { initializedAtMs: Date.now(), initializationPending: true }
        // Establish the completion floor before any request can stall. Server
        // readiness, the task list, and run history may each take long enough
        // for a run to finish while this hook is awaiting them.
        writeNotificationScanState(scanState)
      }
      return scanState
    }

    const poll = async () => {
      if (stopped || pollInFlight) return
      pollInFlight = true
      try {
        const scanState = ensureNotificationScanInitialized()

        const { tasks } = await tasksApi.list()
        if (stopped) return

        const desktopTasks = tasks.filter(hasDesktopNotification)
        if (desktopTasks.length === 0) {
          return
        }

        const initializing = scanState.initializationPending === true
        const requestedCursor = scanState.cursor
        const response = await tasksApi.getRecentRuns(NOTIFICATION_PAGE_SIZE, {
          ...(requestedCursor ? { cursor: requestedCursor } : {}),
          summaryOnly: true,
          ...(initializing ? { completedAfterMs: scanState.initializedAtMs } : {}),
        })
        const { runs, nextCursor, revisionToken, reset = false } = response
        if (stopped) return

        const pageRuns = runs.slice(0, NOTIFICATION_PAGE_SIZE)
        if (initializing) {
          const nonterminalResponse = await tasksApi.getRecentRuns(2_147_483_647, {
            summaryOnly: true,
            nonterminalOnly: true,
          })
          if (stopped) return
          if (
            revisionToken &&
            nonterminalResponse.revisionToken &&
            revisionToken !== nonterminalResponse.revisionToken
          ) {
            // A run may finish between the completion-floor and non-terminal
            // snapshots. Restart from the completion head instead of advancing
            // a mixed-revision frontier that could permanently miss it.
            writeNotificationScanState({
              initializedAtMs: scanState.initializedAtMs,
              initializationPending: true,
            })
            return
          }
          const nonterminalRuns = nonterminalResponse.runs
          const nonterminalBoundary = oldestNonTerminalBoundary(desktopTasks, nonterminalRuns)
          const notifiedRunIds = readNotifiedRunIds()
          const failedRuns: TaskRun[] = []
          const pendingRuns = collectDesktopNotifiableRuns(
            desktopTasks,
            pageRuns.filter(run => completedAfterInitialization(
              run,
              scanState.initializedAtMs,
            )),
            notifiedRunIds,
          )
          for (const run of pendingRuns) {
            if (await deliverTaskRunNotification(run)) notifiedRunIds.add(run.id)
            else failedRuns.push(run)
          }
          writeNotifiedRunIds(notifiedRunIds)

          const resetProgress = reset && requestedCursor !== undefined
          const scanHead = resetProgress
            ? boundaryFromRun(pageRuns[0])
            : scanState.scanHead ?? boundaryFromRun(pageRuns[0])
          const scanLowWater = nonterminalBoundary ??
            (resetProgress ? undefined : scanState.scanLowWater)
          if (failedRuns.length > 0) {
            writeNotificationScanState({
              initializedAtMs: scanState.initializedAtMs,
              initializationPending: true,
              ...(revisionToken ? { revisionToken } : {}),
              ...(scanHead ? { scanHead } : {}),
              ...(scanLowWater ? { scanLowWater } : {}),
              ...(!resetProgress && requestedCursor ? { cursor: requestedCursor } : {}),
            })
          } else if (nextCursor) {
            writeNotificationScanState({
              initializedAtMs: scanState.initializedAtMs,
              initializationPending: true,
              ...(revisionToken ? { revisionToken } : {}),
              ...(scanHead ? { scanHead } : {}),
              ...(scanLowWater ? { scanLowWater } : {}),
              cursor: nextCursor,
            })
          } else {
            const boundary = scanLowWater ?? scanHead ?? boundaryFromRun(pageRuns[0])
            writeNotificationScanState({
              initializedAtMs: scanState.initializedAtMs,
              ...(revisionToken ? { revisionToken } : {}),
              ...(boundary ? { boundary } : {}),
            })
          }
          return
        }

        const notifiedRunIds = readNotifiedRunIds()
        const previousBoundary = scanState.boundary
        const revisionChanged = !!revisionToken &&
          !!scanState.revisionToken &&
          revisionToken !== scanState.revisionToken
        const continueBoundaryTies = scanState.continueBoundaryTies === true ||
          revisionChanged ||
          reset
        const page = runsBeforeBoundary(
          pageRuns,
          previousBoundary,
          scanState.initializedAtMs,
          continueBoundaryTies,
        )
        const resetProgress = reset && requestedCursor !== undefined
        const scanHead = resetProgress
          ? boundaryFromRun(pageRuns[0])
          : scanState.scanHead ?? boundaryFromRun(pageRuns[0])
        const pageLowWater = oldestNonTerminalBoundary(desktopTasks, page.candidates)
        const scanLowWater = pageLowWater ??
          (resetProgress ? undefined : scanState.scanLowWater)
        const pendingRuns = collectDesktopNotifiableRuns(
          desktopTasks,
          page.candidates.filter(run => completedAfterInitialization(
            run,
            scanState.initializedAtMs,
          )),
          notifiedRunIds,
        )

        let deliveryFailed = false
        for (const run of pendingRuns) {
          const sent = await deliverTaskRunNotification(run)
          if (sent) notifiedRunIds.add(run.id)
          else deliveryFailed = true
        }
        writeNotifiedRunIds(notifiedRunIds)

        if (deliveryFailed) {
          writeNotificationScanState({
            initializedAtMs: scanState.initializedAtMs,
            ...(revisionToken ? { revisionToken } : {}),
            ...(continueBoundaryTies ? { continueBoundaryTies: true } : {}),
            ...(previousBoundary ? { boundary: previousBoundary } : {}),
            ...(scanHead ? { scanHead } : {}),
            ...(scanLowWater ? { scanLowWater } : {}),
            ...(!resetProgress && requestedCursor ? { cursor: requestedCursor } : {}),
          })
          return
        }

        if (page.reachedBoundary || !nextCursor) {
          writeNotificationScanState({
            initializedAtMs: scanState.initializedAtMs,
            ...(revisionToken ? { revisionToken } : {}),
            ...(scanLowWater || scanHead || previousBoundary
              ? { boundary: scanLowWater ?? scanHead ?? previousBoundary }
              : {}),
          })
        } else {
          writeNotificationScanState({
            initializedAtMs: scanState.initializedAtMs,
            ...(revisionToken ? { revisionToken } : {}),
            ...(continueBoundaryTies ? { continueBoundaryTies: true } : {}),
            ...(previousBoundary ? { boundary: previousBoundary } : {}),
            ...(scanHead ? { scanHead } : {}),
            ...(scanLowWater ? { scanLowWater } : {}),
            cursor: nextCursor,
          })
        }
      } catch (err) {
        if (typeof console !== 'undefined') {
          console.warn('[scheduledTaskNotifications] failed to poll task runs:', err)
        }
      } finally {
        pollInFlight = false
      }
    }

    ensureNotificationScanInitialized()
    // Wait for the local server URL to be resolved and healthy before polling.
    // Firing immediately on mount would race the desktop bootstrap and hit an
    // uninitialized base URL, producing benign "Failed to fetch" warnings.
    void whenDesktopServerReady().then(() => {
      if (stopped) return
      void poll()
      interval = window.setInterval(() => {
        void poll()
      }, POLL_INTERVAL_MS)
    })

    return () => {
      stopped = true
      if (interval !== undefined) window.clearInterval(interval)
    }
  }, [])
}
