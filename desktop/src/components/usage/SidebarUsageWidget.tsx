import { useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Gauge } from 'lucide-react'
import { Progress } from '@/components/ui/Progress'
import { Tooltip } from '@/components/ui/Tooltip'
import { ModelBrandIcon } from '@/components/composite/ModelBrandIcon'
import { useAnchoredPosition } from '@/hooks/useAnchoredPosition'
import { useDismissable } from '@/hooks/useDismissable'
import { useTranslation } from '@/i18n'
import { isDesktopRuntime } from '@/lib/desktopRuntime'
import { useTabStore, SETTINGS_TAB_ID } from '@/stores/tabStore'
import { useUIStore } from '@/stores/uiStore'
import {
  selectPrimaryUsageHighlight,
  shouldShowSidebarUsageWidget,
  useUsageSummaryStore,
} from '@/stores/usageSummaryStore'
import { UsageSummaryPanel } from './UsageSummaryPanel'
import {
  displayPercentForWindow,
  formatCompactTokenCount,
  formatResetCountdown,
  providerTitleKey,
  toneForRemainingPercent,
} from './usageFormatting'

const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000

export function SidebarUsageWidget({ collapsed }: { collapsed: boolean }) {
  const t = useTranslation()
  const desktopRuntime = isDesktopRuntime()
  const summary = useUsageSummaryStore((s) => s.summary)
  const preferences = useUsageSummaryStore((s) => s.preferences)
  const preferencesLoaded = useUsageSummaryStore((s) => s.preferencesLoaded)
  const isLoading = useUsageSummaryStore((s) => s.isLoading)
  const popoverOpen = useUsageSummaryStore((s) => s.popoverOpen)
  const setPopoverOpen = useUsageSummaryStore((s) => s.setPopoverOpen)
  const fetchSummary = useUsageSummaryStore((s) => s.fetchSummary)
  const hydratePreferences = useUsageSummaryStore((s) => s.hydratePreferences)
  const toggleDisplayMode = useUsageSummaryStore((s) => s.toggleDisplayMode)
  const toggleResetTimeFormat = useUsageSummaryStore((s) => s.toggleResetTimeFormat)
  const togglePinMetric = useUsageSummaryStore((s) => s.togglePinMetric)
  const openFloatingWidget = useUsageSummaryStore((s) => s.openFloatingWidget)
  const snapFloatingToTop = useUsageSummaryStore((s) => s.snapFloatingToTop)

  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const anchored = useAnchoredPosition({
    open: popoverOpen,
    anchorRef: triggerRef,
    floatingRef: popoverRef,
    placement: 'top-start',
    offset: 8,
    viewportMargin: 8,
    flip: true,
    shift: true,
    clampHeight: true,
  })

  useDismissable({
    open: popoverOpen,
    onDismiss: () => setPopoverOpen(false),
    refs: [triggerRef, popoverRef],
  })

  // Hydrate preferences first; wait for preferencesLoaded before querying summary
  // so hidden users with menuBarEnabled=false never fire an unwanted initial request.
  useEffect(() => {
    if (!desktopRuntime) return
    if (!preferencesLoaded) {
      void hydratePreferences()
      return
    }
    if (preferences.sidebarVisibility === 'hidden' && !preferences.menuBarEnabled) return
    void fetchSummary()
  }, [
    desktopRuntime,
    fetchSummary,
    hydratePreferences,
    preferences.menuBarEnabled,
    preferences.sidebarVisibility,
    preferencesLoaded,
  ])

  // Refresh quietly every 5 minutes while document is visible and either sidebar,
  // menu bar status, or popover is active.
  useEffect(() => {
    if (!desktopRuntime || !preferencesLoaded) return
    if (preferences.sidebarVisibility === 'hidden' && !preferences.menuBarEnabled && !popoverOpen) {
      return
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void fetchSummary()
    }, AUTO_REFRESH_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [
    desktopRuntime,
    fetchSummary,
    popoverOpen,
    preferences.menuBarEnabled,
    preferences.sidebarVisibility,
    preferencesLoaded,
  ])

  const visible = desktopRuntime && shouldShowSidebarUsageWidget(preferences, summary)
  const highlight = useMemo(
    () => selectPrimaryUsageHighlight(summary, preferences.pinnedMetricKeys),
    [summary, preferences.pinnedMetricKeys],
  )

  if (!visible) return null

  const openProviderSettings = () => {
    setPopoverOpen(false)
    useUIStore.getState().setPendingSettingsTab('providers')
    useTabStore.getState().openTab(SETTINGS_TAB_ID, t('sidebar.settings'), 'settings')
  }

  const remainingPct = highlight?.window.remainingPercent ?? null
  const displayPct = highlight
    ? displayPercentForWindow(highlight.window, preferences.displayMode)
    : null
  const tone = toneForRemainingPercent(remainingPct)
  const isCritical = remainingPct !== null && remainingPct <= 15
  const resetCountdown = highlight ? formatResetCountdown(highlight.window.resetsAt) : null
  const localTokensText = formatCompactTokenCount(summary?.localWindow.totalTokens ?? 0)

  const percentText = highlight?.window.unlimited
    ? t('usageWidget.unlimited')
    : displayPct !== null
      ? preferences.displayMode === 'used'
        ? t('usageWidget.usedPercent', { percent: String(displayPct) })
        : t('usageWidget.remainingPercent', { percent: String(displayPct) })
      : t('usageWidget.tokensCount', { amount: localTokensText })

  const collapsedTooltip = highlight
    ? `${t(providerTitleKey(highlight.provider.providerId))} · ${percentText}`
    : `${t('usageWidget.localFiveHourTitle')} · ${t('usageWidget.tokensCount', { amount: localTokensText })}`

  const strokeColor =
    tone === 'danger'
      ? 'var(--color-error)'
      : tone === 'warning'
        ? 'var(--color-warning)'
        : tone === 'success'
          ? 'var(--color-success)'
          : 'var(--color-brand)'

  const triggerButton = (
    <button
      ref={triggerRef}
      type="button"
      data-testid="sidebar-usage-trigger"
      aria-expanded={popoverOpen}
      aria-haspopup="dialog"
      aria-label={t('usageWidget.sidebarTriggerLabel')}
      onClick={() => {
        const next = !popoverOpen
        setPopoverOpen(next)
        if (next) void fetchSummary()
      }}
      className={collapsed
        ? `flex h-9 w-9 items-center justify-center rounded-[var(--radius-md)] border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${
            isCritical
              ? 'border-[var(--color-error)] bg-[var(--color-error-container)] text-[var(--color-on-error-container)]'
              : popoverOpen
                ? 'border-[var(--color-border-strong)] bg-[var(--color-surface)]'
                : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-sidebar-item-hover)]'
          }`
        : `flex w-full flex-col gap-1.5 rounded-[var(--radius-md)] border px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${
            isCritical
              ? 'border-[var(--color-error)] bg-[var(--color-error-container)] text-[var(--color-on-error-container)]'
              : popoverOpen
                ? 'border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-card)]'
                : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border-strong)]'
          }`}
    >
      {collapsed ? (
        <span className="relative flex h-7 w-7 items-center justify-center">
          <svg width="26" height="26" viewBox="0 0 26 26" className="absolute inset-0 -rotate-90" aria-hidden="true">
            <circle cx="13" cy="13" r="10.5" fill="none" stroke="var(--color-surface-container-high)" strokeWidth="2.5" />
            <circle
              cx="13"
              cy="13"
              r="10.5"
              fill="none"
              stroke={strokeColor}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={2 * Math.PI * 10.5}
              strokeDashoffset={(2 * Math.PI * 10.5) * (1 - ((remainingPct ?? 100) / 100))}
            />
          </svg>
          {highlight ? (
            <ModelBrandIcon providerId={highlight.provider.providerId} size={11} />
          ) : (
            <Gauge size={12} strokeWidth={1.75} aria-hidden="true" />
          )}
        </span>
      ) : (
        <>
          <div className="flex w-full items-center justify-between gap-2 text-xs">
            <span className="flex min-w-0 items-center gap-1.5 font-medium text-[var(--color-text-primary)]">
              {highlight ? (
                <ModelBrandIcon providerId={highlight.provider.providerId} size={13} />
              ) : (
                <Gauge size={13} strokeWidth={1.75} aria-hidden="true" className="text-[var(--color-text-tertiary)]" />
              )}
              <span className="truncate">
                {highlight
                  ? t(providerTitleKey(highlight.provider.providerId))
                  : t('usageWidget.localFiveHourTitle')}
              </span>
            </span>
            <span
              className={`shrink-0 font-medium tabular-nums ${
                isCritical
                  ? 'text-[var(--color-on-error-container)]'
                  : tone === 'warning'
                    ? 'text-[var(--color-warning)]'
                    : tone === 'success'
                      ? 'text-[var(--color-success)]'
                      : 'text-[var(--color-text-primary)]'
              }`}
            >
              {percentText}
            </span>
          </div>
          {displayPct !== null ? (
            <Progress
              value={displayPct}
              size="xs"
              tone={tone}
              label={`${t('usageWidget.sidebarTriggerLabel')} ${displayPct}%`}
            />
          ) : null}
          <div className="flex w-full items-center justify-between gap-2 font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
            <span className="truncate">
              {resetCountdown
                ? t('usageWidget.resetsInShort', { time: resetCountdown })
                : t('usageWidget.windowFiveHour')}
            </span>
            <span className="shrink-0">
              {t('usageWidget.fiveHourTokensShort', { amount: localTokensText })}
            </span>
          </div>
        </>
      )}
    </button>
  )

  const popoverMaxHeight =
    typeof anchored.style.maxHeight === 'number'
      ? Math.min(460, Math.max(180, anchored.style.maxHeight))
      : 460

  return (
    <div
      data-testid="sidebar-usage-widget"
      className={`relative px-2 pb-1.5 ${collapsed ? 'mb-14 flex justify-center' : 'mb-12'}`}
    >
      {collapsed ? (
        <Tooltip placement="top-start" appearance="surface" content={collapsedTooltip}>
          {triggerButton}
        </Tooltip>
      ) : (
        triggerButton
      )}

      {popoverOpen
        ? createPortal(
            <div
              ref={popoverRef}
              role="dialog"
              aria-label={t('usageWidget.popoverTitle')}
              data-testid="sidebar-usage-popover"
              className="dropdown-glass popover-motion z-[var(--z-popover)] flex w-[340px] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-overlay)]"
              style={{ ...anchored.style, maxHeight: popoverMaxHeight }}
            >
              <UsageSummaryPanel
                summary={summary}
                preferences={preferences}
                isLoading={isLoading}
                isDesktopRuntime={desktopRuntime}
                showDetachControls
                onRefresh={() => void fetchSummary({ force: true })}
                onToggleDisplayMode={() => void toggleDisplayMode()}
                onToggleResetTimeFormat={() => void toggleResetTimeFormat()}
                onTogglePinMetric={(metricKey) => void togglePinMetric(metricKey)}
                onOpenFloating={() => void openFloatingWidget({ compact: false })}
                onSnapToTop={() => void snapFloatingToTop()}
                onOpenSettings={openProviderSettings}
              />
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
