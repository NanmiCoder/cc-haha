import type { MobileActivity } from './dashboard'
import type { Preferences } from '../state/preferences'
import { isQuietTime } from '../state/preferences'

const SIMPLE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'ComputerUse'])
const FILE_EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'])

/** Short titles for pending decisions (lock screen, Dynamic Island and notifications share one tone). */
export function decisionLabel(toolName?: string) {
  if (!toolName) return 'Needs your decision'
  if (toolName === 'Bash' || toolName === 'PowerShell') return 'Wants to run a command'
  if (toolName === 'AskUserQuestion') return 'Asking you'
  if (toolName === 'ExitPlanMode') return 'Plan awaiting your confirmation'
  if (toolName === 'ComputerUse') return 'Wants to use the computer'
  if (FILE_EDIT_TOOLS.has(toolName)) return 'Wants to edit files'
  if (toolName === 'Write') return 'Wants to write a file'
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return 'Wants network access'
  if (READ_TOOLS.has(toolName)) return 'Wants to read files'
  return `Wants to use ${toolName}`
}

/**
 * Notification body: "Wants to run {command}", "Asking you: {question}", "Plan is ready, waiting for your confirmation".
 * The server projects the command only for Bash and the question only for questions; other tools' previews are generic placeholders and are not appended to the body.
 */
export function decisionText(toolName?: string, preview?: string) {
  const text = preview?.trim()
  if (toolName === 'Bash') return text ? `Wants to run ${text}` : 'Wants to run a command'
  if (toolName === 'AskUserQuestion')
    return text ? `Asking you: ${text}` : 'Asking you a question'
  if (toolName === 'ExitPlanMode') return 'Plan is ready, waiting for your confirmation'
  if (toolName === 'ComputerUse') return 'Wants to use the computer, waiting for your permission'
  if (!toolName) return text || 'Needs your decision'
  return `${decisionLabel(toolName)}, waiting for your confirmation`
}

export const NOTIFICATION_COPY = {
  stalled: 'No progress for over 5 minutes, open to check',
  failed: 'Stopped with an error, open to see why',
  completed: 'Finished, open to see the result',
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
          // With "Show commands on lock screen" off, local fallback notifications also hide the raw Bash command.
          preview: decisionText(
            item.toolName,
            item.toolName === 'Bash' && !preferences.liveActivityShowCommand
              ? undefined
              : item.preview
          ),
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

/** The custom fields a notification carries, wherever Expo put them. */
export function notificationRequestData(
  request: NotificationRequestData
): Record<string, unknown> | null {
  const data = request.content.data
  // Expo 58 iOS exposes direct APNs custom fields in trigger.payload; content.data
  // only contains userInfo.body. Local/Expo/FCM data remains authoritative when set.
  if (data != null && (!notificationRecord(data) || Object.keys(data).length))
    return notificationRecord(data) ? data : null
  const trigger = request.trigger
  if (
    notificationRecord(trigger) &&
    trigger.type === 'push' &&
    notificationRecord(trigger.payload)
  )
    return trigger.payload
  return null
}

export function notificationRequestTarget(
  request: NotificationRequestData,
  action: string,
  hostIds: Set<string>
): NotificationTarget | null {
  const data = notificationRequestData(request)
  return data ? notificationTarget(data, action, hostIds) : null
}

/** New public address pushed by the computer (`eventType: 'hostUrl'`), signature not yet verified. */
export type HostUrlUpdate = { hostId: string; url: string; mac: string }
export function hostUrlUpdate(request: NotificationRequestData): HostUrlUpdate | null {
  const data = notificationRequestData(request)
  if (
    !data ||
    data.eventType !== 'hostUrl' ||
    typeof data.hostId !== 'string' ||
    typeof data.url !== 'string' ||
    typeof data.mac !== 'string'
  )
    return null
  return { hostId: data.hostId, url: data.url, mac: data.mac }
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
  // Address updates are for the app itself, not a message for any session.
  if (data.eventType === 'hostUrl') return null
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
