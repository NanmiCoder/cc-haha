import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronRight, Circle, FileText, LoaderCircle, Square, Terminal, Users, X } from 'lucide-react'
import { AgentMascot } from './AgentMascot'
import { getVisibleActivitySections, type ActivityRow, type ActivitySectionId, type SessionActivityModel } from './sessionActivityModel'
import { useTranslation } from '../../i18n'
import type { BackgroundAgentTask } from '../../types/chat'
import type { TeamMember } from '../../types/team'
import { formatTokenCount } from '../../lib/formatTokenCount'

export type OpenSubagentPayload = {
  sessionId: string
  toolUseId: string
  title: string
}

type SessionActivityPanelPlacement = 'overlay' | 'rail'

type TranslationFn = ReturnType<typeof useTranslation>

const ACTIVITY_SCROLLBAR_CLASS = [
  '[scrollbar-width:auto]',
  '[scrollbar-color:color-mix(in_srgb,var(--color-outline)_62%,transparent)_transparent]',
  '[&::-webkit-scrollbar]:w-2.5',
  '[&::-webkit-scrollbar-track]:bg-transparent',
  '[&::-webkit-scrollbar-thumb]:rounded-full',
  '[&::-webkit-scrollbar-thumb]:border-[3px]',
  '[&::-webkit-scrollbar-thumb]:border-transparent',
  '[&::-webkit-scrollbar-thumb]:bg-[color-mix(in_srgb,var(--color-outline)_68%,transparent)]',
  '[&::-webkit-scrollbar-thumb]:bg-clip-content',
  '[&::-webkit-scrollbar-thumb:hover]:border-2',
  '[&::-webkit-scrollbar-thumb:hover]:bg-[color-mix(in_srgb,var(--color-outline)_84%,transparent)]',
].join(' ')

