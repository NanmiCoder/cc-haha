import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'

const { planUsageMock } = vi.hoisted(() => ({ planUsageMock: vi.fn() }))

vi.mock('../../api/hahaOAuth', () => ({
  hahaOAuthApi: { planUsage: planUsageMock },
}))

import { ClaudePlanUsage } from './ClaudePlanUsage'
import { useSettingsStore } from '../../stores/settingsStore'

const FETCHED_AT = '2026-11-08T12:00:00.000Z'
const FIVE_HOUR_RESET = '2026-11-08T16:30:00.000Z'
const WEEKLY_RESET = '2026-11-12T09:00:00.000Z'
const format = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))

describe('ClaudePlanUsage', () => {
  beforeEach(() => {
    planUsageMock.mockReset()
    useSettingsStore.setState({ locale: 'en' })
  })

  afterEach(() => {
    cleanup()
  })

  it('shows each limit with the share used and when it resets', async () => {
    planUsageMock.mockResolvedValue({
      available: true,
      fetchedAt: FETCHED_AT,
      usage: {
        five_hour: { utilization: 42, resets_at: FIVE_HOUR_RESET },
        seven_day: { utilization: 91.6, resets_at: WEEKLY_RESET },
        seven_day_opus: null,
      },
    })

    render(<ClaudePlanUsage />)

    const fiveHour = await screen.findByTestId('claude-plan-usage-five_hour')
    expect(fiveHour).toHaveTextContent('5-hour limit')
    expect(fiveHour).toHaveTextContent(`42% used · Resets ${format(FIVE_HOUR_RESET)}`)
    expect(within(fiveHour).getByRole('progressbar', { name: '5-hour limit 42%' })).toBeInTheDocument()
    const weekly = screen.getByTestId('claude-plan-usage-seven_day')
    expect(weekly).toHaveTextContent(`92% used · Resets ${format(WEEKLY_RESET)}`)
    expect(screen.queryByTestId('claude-plan-usage-seven_day_opus')).not.toBeInTheDocument()
    expect(screen.getByText(`Updated ${format(FETCHED_AT)}`)).toBeInTheDocument()
  })

  it('reads the usage again on Refresh', async () => {
    planUsageMock
      .mockResolvedValueOnce({ available: true, fetchedAt: FETCHED_AT, usage: { five_hour: { utilization: 10, resets_at: null } } })
      .mockResolvedValueOnce({ available: true, fetchedAt: FETCHED_AT, usage: { five_hour: { utilization: 55, resets_at: null } } })

    render(<ClaudePlanUsage />)
    expect(await screen.findByText(/10% used/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))

    expect(await screen.findByText(/55% used/)).toBeInTheDocument()
    expect(planUsageMock).toHaveBeenCalledTimes(2)
  })

  it('asks for a new login when the token cannot read usage', async () => {
    planUsageMock.mockResolvedValue({ available: false, fetchedAt: FETCHED_AT, reason: 'missing_scope' })

    render(<ClaudePlanUsage />)

    expect(await screen.findByText(/Log out and log in again/)).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('says the official endpoint failed, with its status, instead of showing numbers', async () => {
    planUsageMock.mockResolvedValue({ available: false, fetchedAt: FETCHED_AT, reason: 'request_failed', status: 503 })

    render(<ClaudePlanUsage />)

    expect(await screen.findByText('Usage is unavailable right now (HTTP 503).')).toBeInTheDocument()
  })

  it('says so when the account reports no limits', async () => {
    planUsageMock.mockResolvedValue({ available: true, fetchedAt: FETCHED_AT, usage: {} })

    render(<ClaudePlanUsage />)

    expect(await screen.findByText('The account reported no usage limits.')).toBeInTheDocument()
  })

  it('shows the usage as unavailable when the local request fails', async () => {
    planUsageMock.mockRejectedValue(new Error('network down'))

    render(<ClaudePlanUsage />)

    await waitFor(() => expect(screen.getByText('Usage is unavailable right now.')).toBeInTheDocument())
  })

  it('shows the OAuth apps weekly limit even when it is the only reported quota', async () => {
    planUsageMock.mockResolvedValue({ available: true, fetchedAt: FETCHED_AT, usage: {
      seven_day_oauth_apps: { utilization: 63, resets_at: WEEKLY_RESET },
    } })
    render(<ClaudePlanUsage />)
    const row = await screen.findByTestId('claude-plan-usage-seven_day_oauth_apps')
    expect(row).toHaveTextContent('Weekly OAuth apps limit')
    expect(row).toHaveTextContent(`63% used · Resets ${format(WEEKLY_RESET)}`)
  })

  it.each([
    { utilization: null, resets_at: null },
    { utilization: '42', resets_at: 'invalid-date' },
    { utilization: -5, resets_at: '' },
  ])('explains missing or invalid quota fields without inventing values: %j', async (window) => {
    planUsageMock.mockResolvedValue({ available: true, fetchedAt: FETCHED_AT, usage: { five_hour: window } })
    render(<ClaudePlanUsage />)
    const row = await screen.findByTestId('claude-plan-usage-five_hour')
    expect(row).toHaveTextContent('Usage unavailable')
    expect(row).toHaveTextContent('Reset time not provided')
    expect(within(row).queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('shows unlimited extra usage without fabricating a percentage or reset', async () => {
    planUsageMock.mockResolvedValue({ available: true, fetchedAt: FETCHED_AT, usage: {
      extra_usage: { is_enabled: true, monthly_limit: null, used_credits: 1234, utilization: null },
    } })
    render(<ClaudePlanUsage />)
    const row = await screen.findByTestId('claude-plan-usage-extra_usage')
    expect(row).toHaveTextContent('Unlimited')
    expect(within(row).queryByRole('progressbar')).not.toBeInTheDocument()
    expect(row).not.toHaveTextContent('Resets')
  })

  it('keeps a real zero utilization and explains an absent reset', async () => {
    planUsageMock.mockResolvedValue({ available: true, fetchedAt: FETCHED_AT, usage: {
      five_hour: { utilization: 0, resets_at: null },
      extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
    } })
    render(<ClaudePlanUsage />)
    const row = await screen.findByTestId('claude-plan-usage-five_hour')
    expect(row).toHaveTextContent('0% used · Reset time not provided')
    expect(within(row).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
    expect(screen.queryByTestId('claude-plan-usage-extra_usage')).not.toBeInTheDocument()
  })
})
