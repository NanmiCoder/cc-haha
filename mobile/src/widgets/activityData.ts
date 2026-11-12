import type { Host, Session } from '../core/types'
import { formatDuration, type MobileActivity } from '../core/dashboard'
import { decisionLabel } from '../core/notifications'

/**
 * Live Activity content state. This structure is also pushed by desktop APNs (with only basic fields), 
 * New fields are always optional, and components backfill when missing.
 */
export type TaskActivityProps = {
  hostId: string
  sessionId: string
  hostName: string
  title: string
  detail: string
  status: 'running' | 'waiting' | 'failed' | 'completed'
  activeCount: number
  /** Waiting state titles: "Wants to run a command", "Asking you", "Plan awaiting your confirmation". */
  label?: string
  /** Start time of this run (ms); running state shows a live timer. */
  startedAt?: number
  /** One line for the ended state: "Done · took m:ss" / "Stopped with error". */
  summary?: string
  /** Text of the only button when the waiting state has no allow/deny. */
  actionLabel?: string
  requestId?: string
  allowUrl?: string
  denyUrl?: string
  openUrl: string
  connectionState?: 'stale'
}
export const TASK_ACTIVITY_NAME = 'CCHahaTaskActivity'
/** How long the ended state stays on the lock screen, matching the dismissal-date (60 seconds) of desktop APNs end pushes. */
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
    detail: 'Status pending update · open the app to reconnect',
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

/**
 * Display preferences of lock screen Live Activities (Settings "Lock screen and Dynamic Island").
 *
 * Note: these two only constrain content generated locally on the phone. Desktop APNs uses the same activity's
 * push token remote override of content-state (see PUSH_NOTIFICATIONS.md), with content assembled by the server,
 * `mobilePushService` which the phone cannot filter. For it to take effect too, the server needs to: 
 * 1. accept and store `liveActivity` and
 *    `showCommand`in Live Activity registration (PUT /api/sessions/mobile-push) (currently validation requires preferences to have exactly 3 keys and allowlists top-level keys, so extra ones are rejected); 
 * 2. in Live Activity pushes: when mode is decisions, send no update for non-waiting states, 
 *    and send end for changes other than running to waiting; when showCommand is false, detail no longer uses
 *    `activity.preview`(the Bash command), and becomes 'Open the app to view the command' / ''.
 */
export type LiveActivityOptions = {
  /** running: show whenever a task is running; decisions: show only when waiting for your decision. Defaults to running. */
  mode?: 'running' | 'decisions'
  /** Whether to show command text on the lock screen. Defaults to true. */
  showCommand?: boolean
}

/** Monospace detail for the waiting state: commands get "$ ", questions show the question, plans point to the full text. */
function waitingDetail(item: MobileActivity, showCommand: boolean) {
  const preview = item.preview?.trim()
  if (item.decision === 'team_plan') return preview || 'Team is ready, awaiting your confirmation'
  if (item.toolName === 'Bash')
    return showCommand && preview ? `$ ${preview}` : 'Open the app to view the command'
  if (item.toolName === 'AskUserQuestion') return preview || 'More info needed from you'
  if (item.toolName === 'ExitPlanMode') return 'Open the app to see the full plan'
  // Previews of other tools are generic server placeholders, not shown again.
  return 'Open the app for details'
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
  now: number,
  options: LiveActivityOptions = {}
): TaskActivityProps | null {
  const { mode = 'running', showCommand = true } = options
  const waitingItem = activity.find(
    (item) => decisions && item.activityState === 'waiting'
  )
  // decisions In mode running tasks produce no activity; returning null makes the controller end the existing one.
  const candidate =
    waitingItem ??
    (mode === 'running'
      ? activity.find((item) => item.activityState === 'running')
      : undefined)
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
    title: (session.title || 'Tasks in progress').slice(0, 90),
    // A running preview may be a command; when commands are hidden the running state shows no detail.
    detail: (waiting
      ? waitingDetail(candidate, showCommand)
      : showCommand
        ? candidate.preview || ''
        : ''
    ).slice(0, 160),
    status: waiting ? 'waiting' : 'running',
    activeCount: activeCount(activity),
    ...(waiting ? { label: decisionLabel(candidate.toolName) } : {}),
    ...(waiting && !canAnswer
      ? {
          actionLabel:
            candidate.decision === 'team_plan'
              ? 'View and configure'
              : candidate.toolName === 'AskUserQuestion'
                ? 'Answer'
                : candidate.toolName === 'ExitPlanMode'
                  ? 'See full plan'
                  : 'Open to handle',
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
  /** Time when the ended state disappears from the lock screen; if already past the controller ends it directly without showing. */
  dismissAt: number
}

/**
 * Tasks that just ended: success (with a persisted completion time) or error. Only used to wrap up a card already on the lock screen; 
 * no new Live Activity is started for ended tasks; stopped, vanished and unknown idle do not count as success.
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
        ? ` · took ${formatDuration((item.completedAt! - item.startedAt) / 1000)}`
        : ''
    return [
      {
        props: {
          hostId: host.id,
          sessionId: session.id,
          hostName: host.name,
          title: (session.title || 'Tasks').slice(0, 90),
          detail: '',
          status: completed ? 'completed' : 'failed',
          activeCount: others,
          summary: completed ? `Done${duration}` : 'Stopped with error',
          openUrl: activityUrl(host.id, session.id),
        },
        dismissAt: completed
          ? item.completedAt! + FINISHED_ACTIVITY_MS
          : now + FINISHED_ACTIVITY_MS,
      },
    ]
  })
}
