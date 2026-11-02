import { describe, expect, test } from 'bun:test'
import { remoteProviderNeedsCredentials } from './remoteProviderCredentials.js'
import type { SavedProvider } from './types/provider.js'

const provider: SavedProvider = {
  id: 'fixture', presetId: 'custom', name: 'Fixture', apiKey: 'fake-main-key',
  baseUrl: 'https://trusted.invalid', apiFormat: 'anthropic', runtimeKind: 'anthropic_compatible',
  models: { main: 'fake', haiku: 'fake', sonnet: 'fake', opus: 'fake' },
}

describe('remote provider credential destination binding', () => {
  test('unchanged and omitted proxy routes retain the saved credentials', () => {
    const manual = { ...provider, proxy: { mode: 'manual' as const, url: 'http://proxy.example.test:7890' } }
    expect(remoteProviderNeedsCredentials(manual, { name: 'Renamed' })).toBe(false)
    expect(remoteProviderNeedsCredentials(manual, { proxy: undefined })).toBe(false)
    expect(remoteProviderNeedsCredentials(manual, { proxy: { mode: 'manual', url: ' http://proxy.example.test:7890 ' } })).toBe(false)
    expect(remoteProviderNeedsCredentials(provider, { proxy: null })).toBe(false)
    expect(remoteProviderNeedsCredentials(provider, { proxy: { mode: 'follow_global' } })).toBe(false)
    expect(remoteProviderNeedsCredentials({ ...provider, proxy: { mode: 'direct' } }, { proxy: { mode: 'direct', url: 'ignored' } })).toBe(false)
  })

  test('a changed forward proxy cannot receive the hidden model key', () => {
    for (const proxy of [{ mode: 'direct' }, { mode: 'manual', url: 'http://new-proxy.example.test:7890' }]) {
      expect(remoteProviderNeedsCredentials(provider, { proxy })).toBe(true)
      expect(remoteProviderNeedsCredentials(provider, { proxy, apiKey: 'fake-replacement-key' })).toBe(false)
    }
    const manual = { ...provider, proxy: { mode: 'manual' as const, url: 'http://old-proxy.example.test:7890' } }
    for (const proxy of [null, { mode: 'follow_global' }, { mode: 'direct' }, { mode: 'manual', url: 'http://new-proxy.example.test:7890' }]) {
      expect(remoteProviderNeedsCredentials(manual, { proxy, apiKey: '' })).toBe(true)
      expect(remoteProviderNeedsCredentials(manual, { proxy, apiKey: 'fake-replacement-key' })).toBe(false)
    }
  })

  test('proxy changes protect dedicated image keys independently of the main key', () => {
    const separate = { ...provider, imageGeneration: { model: 'image', apiKey: 'fake-image-key' } }
    const proxy = { mode: 'manual', url: 'http://new-proxy.example.test:7890' }
    expect(remoteProviderNeedsCredentials(separate, { proxy, apiKey: 'fake-new-main' })).toBe(true)
    expect(remoteProviderNeedsCredentials(separate, { proxy, imageGeneration: { model: 'image', apiKey: 'fake-new-image' } })).toBe(true)
    expect(remoteProviderNeedsCredentials(separate, { proxy, apiKey: 'fake-new-main', imageGeneration: { model: 'image', apiKey: 'fake-new-image' } })).toBe(false)
    expect(remoteProviderNeedsCredentials(separate, { proxy, apiKey: 'fake-new-main', imageGeneration: null })).toBe(false)
    expect(remoteProviderNeedsCredentials({ ...separate, apiKey: '' }, { proxy })).toBe(true)
    expect(remoteProviderNeedsCredentials({ ...separate, apiKey: '' }, { proxy, imageGeneration: { model: 'image', apiKey: 'fake-new-image' } })).toBe(false)
  })

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
