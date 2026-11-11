import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { hahaDeepSeekOAuthService } from '../../hahaDeepSeekOAuthService.js'
import { hahaOpenAIOAuthService } from '../../hahaOpenAIOAuthService.js'
import { ProviderService } from '../../providerService.js'
import { createProviderTargetResolver, describeCorrectionTargets, resolvePreferredTarget } from './target.js'

let tmpDir: string
let originalConfigDir: string | undefined

beforeEach(async () => {
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-correction-target-'))
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(async () => {
  hahaOpenAIOAuthService.dispose()
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const models = (haiku: string) => ({ main: 'main-model', haiku, sonnet: 'main-model', opus: 'main-model' })

async function addProvider(name: string, overrides: { apiKey?: string; haiku?: string } = {}) {
  return new ProviderService().addProvider({
    presetId: 'custom',
    name,
    apiKey: overrides.apiKey ?? 'fake-key',
    baseUrl: 'http://127.0.0.1:9/anthropic',
    apiFormat: 'anthropic',
    models: models(overrides.haiku ?? 'fast-model'),
  })
}

describe('default correction target', () => {
  test('is null with no providers configured', async () => {
    expect(await createProviderTargetResolver().resolveDefault()).toBeNull()
  })

  test('is the active provider\'s Haiku-slot model, falling back to main', async () => {
    const provider = await addProvider('Fast Provider')
    const service = new ProviderService()
    await service.activateProvider(provider.id)

    expect((await createProviderTargetResolver().resolveDefault())?.target).toEqual({
      providerId: provider.id,
      providerName: 'Fast Provider',
      modelId: 'fast-model',
    })

    await service.updateProvider(provider.id, { models: models('') })
    expect((await createProviderTargetResolver().resolveDefault())?.target.modelId).toBe('main-model')
  })

  test('is null when the active provider has no key, or no provider is active', async () => {
    const keyless = await addProvider('Keyless', { apiKey: '' })
    await new ProviderService().activateProvider(keyless.id)
    expect(await createProviderTargetResolver().resolveDefault()).toBeNull()

    const resolver = createProviderTargetResolver({
      listProviders: async () => ({ providers: [], activeId: 'deleted-provider', providerOrder: [] }),
      getProvider: async () => { throw new Error('not found') },
    })
    expect(await resolver.resolveDefault()).toBeNull()
  })

  test('follows a signed-in DeepSeek Account and ignores it while signed out', async () => {
    await new ProviderService().activateProvider('deepseek-account')
    expect(await createProviderTargetResolver().resolveDefault()).toBeNull()

    await hahaDeepSeekOAuthService.saveTokens({
      token: 'dsh_fake_token',
      issuer: 'https://platform.deepseek.com',
      deviceId: 'device-1',
    })
    expect((await createProviderTargetResolver().resolveDefault())?.target).toEqual({
      providerId: 'deepseek-account',
      providerName: 'DeepSeek Account',
      modelId: 'deepseek-flash[1m]',
    })
  })

  test('follows ChatGPT Official only with saved tokens', async () => {
    await new ProviderService().activateProvider('openai-official')
    expect(await createProviderTargetResolver().resolveDefault()).toBeNull()

    await hahaOpenAIOAuthService.saveTokens({
      accessToken: 'fake-access',
      refreshToken: 'fake-refresh',
      expiresAt: Date.now() + 60 * 60_000,
      accountId: 'acct_fake',
      email: 'fake@example.com',
    })
    const resolved = await createProviderTargetResolver().resolveDefault()
    expect(resolved?.target.providerId).toBe('openai-official')
    expect(resolved?.target.modelId).toBeTruthy()
  })
})

describe('fixed correction target', () => {
  test('resolves any existing provider with the chosen model and is null once it is deleted', async () => {
    const provider = await addProvider('Chosen')
    const resolver = createProviderTargetResolver()

    expect((await resolver.resolveFixed(provider.id, 'any-model'))?.target).toEqual({
      providerId: provider.id,
      providerName: 'Chosen',
      modelId: 'any-model',
    })
    expect(await resolver.resolveFixed('missing-provider', 'any-model')).toBeNull()

    await new ProviderService().deleteProvider(provider.id)
    expect(await resolver.resolveFixed(provider.id, 'any-model')).toBeNull()
  })

  test('the catalog view: target follows the saved choice and reports a vanished fixed provider as null', async () => {
    const active = await addProvider('Active')
    const chosen = await addProvider('Chosen')
    await new ProviderService().activateProvider(active.id)
    const resolver = createProviderTargetResolver()
    const activeTarget = { providerId: active.id, providerName: 'Active', modelId: 'fast-model' }

    expect(await describeCorrectionTargets(resolver, { correctionProviderId: null, correctionModelId: null }))
      .toEqual({ defaultTarget: activeTarget, target: activeTarget })
    expect(await describeCorrectionTargets(resolver, { correctionProviderId: chosen.id, correctionModelId: 'picked' }))
      .toEqual({ defaultTarget: activeTarget, target: { providerId: chosen.id, providerName: 'Chosen', modelId: 'picked' } })
    expect((await resolvePreferredTarget(resolver, { correctionProviderId: chosen.id, correctionModelId: 'picked' }))?.provider.id)
      .toBe(chosen.id)

    await new ProviderService().deleteProvider(chosen.id)
    expect(await describeCorrectionTargets(resolver, { correctionProviderId: chosen.id, correctionModelId: 'picked' }))
      .toEqual({ defaultTarget: activeTarget, target: null })
  })

  test('a broken provider index reads as nothing configured instead of failing the catalog', async () => {
    const resolver = createProviderTargetResolver({
      listProviders: async () => { throw new Error('index unreadable') },
      getProvider: async () => { throw new Error('index unreadable') },
    })
    expect(await describeCorrectionTargets(resolver, { correctionProviderId: null, correctionModelId: null }))
      .toEqual({ defaultTarget: null, target: null })
  })
})
