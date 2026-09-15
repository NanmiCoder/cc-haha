import { useCallback, useEffect, useRef, useState } from 'react'
import { useTaskStore } from '../../stores/taskStore'
import { useChatStore } from '../../stores/chatStore'
import { useTabStore } from '../../stores/tabStore'
import { useTranslation } from '../../i18n'
import { parseRunOutput } from '../../lib/parseRunOutput'
import type { TaskRun } from '../../types/task'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { IconButton } from '@/components/ui/IconButton'
import { LoadingState } from '@/components/ui/LoadingState'

function RunOutput({ run }: { run: TaskRun }) {
  const t = useTranslation()

  // Show error prominently if present. The `/20` + `/28` alpha fills this used
  // are exactly what Safari 15 WebView refuses to parse, so on the desktop
  // shell the box rendered as bare red text with no panel around it.
  if (run.error) {
    return (
      <ErrorState
        size="sm"
        className="mt-3"
        title={t('common.error')}
        detail={
          <span className="block max-h-40 overflow-y-auto whitespace-pre-wrap break-words">{run.error}</span>
        }
      />
    )
  }

  const text = parseRunOutput(run.output || '')

  if (!text) {
    return (
      <Card radius="lg" padding="none" className="mt-3 px-[18px] py-3 text-xs italic text-[var(--color-text-tertiary)]">
        {run.sessionId ? t('tasks.outputHintSession') : t('tasks.noOutputText')}
      </Card>
    )
  }

  // The handoff's "summary card": a bordered sheet on the page ground rather
  // than a tinted inset, so the commit hashes inside it read as badges against
  // a surface instead of two greys stacked on each other.
  return (
    <Card radius="lg" padding="none" className="mt-3 max-h-48 overflow-y-auto px-[22px] py-[18px]">
      <MarkdownRenderer
        content={text}
        variant="compact"
        className="break-words"
      />
    </Card>
  )
}

type Props = {
  taskId: string
  onClose: () => void
  refreshKey?: number
}

const STATUS_CONFIG: Record<string, { icon: string; color: string }> = {
  running:   { icon: 'sync',         color: 'var(--color-warning)' },
  completed: { icon: 'check_circle', color: 'var(--color-success)' },
  failed:    { icon: 'error',        color: 'var(--color-error)' },
  timeout:   { icon: 'timer_off',    color: 'var(--color-error)' },
  missed:    { icon: 'event_busy',   color: 'var(--color-warning)' },
}

