import { create } from 'zustand'
import {
  desktopUiPreferencesApi,
  type DesktopUsageWidgetPreferences,
} from '../api/desktopUiPreferences'
import {
  usageSummaryApi,
  type OfficialProviderUsageSummary,
  type OfficialUsageWindow,
  type UnifiedUsageSummaryResponse,
} from '../api/usageSummary'
import { formatWalletAmount } from '../components/usage/usageFormatting'
import { getDesktopHost } from '../lib/desktopHost'

const DEFAULT_USAGE_WIDGET_PREFERENCES: DesktopUsageWidgetPreferences = {
  sidebarVisibility: 'auto',
  displayMode: 'remaining',
  showExactResetTime: false,
  floatingEnabled: false,
  floatingCompact: false,
  floatingAlwaysOnTop: true,
  menuBarEnabled: false,
  pinnedMetricKeys: ['claude-official:five_hour', 'openai-official:five_hour'],
}

export type UsageHighlightMetric = {
  provider: OfficialProviderUsageSummary
  window: OfficialUsageWindow
}

/**
 * Picks the single most informative metric for compact surfaces (sidebar capsule
 * and macOS menu bar title): lowest remaining percent among pinned or 5-hour
 * windows, falling back to any available window.
 */
export function selectPrimaryUsageHighlight(
  summary: UnifiedUsageSummaryResponse | null,
  pinnedMetricKeys: readonly string[],
): UsageHighlightMetric | null {
  if (!summary) return null
  const pinnedSet = new Set(pinnedMetricKeys)
  const candidates: UsageHighlightMetric[] = []
  for (const provider of summary.providers) {
    if (!provider.signedIn) continue
    for (const window of provider.windows) {
      if (window.remainingPercent === null && !window.unlimited) continue
      candidates.push({ provider, window })
    }
  }
  if (candidates.length === 0) return null

  // Critical low-quota windows (<= 20% left) always surface first regardless of pin state.
  const critical = candidates
    .filter((entry) => entry.window.remainingPercent !== null && entry.window.remainingPercent <= 20)
    .sort((a, b) => (a.window.remainingPercent ?? 100) - (b.window.remainingPercent ?? 100))
  if (critical[0]) return critical[0]

  const pinned = candidates.filter((entry) => pinnedSet.has(entry.window.metricKey))
  if (pinned[0]) return pinned[0]

  const fiveHour = candidates.find((entry) => entry.window.kind === 'five_hour')
  return fiveHour ?? candidates[0] ?? null
}

function buildMenuBarPayload(
  preferences: DesktopUsageWidgetPreferences,
  summary: UnifiedUsageSummaryResponse | null,
): { enabled: boolean; title?: string; tooltip?: string } {
  if (!preferences.menuBarEnabled) {
    return { enabled: false }
  }
  const highlight = selectPrimaryUsageHighlight(summary, preferences.pinnedMetricKeys)
  const tooltipParts = (summary?.providers ?? [])
    .filter((p) => p.signedIn)
    .map((p) => {
      const first = p.windows[0]
      if (first && first.remainingPercent !== null) {
        const pct = preferences.displayMode === 'used' ? `${first.usedPercent}% used` : `${first.remainingPercent}% left`
        return `${p.providerId.replace(/-official|-account/g, '')}: ${pct}`
      }
      const primaryWallet = p.balance?.normalWallets[0] ?? p.balance?.bonusWallets[0]
      if (primaryWallet) {
        return `${p.providerId.replace(/-official|-account/g, '')}: ${formatWalletAmount(primaryWallet.currency, primaryWallet.balance)}`
      }
      return null
    })
    .filter((part): part is string => part !== null)
  const tooltip = tooltipParts.length > 0 ? tooltipParts.join(' · ') : 'cc-haha Usage'

  if (!highlight || highlight.window.remainingPercent === null) {
    const balanceProvider = (summary?.providers ?? []).find(
      (p) => p.signedIn && (p.balance?.normalWallets[0] || p.balance?.bonusWallets[0]),
    )
    const primaryWallet = balanceProvider?.balance?.normalWallets[0] ?? balanceProvider?.balance?.bonusWallets[0]
    return {
      enabled: true,
      title: primaryWallet ? formatWalletAmount(primaryWallet.currency, primaryWallet.balance) : '',
      tooltip,
    }
  }
  const value = preferences.displayMode === 'used'
    ? highlight.window.usedPercent
    : highlight.window.remainingPercent
  const windowShort = highlight.window.kind === 'five_hour' || highlight.window.kind === 'spark_five_hour'
    ? '5h'
    : '7d'
  const title = value !== null ? `${windowShort} ${value}%` : ''
  return {
    enabled: true,
    title,
    tooltip,
  }
}

