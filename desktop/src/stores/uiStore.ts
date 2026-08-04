import { create } from 'zustand'
import {
  isDarkTheme,
  isDarkThemeMode,
  isLightThemeMode,
  THEME_MODES,
  type DarkThemeMode,
  type LightThemeMode,
  type ThemeMode,
} from '../types/settings'
import {
  DARK_THEME_STORAGE_KEY,
  FOLLOW_SYSTEM_THEME_STORAGE_KEY,
  LIGHT_THEME_STORAGE_KEY,
  THEME_BACKGROUNDS,
  THEME_STORAGE_KEY,
  getSystemAppearance,
  readStoredDarkTheme,
  readStoredFollowSystemTheme,
  readStoredLightTheme,
  readStoredTheme,
  resolveAppliedTheme,
  subscribeSystemAppearance,
  subscribeThemeStorageChanges,
} from '../theme/systemAppearance'

const ACTIVE_SETTINGS_TAB_STORAGE_KEY = 'cc-haha-active-settings-tab'
const SIDEBAR_WIDTH_STORAGE_KEY = 'cc-haha-sidebar-width'

export const SIDEBAR_MIN_WIDTH = 240
export const SIDEBAR_MAX_WIDTH = 480
export const SIDEBAR_DEFAULT_WIDTH = 300

export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)))
}

function getStoredSidebarWidth(): number {
  try {
    const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY))
    if (Number.isFinite(stored) && stored > 0) return clampSidebarWidth(stored)
  } catch { /* localStorage unavailable */ }
  return SIDEBAR_DEFAULT_WIDTH
}

const SETTINGS_TABS = [
  'providers',
  'activity',
  'general',
  'h5Access',
  'adapters',
  'terminal',
  'mcp',
  'agents',
  'skills',
  'memory',
  'plugins',
  'pets',
  'computerUse',
  'trace',
  'diagnostics',
  'about',
] as const

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch { /* localStorage unavailable */ }
}

type ThemePreferences = {
  theme: ThemeMode
  lightTheme: LightThemeMode
  darkTheme: DarkThemeMode
  followSystem: boolean
}

/**
 * Write every theme value together.
 *
 * The follow-the-system default is inferred from *not* having a stored theme,
 * so any write that stores a theme has to store the flag alongside it —
 * otherwise a fresh install silently drops back to a fixed theme the first
 * time the theme is persisted for any reason.
 */
function persistThemeState({ theme, lightTheme, darkTheme, followSystem }: ThemePreferences): void {
  persist(THEME_STORAGE_KEY, theme)
  persist(LIGHT_THEME_STORAGE_KEY, lightTheme)
  persist(DARK_THEME_STORAGE_KEY, darkTheme)
  persist(FOLLOW_SYSTEM_THEME_STORAGE_KEY, followSystem ? '1' : '0')
}

/** The theme that should currently be on `<html>`, given the stored values. */
function getInitialAppliedTheme(): ThemeMode {
  return resolveAppliedTheme({
    followSystem: readStoredFollowSystemTheme(),
    theme: readStoredTheme(),
    lightTheme: readStoredLightTheme(),
    darkTheme: readStoredDarkTheme(),
    systemAppearance: getSystemAppearance(),
  })
}

function isSettingsTab(value: unknown): value is SettingsTab {
  return typeof value === 'string' && (SETTINGS_TABS as readonly string[]).includes(value)
}

function getStoredSettingsTab(): SettingsTab {
  try {
    const stored = localStorage.getItem(ACTIVE_SETTINGS_TAB_STORAGE_KEY)
    if (isSettingsTab(stored)) return stored
  } catch { /* localStorage unavailable */ }
  return 'providers'
}

/**
 * Repaint the document for `theme`. Shared with the cross-window storage sync
 * below so a palette change made in another window lands identically here —
 * the `theme-color` meta in particular, which colors the iOS status bar and
 * the Android address bar and would otherwise stay on the palette this window
 * booted with.
 */
function paintDocumentTheme(theme: ThemeMode) {
  document.documentElement.setAttribute('data-theme', theme)
  // Two of the six palettes sit on a dark ground, so this cannot test for the
  // literal 'dark' key — ink-blue would render native scrollbars and form
  // controls in their light variant against a near-black page.
  document.documentElement.style.colorScheme = isDarkTheme(theme) ? 'dark' : 'light'
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_BACKGROUNDS[theme])
}

export function applyTheme(
  theme: ThemeMode,
  followSystem = readStoredFollowSystemTheme(),
  lightTheme = readStoredLightTheme(),
) {
  if (typeof document === 'undefined') return
  paintDocumentTheme(theme)
  notifyHostAppearance(theme, followSystem, lightTheme)
}

