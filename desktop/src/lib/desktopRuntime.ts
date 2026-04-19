import { getDefaultBaseUrl, setBaseUrl } from '../api/client'

export function isTauriRuntime() {
  if (typeof window === 'undefined') return false
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window
}

export async function initializeDesktopServerUrl() {
  const fallbackUrl = getDefaultBaseUrl()

  if (!isTauriRuntime()) {
    setBaseUrl(fallbackUrl)
    return fallbackUrl
  }

  try {
    const { invoke } = await import(/* @vite-ignore */ '@tauri-apps/api/core')
    const serverUrl = await invoke<string>('get_server_url')
    setBaseUrl(serverUrl)
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
