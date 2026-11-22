import { useEffect, useRef } from 'react'
import { AppState, Platform } from 'react-native'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import { isAppForeground } from '../core/appVisibility'
import { KeepAwakeController, isKeepAwakeAvailable } from './keepAwake'
import { usePreferences } from './PreferencesContext'

function currentForeground(): boolean {
  if (Platform.OS === 'web' && typeof document !== 'undefined')
    return document.visibilityState === 'visible'
  return isAppForeground(AppState.currentState)
}

/** 跟随设置中的「屏幕常亮」开关与前后台状态，管理常亮锁的申请和释放。 */
export function KeepAwakeBridge() {
  const { preferences, ready, error } = usePreferences()
  const enabled = ready && !error && preferences.keepAwake
  const controller = useRef<KeepAwakeController | null>(null)

  useEffect(() => {
    if (!isKeepAwakeAvailable(Platform.OS)) return
    const instance = new KeepAwakeController({
      activate: (tag) => activateKeepAwakeAsync(tag),
      deactivate: (tag) => deactivateKeepAwake(tag),
    })
    controller.current = instance
    instance.setForeground(currentForeground())
    const subscription = AppState.addEventListener('change', (state) => {
      instance.setForeground(isAppForeground(state))
    })
    let removeVisibility: (() => void) | undefined
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const onVisibility = () => instance.setForeground(document.visibilityState === 'visible')
      document.addEventListener('visibilitychange', onVisibility)
      removeVisibility = () => document.removeEventListener('visibilitychange', onVisibility)
    }
    return () => {
      subscription.remove()
      removeVisibility?.()
      instance.dispose()
      if (controller.current === instance) controller.current = null
    }
  }, [])

  useEffect(() => {
    controller.current?.setEnabled(enabled)
  }, [enabled])

  return null
}
