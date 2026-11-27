import { contextBridge, ipcRenderer } from 'electron'
import {
  isElectronIpcChannelAllowedForUsageWidgetWindow,
  validateElectronIpcPayload,
} from './ipc/capabilities'
import {
  ELECTRON_EVENT_CHANNELS,
  ELECTRON_IPC_CHANNELS,
  type ElectronIpcChannel,
} from './ipc/channels'
import type {
  DesktopHost,
  DesktopUsageWidgetBoundsState,
  DesktopUsageWidgetDrag,
  DesktopUsageWidgetMenuBarSync,
  DesktopUsageWidgetSettingsTab,
} from '../src/lib/desktopHost/types'
import type { Locale } from '../src/i18n/locale'

function invoke<T>(channel: ElectronIpcChannel, payload?: unknown): Promise<T> {
  if (!isElectronIpcChannelAllowedForUsageWidgetWindow(channel)) {
    return Promise.reject(
      new Error(`Electron IPC channel ${channel} is not available to the usage widget window`),
    )
  }
  if (!validateElectronIpcPayload(channel, payload)) {
    return Promise.reject(new Error(`Invalid Electron IPC payload for ${channel}`))
  }
  return ipcRenderer.invoke(channel, payload) as Promise<T>
}

const usageWidgetHost = {
  kind: 'electron',
  isDesktop: true,
  capabilities: {
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
  },
  runtime: {
    getServerUrl: () => invoke<string>(ELECTRON_IPC_CHANNELS.runtimeGetServerUrl),
    // Keep the shared renderer bootstrap contract while returning only the
    // server-enforced usage-widget capability, never the desktop master token.
    getLocalAccessToken: () =>
      invoke<string | null>(ELECTRON_IPC_CHANNELS.runtimeGetUsageWidgetAccessToken),
  },
  app: {
    getLocalePreference: () =>
      invoke<Locale | null>(ELECTRON_IPC_CHANNELS.appGetLocalePreference),
    getPreferredSystemLanguages: () =>
      invoke<string[]>(ELECTRON_IPC_CHANNELS.appGetPreferredSystemLanguages),
    onLocaleChanged: (handler: (locale: Locale) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, locale: Locale) => handler(locale)
      ipcRenderer.on(ELECTRON_EVENT_CHANNELS.appLocaleChanged, listener)
      return Promise.resolve(() => {
        ipcRenderer.removeListener(ELECTRON_EVENT_CHANNELS.appLocaleChanged, listener)
      })
    },
  },
  appearance: {
    // The floating widget window is transparent and shares the renderer
    // bootstrap. It has no native chrome to sync and must not repaint the main
    // window, so this stays a no-op.
    setApplied: () => Promise.resolve(),
  },
  usageWidget: {
    hide: () => invoke<void>(ELECTRON_IPC_CHANNELS.usageWidgetHide),
    setCompact: (compact: boolean) =>
      invoke<DesktopUsageWidgetBoundsState>(ELECTRON_IPC_CHANNELS.usageWidgetSetCompact, compact),
    setAlwaysOnTop: (alwaysOnTop: boolean) =>
      invoke<DesktopUsageWidgetBoundsState>(
        ELECTRON_IPC_CHANNELS.usageWidgetSetAlwaysOnTop,
        alwaysOnTop,
      ),
    snapToTop: () =>
      invoke<DesktopUsageWidgetBoundsState>(ELECTRON_IPC_CHANNELS.usageWidgetSnapToTop),
    dragWindow: (payload: DesktopUsageWidgetDrag) =>
      invoke<DesktopUsageWidgetBoundsState>(ELECTRON_IPC_CHANNELS.usageWidgetDragWindow, payload),
    syncMenuBar: (payload: DesktopUsageWidgetMenuBarSync) =>
      invoke<void>(ELECTRON_IPC_CHANNELS.usageWidgetSyncMenuBar, payload),
    focusMainWindow: () => invoke<void>(ELECTRON_IPC_CHANNELS.usageWidgetFocusMainWindow),
    openSettings: (tab?: DesktopUsageWidgetSettingsTab) =>
      invoke<void>(ELECTRON_IPC_CHANNELS.usageWidgetOpenSettings, tab),
    notifyPreferencesChanged: () =>
      invoke<void>(ELECTRON_IPC_CHANNELS.usageWidgetNotifyPreferencesChanged),
    onVisibilityChanged: (handler: (visible: boolean) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, visible: boolean) => handler(visible)
      ipcRenderer.on(ELECTRON_EVENT_CHANNELS.usageWidgetVisibilityChanged, listener)
      return Promise.resolve(() => {
        ipcRenderer.removeListener(ELECTRON_EVENT_CHANNELS.usageWidgetVisibilityChanged, listener)
      })
    },
    onPreferencesChanged: (handler: () => void) => {
      const listener = () => handler()
      ipcRenderer.on(ELECTRON_EVENT_CHANNELS.usageWidgetPreferencesChanged, listener)
      return Promise.resolve(() => {
        ipcRenderer.removeListener(ELECTRON_EVENT_CHANNELS.usageWidgetPreferencesChanged, listener)
      })
    },
  },
} as unknown as DesktopHost

contextBridge.exposeInMainWorld('desktopHost', usageWidgetHost)
