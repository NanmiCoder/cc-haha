import type { Preferences } from '../../state/preferences'

/** Consistent with PushRegistrationContext states; here we only care what the UI says. */
export type PushState =
  | 'loading'
  | 'registered'
  | 'notConfigured'
  | 'permissionRequired'
  | 'unsupported'
  | 'error'

export type QuietHours = Preferences['quietHours']
export type AutoQuestion = { enabled: boolean; timeoutMinutes: number }

const time = /^([01]\d|2[0-3]):[0-5]\d$/

/** Value on the right of the "Quiet hours" row in settings. Start equal to end counts as all day (consistent with isQuietTime). */
export function quietSummary(quiet: QuietHours) {
  if (!quiet.enabled) return 'Off'
  if (quiet.start === quiet.end) return 'All day'
  return `${quiet.start} – ${quiet.end}`
}

/** The quiet hours sheet validates everything on "Done" and writes only if valid; the toggle no longer takes effect on its own immediately. */
export function validateQuietHours(
  draft: QuietHours
): { value: QuietHours; error?: undefined } | { value?: undefined; error: string } {
  const start = draft.start.trim()
  const end = draft.end.trim()
  if (!time.test(start) || !time.test(end))
    return { error: 'Please enter time in HH:mm format' }
  return { value: { ...draft, start, end } }
}

export function quietHint(draft: QuietHours) {
  const start = draft.start.trim()
  return draft.enabled && time.test(start) && start === draft.end.trim()
    ? 'Same start and end means quiet all day.'
    : ''
}

/** Footnote under the group: one sentence each for the four abnormal push registration states and the registered state. */
export function pushFootnote(
  push: { status: PushState; error?: string } | undefined,
  hostName: string | undefined
) {
  switch (push?.status) {
    case 'registered':
      return `${hostName ?? 'This computer'} Push is set up; you receive alerts even when the app is not in the foreground.`
    case 'notConfigured':
      return 'The computer has not set up APNs / FCM push yet. Syncing works as usual while the app is open; to get notifications after leaving the app, set up push on the computer first.'
    case 'permissionRequired':
      return 'The system has not allowed cc-haha to send notifications. Turn it on in system settings, or turn the toggle above off and on again.'
    case 'unsupported':
      return 'This device cannot register remote notifications right now.'
    case 'error':
      return push.error || 'Failed to register remote notifications; check the computer connection.'
    default:
      return ''
  }
}

/** AI Auto-answer tiers, matching AUTO_QUESTION_TIMEOUT_OPTIONS on the desktop; 0 means no auto-answer. */
export const autoAnswerMinutes = [0, 1, 5, 10, 30] as const
const timeouts = [1, 5, 10, 30]

export const autoAnswerLabel = (minutes: number) =>
  minutes > 0 ? `${minutes} min` : 'No auto-answer'

/** Value on the right of the "While I am away" row. */
export function autoAnswerValue(current: AutoQuestion) {
  return current.enabled ? `Wait ${current.timeoutMinutes} minutes` : 'No auto-answer'
}

export const selectedMinutes = (current: AutoQuestion) =>
  current.enabled ? current.timeoutMinutes : 0

/** autoQuestion written back to the computer: keep the original wait time when turning off. */
export function nextAutoQuestion(
  current: AutoQuestion,
  minutes: number
): AutoQuestion {
  return {
    enabled: minutes > 0,
    timeoutMinutes: minutes > 0 ? minutes : current.timeoutMinutes,
  }
}

/** Read per the desktop normalizeAutoQuestionSettings rules: missing or invalid counts as off, 5 minutes. */
export function readAutoQuestion(settings: { autoQuestion?: unknown }): AutoQuestion {
  const value = settings.autoQuestion
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { enabled: false, timeoutMinutes: 5 }
  const record = value as Record<string, unknown>
  return {
    enabled: record.enabled === true,
    timeoutMinutes: timeouts.find((minutes) => minutes === record.timeoutMinutes) ?? 5,
  }
}

export const desktopOnly = [
  'MCP, skills and plugins',
  'Providers and API keys',
  'Official account sign-in',
  'IM bots',
  'LAN and public access',
].join(' · ')
