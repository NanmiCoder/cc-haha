/**
 * Unit tests for ProviderService and Providers REST API
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { ProviderService } from '../services/providerService.js'
import { handleProvidersApi } from '../api/providers.js'
import type { CreateProviderInput } from '../types/provider.js'

// ─── Test helpers ─────────────────────────────────────────────────────────────

let tmpDir: string
let originalConfigDir: string | undefined

async function setup() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
}

async function teardown() {
  if (originalConfigDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
}

/** Create a mock Request */
function makeRequest(
  method: string,
  urlStr: string,
  body?: Record<string, unknown>,
): { req: Request; url: URL; segments: string[] } {
  const url = new URL(urlStr, 'http://localhost:3456')
  const init: RequestInit = { method }
  if (body) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const req = new Request(url.toString(), init)
  const segments = url.pathname.split('/').filter(Boolean)
  return { req, url, segments }
}

/** A sample provider input for reuse across tests */
function sampleInput(overrides?: Partial<CreateProviderInput>): CreateProviderInput {
  return {
    presetId: 'custom',
    name: 'Test Provider',
    baseUrl: 'https://api.example.com',
    apiKey: 'sk-test-key-123',
    apiFormat: 'anthropic',
    models: {
      main: 'model-main',
      haiku: 'model-haiku',
      sonnet: 'model-sonnet',
      opus: 'model-opus',
    },
    ...overrides,
  }
}

/** Read the settings.json written to the temp config dir */
async function readSettings(): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(tmpDir, 'cc-haha', 'settings.json'), 'utf-8')
  return JSON.parse(raw) as Record<string, unknown>
}

/** Read the providers.json written to the temp config dir */
async function readProvidersConfig(): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(tmpDir, 'cc-haha', 'providers.json'), 'utf-8')
  return JSON.parse(raw) as Record<string, unknown>
}

// =============================================================================
// ProviderService
// =============================================================================