type UsageSummaryState = {
  summary: UnifiedUsageSummaryResponse | null
  preferences: DesktopUsageWidgetPreferences
  preferencesLoaded: boolean
  isLoading: boolean
  error: string | null
  popoverOpen: boolean
  floatingVisible: boolean
  hydratePreferences: (prefs?: DesktopUsageWidgetPreferences | null) => Promise<void>
  fetchSummary: (options?: { force?: boolean }) => Promise<UnifiedUsageSummaryResponse | null>
  updatePreferences: (
    patch: Partial<DesktopUsageWidgetPreferences>,
    options?: { skipWindowSync?: boolean },
  ) => Promise<void>
  setPopoverOpen: (open: boolean) => void
  setFloatingVisible: (visible: boolean) => void
  handleExternalVisibilityChange: (visible: boolean) => void
  toggleDisplayMode: () => Promise<void>
  toggleResetTimeFormat: () => Promise<void>
  togglePinMetric: (metricKey: string) => Promise<void>
  openFloatingWidget: (options?: { compact?: boolean }) => Promise<void>
  snapFloatingToTop: () => Promise<void>
  hideFloatingWidget: () => Promise<void>
}

let inFlightSummaryRequest: Promise<UnifiedUsageSummaryResponse | null> | null = null

export const useUsageSummaryStore = create<UsageSummaryState>((set, get) => ({
  summary: null,
  preferences: {
    ...DEFAULT_USAGE_WIDGET_PREFERENCES,
    pinnedMetricKeys: [...DEFAULT_USAGE_WIDGET_PREFERENCES.pinnedMetricKeys],
  },
  preferencesLoaded: false,
  isLoading: false,
  error: null,
  popoverOpen: false,
  floatingVisible: false,

  async hydratePreferences(prefs) {
    if (prefs) {
      set({ preferences: prefs, preferencesLoaded: true })
      const host = getDesktopHost()
      if (host.isDesktop && host.usageWidget) {
        void host.usageWidget.syncMenuBar(buildMenuBarPayload(prefs, get().summary)).catch(() => {})
      }
      return
    }
    try {
      const response = await desktopUiPreferencesApi.getUsageWidgetPreferences()
      set({ preferences: response.usageWidget, preferencesLoaded: true })
      const host = getDesktopHost()
      if (host.isDesktop && host.usageWidget) {
        void host.usageWidget.syncMenuBar(buildMenuBarPayload(response.usageWidget, get().summary)).catch(() => {})
      }
    } catch {
      set({ preferencesLoaded: true })
    }
  },

  async fetchSummary(options) {
    const force = options?.force === true
    if (inFlightSummaryRequest && !force) {
      return inFlightSummaryRequest
    }
    set({ isLoading: true, error: null })
    const request = usageSummaryApi.getSummary({ force })
      .then((summary) => {
        set({ summary, isLoading: false, error: null })
        const host = getDesktopHost()
        if (host.isDesktop && host.usageWidget) {
          void host.usageWidget.syncMenuBar(buildMenuBarPayload(get().preferences, summary)).catch(() => {})
        }
        return summary
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        set({ isLoading: false, error: message })
        return null
      })
      .finally(() => {
        if (inFlightSummaryRequest === request) {
          inFlightSummaryRequest = null
        }
      })

    inFlightSummaryRequest = request
    return request
  },

  async updatePreferences(patch, options) {
    const previous = get().preferences
    const optimistic: DesktopUsageWidgetPreferences = { ...previous, ...patch }
    set({ preferences: optimistic })

    const host = getDesktopHost()
    if (host.isDesktop && host.usageWidget) {
      if (patch.menuBarEnabled !== undefined || patch.displayMode !== undefined || patch.pinnedMetricKeys !== undefined) {
        void host.usageWidget.syncMenuBar(buildMenuBarPayload(optimistic, get().summary)).catch(() => {})
      }
      if (!options?.skipWindowSync) {
        if (patch.floatingEnabled === true) {
          void host.usageWidget.show({
            compact: optimistic.floatingCompact,
            alwaysOnTop: optimistic.floatingAlwaysOnTop,
          }).then(() => set({ floatingVisible: true })).catch(() => {})
        } else if (patch.floatingEnabled === false) {
          void host.usageWidget.hide().then(() => set({ floatingVisible: false })).catch(() => {})
        }
        if (patch.floatingCompact !== undefined && patch.floatingEnabled === undefined && get().floatingVisible) {
          void host.usageWidget.setCompact(patch.floatingCompact).catch(() => {})
        }
        if (patch.floatingAlwaysOnTop !== undefined && patch.floatingEnabled === undefined && get().floatingVisible) {
          void host.usageWidget.setAlwaysOnTop(patch.floatingAlwaysOnTop).catch(() => {})
        }
      }
    }

    try {
      const response = await desktopUiPreferencesApi.updateUsageWidgetPreferences(patch)
      set({ preferences: response.usageWidget })
      if (host.isDesktop && host.usageWidget?.notifyPreferencesChanged) {
        void host.usageWidget.notifyPreferencesChanged().catch(() => {})
      }
    } catch {
      set({ preferences: previous })
    }
  },

  setPopoverOpen(open) {
    set({ popoverOpen: open })
  },

  setFloatingVisible(visible) {
    set({ floatingVisible: visible })
  },

  handleExternalVisibilityChange(visible) {
    set({ floatingVisible: visible })
    const state = get()
    if (state.preferencesLoaded && state.preferences.floatingEnabled !== visible) {
      void state.updatePreferences({ floatingEnabled: visible }, { skipWindowSync: true })
    }
  },

  async toggleDisplayMode() {
    const next = get().preferences.displayMode === 'remaining' ? 'used' : 'remaining'
    await get().updatePreferences({ displayMode: next })
  },

  async toggleResetTimeFormat() {
    await get().updatePreferences({ showExactResetTime: !get().preferences.showExactResetTime })
  },

  async togglePinMetric(metricKey) {
    const current = get().preferences.pinnedMetricKeys
    const next = current.includes(metricKey)
      ? current.filter((item) => item !== metricKey)
      : [...current, metricKey]
    await get().updatePreferences({ pinnedMetricKeys: next })
  },

  async openFloatingWidget(options) {
    const compact = options?.compact ?? get().preferences.floatingCompact
    set({ popoverOpen: false, floatingVisible: true })
    const host = getDesktopHost()
    if (host.isDesktop && host.usageWidget) {
      await host.usageWidget.show({
        compact,
        alwaysOnTop: get().preferences.floatingAlwaysOnTop,
      }).catch(() => {})
    }
    await get().updatePreferences(
      { floatingEnabled: true, floatingCompact: compact },
      { skipWindowSync: true },
    )
  },

  async snapFloatingToTop() {
    set({ popoverOpen: false, floatingVisible: true })
    const host = getDesktopHost()
    if (host.isDesktop && host.usageWidget) {
      await host.usageWidget.snapToTop().catch(() => {})
    }
    await get().updatePreferences(
      {
        floatingEnabled: true,
        floatingCompact: true,
        floatingAlwaysOnTop: true,
      },
      { skipWindowSync: true },
    )
  },

  async hideFloatingWidget() {
    set({ floatingVisible: false })
    const host = getDesktopHost()
    if (host.isDesktop && host.usageWidget) {
      await host.usageWidget.hide().catch(() => {})
    }
    await get().updatePreferences({ floatingEnabled: false }, { skipWindowSync: true })
  },
}))
