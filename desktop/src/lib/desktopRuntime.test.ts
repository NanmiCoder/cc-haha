import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const clientMocks = vi.hoisted(() => ({
  defaultBaseUrl: 'http://127.0.0.1:3456',
  explicitDefaultBaseUrl: false,
  setBaseUrl: vi.fn(),
  setAuthToken: vi.fn(),
  postVerify: vi.fn(),
}))

vi.mock('../api/client', () => ({
  api: {
    post: clientMocks.postVerify,
  },
  getDefaultBaseUrl: () => clientMocks.defaultBaseUrl,
  hasExplicitDefaultBaseUrl: () => clientMocks.explicitDefaultBaseUrl,
  setAuthToken: clientMocks.setAuthToken,
  setBaseUrl: clientMocks.setBaseUrl,
}))

import {
  H5ConnectionRequiredError,
  H5_SERVER_URL_STORAGE_KEY,
  H5_TOKEN_STORAGE_KEY,
  initializeDesktopServerUrl,
  isBrowserH5Runtime,
  isDesktopRuntime,
  isLoopbackHostname,
  requiresH5AuthForServerUrl,
  saveAndVerifyH5Connection,
} from './desktopRuntime'
import { browserHost } from './desktopHost/browserHost'

function healthOkResponse() {
  return Response.json({ status: 'ok' })
}

