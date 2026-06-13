import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useTranslation, type TranslationKey } from '../../i18n'
import { useChatStore } from '../../stores/chatStore'
import type { AgentTaskNotification, BackgroundAgentTask, UIMessage } from '../../types/chat'

export type SoloCouncilRole = 'planner' | 'reviewer' | 'critic'
export type SoloCouncilVerdict = 'plan-ready' | 'approve' | 'changes-needed' | 'pending'

export type SoloCouncilDisplayStatus = BackgroundAgentTask['status'] | 'standby'

// Tracks where a row was sourced from so we can prefer canonical live state
// over persisted message fallback while still letting the latest message win
// among message-derived rows.
export type SoloCouncilRowOrigin = 'live' | 'message' | 'standby'

export type SoloCouncilReviewArtifact = {
  role?: Exclude<SoloCouncilRole, 'planner'>
  verdict?: Extract<SoloCouncilVerdict, 'approve' | 'changes-needed'>
  blockingObjections: string[]
  executableActions: string[]
  summary?: string
}

export type SoloCouncilRow = {
  role: SoloCouncilRole
  task?: BackgroundAgentTask
  notification?: AgentTaskNotification
  displayStatus: SoloCouncilDisplayStatus
  origin: SoloCouncilRowOrigin
  verdict: SoloCouncilVerdict
  artifact?: SoloCouncilReviewArtifact
  // Raw text content for live/message rows. Empty string for standby rows; use
  // standbyTextKey instead so canExpand reflects the translated copy.
  text: string
  standbyTextKey?: TranslationKey
  sortTime: number
}

const SOLO_COUNCIL_PREFIXES: Record<SoloCouncilRole, string> = {
  planner: '[Solo Council: Planner]',
  reviewer: '[Solo Council: Reviewer]',
  critic: '[Solo Council: Critic]',
}

const ROLE_ORDER: SoloCouncilRole[] = ['planner', 'reviewer', 'critic']
const APPROVE_RE = /\b(?:PLAN_REVIEWER|PLAN_REVIEW):\s*APPROVE\b/i
const CHANGES_NEEDED_RE = /\b(?:PLAN_REVIEWER|PLAN_REVIEW):\s*CHANGES_NEEDED\b/i
const REVIEW_JSON_PREFIX = 'SOLO_COUNCIL_REVIEW_JSON:'
const SYNTHESIS_START = 'SOLO_COUNCIL_SYNTHESIS_START'
const SYNTHESIS_END = 'SOLO_COUNCIL_SYNTHESIS_END'
const SOLO_COUNCIL_OUTPUT_COLLAPSE_THRESHOLD = 900
const SOLO_COUNCIL_SYNTHESIS_COLLAPSE_THRESHOLD = 1400
const SOLO_COUNCIL_ARTIFACT_MAX_ITEMS = 5
const SOLO_COUNCIL_ARTIFACT_MAX_ITEM_LENGTH = 240
const EMPTY_BACKGROUND_TASKS: Record<string, BackgroundAgentTask> = {}
const EMPTY_AGENT_NOTIFICATIONS: Record<string, AgentTaskNotification> = {}
const EMPTY_MESSAGES: UIMessage[] = []

export function getSoloCouncilRole(description?: string): SoloCouncilRole | null {
  if (!description) return null
  for (const role of ROLE_ORDER) {
    if (description.startsWith(SOLO_COUNCIL_PREFIXES[role])) return role
  }
  return null
}

export function parseSoloCouncilReviewArtifact(
  role: SoloCouncilRole,
  text: string,
): SoloCouncilReviewArtifact | null {
  if (role === 'planner') return null

  const line = text
    .split(/\r?\n/)
    .find((entry) => entry.trimStart().startsWith(REVIEW_JSON_PREFIX))
  if (!line) return null

  const jsonText = line.slice(line.indexOf(REVIEW_JSON_PREFIX) + REVIEW_JSON_PREFIX.length).trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return null
  }

  if (!isPlainObject(parsed)) return null

  const rawRole = parsed.role
  if (rawRole !== undefined && rawRole !== role) return null

  const rawVerdict = parsed.verdict
  const verdict = rawVerdict === 'approve'
    ? 'approve'
    : rawVerdict === 'changes_needed'
      ? 'changes-needed'
      : undefined
  if (rawVerdict !== undefined && verdict === undefined) return null

  const blockingObjections = sanitizeArtifactList(parsed.blockingObjections)
  const executableActions = sanitizeArtifactList(parsed.executableActions)
  if (!blockingObjections || !executableActions) return null

  const rawSummary = parsed.summary
  const summary = rawSummary === undefined
    ? undefined
    : typeof rawSummary === 'string' && rawSummary.trim().length <= SOLO_COUNCIL_ARTIFACT_MAX_ITEM_LENGTH
      ? rawSummary.trim()
      : null
  if (summary === null) return null

  return {
    role: rawRole === 'reviewer' || rawRole === 'critic' ? rawRole : undefined,
    verdict,
    blockingObjections,
    executableActions,
    summary: summary || undefined,
  }
}

