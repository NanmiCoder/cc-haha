import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

const {
  getSummaryMock,
  getPrefsMock,
  updatePrefsMock,
  initServerUrlMock,
  showMock,
  hideMock,
  toggleMock,
  setCompactMock,
  setAlwaysOnTopMock,
  snapToTopMock,
  dragWindowMock,
  syncMenuBarMock,
  focusMainWindowMock,
  openSettingsMock,
  notifyPrefsMock,
  onVisibilityChangedMock,
  onPreferencesChangedMock,
  prefsChangedListeners,
} = vi.hoisted(() => {
  const listeners: Array<() => void> = []
  return {
    getSummaryMock: vi.fn(),
    getPrefsMock: vi.fn(),
    updatePrefsMock: vi.fn(),
    initServerUrlMock: vi.fn(async () => 'http://127.0.0.1:3456'),
    showMock: vi.fn(async () => {}),
    hideMock: vi.fn(async () => {}),
    toggleMock: vi.fn(async () => true),
    setCompactMock: vi.fn(async (compact: boolean) => ({ compact, alwaysOnTop: true, snappedTop: false })),
    setAlwaysOnTopMock: vi.fn(async (alwaysOnTop: boolean) => ({ compact: false, alwaysOnTop, snappedTop: false })),
    snapToTopMock: vi.fn(async () => ({ compact: true, alwaysOnTop: true, snappedTop: true })),
    dragWindowMock: vi.fn(async () => ({ compact: false, alwaysOnTop: true, snappedTop: false })),
    syncMenuBarMock: vi.fn(async () => {}),
    focusMainWindowMock: vi.fn(async () => {}),
    openSettingsMock: vi.fn(async () => {}),
    notifyPrefsMock: vi.fn(async () => {}),
    onVisibilityChangedMock: vi.fn(async () => () => {}),
    onPreferencesChangedMock: vi.fn(async (handler: () => void) => {
      listeners.push(handler)
      return () => {
        const index = listeners.indexOf(handler)
        if (index >= 0) listeners.splice(index, 1)
      }
    }),
    prefsChangedListeners: listeners,
  }
})

vi.mock('@/api/usageSummary', () => ({
  usageSummaryApi: { getSummary: getSummaryMock },
}))

vi.mock('@/api/desktopUiPreferences', async () => {
  const actual = await vi.importActual<typeof import('@/api/desktopUiPreferences')>('@/api/desktopUiPreferences')
  return {
    ...actual,
    desktopUiPreferencesApi: {
      ...actual.desktopUiPreferencesApi,
      getUsageWidgetPreferences: getPrefsMock,
      updateUsageWidgetPreferences: updatePrefsMock,
    },
  }
})

vi.mock('@/lib/desktopRuntime', () => ({
  initializeDesktopServerUrl: initServerUrlMock,
  isDesktopRuntime: () => true,
}))

vi.mock('@/lib/desktopHost', () => ({
  getDesktopHost: () => ({
    isDesktop: true,
    usageWidget: {
      show: showMock,
      hide: hideMock,
      toggle: toggleMock,
      setCompact: setCompactMock,
      setAlwaysOnTop: setAlwaysOnTopMock,
      snapToTop: snapToTopMock,
      dragWindow: dragWindowMock,
      syncMenuBar: syncMenuBarMock,
      focusMainWindow: focusMainWindowMock,
      openSettings: openSettingsMock,
      notifyPreferencesChanged: notifyPrefsMock,
      onVisibilityChanged: onVisibilityChangedMock,
      onPreferencesChanged: onPreferencesChangedMock,
    },
  }),
}))

