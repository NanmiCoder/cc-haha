import { app, BrowserWindow, clipboard, ipcMain, Notification, screen, session, WebContentsView } from 'electron'
import { autoUpdater } from 'electron-updater'
import path from 'node:path'
import { ELECTRON_EVENT_CHANNELS, ELECTRON_INTERNAL_CHANNELS, ELECTRON_IPC_CHANNELS, type ElectronIpcChannel } from './ipc/channels'
import { isElectronIpcChannel, validateElectronIpcPayload } from './ipc/capabilities'
import { ElectronServerRuntime, type TunnelStartOptions } from './services/serverRuntime'
import { openDialog, saveDialog } from './services/dialogs'
import { openExternalUrl, openSystemPath, openSystemSettingsUrl, showItemInFolder } from './services/shell'
import {
  notificationPermissionState,
  requestNotificationPermission,
  sendDesktopNotification,
} from './services/notifications'
import { installApplicationMenu } from './services/menu'
import { acquireSingleInstanceLock } from './services/singleInstance'
import { installTray, shouldInstallTray, type TrayController } from './services/tray'
import { ElectronUpdaterService } from './services/updater'
import { createUpdateSmokeUpdaterFromEnv } from './services/updateSmoke'
import { ElectronTerminalService, type TerminalSpawnInput } from './services/terminal'
import { ElectronPreviewService, type PreviewBounds } from './services/preview'
import {
  applyStartupPortableMode,
  detectPortableDir,
  getAppMode,
  setAppMode,
  type PortableDetection,
} from './services/appMode'
import { installMacOsChromiumKeychainPromptGuard } from './services/keychain'
import { applyWindowsAppUserModelId } from './services/appIdentity'
import { installMainWindowNavigationGuards, installPreviewNavigationGuards } from './services/navigationGuards'
import { installPreviewCleanupOnRendererNavigation } from './services/previewLifecycle'
import { logNotificationSmokeRendererAck, scheduleNotificationSmoke } from './services/notificationSmoke'
import { normalizeZoomFactor } from './services/zoom'
import { resolveRendererEntry } from './services/rendererEntry'
import { writeWindowSmokeSnapshot } from './services/windowSmoke'
import {
  installWindowLifecycle,
  readWindowState,
  restoreWindowMaximized,
  saveWindowState,
  showMainWindow,
  windowChromeOptionsForPlatform,
  windowOptionsFromState,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
} from './services/windows'

let mainWindow: BrowserWindow | null = null
let serverRuntime: ElectronServerRuntime | null = null
let updaterService: ElectronUpdaterService | null = null
let terminalService: ElectronTerminalService | null = null
let previewService: ElectronPreviewService | null = null
const traceWindows = new Map<string, BrowserWindow>()
let isQuitting = false
let trayController: TrayController | null = null

installMacOsChromiumKeychainPromptGuard(app)

function appRoot() {
  return app.isPackaged ? app.getAppPath() : process.cwd()
}

function unpackedRoot() {
  const root = appRoot()
  return app.isPackaged ? root.replace(/\.asar$/, '.asar.unpacked') : root
}

function preloadPath() {
  return path.join(appRoot(), 'electron-dist', 'preload.cjs')
}

function previewPreloadPath() {
  return path.join(appRoot(), 'electron-dist', 'preview-preload.cjs')
}

function previewAgentPath() {
  return path.join(appRoot(), 'src-tauri', 'resources', 'preview-agent.js')
}

function rendererEntry() {
  return resolveRendererEntry({
    isPackaged: app.isPackaged,
    appRoot: appRoot(),
    env: process.env,
  })
}

async function loadRendererEntry(
  window: BrowserWindow,
  query?: Record<string, string>,
) {
  const entry = rendererEntry()
  if (/^https?:\/\//.test(entry)) {
    const url = new URL(entry)
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value)
    }
    await window.loadURL(url.toString())
  } else {
    await window.loadFile(entry, query ? { query } : undefined)
  }
}

async function openTraceWindow(sessionId: string) {
  const existing = traceWindows.get(sessionId)
  if (existing && !existing.isDestroyed()) {
    showMainWindow(existing, app)
    return
  }

  const traceWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 860,
    minHeight: 560,
    title: 'Trace',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  traceWindows.set(sessionId, traceWindow)
  traceWindow.on('closed', () => {
    traceWindows.delete(sessionId)
  })
  installMainWindowNavigationGuards(traceWindow.webContents, { openExternal: openExternalUrl })
  await loadRendererEntry(traceWindow, {
    traceWindow: '1',
    traceSessionId: sessionId,
  })
  showMainWindow(traceWindow, app)
}

function getServerRuntime() {
  serverRuntime ??= new ElectronServerRuntime({
    desktopRoot: unpackedRoot(),
    appRoot: appRoot(),
    h5DistDir: path.join(unpackedRoot(), 'dist'),
    resolveSystemProxy: (url) => session.defaultSession.resolveProxy(url),
  })
  return serverRuntime
}

