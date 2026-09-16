import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { handleApiRequest } from './router.js'
import { ProviderService } from './services/providerService.js'
import { SettingsService } from './services/settingsService.js'
import { conversationService } from './services/conversationService.js'
import type { SavedProvider } from './types/provider.js'

const provider: SavedProvider = {
  id: 'fixture-provider', presetId: 'custom', name: 'Fixture', apiKey: 'fake-existing-key',
  baseUrl: 'https://fixture.invalid', apiFormat: 'anthropic', runtimeKind: 'anthropic_compatible',
  models: { main: 'fixture-model', haiku: 'fixture-model', sonnet: 'fixture-model', opus: 'fixture-model' },
  imageGeneration: { model: 'fixture-image', apiKey: 'fake-image-key' },
  requestCompatibility: { maxOutputTokens: 2048, privateFutureField: 'fake-hidden-value' },
  ...{ futureCredential: 'fake-top-level-secret', env: { PRIVATE_KEY: 'fake-env-secret' } },
}

function request(pathname: string, method = 'GET', body?: unknown, remoteBrowser = true) {
  const url = new URL(pathname, 'https://fixture.invalid')
  const req = new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return handleApiRequest(req, url, { remoteBrowser })
}

beforeEach(() => {
  // All persistence and runtime boundaries are substituted before any request.
  spyOn(ProviderService.prototype, 'getProvider').mockResolvedValue(structuredClone(provider))
  spyOn(ProviderService.prototype, 'listProviders').mockResolvedValue({ providers: [structuredClone(provider)], activeId: provider.id, providerOrder: [provider.id] })
  spyOn(ProviderService.prototype, 'addProvider').mockImplementation(async input => ({ ...structuredClone(provider), ...input }))
  spyOn(ProviderService.prototype, 'updateProvider').mockImplementation(async (_id, input) => ({ ...structuredClone(provider), ...input }))
  spyOn(ProviderService.prototype, 'deleteProvider').mockResolvedValue(undefined)
  spyOn(ProviderService.prototype, 'activateProvider').mockResolvedValue(undefined)
  spyOn(SettingsService.prototype, 'getUserSettings').mockResolvedValue({ language: 'en', alwaysThinkingEnabled: true, env: { API_KEY: 'fake-never-expose' }, hooks: { dangerous: true } })
  spyOn(SettingsService.prototype, 'updateUserSettings').mockResolvedValue(undefined)
  spyOn(conversationService, 'getActiveSessions').mockReturnValue([])
})
afterEach(() => mock.restore())

