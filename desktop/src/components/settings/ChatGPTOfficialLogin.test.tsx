import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

const {
  copyTextToClipboardMock,
  logoutMock,
  shellOpenMock,
  startMock,
  statusMock,
} = vi.hoisted(() => ({
  copyTextToClipboardMock: vi.fn(),
  logoutMock: vi.fn(),
  shellOpenMock: vi.fn(),
  startMock: vi.fn(),
  statusMock: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-shell', () => ({
  open: shellOpenMock,
}))

vi.mock('../../api/hahaOpenAIOAuth', () => ({
  hahaOpenAIOAuthApi: {
    start: startMock,
    status: statusMock,
    logout: logoutMock,
  },
}))

vi.mock('@/lib/clipboard', () => ({
  copyTextToClipboard: copyTextToClipboardMock,
}))

import { ChatGPTOfficialLogin } from './ChatGPTOfficialLogin'
import { useHahaOpenAIOAuthStore } from '../../stores/hahaOpenAIOAuthStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { browserHost } from '../../lib/desktopHost/browserHost'

const initialOAuthState = useHahaOpenAIOAuthStore.getState()

describe('ChatGPTOfficialLogin', () => {
  beforeEach(() => {
    vi.useRealTimers()
    startMock.mockReset()
    statusMock.mockReset()
    logoutMock.mockReset()
    shellOpenMock.mockReset()
    copyTextToClipboardMock.mockReset()
    Reflect.deleteProperty(window, 'desktopHost')
    useSettingsStore.setState({ locale: 'en' })
    useHahaOpenAIOAuthStore.setState({
      ...initialOAuthState,
      status: null,
      isPolling: false,
      isLoading: false,
      error: null,
    })
  })

  afterEach(() => {
    act(() => {
      useHahaOpenAIOAuthStore.getState().stopPolling()
      useHahaOpenAIOAuthStore.setState(initialOAuthState)
    })
    vi.useRealTimers()
    cleanup()
    vi.restoreAllMocks()
  })

  it('keeps an actionable authorization link when shell open fails', async () => {
    const authorizeUrl = 'https://chatgpt.com/oauth/authorize?state=openai-state'
    const hostOpen = vi.fn().mockRejectedValue(new Error('shell unavailable'))
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: {
        ...browserHost.capabilities,
        shell: true,
      },
      shell: {
        ...browserHost.shell,
        open: hostOpen,
      },
    }
    statusMock.mockResolvedValue({ loggedIn: false })
    startMock.mockResolvedValue({ authorizeUrl, state: 'openai-state' })
    copyTextToClipboardMock.mockResolvedValue(true)
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(<ChatGPTOfficialLogin />)

    await screen.findByRole('button', { name: 'Sign in with ChatGPT' })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'I understand, continue' }))
    })

    expect(hostOpen).toHaveBeenCalledWith(authorizeUrl)
    expect(shellOpenMock).not.toHaveBeenCalled()
    expect(consoleErrorSpy).toHaveBeenCalledWith('[ChatGPTOfficialLogin] shellOpen failed:', expect.any(Error))
    expect(screen.getByText(/Unable to open browser/)).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy authorization link' }))
    })

    expect(copyTextToClipboardMock).toHaveBeenCalledWith(authorizeUrl)
    expect(useHahaOpenAIOAuthStore.getState().error).toBeNull()
    expect(useHahaOpenAIOAuthStore.getState().isPolling).toBe(true)
    expect(screen.queryByText(/Unable to open browser/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy authorization link' })).not.toBeInTheDocument()
  })

  it('keeps the authorization link available when copy fails', async () => {
    const authorizeUrl = 'https://chatgpt.com/oauth/authorize?state=openai-state'
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: {
        ...browserHost.capabilities,
        shell: true,
      },
      shell: {
        ...browserHost.shell,
        open: vi.fn().mockRejectedValue(new Error('shell unavailable')),
      },
    }
    statusMock.mockResolvedValue({ loggedIn: false })
    startMock.mockResolvedValue({ authorizeUrl, state: 'openai-state' })
    shellOpenMock.mockRejectedValue(new Error('shell unavailable'))
    copyTextToClipboardMock.mockResolvedValue(false)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    render(<ChatGPTOfficialLogin />)

    await screen.findByRole('button', { name: 'Sign in with ChatGPT' })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'I understand, continue' }))
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy authorization link' }))
    })

    expect(copyTextToClipboardMock).toHaveBeenCalledWith(authorizeUrl)
    expect(useHahaOpenAIOAuthStore.getState().isPolling).toBe(false)
    expect(screen.getByText(/Unable to copy authorization link/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy authorization link' })).toBeInTheDocument()
  })

  it('asks for risk confirmation before starting login and skips it on cancel', async () => {
    const hostOpen = vi.fn().mockResolvedValue(undefined)
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: { ...browserHost.capabilities, shell: true },
      shell: { ...browserHost.shell, open: hostOpen },
    }
    statusMock.mockResolvedValue({ loggedIn: false })
    startMock.mockResolvedValue({
      authorizeUrl: 'https://chatgpt.com/oauth/authorize?state=openai-state',
      state: 'openai-state',
    })

    render(<ChatGPTOfficialLogin />)
    await screen.findByRole('button', { name: 'Sign in with ChatGPT' })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }))
    })

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Relatively low')).toBeInTheDocument()
    expect(startMock).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(startMock).not.toHaveBeenCalled()
    expect(hostOpen).not.toHaveBeenCalled()
  })

  it('shows a refresh failure while retaining the signed-in account', async () => {
    useHahaOpenAIOAuthStore.setState({ status: {
      loggedIn: true, expiresAt: 1, email: 'user@example.com', accountId: 'acct_123',
    } })
    statusMock.mockRejectedValue(new Error('Unable to verify OpenAI sign-in status right now. Please retry.'))
    render(<ChatGPTOfficialLogin />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Please retry')
    expect(screen.getByText(/user@example.com/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in with ChatGPT' })).not.toBeInTheDocument()
  })
})
