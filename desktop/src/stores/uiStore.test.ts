import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('uiStore theme handling', () => {
  beforeEach(() => {
    vi.resetModules()
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.style.colorScheme = ''
  })

  it('defaults new installs to dark', async () => {
    const { initializeTheme, useUIStore } = await import('./uiStore')

    expect(useUIStore.getState().theme).toBe('dark')
    initializeTheme()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
  })

  it('honours an existing stored preference over the new default (no upgrade clobber)', async () => {
    window.localStorage.setItem('cc-haha-theme', 'white')

    const { initializeTheme, useUIStore } = await import('./uiStore')

    expect(useUIStore.getState().theme).toBe('white')
    initializeTheme()
    expect(document.documentElement.getAttribute('data-theme')).toBe('white')
    expect(document.documentElement.style.colorScheme).toBe('light')
  })

  it('cycles through all theme modes in order', async () => {
    const { useUIStore } = await import('./uiStore')

    // Pin the starting point so this test does not depend on the default.
    useUIStore.getState().setTheme('white')

    // white → light
    useUIStore.getState().toggleTheme()
    expect(useUIStore.getState().theme).toBe('light')
    expect(document.documentElement.style.colorScheme).toBe('light')

    // light → dark
    useUIStore.getState().toggleTheme()
    expect(useUIStore.getState().theme).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')

    // dark → system (resolves to light or dark based on OS; jsdom has no matchMedia → light)
    useUIStore.getState().toggleTheme()
    expect(useUIStore.getState().theme).toBe('system')
    expect(document.documentElement.style.colorScheme).toBe('light')

    // system → white (wraps around)
    useUIStore.getState().toggleTheme()
    expect(useUIStore.getState().theme).toBe('white')
    expect(document.documentElement.style.colorScheme).toBe('light')
  })
})
