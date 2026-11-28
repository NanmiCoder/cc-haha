import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'

const { usageSummaryMock, getPrefsMock, updatePrefsMock, showFloatingMock } = vi.hoisted(() => ({
  usageSummaryMock: vi.fn(),
  getPrefsMock: vi.fn(),
  updatePrefsMock: vi.fn(),
  showFloatingMock: vi.fn(async () => {}),
}))

vi.mock('../../api/usageSummary', () => ({ usageSummaryApi: { getSummary: usageSummaryMock } }))
vi.mock('../../api/desktopUiPreferences', async () => {
  const actual = await vi.importActual<typeof import('../../api/desktopUiPreferences')>('../../api/desktopUiPreferences')
  return {
    ...actual,
    desktopUiPreferencesApi: {
      ...actual.desktopUiPreferencesApi,
      getUsageWidgetPreferences: getPrefsMock,
      updateUsageWidgetPreferences: updatePrefsMock,
    },
  }
})
vi.mock('../../lib/desktopRuntime', () => ({
  isDesktopRuntime: () => true,
}))
vi.mock('../../lib/desktopHost', () => ({
  getDesktopHost: () => ({
    isDesktop: true,
    usageWidget: {
      show: showFloatingMock,
      hide: vi.fn(async () => {}),
      toggle: vi.fn(async () => true),
      setCompact: vi.fn(async () => ({ compact: false, alwaysOnTop: true, snappedTop: false })),
      setAlwaysOnTop: vi.fn(async () => ({ compact: false, alwaysOnTop: true, snappedTop: false })),
      snapToTop: vi.fn(async () => ({ compact: true, alwaysOnTop: true, snappedTop: true })),
      dragWindow: vi.fn(async () => ({ compact: false, alwaysOnTop: true, snappedTop: false })),
      syncMenuBar: vi.fn(async () => {}),
      focusMainWindow: vi.fn(async () => {}),
      openSettings: vi.fn(async () => {}),
      notifyPreferencesChanged: vi.fn(async () => {}),
      onVisibilityChanged: vi.fn(async () => () => {}),
      onPreferencesChanged: vi.fn(async () => () => {}),
    },
  }),
}))
vi.mock('../../components/settings/ClaudeOfficialLogin', () => ({ ClaudeOfficialLogin: () => <div data-testid="claude-login-stub" /> }))
vi.mock('../../components/settings/ChatGPTOfficialLogin', () => ({ ChatGPTOfficialLogin: () => <div data-testid="openai-login-stub" /> }))
vi.mock('../../components/settings/GrokOfficialLogin', () => ({ GrokOfficialLogin: () => <div data-testid="grok-login-stub" /> }))
vi.mock('../../components/settings/DeepSeekAccountLogin', () => ({ DeepSeekAccountLogin: () => <div data-testid="deepseek-login-stub" /> }))
vi.mock('../../components/settings/OfficialProviderModelSettings', () => ({ OfficialProviderModelSettings: () => <span data-testid="official-model-settings" /> }))

import { ProviderSettings } from './ProviderSettings'
import { providersApi } from '../../api/providers'
import { DEFAULT_DESKTOP_USAGE_WIDGET_PREFERENCES } from '../../api/desktopUiPreferences'
import { useProviderStore } from '../../stores/providerStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useHahaOAuthStore } from '../../stores/hahaOAuthStore'
import { useMagpieStore } from '../../stores/magpieStore'
import { useUsageSummaryStore } from '../../stores/usageSummaryStore'

const providerState = useProviderStore.getState()
const oauthState = useHahaOAuthStore.getState()
const usageSummaryState = useUsageSummaryStore.getState()

const FULL_SUMMARY = {
  fetchedAt: '2026-11-26T18:00:00.000Z',
  nextAutoRefreshAt: '2026-11-26T18:05:00.000Z',
  cacheTtlMs: 300_000,
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
          usedPercent: 42,
          remainingPercent: 58,
          resetsAt: null,
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
          usedPercent: 18,
          remainingPercent: 82,
          resetsAt: null,
          periodMs: 18_000_000,
        },
      ],
    },
    {
      providerId: 'grok-official' as const,
      signedIn: true,
      status: 'ok' as const,
      planLabel: 'SuperGrok',
      accountLabel: 'grok@example.com',
      fetchedAt: '2026-11-26T18:00:00.000Z',
      rateLimitedUntil: null,
      onDemandCapCents: 5000,
      source: 'official_api' as const,
      windows: [
        {
          id: 'seven_day',
          metricKey: 'grok-official:seven_day',
          kind: 'seven_day' as const,
          usedPercent: 25,
          remainingPercent: 75,
          resetsAt: null,
          periodMs: 604_800_000,
        },
      ],
    },
    {
      providerId: 'deepseek-account' as const,
      signedIn: true,
      status: 'ok' as const,
      planLabel: null,
      accountLabel: 'ds@example.com',
      fetchedAt: '2026-11-26T18:00:00.000Z',
      rateLimitedUntil: null,
      source: 'official_api' as const,
      windows: [],
      balance: {
        normalWallets: [
          { currency: 'CNY' as const, balance: '123.45' },
          { currency: 'USD' as const, balance: '6.78' },
        ],
        bonusWallets: [{ currency: 'CNY' as const, balance: '10.00' }],
      },
    },
  ],
  localWindow: {
    windowHours: 5,
    since: '2026-11-26T13:00:00.000Z',
    until: '2026-11-26T18:00:00.000Z',
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    turnCount: 0,
    sessionCount: 0,
    byModel: [],
  },
}

