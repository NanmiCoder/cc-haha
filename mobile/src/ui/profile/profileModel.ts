import type { ProfileStats } from '../../core/profile'

export function tokenAmount(value: number) {
  const { amount, unit } = tokenParts(value)
  return `${amount}${unit}`
}

export function tokenParts(value: number) {
  const steps = [{ size: 1e12, unit: 'T' }, { size: 1e9, unit: 'B' }, { size: 1e6, unit: 'M' }, { size: 1e3, unit: 'K' }]
  // Promote values that round onto the next unit ("999.95K" reads as "1M").
  const step = steps.find((item) => value >= item.size || (item.size > 1e3 && Math.round(value / (item.size / 1e3)) >= 1e3))
  if (!step) return { amount: Math.round(value).toLocaleString('en-US'), unit: '' }
  const scaled = value / step.size
  return { amount: String(scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10), unit: step.unit }
}

export function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function profileModel(stats: ProfileStats, today = new Date()) {
  const tokens = new Map(stats.dailyModelTokens.map((day) => [
    day.date, Object.values(day.tokensByModel).reduce((sum, value) => sum + value, 0),
  ]))
  // The headline follows the same daily-token sum as the desktop overview.
  const total = [...tokens.values()].reduce((sum, value) => sum + value, 0)
  const models = Object.entries(stats.modelUsage).map(([id, usage]) => ({
    id,
    total: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) +
      (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0),
    cached: usage.cacheReadInputTokens ?? 0,
  })).filter((model) => model.total > 0).sort((a, b) => b.total - a.total || a.id.localeCompare(b.id))
  const modelTotal = models.reduce((sum, model) => sum + model.total, 0)
  const cached = models.reduce((sum, model) => sum + model.cached, 0)
  const dayAt = (offset: number) => {
    const day = new Date(today)
    day.setHours(12, 0, 0, 0)
    day.setDate(day.getDate() + offset)
    const date = dateKey(day)
    return { date, tokens: tokens.get(date) ?? 0 }
  }
  const weekday = (today.getDay() + 6) % 7
  const days = Array.from({ length: 182 }, (_, index) => {
    const offset = index - 175 - weekday
    return { ...dayAt(offset), future: offset > 0 }
  })
  const recent = Array.from({ length: 30 }, (_, index) => dayAt(index - 29))
  const peak = Math.max(...recent.map((day) => day.tokens), 0)
  const duration = stats.longestSession?.duration
  const minutes = duration == null || duration <= 0 ? null : Math.max(1, Math.round(duration / 60000))
  return {
    total, models, modelTotal, days, recent, peak,
    recentTotal: recent.reduce((sum, day) => sum + day.tokens, 0),
    cacheRate: modelTotal ? `${Math.round(cached / modelTotal * 100)}%` : '—',
    longestTask: minutes == null ? '—' : minutes < 60 ? `${minutes} Minutes` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`,
  }
}

export function subtitleLink(text: string) {
  const candidate = /^https?:\/\//i.test(text) ? text : /^[\w.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(text) ? `https://${text}` : null
  if (!candidate) return null
  try {
    const url = new URL(candidate)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}
