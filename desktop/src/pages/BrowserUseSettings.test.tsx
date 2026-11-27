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
})
