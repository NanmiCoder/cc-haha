import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

const { copyMock, logoutMock, startMock, statusMock } = vi.hoisted(() => ({
  copyMock: vi.fn(),
  logoutMock: vi.fn(),
  startMock: vi.fn(),
  statusMock: vi.fn(),
}))

vi.mock('../../api/hahaDeepSeekOAuth', () => ({
  hahaDeepSeekOAuthApi: {
    start: startMock,
    status: statusMock,
    logout: logoutMock,
  },
}))

vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: copyMock }))

import { DeepSeekAccountLogin } from './DeepSeekAccountLogin'
import { useHahaDeepSeekOAuthStore } from '../../stores/hahaDeepSeekOAuthStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { browserHost } from '../../lib/desktopHost/browserHost'

const initialOAuthState = useHahaDeepSeekOAuthStore.getState()
const AUTHORIZE_URL = 'https://platform.deepseek.com/oauth/authorize?state=ds-state'

function installShellOpen(open: ReturnType<typeof vi.fn>) {
  window.desktopHost = {
    ...browserHost,
    kind: 'electron',
    isDesktop: true,
    capabilities: { ...browserHost.capabilities, shell: true },
    shell: { ...browserHost.shell, open },
  }
}

async function renderLogin() {
  // The component fetches the login status on mount; let that settle inside act.
  await act(async () => { render(<DeepSeekAccountLogin />) })
}

async function startLogin() {
  await screen.findByRole('button', { name: 'Sign in with DeepSeek' })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign in with DeepSeek' })))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'I understand, continue' })))
}

describe('DeepSeekAccountLogin', () => {
  beforeEach(() => {
    statusMock.mockResolvedValue({ loggedIn: false })
    startMock.mockResolvedValue({ authorizeUrl: AUTHORIZE_URL, state: 'ds-state' })
    logoutMock.mockResolvedValue({ ok: true })
    copyMock.mockResolvedValue(true)
    useSettingsStore.setState({ locale: 'en' })
    useHahaDeepSeekOAuthStore.setState({
      ...initialOAuthState,
      status: null,
      isPolling: false,
      isLoading: false,
      error: null,
    })
  })

  afterEach(() => {
    useHahaDeepSeekOAuthStore.getState().stopPolling()
    useHahaDeepSeekOAuthStore.setState(initialOAuthState)
    Reflect.deleteProperty(window, 'desktopHost')
    cleanup()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('asks for risk confirmation before starting login and starts nothing on cancel', async () => {
    const open = vi.fn().mockResolvedValue(undefined)
    installShellOpen(open)

    await renderLogin()
    await screen.findByRole('button', { name: 'Sign in with DeepSeek' })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign in with DeepSeek' })))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Medium')).toBeInTheDocument()
    expect(screen.getByText(/may violate the platform terms/)).toBeInTheDocument()
    expect(startMock).not.toHaveBeenCalled()

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(startMock).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('opens the authorization URL, polls for the login and shows the signed-in account', async () => {
    const open = vi.fn().mockResolvedValue(undefined)
    installShellOpen(open)
    await renderLogin()
    await screen.findByRole('button', { name: 'Sign in with DeepSeek' })

    // Only fake timers from here on: the initial status fetch above is a plain promise.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    statusMock.mockResolvedValue({ loggedIn: true, name: 'Ada', contact: 'a***@example.com' })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign in with DeepSeek' })))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'I understand, continue' })))

    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(AUTHORIZE_URL)
    expect(useHahaDeepSeekOAuthStore.getState().isPolling).toBe(true)

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })

    expect(screen.getByText(/Signed in as Ada · a\*\*\*@example\.com/)).toBeInTheDocument()
    expect(useHahaDeepSeekOAuthStore.getState().isPolling).toBe(false)
    // The DeepSeek platform shows its own "authorized" page, so nothing else is opened.
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('keeps a copyable authorization link when opening the browser fails, then polls after copying', async () => {
    const open = vi.fn().mockRejectedValue(new Error('shell unavailable'))
    installShellOpen(open)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await renderLogin()
    await startLogin()

    expect(open).toHaveBeenCalledWith(AUTHORIZE_URL)
    expect(screen.getByText(/Unable to open browser/)).toBeInTheDocument()
    expect(useHahaDeepSeekOAuthStore.getState().isPolling).toBe(false)

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy authorization link' })))

    expect(copyMock).toHaveBeenCalledWith(AUTHORIZE_URL)
    expect(screen.queryByRole('button', { name: 'Copy authorization link' })).not.toBeInTheDocument()
    expect(useHahaDeepSeekOAuthStore.getState().isPolling).toBe(true)
  })

  it('reports a failed clipboard write and keeps the link available', async () => {
    installShellOpen(vi.fn().mockRejectedValue(new Error('shell unavailable')))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    copyMock.mockResolvedValue(false)

    await renderLogin()
    await startLogin()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy authorization link' })))

    expect(screen.getByText(/Unable to copy authorization link/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy authorization link' })).toBeInTheDocument()
    expect(useHahaDeepSeekOAuthStore.getState().isPolling).toBe(false)
  })

  it('falls back to a generic label when the account has no name or contact, and signs out', async () => {
    statusMock.mockResolvedValue({ loggedIn: true, name: null, contact: null })

    await renderLogin()

    expect(await screen.findByText(/Signed in as DeepSeek account/)).toBeInTheDocument()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign out' })))

    await waitFor(() => expect(logoutMock).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('button', { name: 'Sign in with DeepSeek' })).toBeInTheDocument()
    expect(screen.getByTestId('deepseek-account-login')).toBeInTheDocument()
  })
})
