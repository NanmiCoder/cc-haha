import { useMemo, useState, type CSSProperties } from 'react'
import { useTranslation, type TranslationKey } from '../../i18n'
import type {
  TeamMember,
  TeamWorkbenchMessage,
  TeamWorkbenchSnapshot,
  TeamWorkbenchTask,
} from '../../types/team'
import { MEMBER_AVATARS, memberAccentColor } from './agentTeamsAvatars'
import {
  currentTaskForMember,
  getMemberAvatarKey,
  getMemberWorkState,
  getWorkbenchTaskState,
  inferTaskOwner,
  layoutWorkbenchTasks,
  parseWorkbenchMessageBody,
  resolveMemberModel,
  resolveTeamMemberIdentity,
  taskOwnedByMember,
  type MemberWorkState,
  type PositionedWorkbenchTask,
  type WorkbenchTaskState,
} from './agentTeamsModel'

export type AgentTeamsCanvasProps = {
  snapshots: TeamWorkbenchSnapshot[]
  selectedIndex: number
  snapshot: TeamWorkbenchSnapshot
  previousSnapshot?: TeamWorkbenchSnapshot
  leadIsStreaming: boolean
  activeMessageId: string | null
  focusedTaskId?: string | null
  selectedMemberId?: string | null
  onSelectMember: (member: TeamMember, isLead: boolean) => void
  onSelectTask: (task: TeamWorkbenchTask) => void
}

type TranslationFn = ReturnType<typeof useTranslation>

type MemberPosition = {
  member: TeamMember
  isLead: boolean
  centerX: number
  accent: string
  workState: MemberWorkState
  currentTask?: TeamWorkbenchTask
  completed: number
  total: number
  percent: number
  inbox: number
  recentTasks: TeamWorkbenchTask[]
}

type OwnerVisual = {
  member: TeamMember
  isLead: boolean
  name: string
  avatar: string
  accent: string
  inferred: boolean
}

type FlightRoute = {
  key: string
  path: string
  channel: 'claim' | 'lead' | 'peer'
  color: string
  label: string
}

const CANVAS_MIN_WIDTH = 1280
const FORMATION_TITLE_X = 14
const FORMATION_TITLE_Y = 12
const TASKS_TITLE_Y = 388
const LEAD_TOP = 20
const LEAD_FOOT = 150
const LEAD_BUS_Y = 196
const MEMBER_TOP = 222
const MEMBER_FOOT = 352
const PEER_BUS_Y = 372
const MEMBER_PITCH = 200
const MEMBER_SLOT_WIDTH = 176
const TASK_WIDTH = 200
const TASK_HEIGHT = 92
const LANE_TOP = 410

function aliases(value: string | undefined): string[] {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return []
  const short = normalized.split('@')[0] ?? normalized
  return normalized === short ? [normalized] : [normalized, short]
}

function memberName(member: TeamMember): string {
  return member.name || member.role || member.agentId.split('@')[0] || member.agentId
}

function memberMatches(member: TeamMember, identity: string | undefined): boolean {
  const identityAliases = aliases(identity)
  if (identityAliases.length === 0) return false
  const memberAliases = [
    ...aliases(member.agentId),
    ...aliases(member.name),
  ]
  return identityAliases.some(alias => memberAliases.includes(alias))
}

function isSelectedMember(member: TeamMember, selectedMemberId: string | null | undefined): boolean {
  return memberMatches(member, selectedMemberId ?? undefined)
}

function memberStatusColor(state: MemberWorkState): string {
  if (state === 'error') return 'var(--color-error)'
  if (state === 'working') return 'var(--color-text-primary)'
  if (state === 'exited' || state === 'stopped') return 'var(--color-text-tertiary)'
  return 'var(--color-text-secondary)'
}

function taskStateLabel(state: WorkbenchTaskState, t: TranslationFn): string {
  return t(`agentTeams.task.${state}` as TranslationKey)
}

function memberStateLabel(state: MemberWorkState, t: TranslationFn): string {
  return t(`agentTeams.member.${state}` as TranslationKey)
}

function leadStatusLabel(snapshot: TeamWorkbenchSnapshot, t: TranslationFn): string {
  if (snapshot.deletedAt) return t('agentTeams.lead.archived')
  if (snapshot.tasks.length === 0) return t('agentTeams.lead.forming')
  if (snapshot.tasks.every(task => task.status === 'completed')) {
    return t('agentTeams.lead.finishing')
  }
  return t('agentTeams.lead.coordinating')
}

function taskStateColors(state: WorkbenchTaskState, accent: string) {
  if (state === 'completed') {
    return {
      background: 'var(--color-surface-container-low)',
      border: 'var(--color-border)',
      pillBackground: 'var(--color-success-container)',
      pillForeground: 'var(--color-on-success-container)',
      title: 'var(--color-text-secondary)',
      progress: 'var(--color-success)',
    }
  }
  if (state === 'running') {
    return {
      background: 'var(--color-surface-container-lowest)',
      border: accent,
      pillBackground: 'var(--color-brand-soft)',
      pillForeground: 'var(--color-brand)',
      title: 'var(--color-text-primary)',
      progress: accent,
    }
  }
  if (state === 'open') {
    return {
      background: 'var(--color-surface-container-lowest)',
      border: 'var(--color-outline)',
      pillBackground: 'var(--color-surface-container-high)',
      pillForeground: 'var(--color-text-secondary)',
      title: 'var(--color-text-primary)',
      progress: accent,
    }
  }
  return {
    background: 'var(--color-background)',
    border: 'var(--color-border)',
    pillBackground: 'var(--color-background)',
    pillForeground: 'var(--color-text-tertiary)',
    title: 'var(--color-text-tertiary)',
    progress: accent,
  }
}

