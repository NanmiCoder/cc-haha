import { create } from 'zustand'
import { isThemeMode, THEME_MODES, type ThemeMode } from '../types/settings'

const THEME_STORAGE_KEY = 'cc-haha-theme'
const ACTIVE_SETTINGS_TAB_STORAGE_KEY = 'cc-haha-active-settings-tab'

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
  'computerUse',
  'trace',
  'diagnostics',
  'about',
] as const

function getStoredTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (isThemeMode(stored)) return stored
  } catch { /* localStorage unavailable */ }
  return 'light'
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

export function applyTheme(theme: ThemeMode) {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', theme)
  document.documentElement.style.colorScheme = theme === 'dark' ? 'dark' : 'light'
}

const PRESET_STORAGE_KEY = 'cc-haha-theme-preset'

function getStoredPreset(): string {
  if (typeof window === 'undefined') return ''
  try {
    return localStorage.getItem(PRESET_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function setStoredPreset(preset: string) {
  if (typeof window === 'undefined') return
  try {
    if (preset) localStorage.setItem(PRESET_STORAGE_KEY, preset)
    else localStorage.removeItem(PRESET_STORAGE_KEY)
  } catch { /* quota exceeded, ignore */ }
}

let _presetLink: HTMLLinkElement | null = null

export function applyPreset(preset: string) {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme-preset', preset)
  setStoredPreset(preset)
  // Remove old preset CSS link
  if (_presetLink) {
    _presetLink.remove()
    _presetLink = null
  }
  // Inject new preset CSS
  if (preset) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = `./themes/${preset}.css`
    document.head.appendChild(link)
    _presetLink = link
  }
}

export function initializePreset() {
  applyPreset(getStoredPreset())
}

export function initializeTheme() {
  applyTheme(getStoredTheme())
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
  | 'computerUse'
  | 'trace'
  | 'diagnostics'
  | 'about'

type ActiveView = 'code' | 'scheduled' | 'terminal' | 'history' | 'settings'

type UIStore = {
  theme: ThemeMode
  sidebarOpen: boolean
  activeView: ActiveView
  activeSettingsTab: SettingsTab
  pendingSettingsTab: SettingsTab | null
  pendingMemoryPath: string | null
  activeModal: string | null
  toasts: Toast[]
  sideSessions: Record<string, string>

  setTheme: (theme: ThemeMode) => void
  toggleTheme: () => void
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
  setActiveView: (view: ActiveView) => void
  setSideSession: (tabId: string, sessionId: string) => void
  clearSideSession: (tabId: string) => void
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
  theme: getStoredTheme(),
  sidebarOpen: true,
  activeView: 'code',
  activeSettingsTab: getStoredSettingsTab(),
  pendingSettingsTab: null,
  pendingMemoryPath: null,
  activeModal: null,
  toasts: [],
  sideSessions: {} as Record<string, string>,

  setTheme: (theme) => {
    applyTheme(theme)
    try { localStorage.setItem(THEME_STORAGE_KEY, theme) } catch { /* noop */ }
    set({ theme })
  },

  toggleTheme: () => {
    set((state) => {
      const currentIndex = THEME_MODES.indexOf(state.theme)
      const next = THEME_MODES[(currentIndex + 1) % THEME_MODES.length] ?? 'white'
      applyTheme(next)
      try { localStorage.setItem(THEME_STORAGE_KEY, next) } catch { /* noop */ }
      return { theme: next }
    })
  },

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setActiveView: (view) => set({ activeView: view }),
  setSideSession: (tabId, sessionId) => set((s) => ({
    sideSessions: { ...s.sideSessions, [tabId]: sessionId }
  })),
  clearSideSession: (tabId) => set((s) => {
    const { [tabId]: _, ...rest } = s.sideSessions
    return { sideSessions: rest }
  }),
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
