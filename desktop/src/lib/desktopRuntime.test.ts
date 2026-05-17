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
  isLoopbackHostname,
  requiresH5AuthForServerUrl,
  saveAndVerifyH5Connection,
} from './desktopRuntime'

function healthOkResponse() {
  return Response.json({ status: 'ok' })
}

describe('desktopRuntime browser H5 bootstrap', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.clearAllMocks()
    clientMocks.defaultBaseUrl = 'http://127.0.0.1:3456'
    clientMocks.explicitDefaultBaseUrl = false
    vi.useRealTimers()
    window.localStorage.clear()
    window.history.pushState({}, '', '/')
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.fetch = originalFetch
  })

  it('treats IPv6 loopback as local', () => {
    expect(isLoopbackHostname('[::1]')).toBe(true)
    expect(isLoopbackHostname('::1')).toBe(true)
    expect(requiresH5AuthForServerUrl('http://[::1]:3456')).toBe(false)
    expect(requiresH5AuthForServerUrl('http://127.0.0.1:3456')).toBe(false)
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

  it('does not treat a Vite SPA fallback response as a desktop server healthcheck', async () => {
    vi.useFakeTimers()
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
    expect(clientMocks.setAuthToken).toHaveBeenLastCalledWith(null)
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
