import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

const { copyMock, logoutMock, startMock, statusMock } = vi.hoisted(() => ({
  copyMock: vi.fn(),
  logoutMock: vi.fn(),
  startMock: vi.fn(),
  statusMock: vi.fn(),
}))

vi.mock('../../api/hahaGrokOAuth', () => ({
  hahaGrokOAuthApi: {
    start: startMock,
    status: statusMock,
    logout: logoutMock,
    successUrl: () => 'http://127.0.0.1:3456/api/haha-grok-oauth/success',
  },
}))

vi.mock('../chat/clipboard', () => ({ copyTextToClipboard: copyMock }))

import { GrokOfficialLogin } from './GrokOfficialLogin'
import { useHahaGrokOAuthStore } from '../../stores/hahaGrokOAuthStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { browserHost } from '../../lib/desktopHost/browserHost'

const initialOAuthState = useHahaGrokOAuthStore.getState()

describe('GrokOfficialLogin', () => {
  beforeEach(() => {
    statusMock.mockResolvedValue({ loggedIn: false })
    startMock.mockResolvedValue({
      authorizeUrl: 'https://accounts.x.ai/oauth/authorize?state=grok-state',
      state: 'grok-state',
    })
    copyMock.mockResolvedValue(true)
    useSettingsStore.setState({ locale: 'en' })
    useHahaGrokOAuthStore.setState({
      ...initialOAuthState,
      status: null,
      isPolling: false,
      isLoading: false,
      error: null,
    })
  })

  afterEach(() => {
    useHahaGrokOAuthStore.getState().stopPolling()
    useHahaGrokOAuthStore.setState(initialOAuthState)
    Reflect.deleteProperty(window, 'desktopHost')
    cleanup()
    vi.restoreAllMocks()
  })

  it('keeps a copyable authorization link when opening the browser fails', async () => {
    const open = vi.fn().mockRejectedValue(new Error('shell unavailable'))
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: { ...browserHost.capabilities, shell: true },
      shell: { ...browserHost.shell, open },
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})

    render(<GrokOfficialLogin />)
    await screen.findByRole('button', { name: 'Sign in with Grok' })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign in with Grok' })))

    expect(open).toHaveBeenCalled()
    expect(screen.getByText(/Unable to open browser/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy authorization link' })).toBeInTheDocument()
  })

  it('opens the local success page when authorization completes', async () => {
    const open = vi.fn().mockResolvedValue(undefined)
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: { ...browserHost.capabilities, shell: true },
      shell: { ...browserHost.shell, open },
    }

    render(<GrokOfficialLogin />)
    await screen.findByRole('button', { name: 'Sign in with Grok' })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign in with Grok' })))
    expect(open).toHaveBeenCalledWith(expect.stringContaining('accounts.x.ai'))

    act(() => {
      useHahaGrokOAuthStore.setState({
        status: { loggedIn: true, expiresAt: Date.now() + 60_000, email: 'grok@example.com' },
      })
    })

    await waitFor(() => {
      expect(open).toHaveBeenCalledWith('http://127.0.0.1:3456/api/haha-grok-oauth/success')
    })
  })
})
