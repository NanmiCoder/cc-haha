import type { App, BrowserWindow, NativeImage } from 'electron'

const iconSize = 16

/** Windows uses a 16px overlay. The sprite contains 1 through 9 followed by 9+. */
export function createNotificationBadge({ platform, app, window, loadWindowsIcons }: {
  platform: NodeJS.Platform
  app: Pick<App, 'setBadgeCount'>
  window: Pick<BrowserWindow, 'setOverlayIcon' | 'isDestroyed'> & {
    on(event: 'show' | 'focus', handler: () => void): void
  }
  loadWindowsIcons: () => Pick<NativeImage, 'crop'>
}) {
  let icons: Pick<NativeImage, 'crop'> | undefined
  let overlay: { icon: NativeImage, description: string } | null = null
  const restoreOverlay = () => {
    if (overlay && !window.isDestroyed()) window.setOverlayIcon(overlay.icon, overlay.description)
  }
  if (platform === 'win32') {
    // Hiding to the tray removes the taskbar button. Explorer can recreate it
    // too, so reapply an outstanding badge when the window is used again.
    window.on('show', restoreOverlay)
    window.on('focus', restoreOverlay)
  }
  return (count: unknown, description: unknown): boolean => {
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 0x7fffffff) {
      throw new Error('Invalid notification badge count')
    }
    if (typeof description !== 'string' || (count > 0 && !description.trim())) {
      throw new Error('Invalid notification badge description')
    }
    if (platform === 'darwin') return app.setBadgeCount(count)
    if (platform !== 'win32' || window.isDestroyed()) return false
    if (count === 0) {
      overlay = null
      window.setOverlayIcon(null, '')
    } else {
      icons ??= loadWindowsIcons()
      const x = (Math.min(count, 10) - 1) * iconSize
      const icon = icons.crop({ x, y: 0, width: iconSize, height: iconSize })
      overlay = { icon, description }
      window.setOverlayIcon(icon, description)
    }
    return true
  }
}