function metadataNumber(metadata: Record<string, unknown> | undefined, key: string): number | null {
  const value = metadata?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Only renders determinate work when the task source supplied a real value. */
function taskProgress(task: TeamWorkbenchTask): number | null {
  if (task.status === 'completed') return 100
  if (task.status !== 'in_progress') return 0

  const explicit = metadataNumber(task.metadata, 'progressPercent')
    ?? metadataNumber(task.metadata, 'percentComplete')
    ?? metadataNumber(task.metadata, 'percent')
  if (explicit !== null) return Math.max(0, Math.min(100, explicit))

  const progress = metadataNumber(task.metadata, 'progress')
  if (progress !== null) {
    const normalized = progress >= 0 && progress <= 1 ? progress * 100 : progress
    return Math.max(0, Math.min(100, normalized))
  }

  const completedSteps = metadataNumber(task.metadata, 'completedSteps')
  const totalSteps = metadataNumber(task.metadata, 'totalSteps')
  if (completedSteps !== null && totalSteps !== null && totalSteps > 0) {
    return Math.max(0, Math.min(100, (completedSteps / totalSteps) * 100))
  }
  return null
}

function taskOwnerVisual(
  task: TeamWorkbenchTask,
  snapshot: TeamWorkbenchSnapshot,
  members: TeamMember[],
  fallbackIndex: number,
): OwnerVisual | undefined {
  const attribution = inferTaskOwner(task, snapshot)
  if (!attribution) return undefined
  const { member, isLead } = resolveTeamMemberIdentity(snapshot.team, attribution.identity)
  const memberIndex = members.findIndex(candidate => memberMatches(candidate, member.agentId))
  return {
    member,
    isLead,
    name: memberName(member),
    avatar: MEMBER_AVATARS[getMemberAvatarKey(member, isLead)],
    accent: memberAccentColor(member.color, memberIndex >= 0 ? memberIndex : fallbackIndex),
    inferred: attribution.inferred,
  }
}

function taskBelongsToMember(
  task: TeamWorkbenchTask,
  member: TeamMember,
  snapshot: TeamWorkbenchSnapshot,
): boolean {
  if (taskOwnedByMember(task, member)) return true
  const attribution = inferTaskOwner(task, snapshot)
  return Boolean(attribution && memberMatches(member, attribution.identity))
}

function memberInboxCount(member: TeamMember, messages: TeamWorkbenchMessage[]): number {
  return messages.filter(message => (
    memberMatches(member, message.to) ||
    message.recipients.some(recipient => memberMatches(member, recipient))
  )).length
}

function workState(
  member: TeamMember,
  snapshot: TeamWorkbenchSnapshot,
  isLead: boolean,
  leadIsStreaming: boolean,
): MemberWorkState {
  if (snapshot.deletedAt) return 'exited'
  return getMemberWorkState(member, { isLead, leadIsStreaming })
}

function dependencyChain(taskId: string | null, tasks: TeamWorkbenchTask[]): Set<string> | null {
  if (!taskId) return null
  const byId = new Map(tasks.map(task => [task.id, task]))
  const reverse = new Map<string, string[]>()
  for (const task of tasks) {
    for (const dependencyId of task.blockedBy) {
      const downstream = reverse.get(dependencyId)
      if (downstream) downstream.push(task.id)
      else reverse.set(dependencyId, [task.id])
    }
  }

  const chain = new Set<string>()
  const queue = [taskId]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (chain.has(current)) continue
    chain.add(current)
    const task = byId.get(current)
    if (task) queue.push(...task.blockedBy)
    queue.push(...(reverse.get(current) ?? []))
  }
  return chain
}

function cubicTether(memberX: number, task: PositionedWorkbenchTask): string {
  const taskX = task.x + TASK_WIDTH / 2
  return `M ${memberX},${MEMBER_FOOT} C ${memberX},${MEMBER_FOOT + 70} ${taskX},${task.y - 80} ${taskX},${task.y}`
}

function claimFlightPath(memberX: number, task: PositionedWorkbenchTask): string {
  const taskX = task.x + TASK_WIDTH / 2
  return `M ${taskX},${task.y} C ${taskX},${task.y - 80} ${memberX},${MEMBER_FOOT + 70} ${memberX},${MEMBER_FOOT}`
}

function dependencyPath(from: PositionedWorkbenchTask, to: PositionedWorkbenchTask): string {
  const fromX = from.x + TASK_WIDTH
  const fromY = from.y + TASK_HEIGHT / 2
  const toX = to.x
  const toY = to.y + TASK_HEIGHT / 2
  const middle = fromX + (toX - fromX) / 2
  return `M ${fromX},${fromY} C ${middle},${fromY} ${middle},${toY} ${toX - 5},${toY}`
}

function polylinePath(points: Array<[number, number]>): string {
  return points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'} ${x},${y}`).join(' ')
}

function memberForIdentity(members: MemberPosition[], identity: string | undefined): MemberPosition | undefined {
  return members.find(position => memberMatches(position.member, identity))
}

