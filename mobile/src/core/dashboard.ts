import type { Session } from './types'
export type MobileActivity = {
  id: string
  activityState: 'running' | 'waiting' | 'failed' | 'idle' | 'review'
  requestId?: string
  toolName?: string
  preview?: string
  autoAnswerDeadline?: number | null
  startedAt?: number
  lastProgressAt?: number
  completedAt?: number
  terminalOutcome?: 'completed' | 'failed' | 'stopped'
  stalled?: boolean
  /** Not a tool approval decision: the team plan submitted by the lead is waiting for your confirmation. */
  decision?: 'team_plan'
}
export type DashboardRow = { session: Session; activity?: MobileActivity }
export function groupDashboard(
  sessions: Session[],
  activity: MobileActivity[],
  now = new Date()
) {
  const states = new Map(activity.map((item) => [item.id, item]))
  // Each dashboard snapshot belongs to one host; IDs are unique within that host.
  const rows = [...new Map(sessions.map(session => [session.id, session])).values()]
    .map((session) => ({ session, activity: states.get(session.id) }))
    .sort((a, b) => b.session.modifiedAt.localeCompare(a.session.modifiedAt))
  const waiting = rows.filter(
    (row) => row.activity?.activityState === 'waiting'
  )
  const running = rows.filter(
    (row) => row.activity?.activityState === 'running'
  )
  const settled = rows.filter(
    (row) => !['waiting', 'running'].includes(row.activity?.activityState ?? '')
  )
  const today = settled.filter(
    (row) =>
      ['idle', 'review'].includes(row.activity?.activityState ?? '') &&
      row.activity?.terminalOutcome === 'completed' &&
      row.activity?.completedAt !== undefined &&
      Number.isFinite(row.activity.completedAt) &&
      sameDay(new Date(row.activity.completedAt), now)
  )
  return { waiting, running, settled, completedToday: today.length }
}
function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}
/** Duration: under an hour m:ss, over an hour h:mm:ss; negative treated as 0. */
export function formatDuration(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = String(seconds % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}
export function elapsedLabel(date: string | number, now = Date.now()) {
  return formatDuration((now - new Date(date).getTime()) / 1000)
}
/** Time on the right of the list: just now / N min / N h (same day) / yesterday / 10/21. */
export function relativeLabel(date: string, now = new Date()) {
  const timestamp = new Date(date)
  const minutes = Math.floor((now.getTime() - timestamp.getTime()) / 60000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} Minutes`
  if (sameDay(timestamp, now)) return `${Math.floor(minutes / 60)} h`
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (sameDay(timestamp, yesterday)) return 'Yesterday'
  return `${timestamp.getMonth() + 1}/${timestamp.getDate()}`
}
