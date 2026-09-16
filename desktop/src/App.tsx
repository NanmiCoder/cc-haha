import { AppShell } from './components/layout/AppShell'
import { useScheduledTaskDesktopNotifications } from './hooks/useScheduledTaskDesktopNotifications'
import { installDesktopNotificationNavigation } from './lib/desktopNotificationNavigation'
import { useEffect } from 'react'
import { RemoteAccessGate } from './pages/RemoteAccess'
import { isPublicAccessRuntime } from './lib/publicAccessRuntime'

export function App() {
  return isPublicAccessRuntime()
    ? <RemoteAccessGate><ConnectedApp /></RemoteAccessGate>
    : <ConnectedApp />
}

function ConnectedApp() {
  useScheduledTaskDesktopNotifications()
  useEffect(() => {
    let cleanup: (() => void) | undefined
    let cancelled = false
    installDesktopNotificationNavigation()
      .then((fn) => {
        if (cancelled) {
          fn()
        } else {
          cleanup = fn
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
      cleanup?.()
    }
  }, [])
  return <AppShell />
}
