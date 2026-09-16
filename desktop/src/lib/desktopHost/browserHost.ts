import type {
  AppModeConfig,
  DesktopHost,
  DesktopHostCapabilities,
  DesktopHostUnlisten,
  NotificationPermissionState,
} from './types'
import { buildTraceWindowUrl } from '../traceLaunch'
import { readBrowserLanguages } from '../../i18n/locale'

const browserCapabilities: DesktopHostCapabilities = {
  appMode: false,
  clipboard: false,
  dialogs: false,
  notifications: false,
  previewWebview: false,
  workspaceBrowser: false,
  shell: false,
  terminal: false,
  updates: false,
  windowControls: false,
  zoom: false,
}

function unsupported(feature: string): never {
  throw new Error(`${feature} requires the desktop app runtime.`)
}

function noopUnlisten(): void {
  // Intentionally empty: browser fallback has no native event subscriptions.
}

const defaultAppMode: AppModeConfig = {
  mode: 'default',
  portableDir: null,
}

const defaultPermissionState: NotificationPermissionState = 'default'

export const browserHost: DesktopHost = {
  publicAccess: {
    async getStatus() { return unsupported('Public access management') },
    async saveCredential() { return unsupported('Public access management') },
    async deleteCredential() { return unsupported('Public access management') },
    async start() { return unsupported('Public access management') },
    async stop() { return unsupported('Public access management') },
    async setAutoStart() { return unsupported('Public access management') },
  },
  kind: 'browser',
  isDesktop: false,
  capabilities: browserCapabilities,
  runtime: {
    async getServerUrl() {
      unsupported('Resolving the bundled server URL')
    },
    async getLocalAccessToken() {
      unsupported('Resolving the bundled server access token')
    },
  },
  app: {
    async getVersion() {
      return '0.1.0'
    },
    async getLocalePreference() {
      return null
    },
    async setLocalePreference() {
      // Browser/H5 preferences stay in renderer localStorage.
    },
    async getPreferredSystemLanguages() {
      return readBrowserLanguages()
    },
    async onLocaleChanged() {
      return noopUnlisten
    },
  },
  commands: {
    async invoke() {
      unsupported('Native commands')
    },
  },
  clipboard: {
    async readText() {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
        return navigator.clipboard.readText()
      }
      unsupported('Reading clipboard text')
    },
    async writeText(text) {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        return
      }
      unsupported('Writing clipboard text')
    },
  },
  files: {
    getPathForFile(file) {
      const legacyPath = (file as File & { path?: unknown }).path
      return typeof legacyPath === 'string' ? legacyPath : ''
    },
  },
  events: {
    async listen() {
      return noopUnlisten
    },
  },
  webview: {
    async onDragDropEvent() {
      return noopUnlisten
    },
  },
  shell: {
    async open(target) {
      if (typeof window !== 'undefined') {
        window.open(target, '_blank', 'noopener,noreferrer')
        return
      }
      unsupported('Opening system targets')
    },
    async openPath() {
      unsupported('Opening system file paths')
    },
  },
  trace: {
    async openWindow(sessionId) {
      if (typeof window !== 'undefined') {
        window.open(buildTraceWindowUrl(sessionId), '_blank', 'noopener,noreferrer')
        return
      }
      unsupported('Opening trace windows')
    },
  },
  pets: {
    async list() {
      unsupported('Custom pets')
    },
    async createFromImage() {
      unsupported('Creating custom pets')
    },
    async createFromAtlas() {
      unsupported('Creating custom pets')
    },
    async pickSourceSheet() {
      unsupported('Creating custom pets')
    },
    async createFromAtlasBytes() {
      unsupported('Creating custom pets')
    },
    async openFolder() {
      unsupported('Opening the custom pets folder')
    },
    async show() {
      unsupported('Showing the companion pet')
    },
    async hide() {
      unsupported('Hiding the companion pet')
    },
    async showContextMenu() {
      unsupported('Showing the companion pet context menu')
    },
    async dragWindow() {
      unsupported('Dragging the companion pet window')
    },
    async setIgnoreMouseEvents() {
      unsupported('Changing companion pet mouse passthrough')
    },
    async setInteractiveRegions() {
      unsupported('Changing companion pet interaction regions')
    },
    async focusMainWindow() {
      unsupported('Focusing the main desktop window')
    },
    async focusSession() {
      unsupported('Focusing a pet session')
    },
    async onPanelPlacementChanged() {
      return noopUnlisten
    },
    async onNavigateSession() {
      return noopUnlisten
    },
    async onVisibilityChanged() {
      return noopUnlisten
    },
  },
  dialogs: {
    async open() {
      unsupported('Native file dialogs')
    },
    async save() {
      unsupported('Native save dialogs')
    },
  },
  updates: {
    async check() {
      return null
    },
    async prepareInstall() {
      unsupported('Installing desktop updates')
    },
    async cancelInstall() {
      unsupported('Cancelling desktop update installs')
    },
    async relaunch() {
      unsupported('Relaunching the desktop app')
    },
  },
  notifications: {
    async permissionState() {
      if (typeof Notification === 'undefined') return defaultPermissionState
      return Notification.permission
    },
    async requestPermission() {
      if (typeof Notification === 'undefined') return defaultPermissionState
      return Notification.requestPermission()
    },
    async send(options) {
      if (typeof Notification === 'undefined') {
        unsupported('Native notifications')
      }
      new Notification(options.title, {
        body: options.body,
        icon: options.icon,
      })
    },
    async onAction() {
      return noopUnlisten
    },
    async ackAction() {
      return false
    },
  },
  window: {
    async minimize() {
      unsupported('Native window controls')
    },
    async toggleMaximize() {
      unsupported('Native window controls')
    },
    async close() {
      unsupported('Native window controls')
    },
    async startDragging() {
      unsupported('Native window dragging')
    },
    async requestAttention() {
      unsupported('Native window attention')
    },
    async focus() {
      if (typeof window !== 'undefined') {
        window.focus()
        return
      }
      unsupported('Native window focus')
    },
    async isMaximized() {
      return false
    },
    async onResized() {
      return noopUnlisten
    },
    async onNativeMenuNavigate() {
      return noopUnlisten
    },
  },
  terminal: {
    async spawn() {
      unsupported('Native terminal sessions')
    },
    async write() {
      unsupported('Native terminal sessions')
    },
    async resize() {
      unsupported('Native terminal sessions')
    },
    async kill() {
      unsupported('Native terminal sessions')
    },
    async onOutput(): Promise<DesktopHostUnlisten> {
      return noopUnlisten
    },
    async onExit(): Promise<DesktopHostUnlisten> {
      return noopUnlisten
    },
    async getBashPath() {
      return null
    },
    async setBashPath() {
      unsupported('Native shell path settings')
    },
  },
  preview: {
    async open() {
      unsupported('Native preview webview')
    },
    async navigate() {
      unsupported('Native preview webview')
    },
    async setBounds() {
      unsupported('Native preview webview')
    },
    async setVisible() {
      unsupported('Native preview webview')
    },
    async setZoom() {
      unsupported('Native preview webview')
    },
    async close() {
      unsupported('Native preview webview')
    },
    async message() {
      unsupported('Native preview webview')
    },
    async onEvent(): Promise<DesktopHostUnlisten> {
      return noopUnlisten
    },
  },
  browser: {
    // Unlike `preview`, these resolve instead of throwing. Callers reach the
    // browser through `workspaceBrowserHost`, which already reports the missing
    // capability and offers "open externally"; an extra rejection here would
    // only surface as an unhandled error behind that fallback.
    async create() {},
    async navigate() {},
    async goBack() {},
    async goForward() {},
    async reload() {},
    async stop() {},
    async setBounds() {},
    async setVisible() {},
    async setZoom() {},
    async find() {},
    async stopFind() {},
    async capture() {},
    async snapshot() { return null },
    async message() {},
    async printToPdf() {},
    async showMenu() { return null },
    async close() {},
    async onEvent(): Promise<DesktopHostUnlisten> {
      return noopUnlisten
    },
  },
  appMode: {
    async get() {
      return defaultAppMode
    },
    async set() {
      unsupported('Desktop app mode')
    },
    async prepareRestart() {
      unsupported('Desktop app restart')
    },
    async restart() {
      unsupported('Desktop app restart')
    },
  },
  adapters: {
    async restartSidecar() {
      unsupported('Adapter sidecar restart')
    },
  },
  zoom: {
    async set() {
      unsupported('Native app zoom')
    },
  },
  appearance: {
    // No native chrome to keep in sync in a browser tab; the CSS theme is the
    // whole story there, so reporting it is a no-op rather than an error.
    async setApplied() {},
  },
}
