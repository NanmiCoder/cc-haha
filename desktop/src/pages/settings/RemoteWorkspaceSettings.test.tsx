import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  baseUrl: 'http://127.0.0.1:3456',
  connectRemoteWorkspace: vi.fn(),
  disconnectRemoteWorkspace: vi.fn(),
  waitForHealth: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  getBaseUrl: () => mocks.baseUrl,
}))

// The pane drives the store, which delegates to desktopRuntime. Mock that seam so
// the test exercises the pane and store wiring without a live server or tunnel.
vi.mock('@/lib/desktopRuntime', () => ({
  connectRemoteWorkspace: mocks.connectRemoteWorkspace,
  disconnectRemoteWorkspace: mocks.disconnectRemoteWorkspace,
  waitForHealth: mocks.waitForHealth,
}))

import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import { useRemoteWorkspaceStore } from '@/stores/remoteWorkspaceStore'
import { writeRemoteWorkspace } from '@/lib/remoteWorkspace'
import { RemoteWorkspaceSettings } from './RemoteWorkspaceSettings'

const REMOTE_URL = 'http://127.0.0.1:9411'

function urlField() {
  return screen.getByLabelText('Server URL')
}

function hostField() {
  return screen.getByLabelText('SSH host')
}

describe('remote workspace settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.baseUrl = 'http://127.0.0.1:3456'
    mocks.connectRemoteWorkspace.mockResolvedValue(REMOTE_URL)
    mocks.waitForHealth.mockResolvedValue(undefined)
    window.localStorage.clear()
    useSettingsStore.setState({ locale: 'en' })
    useUIStore.setState({ toasts: [] })
    useRemoteWorkspaceStore.setState(useRemoteWorkspaceStore.getInitialState(), true)
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(useSettingsStore.getInitialState(), true)
    useUIStore.setState(useUIStore.getInitialState(), true)
    vi.unstubAllGlobals()
  })

  it('renders the pane in its disconnected state', () => {
    render(<RemoteWorkspaceSettings />)
    expect(screen.getByRole('heading', { name: 'Remote workspace' })).toBeInTheDocument()
    expect(screen.getByText('Local')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Switch to remote' })).toBeDisabled()
    // The deploy command is offered to copy rather than executed from here.
    expect(screen.getByText('bun run scripts/remote-workspace/deploy.ts --host <ssh-host>')).toBeInTheDocument()
  })

  it('pre-fills a remembered profile and offers to reconnect', () => {
    writeRemoteWorkspace({ url: REMOTE_URL, sshHost: 'my-gpu-server', enabled: false, connectedAt: null })
    render(<RemoteWorkspaceSettings />)
    expect(urlField()).toHaveValue(REMOTE_URL)
    expect(hostField()).toHaveValue('my-gpu-server')
    expect(screen.getByRole('button', { name: 'Switch to remote' })).toBeEnabled()
  })

  it('switches to the remote server and reloads', async () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload })
    render(<RemoteWorkspaceSettings />)
    fireEvent.change(urlField(), { target: { value: REMOTE_URL } })
    fireEvent.change(hostField(), { target: { value: 'my-gpu-server' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Switch to remote' }))
    })

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(mocks.connectRemoteWorkspace).toHaveBeenCalledWith(REMOTE_URL, 'my-gpu-server')
    expect(useRemoteWorkspaceStore.getState().status).toBe('connected')
  })

  it('shows why a connection failed and stays on this machine', async () => {
    mocks.connectRemoteWorkspace.mockRejectedValue(new Error('its URL must be on this machine'))
    render(<RemoteWorkspaceSettings />)
    fireEvent.change(urlField(), { target: { value: 'https://gpu.example.com' } })
    fireEvent.change(hostField(), { target: { value: 'my-gpu-server' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Switch to remote' }))
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('must be on this machine')
  })

  it('tests a connection without switching to it', async () => {
    render(<RemoteWorkspaceSettings />)
    fireEvent.change(urlField(), { target: { value: REMOTE_URL } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    })

    await waitFor(() => expect(mocks.waitForHealth).toHaveBeenCalledWith(REMOTE_URL))
    expect(mocks.connectRemoteWorkspace).not.toHaveBeenCalled()
  })

  it('reports an unreachable server from a test connection', async () => {
    mocks.waitForHealth.mockRejectedValue(new Error('Server healthcheck failed'))
    render(<RemoteWorkspaceSettings />)
    fireEvent.change(urlField(), { target: { value: REMOTE_URL } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the remote server')
  })

  it('switches back to local and reloads', () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload })
    // Connected means an enabled profile whose URL is the server in use.
    writeRemoteWorkspace({ url: REMOTE_URL, sshHost: 'my-gpu-server', enabled: true, connectedAt: null })
    mocks.baseUrl = REMOTE_URL

    render(<RemoteWorkspaceSettings />)
    expect(screen.getByText('Remote · my-gpu-server')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Switch back to local' }))

    expect(mocks.disconnectRemoteWorkspace).toHaveBeenCalledTimes(1)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(useRemoteWorkspaceStore.getState().status).toBe('idle')
  })

  it('disables editing while connected', () => {
    writeRemoteWorkspace({ url: REMOTE_URL, sshHost: 'my-gpu-server', enabled: true, connectedAt: null })
    mocks.baseUrl = REMOTE_URL
    render(<RemoteWorkspaceSettings />)
    expect(urlField()).toBeDisabled()
    expect(hostField()).toBeDisabled()
  })
})