export function parseSoloCouncilVerdict(
  role: SoloCouncilRole,
  task: Pick<BackgroundAgentTask, 'status' | 'summary'>,
  notification?: Pick<AgentTaskNotification, 'result' | 'summary'>,
  artifact?: SoloCouncilReviewArtifact | null,
): SoloCouncilVerdict {
  if (artifact?.verdict) return artifact.verdict

  const text = `${notification?.result ?? ''}\n${notification?.summary ?? ''}\n${task.summary ?? ''}`
  if (CHANGES_NEEDED_RE.test(text)) return 'changes-needed'
  if (APPROVE_RE.test(text)) return 'approve'
  if (role === 'planner' && task.status === 'completed') return 'plan-ready'
  return 'pending'
}

export function extractSoloCouncilSynthesis(messages: UIMessage[]): string | null {
  const latestAssistantMessage = [...messages]
    .reverse()
    .find((message) => message.type === 'assistant_text')

  if (!latestAssistantMessage || latestAssistantMessage.type !== 'assistant_text') return null

  const markerRe = new RegExp(`${SYNTHESIS_START}([\\s\\S]*?)${SYNTHESIS_END}`, 'g')
  let latest: string | null = null
  let match: RegExpExecArray | null
  while ((match = markerRe.exec(latestAssistantMessage.content)) !== null) {
    const synthesis = (match[1] ?? '').trim()
    if (synthesis) latest = synthesis
  }

  return latest
}

export function buildSoloCouncilRows(
  tasks: Record<string, BackgroundAgentTask> | undefined,
  notifications: Record<string, AgentTaskNotification> | undefined,
  messages: UIMessage[] = EMPTY_MESSAGES,
  includeStandby = true,
): SoloCouncilRow[] {
  const latestByRole = new Map<SoloCouncilRole, SoloCouncilRow>()

  for (const task of Object.values(tasks ?? {})) {
    const role = getSoloCouncilRole(task.description)
    if (!role) continue

    const notification = findTaskNotification(task, notifications)
    const text = notification?.result || notification?.summary || task.summary || task.description || ''
    const artifactText = `${notification?.result ?? ''}\n${notification?.summary ?? ''}\n${task.summary ?? ''}`
    const artifact = parseSoloCouncilReviewArtifact(role, artifactText) ?? undefined
    const row: SoloCouncilRow = {
      role,
      task,
      notification,
      displayStatus: task.status,
      origin: 'live',
      verdict: parseSoloCouncilVerdict(role, task, notification, artifact),
      artifact,
      text,
      sortTime: task.updatedAt,
    }

    const previous = latestByRole.get(role)
    if (!previous || row.sortTime >= previous.sortTime) {
      latestByRole.set(role, row)
    }
  }

  for (const message of messages) {
    if (message.type !== 'background_task') continue
    const task = message.task
    const role = getSoloCouncilRole(task.description)
    if (!role) continue
    const previous = latestByRole.get(role)
    // Live state is canonical; never let a persisted message override it.
    if (previous?.origin === 'live') continue

    const notification = findTaskNotification(task, notifications)
    const text = notification?.result || notification?.summary || task.summary || task.description || ''
    const artifactText = `${notification?.result ?? ''}\n${notification?.summary ?? ''}\n${task.summary ?? ''}`
    const artifact = parseSoloCouncilReviewArtifact(role, artifactText) ?? undefined
    const sortTime = task.updatedAt || message.timestamp
    // Among message-derived rows, keep the most recent (>= keeps last-write-wins).
    if (previous && sortTime < previous.sortTime) continue
    latestByRole.set(role, {
      role,
      task,
      notification,
      displayStatus: task.status,
      origin: 'message',
      verdict: parseSoloCouncilVerdict(role, task, notification, artifact),
      artifact,
      text,
      sortTime,
    })
  }

  return ROLE_ORDER.flatMap((role) => {
    const row = latestByRole.get(role)
    if (row) return [row]
    if (!includeStandby) return []
    return [{
      role,
      displayStatus: 'standby',
      origin: 'standby',
      verdict: 'pending',
      text: '',
      standbyTextKey: `soloCouncil.output.standby.${role}` as const,
      sortTime: 0,
    }]
  })
}

