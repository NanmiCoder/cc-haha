import { describe, expect, it } from 'vitest'
import { MANAGED_RESOURCES_I18N_KEYS } from '../i18n/keys'
import { en } from '../../../i18n/locales/en'
import { zh } from '../../../i18n/locales/zh'
import { zh as zhTW } from '../../../i18n/locales/zh-TW'
import { jp } from '../../../i18n/locales/jp'
import { kr } from '../../../i18n/locales/kr'

describe('i18n key bindings for managed-resources (U17 / M2.4)', () => {
  const locales = [
    { name: 'en', dict: en },
    { name: 'zh', dict: zh },
    { name: 'zh-TW', dict: zhTW },
    { name: 'jp', dict: jp },
    { name: 'kr', dict: kr },
  ]

  for (const { name, dict } of locales) {
    it(`contains all managed-resources keys in locale: ${name}`, () => {
      for (const key of MANAGED_RESOURCES_I18N_KEYS) {
        expect(key in dict, `Missing key "${key}" in locale ${name}`).toBe(true)
        expect((dict as Record<string, string>)[key]?.length).toBeGreaterThan(0)
      }
    })
  }
})
