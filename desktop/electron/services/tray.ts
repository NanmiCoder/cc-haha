import { existsSync } from 'node:fs'
import path from 'node:path'
import type { App, Tray } from 'electron'

type ElectronTrayRuntime = Pick<typeof import('electron'), 'Menu' | 'Tray' | 'nativeImage'>

export type TrayController = {
  tray: Tray
  setUsageSummary(summary: { title?: string; tooltip?: string }): void
  dispose(): void
}

export function resolveTrayIconPath(desktopRoot: string): string {
  const candidates = [
    path.join(desktopRoot, 'src-tauri', 'icons', 'icon.png'),
    path.join(desktopRoot, 'public', 'app-icon.png'),
    path.join(desktopRoot, 'dist', 'app-icon.png'),
  ]
  const resolved = candidates.find(candidate => existsSync(candidate))
  if (!resolved) {
    throw new Error(`Electron tray icon not found under ${desktopRoot}`)
  }
  return resolved
}

export function shouldInstallTray(platform = process.platform): boolean {
  return platform !== 'darwin'
}

export async function installTray({
  app,
  desktopRoot,
  show,
  quit,
  toggleUsageWidget,
  electronRuntime,
}: {
  app: App
  desktopRoot: string
  show: () => void
  quit: () => void
  toggleUsageWidget?: () => void
  electronRuntime?: ElectronTrayRuntime
}): Promise<TrayController> {
  const { Menu, Tray, nativeImage } = electronRuntime ?? await import('electron')
  const icon = nativeImage.createFromPath(resolveTrayIconPath(desktopRoot))
  const tray = new Tray(icon)
  const defaultTooltip = app.name || 'Claude Code Haha'
  tray.setToolTip(defaultTooltip)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Claude Code Haha', click: show },
    ...(toggleUsageWidget ? [{ label: 'Toggle Usage Widget', click: toggleUsageWidget }] : []),
    { type: 'separator' },
    { label: 'Quit Claude Code Haha', click: quit },
  ]))
  tray.on('click', show)

  return {
    tray,
    setUsageSummary(summary) {
      if (typeof summary.tooltip === 'string' && summary.tooltip.trim()) {
        tray.setToolTip(summary.tooltip.trim())
      } else {
        tray.setToolTip(defaultTooltip)
      }
      if (typeof summary.title === 'string' && typeof tray.setTitle === 'function') {
        tray.setTitle(summary.title)
      }
    },
    dispose() {
      tray.destroy()
    },
  }
}

export async function installUsageMenuBarTray({
  app,
  desktopRoot,
  toggleUsageWidget,
  showMain,
  quit,
  electronRuntime,
}: {
  app: App
  desktopRoot: string
  toggleUsageWidget: () => void
  showMain: () => void
  quit: () => void
  electronRuntime?: ElectronTrayRuntime
}): Promise<TrayController> {
  const { Menu, Tray, nativeImage } = electronRuntime ?? await import('electron')
  let icon = nativeImage.createFromPath(resolveTrayIconPath(desktopRoot))
  if (typeof icon.resize === 'function') {
    icon = icon.resize({ width: 16, height: 16 })
  }
  const tray = new Tray(icon)
  const defaultTooltip = `${app.name || 'Claude Code Haha'} — Usage`
  tray.setToolTip(defaultTooltip)
  tray.on('click', toggleUsageWidget)
  tray.on('right-click', () => {
    tray.popUpContextMenu(Menu.buildFromTemplate([
      { label: 'Toggle Usage Widget', click: toggleUsageWidget },
      { label: 'Show Claude Code Haha', click: showMain },
      { type: 'separator' },
      { label: 'Quit Claude Code Haha', click: quit },
    ]))
  })

  return {
    tray,
    setUsageSummary(summary) {
      if (typeof summary.tooltip === 'string' && summary.tooltip.trim()) {
        tray.setToolTip(summary.tooltip.trim())
      } else {
        tray.setToolTip(defaultTooltip)
      }
      if (typeof summary.title === 'string' && typeof tray.setTitle === 'function') {
        tray.setTitle(summary.title)
      }
    },
    dispose() {
      tray.destroy()
    },
  }
}
