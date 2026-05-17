import { beforeEach, describe, expect, it } from 'vitest'
import {
  APP_ZOOM_STORAGE_KEY,
  LEGACY_UI_ZOOM_STORAGE_KEY,
  applyAppZoomLevel,
  getAppZoomKeyboardAction,
  initializeAppZoom,
  nextAppZoomLevel,
  normalizeAppZoomLevel,
} from './appZoom'

describe('appZoom', () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-app-zoom-mode')
    document.documentElement.removeAttribute('data-app-zoom-percent')
    document.documentElement.style.removeProperty('--app-zoom')
    document.body.style.removeProperty('zoom')
  })

  it('normalizes, clamps, and steps app zoom levels', () => {
    expect(normalizeAppZoomLevel('1.25')).toBe(1.25)
    expect(normalizeAppZoomLevel('bad')).toBe(1)
    expect(normalizeAppZoomLevel(4)).toBe(2)
    expect(normalizeAppZoomLevel(0.1)).toBe(0.5)

    expect(nextAppZoomLevel(1, 'in')).toBe(1.1)
    expect(nextAppZoomLevel(1, 'out')).toBe(0.9)
    expect(nextAppZoomLevel(1.7, 'reset')).toBe(1)
  })

  it('applies browser fallback zoom and preserves valid persisted zoom', async () => {
    window.localStorage.setItem(APP_ZOOM_STORAGE_KEY, '1.2')

    await initializeAppZoom()

    expect(document.documentElement.getAttribute('data-app-zoom-mode')).toBe('css')
    expect(document.documentElement.getAttribute('data-app-zoom-percent')).toBe('120')
    expect(document.documentElement.style.getPropertyValue('--app-zoom')).toBe('1.2')
    expect(window.localStorage.getItem(APP_ZOOM_STORAGE_KEY)).toBe('1.2')
  })

  it('reads the legacy UI zoom key when the app zoom key is absent', async () => {
    window.localStorage.setItem(LEGACY_UI_ZOOM_STORAGE_KEY, '1.25')

    await initializeAppZoom()

    expect(document.documentElement.getAttribute('data-app-zoom-percent')).toBe('125')
    expect(window.localStorage.getItem(APP_ZOOM_STORAGE_KEY)).toBeNull()
  })

  it('persists app zoom changes', async () => {
    await applyAppZoomLevel(1.3)

    expect(window.localStorage.getItem(APP_ZOOM_STORAGE_KEY)).toBe('1.3')
    expect(document.documentElement.style.getPropertyValue('--app-zoom')).toBe('1.3')
  })

  it('maps IDE-style zoom shortcuts by platform', () => {
    expect(getAppZoomKeyboardAction({
      altKey: false,
      code: 'Equal',
      ctrlKey: false,
      key: '=',
      metaKey: true,
    } as KeyboardEvent, 'MacIntel')).toBe('in')
    expect(getAppZoomKeyboardAction({
      altKey: false,
      code: 'Minus',
      ctrlKey: true,
      key: '-',
      metaKey: false,
    } as KeyboardEvent, 'Win32')).toBe('out')
    expect(getAppZoomKeyboardAction({
      altKey: false,
      code: 'Numpad0',
      ctrlKey: true,
      key: '0',
      metaKey: false,
    } as KeyboardEvent, 'Linux x86_64')).toBe('reset')
    expect(getAppZoomKeyboardAction({
      altKey: true,
      code: 'Equal',
      ctrlKey: true,
      key: '=',
      metaKey: false,
    } as KeyboardEvent, 'Win32')).toBeNull()
  })
})
