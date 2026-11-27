import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

const { getSummaryMock, getPrefsMock, updatePrefsMock, isDesktopMock } = vi.hoisted(() => ({
  getSummaryMock: vi.fn(),
  getPrefsMock: vi.fn(),
  updatePrefsMock: vi.fn(),
  isDesktopMock: vi.fn(() => true),
}))

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
  isDesktopRuntime: isDesktopMock,
}))

import { SidebarUsageWidget } from './SidebarUsageWidget'
import { DEFAULT_DESKTOP_USAGE_WIDGET_PREFERENCES } from '@/api/desktopUiPreferences'
import { useUsageSummaryStore } from '@/stores/usageSummaryStore'
import { useSettingsStore } from '@/stores/settingsStore'

const SIGNED_OUT_SUMMARY = {
  fetchedAt: '2026-11-26T18:00:00.000Z',
  nextAutoRefreshAt: '2026-11-26T18:05:00.000Z',
  cacheTtlMs: 300_000,
  hasSignedInOfficial: false,
  providers: [
    { providerId: 'claude-official' as const, signedIn: false, status: 'not_logged_in' as const, planLabel: null, accountLabel: null, fetchedAt: null, rateLimitedUntil: null, windows: [], source: 'official_api' as const },
  ],
  localWindow: {
    windowHours: 5,
    since: '2026-11-26T13:00:00.000Z',
    until: '2026-11-26T18:00:00.000Z',
    totalTokens: 250_000,
    inputTokens: 180_000,
    outputTokens: 40_000,
    cacheReadTokens: 30_000,
    cacheCreationTokens: 0,
    turnCount: 3,
    sessionCount: 1,
    byModel: [],
  },
}

const SIGNED_IN_SUMMARY = {
  ...SIGNED_OUT_SUMMARY,
  hasSignedInOfficial: true,
  providers: [
    {
      providerId: 'claude-official' as const,
      signedIn: true,
      status: 'ok' as const,
      planLabel: 'Max',
      accountLabel: null,
      fetchedAt: '2026-11-26T18:00:00.000Z',
      rateLimitedUntil: null,
      source: 'official_api' as const,
      windows: [
        {
          id: 'five_hour',
          metricKey: 'claude-official:five_hour',
          kind: 'five_hour' as const,
          usedPercent: 38,
          remainingPercent: 62,
          resetsAt: '2026-11-26T20:00:00.000Z',
          periodMs: 18_000_000,
        },
      ],
    },
    {
      providerId: 'openai-official' as const,
      signedIn: true,
      status: 'ok' as const,
      planLabel: 'Pro',
      accountLabel: 'dev@example.com',
      fetchedAt: '2026-11-26T18:00:00.000Z',
      rateLimitedUntil: null,
      source: 'official_api' as const,
      windows: [
        {
          id: 'five_hour',
          metricKey: 'openai-official:five_hour',
          kind: 'five_hour' as const,
          usedPercent: 12,
          remainingPercent: 88,
          resetsAt: '2026-11-26T21:30:00.000Z',
          periodMs: 18_000_000,
        },
      ],
    },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  isDesktopMock.mockReturnValue(true)
  useSettingsStore.setState({ locale: 'en' })
  useUsageSummaryStore.setState({
    summary: null,
    preferences: {
      ...DEFAULT_DESKTOP_USAGE_WIDGET_PREFERENCES,
      pinnedMetricKeys: [...DEFAULT_DESKTOP_USAGE_WIDGET_PREFERENCES.pinnedMetricKeys],
    },
    preferencesLoaded: true,
    isLoading: false,
    error: null,
    popoverOpen: false,
    floatingVisible: false,
  })
  getPrefsMock.mockResolvedValue({ exists: true, usageWidget: DEFAULT_DESKTOP_USAGE_WIDGET_PREFERENCES })
  updatePrefsMock.mockImplementation(async (patch) => ({
    ok: true,
    usageWidget: { ...useUsageSummaryStore.getState().preferences, ...patch },
  }))
})

afterEach(() => {
  cleanup()
})

