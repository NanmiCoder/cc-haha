/**
 * Unit tests for ProviderService and Providers REST API
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
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
  const raw = await fs.readFile(path.join(tmpDir, 'yuanclaw', 'settings.json'), 'utf-8')
  return JSON.parse(raw) as Record<string, unknown>
}

/** Read the providers.json written to the temp config dir */
async function readProvidersConfig(): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(tmpDir, 'yuanclaw', 'providers.json'), 'utf-8')
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

      await expect(fs.readFile(path.join(tmpDir, 'yuanclaw', 'settings.json'), 'utf-8')).rejects.toThrow()
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
      expect(env.ANTHROPIC_API_KEY).toBe('sk-new-key')
      expect(env.ANTHROPIC_MODEL).toBe('model-main')
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
      expect(env.ANTHROPIC_API_KEY).toBe('sk-second-key')
      expect(env.ANTHROPIC_MODEL).toBe('model-main')
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('model-haiku')
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('model-sonnet')
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('model-opus')
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

      const runtimeEnv = await svc.getProviderRuntimeEnv(provider.id)
      expect(runtimeEnv.API_TIMEOUT_MS).toBe('3000000')
      expect(runtimeEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')

      await svc.activateOfficial()
      const clearedSettings = await readSettings()
      const clearedEnv = (clearedSettings.env as Record<string, string> | undefined) ?? {}
      expect(clearedEnv.API_TIMEOUT_MS).toBeUndefined()
      expect(clearedEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined()
    })

    test('should preserve existing settings.json fields on activation', async () => {
      // Pre-seed settings with an extra field
      await fs.mkdir(path.join(tmpDir, 'yuanclaw'), { recursive: true })
      await fs.writeFile(
        path.join(tmpDir, 'yuanclaw', 'settings.json'),
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
      models: {
        main: 'gpt-4',
        haiku: 'gpt-4-haiku',
        sonnet: 'gpt-4-sonnet',
        opus: 'gpt-4-opus',
      },
    })
    const res = await handleProvidersApi(req, url, segments)

    expect(res.status).toBe(201)
    const body = (await res.json()) as { provider: { name: string; models: { main: string } } }
    expect(body.provider.name).toBe('New Provider')
    expect(body.provider.models.main).toBe('gpt-4')
  })

  test('POST /api/providers should return 400 for invalid input', async () => {
    const { req, url, segments } = makeRequest('POST', '/api/providers', {
      name: '', // invalid: empty name
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
    expect(env.ANTHROPIC_API_KEY).toBe('sk-second')
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
