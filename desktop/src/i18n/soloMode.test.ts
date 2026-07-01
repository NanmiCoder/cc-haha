import { describe, expect, it } from 'vitest'
import { en } from './locales/en'
import { zh } from './locales/zh'
import { zh as zhTW } from './locales/zh-TW'
import { jp } from './locales/jp'
import { kr } from './locales/kr'

/**
 * Naming contract for the Solo mode UI.
 *
 * Earlier translations rendered "Solo mode" as locale-specific phrases
 * — `独立流水线模式` (zh), `獨立流水線模式` (zh-TW), `ソロパイプラインモード`
 * (jp), `솔로 파이프라인 모드` (kr) — which obscured the product name and
 * disagreed with how the feature is referred to elsewhere (release notes,
 * commit messages, the `'solo'` runtime flavor on the wire).
 *
 * This test locks the product-name surface to "Solo" across the 3 user-facing
 * keys (`chat.soloPipelineMode`, `session.soloPipelineChip`,
 * `session.soloPipelineChipTooltip`) so a translator can't quietly swap it
 * back to a localized translation.
 */

const LOCALES = { en, zh, 'zh-TW': zhTW, jp, kr } as const
type Locale = keyof typeof LOCALES

const SOLO_PRODUCT_KEYS = [
  'chat.soloPipelineMode',
  'session.soloPipelineChip',
  'session.soloPipelineChipTooltip',
] as const

describe('Solo mode i18n naming contract', () => {
  for (const locale of Object.keys(LOCALES) as Locale[]) {
    describe(`locale: ${locale}`, () => {
      for (const key of SOLO_PRODUCT_KEYS) {
        it(`${key} contains the literal product name "Solo"`, () => {
          const dict = LOCALES[locale] as Record<string, string>
          const value = dict[key]
          expect(value).toBeDefined()
          expect(typeof value).toBe('string')
          expect(value!.length).toBeGreaterThan(0)
          // The literal ASCII "Solo" must appear in every locale's rendering
          // — no localized translations of the product name itself.
          expect(value).toContain('Solo')
        })
      }

      it('does not leak retired translations of the product name', () => {
        const retired = [
          '独立流水线',
          '獨立流水線',
          'ソロパイプ',
          '솔로 파이프',
        ]
        for (const key of SOLO_PRODUCT_KEYS) {
          const dict = LOCALES[locale] as Record<string, string>
          const value = dict[key] ?? ''
          for (const phrase of retired) {
            expect(value).not.toContain(phrase)
          }
        }
      })
    })
  }
})
