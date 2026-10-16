import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProviderService } from '../services/providerService.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { getAutoCompactThreshold } from '../../services/compact/autoCompact.js'

const MODEL_MAPPING = {
  main: 'MiniMax-M3',
  haiku: 'MiniMax-M3',
  sonnet: 'MiniMax-M3',
  opus: 'MiniMax-M3',
}

describe('provider settings isolation', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined
  let service: ProviderService

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-settings-isolation-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    service = new ProviderService()
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function readCcHahaSettings(): Promise<Record<string, unknown>> {
    const raw = await fs.readFile(path.join(tmpDir, 'cc-haha', 'settings.json'), 'utf-8')
    return JSON.parse(raw)
  }

  async function originalSettingsExists(): Promise<boolean> {
    try {
      await fs.access(path.join(tmpDir, 'settings.json'))
      return true
    } catch {
      return false
    }
  }

  test('official runtime and regenerated settings honor global model windows across provider switches', async () => {
    const userSettings = {
      unknownField: { preserved: true },
      env: {
        CLAUDE_CODE_MODEL_CONTEXT_WINDOWS: JSON.stringify({
          'gpt-6.1-sol': 1000000,
          'grok-4.7': 1000000,
        }),
      },
    }
    await fs.writeFile(path.join(tmpDir, 'settings.json'), JSON.stringify(userSettings))
    for (const id of ['openai-official', 'grok-official', 'openai-official']) {
      await service.activateProvider(id)
      const runtime = await service.getProviderRuntimeEnv(id)
      const managed = (await readCcHahaSettings()).env as Record<string, string>
      expect(JSON.parse(runtime.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS)).toMatchObject({
        'gpt-6.1-sol': 1000000, 'grok-4.7': 1000000,
      })
      expect(managed.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS).toBe(runtime.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS)
      expect(runtime.DISABLE_COMPACT).toBeUndefined()
      expect(runtime.DISABLE_AUTO_COMPACT).toBeUndefined()
    }
    expect(JSON.parse(await fs.readFile(path.join(tmpDir, 'settings.json'), 'utf-8'))).toEqual(userSettings)
  })

  test.each([
    ['vendor/small-model', 'small-model'],
    ['small-model', 'vendor/small-model'],
  ])('keeps provider precedence across namespaces and switches: global %s, provider %s', async (globalModel, providerModel) => {
    await fs.writeFile(path.join(tmpDir, 'settings.json'), JSON.stringify({
      env: { CLAUDE_CODE_MODEL_CONTEXT_WINDOWS: JSON.stringify({ [globalModel]: 1000000 }) },
    }))
    const models = { main: 'vendor/small-model', haiku: 'vendor/small-model', sonnet: 'vendor/small-model', opus: 'vendor/small-model' }
    const small = await service.addProvider({
      presetId: 'custom', name: 'Small', baseUrl: 'https://small.example.test', apiKey: 'fixture-small',
      apiFormat: 'openai_chat', models, modelContextWindows: { [providerModel]: 128000 },
    })
    const large = await service.addProvider({
      presetId: 'custom', name: 'Large', baseUrl: 'https://large.example.test', apiKey: 'fixture-large',
      apiFormat: 'openai_chat', models, modelContextWindows: { [providerModel]: 1000000 },
    })
    const keys = ['CLAUDE_CODE_MODEL_CONTEXT_WINDOWS', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
      'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
      'CLAUDE_CODE_DISABLE_1M_CONTEXT', 'CLAUDE_CODE_PROVIDER_MAX_OUTPUT_TOKENS', 'USER_TYPE']
    const saved = keys.map(key => process.env[key])
    try {
      for (const key of keys) delete process.env[key]
      process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '32000'
      for (const [provider, expected] of [[small, 128000], [large, 1000000], [small, 128000]] as const) {
        await service.activateProvider(provider.id)
        const env = await service.getProviderRuntimeEnv(provider.id)
        process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS = env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS
        expect(getContextWindowForModel(models.main)).toBe(expected)
        expect(getAutoCompactThreshold(models.main)).toBe(expected - 33000)
      }
    } finally {
      keys.forEach((key, index) => {
        if (saved[index] === undefined) delete process.env[key]
        else process.env[key] = saved[index]
      })
    }
  })

  test('activating a provider writes only cc-haha/settings.json', async () => {
    const minimax = await service.addProvider({
      presetId: 'minimax',
      name: 'MiniMax',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      apiKey: 'sk-fake-test-key-for-testing-only',
      models: MODEL_MAPPING,
      notes: 'MiniMax official Anthropic-compatible endpoint',
    })

    await service.activateProvider(minimax.id)

    const settings = await readCcHahaSettings()
    const env = settings.env as Record<string, string>
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.minimaxi.com/anthropic')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-fake-test-key-for-testing-only')
    expect(env.ANTHROPIC_API_KEY).toBe('')
    expect(env.ANTHROPIC_MODEL).toBe('MiniMax-M3')
    expect(JSON.parse(env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS)).toMatchObject({
      'MiniMax-M3': 1000000,
      'MiniMax-M2.7': 204800,
      'MiniMax-M2.7-highspeed': 204800,
    })
    expect(await originalSettingsExists()).toBe(false)
  })

  test('switching providers replaces managed env without creating settings.json', async () => {
    const minimax = await service.addProvider({
      presetId: 'minimax',
      name: 'MiniMax',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      apiKey: 'sk-api-test-minimax',
      models: MODEL_MAPPING,
    })
    const relay = await service.addProvider({
      presetId: 'custom',
      name: 'Relay',
      baseUrl: 'https://api.jiekou.ai/anthropic',
      apiKey: 'sk-fake-test-key-for-testing-only',
      models: {
        main: 'claude-opus-4-7',
        haiku: 'claude-haiku-4-5',
        sonnet: 'claude-sonnet-4-6',
        opus: 'claude-opus-4-7',
      },
    })

    await service.activateProvider(minimax.id)
    let settings = await readCcHahaSettings()
    let env = settings.env as Record<string, string>
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.minimaxi.com/anthropic')
    expect(JSON.parse(env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS)).toMatchObject({
      'MiniMax-M3': 1000000,
      'MiniMax-M2.7': 204800,
      'MiniMax-M2.7-highspeed': 204800,
    })

    await service.activateProvider(relay.id)
    settings = await readCcHahaSettings()
    env = settings.env as Record<string, string>
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.jiekou.ai/anthropic')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-fake-test-key-for-testing-only')
    expect(env.ANTHROPIC_API_KEY).toBe('')
    expect(env.ANTHROPIC_MODEL).toBe('claude-opus-4-7')
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()

    const list = await service.listProviders()
    expect(list.activeId).toBe(relay.id)
    expect(await originalSettingsExists()).toBe(false)
  })

  test('activation preserves unrelated cc-haha settings and env', async () => {
    await fs.mkdir(path.join(tmpDir, 'cc-haha'), { recursive: true })
    await fs.writeFile(
      path.join(tmpDir, 'cc-haha', 'settings.json'),
      JSON.stringify({
        customField: 'should_be_preserved',
        env: {
          EXISTING_VAR: 'should_be_preserved',
        },
      }, null, 2),
    )

    const provider = await service.addProvider({
      presetId: 'custom',
      name: 'Relay',
      baseUrl: 'https://api.jiekou.ai/anthropic',
      apiKey: 'sk_test',
      models: {
        main: 'claude-opus-4-7',
        haiku: 'claude-haiku-4-5',
        sonnet: 'claude-sonnet-4-6',
        opus: 'claude-opus-4-7',
      },
    })
    await service.activateProvider(provider.id)

    const settings = await readCcHahaSettings()
    const env = settings.env as Record<string, string>
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.jiekou.ai/anthropic')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk_test')
    expect(env.ANTHROPIC_API_KEY).toBe('')
    expect(settings.customField).toBe('should_be_preserved')
    expect(env.EXISTING_VAR).toBe('should_be_preserved')
  })

  test('activateOfficial removes only provider-managed env', async () => {
    await fs.mkdir(path.join(tmpDir, 'cc-haha'), { recursive: true })
    await fs.writeFile(
      path.join(tmpDir, 'cc-haha', 'settings.json'),
      JSON.stringify({ env: { EXISTING_VAR: 'keep-me' } }, null, 2),
    )
    const provider = await service.addProvider({
      presetId: 'minimax',
      name: 'MiniMax',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      apiKey: 'sk-test',
      models: MODEL_MAPPING,
    })

    await service.activateProvider(provider.id)
    await service.activateOfficial()

    const settings = await readCcHahaSettings()
    const env = settings.env as Record<string, string> | undefined
    expect(env?.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env?.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env?.ANTHROPIC_MODEL).toBeUndefined()
    expect(env?.EXISTING_VAR).toBe('keep-me')
  })

  test('providers.json and cc-haha/settings.json stay isolated from Claude settings.json', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({
        effortLevel: 'high',
        env: {
          ANTHROPIC_BASE_URL: 'https://original-claude-code.api.com',
          ANTHROPIC_API_KEY: 'original-key',
        },
      }, null, 2),
    )

    const provider = await service.addProvider({
      presetId: 'minimax',
      name: 'MiniMax',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      apiKey: 'sk-haha-key',
      models: MODEL_MAPPING,
    })
    await service.activateProvider(provider.id)

    const original = JSON.parse(await fs.readFile(path.join(tmpDir, 'settings.json'), 'utf-8'))
    expect(original.env.ANTHROPIC_BASE_URL).toBe('https://original-claude-code.api.com')
    expect(original.env.ANTHROPIC_API_KEY).toBe('original-key')
    expect(original.effortLevel).toBe('high')

    const haha = await readCcHahaSettings()
    const env = haha.env as Record<string, string>
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.minimaxi.com/anthropic')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-haha-key')
    expect(env.ANTHROPIC_API_KEY).toBe('')
  })
})
