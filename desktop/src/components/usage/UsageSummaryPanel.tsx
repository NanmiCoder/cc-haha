import { useMemo, useState } from 'react'
import { ExternalLink, Pin, PinOff, RefreshCw, Settings, TriangleAlert } from 'lucide-react'
import type {
  OfficialProviderUsageSummary,
  OfficialUsageWindow,
  UnifiedUsageSummaryResponse,
} from '@/api/usageSummary'
import type { DesktopUsageWidgetPreferences } from '@/api/desktopUiPreferences'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Progress } from '@/components/ui/Progress'
import { ScrollArea } from '@/components/ui/ScrollArea'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { ModelBrandIcon } from '@/components/composite/ModelBrandIcon'
import { useTranslation } from '@/i18n'
import {
  computePaceMarkerPercent,
  displayPercentForWindow,
  formatCompactTokenCount,
  formatExactResetTime,
  formatResetCountdown,
  providerTitleKey,
  toneForRemainingPercent,
  windowLabelKey,
} from './usageFormatting'

type PanelTab = 'priority' | 'all'

type FlattenedMetric = {
  provider: OfficialProviderUsageSummary
  window: OfficialUsageWindow
}

function RingGauge({
  remainingPercent,
  providerId,
  onTintedContainer = false,
}: {
  remainingPercent: number | null
  providerId: OfficialProviderUsageSummary['providerId']
  onTintedContainer?: boolean
}) {
  const size = 32
  const strokeWidth = 3
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const fraction = remainingPercent === null ? 0 : Math.max(0.03, remainingPercent / 100)
  const dashOffset = circumference * (1 - fraction)
  const tone = toneForRemainingPercent(remainingPercent)
  const strokeColor =
    tone === 'danger'
      ? 'var(--color-error)'
      : tone === 'warning'
        ? 'var(--color-warning)'
        : 'var(--color-brand)'

  return (
    <span className="relative flex h-8 w-8 shrink-0 items-center justify-center">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="absolute inset-0 -rotate-90"
        aria-hidden="true"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={onTintedContainer ? 'currentColor' : 'var(--color-surface-container-high)'}
          strokeOpacity={onTintedContainer ? 0.22 : undefined}
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
        />
      </svg>
      <ModelBrandIcon providerId={providerId} size={13} />
    </span>
  )
}

function toneTextClass(remainingPercent: number | null): string {
  const tone = toneForRemainingPercent(remainingPercent)
  if (tone === 'danger') return 'text-[var(--color-error)]'
  if (tone === 'warning') return 'text-[var(--color-warning)]'
  return 'text-[var(--color-text-primary)]'
}

