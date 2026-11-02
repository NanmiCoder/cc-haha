import { AppShell } from './components/layout/AppShell'
import { useScheduledTaskDesktopNotifications } from './hooks/useScheduledTaskDesktopNotifications'
import { installDesktopNotificationNavigation } from './lib/desktopNotificationNavigation'
import { useEffect } from 'react'
import { RemoteAccessGate } from './pages/RemoteAccess'
import { isPublicAccessRuntime } from './lib/publicAccessRuntime'
import { useChatStore } from './stores/chatStore'
import { installHiddenSessionRelease } from './stores/hiddenSessionRelease'
import { installSessionTabLimit } from './stores/sessionTabLimit'
import { useMobileShellLayout } from './components/mobile/mobileShellLayout'
import { isDesktopRuntime } from './lib/desktopRuntime'
import { usePowerSettingsStore } from './stores/powerSettingsStore'
import { useIdlePowerStore } from './stores/idlePowerStore'
import { IdlePowerStatus } from './components/power/IdlePowerStatus'

export function App() {
  return isPublicAccessRuntime()
    ? <RemoteAccessGate><ConnectedApp /></RemoteAccessGate>
    : <ConnectedApp />
}

function ConnectedApp() {
  useScheduledTaskDesktopNotifications()
  useEffect(() => {
    if (isDesktopRuntime()) void usePowerSettingsStore.getState().restore().catch(() => {})
  }, [])
  useEffect(() => {
    if (!isDesktopRuntime()) return
    let cleanup: (() => void) | undefined
    let cancelled = false
    useIdlePowerStore.getState().start().then(unlisten => {
      if (cancelled) unlisten()
      else cleanup = unlisten
    }).catch(() => {})
    return () => {
      cancelled = true
      cleanup?.()
    }
  }, [])
  const shellLayout = useMobileShellLayout(isDesktopRuntime())
  useEffect(
    () => installHiddenSessionRelease(useChatStore, {
      scope: shellLayout === 'desktop' ? 'open-tabs' : 'active-tab',
    }),
    [shellLayout],
  )
  // Phones and tablets keep one page on screen; their tabs are only a way back.
  useEffect(
    () => (shellLayout === 'desktop' ? installSessionTabLimit() : undefined),
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
  return <><AppShell /><IdlePowerStatus /></>
}
