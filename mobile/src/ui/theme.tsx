import { useColorScheme } from 'react-native'
import { usePreferences } from '../state/PreferencesContext'
import { dark as darkPalette, light, type Palette } from './palette'

export type Colors = Palette

/** Current appearance: follows the light / dark / system preference. Components all use the kit useColors(). */
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
  error instanceof Error ? error.message : 'Action did not complete, please retry'
