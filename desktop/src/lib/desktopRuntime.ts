import {
  api,
  getBaseUrl,
  getDefaultBaseUrl,
  hasExplicitDefaultBaseUrl,
  setAuthToken,
  setBaseUrl,
} from '../api/client'
import { getDesktopHost } from './desktopHost'

export const H5_SERVER_URL_STORAGE_KEY = 'cc-haha-h5-server-url'
export const H5_TOKEN_STORAGE_KEY = 'cc-haha-h5-token'

type H5ConnectionFailureReason =
  | 'missing-token'
  | 'invalid-token'
  | 'verify-failed'
  | 'unreachable'

export type StoredH5Connection = {
  serverUrl: string | null
  token: string | null
}

export class H5ConnectionRequiredError extends Error {
  readonly serverUrl: string
  readonly reason: H5ConnectionFailureReason

  constructor(message: string, serverUrl: string, reason: H5ConnectionFailureReason) {
    super(message)
    this.name = 'H5ConnectionRequiredError'
    this.serverUrl = serverUrl
    this.reason = reason
  }
}

function getDetectedDesktopHost() {
  return getDesktopHost()
}

/**
 * Server-readiness signal.
 *
 * The api client points at the default base URL until `initializeDesktopServerUrl`
 * resolves the real (dynamic) server URL and confirms `/health`. Background pollers
 * that fire on app mount (e.g. scheduled-task desktop notifications) must wait for
 * this, otherwise their first requests hit an uninitialized base URL and fail with
 * `TypeError: Failed to fetch` — a benign startup race that nonetheless pollutes the
 * diagnostics panel with `client_api_request_failed` warnings.
 */
let resolveServerReady: (() => void) | null = null
let serverReadyPromise: Promise<void> | null = null

/** Resolve once the desktop/browser server URL is initialized and healthy. */
export function whenDesktopServerReady(): Promise<void> {
  if (!serverReadyPromise) {
    serverReadyPromise = new Promise<void>((resolve) => {
      resolveServerReady = resolve
    })
  }
  return serverReadyPromise
}

function markDesktopServerReady() {
  whenDesktopServerReady() // ensure the promise exists before resolving it
  resolveServerReady?.()
}

export function isDesktopRuntime() {
  return getDetectedDesktopHost().isDesktop
}

export function isBrowserH5Runtime() {
  return typeof window !== 'undefined' && !isDesktopRuntime()
}

/**
 * Synchronously return the running local server's base URL (e.g.
 * `http://127.0.0.1:<port>`).
 *
 * The api client caches the resolved base after startup: `initializeDesktopServerUrl`
 * calls `invoke('get_server_url')` (desktop) or resolves a browser/H5 URL, then
 * `setBaseUrl(...)`. Until that runs, `getBaseUrl()` returns the default
 * (`http://127.0.0.1:3456` or `VITE_DESKTOP_SERVER_URL`).
 */
export function getServerBaseUrl(): string {
  return getBaseUrl()
}

export function readStoredH5Connection(): StoredH5Connection {
  if (typeof window === 'undefined') {
    return { serverUrl: null, token: null }
  }

  try {
    return {
      serverUrl: normalizeServerUrl(window.localStorage.getItem(H5_SERVER_URL_STORAGE_KEY)),
      token: normalizeToken(window.localStorage.getItem(H5_TOKEN_STORAGE_KEY)),
    }
  } catch {
    return { serverUrl: null, token: null }
  }
}

export function clearStoredH5Connection() {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(H5_SERVER_URL_STORAGE_KEY)
      window.localStorage.removeItem(H5_TOKEN_STORAGE_KEY)
    } catch {
      // Ignore storage failures
    }
  }

  setAuthToken(null)
}

export async function saveAndVerifyH5Connection(serverUrl: string, token: string) {
  const normalizedServerUrl = normalizeServerUrl(serverUrl)
  const normalizedToken = normalizeToken(token)

  if (!normalizedServerUrl) {
    throw new Error('Enter a valid server URL.')
  }

  if (!normalizedToken) {
    throw new Error('Enter your H5 access token.')
  }

  setBaseUrl(normalizedServerUrl)
  setAuthToken(normalizedToken)
  rememberStoredH5ServerUrl(normalizedServerUrl)

  try {
    await waitForHealth(normalizedServerUrl)
    await verifyH5Access()
  } catch (error) {
    clearStoredH5Token()
    throw normalizeBrowserH5Error(error, normalizedServerUrl)
  }

  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(H5_TOKEN_STORAGE_KEY, normalizedToken)
    } catch {
      // Ignore storage failures after a successful verification.
    }
  }

  return normalizedServerUrl
}

