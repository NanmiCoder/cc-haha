import React from 'react'
import ReactDOM from 'react-dom/client'
import './theme/globals.css'
import { initializeAppZoom } from './lib/appZoom'
import { runDesktopPersistenceMigrations } from './lib/persistenceMigrations'

declare global {
  interface Window {
    __CC_HAHA_BOOTSTRAPPED__?: boolean
    __CC_HAHA_SHOW_STARTUP_ERROR__?: (reason: unknown) => void
  }
}

type DesktopBootstrapModules = [
  { App: React.ComponentType },
  { ErrorBoundary: React.ComponentType<{ children: React.ReactNode }> },
  { installClientDiagnosticsCapture: () => void },
  { initializeTheme: () => void },
]

function loadDesktopBootstrapModules() {
  return Promise.all([
    import('./App'),
    import('./components/ErrorBoundary'),
    import('./lib/diagnosticsCapture'),
    import('./stores/uiStore'),
  ])
}

export async function bootstrapDesktopApp(
  root: HTMLElement | null = document.getElementById('root'),
  loadModules: () => Promise<DesktopBootstrapModules> = loadDesktopBootstrapModules,
) {
  try {
    const [{ App }, { ErrorBoundary }, { installClientDiagnosticsCapture }, { initializeTheme }] = await loadModules()
    initializeTheme()
    installClientDiagnosticsCapture()

    if (!root) {
      throw new Error('Desktop root element not found')
    }

    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>,
    )
    window.__CC_HAHA_BOOTSTRAPPED__ = true
  } catch (error) {
    console.error('[desktop] Failed to bootstrap app', error)
    if (root) {
      if (window.__CC_HAHA_SHOW_STARTUP_ERROR__) {
        window.__CC_HAHA_SHOW_STARTUP_ERROR__(error)
      } else {
        root.textContent = error instanceof Error ? error.message : String(error)
      }
    }
  }
}

runDesktopPersistenceMigrations()
void initializeAppZoom()

void bootstrapDesktopApp()
