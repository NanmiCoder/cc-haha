import React from 'react'
import '@testing-library/jest-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  runDesktopPersistenceMigrations: vi.fn(),
}))

vi.mock('./lib/persistenceMigrations', () => ({
  runDesktopPersistenceMigrations: mocks.runDesktopPersistenceMigrations,
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
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
    delete window.__CC_HAHA_SET_STARTUP_PHASE__
    delete window.__CC_HAHA_BOOTSTRAP_COMPLETE__
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

  it('recognizes only the dedicated pet window query', async () => {
    const { isPetWindowLocation } = await import('./main')

    expect(isPetWindowLocation('?petWindow=1')).toBe(true)
    expect(isPetWindowLocation('?petWindow=0')).toBe(false)
  })

  it('reports pending module downloads and completes the watchdog after rendering', async () => {
    const { bootstrapDesktopApp } = await import('./main')
    const root = document.createElement('div')
    document.body.appendChild(root)
    const phase = vi.fn()
    const complete = vi.fn()
    window.__CC_HAHA_SET_STARTUP_PHASE__ = phase
    window.__CC_HAHA_BOOTSTRAP_COMPLETE__ = complete
    type Modules = Awaited<ReturnType<NonNullable<Parameters<typeof bootstrapDesktopApp>[1]>>>
    let finishDownload!: (modules: Modules) => void
    const download = new Promise<Modules>((resolve) => { finishDownload = resolve })
    const bootstrap = bootstrapDesktopApp(root, () => download)

    await waitFor(() => expect(phase).toHaveBeenLastCalledWith('modules'))
    expect(complete).not.toHaveBeenCalled()
    expect(window.__CC_HAHA_BOOTSTRAPPED__).not.toBe(true)

    await act(async () => {
      finishDownload([
        { App: () => <div>Downloaded remote app</div> },
        { ErrorBoundary: ({ children }) => <>{children}</> },
        { installClientDiagnosticsCapture: vi.fn() },
        { initializeTheme: vi.fn() },
      ])
      await bootstrap
    })

    expect(screen.getByText('Downloaded remote app')).toBeInTheDocument()
    expect(phase.mock.calls.map(([value]) => value)).toEqual(['locale', 'modules', 'render'])
    expect(complete).toHaveBeenCalledTimes(1)
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
