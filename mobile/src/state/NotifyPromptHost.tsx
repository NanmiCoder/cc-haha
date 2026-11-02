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

/** 挂在根布局：连上电脑回到首页后，系统还没问过通知权限就推一次引导页。 */
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
  // 满足条件时（含每次冷启动）重新读一遍系统权限，用户可能在系统设置里改过。
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
      // 每次运行只尝试一次，写入失败也不反复重试。
      if (marked.current) return
      marked.current = true
      update({ notifyPrompted: true }).catch(() => {})
    } else if (decision === 'show' && navigation?.key) {
      // 每次运行只推一次引导页；effect 可能因 update 引用变化重复触发。
      if (shown.current) return
      shown.current = true
      router.push('/notify')
    }
  }, [decision, navigation?.key, update])
  return null
}
