import type { App, BrowserWindow, Dialog } from 'electron'

export const DEFAULT_RENDERER_UNRESPONSIVE_RECOVERY_DELAY_MS = 10_000
export const DEFAULT_RENDERER_RECOVERY_LOAD_TIMEOUT_MS = 30_000
export const DEFAULT_RENDERER_RECOVERY_STABLE_MS = 60_000

export type RendererLifecycleOptions = {
  window: BrowserWindow
  isQuitting: () => boolean
  recordDiagnostic: (detail: string) => string
  writeSnapshot: (reason: string) => void
  onRendererProcessGone?: (detail: string) => void
  onRecoveryExhausted: (detail: string) => void
  unresponsiveRecoveryDelayMs?: number
  recoveryLoadTimeoutMs?: number
  recoveryStableMs?: number
}

export function installRendererLifecycle({
  window,
  isQuitting,
  recordDiagnostic,
  writeSnapshot,
  onRendererProcessGone,
  onRecoveryExhausted,
  unresponsiveRecoveryDelayMs = DEFAULT_RENDERER_UNRESPONSIVE_RECOVERY_DELAY_MS,
  recoveryLoadTimeoutMs = DEFAULT_RENDERER_RECOVERY_LOAD_TIMEOUT_MS,
  recoveryStableMs = DEFAULT_RENDERER_RECOVERY_STABLE_MS,
}: RendererLifecycleOptions): void {
  let recoveryAttempted = false
  let failureReported = false
  let closed = false
  let recoveryLoaded = false
  let recoveryTrigger = ''
  let lastProcessExit = ''
  let unresponsiveRecoveryTimer: ReturnType<typeof setTimeout> | null = null
  let rendererReloadTimer: ReturnType<typeof setTimeout> | null = null
  let recoveryLoadTimer: ReturnType<typeof setTimeout> | null = null
  let recoveryStableTimer: ReturnType<typeof setTimeout> | null = null

  const unavailable = () => closed || isQuitting() || window.isDestroyed() || window.webContents.isDestroyed()
  const clearRecoveryLoad = () => {
    if (recoveryLoadTimer) clearTimeout(recoveryLoadTimer)
    recoveryLoadTimer = null
  }
  const clearRecoveryStable = () => {
    if (recoveryStableTimer) clearTimeout(recoveryStableTimer)
    recoveryStableTimer = null
  }

  const clearUnresponsiveRecovery = () => {
    if (!unresponsiveRecoveryTimer) return
    clearTimeout(unresponsiveRecoveryTimer)
    unresponsiveRecoveryTimer = null
  }
  const clearRendererReload = () => {
    if (!rendererReloadTimer) return
    clearTimeout(rendererReloadTimer)
    rendererReloadTimer = null
  }
  const reportRecoveryFailure = (detail: string) => {
    clearRecoveryLoad()
    clearRecoveryStable()
    clearUnresponsiveRecovery()
    if (failureReported || unavailable()) return
    failureReported = true
    onRecoveryExhausted(recordDiagnostic(`[recovery-exhausted] ${detail}${lastProcessExit ? ` ${lastProcessExit}` : ''}`))
  }
  const scheduleRecoveryStable = () => {
    clearRecoveryStable()
    if (!recoveryLoaded || failureReported || unavailable()) return
    // A completed load alone must not allow an endless load/crash loop.
    recoveryStableTimer = setTimeout(() => {
      recoveryStableTimer = null
      if (unavailable()) return
      recoveryAttempted = false
      recoveryLoaded = false
      recoveryTrigger = ''
      lastProcessExit = ''
      recordDiagnostic('[recovery-stable]')
    }, recoveryStableMs)
  }
  const recoverRenderer = (trigger: string) => {
    clearUnresponsiveRecovery()
    clearRecoveryStable()
    recoveryLoaded = false
    if (unavailable()) {
      recordDiagnostic(`[recovery-skipped] trigger=${trigger} quitting=${isQuitting()}`)
      return
    }
    if (rendererReloadTimer) {
      recordDiagnostic(`[recovery-already-scheduled] trigger=${trigger}`)
      return
    }
    if (recoveryAttempted) {
      reportRecoveryFailure(`trigger=${trigger}`)
      return
    }

    recoveryAttempted = true
    recoveryTrigger = trigger
    recordDiagnostic(`[recovery-started] trigger=${trigger}`)
    rendererReloadTimer = setTimeout(() => {
      rendererReloadTimer = null
      if (unavailable()) {
        recordDiagnostic(`[recovery-skipped] trigger=${trigger} quitting=${isQuitting()}`)
        return
      }
      try {
        recoveryLoadTimer = setTimeout(() => {
          recoveryLoadTimer = null
          reportRecoveryFailure(`trigger=${trigger} load-timeout=${recoveryLoadTimeoutMs}ms`)
        }, recoveryLoadTimeoutMs)
        window.webContents.reload()
      } catch (error) {
        reportRecoveryFailure(
          `trigger=${trigger} reloadError=${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }, 0)
  }

  window.webContents.on('did-finish-load', () => {
    if (unavailable()) return
    clearUnresponsiveRecovery()
    if (recoveryAttempted && !rendererReloadTimer && !failureReported) {
      clearRecoveryLoad()
      recoveryLoaded = true
      recordDiagnostic('[recovery-loaded]')
      scheduleRecoveryStable()
    }
    writeSnapshot('did-finish-load')
  })
  window.webContents.on('did-navigate', () => {
    // Only a committed main-frame navigation replaces the loaded document.
    // Iframe loads, same-document changes and guarded links leave it healthy.
    recoveryLoaded = false
    clearRecoveryStable()
  })
  window.webContents.on('did-fail-load', (
    _event,
    errorCode,
    errorDescription,
    validatedURL,
    isMainFrame,
  ) => {
    writeSnapshot(`did-fail-load:${errorCode}:${errorDescription}:${validatedURL}`)
    if (recoveryAttempted && isMainFrame && errorCode !== -3) {
      reportRecoveryFailure(`trigger=${recoveryTrigger} loadError=${errorCode}:${errorDescription}`)
    }
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    clearUnresponsiveRecovery()
    lastProcessExit = `reason=${details.reason} exitCode=${details.exitCode} (0x${(details.exitCode >>> 0).toString(16).toUpperCase().padStart(8, '0')})`
    const detail = recordDiagnostic(
      `[process-gone] ${lastProcessExit}`,
    )
    onRendererProcessGone?.(detail)
    writeSnapshot(`render-process-gone:${details.reason}:${details.exitCode}`)
    recoverRenderer(`process-gone:${details.reason}`)
  })
  window.webContents.on('unresponsive', () => {
    if (unavailable() || failureReported) return
    clearRecoveryStable()
    recordDiagnostic('[unresponsive]')
    writeSnapshot('unresponsive')
    if (unresponsiveRecoveryTimer) return
    unresponsiveRecoveryTimer = setTimeout(() => {
      unresponsiveRecoveryTimer = null
      recoverRenderer('unresponsive-timeout')
    }, unresponsiveRecoveryDelayMs)
  })
  window.webContents.on('responsive', () => {
    clearUnresponsiveRecovery()
    recordDiagnostic('[responsive]')
    writeSnapshot('responsive')
    scheduleRecoveryStable()
  })
  window.on('closed', () => {
    closed = true
    clearUnresponsiveRecovery()
    clearRendererReload()
    clearRecoveryLoad()
    clearRecoveryStable()
  })
}

export async function showRendererRecoveryFailure({
  window, isQuitting, dialog, app, detail,
}: {
  window: BrowserWindow
  isQuitting: () => boolean
  dialog: Pick<Dialog, 'showMessageBox'>
  app: Pick<App, 'relaunch' | 'quit'>
  detail: string
}): Promise<void> {
  if (isQuitting() || window.isDestroyed()) return
  const { response } = await dialog.showMessageBox(window, {
    type: 'error',
    title: '界面恢复失败 / Interface Recovery Failed',
    message: '桌面界面自动恢复失败。/ The desktop interface could not recover automatically.',
    detail: `请重启应用；如果问题持续存在，请附上诊断日志反馈。\nRestart the app and include diagnostics when reporting the problem.\n\n${detail}`,
    buttons: ['重启应用 / Restart App', '稍后 / Later'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (response !== 0 || isQuitting() || window.isDestroyed()) return
  app.relaunch()
  // Use the host's normal before-quit cleanup to stop sidecars gracefully.
  app.quit()
}
