import { classifyPermission } from '../../state/notifyPromptGate'
import type { LiveActivityMode } from '../../state/preferences'
import type { PushState } from './settingsModel'
import type { PushIssue } from '../../state/PushRegistrationContext'

/** System notification permission; null means not read yet. */
export type NotificationPermission = 'granted' | 'denied' | 'undetermined'
export type PermissionSnapshot = {
  status: NotificationPermission
  /** Whether the system will still show the permission prompt; always false on iOS after denial. */
  canAskAgain: boolean
}

/** Fold expo-notifications results into three states: granted-like cases such as provisional also count as granted. */
export function readNotificationPermission(response: {
  granted: boolean
  status?: string
  canAskAgain?: boolean
}): PermissionSnapshot {
  // Shares the classifier with the notification onboarding page: on Android not yet asked reports denied but canAskAgain is still true, which is "not asked".
  const status = classifyPermission({
    granted: response.granted,
    status: response.status ?? 'denied',
    canAskAgain: response.canAskAgain,
  })
  return { status, canAskAgain: status === 'granted' || response.canAskAgain !== false }
}

export type RowTone = 'ok' | 'warn' | 'bad' | 'off'
export type DutyState = {
  running: boolean
  connected: boolean
  batteryOptimizationIgnored: boolean
}
export type DeliveryRow = {
  key: 'system' | 'push' | 'live' | 'background'
  label: string
  value: string
  tone: RowTone
}
export type DeliveryAction = {
  kind: 'request' | 'settings' | 'test' | 'retry' | 'battery' | 'appSettings'
  label: string
  /** primary=ink primary button, secondary = grey button, plain = text button without background. */
  look: 'primary' | 'secondary' | 'plain'
}
export type Delivery = {
  /** checking=still reading status, ok = alerts arrive after leaving the app, blocked = alerts do not arrive after leaving the app. */
  state: 'checking' | 'ok' | 'blocked'
  title: string
  subtitle: string
  rows: DeliveryRow[]
  actions: DeliveryAction[]
  /** When the computer has not set up push, an extra text link to the setup guide appears at the bottom of the card. */
  guide: boolean
}

export type DeliveryInput = {
  platform: 'ios' | 'android'
  permission: PermissionSnapshot | null
  push: { status: PushState; error?: string; issue?: PushIssue } | undefined
  /** undefined when no computer is connected. */
  hostName: string | undefined
  hasHost: boolean
  decisions: boolean
  /**
   * Android pulling from the computer (`desktop` push): the foreground service's
   * state; `null` until first read. Absent for every other channel.
   */
  duty?: DutyState | null
  liveActivity: LiveActivityMode
}

function systemRow(permission: PermissionSnapshot | null): DeliveryRow {
  const base = { key: 'system', label: 'System notifications' } as const
  if (!permission) return { ...base, value: 'Checking…', tone: 'off' }
  if (permission.status === 'granted') return { ...base, value: 'Allowed', tone: 'ok' }
  if (permission.status === 'undetermined')
    return { ...base, value: 'Not turned on yet', tone: 'warn' }
  return { ...base, value: 'Off', tone: 'bad' }
}

function pushRow(input: DeliveryInput): DeliveryRow {
  const base = { key: 'push', label: 'Computer push' } as const
  if (!input.hasHost) return { ...base, value: 'No computer connected yet', tone: 'off' }
  const name = input.hostName ?? 'This computer'
  if (input.push?.issue === 'deviceNotConfigured')
    return { ...base, value: 'Not supported in this version yet', tone: 'warn' }
  if (input.push?.issue === 'deviceUnavailable')
    return { ...base, value: 'Phone push service unavailable for now', tone: 'warn' }
  if (input.push?.issue === 'hostUnsupported')
    return { ...base, value: 'Desktop app needs update', tone: 'warn' }
  if (input.push?.issue === 'authorization')
    return { ...base, value: 'Computer needs reconnecting', tone: 'warn' }
  if (input.push?.issue === 'storage')
    return { ...base, value: 'Registration info cannot be saved', tone: 'bad' }
  if (input.push?.issue === 'relayFailing')
    return { ...base, value: 'Last send failed', tone: 'bad' }
  switch (input.push?.status) {
    case 'registered':
      return {
        ...base,
        value: `Enabled on ${name}`,
        tone: 'ok',
      }
    case 'notConfigured':
      return { ...base, value: `${name} Not set up`, tone: 'warn' }
    case 'permissionRequired':
      return { ...base, value: 'Allow system notifications first', tone: 'warn' }
    case 'unsupported':
      return { ...base, value: 'Not supported on this device yet', tone: 'warn' }
    case 'error':
      return { ...base, value: 'Connection failed', tone: 'bad' }
    default:
      return { ...base, value: 'Checking…', tone: 'off' }
  }
}

