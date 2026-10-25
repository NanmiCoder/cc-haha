import { useColorScheme } from 'react-native'
import { usePreferences } from '../state/PreferencesContext'
import { dark as darkPalette, light, type Palette } from './palette'

export type Colors = Palette

/** 当前外观：跟随偏好里的浅色 / 深色 / 跟随系统。组件统一用 kit 的 useColors()。 */
export function useTheme() {
  const { preferences, update } = usePreferences()
  const system = useColorScheme()
  const dark =
    preferences.appearance === 'dark' ||
    (preferences.appearance === 'system' && system === 'dark')
  return {
    colors: dark ? darkPalette : light,
    dark,
    appearance: preferences.appearance,
    setAppearance: (appearance: 'light' | 'dark' | 'system') =>
      update({ appearance }),
  }
}

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : '操作未完成，请重试'