function getUpdaterService() {
  const smokeUpdater = createUpdateSmokeUpdaterFromEnv(process.env)
  updaterService ??= new ElectronUpdaterService(smokeUpdater ?? autoUpdater, {
    async apply(proxy) {
      const config = proxy
        ? { proxyRules: proxy, proxyBypassRules: '<local>' }
        : {}
      await Promise.all([
        app.setProxy(config),
        session.defaultSession.setProxy(config),
      ])
      await session.defaultSession.forceReloadProxyConfig()
    },
  }, {
    updateConfigPath: !smokeUpdater && app.isPackaged ? path.join(process.resourcesPath, 'app-update.yml') : undefined,
    currentVersion: app.getVersion(),
  })
  return updaterService
}

function nodePtyRuntimeCacheDir() {
  if (!app.isPackaged || process.platform !== 'darwin') return undefined
  return path.join(app.getPath('userData'), 'native', `node-pty-${process.platform}-${process.arch}-${app.getVersion()}`)
}

function getTerminalService() {
  terminalService ??= new ElectronTerminalService({
    app,
    nodePtySourceDir: app.isPackaged ? path.join(unpackedRoot(), 'node_modules', 'node-pty') : undefined,
    nodePtyCacheDir: nodePtyRuntimeCacheDir(),
  })
  return terminalService
}

function getPreviewService() {
  previewService ??= new ElectronPreviewService({
    previewScriptPath: previewAgentPath(),
    createView: () => {
      const view = new WebContentsView({
        webPreferences: {
          preload: previewPreloadPath(),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      })
      installPreviewNavigationGuards(view.webContents, { openExternal: openExternalUrl })
      return view
    },
  })
  return previewService
}

function currentWindow(event: Electron.IpcMainInvokeEvent) {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window) throw new Error('No BrowserWindow for Electron IPC event')
  return window
}

function registerHandler<T>(
  channel: ElectronIpcChannel,
  handler: (event: Electron.IpcMainInvokeEvent, payload: unknown) => T | Promise<T>,
) {
  ipcMain.handle(channel, async (event, payload) => {
    if (!isElectronIpcChannel(channel) || !validateElectronIpcPayload(channel, payload)) {
      throw new Error(`Invalid Electron IPC payload for ${channel}`)
    }
    return handler(event, payload)
  })
}

function unsupported(name: string): never {
  throw new Error(`${name} is not implemented in the Electron host yet`)
}

function emitNotificationAction(payload: unknown) {
  showMainWindow(mainWindow, app)
  mainWindow?.webContents.send(ELECTRON_EVENT_CHANNELS.notificationAction, payload)
}

async function handleCommandInvoke(payload: unknown): Promise<unknown> {
  const { command, args } = payload as { command: string, args?: Record<string, unknown> }

  switch (command) {
    case 'plugin:notification|is_permission_granted':
      return notificationPermissionState(Notification) === 'granted'
    case 'plugin:notification|request_permission':
    case 'macos_request_notification_permission':
      return requestNotificationPermission(Notification)
    case 'macos_notification_permission_state':
      return notificationPermissionState(Notification)
    case 'macos_send_notification':
      return sendDesktopNotification({
        NotificationClass: Notification,
        options: args,
        onAction: emitNotificationAction,
      })
    case 'macos_open_notification_settings':
      return openSystemSettingsUrl('x-apple.systempreferences:com.apple.preference.notifications')
    case 'open_windows_notification_settings':
      return openSystemSettingsUrl('ms-settings:notifications')
    default:
      return unsupported(`Electron command ${command}`)
  }
}

