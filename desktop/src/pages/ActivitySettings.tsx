import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import { activityStatsApi, type ActivityStatsResponse, type DailyActivity } from '../api/activityStats'
import {
  desktopUiPreferencesApi,
  getProfileAvatarUrl,
  type DesktopProfilePreferences,
} from '../api/desktopUiPreferences'
import { type Locale, useTranslation } from '../i18n'
import { useSettingsStore } from '../stores/settingsStore'
import { publicAssetPath } from '../lib/publicAsset'

type HeatmapDay = {
  date: string
  sessionCount: number
  messageCount: number
  toolCallCount: number
  tokens: number
  level: number
  mode: HeatmapMode
  rangeStart?: string
  rangeEnd?: string
}

type SummaryMetric = {
  label: string
  value: string
  detail?: string
}

type InsightMetric = {
  label: string
  value: string
  detail?: string
}

type PluginRankItem = {
  id: string
  label: string
  count: number
  kind: 'plugin' | 'skill'
}

type HeatmapMode = 'daily' | 'weekly' | 'cumulative'

const WEEK_COUNT = 52
const WEEKDAY_LABEL_KEYS = [
  'settings.activity.weekday.mon',
  'settings.activity.weekday.wed',
  'settings.activity.weekday.fri',
] as const
const HEAT_CELL_GAP = 3
const HEAT_LABEL_WIDTH = 38
const HEAT_CELL_MIN = 6
const HEAT_CELL_MAX = 22
const TOOLTIP_WIDTH = 172
const HEAT_COLORS = [
  'var(--color-activity-heat-0)',
  'var(--color-activity-heat-1)',
  'var(--color-activity-heat-2)',
  'var(--color-activity-heat-3)',
  'var(--color-activity-heat-4)',
]
const DATE_LOCALES: Record<Locale, string> = {
  en: 'en-US',
  zh: 'zh-CN',
  'zh-TW': 'zh-TW',
  jp: 'ja-JP',
  kr: 'ko-KR',
}
const DEFAULT_PROFILE: DesktopProfilePreferences = {
  displayName: 'cc-haha',
  subtitle: 'github.com/NanmiCoder/cc-haha',
  avatarFile: null,
  avatarUpdatedAt: null,
}
const DEFAULT_AVATAR_SRC = publicAssetPath('app-icon.png')

