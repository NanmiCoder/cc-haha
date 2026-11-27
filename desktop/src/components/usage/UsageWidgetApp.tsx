import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { GripVertical, Maximize2, Minimize2, Pin, PinOff, X } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { ModelBrandIcon } from '@/components/composite/ModelBrandIcon'
import { useTranslation } from '@/i18n'
import { getDesktopHost } from '@/lib/desktopHost'
import { initializeDesktopServerUrl } from '@/lib/desktopRuntime'
import {
  selectPrimaryUsageHighlight,
  useUsageSummaryStore,
} from '@/stores/usageSummaryStore'
import { UsageSummaryPanel } from './UsageSummaryPanel'
import {
  displayPercentForWindow,
  formatCompactTokenCount,
  formatResetCountdown,
  formatWalletAmount,
  toneForRemainingPercent,
} from './usageFormatting'

const REFRESH_INTERVAL_MS = 5 * 60 * 1000

export function UsageWidgetApp() {
  const t = useTranslation()
  const summary = useUsageSummaryStore((s) => s.summary)
  const preferences = useUsageSummaryStore((s) => s.preferences)
  const isLoading = useUsageSummaryStore((s) => s.isLoading)
  const hydratePreferences = useUsageSummaryStore((s) => s.hydratePreferences)
  const fetchSummary = useUsageSummaryStore((s) => s.fetchSummary)
  const updatePreferences = useUsageSummaryStore((s) => s.updatePreferences)
  const toggleDisplayMode = useUsageSummaryStore((s) => s.toggleDisplayMode)
  const toggleResetTimeFormat = useUsageSummaryStore((s) => s.toggleResetTimeFormat)
  const togglePinMetric = useUsageSummaryStore((s) => s.togglePinMetric)
  const [ready, setReady] = useState(false)
  const draggingPointerIdRef = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await initializeDesktopServerUrl()
        if (cancelled) return
        await hydratePreferences()
        await fetchSummary()
      } finally {
        if (!cancelled) setReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fetchSummary, hydratePreferences])

  useEffect(() => {
    if (!ready) return
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void fetchSummary()
    }, REFRESH_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [fetchSummary, ready])

  useEffect(() => {
    const host = getDesktopHost()
    if (!host.isDesktop || !host.usageWidget?.onPreferencesChanged) return
    let unlisten: (() => void) | undefined
    let disposed = false
    host.usageWidget.onPreferencesChanged(() => {
      void hydratePreferences()
    })
      .then((fn) => {
        if (disposed) fn()
        else unlisten = fn
      })
      .catch(() => {})
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [hydratePreferences])

  const handleDragPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const host = getDesktopHost()
    if (!host.isDesktop || !host.usageWidget) return
    draggingPointerIdRef.current = event.pointerId
    event.currentTarget.setPointerCapture(event.pointerId)
    void host.usageWidget.dragWindow({
      phase: 'start',
      x: Math.round(event.screenX),
      y: Math.round(event.screenY),
    }).catch(() => {})
  }, [])

  const handleDragPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (draggingPointerIdRef.current !== event.pointerId) return
    const host = getDesktopHost()
    if (!host.isDesktop || !host.usageWidget) return
    void host.usageWidget.dragWindow({
      phase: 'move',
      x: Math.round(event.screenX),
      y: Math.round(event.screenY),
    }).catch(() => {})
  }, [])

  const handleDragPointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (draggingPointerIdRef.current !== event.pointerId) return
    draggingPointerIdRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const host = getDesktopHost()
    if (!host.isDesktop || !host.usageWidget) return
    void host.usageWidget.dragWindow({
      phase: 'end',
      x: Math.round(event.screenX),
      y: Math.round(event.screenY),
    }).catch(() => {})
  }, [])

  const handleToggleCompact = useCallback(() => {
    const nextCompact = !preferences.floatingCompact
    const host = getDesktopHost()
    if (host.isDesktop && host.usageWidget) {
      if (nextCompact) {
        void host.usageWidget.snapToTop().catch(() => {})
      } else {
        void host.usageWidget.setCompact(false).catch(() => {})
      }
    }
    void updatePreferences(
      nextCompact
        ? { floatingCompact: true, floatingAlwaysOnTop: true }
        : { floatingCompact: false },
      { skipWindowSync: true },
    )
  }, [preferences.floatingCompact, updatePreferences])

  const handleToggleAlwaysOnTop = useCallback(() => {
    const next = !preferences.floatingAlwaysOnTop
    const host = getDesktopHost()
    if (host.isDesktop && host.usageWidget) {
      void host.usageWidget.setAlwaysOnTop(next).catch(() => {})
    }
    void updatePreferences({ floatingAlwaysOnTop: next }, { skipWindowSync: true })
  }, [preferences.floatingAlwaysOnTop, updatePreferences])

  const handleClose = useCallback(() => {
    const host = getDesktopHost()
    if (host.isDesktop && host.usageWidget) {
      void host.usageWidget.hide().catch(() => {})
    }
    void updatePreferences({ floatingEnabled: false }, { skipWindowSync: true })
  }, [updatePreferences])

  const handleOpenSettings = useCallback(() => {
    const host = getDesktopHost()
    if (host.isDesktop && host.usageWidget) {
      void host.usageWidget.openSettings('providers').catch(() => {})
    }
  }, [])

  const compactMetrics = useMemo(() => {
    const providers = (summary?.providers ?? []).filter((provider) => provider.signedIn && provider.windows.length > 0)
    return providers.slice(0, 2).map((provider) => ({
      provider,
      window: provider.windows[0]!,
    }))
  }, [summary])

  const compactBalance = useMemo(() => {
    const provider = (summary?.providers ?? []).find(
      (item) => item.signedIn && (item.balance?.normalWallets[0] || item.balance?.bonusWallets[0]),
    )
    const wallet = provider?.balance?.normalWallets[0] ?? provider?.balance?.bonusWallets[0]
    if (!provider || !wallet) return null
    return {
      provider,
      amount: formatWalletAmount(wallet.currency, wallet.balance),
    }
  }, [summary])

  const primaryHighlight = useMemo(
    () => selectPrimaryUsageHighlight(summary, preferences.pinnedMetricKeys),
    [summary, preferences.pinnedMetricKeys],
  )

  const localTokensText = formatCompactTokenCount(summary?.localWindow.totalTokens ?? 0)

  if (preferences.floatingCompact) {
    return (
      <div
        data-testid="usage-widget-compact"
        className="flex h-screen w-screen items-center justify-between gap-2 overflow-hidden rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 shadow-[var(--shadow-overlay)] select-none"
      >
        <div
          onPointerDown={handleDragPointerDown}
          onPointerMove={handleDragPointerMove}
          onPointerUp={handleDragPointerEnd}
          onPointerCancel={handleDragPointerEnd}
          className="flex min-w-0 flex-1 cursor-grab items-center gap-2 active:cursor-grabbing"
        >
          <GripVertical size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
          {compactMetrics.length > 0 ? (
            compactMetrics.map(({ provider, window }) => {
              const pct = displayPercentForWindow(window, preferences.displayMode)
              const tone = toneForRemainingPercent(window.remainingPercent)
              const countdown = formatResetCountdown(window.resetsAt)
              return (
                <span key={window.metricKey} className="inline-flex shrink-0 items-center gap-1 text-xs">
                  <ModelBrandIcon providerId={provider.providerId} size={13} />
                  <span
                    className={`font-medium tabular-nums ${
                      tone === 'danger'
                        ? 'text-[var(--color-error)]'
                        : tone === 'warning'
                          ? 'text-[var(--color-warning)]'
                          : 'text-[var(--color-text-primary)]'
                    }`}
                  >
                    {pct !== null ? `${pct}%` : '—'}
                  </span>
                  {countdown && provider.providerId === primaryHighlight?.provider.providerId ? (
                    <span className="font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
                      {countdown}
                    </span>
                  ) : null}
                </span>
              )
            })
          ) : compactBalance ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-xs">
              <ModelBrandIcon providerId={compactBalance.provider.providerId} size={13} />
              <span className="font-mono text-xs tabular-nums text-[var(--color-text-primary)]">
                {compactBalance.amount}
              </span>
            </span>
          ) : (
            <span className="truncate font-mono text-xs tabular-nums text-[var(--color-text-primary)]">
              {t('usageWidget.fiveHourTokensShort', { amount: localTokensText })}
            </span>
          )}
          <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
            {localTokensText}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-0.5 border-l border-[var(--color-border)] pl-1.5">
          <IconButton
            icon={<Maximize2 size={12} strokeWidth={1.75} aria-hidden="true" />}
            label={t('usageWidget.expandCard')}
            size="2xs"
            tone="muted"
            onClick={handleToggleCompact}
          />
          <IconButton
            icon={<X size={12} strokeWidth={1.75} aria-hidden="true" />}
            label={t('common.close')}
            size="2xs"
            tone="muted"
            onClick={handleClose}
          />
        </div>
      </div>
    )
  }

  return (
    <div
      data-testid="usage-widget-window"
      className="flex h-screen w-screen flex-col overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-overlay)]"
    >
      <div
        onPointerDown={handleDragPointerDown}
        onPointerMove={handleDragPointerMove}
        onPointerUp={handleDragPointerEnd}
        onPointerCancel={handleDragPointerEnd}
        className="flex cursor-grab items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-container)] px-3 py-2 select-none active:cursor-grabbing"
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <GripVertical size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
          <span className="truncate text-xs font-semibold text-[var(--color-text-primary)]">
            {t('usageWidget.floatingTitle')}
          </span>
        </div>
        <div
          className="flex shrink-0 items-center gap-0.5"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <IconButton
            icon={preferences.floatingAlwaysOnTop
              ? <Pin size={12} strokeWidth={1.75} aria-hidden="true" />
              : <PinOff size={12} strokeWidth={1.75} aria-hidden="true" />}
            label={preferences.floatingAlwaysOnTop
              ? t('usageWidget.unpinOnTop')
              : t('usageWidget.pinOnTop')}
            size="2xs"
            tone={preferences.floatingAlwaysOnTop ? 'brand' : 'muted'}
            onClick={handleToggleAlwaysOnTop}
          />
          <IconButton
            icon={<Minimize2 size={12} strokeWidth={1.75} aria-hidden="true" />}
            label={t('usageWidget.collapseMiniBar')}
            size="2xs"
            tone="muted"
            onClick={handleToggleCompact}
          />
          <IconButton
            icon={<X size={12} strokeWidth={1.75} aria-hidden="true" />}
            label={t('common.close')}
            size="2xs"
            tone="muted"
            onClick={handleClose}
          />
        </div>
      </div>

      <UsageSummaryPanel
        summary={summary}
        preferences={preferences}
        isLoading={isLoading}
        isDesktopRuntime
        showDetachControls={false}
        onRefresh={() => void fetchSummary({ force: true })}
        onToggleDisplayMode={() => void toggleDisplayMode()}
        onToggleResetTimeFormat={() => void toggleResetTimeFormat()}
        onTogglePinMetric={(metricKey) => void togglePinMetric(metricKey)}
        onOpenSettings={handleOpenSettings}
      />
    </div>
  )
}