export function UsageSummaryPanel({
  summary,
  preferences,
  isLoading,
  isDesktopRuntime,
  showDetachControls = true,
  onRefresh,
  onToggleDisplayMode,
  onToggleResetTimeFormat,
  onTogglePinMetric,
  onOpenFloating,
  onSnapToTop,
  onOpenSettings,
}: {
  summary: UnifiedUsageSummaryResponse | null
  preferences: DesktopUsageWidgetPreferences
  isLoading: boolean
  isDesktopRuntime: boolean
  showDetachControls?: boolean
  onRefresh: () => void
  onToggleDisplayMode: () => void
  onToggleResetTimeFormat: () => void
  onTogglePinMetric: (metricKey: string) => void
  onOpenFloating?: () => void
  onSnapToTop?: () => void
  onOpenSettings?: () => void
}) {
  const t = useTranslation()
  const [tab, setTab] = useState<PanelTab>('priority')

  const signedInProviders = useMemo(
    () => (summary?.providers ?? []).filter((provider) => provider.signedIn),
    [summary],
  )

  const allMetrics = useMemo<FlattenedMetric[]>(() => {
    const rows: FlattenedMetric[] = []
    for (const provider of signedInProviders) {
      for (const window of provider.windows) {
        rows.push({ provider, window })
      }
    }
    return rows
  }, [signedInProviders])

  const pinnedSet = useMemo(
    () => new Set(preferences.pinnedMetricKeys),
    [preferences.pinnedMetricKeys],
  )

  const pinnedMetrics = useMemo(
    () => allMetrics.filter((item) => pinnedSet.has(item.window.metricKey)),
    [allMetrics, pinnedSet],
  )

  const runningOutMetrics = useMemo(
    () => allMetrics.filter(
      (item) =>
        !pinnedSet.has(item.window.metricKey) &&
        item.window.remainingPercent !== null &&
        item.window.remainingPercent <= 30,
    ),
    [allMetrics, pinnedSet],
  )

  const updatedLabel = useMemo(() => {
    if (!summary?.fetchedAt) return null
    const formatted = formatExactResetTime(summary.fetchedAt)
    return formatted ? t('usageWidget.updatedAt', { time: formatted }) : null
  }, [summary?.fetchedAt, t])

  const renderPercentButton = (
    window: OfficialUsageWindow,
    containerTone?: 'warning' | 'danger',
  ) => {
    const pct = displayPercentForWindow(window, preferences.displayMode)
    const label = window.unlimited
      ? t('usageWidget.unlimited')
      : pct === null
        ? t('usageWidget.valueUnavailable')
        : preferences.displayMode === 'used'
          ? t('usageWidget.usedPercent', { percent: String(pct) })
          : t('usageWidget.remainingPercent', { percent: String(pct) })
    return (
      <button
        type="button"
        onClick={onToggleDisplayMode}
        title={t('usageWidget.toggleDisplayModeHint')}
        className={`cursor-pointer rounded-[var(--radius-sm)] px-1 py-0.5 text-xs font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${
          containerTone === 'warning'
            ? 'text-[var(--color-on-warning-container)] hover:underline'
            : containerTone === 'danger'
              ? 'text-[var(--color-on-error-container)] hover:underline'
              : `hover:bg-[var(--color-surface-hover)] ${toneTextClass(window.remainingPercent)}`
        }`}
      >
        {label}
      </button>
    )
  }

  const renderResetButton = (
    window: OfficialUsageWindow,
    containerTone?: 'warning' | 'danger',
  ) => {
    const value = preferences.showExactResetTime
      ? formatExactResetTime(window.resetsAt)
      : formatResetCountdown(window.resetsAt)
    if (!value) return null
    return (
      <button
        type="button"
        onClick={onToggleResetTimeFormat}
        title={t('usageWidget.toggleResetFormatHint')}
        className={`cursor-pointer rounded-[var(--radius-sm)] px-1 py-0.5 font-mono text-[11px] tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${
          containerTone === 'warning'
            ? 'text-[var(--color-on-warning-container)] hover:underline'
            : containerTone === 'danger'
              ? 'text-[var(--color-on-error-container)] hover:underline'
              : 'text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
        }`}
      >
        {value}
      </button>
    )
  }

  const localTotal = formatCompactTokenCount(summary?.localWindow.totalTokens ?? 0)
  const localInput = formatCompactTokenCount(summary?.localWindow.inputTokens ?? 0)
  const localCache = formatCompactTokenCount(summary?.localWindow.cacheReadTokens ?? 0)
  const localOutput = formatCompactTokenCount(summary?.localWindow.outputTokens ?? 0)

  const renderPriorityView = () => {
    if (signedInProviders.length === 0) {
      return (
        <div className="flex flex-col gap-2.5">
          <div className="rounded-[var(--radius-card-inner)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-[var(--color-text-primary)]">
                {t('usageWidget.localFiveHourTitle')}
              </span>
              <span className="font-mono text-xs tabular-nums text-[var(--color-text-primary)]">
                {t('usageWidget.tokensCount', { amount: localTotal })}
              </span>
            </div>
            <p className="mt-1 font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
              {t('usageWidget.localBreakdown', { input: localInput, cache: localCache, output: localOutput })}
            </p>
          </div>
          <div className="v6c-raised rounded-[var(--radius-card-inner)] border border-[var(--color-border)] p-3">
            <p className="text-xs text-[var(--color-text-secondary)]">
              {t('usageWidget.noOfficialSubscriptions')}
            </p>
            {onOpenSettings ? (
              <div className="mt-2">
                <Button variant="secondary" size="sm" onClick={onOpenSettings}>
                  {t('usageWidget.openProviderSettings')}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      )
    }

    const displayPinned = pinnedMetrics.length > 0 ? pinnedMetrics : allMetrics.slice(0, 2)
    const hasCriticalRunningOut = runningOutMetrics.some(
      ({ window }) => toneForRemainingPercent(window.remainingPercent) === 'danger',
    )

    return (
      <div className="flex flex-col gap-2.5">
        {displayPinned.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <span className="px-0.5 text-[11px] font-medium text-[var(--color-text-tertiary)]">
              {t('usageWidget.sectionPinned')}
            </span>
            {displayPinned.map(({ provider, window }) => (
              <div
                key={window.metricKey}
                data-testid={`usage-priority-row-${window.metricKey}`}
                className="v6c-raised flex items-center justify-between gap-2.5 rounded-[var(--radius-card-inner)] border border-[var(--color-border)] px-2.5 py-2"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <RingGauge
                    remainingPercent={window.remainingPercent}
                    providerId={provider.providerId}
                  />
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium text-[var(--color-text-primary)]">
                      {t(providerTitleKey(provider.providerId))}
                    </div>
                    <div className="truncate text-[11px] text-[var(--color-text-tertiary)]">
                      {t(windowLabelKey(window.kind))}
                      {provider.planLabel ? ` · ${provider.planLabel}` : ''}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end">
                  {renderPercentButton(window)}
                  {renderResetButton(window)}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {runningOutMetrics.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <span
              className={`px-0.5 text-[11px] font-medium ${
                hasCriticalRunningOut ? 'text-[var(--color-error)]' : 'text-[var(--color-warning)]'
              }`}
            >
              {t('usageWidget.sectionRunningOut')}
            </span>
            {runningOutMetrics.map(({ provider, window }) => {
              const rowTone =
                toneForRemainingPercent(window.remainingPercent) === 'warning' ? 'warning' : 'danger'
              return (
                <div
                  key={window.metricKey}
                  data-testid={`usage-running-out-row-${window.metricKey}`}
                  className={`flex items-center justify-between gap-2.5 rounded-[var(--radius-card-inner)] border border-[var(--color-border)] px-2.5 py-2 ${
                    rowTone === 'warning'
                      ? 'bg-[var(--color-warning-container)] text-[var(--color-on-warning-container)]'
                      : 'bg-[var(--color-error-container)] text-[var(--color-on-error-container)]'
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <RingGauge
                      remainingPercent={window.remainingPercent}
                      providerId={provider.providerId}
                      onTintedContainer
                    />
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium">
                        {t(providerTitleKey(provider.providerId))}
                      </div>
                      <div className="truncate text-[11px]">
                        {t(windowLabelKey(window.kind))}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end">
                    {renderPercentButton(window, rowTone)}
                    {renderResetButton(window, rowTone)}
                  </div>
                </div>
              )
            })}
          </div>
        ) : null}

        <div className="rounded-[var(--radius-card-inner)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-[var(--color-text-primary)]">
              {t('usageWidget.localFiveHourTitle')}
            </span>
            <span className="font-mono text-xs tabular-nums text-[var(--color-text-primary)]">
              {t('usageWidget.tokensCount', { amount: localTotal })}
            </span>
          </div>
          <p className="mt-0.5 font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
            {t('usageWidget.localBreakdown', { input: localInput, cache: localCache, output: localOutput })}
          </p>
        </div>
      </div>
    )
  }

  const renderAllView = () => {
    if (signedInProviders.length === 0) {
      return renderPriorityView()
    }
    return (
      <div className="flex flex-col gap-2.5">
        {signedInProviders.map((provider) => (
          <section
            key={provider.providerId}
            data-testid={`usage-provider-card-${provider.providerId}`}
            className="v6c-raised flex flex-col gap-2 rounded-[var(--radius-card-inner)] border border-[var(--color-border)] p-2.5"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <ModelBrandIcon providerId={provider.providerId} size={15} />
                <span className="truncate text-xs font-medium text-[var(--color-text-primary)]">
                  {t(providerTitleKey(provider.providerId))}
                </span>
              </div>
              {provider.planLabel ? (
                <Badge tone="neutral" size="xs" pill={false}>{provider.planLabel}</Badge>
              ) : null}
            </div>

            {provider.status === 'rate_limited' ? (
              <div className="flex items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--color-warning-container)] px-2 py-1 text-[11px] text-[var(--color-on-warning-container)]">
                <TriangleAlert size={12} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
                <span>{t('usageWidget.statusRateLimited')}</span>
              </div>
            ) : provider.status === 'missing_scope' ? (
              <p className="text-[11px] text-[var(--color-text-secondary)]">
                {t('settings.claudeOfficialLogin.usageMissingScope')}
              </p>
            ) : provider.status === 'local_only' ? (
              <p className="text-[11px] text-[var(--color-text-tertiary)]">
                {t('usageWidget.statusLocalOnly')}
              </p>
            ) : provider.status === 'unavailable' && provider.windows.length === 0 ? (
              <p className="text-[11px] text-[var(--color-text-tertiary)]">
                {t('usageWidget.statusUnavailable')}
              </p>
            ) : null}

            {provider.windows.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {provider.windows.map((window) => {
                  const pct = displayPercentForWindow(window, preferences.displayMode)
                  const pinned = pinnedSet.has(window.metricKey)
                  const paceMarker = computePaceMarkerPercent(window, preferences.displayMode)
                  return (
                    <li key={window.metricKey} className="flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-1">
                          <span className="truncate text-xs text-[var(--color-text-secondary)]">
                            {t(windowLabelKey(window.kind))}
                          </span>
                          <IconButton
                            icon={pinned
                              ? <PinOff size={11} strokeWidth={1.75} aria-hidden="true" />
                              : <Pin size={11} strokeWidth={1.75} aria-hidden="true" />}
                            label={pinned ? t('usageWidget.unpinMetric') : t('usageWidget.pinMetric')}
                            size="2xs"
                            tone={pinned ? 'brand' : 'muted'}
                            onClick={() => onTogglePinMetric(window.metricKey)}
                          />
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {renderPercentButton(window)}
                          {renderResetButton(window)}
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
          </section>
        ))}

        <div className="rounded-[var(--radius-card-inner)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-[var(--color-text-primary)]">
              {t('usageWidget.localFiveHourTitle')}
            </span>
            <span className="font-mono text-xs tabular-nums text-[var(--color-text-primary)]">
              {t('usageWidget.tokensCount', { amount: localTotal })}
            </span>
          </div>
          <p className="mt-0.5 font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
            {t('usageWidget.localBreakdown', { input: localInput, cache: localCache, output: localOutput })}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div
      data-testid="usage-summary-panel"
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
        <SegmentedControl
          size="sm"
          as="tablist"
          label={t('usageWidget.tabsLabel')}
          value={tab}
          onChange={setTab}
          items={[
            { value: 'priority', label: t('usageWidget.tabPriority') },
            {
              value: 'all',
              label: signedInProviders.length > 0
                ? t('usageWidget.tabAllWithCount', { count: String(signedInProviders.length) })
                : t('usageWidget.tabAll'),
            },
          ]}
        />
        <div className="flex items-center gap-0.5">
          <IconButton
            icon={<RefreshCw size={13} strokeWidth={1.75} className={isLoading ? 'animate-spin' : ''} aria-hidden="true" />}
            label={t('usageWidget.refresh')}
            size="xs"
            tone="muted"
            onClick={onRefresh}
            disabled={isLoading}
          />
          {showDetachControls && isDesktopRuntime && onOpenFloating ? (
            <IconButton
              icon={<ExternalLink size={13} strokeWidth={1.75} aria-hidden="true" />}
              label={t('usageWidget.detachWindow')}
              size="xs"
              tone="muted"
              onClick={onOpenFloating}
            />
          ) : null}
          {onOpenSettings ? (
            <IconButton
              icon={<Settings size={13} strokeWidth={1.75} aria-hidden="true" />}
              label={t('usageWidget.openSettings')}
              size="xs"
              tone="muted"
              onClick={onOpenSettings}
            />
          ) : null}
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1 px-3 py-2.5">
        {tab === 'priority' ? renderPriorityView() : renderAllView()}
      </ScrollArea>

      <div className="flex items-center justify-between gap-2 border-t border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-2 text-[11px] text-[var(--color-text-tertiary)]">
        <span className="truncate">{updatedLabel ?? t('usageWidget.cacheNotice')}</span>
        {showDetachControls && isDesktopRuntime && onSnapToTop ? (
          <button
            type="button"
            onClick={onSnapToTop}
            className="shrink-0 cursor-pointer rounded-[var(--radius-sm)] px-1 font-medium text-[var(--color-brand)] transition-colors hover:text-[var(--color-brand-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          >
            {t('usageWidget.snapTopButton')}
          </button>
        ) : null}
      </div>
    </div>
  )
}
