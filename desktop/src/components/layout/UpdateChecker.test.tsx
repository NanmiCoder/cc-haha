import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

import { UpdateChecker } from './UpdateChecker'
import { browserHost } from '../../lib/desktopHost/browserHost'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUpdateStore } from '../../stores/updateStore'

describe('UpdateChecker', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en', autoUpdateEnabled: true })
    Reflect.deleteProperty(window, '__TAURI__')
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: {
        ...browserHost.capabilities,
        updates: true,
      },
    }

    useUpdateStore.setState({
      status: 'available',
      availableVersion: '0.1.5',
      releaseNotes: '# Claude Code Haha v0.1.5\n\n[Release notes](https://example.com/releases/v0.1.5)',
      progressPercent: 0,
      downloadedBytes: 0,
      totalBytes: null,
      error: null,
      checkedAt: null,
      shouldPrompt: true,
      initialize: vi.fn().mockResolvedValue(undefined),
      checkForUpdates: vi.fn().mockResolvedValue(null),
      installUpdate: vi.fn().mockResolvedValue(undefined),
      dismissPrompt: vi.fn(),
    })
  })

  it('renders markdown release notes in the update prompt', () => {
    useUpdateStore.setState({ status: 'downloaded' })

    render(<UpdateChecker />)

    expect(screen.getByText('Update ready')).toBeInTheDocument()
    expect(screen.getByText('v0.1.5 has been downloaded. Click “Install and restart” to apply it.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Claude Code Haha v0.1.5' })).toBeInTheDocument()

    const link = screen.getByRole('link', { name: 'Release notes' })
    expect(link).toHaveAttribute('href', 'https://example.com/releases/v0.1.5')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('keeps automatic updates quiet when disabled and starts them when re-enabled', async () => {
    const initialize = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ autoUpdateEnabled: false })
    useUpdateStore.setState({ status: 'downloaded', initialize })
    render(<UpdateChecker />)

    expect(initialize).not.toHaveBeenCalled()
    expect(screen.queryByText('Update ready')).not.toBeInTheDocument()

    await act(async () => {
      useSettingsStore.setState({ autoUpdateEnabled: true })
    })

    expect(initialize).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Update ready')).toBeInTheDocument()

    await act(async () => {
      useSettingsStore.setState({ autoUpdateEnabled: false })
    })

    expect(screen.queryByText('Update ready')).not.toBeInTheDocument()
    expect(initialize).toHaveBeenCalledTimes(1)
  })

  it('renders the update prompt in Electron desktop runtime', () => {
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: {
        ...browserHost.capabilities,
        updates: true,
      },
    }
    useUpdateStore.setState({ status: 'downloaded' })

    render(<UpdateChecker />)

    expect(screen.getByText('Update ready')).toBeInTheDocument()
    expect(screen.getByText('Install and restart')).toBeInTheDocument()
  })

  it('shows downloaded bytes when the updater does not provide total size', () => {
    useUpdateStore.setState({
      status: 'downloading',
      availableVersion: '0.1.5',
      releaseNotes: '# Claude Code Haha v0.1.5',
      progressPercent: 0,
      downloadedBytes: 1536,
      totalBytes: null,
      error: null,
      checkedAt: null,
      shouldPrompt: true,
      initialize: vi.fn().mockResolvedValue(undefined),
      checkForUpdates: vi.fn().mockResolvedValue(null),
      installUpdate: vi.fn().mockResolvedValue(undefined),
      dismissPrompt: vi.fn(),
    })

    render(<UpdateChecker />)

    expect(screen.queryByText('Downloading update... 1.5 KB downloaded')).not.toBeInTheDocument()
    expect(screen.queryByText('Update ready')).not.toBeInTheDocument()
    expect(screen.queryByText(/0%/)).not.toBeInTheDocument()
  })

  it.each(['installing', 'restarting'] as const)('does not keep a forced prompt during %s', (status) => {
    useUpdateStore.setState({
      status,
      availableVersion: '0.1.5',
      shouldPrompt: true,
    })

    render(<UpdateChecker />)

    expect(screen.queryByText('Update ready')).not.toBeInTheDocument()
    expect(screen.queryByText('Install and restart')).not.toBeInTheDocument()
  })

  it('keeps the ready prompt retryable when install fails after download', () => {
    useUpdateStore.setState({
      status: 'downloaded',
      error: 'installer failed',
      shouldPrompt: true,
    })

    render(<UpdateChecker />)

    expect(screen.getByText('Update ready')).toBeInTheDocument()
    expect(screen.getByText('Update failed: installer failed')).toBeInTheDocument()
    expect(screen.getByText('Install and restart')).toBeInTheDocument()
  })

  it('drives the Electron mock-feed check/download/install flow without leaving the prompt stuck', async () => {
    Reflect.deleteProperty(window, '__TAURI__')
    const download = vi.fn(async (onEvent?: (event: unknown) => void) => {
      onEvent?.({ event: 'Started', data: { contentLength: 100 } })
      onEvent?.({ event: 'Progress', data: { chunkLength: 100 } })
      onEvent?.({ event: 'Finished' })
    })
    const install = vi.fn().mockResolvedValue(undefined)
    const prepareInstall = vi.fn().mockResolvedValue(undefined)
    const relaunch = vi.fn().mockResolvedValue(undefined)
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: {
        ...browserHost.capabilities,
        updates: true,
      },
      updates: {
        ...browserHost.updates,
        check: vi.fn().mockResolvedValue({
          version: '0.2.0',
          body: 'Mock release feed',
          download,
          install,
          close: vi.fn().mockResolvedValue(undefined),
        }),
        prepareInstall,
        relaunch,
      },
    }

    vi.resetModules()
    const { UpdateChecker: FreshUpdateChecker } = await import('./UpdateChecker')
    const { useUpdateStore: freshUpdateStore } = await import('../../stores/updateStore')
    const { useSettingsStore: freshSettingsStore } = await import('../../stores/settingsStore')
    freshSettingsStore.setState({ locale: 'en' })
    freshUpdateStore.setState({
      status: 'idle',
      availableVersion: null,
      releaseNotes: null,
      progressPercent: 0,
      downloadedBytes: 0,
      totalBytes: null,
      error: null,
      checkedAt: null,
      shouldPrompt: false,
    })

    render(<FreshUpdateChecker />)
    await act(async () => {
      await freshUpdateStore.getState().checkForUpdates()
    })

    expect(await screen.findByText('Update ready')).toBeInTheDocument()
    expect(screen.getByText('v0.2.0 has been downloaded. Click “Install and restart” to apply it.')).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByText('Install and restart'))
    })

    await waitFor(() => {
      expect(prepareInstall).toHaveBeenCalledTimes(1)
      expect(install).toHaveBeenCalledTimes(1)
      expect(relaunch).toHaveBeenCalledTimes(1)
      expect(freshUpdateStore.getState().status).toBe('restarting')
    })
    expect(screen.queryByText('Update ready')).not.toBeInTheDocument()
  })
})