function fallbackStatusLabel(status: ActivityRow['status']): string {
  const label = String(status).replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!label) return ''
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`
}

function getActivityStatusLabel(status: ActivityRow['status'], t: TranslationFn): string {
  switch (status) {
    case 'pending':
      return t('session.activity.status.pending')
    case 'in_progress':
      return t('session.activity.status.inProgress')
    case 'completed':
      return t('session.activity.status.completed')
    case 'running':
      return t('session.activity.status.running')
    case 'failed':
      return t('session.activity.status.failed')
    case 'stopped':
      return t('session.activity.status.stopped')
    case 'idle':
      return t('session.activity.status.idle')
    case 'error':
      return t('session.activity.status.error')
    default:
      return fallbackStatusLabel(status)
  }
}

function getSectionTitle(sectionId: ActivitySectionId, t: TranslationFn): string {
  switch (sectionId) {
    case 'tasks':
      return t('session.activity.section.tasks')
    case 'team':
      return t('session.activity.section.team')
    case 'backgroundTasks':
      return t('session.activity.section.backgroundTasks')
    case 'subagents':
      return t('session.activity.section.subagents')
    case 'sources':
      return t('session.activity.section.sources')
    case 'output':
      return t('subagentRun.output')
  }
}

function getSectionRowsClassName(sectionId: ActivitySectionId, rowCount: number): string {
  const base = 'space-y-1.5'
  if (rowCount === 0) return base

  switch (sectionId) {
    case 'tasks':
      return base
    case 'team':
      return base
    case 'backgroundTasks':
      return base
    case 'subagents':
      return base
    case 'sources':
      return base
    case 'output':
      return base
  }
}

function getTaskTypeLabel(taskType: BackgroundAgentTask['taskType'] | undefined, t: TranslationFn): string {
  if (taskType?.includes('agent')) return t('chat.backgroundTasks.type.agent')
  if (taskType === 'local_bash') return t('chat.backgroundTasks.type.bash')
  if (taskType === 'local_workflow') return t('chat.backgroundTasks.type.workflow')
  return t('chat.backgroundTasks.type.task')
}

function formatBackgroundDuration(ms: number | undefined, t: TranslationFn): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return undefined
  const totalSeconds = Math.max(1, Math.round(ms / 1000))
  if (totalSeconds < 60) return t('chat.duration.seconds', { seconds: totalSeconds })
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return t('chat.duration.minutesSeconds', { minutes, seconds })
}

function hasBackgroundTaskDetails(row: ActivityRow): boolean {
  return Boolean(
    row.description ||
      row.summary ||
      row.outputFile ||
      row.taskType ||
      row.workflowName ||
      row.usage?.totalTokens ||
      row.usage?.durationMs,
  )
}

function isActivityTriggerTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-session-activity-trigger="true"]') !== null
}

function isBackgroundTaskStatus(status: ActivityRow['status']): status is BackgroundAgentTask['status'] {
  return status === 'running' || status === 'completed' || status === 'failed' || status === 'stopped'
}

function getFinishedBackgroundTaskKeys(model: SessionActivityModel): string[] {
  const keys = new Set<string>()

  for (const sectionId of ['backgroundTasks', 'subagents'] as const) {
    for (const row of model.sections[sectionId].rows) {
      if (row.dismissKey && isBackgroundTaskStatus(row.status) && row.status !== 'running') {
        keys.add(row.dismissKey)
      }
    }
  }

  return Array.from(keys)
}

function TaskStatusMarker({ status, t }: { status: ActivityRow['status']; t: TranslationFn }) {
  if (status === 'completed') {
    return (
      <span
        aria-label={t('session.activity.task.completed')}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-[var(--color-success)] bg-[var(--color-success)] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.24)]"
      >
        <Check size={13} strokeWidth={3} aria-hidden="true" />
      </span>
    )
  }

  if (status === 'in_progress' || status === 'running') {
    return (
      <span
        aria-label={t('session.activity.task.inProgress')}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-[var(--color-accent)] bg-[var(--color-surface)] text-[var(--color-accent)]"
      >
        <LoaderCircle size={13} strokeWidth={2.4} aria-hidden="true" className="motion-safe:animate-spin motion-reduce:animate-none" />
      </span>
    )
  }

  return (
    <span
      aria-label={t('session.activity.task.pending')}
      className="inline-flex h-5 w-5 shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]"
    />
  )
}

function getRowIcon(row: ActivityRow) {
  switch (row.section) {
    case 'team':
      return Users
    case 'backgroundTasks':
      return Terminal
    case 'subagents':
      return Users
    case 'sources':
    case 'output':
      return FileText
    case 'tasks':
      return Circle
  }
}

function getStatusTone(status: ActivityRow['status']) {
  if (status === 'running' || status === 'in_progress') {
    return 'bg-[var(--color-accent)]'
  }
  if (status === 'completed' || status === 'idle') {
    return 'bg-[var(--color-success)]'
  }
  if (status === 'failed' || status === 'error' || status === 'stopped') {
    return 'bg-[var(--color-error)]'
  }
  return 'bg-[var(--color-text-tertiary)]'
}

function ActivityRowIcon({ row, sessionId }: { row: ActivityRow; sessionId: string }) {
  if (row.section === 'subagents') {
    return <AgentMascot seed={`${sessionId}:${row.toolUseId ?? row.taskId ?? row.id}`} status={row.status} />
  }

  const Icon = getRowIcon(row)

  return (
    <span className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-lg text-[var(--color-text-tertiary)]">
      <Icon size={15} strokeWidth={2} aria-hidden="true" />
    </span>
  )
}

function ActivityStatusIndicator({
  status,
  label,
  animated = true,
}: {
  status: ActivityRow['status']
  label: string
  animated?: boolean
}) {
  const isRunning = animated && (status === 'running' || status === 'in_progress')

  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-medium text-[var(--color-text-tertiary)]">
      <span className="relative inline-flex h-1.5 w-1.5" aria-hidden="true">
        {isRunning ? (
          <span className={`absolute inline-flex h-full w-full rounded-full opacity-35 motion-safe:animate-ping motion-reduce:animate-none ${getStatusTone(status)}`} />
        ) : null}
        <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${getStatusTone(status)}`} />
      </span>
      {label}
    </span>
  )
}

