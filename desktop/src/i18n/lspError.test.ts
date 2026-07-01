import { describe, expect, it } from 'vitest'
import { translate } from '.'
import { en } from './locales/en'
import { zh } from './locales/zh'
import { zh as zhTW } from './locales/zh-TW'
import { jp } from './locales/jp'
import { kr } from './locales/kr'

/**
 * Phase 5 of editor-lsp-foundation adds the `solo.suggest.lspError.*`
 * trio of i18n keys for the LSP-error cleanup suggestion. This test
 * locks the 5-locale × 3-key contract on the desktop side: each locale
 * must have all three keys, none empty, and the count param must
 * survive interpolation.
 *
 * `TranslationKey = keyof typeof en` already gates compile-time
 * completeness, but a runtime test catches the case where a locale
 * imports the key but ships an empty string (visually indistinguishable
 * from a real translation in tsc).
 */

const LOCALES = { en, zh, 'zh-TW': zhTW, jp, kr } as const
type Locale = keyof typeof LOCALES

const LSP_ERROR_KEYS = [
  'solo.suggest.lspError.title',
  'solo.suggest.lspError.detail',
  'solo.suggest.lspError.taskPrompt',
] as const

describe('solo.suggest.lspError i18n contract — Phase 5', () => {
  for (const locale of Object.keys(LOCALES) as Locale[]) {
    describe(`locale: ${locale}`, () => {
      for (const key of LSP_ERROR_KEYS) {
        it(`has ${key}`, () => {
          const dict = LOCALES[locale] as Record<string, string>
          expect(dict[key]).toBeDefined()
          expect(typeof dict[key]).toBe('string')
          expect(dict[key]!.length).toBeGreaterThan(0)
        })
      }
    })
  }

  it('renders the count param for every locale title', () => {
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      const result = translate(locale, 'solo.suggest.lspError.title', { count: 7 })
      expect(result).toContain('7')
    }
  })

  it('renders the count param for every locale taskPrompt', () => {
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      const result = translate(locale, 'solo.suggest.lspError.taskPrompt', { count: 12 })
      expect(result).toContain('12')
    }
  })

  it('detail key is param-free across locales (matches the source-of-truth fixture)', () => {
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      const dict = LOCALES[locale] as Record<string, string>
      expect(dict['solo.suggest.lspError.detail']).not.toContain('{')
    }
  })
})