function semanticFlightLabel(
  message: TeamWorkbenchMessage,
  body: ReturnType<typeof parseWorkbenchMessageBody>,
  sender: MemberPosition,
  recipient: MemberPosition,
  t: TranslationFn,
): string {
  if (body.kind === 'assignment') return t('agentTeams.communication.assignment')
  if (body.kind === 'lifecycle' || message.kind === 'system' || message.protocolType) {
    return t('agentTeams.communication.system')
  }
  if (sender.isLead) return t('agentTeams.communication.assignment')
  if (recipient.isLead || message.kind === 'broadcast') {
    return t('agentTeams.communication.report')
  }
  return t('agentTeams.communication.direct')
}

function flightRouteToRecipient(
  message: TeamWorkbenchMessage | undefined,
  positions: MemberPosition[],
  layoutById: Map<string, PositionedWorkbenchTask>,
  lead: MemberPosition | undefined,
  recipientIdentity: string | undefined,
  t: TranslationFn,
): FlightRoute | null {
  if (!message) return null
  const body = parseWorkbenchMessageBody(message)
  const taskId = body.kind === 'assignment' ? (body.taskId ?? message.taskId) : message.taskId
  const sender = memberForIdentity(positions, message.from)
  const recipient = memberForIdentity(positions, recipientIdentity)

  if (body.kind === 'assignment' && body.selfClaim && taskId && sender && !sender.isLead) {
    const task = layoutById.get(taskId)
    if (!task) return null
    return {
      key: `claim-${sender.member.agentId}-${taskId}`,
      path: claimFlightPath(sender.centerX, task),
      channel: 'claim',
      color: sender.accent,
      label: `#${taskId}`,
    }
  }

  if (lead && sender && recipient && (sender.isLead || recipient.isLead)) {
    const worker = sender.isLead ? recipient : sender
    if (worker.isLead) return null
    const leadToWorker: Array<[number, number]> = [
      [lead.centerX, LEAD_FOOT],
      [lead.centerX, LEAD_BUS_Y],
      [worker.centerX, LEAD_BUS_Y],
      [worker.centerX, MEMBER_TOP],
    ]
    const points = sender.isLead ? leadToWorker : leadToWorker.slice().reverse()
    return {
      key: `lead-${sender.member.agentId}-${recipient.member.agentId}`,
      path: polylinePath(points),
      channel: 'lead',
      color: sender.accent,
      label: semanticFlightLabel(message, body, sender, recipient, t),
    }
  }

  if (sender && recipient && !sender.isLead && !recipient.isLead) {
    return {
      key: `peer-${sender.member.agentId}-${recipient.member.agentId}`,
      path: polylinePath([
        [sender.centerX, MEMBER_FOOT],
        [sender.centerX, PEER_BUS_Y],
        [recipient.centerX, PEER_BUS_Y],
        [recipient.centerX, MEMBER_FOOT],
      ]),
      channel: 'peer',
      color: sender.accent,
      label: semanticFlightLabel(message, body, sender, recipient, t),
    }
  }
  return null
}

function flightRoutes(
  message: TeamWorkbenchMessage | undefined,
  positions: MemberPosition[],
  layoutById: Map<string, PositionedWorkbenchTask>,
  lead: MemberPosition | undefined,
  t: TranslationFn,
): FlightRoute[] {
  if (!message) return []
  const body = parseWorkbenchMessageBody(message)
  if (body.kind === 'assignment' && body.selfClaim) {
    const route = flightRouteToRecipient(
      message,
      positions,
      layoutById,
      lead,
      message.from,
      t,
    )
    return route ? [route] : []
  }

  const isBroadcast = message.kind === 'broadcast' || message.to === '*'
  const explicitRecipients = isBroadcast
    ? message.recipients.filter(identity => identity !== '*')
    : [message.to]
  const recipientPositions = explicitRecipients.length > 0
    ? explicitRecipients
        .map(identity => memberForIdentity(positions, identity))
        .filter((position): position is MemberPosition => Boolean(position))
    : positions.filter(position => !memberMatches(position.member, message.from))
  const uniqueRecipients = Array.from(new Map(
    recipientPositions
      .filter(position => !memberMatches(position.member, message.from))
      .map(position => [position.member.agentId, position]),
  ).values())

  return uniqueRecipients.flatMap((position) => {
    const route = flightRouteToRecipient(
      message,
      positions,
      layoutById,
      lead,
      position.member.agentId,
      t,
    )
    return route ? [route] : []
  })
}

