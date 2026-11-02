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
  /** 不是工具审批的决定：队长提交的团队方案在等你确认。 */
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
/** 时长：不到一小时 m:ss，超过一小时 h:mm:ss；负值按 0 处理。 */
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
/** 列表右侧的时间：刚刚 / N 分钟 / N 小时（同一天）/ 昨天 / 10/21。 */
export function relativeLabel(date: string, now = new Date()) {
  const timestamp = new Date(date)
  const minutes = Math.floor((now.getTime() - timestamp.getTime()) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟`
  if (sameDay(timestamp, now)) return `${Math.floor(minutes / 60)} 小时`
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (sameDay(timestamp, yesterday)) return '昨天'
  return `${timestamp.getMonth() + 1}/${timestamp.getDate()}`
}
