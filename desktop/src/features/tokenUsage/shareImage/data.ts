import type { ActivityStatsResponse } from '../../../api/activityStats'
import type { Locale, TranslationKey } from '../../../i18n'
import { DATE_LOCALES, formatMonthName, parseLocalDate } from '../heatmapModel'
import { describeTokenAmount, formatTokenAmount } from '../formatTokenUnits'
import type { DailyModelSeries, RankedModel } from '../usageModel'
import type { ShareImageData } from './layout'

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string

/** A step of 1, 2 or 5 × 10^k that gives at most four grid lines for `max`. */
export function niceStep(max: number): number {
  if (max <= 0) return 1
  const base = 10 ** Math.floor(Math.log10(max / 4))
  for (const multiple of [1, 2, 5, 10]) {
    if (max / (base * multiple) <= 4) return base * multiple
  }
  return base * 10
}

function percentOf(part: number, whole: number, locale: Locale) {
  if (whole <= 0) return '0%'
  const ratio = part / whole
  if (ratio > 0 && ratio < 0.005) return '<1%'
  return new Intl.NumberFormat(DATE_LOCALES[locale], { style: 'percent', maximumFractionDigits: 0 }).format(ratio)
}

function formatCost(cost: number, locale: Locale) {
  return new Intl.NumberFormat(DATE_LOCALES[locale], {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: cost >= 100 ? 0 : 2,
  }).format(cost)
}

function dateStamp(now: Date) {
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${now.getFullYear()}.${month}.${day}`
}

export type BuildShareImageDataInput = {
  stats: ActivityStatsResponse
  models: RankedModel[]
  /** The trailing window the chart draws, oldest first. */
  daily: DailyModelSeries[]
  totalTokens: number
  locale: Locale
  t: Translate
  profile: { displayName: string; subtitle: string }
  now: Date
}

/** Everything the share image prints, already formatted for the reader's language. */
export function buildShareImageData(input: BuildShareImageDataInput): ShareImageData {
  const { stats, models, daily, totalTokens, locale, t, profile, now } = input
  const total = formatTokenAmount(totalTokens, locale)
  const described = describeTokenAmount(totalTokens, locale)
  // English readers are served by the exact figure; "241亿" beside "24.1B" would only add a script they may not read.
  const totalNote = locale === 'en' ? described.exact : `${described.alternate} · ${described.exact}`

  const peakValue = Math.max(...daily.map((day) => day.total), 0)
  const peakIndex = peakValue > 0 ? daily.findIndex((day) => day.total === peakValue) : -1
  const step = niceStep(peakValue)
  const chartMax = Math.max(peakValue * 1.1, step)
  const gridValues: number[] = []
  // No usage in the window means no axis: a lone "1 / day" line would only mislead.
  if (peakValue > 0) for (let value = step; value <= chartMax; value += step) gridValues.push(value)
  const gridLines = gridValues.map((value, index) => {
    const label = formatTokenAmount(value, locale).text
    return {
      value,
      label: index === gridValues.length - 1 ? t('settings.activity.share.perDay', { amount: label }) : label,
    }
  })

  const monthTicks = daily.flatMap((day, index) => (
    day.date.endsWith('-01')
      ? [{ fraction: index / Math.max(daily.length - 1, 1), label: formatMonthName(parseLocalDate(day.date), locale) }]
      : []
  ))

  // Shares are of the models' own sum, so the column always adds to 100% even if the daily series and per-model totals differ slightly.
  const modelsTotal = models.reduce((sum, model) => sum + model.total, 0)
  const freshAndCached = models.reduce((sum, model) => sum + model.fresh + model.cached, 0)
  const cached = models.reduce((sum, model) => sum + model.cached, 0)

  const dayText = (count: number) => t(count === 1 ? 'settings.activity.count.dayOne' : 'settings.activity.count.dayOther', { count })
  const sessionCount = stats.totalSessions
  const summaryLine = [
    t(stats.activeDays === 1 ? 'settings.activity.activeDaysOne' : 'settings.activity.activeDaysOther', { count: stats.activeDays }),
    t(sessionCount === 1 ? 'settings.activity.count.sessionOne' : 'settings.activity.count.sessionOther', { count: sessionCount }),
  ].join(' · ')

  const { currentStreak, longestStreak } = stats.streaks
  return {
    displayName: profile.displayName,
    linkText: profile.subtitle,
    dateLabel: dateStamp(now),
    caption: t('settings.activity.totalTokens'),
    totalValue: total.value,
    totalUnit: total.unit,
    totalNote,
    summaryLine,
    models: models.map((model) => ({
      label: model.label,
      series: model.series,
      amount: formatTokenAmount(model.total, locale).text,
      share: percentOf(model.total, modelsTotal, locale),
      cost: model.unpriced ? null : formatCost(model.costUSD, locale),
    })),
    daily: daily.map((day) => day.byModel),
    chartMax,
    gridLines,
    peak: peakIndex >= 0
      ? { index: peakIndex, label: t('settings.activity.share.peak', { amount: formatTokenAmount(peakValue, locale).text }) }
      : null,
    monthTicks,
    streak: currentStreak > 0 || longestStreak > 0
      ? {
          current: currentStreak,
          longest: longestStreak,
          currentLabel: `${t('settings.activity.currentStreak')} ${dayText(currentStreak)}`,
          longestLabel: `${t('settings.activity.longestStreak')} ${dayText(longestStreak)}`,
        }
      : null,
    footerNote: freshAndCached > 0
      ? t('settings.activity.share.cacheHit', { percent: percentOf(cached, freshAndCached, locale) })
      : '',
  }
}
