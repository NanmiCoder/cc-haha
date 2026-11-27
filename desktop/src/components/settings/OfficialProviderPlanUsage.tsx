import { useEffect } from 'react'
import { ExternalLink, RefreshCw, TriangleAlert, Wallet } from 'lucide-react'
import type { UsageDisplayMode } from '@/api/desktopUiPreferences'
import type { OfficialUsageProviderId } from '@/api/usageSummary'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Progress } from '@/components/ui/Progress'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { useTranslation } from '@/i18n'
import { isDesktopRuntime } from '@/lib/desktopRuntime'
import { useUsageSummaryStore } from '@/stores/usageSummaryStore'
import { useHahaOAuthStore } from '@/stores/hahaOAuthStore'
import { useHahaOpenAIOAuthStore } from '@/stores/hahaOpenAIOAuthStore'
import { useHahaGrokOAuthStore } from '@/stores/hahaGrokOAuthStore'
import { useHahaDeepSeekOAuthStore } from '@/stores/hahaDeepSeekOAuthStore'
import {
  computePaceMarkerPercent,
  displayPercentForWindow,
  formatCentsAsDollars,
  formatExactResetTime,
  formatResetCountdown,
  formatWalletList,
  hasNonZeroWallet,
  hasUsableBalance,
  toneForRemainingPercent,
  windowLabelKey,
} from '@/components/usage/usageFormatting'

