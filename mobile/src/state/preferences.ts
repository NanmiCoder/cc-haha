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
  /** 打开 App 时保持屏幕常亮，避免自动息屏。 */
  keepAwake: boolean
}
export type LiveActivityMode = 'running' | 'decisions'
export type PreferencesPatch = Omit<
  Partial<Preferences>,
  'notifications' | 'quietHours'
> & {
  notifications?: Partial<Preferences['notifications']>
  quietHours?: Partial<Preferences['quietHours']>
}
export type WebLocalStorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const preferencesKey = 'cc-haha.mobile.preferences'
export const desktopThemeKey = 'cc-haha-theme'
export const desktopFollowSystemKey = 'cc-haha-follow-system-theme'

function normalizeAppearance(input: unknown): Appearance {
  if (input === 'light' || input === 'dark' || input === 'system') return input
  if (
    input === 'white' ||
    input === 'paper' ||
    input === 'warm-classic' ||
    input === 'celadon'
  )
    return 'light'
  if (input === 'ink-blue' || input === 'neutral-dark') return 'dark'
  return 'system'
}

function getBrowserLocalStorage(): WebLocalStorageLike | null {
  try {
    const scope = globalThis as { window?: { localStorage?: WebLocalStorageLike } }
    const storage = scope.window?.localStorage
    if (
      storage &&
      typeof storage.getItem === 'function' &&
      typeof storage.setItem === 'function'
    )
      return storage
    return null
  } catch {
    return null
  }
}

/**
 * 在同源 Web / H5 环境下，当移动端偏好尚未落盘时，读取桌面端的主题配置作为初始外观：
 * `cc-haha-follow-system-theme === '1'` → `'system'`；
 * `'0'`（或仅存在旧版 `cc-haha-theme`）→ 暗色值映射为 `'dark'`，其余为 `'light'`。
 */
export function readDesktopWebAppearance(
  webStorage?: WebLocalStorageLike | null
): Appearance | null {
  const ls = webStorage === undefined ? getBrowserLocalStorage() : webStorage
  if (!ls) return null
  try {
    const follow = ls.getItem(desktopFollowSystemKey)
    if (follow === '1') return 'system'
    const theme = ls.getItem(desktopThemeKey)
    if (follow === '0') {
      return theme === 'dark' || theme === 'ink-blue' || theme === 'neutral-dark'
        ? 'dark'
        : 'light'
    }
    if (theme !== null) {
      if (theme === 'dark' || theme === 'ink-blue' || theme === 'neutral-dark')
        return 'dark'
      if (
        theme === 'white' ||
        theme === 'light' ||
        theme === 'paper' ||
        theme === 'warm-classic' ||
        theme === 'celadon'
      )
        return 'light'
    }
    return null
  } catch {
    return null
  }
}

/**
 * 将移动端外观偏好镜像到同源桌面端 localStorage 键，保证 `/` 与 `/m/` 切换主题后即时同步。
 * 在受限 WebView 抛出异常时静默降级。
 */
export function mirrorAppearanceToDesktopWeb(
  appearance: Appearance,
  webStorage?: WebLocalStorageLike | null
): void {
  const ls = webStorage === undefined ? getBrowserLocalStorage() : webStorage
  if (!ls) return
  try {
    if (appearance === 'system') {
      ls.setItem(desktopFollowSystemKey, '1')
    } else {
      ls.setItem(desktopFollowSystemKey, '0')
      ls.setItem(desktopThemeKey, appearance === 'dark' ? 'dark' : 'white')
    }
  } catch {
    /* 受限 WebView 禁止写 localStorage 时不影响主流程。 */
  }
}

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
    appearance: normalizeAppearance(value.appearance),
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
    keepAwake: value.keepAwake === true,
  }
}

export class PreferencesRepository {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    private storage: Storage,
    private webStorage?: WebLocalStorageLike | null
  ) {}
  load() {
    return this.serial(async () => {
      const raw = await this.storage.getItem(preferencesKey)
      const result = migratePreferences(raw)
      if (!raw) {
        const inherited = readDesktopWebAppearance(this.webStorage)
        if (inherited) result.appearance = inherited
      }
      if (raw && raw !== JSON.stringify(result))
        await this.storage.setItem(preferencesKey, JSON.stringify(result))
      return result
    })
  }
  update(patch: PreferencesPatch) {
    return this.serial(async () => {
      const raw = await this.storage.getItem(preferencesKey)
      const current = migratePreferences(raw)
      if (!raw) {
        const inherited = readDesktopWebAppearance(this.webStorage)
        if (inherited) current.appearance = inherited
      }
      const next = migratePreferences(
        JSON.stringify({
          ...current,
          ...patch,
          notifications: { ...current.notifications, ...patch.notifications },
          quietHours: { ...current.quietHours, ...patch.quietHours },
        })
      )
      await this.storage.setItem(preferencesKey, JSON.stringify(next))
      mirrorAppearanceToDesktopWeb(next.appearance, this.webStorage)
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
