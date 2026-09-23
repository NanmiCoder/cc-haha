import { useId, useMemo } from 'react'
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react'

import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'
import { MEMBER_AVATARS, memberAccentColor } from '@/components/agentTeams/agentTeamsAvatars'
import {
  formatWorkbenchMessageTime,
  getMemberAvatarKey,
  getMemberWorkState,
  getWorkbenchTaskState,
  inferTaskOwner,
  parseWorkbenchMessageBody,
  resolveMemberModel,
  resolveTeamMemberIdentity,
  taskOwnedByMember,
  type MemberWorkState,
  type WorkbenchMessageBody,
  type WorkbenchTaskState,
} from '@/components/agentTeams/agentTeamsModel'
import { Badge, StatusDot, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { useTranslation, type TranslationKey } from '@/i18n'
import type {
  TeamMember,
  TeamWorkbenchMessage,
  TeamWorkbenchSnapshot,
  TeamWorkbenchTask,
} from '@/types/team'

export type AgentTeamsMemberInspectorProps = {
  snapshots: TeamWorkbenchSnapshot[]
  selectedIndex: number
  snapshot: TeamWorkbenchSnapshot
  member: TeamMember
  isLead: boolean
  leadIsStreaming: boolean
  onBack: () => void
  onClose: () => void
  onOpenExecution: () => void
}

type TranslationFn = ReturnType<typeof useTranslation>

type TaskHistoryEntry = {
  task: TeamWorkbenchTask
  state: WorkbenchTaskState
  startedAt: number | null
  durationMs: number | null
}

type MemberMessage = {
  message: TeamWorkbenchMessage
  body: WorkbenchMessageBody
  direction: 'sent' | 'received'
  peerName: string
}

function timestampMs(value: string | undefined): number | null {
  if (!value) return null
  const numeric = /^\d+$/.test(value) ? Number(value) : Number.NaN
  const parsed = Number.isFinite(numeric) ? numeric : Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function identityAliases(value: string | undefined): string[] {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return []
  const short = normalized.split('@')[0] ?? normalized
  return normalized === short ? [normalized] : [normalized, short]
}

function memberAliases(member: TeamMember): string[] {
  return [
    ...identityAliases(member.agentId),
    ...identityAliases(member.name),
  ]
}

function memberMatchesIdentity(member: TeamMember, identity: string | undefined): boolean {
  const aliases = identityAliases(identity)
  return aliases.some(alias => memberAliases(member).includes(alias))
}

function memberName(member: TeamMember): string {
  return member.name || member.role || member.agentId.split('@')[0] || member.agentId
}

function taskBelongsToMember(
  task: TeamWorkbenchTask,
  member: TeamMember,
  snapshot: TeamWorkbenchSnapshot,
): boolean {
  if (taskOwnedByMember(task, member)) return true
  const attribution = inferTaskOwner(task, snapshot)
  return attribution ? memberMatchesIdentity(member, attribution.identity) : false
}

function visibleSnapshots(
  snapshots: TeamWorkbenchSnapshot[],
  selectedIndex: number,
  snapshot: TeamWorkbenchSnapshot,
): TeamWorkbenchSnapshot[] {
  if (snapshots.length === 0) return [snapshot]
  const clampedIndex = Math.max(0, Math.min(selectedIndex, snapshots.length - 1))
  const visible = snapshots.slice(0, clampedIndex + 1)
  // `snapshotWithHistoricalMembers` returns a reconstructed object. Keep that
  // roster while retaining the original earlier frames used for timing.
  visible[visible.length - 1] = snapshot
  return visible
}

function deriveTaskHistory(
  snapshots: TeamWorkbenchSnapshot[],
  selectedIndex: number,
  snapshot: TeamWorkbenchSnapshot,
  member: TeamMember,
): TaskHistoryEntry[] {
  type MutableTaskHistory = {
    task: TeamWorkbenchTask
    startedAt: number | null
    completedAt: number | null
  }

  const history = new Map<string, MutableTaskHistory>()
  const frames = visibleSnapshots(snapshots, selectedIndex, snapshot)

  frames.forEach((frame) => {
    const frameTime = timestampMs(frame.generatedAt)
    frame.tasks.forEach((task) => {
      if (!taskBelongsToMember(task, member, frame)) return
      const entry = history.get(task.id) ?? {
        task,
        startedAt: null,
        completedAt: null,
      }
      entry.task = task
      if (entry.startedAt === null && task.status !== 'pending') entry.startedAt = frameTime
      if (entry.completedAt === null && task.status === 'completed') entry.completedAt = frameTime
      history.set(task.id, entry)
    })
  })

  const tasksById = new Map(snapshot.tasks.map(task => [task.id, task]))
  const selectedTime = timestampMs(snapshot.generatedAt)

  return Array.from(history.values())
    .map((entry): TaskHistoryEntry => {
      const currentTask = tasksById.get(entry.task.id)
      const task = currentTask && taskBelongsToMember(currentTask, member, snapshot)
        ? currentTask
        : entry.task
      const durationEnd = entry.completedAt ?? selectedTime
      const durationMs = entry.startedAt !== null && durationEnd !== null
        ? Math.max(0, durationEnd - entry.startedAt)
        : null
      return {
        task,
        state: getWorkbenchTaskState(task, tasksById),
        startedAt: entry.startedAt,
        durationMs,
      }
    })
    .sort((left, right) => {
      // A task authored up-front is merely future work until it actually
      // leaves `pending`; do not place it before work the member already ran.
      const leftTime = left.startedAt ?? Number.MAX_SAFE_INTEGER
      const rightTime = right.startedAt ?? Number.MAX_SAFE_INTEGER
      return leftTime - rightTime || left.task.id.localeCompare(right.task.id, undefined, { numeric: true })
    })
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function formatTaskSpan(entry: TaskHistoryEntry): string {
  if (entry.startedAt === null || entry.durationMs === null) return '—'
  return `${formatWorkbenchMessageTime(new Date(entry.startedAt).toISOString())} +${formatDuration(entry.durationMs)}`
}

function taskTone(state: WorkbenchTaskState): Tone {
  if (state === 'running') return 'brand'
  if (state === 'completed') return 'success'
  if (state === 'open') return 'warning'
  return 'neutral'
}

function memberTone(state: MemberWorkState): Tone {
  if (state === 'working') return 'brand'
  if (state === 'error') return 'danger'
  if (state === 'exited' || state === 'stopped') return 'neutral'
  return 'info'
}

function leadStatusLabel(snapshot: TeamWorkbenchSnapshot, t: TranslationFn): string {
  if (snapshot.deletedAt) return t('agentTeams.lead.archived')
  if (snapshot.tasks.length === 0) return t('agentTeams.lead.forming')
  if (snapshot.tasks.every(task => task.status === 'completed')) {
    return t('agentTeams.lead.finishing')
  }
  return t('agentTeams.lead.coordinating')
}

function relatedToMember(message: TeamWorkbenchMessage, member: TeamMember): boolean {
  return memberMatchesIdentity(member, message.from)
    || memberMatchesIdentity(member, message.to)
    || message.recipients.some(recipient => memberMatchesIdentity(member, recipient))
    || message.to === '*'
}

function displayIdentity(
  identity: string,
  snapshot: TeamWorkbenchSnapshot,
  t: TranslationFn,
): string {
  if (identity === '*') return t('agentTeams.communication.everyone')
  return memberName(resolveTeamMemberIdentity(snapshot.team, identity).member)
}

function deriveMemberMessages(
  snapshot: TeamWorkbenchSnapshot,
  member: TeamMember,
  t: TranslationFn,
): MemberMessage[] {
  return snapshot.messages
    .filter(message => relatedToMember(message, member))
    .map((message): MemberMessage => {
      const direction = memberMatchesIdentity(member, message.from) ? 'sent' : 'received'
      const recipient = message.to === '*'
        ? '*'
        : message.recipients[0] ?? message.to
      return {
        message,
        body: parseWorkbenchMessageBody(message),
        direction,
        peerName: direction === 'sent'
          ? displayIdentity(recipient, snapshot, t)
          : displayIdentity(message.from, snapshot, t),
      }
    })
    .reverse()
}

function protocolNarration(
  row: MemberMessage,
  snapshot: TeamWorkbenchSnapshot,
  t: TranslationFn,
): string {
  if (row.body.kind === 'lifecycle') {
    const label = t(`agentTeams.communication.lifecycle.${row.body.type}` as TranslationKey)
    return row.body.detail ? `${label} · ${row.body.detail}` : label
  }
  if (row.body.kind === 'assignment') {
    const taskId = row.body.taskId ?? row.message.taskId
    const name = row.body.selfClaim
      ? displayIdentity(row.message.from, snapshot, t)
      : displayIdentity(row.message.recipients[0] ?? row.message.to, snapshot, t)
    return t(
      row.body.selfClaim
        ? 'agentTeams.communication.taskClaimed'
        : 'agentTeams.communication.taskAssignment',
      {
        task: taskId ? `#${taskId}` : '',
        subject: row.body.subject ?? '',
        name,
      },
    )
  }
  return row.body.text
}

/**
 * Right-hand transcript drawer for one Agent Teams participant. The board
 * remains visible; this panel explains the teammate's serial task history and
 * all communication at the currently selected replay frame.
 */
export function AgentTeamsMemberInspector({
  snapshots,
  selectedIndex,
  snapshot,
  member,
  isLead,
  leadIsStreaming,
  onBack,
  onClose,
  onOpenExecution,
}: AgentTeamsMemberInspectorProps) {
  const t = useTranslation()
  const headingId = useId()
  const name = memberName(member)
  const memberIndex = Math.max(0, snapshot.team.members.findIndex(candidate => (
    memberMatchesIdentity(candidate, member.agentId)
  )))
  const avatarKey = getMemberAvatarKey(member, isLead)
  const accent = memberAccentColor(member.color, memberIndex)
  const workState = snapshot.deletedAt
    ? 'exited'
    : getMemberWorkState(member, { isLead, leadIsStreaming })
  const leadMember = snapshot.team.members.find(candidate => candidate.agentId === snapshot.team.leadAgentId)
  const model = resolveMemberModel(member, isLead ? undefined : leadMember?.model)
  const taskHistory = useMemo(
    () => deriveTaskHistory(snapshots, selectedIndex, snapshot, member),
    [member, selectedIndex, snapshot, snapshots],
  )
  const messages = useMemo(
    () => deriveMemberMessages(snapshot, member, t),
    [member, snapshot, t],
  )
  const completedTasks = taskHistory.filter(entry => entry.state === 'completed').length
  const runningTask = taskHistory.find(entry => entry.state === 'running')?.task
  const blockedTask = taskHistory.find(entry => entry.state === 'blocked')?.task
  const waitingDependency = blockedTask?.blockedBy.find(dependencyId => (
    snapshot.tasks.find(task => task.id === dependencyId)?.status !== 'completed'
  ))
  const currentStatusLabel = isLead
    ? leadStatusLabel(snapshot, t)
    : workState === 'working' && runningTask
      ? t('agentTeams.member.executingTask', { task: runningTask.id })
      : workState === 'idle' && taskHistory.length > 0 && completedTasks === taskHistory.length
        ? t('agentTeams.member.waitingForClose')
        : workState === 'idle' && waitingDependency
          ? t('agentTeams.member.waitingForDependency', { task: waitingDependency })
          : workState === 'idle'
            ? t('agentTeams.member.waitingForTask')
            : t(`agentTeams.member.${workState}` as TranslationKey)

  return (
    <section
      data-testid="agent-teams-member-inspector"
      data-member-id={member.agentId}
      aria-labelledby={headingId}
      className="flex h-full min-h-0 w-full flex-col bg-[var(--color-surface)] text-[var(--color-text-primary)]"
    >
      <header className="shrink-0 border-b border-[var(--color-border)] px-3.5 py-3">
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={<ChevronLeft aria-hidden="true" />}
            onClick={onBack}
          >
            {t('agentTeams.communication.backToFeed')}
          </Button>
          <IconButton
            icon={<ChevronRight aria-hidden="true" />}
            label={t('agentTeams.communication.close')}
            size="sm"
            tone="muted"
            bordered
            onClick={onClose}
          />
        </div>

        <div className="mt-2.5 flex min-w-0 items-center gap-2.5">
          <span className="relative h-11 w-11 shrink-0" data-avatar-key={avatarKey}>
            <img
              src={MEMBER_AVATARS[avatarKey]}
              alt=""
              draggable={false}
              className="h-11 w-11 select-none object-contain drop-shadow-[0_3px_3px_var(--color-border-strong)]"
            />
            <span
              aria-hidden="true"
              className="absolute bottom-0 left-1/2 h-1.5 w-5 -translate-x-1/2 rounded-full border border-[var(--color-surface)]"
              style={{ background: accent }}
            />
          </span>
          <div className="min-w-0">
            <h2 id={headingId} className="truncate font-mono text-[14px] font-extrabold">
              {name}
            </h2>
            <p className="truncate text-[10.5px] text-[var(--color-text-secondary)]">
              {t('agentTeams.inspector.independentContext', { role: member.role })}
            </p>
          </div>
        </div>

        <dl className="mt-3 grid grid-cols-3 gap-4 text-[11.5px]">
          <div className="min-w-0">
            <dt className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">
              {t('agentTeams.inspector.current')}
            </dt>
            <dd className="mt-0.5 flex min-w-0 items-center gap-1.5 font-extrabold">
              <StatusDot tone={memberTone(workState)} pulse={workState === 'working'} />
              <span className="truncate">{currentStatusLabel}</span>
            </dd>
          </div>
          <div>
            <dt className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">
              {t('agentTeams.inspector.completedTasks')}
            </dt>
            <dd className="mt-0.5 font-extrabold tabular-nums">{completedTasks}</dd>
          </div>
          <div>
            <dt className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">
              {t('agentTeams.inspector.messages')}
            </dt>
            <dd className="mt-0.5 font-extrabold tabular-nums">{messages.length}</dd>
          </div>
          {/* Model spans the full width: a model id plus an "inherited from" prefix
              does not fit a third of the drawer, and truncating it would cut the
              model name itself — the one part that matters. */}
          <div className="col-span-3 min-w-0">
            <dt className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">
              {t('agentTeams.model.label')}
            </dt>
            <dd
              className="mt-0.5 truncate font-extrabold"
              title={model?.full}
              data-testid="agent-teams-member-model"
              data-model-inherited={model?.inherited ? 'true' : 'false'}
            >
              {model === undefined
                ? t('agentTeams.model.unknown')
                : model.inherited
                  ? t('agentTeams.model.inheritFromLead', { model: model.full })
                  : model.full}
            </dd>
          </div>
        </dl>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <section
          aria-labelledby={`${headingId}-tasks`}
          className="border-b border-[var(--color-border)] px-3.5 py-3"
        >
          <h3
            id={`${headingId}-tasks`}
            className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--color-text-tertiary)]"
          >
            {t('agentTeams.inspector.taskHistory')}
            <span className="ml-1 normal-case tracking-normal">
              · {t('agentTeams.inspector.taskHistoryHint')}
            </span>
          </h3>
          {taskHistory.length > 0 ? (
            <ol className="mt-2" data-testid="agent-teams-member-task-history">
              {taskHistory.map(entry => {
                const span = formatTaskSpan(entry)
                return (
                  <li
                    key={entry.task.id}
                    data-testid={`agent-teams-member-task-${entry.task.id}`}
                    data-task-state={entry.state}
                    className="flex min-w-0 items-center gap-2 border-b border-[var(--color-border)] py-1.5 last:border-b-0"
                  >
                    <span className="w-[26px] shrink-0 font-mono text-[10px] font-extrabold text-[var(--color-text-tertiary)]">
                      #{entry.task.id}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[11.5px] leading-[1.3]" title={entry.task.subject}>
                      {entry.task.subject}
                    </span>
                    <Badge
                      data-testid={`agent-teams-member-task-${entry.task.id}-state`}
                      tone={taskTone(entry.state)}
                      size="xs"
                      bordered
                    >
                      {t(`agentTeams.task.${entry.state}` as TranslationKey)}
                    </Badge>
                    <time
                      dateTime={entry.startedAt === null ? undefined : new Date(entry.startedAt).toISOString()}
                      className="w-[82px] shrink-0 text-right font-mono text-[9.5px] tabular-nums text-[var(--color-text-tertiary)]"
                    >
                      {span}
                    </time>
                  </li>
                )
              })}
            </ol>
          ) : (
            <p className="mt-2 text-[11px] text-[var(--color-text-tertiary)]">
              {t('agentTeams.noMemberTasks')}
            </p>
          )}
        </section>

        <section aria-labelledby={`${headingId}-messages`} className="px-3.5 py-3">
          <h3
            id={`${headingId}-messages`}
            className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--color-text-tertiary)]"
          >
            {t('agentTeams.inspector.messages')}
          </h3>
          {messages.length > 0 ? (
            <ol className="mt-2" data-testid="agent-teams-member-messages">
              {messages.map(row => {
                const sent = row.direction === 'sent'
                return (
                  <li
                    key={row.message.id}
                    data-testid={`agent-teams-member-message-${row.message.id}`}
                    data-message-direction={row.direction}
                    data-message-body={row.body.kind}
                    className={`mb-2 border-l-2 pb-2 pl-2.5 last:mb-0 ${sent ? 'border-l-[var(--color-brand)]' : 'border-l-[var(--color-tertiary)]'}`}
                  >
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className={`shrink-0 text-[9.5px] font-extrabold ${sent ? 'text-[var(--color-brand)]' : 'text-[var(--color-tertiary)]'}`}>
                        {t(sent ? 'agentTeams.inspector.sent' : 'agentTeams.inspector.received')}
                      </span>
                      {sent
                        ? <ArrowRight size={11} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
                        : <ArrowLeft size={11} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />}
                      <span className="min-w-0 truncate font-mono text-[10px] text-[var(--color-text-tertiary)]">
                        {row.peerName}
                      </span>
                      <time
                        dateTime={row.message.timestamp}
                        className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-[var(--color-text-tertiary)]"
                      >
                        {formatWorkbenchMessageTime(row.message.timestamp)}
                      </time>
                    </div>
                    {row.body.kind === 'text' ? (
                      <MarkdownRenderer
                        content={row.body.text}
                        variant="compact"
                        className="mt-1 text-[12.5px] leading-[1.55] text-[var(--color-text-primary)]"
                      />
                    ) : (
                      <p className="mt-1 text-[11.5px] leading-[1.5] text-[var(--color-text-secondary)]">
                        {protocolNarration(row, snapshot, t)}
                      </p>
                    )}
                  </li>
                )
              })}
            </ol>
          ) : (
            <p className="mt-2 text-[11px] text-[var(--color-text-tertiary)]">
              {t('agentTeams.noMemberMessages')}
            </p>
          )}
        </section>
      </div>

      <footer className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-3">
        <Button variant="primary" size="base" block onClick={onOpenExecution}>
          {t('agentTeams.openExecution', { name })}
        </Button>
      </footer>
    </section>
  )
}
