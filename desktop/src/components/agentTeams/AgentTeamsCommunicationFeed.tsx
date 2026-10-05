import { useMemo, useState } from 'react'
import { ArrowRight, Megaphone, MessageSquare, Settings2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { useTranslation, type TranslationKey } from '../../i18n'
import type { TeamMember, TeamWorkbenchMessage, TeamWorkbenchSnapshot } from '../../types/team'
import { MEMBER_AVATARS, memberAccentColor } from './agentTeamsAvatars'
import {
  formatWorkbenchMessageTime,
  getMemberAvatarKey,
  parseWorkbenchMessageBody,
  resolveTeamMemberIdentity,
  type MemberAvatarKey,
  type WorkbenchMessageBody,
} from './agentTeamsModel'

type TranslationFn = ReturnType<typeof useTranslation>
type FeedCategory = 'assignment' | 'peer' | 'report' | 'system'
type FeedFilter = 'all' | FeedCategory

/** Beyond this the body collapses behind a "show more" toggle. */
const COLLAPSED_BODY_CHARS = 260

type ParsedMessageRow = {
  message: TeamWorkbenchMessage
  body: WorkbenchMessageBody
  category: FeedCategory
}

type MessageParticipant = {
  member: TeamMember
  avatarKey: MemberAvatarKey
  accent: string
}

function resolveParticipant(
  value: string,
  snapshot: TeamWorkbenchSnapshot,
  fallbackIndex: number,
): MessageParticipant {
  const { member, isLead } = resolveTeamMemberIdentity(snapshot.team, value)

  return {
    member,
    avatarKey: getMemberAvatarKey(member, isLead),
    accent: memberAccentColor(member.color, fallbackIndex),
  }
}

function isLeadIdentity(value: string, snapshot: TeamWorkbenchSnapshot): boolean {
  if (!value || value === '*') return false
  return resolveTeamMemberIdentity(snapshot.team, value).isLead
}

/**
 * CLI transport kinds describe how an envelope moved, not what the team was
 * doing. Derive the v2 communication groups from parsed protocol bodies and
 * the actual route while accepting both bare names and `name@team` ids.
 */
function classifyMessage(
  message: TeamWorkbenchMessage,
  body: WorkbenchMessageBody,
  snapshot: TeamWorkbenchSnapshot,
): FeedCategory {
  if (body.kind === 'assignment') return body.selfClaim ? 'system' : 'assignment'
  if (body.kind === 'lifecycle') return 'system'
  if (message.protocolType || message.kind === 'system') return 'system'

  const senderIsLead = isLeadIdentity(message.from, snapshot)
  if (message.kind === 'broadcast') return senderIsLead ? 'assignment' : 'report'

  const recipients = Array.from(new Set([message.to, ...message.recipients])).filter(Boolean)
  const targetsLead = recipients.some((recipient) => isLeadIdentity(recipient, snapshot))
  const targetsMember = recipients.some((recipient) => !isLeadIdentity(recipient, snapshot))

  if (senderIsLead && targetsMember) return 'assignment'
  if (!senderIsLead && targetsLead) return 'report'
  if (message.kind === 'direct') return 'peer'
  return 'system'
}

function transportIcon(kind: TeamWorkbenchMessage['kind']): LucideIcon {
  if (kind === 'broadcast') return Megaphone
  if (kind === 'direct') return MessageSquare
  return Settings2
}

function categoryLabel(category: FeedCategory, t: TranslationFn): string {
  if (category === 'assignment') return t('agentTeams.communication.assignment')
  if (category === 'peer') return t('agentTeams.communication.peer')
  if (category === 'report') return t('agentTeams.communication.report')
  return t('agentTeams.communication.system')
}

function categoryTagClass(category: FeedCategory): string {
  if (category === 'assignment') {
    return 'border-transparent bg-[var(--color-info-container)] text-[var(--color-on-info-container)]'
  }
  if (category === 'peer') {
    return 'border-[var(--color-memory-border)] bg-[var(--color-tertiary-container)] text-[var(--color-tertiary)]'
  }
  if (category === 'system') {
    return 'border-transparent bg-[var(--color-surface-container)] text-[var(--color-text-secondary)]'
  }
  return 'border-[var(--color-outline)] bg-[var(--color-surface-container-lowest)] text-[var(--color-text-secondary)]'
}

function categoryAccent(category: FeedCategory): string {
  if (category === 'assignment') return 'var(--color-info)'
  if (category === 'peer') return 'var(--color-tertiary)'
  if (category === 'system') return 'var(--color-text-tertiary)'
  return 'var(--color-text-secondary)'
}

function lifecycleNarration(
  body: Extract<WorkbenchMessageBody, { kind: 'lifecycle' }>,
  t: TranslationFn,
): string {
  const narration = t(`agentTeams.communication.lifecycle.${body.type}` as TranslationKey)
  return body.detail ? `${narration} · ${body.detail}` : narration
}

/** Picking work up and being handed it are different events, so they read differently. */
function assignmentNarration(
  body: Extract<WorkbenchMessageBody, { kind: 'assignment' }>,
  message: TeamWorkbenchMessage,
  t: TranslationFn,
): string {
  const taskId = body.taskId ?? message.taskId
  return t(
    body.selfClaim
      ? 'agentTeams.communication.taskClaimed'
      : 'agentTeams.communication.taskAssignment',
    {
      task: taskId ? `#${taskId}` : '',
      subject: body.subject ?? '',
      name: body.selfClaim ? message.from : (message.recipients[0] ?? message.to),
    },
  )
}

function readableSystemText(
  body: Extract<WorkbenchMessageBody, { kind: 'text' }>,
  t: TranslationFn,
): string {
  const text = body.text.trim()
  if (!text.startsWith('{') || !text.endsWith('}')) return text
  return t('agentTeams.communication.system')
}

export function AgentTeamsCommunicationFeed({
  snapshot,
  fill = false,
  onFocusTask,
}: {
  snapshot: TeamWorkbenchSnapshot
  /** Full-height layouts let the feed own its column instead of a fixed strip. */
  fill?: boolean
  /** Lights up the task a row is about on the map, reusing its focus channel. */
  onFocusTask?: (taskId: string | null) => void
}) {
  const t = useTranslation()
  const [filter, setFilter] = useState<FeedFilter>('all')

  const rows = useMemo(() => snapshot.messages
    .map((message): ParsedMessageRow => {
      const body = parseWorkbenchMessageBody(message)
      return {
        message,
        body,
        category: classifyMessage(message, body, snapshot),
      }
    })
    .reverse(), [snapshot])
  const categoryCounts = useMemo(() => rows.reduce<Record<FeedCategory, number>>(
    (counts, row) => {
      counts[row.category] += 1
      return counts
    },
    { assignment: 0, peer: 0, report: 0, system: 0 },
  ), [rows])
  const filters: Array<{ key: FeedFilter; label: string; count: number }> = [
    { key: 'all', label: t('agentTeams.communication.all'), count: rows.length },
    { key: 'assignment', label: categoryLabel('assignment', t), count: categoryCounts.assignment },
    { key: 'peer', label: categoryLabel('peer', t), count: categoryCounts.peer },
    { key: 'report', label: categoryLabel('report', t), count: categoryCounts.report },
    { key: 'system', label: categoryLabel('system', t), count: categoryCounts.system },
  ]
  const filteredRows = filter === 'all'
    ? rows
    : rows.filter(({ category }) => category === filter)

  // A teammate waiting for work repeats the same idle notice every few seconds.
  // Keep the newest signal and fold adjacent duplicates into its repeat count.
  const visibleRows = useMemo(() => {
    const collapsed: Array<ParsedMessageRow & { repeats: number }> = []
    for (const row of filteredRows) {
      const previous = collapsed[collapsed.length - 1]
      if (
        previous &&
        previous.body.kind === 'lifecycle' &&
        row.body.kind === 'lifecycle' &&
        previous.body.type === row.body.type &&
        previous.message.from === row.message.from
      ) {
        previous.repeats += 1
        continue
      }
      collapsed.push({ ...row, repeats: 1 })
    }
    return collapsed
  }, [filteredRows])

  return (
    <section
      data-testid="agent-teams-communication"
      className={[
        'flex min-h-0 flex-col border-[var(--color-border)] bg-[var(--color-surface)]',
        fill
          ? 'h-full w-full min-w-0'
          : 'h-[240px] shrink-0 border-t',
      ].join(' ')}
    >
      <div className="shrink-0 border-b border-[var(--color-border)] px-3.5 py-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <h3 className="text-[15px] font-semibold tracking-[-0.2px]">
            {t('agentTeams.communication.title')}
          </h3>
          <span
            data-testid="agent-teams-message-count"
            className="font-mono text-[12px] tabular-nums text-[var(--color-text-tertiary)]"
          >
            {t('agentTeams.communication.count', { count: rows.length })}
          </span>
        </div>

        <div
          role="group"
          aria-label={t('agentTeams.communication.title')}
          className="mt-2.5 flex min-w-0 flex-wrap items-center gap-1.5"
        >
          {filters.map((option) => {
            const selected = filter === option.key
            return (
              <button
                key={option.key}
                type="button"
                data-testid={`agent-teams-filter-${option.key}`}
                data-count={option.count}
                aria-pressed={selected}
                onClick={() => setFilter(option.key)}
                className={[
                  'inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold outline-none transition-[transform,background-color,border-color,color] duration-200 focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] active:scale-[0.98]',
                  selected
                    ? 'border-[var(--color-text-primary)] bg-[var(--color-text-primary)] text-[var(--color-surface)]'
                    : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]',
                ].join(' ')}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {visibleRows.length === 0 ? (
          <div className="flex min-h-28 items-center justify-center px-6 text-center text-[11px] leading-5 text-[var(--color-text-tertiary)]">
            {t('agentTeams.communication.empty')}
          </div>
        ) : (
          <div className="divide-y divide-[var(--color-border)]">
            {visibleRows.map(({ message, body, category, repeats }, index) => (
              <FeedRow
                key={message.id}
                message={message}
                body={body}
                category={category}
                repeats={repeats}
                isLatest={index === 0}
                snapshot={snapshot}
                onFocusTask={onFocusTask}
                t={t}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function FeedRow({
  message,
  body,
  category,
  repeats,
  isLatest,
  snapshot,
  onFocusTask,
  t,
}: {
  message: TeamWorkbenchMessage
  body: WorkbenchMessageBody
  category: FeedCategory
  /** How many identical signals in a row this one stands for. */
  repeats: number
  isLatest: boolean
  snapshot: TeamWorkbenchSnapshot
  onFocusTask?: (taskId: string | null) => void
  t: TranslationFn
}) {
  const [expanded, setExpanded] = useState(false)
  const focusedTaskId = (body.kind === 'assignment' ? body.taskId : undefined) ?? message.taskId
  const time = formatWorkbenchMessageTime(message.timestamp)
  const text = body.kind === 'lifecycle'
    ? lifecycleNarration(body, t)
    : body.kind === 'assignment'
      ? assignmentNarration(body, message, t)
      : category === 'system'
        ? readableSystemText(body, t)
        : body.text
  const compact = body.kind !== 'text' || category === 'system'
  const rowProps = {
    'data-testid': `agent-teams-message-${message.id}`,
    'data-message-body': body.kind,
    'data-message-kind': message.kind,
    'data-message-category': category,
    onMouseEnter: focusedTaskId ? () => onFocusTask?.(focusedTaskId) : undefined,
    onMouseLeave: focusedTaskId ? () => onFocusTask?.(null) : undefined,
  }

  if (compact) {
    return (
      <article
        {...rowProps}
        className="bg-[var(--color-surface-container-low)] px-3.5 py-2"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: categoryAccent(category) }}
            aria-hidden="true"
          />
          <span
            className="shrink-0 text-[11px] font-semibold"
            style={{ color: categoryAccent(category) }}
          >
            {categoryLabel(category, t)}
          </span>
          <p
            data-testid={`agent-teams-message-${message.id}-body`}
            className="min-w-0 flex-1 truncate text-xs leading-[1.4] text-[var(--color-text-secondary)]"
            title={text}
          >
            {text}
          </p>
          {message.taskId ? (
            <span className="shrink-0 rounded-full bg-[var(--color-surface-container-high)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-text-tertiary)]">
              #{message.taskId}
            </span>
          ) : null}
          {repeats > 1 ? (
            <span
              data-testid={`agent-teams-message-${message.id}-repeats`}
              className="shrink-0 rounded-full bg-[var(--color-surface-container-high)] px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]"
            >
              ×{repeats}
            </span>
          ) : null}
          <time
            dateTime={message.timestamp}
            className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]"
          >
            {time}
          </time>
        </div>
      </article>
    )
  }

  const isTruncatable = text.length > COLLAPSED_BODY_CHARS
  const collapsed = isTruncatable && !expanded
  const recipient = message.kind === 'broadcast'
    ? t('agentTeams.communication.everyone')
    : message.to
  const senderParticipant = resolveParticipant(message.from, snapshot, 0)
  const recipientParticipant = message.kind === 'direct'
    ? resolveParticipant(message.to, snapshot, 1)
    : null
  const Icon = transportIcon(message.kind)

  return (
    <article {...rowProps} className="relative px-3.5 py-3">
      {isLatest ? (
        <span className="absolute bottom-3 left-0 top-3 w-0.5 rounded-r-full bg-[var(--color-info)]" aria-hidden="true" />
      ) : null}

      <div className="flex min-w-0 items-center gap-2">
        <span
          className={[
            'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold',
            categoryTagClass(category),
          ].join(' ')}
        >
          <Icon size={12} strokeWidth={2} aria-hidden="true" />
          {categoryLabel(category, t)}
        </span>
        {message.taskId ? (
          <span className="shrink-0 rounded-full bg-[var(--color-surface-container-high)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-text-tertiary)]">
            #{message.taskId}
          </span>
        ) : null}
        <time
          dateTime={message.timestamp}
          className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]"
        >
          {time}
        </time>
      </div>

      <div
        data-testid={`agent-teams-message-${message.id}-route`}
        className="mt-1.5 flex min-w-0 items-center gap-1.5"
      >
        <ParticipantFigure
          participant={senderParticipant}
          name={message.from}
          nameTestId={`agent-teams-message-${message.id}-from`}
          avatarTestId={`agent-teams-message-${message.id}-from-avatar`}
        />
        <ArrowRight size={12} strokeWidth={2} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
        {recipientParticipant ? (
          <ParticipantFigure
            participant={recipientParticipant}
            name={recipient}
            nameTestId={`agent-teams-message-${message.id}-to`}
            avatarTestId={`agent-teams-message-${message.id}-to-avatar`}
          />
        ) : (
          <span
            data-testid={`agent-teams-message-${message.id}-to`}
            className="inline-flex min-w-0 flex-1 items-center gap-1.5"
            title={recipient}
          >
            <span className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] text-[var(--color-text-secondary)]">
              <Megaphone size={11} strokeWidth={2} aria-hidden="true" />
            </span>
            <span className="min-w-0 truncate font-mono text-[11px] font-medium text-[var(--color-text-secondary)]">
              {recipient}
            </span>
          </span>
        )}
      </div>

      <div
        data-testid={`agent-teams-message-${message.id}-body`}
        data-collapsed={collapsed ? 'true' : 'false'}
        className="relative mt-[7px] text-[13px] leading-[1.55]"
      >
        <div className={collapsed ? 'max-h-[148px] overflow-hidden' : ''}>
          <MarkdownRenderer
            content={text}
            variant="compact"
            className="prose-p:first:mt-0 prose-p:last:mb-0 prose-p:text-[13px] prose-p:leading-[1.55] prose-li:text-[13px] prose-li:leading-[1.55] prose-headings:first:mt-0 prose-headings:text-[var(--color-text-primary)] prose-code:text-[11px]"
          />
        </div>
        {collapsed ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-b from-transparent to-[var(--color-surface)]"
          />
        ) : null}
      </div>

      {isTruncatable ? (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="relative mt-2 rounded-[var(--radius-sm)] text-[11px] font-medium text-[var(--color-text-accent)] outline-none transition-[transform,color] duration-200 hover:underline focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] active:scale-[0.98]"
        >
          {t(expanded ? 'agentTeams.communication.collapse' : 'agentTeams.communication.expand')}
        </button>
      ) : null}
    </article>
  )
}

function ParticipantFigure({
  participant,
  name,
  nameTestId,
  avatarTestId,
}: {
  participant: MessageParticipant
  name: string
  nameTestId: string
  avatarTestId: string
}) {
  return (
    <span className="inline-flex min-w-0 flex-1 items-center gap-1.5" title={name}>
      <span
        data-testid={avatarTestId}
        data-avatar-key={participant.avatarKey}
        aria-hidden="true"
        className="relative h-[22px] w-[22px] shrink-0"
      >
        <img
          src={MEMBER_AVATARS[participant.avatarKey]}
          alt=""
          draggable={false}
          className="h-full w-full select-none object-contain drop-shadow-[0_1px_1px_rgba(0,0,0,0.14)]"
        />
        <span
          className="absolute bottom-0 left-1/2 h-0.5 w-3 -translate-x-1/2 rounded-full border border-[var(--color-surface)]"
          style={{ background: participant.accent }}
        />
      </span>
      <span
        data-testid={nameTestId}
        className="min-w-0 truncate font-mono text-[11px] font-medium text-[var(--color-text-secondary)]"
      >
        {name}
      </span>
    </span>
  )
}
