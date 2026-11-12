import type { DashboardRow, MobileActivity } from '../../core/dashboard'
import type { DashboardFailure } from '../../core/dashboardSync'
import type { ScheduledTask } from '../../core/operations'
import type { Host, Session } from '../../core/types'
import { nextRunAt } from '../../core/schedulesView'
import { plural } from '../../core/plural'

/* ───────────── Projects ───────────── */

export type Project = { key: string; name: string; dir: string }

function trimSlashes(path: string) {
  return path.replace(/[\\/]+$/, '')
}

/** Project = repo root (worktree sessions belong to the original repo), falling back to the working directory. */
export function projectOf(session: Session): Project | null {
  const dir = trimSlashes(session.projectRoot || session.workDir || '')
  const name = dir.split(/[\\/]/).filter(Boolean).pop()
  return name ? { key: dir, name, dir } : null
}

/** Projects sorted by recent activity (rows already sorted by modifiedAt descending). */
export function projectsOf(rows: DashboardRow[]): (Project & { count: number })[] {
  const projects = new Map<string, Project & { count: number }>()
  for (const row of rows) {
    const project = projectOf(row.session)
    if (!project) continue
    const known = projects.get(project.key)
    if (known) known.count++
    else projects.set(project.key, { ...project, count: 1 })
  }
  return [...projects.values()]
}

export function inProject(row: DashboardRow, key: string | null) {
  return key === null || projectOf(row.session)?.key === key
}

/* ───────────── Waiting for your decision ───────────── */

export type DecisionKind = 'approval' | 'question' | 'plan' | 'team' | 'other'

/** Only regular tool approvals with a requestId can be allowed/denied directly on home (same rule as lock screen notifications). */
export function decisionKind(activity?: MobileActivity): DecisionKind {
  if (activity?.decision === 'team_plan') return 'team'
  if (activity?.toolName === 'AskUserQuestion') return 'question'
  if (activity?.toolName === 'ExitPlanMode') return 'plan'
  if (activity?.requestId && activity.toolName && activity.toolName !== 'ComputerUse')
    return 'approval'
  return 'other'
}

const fileTools = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const readTools = new Set(['Read', 'Glob', 'Grep', 'LS'])

export function decisionAction(activity?: MobileActivity) {
  const tool = activity?.toolName
  switch (decisionKind(activity)) {
    case 'question':
      return 'Asking you'
    case 'plan':
      return 'Plan is ready, waiting for your confirmation'
    case 'team':
      return activity?.preview?.trim() || 'Team is ready, awaiting your confirmation'
  }
  if (!tool) return 'Needs your decision'
  if (tool === 'Bash' || tool === 'PowerShell') return 'Wants to run a command'
  if (fileTools.has(tool)) return 'Wants to edit files'
  if (readTools.has(tool)) return 'Wants to read files'
  if (tool === 'WebFetch') return 'Wants to visit a web page'
  if (tool === 'WebSearch') return 'Wants to search the web'
  if (tool === 'ComputerUse') return 'Wants to use the computer'
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  return `Wants to use ${mcp ? `${mcp[1]} · ${mcp[2]}` : tool}`
}

/** Description for waiting rows while offline: different decisions use different verbs. */
export function pendingWhileOffline(activity?: MobileActivity) {
  const kind = decisionKind(activity)
  const verb =
    kind === 'question'
      ? 'Waiting for your answer'
      : kind === 'plan'
        ? 'Waiting for you to confirm the plan'
        : kind === 'team'
          ? 'Team waiting for your confirmation'
          : 'Waiting for your approval'
  return `${verb} · can be handled once connected`
}

/**
 * Placeholder text the computer fills in when there is nothing to show; home does not treat them as command or plan bodies.
 * Older desktop servers still send the Chinese wording, so both sets stay.
 */
