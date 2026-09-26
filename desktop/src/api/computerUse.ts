import { api, apiGetBlob } from './client'

/**
 * Opening the picker renders every installed application at once. Without a
 * ceiling that is one request — and one `sips` subprocess on the server — per
 * row, all at the same instant. Six keeps the list filling visibly while the
 * machine stays responsive.
 */
const ICON_CONCURRENCY = 6
let activeIconRequests = 0
const iconWaiters: Array<() => void> = []

async function withIconSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeIconRequests >= ICON_CONCURRENCY) {
    await new Promise<void>(resolve => iconWaiters.push(resolve))
  }
  activeIconRequests += 1
  try {
    return await task()
  } finally {
    activeIconRequests -= 1
    iconWaiters.shift()?.()
  }
}

/** Resolved icons, including the misses — null means "this bundle has none". */
const iconCache = new Map<string, string | null>()
const iconRequests = new Map<string, Promise<string | null>>()

function loadAppIconUrl(bundleId: string, size: number): Promise<string | null> {
  const key = `${bundleId}:${size}`
  const cached = iconCache.get(key)
  // `undefined` is "never asked"; `null` is a cached miss and must not retry —
  // a list that re-renders would otherwise re-request every iconless bundle.
  if (cached !== undefined) return Promise.resolve(cached)

  const pending = iconRequests.get(key)
  if (pending) return pending

  const request = withIconSlot(async () => {
    try {
      const blob = await apiGetBlob(
        `/api/computer-use/app-icon?bundleId=${encodeURIComponent(bundleId)}&size=${size}`,
      )
      const url = URL.createObjectURL(blob)
      iconCache.set(key, url)
      return url
    } catch {
      iconCache.set(key, null)
      return null
    } finally {
      iconRequests.delete(key)
    }
  })
  iconRequests.set(key, request)
  return request
}

/**
 * Test hook: forget cached icons and release the concurrency gate.
 *
 * The gate counter and its waiter queue have to be reset too. They are module
 * state that no production path ever rewinds, so a case that leaves a request
 * in flight would otherwise hand the next case a permanently consumed slot —
 * and after enough of them, a queue that never drains.
 */
export function __resetAppIconCacheForTests(): void {
  iconCache.clear()
  iconRequests.clear()
  activeIconRequests = 0
  iconWaiters.splice(0).forEach(resume => resume())
}

export type ComputerUseStatus = {
  platform: string
  supported: boolean
  engine: 'macos-native' | 'windows-compat' | 'linux-x11' | 'unsupported'
  systemVersion: string | null
  arch: string
  /**
   * Native cu-helper engine availability. `available` is true only on macOS AND
   * when the Swift `cu-helper` binary resolves on the server. The settings page
   * branches on this to render the Codex-style native UI (no Python) instead of
   * the Python setup flow. Populated by the backend `checkStatus` (server
   * `EnvStatus.cuHelper`).
   */
  cuHelper: {
    available: boolean
    supported: boolean
    minimumMacosVersion: string
    reason:
      | 'unsupported_platform'
      | 'system_version_unknown'
      | 'os_too_old'
      | 'helper_missing'
      | null
  }
  python: {
    installed: boolean
    version: string | null
    path: string | null
    source: 'custom' | 'system' | 'venv' | null
    error: string | null
  }
  venv: {
    created: boolean
    path: string
  }
  dependencies: {
    installed: boolean
    requirementsFound: boolean
  }
  permissions: {
    accessibility: boolean | null
    screenRecording: boolean | null
    error?: string | null
  }
}

export type SetupStep = {
  name: string
  ok: boolean
  message: string
}

export type SetupResult = {
  success: boolean
  steps: SetupStep[]
}

export type InstalledApp = {
  bundleId: string
  displayName: string
  path: string
}

export type AuthorizedApp = {
  bundleId: string
  displayName: string
  authorizedAt: string
}

/**
 * Result of POST /api/computer-use/open-permission-card. `ok` is false (with a
 * `reason`) off macOS or when the cu-helper binary is missing. When the card
 * was shown, `accessibility`/`screenRecording` carry its final snapshot (may be
 * null if it could not be parsed); the page re-reads status afterward anyway.
 */
export type OpenPermissionCardResult = {
  ok: boolean
  reason?: string
  accessibility?: boolean | null
  screenRecording?: boolean | null
}

export type ComputerUseConfig = {
  enabled: boolean
  authorizedApps: AuthorizedApp[]
  grantFlags: {
    clipboardRead: boolean
    clipboardWrite: boolean
    systemKeyCombos: boolean
  }
  pythonPath: string | null
}

export const computerUseApi = {
  getStatus() {
    return api.get<ComputerUseStatus>('/api/computer-use/status')
  },
  runSetup() {
    return api.post<SetupResult>('/api/computer-use/setup', undefined, { timeout: 300_000 })
  },
  getInstalledApps() {
    return api.get<{ apps: InstalledApp[] }>('/api/computer-use/apps')
  },
  getAuthorizedApps() {
    return api.get<ComputerUseConfig>('/api/computer-use/authorized-apps')
  },
  /**
   * Patch the stored config. `grantFlags` is merged field-by-field on the
   * server, so a caller flipping one switch sends only that switch — a plain
   * `Partial<ComputerUseConfig>` would force it to restate the other flags,
   * and restating a stale value is how a grant gets silently reverted.
   */
  setAuthorizedApps(
    config: Partial<Omit<ComputerUseConfig, 'grantFlags'>> & {
      grantFlags?: Partial<ComputerUseConfig['grantFlags']>
    },
  ) {
    return api.put<{ ok: true }>('/api/computer-use/authorized-apps', config)
  },
  openSettings(pane: 'Privacy_ScreenCapture' | 'Privacy_Accessibility') {
    return api.post<{ ok: true }>('/api/computer-use/open-settings', { pane })
  },
  /**
   * A blob URL for an installed app's own icon, or null when it has none.
   *
   * Not an `<img src>` pointing at the endpoint: the packaged renderer is a
   * `file://` page, so that request is a cross-origin subresource the server
   * refuses (see `apiGetBlob`). The bytes come through the authenticated
   * channel instead and reach the DOM as a blob.
   *
   * macOS-only. A bundle with no icon resolves to null, which is an ordinary
   * outcome — the caller shows a letter tile.
   *
   * Results are cached per (bundle, size) and blob URLs are intentionally not
   * revoked: the cache hands out the same URL for the lifetime of the window,
   * so the count is bounded by the number of installed applications rather
   * than by how many times a list is rendered.
   */
  loadAppIcon(bundleId: string, size = 72): Promise<string | null> {
    return loadAppIconUrl(bundleId, size)
  },
  /**
   * macOS-only. Spawns the native `cu-helper request-access` permission card and
   * resolves ONLY when the user closes it (hence the long timeout, mirroring
   * runSetup's pattern), returning the card's final permission snapshot. Off
   * darwin or when the helper binary is missing the backend returns
   * `{ ok: false, reason }`. Callers should follow this with `getStatus()` to
   * re-read the authoritative permission state regardless of the snapshot.
   */
  openPermissionCard() {
    return api.post<OpenPermissionCardResult>(
      '/api/computer-use/open-permission-card',
      undefined,
      { timeout: 600_000 },
    )
  },
}
