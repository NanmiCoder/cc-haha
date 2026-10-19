import { useEffect, useMemo, useState } from 'react'
import { ChartNoAxesColumn, CircleAlert, Share2 } from 'lucide-react'

import { activityStatsApi, type ActivityStatsResponse } from '../api/activityStats'
import { SettingsPageHeader } from '@/components/settings/SettingsSection'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { type Locale, useTranslation } from '../i18n'
import { useSettingsStore } from '../stores/settingsStore'
import { ModelDetails } from '../features/tokenUsage/ModelDetails'
import { ProfileEditModal } from '../features/tokenUsage/ProfileEditModal'
import { ShareImageDialog } from '../features/tokenUsage/ShareImageDialog'
import { TokenHeatmap } from '../features/tokenUsage/TokenHeatmap'
import { TokenHero } from '../features/tokenUsage/TokenHero'
import { TokenSkills } from '../features/tokenUsage/TokenSkills'
import { TokenStreamChart } from '../features/tokenUsage/TokenStreamChart'
import { formatTokenAmount } from '../features/tokenUsage/formatTokenUnits'
import { getDailyTokenMap } from '../features/tokenUsage/heatmapModel'
import { getProfileAvatarSource, useActivityProfile } from '../features/tokenUsage/useActivityProfile'
import { buildDailyModelSeries, rankModels } from '../features/tokenUsage/usageModel'

const STREAM_DAYS = 90

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

function formatPercent(part: number, whole: number) {
  if (whole <= 0) return '0%'
  return `${Math.round((part / whole) * 100)}%`
}

type StatTile = { label: string; value: string; detail?: string }

function StatsRow({ tiles }: { tiles: StatTile[] }) {
  return (
    <dl className="mt-14 grid grid-cols-2 gap-x-6 gap-y-6 border-t border-[var(--color-border)] pt-5 @[560px]:grid-cols-4">
      {tiles.map((tile) => (
        <div key={tile.label} className="min-w-0">
          <dt className="truncate text-xs text-[var(--color-text-tertiary)]">{tile.label}</dt>
          <dd className="m-0 mt-1.5 text-[22px] font-semibold leading-tight tabular-nums text-[var(--color-text-primary)]">{tile.value}</dd>
          {tile.detail ? <div className="mt-1 truncate font-mono text-[11px] text-[var(--color-text-tertiary)]">{tile.detail}</div> : null}
        </div>
      ))}
    </dl>
  )
}

function LoadingSkeleton() {
  return (
    <div aria-hidden="true" className="mt-10 animate-pulse">
      <div className="flex flex-wrap items-end justify-between gap-8">
        <div className="flex items-center gap-6">
          <div className="h-32 w-32 rounded-full bg-[var(--color-surface-container)]" />
          <div className="grid gap-2">
            <div className="h-5 w-40 rounded-[var(--radius-xs)] bg-[var(--color-surface-container)]" />
            <div className="h-3 w-48 rounded-[var(--radius-xs)] bg-[var(--color-surface-container)]" />
          </div>
        </div>
        <div className="h-28 w-64 rounded-[var(--radius-md)] bg-[var(--color-surface-container)]" />
      </div>
      <div className="mt-14 h-[240px] rounded-[var(--radius-md)] bg-[var(--color-surface-container)]" />
    </div>
  )
}