function localDateKey(date: Date) {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parseLocalDate(dateKey: string) {
  return new Date(`${dateKey}T00:00:00`)
}

function addDays(date: Date, days: number) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function startOfWeek(date: Date) {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  next.setDate(next.getDate() - next.getDay())
  return next
}

function formatDateLabel(dateKey: string, locale: Locale) {
  return parseLocalDate(dateKey).toLocaleDateString(DATE_LOCALES[locale], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function formatTokens(tokens: number) {
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(tokens >= 10_000_000_000 ? 0 : 1)}B`
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return `${tokens}`
}

function formatInteger(value: number, locale: Locale) {
  return new Intl.NumberFormat(DATE_LOCALES[locale], { maximumFractionDigits: 0 }).format(value)
}

function formatPercent(numerator: number, denominator: number, locale: Locale) {
  if (denominator <= 0) return '0%'
  return new Intl.NumberFormat(DATE_LOCALES[locale], {
    maximumFractionDigits: 0,
    style: 'percent',
  }).format(numerator / denominator)
}

function formatDayCount(value: number, t: ReturnType<typeof useTranslation>) {
  return t(value === 1 ? 'settings.activity.count.dayOne' : 'settings.activity.count.dayOther', { count: value })
}

function formatTaskDuration(duration: number | undefined, locale: Locale, t: ReturnType<typeof useTranslation>) {
  if (!duration || duration <= 0) return t('settings.activity.noDuration')
  const totalMinutes = Math.max(1, Math.round(duration / 60_000))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60

  if (locale === 'zh') {
    if (hours > 0 && minutes > 0) return `${hours} 小时 ${minutes} 分钟`
    if (hours > 0) return `${hours} 小时`
    return `${minutes} 分钟`
  }

  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h`
  return `${minutes}m`
}

function formatSessionCount(value: number, t: ReturnType<typeof useTranslation>) {
  return t(value === 1 ? 'settings.activity.count.sessionOne' : 'settings.activity.count.sessionOther', { count: value })
}

function formatMessageCount(value: number, t: ReturnType<typeof useTranslation>) {
  return `${value} ${t('settings.activity.messages')}`
}

function formatRunCount(value: number, t: ReturnType<typeof useTranslation>) {
  return t(value === 1 ? 'settings.activity.count.runOne' : 'settings.activity.count.runOther', { count: value })
}

function getModelTokenTotal(usage: ActivityStatsResponse['modelUsage'][string] | undefined) {
  if (!usage) return 0
  return (
    (usage.inputTokens ?? 0) +
    (usage.outputTokens ?? 0) +
    (usage.cacheReadInputTokens ?? 0) +
    (usage.cacheCreationInputTokens ?? 0)
  )
}

function formatModelName(model: string) {
  return model
    .replace(/^claude-/i, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function getPluginNameFromToolName(toolName: string) {
  if (!toolName.startsWith('mcp__')) return null
  const parts = toolName.split('__').filter(Boolean)
  const serverName = parts[1]
  if (!serverName) return null
  if (serverName === 'codex_apps' && parts[2]) return parts[2]
  return serverName
}

function formatPluginName(pluginName: string) {
  return pluginName.replace(/_/g, '-')
}

function buildPluginAndSkillRankItems(stats: ActivityStatsResponse | null) {
  const skillItems = Object.entries(stats?.skillUsage ?? {}).map<PluginRankItem>(([skill, count]) => ({
    id: `skill:${skill}`,
    label: `$${skill}`,
    count,
    kind: 'skill',
  }))

  const pluginUsage = new Map<string, number>()
  for (const [toolName, count] of Object.entries(stats?.toolUsage ?? {})) {
    const pluginName = getPluginNameFromToolName(toolName)
    if (!pluginName || count <= 0) continue
    pluginUsage.set(pluginName, (pluginUsage.get(pluginName) || 0) + count)
  }
  const pluginItems = [...pluginUsage.entries()].map<PluginRankItem>(([pluginName, count]) => ({
    id: `plugin:${pluginName}`,
    label: `@${formatPluginName(pluginName)}`,
    count,
    kind: 'plugin',
  }))

  return [...skillItems, ...pluginItems]
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, 6)
}

function withProfileDefaults(profile: Partial<DesktopProfilePreferences> | null | undefined): DesktopProfilePreferences {
  return { ...DEFAULT_PROFILE, ...profile }
}

function getProfileSubtitleHref(subtitle: string) {
  if (/^https?:\/\//i.test(subtitle)) return subtitle
  if (/^[\w.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(subtitle)) return `https://${subtitle}`
  return null
}

function calculateHeatCellSize(width: number) {
  const available = width - HEAT_LABEL_WIDTH - (WEEK_COUNT - 1) * HEAT_CELL_GAP
  return Math.max(HEAT_CELL_MIN, Math.min(HEAT_CELL_MAX, Math.floor(available / WEEK_COUNT)))
}

function sumDailyUsage(days: HeatmapDay[]) {
  return days.reduce(
    (sum, day) => ({
      sessions: sum.sessions + day.sessionCount,
      tokens: sum.tokens + day.tokens,
    }),
    { sessions: 0, tokens: 0 },
  )
}

function getDailyTokenMap(stats: ActivityStatsResponse | null) {
  const map = new Map<string, number>()
  for (const day of stats?.dailyModelTokens ?? []) {
    const total = Object.values(day.tokensByModel).reduce((sum, tokens) => sum + tokens, 0)
    map.set(day.date, total)
  }
  return map
}

function getHeatLevel(day: DailyActivity | undefined, tokens: number, maxScore: number) {
  const sessionCount = day?.sessionCount ?? 0
  if (sessionCount === 0 && tokens === 0) return 0
  if (maxScore <= 0) return 1

  const score = sessionCount * 3 + Math.ceil(tokens / 50_000)
  const ratio = score / maxScore
  if (ratio >= 0.78) return 4
  if (ratio >= 0.5) return 3
  if (ratio >= 0.24) return 2
  return 1
}

function getBarHeight(value: number, maxValue: number) {
  if (value <= 0 || maxValue <= 0) return 0
  return Math.max(1, Math.min(7, Math.ceil((value / maxValue) * 7)))
}

function getBarLevel(value: number, maxValue: number) {
  if (value <= 0) return 0
  if (maxValue <= 0) return 1
  const ratio = value / maxValue
  if (ratio >= 0.78) return 4
  if (ratio >= 0.5) return 3
  if (ratio >= 0.24) return 2
  return 1
}

function buildHeatmapDays(stats: ActivityStatsResponse | null, mode: HeatmapMode) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const finalWeekStart = startOfWeek(today)
  const start = addDays(finalWeekStart, -(WEEK_COUNT - 1) * 7)
  const activityMap = new Map((stats?.dailyActivity ?? []).map((day) => [day.date, day]))
  const tokenMap = getDailyTokenMap(stats)
  const dates: string[] = []
  for (let cursor = new Date(start); cursor <= today; cursor = addDays(cursor, 1)) {
    dates.push(localDateKey(cursor))
  }

  const scores: number[] = []
  let cumulativeTokens = 0
  for (const dateKey of dates) {
    const day = activityMap.get(dateKey)
    const tokens = tokenMap.get(dateKey) ?? 0
    cumulativeTokens += tokens
    scores.push((day?.sessionCount ?? 0) * 3 + Math.ceil(tokens / 50_000))
  }
  const maxScore = Math.max(...scores, 0)

  const days: HeatmapDay[] = []
  cumulativeTokens = 0
  for (const dateKey of dates) {
    const day = activityMap.get(dateKey)
    const tokens = tokenMap.get(dateKey) ?? 0
    cumulativeTokens += tokens
    days.push({
      date: dateKey,
      sessionCount: day?.sessionCount ?? 0,
      messageCount: day?.messageCount ?? 0,
      toolCallCount: day?.toolCallCount ?? 0,
      tokens,
      level: getHeatLevel(day, tokens, maxScore),
      mode: 'daily',
    })
  }

  if (mode === 'daily') return days

  const weeks = Array.from({ length: WEEK_COUNT }, (_, index) => {
    const rangeStart = dates[index * 7] ?? ''
    const rangeEnd = dates[Math.min(index * 7 + 6, dates.length - 1)] ?? rangeStart
    return {
      rangeStart,
      rangeEnd,
      sessionCount: 0,
      messageCount: 0,
      toolCallCount: 0,
      tokens: 0,
      cumulativeTokens: 0,
    }
  })

  dates.forEach((dateKey, index) => {
    const week = weeks[Math.floor(index / 7)]
    const day = activityMap.get(dateKey)
    if (!week) return
    week.sessionCount += day?.sessionCount ?? 0
    week.messageCount += day?.messageCount ?? 0
    week.toolCallCount += day?.toolCallCount ?? 0
    week.tokens += tokenMap.get(dateKey) ?? 0
  })

  let runningTotal = 0
  for (const week of weeks) {
    runningTotal += week.tokens
    week.cumulativeTokens = runningTotal
  }

  const maxValue = Math.max(
    ...weeks.map((week) => (mode === 'weekly' ? week.tokens : week.cumulativeTokens)),
    0,
  )

  return dates.map((dateKey, index) => {
    const week = weeks[Math.floor(index / 7)]
    const row = index % 7
    const tokens = mode === 'weekly' ? week?.tokens ?? 0 : week?.cumulativeTokens ?? 0
    const height = getBarHeight(tokens, maxValue)
    const isFilled = height > 0 && row >= 7 - height

    return {
      date: dateKey,
      sessionCount: week?.sessionCount ?? 0,
      messageCount: week?.messageCount ?? 0,
      toolCallCount: week?.toolCallCount ?? 0,
      tokens,
      level: isFilled ? getBarLevel(tokens, maxValue) : 0,
      mode,
      rangeStart: week?.rangeStart,
      rangeEnd: week?.rangeEnd,
    }
  })
}

function buildMonthLabels(days: HeatmapDay[], locale: Locale) {
  if (days.length === 0) return []
  const labels: Array<{ week: number; label: string }> = []
  const firstDay = days[0]
  const lastDay = days[days.length - 1]
  if (!firstDay || !lastDay) return labels

  const firstDate = parseLocalDate(firstDay.date)
  const lastDate = parseLocalDate(lastDay.date)
  let previousMonth = -1

  for (let week = 0; week < WEEK_COUNT; week += 1) {
    const weekDate = addDays(firstDate, week * 7)
    if (weekDate > lastDate) break
    if (weekDate.getMonth() !== previousMonth) {
      labels.push({
        week,
        label: weekDate.toLocaleDateString(DATE_LOCALES[locale], { month: 'short' }),
      })
      previousMonth = weekDate.getMonth()
    }
  }

  return labels
}

function getHeatmapCellTitle(day: HeatmapDay, locale: Locale, t: ReturnType<typeof useTranslation>) {
  if (day.mode === 'weekly') {
    return t('settings.activity.weekRange', {
      start: formatDateLabel(day.rangeStart ?? day.date, locale),
      end: formatDateLabel(day.rangeEnd ?? day.date, locale),
    })
  }

  if (day.mode === 'cumulative') {
    return t('settings.activity.cumulativeThrough', {
      date: formatDateLabel(day.rangeEnd ?? day.date, locale),
    })
  }

  return formatDateLabel(day.date, locale)
}

function getHeatmapCellDetail(day: HeatmapDay, t: ReturnType<typeof useTranslation>) {
  if (day.mode === 'cumulative') {
    return t('settings.activity.tokenValue', { tokens: formatTokens(day.tokens) })
  }

  return `${formatSessionCount(day.sessionCount, t)} · ${formatTokens(day.tokens)} ${t('settings.activity.tokens')}`
}

export function ActivitySettings() {
  const t = useTranslation()
  const locale = useSettingsStore((state) => state.locale)
  const heatmapMeasureRef = useRef<HTMLDivElement | null>(null)
  const avatarInputRef = useRef<HTMLInputElement | null>(null)
  const [stats, setStats] = useState<ActivityStatsResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [profile, setProfile] = useState<DesktopProfilePreferences>(DEFAULT_PROFILE)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [profileStatus, setProfileStatus] = useState<string | null>(null)
  const [isProfileLoading, setIsProfileLoading] = useState(true)
  const [isEditingProfile, setIsEditingProfile] = useState(false)
  const [isSavingProfile, setIsSavingProfile] = useState(false)
  const [draftDisplayName, setDraftDisplayName] = useState(DEFAULT_PROFILE.displayName)
  const [draftSubtitle, setDraftSubtitle] = useState(DEFAULT_PROFILE.subtitle)
  const [heatmapMode, setHeatmapMode] = useState<HeatmapMode>('daily')
  const [hoveredDate, setHoveredDate] = useState<string | null>(null)
  const [focusedDate, setFocusedDate] = useState<string | null>(null)
  const [heatCellSize, setHeatCellSize] = useState(10)

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    setError(null)

    activityStatsApi.getStats('all')
      .then((nextStats) => {
        if (cancelled) return
        setStats(nextStats)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setIsProfileLoading(true)
    setProfileError(null)

    desktopUiPreferencesApi.getPreferences()
      .then((result) => {
        if (cancelled) return
        const nextProfile = withProfileDefaults(result.preferences.profile)
        setProfile(nextProfile)
        setDraftDisplayName(nextProfile.displayName)
        setDraftSubtitle(nextProfile.subtitle)
      })
      .catch((err) => {
        if (cancelled) return
        setProfileError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setIsProfileLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (isLoading || error) return
    const element = heatmapMeasureRef.current
    if (!element) return

    const updateCellSize = () => {
      const nextSize = calculateHeatCellSize(element.clientWidth)
      setHeatCellSize((current) => (current === nextSize ? current : nextSize))
    }

    updateCellSize()

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(updateCellSize)
      observer.observe(element)
      return () => observer.disconnect()
    }

    window.addEventListener('resize', updateCellSize)
    return () => window.removeEventListener('resize', updateCellSize)
  }, [error, isLoading])

  const days = useMemo(() => buildHeatmapDays(stats, heatmapMode), [heatmapMode, stats])
  const monthLabels = useMemo(() => buildMonthLabels(days, locale), [days, locale])
  const today = days.length > 0 ? days[days.length - 1] : null
  const activeTooltipDate = hoveredDate ?? focusedDate
  const tooltipDay = days.find((day) => day.date === activeTooltipDate) ?? null
  const tooltipIndex = tooltipDay ? days.findIndex((day) => day.date === tooltipDay.date) : -1
  const heatGridWidth = WEEK_COUNT * heatCellSize + (WEEK_COUNT - 1) * HEAT_CELL_GAP
  const heatGridHeight = 7 * heatCellSize + 6 * HEAT_CELL_GAP
  const heatmapWidth = HEAT_LABEL_WIDTH + heatGridWidth
  const tooltipStyle = tooltipIndex >= 0
    ? {
        left: Math.max(
          HEAT_LABEL_WIDTH,
          Math.min(
            heatmapWidth - TOOLTIP_WIDTH,
            HEAT_LABEL_WIDTH + Math.floor(tooltipIndex / 7) * (heatCellSize + HEAT_CELL_GAP) - 52,
          ),
        ),
        top: Math.max(28, 30 + (tooltipIndex % 7) * (heatCellSize + HEAT_CELL_GAP) - 50),
    }
    : undefined
  const last30Usage = sumDailyUsage(days.slice(-30))
  const totalTokens = useMemo(() => {
    return (stats?.dailyModelTokens ?? []).reduce((sum, day) => (
      sum + Object.values(day.tokensByModel).reduce((daySum, tokens) => daySum + tokens, 0)
    ), 0)
  }, [stats])
  const totalToolCalls = useMemo(() => {
    return (stats?.dailyActivity ?? []).reduce((sum, day) => sum + day.toolCallCount, 0)
  }, [stats])
  const totalSkillUses = useMemo(() => {
    return Object.values(stats?.skillUsage ?? {}).reduce((sum, count) => sum + count, 0)
  }, [stats])
  const exploredSkillsCount = Object.keys(stats?.skillUsage ?? {}).length
  const topModel = useMemo(() => {
    return Object.entries(stats?.modelUsage ?? {}).reduce<{
      model: string
      tokens: number
    } | null>((top, [model, usage]) => {
      const tokens = getModelTokenTotal(usage)
      if (tokens <= 0) return top
      if (!top || tokens > top.tokens) return { model, tokens }
      return top
    }, null)
  }, [stats])
  const peakTokens = useMemo(() => {
    return (stats?.dailyModelTokens ?? []).reduce((peak, day) => {
      const dayTotal = Object.values(day.tokensByModel).reduce((sum, tokens) => sum + tokens, 0)
      return Math.max(peak, dayTotal)
    }, 0)
  }, [stats])
  const topPluginItems = useMemo(() => buildPluginAndSkillRankItems(stats), [stats])
  const metrics: SummaryMetric[] = [
    {
      label: t('settings.activity.totalTokens'),
      value: formatTokens(totalTokens),
      detail: formatDayCount(stats?.activeDays ?? 0, t),
    },
    {
      label: t('settings.activity.peakTokens'),
      value: formatTokens(peakTokens),
      detail: stats?.peakActivityDay ? formatDateLabel(stats.peakActivityDay, locale) : undefined,
    },
    {
      label: t('settings.activity.longestTask'),
      value: formatTaskDuration(stats?.longestSession?.duration, locale, t),
      detail: stats?.longestSession ? formatMessageCount(stats.longestSession.messageCount, t) : undefined,
    },
    {
      label: t('settings.activity.currentStreak'),
      value: formatDayCount(stats?.streaks.currentStreak ?? 0, t),
      detail: today ? `${formatTokens(today.tokens)} ${t('settings.activity.tokens')}` : undefined,
    },
    {
      label: t('settings.activity.longestStreak'),
      value: formatDayCount(stats?.streaks.longestStreak ?? 0, t),
      detail: formatSessionCount(last30Usage.sessions, t),
    },
  ]
  const insightMetrics: InsightMetric[] = [
    {
      label: t('settings.activity.activeRate'),
      value: formatPercent(stats?.activeDays ?? 0, stats?.totalDays ?? 0, locale),
    },
    {
      label: t('settings.activity.mostUsedModel'),
      value: topModel ? formatModelName(topModel.model) : t('settings.activity.none'),
      detail: topModel ? `${formatTokens(topModel.tokens)} ${t('settings.activity.tokens')}` : undefined,
    },
    {
      label: t('settings.activity.exploredSkills'),
      value: formatInteger(exploredSkillsCount, locale),
    },
    {
      label: t('settings.activity.totalSkillUses'),
      value: formatInteger(totalSkillUses, locale),
    },
    {
      label: t('settings.activity.totalToolCalls'),
      value: formatInteger(totalToolCalls, locale),
    },
    {
      label: t('settings.activity.totalSessions'),
      value: formatInteger(stats?.totalSessions ?? 0, locale),
    },
  ]
  const avatarSrc = profile.avatarFile ? getProfileAvatarUrl(profile.avatarUpdatedAt) : DEFAULT_AVATAR_SRC
  const avatarClassName = profile.avatarFile
    ? 'h-full w-full object-cover'
    : 'h-full w-full scale-[1.28] object-contain transition-transform'
  const profileSubtitleHref = getProfileSubtitleHref(profile.subtitle)
  const hasUsage = Boolean(stats && (stats.totalSessions > 0 || totalTokens > 0))
  const modeOptions: Array<{ mode: HeatmapMode; label: string; help: string }> = [
    { mode: 'daily', label: t('settings.activity.mode.daily'), help: t('settings.activity.modeHelp.daily') },
    { mode: 'weekly', label: t('settings.activity.mode.weekly'), help: t('settings.activity.modeHelp.weekly') },
    { mode: 'cumulative', label: t('settings.activity.mode.cumulative'), help: t('settings.activity.modeHelp.cumulative') },
  ]

  const saveProfile = async () => {
    setIsSavingProfile(true)
    setProfileError(null)
    setProfileStatus(null)
    try {
      const result = await desktopUiPreferencesApi.updateProfilePreferences({
        displayName: draftDisplayName,
        subtitle: draftSubtitle,
      })
      const nextProfile = withProfileDefaults(result.preferences.profile)
      setProfile(nextProfile)
      setDraftDisplayName(nextProfile.displayName)
      setDraftSubtitle(nextProfile.subtitle)
      setIsEditingProfile(false)
      setProfileStatus(t('settings.activity.profileSaved'))
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : t('settings.activity.profileSaveFailed'))
    } finally {
      setIsSavingProfile(false)
    }
  }

  const handleAvatarChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setIsSavingProfile(true)
    setProfileError(null)
    setProfileStatus(null)
    try {
      const result = await desktopUiPreferencesApi.uploadProfileAvatar(file)
      const nextProfile = withProfileDefaults(result.preferences.profile)
      setProfile(nextProfile)
      setDraftDisplayName(nextProfile.displayName)
      setDraftSubtitle(nextProfile.subtitle)
      setProfileStatus(t('settings.activity.profileSaved'))
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : t('settings.activity.profileSaveFailed'))
    } finally {
      setIsSavingProfile(false)
    }
  }

  const removeAvatar = async () => {
    setIsSavingProfile(true)
    setProfileError(null)
    setProfileStatus(null)
    try {
      const result = await desktopUiPreferencesApi.deleteProfileAvatar()
      setProfile(withProfileDefaults(result.preferences.profile))
      setProfileStatus(t('settings.activity.profileSaved'))
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : t('settings.activity.profileSaveFailed'))
    } finally {
      setIsSavingProfile(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1060px] min-w-0 pb-12">
      <section className="relative flex min-h-[176px] flex-col items-center justify-start pt-4 text-center">
        <div className="relative h-16 w-16 overflow-hidden rounded-full border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[0_10px_28px_-22px_rgba(15,23,42,0.6)]">
          <img
            src={avatarSrc}
            alt={`${profile.displayName} avatar`}
            className={avatarClassName}
            onError={(event) => {
              event.currentTarget.src = DEFAULT_AVATAR_SRC
              event.currentTarget.className = 'h-full w-full scale-[1.28] object-contain transition-transform'
            }}
          />
        </div>
        <div className="group/activity-profile mt-4 flex max-w-full items-center justify-center gap-2">
          <h1 className="max-w-[min(720px,calc(100%-2.25rem))] truncate text-[28px] font-semibold tracking-tight text-[var(--color-text-primary)] sm:text-[34px]">{profile.displayName}</h1>
          <button
            type="button"
            aria-label={t('settings.activity.editProfile')}
            title={t('settings.activity.editProfile')}
            className="mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--color-text-tertiary)] opacity-0 transition-[background-color,color,opacity,transform] group-hover/activity-profile:opacity-100 hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)] focus:ring-offset-2 focus:ring-offset-[var(--color-surface)] focus-visible:opacity-100 active:translate-y-[1px] disabled:pointer-events-none disabled:opacity-0"
            onClick={() => {
              setIsEditingProfile(true)
              setDraftDisplayName(profile.displayName)
              setDraftSubtitle(profile.subtitle)
            }}
            disabled={isProfileLoading}
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">edit</span>
          </button>
        </div>
        {profileSubtitleHref ? (
          <a
            href={profileSubtitleHref}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex max-w-full items-center justify-center gap-2 truncate text-base text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-primary)]"
          >
            <span>{profile.subtitle}</span>
          </a>
        ) : (
          <div className="mt-2 max-w-full truncate text-base text-[var(--color-text-tertiary)]">{profile.subtitle}</div>
        )}
        {profileStatus && <div className="mt-3 text-xs text-[var(--color-success)]">{profileStatus}</div>}
        {profileError && !isEditingProfile && <div className="mt-3 text-xs text-[var(--color-error)]">{profileError}</div>}
      </section>

      <section className="activity-summary-panel mx-auto mt-7 w-full max-w-[900px] overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-border)] p-px shadow-[0_12px_34px_-32px_rgba(15,23,42,0.55)]">
        {isLoading ? (
          <div className="activity-summary-grid grid gap-px">
            {Array.from({ length: 5 }).map((_, index) => (
              <div
                key={index}
                className={`activity-summary-metric min-h-[76px] animate-pulse bg-[var(--color-surface)] px-4 py-3 ${
                  index === 0 ? 'activity-summary-metric-primary' : ''
                }`}
              >
                <div className="mx-auto h-5 w-16 rounded bg-[var(--color-surface-container)]" />
                <div className="mx-auto mt-2 h-3 w-20 rounded bg-[var(--color-surface-container)]" />
                <div className="mx-auto mt-2 h-2.5 w-14 rounded bg-[var(--color-surface-container)]" />
              </div>
            ))}
          </div>
        ) : (
          <div className="activity-summary-grid grid gap-px">
            {metrics.map((metric, index) => {
              const isPrimary = index === 0
              return (
                <div
                  key={metric.label}
                  className={`activity-summary-metric min-w-0 bg-[var(--color-surface-container-lowest)] px-4 py-3 text-center opacity-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.48)] [animation:activity-reveal_420ms_cubic-bezier(0.16,1,0.3,1)_forwards] ${
                    isPrimary ? 'activity-summary-metric-primary' : ''
                  }`}
                  style={{ animationDelay: `${index * 45}ms` }}
                >
                  <div className="flex min-h-[68px] flex-col items-center justify-center gap-1.5">
                    <div className={`activity-summary-value max-w-full min-w-0 font-semibold leading-none tracking-tight text-[var(--color-text-primary)] tabular-nums ${
                      isPrimary ? 'text-[23px]' : 'text-[22px]'
                    }`} style={{ overflow: 'visible', whiteSpace: 'normal', textOverflow: 'clip' }}>
                      {metric.value}
                    </div>
                    <div className="min-w-0 truncate text-[13px] font-medium leading-tight text-[var(--color-text-secondary)]">
                      {metric.label}
                    </div>
                    {metric.detail && <div className="max-w-full truncate text-[11px] leading-tight text-[var(--color-text-tertiary)]">{metric.detail}</div>}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {isEditingProfile && createPortal(
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-[var(--color-overlay-scrim)] px-4 py-8" role="dialog" aria-modal="true" aria-labelledby="activity-profile-dialog-title">
          <div className="w-full max-w-[420px] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="activity-profile-dialog-title" className="text-base font-semibold text-[var(--color-text-primary)]">{t('settings.activity.editProfile')}</h2>
                <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">{t('settings.activity.displayNameHelper')}</p>
              </div>
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
                onClick={() => {
                  setIsEditingProfile(false)
                  setDraftDisplayName(profile.displayName)
                  setDraftSubtitle(profile.subtitle)
                  setProfileError(null)
                }}
                aria-label={t('settings.activity.cancelEdit')}
              >
                <span className="material-symbols-outlined text-[17px]" aria-hidden="true">close</span>
              </button>
            </div>

            <div className="mt-5 grid gap-4">
              <div className="grid gap-2">
                <label htmlFor="activity-profile-display-name" className="text-xs font-medium text-[var(--color-text-secondary)]">
                  {t('settings.activity.displayName')}
                </label>
                <input
                  id="activity-profile-display-name"
                  value={draftDisplayName}
                  onChange={(event) => setDraftDisplayName(event.target.value)}
                  className="h-10 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text-primary)] outline-none transition-colors focus:border-[var(--color-border-focus)]"
                />
              </div>

              <div className="grid gap-2">
                <label htmlFor="activity-profile-subtitle" className="text-xs font-medium text-[var(--color-text-secondary)]">
                  {t('settings.activity.subtitle')}
                </label>
                <input
                  id="activity-profile-subtitle"
                  value={draftSubtitle}
                  onChange={(event) => setDraftSubtitle(event.target.value)}
                  className="h-10 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text-primary)] outline-none transition-colors focus:border-[var(--color-border-focus)]"
                />
              </div>

              <div className="grid gap-2">
                <div className="text-xs font-medium text-[var(--color-text-secondary)]">{t('settings.activity.avatar')}</div>
                <p className="text-xs text-[var(--color-text-tertiary)]">{t('settings.activity.avatarHelper')}</p>
                <div className="flex flex-wrap gap-2">
                  <input
                    ref={avatarInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={handleAvatarChange}
                  />
                  <button
                    type="button"
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 text-xs font-medium text-[var(--color-text-secondary)] transition-[background-color,transform] hover:bg-[var(--color-surface-hover)] active:translate-y-[1px]"
                    onClick={() => avatarInputRef.current?.click()}
                  >
                    <span className="material-symbols-outlined text-[15px]" aria-hidden="true">upload</span>
                    {t('settings.activity.changeAvatar')}
                  </button>
                  {profile.avatarFile && (
                    <button
                      type="button"
                      className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-[var(--color-text-tertiary)] transition-[background-color,transform] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] active:translate-y-[1px]"
                      onClick={removeAvatar}
                    >
                      {t('settings.activity.removeAvatar')}
                    </button>
                  )}
                </div>
              </div>
            </div>

            {profileError && <div className="mt-4 rounded-md border border-[var(--color-error)]/30 bg-[var(--color-error)]/10 px-3 py-2 text-xs text-[var(--color-error)]">{profileError}</div>}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="h-8 rounded-md px-3 text-xs font-medium text-[var(--color-text-secondary)] transition-[background-color,transform] hover:bg-[var(--color-surface-hover)] active:translate-y-[1px]"
                onClick={() => {
                  setIsEditingProfile(false)
                  setDraftDisplayName(profile.displayName)
                  setDraftSubtitle(profile.subtitle)
                  setProfileError(null)
                }}
              >
                {t('settings.activity.cancelEdit')}
              </button>
              <button
                type="button"
                className="h-8 rounded-md bg-[var(--color-text-primary)] px-3 text-xs font-medium text-[var(--color-surface)] transition-[opacity,transform] active:translate-y-[1px] disabled:opacity-50"
                onClick={saveProfile}
                disabled={isSavingProfile}
              >
                {t('settings.activity.saveProfile')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      <div className="mt-10">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)]">{t('settings.activity.tokenActivity')}</h2>
          </div>
          <div className="inline-flex w-fit items-center gap-7">
            {modeOptions.map((option) => (
              <button
                key={option.mode}
                type="button"
                aria-pressed={heatmapMode === option.mode}
                title={option.help}
                className={`text-lg font-semibold transition-[color,transform] active:translate-y-[1px] ${
                  heatmapMode === option.mode
                    ? 'text-[var(--color-text-primary)]'
                    : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]'
                }`}
                onClick={() => setHeatmapMode(option.mode)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <div className="min-h-[190px] space-y-3">
            <div className="h-4 w-1/4 animate-pulse rounded bg-[var(--color-surface-container)]" />
            <div className="grid grid-flow-col gap-[3px]">
              {Array.from({ length: 52 }).map((_, col) => (
                <div key={col} className="grid grid-rows-7 gap-[3px]">
                  {Array.from({ length: 7 }).map((__, row) => (
                    <div key={row} className="h-2.5 w-2.5 animate-pulse rounded-[3px] bg-[var(--color-surface-container)]" />
                  ))}
                </div>
              ))}
            </div>
          </div>
        ) : error ? (
          <div className="rounded-md border border-[var(--color-error)]/30 bg-[var(--color-error)]/10 px-4 py-3 text-sm text-[var(--color-error)]">
            {error}
          </div>
        ) : !hasUsage ? (
          <div className="flex min-h-[190px] items-center justify-center">
            <div className="max-w-sm text-center">
              <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] text-[var(--color-text-tertiary)]">
                <span className="material-symbols-outlined text-[20px]" aria-hidden="true">monitoring</span>
              </div>
              <div className="mt-3 text-sm font-medium text-[var(--color-text-primary)]">{t('settings.activity.emptyTitle')}</div>
              <p className="mt-1 text-sm leading-5 text-[var(--color-text-tertiary)]">{t('settings.activity.emptyBody')}</p>
            </div>
          </div>
        ) : (
          <>
            <div ref={heatmapMeasureRef} className="min-w-0 pb-2">
              <div className="relative" style={{ width: heatmapWidth, maxWidth: '100%' }}>
                <div
                  className="mb-3 grid h-5 text-[11px] leading-none text-[var(--color-text-tertiary)]"
                  style={{
                    marginLeft: HEAT_LABEL_WIDTH,
                    gridTemplateColumns: `repeat(${WEEK_COUNT}, ${heatCellSize}px)`,
                    columnGap: HEAT_CELL_GAP,
                  }}
                >
                  {monthLabels.map((month) => (
                    <div key={`${month.week}-${month.label}`} style={{ gridColumn: `${month.week + 1} / span 4` }}>
                      {month.label}
                    </div>
                  ))}
                </div>

                <div className="flex items-start" style={{ gap: HEAT_CELL_GAP }}>
                  <div
                    className="grid shrink-0 grid-rows-7 text-[11px] leading-none text-[var(--color-text-tertiary)]"
                    style={{ width: HEAT_LABEL_WIDTH, height: heatGridHeight, rowGap: HEAT_CELL_GAP }}
                  >
                    <div className="row-start-2 flex items-center">{t(WEEKDAY_LABEL_KEYS[0])}</div>
                    <div className="row-start-4 flex items-center">{t(WEEKDAY_LABEL_KEYS[1])}</div>
                    <div className="row-start-6 flex items-center">{t(WEEKDAY_LABEL_KEYS[2])}</div>
                  </div>

                  <div
                    role="grid"
                    aria-label={t('settings.activity.heatmapLabel')}
                    className="grid grid-flow-col"
                    style={{
                      gridTemplateRows: `repeat(7, ${heatCellSize}px)`,
                      gridAutoColumns: `${heatCellSize}px`,
                      columnGap: HEAT_CELL_GAP,
                      rowGap: HEAT_CELL_GAP,
                    }}
                    onMouseLeave={() => setHoveredDate(null)}
                  >
                    {days.map((day) => {
                      const isSelected = activeTooltipDate === day.date
                      const tooltipId = `activity-day-tooltip-${day.date}`
                      const cellTitle = getHeatmapCellTitle(day, locale, t)
                      const cellDetail = getHeatmapCellDetail(day, t)
                      return (
                        <button
                          key={day.date}
                          type="button"
                          role="gridcell"
                          aria-label={`${cellTitle}: ${cellDetail}`}
                          aria-describedby={activeTooltipDate === day.date ? tooltipId : undefined}
                          className={`activity-heat-cell rounded-[3px] border focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)] focus:ring-offset-2 focus:ring-offset-[var(--color-surface)] ${
                            isSelected
                              ? 'is-active border-[var(--color-activity-cell-border-active)]'
                              : 'border-[var(--color-activity-cell-border)] hover:border-[var(--color-activity-cell-border-hover)]'
                          }`}
                          style={{
                            width: heatCellSize,
                            height: heatCellSize,
                            backgroundColor: HEAT_COLORS[day.level],
                          }}
                          onFocus={() => setFocusedDate(day.date)}
                          onBlur={() => setFocusedDate(null)}
                          onMouseEnter={() => setHoveredDate(day.date)}
                        />
                      )
                    })}
                  </div>
                </div>

                {tooltipDay && (
                  <div
                    id={`activity-day-tooltip-${tooltipDay.date}`}
                    role="tooltip"
                    className="pointer-events-none absolute z-20 min-w-[172px] rounded-md border border-[var(--color-activity-tooltip-border)] bg-[var(--color-activity-tooltip-surface)] px-3 py-2 text-xs shadow-xl"
                    style={tooltipStyle}
                  >
                    <div className="font-medium text-[var(--color-activity-tooltip-text)]">{getHeatmapCellTitle(tooltipDay, locale, t)}</div>
                    <div className="mt-1 text-[var(--color-activity-tooltip-muted)]">
                      {getHeatmapCellDetail(tooltipDay, t)}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="mt-3 flex items-center justify-end gap-2 text-xs text-[var(--color-text-tertiary)] xl:mt-4">
              <span>{t('settings.activity.less')}</span>
              {HEAT_COLORS.map((color) => (
                <span
                  key={color}
                  aria-hidden="true"
                  className="rounded-[3px] border border-[var(--color-activity-cell-border)]"
                  style={{ width: heatCellSize, height: heatCellSize, backgroundColor: color }}
                />
              ))}
              <span>{t('settings.activity.more')}</span>
            </div>
          </>
        )}
      </div>

      {!isLoading && !error && hasUsage && (
        <div className={`mt-12 grid gap-10 ${
          topPluginItems.length > 0 ? 'lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1fr)]' : 'lg:max-w-[520px]'
        }`}>
          <section className="min-w-0">
            <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">{t('settings.activity.activityInsights')}</h2>
            <dl className="mt-5 grid gap-3">
              {insightMetrics.map((metric) => (
                <div key={metric.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-5">
                  <dt className="min-w-0 truncate text-sm font-medium text-[var(--color-text-tertiary)]">{metric.label}</dt>
                  <dd className="min-w-0 text-right text-sm font-semibold text-[var(--color-text-primary)]">
                    <span className="tabular-nums">{metric.value}</span>
                    {metric.detail && (
                      <span className="ml-2 text-xs font-medium text-[var(--color-text-tertiary)]">{metric.detail}</span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          {topPluginItems.length > 0 && (
            <section className="min-w-0">
              <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">{t('settings.activity.mostUsedPluginsAndSkills')}</h2>
              <div className="mt-5 grid gap-3">
                {topPluginItems.map((item) => (
                  <div key={item.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3">
                    <span className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] text-[var(--color-text-tertiary)]">
                      <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                        {item.kind === 'skill' ? 'extension' : 'hub'}
                      </span>
                    </span>
                    <span className="min-w-0 truncate text-sm font-medium text-[var(--color-text-primary)]">{item.label}</span>
                    <span className="text-sm text-[var(--color-text-tertiary)] tabular-nums">{formatRunCount(item.count, t)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