function registerIpcHandlers() {
  ipcMain.on(ELECTRON_INTERNAL_CHANNELS.previewMessageFromView, (event, raw) => {
    void getPreviewService().sendMessageToRenderer(event.sender, raw, mainWindow?.webContents)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.appGetVersion, () => app.getVersion())
  registerHandler(ELECTRON_IPC_CHANNELS.runtimeGetServerUrl, () => getServerRuntime().getServerUrl())
  registerHandler(ELECTRON_IPC_CHANNELS.commandInvoke, (_event, payload) => handleCommandInvoke(payload))
  registerHandler(ELECTRON_IPC_CHANNELS.clipboardReadText, () => clipboard.readText())
  registerHandler(ELECTRON_IPC_CHANNELS.clipboardWriteText, (_event, payload) => clipboard.writeText(String(payload)))
  registerHandler(ELECTRON_IPC_CHANNELS.shellOpen, (_event, payload) => openExternalUrl(String(payload)))
  registerHandler(ELECTRON_IPC_CHANNELS.shellOpenPath, (_event, payload) => openSystemPath(String(payload)))
  registerHandler(ELECTRON_IPC_CHANNELS.shellShowItemInFolder, (_event, payload) => showItemInFolder(String(payload)))
  registerHandler(ELECTRON_IPC_CHANNELS.traceOpenWindow, (_event, payload) => openTraceWindow(String(payload)))
  registerHandler(ELECTRON_IPC_CHANNELS.dialogOpen, (event, payload) =>
    openDialog(currentWindow(event), payload as Parameters<typeof openDialog>[1]))
  registerHandler(ELECTRON_IPC_CHANNELS.dialogSave, (event, payload) =>
    saveDialog(currentWindow(event), payload as Parameters<typeof saveDialog>[1]))
  registerHandler(ELECTRON_IPC_CHANNELS.updateCheck, (_event, payload) =>
    getUpdaterService().checkForUpdates(payload as Parameters<ElectronUpdaterService['checkForUpdates']>[0]))
  registerHandler(ELECTRON_IPC_CHANNELS.updateDownload, () => getUpdaterService().downloadUpdate(event => {
    mainWindow?.webContents.send(ELECTRON_EVENT_CHANNELS.updateDownloadEvent, event)
  }))
  registerHandler(ELECTRON_IPC_CHANNELS.updateInstall, () => getUpdaterService().stageDownloadedUpdate())
  registerHandler(ELECTRON_IPC_CHANNELS.updatePrepareInstall, () => getServerRuntime().stopAll())
  registerHandler(ELECTRON_IPC_CHANNELS.updateCancelInstall, () => getUpdaterService().cancelInstall())
  registerHandler(ELECTRON_IPC_CHANNELS.updateRelaunch, () => {
    if (getUpdaterService().hasDownloadedUpdate()) {
      isQuitting = true
      getUpdaterService().quitAndInstallDownloadedUpdate()
      return
    }
    app.relaunch()
    app.quit()
  })
  registerHandler(ELECTRON_IPC_CHANNELS.notificationPermissionState, () => notificationPermissionState(Notification))
  registerHandler(ELECTRON_IPC_CHANNELS.notificationRequestPermission, () => requestNotificationPermission(Notification))
  registerHandler(ELECTRON_IPC_CHANNELS.notificationSend, (_event, payload) => sendDesktopNotification({
    NotificationClass: Notification,
    options: payload,
    onAction: emitNotificationAction,
  }))
  registerHandler(ELECTRON_IPC_CHANNELS.notificationActionAck, (_event, payload) =>
    logNotificationSmokeRendererAck(process.env, payload))
  registerHandler(ELECTRON_IPC_CHANNELS.windowMinimize, event => currentWindow(event).minimize())
  registerHandler(ELECTRON_IPC_CHANNELS.windowToggleMaximize, event => {
    const window = currentWindow(event)
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  registerHandler(ELECTRON_IPC_CHANNELS.windowClose, event => currentWindow(event).close())
  registerHandler(ELECTRON_IPC_CHANNELS.windowStartDragging, () => undefined)
  registerHandler(ELECTRON_IPC_CHANNELS.windowRequestAttention, event => currentWindow(event).flashFrame(true))
  registerHandler(ELECTRON_IPC_CHANNELS.windowFocus, event => currentWindow(event).focus())
  registerHandler(ELECTRON_IPC_CHANNELS.windowIsMaximized, event => currentWindow(event).isMaximized())
  registerHandler(ELECTRON_IPC_CHANNELS.terminalSpawn, (event, payload) =>
    getTerminalService().spawn((payload ?? {}) as TerminalSpawnInput, event.sender))
  registerHandler(ELECTRON_IPC_CHANNELS.terminalWrite, (_event, payload) => {
    const { sessionId, data } = payload as { sessionId: number, data: string }
    return getTerminalService().write(sessionId, data)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.terminalResize, (_event, payload) => {
    const { sessionId, cols, rows } = payload as { sessionId: number, cols: number, rows: number }
    return getTerminalService().resize(sessionId, cols, rows)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.terminalKill, (_event, payload) => {
    const { sessionId } = payload as { sessionId: number }
    return getTerminalService().kill(sessionId)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.terminalGetBashPath, () => getTerminalService().getBashPath())
  registerHandler(ELECTRON_IPC_CHANNELS.terminalSetBashPath, (_event, payload) => getTerminalService().setBashPath(payload as string | null))
  registerHandler(ELECTRON_IPC_CHANNELS.previewOpen, (event, payload) => {
    const { url, bounds } = payload as { url: string, bounds?: PreviewBounds }
    return getPreviewService().open(currentWindow(event), url, bounds ?? { x: 0, y: 0, width: 0, height: 0 })
  })
  registerHandler(ELECTRON_IPC_CHANNELS.previewNavigate, (_event, payload) => getPreviewService().navigate(String(payload)))
  registerHandler(ELECTRON_IPC_CHANNELS.previewSetBounds, (_event, payload) => getPreviewService().setBounds(payload as PreviewBounds))
  registerHandler(ELECTRON_IPC_CHANNELS.previewSetVisible, (_event, payload) => getPreviewService().setVisible(Boolean(payload)))
  registerHandler(ELECTRON_IPC_CHANNELS.previewClose, () => getPreviewService().close())
  registerHandler(ELECTRON_IPC_CHANNELS.previewMessage, (event, payload) => getPreviewService().message(payload, event.sender))
  registerHandler(ELECTRON_IPC_CHANNELS.appModeGet, () => getAppMode(app))
  registerHandler(ELECTRON_IPC_CHANNELS.appModeSet, (_event, payload) => setAppMode(app, payload as Parameters<typeof setAppMode>[1]))
  registerHandler(ELECTRON_IPC_CHANNELS.appModeDetectPortableDir, () => detectPortableDir(app) as PortableDetection)
  registerHandler(ELECTRON_IPC_CHANNELS.appModePrepareRestart, () => getServerRuntime().stopAll())
  registerHandler(ELECTRON_IPC_CHANNELS.appModeRestart, () => {
    isQuitting = true
    app.relaunch()
    app.quit()
  })
  registerHandler(ELECTRON_IPC_CHANNELS.adaptersRestartSidecar, () => getServerRuntime().restartAdaptersSidecars())
  registerHandler(ELECTRON_IPC_CHANNELS.tunnelStart, (_event, payload) => getServerRuntime().startTunnel(payload as TunnelStartOptions))
  registerHandler(ELECTRON_IPC_CHANNELS.tunnelStop, () => getServerRuntime().stopTunnel())
  registerHandler(ELECTRON_IPC_CHANNELS.tunnelGetStatus, () => getServerRuntime().getTunnelStatus())
  registerHandler(ELECTRON_IPC_CHANNELS.zoomSet, (event, payload) => currentWindow(event).webContents.setZoomFactor(normalizeZoomFactor(payload)))
}

async function createMainWindow() {
  const restoredState = readWindowState(app, screen.getAllDisplays())
  const bounds = windowOptionsFromState(restoredState)
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    ...windowChromeOptionsForPlatform(process.platform),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  installMainWindowNavigationGuards(mainWindow.webContents, { openExternal: openExternalUrl })
  installPreviewCleanupOnRendererNavigation(mainWindow.webContents, () => {
    previewService?.close()
  })

  installWindowLifecycle({
    app,
    window: mainWindow,
    shouldQuit: () => isQuitting,
  })

  mainWindow.on('resize', () => {
    mainWindow?.webContents.send(ELECTRON_EVENT_CHANNELS.windowResized)
  })
  mainWindow.webContents.on('did-finish-load', () => {
    writeWindowSmokeSnapshot(mainWindow, 'did-finish-load')
  })
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    writeWindowSmokeSnapshot(mainWindow, `did-fail-load:${errorCode}:${errorDescription}:${validatedURL}`)
  })

  writeWindowSmokeSnapshot(mainWindow, 'after-create')

  await loadRendererEntry(mainWindow)

  restoreWindowMaximized(mainWindow, restoredState)
  showMainWindow(mainWindow, app)
  writeWindowSmokeSnapshot(mainWindow, 'after-final-show')
}

if (!acquireSingleInstanceLock(app, () => mainWindow)) {
  process.exit(0)
}

registerIpcHandlers()

app.whenReady().then(async () => {
  applyWindowsAppUserModelId(app)
  applyStartupPortableMode(app)
  await getServerRuntime().startServer().catch(error => {
    console.error('[desktop] failed to start Electron server sidecar', error)
  })
  await installApplicationMenu(app, () => mainWindow)
  if (shouldInstallTray(process.platform)) {
    trayController = await installTray({
      app,
      desktopRoot: appRoot(),
      show: () => showMainWindow(mainWindow, app),
      quit: () => {
        isQuitting = true
        app.quit()
      },
    }).catch(error => {
      console.error('[desktop] failed to create Electron tray', error)
      return null
    })
  }
  await createMainWindow()
  scheduleNotificationSmoke({
    env: process.env,
    NotificationClass: Notification,
    onAction: emitNotificationAction,
  })

  app.on('activate', () => {
    if (mainWindow) {
      showMainWindow(mainWindow, app)
      return
    }
    void createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (isQuitting && process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  isQuitting = true
  if (mainWindow) saveWindowState(app, mainWindow)
  trayController?.dispose()
  trayController = null
  terminalService?.killAll()
  previewService?.close()
  // Synchronous on quit so the Windows taskkill completes before the process
  // exits, otherwise the fire-and-forget kill can leave orphaned sidecars.
  getServerRuntime().stopAll(true)
})
