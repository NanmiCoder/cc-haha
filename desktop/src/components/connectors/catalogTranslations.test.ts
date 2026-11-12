import { expect, it } from 'vitest'
import { en } from '@/i18n/locales/en'
import { ALL_CONNECTORS } from '../../../../src/services/connectors/catalog'

// Catalog definitions contain only data; no adapter or user-state access runs here.
const connectorIds = ALL_CONNECTORS.map(item => item.id)

it('has English copy for all 55 services and skill plugins, including Remotion', () => {
  expect(connectorIds).toHaveLength(55)
  for (const id of connectorIds) {
    for (const field of ['name', 'description', 'example', 'requirements']) {
      const key = `connectors.${id}.${field}`
      expect((en as Record<string, string>)[key], key).toBeTruthy()
      if (field !== 'name') expect((en as Record<string, string>)[key], key).not.toMatch(/[\u3400-\u9fff]/)
    }
  }
  expect(en['connectors.category.legal']).toBeTruthy()
})
