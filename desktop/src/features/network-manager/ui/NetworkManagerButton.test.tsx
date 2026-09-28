import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserHost } from '@/lib/desktopHost/browserHost'
import { useSettingsStore } from '@/stores/settingsStore'
import { createNetworkFixture } from '../testing/networkFixture'
import { NetworkManagerButton } from './NetworkManagerButton'

afterEach(() => { cleanup(); delete window.desktopHost })
describe('NetworkManagerButton', () => {
  it('hides the entry on a host without a network bridge', () => {
    window.desktopHost = browserHost
    render(<NetworkManagerButton />)
    expect(screen.queryByRole('button')).toBeNull()
  })
  it('opens a named dialog from the toolbar and closes without changing the network', async () => {
    useSettingsStore.setState({ locale: 'en' })
    const fixture = createNetworkFixture()
    window.desktopHost = { ...browserHost, networkManager: fixture.api }
    render(<NetworkManagerButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Network configuration' }))
    expect(screen.getByRole('dialog', { name: 'Network configuration' })).toBeVisible()
    await screen.findByLabelText('Profile name')
    fireEvent.click(screen.getByRole('button', { name: 'Close network configuration' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fixture.calls.map(call => call.action).sort()).toEqual(['discoverProxy', 'list', 'vpnRouteOptions'])
  })
  it('opens ncpa.cpl only after a click and preserves an unsaved draft with no save/apply', async () => {
    useSettingsStore.setState({ locale: 'en' })
    const fixture = createNetworkFixture()
    window.desktopHost = { ...browserHost, networkManager: fixture.api }
    render(<NetworkManagerButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Network configuration' }))
    await screen.findByLabelText('Profile name')
    expect(fixture.calls.some(call => call.action === 'openNetworkConnections')).toBe(false)
    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Unsaved network draft' } })
    const button = screen.getByRole('button', { name: 'Open network connections' })
    expect(button).toHaveAttribute('title', expect.stringContaining('ncpa.cpl'))
    fireEvent.click(button)
    await screen.findByText(/Requested Windows Network Connections/)
    expect(fixture.calls.filter(call => call.action === 'openNetworkConnections')).toEqual([{ action: 'openNetworkConnections' }])
    expect(screen.getByLabelText('Profile name')).toHaveValue('Unsaved network draft')
    expect(fixture.calls.some(call => ['save', 'apply', 'login'].includes(call.action))).toBe(false)
  })

  it('coalesces repeated clicks while the launch is pending', async () => {
    useSettingsStore.setState({ locale: 'en' })
    const fixture = createNetworkFixture()
    let release!: (value: { ok: true; data: null }) => void
    const launch = vi.fn(() => new Promise<{ ok: true; data: null }>(resolve => { release = resolve }))
    fixture.api.openNetworkConnections = launch
    window.desktopHost = { ...browserHost, networkManager: fixture.api }
    render(<NetworkManagerButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Network configuration' }))
    await screen.findByLabelText('Profile name')
    const button = screen.getByRole('button', { name: 'Open network connections' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(button).toBeDisabled()
    expect(launch).toHaveBeenCalledTimes(1)
    await act(async () => { release({ ok: true, data: null }) })
    expect(button).toBeEnabled()
  })

  it('reports failure without native details and permits retry', async () => {
    useSettingsStore.setState({ locale: 'en' })
    const fixture = createNetworkFixture()
    fixture.api.openNetworkConnections = vi.fn()
      .mockRejectedValueOnce(new Error('PRIVATE_OS_DETAIL'))
      .mockResolvedValueOnce({ ok: false, error: { code: 'NETWORK_CONNECTIONS_OPEN_FAILED', message: 'PRIVATE_OS_DETAIL' } })
      .mockResolvedValue({ ok: true, data: null })
    window.desktopHost = { ...browserHost, networkManager: fixture.api }
    render(<NetworkManagerButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Network configuration' }))
    await screen.findByLabelText('Profile name')
    const button = screen.getByRole('button', { name: 'Open network connections' })
    for (let attempt = 0; attempt < 2; attempt++) {
      fireEvent.click(button)
      expect(await screen.findByText(/Could not open Windows Network Connections/)).toHaveAttribute('role', 'alert')
      expect(screen.queryByText('PRIVATE_OS_DETAIL')).toBeNull()
      await waitFor(() => expect(button).toBeEnabled())
    }
    fireEvent.click(button)
    await screen.findByText(/Requested Windows Network Connections/)
    expect(screen.queryByText(/Could not open Windows Network Connections/)).toBeNull()
  })

  it('does not display a stale launch result after the configuration dialog is reopened', async () => {
    useSettingsStore.setState({ locale: 'en' })
    const fixture = createNetworkFixture()
    let release!: (value: { ok: true; data: null }) => void
    fixture.api.openNetworkConnections = () => new Promise(resolve => { release = resolve })
    window.desktopHost = { ...browserHost, networkManager: fixture.api }
    render(<NetworkManagerButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Network configuration' }))
    await screen.findByLabelText('Profile name')
    fireEvent.click(screen.getByRole('button', { name: 'Open network connections' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close network configuration' }))
    fireEvent.click(screen.getByRole('button', { name: 'Network configuration' }))
    await screen.findByLabelText('Profile name')
    await act(async () => { release({ ok: true, data: null }) })
    expect(screen.queryByText(/Requested Windows Network Connections/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Open network connections' })).toBeEnabled()
  })

  it('opens detailed help from the question-mark action without touching the network', async () => {
    useSettingsStore.setState({ locale: 'en' })
    const fixture = createNetworkFixture()
    window.desktopHost = { ...browserHost, networkManager: fixture.api }
    render(<NetworkManagerButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Network configuration' }))
    await screen.findByLabelText('Profile name')

    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Unsaved fixture profile' } })
    fireEvent.click(screen.getByRole('button', { name: 'Help' }))
    expect(screen.getByRole('dialog', { name: 'Network configuration · Help' })).toBeVisible()
    expect(screen.getByTestId('network-manager-help')).toBeVisible()
    expect(screen.getByText('What this tool manages')).toBeVisible()
    expect(screen.getByText('Configuration and validation flow')).toBeVisible()
    expect(screen.getByText('Underlying principles and safety boundaries')).toBeVisible()
    expect(fixture.calls.map(call => call.action).sort()).toEqual(['discoverProxy', 'list', 'vpnRouteOptions'])

    fireEvent.click(screen.getByRole('button', { name: 'Back to configuration' }))
    expect(await screen.findByLabelText('Profile name')).toBeVisible()
    expect(screen.getByLabelText('Profile name')).toHaveValue('Unsaved fixture profile')
    expect(fixture.calls.map(call => call.action).sort()).toEqual(['discoverProxy', 'list', 'vpnRouteOptions'])
  })
})
