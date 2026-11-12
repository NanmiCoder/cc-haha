import type { Storage } from './storage'

export type Appearance = 'light' | 'dark' | 'system'
export type Preferences = Record<string, unknown> & {
  version: 1
  appearance: Appearance
  notifications: { decisions: boolean; completed: boolean; errors: boolean }
  quietHours: { enabled: boolean; start: string; end: string }
  /** Lock screen Live Activity: show whenever a task runs, or only when waiting for your decision. */
  liveActivity: LiveActivityMode
  /** Whether to show command content on the lock screen; when off only shows "Wants to run a command". */
  liveActivityShowCommand: boolean
  /** The "Turn on notifications" onboarding page has already been shown; do not auto-show again. */
  notifyPrompted: boolean
  /** iOS: approval alerts are marked time-sensitive and delivered even in Focus mode. */
  timeSensitive: boolean
}
export type LiveActivityMode = 'running' | 'decisions'
export type PreferencesPatch = Omit<
  Partial<Preferences>,
  'notifications' | 'quietHours'
> & {
  notifications?: Partial<Preferences['notifications']>
  quietHours?: Partial<Preferences['quietHours']>
}
export const preferencesKey = 'cc-haha.mobile.preferences'
export function migratePreferences(raw: string | null): Preferences {
  const value = raw ? JSON.parse(raw) : {}
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Phone settings cannot be read; raw data kept')
  if (value.version !== undefined && value.version !== 0 && value.version !== 1)
    throw new Error('Phone settings are from a newer version; please upgrade first App')
  for (const key of ['notifications', 'quietHours']) {
    if (
      value[key] !== undefined &&
      (!value[key] ||
        typeof value[key] !== 'object' ||
        Array.isArray(value[key]))
    )
      throw new Error('Invalid notification settings format; raw data kept')
  }
  const notifications = value.notifications ?? {}
  const quiet = value.quietHours ?? {}
  for (const key of ['decisions', 'completed', 'errors']) {
    if (
      notifications[key] !== undefined &&
      typeof notifications[key] !== 'boolean'
    )
      throw new Error('Invalid notification toggle format; raw data kept')
  }
  if (quiet.enabled !== undefined && typeof quiet.enabled !== 'boolean')
    throw new Error('Invalid quiet hours toggle format; raw data kept')
  for (const key of ['start', 'end']) {
    if (
      quiet[key] !== undefined &&
      (typeof quiet[key] !== 'string' ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(quiet[key]))
    )
      throw new Error('Invalid quiet hours time format; raw data kept')
  }
  const time = (input: unknown, fallback: string) =>
    typeof input === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(input)
      ? input
      : fallback
  return {
    ...value,
    version: 1,
    appearance: ['light', 'dark', 'system'].includes(value.appearance)
      ? value.appearance
      : 'system',
    notifications: {
      ...notifications,
      decisions: notifications.decisions !== false,
      completed: notifications.completed !== false,
      errors: notifications.errors !== false,
    },
    quietHours: {
      ...quiet,
      enabled: quiet.enabled === true,
      start: time(quiet.start, '23:00'),
      end: time(quiet.end, '08:00'),
    },
    // Three later additions: default values when missing in old data (keeping the original behavior: show while running, show commands, not onboarded).
    liveActivity: value.liveActivity === 'decisions' ? 'decisions' : 'running',
    liveActivityShowCommand: value.liveActivityShowCommand !== false,
    notifyPrompted: value.notifyPrompted === true,
    timeSensitive: value.timeSensitive !== false,
  }
}
export class PreferencesRepository {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private storage: Storage) {}
  load() {
    return this.serial(async () => {
      const raw = await this.storage.getItem(preferencesKey)
      const result = migratePreferences(raw)
      if (raw && raw !== JSON.stringify(result))
        await this.storage.setItem(preferencesKey, JSON.stringify(result))
      return result
    })
  }
  update(patch: PreferencesPatch) {
    return this.serial(async () => {
      const current = migratePreferences(
        await this.storage.getItem(preferencesKey)
      )
      const next = migratePreferences(
        JSON.stringify({
          ...current,
          ...patch,
          notifications: { ...current.notifications, ...patch.notifications },
          quietHours: { ...current.quietHours, ...patch.quietHours },
        })
      )
      await this.storage.setItem(preferencesKey, JSON.stringify(next))
      return next
    })
  }
  private serial<T>(task: () => Promise<T>) {
    const result = this.queue.then(task)
    this.queue = result.catch(() => {})
    return result
  }
}

export function isQuietTime(preferences: Preferences, date: Date): boolean {
  if (!preferences.quietHours.enabled) return false
  const minutes = (time: string) =>
    Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
  const current = date.getHours() * 60 + date.getMinutes()
  const start = minutes(preferences.quietHours.start)
  const end = minutes(preferences.quietHours.end)
  return (
    start === end ||
    (start < end
      ? current >= start && current < end
      : current >= start || current < end)
  )
}
