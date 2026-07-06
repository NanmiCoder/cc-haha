import { getDefaultBaseUrl, setAccessToken, setBaseUrl } from '../api/client'

export function isTauriRuntime() {
  if (typeof window === 'undefined') return false
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window
}

export async function initializeDesktopServerUrl() {
  const fallbackUrl = getDefaultBaseUrl()
  const queryUrl =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('serverUrl')
      : null
  const requestedUrl = queryUrl?.trim() || fallbackUrl

  if (!isTauriRuntime()) {
    setBaseUrl(requestedUrl)
    await waitForHealth(requestedUrl)
    return requestedUrl
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const serverUrl = await invoke<string>('get_server_url')
    const token = await invoke<string>('get_server_access_token').catch(() => '')
    setBaseUrl(serverUrl)
    setAccessToken(token)
    await waitForHealth(serverUrl)
    return serverUrl
  } catch (error) {
    const message =
      error instanceof Error ? error.message : `desktop server startup failed: ${String(error)}`
    console.error('[desktop] Failed to initialize desktop server URL', error)
    throw new Error(message || `desktop server startup failed (fallback would be ${fallbackUrl})`)
  }
}

async function waitForHealth(serverUrl: string) {
  let lastError: unknown

  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`${serverUrl}/health`, {
        cache: 'no-store',
      })
      if (response.ok) {
        return
      }
      lastError = new Error(`healthcheck returned ${response.status}`)
    } catch (error) {
      lastError = error
    }

    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  throw new Error(
    lastError instanceof Error
      ? `Local server healthcheck failed: ${lastError.message}`
      : 'Local server healthcheck failed',
  )
}