function findTaskNotification(
  task: BackgroundAgentTask,
  notifications: Record<string, AgentTaskNotification> | undefined,
): AgentTaskNotification | undefined {
  if (!notifications) return undefined
  if (task.toolUseId && notifications[task.toolUseId]) return notifications[task.toolUseId]
  if (!task.toolUseId) {
    return Object.values(notifications).find((notification) => notification.taskId === task.taskId)
  }
  return undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitizeArtifactList(value: unknown): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  if (value.length > SOLO_COUNCIL_ARTIFACT_MAX_ITEMS) return null

  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    const text = item.trim()
    if (text.length > SOLO_COUNCIL_ARTIFACT_MAX_ITEM_LENGTH) return null
    if (text) items.push(text)
  }
  return items
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
      messages: session?.messages ?? EMPTY_MESSAGES,
    }
  }))
  const [manuallyExpanded, setManuallyExpanded] = useState(false)
  const [manuallyCollapsed, setManuallyCollapsed] = useState(false)
  const rows = useMemo(
    () => buildSoloCouncilRows(sessionSnapshot.tasks, sessionSnapshot.notifications, sessionSnapshot.messages),
    [sessionSnapshot.tasks, sessionSnapshot.notifications, sessionSnapshot.messages],
  )
  const synthesis = useMemo(
    () => extractSoloCouncilSynthesis(sessionSnapshot.messages),
    [sessionSnapshot.messages],
  )

  const hasDebate = useMemo(
    () => rows.some((row) => row.verdict === 'changes-needed' || row.displayStatus === 'failed'),
    [rows],
  )
  const hasActivity = useMemo(
    () => rows.some((row) => row.origin !== 'standby'),
    [rows],
  )
  const collapsed = manuallyCollapsed || (!manuallyExpanded && !hasActivity && !synthesis)

  // With includeStandby defaulted to true, buildSoloCouncilRows always returns
  // ROLE_ORDER.length rows. Kept defensively in case a future caller opts out.
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
          <div className="flex shrink-0 items-center gap-2">
            {hasDebate && (
              <span className="inline-flex items-center gap-1 rounded-full border border-[var(--color-warning)]/35 bg-[var(--color-warning)]/10 px-2 py-1 text-[10px] font-semibold text-[var(--color-warning)]">
                <span className="material-symbols-outlined text-[13px]" aria-hidden="true">forum</span>
                {t('soloCouncil.debateActive')}
              </span>
            )}
            <button
              type="button"
              data-testid="solo-council-panel-toggle"
              aria-expanded={!collapsed}
              aria-controls="solo-council-panel-body"
              onClick={() => {
                if (collapsed) {
                  setManuallyExpanded(true)
                  setManuallyCollapsed(false)
                } else {
                  setManuallyCollapsed(true)
                  setManuallyExpanded(false)
                }
              }}
              className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-1 text-[10px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
            >
              <span className="material-symbols-outlined text-[13px]" aria-hidden="true">
                {collapsed ? 'expand_more' : 'expand_less'}
              </span>
              {t(collapsed ? 'soloCouncil.panel.expand' : 'soloCouncil.panel.collapse')}
            </button>
          </div>
        </div>
        {!collapsed ? (
          <div id="solo-council-panel-body" data-testid="solo-council-panel-body">
            <SoloCouncilFlow rows={rows} hasSynthesis={Boolean(synthesis)} />
            <div className="grid gap-2 md:grid-cols-3">
              {rows.map((row) => (
                <SoloCouncilCard key={`${row.role}-${row.task?.taskId ?? `standby-${row.role}`}`} row={row} />
              ))}
            </div>
            {synthesis ? <SoloCouncilSynthesis text={synthesis} /> : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function SoloCouncilFlow({ rows, hasSynthesis }: { rows: SoloCouncilRow[]; hasSynthesis: boolean }) {
  const t = useTranslation()
  const rowByRole = new Map(rows.map((row) => [row.role, row]))
  const steps: Array<{ id: SoloCouncilRole | 'synthesis'; label: TranslationKey; state: 'muted' | 'running' | 'success' | 'warning' }> = [
    { id: 'planner', label: 'soloCouncil.flow.planner', state: getFlowState(rowByRole.get('planner')) },
    { id: 'reviewer', label: 'soloCouncil.flow.reviewer', state: getFlowState(rowByRole.get('reviewer')) },
    { id: 'critic', label: 'soloCouncil.flow.critic', state: getFlowState(rowByRole.get('critic')) },
    { id: 'synthesis', label: 'soloCouncil.flow.synthesis', state: hasSynthesis ? 'success' : 'muted' },
  ]

  return (
    <div data-testid="solo-council-flow" className="mb-3 flex flex-wrap items-center gap-1.5 text-[10px]">
      {steps.map((step, index) => (
        <div key={step.id} className="flex items-center gap-1.5">
          {index > 0 ? <span className="text-[var(--color-text-tertiary)]">→</span> : null}
          <span
            data-testid={`solo-council-flow-step-${step.id}`}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 font-medium ${flowStateClassName(step.state)}`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {t(step.label)}
          </span>
        </div>
      ))}
    </div>
  )
}

function SoloCouncilCard({ row }: { row: SoloCouncilRow }) {
  const t = useTranslation()
  const tone = getCardTone(row)
  const usage = row.task?.usage || row.notification?.usage
  const statusKey = `soloCouncil.status.${row.displayStatus}` as const
  const verdictKey = getVerdictKey(row.verdict)
  const [expanded, setExpanded] = useState(false)
  const displayText = row.standbyTextKey ? t(row.standbyTextKey) : row.text
  const canExpand = displayText.length > SOLO_COUNCIL_OUTPUT_COLLAPSE_THRESHOLD
  const outputId = `solo-council-output-${row.role}`
  const outputClassName = canExpand
    ? expanded
      ? 'mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] border border-[var(--color-border)]/60 bg-[var(--color-surface-container-lowest)]/50 p-2 text-[11px] leading-relaxed text-[var(--color-text-secondary)]'
      : 'mt-2 line-clamp-3 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[var(--color-text-secondary)]'
    : 'mt-2 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[var(--color-text-secondary)]'

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
            <StatusDot status={row.displayStatus} />
            <span>{t(statusKey)}</span>
            {usage?.totalTokens ? <span>{usage.totalTokens.toLocaleString()} t</span> : null}
            {usage?.toolUses ? <span>{usage.toolUses} tools</span> : null}
          </div>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${tone.badgeClassName}`}>
          {t(verdictKey)}
        </span>
      </div>
      {displayText ? (
        <>
          <div
            id={outputId}
            data-testid={outputId}
            className={outputClassName}
          >
            {displayText}
          </div>
          {canExpand ? (
            <button
              type="button"
              data-testid={`solo-council-toggle-${row.role}`}
              aria-expanded={expanded}
              aria-controls={outputId}
              aria-label={t('soloCouncil.output.toggleLabel')}
              onClick={() => setExpanded((value) => !value)}
              className="mt-2 text-[11px] font-medium text-[var(--color-text-accent)] transition-colors hover:text-[var(--color-primary)]"
            >
              {t(expanded ? 'soloCouncil.output.collapse' : 'soloCouncil.output.showFull')}
            </button>
          ) : null}
        </>
      ) : null}
      {row.verdict === 'changes-needed' && row.artifact ? (
        <SoloCouncilStructuredReview row={row} artifact={row.artifact} />
      ) : null}
    </div>
  )
}

function SoloCouncilStructuredReview({ row, artifact }: { row: SoloCouncilRow; artifact: SoloCouncilReviewArtifact }) {
  const t = useTranslation()

  return (
    <div className="mt-2 space-y-2 text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
      {artifact.blockingObjections.length > 0 ? (
        <div data-testid={`solo-council-objections-${row.role}`}>
          <div className="font-semibold text-[var(--color-text-primary)]">{t('soloCouncil.objections.title')}</div>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {artifact.blockingObjections.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      ) : null}
      {artifact.executableActions.length > 0 ? (
        <div data-testid={`solo-council-actions-${row.role}`}>
          <div className="font-semibold text-[var(--color-text-primary)]">{t('soloCouncil.actions.title')}</div>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {artifact.executableActions.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function SoloCouncilSynthesis({ text }: { text: string }) {
  const t = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const canExpand = text.length > SOLO_COUNCIL_SYNTHESIS_COLLAPSE_THRESHOLD
  const outputClassName = canExpand
    ? expanded
      ? 'mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] border border-[var(--color-border)]/60 bg-[var(--color-surface-container-lowest)]/50 p-2 text-[11px] leading-relaxed text-[var(--color-text-secondary)]'
      : 'mt-2 line-clamp-5 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[var(--color-text-secondary)]'
    : 'mt-2 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[var(--color-text-secondary)]'

  return (
    <div data-testid="solo-council-synthesis" className="mt-3 rounded-[var(--radius-md)] border border-[var(--color-primary)]/25 bg-[var(--color-primary)]/6 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text-primary)]">
        <span className="material-symbols-outlined text-[14px] text-[var(--color-primary)]" aria-hidden="true">route</span>
        {t('soloCouncil.synthesis.title')}
      </div>
      <div className="mt-1 text-[10px] text-[var(--color-text-tertiary)]">{t('soloCouncil.synthesis.subtitle')}</div>
      <div className="mt-2 rounded-[var(--radius-sm)] border border-[var(--color-primary)]/20 bg-[var(--color-primary)]/8 px-2 py-1.5 text-[11px] font-medium text-[var(--color-text-primary)]">
        {t('soloCouncil.synthesis.approvalHint')}
      </div>
      <div id="solo-council-synthesis-output" data-testid="solo-council-synthesis-output" className={outputClassName}>
        {text}
      </div>
      {canExpand ? (
        <button
          type="button"
          data-testid="solo-council-synthesis-toggle"
          aria-expanded={expanded}
          aria-controls="solo-council-synthesis-output"
          aria-label={t('soloCouncil.synthesis.toggleLabel')}
          onClick={() => setExpanded((value) => !value)}
          className="mt-2 text-[11px] font-medium text-[var(--color-text-accent)] transition-colors hover:text-[var(--color-primary)]"
        >
          {t(expanded ? 'soloCouncil.synthesis.collapse' : 'soloCouncil.synthesis.showFull')}
        </button>
      ) : null}
    </div>
  )
}

function getFlowState(row: SoloCouncilRow | undefined): 'muted' | 'running' | 'success' | 'warning' {
  if (!row || row.origin === 'standby') return 'muted'
  if (row.displayStatus === 'failed' || row.verdict === 'changes-needed') return 'warning'
  if (row.displayStatus === 'running') return 'running'
  if (row.displayStatus === 'completed' && row.verdict !== 'pending') return 'success'
  return 'muted'
}

function flowStateClassName(state: 'muted' | 'running' | 'success' | 'warning') {
  if (state === 'success') return 'border-[var(--color-success)]/30 bg-[var(--color-success)]/10 text-[var(--color-success)]'
  if (state === 'warning') return 'border-[var(--color-warning)]/35 bg-[var(--color-warning)]/10 text-[var(--color-warning)]'
  if (state === 'running') return 'border-[var(--color-primary)]/35 bg-[var(--color-primary)]/10 text-[var(--color-primary)]'
  return 'border-[var(--color-border)] bg-[var(--color-surface-container-low)] text-[var(--color-text-tertiary)]'
}

function getVerdictKey(verdict: SoloCouncilVerdict) {
  if (verdict === 'plan-ready') return 'soloCouncil.verdict.planReady'
  if (verdict === 'approve') return 'soloCouncil.verdict.approve'
  if (verdict === 'changes-needed') return 'soloCouncil.verdict.changesNeeded'
  return 'soloCouncil.verdict.pending'
}

function getCardTone(row: SoloCouncilRow) {
  if (row.displayStatus === 'failed' || row.verdict === 'changes-needed') {
    return {
      className: 'border-[var(--color-warning)]/45 bg-[var(--color-warning)]/8',
      badgeClassName: 'bg-[var(--color-warning)]/15 text-[var(--color-warning)]',
    }
  }
  if (row.displayStatus === 'completed' && row.verdict !== 'pending') {
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

function StatusDot({ status }: { status: SoloCouncilDisplayStatus }) {
  const color = status === 'failed'
    ? 'bg-[var(--color-error)]'
    : status === 'completed'
      ? 'bg-[var(--color-success)]'
      : status === 'stopped' || status === 'standby'
        ? 'bg-[var(--color-text-tertiary)]'
        : 'bg-[var(--color-primary)]'

  return <span className={`h-1.5 w-1.5 rounded-full ${color} ${status === 'running' ? 'animate-pulse' : ''}`} />
}

function roleIcon(role: SoloCouncilRole) {
  if (role === 'planner') return 'architecture'
  if (role === 'reviewer') return 'fact_check'
  return 'gavel'
}
