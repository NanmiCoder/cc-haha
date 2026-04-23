import { useEffect, useState } from 'react'
import { useTaskStore } from '../../stores/taskStore'
import { useChatStore } from '../../stores/chatStore'
import { useTabStore } from '../../stores/tabStore'
import { useTranslation } from '../../i18n'
import { parseRunOutput } from '../../lib/parseRunOutput'
import type { TaskRun } from '../../types/task'

function RunOutput({ run }: { run: TaskRun }) {
  const t = useTranslation()

  // Show error prominently if present
  if (run.error) {
    return (
      <div className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] border border-[var(--color-error)]/20 bg-[var(--color-error-container)]/28 p-2.5 text-xs text-[var(--color-error)]">
        {run.error}
      </div>
    )
  }

  const text = parseRunOutput(run.output || '')

  if (!text) {
    return (
      <div className="mt-2 p-2.5 rounded-[var(--radius-sm)] bg-[var(--color-surface-container)] text-xs text-[var(--color-text-tertiary)] italic">
        {run.sessionId ? t('tasks.outputHintSession') : t('tasks.noOutputText')}
      </div>
    )
  }

  // Render AI text response with proper formatting (not monospace <pre>)
  return (
    <div className="mt-2 p-2.5 rounded-[var(--radius-sm)] bg-[var(--color-surface-container)] text-xs text-[var(--color-text-secondary)] whitespace-pre-wrap break-words max-h-48 overflow-y-auto leading-relaxed">
      {text}
    </div>
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
}

export function TaskRunsPanel({ taskId, onClose, refreshKey }: Props) {
  const t = useTranslation()
  const { fetchTaskRuns } = useTaskStore()
  const connectToSession = useChatStore((s) => s.connectToSession)
  const openTab = useTabStore((s) => s.openTab)
  const [runs, setRuns] = useState<TaskRun[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const openSession = (sessionId: string, taskName?: string) => {
    openTab(sessionId, taskName || 'Task Run')
    connectToSession(sessionId)
  }

  const refresh = () => {
    fetchTaskRuns(taskId).then((r) => {
      setRuns(r)
      setLoading(false)
    }).catch(() => setLoading(false))
  }

  // Initial fetch + re-fetch when refreshKey changes
  useEffect(() => {
    setLoading(true)
    refresh()
  }, [taskId, fetchTaskRuns, refreshKey])

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
  }, [hasRunning, taskId, refreshKey])

  return (
    <div className="mt-2 mb-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-[var(--color-surface-container)]">
        <span className="text-xs font-medium text-[var(--color-text-primary)]">{t('tasks.logsTitle')}</span>
        <button
          onClick={onClose}
          className="p-0.5 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
        >
          <span className="material-symbols-outlined text-[16px]">close</span>
        </button>
      </div>

      {/* Content */}
      <div className="max-h-64 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <div className="animate-spin w-4 h-4 border-2 border-[var(--color-brand)] border-t-transparent rounded-full" />
          </div>
        ) : runs.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-[var(--color-text-tertiary)]">
            {t('tasks.noLogs')}
          </div>
        ) : (
          <div className="divide-y divide-[var(--color-border-separator)]">
            {runs.map((run) => {
              const cfg = STATUS_CONFIG[run.status] || STATUS_CONFIG.failed!
              const isExpanded = expandedId === run.id
              return (
                <div key={run.id} className="px-4 py-2.5">
                  <div className="flex items-center gap-3">
                    {/* Status icon */}
                    <span
                      className={`material-symbols-outlined text-[16px] ${run.status === 'running' ? 'animate-spin' : ''}`}
                      style={{ color: cfg.color, fontVariationSettings: "'FILL' 1" }}
                    >
                      {cfg.icon}
                    </span>

                    {/* Status text */}
                    <span className="text-xs font-medium" style={{ color: cfg.color }}>
                      {t(`tasks.runStatus.${run.status}` as any)} {/* dynamic key */}
                    </span>

                    {/* Time */}
                    <span className="text-xs text-[var(--color-text-tertiary)]">
                      {new Date(run.startedAt).toLocaleString()}
                    </span>

                    {/* Duration */}
                    {run.durationMs != null && (
                      <span className="text-xs text-[var(--color-text-tertiary)]">
                        {t('tasks.duration', { s: Math.round(run.durationMs / 1000) })}
                      </span>
                    )}

                    <div className="ml-auto flex items-center gap-2">
                      {/* Open session — only after run completes (session is empty while running) */}
                      {run.sessionId && run.status !== 'running' && (
                        <button
                          onClick={() => openSession(run.sessionId!, run.taskName)}
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-[var(--color-brand)] bg-[var(--color-brand)]/8 hover:bg-[var(--color-brand)]/15 rounded-[var(--radius-sm)] transition-colors"
                        >
                          <span className="material-symbols-outlined text-[14px]">open_in_new</span>
                          {t('tasks.openSession')}
                        </button>
                      )}

                      {/* Summary toggle */}
                      {(run.output || run.error) && (
                        <button
                          onClick={() => setExpandedId(isExpanded ? null : run.id)}
                          className="text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors"
                        >
                          {isExpanded ? t('tasks.hideOutput') : t('tasks.viewOutput')}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Expanded output */}
                  {isExpanded && (
                    <RunOutput run={run} />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