/** Android "background connection": stable only when the persistent service is running, connected to the computer, and not restricted by battery optimization. */
export function backgroundRow(duty: DutyState | null): DeliveryRow {
  const base = { key: 'background', label: 'Background connection' } as const
  if (!duty) return { ...base, value: 'Checking…', tone: 'off' }
  if (!duty.running) return { ...base, value: 'Not running', tone: 'bad' }
  if (!duty.connected) return { ...base, value: 'Connecting to computer', tone: 'warn' }
  if (!duty.batteryOptimizationIgnored)
    return { ...base, value: 'Connected, restricted by battery saver', tone: 'warn' }
  return { ...base, value: 'Connected', tone: 'ok' }
}

/**
 * Lock screen Live Activities can only be inferred from what the app knows: none when system notifications are off or "Needs my decision" is off; 
 * JS cannot read the "Live Activities" master switch in system settings, so this does not claim it is definitely on.
 */
export function liveActivityRow(input: DeliveryInput): DeliveryRow {
  const base = { key: 'live', label: 'Lock screen Live Activities' } as const
  if (input.permission?.status !== 'granted')
    return { ...base, value: 'Updates only while the app is open', tone: 'off' }
  if (!input.decisions) return { ...base, value: '“Needs my decision” is off', tone: 'off' }
  return {
    ...base,
    value: input.liveActivity === 'decisions' ? 'Only when waiting for your decision' : 'Enabled',
    tone: 'ok',
  }
}

export function deliveryStatus(input: DeliveryInput): Delivery {
  const system = systemRow(input.permission)
  const push = pushRow(input)
  const rows: DeliveryRow[] = [system, push]
  if (input.platform === 'ios') rows.push(liveActivityRow(input))
  const duty = input.duty
  if (duty !== undefined) rows.push(backgroundRow(duty))

  const permission = input.permission
  const actions: DeliveryAction[] = []
  if (permission?.status === 'undetermined')
    actions.push({ kind: 'request', label: 'Turn on notifications', look: 'primary' })
  else if (permission?.status === 'denied') {
    if (permission.canAskAgain)
      actions.push({ kind: 'request', label: 'Turn on notifications', look: 'primary' })
    actions.push({
      kind: 'settings',
      label: 'Open system settings',
      look: permission.canAskAgain ? 'plain' : 'primary',
    })
  } else if (permission?.status === 'granted')
    actions.push({
      kind: 'test',
      label: 'Test notification',
      look: 'secondary',
    })
  const relayFailing = input.push?.status === 'registered' && input.push.issue === 'relayFailing'
  if (permission?.status === 'granted' && input.hasHost &&
    (input.push?.status === 'notConfigured' || relayFailing || (input.push?.status === 'error' &&
      input.push.issue !== 'authorization' && input.push.issue !== 'storage')))
    actions.push({ kind: 'retry', label: 'Check again', look: 'plain' })
  if (duty) {
    if (!duty.batteryOptimizationIgnored)
      actions.push({ kind: 'battery', label: 'Allow background running', look: 'secondary' })
    // Vendor autostart and background restriction toggles are on the app details page or next to it.
    actions.push({ kind: 'appSettings', label: 'App settings', look: 'plain' })
  }

  const guide = input.hasHost && input.push?.status === 'notConfigured'
  // When system notifications are off the conclusion is settled without waiting for push registration; only when allowed do we wait for the registration result.
  const checking =
    !permission ||
    (permission.status === 'granted' &&
      input.hasHost &&
      (!input.push || input.push.status === 'loading' || duty === null))
  if (checking)
    return {
      state: 'checking',
      title: 'Checking notifications',
      subtitle: 'Getting system permissions and computer push status.',
      rows,
      actions,
      guide,
    }
  // Successful registration does not guarantee delivery: when the computer fails to send via Expo, alerts after leaving the app will not reach the phone.
  if (permission?.status === 'granted' && relayFailing)
    return {
      state: 'blocked',
      title: 'Push delivery failed',
      subtitle: 'The computer failed to send the last alert; you may not receive alerts after leaving the app.',
      rows,
      actions,
      guide,
    }
  // In Android pull mode, whether alerts arrive after leaving the app depends on whether the background connection is really running.
  if (permission?.status === 'granted' && input.push?.status === 'registered' && (!duty || duty.running))
    return {
      state: 'ok',
      title: 'Notifications ready',
      subtitle: 'You can receive alerts from the computer even after leaving the app.',
      rows,
      actions,
      guide,
    }
  if (permission?.status === 'granted' && duty && !duty.running)
    return {
      state: 'blocked',
      title: 'Background connection not running',
      subtitle: 'You will not receive alerts after leaving the app for now. Allow background running, or return to the app to reconnect.',
      rows,
      actions,
      guide,
    }
  return {
    state: 'blocked',
    title:
      permission.status !== 'granted'
        ? 'Notifications off'
        : !input.hasHost
          ? 'No computer connected yet'
          : input.push?.issue === 'deviceNotConfigured'
            ? 'This version does not support background push yet'
          : input.push?.status === 'notConfigured'
            ? 'Computer push not set up'
            : 'Push unavailable for now',
    subtitle:
      permission.status !== 'granted'
        ? 'Turn on system notifications to receive alerts after leaving the app.'
        : !input.hasHost
          ? 'Connect a computer to receive task alerts.'
          : 'For now alerts can only be viewed inside the app.',
    rows,
    actions,
    guide,
  }
}