/**
 * Tell the Electron main process which theme ended up applied, so the native
 * window background matches it on the next launch. Best effort: the browser
 * host and the Tauri shell have no such channel and simply no-op.
 *
 * `lightBackground` travels along because a cache written at night would
 * otherwise have no way to know which light theme to repaint in the morning.
 */
function notifyHostAppearance(theme: ThemeMode, followSystem: boolean, lightTheme: LightThemeMode) {
  void import('../lib/desktopHost')
    .then(({ desktopHost }) => desktopHost.appearance.setApplied({
      isDark: isDarkTheme(theme),
      background: THEME_BACKGROUNDS[theme],
      lightBackground: THEME_BACKGROUNDS[lightTheme],
      followSystem,
    }))
    .catch(() => { /* host channel unavailable */ })
}

let stopSystemAppearanceWatch: (() => void) | null = null
let stopStorageSync: (() => void) | null = null

export function initializeTheme() {
  const state = useUIStore.getState()
  applyTheme(state.theme, state.followSystemTheme, state.lightTheme)
  // Pin down the inferred default so it survives the next launch.
  persistThemeState({
    theme: state.theme,
    lightTheme: state.lightTheme,
    darkTheme: state.darkTheme,
    followSystem: state.followSystemTheme,
  })

  stopSystemAppearanceWatch?.()
  stopSystemAppearanceWatch = subscribeSystemAppearance((appearance) => {
    // Read the preference from storage rather than this window's store. The
    // pet and trace windows run the same bootstrap with their own store
    // instance over one shared localStorage, so after the main window changes
    // the setting their in-memory copy is stale — and acting on it here would
    // write the user's choice straight back out.
    if (!readStoredFollowSystemTheme()) return
    const lightTheme = readStoredLightTheme()
    const darkTheme = readStoredDarkTheme()
    const current = useUIStore.getState()
    const next = resolveAppliedTheme({
      followSystem: true,
      theme: current.theme,
      lightTheme,
      darkTheme,
      systemAppearance: appearance,
    })
    if (next === current.theme) return
    applyTheme(next, true, lightTheme)
    persistThemeState({ theme: next, lightTheme, darkTheme, followSystem: true })
    useUIStore.setState({ theme: next, lightTheme, darkTheme, followSystemTheme: true })
  })

  stopStorageSync?.()
  stopStorageSync = subscribeThemeStorageChanges(() => {
    // Another window changed the appearance. Catch this window's store up so
    // its next decision is made on current values, and repaint it.
    const followSystemTheme = readStoredFollowSystemTheme()
    const lightTheme = readStoredLightTheme()
    const darkTheme = readStoredDarkTheme()
    const theme = resolveAppliedTheme({
      followSystem: followSystemTheme,
      theme: readStoredTheme(),
      lightTheme,
      darkTheme,
      systemAppearance: getSystemAppearance(),
    })
    useUIStore.setState({ theme, lightTheme, darkTheme, followSystemTheme })
    if (typeof document !== 'undefined') paintDocumentTheme(theme)
  })
}

/** Test seam: drop the listeners installed by initializeTheme. */
export function teardownTheme() {
  stopSystemAppearanceWatch?.()
  stopSystemAppearanceWatch = null
  stopStorageSync?.()
  stopStorageSync = null
}

export type Toast = {
  id: string
  type: 'success' | 'error' | 'warning' | 'info'
  message: string
  duration?: number
}

export type SettingsTab =
  | 'providers'
  | 'activity'
  | 'general'
  | 'h5Access'
  | 'adapters'
  | 'terminal'
  | 'mcp'
  | 'agents'
  | 'skills'
  | 'memory'
  | 'plugins'
  | 'deploymentMode'
  | 'pets'
  | 'computerUse'
  | 'trace'
  | 'diagnostics'
  | 'about'

type ActiveView = 'code' | 'scheduled' | 'terminal' | 'history' | 'settings'

