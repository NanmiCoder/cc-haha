import { PublicAccessManager } from './services/publicAccess'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, screen, session, WebContentsView } from 'electron'
import { autoUpdater } from 'electron-updater'
import path from 'node:path'
import { ELECTRON_EVENT_CHANNELS, ELECTRON_INTERNAL_CHANNELS, ELECTRON_IPC_CHANNELS, type ElectronIpcChannel } from './ipc/channels'
import {
  isElectronIpcChannel,
  isElectronIpcChannelAllowedForPetWindow,
  validateElectronIpcPayload,
} from './ipc/capabilities'
import { ElectronServerRuntime } from './services/serverRuntime'
import { appendHostDiagnostic, electronHostDiagnosticsFile, sanitizeHostDiagnostic } from './services/sidecarManager'
import { openDialog, saveDialog } from './services/dialogs'
import { openExternalUrl, openSystemPath, openSystemSettingsUrl } from './services/shell'
import {
  notificationPermissionState,
  requestNotificationPermission,
  sendDesktopNotification,
} from './services/notifications'
import { installApplicationMenu, installRendererContextMenu } from './services/menu'
import { saveWorkspaceBrowserPdf } from './services/workspaceBrowserPdf'
import { workspaceBrowserMenuPosition } from './services/workspaceBrowserMenu'
import type { WorkspaceBrowserMenuOptions } from '../src/lib/desktopHost/types'
import { acquireSingleInstanceLock } from './services/singleInstance'
import { installTray, shouldInstallTray, type TrayController } from './services/tray'
import { ElectronUpdaterService, updaterSessionProxyConfig } from './services/updater'
import { createUpdateSmokeUpdaterFromEnv } from './services/updateSmoke'
import { ElectronTerminalService, type TerminalSpawnInput } from './services/terminal'
import { ElectronPreviewService, type PreviewBounds } from './services/preview'
import {
  ElectronWorkspaceBrowserService,
  WORKSPACE_BROWSER_PARTITION,
  type WorkspaceBrowserBounds,
  type WorkspaceBrowserCaptureKind,
  type WorkspaceBrowserCreateOptions,
  type WorkspaceBrowserFindOptions,
} from './services/workspaceBrowser'
import {
  configureLocalServerRequestAuth,
  configurePreviewSessionPermissions,
  createPreviewSessionPartition,
  isAllowlistedMainRendererAuthRequest,
  type PreviewLocalAccess,
} from './services/previewSession'
import {
  applyStartupPortableMode,
  getAppMode,
  setAppMode,
} from './services/appMode'
import { installMacOsChromiumKeychainPromptGuard } from './services/keychain'
import { installStdioWriteFailureGuards } from './services/stdioGuards'
import { applyWindowsAppUserModelId } from './services/appIdentity'
import { installMainWindowNavigationGuards, installPreviewNavigationGuards } from './services/navigationGuards'
import { installPreviewCleanupOnRendererNavigation } from './services/previewLifecycle'
import { logNotificationSmokeRendererAck, scheduleNotificationSmoke } from './services/notificationSmoke'
import { normalizeZoomFactor } from './services/zoom'
import {
  applyAppliedAppearance,
  isAppliedAppearance,
  readAppearanceState,
  startupWindowBackground,
  type AppliedAppearance,
} from './services/nativeAppearance'
import { resolveRendererEntry } from './services/rendererEntry'
import { installRendererLifecycle } from './services/rendererLifecycle'
import { writeWindowSmokeSnapshot } from './services/windowSmoke'
import { loadAndRevealMainWindow } from './services/windowStartup'
import {
  PetWindowController,
  readPetWindowPosition,
  writePetWindowPosition,
  type PetWindowDragPayload,
} from './services/petWindow'
import {
  readLocalePreference,
  writeLocalePreference,
} from './services/localePreference'
import type { Locale } from '../src/i18n/locale'
import {
  createCustomPetCatalogLoader,
  createCustomPetFromAtlas,
  createCustomPetFromAtlasBytes,
  createCustomPetFromImage,
  ensureCustomPetsRoot,
  getPetPackageErrorCode,
  loadCustomPets,
  readCustomPetSourceImage,
} from './services/pets'
import {
  installWindowLifecycle,
  readWindowState,
  refreshWindowsDragHitTest,
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
let publicAccessManager: PublicAccessManager | null = null
let updaterService: ElectronUpdaterService | null = null
let terminalService: ElectronTerminalService | null = null
let previewService: ElectronPreviewService | null = null
let workspaceBrowserService: ElectronWorkspaceBrowserService | null = null
let petWindowController: PetWindowController | null = null
const traceWindows = new Map<string, BrowserWindow>()
let isQuitting = false
let quitCleanupStarted = false
let quitCleanupFinished = false
let trayController: TrayController | null = null

// Must run before anything logs: a Finder/Dock launch inherits unreadable
// stdio, and an unguarded write failure there surfaces as a crash dialog.
installStdioWriteFailureGuards()
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

function petPreloadPath() {
  return path.join(appRoot(), 'electron-dist', 'pet-preload.cjs')
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

/**
 * Last appearance the renderer reported, kept in memory so the OS-flip watcher
 * does not have to re-read the cache file (and race with its own write).
 * Seeded from disk on first use because the renderer has not reported yet.
 */
let lastAppliedAppearance: AppliedAppearance | null = null

function currentAppearance(): AppliedAppearance | null {
  if (!lastAppliedAppearance) lastAppliedAppearance = readAppearanceState(app)
  return lastAppliedAppearance
}

/**
 * The renderer keeps its theme in localStorage, which the main process cannot
 * read, so the last applied appearance is replayed from cache to pick the
 * pre-paint window background. First launch falls back to the OS setting.
 *
 * `shouldUseDarkColors` is the true OS setting here because `themeSource` is
 * never pinned — see services/nativeAppearance.ts.
 */
function resolveStartupWindowBackground(): string {
  return startupWindowBackground(currentAppearance(), nativeTheme.shouldUseDarkColors)
}

/**
 * While the user follows the OS, repaint window backgrounds the moment the OS
 * flips instead of waiting for the renderer to notice and report back — that
 * round-trip is visible as a flash of the old color when resizing.
 */
function installSystemAppearanceWatch() {
  nativeTheme.on('updated', () => {
    const current = currentAppearance()
    if (current && !current.followSystem) return
    const background = startupWindowBackground(current, nativeTheme.shouldUseDarkColors)
    for (const window of [mainWindow, ...traceWindows.values()]) {
      if (!window || window.isDestroyed()) continue
      window.setBackgroundColor(background)
    }
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
    backgroundColor: resolveStartupWindowBackground(),
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
    onServerUnavailable: () => { void publicAccessManager?.serverUnavailable() },
    onServerReady: () => { void publicAccessManager?.serverChanged() },
    desktopRoot: unpackedRoot(),
    appRoot: appRoot(),
    h5DistDir: path.join(unpackedRoot(), 'dist'),
    diagnosticsFile: electronHostDiagnosticsFile(process.env),
    resolveSystemProxy: (url) => session.defaultSession.resolveProxy(url),
  })
  return serverRuntime
}

function getPublicAccessManager() {
  if (publicAccessManager) return publicAccessManager
  let queue: Promise<unknown> = Promise.resolve()
  publicAccessManager = new PublicAccessManager({
    directory: path.join(getAppMode(app).activeConfigDir ?? app.getPath('userData'), 'cc-haha', 'public-access'),
    backend: {
      request<T>(route: string, method: string, body?: unknown): Promise<T> {
        const operation = queue.catch(() => {}).then(async () => {
          const runtime = getServerRuntime()
          // Never boot the sidecar merely to disable an already stopped tunnel.
          const serverUrl = runtime.getActiveServerUrl()
          if (!serverUrl) throw new Error('Server unavailable')
          const response = await fetch(`${serverUrl}/api/public-access${route}`, {
            method,
            headers: { Authorization: `Bearer ${runtime.getLocalAccessToken()}`, 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(10_000),
          })
          if (!response.ok) throw new Error('Public access configuration failed')
          return await response.json() as T
        })
        queue = operation
        return operation
      },
    },
  })
  return publicAccessManager
}

function resolvePetServerAccess(): PreviewLocalAccess | null {
  const runtime = getServerRuntime()
  const serverUrl = runtime.getActiveServerUrl()
  return serverUrl
    ? { serverUrl, token: runtime.getPetAccessToken() }
    : null
}

function resolveMainRendererServerAccess(): PreviewLocalAccess | null {
  const runtime = getServerRuntime()
  const serverUrl = runtime.getActiveServerUrl()
  return serverUrl
    ? { serverUrl, token: runtime.getLocalAccessToken() }
    : null
}

function getUpdaterService() {
  const smokeUpdater = createUpdateSmokeUpdaterFromEnv(process.env)
  updaterService ??= new ElectronUpdaterService(smokeUpdater ?? autoUpdater, {
    async apply(proxy) {
      // Update traffic runs on electron-updater's own session partition;
      // configuring app/defaultSession proxies never reaches it.
      await autoUpdater.netSession.setProxy(updaterSessionProxyConfig(proxy))
    },
  }, {
    updateConfigPath: !smokeUpdater && app.isPackaged ? path.join(process.resourcesPath, 'app-update.yml') : undefined,
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
    resolveScaleFactor: parent => {
      const bounds = parent.getBounds?.()
      return bounds ? screen.getDisplayMatching(bounds).scaleFactor : 1
    },
    createView: () => {
      const view = new WebContentsView({
        webPreferences: {
          preload: previewPreloadPath(),
          partition: createPreviewSessionPartition(),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      })
      configurePreviewSessionPermissions(view.webContents.session)
      installPreviewNavigationGuards(view.webContents, { openExternal: openExternalUrl })
      return view
    },
  })
  return previewService
}

function getPetWindowController() {
  petWindowController ??= new PetWindowController({
    createWindow: options => new BrowserWindow(options),
    getCursorScreenPoint: () => screen.getCursorScreenPoint(),
    getCurrentWorkArea: () => screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint(),
    ).workArea,
    getWorkAreaForPoint: point => screen.getDisplayNearestPoint(point).workArea,
    preloadPath: petPreloadPath(),
    platform: process.platform,
    readPosition: () => readPetWindowPosition(process.env, app.getPath('home')),
    writePosition: position => writePetWindowPosition(position, process.env, app.getPath('home')),
    onCreated: (window) => {
      configurePreviewSessionPermissions(window.webContents.session)
      configureLocalServerRequestAuth(
        window.webContents.session.webRequest,
        resolvePetServerAccess,
      )
      installMainWindowNavigationGuards(window.webContents, { openExternal: openExternalUrl })
    },
    load: window => loadRendererEntry(window, { petWindow: '1' }),
    onPanelPlacementChanged: (window, placement) => {
      if (window.isDestroyed()) return
      window.webContents.send(ELECTRON_EVENT_CHANNELS.petPanelPlacementChanged, placement)
    },
  })
  return petWindowController
}

const loadCustomPetCatalog = createCustomPetCatalogLoader(() => loadCustomPets({
    inspectImageSize: ({ data }) => nativeImage.createFromBuffer(data).getSize(),
  }))

function workspaceBrowserDownloadsDir() {
  return app.getPath('downloads')
}

function getWorkspaceBrowserService() {
  workspaceBrowserService ??= new ElectronWorkspaceBrowserService({
    previewScriptPath: previewAgentPath(),
    menuFactory: template => {
      const window = mainWindow
      if (!window || window.isDestroyed()) throw new Error('Workspace browser menu requires a live main window')
      const menu = Menu.buildFromTemplate(template)
      return {
        popup: options => menu.popup({ ...options, window }),
        closePopup: () => { if (!window.isDestroyed()) menu.closePopup(window) },
      }
    },
    emit: event => {
      mainWindow?.webContents.send(ELECTRON_EVENT_CHANNELS.workspaceBrowserEvent, event)
    },
    resolveScaleFactor: parent => {
      const bounds = parent.getBounds?.()
      return bounds ? screen.getDisplayMatching(bounds).scaleFactor : 1
    },
    writePdf: async ({ data, filename }) => {
      return saveWorkspaceBrowserPdf(data, async () => {
        if (!mainWindow || mainWindow.isDestroyed()) return null
        const result = await dialog.showSaveDialog(mainWindow, {
          defaultPath: path.join(workspaceBrowserDownloadsDir(), filename),
          filters: [{ name: 'PDF', extensions: ['pdf'] }],
        })
        return result.canceled ? null : result.filePath ?? null
      })
    },
    createView: () => {
      const view = new WebContentsView({
        webPreferences: {
          preload: previewPreloadPath(),
          // One shared persistent partition for every workspace page: a login in
          // one tab has to still be there in the next one. Per-tab partitions
          // would turn every new tab into a fresh, logged-out browser.
          partition: WORKSPACE_BROWSER_PARTITION,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      })
      // Same boundary as the singleton preview: OS permissions are denied, and
      // `configureLocalServerRequestAuth` is deliberately NOT installed here.
      // These pages render arbitrary remote sites, so attaching the desktop's
      // local access token to their loopback requests would hand any visited
      // site the local API.
      configurePreviewSessionPermissions(view.webContents.session)
      return view
    },
  })
  return workspaceBrowserService
}

async function listCustomPets() {
  const { pets, errors } = await loadCustomPetCatalog()
  return { pets, errors }
}

function focusPetSession(sessionId: string) {
  showMainWindow(mainWindow, app)
  mainWindow?.webContents.send(ELECTRON_EVENT_CHANNELS.petNavigateSession, sessionId)
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
    const senderWindow = BrowserWindow.fromWebContents(event.sender)
    if (channel.startsWith('desktop:public-access:') && (senderWindow !== mainWindow || event.senderFrame !== event.sender.mainFrame)) {
      throw new Error('Public access management requires the main desktop window')
    }
    if (
      petWindowController?.owns(senderWindow) &&
      !isElectronIpcChannelAllowedForPetWindow(channel)
    ) {
      throw new Error(`Electron IPC channel ${channel} is not available to the pet window`)
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

function broadcastLocaleChanged(locale: Locale) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    window.webContents.send(ELECTRON_EVENT_CHANNELS.appLocaleChanged, locale)
  }
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
    // Workspace pages and the legacy singleton preview share one preload, so the
    // owner of the sender decides which service receives the message.
    if (getWorkspaceBrowserService().handleMessageFromView(event.sender, raw)) return
    void getPreviewService().sendMessageToRenderer(event.sender, raw, mainWindow?.webContents)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.publicAccessGetStatus, () => getPublicAccessManager().getStatus())
  registerHandler(ELECTRON_IPC_CHANNELS.publicAccessSaveCredential, (_event, payload) => getPublicAccessManager().saveCredential(payload as string))
  registerHandler(ELECTRON_IPC_CHANNELS.publicAccessDeleteCredential, () => getPublicAccessManager().deleteCredential())
  registerHandler(ELECTRON_IPC_CHANNELS.publicAccessStart, (_event, payload) => getPublicAccessManager().start(payload as number))
  registerHandler(ELECTRON_IPC_CHANNELS.publicAccessStop, () => getPublicAccessManager().stop())
  registerHandler(ELECTRON_IPC_CHANNELS.publicAccessSetAutoStart, (_event, payload) => getPublicAccessManager().setAutoStart(payload as boolean))
  registerHandler(ELECTRON_IPC_CHANNELS.appGetVersion, () => app.getVersion())
  registerHandler(
    ELECTRON_IPC_CHANNELS.appGetLocalePreference,
    () => readLocalePreference(app),
  )
  registerHandler(ELECTRON_IPC_CHANNELS.appSetLocalePreference, (event, payload) => {
    if (currentWindow(event) !== mainWindow) {
      throw new Error('Only the main window can change the locale preference')
    }
    const locale = payload as Locale
    writeLocalePreference(app, locale)
    broadcastLocaleChanged(locale)
  })
  registerHandler(
    ELECTRON_IPC_CHANNELS.appGetPreferredSystemLanguages,
    () => app.getPreferredSystemLanguages(),
  )
  registerHandler(ELECTRON_IPC_CHANNELS.runtimeGetServerUrl, () => getServerRuntime().getServerUrl())
  registerHandler(
    ELECTRON_IPC_CHANNELS.runtimeGetLocalAccessToken,
    () => getServerRuntime().getLocalAccessToken(),
  )
  registerHandler(
    ELECTRON_IPC_CHANNELS.runtimeGetPetAccessToken,
    () => getServerRuntime().getPetAccessToken(),
  )
  registerHandler(ELECTRON_IPC_CHANNELS.commandInvoke, (_event, payload) => handleCommandInvoke(payload))
  registerHandler(ELECTRON_IPC_CHANNELS.clipboardReadText, () => clipboard.readText())
  registerHandler(ELECTRON_IPC_CHANNELS.clipboardWriteText, (_event, payload) => clipboard.writeText(String(payload)))
  registerHandler(ELECTRON_IPC_CHANNELS.shellOpen, (_event, payload) => openExternalUrl(String(payload)))
  registerHandler(ELECTRON_IPC_CHANNELS.shellOpenPath, (_event, payload) => openSystemPath(String(payload)))
  registerHandler(ELECTRON_IPC_CHANNELS.traceOpenWindow, (_event, payload) => openTraceWindow(String(payload)))
  registerHandler(ELECTRON_IPC_CHANNELS.petsList, () => listCustomPets())
  registerHandler(ELECTRON_IPC_CHANNELS.petsCreateFromImage, async (event, payload) => {
    const input = payload as {
      slug: string
      displayName: string
      description: string
      dialogTitle?: string
      dialogFilterName?: string
    }
    const imagePath = await openDialog(currentWindow(event), {
      title: input.dialogTitle || 'Choose a transparent pet image',
      filters: [{ name: input.dialogFilterName || 'Pet image', extensions: ['png', 'webp'] }],
    })
    if (typeof imagePath !== 'string') return null
    try {
      const pet = await loadCustomPetCatalog.invalidateAfter(() =>
        createCustomPetFromImage({
          slug: input.slug,
          displayName: input.displayName,
          description: input.description,
          imagePath,
        }, {
          inspectImageSize: ({ data }) => nativeImage.createFromBuffer(data).getSize(),
        }))
      return { id: pet.id }
    } catch (error) {
      return { errorCode: getPetPackageErrorCode(error) }
    }
  })
  registerHandler(ELECTRON_IPC_CHANNELS.petsCreateFromAtlas, async (event, payload) => {
    const input = payload as {
      slug: string
      displayName: string
      description: string
      dialogTitle?: string
      dialogFilterName?: string
    }
    const atlasPath = await openDialog(currentWindow(event), {
      title: input.dialogTitle || 'Choose a v2 pet animation atlas',
      filters: [{ name: input.dialogFilterName || 'Pet animation atlas', extensions: ['png', 'webp'] }],
    })
    if (typeof atlasPath !== 'string') return null
    try {
      const pet = await loadCustomPetCatalog.invalidateAfter(() =>
        createCustomPetFromAtlas({
          slug: input.slug,
          displayName: input.displayName,
          description: input.description,
          atlasPath,
        }, {
          inspectImageSize: ({ data }) => nativeImage.createFromBuffer(data).getSize(),
        }))
      return { id: pet.id }
    } catch (error) {
      return { errorCode: getPetPackageErrorCode(error) }
    }
  })
  registerHandler(ELECTRON_IPC_CHANNELS.petsPickSourceSheet, async (event, payload) => {
    const input = payload as { dialogTitle?: string, dialogFilterName?: string }
    const imagePath = await openDialog(currentWindow(event), {
      title: input.dialogTitle || 'Choose a pet action sheet',
      filters: [{ name: input.dialogFilterName || 'Pet action sheet', extensions: ['png', 'webp'] }],
    })
    if (typeof imagePath !== 'string') return null
    try {
      const source = await readCustomPetSourceImage(imagePath)
      // The renderer needs the pixels to assemble the atlas on a canvas; the path
      // itself is deliberately never handed over.
      return {
        bytes: source.data,
        mimeType: source.mimeType,
        width: source.width,
        height: source.height,
      }
    } catch (error) {
      return { errorCode: getPetPackageErrorCode(error) }
    }
  })
  registerHandler(ELECTRON_IPC_CHANNELS.petsCreateFromAtlasBytes, async (_event, payload) => {
    const input = payload as {
      slug: string
      displayName: string
      description: string
      atlasData: Uint8Array
      mimeType: 'image/png' | 'image/webp'
    }
    try {
      const pet = await loadCustomPetCatalog.invalidateAfter(() =>
        createCustomPetFromAtlasBytes({
          slug: input.slug,
          displayName: input.displayName,
          description: input.description,
          atlasData: input.atlasData,
          mimeType: input.mimeType,
        }, {
          inspectImageSize: ({ data }) => nativeImage.createFromBuffer(data).getSize(),
        }))
      return { id: pet.id }
    } catch (error) {
      return { errorCode: getPetPackageErrorCode(error) }
    }
  })
  registerHandler(ELECTRON_IPC_CHANNELS.petsOpenFolder, async () => {
    const root = await ensureCustomPetsRoot()
    await openSystemPath(root)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.petsShow, async () => {
    await getPetWindowController().show()
    mainWindow?.webContents.send(ELECTRON_EVENT_CHANNELS.petVisibilityChanged, true)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.petsHide, () => {
    getPetWindowController().hide()
    mainWindow?.webContents.send(ELECTRON_EVENT_CHANNELS.petVisibilityChanged, false)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.petsShowContextMenu, (event, payload) => {
    const { closeLabel } = payload as { closeLabel: string }
    return getPetWindowController().showContextMenu(
      currentWindow(event),
      closeLabel.trim(),
      Menu,
    )
  })
  registerHandler(ELECTRON_IPC_CHANNELS.petsDragWindow, (event, payload) =>
    getPetWindowController().dragWindow(
      currentWindow(event),
      payload as PetWindowDragPayload,
    ))
  registerHandler(ELECTRON_IPC_CHANNELS.petsSetIgnoreMouseEvents, (event, payload) => {
    getPetWindowController().setIgnoreMouseEvents(currentWindow(event), Boolean(payload))
  })
  registerHandler(ELECTRON_IPC_CHANNELS.petsSetInteractiveRegions, (event, payload) =>
    getPetWindowController().setInteractiveRegions(
      currentWindow(event),
      payload as Electron.Rectangle[],
    ))
  registerHandler(ELECTRON_IPC_CHANNELS.petsFocusMainWindow, (event) => {
    if (!getPetWindowController().owns(currentWindow(event))) {
      throw new Error('Pet window IPC sender does not own the companion window')
    }
    showMainWindow(mainWindow, app)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.petsFocusSession, (_event, payload) =>
    focusPetSession(String(payload)))
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
  registerHandler(ELECTRON_IPC_CHANNELS.updatePrepareInstall, async () => { await publicAccessManager?.stop(); getServerRuntime().stopAll() })
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
  registerHandler(ELECTRON_IPC_CHANNELS.terminalWrite, (event, payload) => {
    const { sessionId, data } = payload as { sessionId: number, data: string }
    return getTerminalService().write(sessionId, data, event.sender)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.terminalResize, (event, payload) => {
    const { sessionId, cols, rows } = payload as { sessionId: number, cols: number, rows: number }
    return getTerminalService().resize(sessionId, cols, rows, event.sender)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.terminalKill, (event, payload) => {
    const { sessionId } = payload as { sessionId: number }
    return getTerminalService().kill(sessionId, event.sender)
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
  registerHandler(ELECTRON_IPC_CHANNELS.previewSetZoom, (_event, payload) => getPreviewService().setZoomFactor(payload))
  registerHandler(ELECTRON_IPC_CHANNELS.previewClose, () => getPreviewService().close())
  registerHandler(ELECTRON_IPC_CHANNELS.previewMessage, (event, payload) => getPreviewService().message(payload, event.sender))
  registerHandler(ELECTRON_IPC_CHANNELS.workspaceBrowserCreate, (event, payload) => {
    // The service keeps a single parent window, so whichever renderer calls
    // `create` last owns where every page is attached and detached. Trace and
    // pet windows load the same preload, so without this a secondary window
    // could adopt the pages and strand them as unremovable children of the main
    // window. Same guard shape as `appSetLocalePreference`.
    if (!mainWindow || currentWindow(event) !== mainWindow) {
      throw new Error('Only the main window can host workspace browser pages')
    }
    const { tabId, ...options } = payload as { tabId: string } & WorkspaceBrowserCreateOptions
    return getWorkspaceBrowserService().create(mainWindow, tabId, options)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.workspaceBrowserNavigate, (_event, payload) => {
    const { tabId, url } = payload as { tabId: string, url: string }
    return getWorkspaceBrowserService().navigate(tabId, url)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.workspaceBrowserShowMenu, (event, payload) => {
    if (!mainWindow || currentWindow(event) !== mainWindow || mainWindow.isDestroyed()) {
      throw new Error('Only the main window can open workspace browser menus')
    }
    const { tabId, ...options } = payload as { tabId: string } & WorkspaceBrowserMenuOptions
    const { width, height } = mainWindow.getContentBounds()
    const anchor = workspaceBrowserMenuPosition(options, mainWindow.webContents.getZoomFactor(), { width, height })
    return getWorkspaceBrowserService().showMenu(mainWindow, tabId, { ...options, ...anchor })
  })
  registerHandler(ELECTRON_IPC_CHANNELS.workspaceBrowserGoBack, (_event, payload) =>
    getWorkspaceBrowserService().goBack((payload as { tabId: string }).tabId))
  registerHandler(ELECTRON_IPC_CHANNELS.workspaceBrowserGoForward, (_event, payload) =>
    getWorkspaceBrowserService().goForward((payload as { tabId: string }).tabId))
  registerHandler(ELECTRON_IPC_CHANNELS.workspaceBrowserReload, (_event, payload) => {
    const { tabId, ignoreCache } = payload as { tabId: string, ignoreCache?: boolean }
    return getWorkspaceBrowserService().reload(tabId, { ignoreCache })
  })
  registerHandler(ELECTRON_IPC_CHANNELS.workspaceBrowserStop, (_event, payload) =>
    getWorkspaceBrowserService().stop((payload as { tabId: string }).tabId))
  registerHandler(ELECTRON_IPC_CHANNELS.workspaceBrowserSetBounds, (_event, payload) => {
    const { tabId, bounds } = payload as { tabId: string, bounds: WorkspaceBrowserBounds }
    return getWorkspaceBrowserService().setBounds(tabId, bounds)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.workspaceBrowserSetVisible, (_event, payload) => {
    const { tabId, visible } = payload as { tabId: string, visible: boolean }
    return getWorkspaceBrowserService().setVisible(tabId, visible)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.workspaceBrowserSetZoom, (_event, payload) => {
    const { tabId, factor } = payload as { tabId: string, factor: number }
    return getWorkspaceBrowserService().setZoom(tabId, factor)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.workspaceBrowserFind, (_event, payload) => {
    const { tabId, text, options } = payload as {
      tabId: string
      text: string
      options?: WorkspaceBrowserFindOptions
    }
    return getWorkspaceBrowserService().find(tabId, text, options)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.workspaceBrowserStopFind, (_event, payload) =>
    getWorkspaceBrowserService().stopFind((payload as { tabId: string }).tabId))
  registerHandler(ELECTRON_IPC_CHANNELS.workspaceBrowserCapture, (_event, payload) => {
    const { tabId, kind } = payload as { tabId: string, kind: WorkspaceBrowserCaptureKind }
    return getWorkspaceBrowserService().capture(tabId, kind)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.workspaceBrowserSnapshot, (_event, payload) =>
    getWorkspaceBrowserService().snapshot((payload as { tabId: string }).tabId))
  registerHandler(ELECTRON_IPC_CHANNELS.workspaceBrowserMessage, (_event, payload) => {
    const { tabId, payload: message } = payload as { tabId: string, payload: unknown }
    return getWorkspaceBrowserService().message(tabId, message)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.workspaceBrowserPrintToPdf, (_event, payload) =>
    getWorkspaceBrowserService().printToPdf((payload as { tabId: string }).tabId))
  registerHandler(ELECTRON_IPC_CHANNELS.workspaceBrowserClose, (_event, payload) =>
    getWorkspaceBrowserService().close((payload as { tabId: string }).tabId))
  registerHandler(ELECTRON_IPC_CHANNELS.appModeGet, () => getAppMode(app))
  registerHandler(ELECTRON_IPC_CHANNELS.appModeSet, (_event, payload) => setAppMode(app, payload as Parameters<typeof setAppMode>[1]))
  registerHandler(ELECTRON_IPC_CHANNELS.appModePrepareRestart, () => getServerRuntime().stopAll(true))
  registerHandler(ELECTRON_IPC_CHANNELS.appModeRestart, () => {
    isQuitting = true
    app.relaunch()
    app.quit()
  })
  registerHandler(ELECTRON_IPC_CHANNELS.adaptersRestartSidecar, () => getServerRuntime().restartAdaptersSidecars())
  registerHandler(ELECTRON_IPC_CHANNELS.zoomSet, (event, payload) => currentWindow(event).webContents.setZoomFactor(normalizeZoomFactor(payload)))
  registerHandler(ELECTRON_IPC_CHANNELS.appearanceSetApplied, (_event, payload) => {
    if (!isAppliedAppearance(payload)) return
    lastAppliedAppearance = payload
    applyAppliedAppearance(payload, {
      app,
      // The pet window is deliberately transparent, so it stays out of this.
      windows: () => [mainWindow, ...traceWindows.values()].filter((window): window is BrowserWindow => !!window),
    })
  })
}

async function createMainWindow() {
  const restoredState = readWindowState(app, screen.getAllDisplays())
  const bounds = windowOptionsFromState(restoredState)
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    // Painted before the renderer produces its first frame; without it a
    // dark-theme user gets a white flash on every launch.
    backgroundColor: resolveStartupWindowBackground(),
    ...windowChromeOptionsForPlatform(process.platform),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  configureLocalServerRequestAuth(
    mainWindow.webContents.session.webRequest,
    resolveMainRendererServerAccess,
    details => isAllowlistedMainRendererAuthRequest(
      details,
      mainWindow!.webContents.id,
    ),
  )
  installMainWindowNavigationGuards(mainWindow.webContents, { openExternal: openExternalUrl })
  await installRendererContextMenu(mainWindow)
  installPreviewCleanupOnRendererNavigation(mainWindow.webContents, () => {
    previewService?.close()
    // A renderer reload discards every workspace tab, so the pages behind them
    // have to go too rather than linger as orphaned webContents.
    workspaceBrowserService?.closeAll()
  })

  installWindowLifecycle({
    app,
    window: mainWindow,
    shouldQuit: () => isQuitting,
  })

  const window = mainWindow
  const diagnosticsFile = electronHostDiagnosticsFile(process.env)
  const recordRendererDiagnostic = (detail: string) => {
    const sanitized = sanitizeHostDiagnostic(detail)
    appendHostDiagnostic(diagnosticsFile, `[renderer] ${sanitized}`)
    return sanitized
  }

  window.on('resize', () => {
    if (window.isDestroyed()) return
    window.webContents.send(ELECTRON_EVENT_CHANNELS.windowResized)
  })
  installRendererLifecycle({
    window,
    isQuitting: () => isQuitting,
    recordDiagnostic: recordRendererDiagnostic,
    writeSnapshot: reason => writeWindowSmokeSnapshot(window, reason),
    onRendererProcessGone: detail => {
      console.error(`[desktop] Electron renderer process exited: ${detail}`)
    },
    onRecoveryExhausted: detail => {
      console.error(`[desktop] Electron renderer recovery exhausted: ${detail}`)
      dialog.showErrorBox(
        '界面恢复失败 / Interface Recovery Failed',
        `桌面界面意外退出或持续无响应，自动恢复未能解决问题。请重启应用；如果问题持续存在，请附上诊断日志反馈。\n\nThe desktop interface exited unexpectedly or remained unresponsive, and automatic recovery did not resolve it. Restart the app and include diagnostics when reporting the problem.\n\n${detail}`,
      )
    },
  })
  writeWindowSmokeSnapshot(mainWindow, 'after-create')

  await loadAndRevealMainWindow({
    load: () => loadRendererEntry(mainWindow!),
    beforeReveal: () => restoreWindowMaximized(mainWindow!, restoredState),
    reveal: () => showMainWindow(mainWindow, app),
    onLoadFailure: (error) => {
      const detail = sanitizeHostDiagnostic(error instanceof Error ? error.message : String(error))
      console.error(`[desktop] failed to load Electron renderer: ${detail}`)
      writeWindowSmokeSnapshot(mainWindow, 'renderer-load-failed')
      dialog.showErrorBox(
        '启动错误 / Startup Error',
        `桌面界面加载失败，请重启应用。如果问题持续存在，请附上诊断日志反馈。\n\nThe desktop interface could not be loaded. Restart the app and include diagnostics when reporting the problem.\n\n${detail}`,
      )
    },
  })
  refreshWindowsDragHitTest(mainWindow, process.platform)
  writeWindowSmokeSnapshot(mainWindow, 'after-final-show')
}

if (!acquireSingleInstanceLock(app, () => mainWindow)) {
  process.exit(0)
}

registerIpcHandlers()

app.whenReady().then(async () => {
  applyWindowsAppUserModelId(app)
  applyStartupPortableMode(app)
  installSystemAppearanceWatch()
  screen.on('display-metrics-changed', (_event, _display, changedMetrics) => {
    if (changedMetrics.includes('scaleFactor') || changedMetrics.includes('bounds')) {
      previewService?.refreshBounds()
      workspaceBrowserService?.refreshBounds()
    }
  })
  await getServerRuntime().startServer().catch(error => {
    console.error('[desktop] failed to start Electron server sidecar', error)
  })
  await getPublicAccessManager().restore().catch(() => {})
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

app.on('before-quit', event => {
  isQuitting = true
  if (quitCleanupFinished) return
  event.preventDefault()
  if (quitCleanupStarted) return
  quitCleanupStarted = true
  const cleanupSteps = {
    window: () => { if (mainWindow) saveWindowState(app, mainWindow) },
    tray: () => { trayController?.dispose() },
    terminal: () => { terminalService?.killAll() },
    preview: () => { previewService?.close() },
    workspaceBrowser: () => { workspaceBrowserService?.closeAll() },
    pet: () => { petWindowController?.dispose() },
  }
  // A destroyed native view or PTY can throw during cleanup. Keep going so a
  // failed resource cannot leave every later quit blocked by cleanupStarted.
  for (const [resource, cleanup] of Object.entries(cleanupSteps)) {
    try {
      cleanup()
    } catch (error) {
      console.error(`[desktop] ${resource} cleanup failed during quit`, error)
    }
  }
  trayController = null
  petWindowController = null
  // Keep Electron (and the server's stdout/stderr pipes) alive until the server
  // has waited for its CLI children to finish their graceful cleanup. The CLI
  // owns the launchd-reparented Computer Use helper, so exiting the host first
  // can strand its active turn across an immediate app restart.
  void (async () => {
    try {
      try {
        await publicAccessManager?.dispose()
      } catch {
        // Provider errors may contain credentials. A tunnel cleanup failure
        // must never bypass the sidecar's graceful shutdown.
        console.error('[desktop] public access cleanup failed during quit')
      }
      await getServerRuntime().stopAllAndWait()
    } catch (error) {
      console.error('[desktop] graceful server shutdown failed', error)
    } finally {
      quitCleanupFinished = true
      app.quit()
    }
  })()
})