beforeEach(() => {
  vi.resetAllMocks()
  useSettingsStore.setState({ locale: 'en' })
  vi.spyOn(useSettingsStore.getState(), 'fetchAll').mockResolvedValue()
  vi.spyOn(useMagpieStore.getState(), 'refresh').mockResolvedValue(null)
  vi.spyOn(providersApi, 'list').mockResolvedValue({ providers: [], activeId: 'openai-official' })
  vi.spyOn(providersApi, 'getSettings').mockResolvedValue({})
  useProviderStore.setState({ providers: [], activeId: 'openai-official', providerOrder: [], hasLoadedProviders: false, isLoading: false })
  useHahaOAuthStore.setState({ ...oauthState, status: null })
  useUsageSummaryStore.setState({
    ...usageSummaryState,
    summary: null,
    preferences: { ...DEFAULT_DESKTOP_USAGE_WIDGET_PREFERENCES },
    preferencesLoaded: true,
    isLoading: false,
    error: null,
  })
  getPrefsMock.mockResolvedValue({ exists: true, usageWidget: DEFAULT_DESKTOP_USAGE_WIDGET_PREFERENCES })
  updatePrefsMock.mockImplementation(async (patch) => ({
    ok: true,
    usageWidget: { ...useUsageSummaryStore.getState().preferences, ...patch },
  }))
  usageSummaryMock.mockResolvedValue(FULL_SUMMARY)
})

afterEach(() => {
  cleanup()
  useHahaOAuthStore.getState().stopPolling()
  useProviderStore.setState(providerState)
  useHahaOAuthStore.setState(oauthState)
  useUsageSummaryStore.setState(usageSummaryState)
  vi.restoreAllMocks()
})