describe('SidebarUsageWidget (Version A)', () => {
  it('stays completely hidden in auto mode when no official subscription is signed in (API-key-only user)', async () => {
    getSummaryMock.mockResolvedValue(SIGNED_OUT_SUMMARY)
    render(<SidebarUsageWidget collapsed={false} />)
    await waitFor(() => expect(getSummaryMock).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('sidebar-usage-widget')).not.toBeInTheDocument()
  })

  it('shows local 5-hour token burn in always mode even when no official subscription is signed in', async () => {
    getSummaryMock.mockResolvedValue(SIGNED_OUT_SUMMARY)
    useUsageSummaryStore.setState({
      preferences: { ...DEFAULT_DESKTOP_USAGE_WIDGET_PREFERENCES, sidebarVisibility: 'always' },
    })
    render(<SidebarUsageWidget collapsed={false} />)
    expect(await screen.findByTestId('sidebar-usage-trigger')).toBeInTheDocument()
    expect(screen.getByText(/250K tokens/)).toBeInTheDocument()
  })

  it('appears automatically in auto mode when an official subscription is signed in and opens the dual-tab popover', async () => {
    getSummaryMock.mockResolvedValue(SIGNED_IN_SUMMARY)
    render(<SidebarUsageWidget collapsed={false} />)

    const trigger = await screen.findByTestId('sidebar-usage-trigger')
    expect(trigger).toHaveTextContent('62% left')
    expect(trigger.className).toContain('rounded-[var(--radius-card-inner)]')
    expect(trigger.className).not.toContain('--color-border-strong')
    expect(trigger.innerHTML).not.toContain('text-[var(--color-success)]')

    fireEvent.click(trigger)
    expect(trigger.className).toContain('v6c-raised')
    const popover = await screen.findByTestId('sidebar-usage-popover')
    expect(popover).toBeInTheDocument()
    expect(popover.className).toContain('dropdown-glass')
    expect(popover.className).toContain('rounded-[var(--radius-xl)]')
    expect(popover.className).not.toContain('--color-border-strong')
    expect(popover.className).not.toContain('bg-[var(--color-surface)]')
    expect(popover.className).not.toContain('shadow-[var(--shadow-overlay)]')
    // Rendered in a portal attached directly to document.body so sidebar overflow:hidden cannot clip it.
    expect(popover.parentElement).toBe(document.body)
    expect(screen.getByTestId('sidebar-usage-widget')).not.toContainElement(popover)
    expect(screen.getByTestId('usage-priority-row-claude-official:five_hour')).toBeInTheDocument()
    expect(screen.getByTestId('usage-priority-row-openai-official:five_hour')).toBeInTheDocument()

    // Clicking the percentage flips between remaining and used mode.
    fireEvent.click(screen.getAllByText('62% left')[1]!)
    await waitFor(() => {
      expect(updatePrefsMock).toHaveBeenCalledWith({ displayMode: 'used' })
    })
  })

  it('waits for preferencesLoaded before querying summary and honors menuBarEnabled when sidebar is hidden', async () => {
    getSummaryMock.mockResolvedValue(SIGNED_IN_SUMMARY)
    getPrefsMock.mockResolvedValue({
      exists: true,
      usageWidget: {
        ...DEFAULT_DESKTOP_USAGE_WIDGET_PREFERENCES,
        sidebarVisibility: 'hidden',
        menuBarEnabled: false,
      },
    })
    useUsageSummaryStore.setState({ preferencesLoaded: false })

    const { unmount } = render(<SidebarUsageWidget collapsed={false} />)
    await waitFor(() => expect(getPrefsMock).toHaveBeenCalledTimes(1))
    expect(getSummaryMock).not.toHaveBeenCalled()
    unmount()

    // With menuBarEnabled=true, summary is still fetched even when sidebarVisibility is hidden.
    vi.clearAllMocks()
    getSummaryMock.mockResolvedValue(SIGNED_IN_SUMMARY)
    useUsageSummaryStore.setState({
      preferencesLoaded: true,
      preferences: {
        ...DEFAULT_DESKTOP_USAGE_WIDGET_PREFERENCES,
        sidebarVisibility: 'hidden',
        menuBarEnabled: true,
      },
    })
    render(<SidebarUsageWidget collapsed={false} />)
    await waitFor(() => expect(getSummaryMock).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('sidebar-usage-widget')).not.toBeInTheDocument()
  })

  it('renders collapsed ring trigger, critical alert styling, and popover action buttons', async () => {
    const criticalSummary = {
      ...SIGNED_IN_SUMMARY,
      providers: [
        {
          ...SIGNED_IN_SUMMARY.providers[0]!,
          windows: [
            {
              ...SIGNED_IN_SUMMARY.providers[0]!.windows[0]!,
              usedPercent: 90,
              remainingPercent: 10,
            },
          ],
        },
      ],
    }
    getSummaryMock.mockResolvedValue(criticalSummary)
    render(<SidebarUsageWidget collapsed />)

    const trigger = await screen.findByTestId('sidebar-usage-trigger')
    expect(trigger).toBeInTheDocument()
    expect(trigger.className).toContain('rounded-[var(--radius-control)]')
    expect(trigger.className).toContain('bg-[var(--color-error-container)]')
    expect(trigger.className).toContain('v6c-ring-error')
    fireEvent.click(trigger)
    expect(await screen.findByTestId('sidebar-usage-popover')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Refresh usage' }))
    await waitFor(() => expect(getSummaryMock).toHaveBeenCalledWith({ force: true }))

    fireEvent.click(screen.getByRole('button', { name: 'Usage settings' }))
    expect(useUsageSummaryStore.getState().popoverOpen).toBe(false)
  })
})