export function OfficialUsageToolbar() {
  const t = useTranslation()
  const desktopRuntime = isDesktopRuntime()
  const summary = useUsageSummaryStore((s) => s.summary)
  const preferences = useUsageSummaryStore((s) => s.preferences)
  const preferencesLoaded = useUsageSummaryStore((s) => s.preferencesLoaded)
  const isLoading = useUsageSummaryStore((s) => s.isLoading)
  const hydratePreferences = useUsageSummaryStore((s) => s.hydratePreferences)
  const fetchSummary = useUsageSummaryStore((s) => s.fetchSummary)
  const updatePreferences = useUsageSummaryStore((s) => s.updatePreferences)
  const openFloatingWidget = useUsageSummaryStore((s) => s.openFloatingWidget)

  useEffect(() => {
    if (!preferencesLoaded) {
      void hydratePreferences()
    }
  }, [hydratePreferences, preferencesLoaded])

  useEffect(() => {
    if (!summary) {
      void fetchSummary()
    }
  }, [fetchSummary, summary])

  const updatedAt = summary?.fetchedAt ? formatExactResetTime(summary.fetchedAt) : null

  return (
    <div
      data-testid="official-usage-toolbar"
      className="mt-4 flex flex-wrap items-center justify-between gap-2.5 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3.5 py-2.5"
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[13px] font-medium text-[var(--color-text-primary)]">
          {t('usageWidget.officialToolbarTitle')}
        </span>
        <span className="text-xs text-[var(--color-text-tertiary)]">
          {updatedAt
            ? t('usageWidget.updatedAt', { time: updatedAt })
            : t('usageWidget.cacheNotice')}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl<UsageDisplayMode>
          size="sm"
          label={t('usageWidget.settingsDisplayModeTitle')}
          value={preferences.displayMode}
          onChange={(value) => void updatePreferences({ displayMode: value })}
          items={[
            { value: 'remaining', label: t('usageWidget.displayModeRemaining') },
            { value: 'used', label: t('usageWidget.displayModeUsed') },
          ]}
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void fetchSummary({ force: true })}
          loading={isLoading}
          icon={<RefreshCw size={12} strokeWidth={1.75} aria-hidden="true" />}
        >
          {t('settings.claudeOfficialLogin.usageRefresh')}
        </Button>
        {desktopRuntime ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void openFloatingWidget({ compact: false })}
            icon={<ExternalLink size={12} strokeWidth={1.75} aria-hidden="true" />}
          >
            {t('usageWidget.openFloatingButton')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export function OfficialProviderPlanUsage({
  providerId,
  isActive = false,
}: {
  providerId: OfficialUsageProviderId
  isActive?: boolean
}) {
  const t = useTranslation()
  const summary = useUsageSummaryStore((s) => s.summary)
  const preferences = useUsageSummaryStore((s) => s.preferences)
  const isLoading = useUsageSummaryStore((s) => s.isLoading)
  const fetchSummary = useUsageSummaryStore((s) => s.fetchSummary)
  const toggleDisplayMode = useUsageSummaryStore((s) => s.toggleDisplayMode)
  const toggleResetTimeFormat = useUsageSummaryStore((s) => s.toggleResetTimeFormat)

  const claudeLoggedIn = useHahaOAuthStore((s) => s.status?.loggedIn === true)
  const openaiLoggedIn = useHahaOpenAIOAuthStore((s) => s.status?.loggedIn === true)
  const grokLoggedIn = useHahaGrokOAuthStore((s) => s.status?.loggedIn === true)
  const deepseekLoggedIn = useHahaDeepSeekOAuthStore((s) => s.status?.loggedIn === true)

  const isLoggedIn =
    providerId === 'claude-official'
      ? claudeLoggedIn
      : providerId === 'openai-official'
        ? openaiLoggedIn
        : providerId === 'grok-official'
          ? grokLoggedIn
          : deepseekLoggedIn

  const provider = summary?.providers.find((item) => item.providerId === providerId)
  const providerSignedIn = provider?.signedIn === true

  useEffect(() => {
    if (!summary || (isLoggedIn && !providerSignedIn)) {
      void fetchSummary()
    }
  }, [fetchSummary, isLoggedIn, providerSignedIn, summary])

  if (!provider || !provider.signedIn) return null

  const isBalanceProvider = providerId === 'deepseek-account'
  const sectionTitle = isBalanceProvider
    ? t('usageWidget.balanceTitle')
    : t('settings.claudeOfficialLogin.usageTitle')
  const updatedAt = provider.fetchedAt ? formatExactResetTime(provider.fetchedAt) : null
  const hasBalance = hasUsableBalance(provider.balance)
  const showBonusWallets = Boolean(
    provider.balance && hasNonZeroWallet(provider.balance.bonusWallets),
  )

  return (
    <section
      aria-label={sectionTitle}
      data-testid={`official-plan-usage-${providerId}`}
      className="flex w-full flex-col gap-2.5 rounded-[var(--radius-card-inner)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {isBalanceProvider ? (
            <Wallet size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
          ) : null}
          <span className="text-xs font-medium text-[var(--color-text-secondary)]">
            {sectionTitle}
          </span>
          {provider.planLabel ? (
            <Badge tone="neutral" size="xs" pill={false}>
              {provider.planLabel}
            </Badge>
          ) : null}
          {!isActive && provider.accountLabel ? (
            <span className="truncate text-xs text-[var(--color-text-tertiary)]">
              · {provider.accountLabel}
            </span>
          ) : null}
        </div>
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

      {provider.status === 'missing_scope' ? (
        <p role="alert" className="text-xs text-[var(--color-text-secondary)]">
          {t('settings.claudeOfficialLogin.usageMissingScope')}
        </p>
      ) : null}

      {provider.status === 'rate_limited' ? (
        <div
          role="alert"
          className="flex items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--color-warning-container)] px-2.5 py-1.5 text-xs text-[var(--color-on-warning-container)]"
        >
          <TriangleAlert size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
          <span>{t('usageWidget.statusRateLimited')}</span>
        </div>
      ) : null}

      {provider.noticeCode === 'grok_team_no_personal_quota' ? (
        <p className="text-xs text-[var(--color-text-secondary)]">
          {t('usageWidget.grokTeamNoPersonalQuota')}
        </p>
      ) : provider.status === 'local_only' ? (
        <p className="text-xs text-[var(--color-text-secondary)]">
          {t('usageWidget.statusLocalOnly')}
        </p>
      ) : null}

      {hasBalance && provider.balance ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="flex flex-col gap-0.5 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
            <span className="text-[11px] text-[var(--color-text-tertiary)]">
              {t('usageWidget.rechargeBalance')}
            </span>
            <span
              data-testid={`official-balance-normal-${providerId}`}
              className="font-mono text-sm tabular-nums text-[var(--color-text-primary)]"
            >
              {provider.balance.normalWallets.length > 0
                ? formatWalletList(provider.balance.normalWallets)
                : t('usageWidget.valueUnavailable')}
            </span>
          </div>
          {showBonusWallets ? (
            <div className="flex flex-col gap-0.5 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
              <span className="text-[11px] text-[var(--color-text-tertiary)]">
                {t('usageWidget.bonusBalance')}
              </span>
              <span
                data-testid={`official-balance-bonus-${providerId}`}
                className="font-mono text-sm tabular-nums text-[var(--color-text-secondary)]"
              >
                {formatWalletList(provider.balance.bonusWallets)}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {provider.windows.length > 0 ? (
        <ul className="flex flex-col gap-2.5">
          {provider.windows.map((window) => {
            const pct = displayPercentForWindow(window, preferences.displayMode)
            const paceMarker = computePaceMarkerPercent(window, preferences.displayMode)
            const resetValue = preferences.showExactResetTime
              ? formatExactResetTime(window.resetsAt)
              : formatResetCountdown(window.resetsAt)
            const percentLabel = window.unlimited
              ? t('usageWidget.unlimited')
              : pct === null
                ? t('usageWidget.valueUnavailable')
                : preferences.displayMode === 'used'
                  ? t('usageWidget.usedPercent', { percent: String(pct) })
                  : t('usageWidget.remainingPercent', { percent: String(pct) })
            return (
              <li key={window.metricKey} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs">
                  <span className="text-[var(--color-text-primary)]">
                    {t(windowLabelKey(window.kind))}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void toggleDisplayMode()}
                      title={t('usageWidget.toggleDisplayModeHint')}
                      className="rounded-[var(--radius-xs)] px-1 py-0.5 text-xs font-medium tabular-nums text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
                    >
                      {percentLabel}
                    </button>
                    {resetValue ? (
                      <button
                        type="button"
                        onClick={() => void toggleResetTimeFormat()}
                        title={t('usageWidget.toggleResetFormatHint')}
                        className="rounded-[var(--radius-xs)] px-1 py-0.5 font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
                      >
                        {preferences.showExactResetTime
                          ? t('settings.claudeOfficialLogin.usageResetsAt', { time: resetValue })
                          : t('usageWidget.resetsInShort', { time: resetValue })}
                      </button>
                    ) : null}
                  </div>
                </div>
                {pct !== null ? (
                  <div className="relative">
                    <Progress
                      value={pct}
                      size="xs"
                      tone={toneForRemainingPercent(window.remainingPercent)}
                      label={`${t(windowLabelKey(window.kind))} ${pct}%`}
                    />
                    {paceMarker !== null ? (
                      <span
                        aria-hidden="true"
                        title={t('usageWidget.paceMarkerHint')}
                        className="pointer-events-none absolute -top-0.5 bottom-[-2px] w-0.5 rounded-full bg-[var(--color-text-primary)] opacity-45"
                        style={{ left: `${paceMarker}%` }}
                      />
                    ) : null}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}

      {provider.onDemandCapCents && provider.onDemandCapCents > 0 ? (
        <div className="flex items-center justify-between gap-2 text-xs text-[var(--color-text-secondary)]">
          <span>{t('usageWidget.payAsYouGoLabel')}</span>
          <Badge tone="neutral" size="xs" pill={false}>
            {t('usageWidget.payAsYouGoCap', { amount: formatCentsAsDollars(provider.onDemandCapCents) })}
          </Badge>
        </div>
      ) : null}

      {provider.status === 'unavailable' && provider.windows.length === 0 && !hasBalance ? (
        <p role="alert" className="text-xs text-[var(--color-text-secondary)]">
          {provider.httpStatus === 401
            ? t('usageWidget.statusAuthExpired')
            : t('usageWidget.statusUnavailable')}
        </p>
      ) : null}
    </section>
  )
}
