import { useColorScheme } from 'react-native'
import { usePreferences } from '../state/PreferencesContext'
import {
  dark as darkPalette,
  light,
  shadowsFor,
  type Palette,
  type ShadowSet,
} from './palette'

export type Colors = Palette
export type { ShadowSet }

/** 当前外观：跟随偏好里的浅色 / 深色 / 跟随系统。组件统一用 kit 的 useColors() 或 useShadows()。 */
export function useTheme() {
  const { preferences, update } = usePreferences()
  const system = useColorScheme()
  const dark =
    preferences.appearance === 'dark' ||
    (preferences.appearance === 'system' && system === 'dark')
  const scheme: 'light' | 'dark' = dark ? 'dark' : 'light'
  return {
    scheme,
    dark,
    colors: dark ? darkPalette : light,
    shadows: shadowsFor(scheme),
    appearance: preferences.appearance,
    setAppearance: (appearance: 'light' | 'dark' | 'system') =>
      update({ appearance }),
  }
}

export function useShadows(): ShadowSet {
  return useTheme().shadows
}

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : '操作未完成，请重试'
