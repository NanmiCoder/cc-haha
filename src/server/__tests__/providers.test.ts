/**
 * Unit tests for ProviderService and Providers REST API
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { ProviderService } from '../services/providerService.js'
import { handleProvidersApi } from '../api/providers.js'
import { handleProxyRequest } from '../proxy/handler.js'
import { clearTraceCaptureStateForTests, traceCaptureService } from '../services/traceCaptureService.js'
import type { CreateProviderInput } from '../types/provider.js'

// ─── Test helpers ─────────────────────────────────────────────────────────────

let tmpDir: string
let originalConfigDir: string | undefined

async function setup() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  clearTraceCaptureStateForTests()
}

async function teardown() {
  clearTraceCaptureStateForTests()
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
      expect(result).toEqual({
        providers: [],
        activeId: null,
        providerOrder: ['claude-official', 'openai-official'],
      })
    })

    test('should recover from a malformed providers index after an upgrade', async () => {
      await fs.mkdir(path.join(tmpDir, 'cc-haha'), { recursive: true })
      await fs.writeFile(path.join(tmpDir, 'cc-haha', 'providers.json'), '{not json', 'utf-8')

      const svc = new ProviderService()
      const result = await svc.listProviders()
      const files = await fs.readdir(path.join(tmpDir, 'cc-haha'))

      expect(result).toEqual({
        providers: [],
        activeId: null,
        providerOrder: ['claude-official', 'openai-official'],
      })
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

    test('should normalize empty model mappings to the main model when adding a provider', async () => {
      const svc = new ProviderService()
      const provider = await svc.addProvider(sampleInput({
        models: {
          main: 'gpt-5.5',
          haiku: '',
          sonnet: '   ',
          opus: '',
        },
      }))

      expect(provider.models).toEqual({
        main: 'gpt-5.5',
        haiku: 'gpt-5.5',
        sonnet: 'gpt-5.5',
        opus: 'gpt-5.5',
      })

      const config = await readProvidersConfig()
      expect((config.providers as Array<{ models: unknown }>)[0]?.models).toEqual(provider.models)
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

    test('Xiaomi MiMo custom providers declare thinking without effort passthrough', async () => {
      const svc = new ProviderService()
      const provider = await svc.addProvider(sampleInput({
        name: 'Xiaomi MiMo Custom',
        baseUrl: 'https://token-plan-sgp.xiaomimimo.com/anthropic',
        models: {
          main: 'mimo-v2.5-pro[1m]',
          haiku: 'mimo-v2.5-pro[1m]',
          sonnet: 'mimo-v2.5-pro[1m]',
          opus: 'mimo-v2.5-pro[1m]',
        },
      }))

      await svc.activateProvider(provider.id)

      const settings = await readSettings()
      const env = settings.env as Record<string, string>
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES).toBe('thinking')
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES).toBe('thinking')
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES).toBe('thinking')
    })

    test('custom providers can mark main and role models as 1M-capable', async () => {
      const svc = new ProviderService()
      const provider = await svc.addProvider(sampleInput({
        models: {
          main: 'claude-sonnet-4-6',
          haiku: 'claude-haiku-4-5',
          sonnet: 'claude-sonnet-4-6',
          opus: 'claude-opus-4-7',
        },
        model1mSupport: {
          main: true,
          haiku: false,
          sonnet: true,
          opus: true,
        },
      }))

      await svc.activateProvider(provider.id)

      const settings = await readSettings()
      const env = settings.env as Record<string, string>
      expect(env.ANTHROPIC_MODEL).toBe('claude-sonnet-4-6[1m]')
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-4-5')
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('claude-sonnet-4-6[1m]')
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-4-7[1m]')

      const runtimeEnv = await svc.getProviderRuntimeEnv(provider.id)
      expect(runtimeEnv.ANTHROPIC_MODEL).toBe('claude-sonnet-4-6[1m]')
      expect(runtimeEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-4-5')
      expect(runtimeEnv.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('claude-sonnet-4-6[1m]')
      expect(runtimeEnv.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-4-7[1m]')
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

    describe('ChatGPT Official provider metadata', () => {
      test('normalizes the built-in ChatGPT provider as an active provider id', async () => {
        await fs.mkdir(path.join(tmpDir, 'cc-haha'), { recursive: true })
        await fs.writeFile(
          path.join(tmpDir, 'cc-haha', 'providers.json'),
          JSON.stringify({ activeId: 'openai-official', providers: [] }),
          'utf-8',
        )

        const svc = new ProviderService()
        const result = await svc.listProviders()

        expect(result.activeId).toBe('openai-official')
        expect(result.providers).toEqual([])
      })

      test('returns built-in ChatGPT provider metadata without persisting secrets', async () => {
        const svc = new ProviderService()
        const provider = await svc.getProvider('openai-official')

        expect(provider).toMatchObject({
          id: 'openai-official',
          presetId: 'openai-official',
          name: 'ChatGPT Official',
          apiKey: '',
          apiFormat: 'openai_responses',
          runtimeKind: 'openai_oauth',
          models: {
            main: 'gpt-5.3-codex',
            haiku: 'gpt-5.4-mini',
            sonnet: 'gpt-5.4',
            opus: 'gpt-5.3-codex',
          },
        })
      })

      test('activating ChatGPT Official writes OpenAI OAuth runtime env without Anthropic auth or proxy env', async () => {
        const svc = new ProviderService()

        await svc.activateProvider('openai-official')

        const config = await readProvidersConfig()
        const settings = await readSettings()
        expect(config.activeId).toBe('openai-official')
        const env = settings.env as Record<string, string>
        expect(env.CC_HAHA_OPENAI_OAUTH_PROVIDER).toBe('1')
        expect(env.OPENAI_CODEX_OAUTH_FILE).toBe(
          path.join(tmpDir, 'cc-haha', 'openai-oauth.json'),
        )
        expect(env.ANTHROPIC_MODEL).toBe('gpt-5.3-codex')
        expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('gpt-5.4-mini')
        expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-5.4')
        expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('gpt-5.3-codex')
        expect(typeof env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS).toBe('string')
        expect(JSON.parse(env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS)).toEqual({
          'gpt-5.3-codex': 258_400,
          'gpt-5.4': 950_000,
          'gpt-5.5': 258_400,
          'gpt-5.4-mini': 258_400,
        })
        expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
        expect(env.ANTHROPIC_API_KEY).toBeUndefined()
        expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
      })

      test('activating ChatGPT Official clears stale managed provider env', async () => {
        const svc = new ProviderService()
        const provider = await svc.addProvider(sampleInput({
          apiFormat: 'openai_responses',
          baseUrl: 'https://api.example.com/openai',
          models: {
            main: 'provider-main',
            haiku: 'provider-haiku',
            sonnet: 'provider-sonnet',
            opus: 'provider-opus',
          },
        }))
        await svc.activateProvider(provider.id)
        expect(((await readSettings()).env as Record<string, string>).ANTHROPIC_BASE_URL).toContain('/proxy')

        await svc.activateProvider('openai-official')

        const settings = await readSettings()
        const env = settings.env as Record<string, string>
        expect(env.CC_HAHA_OPENAI_OAUTH_PROVIDER).toBe('1')
        expect(env.OPENAI_CODEX_OAUTH_FILE).toBe(
          path.join(tmpDir, 'cc-haha', 'openai-oauth.json'),
        )
        expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
        expect(env.ANTHROPIC_API_KEY).toBeUndefined()
        expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
      })

      test('auth status reports ChatGPT Official from the desktop OpenAI token file', async () => {
        await fs.mkdir(path.join(tmpDir, 'cc-haha'), { recursive: true })
        await fs.writeFile(
          path.join(tmpDir, 'cc-haha', 'openai-oauth.json'),
          JSON.stringify({
            accessToken: 'openai-access',
            refreshToken: 'openai-refresh',
            expiresAt: Date.now() + 60 * 60_000,
            email: 'user@example.com',
            accountId: 'acct_123',
          }),
          'utf-8',
        )

        const svc = new ProviderService()
        await svc.activateProvider('openai-official')

        await expect(svc.checkAuthStatus()).resolves.toMatchObject({
          hasAuth: true,
          source: 'openai-oauth',
          activeProvider: 'ChatGPT Official',
        })
      })

      test('auth status reports ChatGPT Official as unauthenticated when the OpenAI token file is missing', async () => {
        const svc = new ProviderService()
        await svc.activateProvider('openai-official')

        await expect(svc.checkAuthStatus()).resolves.toMatchObject({
          hasAuth: false,
          source: 'none',
          activeProvider: 'ChatGPT Official',
        })
      })

      test('activating another provider clears ChatGPT Official runtime markers', async () => {
        const svc = new ProviderService()
        const provider = await svc.addProvider(sampleInput())

        await svc.activateProvider('openai-official')
        await svc.activateProvider(provider.id)

        const env = (await readSettings()).env as Record<string, string>
        expect(env.CC_HAHA_OPENAI_OAUTH_PROVIDER).toBeUndefined()
        expect(env.OPENAI_CODEX_OAUTH_FILE).toBeUndefined()
        expect(env.ANTHROPIC_BASE_URL).toBe('https://api.example.com')
        expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-test-key-123')
      })
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

    test('should normalize empty model mappings before syncing settings', async () => {
      const svc = new ProviderService()
      const provider = await svc.addProvider(sampleInput({
        models: {
          main: 'gpt-5.5',
          haiku: '',
          sonnet: '',
          opus: '',
        },
      }))

      await svc.activateProvider(provider.id)

      const settings = await readSettings()
      const env = settings.env as Record<string, string>
      expect(env.ANTHROPIC_MODEL).toBe('gpt-5.5')
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('gpt-5.5')
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-5.5')
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('gpt-5.5')
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

  // ─── reorderProviders ────────────────────────────────────────────────────

  describe('reorderProviders', () => {
    test('should reorder providers to match the given id order and persist it', async () => {
      const svc = new ProviderService()
      const a = await svc.addProvider(sampleInput({ name: 'A' }))
      const b = await svc.addProvider(sampleInput({ name: 'B' }))
      const c = await svc.addProvider(sampleInput({ name: 'C' }))

      const result = await svc.reorderProviders([c.id, a.id, b.id])
      expect(result.providers.map((p) => p.name)).toEqual(['C', 'A', 'B'])

      // Persisted order survives a fresh read
      const { providers } = await svc.listProviders()
      expect(providers.map((p) => p.name)).toEqual(['C', 'A', 'B'])

      const config = await readProvidersConfig()
      expect((config.providers as Array<{ name: string }>).map((p) => p.name)).toEqual(['C', 'A', 'B'])
    })

    test('should persist display order including built-in official providers', async () => {
      const svc = new ProviderService()
      const a = await svc.addProvider(sampleInput({ name: 'A' }))
      const b = await svc.addProvider(sampleInput({ name: 'B' }))

      const result = await svc.reorderProviders(['openai-official', b.id, 'claude-official', a.id])

      expect(result.providerOrder).toEqual(['openai-official', b.id, 'claude-official', a.id])
      expect(result.providers.map((p) => p.id)).toEqual([b.id, a.id])

      const listed = await svc.listProviders()
      expect(listed.providerOrder).toEqual(['openai-official', b.id, 'claude-official', a.id])

      const config = await readProvidersConfig()
      expect(config.providerOrder).toEqual(['openai-official', b.id, 'claude-official', a.id])
    })

    test('should not change activeId when reordering', async () => {
      const svc = new ProviderService()
      const a = await svc.addProvider(sampleInput({ name: 'A' }))
      const b = await svc.addProvider(sampleInput({ name: 'B' }))
      await svc.activateProvider(a.id)

      await svc.reorderProviders([b.id, a.id])

      const { activeId } = await svc.listProviders()
      expect(activeId).toBe(a.id)
    })

    test('should throw 400 when orderedIds is missing a provider', async () => {
      const svc = new ProviderService()
      const a = await svc.addProvider(sampleInput({ name: 'A' }))
      await svc.addProvider(sampleInput({ name: 'B' }))

      try {
        await svc.reorderProviders([a.id])
        expect(true).toBe(false)
      } catch (err: unknown) {
        const apiErr = err as { statusCode: number }
        expect(apiErr.statusCode).toBe(400)
      }
    })

    test('should throw 400 when orderedIds contains an unknown id', async () => {
      const svc = new ProviderService()
      const a = await svc.addProvider(sampleInput({ name: 'A' }))
      const b = await svc.addProvider(sampleInput({ name: 'B' }))

      try {
        await svc.reorderProviders([a.id, b.id, 'ghost-id'])
        expect(true).toBe(false)
      } catch (err: unknown) {
        const apiErr = err as { statusCode: number }
        expect(apiErr.statusCode).toBe(400)
      }
    })

    test('should throw 400 when orderedIds contains duplicates', async () => {
      const svc = new ProviderService()
      const a = await svc.addProvider(sampleInput({ name: 'A' }))
      await svc.addProvider(sampleInput({ name: 'B' }))

      try {
        await svc.reorderProviders([a.id, a.id])
        expect(true).toBe(false)
      } catch (err: unknown) {
        const apiErr = err as { statusCode: number }
        expect(apiErr.statusCode).toBe(400)
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
      expect(env.ENABLE_TOOL_SEARCH).toBe('true')
      expect(env.ANTHROPIC_MODEL).toBe('model-main')
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('model-haiku')
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('model-sonnet')
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('model-opus')
      expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0')
      expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()
    })

    test('should persist disabled tool search for native Anthropic providers', async () => {
      const svc = new ProviderService()
      const provider = await svc.addProvider(sampleInput({
        toolSearchEnabled: false,
      }))

      await svc.activateProvider(provider.id)

      const settings = await readSettings()
      const env = settings.env as Record<string, string>
      expect(env.ENABLE_TOOL_SEARCH).toBe('false')

      const runtimeEnv = await svc.getProviderRuntimeEnv(provider.id)
      expect(runtimeEnv.ENABLE_TOOL_SEARCH).toBe('false')
    })

    test('should preserve attribution header for Claude-prefixed provider models', async () => {
      const svc = new ProviderService()
      const provider = await svc.addProvider(sampleInput({
        models: {
          main: 'Claude Sonnet 4.6',
          haiku: 'Claude Haiku 4.5',
          sonnet: 'Claude Sonnet 4.6',
          opus: 'Claude Opus 4.7',
        },
      }))

      await svc.activateProvider(provider.id)

      const settings = await readSettings()
      const env = settings.env as Record<string, string>
      expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('1')

      const runtimeEnv = await svc.getProviderRuntimeEnv(provider.id)
      expect(runtimeEnv.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('1')
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
      expect(env.ENABLE_TOOL_SEARCH).toBeUndefined()
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
      expect(clearedEnv.CLAUDE_CODE_ATTRIBUTION_HEADER).toBeUndefined()
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

    test('should return null for explicit ChatGPT Official proxy lookup', async () => {
      const svc = new ProviderService()

      const active = await svc.getProviderForProxy('openai-official')

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

    test('should return null when ChatGPT Official is the active provider', async () => {
      const svc = new ProviderService()
      await svc.activateProvider('openai-official')

      const active = await svc.getProviderForProxy()

      expect(active).toBeNull()
    })
  })

  describe('handleProxyRequest', () => {
    test('records a session trace for proxied OpenAI Chat calls', async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = mock(async () => {
        return new Response(JSON.stringify({
          id: 'chatcmpl-trace',
          object: 'chat.completion',
          created: 0,
          model: 'gpt-4',
          choices: [{ index: 0, message: { role: 'assistant', content: 'trace ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'x-request-id': 'req-trace' },
        })
      }) as typeof fetch

      try {
        const svc = new ProviderService()
        const provider = await svc.addProvider(sampleInput({ apiFormat: 'openai_chat', name: 'Trace Provider' }))
        await svc.activateProvider(provider.id)

        const req = new Request('http://localhost:3456/proxy/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Claude-Code-Session-Id': 'session-proxy-trace',
          },
          body: JSON.stringify({
            model: 'gpt-4',
            max_tokens: 64,
            messages: [{ role: 'user', content: 'capture this call' }],
          }),
        })

        const res = await handleProxyRequest(req, new URL(req.url))
        const trace = await traceCaptureService.getSessionTrace('session-proxy-trace')

        expect(res.status).toBe(200)
        expect(trace.summary.apiCalls).toBe(1)
        expect(trace.calls[0]).toMatchObject({
          source: 'proxy',
          provider: {
            id: provider.id,
            name: 'Trace Provider',
            format: 'openai_chat',
          },
          model: 'gpt-4',
        })
        expect(trace.calls[0].request.body.preview).toContain('capture this call')
        expect(trace.calls[0].response.body.preview).toContain('chatcmpl-trace')
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    test('strips leading billing attribution instead of injecting it for OpenAI-compatible upstreams', async () => {
      const originalFetch = globalThis.fetch
      const calls: Array<{ body: Record<string, unknown> }> = []
      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> })
        return new Response(JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 0,
          model: 'gpt-4',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as typeof fetch

      try {
        const svc = new ProviderService()
        const provider = await svc.addProvider(sampleInput({ apiFormat: 'openai_chat' }))
        await svc.activateProvider(provider.id)

        const req = new Request('http://localhost:3456/proxy/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4',
            max_tokens: 64,
            system: [
              { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.92.693; cc_entrypoint=cli; cch=00000;' },
              { type: 'text', text: 'You are a helpful assistant.' },
            ],
            messages: [{ role: 'user', content: 'hello from proxy' }],
          }),
        })

        const res = await handleProxyRequest(req, new URL(req.url))
        expect(res.status).toBe(200)

        // The rotating billing header would change the prompt prefix on every
        // request and defeat upstream prefix caching — it must not be forwarded.
        const messages = calls[0].body.messages as Array<Record<string, string>>
        expect(messages[0].role).toBe('system')
        expect(messages[0].content).toBe('You are a helpful assistant.')
        expect(JSON.stringify(calls[0].body)).not.toContain('x-anthropic-billing-header')
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    test('forwards a stable prompt_cache_key from client session metadata for OpenAI Responses upstreams', async () => {
      const originalFetch = globalThis.fetch
      const calls: Array<{ body: Record<string, unknown> }> = []
      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> })
        return new Response(JSON.stringify({
          id: 'resp-1',
          object: 'response',
          created_at: 0,
          model: 'gpt-5.4',
          status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as typeof fetch

      try {
        const svc = new ProviderService()
        const provider = await svc.addProvider(sampleInput({ apiFormat: 'openai_responses' }))
        await svc.activateProvider(provider.id)

        const req = new Request('http://localhost:3456/proxy/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-5.4',
            max_tokens: 64,
            metadata: { user_id: 'user_3f7a_account_9b2c_session_sess-42aa' },
            messages: [{ role: 'user', content: 'hello from proxy' }],
          }),
        })

        const res = await handleProxyRequest(req, new URL(req.url))
        expect(res.status).toBe(200)
        expect(calls[0].body.prompt_cache_key).toBe('sess-42aa')
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    test('omits image_url parts for DeepSeek OpenAI Chat proxy requests', async () => {
      const originalFetch = globalThis.fetch
      const calls: Array<{ body: Record<string, unknown> }> = []
      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> })
        return new Response(JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 0,
          model: 'deepseek-v4-pro',
          choices: [{ index: 0, message: { role: 'assistant', content: 'I cannot view images.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as typeof fetch

      try {
        const svc = new ProviderService()
        const provider = await svc.addProvider(sampleInput({
          apiFormat: 'openai_chat',
          baseUrl: 'https://api.deepseek.com',
          models: {
            main: 'deepseek-v4-pro',
            haiku: 'deepseek-v4-pro',
            sonnet: 'deepseek-v4-pro',
            opus: 'deepseek-v4-pro',
          },
        }))
        await svc.activateProvider(provider.id)

        const req = new Request('http://localhost:3456/proxy/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'deepseek-v4-pro',
            max_tokens: 64,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: 'What is in this screenshot?' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
              ],
            }],
          }),
        })

        const res = await handleProxyRequest(req, new URL(req.url))
        expect(res.status).toBe(200)

        const serialized = JSON.stringify(calls[0].body)
        expect(serialized).not.toContain('image_url')
        expect(serialized).not.toContain('abc123')
        expect(serialized).toContain('What is in this screenshot?')
        expect(serialized).toContain('Image omitted')
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    test('normalizes context-window suffixes before forwarding OpenAI Chat proxy requests', async () => {
      const originalFetch = globalThis.fetch
      const calls: Array<{ body: Record<string, unknown> }> = []
      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> })
        return new Response(JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 0,
          model: 'mimo-v2.5-pro',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as typeof fetch

      try {
        const svc = new ProviderService()
        const provider = await svc.addProvider(sampleInput({ apiFormat: 'openai_chat' }))
        await svc.activateProvider(provider.id)

        const req = new Request('http://localhost:3456/proxy/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'mimo-v2.5-pro[1m]',
            max_tokens: 64,
            messages: [{ role: 'user', content: 'hello from proxy' }],
          }),
        })

        const res = await handleProxyRequest(req, new URL(req.url))
        expect(res.status).toBe(200)
        expect(calls[0].body.model).toBe('mimo-v2.5-pro')
      } finally {
        globalThis.fetch = originalFetch
      }
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

    test('normalizes context-window suffixes for Anthropic-compatible connectivity tests', async () => {
      const originalFetch = globalThis.fetch
      const calls: Array<{ body: Record<string, unknown> }> = []
      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> })
        return new Response(JSON.stringify({
          type: 'message',
          model: 'mimo-v2.5-pro',
          content: [],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as typeof fetch

      try {
        const svc = new ProviderService()
        const result = await svc.testProviderConfig({
          baseUrl: 'https://api.xiaomimimo.com/anthropic',
          apiKey: 'sk-api',
          modelId: 'mimo-v2.5-pro[1m]',
          authStrategy: 'auth_token',
          apiFormat: 'anthropic',
        })

        expect(result.connectivity.success).toBe(true)
        expect(result.connectivity.modelUsed).toBe('mimo-v2.5-pro')
        expect(calls[0].body.model).toBe('mimo-v2.5-pro')
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    test('normalizes context-window suffixes for provider proxy pipeline tests', async () => {
      const originalFetch = globalThis.fetch
      const calls: Array<{ body: Record<string, unknown> }> = []
      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> })
        return new Response(JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 0,
          model: 'mimo-v2.5-pro',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as typeof fetch

      try {
        const svc = new ProviderService()
        const result = await svc.testProviderConfig({
          baseUrl: 'https://api.example.com',
          apiKey: 'sk-api',
          modelId: 'mimo-v2.5-pro[1m]',
          authStrategy: 'api_key',
          apiFormat: 'openai_chat',
        })

        expect(result.connectivity.success).toBe(true)
        expect(result.proxy?.success).toBe(true)
        expect(result.connectivity.modelUsed).toBe('mimo-v2.5-pro')
        expect(result.proxy?.modelUsed).toBe('mimo-v2.5-pro')
        expect(calls.map((call) => call.body.model)).toEqual(['mimo-v2.5-pro', 'mimo-v2.5-pro'])
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    test('requests non-stream OpenAI Chat responses during provider tests', async () => {
      const originalFetch = globalThis.fetch
      const calls: Array<{ body: Record<string, unknown> }> = []
      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> })
        return new Response(JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 0,
          model: 'deepseek-v4-flash',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as typeof fetch

      try {
        const svc = new ProviderService()
        const result = await svc.testProviderConfig({
          baseUrl: 'https://api.example.com',
          apiKey: 'sk-api',
          modelId: 'deepseek-v4-flash',
          authStrategy: 'api_key',
          apiFormat: 'openai_chat',
        })

        expect(result.connectivity.success).toBe(true)
        expect(result.proxy?.success).toBe(true)
        expect(calls.map((call) => call.body.stream)).toEqual([false, false])
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    test('should use configured network timeout for provider tests', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'settings.json'),
        JSON.stringify({
          network: {
            aiRequestTimeoutMs: 180_000,
            proxy: { mode: 'system', url: '' },
          },
        }),
        'utf-8',
      )
      const originalFetch = globalThis.fetch
      const originalTimeout = AbortSignal.timeout
      const timeoutCalls: number[] = []
      globalThis.fetch = mock(async (_url: string | URL | Request, _init?: RequestInit) => {
        return new Response(JSON.stringify({
          type: 'message',
          model: 'model-main',
          content: [],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as typeof fetch
      AbortSignal.timeout = ((ms: number) => {
        timeoutCalls.push(ms)
        return originalTimeout(ms)
      }) as typeof AbortSignal.timeout

      try {
        const svc = new ProviderService()
        await svc.testProviderConfig({
          baseUrl: 'https://api.example.com/anthropic',
          apiKey: 'sk-api',
          modelId: 'model-main',
          authStrategy: 'api_key',
          apiFormat: 'anthropic',
        })

        expect(timeoutCalls).toEqual([180_000])
      } finally {
        AbortSignal.timeout = originalTimeout
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

  // ─── PUT /api/providers/reorder ──────────────────────────────────────────

  test('PUT /api/providers/reorder should reorder providers', async () => {
    const svc = new ProviderService()
    const a = await svc.addProvider(sampleInput({ name: 'A' }))
    const b = await svc.addProvider(sampleInput({ name: 'B' }))

    const { req, url, segments } = makeRequest('PUT', '/api/providers/reorder', {
      orderedIds: [b.id, a.id],
    })
    const res = await handleProvidersApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = (await res.json()) as { providers: { name: string }[]; providerOrder: string[] }
    expect(body.providers.map((p) => p.name)).toEqual(['B', 'A'])
    expect(body.providerOrder).toEqual([b.id, a.id, 'claude-official', 'openai-official'])
  })

  test('PUT /api/providers/reorder should return 400 for a non-permutation', async () => {
    const svc = new ProviderService()
    const a = await svc.addProvider(sampleInput({ name: 'A' }))
    await svc.addProvider(sampleInput({ name: 'B' }))

    const { req, url, segments } = makeRequest('PUT', '/api/providers/reorder', {
      orderedIds: [a.id], // missing B
    })
    const res = await handleProvidersApi(req, url, segments)

    expect(res.status).toBe(400)
  })

  test('PUT /api/providers/reorder should return 400 for empty orderedIds', async () => {
    const { req, url, segments } = makeRequest('PUT', '/api/providers/reorder', {
      orderedIds: [],
    })
    const res = await handleProvidersApi(req, url, segments)

    expect(res.status).toBe(400)
  })

  test('POST /api/providers/reorder should be method-not-allowed', async () => {
    const { req, url, segments } = makeRequest('POST', '/api/providers/reorder', {
      orderedIds: [],
    })
    const res = await handleProvidersApi(req, url, segments)

    expect(res.status).toBe(405)
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
