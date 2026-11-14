import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  baseUrl: 'http://127.0.0.1:3456',
  connectRemoteWorkspace: vi.fn(),
  disconnectRemoteWorkspace: vi.fn(),
  waitForHealth: vi.fn(),
  reload: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  getBaseUrl: () => mocks.baseUrl,
}))

vi.mock('@/lib/desktopRuntime', () => ({
  connectRemoteWorkspace: mocks.connectRemoteWorkspace,
  disconnectRemoteWorkspace: mocks.disconnectRemoteWorkspace,
  waitForHealth: mocks.waitForHealth,
}))

import { useRemoteWorkspaceStore } from './remoteWorkspaceStore'
import { writeRemoteWorkspace } from '@/lib/remoteWorkspace'

const REMOTE_URL = 'http://127.0.0.1:9411'

function resetStore() {
  useRemoteWorkspaceStore.setState(useRemoteWorkspaceStore.getInitialState(), true)
}

describe('remote workspace store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    mocks.baseUrl = 'http://127.0.0.1:3456'
    resetStore()
    vi.stubGlobal('location', { ...window.location, reload: mocks.reload })
  })

  it('reports connected when the stored profile is the server in use', () => {
    writeRemoteWorkspace({ url: REMOTE_URL, sshHost: 'my-gpu-server', enabled: true, connectedAt: null })
    mocks.baseUrl = REMOTE_URL
    useRemoteWorkspaceStore.getState().load()
    const state = useRemoteWorkspaceStore.getState()
    expect(state.profile?.sshHost).toBe('my-gpu-server')
    expect(state.status).toBe('connected')
  })

  it('reports idle when the stored profile is remembered but not in use', () => {
    writeRemoteWorkspace({ url: REMOTE_URL, sshHost: 'my-gpu-server', enabled: false, connectedAt: null })
    useRemoteWorkspaceStore.getState().load()
    expect(useRemoteWorkspaceStore.getState()).toMatchObject({ status: 'idle', error: null })
    expect(useRemoteWorkspaceStore.getState().profile?.sshHost).toBe('my-gpu-server')
  })

  it('reports idle with no profile', () => {
    useRemoteWorkspaceStore.getState().load()
    expect(useRemoteWorkspaceStore.getState()).toMatchObject({ profile: null, status: 'idle' })
  })

  it('verifies a reachable server without switching to it', async () => {
    mocks.waitForHealth.mockResolvedValue(undefined)
    await expect(useRemoteWorkspaceStore.getState().verify(REMOTE_URL)).resolves.toBe(true)
    expect(useRemoteWorkspaceStore.getState().status).toBe('idle')
    expect(mocks.connectRemoteWorkspace).not.toHaveBeenCalled()
  })

  it('reports an unreachable server on verify', async () => {
    mocks.waitForHealth.mockRejectedValue(new Error('Server healthcheck failed'))
    await expect(useRemoteWorkspaceStore.getState().verify(REMOTE_URL)).resolves.toBe(false)
    expect(useRemoteWorkspaceStore.getState()).toMatchObject({ status: 'error', error: 'unreachable' })
  })

  it('connects then reloads so every view re-resolves against the remote', async () => {
    mocks.connectRemoteWorkspace.mockResolvedValue(REMOTE_URL)
    await expect(useRemoteWorkspaceStore.getState().connect(REMOTE_URL, 'my-gpu-server')).resolves.toBe(REMOTE_URL)
    expect(mocks.connectRemoteWorkspace).toHaveBeenCalledWith(REMOTE_URL, 'my-gpu-server', undefined)
    expect(mocks.reload).toHaveBeenCalledTimes(1)
  })

  it('keeps the reason a connection failed and does not reload', async () => {
    mocks.connectRemoteWorkspace.mockRejectedValue(new Error('its URL must be on this machine'))
    await expect(useRemoteWorkspaceStore.getState().connect('https://gpu.example.com', 'h')).rejects.toThrow()
    expect(useRemoteWorkspaceStore.getState().status).toBe('error')
    expect(useRemoteWorkspaceStore.getState().error).toBe('its URL must be on this machine')
    expect(mocks.reload).not.toHaveBeenCalled()
  })

  it('stringifies a non-Error rejection', async () => {
    mocks.connectRemoteWorkspace.mockRejectedValue('boom')
    await expect(useRemoteWorkspaceStore.getState().connect(REMOTE_URL, 'h')).rejects.toBe('boom')
    expect(useRemoteWorkspaceStore.getState().error).toBe('boom')
  })

  it('disconnects, clears the pane and reloads', () => {
    writeRemoteWorkspace({ url: REMOTE_URL, sshHost: 'my-gpu-server', enabled: true, connectedAt: null })
    useRemoteWorkspaceStore.getState().load()
    useRemoteWorkspaceStore.getState().disconnect()
    expect(mocks.disconnectRemoteWorkspace).toHaveBeenCalledTimes(1)
    expect(useRemoteWorkspaceStore.getState()).toMatchObject({ profile: null, status: 'idle', error: null })
    expect(mocks.reload).toHaveBeenCalledTimes(1)
  })
})
