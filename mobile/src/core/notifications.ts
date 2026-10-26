import type { MobileActivity } from './dashboard'
import type { Preferences } from '../state/preferences'
import { isQuietTime } from '../state/preferences'

const SIMPLE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'ComputerUse'])
const FILE_EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'])

/** 待决定事项的短标题（锁屏、灵动岛、通知共用一套口吻）。 */
export function decisionLabel(toolName?: string) {
  if (!toolName) return '需要你决定'
  if (toolName === 'Bash' || toolName === 'PowerShell') return '想运行命令'
  if (toolName === 'AskUserQuestion') return '在问你'
  if (toolName === 'ExitPlanMode') return '计划等你确认'
  if (toolName === 'ComputerUse') return '想操作电脑'
  if (FILE_EDIT_TOOLS.has(toolName)) return '想修改文件'
  if (toolName === 'Write') return '想写入文件'
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return '想联网'
  if (READ_TOOLS.has(toolName)) return '想读取文件'
  return `想使用 ${toolName}`
}

/**
 * 通知正文：“想运行 {命令}”“在问你：{问题}”“计划写好了，等你确认”。
 * 服务端只为 Bash 投影命令、为提问投影题目，其他工具的 preview 是通用占位，不拼进正文。
 */
export function decisionText(toolName?: string, preview?: string) {
  const text = preview?.trim()
  if (toolName === 'Bash') return text ? `想运行 ${text}` : '想运行命令'
  if (toolName === 'AskUserQuestion')
    return text ? `在问你：${text}` : '在问你一个问题'
  if (toolName === 'ExitPlanMode') return '计划写好了，等你确认'
  if (toolName === 'ComputerUse') return '想操作电脑，等你允许'
  if (!toolName) return text || '需要你做决定'
  return `${decisionLabel(toolName)}，等你确认`
}

export const NOTIFICATION_COPY = {
  stalled: '超过 5 分钟没有进展，打开看看',
  failed: '出错停下了，打开查看原因',
  completed: '完成了，打开查看结果',
} as const

export type NotificationEvent = {
  sessionId: string
  requestId?: string
  kind: 'decision' | 'completed' | 'error'
  toolName?: string
  preview: string
  category: 'cchahaTool' | 'cchahaDecision' | 'cchahaResult'
  key: string
}
export function notificationEvents(
  previous: MobileActivity[] | null,
  current: MobileActivity[],
  preferences: Preferences,
  now: Date
): NotificationEvent[] {
  if (isQuietTime(preferences, now)) return []
  const prior = new Map((previous ?? []).map((item) => [item.id, item]))
  return current.flatMap<NotificationEvent>((item) => {
    const before = prior.get(item.id)
    if (
      item.activityState === 'waiting' &&
      preferences.notifications.decisions &&
      (before?.activityState !== 'waiting' ||
        before.requestId !== item.requestId)
    ) {
      return [
        {
          sessionId: item.id,
          requestId: item.requestId,
          kind: 'decision',
          toolName: item.toolName,
          preview: decisionText(item.toolName, item.preview),
          category:
            item.toolName && !SIMPLE_TOOLS.has(item.toolName)
              ? 'cchahaTool'
              : 'cchahaDecision',
          key: `${item.id}:decision:${item.requestId ?? ''}`,
        } satisfies NotificationEvent,
      ]
    }
    if (
      item.activityState === 'running' &&
      item.stalled &&
      !before?.stalled &&
      preferences.notifications.errors
    )
      return [
        {
          sessionId: item.id,
          kind: 'error',
          preview: NOTIFICATION_COPY.stalled,
          category: 'cchahaResult',
          key: `${item.id}:stalled:${item.lastProgressAt ?? ''}`,
        } satisfies NotificationEvent,
      ]
    if (
      item.activityState === 'failed' &&
      before &&
      before.activityState !== 'failed' &&
      preferences.notifications.errors
    )
      return [
        {
          sessionId: item.id,
          kind: 'error',
          preview: NOTIFICATION_COPY.failed,
          category: 'cchahaResult',
          key: `${item.id}:error`,
        } satisfies NotificationEvent,
      ]
    if (
      ['idle', 'review'].includes(item.activityState) &&
      item.terminalOutcome === 'completed' &&
      Number.isFinite(item.completedAt) &&
      (item.completedAt ?? 0) > 0 &&
      before &&
      before.completedAt !== item.completedAt &&
      preferences.notifications.completed
    )
      return [
        {
          sessionId: item.id,
          kind: 'completed',
          preview: NOTIFICATION_COPY.completed,
          category: 'cchahaResult',
          key: `${item.id}:completed:${item.completedAt}`,
        } satisfies NotificationEvent,
      ]
    return []
  })
}
export type NotificationTarget = {
  hostId: string
  sessionId: string
  requestId?: string
  action?: 'allow' | 'deny'
}
export type NotificationRequestData = {
  identifier: string
  content: { data?: unknown }
  trigger?: unknown
}

function notificationRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function notificationRequestTarget(
  request: NotificationRequestData,
  action: string,
  hostIds: Set<string>
): NotificationTarget | null {
  const data = request.content.data
  // Expo 58 iOS exposes direct APNs custom fields in trigger.payload; content.data
  // only contains userInfo.body. Local/Expo/FCM data remains authoritative when set.
  if (data != null && (!notificationRecord(data) || Object.keys(data).length))
    return notificationRecord(data) ? notificationTarget(data, action, hostIds) : null
  const trigger = request.trigger
  if (
    notificationRecord(trigger) &&
    trigger.type === 'push' &&
    notificationRecord(trigger.payload)
  )
    return notificationTarget(trigger.payload, action, hostIds)
  return null
}

export function routeNotificationResponse(
  response: {
    notification: { request: NotificationRequestData }
    actionIdentifier: string
  },
  options: {
    ready: boolean
    hostIds: Set<string>
    handled: Set<string>
    open: (target: NotificationTarget) => void
  }
): boolean {
  if (!options.ready) return false
  const key = `${response.notification.request.identifier}:${response.actionIdentifier}`
  if (options.handled.has(key)) return false
  const target = notificationRequestTarget(
    response.notification.request,
    response.actionIdentifier,
    options.hostIds
  )
  if (!target) return false
  options.open(target)
  options.handled.add(key)
  return true
}

export function notificationTarget(
  data: Record<string, unknown>,
  action: string,
  hostIds: Set<string>
): NotificationTarget | null {
  if (
    typeof data.hostId !== 'string' ||
    !hostIds.has(data.hostId) ||
    typeof data.sessionId !== 'string' ||
    !data.sessionId ||
    data.sessionId.length > 200
  )
    return null
  const requestId =
    typeof data.requestId === 'string' && data.requestId.length <= 200
      ? data.requestId
      : undefined
  const decision =
    (action === 'allow' || action === 'deny') && requestId ? action : undefined
  return {
    hostId: data.hostId,
    sessionId: data.sessionId,
    requestId,
    action: decision,
  }
}