/** Extra note under the card: only registration failure and unsupported device need one more sentence. */
export function deliveryNote(
  push: DeliveryInput['push'],
  duty?: DeliveryInput['duty']
) {
  if (push?.status === 'registered' && push.issue === 'relayFailing')
    return `${push.error ?? 'The computer failed to send push'}. If the computer reaches the internet through a proxy, configure a network proxy in Settings → General on the desktop app, then tap “Test notification” to confirm.`
  if (duty && push?.status === 'registered')
    return 'After leaving the app, the “On duty” entry in the notification shade keeps the connection to the computer. Xiaomi, Huawei, OPPO, vivo and similar phones also need autostart allowed in app settings and cc-haha locked in recent tasks, otherwise the system may kill it.'
  if (push?.issue === 'deviceNotConfigured')
    return 'This version does not support background push yet; view task alerts inside the app. No need to change phone notification permission again.'
  if (push?.issue === 'deviceUnavailable')
    return 'The phone cannot reach the system push service right now; check the network and check again.'
  if (push?.issue === 'authorization')
    return 'Computer connection authorization expired; reconnect in “Your computers”.'
  if (push?.issue === 'hostUnsupported')
    return 'This computer’s version does not support push registration; please update the desktop app.'
  if (push?.issue === 'storage')
    return 'The phone cannot save push registration info; restart the app and check again.'
  if (push?.issue === 'unknown')
    return 'Push registration did not finish; please check again.'
  if (push?.status === 'notConfigured')
    return 'This computer has not enabled push yet. For now alerts can be viewed inside the app, and testing phone notifications cannot verify computer push.'
  if (push?.status === 'error') return 'Cannot reach computer push; check the connection and retry.'
  if (push?.status === 'unsupported') return 'Computer push is not supported on this device or install version yet.'
  return ''
}

/** Footnote under "Notify me": when system notifications are off, the toggles only control alerts while the app is open. */
export function remindFootnote(permission: PermissionSnapshot | null) {
  return permission && permission.status !== 'granted'
    ? 'With system notifications off, these only decide whether to alert you while the app is open.'
    : ''
}

export const TEST_NOTIFICATION_DELAY_SECONDS = 5

/**
 * Local test notification: sent after a few seconds' delay, leaving time to return to the home screen. Marked the same as test pushes from the computer
 * (`eventType: 'test'`), so a banner shows even while the app is in the foreground.
 */
export const testNotificationContent = {
  title: 'Test notification · cc-haha',
  body: 'If you see this, system notifications work on this phone.',
  data: { eventType: 'test' },
}

/** When the computer does not support remote tests yet (older desktop without the endpoint) fall back to a local notification, stating clearly it only tested the system banner. */
const localTestInstruction = `Go back to the phone home screen and check the notification in ${TEST_NOTIFICATION_DELAY_SECONDS} seconds. This only tests phone notifications; computer push was not verified.`
export const noPushTokenNote = `Cannot test computer push right now. ${localTestInstruction}`
export const testNotificationNote = `Please update the desktop app before testing push. ${localTestInstruction}`
export const noHostTestNote = `No computer connected yet. ${localTestInstruction}`

/** `POST /api/sessions/mobile-push/test` response. */
export type PushTestResult = {
  status: 'sent' | 'notConfigured' | 'noRegistration' | 'failed'
  error?: string
}

/** Turn the computer's test result into one sentence; unknown states count as failure without pretending success. */
export function pushTestNote(result: PushTestResult): string {
  switch (result.status) {
    case 'sent':
      return 'The computer sent a test notification; a banner should appear at the top of the screen.'
    case 'notConfigured':
      return 'Computer push is not set up yet; see “Push setup guide”.'
    case 'noRegistration':
      return 'The computer does not recognize this phone yet; reconnect and retry.'
    default:
      return 'Test notification failed to send; check the computer push settings and retry.'
  }
}

export type TestNotificationOutcome = {
  /** remote=through a real computer push; local = only a local notification was sent. */
  via: 'remote' | 'local'
  note: string
}