describe('ProviderService', () => {
  beforeEach(setup)
  afterEach(teardown)

  // ─── listProviders ───────────────────────────────────────────────────────

  describe('listProviders', () => {
    test('should return empty array when no providers exist', async () => {
      const svc = new ProviderService()
      const result = await svc.listProviders()
      expect(result).toEqual({ providers: [], activeId: null })
    })

    test('should recover from a malformed providers index after an upgrade', async () => {
      await fs.mkdir(path.join(tmpDir, 'cc-haha'), { recursive: true })
      await fs.writeFile(path.join(tmpDir, 'cc-haha', 'providers.json'), '{not json', 'utf-8')

      const svc = new ProviderService()
      const result = await svc.listProviders()
      const files = await fs.readdir(path.join(tmpDir, 'cc-haha'))

      expect(result).toEqual({ providers: [], activeId: null })
      expect(files.some((name) => name.startsWith('providers.json.invalid-'))).toBe(true)
    })

    test('should normalize a legacy activeProviderId field', async () => {
      await fs.mkdir(path.join(tmpDir, 'cc-haha'), { recursive: true })
      const provider = {
        id: 'legacy-provider',
        ...sampleInput({ name: 'Legacy Provider' }),
      }
      await fs.writeFile(
        path.join(tmpDir, 'cc-haha', 'providers.json'),
        JSON.stringify({ activeProviderId: provider.id, providers: [provider] }),
        'utf-8',
      )

      const svc = new ProviderService()
      const result = await svc.listProviders()

      expect(result.activeId).toBe(provider.id)
      expect(result.providers).toHaveLength(1)
      expect(result.providers[0].name).toBe('Legacy Provider')
    })

    test('should return all added providers', async () => {
      const svc = new ProviderService()
      await svc.addProvider(sampleInput({ name: 'Provider A' }))
      await svc.addProvider(sampleInput({ name: 'Provider B' }))

      const { providers, activeId } = await svc.listProviders()
      expect(providers).toHaveLength(2)
      expect(providers[0].name).toBe('Provider A')
      expect(providers[1].name).toBe('Provider B')
      expect(activeId).toBeNull()
    })
  })

  // ─── addProvider ─────────────────────────────────────────────────────────

  describe('addProvider', () => {
    test('should add a provider and return it with generated fields', async () => {
      const svc = new ProviderService()
      const provider = await svc.addProvider(sampleInput())

      expect(provider.id).toBeDefined()
      expect(provider.name).toBe('Test Provider')
      expect(provider.baseUrl).toBe('https://api.example.com')
      expect(provider.apiKey).toBe('sk-test-key-123')
      expect(provider.models.main).toBe('model-main')
    })

    test('new providers should not be auto-activated', async () => {
      const svc = new ProviderService()
      const provider = await svc.addProvider(sampleInput())

      expect(provider.id).toBeDefined()
      const { activeId } = await svc.listProviders()
      expect(activeId).toBeNull()
    })

    test('adding a provider should not sync settings until activated', async () => {
      const svc = new ProviderService()
      await svc.addProvider(sampleInput())

      await expect(fs.readFile(path.join(tmpDir, 'cc-haha', 'settings.json'), 'utf-8')).rejects.toThrow()
    })

    test('custom providers declare thinking and effort capability passthrough for user-defined models', async () => {
      const svc = new ProviderService()
      const provider = await svc.addProvider(sampleInput({
        models: {
          main: 'deepseek-ai/DeepSeek-V4-Pro',
          haiku: 'deepseek-ai/DeepSeek-V4-Pro',
          sonnet: 'deepseek-ai/DeepSeek-V4-Pro',
          opus: 'deepseek-ai/DeepSeek-V4-Pro',
        },
      }))

      await svc.activateProvider(provider.id)

      const settings = await readSettings()
      const env = settings.env as Record<string, string>
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('deepseek-ai/DeepSeek-V4-Pro')
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES).toBe(
        'thinking,effort,adaptive_thinking,max_effort',
      )
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES).toBe(
        'thinking,effort,adaptive_thinking,max_effort',
      )
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES).toBe(
        'thinking,effort,adaptive_thinking,max_effort',
      )
    })

    test('DeepSeek preset follows the global thinking toggle instead of forcing disabled thinking', async () => {
      const svc = new ProviderService()
      const provider = await svc.addProvider(sampleInput({
        presetId: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/anthropic',
        models: {
          main: 'deepseek-v4-pro',
          haiku: 'deepseek-v4-flash',
          sonnet: 'deepseek-v4-pro',
          opus: 'deepseek-v4-pro',
        },
      }))

      await svc.activateProvider(provider.id)

      const settings = await readSettings()
      const env = settings.env as Record<string, string>
      expect(env.CC_HAHA_SEND_DISABLED_THINKING).toBeUndefined()
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES).toBe(
        'thinking,effort,adaptive_thinking,max_effort',
      )
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES).toBe(
        'thinking,effort,adaptive_thinking,max_effort',
      )
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES).toBe(
        'thinking,effort,adaptive_thinking,max_effort',
      )
    })

    test('adding additional providers should keep activeId unchanged', async () => {
      const svc = new ProviderService()
      await svc.addProvider(sampleInput({ name: 'First' }))
      const second = await svc.addProvider(sampleInput({ name: 'Second' }))

      expect(second.id).toBeDefined()
      const { activeId } = await svc.listProviders()
      expect(activeId).toBeNull()
    })

    test('should preserve optional notes field', async () => {
      const svc = new ProviderService()
      const provider = await svc.addProvider(sampleInput({ notes: 'dev environment' }))

      expect(provider.notes).toBe('dev environment')
    })

    test('should preserve optional auto compact window', async () => {
      const svc = new ProviderService()
      const provider = await svc.addProvider(sampleInput({ autoCompactWindow: 64000 }))

      expect(provider.autoCompactWindow).toBe(64000)
    })

    test('should preserve optional model context windows', async () => {
      const svc = new ProviderService()
      const provider = await svc.addProvider(sampleInput({
        modelContextWindows: {
          'model-main': 300000,
          'model-haiku': 128000,
        },
      }))

      expect(provider.modelContextWindows).toEqual({
        'model-main': 300000,
        'model-haiku': 128000,
      })
    })
  })

  // ─── getProvider ─────────────────────────────────────────────────────────

  describe('getProvider', () => {
    test('should return the provider by id', async () => {
      const svc = new ProviderService()
      const added = await svc.addProvider(sampleInput())

      const fetched = await svc.getProvider(added.id)
      expect(fetched.id).toBe(added.id)
      expect(fetched.name).toBe(added.name)
    })

    test('should throw 404 for non-existent id', async () => {
      const svc = new ProviderService()

      try {
        await svc.getProvider('non-existent-id')
        expect(true).toBe(false) // should not reach here
      } catch (err: unknown) {
        const apiErr = err as { statusCode: number }
        expect(apiErr.statusCode).toBe(404)
      }
    })
  })

  // ─── updateProvider ──────────────────────────────────────────────────────

  describe('updateProvider', () => {
    test('should update provider fields', async () => {
      const svc = new ProviderService()
      const added = await svc.addProvider(sampleInput())

      const updated = await svc.updateProvider(added.id, {
        name: 'Updated Name',
        baseUrl: 'https://new-api.example.com',
      })

      expect(updated.name).toBe('Updated Name')
      expect(updated.baseUrl).toBe('https://new-api.example.com')
      // unchanged fields preserved
      expect(updated.apiKey).toBe('sk-test-key-123')
    })

    test('should throw 404 for non-existent provider', async () => {
      const svc = new ProviderService()

      try {
        await svc.updateProvider('non-existent-id', { name: 'X' })
        expect(true).toBe(false)
      } catch (err: unknown) {
        const apiErr = err as { statusCode: number }
        expect(apiErr.statusCode).toBe(404)
      }
    })

    test('updating active provider should re-sync settings.json', async () => {
      const svc = new ProviderService()
      const added = await svc.addProvider(sampleInput())
      await svc.activateProvider(added.id)

      await svc.updateProvider(added.id, {
        baseUrl: 'https://new-api.example.com',
        apiKey: 'sk-new-key',
      })

      const settings = await readSettings()
      const env = settings.env as Record<string, string>
      expect(env.ANTHROPIC_BASE_URL).toBe('https://new-api.example.com')
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-new-key')
      expect(env.ANTHROPIC_API_KEY).toBe('')
      expect(env.ANTHROPIC_MODEL).toBe('model-main')
    })

    test('updating active provider should override and clear auto compact window', async () => {
      const svc = new ProviderService()
      const added = await svc.addProvider(sampleInput({ autoCompactWindow: 64000 }))
      await svc.activateProvider(added.id)

      let settings = await readSettings()
      let env = settings.env as Record<string, string>
      expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('64000')

      await svc.updateProvider(added.id, { autoCompactWindow: 32000 })

      settings = await readSettings()
      env = settings.env as Record<string, string>
      expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('32000')

      await svc.updateProvider(added.id, { autoCompactWindow: null })

      settings = await readSettings()
      env = settings.env as Record<string, string>
      expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()
    })

    test('updating active provider should override and clear model context windows', async () => {
      const svc = new ProviderService()
      const added = await svc.addProvider(sampleInput({
        modelContextWindows: { 'model-main': 300000 },
      }))
      await svc.activateProvider(added.id)

      let settings = await readSettings()
      let env = settings.env as Record<string, string>
      expect(JSON.parse(env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS)).toEqual({
        'model-main': 300000,
      })

      await svc.updateProvider(added.id, {
        modelContextWindows: { 'model-main': 500000 },
      })

      settings = await readSettings()
      env = settings.env as Record<string, string>
      expect(JSON.parse(env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS)).toEqual({
        'model-main': 500000,
      })

      await svc.updateProvider(added.id, { modelContextWindows: null })

      settings = await readSettings()
      env = settings.env as Record<string, string>
      expect(env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS).toBeUndefined()
    })
  })

  // ─── deleteProvider ──────────────────────────────────────────────────────

  describe('deleteProvider', () => {
    test('should delete an inactive provider', async () => {
      const svc = new ProviderService()
      await svc.addProvider(sampleInput({ name: 'First' }))
      const second = await svc.addProvider(sampleInput({ name: 'Second' }))

      // Second is inactive, so deletion should succeed
      await svc.deleteProvider(second.id)

      const { providers } = await svc.listProviders()
      expect(providers).toHaveLength(1)
      expect(providers[0].name).toBe('First')
    })

    test('should throw 409 when deleting an active provider', async () => {
      const svc = new ProviderService()
      const active = await svc.addProvider(sampleInput())
      await svc.activateProvider(active.id)

      try {
        await svc.deleteProvider(active.id)
        expect(true).toBe(false)
      } catch (err: unknown) {
        const apiErr = err as { statusCode: number }
        expect(apiErr.statusCode).toBe(409)
      }
    })

    test('should throw 404 when deleting non-existent provider', async () => {
      const svc = new ProviderService()

      try {
        await svc.deleteProvider('non-existent-id')
        expect(true).toBe(false)
      } catch (err: unknown) {
        const apiErr = err as { statusCode: number }
        expect(apiErr.statusCode).toBe(404)
      }
    })
  })

  // ─── activateProvider ────────────────────────────────────────────────────

  describe('activateProvider', () => {
    test('should activate a provider with a valid model', async () => {
      const svc = new ProviderService()
      const first = await svc.addProvider(sampleInput({ name: 'First' }))
      const second = await svc.addProvider(
        sampleInput({
          name: 'Second',
          baseUrl: 'https://second-api.example.com',
          apiKey: 'sk-second-key',
        }),
      )

      await svc.activateProvider(second.id)

      // Second should now be active
      const { activeId, providers } = await svc.listProviders()
      expect(activeId).toBe(second.id)
      expect(providers.find((p) => p.id === first.id)).toBeDefined()
      expect(providers.find((p) => p.id === second.id)).toBeDefined()
    })

    test('should write correct settings.json on activation', async () => {
      const svc = new ProviderService()
      await svc.addProvider(sampleInput({ name: 'First' }))
      const second = await svc.addProvider(
        sampleInput({
          name: 'Second',
          baseUrl: 'https://second-api.example.com',
          apiKey: 'sk-second-key',
        }),
      )

      await svc.activateProvider(second.id)

      const settings = await readSettings()
      const env = settings.env as Record<string, string>
      expect(env.ANTHROPIC_BASE_URL).toBe('https://second-api.example.com')
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-second-key')
      expect(env.ANTHROPIC_API_KEY).toBe('')
      expect(env.ANTHROPIC_MODEL).toBe('model-main')
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('model-haiku')
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('model-sonnet')
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('model-opus')
      expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()
    })

    test('should honor provider auth env strategies on activation and runtime env', async () => {
      const svc = new ProviderService()

      const apiKeyProvider = await svc.addProvider(sampleInput({
        apiKey: 'sk-api-key',
        authStrategy: 'api_key',
      }))
      await svc.activateProvider(apiKeyProvider.id)
      let env = (await readSettings()).env as Record<string, string>
      expect(env.ANTHROPIC_API_KEY).toBe('sk-api-key')
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()

      const bearerProvider = await svc.addProvider(sampleInput({
        apiKey: 'sk-bearer',
        authStrategy: 'auth_token_empty_api_key',
      }))
      await svc.activateProvider(bearerProvider.id)
      env = (await readSettings()).env as Record<string, string>
      expect(env.ANTHROPIC_API_KEY).toBe('')
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-bearer')

      const dualProvider = await svc.addProvider(sampleInput({
        apiKey: 'sk-dual',
        authStrategy: 'dual_same_token',
      }))
      const runtimeEnv = await svc.getProviderRuntimeEnv(dualProvider.id)
      expect(runtimeEnv.ANTHROPIC_API_KEY).toBe('sk-dual')
      expect(runtimeEnv.ANTHROPIC_AUTH_TOKEN).toBe('sk-dual')

      const dummyProvider = await svc.addProvider(sampleInput({
        apiKey: '',
        authStrategy: 'dual_dummy',
      }))
      const dummyRuntimeEnv = await svc.getProviderRuntimeEnv(dummyProvider.id)
      expect(dummyRuntimeEnv.ANTHROPIC_API_KEY).toBe('dummy')
      expect(dummyRuntimeEnv.ANTHROPIC_AUTH_TOKEN).toBe('dummy')
    })

    test('proxy providers keep proxy-managed auth regardless of auth strategy', async () => {
      const svc = new ProviderService()
      const provider = await svc.addProvider(sampleInput({
        apiFormat: 'openai_chat',
        authStrategy: 'auth_token',
      }))

      await svc.activateProvider(provider.id)

      const settings = await readSettings()
      const env = settings.env as Record<string, string>
      expect(env.ANTHROPIC_API_KEY).toBe('proxy-managed')
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    })

    test('should include preset default env on activation and runtime env', async () => {
      const svc = new ProviderService()
      const provider = await svc.addProvider(sampleInput({
        presetId: 'shengsuanyun',
        baseUrl: 'https://router.shengsuanyun.com/api',
      }))

      await svc.activateProvider(provider.id)

      const settings = await readSettings()
      const env = settings.env as Record<string, string>
      expect(env.API_TIMEOUT_MS).toBe('3000000')
      expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
      expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()
      expect(JSON.parse(env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS)).toEqual({
        'anthropic/claude-sonnet-4.6': 1000000,
        'anthropic/claude-haiku-4.5:thinking': 200000,
        'anthropic/claude-opus-4.7': 1000000,
      })

      const runtimeEnv = await svc.getProviderRuntimeEnv(provider.id)
      expect(runtimeEnv.API_TIMEOUT_MS).toBe('3000000')
      expect(runtimeEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
      expect(runtimeEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()
      expect(JSON.parse(runtimeEnv.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS)).toEqual({
        'anthropic/claude-sonnet-4.6': 1000000,
        'anthropic/claude-haiku-4.5:thinking': 200000,
        'anthropic/claude-opus-4.7': 1000000,
      })

      await svc.activateOfficial()
      const clearedSettings = await readSettings()
      const clearedEnv = (clearedSettings.env as Record<string, string> | undefined) ?? {}
      expect(clearedEnv.API_TIMEOUT_MS).toBeUndefined()
      expect(clearedEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined()
      expect(clearedEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()
      expect(clearedEnv.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS).toBeUndefined()
    })

    test('auth status treats preset default auth as active provider auth', async () => {
      const svc = new ProviderService()
      const provider = await svc.addProvider(sampleInput({
        presetId: 'lmstudio',
        apiKey: '',
        authStrategy: 'auth_token_empty_api_key',
        models: {
          main: 'lmstudio-model',
          haiku: 'lmstudio-model',
          sonnet: 'lmstudio-model',
          opus: 'lmstudio-model',
        },
      }))
      await svc.activateProvider(provider.id)

      const status = await svc.checkAuthStatus()

      expect(status).toEqual({
        hasAuth: true,
        source: 'cc-haha-provider',
        activeProvider: provider.name,
      })
    })

    test('auth status treats dummy proxy auth as active provider auth', async () => {
      const svc = new ProviderService()
      const provider = await svc.addProvider(sampleInput({
        apiKey: '',
        apiFormat: 'openai_chat',
      }))
      await svc.activateProvider(provider.id)

      const status = await svc.checkAuthStatus()

      expect(status).toEqual({
        hasAuth: true,
        source: 'cc-haha-provider',
        activeProvider: provider.name,
      })
    })

    test('provider auto compact window should override preset default env on activation and runtime env', async () => {
      const svc = new ProviderService()
      const provider = await svc.addProvider(sampleInput({
        presetId: 'custom',
        autoCompactWindow: 32000,
      }))

      await svc.activateProvider(provider.id)

      const settings = await readSettings()
      const env = settings.env as Record<string, string>
      expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('32000')

      const runtimeEnv = await svc.getProviderRuntimeEnv(provider.id)
      expect(runtimeEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('32000')
    })

    test('should preserve existing settings.json fields on activation', async () => {
      // Pre-seed settings with an extra field
      await fs.mkdir(path.join(tmpDir, 'cc-haha'), { recursive: true })
      await fs.writeFile(
        path.join(tmpDir, 'cc-haha', 'settings.json'),
        JSON.stringify({ theme: 'dark', env: { CUSTOM_VAR: 'keep-me' } }),
      )

      const svc = new ProviderService()
      const provider = await svc.addProvider(sampleInput())

      // Re-activate to verify merge behavior
      await svc.activateProvider(provider.id)

      const settings = await readSettings()
      expect(settings.theme).toBe('dark')
      const env = settings.env as Record<string, string>
      expect(env.CUSTOM_VAR).toBe('keep-me')
      expect(env.ANTHROPIC_BASE_URL).toBe('https://api.example.com')
    })

    test('should recover malformed managed settings before activation sync', async () => {
      await fs.mkdir(path.join(tmpDir, 'cc-haha'), { recursive: true })
      await fs.writeFile(path.join(tmpDir, 'cc-haha', 'settings.json'), '{not json', 'utf-8')

      const svc = new ProviderService()
      const provider = await svc.addProvider(sampleInput())

      await svc.activateProvider(provider.id)

      const settings = await readSettings()
      const env = settings.env as Record<string, string>
      const files = await fs.readdir(path.join(tmpDir, 'cc-haha'))

      expect(env.ANTHROPIC_BASE_URL).toBe('https://api.example.com')
      expect(files.some((name) => name.startsWith('settings.json.invalid-'))).toBe(true)
    })

    test('should throw 404 for non-existent provider id', async () => {
      const svc = new ProviderService()

      try {
        await svc.activateProvider('non-existent-id')
        expect(true).toBe(false)
      } catch (err: unknown) {
        const apiErr = err as { statusCode: number }
        expect(apiErr.statusCode).toBe(404)
      }
    })

    test('activeId should be persisted in providers.json', async () => {
      const svc = new ProviderService()
      const provider = await svc.addProvider(sampleInput())

      await svc.activateProvider(provider.id)

      const config = await readProvidersConfig()
      expect(config.activeId).toBe(provider.id)
    })
  })

  // ─── getProviderForProxy ─────────────────────────────────────────────────

  describe('getProviderForProxy', () => {
    test('should return null when no provider is active', async () => {
      const svc = new ProviderService()
      const active = await svc.getProviderForProxy()
      expect(active).toBeNull()
    })

    test('should return the active provider proxy config', async () => {
      const svc = new ProviderService()
      const provider = await svc.addProvider(sampleInput())
      await svc.activateProvider(provider.id)

      const active = await svc.getProviderForProxy()
      expect(active).not.toBeNull()
      expect(active!.baseUrl).toBe(provider.baseUrl)
      expect(active!.apiKey).toBe(provider.apiKey)
      expect(active!.apiFormat).toBe('anthropic')
    })
  })

  describe('testProvider', () => {
    test('should use preset default auth for saved no-key Anthropic-compatible providers', async () => {
      const originalFetch = globalThis.fetch
      const calls: Array<{ headers: Record<string, string> }> = []
      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push({ headers: init?.headers as Record<string, string> })
        return new Response(JSON.stringify({
          type: 'message',
          model: 'lmstudio-model',
          content: [],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as typeof fetch

      try {
        const svc = new ProviderService()
        const provider = await svc.addProvider(sampleInput({
          presetId: 'lmstudio',
          apiKey: '',
          authStrategy: 'auth_token_empty_api_key',
          models: {
            main: 'lmstudio-model',
            haiku: 'lmstudio-model',
            sonnet: 'lmstudio-model',
            opus: 'lmstudio-model',
          },
        }))

        const result = await svc.testProvider(provider.id)

        expect(result.connectivity.success).toBe(true)
        expect(calls[0].headers.Authorization).toBe('Bearer lmstudio')
        expect(calls[0].headers['x-api-key']).toBeUndefined()
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  describe('testProviderConfig', () => {
    test('should use auth strategy headers for Anthropic-compatible tests', async () => {
      const originalFetch = globalThis.fetch
      const calls: Array<{ url: string; headers: Record<string, string> }> = []
      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(url),
          headers: init?.headers as Record<string, string>,
        })
        return new Response(JSON.stringify({
          type: 'message',
          model: 'model-main',
          content: [],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as typeof fetch

      try {
        const svc = new ProviderService()
        await svc.testProviderConfig({
          baseUrl: 'https://api.example.com/anthropic',
          apiKey: 'sk-bearer',
          modelId: 'model-main',
          authStrategy: 'auth_token',
          apiFormat: 'anthropic',
        })
        await svc.testProviderConfig({
          baseUrl: 'https://api.example.com/anthropic',
          apiKey: 'sk-api',
          modelId: 'model-main',
          authStrategy: 'api_key',
          apiFormat: 'anthropic',
        })
        await svc.testProviderConfig({
          baseUrl: 'https://api.example.com/anthropic',
          apiKey: 'sk-dual',
          modelId: 'model-main',
          authStrategy: 'dual_same_token',
          apiFormat: 'anthropic',
        })

        expect(calls[0].headers.Authorization).toBe('Bearer sk-bearer')
        expect(calls[0].headers['x-api-key']).toBeUndefined()
        expect(calls[1].headers['x-api-key']).toBe('sk-api')
        expect(calls[1].headers.Authorization).toBeUndefined()
        expect(calls[2].headers['x-api-key']).toBe('sk-dual')
        expect(calls[2].headers.Authorization).toBe('Bearer sk-dual')
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })
})

// =============================================================================
// Providers REST API
// =============================================================================

describe('Providers API', () => {
  beforeEach(setup)
  afterEach(teardown)

  // ─── GET /api/providers ──────────────────────────────────────────────────

  test('GET /api/providers should return empty list initially', async () => {
    const { req, url, segments } = makeRequest('GET', '/api/providers')
    const res = await handleProvidersApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = (await res.json()) as { providers: unknown[] }
    expect(body.providers).toEqual([])
  })

  test('GET /api/providers should list added providers', async () => {
    // Seed a provider via service
    const svc = new ProviderService()
    await svc.addProvider(sampleInput())

    const { req, url, segments } = makeRequest('GET', '/api/providers')
    const res = await handleProvidersApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = (await res.json()) as { providers: { name: string; apiKey: string }[] }
    expect(body.providers).toHaveLength(1)
    expect(body.providers[0].name).toBe('Test Provider')
    expect(body.providers[0].apiKey).toBe('sk-test-key-123')
  })

  // ─── POST /api/providers ─────────────────────────────────────────────────

  test('POST /api/providers should create a provider', async () => {
    const { req, url, segments } = makeRequest('POST', '/api/providers', {
      presetId: 'custom',
      name: 'New Provider',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      apiFormat: 'anthropic',
      autoCompactWindow: 64000,
      models: {
        main: 'gpt-4',
        haiku: 'gpt-4-haiku',
        sonnet: 'gpt-4-sonnet',
        opus: 'gpt-4-opus',
      },
    })
    const res = await handleProvidersApi(req, url, segments)

    expect(res.status).toBe(201)
    const body = (await res.json()) as { provider: { name: string; models: { main: string }; autoCompactWindow: number } }
    expect(body.provider.name).toBe('New Provider')
    expect(body.provider.models.main).toBe('gpt-4')
    expect(body.provider.autoCompactWindow).toBe(64000)
  })

  test('POST /api/providers should return 400 for invalid input', async () => {
    const { req, url, segments } = makeRequest('POST', '/api/providers', {
      name: '', // invalid: empty name
    })
    const res = await handleProvidersApi(req, url, segments)

    expect(res.status).toBe(400)
  })

  test('POST /api/providers should return 400 for invalid auto compact window', async () => {
    const { req, url, segments } = makeRequest('POST', '/api/providers', {
      presetId: 'custom',
      name: 'New Provider',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      apiFormat: 'anthropic',
      autoCompactWindow: 8000,
      models: {
        main: 'gpt-4',
        haiku: 'gpt-4-haiku',
        sonnet: 'gpt-4-sonnet',
        opus: 'gpt-4-opus',
      },
    })
    const res = await handleProvidersApi(req, url, segments)

    expect(res.status).toBe(400)
  })

  // ─── GET /api/providers/:id ──────────────────────────────────────────────

  test('GET /api/providers/:id should return a provider', async () => {
    const svc = new ProviderService()
    const added = await svc.addProvider(sampleInput())

    const { req, url, segments } = makeRequest('GET', `/api/providers/${added.id}`)
    const res = await handleProvidersApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = (await res.json()) as { provider: { id: string; name: string } }
    expect(body.provider.id).toBe(added.id)
  })

  test('GET /api/providers/:id should return 404 for unknown id', async () => {
    const { req, url, segments } = makeRequest('GET', '/api/providers/unknown-id')
    const res = await handleProvidersApi(req, url, segments)

    expect(res.status).toBe(404)
  })

  // ─── PUT /api/providers/:id ──────────────────────────────────────────────

  test('PUT /api/providers/:id should update a provider', async () => {
    const svc = new ProviderService()
    const added = await svc.addProvider(sampleInput())

    const { req, url, segments } = makeRequest('PUT', `/api/providers/${added.id}`, {
      name: 'Renamed Provider',
    })
    const res = await handleProvidersApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = (await res.json()) as { provider: { name: string } }
    expect(body.provider.name).toBe('Renamed Provider')
  })

  // ─── DELETE /api/providers/:id ───────────────────────────────────────────

  test('DELETE /api/providers/:id should delete an inactive provider', async () => {
    const svc = new ProviderService()
    await svc.addProvider(sampleInput({ name: 'First' }))
    const second = await svc.addProvider(sampleInput({ name: 'Second' }))

    const { req, url, segments } = makeRequest('DELETE', `/api/providers/${second.id}`)
    const res = await handleProvidersApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  test('DELETE /api/providers/:id should return 409 for active provider', async () => {
    const svc = new ProviderService()
    const active = await svc.addProvider(sampleInput())
    await svc.activateProvider(active.id)

    const { req, url, segments } = makeRequest('DELETE', `/api/providers/${active.id}`)
    const res = await handleProvidersApi(req, url, segments)

    expect(res.status).toBe(409)
  })

  // ─── POST /api/providers/:id/activate ────────────────────────────────────

  test('POST /api/providers/:id/activate should activate a provider', async () => {
    const svc = new ProviderService()
    await svc.addProvider(sampleInput({ name: 'First' }))
    const second = await svc.addProvider(
      sampleInput({
        name: 'Second',
        baseUrl: 'https://second.example.com',
        apiKey: 'sk-second',
      }),
    )

    const { req, url, segments } = makeRequest(
      'POST',
      `/api/providers/${second.id}/activate`,
    )
    const res = await handleProvidersApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)

    // Verify settings were synced
    const settings = await readSettings()
    const env = settings.env as Record<string, string>
    expect(env.ANTHROPIC_BASE_URL).toBe('https://second.example.com')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-second')
    expect(env.ANTHROPIC_API_KEY).toBe('')
    expect(env.ANTHROPIC_MODEL).toBe('model-main')
  })

  test('POST /api/providers/:id/activate should not require modelId', async () => {
    const svc = new ProviderService()
    const provider = await svc.addProvider(sampleInput())

    const { req, url, segments } = makeRequest(
      'POST',
      `/api/providers/${provider.id}/activate`,
      {},
    )
    const res = await handleProvidersApi(req, url, segments)

    expect(res.status).toBe(200)
  })

  test('POST /api/providers/:id/activate should ignore modelId because session runtime selects the model', async () => {
    const svc = new ProviderService()
    const provider = await svc.addProvider(sampleInput())

    const { req, url, segments } = makeRequest(
      'POST',
      `/api/providers/${provider.id}/activate`,
      { modelId: 'non-existent-model' },
    )
    const res = await handleProvidersApi(req, url, segments)

    expect(res.status).toBe(200)
  })

  // ─── Method not allowed ──────────────────────────────────────────────────

  test('should return 405 for unsupported methods', async () => {
    const { req, url, segments } = makeRequest('PATCH', '/api/providers')
    const res = await handleProvidersApi(req, url, segments)

    expect(res.status).toBe(405)
  })
})