export function ActivitySettings() {
  const t = useTranslation()
  const locale = useSettingsStore((state) => state.locale)
  const profile = useActivityProfile()
  const [stats, setStats] = useState<ActivityStatsResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [shareOpen, setShareOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    setError(null)

    activityStatsApi.getStats('all')
      .then((nextStats) => {
        if (!cancelled) setStats(nextStats)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const otherLabel = t('settings.activity.otherModels')
  const models = useMemo(() => rankModels(stats, otherLabel), [stats, otherLabel])
  const daily = useMemo(() => buildDailyModelSeries(stats, models, STREAM_DAYS, new Date()), [stats, models])
  const dayActivity = useMemo(() => new Map((stats?.dailyActivity ?? []).map((day) => [day.date, day])), [stats])
  const totalTokens = useMemo(
    () => [...getDailyTokenMap(stats).values()].reduce((sum, tokens) => sum + tokens, 0),
    [stats],
  )
  const shareProfile = useMemo(
    () => ({ displayName: profile.profile.displayName, subtitle: profile.profile.subtitle }),
    [profile.profile.displayName, profile.profile.subtitle],
  )

  const hasUsage = Boolean(stats && (stats.totalSessions > 0 || totalTokens > 0))
  const ready = Boolean(stats) && !isLoading && !error

  const tiles: StatTile[] = []
  if (stats) {
    const fresh = models.reduce((sum, model) => sum + model.fresh, 0)
    const cached = models.reduce((sum, model) => sum + model.cached, 0)
    const dayText = (count: number) => t(count === 1 ? 'settings.activity.count.dayOne' : 'settings.activity.count.dayOther', { count })
    tiles.push(
      {
        label: t('settings.activity.longestTask'),
        value: formatTaskDuration(stats.longestSession?.duration, locale, t),
        detail: stats.longestSession ? `${stats.longestSession.messageCount} ${t('settings.activity.messages')}` : undefined,
      },
      { label: t('settings.activity.currentStreak'), value: dayText(stats.streaks.currentStreak) },
      {
        label: t('settings.activity.longestStreak'),
        value: dayText(stats.streaks.longestStreak),
        detail: t(stats.totalSessions === 1 ? 'settings.activity.count.sessionOne' : 'settings.activity.count.sessionOther', { count: stats.totalSessions }),
      },
      {
        label: t('settings.activity.cacheHitRate'),
        value: formatPercent(cached, fresh + cached),
        detail: t('settings.activity.freshAmount', { amount: formatTokenAmount(fresh, locale).text }),
      },
    )
  }

  return (
    <div className="token-usage-root w-full min-w-0">
      <SettingsPageHeader
        title={t('settings.activity.title')}
        description={t('settings.activity.subtitleLoading')}
        action={
          <Button
            variant="secondary"
            size="base"
            disabled={!ready || !hasUsage}
            onClick={() => setShareOpen(true)}
            icon={<Share2 size={14} strokeWidth={1.75} aria-hidden="true" />}
          >
            {t('settings.activity.share')}
          </Button>
        }
      />

      {isLoading ? (
        <LoadingSkeleton />
      ) : error ? (
        <div
          role="alert"
          className="mt-10 flex items-start gap-2 rounded-[var(--radius-md)] bg-[var(--color-error-container)] px-3 py-2 text-xs text-[var(--color-on-error-container)]"
        >
          <CircleAlert size={14} strokeWidth={1.75} aria-hidden="true" className="mt-px shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      ) : stats ? (
        <>
          <div className="mt-10">
            <TokenHero profile={profile} totalTokens={totalTokens} activeDays={stats.activeDays} locale={locale} />
          </div>

          {hasUsage ? (
            <>
              <TokenStreamChart days={daily} models={models} activity={dayActivity} locale={locale} className="mt-14" />
              <StatsRow tiles={tiles} />
              <div className="mt-14">
                <TokenHeatmap stats={stats} locale={locale} />
              </div>
              <ModelDetails models={models} locale={locale} />
              <TokenSkills stats={stats} />
            </>
          ) : (
            <EmptyState
              size="md"
              className="mt-14"
              icon={<ChartNoAxesColumn size={18} strokeWidth={1.75} />}
              title={t('settings.activity.emptyTitle')}
              description={t('settings.activity.emptyBody')}
            />
          )}
        </>
      ) : null}

      <ProfileEditModal profile={profile} />

      {stats && hasUsage ? (
        <ShareImageDialog
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          stats={stats}
          models={models}
          daily={daily}
          totalTokens={totalTokens}
          locale={locale}
          profile={shareProfile}
          avatarUrl={getProfileAvatarSource(profile.profile)}
        />
      ) : null}
    </div>
  )
}