function MemberNode({
  position,
  selected,
  hasActiveMessage,
  waitingDependency,
  leadStatus,
  leadModel,
  onSelect,
  t,
}: {
  position: MemberPosition
  selected: boolean
  hasActiveMessage: boolean
  waitingDependency?: string
  leadStatus?: string
  leadModel?: string
  onSelect: () => void
  t: TranslationFn
}) {
  const { member, isLead, centerX, accent, workState: state } = position
  const model = resolveMemberModel(member, isLead ? undefined : leadModel)
  const top = isLead ? LEAD_TOP : MEMBER_TOP
  const avatarSize = isLead ? 96 : 84
  const identityWidth = isLead ? 28 : 24
  const stateLabel = isLead && leadStatus
    ? leadStatus
    : state === 'working' && position.currentTask
      ? t('agentTeams.member.executingTask', { task: position.currentTask.id })
      : state === 'idle' && !isLead
        ? position.total > 0 && position.completed === position.total
          ? t('agentTeams.member.waitingForClose')
          : waitingDependency
            ? t('agentTeams.member.waitingForDependency', { task: waitingDependency })
            : t('agentTeams.member.waitingForTask')
        : memberStateLabel(state, t)
  const characterClass = state === 'working'
    ? 'agent-teams-character-working'
    : state === 'idle'
      ? 'agent-teams-character-idle'
      : state === 'exited'
        ? 'agent-teams-character-archived'
        : ''

  return (
    <button
      type="button"
      data-testid={`agent-teams-canvas-member-${member.agentId}`}
      data-member-state={state}
      data-avatar-key={getMemberAvatarKey(member, isLead)}
      aria-label={memberName(member)}
      aria-pressed={selected}
      onClick={onSelect}
      className="agent-teams-person absolute z-20 flex w-[176px] cursor-pointer flex-col items-center rounded-[14px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-background)]"
      style={{ left: centerX - MEMBER_SLOT_WIDTH / 2, top }}
    >
      <span className="relative block" style={{ width: avatarSize, height: avatarSize }}>
        <img
          aria-hidden="true"
          alt=""
          draggable={false}
          src={MEMBER_AVATARS[getMemberAvatarKey(member, isLead)]}
          className={`agent-teams-character h-full w-full object-contain drop-shadow-md ${characterClass}`}
        />
        <span
          aria-hidden="true"
          className="absolute bottom-0 left-1/2 h-[6px] -translate-x-1/2 rounded-full border border-[var(--color-surface-container-lowest)]"
          style={{ width: identityWidth, backgroundColor: accent }}
        />
        {hasActiveMessage ? (
          <span
            aria-hidden="true"
            className="agent-teams-member-ring absolute -inset-[6px] rounded-full border-2 border-[var(--color-brand)]"
          />
        ) : null}
        {!isLead && state === 'idle' ? (
          <span
            aria-hidden="true"
            className="agent-teams-zz absolute -right-1 -top-1 text-[9px] font-extrabold text-[var(--color-text-tertiary)]"
          >
            zZ
          </span>
        ) : null}
      </span>

      <span
        className="mt-0.5 flex max-w-[168px] items-center gap-1.5 overflow-hidden rounded-[14px] border bg-[var(--color-surface-container-lowest)] px-2.5 py-1 shadow-[var(--shadow-card)]"
        style={{ borderColor: selected ? 'var(--color-brand)' : 'var(--color-border)' }}
      >
        <span className="truncate font-mono text-[10.5px] font-extrabold text-[var(--color-text-primary)]">
          {memberName(member)}
        </span>
        {model ? (
          <span
            className="max-w-[54px] shrink-0 truncate rounded-full border border-[var(--color-border)] px-1.5 py-px text-[9px] font-extrabold text-[var(--color-text-tertiary)]"
            title={model.full}
            data-testid={`agent-teams-canvas-member-model-${member.agentId}`}
            data-model-inherited={model.inherited ? 'true' : 'false'}
          >
            {model.label}
          </span>
        ) : null}
        {isLead ? (
          <span className="shrink-0 rounded-full border border-[var(--color-brand)] bg-[var(--color-brand-soft)] px-1.5 py-px text-[9px] font-extrabold text-[var(--color-brand)]">
            {t('agentTeams.leader')}
          </span>
        ) : null}
      </span>

      <span
        className="mt-1 flex max-w-[172px] items-center gap-1.5 text-[10.5px] font-semibold"
        style={{ color: isLead ? 'var(--color-text-secondary)' : memberStatusColor(state) }}
      >
        {!isLead ? (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: state === 'working' ? accent : memberStatusColor(state) }}
          />
        ) : null}
        <span className="truncate">{stateLabel}</span>
        {isLead ? (
          <span className="shrink-0 text-[var(--color-text-tertiary)]">
            · {t('agentTeams.member.inbox', { count: position.inbox })}
          </span>
        ) : null}
      </span>

      {!isLead ? (
        <>
          <span className="mt-1.5 block h-1 w-[150px] overflow-hidden rounded-full bg-[var(--color-surface-container-high)]">
            <span className="block h-full rounded-full" style={{ width: `${position.percent}%`, backgroundColor: accent }} />
          </span>
          <span className="mt-1.5 flex max-w-[172px] items-center justify-center gap-1 overflow-hidden">
            {position.recentTasks.map(task => (
              <span
                key={task.id}
                className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-container-high)] px-1.5 py-px font-mono text-[9px] font-extrabold text-[var(--color-text-secondary)]"
              >
                #{task.id}
              </span>
            ))}
          </span>
        </>
      ) : null}
    </button>
  )
}