export function isH5ConnectionRequiredError(error: unknown): error is H5ConnectionRequiredError {
  return error instanceof H5ConnectionRequiredError
}

export async function initializeDesktopServerUrl() {
  const fallbackUrl = getDefaultBaseUrl()
  const host = getDetectedDesktopHost()

  if (!host.isDesktop) {
    return initializeBrowserServerUrl(fallbackUrl)
  }

  try {
    const [serverUrl, localAccessToken] = await Promise.all([
      host.runtime.getServerUrl(),
      host.runtime.getLocalAccessToken(),
    ])
    setBaseUrl(serverUrl)
    setAuthToken(localAccessToken)
    await waitForHealth(serverUrl)
    markDesktopServerReady()
    return serverUrl
  } catch (error) {
    const message =
      error instanceof Error ? error.message : `desktop server startup failed: ${String(error)}`
    console.error('[desktop] Failed to initialize desktop server URL', error)
    throw new Error(message || `desktop server startup failed (fallback would be ${fallbackUrl})`)
  }
}

async function initializeBrowserServerUrl(fallbackUrl: string) {
  const query = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search)
    : null
  const queryUrl = query?.get('serverUrl') ?? null
  const queryToken = normalizeToken(query?.get('h5Token') ?? query?.get('token'))
  const stored = readStoredH5Connection()
  const configuredUrl = getConfiguredBrowserServerUrl(fallbackUrl)
  const sameOriginUrl = getSameOriginServerUrl()
  const requestedUrl =
    normalizeServerUrl(queryUrl) ??
    configuredUrl ??
    stored.serverUrl ??
    fallbackUrl
  const requestedImplicitSameOrigin =
    !queryUrl &&
    !hasExplicitDefaultBaseUrl() &&
    !!sameOriginUrl &&
    requestedUrl === sameOriginUrl
  const token = queryToken ?? stored.token
  const browserH5Runtime = requiresH5AuthForServerUrl(requestedUrl)

  setBaseUrl(requestedUrl)
  setAuthToken(browserH5Runtime ? token : null)
  if (browserH5Runtime) {
    rememberStoredH5ServerUrl(requestedUrl)
  }

  try {
    await waitForHealth(requestedUrl)
  } catch (error) {
    if (shouldFallbackFromLoopbackDevOrigin({
      error,
      requestedUrl,
      fallbackUrl,
      requestedImplicitSameOrigin,
    })) {
      setBaseUrl(fallbackUrl)
      setAuthToken(null)
      await waitForHealth(fallbackUrl)
      await ensureBrowserApiAccessibleWithoutH5(fallbackUrl)
      markDesktopServerReady()
      return fallbackUrl
    }

    if (browserH5Runtime) {
      clearStoredH5Token()
      throw normalizeBrowserH5Error(error, requestedUrl)
    }
    throw error
  }

  if (!browserH5Runtime) {
    await ensureBrowserApiAccessibleWithoutH5(requestedUrl)
    markDesktopServerReady()
    return requestedUrl
  }

  if (!token) {
    clearStoredH5Token()
    throw new H5ConnectionRequiredError(
      'Enter your H5 token to continue.',
      requestedUrl,
      'missing-token',
    )
  }

  try {
    await verifyH5Access()
  } catch (error) {
    clearStoredH5Token()
    throw normalizeBrowserH5Error(error, requestedUrl)
  }

  if (queryToken && typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(H5_TOKEN_STORAGE_KEY, queryToken)
    } catch {
      // Ignore storage failures after successful verification.
    }
  }

  markDesktopServerReady()
  return requestedUrl
}

async function waitForHealth(serverUrl: string) {
  let lastError: unknown

  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`${serverUrl}/health`, {
        cache: 'no-store',
      })
      if (response.ok) {
        const contentType = response.headers.get('content-type') ?? ''
        if (!contentType.toLowerCase().includes('application/json')) {
          lastError = new Error(`healthcheck returned non-JSON response from ${serverUrl}/health`)
          break
        } else {
          const body = await response.json().catch(() => null)
          if (body && typeof body === 'object' && 'status' in body && body.status === 'ok') {
            return
          }
          lastError = new Error(`healthcheck returned invalid response from ${serverUrl}/health`)
        }
      } else {
        lastError = new Error(`healthcheck returned ${response.status}`)
      }
    } catch (error) {
      lastError = error
    }

    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  throw new Error(
    lastError instanceof Error
      ? `Server healthcheck failed: ${lastError.message}`
      : 'Server healthcheck failed',
  )
}

