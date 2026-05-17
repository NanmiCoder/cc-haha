export const APP_ZOOM_STORAGE_KEY = 'cc-haha-app-zoom'
export const LEGACY_UI_ZOOM_STORAGE_KEY = 'cc-haha-ui-zoom'
export const DEFAULT_APP_ZOOM = 1
export const MIN_APP_ZOOM = 0.5
export const MAX_APP_ZOOM = 2
export const APP_ZOOM_STEP = 0.1
export const APP_ZOOM_CONTROL_STEP = 0.01

export type AppZoomAction = 'in' | 'out' | 'reset'

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
type KeyboardShortcutInput = Pick<KeyboardEvent, 'altKey' | 'code' | 'ctrlKey' | 'key' | 'metaKey'>

function isTauriRuntime() {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
}

function getDefaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function roundZoom(value: number): number {
  return Math.round(value * 100) / 100
}

export function normalizeAppZoomLevel(value: unknown): number {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : DEFAULT_APP_ZOOM
  if (!Number.isFinite(numeric)) return DEFAULT_APP_ZOOM
  return roundZoom(Math.min(Math.max(numeric, MIN_APP_ZOOM), MAX_APP_ZOOM))
}

export function isValidStoredAppZoomLevel(value: string | null): boolean {
  if (value === null) return true
  if (value.trim() === '') return false
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= MIN_APP_ZOOM && numeric <= MAX_APP_ZOOM
}

export function readStoredAppZoomLevel(storage: StorageLike | null = getDefaultStorage()): number {
  if (!storage) return DEFAULT_APP_ZOOM
  try {
    const stored = storage.getItem(APP_ZOOM_STORAGE_KEY)
    if (stored !== null) return normalizeAppZoomLevel(stored)
    return normalizeAppZoomLevel(storage.getItem(LEGACY_UI_ZOOM_STORAGE_KEY))
  } catch {
    return DEFAULT_APP_ZOOM
  }
}

function persistAppZoomLevel(level: number, storage: StorageLike | null = getDefaultStorage()) {
  if (!storage) return
  try {
    storage.setItem(APP_ZOOM_STORAGE_KEY, String(level))
  } catch {
    // localStorage can be unavailable in hardened browser contexts.
  }
}

function setCssAppZoomMode(level: number, mode: 'css' | 'native') {
  if (typeof document === 'undefined') return
  document.documentElement.style.setProperty('--app-zoom', String(level))
  document.documentElement.setAttribute('data-app-zoom-mode', mode)
  document.documentElement.setAttribute('data-app-zoom-percent', String(Math.round(level * 100)))
  document.body?.style.setProperty('zoom', mode === 'css' ? String(level) : '')
}

async function trySetNativeAppZoom(level: number): Promise<boolean> {
  if (!isTauriRuntime()) return false
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('set_app_zoom', { zoomFactor: level })
    setCssAppZoomMode(level, 'native')
    return true
  } catch {
    return false
  }
}

export async function applyAppZoomLevel(
  input: number,
  options: { persist?: boolean } = {},
): Promise<number> {
  const level = normalizeAppZoomLevel(input)
  if (options.persist !== false) {
    persistAppZoomLevel(level)
  }

  const nativeApplied = await trySetNativeAppZoom(level)
  if (!nativeApplied) {
    setCssAppZoomMode(level, 'css')
  }

  return level
}

export function nextAppZoomLevel(current: number, action: AppZoomAction): number {
  if (action === 'reset') return DEFAULT_APP_ZOOM
  const delta = action === 'in' ? APP_ZOOM_STEP : -APP_ZOOM_STEP
  return normalizeAppZoomLevel(roundZoom(current + delta))
}

export function getAppZoomKeyboardAction(
  event: KeyboardShortcutInput,
  platform: string = typeof navigator === 'undefined' ? '' : navigator.platform,
): AppZoomAction | null {
  if (event.altKey) return null
  const isMac = /mac/i.test(platform)
  const hasPrimaryModifier = isMac ? event.metaKey : event.ctrlKey
  if (!hasPrimaryModifier) return null

  const key = event.key.toLowerCase()
  if (key === '+' || key === '=' || event.code === 'Equal' || event.code === 'NumpadAdd') {
    return 'in'
  }
  if (key === '-' || event.code === 'Minus' || event.code === 'NumpadSubtract') {
    return 'out'
  }
  if (key === '0' || event.code === 'Digit0' || event.code === 'Numpad0') {
    return 'reset'
  }
  return null
}

export function initializeAppZoom(): Promise<number> {
  return applyAppZoomLevel(readStoredAppZoomLevel(), { persist: false })
}
