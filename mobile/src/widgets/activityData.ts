import type { Host, Session } from '../core/types'
import type { MobileActivity } from '../core/dashboard'

export type TaskActivityProps = {
  hostId: string
  sessionId: string
  hostName: string
  title: string
  detail: string
  status: 'running' | 'waiting' | 'failed' | 'completed'
  activeCount: number
  requestId?: string
  allowUrl?: string
  denyUrl?: string
  openUrl: string
  connectionState?: 'stale'
}
export const TASK_ACTIVITY_NAME = 'CCHahaTaskActivity'
export function activityBridgeAction(state: {
  hostsReady: boolean
  preferencesReady: boolean
  preferencesError: boolean
  hasHosts: boolean
  foreground: boolean
  fresh: boolean
  error: boolean
  hasSnapshot: boolean
  hasClient: boolean
}): 'wait' | 'end' | 'preserve' | 'stale' | 'sync' {
  if (!state.hostsReady) return 'wait'
  if (!state.preferencesReady || state.preferencesError || !state.hasHosts)
    return 'end'
  if (!state.foreground) return 'preserve'
  if (!state.fresh || state.error || !state.hasSnapshot || !state.hasClient)
    return 'stale'
  return 'sync'
}
export function staleActivityProps(
  props: TaskActivityProps
): TaskActivityProps {
  return {
    ...props,
    connectionState: 'stale',
    allowUrl: undefined,
    denyUrl: undefined,
    detail: '状态待更新 · 打开 App 重新连接',
  }
}
export function activityUrl(
  hostId: string,
  sessionId: string,
  requestId?: string,
  action?: 'allow' | 'deny'
) {
  const query = new URLSearchParams({ host: hostId })
  if (requestId) query.set('requestId', requestId)
  if (requestId && action) query.set('notificationAction', action)
  return `cchaha:///chat/${encodeURIComponent(sessionId)}?${query}`
}
export function taskActivityData(
  host: Host,
  sessions: Session[],
  activity: MobileActivity[],
  decisions: boolean,
  now: number
): TaskActivityProps | null {
  const candidate =
    activity.find((item) => decisions && item.activityState === 'waiting') ??
    activity.find((item) => item.activityState === 'running')
  if (!candidate) return null
  const session = sessions.find((item) => item.id === candidate.id)
  if (!session) return null
  const waiting = candidate.activityState === 'waiting'
  const canAnswer =
    waiting &&
    candidate.requestId &&
    candidate.toolName &&
    !['AskUserQuestion', 'ExitPlanMode', 'ComputerUse'].includes(
      candidate.toolName
    ) &&
    (!candidate.autoAnswerDeadline || candidate.autoAnswerDeadline > now)
  const openUrl = activityUrl(host.id, session.id)
  return {
    hostId: host.id,
    sessionId: session.id,
    hostName: host.name,
    title: (session.title || '进行中的任务').slice(0, 90),
    detail: (waiting
      ? candidate.toolName === 'AskUserQuestion'
        ? `在问你：${candidate.preview || '需要你补充信息'}`
        : candidate.toolName === 'ExitPlanMode'
          ? '计划已就绪，打开 App 确认执行方式'
          : candidate.preview
            ? `想运行 ${candidate.preview}`
            : '等待你的审批'
      : candidate.preview || '电脑正在处理任务'
    ).slice(0, 160),
    status: waiting ? 'waiting' : 'running',
    activeCount: activity.filter((item) =>
      ['running', 'waiting'].includes(item.activityState)
    ).length,
    ...(waiting && candidate.requestId
      ? { requestId: candidate.requestId }
      : {}),
    ...(canAnswer
      ? {
          allowUrl: activityUrl(
            host.id,
            session.id,
            candidate.requestId,
            'allow'
          ),
          denyUrl: activityUrl(
            host.id,
            session.id,
            candidate.requestId,
            'deny'
          ),
        }
      : {}),
    openUrl,
  }
}
