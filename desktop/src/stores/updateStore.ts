import { create } from 'zustand'
import { getDesktopHost } from '../lib/desktopHost'
import type { DesktopHost, DesktopUpdate } from '../lib/desktopHost'
import type { UpdateProxySettings } from '../types/settings'
import { useSettingsStore } from './settingsStore'

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'up-to-date'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'restarting'
  | 'error'

type CheckOptions = {
  silent?: boolean
  autoDownload?: boolean
}

const DISMISSED_UPDATE_VERSION_KEY = 'cc-haha-dismissed-update-version'

type UpdateStore = {
  status: UpdateStatus
  availableVersion: string | null
  releaseNotes: string | null
  progressPercent: number
  downloadedBytes: number
  totalBytes: number | null
  error: string | null
  checkedAt: number | null
  shouldPrompt: boolean
  initialize: () => Promise<void>
  checkForUpdates: (options?: CheckOptions) => Promise<DesktopUpdate | null>
  downloadUpdate: () => Promise<void>
  installUpdate: () => Promise<void>
  dismissPrompt: () => void
}

let pendingUpdate: DesktopUpdate | null = null
let pendingUpdateProxyKey: string | null = null
let pendingUpdateDownloaded = false
let downloadPromise: Promise<void> | null = null
let downloadingProxyKey: string | null = null
let startupCheckPromise: Promise<void> | null = null

function readDismissedUpdateVersion(): string | null {
  if (typeof window === 'undefined') return null

  try {
    return window.localStorage.getItem(DISMISSED_UPDATE_VERSION_KEY)
  } catch {
    return null
  }
}

function writeDismissedUpdateVersion(version: string | null) {
  if (typeof window === 'undefined') return

  try {
    if (version) {
      window.localStorage.setItem(DISMISSED_UPDATE_VERSION_KEY, version)
    } else {
      window.localStorage.removeItem(DISMISSED_UPDATE_VERSION_KEY)
    }
  } catch {
    // Ignore storage write failures.
  }
}

function getUpdateProxyUrl(settings: UpdateProxySettings = useSettingsStore.getState().updateProxy) {
  if (settings.mode !== 'manual') return null
  const proxy = settings.url.trim()
  return proxy || null
}

function getUpdateProxyKey(settings: UpdateProxySettings = useSettingsStore.getState().updateProxy) {
  const proxy = getUpdateProxyUrl(settings)
  return proxy ? `manual:${proxy}` : 'system'
}

function getUpdateCheckOptions() {
  const proxy = getUpdateProxyUrl()
  return proxy ? { proxy } : undefined
}

function getUpdateHost(): DesktopHost | null {
  const host = getDesktopHost()
  return host.capabilities.updates ? host : null
}

async function setPendingUpdate(next: DesktopUpdate | null, proxyKey: string | null) {
  const previous = pendingUpdate
  pendingUpdate = next
  pendingUpdateProxyKey = next ? proxyKey : null
  pendingUpdateDownloaded = false
  if (!downloadPromise) {
    downloadingProxyKey = null
  }

  if (previous && previous !== next) {
    try {
      await previous.close()
    } catch {
      // Ignore stale resource cleanup failures.
    }
  }
}

