// desktop/src/components/settings/ClaudePlanUsage.tsx
//
// The logged-in Claude subscription's usage limits (the data `/usage` shows in
// the terminal): how much of each rolling limit is used and when it resets.
// Shows why the numbers are unavailable instead of guessing from the context
// window, which is per session and says nothing about the account (#1804).

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Progress } from '@/components/ui/Progress'
import { useTranslation, type TranslationKey } from '@/i18n'
import {
  hahaOAuthApi,
  type ClaudePlanUsage as PlanUsage,
  type ClaudePlanUsageResult,
} from '@/api/hahaOAuth'

const WINDOWS: ReadonlyArray<{ key: 'five_hour' | 'seven_day' | 'seven_day_oauth_apps' | 'seven_day_opus' | 'seven_day_sonnet'; label: TranslationKey }> = [
  { key: 'five_hour', label: 'settings.claudeOfficialLogin.usageFiveHour' },
  { key: 'seven_day', label: 'settings.claudeOfficialLogin.usageSevenDay' },
  { key: 'seven_day_oauth_apps', label: 'settings.claudeOfficialLogin.usageSevenDayOauthApps' },
  { key: 'seven_day_opus', label: 'settings.claudeOfficialLogin.usageSevenDayOpus' },
  { key: 'seven_day_sonnet', label: 'settings.claudeOfficialLogin.usageSevenDaySonnet' },
]

function formatTime(iso: string): string | null {
  if (typeof iso !== 'string' || !iso.trim()) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}

function percent(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : null
}

function toneFor(value: number) {
  return value >= 90 ? 'danger' : value >= 70 ? 'warning' : 'brand'
}

type Row = { id: string; label: string; used: number | null; resetsAt: string | null; unlimited?: boolean }

function rowsOf(usage: PlanUsage, t: ReturnType<typeof useTranslation>): Row[] {
  const rows: Row[] = []
  for (const window of WINDOWS) {
    const value = usage[window.key]
    if (!value) continue
    rows.push({ id: window.key, label: t(window.label), used: percent(value.utilization), resetsAt: value.resets_at })
  }
  if (usage.extra_usage?.is_enabled) {
    const unlimited = usage.extra_usage.monthly_limit === null
    rows.push({ id: 'extra_usage', label: t('settings.claudeOfficialLogin.usageExtra'), used: unlimited ? null : percent(usage.extra_usage.utilization), resetsAt: null, unlimited })
  }
  return rows
}

export function ClaudePlanUsage() {
  const t = useTranslation()
  const [result, setResult] = useState<ClaudePlanUsageResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [requestFailed, setRequestFailed] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setResult(await hahaOAuthApi.planUsage())
      setRequestFailed(false)
    } catch {
      setRequestFailed(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const updatedAt = result ? formatTime(result.fetchedAt) : null
  let body: ReactNode
  if (requestFailed) {
    body = <p role="alert" className="text-xs text-[var(--color-text-secondary)]">{t('settings.claudeOfficialLogin.usageUnavailable')}</p>
  } else if (!result) {
    body = <p className="text-xs text-[var(--color-text-tertiary)]">{t('common.loading')}</p>
  } else if (!result.available) {
    const message = result.reason === 'missing_scope'
      ? t('settings.claudeOfficialLogin.usageMissingScope')
      : result.status
        ? t('settings.claudeOfficialLogin.usageUnavailableStatus', { status: String(result.status) })
        : t('settings.claudeOfficialLogin.usageUnavailable')
    body = <p role="alert" className="text-xs text-[var(--color-text-secondary)]">{message}</p>
  } else {
    const rows = rowsOf(result.usage, t)
    body = rows.length === 0
      ? <p className="text-xs text-[var(--color-text-secondary)]">{t('settings.claudeOfficialLogin.usageNoData')}</p>
      : (
        <ul className="flex flex-col gap-2.5">
          {rows.map((row) => {
            const resets = row.resetsAt ? formatTime(row.resetsAt) : null
            const values = [row.unlimited
              ? t('settings.claudeOfficialLogin.usageUnlimited')
              : row.used !== null
                ? t('settings.claudeOfficialLogin.usageUsed', { percent: String(row.used) })
                : t('settings.claudeOfficialLogin.usageUnavailableValue')]
            if (resets) values.push(t('settings.claudeOfficialLogin.usageResetsAt', { time: resets }))
            else if (row.id !== 'extra_usage') values.push(t('settings.claudeOfficialLogin.usageResetNotProvided'))
            return (
              <li key={row.id} data-testid={`claude-plan-usage-${row.id}`} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs">
                  <span className="text-[var(--color-text-primary)]">{row.label}</span>
                  <span className="text-[var(--color-text-secondary)]">
                    {values.join(' · ')}
                  </span>
                </div>
                {row.used !== null && (
                  <Progress value={row.used} size="xs" tone={toneFor(row.used)} label={`${row.label} ${row.used}%`} />
                )}
              </li>
            )
          })}
        </ul>
      )
  }

  return (
    <section
      aria-label={t('settings.claudeOfficialLogin.usageTitle')}
      className="flex w-full flex-col gap-2.5 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-[var(--color-text-secondary)]">{t('settings.claudeOfficialLogin.usageTitle')}</span>
        <div className="flex items-center gap-2">
          {updatedAt && (
            <span className="text-[11px] text-[var(--color-text-tertiary)]">
              {t('settings.claudeOfficialLogin.usageUpdatedAt', { time: updatedAt })}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void refresh()}
            loading={loading}
            icon={<RefreshCw size={12} strokeWidth={1.75} aria-hidden="true" />}
          >
            {t('settings.claudeOfficialLogin.usageRefresh')}
          </Button>
        </div>
      </div>
      {body}
    </section>
  )
}