describe('desktopRuntime browser H5 bootstrap', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.clearAllMocks()
    clientMocks.postVerify.mockReset()
    clientMocks.defaultBaseUrl = 'http://127.0.0.1:3456'
    clientMocks.explicitDefaultBaseUrl = false
    vi.useRealTimers()
    window.localStorage.clear()
    window.history.pushState({}, '', '/')
    Reflect.deleteProperty(window, 'desktopHost')
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
    Reflect.deleteProperty(window, '__TAURI__')
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.fetch = originalFetch
  })

  it('keeps public cookie sessions same-origin despite legacy tokens and attacker URL parameters', async () => {
    window.history.pushState({}, '', '/remote?serverUrl=https://attacker.example&h5Token=leak')
    window.localStorage.setItem(H5_SERVER_URL_STORAGE_KEY, 'https://attacker.example')
    window.localStorage.setItem(H5_TOKEN_STORAGE_KEY, 'old-secret')
    clientMocks.explicitDefaultBaseUrl = true
    clientMocks.defaultBaseUrl = 'https://configured.example'
    globalThis.fetch = vi.fn().mockImplementation(async () => healthOkResponse()) as typeof fetch

    await expect(initializeDesktopServerUrl()).resolves.toBe(window.location.origin)
    expect(clientMocks.setBaseUrl).toHaveBeenLastCalledWith(window.location.origin)
    expect(clientMocks.setAuthToken).toHaveBeenLastCalledWith(null)
    expect(globalThis.fetch).toHaveBeenCalledExactlyOnceWith(`${window.location.origin}/health`, { cache: 'no-store' })
    expect(clientMocks.postVerify).not.toHaveBeenCalled()
  })

  it('treats IPv6 loopback as local', () => {
    expect(isLoopbackHostname('[::1]')).toBe(true)
    expect(isLoopbackHostname('::1')).toBe(true)
    expect(isLoopbackHostname('127.0.1.1')).toBe(true)
    expect(isLoopbackHostname('127.example.com')).toBe(false)
    expect(isLoopbackHostname('127.bad.0.1')).toBe(false)
    expect(requiresH5AuthForServerUrl('http://[::1]:3456')).toBe(false)
    expect(requiresH5AuthForServerUrl('http://127.0.0.1:3456')).toBe(false)
    expect(requiresH5AuthForServerUrl('http://127.0.1.1:3456')).toBe(false)
    expect(requiresH5AuthForServerUrl('http://127.example.com:3456')).toBe(true)
    expect(requiresH5AuthForServerUrl('http://localhost:3456')).toBe(false)
    expect(requiresH5AuthForServerUrl('https://public.example.com/app')).toBe(true)
    expect(requiresH5AuthForServerUrl('https://public.example.com/app', 'phone.example.test')).toBe(true)
  })

  it('requires H5 auth for LAN and public browser URLs', () => {
    expect(requiresH5AuthForServerUrl('http://192.168.0.102:28670', '127.0.0.1')).toBe(true)
    expect(requiresH5AuthForServerUrl('http://10.0.0.5:28670', 'localhost')).toBe(true)
    expect(requiresH5AuthForServerUrl('http://172.20.1.8:28670', 'localhost')).toBe(true)
    expect(requiresH5AuthForServerUrl('https://public.example.com/app', 'localhost')).toBe(true)
    expect(requiresH5AuthForServerUrl('http://192.168.0.102:28670', 'phone.example.test')).toBe(true)
  })

  it('clears an invalid token but preserves the remembered remote server URL', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      healthOkResponse(),
    ) as typeof fetch
    clientMocks.postVerify.mockRejectedValueOnce(
      Object.assign(new Error('Invalid or missing H5 access token'), { status: 401 }),
    )

    await expect(saveAndVerifyH5Connection('https://public.example.com/app', 'stale-token')).rejects.toMatchObject({
      name: 'H5ConnectionRequiredError',
      serverUrl: 'https://public.example.com/app',
      message: 'The saved H5 token is no longer valid.',
    } satisfies Partial<H5ConnectionRequiredError>)

    expect(window.localStorage.getItem(H5_SERVER_URL_STORAGE_KEY)).toBe(
      'https://public.example.com/app',
    )
    expect(window.localStorage.getItem(H5_TOKEN_STORAGE_KEY)).toBeNull()
  })

  it('does not reuse stored remote H5 tokens for loopback browser startup', async () => {
    window.history.pushState({}, '', '/?serverUrl=http%3A%2F%2F%5B%3A%3A1%5D%3A3456')
    window.localStorage.setItem(H5_TOKEN_STORAGE_KEY, 'remote-token')
    globalThis.fetch = vi.fn().mockResolvedValue(
      healthOkResponse(),
    ) as typeof fetch

    await expect(initializeDesktopServerUrl()).resolves.toBe('http://[::1]:3456')

    expect(clientMocks.setBaseUrl).toHaveBeenLastCalledWith('http://[::1]:3456')
    expect(clientMocks.setAuthToken).toHaveBeenLastCalledWith(null)
    expect(clientMocks.postVerify).not.toHaveBeenCalled()
  })

  it('does not send a stored H5 token to a different query-selected server', async () => {
    window.localStorage.setItem(H5_SERVER_URL_STORAGE_KEY, 'https://paired.example/app')
    window.localStorage.setItem(H5_TOKEN_STORAGE_KEY, 'paired-server-token')
    window.history.pushState({}, '', '/?serverUrl=https%3A%2F%2Fattacker.example%2Fapp')
    globalThis.fetch = vi.fn().mockResolvedValue(
      healthOkResponse(),
    ) as typeof fetch

    await expect(initializeDesktopServerUrl()).rejects.toMatchObject({
      name: 'H5ConnectionRequiredError',
      serverUrl: 'https://attacker.example/app',
      reason: 'missing-token',
    } satisfies Partial<H5ConnectionRequiredError>)

    expect(clientMocks.setAuthToken).toHaveBeenLastCalledWith(null)
    expect(clientMocks.postVerify).not.toHaveBeenCalled()
  })

  it('reuses a stored H5 token only for its normalized server URL', async () => {
    window.localStorage.setItem(H5_SERVER_URL_STORAGE_KEY, 'https://paired.example/app/')
    window.localStorage.setItem(H5_TOKEN_STORAGE_KEY, 'paired-server-token')
    window.history.pushState({}, '', '/?serverUrl=https%3A%2F%2Fpaired.example%2Fapp')
    globalThis.fetch = vi.fn().mockResolvedValue(
      healthOkResponse(),
    ) as typeof fetch
    clientMocks.postVerify.mockResolvedValueOnce({ ok: true })

    await expect(initializeDesktopServerUrl()).resolves.toBe('https://paired.example/app')

    expect(clientMocks.setAuthToken).toHaveBeenLastCalledWith('paired-server-token')
    expect(clientMocks.postVerify).toHaveBeenCalledWith('/api/h5-access/verify')
  })

  it('uses the current browser origin when the H5 shell is served by the desktop server', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      healthOkResponse(),
    ) as typeof fetch

    await expect(initializeDesktopServerUrl()).resolves.toBe(window.location.origin)

    expect(clientMocks.setBaseUrl).toHaveBeenLastCalledWith(window.location.origin)
    expect(clientMocks.setAuthToken).toHaveBeenLastCalledWith(null)
    expect(globalThis.fetch).toHaveBeenCalledWith(`${window.location.origin}/health`, {
      cache: 'no-store',
    })
    expect(globalThis.fetch).toHaveBeenCalledWith(`${window.location.origin}/api/status`, {
      cache: 'no-store',
    })
  })

  it('uses an injected desktop host server URL before browser fallback', async () => {
    const serverUrl = 'http://127.0.0.1:59231'
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      runtime: {
        getServerUrl: vi.fn().mockResolvedValue(serverUrl),
        getLocalAccessToken: vi.fn().mockResolvedValue('desktop-local-token'),
      },
    }
    globalThis.fetch = vi.fn().mockResolvedValue(
      healthOkResponse(),
    ) as typeof fetch

    await expect(initializeDesktopServerUrl()).resolves.toBe(serverUrl)

    expect(window.desktopHost.runtime.getServerUrl).toHaveBeenCalledTimes(1)
    expect(clientMocks.setBaseUrl).toHaveBeenLastCalledWith(serverUrl)
    expect(clientMocks.setAuthToken).toHaveBeenLastCalledWith('desktop-local-token')
    expect(globalThis.fetch).toHaveBeenCalledWith(`${serverUrl}/health`, {
      cache: 'no-store',
    })
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('still starts when the desktop host cannot resolve the local access token', async () => {
    // The token only raises what the shell may do — loopback is trusted without
    // it — so losing it must degrade rather than block startup.
    const serverUrl = 'http://127.0.0.1:59232'
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      runtime: {
        getServerUrl: vi.fn().mockResolvedValue(serverUrl),
        getLocalAccessToken: vi.fn().mockRejectedValue(new Error('ipc channel missing')),
      },
    }
    globalThis.fetch = vi.fn().mockResolvedValue(
      healthOkResponse(),
    ) as typeof fetch

    await expect(initializeDesktopServerUrl()).resolves.toBe(serverUrl)

    expect(clientMocks.setBaseUrl).toHaveBeenLastCalledWith(serverUrl)
    expect(clientMocks.setAuthToken).toHaveBeenLastCalledWith(null)
    expect(consoleWarn).toHaveBeenCalled()

    consoleWarn.mockRestore()
  })

  it('classifies browser H5 runtime using the desktop host boundary', () => {
    expect(isBrowserH5Runtime()).toBe(true)
    expect(isDesktopRuntime()).toBe(false)

    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
    }

    expect(isBrowserH5Runtime()).toBe(false)
    expect(isDesktopRuntime()).toBe(true)
  })

  it('normalizes injected desktop host startup failures', async () => {
    const error = new Error('electron sidecar failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      runtime: {
        getServerUrl: vi.fn().mockRejectedValue(error),
        getLocalAccessToken: vi.fn().mockResolvedValue('desktop-local-token'),
      },
    }

    await expect(initializeDesktopServerUrl()).rejects.toThrow('electron sidecar failed')
    expect(consoleError).toHaveBeenCalledWith(
      '[desktop] Failed to initialize desktop server URL',
      error,
    )

    consoleError.mockRestore()
  })

  it('falls back to the default backend when a loopback dev origin serves a Vite SPA fallback', async () => {
    vi.useFakeTimers()
    globalThis.fetch = vi.fn((input) => {
      if (String(input) === `${window.location.origin}/health`) {
        return Promise.resolve(new Response('<!doctype html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }))
      }
      return Promise.resolve(healthOkResponse())
    }) as typeof fetch

    const startup = expect(initializeDesktopServerUrl()).resolves.toBe('http://127.0.0.1:3456')
    await vi.runAllTimersAsync()

    await startup
    expect(clientMocks.setBaseUrl).toHaveBeenLastCalledWith('http://127.0.0.1:3456')
    expect(clientMocks.setAuthToken).toHaveBeenLastCalledWith(null)
    expect(globalThis.fetch).toHaveBeenCalledWith(`${window.location.origin}/health`, {
      cache: 'no-store',
    })
    expect(globalThis.fetch).toHaveBeenCalledWith('http://127.0.0.1:3456/health', {
      cache: 'no-store',
    })
  })

  it('does not fall back when an explicit Vite desktop server URL returns a SPA fallback', async () => {
    vi.useFakeTimers()
    clientMocks.defaultBaseUrl = 'http://127.0.0.1:55189'
    clientMocks.explicitDefaultBaseUrl = true
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('<!doctype html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    ) as typeof fetch

    const startup = expect(initializeDesktopServerUrl()).rejects.toThrow(
      'Server healthcheck failed: healthcheck returned non-JSON response from http://127.0.0.1:55189/health',
    )
    await vi.runAllTimersAsync()

    await startup
    expect(clientMocks.setBaseUrl).toHaveBeenLastCalledWith('http://127.0.0.1:55189')
  })

  it('does not fall back from a loopback dev origin to a non-loopback default backend', async () => {
    vi.useFakeTimers()
    clientMocks.defaultBaseUrl = 'https://public.example.com'
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('<!doctype html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    ) as typeof fetch

    const startup = expect(initializeDesktopServerUrl()).rejects.toThrow(
      `Server healthcheck failed: healthcheck returned non-JSON response from ${window.location.origin}/health`,
    )
    await vi.runAllTimersAsync()

    await startup
    expect(clientMocks.setBaseUrl).toHaveBeenLastCalledWith(window.location.origin)
  })

  it('does not fall back from a loopback dev origin to an invalid default backend', async () => {
    vi.useFakeTimers()
    clientMocks.defaultBaseUrl = 'not-a-url'
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('<!doctype html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    ) as typeof fetch

    const startup = expect(initializeDesktopServerUrl()).rejects.toThrow(
      `Server healthcheck failed: healthcheck returned non-JSON response from ${window.location.origin}/health`,
    )
    await vi.runAllTimersAsync()

    await startup
    expect(clientMocks.setBaseUrl).toHaveBeenLastCalledWith(window.location.origin)
  })

  it('prefers an explicit Vite desktop server URL over the dev server origin', async () => {
    clientMocks.defaultBaseUrl = 'http://127.0.0.1:55189'
    clientMocks.explicitDefaultBaseUrl = true
    window.history.pushState({}, '', '/')
    globalThis.fetch = vi.fn().mockResolvedValue(
      healthOkResponse(),
    ) as typeof fetch

    await expect(initializeDesktopServerUrl()).resolves.toBe('http://127.0.0.1:55189')

    expect(clientMocks.setBaseUrl).toHaveBeenLastCalledWith('http://127.0.0.1:55189')
    expect(clientMocks.setAuthToken).toHaveBeenLastCalledWith(null)
    expect(globalThis.fetch).toHaveBeenCalledWith('http://127.0.0.1:55189/health', {
      cache: 'no-store',
    })
    expect(globalThis.fetch).toHaveBeenCalledWith('http://127.0.0.1:55189/api/status', {
      cache: 'no-store',
    })
  })

  it('prefers an explicit Vite desktop server URL over a remembered H5 server URL', async () => {
    clientMocks.defaultBaseUrl = 'http://127.0.0.1:55189'
    clientMocks.explicitDefaultBaseUrl = true
    window.history.pushState({}, '', '/')
    window.localStorage.setItem(H5_SERVER_URL_STORAGE_KEY, 'http://192.168.0.102:3456')
    window.localStorage.setItem(H5_TOKEN_STORAGE_KEY, 'stale-h5-token')
    globalThis.fetch = vi.fn().mockResolvedValue(
      healthOkResponse(),
    ) as typeof fetch

    await expect(initializeDesktopServerUrl()).resolves.toBe('http://127.0.0.1:55189')

    expect(clientMocks.setBaseUrl).toHaveBeenLastCalledWith('http://127.0.0.1:55189')
    expect(clientMocks.setAuthToken).toHaveBeenLastCalledWith(null)
    expect(clientMocks.postVerify).not.toHaveBeenCalled()
    expect(globalThis.fetch).toHaveBeenCalledWith('http://127.0.0.1:55189/api/status', {
      cache: 'no-store',
    })
  })

  it('normalizes unreachable remote browser startup into a recoverable H5 error', async () => {
    vi.useFakeTimers()
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as typeof fetch

    const startup = expect(saveAndVerifyH5Connection('https://unreachable.example.com', 'h5_token')).rejects.toMatchObject({
      name: 'H5ConnectionRequiredError',
      serverUrl: 'https://unreachable.example.com',
      message: 'Unable to reach https://unreachable.example.com. Check the server URL or network access.',
    } satisfies Partial<H5ConnectionRequiredError>)
    await vi.runAllTimersAsync()

    await startup

    expect(window.localStorage.getItem(H5_SERVER_URL_STORAGE_KEY)).toBe(
      'https://unreachable.example.com',
    )
  })

  it('normalizes remote verify failures like disabled H5 or CORS into recoverable H5 errors', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      healthOkResponse(),
    ) as typeof fetch
    clientMocks.postVerify.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    await expect(saveAndVerifyH5Connection('https://public.example.com', 'h5_token')).rejects.toMatchObject({
      name: 'H5ConnectionRequiredError',
      serverUrl: 'https://public.example.com',
      message: 'Unable to verify the H5 access token.',
    } satisfies Partial<H5ConnectionRequiredError>)

    expect(window.localStorage.getItem(H5_SERVER_URL_STORAGE_KEY)).toBe(
      'https://public.example.com',
    )
    expect(window.localStorage.getItem(H5_TOKEN_STORAGE_KEY)).toBeNull()
  })

  it('requires a token when browser WebUI connects to a LAN-bound server', async () => {
    window.history.pushState({}, '', '/?serverUrl=http%3A%2F%2F192.168.0.102%3A28670')
    globalThis.fetch = vi.fn().mockResolvedValue(
      healthOkResponse(),
    ) as typeof fetch

    await expect(initializeDesktopServerUrl()).rejects.toMatchObject({
      name: 'H5ConnectionRequiredError',
      serverUrl: 'http://192.168.0.102:28670',
      reason: 'missing-token',
    } satisfies Partial<H5ConnectionRequiredError>)

    expect(clientMocks.setBaseUrl).toHaveBeenLastCalledWith('http://192.168.0.102:28670')
    expect(clientMocks.setAuthToken).toHaveBeenLastCalledWith(null)
    expect(clientMocks.postVerify).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(H5_SERVER_URL_STORAGE_KEY)).toBe('http://192.168.0.102:28670')
  })

  it('keeps the saved pairing through transient verification failure and reconnects without scanning', async () => {
    const server = 'https://paired.example/app'
    localStorage.setItem(H5_SERVER_URL_STORAGE_KEY, server)
    localStorage.setItem(H5_TOKEN_STORAGE_KEY, 'remembered-token')
    history.replaceState(null, '', '/?serverUrl=' + encodeURIComponent(server))
    globalThis.fetch = vi.fn().mockImplementation(async () => healthOkResponse()) as typeof fetch
    clientMocks.postVerify.mockRejectedValueOnce(new TypeError('Network unavailable')).mockResolvedValueOnce({ ok: true })
    await expect(initializeDesktopServerUrl()).rejects.toMatchObject({ reason: 'verify-failed' })
    expect(localStorage.getItem(H5_TOKEN_STORAGE_KEY)).toBe('remembered-token')
    await expect(initializeDesktopServerUrl()).resolves.toBe(server)
    expect(clientMocks.setAuthToken).toHaveBeenLastCalledWith('remembered-token')
  })

  it('keeps an existing valid pairing when the camera opens an older QR link', async () => {
    const server = 'https://paired.example/app'
    localStorage.setItem(H5_SERVER_URL_STORAGE_KEY, server)
    localStorage.setItem(H5_TOKEN_STORAGE_KEY, 'current-token')
    history.replaceState(null, '', '/?serverUrl=' + encodeURIComponent(server) + '&h5Token=old-qr-token&keep=yes')
    globalThis.fetch = vi.fn().mockImplementation(async () => healthOkResponse()) as typeof fetch
    clientMocks.postVerify.mockResolvedValueOnce({ ok: true })
    await expect(initializeDesktopServerUrl()).resolves.toBe(server)
    expect(clientMocks.setAuthToken).toHaveBeenLastCalledWith('current-token')
    expect(localStorage.getItem(H5_TOKEN_STORAGE_KEY)).toBe('current-token')
    expect(location.search).not.toContain('h5Token')
    expect(new URLSearchParams(location.search).get('keep')).toBe('yes')
  })

  it('can replace an expired stored token with a fresh camera QR token', async () => {
    const server = 'https://paired.example/app'
    localStorage.setItem(H5_SERVER_URL_STORAGE_KEY, server)
    localStorage.setItem(H5_TOKEN_STORAGE_KEY, 'expired-token')
    history.replaceState(null, '', '/?serverUrl=' + encodeURIComponent(server) + '&h5Token=fresh-token')
    globalThis.fetch = vi.fn().mockImplementation(async () => healthOkResponse()) as typeof fetch
    clientMocks.postVerify.mockRejectedValueOnce(Object.assign(new Error('Invalid token'), { status: 401 })).mockResolvedValueOnce({ ok: true })
    await expect(initializeDesktopServerUrl()).resolves.toBe(server)
    expect(clientMocks.setAuthToken).toHaveBeenLastCalledWith('fresh-token')
    expect(localStorage.getItem(H5_TOKEN_STORAGE_KEY)).toBe('fresh-token')
  })

  it('does not erase another server pairing when an unpaired QR destination is opened', async () => {
    localStorage.setItem(H5_SERVER_URL_STORAGE_KEY, 'https://paired.example')
    localStorage.setItem(H5_TOKEN_STORAGE_KEY, 'paired-token')
    history.replaceState(null, '', '/?serverUrl=https%3A%2F%2Funpaired.example')
    globalThis.fetch = vi.fn().mockImplementation(async () => healthOkResponse()) as typeof fetch
    await expect(initializeDesktopServerUrl()).rejects.toMatchObject({ reason: 'missing-token' })
    expect(localStorage.getItem(H5_SERVER_URL_STORAGE_KEY)).toBe('https://paired.example')
    expect(localStorage.getItem(H5_TOKEN_STORAGE_KEY)).toBe('paired-token')
  })

  it('preserves the legacy stored pairing while the desktop is offline', async () => {
    vi.useFakeTimers()
    localStorage.setItem(H5_SERVER_URL_STORAGE_KEY, 'https://paired.example')
    localStorage.setItem(H5_TOKEN_STORAGE_KEY, 'saved-token')
    history.replaceState(null, '', '/?serverUrl=https%3A%2F%2Fpaired.example')
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Offline')) as typeof fetch
    const result = expect(initializeDesktopServerUrl()).rejects.toMatchObject({ reason: 'unreachable' })
    await vi.runAllTimersAsync()
    await result
    expect(localStorage.getItem(H5_TOKEN_STORAGE_KEY)).toBe('saved-token')
  })

  it('forgets only a saved token explicitly rejected by its own server', async () => {
    localStorage.setItem(H5_SERVER_URL_STORAGE_KEY, 'https://paired.example')
    localStorage.setItem(H5_TOKEN_STORAGE_KEY, 'revoked-token')
    history.replaceState(null, '', '/?serverUrl=https%3A%2F%2Fpaired.example')
    globalThis.fetch = vi.fn().mockImplementation(async () => healthOkResponse()) as typeof fetch
    clientMocks.postVerify.mockRejectedValueOnce(Object.assign(new Error('Invalid token'), { status: 401 }))
    await expect(initializeDesktopServerUrl()).rejects.toMatchObject({ reason: 'invalid-token' })
    expect(localStorage.getItem(H5_TOKEN_STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem(H5_SERVER_URL_STORAGE_KEY)).toBe('https://paired.example')
  })

  it('uses and persists an H5 token from the QR launch URL', async () => {
    window.history.pushState({}, '', '/?serverUrl=https%3A%2F%2Fpublic.example.com%2Fapp&h5Token=qr-token')
    globalThis.fetch = vi.fn().mockResolvedValue(
      healthOkResponse(),
    ) as typeof fetch
    clientMocks.postVerify.mockResolvedValueOnce({ ok: true })

    await expect(initializeDesktopServerUrl()).resolves.toBe('https://public.example.com/app')

    expect(clientMocks.setBaseUrl).toHaveBeenLastCalledWith('https://public.example.com/app')
    expect(clientMocks.setAuthToken).toHaveBeenLastCalledWith('qr-token')
    expect(clientMocks.postVerify).toHaveBeenCalledWith('/api/h5-access/verify')
    expect(window.localStorage.getItem(H5_TOKEN_STORAGE_KEY)).toBe('qr-token')
  })

  it('shows the H5 token recovery view when a local browser connects to an auth-required LAN server', async () => {
    window.history.pushState({}, '', '/?serverUrl=http%3A%2F%2F192.168.0.102%3A28670')
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(healthOkResponse())
      .mockResolvedValueOnce(new Response(null, { status: 401 })) as typeof fetch

    await expect(initializeDesktopServerUrl()).rejects.toMatchObject({
      name: 'H5ConnectionRequiredError',
      serverUrl: 'http://192.168.0.102:28670',
      reason: 'missing-token',
    } satisfies Partial<H5ConnectionRequiredError>)
  })
})
