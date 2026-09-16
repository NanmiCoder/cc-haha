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

test('desktop retains the existing endpoint editing contract', async () => {
  expect((await update({ baseUrl: 'https://new.invalid' }, false)).status).toBe(200)
  expect(ProviderService.prototype.updateProvider).toHaveBeenCalledWith('fixture', { baseUrl: 'https://new.invalid' })
})
