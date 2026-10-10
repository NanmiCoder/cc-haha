import { AppShell } from './components/layout/AppShell'
import { useScheduledTaskDesktopNotifications } from './hooks/useScheduledTaskDesktopNotifications'
import { installDesktopNotificationNavigation } from './lib/desktopNotificationNavigation'
import { useEffect } from 'react'
import { RemoteAccessGate } from './pages/RemoteAccess'
import { isPublicAccessRuntime } from './lib/publicAccessRuntime'
import { useChatStore } from './stores/chatStore'
import { installHiddenSessionRelease } from './stores/hiddenSessionRelease'
import { useMobileShellLayout } from './components/mobile/mobileShellLayout'
import { isDesktopRuntime } from './lib/desktopRuntime'

export function App() {
  return isPublicAccessRuntime()
    ? <RemoteAccessGate><ConnectedApp /></RemoteAccessGate>
    : <ConnectedApp />
}

function ConnectedApp() {
  useScheduledTaskDesktopNotifications()
  const shellLayout = useMobileShellLayout(isDesktopRuntime())
  useEffect(
    () => installHiddenSessionRelease(useChatStore, {
      scope: shellLayout === 'desktop' ? 'open-tabs' : 'active-tab',
    }),
    [shellLayout],
  )
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
