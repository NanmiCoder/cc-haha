import { existsSync } from 'node:fs'
import path from 'node:path'
import type { App, Tray } from 'electron'

export type TrayController = {
  tray: Tray
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
}: {
  app: App
  desktopRoot: string
  show: () => void
  quit: () => void
}): Promise<TrayController> {
  const { Menu, Tray, nativeImage } = await import('electron')
  const icon = nativeImage.createFromPath(resolveTrayIconPath(desktopRoot))
  const tray = new Tray(icon)
  tray.setToolTip(app.name || 'Code Council')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Code Council', click: show },
    { type: 'separator' },
    { label: 'Quit Code Council', click: quit },
  ]))
  tray.on('click', show)

  return {
    tray,
    dispose() {
      tray.destroy()
    },
  }
}
