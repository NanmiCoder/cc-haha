import { appendFileSync, writeFileSync } from 'node:fs'
import type { BrowserWindow } from 'electron'

export type WindowSmokeEnv = {
  CC_HAHA_ELECTRON_WINDOW_SMOKE_LOG?: string
  CC_HAHA_ELECTRON_WINDOW_SMOKE_SCREENSHOT?: string
}

type WindowSmokeWindow = Pick<
  BrowserWindow,
  'getBounds' | 'getTitle' | 'isDestroyed' | 'isFocused' | 'isFullScreen' | 'isMaximized' | 'isMinimized' | 'isVisible'
> & {
  webContents?: Pick<BrowserWindow['webContents'], 'getURL' | 'isLoading'>
}

export function writeWindowSmokeSnapshot(
  window: WindowSmokeWindow | null,
  reason: string,
  env: WindowSmokeEnv = process.env,
) {
  const logPath = env.CC_HAHA_ELECTRON_WINDOW_SMOKE_LOG
  if (!logPath) return

  const payload = window
    ? {
        reason,
        destroyed: window.isDestroyed(),
        title: window.getTitle(),
        visible: window.isVisible(),
        focused: window.isFocused(),
        minimized: window.isMinimized(),
        maximized: window.isMaximized(),
        fullScreen: window.isFullScreen(),
        bounds: window.getBounds(),
        url: window.webContents?.getURL() ?? null,
        loading: window.webContents?.isLoading() ?? null,
      }
    : {
        reason,
        missingWindow: true,
      }

  appendFileSync(logPath, `${JSON.stringify({
    ts: new Date().toISOString(),
    ...payload,
  })}\n`)
}

export async function writeWindowSmokeScreenshot(
  window: Pick<BrowserWindow, 'isDestroyed'> & {
    webContents: Pick<BrowserWindow['webContents'], 'capturePage'>
  },
  env: WindowSmokeEnv = process.env,
): Promise<void> {
  const screenshotPath = env.CC_HAHA_ELECTRON_WINDOW_SMOKE_SCREENSHOT?.trim()
  if (!screenshotPath || window.isDestroyed()) return
  const image = await window.webContents.capturePage()
  writeFileSync(screenshotPath, image.toPNG())
}
