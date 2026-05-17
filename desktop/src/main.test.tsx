import React from 'react'
import '@testing-library/jest-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, screen } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  runDesktopPersistenceMigrations: vi.fn(),
}))

vi.mock('./lib/persistenceMigrations', () => ({
  runDesktopPersistenceMigrations: mocks.runDesktopPersistenceMigrations,
}))

vi.mock('./theme/globals.css', () => ({}))

vi.mock('./App', () => ({
  App: () => <div>Auto boot app</div>,
}))

vi.mock('./components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('./lib/diagnosticsCapture', () => ({
  installClientDiagnosticsCapture: vi.fn(),
}))

vi.mock('./stores/uiStore', () => ({
  initializeTheme: vi.fn(),
}))

describe('desktop bootstrap', () => {
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    delete window.__CC_HAHA_BOOTSTRAPPED__
    delete window.__CC_HAHA_SHOW_STARTUP_ERROR__
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('runs startup migrations and renders the app without top-level await', async () => {
    document.body.innerHTML = '<div id="root"></div>'

    await act(async () => {
      await import('./main')
      await Promise.resolve()
    })

    expect(await screen.findByText('Auto boot app')).toBeInTheDocument()
    expect(mocks.runDesktopPersistenceMigrations).toHaveBeenCalledTimes(1)
    expect(window.__CC_HAHA_BOOTSTRAPPED__).toBe(true)
  })

  it('surfaces bootstrap failures in the root element', async () => {
    const { bootstrapDesktopApp } = await import('./main')
    const root = document.createElement('div')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await bootstrapDesktopApp(root, async () => {
      throw new Error('bootstrap failed')
    })

    expect(root.textContent).toBe('bootstrap failed')
    expect(consoleError).toHaveBeenCalledWith('[desktop] Failed to bootstrap app', expect.any(Error))
  })

  it('delegates bootstrap failures to the HTML startup watchdog when available', async () => {
    const { bootstrapDesktopApp } = await import('./main')
    const root = document.createElement('div')
    const showStartupError = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    window.__CC_HAHA_SHOW_STARTUP_ERROR__ = showStartupError

    await bootstrapDesktopApp(root, async () => {
      throw new Error('module failed')
    })

    expect(showStartupError).toHaveBeenCalledWith(expect.any(Error))
    expect(root.textContent).toBe('')
    expect(consoleError).toHaveBeenCalledWith('[desktop] Failed to bootstrap app', expect.any(Error))
  })
})
