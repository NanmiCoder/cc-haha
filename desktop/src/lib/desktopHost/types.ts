import type {
  AppMode as SettingsAppMode,
  AppModeConfig as SettingsAppModeConfig,
} from '../../types/settings'

export type DesktopHostKind = 'browser' | 'electron'

export type DesktopHostCapability =
  | 'appMode'
  | 'dialogs'
  | 'notifications'
  | 'previewWebview'
  | 'shell'
  | 'terminal'
  | 'updates'
  | 'windowControls'
  | 'zoom'

export type DesktopHostCapabilities = Record<DesktopHostCapability, boolean>

export type DesktopHostUnlisten = () => void

export type DialogFileFilter = {
  name: string
  extensions: string[]
}

export type DialogOpenOptions = {
  directory?: boolean
  multiple?: boolean
  title?: string
  defaultPath?: string
  filters?: DialogFileFilter[]
}

export type DialogSaveOptions = {
  title?: string
  defaultPath?: string
  filters?: DialogFileFilter[]
}

export type NotificationPermissionState = 'granted' | 'denied' | 'default'

export type DesktopNotificationOptions = {
  title: string
  body?: string
  icon?: string
  id?: number
  extra?: Record<string, unknown>
  target?: unknown
}

export type DesktopUpdateDownloadEvent =
  | {
      event: 'Started'
      data: {
        contentLength?: number | null
      }
    }
  | {
      event: 'Progress'
      data: {
        chunkLength: number
      }
    }
  | {
      event: 'Finished'
    }

export type DesktopUpdate = {
  version: string
  body?: string | null
  download(onEvent?: (event: DesktopUpdateDownloadEvent) => void): Promise<void>
  install(): Promise<void>
  close(): Promise<void>
}

export type DesktopUpdateCheckOptions = {
  proxy?: string
}

export type TerminalSpawnOptions = {
  cwd?: string
  shell?: string
  cols: number
  rows: number
}

export type TerminalSession = {
  session_id: number
  shell: string
  cwd: string
}

export type TerminalOutputEvent = {
  session_id: number
  data: string
}

export type TerminalExitEvent = {
  session_id: number
  code: number
  signal?: string | null
}

export type PreviewBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type PreviewEvent = {
  type: string
  payload?: unknown
}

export type PreviewCaptureMessage = {
  v: 1
  type: 'capture'
  kind: 'full'
}

export type PreviewPickerMessage = {
  v: 1
  type: 'enter-picker' | 'exit-picker'
}

export type PreviewHostMessage = PreviewCaptureMessage | PreviewPickerMessage

export type AppModeConfig = SettingsAppModeConfig

export type WindowDragMoveInput = {
  deltaX: number
  deltaY: number
}

export type AppModeSetInput = {
  mode: SettingsAppMode
  portableDir: string | null
}

export type PortableDirDetection = {
  defaultPortableDir: string | null
  hasData: boolean
}

export type DesktopHost = {
  kind: DesktopHostKind
  isDesktop: boolean
  capabilities: DesktopHostCapabilities
  runtime: {
    getServerUrl(): Promise<string>
  }
  app: {
    getVersion(): Promise<string>
  }
  commands: {
    invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>
  }
  events: {
    listen<T>(eventName: string, handler: (payload: T) => void): Promise<DesktopHostUnlisten>
  }
  webview: {
    onDragDropEvent(handler: (event: unknown) => void): Promise<DesktopHostUnlisten>
  }
  shell: {
    open(target: string): Promise<void>
    openPath(path: string): Promise<void>
  }
  trace?: {
    openWindow(sessionId: string): Promise<void>
  }
  dialogs: {
    open(options?: DialogOpenOptions): Promise<string | string[] | null>
    save(options?: DialogSaveOptions): Promise<string | null>
  }
  updates: {
    check(options?: DesktopUpdateCheckOptions): Promise<DesktopUpdate | null>
    prepareInstall(): Promise<void>
    cancelInstall(): Promise<void>
    relaunch(): Promise<void>
  }
  notifications: {
    permissionState(): Promise<NotificationPermissionState>
    requestPermission(): Promise<NotificationPermissionState>
    send(options: DesktopNotificationOptions): Promise<void>
    onAction(handler: (payload: unknown) => void): Promise<DesktopHostUnlisten>
    ackAction(payload: unknown): Promise<boolean>
  }
  window: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<void>
    close(): Promise<void>
    startDragging(input?: WindowDragMoveInput): Promise<void>
    requestAttention(): Promise<void>
    focus(): Promise<void>
    isMaximized(): Promise<boolean>
    onResized(handler: () => void): Promise<DesktopHostUnlisten>
    onNativeMenuNavigate(handler: (destination: string) => void): Promise<DesktopHostUnlisten>
  }
  terminal: {
    spawn(options: TerminalSpawnOptions): Promise<TerminalSession>
    write(sessionId: number, data: string): Promise<void>
    resize(sessionId: number, cols: number, rows: number): Promise<void>
    kill(sessionId: number): Promise<void>
    onOutput(handler: (event: TerminalOutputEvent) => void): Promise<DesktopHostUnlisten>
    onExit(handler: (event: TerminalExitEvent) => void): Promise<DesktopHostUnlisten>
    getBashPath(): Promise<string | null>
    setBashPath(path: string | null): Promise<void>
  }
  preview: {
    open(url: string, bounds?: PreviewBounds): Promise<void>
    navigate(url: string): Promise<void>
    setBounds(bounds: PreviewBounds): Promise<void>
    setVisible(visible: boolean): Promise<void>
    close(): Promise<void>
    message(payload: PreviewHostMessage): Promise<void>
    onEvent(handler: (event: unknown) => void): Promise<DesktopHostUnlisten>
  }
  appMode: {
    get(): Promise<AppModeConfig>
    set(config: AppModeSetInput): Promise<void>
    detectPortableDir(): Promise<PortableDirDetection | null>
    prepareRestart(): Promise<void>
    restart(): Promise<void>
  }
  adapters: {
    restartSidecar(): Promise<void>
  }
  zoom: {
    set(level: number): Promise<void>
  }
}

declare global {
  interface Window {
    desktopHost?: DesktopHost
  }
}