function TaskCard({
  positioned,
  snapshot,
  members,
  focused,
  dimmed,
  justUnlocked,
  onHover,
  onHoverEnd,
  onFocus,
  onBlur,
  onSelect,
  t,
}: {
  positioned: PositionedWorkbenchTask
  snapshot: TeamWorkbenchSnapshot
  members: TeamMember[]
  focused: boolean
  dimmed: boolean
  justUnlocked: boolean
  onHover: () => void
  onHoverEnd: () => void
  onFocus: () => void
  onBlur: () => void
  onSelect: () => void
  t: TranslationFn
}) {
  const { task, state, depth, x, y } = positioned
  const owner = taskOwnerVisual(task, snapshot, members, depth)
  const accent = owner?.accent ?? 'var(--color-brand)'
  const colors = taskStateColors(state, accent)
  const progress = taskProgress(task)
  const dependencies = task.blockedBy.map(id => `#${id}`).join(' ')
  const ownerLabel = owner
    ? owner.inferred
      ? t('agentTeams.task.inferredOwner', { name: owner.name })
      : owner.name
    : task.status === 'completed'
      ? t('agentTeams.task.completedNoOwner')
      : t('agentTeams.task.unclaimed')

  return (
    <button
      type="button"
      data-testid={`agent-teams-canvas-task-${task.id}`}
      data-state={state}
      data-depth={depth}
      data-chain-active={focused ? 'true' : 'false'}
      aria-label={`${task.subject}, ${taskStateLabel(state, t)}`}
      onClick={onSelect}
      onMouseEnter={onHover}
      onMouseLeave={onHoverEnd}
      onFocus={onFocus}
      onBlur={onBlur}
      className={`agent-teams-task absolute z-20 flex h-[92px] w-[200px] cursor-pointer flex-col gap-[5px] rounded-[10px] border p-[9px_10px] text-left shadow-none outline-none transition-[opacity,border-color,box-shadow,transform] hover:-translate-y-px hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-card)] focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-background)] active:translate-y-0 ${justUnlocked ? 'agent-teams-unlocked' : ''}`}
      style={{
        left: x,
        top: y,
        backgroundColor: colors.background,
        borderColor: justUnlocked ? 'var(--color-success)' : colors.border,
        opacity: dimmed ? 0.34 : state === 'blocked' ? 0.72 : 1,
      }}
    >
      <span className="flex items-center justify-between gap-1.5">
        <span data-task-id={task.id} className="shrink-0 font-mono text-[10px] font-extrabold text-[var(--color-text-tertiary)]">
          #{task.id}
        </span>
        <span
          className="shrink-0 rounded-full border px-1.5 py-px text-[9.5px] font-extrabold"
          style={{
            backgroundColor: justUnlocked ? 'var(--color-success-container)' : colors.pillBackground,
            borderColor: justUnlocked ? 'var(--color-success)' : colors.border,
            color: justUnlocked ? 'var(--color-on-success-container)' : colors.pillForeground,
          }}
        >
          {justUnlocked ? t('agentTeams.task.unlocked') : taskStateLabel(state, t)}
        </span>
      </span>

      <span className="line-clamp-2 min-h-0 flex-1 text-[12px] font-medium leading-[1.35]" style={{ color: colors.title }}>
        {task.subject}
      </span>

      <span className="flex min-w-0 items-center gap-1.5">
        {owner ? (
          <img aria-hidden="true" alt="" src={owner.avatar} className="h-5 w-5 shrink-0 object-contain" />
        ) : (
          <span aria-hidden="true" className="h-5 w-5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[9.5px] font-bold text-[var(--color-text-secondary)]" title={owner?.inferred ? t('agentTeams.task.reconstructedOwner') : undefined}>
          {ownerLabel}
        </span>
        <span className="shrink-0 whitespace-nowrap font-mono text-[9.5px] text-[var(--color-text-tertiary)]">
          {dependencies
            ? state === 'blocked'
              ? `${t('agentTeams.task.dependsOn')} ${dependencies}`
              : `← ${dependencies}`
            : t('agentTeams.task.start')}
        </span>
      </span>

      <span
        className="block h-[3px] overflow-hidden rounded-full"
        style={{
          backgroundColor: state === 'blocked'
            ? 'transparent'
            : 'var(--color-surface-container-high)',
        }}
      >
        {progress === null ? (
          <span
            data-progress="indeterminate"
            className="agent-teams-task-running-fill block h-full rounded-full"
            style={{ backgroundColor: colors.progress }}
          />
        ) : (
          <span
            data-progress={Math.round(progress)}
            className="block h-full rounded-full"
            style={{ width: `${progress}%`, backgroundColor: colors.progress }}
          />
        )}
      </span>
    </button>
  )
}

export function AgentTeamsCanvas({
  snapshots,
  selectedIndex,
  snapshot,
  previousSnapshot,
  leadIsStreaming,
  activeMessageId,
  focusedTaskId: externallyFocusedTaskId,
  selectedMemberId,
  onSelectMember,
  onSelectTask,
}: AgentTeamsCanvasProps) {
  const t = useTranslation()
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null)
  const [keyboardFocusedTaskId, setKeyboardFocusedTaskId] = useState<string | null>(null)
  const uniqueMembers = useMemo(
    () => Array.from(new Map(snapshot.team.members.map(member => [member.agentId, member])).values()),
    [snapshot.team.members],
  )
  const leadMember = uniqueMembers.find(member => member.agentId === snapshot.team.leadAgentId)
    ?? uniqueMembers.find(member => aliases(member.name).includes('team-lead'))
    ?? uniqueMembers[0]
  const leadModel = leadMember?.model
  const workers = uniqueMembers.filter(member => member !== leadMember)
  const naturalWidth = Math.max(CANVAS_MIN_WIDTH, 460 + Math.max(0, workers.length - 1) * MEMBER_PITCH)
  const layout = useMemo(
    () => layoutWorkbenchTasks(snapshot.tasks, naturalWidth),
    [naturalWidth, snapshot.tasks],
  )
  const timeline = snapshots.length > 0 ? snapshots : [snapshot]
  const timelineIndex = snapshots.length > 0
    ? Math.max(0, Math.min(selectedIndex, snapshots.length - 1))
    : 0
  const membersByPosition = useMemo(() => {
    const result: MemberPosition[] = []
    const leadCenter = layout.width / 2
    const workerStart = leadCenter - Math.max(0, workers.length - 1) * MEMBER_PITCH / 2
    const addMember = (member: TeamMember, isLead: boolean, centerX: number, index: number) => {
      const ownedTasks = snapshot.tasks.filter(task => taskBelongsToMember(task, member, snapshot))
      const completed = ownedTasks.filter(task => task.status === 'completed').length
      const current = isLead
        ? undefined
        : currentTaskForMember(timeline, timelineIndex, member)
      const currentTask = current ? snapshot.tasks.find(task => task.id === current.id) ?? current : undefined
      result.push({
        member,
        isLead,
        centerX,
        accent: memberAccentColor(member.color, index),
        workState: workState(member, snapshot, isLead, leadIsStreaming),
        currentTask,
        completed,
        total: ownedTasks.length,
        percent: ownedTasks.length === 0 ? 0 : Math.round((completed / ownedTasks.length) * 100),
        inbox: memberInboxCount(member, snapshot.messages),
        recentTasks: ownedTasks.filter(task => task.status !== 'pending').slice(-4),
      })
    }

    if (leadMember) addMember(leadMember, true, leadCenter, uniqueMembers.indexOf(leadMember))
    workers.forEach((member, index) => addMember(member, false, workerStart + index * MEMBER_PITCH, uniqueMembers.indexOf(member)))
    return result
  }, [
    layout.width,
    leadIsStreaming,
    leadMember,
    snapshot,
    timeline,
    timelineIndex,
    uniqueMembers,
    workers,
  ])
  const leadPosition = membersByPosition.find(position => position.isLead)
  const workerPositions = membersByPosition.filter(position => !position.isLead)
  const focusedTaskId = hoveredTaskId ?? keyboardFocusedTaskId ?? externallyFocusedTaskId ?? null
  const focusedChain = useMemo(
    () => dependencyChain(focusedTaskId, snapshot.tasks),
    [focusedTaskId, snapshot.tasks],
  )
  const previousTasksById = useMemo(
    () => new Map(previousSnapshot?.tasks.map(task => [task.id, task]) ?? []),
    [previousSnapshot],
  )
  const previousStatesById = useMemo(() => {
    const states = new Map<string, WorkbenchTaskState>()
    for (const task of previousSnapshot?.tasks ?? []) {
      states.set(task.id, getWorkbenchTaskState(task, previousTasksById))
    }
    return states
  }, [previousSnapshot, previousTasksById])
  const justUnlockedIds = useMemo(() => new Set(layout.tasks
    .filter(positioned => (
      previousStatesById.get(positioned.task.id) === 'blocked' && positioned.state === 'open'
    ))
    .map(positioned => positioned.task.id)), [layout.tasks, previousStatesById])
  const activeMessage = activeMessageId
    ? snapshot.messages.find(message => message.id === activeMessageId)
    : undefined
  const routes = flightRoutes(activeMessage, membersByPosition, layout.byId, leadPosition, t)
  const activeParticipants = new Set<string>()
  if (activeMessage) {
    const broadcastsToAll = (activeMessage.kind === 'broadcast' || activeMessage.to === '*') &&
      activeMessage.recipients.every(recipient => recipient === '*')
    for (const position of membersByPosition) {
      if (
        broadcastsToAll ||
        memberMatches(position.member, activeMessage.from) ||
        memberMatches(position.member, activeMessage.to) ||
        activeMessage.recipients.some(recipient => memberMatches(position.member, recipient))
      ) {
        activeParticipants.add(position.member.agentId)
      }
    }
  }
  const maxDepth = Math.max(0, ...layout.lanes.map(lane => lane.depth))
  const activeTethers = workerPositions
    .filter(position => (
      position.workState === 'working' &&
      position.currentTask?.status === 'in_progress' &&
      layout.byId.has(position.currentTask.id)
    ))

  return (
    <div
      data-testid="agent-teams-canvas-viewport"
      className="h-full min-h-0 min-w-0 overflow-auto bg-[var(--color-background)] text-[var(--color-text-primary)]"
    >
      <div
        data-testid="agent-teams-canvas"
        className="relative"
        style={{ width: layout.width, minWidth: naturalWidth, height: layout.height }}
      >
        <div
          data-testid="agent-teams-formation-layer"
          role="group"
          aria-label={t('agentTeams.canvas.formation')}
          className="pointer-events-none absolute inset-x-0 top-0 h-[388px]"
        />
        <div
          data-testid="agent-teams-task-layer"
          role="group"
          aria-label={t('agentTeams.canvas.tasks')}
          className="pointer-events-none absolute inset-x-0"
          style={{ top: TASKS_TITLE_Y, height: layout.height - TASKS_TITLE_Y }}
        />

        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-0"
          width={layout.width}
          height={layout.height}
        >
          {layout.lanes.map((lane, index) => (
            <g key={lane.depth} data-testid={`agent-teams-canvas-lane-${lane.depth}`}>
              <rect
                x={lane.x}
                y={lane.y}
                width={lane.width}
                height={lane.height}
                rx={14}
                fill={index % 2 === 0 ? 'var(--color-surface-container-low)' : 'var(--color-surface-container-high)'}
                fillOpacity={0.62}
                stroke="var(--color-outline)"
              />
              <path
                d={`M ${lane.x + 12},436 L ${lane.x + lane.width - 12},436`}
                stroke="var(--color-outline)"
              />
            </g>
          ))}

          {leadPosition && workerPositions.length > 0 ? (
            <g data-channel="lead">
              <path
                d={`M ${leadPosition.centerX},${LEAD_FOOT} L ${leadPosition.centerX},${LEAD_BUS_Y}`}
                fill="none"
                stroke="var(--color-border)"
                strokeWidth={2}
                strokeDasharray="6 6"
              />
              <path
                d={`M ${workerPositions[0]!.centerX},${LEAD_BUS_Y} L ${workerPositions.at(-1)!.centerX},${LEAD_BUS_Y}`}
                fill="none"
                stroke="var(--color-border)"
                strokeWidth={2}
                strokeDasharray="6 6"
              />
              {workerPositions.map(position => (
                <path
                  key={position.member.agentId}
                  d={`M ${position.centerX},${LEAD_BUS_Y} L ${position.centerX},${MEMBER_TOP}`}
                  fill="none"
                  stroke="var(--color-outline)"
                  strokeWidth={2}
                  strokeDasharray="6 6"
                />
              ))}
            </g>
          ) : null}

          {workerPositions.length > 0 ? (
            <g data-channel="peer">
              <path
                d={`M ${workerPositions[0]!.centerX},${MEMBER_FOOT} L ${workerPositions[0]!.centerX},${PEER_BUS_Y} L ${workerPositions.at(-1)!.centerX},${PEER_BUS_Y} L ${workerPositions.at(-1)!.centerX},${MEMBER_FOOT}`}
                fill="none"
                stroke="var(--color-border)"
                strokeWidth={2}
                strokeDasharray="4 7"
              />
              {workerPositions.slice(1, -1).map(position => (
                <path
                  key={position.member.agentId}
                  d={`M ${position.centerX},${MEMBER_FOOT} L ${position.centerX},${PEER_BUS_Y}`}
                  fill="none"
                  stroke="var(--color-border)"
                  strokeWidth={2}
                  strokeDasharray="4 7"
                />
              ))}
            </g>
          ) : null}

          {layout.tasks.flatMap(to => to.task.blockedBy.map(dependencyId => {
            const from = layout.byId.get(dependencyId)
            if (!from) return null
            const satisfied = from.task.status === 'completed'
            const justCompleted = satisfied && previousTasksById.get(dependencyId)?.status !== 'completed'
            const fresh = justCompleted || justUnlockedIds.has(to.task.id)
            const owner = taskOwnerVisual(from.task, snapshot, uniqueMembers, from.depth)
            const related = !focusedChain || (focusedChain.has(from.task.id) && focusedChain.has(to.task.id))
            return (
              <g key={`${dependencyId}-${to.task.id}`}>
                <path
                  data-testid={`agent-teams-canvas-edge-${dependencyId}-${to.task.id}`}
                  data-edge-satisfied={satisfied ? 'true' : 'false'}
                  data-edge-fresh={fresh ? 'true' : 'false'}
                  data-edge-active={focusedChain && related ? 'true' : 'false'}
                  d={dependencyPath(from, to)}
                  fill="none"
                  stroke={fresh ? 'var(--color-success)' : satisfied ? owner?.accent ?? 'var(--color-brand)' : 'var(--color-border)'}
                  strokeWidth={fresh ? 3 : focusedChain && related ? 2.5 : 2}
                  strokeDasharray="7 7"
                  opacity={related ? (satisfied ? 0.95 : 0.8) : 0.2}
                  className={`${satisfied ? 'agent-teams-flow' : ''} ${fresh ? 'agent-teams-unlocked' : ''}`}
                />
                <circle
                  cx={to.x - 4}
                  cy={to.y + TASK_HEIGHT / 2}
                  r={3.2}
                  fill={fresh ? 'var(--color-success)' : satisfied ? owner?.accent ?? 'var(--color-brand)' : 'var(--color-border)'}
                  opacity={related ? 1 : 0.2}
                />
              </g>
            )
          }))}

          {activeTethers.map(position => {
            const task = layout.byId.get(position.currentTask!.id)!
            return (
              <path
                key={position.member.agentId}
                data-testid={`agent-teams-canvas-tether-${position.member.agentId}`}
                data-task-id={task.task.id}
                d={cubicTether(position.centerX, task)}
                fill="none"
                stroke={position.accent}
                strokeWidth={2.5}
                strokeDasharray="8 6"
                opacity={0.95}
                className="agent-teams-flow"
              />
            )
          })}

          {routes.map(route => (
            <path
              key={route.key}
              data-testid="agent-teams-active-flight-path"
              data-flight-channel={route.channel}
              d={route.path}
              fill="none"
              stroke={route.color}
              strokeWidth={2.5}
              strokeDasharray="7 7"
              className="agent-teams-flow"
            />
          ))}
        </svg>

        <div
          className="absolute z-10 whitespace-nowrap text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]"
          style={{ left: FORMATION_TITLE_X, top: FORMATION_TITLE_Y }}
        >
          {t('agentTeams.canvas.formation')}
        </div>
        <div
          className="absolute z-10 whitespace-nowrap text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]"
          style={{ left: FORMATION_TITLE_X, top: TASKS_TITLE_Y }}
        >
          {t('agentTeams.canvas.tasks')}
        </div>

        {layout.lanes.map(lane => {
          const tasks = layout.tasks.filter(task => task.depth === lane.depth)
          const completed = tasks.filter(task => task.state === 'completed').length
          const title = lane.depth === 0
            ? t('agentTeams.canvas.laneRoot')
            : lane.depth === maxDepth
              ? t('agentTeams.canvas.laneWrapUp')
              : t('agentTeams.canvas.laneDepth', { layer: lane.depth + 1 })
          return (
            <div
              key={lane.depth}
              className="absolute z-10 flex items-center justify-between px-3"
              style={{ left: lane.x, top: LANE_TOP + 8, width: lane.width }}
            >
              <span className="truncate text-[10px] font-extrabold uppercase tracking-[0.1em] text-[var(--color-text-secondary)]">
                {title}
              </span>
              <span className="shrink-0 font-mono text-[10px] font-bold text-[var(--color-text-tertiary)]">
                {completed}/{lane.count}
              </span>
            </div>
          )
        })}

        {membersByPosition.map(position => {
          const blockedTask = position.isLead
            ? undefined
            : snapshot.tasks.find(task => (
              taskBelongsToMember(task, position.member, snapshot) &&
              getWorkbenchTaskState(task, new Map(snapshot.tasks.map(entry => [entry.id, entry]))) === 'blocked'
            ))
          const waitingDependency = blockedTask?.blockedBy.find(id => snapshot.tasks.find(task => task.id === id)?.status !== 'completed')
          return (
            <MemberNode
              key={position.member.agentId}
              position={position}
              selected={isSelectedMember(position.member, selectedMemberId)}
              hasActiveMessage={activeParticipants.has(position.member.agentId)}
              waitingDependency={waitingDependency}
              leadStatus={position.isLead ? leadStatusLabel(snapshot, t) : undefined}
              leadModel={leadModel}
              onSelect={() => onSelectMember(position.member, position.isLead)}
              t={t}
            />
          )
        })}

        {layout.tasks.map(positioned => (
          <TaskCard
            key={positioned.task.id}
            positioned={positioned}
            snapshot={snapshot}
            members={uniqueMembers}
            focused={Boolean(focusedChain?.has(positioned.task.id))}
            dimmed={Boolean(focusedChain && !focusedChain.has(positioned.task.id))}
            justUnlocked={justUnlockedIds.has(positioned.task.id)}
            onHover={() => setHoveredTaskId(positioned.task.id)}
            onHoverEnd={() => setHoveredTaskId(current => current === positioned.task.id ? null : current)}
            onFocus={() => setKeyboardFocusedTaskId(positioned.task.id)}
            onBlur={() => setKeyboardFocusedTaskId(current => current === positioned.task.id ? null : current)}
            onSelect={() => onSelectTask(positioned.task)}
            t={t}
          />
        ))}

        {routes.map(route => (
          <div
            key={route.key}
            aria-hidden="true"
            data-testid="agent-teams-active-flight"
            data-flight-channel={route.channel}
            className="agent-teams-flight pointer-events-none absolute z-30 flex items-center gap-1.5 whitespace-nowrap rounded-full border-[1.5px] bg-[var(--color-surface-container-lowest)] px-2 py-1 shadow-[var(--shadow-card)]"
            style={{
              borderColor: route.color,
              color: route.color,
              offsetPath: `path('${route.path}')`,
              offsetDistance: '50%',
              offsetRotate: '0deg',
            } as CSSProperties}
          >
            <span className="h-[7px] w-[7px] rounded-full" style={{ backgroundColor: route.color }} />
            <span className="font-mono text-[10px] font-extrabold">{route.label}</span>
          </div>
        ))}

        <div
          data-testid="agent-teams-legend"
          className="absolute z-10 flex items-center gap-[22px] whitespace-nowrap text-[10.5px] font-semibold text-[var(--color-text-secondary)]"
          style={{ left: 32, top: layout.legendY }}
        >
          <span className="flex items-center gap-1.5">
            <svg aria-hidden="true" width="26" height="6"><path d="M 0,3 L 26,3" stroke="var(--color-border)" strokeWidth="2" strokeDasharray="7 7" /></svg>
            {t('agentTeams.legend.unmet')}
          </span>
          <span className="flex items-center gap-1.5">
            <svg aria-hidden="true" width="26" height="6"><path d="M 0,3 L 26,3" stroke="var(--color-brand)" strokeWidth="2" strokeDasharray="7 7" className="agent-teams-flow" /></svg>
            {t('agentTeams.legend.satisfied')}
          </span>
          <span className="flex items-center gap-1.5">
            <svg aria-hidden="true" width="26" height="6"><path d="M 0,3 L 26,3" stroke="var(--color-info)" strokeWidth="2.5" strokeDasharray="8 6" className="agent-teams-flow" /></svg>
            {t('agentTeams.legend.tether')}
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-[var(--color-success)]" />
            {t('agentTeams.legend.unlocked')}
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-4 w-4 rounded-full border-[1.5px] border-[var(--color-brand)]" />
            {t('agentTeams.legend.flight')}
          </span>
        </div>
      </div>
    </div>
  )
}
