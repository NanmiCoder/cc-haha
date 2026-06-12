import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useTranslation } from '../../i18n'
import { useChatStore } from '../../stores/chatStore'
import type { AgentTaskNotification, BackgroundAgentTask } from '../../types/chat'

export type SoloCouncilRole = 'planner' | 'reviewer' | 'critic'
export type SoloCouncilVerdict = 'plan-ready' | 'approve' | 'changes-needed' | 'pending'

export type SoloCouncilRow = {
  role: SoloCouncilRole
  task: BackgroundAgentTask
  notification?: AgentTaskNotification
  verdict: SoloCouncilVerdict
  text: string
}

const SOLO_COUNCIL_PREFIXES: Record<SoloCouncilRole, string> = {
  planner: '[Solo Council: Planner]',
  reviewer: '[Solo Council: Reviewer]',
  critic: '[Solo Council: Critic]',
}

const ROLE_ORDER: SoloCouncilRole[] = ['planner', 'reviewer', 'critic']
const APPROVE_RE = /\b(?:PLAN_REVIEWER|PLAN_REVIEW):\s*APPROVE\b/i
const CHANGES_NEEDED_RE = /\b(?:PLAN_REVIEWER|PLAN_REVIEW):\s*CHANGES_NEEDED\b/i
const EMPTY_BACKGROUND_TASKS: Record<string, BackgroundAgentTask> = {}
const EMPTY_AGENT_NOTIFICATIONS: Record<string, AgentTaskNotification> = {}

export function getSoloCouncilRole(description?: string): SoloCouncilRole | null {
  if (!description) return null
  for (const role of ROLE_ORDER) {
    if (description.startsWith(SOLO_COUNCIL_PREFIXES[role])) return role
  }
  return null
}

export function parseSoloCouncilVerdict(
  role: SoloCouncilRole,
  task: Pick<BackgroundAgentTask, 'status' | 'summary'>,
  notification?: Pick<AgentTaskNotification, 'result' | 'summary'>,
): SoloCouncilVerdict {
  const text = `${notification?.result ?? ''}\n${notification?.summary ?? ''}\n${task.summary ?? ''}`
  if (CHANGES_NEEDED_RE.test(text)) return 'changes-needed'
  if (APPROVE_RE.test(text)) return 'approve'
  if (role === 'planner' && task.status === 'completed') return 'plan-ready'
  return 'pending'
}

export function buildSoloCouncilRows(
  tasks: Record<string, BackgroundAgentTask> | undefined,
  notifications: Record<string, AgentTaskNotification> | undefined,
): SoloCouncilRow[] {
  const latestByRole = new Map<SoloCouncilRole, SoloCouncilRow>()

  for (const task of Object.values(tasks ?? {})) {
    const role = getSoloCouncilRole(task.description)
    if (!role) continue

    const notification = task.toolUseId ? notifications?.[task.toolUseId] : undefined
    const text = notification?.result || notification?.summary || task.summary || task.description || ''
    const row: SoloCouncilRow = {
      role,
      task,
      notification,
      verdict: parseSoloCouncilVerdict(role, task, notification),
      text,
    }

    const previous = latestByRole.get(role)
    if (!previous || row.task.updatedAt >= previous.task.updatedAt) {
      latestByRole.set(role, row)
    }
  }

  return ROLE_ORDER.flatMap((role) => {
    const row = latestByRole.get(role)
    return row ? [row] : []
  })
}