type UIStore = {
  /** The theme currently on `<html>` — resolved, not necessarily the manual pick. */
  theme: ThemeMode
  /** Whether `theme` tracks the OS dark/light setting. */
  followSystemTheme: boolean
  /** Which paper palette the light half of "follow the system" resolves to. */
  lightTheme: LightThemeMode
  /** Which ink palette the dark half of "follow the system" resolves to. */
  darkTheme: DarkThemeMode
  sidebarOpen: boolean
  /** Expanded-state sidebar width in px, user-resizable within the clamp range. */
  sidebarWidth: number
  activeView: ActiveView
  activeSettingsTab: SettingsTab
  pendingSettingsTab: SettingsTab | null
  pendingMemoryPath: string | null
  activeModal: string | null
  toasts: Toast[]

  setTheme: (theme: ThemeMode) => void
  setFollowSystemTheme: (follow: boolean) => void
  toggleTheme: () => void
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
  setSidebarWidth: (width: number) => void
  setActiveView: (view: ActiveView) => void
  setActiveSettingsTab: (tab: SettingsTab) => void
  setPendingSettingsTab: (tab: SettingsTab | null) => void
  setPendingMemoryPath: (path: string | null) => void
  openModal: (id: string) => void
  closeModal: () => void
  addToast: (toast: Omit<Toast, 'id'>) => void
  removeToast: (id: string) => void
}

let toastCounter = 0

export const useUIStore = create<UIStore>((set) => ({
  theme: getInitialAppliedTheme(),
  followSystemTheme: readStoredFollowSystemTheme(),
  lightTheme: readStoredLightTheme(),
  darkTheme: readStoredDarkTheme(),
  sidebarOpen: true,
  sidebarWidth: getStoredSidebarWidth(),
  activeView: 'code',
  activeSettingsTab: getStoredSettingsTab(),
  pendingSettingsTab: null,
  pendingMemoryPath: null,
  activeModal: null,
  toasts: [],

  // Picking a palette while following the system does not fight the OS: it
  // becomes the preference for its own half and shows up once the OS is on
  // that ground. So choosing ink-blue at noon is remembered for tonight.
  setTheme: (theme) => {
    set((state) => {
      const lightTheme = isLightThemeMode(theme) ? theme : state.lightTheme
      const darkTheme = isDarkThemeMode(theme) ? theme : state.darkTheme
      const applied = resolveAppliedTheme({
        followSystem: state.followSystemTheme,
        theme,
        lightTheme,
        darkTheme,
        systemAppearance: getSystemAppearance(),
      })
      applyTheme(applied, state.followSystemTheme, lightTheme)
      persistThemeState({ theme: applied, lightTheme, darkTheme, followSystem: state.followSystemTheme })
      return { theme: applied, lightTheme, darkTheme }
    })
  },

  // Turning the switch off freezes whatever is on screen rather than snapping
  // back to an older manual pick.
  setFollowSystemTheme: (follow) => {
    set((state) => {
      const applied = resolveAppliedTheme({
        followSystem: follow,
        theme: state.theme,
        lightTheme: state.lightTheme,
        darkTheme: state.darkTheme,
        systemAppearance: getSystemAppearance(),
      })
      applyTheme(applied, follow, state.lightTheme)
      persistThemeState({
        theme: applied,
        lightTheme: state.lightTheme,
        darkTheme: state.darkTheme,
        followSystem: follow,
      })
      return { followSystemTheme: follow, theme: applied }
    })
  },

  // Cycling through the palettes by hand is an explicit takeover, so it also
  // releases the OS switch.
  toggleTheme: () => {
    set((state) => {
      const currentIndex = THEME_MODES.indexOf(state.theme)
      const next = THEME_MODES[(currentIndex + 1) % THEME_MODES.length] ?? 'white'
      const lightTheme = isLightThemeMode(next) ? next : state.lightTheme
      const darkTheme = isDarkThemeMode(next) ? next : state.darkTheme
      applyTheme(next, false, lightTheme)
      persistThemeState({ theme: next, lightTheme, darkTheme, followSystem: false })
      return { theme: next, lightTheme, darkTheme, followSystemTheme: false }
    })
  },

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setSidebarWidth: (width) => {
    const clamped = clampSidebarWidth(width)
    persist(SIDEBAR_WIDTH_STORAGE_KEY, String(clamped))
    set({ sidebarWidth: clamped })
  },
  setActiveView: (view) => set({ activeView: view }),
  setActiveSettingsTab: (tab) => {
    try { localStorage.setItem(ACTIVE_SETTINGS_TAB_STORAGE_KEY, tab) } catch { /* noop */ }
    set({ activeSettingsTab: tab })
  },
  setPendingSettingsTab: (tab) => set({ pendingSettingsTab: tab }),
  setPendingMemoryPath: (path) => set({ pendingMemoryPath: path }),
  openModal: (id) => set({ activeModal: id }),
  closeModal: () => set({ activeModal: null }),

  addToast: (toast) => {
    const id = `toast-${++toastCounter}`
    set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }))
    // Auto-remove after duration
    const duration = toast.duration ?? 4000
    if (duration > 0) {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
      }, duration)
    }
  },

  removeToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))