import { UsageWidgetApp } from './UsageWidgetApp'
import { UsageSummaryPanel } from './UsageSummaryPanel'
import {
  computePaceMarkerPercent,
  displayPercentForWindow,
  formatCentsAsDollars,
  formatCompactTokenCount,
  formatExactResetTime,
  formatResetCountdown,
  formatWalletAmount,
  providerTitleKey,
  toneForRemainingPercent,
  windowLabelKey,
} from './usageFormatting'
import { DEFAULT_DESKTOP_USAGE_WIDGET_PREFERENCES } from '@/api/desktopUiPreferences'
import {
  selectPrimaryUsageHighlight,
  useUsageSummaryStore,
} from '@/stores/usageSummaryStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { browserHost } from '@/lib/desktopHost/browserHost'
import type { UnifiedUsageSummaryResponse } from '@/api/usageSummary'

const RICH_SUMMARY: UnifiedUsageSummaryResponse = {
  fetchedAt: '2026-11-26T18:00:00.000Z',
  nextAutoRefreshAt: '2026-11-26T18:05:00.000Z',
  cacheTtlMs: 300_000,
  hasSignedInOfficial: true,
  providers: [
    {
      providerId: 'claude-official',
      signedIn: true,
      status: 'ok',
      planLabel: 'Max',
      accountLabel: null,
      fetchedAt: '2026-11-26T18:00:00.000Z',
      rateLimitedUntil: null,
      source: 'official_api',
      windows: [
        {
          id: 'five_hour',
          metricKey: 'claude-official:five_hour',
          kind: 'five_hour',
          usedPercent: 38,
          remainingPercent: 62,
          resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
          periodMs: 5 * 3600_000,
        },
        {
          id: 'seven_day',
          metricKey: 'claude-official:seven_day',
          kind: 'seven_day',
          usedPercent: 88,
          remainingPercent: 12,
          resetsAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
          periodMs: 7 * 24 * 3600_000,
        },
        {
          id: 'extra_usage',
          metricKey: 'claude-official:extra_usage',
          kind: 'extra_usage',
          usedPercent: null,
          remainingPercent: null,
          resetsAt: null,
          periodMs: null,
          unlimited: true,
        },
      ],
    },
    {
      providerId: 'openai-official',
      signedIn: true,
      status: 'rate_limited',
      planLabel: 'Pro',
      accountLabel: 'dev@example.com',
      fetchedAt: '2026-11-26T18:00:00.000Z',
      rateLimitedUntil: '2026-11-26T18:10:00.000Z',
      source: 'official_api',
      windows: [
        {
          id: 'five_hour',
          metricKey: 'openai-official:five_hour',
          kind: 'five_hour',
          usedPercent: 75,
          remainingPercent: 25,
          resetsAt: new Date(Date.now() + 90 * 60_000).toISOString(),
          periodMs: 5 * 3600_000,
        },
      ],
    },
    {
      providerId: 'grok-official',
      signedIn: true,
      status: 'unavailable',
      planLabel: 'SuperGrok',
      accountLabel: 'grok@example.com',
      fetchedAt: '2026-11-26T18:00:00.000Z',
      rateLimitedUntil: null,
      source: 'official_api',
      windows: [],
    },
    {
      providerId: 'deepseek-account',
      signedIn: true,
      status: 'ok',
      planLabel: null,
      accountLabel: 'ds@example.com',
      fetchedAt: '2026-11-26T18:00:00.000Z',
      rateLimitedUntil: null,
      source: 'official_api',
      windows: [],
      balance: {
        normalWallets: [{ currency: 'CNY', balance: '88.50' }],
        bonusWallets: [{ currency: 'CNY', balance: '10.00' }],
      },
    },
  ],
  localWindow: {
    windowHours: 5,
    since: '2026-11-26T13:00:00.000Z',
    until: '2026-11-26T18:00:00.000Z',
    totalTokens: 1_500_000,
    inputTokens: 1_000_000,
    outputTokens: 200_000,
    cacheReadTokens: 300_000,
    cacheCreationTokens: 0,
    turnCount: 12,
    sessionCount: 3,
    byModel: [],
  },
}

