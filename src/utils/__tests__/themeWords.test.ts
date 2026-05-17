import { describe, expect, test } from 'bun:test'

import {
  getTheme,
  THEME_NAMES,
  themeColorToAnsi,
  type ThemeName,
} from '../theme.js'
import { generateShortWordSlug, generateWordSlug } from '../words.js'

describe('theme utilities', () => {
  test('resolves every supported theme to a complete palette', () => {
    for (const themeName of THEME_NAMES) {
      const theme = getTheme(themeName)

      expect(theme.text).toBeTruthy()
      expect(theme.inverseText).toBeTruthy()
      expect(theme.success).toBeTruthy()
      expect(theme.error).toBeTruthy()
      expect(theme.claude).toBeTruthy()
    }
  })

  test('falls back to the dark theme for unknown concrete theme names', () => {
    const darkTheme = getTheme('dark')
    const unknownTheme = getTheme('unknown' as ThemeName)

    expect(unknownTheme).toBe(darkTheme)
  })

  test('converts rgb theme colors to ansi escapes', () => {
    expect(themeColorToAnsi('rgb(12, 34, 56)')).toEqual(expect.any(String))
    expect(themeColorToAnsi('not-a-color')).toBe('\x1b[35m')
  })
})

describe('word slug utilities', () => {
  test('generates hyphenated slugs with the expected part count', () => {
    expect(generateWordSlug().split('-')).toHaveLength(3)
    expect(generateShortWordSlug().split('-')).toHaveLength(2)
  })
})