it('shows unified toolbar and live usage/balances for Claude, ChatGPT, Grok, and DeepSeek in the Official tab', async () => {
  const activate = vi.spyOn(providersApi, 'activateOfficial')
  render(<ProviderSettings />)

  const toolbar = await screen.findByTestId('official-usage-toolbar')
  expect(toolbar).toBeInTheDocument()

  // Non-default signed-in Claude renders quota without activating or exposing model edits.
  const claudeCard = within(await screen.findByTestId('claude-official-provider'))
  expect(await claudeCard.findByText(/58% left/)).toBeInTheDocument()
  expect(claudeCard.queryByTestId('official-model-settings')).not.toBeInTheDocument()
  expect(activate).not.toHaveBeenCalled()

  // Active ChatGPT places quota above the model mapping section with V6C inner-card radius.
  const openaiCard = await screen.findByTestId('openai-official-provider')
  const openaiUsage = within(openaiCard).getByTestId('official-plan-usage-openai-official')
  const openaiModels = within(openaiCard).getByTestId('official-model-settings')
  expect(openaiUsage.compareDocumentPosition(openaiModels) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(openaiUsage.className).toContain('rounded-[var(--radius-card-inner)]')
  const openaiPct = within(openaiUsage).getByText(/82% left/)
  expect(openaiPct).toBeInTheDocument()
  expect(openaiPct.className).toContain('tabular-nums')

  // Grok displays weekly quota and pay-as-you-go cap.
  const grokUsage = await screen.findByTestId('official-plan-usage-grok-official')
  expect(within(grokUsage).getByText(/75% left/)).toBeInTheDocument()
  expect(within(grokUsage).getByText('$50 cap')).toBeInTheDocument()

  // DeepSeek displays recharge & bonus wallet balances instead of subscription bars.
  const deepseekUsage = await screen.findByTestId('official-plan-usage-deepseek-account')
  expect(within(deepseekUsage).getByTestId('official-balance-normal-deepseek-account')).toHaveTextContent('¥123.45 · $6.78')
  expect(within(deepseekUsage).getByTestId('official-balance-bonus-deepseek-account')).toHaveTextContent('¥10.00')

  // Toolbar controls flip display mode globally, force-refresh, and open the floating window.
  fireEvent.click(within(toolbar).getByRole('radio', { name: 'Used' }))
  await waitFor(() => expect(updatePrefsMock).toHaveBeenCalledWith({ displayMode: 'used' }))
  expect(within(claudeCard.getByTestId('official-plan-usage-claude-official')).getByText(/42% used/)).toBeInTheDocument()

  fireEvent.click(within(toolbar).getByRole('button', { name: 'Refresh' }))
  await waitFor(() => expect(usageSummaryMock).toHaveBeenCalledWith({ force: true }))

  fireEvent.click(within(toolbar).getByRole('button', { name: 'Floating window' }))
  await waitFor(() => expect(showFloatingMock).toHaveBeenCalledTimes(1))
})

it('hides usage blocks for signed-out providers and shows Grok team notice cleanly', async () => {
  usageSummaryMock.mockResolvedValue({
    ...FULL_SUMMARY,
    providers: [
      {
        providerId: 'claude-official',
        signedIn: false,
        status: 'not_logged_in',
        planLabel: null,
        accountLabel: null,
        fetchedAt: null,
        rateLimitedUntil: null,
        windows: [],
        source: 'official_api',
      },
      {
        providerId: 'grok-official',
        signedIn: true,
        status: 'local_only',
        planLabel: 'SuperGrok Business',
        accountLabel: 'team@example.com',
        fetchedAt: '2026-11-26T18:00:00.000Z',
        rateLimitedUntil: null,
        noticeCode: 'grok_team_no_personal_quota',
        windows: [],
        source: 'official_api',
      },
    ],
  })
  render(<ProviderSettings />)

  const grokUsage = await screen.findByTestId('official-plan-usage-grok-official')
  expect(within(grokUsage).getByText('Grok team accounts have no personal quota.')).toBeInTheDocument()
  expect(screen.queryByTestId('official-plan-usage-claude-official')).not.toBeInTheDocument()
  expect(screen.queryByTestId('official-plan-usage-deepseek-account')).not.toBeInTheDocument()
})

it('covers missing scope, rate limit, auth expired, reset time toggle, and unlimited usage states', async () => {
  usageSummaryMock.mockResolvedValue({
    ...FULL_SUMMARY,
    providers: [
      {
        providerId: 'claude-official',
        signedIn: true,
        status: 'missing_scope',
        planLabel: 'Max',
        accountLabel: null,
        fetchedAt: '2026-11-26T18:00:00.000Z',
        rateLimitedUntil: null,
        windows: [],
        source: 'official_api',
      },
      {
        providerId: 'openai-official',
        signedIn: true,
        status: 'rate_limited',
        planLabel: 'Pro',
        accountLabel: 'dev@example.com',
        fetchedAt: '2026-11-26T18:00:00.000Z',
        rateLimitedUntil: '2026-11-26T18:10:00.000Z',
        windows: [
          {
            id: 'five_hour',
            metricKey: 'openai-official:five_hour',
            kind: 'five_hour',
            usedPercent: 30,
            remainingPercent: 70,
            resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
            periodMs: 5 * 3600_000,
          },
          {
            id: 'extra_usage',
            metricKey: 'openai-official:extra_usage',
            kind: 'extra_usage',
            usedPercent: null,
            remainingPercent: null,
            resetsAt: null,
            periodMs: null,
            unlimited: true,
          },
        ],
        source: 'official_api',
      },
      {
        providerId: 'deepseek-account',
        signedIn: true,
        status: 'unavailable',
        planLabel: null,
        accountLabel: 'ds@example.com',
        fetchedAt: '2026-11-26T18:00:00.000Z',
        rateLimitedUntil: null,
        httpStatus: 401,
        windows: [],
        balance: null,
        source: 'official_api',
      },
    ],
  })

  render(<ProviderSettings />)

  const claudeUsage = await screen.findByTestId('official-plan-usage-claude-official')
  expect(within(claudeUsage).getByRole('alert')).toBeInTheDocument()

  const openaiUsage = await screen.findByTestId('official-plan-usage-openai-official')
  expect(within(openaiUsage).getByText('Rate-limited by provider — waiting before retrying')).toBeInTheDocument()
  expect(within(openaiUsage).getByText('Unlimited')).toBeInTheDocument()
  fireEvent.click(within(openaiUsage).getByTitle('Click to switch between countdown and exact time'))
  await waitFor(() => expect(updatePrefsMock).toHaveBeenCalledWith({ showExactResetTime: true }))
  fireEvent.click(within(openaiUsage).getByRole('button', { name: 'Refresh' }))
  await waitFor(() => expect(usageSummaryMock).toHaveBeenCalledWith({ force: true }))

  const deepseekUsage = await screen.findByTestId('official-plan-usage-deepseek-account')
  expect(within(deepseekUsage).getByText('Session expired. Please sign in again.')).toBeInTheDocument()
})

it('keeps desktop-only usage toolbar and plan usage out of remote browser settings', async () => {
  render(<ProviderSettings browserMode />)
  await screen.findByTestId('claude-official-provider')
  expect(usageSummaryMock).not.toHaveBeenCalled()
  expect(screen.queryByTestId('official-usage-toolbar')).not.toBeInTheDocument()
  expect(screen.queryByTestId('official-plan-usage-openai-official')).not.toBeInTheDocument()
})
