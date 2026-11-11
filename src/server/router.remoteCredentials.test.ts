import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { handleApiRequest } from './router.js'
import { ProviderService } from './services/providerService.js'
import type { SavedProvider } from './types/provider.js'

const provider: SavedProvider = {
  id: 'fixture', presetId: 'custom', name: 'Fixture', apiKey: 'fake-secret',
  baseUrl: 'https://trusted.invalid', apiFormat: 'anthropic', runtimeKind: 'anthropic_compatible',
  models: { main: 'fake', haiku: 'fake', sonnet: 'fake', opus: 'fake' },
}
beforeEach(() => {
  spyOn(ProviderService.prototype, 'getProvider').mockResolvedValue(structuredClone(provider))
  spyOn(ProviderService.prototype, 'updateProvider').mockImplementation(async (_id, input) => ({ ...provider, ...input } as SavedProvider))
})
afterEach(() => mock.restore())

function update(input: unknown, remoteBrowser = true) {
  const url = new URL('https://fixture.invalid/api/providers/fixture')
  return handleApiRequest(new Request(url, { method: 'PUT', body: JSON.stringify(input) }), url, { remoteBrowser })
}

test('remote endpoint changes reject retained secrets before persistence', async () => {
  for (const input of [
    { baseUrl: 'https://attacker.invalid', apiKey: '' },
    { baseUrl: 'https://attacker.invalid' },
    { imageGeneration: { model: 'image', baseUrl: 'https://attacker.invalid', apiKey: '' } },
  ]) {
    const response = await update(input)
    expect(response.status).toBe(400)
    expect((await response.json()).code).toBe('REMOTE_PROVIDER_CREDENTIAL_REQUIRED')
  }
  expect(ProviderService.prototype.updateProvider).not.toHaveBeenCalled()
})

test('explicit replacement permits remote endpoint edit and remains redacted', async () => {
  const response = await update({ baseUrl: 'https://new.invalid', apiKey: 'fake-new-key' })
  expect(response.status).toBe(200)
  expect(ProviderService.prototype.updateProvider).toHaveBeenCalledWith('fixture', { baseUrl: 'https://new.invalid', apiKey: 'fake-new-key' })
  expect(await response.text()).not.toContain('fake-new-key')
})

test('remote proxy changes reject retained keys before persistence and preserve a name-only edit', async () => {
  const saved = { ...provider, proxy: { mode: 'manual' as const, url: 'http://fake-user:fake-password@old-proxy.invalid:7890' } }
  spyOn(ProviderService.prototype, 'getProvider').mockResolvedValue(saved)
  for (const proxy of [null, { mode: 'direct' }, { mode: 'manual', url: 'http://other-proxy.invalid:7890' }]) {
    const response = await update({ proxy })
    expect(response.status).toBe(400)
    expect((await response.json()).code).toBe('REMOTE_PROVIDER_CREDENTIAL_REQUIRED')
  }
  expect(ProviderService.prototype.updateProvider).not.toHaveBeenCalled()
  expect((await update({ name: 'Renamed' })).status).toBe(200)
  expect(ProviderService.prototype.updateProvider).toHaveBeenCalledWith('fixture', { name: 'Renamed' })
})

test('remote proxy changes accept explicit replacement keys without exposing the proxy URL', async () => {
  const saved = { ...provider, imageGeneration: { model: 'image', apiKey: 'fake-saved-image-key' } }
  spyOn(ProviderService.prototype, 'getProvider').mockResolvedValue(saved)
  const proxy = { mode: 'manual', url: 'http://new-user:new-password@other-proxy.invalid:7890' }
  const denied = await update({ proxy, apiKey: 'fake-new-main' })
  expect(denied.status).toBe(400)
  expect(ProviderService.prototype.updateProvider).not.toHaveBeenCalled()
  const input = { proxy, apiKey: 'fake-new-main', imageGeneration: { model: 'image', apiKey: 'fake-new-image' } }
  const accepted = await update(input)
  expect(accepted.status).toBe(200)
  expect(ProviderService.prototype.updateProvider).toHaveBeenCalledWith('fixture', input)
  const text = await accepted.text()
  expect(JSON.parse(text).provider.proxy).toEqual({ mode: 'manual' })
  for (const secret of ['new-user', 'new-password', 'fake-new-main', 'fake-new-image']) expect(text).not.toContain(secret)
})

test('desktop retains the existing endpoint editing contract', async () => {
  expect((await update({ baseUrl: 'https://new.invalid' }, false)).status).toBe(200)
  expect(ProviderService.prototype.updateProvider).toHaveBeenCalledWith('fixture', { baseUrl: 'https://new.invalid' })
  expect((await update({ proxy: { mode: 'direct' } }, false)).status).toBe(200)
  expect(ProviderService.prototype.updateProvider).toHaveBeenCalledWith('fixture', { proxy: { mode: 'direct' } })
})
