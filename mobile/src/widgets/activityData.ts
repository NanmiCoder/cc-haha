import type { Host, Session } from '../core/types'
import { formatDuration, type MobileActivity } from '../core/dashboard'
import { decisionLabel } from '../core/notifications'

/**
 * Live Activity 的 content state。这份结构也由电脑端 APNs 推送（只带基础字段），
 * 新增字段一律可选，组件在缺少时兜底。
 */
export type TaskActivityProps = {
  hostId: string
  sessionId: string
  hostName: string
  title: string
  detail: string
  status: 'running' | 'waiting' | 'failed' | 'completed'
  activeCount: number
  /** 等待态标题：“想运行命令”“在问你”“计划等你确认”。 */
  label?: string
  /** 本次运行开始时间（毫秒），运行态显示实时计时。 */
  startedAt?: number
  /** 结束态一句话：“完成 · 用时 m:ss” / “出错停下”。 */
  summary?: string
  /** 等待态没有允许/拒绝时，唯一按钮的文字。 */
  actionLabel?: string
  requestId?: string
  allowUrl?: string
  denyUrl?: string
  openUrl: string
  connectionState?: 'stale'
}
export const TASK_ACTIVITY_NAME = 'CCHahaTaskActivity'
/** 结束态在锁屏上停留的时间，与电脑端 APNs 结束推送的 dismissal-date（60 秒）一致。 */
export const FINISHED_ACTIVITY_MS = 60_000
const SIMPLE_DECISIONS = ['AskUserQuestion', 'ExitPlanMode', 'ComputerUse']

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

/** 等待态的等宽详情：命令带 “$ ”，提问是题目，计划提示去看全文。 */
function waitingDetail(item: MobileActivity) {
  const preview = item.preview?.trim()
  if (item.toolName === 'Bash') return preview ? `$ ${preview}` : '打开 App 查看命令'
  if (item.toolName === 'AskUserQuestion') return preview || '需要你补充信息'
  if (item.toolName === 'ExitPlanMode') return '打开 App 看完整计划'
  // 其他工具的 preview 是服务端的通用占位，不重复显示。
  return '打开 App 查看详情'
}

const activeCount = (activity: MobileActivity[]) =>
  activity.filter((item) => ['running', 'waiting'].includes(item.activityState))
    .length
const finite = (value?: number | null): value is number =>
  typeof value === 'number' && Number.isFinite(value)

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
    !SIMPLE_DECISIONS.includes(candidate.toolName) &&
    (!candidate.autoAnswerDeadline || candidate.autoAnswerDeadline > now)
  const openUrl = activityUrl(host.id, session.id)
  return {
    hostId: host.id,
    sessionId: session.id,
    hostName: host.name,
    title: (session.title || '进行中的任务').slice(0, 90),
    detail: (waiting ? waitingDetail(candidate) : candidate.preview || '').slice(
      0,
      160
    ),
    status: waiting ? 'waiting' : 'running',
    activeCount: activeCount(activity),
    ...(waiting ? { label: decisionLabel(candidate.toolName) } : {}),
    ...(waiting && !canAnswer
      ? {
          actionLabel:
            candidate.toolName === 'AskUserQuestion'
              ? '去回答'
              : candidate.toolName === 'ExitPlanMode'
                ? '看完整计划'
                : '打开处理',
        }
      : {}),
    ...(!waiting && finite(candidate.startedAt)
      ? { startedAt: candidate.startedAt }
      : {}),
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

export type FinishedActivity = {
  props: TaskActivityProps
  /** 结束态从锁屏消失的时间；已过去时控制器直接结束、不再展示。 */
  dismissAt: number
}

/**
 * 刚结束的任务：成功（有持久化的完成时间）或出错。只用于收尾已经在锁屏上的那张卡，
 * 不会为已结束的任务新开实时活动；停止、消失和未知的空闲都不算成功。
 */
export function finishedActivities(
  host: Host,
  sessions: Session[],
  activity: MobileActivity[],
  now: number
): FinishedActivity[] {
  const others = activeCount(activity)
  return activity.flatMap((item) => {
    const session = sessions.find((value) => value.id === item.id)
    if (!session) return []
    const completed =
      ['idle', 'review'].includes(item.activityState) &&
      item.terminalOutcome === 'completed' &&
      finite(item.completedAt) &&
      item.completedAt > 0
    const failed = item.activityState === 'failed'
    if (!completed && !failed) return []
    const duration =
      completed && finite(item.startedAt) && item.completedAt! >= item.startedAt
        ? ` · 用时 ${formatDuration((item.completedAt! - item.startedAt) / 1000)}`
        : ''
    return [
      {
        props: {
          hostId: host.id,
          sessionId: session.id,
          hostName: host.name,
          title: (session.title || '任务').slice(0, 90),
          detail: '',
          status: completed ? 'completed' : 'failed',
          activeCount: others,
          summary: completed ? `完成${duration}` : '出错停下',
          openUrl: activityUrl(host.id, session.id),
        },
        dismissAt: completed
          ? item.completedAt! + FINISHED_ACTIVITY_MS
          : now + FINISHED_ACTIVITY_MS,
      },
    ]
  })
}
