import type { App, BrowserWindow, MenuItemConstructorOptions } from 'electron'
import { ELECTRON_EVENT_CHANNELS } from '../ipc/channels'
import { hideWindowSafely, toggleWindowFullScreen } from './windows'

export type NativeMenuDestination = 'about' | 'settings'

type RendererContextMenuParams = {
  isEditable: boolean
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

  return []
}

export async function installRendererContextMenu(window: BrowserWindow) {
  const { Menu } = await import('electron')
  window.webContents.on('context-menu', (_event, params) => {
    const template = buildRendererContextMenuTemplate(params)
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
      if (window) toggleWindowFullScreen(window, platform)
    },
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
