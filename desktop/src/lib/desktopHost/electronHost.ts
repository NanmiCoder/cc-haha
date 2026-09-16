import type {
  DesktopHost,
  DesktopHostUnlisten,
  DesktopUpdate,
  DesktopUpdateDownloadEvent,
} from './types'
import {
  ELECTRON_EVENT_CHANNELS,
  ELECTRON_IPC_CHANNELS,
  type ElectronEventChannel,
  type ElectronIpcChannel,
} from '../../../electron/ipc/channels'
import { validateElectronIpcPayload } from '../../../electron/ipc/capabilities'

export type ElectronHostBridge = {
  invoke<T>(channel: ElectronIpcChannel, payload?: unknown): Promise<T>
  getPathForFile?(file: File): string
  subscribe<T>(
    channel: ElectronEventChannel,
    handler: (payload: T) => void,
  ): Promise<DesktopHostUnlisten>
}

type ElectronUpdateMetadata = {
  version: string
  body?: string | null
}

function safeInvoke<T>(
  bridge: ElectronHostBridge,
  channel: ElectronIpcChannel,
  payload?: unknown,
): Promise<T> {
  if (!validateElectronIpcPayload(channel, payload)) {
    return Promise.reject(new Error(`Invalid Electron IPC payload for ${channel}`))
  }
  return bridge.invoke<T>(channel, payload)
}

