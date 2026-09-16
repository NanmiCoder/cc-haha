import { describe, expect, test } from 'bun:test'
import { remoteProviderNeedsCredentials } from './remoteProviderCredentials.js'
import type { SavedProvider } from './types/provider.js'

const provider: SavedProvider = {
  id: 'fixture', presetId: 'custom', name: 'Fixture', apiKey: 'fake-main-key',
  baseUrl: 'https://trusted.invalid', apiFormat: 'anthropic', runtimeKind: 'anthropic_compatible',
  models: { main: 'fake', haiku: 'fake', sonnet: 'fake', opus: 'fake' },
}

describe('remote provider credential destination binding', () => {
  test('requires an explicit key when changing the main destination', () => {
    for (const apiKey of [undefined, '', ' ']) {
      expect(remoteProviderNeedsCredentials(provider, { baseUrl: 'https://other.invalid', apiKey })).toBe(true)
    }
    expect(remoteProviderNeedsCredentials(provider, { baseUrl: 'https://other.invalid', apiKey: 'fake-new-key' })).toBe(false)
    expect(remoteProviderNeedsCredentials(provider, { name: 'Renamed', apiKey: '' })).toBe(false)
  })

  test('new image destinations cannot inherit the hidden main key', () => {
    const imageGeneration = { model: 'image', baseUrl: 'https://image.invalid' }
    expect(remoteProviderNeedsCredentials(provider, { imageGeneration })).toBe(true)
    expect(remoteProviderNeedsCredentials(provider, { imageGeneration, apiKey: 'fake-new-main' })).toBe(false)
    expect(remoteProviderNeedsCredentials(provider, { imageGeneration: { ...imageGeneration, apiKey: 'fake-new-image' } })).toBe(false)
  })

  test('image URL removal and main URL changes honor dedicated image key retention', () => {
    const separate = { ...provider, imageGeneration: { model: 'image', baseUrl: 'https://image.invalid', apiKey: 'fake-image' } }
    expect(remoteProviderNeedsCredentials(separate, { imageGeneration: { model: 'new' } })).toBe(true)
    expect(remoteProviderNeedsCredentials(separate, { imageGeneration: { model: 'new', baseUrl: '' }, apiKey: 'fake-new-main' })).toBe(true)
    expect(remoteProviderNeedsCredentials(separate, { imageGeneration: { model: 'new', apiKey: 'fake-new-image' } })).toBe(false)
    const inherited = { ...separate, imageGeneration: { model: 'image', apiKey: 'fake-image' } }
    expect(remoteProviderNeedsCredentials(inherited, { baseUrl: 'https://other.invalid', apiKey: 'fake-new-main' })).toBe(true)
    expect(remoteProviderNeedsCredentials(inherited, { baseUrl: 'https://other.invalid', apiKey: 'fake-new-main', imageGeneration: null })).toBe(false)
  })
})
