import { useEffect, useRef, useState } from 'react'
import { Platform } from 'react-native'
import { router, usePathname, useRootNavigationState } from 'expo-router'
import * as Notifications from 'expo-notifications'
import { useApp } from './AppContext'
import { usePreferences } from './PreferencesContext'
import {
  classifyPermission,
  decideNotifyPrompt,
  type NotifyPermission,
} from './notifyPromptGate'

/** Mounted on the root layout: after connecting a computer and returning home, push the onboarding page once if the system has not asked for notification permission yet. */
export function NotifyPromptHost() {
  const { registry, ready } = useApp()
  const {
    preferences,
    ready: preferencesReady,
    error: preferencesError,
    update,
  } = usePreferences()
  const navigation = useRootNavigationState()
  const pathname = usePathname()
  const [permission, setPermission] = useState<NotifyPermission>('unknown')
  const shown = useRef(false)
  const marked = useRef(false)
  const eligible =
    Platform.OS !== 'web' &&
    ready &&
    registry.hosts.length > 0 &&
    preferencesReady &&
    !preferencesError &&
    !preferences.notifyPrompted
  // Reread system permissions when conditions are met (including every cold start); the user may have changed them in system settings.
  useEffect(() => {
    if (!eligible) return
    let alive = true
    Notifications.getPermissionsAsync()
      .then((result) => {
        if (!alive) return
        setPermission(classifyPermission(result))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [eligible])
  const decision = decideNotifyPrompt({
    platform: Platform.OS,
    appReady: ready,
    hostCount: registry.hosts.length,
    preferencesReady,
    preferencesError: Boolean(preferencesError),
    prompted: preferences.notifyPrompted,
    permission,
    onHome: pathname === '/',
  })
  useEffect(() => {
    if (decision === 'markPrompted') {
      // Try only once per run; do not retry repeatedly even if the write fails.
      if (marked.current) return
      marked.current = true
      update({ notifyPrompted: true }).catch(() => {})
    } else if (decision === 'show' && navigation?.key) {
      // Push the onboarding page only once per run; the effect may fire repeatedly as the update reference changes.
      if (shown.current) return
      shown.current = true
      router.push('/notify')
    }
  }, [decision, navigation?.key, update])
  return null
}
