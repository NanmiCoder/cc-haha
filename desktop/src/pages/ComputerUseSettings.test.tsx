import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

import { ComputerUseSettings } from './ComputerUseSettings'
import { useSettingsStore } from '../stores/settingsStore'

const computerUseApiMock = vi.hoisted(() => ({
  getStatus: vi.fn(),
  getInstalledApps: vi.fn(),
  getAuthorizedApps: vi.fn(),
  setAuthorizedApps: vi.fn(),
  runSetup: vi.fn(),
  openSettings: vi.fn(),
}))

vi.mock('../api/computerUse', () => ({
  computerUseApi: computerUseApiMock,
}))

const readyStatus = {
  platform: 'darwin',
  supported: true,
  python: {
    installed: true,
    version: '3.12.0',
    path: '/usr/bin/python3',
    source: 'system',
    error: null,
  },
  venv: {
    created: false,
    path: '/tmp/venv',
  },
  dependencies: {
    installed: false,
    requirementsFound: true,
  },
  permissions: {
    accessibility: null,
    screenRecording: null,
  },
}

const enabledConfig = {
  enabled: true,
  authorizedApps: [],
  grantFlags: {
    clipboardRead: true,
    clipboardWrite: true,
    systemKeyCombos: true,
  },
  pythonPath: null,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

describe('ComputerUseSettings', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    computerUseApiMock.getStatus.mockReset()
    computerUseApiMock.getInstalledApps.mockReset()
    computerUseApiMock.getAuthorizedApps.mockReset()
    computerUseApiMock.setAuthorizedApps.mockReset()
    computerUseApiMock.runSetup.mockReset()
    computerUseApiMock.openSettings.mockReset()

    computerUseApiMock.getStatus.mockResolvedValue(readyStatus)
    computerUseApiMock.getAuthorizedApps.mockResolvedValue(enabledConfig)
    computerUseApiMock.setAuthorizedApps.mockResolvedValue({ ok: true })
  })

  it('renders the stored disabled state with the MCP exposure hint', async () => {
    computerUseApiMock.getAuthorizedApps.mockResolvedValue({
      ...enabledConfig,
      enabled: false,
    })

    render(<ComputerUseSettings />)

    const toggle = await screen.findByLabelText('Enabled')
    await waitFor(() => expect(toggle).not.toBeChecked())
    expect(
      screen.getByText(/will not inject the computer-use MCP server/i),
    ).toBeInTheDocument()
  })

  it('saves the Computer Use enablement toggle independently', async () => {
    render(<ComputerUseSettings />)

    const toggle = await screen.findByLabelText('Enabled')
    await waitFor(() => expect(computerUseApiMock.getAuthorizedApps).toHaveBeenCalled())

    await act(async () => {
      fireEvent.click(toggle)
      await Promise.resolve()
    })

    expect(computerUseApiMock.setAuthorizedApps).toHaveBeenCalledWith({
      enabled: false,
    })
  })

  it('saves a custom Python interpreter path and rechecks status', async () => {
    render(<ComputerUseSettings />)

    const input = await screen.findByLabelText('Python Interpreter Path')

    await act(async () => {
      fireEvent.change(input, {
        target: { value: '  C:\\Users\\me\\miniconda3\\envs\\cu\\python.exe  ' },
      })
      fireEvent.click(screen.getByText('Apply'))
      await Promise.resolve()
    })

    expect(computerUseApiMock.setAuthorizedApps).toHaveBeenCalledWith({
      pythonPath: 'C:\\Users\\me\\miniconda3\\envs\\cu\\python.exe',
    })
    expect(computerUseApiMock.getStatus).toHaveBeenCalledTimes(2)
  })

  it('keeps the user-selected enablement when a stale refresh resolves later', async () => {
    const staleRefresh = deferred<typeof enabledConfig>()
    computerUseApiMock.getStatus.mockResolvedValue({
      ...readyStatus,
      venv: {
        ...readyStatus.venv,
        created: true,
      },
      dependencies: {
        ...readyStatus.dependencies,
        installed: true,
      },
    })
    computerUseApiMock.getInstalledApps.mockResolvedValue({ apps: [] })
    computerUseApiMock.getAuthorizedApps
      .mockResolvedValueOnce({
        ...enabledConfig,
        enabled: false,
      })
      .mockReturnValueOnce(staleRefresh.promise)

    render(<ComputerUseSettings />)

    const toggle = await screen.findByLabelText('Enabled')
    await waitFor(() => expect(toggle).not.toBeChecked())
    await waitFor(() => expect(computerUseApiMock.getInstalledApps).toHaveBeenCalled())

    await act(async () => {
      fireEvent.click(toggle)
      await Promise.resolve()
    })

    expect(toggle).toBeChecked()

    await act(async () => {
      staleRefresh.resolve({
        ...enabledConfig,
        enabled: false,
      })
      await staleRefresh.promise
    })

    expect(toggle).toBeChecked()
  })

  it('saves app and grant flag changes from the ready environment view', async () => {
    computerUseApiMock.getStatus.mockResolvedValue({
      ...readyStatus,
      venv: {
        ...readyStatus.venv,
        created: true,
      },
      dependencies: {
        ...readyStatus.dependencies,
        installed: true,
      },
    })
    computerUseApiMock.getInstalledApps.mockResolvedValue({
      apps: [
        {
          bundleId: 'com.example.Preview',
          displayName: 'Preview',
          path: '/Applications/Preview.app',
        },
      ],
    })

    render(<ComputerUseSettings />)

    await screen.findByText('Preview')

    await act(async () => {
      fireEvent.click(screen.getByText('Preview'))
      await Promise.resolve()
    })

    expect(computerUseApiMock.setAuthorizedApps).toHaveBeenCalledWith({
      authorizedApps: [
        expect.objectContaining({
          bundleId: 'com.example.Preview',
          displayName: 'Preview',
        }),
      ],
      grantFlags: {
        clipboardRead: true,
        clipboardWrite: true,
        systemKeyCombos: true,
      },
    })

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Clipboard Access'))
      await Promise.resolve()
    })

    expect(computerUseApiMock.setAuthorizedApps).toHaveBeenCalledWith({
      authorizedApps: [
        expect.objectContaining({
          bundleId: 'com.example.Preview',
          displayName: 'Preview',
        }),
      ],
      grantFlags: {
        clipboardRead: false,
        clipboardWrite: false,
        systemKeyCombos: true,
      },
    })
  })
})
