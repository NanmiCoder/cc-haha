import AsyncStorage from '@react-native-async-storage/async-storage'
import { DEFAULT_SERVER_URL, SERVER_ACCESS_TOKEN_KEY, SERVER_URL_KEY } from '../constants/config'

let baseUrl = DEFAULT_SERVER_URL
let accessToken = ''
const REQUEST_TIMEOUT_MS = 8000

export async function initBaseUrl() {
  try {
    const [savedUrl, savedToken] = await Promise.all([
      AsyncStorage.getItem(SERVER_URL_KEY),
      AsyncStorage.getItem(SERVER_ACCESS_TOKEN_KEY),
    ])

    if (savedUrl) {
      baseUrl = savedUrl
    }
    if (savedToken) {
      accessToken = savedToken
    }
  } catch (error) {
    console.error('Failed to load config:', error)
  }
}

export function setBaseUrl(url: string) {
  baseUrl = url.replace(/\/$/, '')
  void AsyncStorage.setItem(SERVER_URL_KEY, baseUrl)
}

export function getBaseUrl() {
  return baseUrl
}

export function getDefaultBaseUrl() {
  return DEFAULT_SERVER_URL
}

export async function setAccessToken(token: string) {
  accessToken = token
  await AsyncStorage.setItem(SERVER_ACCESS_TOKEN_KEY, token)
}

export function getAccessToken() {
  return accessToken
}

export async function clearAccessToken() {
  accessToken = ''
  await AsyncStorage.removeItem(SERVER_ACCESS_TOKEN_KEY)
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(getErrorMessage(status, body))
    this.name = 'ApiError'
  }
}

function getErrorMessage(status: number, body: unknown) {
  if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string') {
    return body.message
  }
  if (typeof body === 'string' && body.trim().length > 0) {
    return body
  }
  return `API error ${status}`
}

function describeServerUrl(url: string) {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return url
  }
}

function getConnectionSummary() {
  return {
    baseUrl: describeServerUrl(baseUrl),
    hasToken: accessToken.trim().length > 0,
    timeoutMs: REQUEST_TIMEOUT_MS,
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `${baseUrl}${path}`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const startedAt = Date.now()

  console.log(`[api] ${method} ${url} start`, getConnectionSummary())

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    const elapsedMs = Date.now() - startedAt

    console.log(`[api] ${method} ${url} response`, {
      status: res.status,
      ok: res.ok,
      elapsedMs,
    })

    if (!res.ok) {
      const errorBody = await res.json().catch(() => res.text())
      console.error(`[api] ${method} ${url} error body`, errorBody)
      throw new ApiError(res.status, errorBody)
    }

    if (res.status === 204) return undefined as T
    return res.json() as Promise<T>
  } catch (error) {
    const elapsedMs = Date.now() - startedAt
    const timedOut = error instanceof Error && error.name === 'AbortError'
    if (timedOut) {
      console.error(`[api] ${method} ${url} timed out`, {
        elapsedMs,
        timeoutMs: REQUEST_TIMEOUT_MS,
        summary: getConnectionSummary(),
      })
      throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${url}`)
    }
    console.error(`[api] ${method} ${url} failed after ${elapsedMs}ms:`, error)
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
}

export async function testConnection(): Promise<boolean> {
  console.log('[connection-test] start', getConnectionSummary())
  try {
    console.log('[connection-test] step 1/2 health')
    await api.get('/health')

    console.log('[connection-test] step 2/2 sessions')
    await api.get('/api/sessions?limit=1')
    console.log('[connection-test] success')
    return true
  } catch (error) {
    console.error('[connection-test] failed', {
      summary: getConnectionSummary(),
      error,
    })
    return false
  }
}
