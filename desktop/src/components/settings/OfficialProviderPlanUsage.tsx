import { useEffect } from 'react'
import { RefreshCw } from 'lucide-react'
import type { OfficialUsageProviderId } from '@/api/usageSummary'
import { Button } from '@/components/ui/Button'
import { Progress } from '@/components/ui/Progress'
import { useTranslation } from '@/i18n'
import { useUsageSummaryStore } from '@/stores/usageSummaryStore'
import { useHahaOpenAIOAuthStore } from '@/stores/hahaOpenAIOAuthStore'
import { useHahaGrokOAuthStore } from '@/stores/hahaGrokOAuthStore'
import {
  displayPercentForWindow,
  formatExactResetTime,
  toneForRemainingPercent,
  windowLabelKey,
} from '@/components/usage/usageFormatting'

export function OfficialProviderPlanUsage({
  providerId,
}: {
  providerId: Extract<OfficialUsageProviderId, 'openai-official' | 'grok-official'>
}) {
  const t = useTranslation()
  const summary = useUsageSummaryStore((s) => s.summary)
  const preferences = useUsageSummaryStore((s) => s.preferences)
  const isLoading = useUsageSummaryStore((s) => s.isLoading)
  const fetchSummary = useUsageSummaryStore((s) => s.fetchSummary)
  const openaiLoggedIn = useHahaOpenAIOAuthStore((s) => s.status?.loggedIn === true)
  const grokLoggedIn = useHahaGrokOAuthStore((s) => s.status?.loggedIn === true)
  const isLoggedIn = providerId === 'openai-official' ? openaiLoggedIn : grokLoggedIn

  const provider = summary?.providers.find((item) => item.providerId === providerId)
  const providerSignedIn = provider?.signedIn === true

  useEffect(() => {
    if (!summary || (isLoggedIn && !providerSignedIn)) {
      void fetchSummary()
    }
  }, [fetchSummary, isLoggedIn, providerSignedIn, summary])

  if (!provider || !provider.signedIn) return null

  const updatedAt = provider.fetchedAt ? formatExactResetTime(provider.fetchedAt) : null

  return (
    <section
      aria-label={t('settings.claudeOfficialLogin.usageTitle')}
      data-testid={`official-plan-usage-${providerId}`}
      className="flex w-full flex-col gap-2.5 rounded-[var(--radius-card-inner)] border border-[var(--color-border)] p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-[var(--color-text-secondary)]">
          {t('settings.claudeOfficialLogin.usageTitle')}
          {provider.planLabel ? ` · ${provider.planLabel}` : ''}
        </span>
        <div className="flex items-center gap-2">
          {updatedAt ? (
            <span className="text-[11px] text-[var(--color-text-tertiary)]">
              {t('settings.claudeOfficialLogin.usageUpdatedAt', { time: updatedAt })}
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void fetchSummary({ force: true })}
            loading={isLoading}
            icon={<RefreshCw size={12} strokeWidth={1.75} aria-hidden="true" />}
          >
            {t('settings.claudeOfficialLogin.usageRefresh')}
          </Button>
        </div>
      </div>

      {provider.status === 'rate_limited' ? (
        <p role="alert" className="text-xs text-[var(--color-text-secondary)]">
          {t('usageWidget.statusRateLimited')}
        </p>
      ) : provider.status === 'local_only' ? (
        <p className="text-xs text-[var(--color-text-secondary)]">
          {t('usageWidget.statusLocalOnly')}
        </p>
      ) : provider.windows.length === 0 ? (
        <p className="text-xs text-[var(--color-text-secondary)]">
          {t('usageWidget.statusUnavailable')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {provider.windows.map((window) => {
            const pct = displayPercentForWindow(window, preferences.displayMode)
            const resetTime = formatExactResetTime(window.resetsAt)
            const parts: string[] = []
            if (pct !== null) {
              parts.push(
                preferences.displayMode === 'used'
                  ? t('usageWidget.usedPercent', { percent: String(pct) })
                  : t('usageWidget.remainingPercent', { percent: String(pct) }),
              )
            }
            if (resetTime) {
              parts.push(t('settings.claudeOfficialLogin.usageResetsAt', { time: resetTime }))
            }
            return (
              <li key={window.metricKey} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs">
                  <span className="text-[var(--color-text-primary)]">{t(windowLabelKey(window.kind))}</span>
                  <span className="tabular-nums text-[var(--color-text-secondary)]">{parts.join(' · ')}</span>
                </div>
                {pct !== null ? (
                  <Progress
                    value={pct}
                    size="xs"
                    tone={toneForRemainingPercent(window.remainingPercent)}
                    label={`${t(windowLabelKey(window.kind))} ${pct}%`}
                  />
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
