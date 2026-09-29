import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronRight, Circle, FileText, LoaderCircle, Square, Terminal, Users, X, Zap } from 'lucide-react'
import { Badge, StatusDot, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Progress } from '@/components/ui/Progress'
import { useDismissable } from '@/hooks/useDismissable'
import { AgentMascot } from './AgentMascot'
import { getVisibleActivitySections, type ActivityRow, type ActivitySectionId, type SessionActivityModel } from './sessionActivityModel'
import { useTranslation } from '../../i18n'
import { useSettingsStore } from '../../stores/settingsStore'
import type { BackgroundAgentTask } from '../../types/chat'
import type { TeamMember } from '../../types/team'
import { formatTokenCount } from '../../lib/formatTokenCount'

export type OpenSubagentPayload = {
  sessionId: string
  taskId?: string
  toolUseId: string
  title: string
  teamName?: string
  teamMemberName?: string
  teamStartedAt?: number
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
    case 'workflow':
      return t('session.activity.section.workflow')
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
  const base = 'space-y-0.5'
  if (rowCount === 0) return base

  switch (sectionId) {
    case 'tasks':
      return base
    case 'team':
      return base
    case 'workflow':
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

/**
 * How long a background task ran, in a compact fixed shape: `43s`, `4m1s`,
 * `1h2m`.
 *
 * Deliberately not localized *here*, unlike the duration readings elsewhere in
 * the app: this column sits beside a truncated task label and reports machine
 * work, so a digits-and-letters form keeps it narrow and lets the values line
 * up down the rail instead of changing width with the language. Past an hour
 * the seconds stop earning their width. Floored at one second — a sub-second
 * span still happened, and `0s` reads as "not measured"; a row with no span at
 * all stays blank instead (see `backgroundTaskDurationMs`).
 */
function formatBackgroundDuration(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return undefined
  const totalSeconds = Math.max(1, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}m${totalSeconds % 60}s`
  return `${Math.floor(totalMinutes / 60)}h${totalMinutes % 60}m`
}

/**
 * How long a background task ran, for a row that may carry either measure.
 *
 * The CLI reports `usage.durationMs` for agent-backed tasks and nothing at all
 * for shell tasks, so a reported value is preferred but is absent on exactly
 * the rows a reader most often wants timed. The client's own event clock
 * (`startedAt` → `updatedAt`) then supplies the span. A zero span stays
 * unmeasured rather than rendering as "1s": an instant is not an observation.
 */
function backgroundTaskDurationMs(row: ActivityRow): number | undefined {
  const reported = row.usage?.durationMs
  if (typeof reported === 'number' && Number.isFinite(reported) && reported > 0) return reported
  const { startedAt, updatedAt } = row
  if (
    typeof startedAt === 'number' && Number.isFinite(startedAt) &&
    typeof updatedAt === 'number' && Number.isFinite(updatedAt) &&
    updatedAt > startedAt
  ) {
    return updatedAt - startedAt
  }
  return undefined
}

function hasBackgroundTaskDetails(row: ActivityRow): boolean {
  return Boolean(
    row.description ||
      row.summary ||
      row.outputFile ||
      row.taskType ||
      row.workflowName ||
      row.usage?.totalTokens ||
      backgroundTaskDurationMs(row),
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
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-success)] text-[var(--color-surface)]"
      >
        <Check size={13} strokeWidth={3} aria-hidden="true" />
      </span>
    )
  }

  if (status === 'stopped') {
    return (
      <span
        aria-label={t('session.activity.status.stopped')}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--color-outline)] text-[var(--color-text-tertiary)]"
      >
        <X size={12} strokeWidth={2.4} aria-hidden="true" />
      </span>
    )
  }

  if (status === 'in_progress' || status === 'running') {
    // Not `Spinner`: this panel's markers stop under reduced motion, while
    // `Spinner` deliberately slows instead. `SessionActivityPanel.test.tsx`
    // asserts both the `motion-reduce:animate-none` and the absence of a bare
    // `.animate-spin` inside a row.
    return (
      <span
        aria-label={t('session.activity.task.inProgress')}
        className="inline-flex h-5 w-5 shrink-0 rounded-full border-[2.5px] border-[var(--color-primary-fixed-dim)] border-t-[var(--color-brand)] motion-safe:animate-spin motion-reduce:animate-none"
      />
    )
  }

  return (
    <span
      aria-label={t('session.activity.task.pending')}
      className="inline-flex h-5 w-5 shrink-0 rounded-full border-[1.8px] border-[var(--color-outline)]"
    />
  )
}

function getRowIcon(row: ActivityRow) {
  switch (row.section) {
    case 'team':
      return Users
    case 'workflow':
      return Zap
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

function getStatusTone(status: ActivityRow['status']): Tone {
  if (status === 'running' || status === 'in_progress') return 'brand'
  if (status === 'completed' || status === 'idle') return 'success'
  if (status === 'failed' || status === 'error' || status === 'stopped') return 'danger'
  return 'neutral'
}

/** A canonical Team DAG owns the section ratio when present. Run-local rows
 * remain visible beside it without changing the shared workbench progress. */
function getTaskProgress(rows: ActivityRow[]): { completed: number; total: number; percent: number } | null {
  if (rows.length === 0) return null
  const teamRows = rows.filter((row) => row.teamTaskListId !== undefined)
  const progressRows = teamRows.length > 0 ? teamRows : rows
  const completed = progressRows.filter((row) => row.status === 'completed').length
  return {
    completed,
    total: progressRows.length,
    percent: Math.round((completed / progressRows.length) * 100),
  }
}

/**
 * The tile's fill states what happened without spending a word on it, which is
 * what lets the row itself stay one line. Tone pairs come from the token scale
 * (see components/AGENTS.md §3.2) — never a raw accent as foreground on its own
 * container.
 */
function getRowIconToneClass(status: ActivityRow['status']): string {
  if (status === 'running' || status === 'in_progress') {
    return 'bg-[var(--color-brand-soft)] text-[var(--color-on-brand-soft)]'
  }
  if (status === 'completed' || status === 'idle') {
    return 'bg-[var(--color-success-container)] text-[var(--color-on-success-container)]'
  }
  if (status === 'failed' || status === 'error') {
    return 'bg-[var(--color-error-container)] text-[var(--color-on-error-container)]'
  }
  return 'bg-[var(--color-surface-container)] text-[var(--color-text-secondary)]'
}

function ActivityRowIcon({
  row,
  sessionId,
  status = row.status,
}: {
  row: ActivityRow
  sessionId: string
  status?: ActivityRow['status']
}) {
  // Workflow agents get the same mascot as any other subagent — they are the
  // same thing, and giving them a different glyph would imply otherwise.
  if (row.section === 'subagents' || (row.section === 'workflow' && row.group)) {
    return <AgentMascot seed={`${sessionId}:${row.toolUseId ?? row.taskId ?? row.id}`} status={status} />
  }

  const Icon = getRowIcon(row)

  // 30px to match `AgentMascot`, so a SubAgent row and a background-task row
  // start their text on the same column.
  return (
    <span
      data-testid="activity-row-icon"
      data-tone-status={status}
      className={`inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[var(--radius-md)] ${getRowIconToneClass(status)}`}
    >
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
    <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-[var(--color-text-tertiary)]">
      {/* `StatusDot`'s breathing dot rather than the expanding ping this used to
          draw: the design language has one live-status motion (1.6s pulse) and
          fifteen other dots in the app already run it. */}
      <StatusDot tone={getStatusTone(status)} pulse={isRunning} />
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
    <IconButton
      icon={stopping ? (
        <LoaderCircle size={14} strokeWidth={2.2} className="motion-safe:animate-spin motion-reduce:animate-none" aria-hidden="true" />
      ) : (
        <Square size={12} strokeWidth={2.4} aria-hidden="true" />
      )}
      label={label}
      size="md"
      tone="muted"
      disabled={stopping}
      onClick={() => onStop(row.taskId!)}
    />
  )
}

/**
 * A phase heading inside the workflow section.
 *
 * Deliberately not a card: the section is already a bordered list, and boxing
 * each phase inside it turned three stages into three nested frames. A rule
 * plus the settled count carries the grouping on its own.
 */
function WorkflowPhaseHeader({
  label,
  status,
  done,
  total,
}: {
  label: string
  status: ActivityRow['status']
  done: number
  total: number
}) {
  return (
    <div
      data-testid="workflow-phase-header"
      data-status={status}
      className="flex items-center gap-2 px-2 pb-1 pt-2.5 first:pt-1"
    >
      <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
        {label}
      </span>
      <span className="h-px flex-1 bg-[var(--color-border)]" aria-hidden="true" />
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
        {done}/{total}
      </span>
    </div>
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
  // 关闭会话扩展信息时隐藏本 fork 新增的行耗时；缺省视为开启。
  // 必须在下方 groupProgress 提前返回之前读取，避免条件式调用 Hook。
  const sessionExtendedInfo = useSettingsStore((state) => state.sessionExtendedInfo)
  // A workflow phase is a heading over its agents, not a row you can open.
  // Rendering it as one made a fan-out read as a flat list where the stage
  // boundaries were invisible.
  if (row.groupProgress) {
    return (
      <WorkflowPhaseHeader
        label={row.label}
        status={row.status}
        done={row.groupProgress.done}
        total={row.groupProgress.total}
      />
    )
  }
  const isTask = row.section === 'tasks'
  const isStoppingSubagent = row.section === 'subagents' && row.status === 'running' && stoppingBackgroundTask
  const displayStatus: ActivityRow['status'] = isStoppingSubagent ? 'pending' : row.status
  const statusLabel = isStoppingSubagent
    ? t('session.activity.status.stopping')
    : row.cached
      ? t('workflows.agent.cached')
      : getActivityStatusLabel(row.status, t)
  const label = row.taskHistory
    ? t('session.activity.tasks.earlier')
    : row.label
  const detail = row.taskHistory
    ? t('session.activity.tasks.earlierSummary', {
      completed: row.taskHistory.completed,
      total: row.taskHistory.total,
      turns: row.taskHistory.turnCount,
    })
    // Tasks only. SubAgent / team / background rows deliberately stay one line:
    // their `description` is free-form agent prose, not the compact identity
    // string the prototype's second line shows, and three tests pin that a row
    // never previews it. Details live in the expandable panel instead.
    : isTask && row.description && row.description !== row.label
      ? row.description
      : isTask && row.summary && row.summary !== row.label
        ? row.summary
        : undefined
  // Execution time on the right of the row. Deliberately not for subagents:
  // clicking one opens its run detail, and the floating card is too narrow to
  // carry another field on every agent line (the row would truncate the label).
  const rowDuration = row.section === 'tasks' || row.section === 'backgroundTasks'
    ? formatBackgroundDuration(backgroundTaskDurationMs(row))
    : undefined
  const content = (
    <>
      {isTask ? (
        <TaskStatusMarker status={row.status} t={t} />
      ) : (
        <ActivityRowIcon row={row} sessionId={sessionId} status={displayStatus} />
      )}
      <span className="min-w-0 flex-1 truncate text-left">
        <span
          className={`block truncate text-[13px] font-medium leading-5 ${isTask && row.status === 'completed' ? 'text-[var(--color-text-tertiary)] line-through decoration-[var(--color-text-tertiary)]' : 'text-[var(--color-text-primary)]'}`}
          title={label}
        >
          {label}
        </span>
        {detail ? (
          <span
            className="mt-px block truncate text-[11.5px] leading-4 text-[var(--color-text-tertiary)]"
            title={detail}
          >
            {detail}
          </span>
        ) : null}
      </span>
      {sessionExtendedInfo !== false && rowDuration ? (
        <span
          data-activity-duration="true"
          className="shrink-0 whitespace-nowrap font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]"
        >
          {rowDuration}
        </span>
      ) : null}
      {isTask ? null : (
        <ActivityStatusIndicator
          status={displayStatus}
          label={statusLabel}
          animated={row.section !== 'subagents'}
        />
      )}
      {!isTask && row.openable ? (
        <ChevronRight size={13} strokeWidth={2.2} className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
      ) : null}
    </>
  )
  const interactiveRowClassName =
    'flex min-w-0 items-center gap-2.5 rounded-[var(--radius-md)] px-2 py-1.5 text-left transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--color-surface-hover)] active:translate-y-px motion-reduce:active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]'
  const stopButton = row.section === 'backgroundTasks' && onStopBackgroundTask ? (
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

  // A workflow agent is an ordinary subagent, so it opens the same page by the
  // same handler — there is nothing workflow-specific to render for one.
  if (
    (row.section === 'subagents' || row.section === 'workflow' || row.section === 'team') &&
    row.openable &&
    row.toolUseId
  ) {
    const openButton = (
      <button
        type="button"
        aria-label={`${t('session.activity.openRun', { name: row.label })} · ${statusLabel}`}
        onClick={() => onOpenSubagent({
          sessionId,
          ...(row.taskId ? { taskId: row.taskId } : {}),
          toolUseId: row.toolUseId!,
          title: row.label,
          ...(row.teamName ? { teamName: row.teamName } : {}),
          ...(row.teamMemberName ? { teamMemberName: row.teamMemberName } : {}),
          ...(row.teamStartedAt !== undefined ? { teamStartedAt: row.teamStartedAt } : {}),
        })}
        className={`${interactiveRowClassName} ${stopButton ? 'flex-1' : 'w-full'} ${row.group ? 'pl-3' : ''}`}
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
        <div className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[var(--radius-md)] px-2 py-1.5">
          {content}
        </div>
        {stopButton}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2.5 rounded-[var(--radius-md)] px-2 py-1.5">
      {content}
    </div>
  )
}

function BackgroundTaskDetail({ row }: { row: ActivityRow }) {
  const t = useTranslation()
  const sessionExtendedInfo = useSettingsStore((state) => state.sessionExtendedInfo)
  // The card's own header carries the execution time, not a details field: it
  // belongs to the task as a whole, and putting it on the usage row tied it to
  // a row that shell tasks never have (they report no usage at all), so the
  // time silently vanished on exactly the tasks worth timing.
  // 关闭扩展信息只令该耗时字段消失，卡片其余字段照常渲染（见下方 return）。
  const duration = sessionExtendedInfo === false
    ? undefined
    : formatBackgroundDuration(backgroundTaskDurationMs(row))
  const usageTokens = typeof row.usage?.totalTokens === 'number'
    ? t('chat.backgroundAgents.tokens', { count: formatTokenCount(row.usage.totalTokens) })
    : ''
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
    usageTokens
      ? { label: t('session.activity.details.usage'), value: usageTokens }
      : null,
  ].filter((item): item is { label: string; value: string } => Boolean(item?.value))

  if (details.length === 0 && !duration) return null

  return (
    <div className="mx-2 mb-1.5 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">
          {t('session.activity.details.title')}
        </span>
        {duration ? (
          <span
            data-activity-detail-duration="true"
            className="shrink-0 whitespace-nowrap font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]"
          >
            {duration}
          </span>
        ) : null}
      </div>
      <dl className="space-y-2">
        {details.map((detail) => (
          <div key={detail.label} className="min-w-0">
            <dt className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">
              {detail.label}
            </dt>
            <dd className="max-h-28 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
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

  // Docked in the rail the panel is part of the layout, so nothing outside it
  // dismisses it; Escape still does, in both placements.
  const isDismissExempt = useCallback(
    (target: EventTarget | null) => placement === 'rail' || isActivityTriggerTarget(target),
    [placement],
  )

  useDismissable({
    open,
    refs: [panelRef],
    onDismiss: onClose,
    isExempt: isDismissExempt,
  })

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
  // Both placements are out-of-flow overlays pinned to the top right of the
  // session area. `rail` used to be an in-flow flex sibling, which is why the
  // handoff's "content makes way over .2s" could not be built: the content
  // column's width was whatever flex computed, and a flex-derived width is not
  // animatable. Out of flow, the column owns its own padding and can transition
  // it. Whoever renders this decides where it lands — the offsets resolve
  // against the nearest positioned ancestor, which in `ActiveSession` is the
  // session-area wrapper the chat column and this panel both sit in.
  //
  // `glass-panel` carries the frosted fill, hairline and `--shadow-overlay` the
  // design gives every floating surface; the hand-rolled shadow it replaces was
  // three hardcoded slate rgba layers plus a white gloss, none of which follow
  // `data-theme`.
  //
  // The level is pinned to the `z-40` this replaced: the panel has to clear
  // `MessageList`'s z-20 scroll button and stay under its fixed z-50 pill.
  // `--z-scrim` is that level on the scale; the name is about where 40 sits,
  // not about this being a scrim.
  const shellClassName = 'glass-panel absolute top-4 z-[var(--z-scrim)] flex flex-col overflow-hidden rounded-[var(--radius-xl)] animate-overlay-in'
  const className = placement === 'rail'
    // 20px from the right edge is the handoff's number, and it is what makes
    // the content column's 352px of padding leave the 8px gap it draws.
    ? `${shellClassName} right-5 max-h-[min(620px,calc(100%-80px))] w-[340px]`
    // Phone width: inset 16px on both sides, so the panel narrows instead of
    // running off the screen.
    : `${shellClassName} right-4 max-h-[calc(100%-80px)] w-[min(340px,calc(100%-32px))]`

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t('session.activity.title')}
      data-testid="session-activity-panel"
      data-placement={placement}
      className={className}
    >
      <div className="flex items-center gap-2 px-4 pb-2 pt-3.5">
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-[var(--color-text-primary)]">
          {t('session.activity.title')}
        </h2>
        <IconButton
          icon={<X size={14} strokeWidth={2.2} aria-hidden="true" />}
          label={t('session.activity.close')}
          size="sm"
          tone="muted"
          onClick={onClose}
        />
      </div>

      <div
        data-testid="session-activity-scroll"
        className={`min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 pb-4 pt-0.5 ${ACTIVITY_SCROLLBAR_CLASS}`}
      >
        {visibleSections.map((section, index) => {
          const sectionTitle = getSectionTitle(section.id, t)
          const taskProgress = section.id === 'tasks' ? getTaskProgress(section.rows) : null

          return (
            <section
              key={section.id}
              aria-label={sectionTitle}
              className={index > 0 ? 'border-t border-[var(--color-border)] pt-3' : undefined}
            >
              <div className="mb-1.5 flex items-center justify-between gap-2 px-2">
                <div className="flex min-w-0 items-center gap-2">
                  <h3 className="text-[12px] font-semibold text-[var(--color-text-secondary)]">
                    {sectionTitle}
                  </h3>
                  {section.rows.length > 0 ? (
                    <Badge tone="neutral" size="sm" pill={false}>{section.rows.length}</Badge>
                  ) : null}
                </div>
                {taskProgress ? (
                  <span className="flex shrink-0 items-center gap-2 text-[12px] tabular-nums text-[var(--color-text-tertiary)]">
                    {/* `Progress` is `w-full`; the wrapper is what makes it the
                        52px rail the design calls for, since the two width
                        utilities would otherwise resolve by stylesheet order. */}
                    <span className="inline-flex w-[52px] shrink-0">
                      {/* Named for what it measures, not the section: reusing the
                          section title made screen readers announce "任务, 50%". */}
                      <Progress
                        size="xs"
                        tone="success"
                        value={taskProgress.percent}
                        label={t('session.activity.tasksProgress', {
                          completed: taskProgress.completed,
                          total: taskProgress.total,
                        })}
                      />
                    </span>
                    {taskProgress.completed}/{taskProgress.total}
                  </span>
                ) : null}
                {section.id === 'backgroundTasks' && finishedBackgroundTaskKeys.length > 0 && onClearFinishedBackgroundTasks ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => onClearFinishedBackgroundTasks(finishedBackgroundTaskKeys)}
                  >
                    {t('session.activity.clearFinished')}
                  </Button>
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
