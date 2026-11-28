import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import type { BrowserUseConfig, BrowserUseStatus } from '@/api/browserUse'
import { useBrowserUseStore } from '@/stores/browserUseStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { BrowserUseSettings } from './BrowserUseSettings'

const apiMock = vi.hoisted(() => ({
  getStatus: vi.fn(),
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  connectChrome: vi.fn(),
  launchManagedChrome: vi.fn(),
  disconnectChrome: vi.fn(),
  resumeTakeover: vi.fn(),
  abortTakeover: vi.fn(),
}))

vi.mock('@/api/browserUse', () => ({
  browserUseApi: apiMock,
}))

const baseConfig: BrowserUseConfig = {
  enabled: false,
  preferredTarget: 'auto',
  showCursorOverlay: true,
  autoOpenWorkspacePanel: true,
  managedChromeHeadless: false,
}

const baseStatus: BrowserUseStatus = {
  enabled: false,
  preferredTarget: 'auto',
  activeTarget: null,
  workspaceAvailable: true,
  chrome: {
    mode: 'disconnected',
    detectedBrowsers: [
      {
        id: 'chrome',
        name: 'Google Chrome',
        executablePath: '/Applications/Google Chrome.app',
        userDataDir: '/tmp/chrome',
        devToolsActivePortPath: '/tmp/chrome/DevToolsActivePort',
        hasDevToolsActivePort: false,
        platform: 'darwin',
      },
    ],
  },
  controlState: 'idle',
  tabs: [],
  config: baseConfig,
}