export function createElectronHost(bridge: ElectronHostBridge): DesktopHost {
  const invoke = <T>(channel: ElectronIpcChannel, payload?: unknown) =>
    safeInvoke<T>(bridge, channel, payload)
  const subscribe = <T>(channel: ElectronEventChannel, handler: (payload: T) => void) =>
    bridge.subscribe(channel, handler)
  const createUpdate = (metadata: ElectronUpdateMetadata): DesktopUpdate => ({
    version: metadata.version,
    body: metadata.body ?? null,
    async download(onEvent) {
      const unlisten = onEvent
        ? await subscribe<DesktopUpdateDownloadEvent>(ELECTRON_EVENT_CHANNELS.updateDownloadEvent, onEvent)
        : null
      try {
        await invoke(ELECTRON_IPC_CHANNELS.updateDownload)
      } finally {
        unlisten?.()
      }
    },
    install: () => invoke(ELECTRON_IPC_CHANNELS.updateInstall),
    close: () => invoke(ELECTRON_IPC_CHANNELS.updateCancelInstall),
  })

  return {
    publicAccess: {
      getStatus: () => invoke(ELECTRON_IPC_CHANNELS.publicAccessGetStatus),
      saveCredential: token => invoke(ELECTRON_IPC_CHANNELS.publicAccessSaveCredential, token),
      deleteCredential: () => invoke(ELECTRON_IPC_CHANNELS.publicAccessDeleteCredential),
      start: consentVersion => invoke(ELECTRON_IPC_CHANNELS.publicAccessStart, consentVersion),
      stop: () => invoke(ELECTRON_IPC_CHANNELS.publicAccessStop),
      setAutoStart: enabled => invoke(ELECTRON_IPC_CHANNELS.publicAccessSetAutoStart, enabled),
    },
    kind: 'electron',
    isDesktop: true,
    capabilities: {
      appMode: true,
      clipboard: true,
      dialogs: true,
      notifications: true,
      previewWebview: true,
      workspaceBrowser: true,
      shell: true,
      terminal: true,
      updates: true,
      windowControls: true,
      zoom: true,
    },
    runtime: {
      getServerUrl: () => invoke(ELECTRON_IPC_CHANNELS.runtimeGetServerUrl),
      getLocalAccessToken: () => invoke(ELECTRON_IPC_CHANNELS.runtimeGetLocalAccessToken),
    },
    app: {
      getVersion: () => invoke(ELECTRON_IPC_CHANNELS.appGetVersion),
      getLocalePreference: () => invoke(ELECTRON_IPC_CHANNELS.appGetLocalePreference),
      setLocalePreference: locale => invoke(ELECTRON_IPC_CHANNELS.appSetLocalePreference, locale),
      getPreferredSystemLanguages: () => invoke(ELECTRON_IPC_CHANNELS.appGetPreferredSystemLanguages),
      onLocaleChanged: handler => subscribe(ELECTRON_EVENT_CHANNELS.appLocaleChanged, handler),
    },
    commands: {
      invoke: (command, args) => invoke(ELECTRON_IPC_CHANNELS.commandInvoke, { command, args }),
    },
    clipboard: {
      readText: () => invoke(ELECTRON_IPC_CHANNELS.clipboardReadText),
      writeText: text => invoke(ELECTRON_IPC_CHANNELS.clipboardWriteText, text),
    },
    files: {
      getPathForFile(file) {
        const nativePath = bridge.getPathForFile?.(file)
        if (nativePath) return nativePath
        const legacyPath = (file as File & { path?: unknown }).path
        return typeof legacyPath === 'string' ? legacyPath : ''
      },
    },
    events: {
      listen: (_eventName, handler) => subscribe(ELECTRON_EVENT_CHANNELS.event, handler),
    },
    webview: {
      onDragDropEvent: handler => subscribe(ELECTRON_EVENT_CHANNELS.webviewDragDrop, handler),
    },
    shell: {
      open: target => invoke(ELECTRON_IPC_CHANNELS.shellOpen, target),
      openPath: path => invoke(ELECTRON_IPC_CHANNELS.shellOpenPath, path),
    },
    trace: {
      openWindow: sessionId => invoke(ELECTRON_IPC_CHANNELS.traceOpenWindow, sessionId),
    },
    pets: {
      list: () => invoke(ELECTRON_IPC_CHANNELS.petsList),
      createFromImage: input => invoke(ELECTRON_IPC_CHANNELS.petsCreateFromImage, input),
      createFromAtlas: input => invoke(ELECTRON_IPC_CHANNELS.petsCreateFromAtlas, input),
      pickSourceSheet: input => invoke(ELECTRON_IPC_CHANNELS.petsPickSourceSheet, input),
      createFromAtlasBytes: input => invoke(ELECTRON_IPC_CHANNELS.petsCreateFromAtlasBytes, input),
      openFolder: () => invoke(ELECTRON_IPC_CHANNELS.petsOpenFolder),
      show: () => invoke(ELECTRON_IPC_CHANNELS.petsShow),
      hide: () => invoke(ELECTRON_IPC_CHANNELS.petsHide),
      showContextMenu: closeLabel => invoke(
        ELECTRON_IPC_CHANNELS.petsShowContextMenu,
        { closeLabel },
      ),
      dragWindow: payload => invoke(ELECTRON_IPC_CHANNELS.petsDragWindow, payload),
      setIgnoreMouseEvents: ignore => invoke(ELECTRON_IPC_CHANNELS.petsSetIgnoreMouseEvents, ignore),
      setInteractiveRegions: regions => invoke(ELECTRON_IPC_CHANNELS.petsSetInteractiveRegions, regions),
      focusMainWindow: () => invoke(ELECTRON_IPC_CHANNELS.petsFocusMainWindow),
      focusSession: sessionId => invoke(ELECTRON_IPC_CHANNELS.petsFocusSession, sessionId),
      onNavigateSession: handler => subscribe(ELECTRON_EVENT_CHANNELS.petNavigateSession, handler),
      onVisibilityChanged: handler => subscribe(ELECTRON_EVENT_CHANNELS.petVisibilityChanged, handler),
      onPanelPlacementChanged: handler =>
        subscribe(ELECTRON_EVENT_CHANNELS.petPanelPlacementChanged, handler),
    },
    dialogs: {
      open: options => invoke(ELECTRON_IPC_CHANNELS.dialogOpen, options),
      save: options => invoke(ELECTRON_IPC_CHANNELS.dialogSave, options),
    },
    updates: {
      check: async (options) => {
        const update = await invoke<ElectronUpdateMetadata | null>(ELECTRON_IPC_CHANNELS.updateCheck, options)
        return update ? createUpdate(update) : null
      },
      prepareInstall: () => invoke(ELECTRON_IPC_CHANNELS.updatePrepareInstall),
      cancelInstall: () => invoke(ELECTRON_IPC_CHANNELS.updateCancelInstall),
      relaunch: () => invoke(ELECTRON_IPC_CHANNELS.updateRelaunch),
    },
    notifications: {
      permissionState: () => invoke(ELECTRON_IPC_CHANNELS.notificationPermissionState),
      requestPermission: () => invoke(ELECTRON_IPC_CHANNELS.notificationRequestPermission),
      send: options => invoke(ELECTRON_IPC_CHANNELS.notificationSend, options),
      onAction: handler => subscribe(ELECTRON_EVENT_CHANNELS.notificationAction, handler),
      ackAction: payload => invoke(ELECTRON_IPC_CHANNELS.notificationActionAck, payload),
    },
    window: {
      minimize: () => invoke(ELECTRON_IPC_CHANNELS.windowMinimize),
      toggleMaximize: () => invoke(ELECTRON_IPC_CHANNELS.windowToggleMaximize),
      close: () => invoke(ELECTRON_IPC_CHANNELS.windowClose),
      startDragging: () => invoke(ELECTRON_IPC_CHANNELS.windowStartDragging),
      requestAttention: () => invoke(ELECTRON_IPC_CHANNELS.windowRequestAttention),
      focus: () => invoke(ELECTRON_IPC_CHANNELS.windowFocus),
      isMaximized: () => invoke(ELECTRON_IPC_CHANNELS.windowIsMaximized),
      onResized: handler => subscribe(ELECTRON_EVENT_CHANNELS.windowResized, handler),
      onNativeMenuNavigate: handler => subscribe(ELECTRON_EVENT_CHANNELS.nativeMenuNavigate, handler),
    },
    terminal: {
      supportsStartupCorrelation: true,
      spawn: options => invoke(ELECTRON_IPC_CHANNELS.terminalSpawn, options),
      write: (sessionId, data) => invoke(ELECTRON_IPC_CHANNELS.terminalWrite, { sessionId, data }),
      resize: (sessionId, cols, rows) => invoke(ELECTRON_IPC_CHANNELS.terminalResize, { sessionId, cols, rows }),
      kill: sessionId => invoke(ELECTRON_IPC_CHANNELS.terminalKill, { sessionId }),
      onOutput: handler => subscribe(ELECTRON_EVENT_CHANNELS.terminalOutput, handler),
      onExit: handler => subscribe(ELECTRON_EVENT_CHANNELS.terminalExit, handler),
      getBashPath: () => invoke(ELECTRON_IPC_CHANNELS.terminalGetBashPath),
      setBashPath: path => invoke(ELECTRON_IPC_CHANNELS.terminalSetBashPath, path),
    },
    preview: {
      open: (url, bounds) => invoke(ELECTRON_IPC_CHANNELS.previewOpen, { url, bounds }),
      navigate: url => invoke(ELECTRON_IPC_CHANNELS.previewNavigate, url),
      setBounds: bounds => invoke(ELECTRON_IPC_CHANNELS.previewSetBounds, bounds),
      setVisible: visible => invoke(ELECTRON_IPC_CHANNELS.previewSetVisible, visible),
      setZoom: level => invoke(ELECTRON_IPC_CHANNELS.previewSetZoom, level),
      close: () => invoke(ELECTRON_IPC_CHANNELS.previewClose),
      message: payload => invoke(ELECTRON_IPC_CHANNELS.previewMessage, payload),
      onEvent: handler => subscribe(ELECTRON_EVENT_CHANNELS.previewEvent, handler),
    },
    browser: {
      showMenu: (tabId, options) => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserShowMenu, { ...options, tabId }),
      create: (tabId, options) => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserCreate, {
        tabId,
        storageId: options.storageId,
        ...(options.url === undefined ? {} : { url: options.url }),
        ...(options.bounds === undefined ? {} : { bounds: options.bounds }),
        ...(options.visible === undefined ? {} : { visible: options.visible }),
      }),
      navigate: (tabId, url) => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserNavigate, { tabId, url }),
      goBack: tabId => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserGoBack, { tabId }),
      goForward: tabId => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserGoForward, { tabId }),
      reload: (tabId, options) => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserReload, {
        tabId,
        ...(options?.ignoreCache === undefined ? {} : { ignoreCache: options.ignoreCache }),
      }),
      stop: tabId => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserStop, { tabId }),
      setBounds: (tabId, bounds) => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserSetBounds, { tabId, bounds }),
      setVisible: (tabId, visible) => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserSetVisible, { tabId, visible }),
      setZoom: (tabId, factor) => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserSetZoom, { tabId, factor }),
      find: (tabId, text, options) => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserFind, {
        tabId,
        text,
        ...(options === undefined ? {} : { options }),
      }),
      stopFind: tabId => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserStopFind, { tabId }),
      capture: (tabId, kind) => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserCapture, { tabId, kind }),
      snapshot: (tabId) => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserSnapshot, { tabId }),
      message: (tabId, payload) => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserMessage, { tabId, payload }),
      printToPdf: tabId => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserPrintToPdf, { tabId }),
      close: tabId => invoke(ELECTRON_IPC_CHANNELS.workspaceBrowserClose, { tabId }),
      onEvent: handler => subscribe(ELECTRON_EVENT_CHANNELS.workspaceBrowserEvent, handler),
    },
    appMode: {
      get: () => invoke(ELECTRON_IPC_CHANNELS.appModeGet),
      set: config => invoke(ELECTRON_IPC_CHANNELS.appModeSet, config),
      prepareRestart: () => invoke(ELECTRON_IPC_CHANNELS.appModePrepareRestart),
      restart: () => invoke(ELECTRON_IPC_CHANNELS.appModeRestart),
    },
    adapters: {
      restartSidecar: () => invoke(ELECTRON_IPC_CHANNELS.adaptersRestartSidecar),
    },
    zoom: {
      set: level => invoke(ELECTRON_IPC_CHANNELS.zoomSet, level),
    },
    appearance: {
      setApplied: state => invoke(ELECTRON_IPC_CHANNELS.appearanceSetApplied, state),
    },
  }
}
