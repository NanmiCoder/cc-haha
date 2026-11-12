/** Trigger decision and Continue flow for the notification onboarding page. Kept pure without native modules for easy unit testing. */

export type NotifyPermission = 'undetermined' | 'granted' | 'denied' | 'unknown'

export type NotifyGateInput = {
  platform: string
  /** AppContext Finished reading the locally saved computer list. */
  appReady: boolean
  hostCount: number
  preferencesReady: boolean
  preferencesError: boolean
  /** preferences.notifyPrompted: the onboarding page has already appeared (or the system asked long ago). */
  prompted: boolean
  /** System notification permission; unknown when not read yet. */
  permission: NotifyPermission
  /** Currently on home (just connected a computer and returned home, or cold start landed on home). */
  onHome: boolean
}

export type NotifyGateDecision = 'show' | 'markPrompted' | 'none'

/**
 * Fold expo-notifications permission results into three states. Note Android: before asking it reports `denied`, 
 * but `canAskAgain` is still true; only "not granted and cannot ask again" means the user really denied.
 * iOS Not asked yet is `undetermined`, and after denial `canAskAgain` is false, which also applies.
 */
export function classifyPermission(result: {
  granted: boolean
  status: string
  canAskAgain?: boolean
}): Exclude<NotifyPermission, 'unknown'> {
  if (result.granted) return 'granted'
  if (result.status === 'undetermined') return 'undetermined'
  return result.canAskAgain === false ? 'denied' : 'undetermined'
}

/**
 * Show the onboarding page only when "the system has not asked yet" and the user is on home (the caller ensures once per run); 
 * if the system already has an answer (allow or deny) record it silently and never show again.
 */
export function decideNotifyPrompt(input: NotifyGateInput): NotifyGateDecision {
  if (input.platform === 'web') return 'none'
  if (!input.appReady || input.hostCount === 0) return 'none'
  if (!input.preferencesReady || input.preferencesError) return 'none'
  if (input.prompted) return 'none'
  if (input.permission === 'unknown') return 'none'
  if (input.permission !== 'undetermined') return 'markPrompted'
  if (!input.onHome) return 'none'
  return 'show'
}

/**
 * Tap Continue: first ensure the Android channel exists, then show the system prompt, and finally whether allowed, denied or errored
 * record as onboarded and leave — denying must not block the user from using the app.
 */
export async function continueNotifyPrompt(deps: {
  ensureChannel(): Promise<void>
  request(): Promise<unknown>
  markPrompted(): Promise<void>
  /** After the system permission flow ends, push registration rechecks the permission. */
  decided?(): void
}) {
  try {
    await deps.ensureChannel()
  } catch {
    // Still request as usual when the channel fails; Android 12 and below have no runtime prompt.
  }
  try {
    await deps.request()
  } catch {
    // A failed request is treated as not granted; it can still be enabled in Settings.
  }
  try {
    await deps.markPrompted()
  } catch {
    // A failed preference write only means onboarding shows again on next launch, without blocking the user.
  }
  deps.decided?.()
}

type Listener = () => void
const listeners = new Set<Listener>()

/** Push registration subscribes to "permission has an answer", so it need not wait for the next foreground return to register. */
export function subscribePermissionDecided(listener: Listener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitPermissionDecided() {
  for (const listener of [...listeners]) listener()
}