describe('remote browser API routing', () => {
  test('projects provider list, get, and create responses while local desktop retains full records', async () => {
    for (const pathname of ['/api/providers', `/api/providers/${provider.id}`]) {
      const response = await request(pathname)
      expect(response.status).toBe(200)
      const data = await response.json()
      const result = data.provider ?? data.providers[0]
      expect(result.apiKey).toBe('')
      expect(result.hasApiKey).toBe(true)
      expect(result.imageGeneration).toEqual({ model: 'fixture-image', apiKey: '', hasApiKey: true })
      expect(result.requestCompatibility).toEqual({ maxOutputTokens: 2048 })
      expect(JSON.stringify(data)).not.toContain('fake-existing-key')
      expect(JSON.stringify(data)).not.toContain('fake-top-level-secret')
      expect(JSON.stringify(data)).not.toContain('fake-env-secret')
    }
    const created = await request('/api/providers', 'POST', { ...provider, apiKey: 'fake-new-key' })
    expect(created.status).toBe(201)
    expect((await created.json()).provider.apiKey).toBe('')
    expect(ProviderService.prototype.addProvider).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'fake-new-key' }))
    expect((await (await request(`/api/providers/${provider.id}`, 'GET', undefined, false)).json()).provider.apiKey).toBe(provider.apiKey)
  })

  test('blank primary/image keys preserve secrets and compatibility updates preserve hidden future fields', async () => {
    const response = await request(`/api/providers/${provider.id}`, 'PUT', {
      name: 'Renamed', apiKey: '', imageGeneration: { model: 'updated-image', apiKey: '' }, requestCompatibility: { maxOutputTokens: 4096 },
    })
    expect(response.status).toBe(200)
    expect(ProviderService.prototype.updateProvider).toHaveBeenCalledWith(provider.id, {
      name: 'Renamed', imageGeneration: { model: 'updated-image', apiKey: 'fake-image-key' },
      requestCompatibility: { maxOutputTokens: 4096, privateFutureField: 'fake-hidden-value' },
    })
    const data = await response.json()
    expect(data.provider.hasApiKey).toBe(true)
    expect(data.provider.apiKey).toBe('')
    expect(data.provider.requestCompatibility).toEqual({ maxOutputTokens: 4096 })
  })

  test('remote compatibility writes cannot replace hidden extensions or introduce new ones', async () => {
    await request(`/api/providers/${provider.id}`, 'PUT', { requestCompatibility: { maxOutputTokens: 4096, privateFutureField: 'overwrite', env: { NODE_OPTIONS: 'forbidden' } } })
    expect(ProviderService.prototype.updateProvider).toHaveBeenLastCalledWith(provider.id, {
      requestCompatibility: { maxOutputTokens: 4096, privateFutureField: 'fake-hidden-value' },
    })
    await request('/api/providers', 'POST', { ...provider, requestCompatibility: { maxOutputTokens: 4096, env: { NODE_OPTIONS: 'forbidden' } } })
    expect(ProviderService.prototype.addProvider).toHaveBeenLastCalledWith(expect.objectContaining({ requestCompatibility: { maxOutputTokens: 4096 } }))
  })

  test('omitted image key is preserved; explicit replacement reaches service but never response', async () => {
    await request(`/api/providers/${provider.id}`, 'PUT', { imageGeneration: { model: 'updated-image' } })
    expect(ProviderService.prototype.updateProvider).toHaveBeenLastCalledWith(provider.id, { imageGeneration: { model: 'updated-image', apiKey: 'fake-image-key' } })
    const replaced = await request(`/api/providers/${provider.id}`, 'PUT', { apiKey: 'fake-replacement', imageGeneration: { model: 'new', apiKey: 'fake-new-image-key' } })
    expect(ProviderService.prototype.updateProvider).toHaveBeenLastCalledWith(provider.id, { apiKey: 'fake-replacement', imageGeneration: { model: 'new', apiKey: 'fake-new-image-key' } })
    expect(await replaced.text()).not.toContain('fake-replacement')
  })

  test('replaces visible compatibility fields while preserving hidden fields when clearing controls', async () => {
    for (const patch of [{ sampling: 'unsupported' }, {}, null]) {
      const response = await request(`/api/providers/${provider.id}`, 'PUT', { requestCompatibility: patch })
      expect(response.status).toBe(200)
      expect(ProviderService.prototype.updateProvider).toHaveBeenLastCalledWith(provider.id, {
        requestCompatibility: { privateFutureField: 'fake-hidden-value', ...patch },
      })
      expect((await response.json()).provider.requestCompatibility).toEqual(patch ?? {})
    }
    // A desktop editor owns the complete object and retains its existing reset semantics.
    await request(`/api/providers/${provider.id}`, 'PUT', { requestCompatibility: null }, false)
    expect(ProviderService.prototype.updateProvider).toHaveBeenLastCalledWith(provider.id, { requestCompatibility: null })
  })

  test('general reads exclude secrets and valid edits including language reset keep exact requested fields', async () => {
    expect(await (await request('/api/settings/user')).json()).toEqual({ language: 'en', alwaysThinkingEnabled: true })
    const patch = { language: '', chatSendBehavior: 'modifierEnter', workflowKeywordTriggerEnabled: true, alwaysThinkingEnabled: false, outputStyle: 'Learning' }
    const response = await request('/api/settings/user', 'PUT', patch)
    expect(response.status).toBe(200)
    expect(SettingsService.prototype.updateUserSettings).toHaveBeenCalledWith(patch)
  })

  test('rejects protected routes and malformed patches before touching persistence', async () => {
    for (const pathname of ['/api/providers/settings', '/api/providers/cc-switch/scan', '/api/settings/project', '/api/settings/user/extra']) {
      expect((await request(pathname)).status).toBe(403)
    }
    for (const patch of [null, [], 'invalid', { env: { API_KEY: 'forbidden' } }, { alwaysThinkingEnabled: 'true' }]) {
      expect((await request('/api/settings/user', 'PUT', patch)).status).toBe(400)
    }
    expect(SettingsService.prototype.updateUserSettings).not.toHaveBeenCalled()
    const url = new URL('https://fixture.invalid/api/settings/user')
    expect((await handleApiRequest(new Request(url, { method: 'PUT', body: '{broken' }), url, { remoteBrowser: true })).status).toBe(400)
  })

  test('forwards safe mutation results and preserves downstream validation errors', async () => {
    expect((await request(`/api/providers/${provider.id}/activate`, 'POST', {})).status).toBe(200)
    expect(ProviderService.prototype.activateProvider).toHaveBeenCalledWith(provider.id)
    expect((await request(`/api/providers/${provider.id}`, 'DELETE')).status).toBe(200)
    expect(ProviderService.prototype.deleteProvider).toHaveBeenCalledWith(provider.id)
    expect((await request('/api/providers', 'POST', { name: 'missing-required-fields' })).status).toBe(400)
    expect(ProviderService.prototype.addProvider).not.toHaveBeenCalled()
    // Non-settings APIs retain the existing router behavior under remote context.
    expect((await request('/api/nonexistent')).status).toBe(404)
  })
})
