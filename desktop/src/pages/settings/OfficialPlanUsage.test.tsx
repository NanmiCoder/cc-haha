import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'

const { planUsageMock, statusMock, usageSummaryMock } = vi.hoisted(() => ({
  planUsageMock: vi.fn(),
  statusMock: vi.fn(),
  usageSummaryMock: vi.fn(),
}))
vi.mock('../../api/hahaOAuth', () => ({ hahaOAuthApi: { planUsage: planUsageMock, status: statusMock } }))
vi.mock('../../api/usageSummary', () => ({ usageSummaryApi: { getSummary: usageSummaryMock } }))
vi.mock('../../components/settings/ChatGPTOfficialLogin', () => ({ ChatGPTOfficialLogin: () => null }))
vi.mock('../../components/settings/GrokOfficialLogin', () => ({ GrokOfficialLogin: () => null }))
vi.mock('../../components/settings/DeepSeekAccountLogin', () => ({ DeepSeekAccountLogin: () => null }))
vi.mock('../../components/settings/OfficialProviderModelSettings', () => ({ OfficialProviderModelSettings: () => <span data-testid="official-model-settings" /> }))

import { ProviderSettings } from './ProviderSettings'
import { providersApi } from '../../api/providers'
import { useProviderStore } from '../../stores/providerStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useHahaOAuthStore } from '../../stores/hahaOAuthStore'
import { useMagpieStore } from '../../stores/magpieStore'
import { useUsageSummaryStore } from '../../stores/usageSummaryStore'

const providerState = useProviderStore.getState()
const oauthState = useHahaOAuthStore.getState()
const usageSummaryState = useUsageSummaryStore.getState()
const loggedIn = { loggedIn: true as const, expiresAt: 9999999999999, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' as const }

beforeEach(() => {
  vi.resetAllMocks()
  useSettingsStore.setState({ locale: 'en' })
  vi.spyOn(useSettingsStore.getState(), 'fetchAll').mockResolvedValue()
  vi.spyOn(useMagpieStore.getState(), 'refresh').mockResolvedValue(null)
  vi.spyOn(providersApi, 'list').mockResolvedValue({ providers: [], activeId: 'openai-official' })
  vi.spyOn(providersApi, 'getSettings').mockResolvedValue({})
  useProviderStore.setState({ providers: [], activeId: 'openai-official', providerOrder: [], hasLoadedProviders: false, isLoading: false })
  useHahaOAuthStore.setState({ ...oauthState, status: null })
  useUsageSummaryStore.setState({ ...usageSummaryState, summary: null, isLoading: false, error: null })
  statusMock.mockResolvedValue(loggedIn)
  planUsageMock.mockResolvedValue({ available: true, fetchedAt: '2026-11-11T09:00:00.000Z', usage: { five_hour: { utilization: 42, resets_at: null } } })
  usageSummaryMock.mockResolvedValue({
    fetchedAt: '2026-11-26T18:00:00.000Z',
    nextAutoRefreshAt: '2026-11-26T18:05:00.000Z',
    cacheTtlMs: 300_000,
    hasSignedInOfficial: true,
    providers: [
      {
        providerId: 'openai-official',
        signedIn: true,
        status: 'ok',
        planLabel: 'Pro',
        accountLabel: 'dev@example.com',
        fetchedAt: '2026-11-26T18:00:00.000Z',
        rateLimitedUntil: null,
        source: 'official_api',
        windows: [
          {
            id: 'five_hour',
            metricKey: 'openai-official:five_hour',
            kind: 'five_hour',
            usedPercent: 18,
            remainingPercent: 82,
            resetsAt: null,
            periodMs: 18_000_000,
          },
        ],
      },
      {
        providerId: 'grok-official',
        signedIn: true,
        status: 'ok',
        planLabel: 'SuperGrok',
        accountLabel: 'grok@example.com',
        fetchedAt: '2026-11-26T18:00:00.000Z',
        rateLimitedUntil: null,
        source: 'official_api',
        windows: [
          {
            id: 'seven_day',
            metricKey: 'grok-official:seven_day',
            kind: 'seven_day',
            usedPercent: 25,
            remainingPercent: 75,
            resetsAt: null,
            periodMs: 604_800_000,
          },
        ],
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
  })
})
afterEach(() => {
  cleanup()
  useHahaOAuthStore.getState().stopPolling()
  useProviderStore.setState(providerState)
  useHahaOAuthStore.setState(oauthState)
  useUsageSummaryStore.setState(usageSummaryState)
  vi.restoreAllMocks()
})

it('reads the signed-in nondefault Claude quota without activating it or exposing model edits', async () => {
  const activate = vi.spyOn(providersApi, 'activateOfficial')
  render(<ProviderSettings />)
  const card = within(await screen.findByTestId('claude-official-provider'))
  expect(await card.findByText(/42% used/)).toBeInTheDocument()
  fireEvent.click(card.getByRole('button', { name: 'Refresh' }))
  await waitFor(() => expect(planUsageMock).toHaveBeenCalledTimes(2))
  expect(activate).not.toHaveBeenCalled()
  expect(useProviderStore.getState().activeId).toBe('openai-official')
  expect(card.queryByTestId('official-model-settings')).not.toBeInTheDocument()
  expect(card.queryByRole('button', { name: /sign out|log out/i })).not.toBeInTheDocument()
})

it('does not request Claude quota when the nondefault account is not signed in', async () => {
  statusMock.mockResolvedValue({ loggedIn: false })
  usageSummaryMock.mockResolvedValue({
    fetchedAt: '2026-11-26T18:00:00.000Z',
    nextAutoRefreshAt: '2026-11-26T18:05:00.000Z',
    cacheTtlMs: 300_000,
    hasSignedInOfficial: false,
    providers: [],
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
  })
  render(<ProviderSettings />)
  await waitFor(() => expect(statusMock).toHaveBeenCalled())
  expect(planUsageMock).not.toHaveBeenCalled()
  expect(screen.queryByRole('region', { name: 'Plan usage' })).not.toBeInTheDocument()
})

it('shows live plan usage for signed-in ChatGPT and Grok while keeping DeepSeek honest', async () => {
  render(<ProviderSettings />)
  const openaiUsage = await screen.findByTestId('official-plan-usage-openai-official')
  expect(openaiUsage.className).toContain('rounded-[var(--radius-card-inner)]')
  const openaiPct = within(openaiUsage).getByText(/82% left/)
  expect(openaiPct).toBeInTheDocument()
  expect(openaiPct.className).toContain('tabular-nums')
  const grokUsage = await screen.findByTestId('official-plan-usage-grok-official')
  expect(within(grokUsage).getByText(/75% left/)).toBeInTheDocument()
  const deepseekCard = within(await screen.findByTestId('deepseek-account-provider'))
  expect(deepseekCard.getByText('Quota queries for this service are not integrated yet. Check usage on its official website.')).toBeInTheDocument()
})

it('keeps the desktop-only OAuth path out of remote browser settings', async () => {
  render(<ProviderSettings browserMode />)
  await screen.findByTestId('claude-official-provider')
  expect(statusMock).not.toHaveBeenCalled()
  expect(planUsageMock).not.toHaveBeenCalled()
  expect(screen.queryByText(/Quota queries for this service/)).not.toBeInTheDocument()
})