export function SoloCouncilPanel({
  sessionId,
  compact = false,
}: {
  sessionId: string
  compact?: boolean
}) {
  const t = useTranslation()
  const sessionSnapshot = useChatStore(useShallow((state) => {
    const session = state.sessions[sessionId]
    return {
      tasks: session?.backgroundAgentTasks ?? EMPTY_BACKGROUND_TASKS,
      notifications: session?.agentTaskNotifications ?? EMPTY_AGENT_NOTIFICATIONS,
    }
  }))
  const rows = useMemo(
    () => buildSoloCouncilRows(sessionSnapshot.tasks, sessionSnapshot.notifications),
    [sessionSnapshot.tasks, sessionSnapshot.notifications],
  )

  const hasDebate = useMemo(
    () => rows.some((row) => row.verdict === 'changes-needed' || row.task.status === 'failed'),
    [rows],
  )

  if (rows.length === 0) return null

  return (
    <div className={compact ? 'mt-2' : 'mt-3'} data-testid="solo-council-panel">
      <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-3 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
              <span className="material-symbols-outlined text-[16px] text-[var(--color-primary)]" aria-hidden="true">diversity_3</span>
              {t('soloCouncil.title')}
            </div>
            <div className="mt-0.5 text-[11px] text-[var(--color-text-tertiary)]">
              {t('soloCouncil.subtitle')}
            </div>
          </div>
          {hasDebate && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--color-warning)]/35 bg-[var(--color-warning)]/10 px-2 py-1 text-[10px] font-semibold text-[var(--color-warning)]">
              <span className="material-symbols-outlined text-[13px]" aria-hidden="true">forum</span>
              {t('soloCouncil.debateActive')}
            </span>
          )}
        </div>
        <div className="grid gap-2 md:grid-cols-3">
          {rows.map((row) => (
            <SoloCouncilCard key={row.role} row={row} />
          ))}
        </div>
      </div>
    </div>
  )
}

function SoloCouncilCard({ row }: { row: SoloCouncilRow }) {
  const t = useTranslation()
  const tone = getCardTone(row)
  const usage = row.task.usage || row.notification?.usage
  const statusKey = `soloCouncil.status.${row.task.status}` as const
  const verdictKey = getVerdictKey(row.verdict)

  return (
    <div
      data-testid={`solo-council-card-${row.role}`}
      className={`min-w-0 rounded-[var(--radius-md)] border px-3 py-2.5 ${tone.className}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text-primary)]">
            <span className="material-symbols-outlined text-[14px]" aria-hidden="true">{roleIcon(row.role)}</span>
            {t(`soloCouncil.role.${row.role}` as const)}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--color-text-tertiary)]">
            <StatusDot status={row.task.status} />
            <span>{t(statusKey)}</span>
            {usage?.totalTokens ? <span>{usage.totalTokens.toLocaleString()} t</span> : null}
            {usage?.toolUses ? <span>{usage.toolUses} tools</span> : null}
          </div>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${tone.badgeClassName}`}>
          {t(verdictKey)}
        </span>
      </div>
      {row.text ? (
        <div className="mt-2 line-clamp-3 text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
          {row.text}
        </div>
      ) : null}
    </div>
  )
}

function getVerdictKey(verdict: SoloCouncilVerdict) {
  if (verdict === 'plan-ready') return 'soloCouncil.verdict.planReady'
  if (verdict === 'approve') return 'soloCouncil.verdict.approve'
  if (verdict === 'changes-needed') return 'soloCouncil.verdict.changesNeeded'
  return 'soloCouncil.verdict.pending'
}

function getCardTone(row: SoloCouncilRow) {
  if (row.task.status === 'failed' || row.verdict === 'changes-needed') {
    return {
      className: 'border-[var(--color-warning)]/45 bg-[var(--color-warning)]/8',
      badgeClassName: 'bg-[var(--color-warning)]/15 text-[var(--color-warning)]',
    }
  }
  if (row.task.status === 'completed' && row.verdict !== 'pending') {
    return {
      className: 'border-[var(--color-success)]/30 bg-[var(--color-success)]/7',
      badgeClassName: 'bg-[var(--color-success)]/12 text-[var(--color-success)]',
    }
  }
  return {
    className: 'border-[var(--color-border)] bg-[var(--color-surface-container-low)]',
    badgeClassName: 'bg-[var(--color-surface-container-high)] text-[var(--color-text-tertiary)]',
  }
}

function StatusDot({ status }: { status: BackgroundAgentTask['status'] }) {
  const color = status === 'failed'
    ? 'bg-[var(--color-error)]'
    : status === 'completed'
      ? 'bg-[var(--color-success)]'
      : status === 'stopped'
        ? 'bg-[var(--color-text-tertiary)]'
        : 'bg-[var(--color-primary)]'

  return <span className={`h-1.5 w-1.5 rounded-full ${color} ${status === 'running' ? 'animate-pulse' : ''}`} />
}

function roleIcon(role: SoloCouncilRole) {
  if (role === 'planner') return 'architecture'
  if (role === 'reviewer') return 'fact_check'
  return 'gavel'
}
