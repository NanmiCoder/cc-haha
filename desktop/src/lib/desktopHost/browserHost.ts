import type {
  AppModeConfig,
  DesktopHost,
  DesktopHostCapabilities,
  DesktopHostUnlisten,
  NotificationPermissionState,
} from './types'
import { buildTraceWindowUrl } from '../traceLaunch'

const browserCapabilities: DesktopHostCapabilities = {
  appMode: false,
  clipboard: false,
  dialogs: false,
  notifications: false,
  previewWebview: false,
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
  defaultPortableDir: null,
}

const defaultPermissionState: NotificationPermissionState = 'default'

export const browserHost: DesktopHost = {
  kind: 'browser',
  isDesktop: false,
  capabilities: browserCapabilities,
  runtime: {
    async getServerUrl() {
      unsupported('Resolving the bundled server URL')
    },
  },
  app: {
    async getVersion() {
      return '0.1.0'
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
  appMode: {
    async get() {
      return defaultAppMode
    },
    async set() {
      unsupported('Desktop app mode')
    },
    async detectPortableDir() {
      return null
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
}
