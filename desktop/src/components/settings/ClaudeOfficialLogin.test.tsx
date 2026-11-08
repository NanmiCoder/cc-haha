import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'

const { logoutMock, planUsageMock, startMock, statusMock } = vi.hoisted(() => ({
  logoutMock: vi.fn(),
  planUsageMock: vi.fn(),
  startMock: vi.fn(),
  statusMock: vi.fn(),
}))

vi.mock('../../api/hahaOAuth', () => ({
  hahaOAuthApi: {
    start: startMock,
    status: statusMock,
    logout: logoutMock,
    planUsage: planUsageMock,
  },
}))

import { ClaudeOfficialLogin } from './ClaudeOfficialLogin'
import { useHahaOAuthStore } from '../../stores/hahaOAuthStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { browserHost } from '../../lib/desktopHost/browserHost'

const initialOAuthState = useHahaOAuthStore.getState()
const authorizeUrl = 'https://claude.ai/oauth/authorize?state=claude-state'

describe('ClaudeOfficialLogin', () => {
  beforeEach(() => {
    statusMock.mockReset()
    startMock.mockReset()
    logoutMock.mockReset()
    planUsageMock.mockReset()
    statusMock.mockResolvedValue({ loggedIn: false })
    startMock.mockResolvedValue({ authorizeUrl, state: 'claude-state' })
    useSettingsStore.setState({ locale: 'en' })
    useHahaOAuthStore.setState({
      ...initialOAuthState,
      status: null,
      isPolling: false,
      isLoading: false,
      error: null,
    })
  })

  afterEach(() => {
    act(() => {
      useHahaOAuthStore.getState().stopPolling()
      useHahaOAuthStore.setState(initialOAuthState)
    })
    Reflect.deleteProperty(window, 'desktopHost')
    cleanup()
    vi.restoreAllMocks()
  })

  function installHost(open: ReturnType<typeof vi.fn>) {
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: { ...browserHost.capabilities, shell: true },
      shell: { ...browserHost.shell, open },
    }
  }

  it('asks for risk confirmation before starting the OAuth flow', async () => {
    const open = vi.fn().mockResolvedValue(undefined)
    installHost(open)

    render(<ClaudeOfficialLogin />)
    await screen.findByRole('button', { name: 'Sign in to Claude' })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Claude' }))
    })

    // Clicking login only opens the dialog; nothing may reach the server or browser yet.
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('High')).toBeInTheDocument()
    expect(startMock).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'I understand, continue' }))
    })

    expect(startMock).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(authorizeUrl)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(useHahaOAuthStore.getState().isPolling).toBe(true)
  })

  it('does not start the OAuth flow when the risk dialog is cancelled', async () => {
    const open = vi.fn().mockResolvedValue(undefined)
    installHost(open)

    render(<ClaudeOfficialLogin />)
    await screen.findByRole('button', { name: 'Sign in to Claude' })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Claude' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(startMock).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(useHahaOAuthStore.getState().isPolling).toBe(false)
    expect(screen.getByRole('button', { name: 'Sign in to Claude' })).toBeInTheDocument()
  })

  it('shows the subscription usage once the account is logged in (#1804)', async () => {
    statusMock.mockResolvedValue({ loggedIn: true, expiresAt: null, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' })
    planUsageMock.mockResolvedValue({
      available: true,
      fetchedAt: '2026-11-08T12:00:00.000Z',
      usage: { five_hour: { utilization: 30, resets_at: null }, seven_day: { utilization: 5, resets_at: null } },
    })

    render(<ClaudeOfficialLogin />)

    const section = await screen.findByRole('region', { name: 'Plan usage' })
    expect(await within(section).findByText('30% used')).toBeInTheDocument()
    expect(within(section).getByText('5% used')).toBeInTheDocument()
    expect(planUsageMock).toHaveBeenCalledTimes(1)
  })

  it('does not ask for usage while logged out', async () => {
    render(<ClaudeOfficialLogin />)
    await screen.findByRole('button', { name: 'Sign in to Claude' })

    expect(screen.queryByRole('region', { name: 'Plan usage' })).not.toBeInTheDocument()
    expect(planUsageMock).not.toHaveBeenCalled()
  })
})
