import type { Storage } from './storage'

export type Appearance = 'light' | 'dark' | 'system'
export type Preferences = Record<string, unknown> & {
  version: 1
  appearance: Appearance
  notifications: { decisions: boolean; completed: boolean; errors: boolean }
  quietHours: { enabled: boolean; start: string; end: string }
  /** 锁屏实时活动：有任务在跑就显示，还是只在等你决定时显示。 */
  liveActivity: LiveActivityMode
  /** 锁屏上是否显示命令内容；关掉后只写「想运行命令」。 */
  liveActivityShowCommand: boolean
  /** 已经给过「开启通知」引导页，不再自动弹。 */
  notifyPrompted: boolean
  /** iOS：审批提醒标成时效性通知，专注模式下也送达。 */
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
    throw new Error('手机设置无法读取，原始数据已保留')
  if (value.version !== undefined && value.version !== 0 && value.version !== 1)
    throw new Error('手机设置来自更新版本，请先升级 App')
  for (const key of ['notifications', 'quietHours']) {
    if (
      value[key] !== undefined &&
      (!value[key] ||
        typeof value[key] !== 'object' ||
        Array.isArray(value[key]))
    )
      throw new Error('通知设置格式无效，原始数据已保留')
  }
  const notifications = value.notifications ?? {}
  const quiet = value.quietHours ?? {}
  for (const key of ['decisions', 'completed', 'errors']) {
    if (
      notifications[key] !== undefined &&
      typeof notifications[key] !== 'boolean'
    )
      throw new Error('通知开关格式无效，原始数据已保留')
  }
  if (quiet.enabled !== undefined && typeof quiet.enabled !== 'boolean')
    throw new Error('勿扰开关格式无效，原始数据已保留')
  for (const key of ['start', 'end']) {
    if (
      quiet[key] !== undefined &&
      (typeof quiet[key] !== 'string' ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(quiet[key]))
    )
      throw new Error('勿扰时间格式无效，原始数据已保留')
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
    // 后加的三项：旧数据没有时取默认值（保持原有行为：运行中也显示、显示命令、没引导过）。
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
