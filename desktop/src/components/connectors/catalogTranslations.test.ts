import { expect, it } from 'vitest'
import { en } from '@/i18n/locales/en'
import { zh } from '@/i18n/locales/zh'
import { zh as zhTW } from '@/i18n/locales/zh-TW'
import { jp } from '@/i18n/locales/jp'
import { kr } from '@/i18n/locales/kr'
import { ALL_CONNECTORS } from '../../../../src/services/connectors/catalog'

// Catalog definitions contain only data; no adapter or user-state access runs here.
const connectorIds = ALL_CONNECTORS.map(item => item.id)

it('translates all 54 services and skill plugins in all five locales, including legal search', () => {
  expect(connectorIds).toHaveLength(54)
  for (const id of connectorIds) {
    for (const field of ['name', 'description', 'example', 'requirements']) {
      const key = `connectors.${id}.${field}`
      for (const locale of [en, zh, zhTW, jp, kr]) expect((locale as Record<string, string>)[key], key).toBeTruthy()
      if (field !== 'name') {
        expect((en as Record<string, string>)[key], key).not.toMatch(/[\u3400-\u9fff]/)
        expect((jp as Record<string, string>)[key], key).not.toBe((zh as Record<string, string>)[key])
        expect((kr as Record<string, string>)[key], key).toMatch(/[\uac00-\ud7af]/)
      }
    }
  }
  for (const locale of [en, zh, zhTW, jp, kr]) expect(locale['connectors.category.legal']).toBeTruthy()
})
