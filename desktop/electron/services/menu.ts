import type { App, BrowserWindow, MenuItemConstructorOptions } from 'electron'
import type { Locale } from '../../src/i18n/locale'
import { ELECTRON_EVENT_CHANNELS } from '../ipc/channels'
import { hideWindowSafely, toggleWindowFullScreen } from './windows'

export type NativeMenuDestination = 'about' | 'settings'

const COPY_IMAGE_LABEL: Record<Locale, string> = {
  en: 'Copy Image',
  zh: '复制图片',
  'zh-TW': '複製圖片',
  jp: '画像をコピー',
  kr: '이미지 복사',
}

type RendererContextMenuParams = {
  isEditable: boolean
  mediaType?: string
  x?: number
  y?: number
  selectionText: string
  editFlags: {
    canUndo: boolean
    canRedo: boolean
    canCut: boolean
    canCopy: boolean
    canPaste: boolean
    canSelectAll: boolean
  }
}

type ApplicationMenuActions = {
  hide?: () => void
  close?: () => void
  closeTab?: () => void
  toggleFullScreen?: () => void
}

export function buildApplicationMenuTemplate(
  appName: string,
  onNavigate: (destination: NativeMenuDestination) => void,
  platform = process.platform,
  actions: ApplicationMenuActions = {},
): MenuItemConstructorOptions[] {
  const appMenu: MenuItemConstructorOptions[] = platform === 'darwin'
    ? [{
        label: appName,
        submenu: [
          { label: `About ${appName}`, click: () => onNavigate('about') },
          { type: 'separator' },
          { label: 'Settings...', accelerator: 'CmdOrCtrl+,', click: () => onNavigate('settings') },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { label: `Hide ${appName}`, accelerator: 'Command+H', click: () => actions.hide?.() },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      }]
    : [{
        label: 'File',
        submenu: [
          { label: 'Settings...', accelerator: 'Ctrl+,', click: () => onNavigate('settings') },
          { type: 'separator' },
          { role: 'quit' },
        ],
      }]

  return [
    ...appMenu,
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Full Screen',
          accelerator: platform === 'darwin' ? 'Ctrl+Command+F' : 'F11',
          click: () => actions.toggleFullScreen?.(),
        },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => actions.closeTab?.() },
        { label: 'Close Window', click: () => actions.close?.() },
      ],
    },
  ]
}

export function buildRendererContextMenuTemplate(
  params: RendererContextMenuParams,
  options: { locale?: Locale; copyImageAt?: (x: number, y: number) => void } = {},
): MenuItemConstructorOptions[] {
  if (params.isEditable) {
    return [
      { role: 'undo', enabled: params.editFlags.canUndo },
      { role: 'redo', enabled: params.editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll },
    ]
  }

  if (params.selectionText.length > 0) {
    return [{ role: 'copy', enabled: params.editFlags.canCopy }]
  }

  // Chromium offers no image copy of its own in Electron; `copyImageAt` hit-tests
  // the point, so it also covers blob:/data: images the lightbox shows.
  if (params.mediaType === 'image' && options.copyImageAt) {
    const { x = 0, y = 0 } = params
    const copyImageAt = options.copyImageAt
    return [{
      label: COPY_IMAGE_LABEL[options.locale ?? 'en'],
      click: () => copyImageAt(x, y),
    }]
  }

  return []
}

export async function installRendererContextMenu(
  window: BrowserWindow,
  getLocale?: () => Locale,
) {
  const { Menu } = await import('electron')
  window.webContents.on('context-menu', (_event, params) => {
    const template = buildRendererContextMenuTemplate(params, {
      locale: getLocale?.(),
      copyImageAt: (x, y) => {
        if (!window.isDestroyed()) window.webContents.copyImageAt(x, y)
      },
    })
    if (template.length === 0 || window.isDestroyed()) return
    Menu.buildFromTemplate(template).popup({ window })
  })
  window.webContents.on('before-input-event', (_event, input) => {
    // Let the renderer decide whether W belongs to its active tab or terminal.
    // Preventing the key here would also suppress readline's Ctrl+W.
    window.webContents.setIgnoreMenuShortcuts(
      input.key.toLowerCase() === 'w' && (input.meta || input.control),
    )
  })
}

export async function installApplicationMenu(
  app: App,
  getMainWindow: () => BrowserWindow | null,
  platform: NodeJS.Platform = process.platform,
) {
  const { Menu } = await import('electron')
  if (platform === 'win32') {
    Menu.setApplicationMenu(null)
    return
  }

  const template = buildApplicationMenuTemplate(app.name || 'Claude Code Haha', destination => {
    getMainWindow()?.webContents.send(ELECTRON_EVENT_CHANNELS.nativeMenuNavigate, destination)
  }, platform, {
    hide: () => {
      const window = getMainWindow()
      if (!window) {
        app.hide?.()
        return
      }
      hideWindowSafely(window, () => app.hide?.())
    },
    close: () => {
      getMainWindow()?.close()
    },
    closeTab: () => {
      getMainWindow()?.webContents.send(ELECTRON_EVENT_CHANNELS.workspaceBrowserEvent, {
        type: 'shortcut', tabId: '', action: 'close-tab',
      })
    },
    toggleFullScreen: () => {
      const window = getMainWindow()
      if (window) toggleWindowFullScreen(window)
    },
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