const placeholders = new Set([
  'Needs your decision',
  'Waiting for your answer',
  'Plan awaiting confirmation',
  'Waiting for tool permission',
  'Waiting for computer control permission',
  '需要你做决定',
  '等待你回答问题',
  '计划等待确认',
  '等待工具权限确认',
  '等待电脑操作权限确认',
])
export function previewText(activity?: MobileActivity) {
  const text = activity?.preview?.trim()
  return text && !placeholders.has(text) ? text : ''
}

/** Monospace single line in the approval card: commands get a prompt prefix, other tools shown as is. */
export function approvalPreview(activity?: MobileActivity) {
  const text = previewText(activity)
  if (!text) return ''
  return activity?.toolName === 'Bash' || activity?.toolName === 'PowerShell'
    ? `$ ${text}`
    : text
}

/** First two steps of the plan body and remaining step count; null when there is no body (no plan made up). */
export function planPreview(activity?: MobileActivity) {
  const lines = previewText(activity)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !/^`[^`]*`$/.test(line))
  if (!lines.length) return null
  return { lines: lines.slice(0, 2), more: Math.max(0, lines.length - 2) }
}

/* ───────────── In progress ───────────── */

export function stalledLabel(activity: MobileActivity | undefined, now: number) {
  const since = activity?.lastProgressAt
  if (typeof since !== 'number' || !Number.isFinite(since)) return 'No progress for now'
  const minutes = Math.floor((now - since) / 60000)
  if (minutes < 1) return 'No progress for now'
  if (minutes < 60) return `${minutes} min without progress`
  return `${Math.floor(minutes / 60)} h without progress`
}

/* ───────────── Recent ───────────── */

export type Outcome = 'done' | 'review' | 'failed' | 'stopped' | 'unknown'

export function settledOutcome(activity?: MobileActivity): Outcome {
  if (!activity) return 'unknown'
  if (activity.activityState === 'failed' || activity.terminalOutcome === 'failed')
    return 'failed'
  if (activity.activityState === 'review') return 'review'
  if (activity.terminalOutcome === 'stopped') return 'stopped'
  if (activity.terminalOutcome === 'completed') return 'done'
  return 'unknown'
}

/** Subline: done writes "project · outcome", errors and stops put the outcome first (matching the design). */
export function outcomeLine(outcome: Outcome, project?: string | null) {
  const join = (...parts: (string | null | undefined)[]) =>
    parts.filter(Boolean).join(' · ')
  switch (outcome) {
    case 'failed':
      return join('Stopped with error', project)
    case 'stopped':
      return join('You stopped', project)
    case 'done':
      return join(project, 'Done')
    case 'review':
      return join(project, 'Done', 'Unviewed')
    default:
      return project ?? ''
  }
}

/* ───────────── Search ───────────── */

export function matchesQuery(row: DashboardRow, query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  // Like the old version also match the full working directory, so subdirectory names in the path are searchable too.
  return `${row.session.title}\n${projectOf(row.session)?.name ?? ''}\n${row.session.workDir ?? ''}`
    .toLowerCase()
    .includes(needle)
}

/** Split text by keywords for mark highlighting; case-insensitive, keeping the original text. */
export function highlightParts(text: string, query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return [{ text, match: false }]
  const parts: { text: string; match: boolean }[] = []
  const lower = text.toLowerCase()
  let index = 0
  while (index < text.length) {
    const found = lower.indexOf(needle, index)
    if (found < 0) break
    if (found > index) parts.push({ text: text.slice(index, found), match: false })
    parts.push({ text: text.slice(found, found + needle.length), match: true })
    index = found + needle.length
  }
  if (index < text.length) parts.push({ text: text.slice(index), match: false })
  return parts.length ? parts : [{ text, match: false }]
}

/* ───────────── Connection state of this computer ───────────── */

export type HostLink = 'none' | 'connecting' | 'online' | DashboardFailure

export function hostLink(input: {
  host?: Host | null
  fresh: boolean
  failure: DashboardFailure | null
  credentialError?: string
  credentialIssue?: 'missing' | 'unavailable' | null
}): HostLink {
  if (!input.host) return 'none'
  if (input.credentialError)
    return input.credentialIssue === 'unavailable' ? 'failed' : 'unauthorized'
  if (input.fresh) return 'online'
  return input.failure ?? 'connecting'
}

export function networkName(host: Pick<Host, 'auth'>) {
  return host.auth === 'lan' ? 'LAN' : 'Public'
}

export function hostAddress(host: Pick<Host, 'auth' | 'url'>) {
  let address = host.url
  try {
    address = new URL(host.url).host
  } catch {
    /* Saved addresses are all validated; this is only a display fallback. */
  }
  return `${networkName(host)} · ${address}`
}

function pad(value: number) {
  return String(value).padStart(2, '0')
}
function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/** "4 minutes ago" / "2 hours ago" / "10/21", for last sync time. */
export function agoLabel(timestamp: number, now: number) {
  const minutes = Math.floor((now - timestamp) / 60000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${plural(minutes, 'minute')} ago`
  if (minutes < 24 * 60) return `${plural(Math.floor(minutes / 60), 'hour')} ago`
  const date = new Date(timestamp)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

