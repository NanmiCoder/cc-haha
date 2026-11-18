import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProviderService } from '../services/providerService.js'
import { ManagedSettingsService } from '../services/managedSettingsService.js'
import { handleProvidersApi } from '../api/providers.js'

const MODEL_MAPPING = {
  main: 'MiniMax-M3',
  haiku: 'MiniMax-M3',
  sonnet: 'MiniMax-M3',
  opus: 'MiniMax-M3',
}

describe('provider settings isolation', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined
  let originalHome: string | undefined
  let service: ProviderService

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-settings-isolation-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    originalHome = process.env.HOME
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.HOME = tmpDir
    service = new ProviderService()
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
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

  async function saveSettings(settings: Record<string, unknown>, expectedActiveProviderId: string) {
    const url = new URL('http://localhost/api/providers/settings')
    url.searchParams.set('expectedActiveProviderId', expectedActiveProviderId)
    return handleProvidersApi(new Request(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    }), url, ['api', 'providers', 'settings'])
  }

  async function addProxyProvider(name: string) {
    return service.addProvider({
      presetId: 'custom', name, baseUrl: `https://${name}.example.invalid/v1`,
      apiKey: 'fake-test-key', apiFormat: 'openai_chat', models: MODEL_MAPPING,
    })
  }

  test.each(['official', 'other provider'])('rejects a stale editor after another client activates %s without changing either file', async (destination) => {
    const provider = await addProxyProvider('provider-a')
    const other = await addProxyProvider('provider-b')
    await service.activateProvider(provider.id)
    const draft = { ...await service.getManagedSettings(), skipWebFetchPreflight: false }
    if (destination === 'official') await service.activateOfficial()
    else await service.activateProvider(other.id)
    const settingsBefore = await fs.readFile(path.join(tmpDir, 'cc-haha', 'settings.json'), 'utf-8')
    const providersBefore = await fs.readFile(path.join(tmpDir, 'cc-haha', 'providers.json'), 'utf-8')
    const originalBefore = await fs.readFile(path.join(tmpDir, 'settings.json'), 'utf-8').catch(() => null)

    const response = await saveSettings(draft, provider.id)

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'PROVIDER_SETTINGS_OWNER_CHANGED' })
    expect(await fs.readFile(path.join(tmpDir, 'cc-haha', 'settings.json'), 'utf-8')).toBe(settingsBefore)
    expect(await fs.readFile(path.join(tmpDir, 'cc-haha', 'providers.json'), 'utf-8')).toBe(providersBefore)
    expect(await fs.readFile(path.join(tmpDir, 'settings.json'), 'utf-8').catch(() => null)).toBe(originalBefore)
  })

  test('checks ownership when a queued settings write runs, after the default changed', async () => {
    const provider = await addProxyProvider('provider-a')
    await service.activateProvider(provider.id)
    const draft = await service.getManagedSettings()
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const locked = new Promise<void>((resolve) => { entered = resolve })
    const blockingWrite = new ManagedSettingsService().updateSettings(async (settings) => {
      entered()
      await blocked
      return { settings, result: undefined }
    })
    await locked
    let changed!: () => void
    const changedIndex = new Promise<void>((resolve) => { changed = resolve })
    const indexPath = path.join(tmpDir, 'cc-haha', 'providers.json')
    const rename = fs.rename
    const indexWrite = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to)
      if (to === indexPath) changed()
    })
    const saving = service.updateManagedSettings(draft, provider.id)
    const switching = service.activateOfficial()
    const settled = Promise.allSettled([saving, switching, blockingWrite])
    try {
      // Observe the real index rename while the settings queue stays blocked.
      await Promise.race([changedIndex, switching])
      expect((await service.listProviders()).activeId).toBeNull()
    } finally {
      release()
      await settled
      indexWrite.mockRestore()
    }
    const [saveResult, switchResult, blockingResult] = await settled
    expect(saveResult).toMatchObject({ status: 'rejected', reason: { statusCode: 409 } })
    expect(switchResult.status).toBe('fulfilled')
    expect(blockingResult.status).toBe('fulfilled')
    expect((await service.getManagedSettings()).env).not.toHaveProperty('ANTHROPIC_BASE_URL')
  })

  test('accepts the current owner without persisting the query or dropping unknown settings', async () => {
    const provider = await addProxyProvider('provider-a')
    await service.activateProvider(provider.id)
    await service.updateManagedSettings({ futureSetting: { keep: true }, env: { CUSTOM_ENV: 'keep' } })

    const response = await saveSettings({ skipWebFetchPreflight: false }, provider.id)

    expect(response.status).toBe(200)
    expect(await readCcHahaSettings()).toEqual({
      providerEnvOwner: provider.id,
      futureSetting: { keep: true }, env: { CUSTOM_ENV: 'keep' }, skipWebFetchPreflight: false,
    })
    const index = JSON.parse(await fs.readFile(path.join(tmpDir, 'cc-haha', 'providers.json'), 'utf-8'))
    expect(index).not.toHaveProperty('expectedActiveProviderId')
    expect(index.providers[0]).not.toHaveProperty('expectedActiveProviderId')
  })

  test('rejects an explicitly empty owner instead of making the settings write unconditional', async () => {
    await service.updateManagedSettings({ futureSetting: true })
    const response = await saveSettings({ futureSetting: false }, ' ')
    expect(response.status).toBe(400)
    expect(await readCcHahaSettings()).toEqual({ futureSetting: true })
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
