import type {
  OfficialUsageProviderId,
  OfficialUsageWindow,
  OfficialUsageWindowKind,
} from '@/api/usageSummary'
import type { TranslationKey } from '@/i18n'

export type UsageTone = 'brand' | 'success' | 'warning' | 'danger'

export function providerTitleKey(providerId: OfficialUsageProviderId): TranslationKey {
  switch (providerId) {
    case 'claude-official':
      return 'settings.providers.officialName'
    case 'openai-official':
      return 'settings.providers.openaiOfficialName'
    case 'grok-official':
      return 'settings.providers.grokOfficialName'
    case 'deepseek-account':
      return 'settings.providers.deepseekAccountName'
  }
}

export function windowLabelKey(kind: OfficialUsageWindowKind): TranslationKey {
  switch (kind) {
    case 'five_hour':
      return 'usageWidget.windowFiveHour'
    case 'seven_day':
      return 'usageWidget.windowSevenDay'
    case 'seven_day_sonnet':
      return 'usageWidget.windowSevenDaySonnet'
    case 'seven_day_opus':
      return 'usageWidget.windowSevenDayOpus'
    case 'seven_day_oauth_apps':
      return 'usageWidget.windowSevenDayOauthApps'
    case 'spark_five_hour':
      return 'usageWidget.windowSparkFiveHour'
    case 'spark_seven_day':
      return 'usageWidget.windowSparkSevenDay'
    case 'extra_usage':
      return 'usageWidget.windowExtraUsage'
  }
}

export function toneForRemainingPercent(remainingPercent: number | null): UsageTone {
  if (remainingPercent === null) return 'brand'
  if (remainingPercent <= 15) return 'danger'
  if (remainingPercent <= 30) return 'warning'
  return 'success'
}

export function displayPercentForWindow(
  window: OfficialUsageWindow,
  mode: 'remaining' | 'used',
): number | null {
  if (window.unlimited) return null
  return mode === 'used' ? window.usedPercent : window.remainingPercent
}

export function formatResetCountdown(resetsAt: string | null, nowMs: number = Date.now()): string | null {
  if (!resetsAt) return null
  const targetMs = Date.parse(resetsAt)
  if (!Number.isFinite(targetMs)) return null
  const diffMs = targetMs - nowMs
  if (diffMs <= 0) return '0m'
  const totalMinutes = Math.ceil(diffMs / 60_000)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const totalHours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (totalHours < 24) {
    return minutes > 0 ? `${totalHours}h ${minutes}m` : `${totalHours}h`
  }
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`
}

export function formatExactResetTime(resetsAt: string | null): string | null {
  if (!resetsAt) return null
  const date = new Date(resetsAt)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function formatCompactTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(2)}B`
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(Math.round(tokens))
}

/**
 * Returns the 0..100 position of an even-pace reference mark along the bar, or
 * null when the window lacks a reset time or period.
 */
export function computePaceMarkerPercent(
  window: OfficialUsageWindow,
  mode: 'remaining' | 'used',
  nowMs: number = Date.now(),
): number | null {
  if (!window.resetsAt || !window.periodMs || window.periodMs <= 0) return null
  const resetMs = Date.parse(window.resetsAt)
  if (!Number.isFinite(resetMs)) return null
  const remainingMs = resetMs - nowMs
  if (remainingMs <= 0 || remainingMs >= window.periodMs) return null
  const elapsedFraction = 1 - remainingMs / window.periodMs
  if (elapsedFraction < 0.02 || elapsedFraction > 0.98) return null
  const pct = mode === 'remaining' ? (1 - elapsedFraction) * 100 : elapsedFraction * 100
  return Math.round(Math.max(2, Math.min(98, pct)))
}