/** "23:10" / "Yesterday 23:10" / "10/21 23:10", for last online time. */
export function clockLabel(timestamp: number, now: number) {
  const date = new Date(timestamp)
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const today = new Date(now)
  if (sameDay(date, today)) return time
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (sameDay(date, yesterday)) return `Yesterday ${time}`
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`
}

export type StatusTone = 'ok' | 'faint' | 'attn' | 'err'

/** Status line under the large title: dot tone + text. */
export function hostStatusLine(
  link: HostLink,
  host: Pick<Host, 'auth'> | null | undefined,
  lastSyncedAt: number | undefined,
  now: number
): { text: string; tone: StatusTone } {
  const synced = lastSyncedAt ? ` · last synced ${agoLabel(lastSyncedAt, now)}` : ''
  switch (link) {
    case 'online':
      return { text: `Online · ${host ? networkName(host) : ''}`, tone: 'ok' }
    case 'offline':
      return { text: `Offline${synced}`, tone: 'faint' }
    case 'unauthorized':
      return { text: 'Authorization expired', tone: 'err' }
    case 'failed':
      return { text: `Sync failed${synced}`, tone: 'err' }
    case 'slow':
      return { text: 'Sync is slow · retrying', tone: 'attn' }
    case 'none':
      return { text: 'No computer connected yet', tone: 'faint' }
    default:
      return { text: 'Connecting…', tone: 'faint' }
  }
}

/** A single status word (online / offline / authorization expired…), without network or sync time. */
export function hostStateName(link: HostLink): { text: string; tone: StatusTone } {
  switch (link) {
    case 'online':
      return { text: 'Online', tone: 'ok' }
    case 'offline':
      return { text: 'Offline', tone: 'faint' }
    case 'unauthorized':
      return { text: 'Authorization expired', tone: 'err' }
    case 'failed':
      return { text: 'Sync failed', tone: 'err' }
    case 'slow':
      return { text: 'Sync is slow', tone: 'attn' }
    default:
      return { text: 'Connecting', tone: 'faint' }
  }
}

/** Offline card and "New task": only block when there is no computer or it is truly unreachable; a stale snapshot does not count. */
export function canStartTask(link: HostLink) {
  return !['none', 'offline', 'unauthorized'].includes(link)
}

/* ───────────── Connectivity check of other computers ───────────── */

export type HostCheck = {
  state: 'checking' | 'online' | 'offline' | 'unauthorized' | 'failed'
  message?: string
  expiresAt?: number
  checkedAt?: number
  waiting?: number
  running?: number
  lastOnlineAt?: number
}

export function credentialHostCheck(message: string, issue: 'missing' | 'unavailable' | null): HostCheck {
  return { state: issue === 'unavailable' ? 'failed' : 'unauthorized', message }
}

export function hostCheckLine(host: Pick<Host, 'auth'>, check: HostCheck, now: number) {
  switch (check.state) {
    case 'checking':
      return 'Checking connection…'
    case 'unauthorized':
      return 'Authorization expired · please reconnect'
    case 'failed':
      return check.message || 'Cannot read connection credentials right now'
    case 'offline':
      return check.lastOnlineAt
        ? `Offline · last online ${clockLabel(check.lastOnlineAt, now).replace(/^Yesterday/, 'yesterday')}`
        : 'Offline · unreachable for now'
  }
  if (host.auth === 'lan') return 'LAN · online'
  if (check.expiresAt === undefined) return 'Public · online'
  const days = Math.max(
    0,
    Math.ceil((check.expiresAt - (check.checkedAt ?? check.expiresAt)) / 86400000)
  )
  return days < 1 ? 'Public · authorization expires in less than 1 day' : `Public · authorization expires in ${plural(days, 'day')}`
}

export function hostCheckBadge(check: HostCheck): { text: string; tone: 'attn' | 'ink3' } | null {
  if (check.state !== 'online') return null
  if (check.waiting) return { text: `${check.waiting} waiting for you`, tone: 'attn' }
  if (check.running) return { text: `${check.running} in progress`, tone: 'ink3' }
  return null
}

/* ───────────── Scheduled tasks ───────────── */

function parseField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>()
  for (const part of field.split(',')) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part)
    if (!range) return null
    const from = Number(range[1])
    const to = range[2] === undefined ? from : Number(range[2])
    if (from < min || to > max || from > to) return null
    for (let value = from; value <= to; value++) values.add(value)
  }
  return values
}

/**
 * Only recognizes `min hour * * weekday` expressions like "daily / weekdays / specific weekdays HH:mm"; 
 * other forms return null and the caller hides the next time, to avoid guessing wrong.
 */
export function nextCronRun(cron: string, now: Date): Date | null {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields
  if (!/^\d+$/.test(minute!) || !/^\d+$/.test(hour!)) return null
  if (dayOfMonth !== '*' || month !== '*') return null
  const m = Number(minute)
  const h = Number(hour)
  if (m > 59 || h > 23) return null
  const days =
    dayOfWeek === '*' ? null : parseField(dayOfWeek!, 0, 7)
  if (dayOfWeek !== '*' && !days) return null
  if (days?.has(7)) days.add(0)
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(now)
    candidate.setDate(candidate.getDate() + offset)
    candidate.setHours(h, m, 0, 0)
    if (candidate.getTime() <= now.getTime()) continue
    if (!days || days.has(candidate.getDay())) return candidate
  }
  return null
}

const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "3 enabled · next 18:00"; when any enabled task's time cannot be computed only the count is shown. */
export function scheduleSummary(tasks: ScheduledTask[], now: Date) {
  const enabled = tasks.filter((task) => task.enabled !== false && task.scheduleState !== 'completed')
  if (!tasks.length) return 'Not set up'
  if (!enabled.length) return tasks.every(task => task.scheduleState === 'completed') ? 'All done' : 'All paused'
  const runs = enabled.map((task) => task.schedule || task.nextRunAt !== undefined ? nextRunAt(task, now) : nextCronRun(task.cron, now))
  if (runs.some((run) => !run)) return `${enabled.length} enabled`
  const next = new Date(Math.min(...runs.map((run) => run!.getTime())))
  const time = `${pad(next.getHours())}:${pad(next.getMinutes())}`
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const day = sameDay(next, now)
    ? ''
    : sameDay(next, tomorrow)
      ? 'tomorrow '
      : `${weekdayNames[next.getDay()]} `
  return `${enabled.length} enabled · next ${day}${time}`
}
