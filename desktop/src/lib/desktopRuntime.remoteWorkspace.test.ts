import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const clientMocks = vi.hoisted(() => ({
  defaultBaseUrl: 'http://127.0.0.1:3456',
  explicitDefaultBaseUrl: false,
  setBaseUrl: vi.fn(),
  setAuthToken: vi.fn(),
  postVerify: vi.fn(),
}))

vi.mock('../api/client', () => ({
  api: { post: clientMocks.postVerify },
  getDefaultBaseUrl: () => clientMocks.defaultBaseUrl,
  hasExplicitDefaultBaseUrl: () => clientMocks.explicitDefaultBaseUrl,
  setAuthToken: clientMocks.setAuthToken,
  setBaseUrl: clientMocks.setBaseUrl,
}))

import {
  connectRemoteWorkspace,
  disconnectRemoteWorkspace,
  initializeDesktopServerUrl,
} from './desktopRuntime'
import { browserHost } from './desktopHost/browserHost'
import {
  REMOTE_WORKSPACE_STORAGE_KEY,
  writeRemoteWorkspace,
} from './remoteWorkspace'

function healthOkResponse() {
  return Response.json({ status: 'ok' })
}

function desktopHostAt(serverUrl: string) {
  return {
    ...browserHost,
    kind: 'electron' as const,
    isDesktop: true,
    runtime: {
      getServerUrl: vi.fn().mockResolvedValue(serverUrl),
      getLocalAccessToken: vi.fn().mockResolvedValue('desktop-local-token'),
    },
  }
}

const REMOTE_URL = 'http://127.0.0.1:9411'

describe('remote workspace runtime', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.clearAllMocks()
    clientMocks.defaultBaseUrl = 'http://127.0.0.1:3456'
    clientMocks.explicitDefaultBaseUrl = false
    vi.useRealTimers()
    window.localStorage.clear()
    window.history.pushState({}, '', '/')
    Reflect.deleteProperty(window, 'desktopHost')
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.fetch = originalFetch
  })

  describe('connectRemoteWorkspace', () => {
    it('switches the base URL and persists an enabled profile once healthy', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(healthOkResponse()) as typeof fetch

      await expect(connectRemoteWorkspace(REMOTE_URL, 'my-gpu-server')).resolves.toBe(REMOTE_URL)

      expect(clientMocks.setBaseUrl).toHaveBeenCalledWith(REMOTE_URL)
      // The tunnel reaches the server as a loopback peer, so no token is sent.
      expect(clientMocks.setAuthToken).toHaveBeenCalledWith(null)
      expect(JSON.parse(window.localStorage.getItem(REMOTE_WORKSPACE_STORAGE_KEY)!)).toMatchObject({
        url: REMOTE_URL,
        sshHost: 'my-gpu-server',
        enabled: true,
      })
    })

    it('strips a trailing slash before storing', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(healthOkResponse()) as typeof fetch
      await connectRemoteWorkspace(`${REMOTE_URL}/`, 'my-gpu-server')
      expect(clientMocks.setBaseUrl).toHaveBeenCalledWith(REMOTE_URL)
    })

    it('does not touch the base URL when the health probe fails', async () => {
      vi.useFakeTimers()
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as typeof fetch

      const attempt = expect(connectRemoteWorkspace(REMOTE_URL, 'my-gpu-server')).rejects.toThrow(/healthcheck/i)
      await vi.runAllTimersAsync()
      await attempt

      expect(clientMocks.setBaseUrl).not.toHaveBeenCalled()
      expect(window.localStorage.getItem(REMOTE_WORKSPACE_STORAGE_KEY)).toBeNull()
    })

    it.each([
      ['a non-loopback URL', 'https://gpu.example.com', 'my-gpu-server'],
      ['a blank URL', '   ', 'my-gpu-server'],
      ['a blank SSH host', REMOTE_URL, '  '],
    ])('rejects %s before probing', async (_label, url, host) => {
      globalThis.fetch = vi.fn().mockResolvedValue(healthOkResponse()) as typeof fetch
      await expect(connectRemoteWorkspace(url, host)).rejects.toThrow()
      expect(globalThis.fetch).not.toHaveBeenCalled()
      expect(clientMocks.setBaseUrl).not.toHaveBeenCalled()
    })
  })

  describe('initializeDesktopServerUrl', () => {
    it('applies an enabled remote profile instead of the local sidecar', async () => {
      writeRemoteWorkspace({ url: REMOTE_URL, sshHost: 'my-gpu-server', enabled: true, connectedAt: null })
      window.desktopHost = desktopHostAt('http://127.0.0.1:59231')
      globalThis.fetch = vi.fn().mockResolvedValue(healthOkResponse()) as typeof fetch

      await expect(initializeDesktopServerUrl()).resolves.toBe(REMOTE_URL)

      expect(clientMocks.setBaseUrl).toHaveBeenCalledWith(REMOTE_URL)
      expect(clientMocks.setAuthToken).toHaveBeenCalledWith(null)
      // The local sidecar is never asked for its URL when a remote is active.
      expect(window.desktopHost.runtime.getServerUrl).not.toHaveBeenCalled()
    })

    it('leaves startup on the local sidecar when no profile is stored', async () => {
      const localUrl = 'http://127.0.0.1:59231'
      window.desktopHost = desktopHostAt(localUrl)
      globalThis.fetch = vi.fn().mockResolvedValue(healthOkResponse()) as typeof fetch

      await expect(initializeDesktopServerUrl()).resolves.toBe(localUrl)
      expect(window.desktopHost.runtime.getServerUrl).toHaveBeenCalledTimes(1)
    })

    it('falls back to the local sidecar and disables the profile when the tunnel is down', async () => {
      writeRemoteWorkspace({ url: REMOTE_URL, sshHost: 'my-gpu-server', enabled: true, connectedAt: null })
      const localUrl = 'http://127.0.0.1:59231'
      window.desktopHost = desktopHostAt(localUrl)
      globalThis.fetch = vi.fn((input) => (
        String(input) === `${REMOTE_URL}/health`
          ? Promise.reject(new Error('ECONNREFUSED'))
          : Promise.resolve(healthOkResponse())
      )) as typeof fetch

      vi.useFakeTimers()
      const startup = expect(initializeDesktopServerUrl()).resolves.toBe(localUrl)
      await vi.runAllTimersAsync()
      await startup

      expect(clientMocks.setBaseUrl).toHaveBeenLastCalledWith(localUrl)
      // Remembered but switched off, so the next startup does not pay the probe.
      expect(JSON.parse(window.localStorage.getItem(REMOTE_WORKSPACE_STORAGE_KEY)!)).toMatchObject({
        url: REMOTE_URL,
        sshHost: 'my-gpu-server',
        enabled: false,
      })
    })
  })

  it('disconnectRemoteWorkspace forgets the profile', () => {
    writeRemoteWorkspace({ url: REMOTE_URL, sshHost: 'my-gpu-server', enabled: true, connectedAt: null })
    disconnectRemoteWorkspace()
    expect(window.localStorage.getItem(REMOTE_WORKSPACE_STORAGE_KEY)).toBeNull()
  })
})
