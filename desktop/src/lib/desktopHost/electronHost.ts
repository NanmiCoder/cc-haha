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
    kind: 'electron',
    isDesktop: true,
    capabilities: {
      appMode: true,
      dialogs: true,
      notifications: true,
      previewWebview: true,
      shell: true,
      terminal: true,
      updates: true,
      windowControls: true,
      zoom: true,
    },
    runtime: {
      getServerUrl: () => invoke(ELECTRON_IPC_CHANNELS.runtimeGetServerUrl),
    },
    app: {
      getVersion: () => invoke(ELECTRON_IPC_CHANNELS.appGetVersion),
    },
    commands: {
      invoke: (command, args) => invoke(ELECTRON_IPC_CHANNELS.commandInvoke, { command, args }),
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
      startDragging: input => invoke(ELECTRON_IPC_CHANNELS.windowStartDragging, input),
      requestAttention: () => invoke(ELECTRON_IPC_CHANNELS.windowRequestAttention),
      focus: () => invoke(ELECTRON_IPC_CHANNELS.windowFocus),
      isMaximized: () => invoke(ELECTRON_IPC_CHANNELS.windowIsMaximized),
      onResized: handler => subscribe(ELECTRON_EVENT_CHANNELS.windowResized, handler),
      onNativeMenuNavigate: handler => subscribe(ELECTRON_EVENT_CHANNELS.nativeMenuNavigate, handler),
    },
    terminal: {
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
      close: () => invoke(ELECTRON_IPC_CHANNELS.previewClose),
      message: payload => invoke(ELECTRON_IPC_CHANNELS.previewMessage, payload),
      onEvent: handler => subscribe(ELECTRON_EVENT_CHANNELS.previewEvent, handler),
    },
    appMode: {
      get: () => invoke(ELECTRON_IPC_CHANNELS.appModeGet),
      set: config => invoke(ELECTRON_IPC_CHANNELS.appModeSet, config),
      detectPortableDir: () => invoke(ELECTRON_IPC_CHANNELS.appModeDetectPortableDir),
      prepareRestart: () => invoke(ELECTRON_IPC_CHANNELS.appModePrepareRestart),
      restart: () => invoke(ELECTRON_IPC_CHANNELS.appModeRestart),
    },
    adapters: {
      restartSidecar: () => invoke(ELECTRON_IPC_CHANNELS.adaptersRestartSidecar),
    },
    zoom: {
      set: level => invoke(ELECTRON_IPC_CHANNELS.zoomSet, level),
    },
  }
}
