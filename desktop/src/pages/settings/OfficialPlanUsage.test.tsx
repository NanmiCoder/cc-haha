import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'

const { planUsageMock, statusMock } = vi.hoisted(() => ({ planUsageMock: vi.fn(), statusMock: vi.fn() }))
vi.mock('../../api/hahaOAuth', () => ({ hahaOAuthApi: { planUsage: planUsageMock, status: statusMock } }))
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

const providerState = useProviderStore.getState()
const oauthState = useHahaOAuthStore.getState()
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
  statusMock.mockResolvedValue(loggedIn)
  planUsageMock.mockResolvedValue({ available: true, fetchedAt: '2026-11-11T09:00:00.000Z', usage: { five_hour: { utilization: 42, resets_at: null } } })
})
afterEach(() => {
  cleanup()
  useHahaOAuthStore.getState().stopPolling()
  useProviderStore.setState(providerState)
  useHahaOAuthStore.setState(oauthState)
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
  render(<ProviderSettings />)
  await waitFor(() => expect(statusMock).toHaveBeenCalled())
  expect(planUsageMock).not.toHaveBeenCalled()
  expect(screen.queryByRole('region', { name: 'Plan usage' })).not.toBeInTheDocument()
})

it('explains each other service capability without asserting that its official API is absent', async () => {
  render(<ProviderSettings />)
  for (const id of ['openai-official-provider', 'grok-official-provider', 'deepseek-account-provider']) {
    const card = within(await screen.findByTestId(id))
    expect(card.getByText('Quota queries for this service are not integrated yet. Check usage on its official website.')).toBeInTheDocument()
  }
})

it('keeps the desktop-only OAuth path out of remote browser settings', async () => {
  render(<ProviderSettings browserMode />)
  await screen.findByTestId('claude-official-provider')
  expect(statusMock).not.toHaveBeenCalled()
  expect(planUsageMock).not.toHaveBeenCalled()
  expect(screen.queryByText(/Quota queries for this service/)).not.toBeInTheDocument()
})