function BackgroundTaskStopButton({
  row,
  stopping,
  onStop,
}: {
  row: ActivityRow
  stopping: boolean
  onStop: (taskId: string) => void
}) {
  const t = useTranslation()
  if (row.status !== 'running' || !row.taskId) return null

  const label = stopping
    ? t('session.activity.stoppingBackgroundTask', { name: row.label })
    : t('session.activity.stopBackgroundTask', { name: row.label })

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={stopping}
      onClick={() => onStop(row.taskId!)}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-tertiary)] transition-[background-color,color,transform] duration-150 ease-out hover:bg-[var(--color-error)]/10 hover:text-[var(--color-error)] active:translate-y-px disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
    >
      {stopping ? (
        <LoaderCircle size={14} strokeWidth={2.2} className="motion-safe:animate-spin motion-reduce:animate-none" aria-hidden="true" />
      ) : (
        <Square size={12} strokeWidth={2.4} aria-hidden="true" />
      )}
    </button>
  )
}

function ActivityRowView({
  row,
  sessionId,
  onOpenSubagent,
  onOpenMember,
  onOpenBackgroundTask,
  onStopBackgroundTask,
  stoppingBackgroundTask,
  selected,
}: {
  row: ActivityRow
  sessionId: string
  onOpenSubagent: (payload: OpenSubagentPayload) => void
  onOpenMember?: (member: TeamMember) => void
  onOpenBackgroundTask?: (row: ActivityRow) => void
  onStopBackgroundTask?: (taskId: string) => void
  stoppingBackgroundTask?: boolean
  selected?: boolean
}) {
  const t = useTranslation()
  const isTask = row.section === 'tasks'
  const label = row.taskHistory
    ? t('session.activity.tasks.earlier')
    : row.label
  const detail = row.taskHistory
    ? t('session.activity.tasks.earlierSummary', {
      completed: row.taskHistory.completed,
      total: row.taskHistory.total,
      turns: row.taskHistory.turnCount,
    })
    : isTask && row.description && row.description !== row.label
      ? row.description
      : isTask && row.summary && row.summary !== row.label
        ? row.summary
        : undefined
  const content = (
    <>
      {isTask ? (
        <TaskStatusMarker status={row.status} t={t} />
      ) : (
        <ActivityRowIcon row={row} sessionId={sessionId} />
      )}
      <span className="min-w-0 flex-1 truncate text-left">
        <span
          className={`block truncate text-[12px] font-semibold leading-4 ${isTask && row.status === 'completed' ? 'text-[var(--color-text-tertiary)] line-through decoration-[var(--color-text-tertiary)]/60' : 'text-[var(--color-text-primary)]'}`}
          title={label}
        >
          {label}
        </span>
        {detail ? (
          <span
            className="block truncate text-[10px] leading-4 text-[var(--color-text-tertiary)]"
            title={detail}
          >
            {detail}
          </span>
        ) : null}
      </span>
      {isTask ? null : (
        <ActivityStatusIndicator
          status={row.status}
          label={getActivityStatusLabel(row.status, t)}
          animated={row.section !== 'subagents'}
        />
      )}
      {!isTask && row.openable ? (
        <ChevronRight size={13} strokeWidth={2.2} className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
      ) : null}
    </>
  )
  const interactiveRowClassName =
    'flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--color-surface-hover)] active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]'
  const stopButton = onStopBackgroundTask ? (
    <BackgroundTaskStopButton
      row={row}
      stopping={Boolean(stoppingBackgroundTask)}
      onStop={onStopBackgroundTask}
    />
  ) : null

  if (row.section === 'team' && row.member && onOpenMember) {
    return (
      <button
        type="button"
        aria-label={t('session.activity.openTeamMember', { name: row.label })}
        onClick={() => onOpenMember(row.member!)}
        className={`${interactiveRowClassName} w-full`}
      >
        {content}
      </button>
    )
  }

  if (row.section === 'subagents' && row.openable && row.toolUseId) {
    const statusLabel = getActivityStatusLabel(row.status, t)
    const openButton = (
      <button
        type="button"
        aria-label={`${t('session.activity.openRun', { name: row.label })} · ${statusLabel}`}
        onClick={() => onOpenSubagent({ sessionId, toolUseId: row.toolUseId!, title: row.label })}
        className={`${interactiveRowClassName} ${stopButton ? 'flex-1' : 'w-full'}`}
      >
        {content}
      </button>
    )

    return stopButton ? (
      <div className="flex w-full items-center gap-1">
        {openButton}
        {stopButton}
      </div>
    ) : openButton
  }

  if (row.section === 'backgroundTasks' && onOpenBackgroundTask && hasBackgroundTaskDetails(row)) {
    const openButton = (
      <button
        type="button"
        aria-label={t('session.activity.openBackgroundTask', { name: row.label })}
        aria-expanded={selected}
        onClick={() => onOpenBackgroundTask(row)}
        className={`${interactiveRowClassName} ${stopButton ? 'flex-1' : 'w-full'} ${selected ? 'bg-[var(--color-surface-container)]' : ''}`}
      >
        {content}
      </button>
    )

    return stopButton ? (
      <div className="flex w-full items-center gap-1">
        {openButton}
        {stopButton}
      </div>
    ) : openButton
  }

  if (stopButton) {
    return (
      <div className="flex w-full items-center gap-1">
        <div className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-2.5">
          {content}
        </div>
        {stopButton}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2.5 rounded-lg px-2.5 py-2.5">
      {content}
    </div>
  )
}

function BackgroundTaskDetail({ row }: { row: ActivityRow }) {
  const t = useTranslation()
  const duration = formatBackgroundDuration(row.usage?.durationMs, t)
  const usageParts = [
    typeof row.usage?.totalTokens === 'number'
      ? t('chat.backgroundAgents.tokens', { count: formatTokenCount(row.usage.totalTokens) })
      : '',
    duration,
  ].filter(Boolean)
  const details = [
    row.taskType || row.workflowName
      ? { label: t('session.activity.details.type'), value: getTaskTypeLabel(row.taskType, t) }
      : null,
    row.description
      ? { label: t('session.activity.details.description'), value: row.description }
      : null,
    row.summary
      ? { label: t('session.activity.details.summary'), value: row.summary }
      : null,
    row.outputFile
      ? { label: t('session.activity.details.outputFile'), value: row.outputFile }
      : null,
    usageParts.length > 0
      ? { label: t('session.activity.details.usage'), value: usageParts.join(' · ') }
      : null,
  ].filter((item): item is { label: string; value: string } => Boolean(item?.value))

  if (details.length === 0) return null

  return (
    <div className="mx-2.5 mb-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.54)]">
      <div className="mb-1.5 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
        {t('session.activity.details.title')}
      </div>
      <dl className="space-y-1.5">
        {details.map((detail) => (
          <div key={detail.label} className="min-w-0">
            <dt className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">
              {detail.label}
            </dt>
            <dd className="max-h-28 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-relaxed text-[var(--color-text-secondary)]">
              {detail.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export function SessionActivityPanel({
  model,
  open,
  onClose,
  onOpenSubagent,
  onClearFinishedBackgroundTasks,
  onOpenMember,
  onStopBackgroundTask,
  stoppingBackgroundTaskIds,
  placement = 'overlay',
}: {
  model: SessionActivityModel
  open: boolean
  onClose: () => void
  onOpenSubagent: (payload: OpenSubagentPayload) => void
  onClearFinishedBackgroundTasks?: (taskKeys: string[]) => void
  onOpenMember?: (member: TeamMember) => void
  onStopBackgroundTask?: (taskId: string) => void
  stoppingBackgroundTaskIds?: Record<string, boolean>
  placement?: SessionActivityPanelPlacement
}) {
  const t = useTranslation()
  const panelRef = useRef<HTMLDivElement>(null)
  const [selectedBackgroundTaskId, setSelectedBackgroundTaskId] = useState<string | null>(null)
  const finishedBackgroundTaskKeys = useMemo(() => getFinishedBackgroundTaskKeys(model), [model])
  const visibleSections = useMemo(() => getVisibleActivitySections(model), [model])

  useEffect(() => {
    if (!open) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose, open])

  useEffect(() => {
    if (!open || placement === 'rail') return

    const handlePointerDown = (event: PointerEvent) => {
      if (isActivityTriggerTarget(event.target)) return
      if (panelRef.current?.contains(event.target as Node)) return
      onClose()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [onClose, open, placement])

  useEffect(() => {
    if (!open) {
      setSelectedBackgroundTaskId(null)
      return
    }

    if (
      selectedBackgroundTaskId &&
      !model.sections.backgroundTasks.rows.some((row) => row.id === selectedBackgroundTaskId)
    ) {
      setSelectedBackgroundTaskId(null)
    }
  }, [model.sections.backgroundTasks.rows, open, selectedBackgroundTaskId])

  if (!open) return null
  const className = placement === 'rail'
    ? 'my-4 ml-3 mr-3 flex max-h-[min(620px,calc(100vh-72px))] w-[336px] shrink-0 self-start flex-col overflow-hidden rounded-[22px] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[0_24px_72px_-48px_rgba(15,23,42,0.54),0_10px_26px_-22px_rgba(15,23,42,0.32),inset_0_1px_0_rgba(255,255,255,0.82)]'
    : 'absolute right-4 top-4 z-40 flex max-h-[calc(100%-80px)] w-[min(336px,calc(100%-32px))] flex-col overflow-hidden rounded-[22px] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[0_24px_72px_-48px_rgba(15,23,42,0.54),0_10px_26px_-22px_rgba(15,23,42,0.32),inset_0_1px_0_rgba(255,255,255,0.82)]'

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t('session.activity.title')}
      data-testid="session-activity-panel"
      data-placement={placement}
      className={className}
    >
      <div className="flex items-center justify-between px-4 pb-1.5 pt-3.5">
        <h2 className="text-[12px] font-semibold text-[var(--color-text-secondary)]">{t('session.activity.title')}</h2>
        <button
          type="button"
          aria-label={t('session.activity.close')}
          onClick={onClose}
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-[var(--color-text-tertiary)] transition-[background-color,color,transform] duration-150 ease-out hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
        >
          <X size={14} strokeWidth={2.2} aria-hidden="true" />
        </button>
      </div>

      <div
        data-testid="session-activity-scroll"
        className={`min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 pb-4 pt-0.5 ${ACTIVITY_SCROLLBAR_CLASS}`}
      >
        {visibleSections.map((section, index) => {
          const sectionTitle = getSectionTitle(section.id, t)

          return (
            <section
              key={section.id}
              aria-label={sectionTitle}
              className={index > 0 ? 'border-t border-[var(--color-border)] pt-3' : undefined}
            >
              <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
                <div className="flex min-w-0 items-center gap-1.5">
                  <h3 className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">
                    {sectionTitle}
                  </h3>
                  {section.rows.length > 0 ? (
                    <span className="rounded-full bg-[var(--color-surface-container)] px-1.5 py-0.5 text-[9px] leading-none text-[var(--color-text-tertiary)]">
                      {section.rows.length}
                    </span>
                  ) : null}
                </div>
                {section.id === 'backgroundTasks' && finishedBackgroundTaskKeys.length > 0 && onClearFinishedBackgroundTasks ? (
                  <button
                    type="button"
                    onClick={() => onClearFinishedBackgroundTasks(finishedBackgroundTaskKeys)}
                    className="rounded px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
                  >
                    {t('session.activity.clearFinished')}
                  </button>
                ) : null}
              </div>
              <div className={getSectionRowsClassName(section.id, section.rows.length)}>
                {section.rows.map((row) => (
                  <div key={row.id}>
                    <ActivityRowView
                      row={row}
                      sessionId={model.sessionId}
                      onOpenSubagent={onOpenSubagent}
                      onOpenMember={onOpenMember}
                      onStopBackgroundTask={onStopBackgroundTask}
                      stoppingBackgroundTask={Boolean(row.taskId && stoppingBackgroundTaskIds?.[row.taskId])}
                      onOpenBackgroundTask={(backgroundRow) => {
                        setSelectedBackgroundTaskId((current) => (
                          current === backgroundRow.id ? null : backgroundRow.id
                        ))
                      }}
                      selected={section.id === 'backgroundTasks' && selectedBackgroundTaskId === row.id}
                    />
                    {section.id === 'backgroundTasks' && selectedBackgroundTaskId === row.id ? (
                      <BackgroundTaskDetail row={row} />
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