const EMPTY_SUMMARY: UnifiedUsageSummaryResponse = {
  ...RICH_SUMMARY,
  hasSignedInOfficial: false,
  providers: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  prefsChangedListeners.splice(0)
  useSettingsStore.setState({ locale: 'en' })
  useUsageSummaryStore.setState({
    summary: null,
    preferences: {
      ...DEFAULT_DESKTOP_USAGE_WIDGET_PREFERENCES,
      pinnedMetricKeys: [...DEFAULT_DESKTOP_USAGE_WIDGET_PREFERENCES.pinnedMetricKeys],
    },
    preferencesLoaded: false,
    isLoading: false,
    error: null,
    popoverOpen: false,
    floatingVisible: false,
  })
  getSummaryMock.mockResolvedValue(RICH_SUMMARY)
  getPrefsMock.mockResolvedValue({
    exists: true,
    usageWidget: { ...DEFAULT_DESKTOP_USAGE_WIDGET_PREFERENCES },
  })
  updatePrefsMock.mockImplementation(async (patch) => ({
    ok: true,
    usageWidget: { ...useUsageSummaryStore.getState().preferences, ...patch },
  }))
})

afterEach(() => {
  cleanup()
})

describe('UsageWidgetApp', () => {
  it('renders full floating card, handles drag, pin-on-top, collapse, close, settings, and cross-window sync', async () => {
    render(<UsageWidgetApp />)

    const win = await screen.findByTestId('usage-widget-window')
    expect(win).toBeInTheDocument()
    await waitFor(() => expect(getSummaryMock).toHaveBeenCalledTimes(1))

    // Running-out section renders the unpinned low-quota Claude 7d window and DeepSeek balance row.
    expect(screen.getByText('Running low')).toBeInTheDocument()
    expect(screen.getByText('12% left')).toBeInTheDocument()
    expect(screen.getByTestId('usage-priority-balance-deepseek-account')).toHaveTextContent('¥88.50')

    // Drag header triggers start -> move -> end IPC calls.
    const dragHeader = screen.getByText('Usage monitor').closest('div')!.parentElement!
    dragHeader.setPointerCapture = vi.fn()
    dragHeader.hasPointerCapture = vi.fn(() => true)
    dragHeader.releasePointerCapture = vi.fn()
    const makePointerEvent = (type: string, screenX: number, screenY: number) => {
      const ev = new MouseEvent(type, { bubbles: true, button: 0, screenX, screenY })
      Object.defineProperty(ev, 'pointerId', { value: 1 })
      return ev
    }
    fireEvent(dragHeader, makePointerEvent('pointerdown', 100, 50))
    fireEvent(dragHeader, makePointerEvent('pointermove', 140, 60))
    fireEvent(dragHeader, makePointerEvent('pointerup', 140, 60))
    expect(dragWindowMock).toHaveBeenCalledWith({ phase: 'start', x: 100, y: 50 })
    expect(dragWindowMock).toHaveBeenCalledWith({ phase: 'move', x: 140, y: 60 })
    expect(dragWindowMock).toHaveBeenCalledWith({ phase: 'end', x: 140, y: 60 })

    // Toggle always-on-top.
    fireEvent.click(screen.getByRole('button', { name: 'Allow other windows above' }))
    await waitFor(() => expect(setAlwaysOnTopMock).toHaveBeenCalledWith(false))
    expect(updatePrefsMock).toHaveBeenCalledWith({ floatingAlwaysOnTop: false })

    // Open settings navigates directly to providers tab.
    fireEvent.click(screen.getByRole('button', { name: 'Usage settings' }))
    expect(openSettingsMock).toHaveBeenCalledWith('providers')

    // Switch to All tab to exercise all provider status cards, pace markers, and pin toggle.
    fireEvent.click(screen.getByRole('tab', { name: /All/ }))
    expect(screen.getByTestId('usage-provider-card-claude-official')).toBeInTheDocument()
    expect(screen.getByTestId('usage-provider-card-openai-official')).toBeInTheDocument()
    expect(screen.getByTestId('usage-provider-card-grok-official')).toBeInTheDocument()
    expect(screen.getByTestId('usage-provider-card-deepseek-account')).toBeInTheDocument()
    expect(screen.getByText('Unlimited')).toBeInTheDocument()

    // Toggle pin on an unpinned metric and toggle reset time format.
    fireEvent.click(screen.getAllByRole('button', { name: 'Pin metric' })[0]!)
    await waitFor(() => expect(updatePrefsMock).toHaveBeenCalledWith(
      expect.objectContaining({ pinnedMetricKeys: expect.arrayContaining(['claude-official:seven_day']) }),
    ))
    fireEvent.click(screen.getAllByTitle('Click to switch between countdown and exact time')[0]!)
    await waitFor(() => expect(updatePrefsMock).toHaveBeenCalledWith({ showExactResetTime: true }))

    // Collapse to top mini bar sets floatingCompact + floatingAlwaysOnTop.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse to top mini bar' }))
    await waitFor(() => expect(snapToTopMock).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId('usage-widget-compact')).toBeInTheDocument()

    // Expand back to card.
    fireEvent.click(screen.getByRole('button', { name: 'Expand usage card' }))
    await waitFor(() => expect(setCompactMock).toHaveBeenCalledWith(false))

    // Cross-window preference broadcast triggers re-hydration.
    act(() => {
      for (const listener of prefsChangedListeners) listener()
    })
    await waitFor(() => expect(getPrefsMock).toHaveBeenCalledTimes(2))

    // Close hides window and persists floatingEnabled: false without duplicate hide calls.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(hideMock).toHaveBeenCalledTimes(1))
    expect(updatePrefsMock).toHaveBeenCalledWith({ floatingEnabled: false })
  })

  it('renders compact mini bar fallback when no official subscriptions are signed in', async () => {
    getSummaryMock.mockResolvedValue(EMPTY_SUMMARY)
    getPrefsMock.mockResolvedValue({
      exists: true,
      usageWidget: { ...DEFAULT_DESKTOP_USAGE_WIDGET_PREFERENCES, floatingCompact: true },
    })

    render(<UsageWidgetApp />)
    const compact = await screen.findByTestId('usage-widget-compact')
    expect(compact).toHaveTextContent('5h 1.50M')
  })

  it('renders UsageSummaryPanel empty state and missing_scope status', () => {
    const onOpenSettings = vi.fn()
    const { rerender } = render(
      <UsageSummaryPanel
        summary={EMPTY_SUMMARY}
        preferences={DEFAULT_DESKTOP_USAGE_WIDGET_PREFERENCES}
        isLoading={false}
        isDesktopRuntime
        onRefresh={vi.fn()}
        onToggleDisplayMode={vi.fn()}
        onToggleResetTimeFormat={vi.fn()}
        onTogglePinMetric={vi.fn()}
        onOpenSettings={onOpenSettings}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open Model Settings' }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)

    rerender(
      <UsageSummaryPanel
        summary={{
          ...EMPTY_SUMMARY,
          hasSignedInOfficial: true,
          providers: [
            {
              providerId: 'claude-official',
              signedIn: true,
              status: 'missing_scope',
              planLabel: 'Pro',
              accountLabel: null,
              fetchedAt: null,
              rateLimitedUntil: null,
              source: 'official_api',
              windows: [],
            },
          ],
        }}
        preferences={DEFAULT_DESKTOP_USAGE_WIDGET_PREFERENCES}
        isLoading={false}
        isDesktopRuntime
        onRefresh={vi.fn()}
        onToggleDisplayMode={vi.fn()}
        onToggleResetTimeFormat={vi.fn()}
        onTogglePinMetric={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('tab', { name: /All/ }))
    expect(screen.getByTestId('usage-provider-card-claude-official')).toBeInTheDocument()
  })
})

describe('usageFormatting, usageSummaryStore, and browserHost', () => {
  it('formats all provider keys, window keys, countdowns, token counts, and pace markers', () => {
    expect(providerTitleKey('claude-official')).toBe('settings.providers.officialName')
    expect(providerTitleKey('openai-official')).toBe('settings.providers.openaiOfficialName')
    expect(providerTitleKey('grok-official')).toBe('settings.providers.grokOfficialName')
    expect(providerTitleKey('deepseek-account')).toBe('settings.providers.deepseekAccountName')

    for (const kind of [
      'five_hour',
      'seven_day',
      'seven_day_sonnet',
      'seven_day_opus',
      'seven_day_oauth_apps',
      'spark_five_hour',
      'spark_seven_day',
      'extra_usage',
    ] as const) {
      expect(windowLabelKey(kind)).toContain('usageWidget.window')
    }

    expect(toneForRemainingPercent(null)).toBe('brand')
    expect(toneForRemainingPercent(10)).toBe('danger')
    expect(toneForRemainingPercent(25)).toBe('warning')
    expect(toneForRemainingPercent(80)).toBe('success')

    const sampleWindow = RICH_SUMMARY.providers[0]!.windows[0]!
    expect(displayPercentForWindow(sampleWindow, 'remaining')).toBe(62)
    expect(displayPercentForWindow(sampleWindow, 'used')).toBe(38)
    expect(displayPercentForWindow({ ...sampleWindow, unlimited: true }, 'remaining')).toBeNull()

    const now = Date.parse('2026-11-26T18:00:00.000Z')
    expect(formatResetCountdown(null, now)).toBeNull()
    expect(formatResetCountdown('not-a-date', now)).toBeNull()
    expect(formatResetCountdown('2026-11-26T17:00:00.000Z', now)).toBe('0m')
    expect(formatResetCountdown('2026-11-26T18:25:00.000Z', now)).toBe('25m')
    expect(formatResetCountdown('2026-11-26T20:00:00.000Z', now)).toBe('2h')
    expect(formatResetCountdown('2026-11-26T20:15:00.000Z', now)).toBe('2h 15m')
    expect(formatResetCountdown('2026-11-28T18:00:00.000Z', now)).toBe('2d')
    expect(formatResetCountdown('2026-11-28T21:00:00.000Z', now)).toBe('2d 3h')

    expect(formatExactResetTime(null)).toBeNull()
    expect(formatExactResetTime('bad')).toBeNull()
    expect(formatExactResetTime('2026-11-26T20:00:00.000Z')).toBeTruthy()

    expect(formatCompactTokenCount(0)).toBe('0')
    expect(formatCompactTokenCount(850)).toBe('850')
    expect(formatCompactTokenCount(12_400)).toBe('12K')
    expect(formatCompactTokenCount(2_500_000)).toBe('2.50M')
    expect(formatCompactTokenCount(1_250_000_000)).toBe('1.25B')

    expect(formatWalletAmount('CNY', '0E-16')).toBe('¥0.00')
    expect(formatWalletAmount('CNY', '123.45')).toBe('¥123.45')
    expect(formatWalletAmount('USD', '6.7')).toBe('$6.70')
    expect(formatCentsAsDollars(5000)).toBe('$50')
    expect(formatCentsAsDollars(2550)).toBe('$25.50')

    expect(computePaceMarkerPercent({ ...sampleWindow, resetsAt: null }, 'remaining', now)).toBeNull()
    expect(computePaceMarkerPercent({ ...sampleWindow, resetsAt: 'bad' }, 'remaining', now)).toBeNull()
    expect(computePaceMarkerPercent({
      ...sampleWindow,
      resetsAt: '2026-11-26T20:30:00.000Z',
      periodMs: 5 * 3600_000,
    }, 'remaining', now)).toBe(50)
    expect(computePaceMarkerPercent({
      ...sampleWindow,
      resetsAt: '2026-11-26T20:30:00.000Z',
      periodMs: 5 * 3600_000,
    }, 'used', now)).toBe(50)
  })

  it('covers store floating actions, external visibility sync, highlight priority, error rollback, and browserHost fallbacks', async () => {
    expect(selectPrimaryUsageHighlight(null, [])).toBeNull()
    expect(selectPrimaryUsageHighlight(EMPTY_SUMMARY, [])).toBeNull()
    // Critical window (12% remaining) beats pinned higher-remaining windows.
    expect(selectPrimaryUsageHighlight(RICH_SUMMARY, ['claude-official:five_hour'])?.window.metricKey)
      .toBe('claude-official:seven_day')

    useUsageSummaryStore.setState({
      preferencesLoaded: true,
      preferences: {
        ...DEFAULT_DESKTOP_USAGE_WIDGET_PREFERENCES,
        menuBarEnabled: true,
        displayMode: 'used',
      },
      summary: RICH_SUMMARY,
    })

    await useUsageSummaryStore.getState().openFloatingWidget({ compact: false })
    expect(showMock).toHaveBeenCalledTimes(1)
    expect(useUsageSummaryStore.getState().floatingVisible).toBe(true)

    await useUsageSummaryStore.getState().hideFloatingWidget()
    expect(hideMock).toHaveBeenCalledTimes(1)
    expect(useUsageSummaryStore.getState().floatingVisible).toBe(false)

    useUsageSummaryStore.getState().handleExternalVisibilityChange(true)
    await waitFor(() => expect(updatePrefsMock).toHaveBeenCalledWith({ floatingEnabled: true }))

    // Fetch error populates store error cleanly.
    getSummaryMock.mockRejectedValueOnce(new Error('network offline'))
    expect(await useUsageSummaryStore.getState().fetchSummary({ force: true })).toBeNull()
    expect(useUsageSummaryStore.getState().error).toBe('network offline')

    // Preference update failure rolls back optimistic state.
    updatePrefsMock.mockRejectedValueOnce(new Error('disk full'))
    await useUsageSummaryStore.getState().updatePreferences({ displayMode: 'remaining' })
    expect(useUsageSummaryStore.getState().preferences.displayMode).toBe('used')

    // Browser host fallbacks return safe defaults or reject unsupported native window actions.
    expect(await browserHost.usageWidget!.toggle()).toBe(false)
    expect(await browserHost.usageWidget!.setCompact(true)).toEqual({ compact: false, alwaysOnTop: true, snappedTop: false })
    expect(await browserHost.usageWidget!.setAlwaysOnTop(true)).toEqual({ compact: false, alwaysOnTop: true, snappedTop: false })
    expect(await browserHost.usageWidget!.snapToTop()).toEqual({ compact: true, alwaysOnTop: true, snappedTop: true })
    expect(await browserHost.usageWidget!.dragWindow({ phase: 'end', x: 0, y: 0 })).toEqual({ compact: false, alwaysOnTop: true, snappedTop: false })
    await expect(browserHost.usageWidget!.syncMenuBar({ enabled: false })).resolves.toBeUndefined()
    await expect(browserHost.usageWidget!.notifyPreferencesChanged()).resolves.toBeUndefined()
    const unlistenVis = await browserHost.usageWidget!.onVisibilityChanged(() => {})
    const unlistenPrefs = await browserHost.usageWidget!.onPreferencesChanged(() => {})
    unlistenVis()
    unlistenPrefs()
    await expect(browserHost.usageWidget!.show()).rejects.toThrow()
    await expect(browserHost.usageWidget!.hide()).rejects.toThrow()
    await expect(browserHost.usageWidget!.focusMainWindow()).rejects.toThrow()
    await expect(browserHost.usageWidget!.openSettings()).rejects.toThrow()
  })
})