describe('BrowserUseSettings', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    useBrowserUseStore.getState().reset()
    vi.clearAllMocks()
    apiMock.getStatus.mockResolvedValue(baseStatus)
    apiMock.getConfig.mockResolvedValue(baseConfig)
    apiMock.updateConfig.mockImplementation(async (patch: Partial<BrowserUseConfig>) => ({
      ...baseConfig,
      ...patch,
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens confirmation dialog before enabling and persists config on confirm', async () => {
    render(<BrowserUseSettings />)

    const toggle = await screen.findByLabelText('Enable Browser Use')
    expect(toggle).not.toBeChecked()

    fireEvent.click(toggle)
    expect(screen.getByRole('dialog')).toHaveTextContent('Enable Browser Use?')
    expect(apiMock.updateConfig).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Enable Browser Use' }))

    await waitFor(() => {
      expect(apiMock.updateConfig).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }))
    })
    expect(toggle).toBeChecked()
  })

  it('polls every 1.5s in the 2-step Live Attach wizard and connects Chrome', async () => {
    const portReadyStatus: BrowserUseStatus = {
      ...baseStatus,
      chrome: {
        ...baseStatus.chrome,
        detectedBrowsers: [
          { ...baseStatus.chrome.detectedBrowsers[0]!, hasDevToolsActivePort: true },
        ],
      },
    }
    const connectedStatus: BrowserUseStatus = {
      ...portReadyStatus,
      chrome: {
        ...portReadyStatus.chrome,
        mode: 'live_attach',
        browserId: 'chrome',
        browserName: 'Google Chrome',
        browserVersion: 'Chrome/144.0',
        port: 9222,
      },
    }
    apiMock.getStatus
      .mockResolvedValueOnce(baseStatus)
      .mockResolvedValueOnce(portReadyStatus)
    apiMock.connectChrome.mockResolvedValueOnce({
      ok: true,
      chrome: connectedStatus.chrome,
      status: connectedStatus,
    })

    render(<BrowserUseSettings />)
    await screen.findByText('Google Chrome')

    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: '2-step setup guide' }))
    expect(screen.getByTestId('chrome-live-attach-wizard')).toBeInTheDocument()
    expect(screen.getByText('chrome://inspect/#remote-debugging')).toBeInTheDocument()
    expect(screen.getByTestId('chrome-debug-port-status')).toHaveTextContent('Listening for remote debugging port')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(screen.getByTestId('chrome-debug-port-status')).toHaveTextContent('Remote debugging port detected')

    vi.useRealTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => {
      expect(apiMock.connectChrome).toHaveBeenCalledWith({ browserId: 'chrome' })
    })
    expect(screen.getByText('Connected (Live Attach)')).toBeInTheDocument()
  })

  it('launches Managed Isolated Chrome and supports disconnecting', async () => {
    const managedStatus: BrowserUseStatus = {
      ...baseStatus,
      chrome: {
        ...baseStatus.chrome,
        mode: 'managed',
        browserId: 'chrome',
        browserName: 'Google Chrome',
        port: 51234,
      },
    }
    apiMock.launchManagedChrome.mockResolvedValueOnce({
      ok: true,
      chrome: managedStatus.chrome,
      status: managedStatus,
    })
    apiMock.disconnectChrome.mockResolvedValueOnce({
      ok: true,
      status: baseStatus,
    })

    render(<BrowserUseSettings />)
    await screen.findByText('Managed Isolated Chrome')

    fireEvent.click(screen.getByRole('button', { name: 'Launch managed browser' }))
    await waitFor(() => {
      expect(apiMock.launchManagedChrome).toHaveBeenCalledWith({ browserId: 'chrome' })
    })
    expect(screen.getByText('Connected (Managed)')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => {
      expect(apiMock.disconnectChrome).toHaveBeenCalledTimes(1)
    })
  })

  it('handles loading/config errors, settings toggles, target changes, awaiting_approval, and Chrome errors', async () => {
    // Status load failure + retry
    apiMock.getStatus.mockRejectedValueOnce(new Error('network'))
    const first = render(<BrowserUseSettings />)
    expect(await screen.findByText('Failed to check Browser Use status.')).toBeInTheDocument()
    apiMock.getStatus.mockResolvedValueOnce({
      ...baseStatus,
      workspaceAvailable: false,
      chrome: {
        mode: 'awaiting_approval',
        detectedBrowsers: [
          ...baseStatus.chrome.detectedBrowsers,
          {
            id: 'edge',
            name: 'Microsoft Edge',
            executablePath: '/Applications/Edge.app',
            userDataDir: '/tmp/edge',
            devToolsActivePortPath: '/tmp/edge/DevToolsActivePort',
            hasDevToolsActivePort: true,
            platform: 'darwin',
          },
        ],
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await screen.findByText('Desktop app required')
    expect(screen.getByText(/waiting for you to click Allow/i)).toBeInTheDocument()

    // Select second detected browser + change preferred target + toggle cursor/auto-open switches
    fireEvent.click(screen.getByTestId('detected-browser-edge'))
    fireEvent.click(screen.getByRole('radio', { name: 'Chrome' }))
    await waitFor(() => {
      expect(apiMock.updateConfig).toHaveBeenCalledWith({ preferredTarget: 'chrome' })
    })

    fireEvent.click(screen.getByLabelText('Show virtual cursor and action effects'))
    await waitFor(() => {
      expect(apiMock.updateConfig).toHaveBeenCalledWith({ showCursorOverlay: false })
    })

    fireEvent.click(screen.getByLabelText('Auto-expand right workspace during browser control'))
    await waitFor(() => {
      expect(apiMock.updateConfig).toHaveBeenCalledWith({ autoOpenWorkspacePanel: false })
    })

    // Config save failure rolls back and shows error banner
    apiMock.updateConfig.mockRejectedValueOnce(new Error('save failed'))
    fireEvent.click(screen.getByLabelText('Show virtual cursor and action effects'))
    expect(await screen.findByText('Failed to save Browser Use settings.')).toBeInTheDocument()

    // Chrome connect / launch / disconnect errors surface notice
    fireEvent.click(screen.getByRole('button', { name: '2-step setup guide' }))
    apiMock.connectChrome.mockRejectedValueOnce(new Error('connect boom'))
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByText('connect boom')).toBeInTheDocument()

    apiMock.launchManagedChrome.mockRejectedValueOnce(new Error('launch boom'))
    fireEvent.click(screen.getByRole('button', { name: 'Launch managed browser' }))
    expect(await screen.findByText('launch boom')).toBeInTheDocument()

    // Refresh button triggers status re-fetch
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(apiMock.getStatus).toHaveBeenCalledTimes(3))
    first.unmount()

    // Config load error state + retry
    apiMock.getStatus.mockResolvedValueOnce(baseStatus)
    apiMock.getConfig.mockRejectedValueOnce(new Error('cfg fail'))
    render(<BrowserUseSettings />)
    expect(await screen.findByText('Failed to load Browser Use settings.')).toBeInTheDocument()
  })

  it('uses V6C switch rows without duplicate labels, non-pill badges, and pressable browser selector tiles', async () => {
    apiMock.getStatus.mockResolvedValueOnce({
      ...baseStatus,
      chrome: {
        ...baseStatus.chrome,
        detectedBrowsers: [
          ...baseStatus.chrome.detectedBrowsers,
          {
            id: 'edge',
            name: 'Microsoft Edge',
            executablePath: '/Applications/Edge.app',
            userDataDir: '/tmp/edge',
            devToolsActivePortPath: '/tmp/edge/DevToolsActivePort',
            hasDevToolsActivePort: true,
            platform: 'darwin',
          },
        ],
      },
    })

    render(<BrowserUseSettings />)
    await screen.findByText('Google Chrome')

    // SettingsSwitchRow hides duplicate visible switch label while preserving aria-label
    expect(screen.getAllByText('Show virtual cursor and action effects')).toHaveLength(1)
    expect(screen.getAllByText('Auto-expand right workspace during browser control')).toHaveLength(1)
    expect(screen.getByLabelText('Show virtual cursor and action effects')).toBeInTheDocument()
    expect(screen.getByLabelText('Auto-expand right workspace during browser control')).toBeInTheDocument()

    // Non-pill badges
    const readyBadge = screen.getByText('Ready · No OS permissions')
    expect(readyBadge.className).toContain('rounded-[var(--radius-sm)]')
    expect(readyBadge.className).not.toContain('rounded-full')

    // Pressable browser tiles with aria-pressed
    const chromeTile = screen.getByTestId('detected-browser-chrome')
    const edgeTile = screen.getByTestId('detected-browser-edge')
    expect(chromeTile).toHaveAttribute('aria-pressed', 'true')
    expect(edgeTile).toHaveAttribute('aria-pressed', 'false')
    expect(chromeTile.className).toContain('v6c-pressable')
    expect(chromeTile.className).toContain('rounded-[var(--radius-card-inner)]')
    expect(chromeTile.className).toContain('border-[var(--color-brand)]')
    expect(edgeTile.className).toContain('v6c-raised')

    fireEvent.click(edgeTile)
    expect(edgeTile).toHaveAttribute('aria-pressed', 'true')
    expect(chromeTile).toHaveAttribute('aria-pressed', 'false')

    // Wizard inner card and CopyButton tokens
    fireEvent.click(screen.getByRole('button', { name: '2-step setup guide' }))
    const wizard = screen.getByTestId('chrome-live-attach-wizard')
    expect(wizard.className).toContain('rounded-[var(--radius-card-inner)]')
    const copyBtn = screen.getByRole('button', { name: 'Copy URL' })
    expect(copyBtn.className).toContain('v6c-raised')
    expect(copyBtn.className).toContain('v6c-pressable')
    expect(copyBtn.className).toContain('rounded-[var(--radius-control)]')
  })
})
