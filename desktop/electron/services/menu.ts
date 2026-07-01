import type { App, BrowserWindow, MenuItemConstructorOptions } from 'electron'
import { ELECTRON_EVENT_CHANNELS } from '../ipc/channels'
import { hideWindowSafely, toggleWindowFullScreen } from './windows'

export type NativeMenuDestination = 'about' | 'settings'
type ApplicationMenuActions = {
  hide?: () => void
  close?: () => void
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
        { label: 'Close Window', accelerator: 'CmdOrCtrl+W', click: () => actions.close?.() },
      ],
    },
  ]
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

  const template = buildApplicationMenuTemplate(app.name || 'Code Council', destination => {
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
    toggleFullScreen: () => {
      const window = getMainWindow()
      if (window) toggleWindowFullScreen(window, platform)
    },
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
