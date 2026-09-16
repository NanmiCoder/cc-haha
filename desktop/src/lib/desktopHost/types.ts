import type {
  AppMode as SettingsAppMode,
  AppModeConfig as SettingsAppModeConfig,
} from '../../types/settings'
import type { Locale } from '../../i18n/locale'

// Version 2 adds remote provider management and selected General settings.
export const PUBLIC_ACCESS_CONSENT_VERSION = 2

export type DesktopHostKind = 'browser' | 'electron'

export type DesktopHostCapability =
  | 'appMode'
  | 'clipboard'
  | 'dialogs'
  | 'notifications'
  | 'previewWebview'
  | 'workspaceBrowser'
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
  /** Correlates events that can arrive before the spawn IPC reply. */
  requestId?: string
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
  /** Correlates events that can arrive before the spawn IPC reply. */
  requestId?: string
  session_id: number
  data: string
}

export type TerminalExitEvent = {
  /** Correlates events that can arrive before the spawn IPC reply. */
  requestId?: string
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
      persistent?: boolean
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

export type PreviewBrowserControlsMessage = {
  v: 1
  type: 'browser-controls'
  zoomFactor: number
  appZoom: number
  copy: { zoom: string; zoomOut: string; zoomIn: string; zoomReset: string }
  colors: { background: string; foreground: string; muted: string; border: string; hover: string; focus: string; shadow: string }
}

export type PreviewHostMessage = PreviewCaptureMessage | PreviewPickerMessage | PreviewBrowserControlsMessage

/**
 * Multi-page browser host. Every method names its page, so a second page never
 * navigates the first and unmounting a React surface never destroys a page.
 */
export type WorkspaceBrowserBounds = PreviewBounds

export type WorkspaceBrowserCaptureKind = 'full' | 'viewport'

export type WorkspaceBrowserMenuAction =
  | 'find' | 'print' | 'zoomIn' | 'zoomOut' | 'zoomReset'
  | 'capture' | 'pickElement' | 'downloads' | 'history' | 'openExternal'

export type WorkspaceBrowserMenuOptions = {
  /** Anchor in renderer CSS pixels; the main process converts it using host zoom. */
  x: number
  y: number
  labels: Record<WorkspaceBrowserMenuAction | 'zoom', string>
  zoomFactor: number
  hasPage: boolean
  canOpenExternal: boolean
}

export type WorkspaceBrowserFindOptions = {
  forward?: boolean
  findNext?: boolean
  matchCase?: boolean
}

export type WorkspaceBrowserDownload = {
  id: string
  filename: string
  savePath: string | null
  receivedBytes: number
  totalBytes: number
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
}

export type WorkspaceBrowserHistoryEntry = {
  url: string
  title: string
  visitedAt: number
}

/**
 * Everything the host reports back, always carrying `tabId`.
 *
 * A late event for a page that has already been closed is dropped by the
 * controller rather than applied to whatever took its slot — the id is what
 * makes that check possible.
 */
export type WorkspaceBrowserEvent =
  | { type: 'shortcut'; tabId: string; action: import('../workspace/shortcuts').WorkspaceShortcutAction }
  | {
      type: 'state'
      tabId: string
      url: string
      title: string
      canGoBack: boolean
      canGoForward: boolean
      loading: boolean
      navigationId?: number
      navigationOutcome?: 'idle' | 'pending' | 'succeeded' | 'failed'
      zoomFactor?: number
      annotationActive?: boolean
    }
  | {
      type: 'failed'
      tabId: string
      url: string
      errorCode: number
      errorDescription: string
      navigationId?: number
    }
  /** `window.open`, `target=_blank` and popups all land here as a new tab. */
  | { type: 'new-window'; tabId: string; url: string }
  | { type: 'found'; tabId: string; activeMatchOrdinal: number; matches: number }
  | { type: 'screenshot'; tabId: string; dataUrl: string; kind: WorkspaceBrowserCaptureKind }
  | { type: 'download'; tabId: string; download: WorkspaceBrowserDownload }
  | { type: 'history'; tabId: string; entries: WorkspaceBrowserHistoryEntry[] }
  /** The in-page selection agent speaking; payload shape is the legacy one. */
  | { type: 'agent'; tabId: string; message: unknown }
  /** The page died (crash, host teardown). The tab shows a retry entry point. */
  | { type: 'destroyed'; tabId: string; reason: 'crashed' | 'closed' }

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

export type DesktopPublicAccessStatus = {
  state: 'unconfigured' | 'disabled' | 'connecting' | 'online' | 'reconnecting' | 'failed'
  hasCredential: boolean
  publicUrl: string | null
  error: 'auth' | 'quota' | 'network' | 'configuration' | null
  autoStart: boolean
  consentVersion: number
}

export type DesktopHost = {
  publicAccess: {
    getStatus(): Promise<DesktopPublicAccessStatus>
    saveCredential(token: string): Promise<DesktopPublicAccessStatus>
    deleteCredential(): Promise<DesktopPublicAccessStatus>
    start(consentVersion: number): Promise<DesktopPublicAccessStatus>
    stop(): Promise<DesktopPublicAccessStatus>
    setAutoStart(enabled: boolean): Promise<DesktopPublicAccessStatus>
  }
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
    /** Absent in older preloads whose IPC validator rejects requestId. */
    supportsStartupCorrelation?: boolean
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
  browser: {
    showMenu(tabId: string, options: WorkspaceBrowserMenuOptions): Promise<WorkspaceBrowserMenuAction | null>
    create(
      tabId: string,
      options: { storageId: string; url?: string; bounds?: WorkspaceBrowserBounds; visible?: boolean },
    ): Promise<void>
    navigate(tabId: string, url: string): Promise<void>
    goBack(tabId: string): Promise<void>
    goForward(tabId: string): Promise<void>
    reload(tabId: string, options?: { ignoreCache?: boolean }): Promise<void>
    stop(tabId: string): Promise<void>
    setBounds(tabId: string, bounds: WorkspaceBrowserBounds): Promise<void>
    setVisible(tabId: string, visible: boolean): Promise<void>
    setZoom(tabId: string, factor: number): Promise<void>
    find(tabId: string, text: string, options?: WorkspaceBrowserFindOptions): Promise<void>
    stopFind(tabId: string): Promise<void>
    capture(tabId: string, kind: WorkspaceBrowserCaptureKind): Promise<void>
    /** Read-only presentation backdrop, with no screenshot or composer event. */
    snapshot(tabId: string): Promise<string | null>
    message(tabId: string, payload: PreviewHostMessage): Promise<void>
    printToPdf(tabId: string): Promise<void>
    close(tabId: string): Promise<void>
    onEvent(handler: (event: WorkspaceBrowserEvent) => void): Promise<DesktopHostUnlisten>
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
