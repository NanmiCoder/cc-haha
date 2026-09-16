import type { MenuItemConstructorOptions } from 'electron'
import type { WorkspaceBrowserMenuAction, WorkspaceBrowserMenuOptions } from '../../src/lib/desktopHost/types'
import { MAX_APP_ZOOM, MIN_APP_ZOOM } from './zoom'

export type WorkspaceBrowserNativeMenu = {
  popup(options: { x: number; y: number; callback: () => void }): void
  closePopup(): void
}

export type WorkspaceBrowserMenuFactory = (template: MenuItemConstructorOptions[]) => WorkspaceBrowserNativeMenu

/** Renderer anchors are CSS pixels; Electron popup coordinates use window DIP. */
export function workspaceBrowserMenuPosition(
  anchor: { x: number; y: number },
  hostZoom: number,
  contentSize: { width: number; height: number },
): { x: number; y: number } {
  if (![anchor.x, anchor.y, hostZoom, contentSize.width, contentSize.height].every(Number.isFinite) || hostZoom <= 0) {
    throw new Error('Invalid workspace browser menu position')
  }
  return {
    x: Math.round(Math.max(0, Math.min(anchor.x * hostZoom, Math.max(0, contentSize.width - 1)))),
    y: Math.round(Math.max(0, Math.min(anchor.y * hostZoom, Math.max(0, contentSize.height - 1)))),
  }
}

export function buildWorkspaceBrowserMenuTemplate(
  options: WorkspaceBrowserMenuOptions,
  select: (action: WorkspaceBrowserMenuAction) => void,
): MenuItemConstructorOptions[] {
  const item = (action: WorkspaceBrowserMenuAction, enabled = true): MenuItemConstructorOptions => ({
    id: action,
    label: options.labels[action],
    enabled,
    click: () => { if (enabled) select(action) },
  })
  return [
    item('find', options.hasPage),
    item('print', options.hasPage),
    { type: 'separator' },
    { id: 'zoom', label: `${options.labels.zoom} · ${Math.round(options.zoomFactor * 100)}%`, enabled: false },
    item('zoomOut', options.zoomFactor > MIN_APP_ZOOM),
    item('zoomIn', options.zoomFactor < MAX_APP_ZOOM),
    item('zoomReset', options.zoomFactor !== 1),
    { type: 'separator' },
    item('capture', options.hasPage),
    item('pickElement', options.hasPage),
    { type: 'separator' },
    item('downloads'),
    item('history'),
    item('openExternal', options.canOpenExternal),
  ]
}

/** One popup belongs to one live page; dismissal never hides its WebContentsView. */
export class WorkspaceBrowserMenuController {
  private pending: { tabId: string; cancel: () => void } | null = null

  constructor(private readonly createMenu: WorkspaceBrowserMenuFactory) {}

  show(tabId: string, options: WorkspaceBrowserMenuOptions): Promise<WorkspaceBrowserMenuAction | null> {
    this.cancel()
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (action: WorkspaceBrowserMenuAction | null) => {
        if (settled) return
        settled = true
        if (this.pending === pending) this.pending = null
        resolve(action)
      }
      const menu = this.createMenu(buildWorkspaceBrowserMenuTemplate(options, finish))
      const pending = { tabId, cancel: () => {
        finish(null)
        menu.closePopup()
      } }
      this.pending = pending
      try {
        menu.popup({ x: options.x, y: options.y, callback: () => finish(null) })
      } catch (error) {
        settled = true
        if (this.pending === pending) this.pending = null
        reject(error)
      }
    })
  }

  cancel(tabId?: string): void {
    if (this.pending && (tabId === undefined || this.pending.tabId === tabId)) this.pending.cancel()
  }
}