/** Three answers when an older desktop has no test endpoint: 404 no route, 405 method not allowed on LAN, 403 rejected by the public allowlist. */
const oldDesktopStatuses = [404, 405, 403]

/**
 * "Send a test notification": prefer having the computer really send one via APNs / FCM; when an older desktop has no such endpoint
 * fall back to a local notification. Other errors (offline, credentials) are thrown as is, without passing off a local notification as success.
 */
export async function runTestNotification(deps: {
  getToken(): Promise<string>
  postTest(body: { token: string; hostId: string }): Promise<PushTestResult>
  scheduleLocal(): Promise<void>
  hostId: string | undefined
}): Promise<TestNotificationOutcome> {
  if (!deps.hostId) {
    await deps.scheduleLocal()
    return { via: 'local', note: noHostTestNote }
  }
  let token: string
  try {
    token = await deps.getToken()
  } catch (error) {
    // No system push credential available (install without FCM / APNs configured, simulator, offline): the computer path cannot be tested, 
    // so only test the local banner and say so truthfully, without throwing native English errors at the user.
    await deps.scheduleLocal()
    if ((error as { code?: string } | null)?.code === 'NOT_CONFIGURED')
      return { via: 'local', note: `This version does not support background push yet. ${localTestInstruction}` }
    return { via: 'local', note: noPushTokenNote }
  }
  try {
    const result = await deps.postTest({ token, hostId: deps.hostId })
    return { via: 'remote', note: pushTestNote(result) }
  } catch (error) {
    const status = (error as { status?: number } | null)?.status
    if (!status || !oldDesktopStatuses.includes(status)) throw error
    await deps.scheduleLocal()
    return { via: 'local', note: testNotificationNote }
  }
}

/** expo-notifications AndroidImportance values (NONE=2 … MAX=7, different from the system's own 0–5). */
export const ANDROID_IMPORTANCE = {
  NONE: 2,
  MIN: 3,
  LOW: 4,
  DEFAULT: 5,
  HIGH: 6,
  MAX: 7,
} as const

/**
 * One line on the right of the "Sounds & vibration" row. Importance and sound changed by the user in the system take precedence: 
 * banner = high importance (pops up); silent = low or minimum; off = channel disabled.
 * Returns an empty string when the channel cannot be read (not created yet, old system), and the row shows no value.
 */
export function channelSummary(
  channel: { importance: number; sound: string | null } | null | undefined
): string {
  if (!channel) return ''
  const { importance } = channel
  if (importance === ANDROID_IMPORTANCE.NONE) return 'Off'
  if (importance === ANDROID_IMPORTANCE.MIN || importance === ANDROID_IMPORTANCE.LOW)
    return 'Silent'
  const loud = channel.sound !== null
  if (importance >= ANDROID_IMPORTANCE.HIGH) return loud ? 'Banner · with sound' : 'Banner'
  return loud ? 'With sound' : 'Silent'
}

/** Channel row title: matches the channel name seen in the system. */
export const channelRows = [
  { kind: 'decisions', title: 'Needs my decision' },
  { kind: 'completed', title: 'Task finished' },
  { kind: 'errors', title: 'Error or stuck' },
] as const

export const channelFootnote = 'Tap an alert type to adjust sound and vibration in system settings.'

/** First row of the computer group: "<name> settings". */
export function computerSettingsTitle(name: string | undefined) {
  const trimmed = name?.trim()
  if (!trimmed) return 'This computer’s settings'
  return `${trimmed} settings`
}

export const liveActivityValue = (mode: LiveActivityMode) =>
  mode === 'decisions' ? 'Only when waiting for your decision' : 'Also show while running'

/** Value on the right of the camera and photo permission rows; hidden when not read yet. */
export function permissionLabel(
  response: { status: string; accessPrivileges?: string } | null
) {
  if (!response) return ''
  if (response.status === 'granted')
    return response.accessPrivileges === 'limited' ? 'Selected photos only' : 'Allowed'
  return response.status === 'undetermined' ? 'Not asked' : 'Not allowed'
}

export const computersValue = (count: number) => `${count} computers`

/** About section of settings: "0.1.0 (12)", with the build number from the native bundle (only the version when unavailable). */
export function versionLabel(version: string | undefined, build?: string | null) {
  if (!version) return 'Unknown version'
  return build ? `${version} (${build})` : version
}

export const repoUrl = 'https://github.com/NanmiCoder/cc-haha'
export const aboutLinks = {
  guide: repoUrl,
  issues: `${repoUrl}/issues`,
  license: `${repoUrl}/blob/main/LICENSE`,
  pushSetup: `${repoUrl}/blob/main/mobile/PUSH_NOTIFICATIONS.md`,
}