export function TaskRunsPanel({ taskId, onClose, refreshKey }: Props) {
  const t = useTranslation()
  const { fetchTaskRuns, fetchTaskRunDetail } = useTaskStore()
  const connectToSession = useChatStore((s) => s.connectToSession)
  const openTab = useTabStore((s) => s.openTab)
  const [runs, setRuns] = useState<TaskRun[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [detailState, setDetailState] = useState<{
    runId: string
    status: 'loading' | 'error'
  } | null>(null)
  const requestGeneration = useRef(0)
  const detailGeneration = useRef(0)
  const selectedRunId = useRef<string | null>(null)
  const currentTaskId = useRef(taskId)
  const mounted = useRef(true)
  const detailAbortController = useRef<AbortController | null>(null)

  const openSession = (sessionId: string, taskName?: string) => {
    openTab(sessionId, taskName || 'Task Run')
    connectToSession(sessionId)
  }

  const cancelDetailRequest = useCallback(() => {
    detailAbortController.current?.abort()
    detailAbortController.current = null
  }, [])

  const refresh = useCallback(() => {
    const generation = ++requestGeneration.current
    fetchTaskRuns(taskId, { limit: 100, summaryOnly: true }).then((r) => {
      if (generation !== requestGeneration.current) return
      setRuns((current) => {
        const previousById = new Map(current.map(run => [run.id, run]))
        return r.map((run) => {
          const previous = previousById.get(run.id)
          return {
            ...run,
            ...(run.output === undefined && previous?.output !== undefined
              ? { output: previous.output }
              : {}),
            ...(run.error === undefined && previous?.error !== undefined
              ? { error: previous.error }
              : {}),
          }
        })
      })
      const selectedId = selectedRunId.current
      if (selectedId && r.some(run =>
        run.id === selectedId && (!!run.output || !!run.error),
      )) {
        cancelDetailRequest()
        detailGeneration.current += 1
        setDetailState(null)
      }
      setLoading(false)
    }).catch(() => {
      if (generation === requestGeneration.current) setLoading(false)
    })
  }, [cancelDetailRequest, fetchTaskRuns, taskId])

  const loadDetail = async (run: TaskRun) => {
    cancelDetailRequest()
    const controller = new AbortController()
    detailAbortController.current = controller
    const requestedTaskId = taskId
    const requestedDetailGeneration = detailGeneration.current + 1
    detailGeneration.current = requestedDetailGeneration
    selectedRunId.current = run.id
    setDetailState({ runId: run.id, status: 'loading' })
    try {
      const detail = await fetchTaskRunDetail(run.id, { signal: controller.signal })
      if (
        controller.signal.aborted ||
        !mounted.current ||
        currentTaskId.current !== requestedTaskId ||
        detailGeneration.current !== requestedDetailGeneration ||
        selectedRunId.current !== run.id
      ) return
      setRuns((current) => current.map((item) => {
        if (item.id !== detail.id || item.taskId !== requestedTaskId) return item
        if (item.output || item.error) return item
        return detail
      }))
      setDetailState(null)
    } catch {
      if (
        !controller.signal.aborted &&
        mounted.current &&
        currentTaskId.current === requestedTaskId &&
        detailGeneration.current === requestedDetailGeneration &&
        selectedRunId.current === run.id
      ) {
        setDetailState({ runId: run.id, status: 'error' })
      }
    } finally {
      if (detailAbortController.current === controller) {
        detailAbortController.current = null
      }
    }
  }

  const toggleOutput = (run: TaskRun) => {
    if (expandedId === run.id) {
      cancelDetailRequest()
      selectedRunId.current = null
      detailGeneration.current += 1
      setDetailState(null)
      setExpandedId(null)
      return
    }
    cancelDetailRequest()
    selectedRunId.current = run.id
    setDetailState(null)
    setExpandedId(run.id)
    if (!run.output && !run.error && (run.hasOutput || run.hasError)) {
      void loadDetail(run)
    }
  }

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      cancelDetailRequest()
      selectedRunId.current = null
      detailGeneration.current += 1
    }
  }, [cancelDetailRequest])

  useEffect(() => {
    cancelDetailRequest()
    currentTaskId.current = taskId
    selectedRunId.current = null
    detailGeneration.current += 1
    setDetailState(null)
    setExpandedId(null)
  }, [cancelDetailRequest, taskId])

  // Initial fetch + re-fetch when refreshKey changes
  useEffect(() => {
    setLoading(true)
    refresh()
    return () => { requestGeneration.current += 1 }
  }, [refresh, refreshKey])

  // Auto-poll while any run is "running" or shortly after a manual trigger.
  // Uses faster 1s polling for the first 10s after refreshKey changes, then 3s.
  const hasRunning = runs.some((r) => r.status === 'running')
  useEffect(() => {
    if (!hasRunning && refreshKey === 0) return // no reason to poll initially
    // Start with fast polling (1s) to give snappy feedback after "Run Now"
    let interval = 1000
    let timer = setInterval(refresh, interval)
    // After 10s, switch to slower 3s polling if still running
    const slowDown = setTimeout(() => {
      clearInterval(timer)
      if (hasRunning) {
        timer = setInterval(refresh, 3000)
      }
    }, 10000)
    // If nothing is running and initial window passes, stop entirely
    const stopTimer = hasRunning ? undefined : setTimeout(() => clearInterval(timer), 12000)
    return () => {
      clearInterval(timer)
      clearTimeout(slowDown)
      if (stopTimer) clearTimeout(stopTimer)
    }
  }, [hasRunning, taskId, refreshKey, refresh])

  return (
    // A drawer under its row, not a card inside it: the border-top continues
    // the list's own separator and the fill is the next surface layer down.
    <div className="border-t border-[var(--color-border-separator)] bg-[var(--color-surface-container-low)]">
      {/* Header */}
      <div className="flex items-center justify-between px-5 pb-1.5 pt-3.5">
        <span className="text-[14.5px] font-bold text-[var(--color-text-primary)]">{t('tasks.logsTitle')}</span>
        <IconButton
          icon={<span className="material-symbols-outlined text-[16px]">close</span>}
          label={t('tasks.close')}
          size="xs"
          tone="muted"
          onClick={onClose}
        />
      </div>

      {/* Content */}
      <div className="max-h-64 overflow-y-auto px-5 pb-4">
        {loading ? (
          // Same 16px brand spinner in the same `py-6` box; the label goes from
          // an `aria-label` on the SVG to an `aria-live` region, so the wait is
          // announced rather than only readable on focus.
          <LoadingState size="sm" label={t('common.loading')} labelHidden />
        ) : runs.length === 0 ? (
          <EmptyState variant="plain" size="sm" description={t('tasks.noLogs')} />
        ) : (
          <div className="divide-y divide-[var(--color-border-separator)]">
            {runs.map((run) => {
              const cfg = STATUS_CONFIG[run.status] || STATUS_CONFIG.failed!
              const isExpanded = expandedId === run.id
              return (
                <div key={run.id} className="py-2.5">
                  <div className="flex items-center gap-[11px]">
                    {/* Status icon */}
                    <span
                      aria-hidden="true"
                      className={`material-symbols-outlined shrink-0 text-[17px] ${run.status === 'running' ? 'animate-spin' : ''}`}
                      style={{ color: cfg.color, fontVariationSettings: "'FILL' 1" }}
                    >
                      {cfg.icon}
                    </span>

                    {/* Status text */}
                    <span className="text-[13.5px] font-bold" style={{ color: cfg.color }}>
                      {t(`tasks.runStatus.${run.status}` as any)} {/* dynamic key */}
                    </span>

                    {/* Time — mono, so timestamps line up down the column */}
                    <span className="font-mono text-[13px] tabular-nums text-[var(--color-text-secondary)]">
                      {new Date(run.startedAt).toLocaleString()}
                    </span>

                    {/* Duration */}
                    {run.durationMs != null && (
                      <span className="text-[13px] text-[var(--color-text-tertiary)]">
                        {t('tasks.duration', { s: Math.round(run.durationMs / 1000) })}
                      </span>
                    )}

                    <div className="ml-auto flex items-center gap-2">
                      {/* Open session — only after run completes (session is empty while running) */}
                      {run.sessionId && run.status !== 'running' && (
                        <Button
                          variant="link"
                          size="sm"
                          icon={<span aria-hidden="true" className="material-symbols-outlined text-[13px]">north_east</span>}
                          iconPosition="end"
                          onClick={() => openSession(run.sessionId!, run.taskName)}
                        >
                          {t('tasks.openSession')}
                        </Button>
                      )}

                      {/* Summary toggle */}
                      {(run.output || run.error || run.hasOutput || run.hasError) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-expanded={isExpanded}
                          onClick={() => { void toggleOutput(run) }}
                        >
                          {isExpanded ? t('tasks.hideOutput') : t('tasks.viewOutput')}
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Expanded output */}
                  {isExpanded && (run.output || run.error) ? (
                    <RunOutput run={run} />
                  ) : isExpanded && detailState?.runId === run.id && detailState.status === 'loading' ? (
                    <Card radius="lg" padding="none" className="mt-3 px-[18px] py-3 text-xs text-[var(--color-text-tertiary)]">
                      {t('common.loading')}
                    </Card>
                  ) : isExpanded && detailState?.runId === run.id && detailState.status === 'error' ? (
                    <ErrorState
                      size="sm"
                      className="mt-3"
                      title={t('common.error')}
                      onRetry={() => { void loadDetail(run) }}
                      retryLabel={t('common.retry')}
                    />
                  ) : isExpanded ? (
                    <RunOutput run={run} />
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