async function verifyH5Access() {
  await api.post<{ ok: true }>('/api/h5-access/verify')
}

async function ensureBrowserApiAccessibleWithoutH5(serverUrl: string) {
  const response = await fetch(`${serverUrl}/api/status`, {
    cache: 'no-store',
  })
  if (response.status === 401) {
    throw new H5ConnectionRequiredError(
      'Enter your H5 token to continue.',
      serverUrl,
      'missing-token',
    )
  }
}

function normalizeServerUrl(value: string | null | undefined) {
  const trimmed = value?.trim()
  if (!trimmed) return null

  try {
    return new URL(trimmed).toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

function normalizeToken(value: string | null | undefined) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function getSameOriginServerUrl() {
  if (typeof window === 'undefined') {
    return null
  }

  if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') {
    return null
  }

  return normalizeServerUrl(window.location.origin)
}

function getConfiguredBrowserServerUrl(fallbackUrl: string) {
  if (hasExplicitDefaultBaseUrl()) {
    return normalizeServerUrl(fallbackUrl)
  }

  return getSameOriginServerUrl()
}

function shouldFallbackFromLoopbackDevOrigin({
  error,
  requestedUrl,
  fallbackUrl,
  requestedImplicitSameOrigin,
}: {
  error: unknown
  requestedUrl: string
  fallbackUrl: string
  requestedImplicitSameOrigin: boolean
}) {
  if (!requestedImplicitSameOrigin || requestedUrl === fallbackUrl) {
    return false
  }

  if (!isLoopbackServerUrl(requestedUrl) || !isLoopbackServerUrl(fallbackUrl)) {
    return false
  }

  return error instanceof Error &&
    error.message.includes('healthcheck returned non-JSON response')
}

export function isLoopbackHostname(hostname: string) {
  const normalized = hostname.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  return normalized === 'localhost' || normalized === '::1' || isLoopbackIPv4(normalized)
}

function isLoopbackServerUrl(serverUrl: string) {
  try {
    return isLoopbackHostname(new URL(serverUrl).hostname)
  } catch {
    return false
  }
}

function isLoopbackIPv4(hostname: string) {
  const parts = hostname.split('.')
  if (parts.length !== 4 || parts[0] !== '127') {
    return false
  }

  return parts.every((part) => {
    if (!/^\d+$/.test(part)) {
      return false
    }

    const value = Number(part)
    return value >= 0 && value <= 255
  })
}

export function requiresH5AuthForServerUrl(serverUrl: string, browserHostname = getBrowserHostname()) {
  void browserHostname
  try {
    return !isLoopbackHostname(new URL(serverUrl).hostname)
  } catch {
    return false
  }
}

function getBrowserHostname() {
  if (typeof window === 'undefined') return null
  return window.location.hostname
}

function normalizeBrowserH5Error(error: unknown, serverUrl: string) {
  if (error instanceof H5ConnectionRequiredError) {
    return error
  }

  if (error instanceof Error && error.message.startsWith('Server healthcheck failed')) {
    return new H5ConnectionRequiredError(
      `Unable to reach ${serverUrl}. Check the server URL or network access.`,
      serverUrl,
      'unreachable',
    )
  }

  const message =
    error instanceof Error ? error.message : 'Unable to verify the H5 access token.'
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? (error as { status?: unknown }).status
    : undefined
  const unauthorized = status === 401 || message.includes('401') || message.toLowerCase().includes('unauthorized')
  return new H5ConnectionRequiredError(
    unauthorized ? 'The saved H5 token is no longer valid.' : 'Unable to verify the H5 access token.',
    serverUrl,
    unauthorized ? 'invalid-token' : 'verify-failed',
  )
}

function rememberStoredH5ServerUrl(serverUrl: string) {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(H5_SERVER_URL_STORAGE_KEY, serverUrl)
  } catch {
    // Ignore storage failures.
  }
}

function clearStoredH5Token() {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(H5_TOKEN_STORAGE_KEY)
    } catch {
      // Ignore storage failures.
    }
  }

  setAuthToken(null)
}
