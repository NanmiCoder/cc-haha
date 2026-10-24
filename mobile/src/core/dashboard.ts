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
export function elapsedLabel(date: string | number, now = Date.now()) {
  const elapsed = Math.max(
    0,
    Math.floor((now - new Date(date).getTime()) / 1000)
  )
  return `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`
}
export function relativeLabel(date: string, now = new Date()) {
  const timestamp = new Date(date)
  const minutes = Math.floor((now.getTime() - timestamp.getTime()) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟`
  return sameDay(timestamp, now)
    ? timestamp.toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : timestamp.toLocaleDateString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
      })
}
