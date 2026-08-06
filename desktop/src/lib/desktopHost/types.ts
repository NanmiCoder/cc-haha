import type {
  AppMode as SettingsAppMode,
  AppModeConfig as SettingsAppModeConfig,
} from '../../types/settings'
import type { Locale } from '../../i18n/locale'

export type DesktopHostKind = 'browser' | 'electron'

export type DesktopHostCapability =
  | 'appMode'
  | 'clipboard'
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

export type DesktopPetInteractiveRegion = {
  x: number
  y: number
  width: number
  height: number
}

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

/**
 * What the renderer settled on, reported to the native shell so the window
 * background and the OS-drawn chrome can match it.
 */
export type AppliedAppearance = {
  isDark: boolean
  /** Base background of the applied theme, as a CSS hex color. */
  background: string
  /**
   * Base background of the user's light theme, also as a hex color. Carried
   * separately so a shell that cached this at night knows which light theme to
   * repaint when it next starts in the morning.
   */
  lightBackground: string
  /** Whether the renderer is tracking the OS setting rather than a fixed pick. */
  followSystem: boolean
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
} & (
  | {
      type: 'enter-picker'
      mode?: 'single' | 'batch'
      label?: number
      copy?: {
        cancel: string
        send: string
        queueAndContinue: string
        add: string
        descriptionPlaceholder: string
      }
    }
  | { type: 'exit-picker' }
  | { type: 'undo-selection'; itemId: string }
  | { type: 'clear-selection-draft' }
  | { type: 'commit-selection-draft' }
)

export type PreviewHostMessage = PreviewCaptureMessage | PreviewPickerMessage

type DesktopPetBase = {
  id: string
  displayName: string
  description: string
  mimeType: 'image/png' | 'image/webp'
  dataUrl: string
}

export type DesktopAtlasPet = DesktopPetBase & {
  spriteVersionNumber: 2
  spritesheetPath: string
}

export type DesktopImagePet = DesktopPetBase & {
  manifestVersion: 1
  spriteVersionNumber: 1
  imagePath: string
  motionProfile: 'soft-spring-v1'
}

export type DesktopPet = DesktopAtlasPet | DesktopImagePet

export type DesktopPetLoadError = {
  entry?: string
  code: string
  message: string
}

export type DesktopPetListResult = {
  pets: DesktopPet[]
  errors: DesktopPetLoadError[]
}

export type DesktopPetCreateInput = {
  slug: string
  displayName: string
  description: string
  dialogTitle?: string
  dialogFilterName?: string
}

export type DesktopPetCreateResult =
  | { id: string }
  | { errorCode: string }

export type DesktopPetSheetPickInput = {
  dialogTitle?: string
  dialogFilterName?: string
}

/** Decoded pixels of a user-picked action sheet, ready to be normalized on a canvas. */
export type DesktopPetSourceSheet = {
  bytes: Uint8Array
  mimeType: 'image/png' | 'image/webp'
  width: number
  height: number
}

export type DesktopPetSheetPickResult =
  | DesktopPetSourceSheet
  | { errorCode: string }

export type DesktopPetCreateFromAtlasBytesInput = {
  slug: string
  displayName: string
  description: string
  atlasData: Uint8Array
  mimeType: 'image/png' | 'image/webp'
}

export type DesktopPetWindowDrag = {
  phase: 'start' | 'move' | 'end'
  x: number
  y: number
}

/**
 * Which side of the mascot the host wants the activity panel drawn on.
 *
 * The mascot is clamped to the display edge through the window's transparent
 * padding, so at a display edge the wider panel that shares that padding ends
 * up off-screen. Only the host knows the window position and the work area, so
 * it decides and the renderer follows.
 */
export type DesktopPetPanelPlacement = {
  vertical: 'above' | 'below'
  horizontal: 'center' | 'left' | 'right'
}

export type AppModeConfig = SettingsAppModeConfig

export type AppModeSetInput = {
  mode: SettingsAppMode
  portableDir: string | null
}

export type DesktopHost = {
  kind: DesktopHostKind
  isDesktop: boolean
  capabilities: DesktopHostCapabilities
  runtime: {
    getServerUrl(): Promise<string>
    getLocalAccessToken(): Promise<string | null>
  }
  app: {
    getVersion(): Promise<string>
    getLocalePreference(): Promise<Locale | null>
    setLocalePreference(locale: Locale): Promise<void>
    getPreferredSystemLanguages(): Promise<string[]>
    onLocaleChanged(handler: (locale: Locale) => void): Promise<DesktopHostUnlisten>
  }
  commands: {
    invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>
  }
  clipboard: {
    readText(): Promise<string>
    writeText(text: string): Promise<void>
  }
  files: {
    getPathForFile(file: File): string
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
  pets: {
    list(): Promise<DesktopPetListResult>
    createFromImage(input: DesktopPetCreateInput): Promise<DesktopPetCreateResult | null>
    createFromAtlas(input: DesktopPetCreateInput): Promise<DesktopPetCreateResult | null>
    pickSourceSheet(input: DesktopPetSheetPickInput): Promise<DesktopPetSheetPickResult | null>
    createFromAtlasBytes(
      input: DesktopPetCreateFromAtlasBytesInput,
    ): Promise<DesktopPetCreateResult | null>
    openFolder(): Promise<void>
    show(): Promise<void>
    hide(): Promise<void>
    showContextMenu(closeLabel: string): Promise<boolean>
    dragWindow(payload: DesktopPetWindowDrag): Promise<DesktopPetPanelPlacement>
    setIgnoreMouseEvents(ignore: boolean): Promise<void>
    setInteractiveRegions(
      regions: DesktopPetInteractiveRegion[],
    ): Promise<DesktopPetPanelPlacement>
    focusMainWindow(): Promise<void>
    focusSession(sessionId: string): Promise<void>
    onNavigateSession(handler: (sessionId: string) => void): Promise<DesktopHostUnlisten>
    onVisibilityChanged(handler: (visible: boolean) => void): Promise<DesktopHostUnlisten>
    onPanelPlacementChanged(
      handler: (placement: DesktopPetPanelPlacement) => void,
    ): Promise<DesktopHostUnlisten>
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
    startDragging(): Promise<void>
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
    setZoom(level: number): Promise<void>
    close(): Promise<void>
    message(payload: PreviewHostMessage): Promise<void>
    onEvent(handler: (event: unknown) => void): Promise<DesktopHostUnlisten>
  }
  appMode: {
    get(): Promise<AppModeConfig>
    set(config: AppModeSetInput): Promise<void>
    prepareRestart(): Promise<void>
    restart(): Promise<void>
  }
  adapters: {
    restartSidecar(): Promise<void>
  }
  zoom: {
    set(level: number): Promise<void>
  }
  appearance: {
    setApplied(state: AppliedAppearance): Promise<void>
  }
}

declare global {
  interface Window {
    desktopHost?: DesktopHost
  }
}