function shouldPromptForVersion(version: string | null) {
  return !!version && readDismissedUpdateVersion() !== version
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function parseAppVersion(version: string | null | undefined) {
  const match = version?.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return match.slice(1).map(Number) as [number, number, number]
}

function compareAppVersions(left: string | null | undefined, right: string | null | undefined) {
  const leftParts = parseAppVersion(left)
  const rightParts = parseAppVersion(right)
  if (!leftParts || !rightParts) return null

  for (let index = 0; index < leftParts.length; index += 1) {
    const delta = leftParts[index]! - rightParts[index]!
    if (delta !== 0) return delta
  }
  return 0
}

function isUpdateNewerThanCurrent(updateVersion: string, currentVersion: string | null) {
  const comparison = compareAppVersions(updateVersion, currentVersion)
  return comparison === null || comparison > 0
}

async function getCurrentAppVersion(host: DesktopHost) {
  try {
    return await host.app.getVersion()
  } catch {
    return null
  }
}

async function closeIgnoredUpdate(update: DesktopUpdate) {
  try {
    await update.close()
  } catch {
    // Best effort: a stale same-version update should not keep the prompt alive.
  }
}

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  status: 'idle',
  availableVersion: null,
  releaseNotes: null,
  progressPercent: 0,
  downloadedBytes: 0,
  totalBytes: null,
  error: null,
  checkedAt: null,
  shouldPrompt: false,

  initialize: async () => {
    if (!getUpdateHost()) return
    if (!startupCheckPromise) {
      startupCheckPromise = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000))
        await get().checkForUpdates({ silent: true })
      })().finally(() => {
        startupCheckPromise = null
      })
    }

    await startupCheckPromise
  },

  checkForUpdates: async ({ silent = false, autoDownload = true } = {}) => {
    const host = getUpdateHost()
    if (!host) return null
    if (downloadPromise && get().status === 'downloading' && pendingUpdate) return pendingUpdate

    set((state) => ({
      ...state,
      status: 'checking',
      error: null,
    }))

    try {
      const updateProxyKey = getUpdateProxyKey()
      const update = await host.updates.check(getUpdateCheckOptions())

      if (update && !isUpdateNewerThanCurrent(update.version, await getCurrentAppVersion(host))) {
        await closeIgnoredUpdate(update)
        await setPendingUpdate(null, null)

        const checkedAt = Date.now()
        writeDismissedUpdateVersion(null)
        set((state) => ({
          ...state,
          status: 'up-to-date',
          availableVersion: null,
          releaseNotes: null,
          progressPercent: 0,
          downloadedBytes: 0,
          totalBytes: null,
          checkedAt,
          error: null,
          shouldPrompt: false,
        }))
        return null
      }

      await setPendingUpdate(update, updateProxyKey)

      const checkedAt = Date.now()

      if (!update) {
        writeDismissedUpdateVersion(null)
        set((state) => ({
          ...state,
          status: 'up-to-date',
          availableVersion: null,
          releaseNotes: null,
          progressPercent: 0,
          downloadedBytes: 0,
          totalBytes: null,
          checkedAt,
          error: null,
          shouldPrompt: false,
        }))
        return null
      }

      const dismissedVersion = readDismissedUpdateVersion()
      const shouldOffer = dismissedVersion !== update.version

      set((state) => ({
        ...state,
        status: 'available',
        availableVersion: update.version,
        releaseNotes: update.body ?? null,
        progressPercent: 0,
        downloadedBytes: 0,
        totalBytes: null,
        checkedAt,
        error: null,
        shouldPrompt: false,
      }))

      if (autoDownload && (shouldOffer || !silent)) {
        void get().downloadUpdate().catch(() => {
          // The store records the failure and keeps the manual install path retryable.
        })
      }
      return update
    } catch (error) {
      if (!silent) {
        set((state) => ({
          ...state,
          status: 'error',
          error: getErrorMessage(error),
          checkedAt: Date.now(),
        }))
      } else {
        set((state) => ({
          ...state,
          status: state.availableVersion ? 'available' : 'idle',
          checkedAt: Date.now(),
        }))
      }
      return null
    }
  },

  downloadUpdate: async () => {
    if (!getUpdateHost()) return

    let update = pendingUpdate
    if (update && pendingUpdateProxyKey !== getUpdateProxyKey()) {
      await setPendingUpdate(null, null)
      update = null
    }
    if (!update) {
      update = await get().checkForUpdates({ autoDownload: false })
      if (!update) return
    }

    if (pendingUpdateDownloaded) {
      set((state) => ({
        ...state,
        status: 'downloaded',
        progressPercent: 100,
        shouldPrompt: shouldPromptForVersion(state.availableVersion),
      }))
      return
    }

    if (downloadPromise) {
      await downloadPromise
      return
    }

    set((state) => ({
      ...state,
      status: 'downloading',
      error: null,
      shouldPrompt: false,
      progressPercent: 0,
      downloadedBytes: 0,
      totalBytes: null,
    }))

    const downloadingUpdate = update
    downloadingProxyKey = pendingUpdateProxyKey
    const activeDownload = (async () => {
      let totalBytes: number | null = null
      let downloadedBytes = 0

      await downloadingUpdate.download((event) => {
        if (event.event === 'Started') {
          totalBytes = event.data.contentLength ?? null
          downloadedBytes = 0
          set((state) => ({
            ...state,
            totalBytes,
            downloadedBytes: 0,
            progressPercent: 0,
          }))
        } else if (event.event === 'Progress') {
          downloadedBytes += event.data.chunkLength
          const progressPercent =
            totalBytes && totalBytes > 0
              ? Math.min(Math.round((downloadedBytes / totalBytes) * 100), 100)
              : 0

          set((state) => ({
            ...state,
            downloadedBytes,
            totalBytes,
            progressPercent,
          }))
        } else if (event.event === 'Finished') {
          set((state) => ({
            ...state,
            progressPercent: 100,
          }))
        }
      })

      if (pendingUpdate !== downloadingUpdate) return
      if (getUpdateProxyKey() !== downloadingProxyKey) {
        await setPendingUpdate(null, null)
        set((state) => ({
          ...state,
          status: 'available',
          progressPercent: 0,
          shouldPrompt: false,
        }))
        return
      }

      pendingUpdateDownloaded = true
      set((state) => ({
        ...state,
        status: 'downloaded',
        error: null,
        shouldPrompt: shouldPromptForVersion(state.availableVersion),
        progressPercent: 100,
      }))
    })()
    downloadPromise = activeDownload

    try {
      await downloadPromise
    } catch (error) {
      if (pendingUpdate === downloadingUpdate) {
        set((state) => ({
          ...state,
          status: 'available',
          error: getErrorMessage(error),
          shouldPrompt: false,
        }))
      }
      throw error
    } finally {
      if (downloadPromise === activeDownload) {
        downloadPromise = null
        downloadingProxyKey = null
      }
    }
  },

  installUpdate: async () => {
    const host = getUpdateHost()
    if (!host) return

    let update = pendingUpdate
    if (update && pendingUpdateProxyKey !== getUpdateProxyKey()) {
      await setPendingUpdate(null, null)
      update = null
    }
    if (!update) {
      update = await get().checkForUpdates({ autoDownload: false })
      if (!update) return
    }

    let prepareInstallAttempted = false
    try {
      writeDismissedUpdateVersion(null)
      if (!pendingUpdateDownloaded) {
        await get().downloadUpdate()
      }
      if (!pendingUpdateDownloaded) return

      set((state) => ({
        ...state,
        status: 'installing',
        error: null,
        shouldPrompt: false,
        progressPercent: 100,
      }))

      prepareInstallAttempted = true
      await host.updates.prepareInstall()
      await update.install()

      set((state) => ({
        ...state,
        status: 'restarting',
        progressPercent: 100,
      }))

      await host.updates.relaunch()
    } catch (error) {
      if (prepareInstallAttempted) {
        try {
          await host.updates.cancelInstall()
        } catch {
          // Best effort: keep the update prompt recoverable even if native reset fails.
        }
      }
      set((state) => ({
        ...state,
        status: pendingUpdateDownloaded ? 'downloaded' : 'available',
        error: getErrorMessage(error),
        shouldPrompt: true,
      }))
    }
  },

  dismissPrompt: () => {
    writeDismissedUpdateVersion(get().availableVersion)
    set((state) => ({
      ...state,
      shouldPrompt: false,
    }))
  },
}))
