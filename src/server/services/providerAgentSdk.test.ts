import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProviderService } from './providerService.js'
import { resetPersistentStorageMigrationsForTests } from './persistentStorageMigrations.js'
import { CreateProviderSchema, UpdateProviderSchema } from '../types/provider.js'
import { handleProvidersApi } from '../api/providers.js'

const fixture = {
  presetId: 'custom', name: 'Official SDK fixture', apiKey: 'fixture-api-key',
  baseUrl: 'https://api.anthropic.com', apiFormat: 'anthropic',
  authStrategy: 'api_key', runtime: 'agent-sdk',
  models: { main: 'fixture-main', haiku: '', sonnet: '', opus: '' },
}

describe('provider Agent SDK configuration', () => {
  let configDir: string
  let originalConfigDir: string | undefined
  let originalHome: string | undefined

  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-agent-sdk-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    originalHome = process.env.HOME
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.HOME = configDir
    resetPersistentStorageMigrationsForTests()
  })

  afterEach(async () => {
    resetPersistentStorageMigrationsForTests()
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    await fs.rm(configDir, { recursive: true, force: true })
  })

  test('saves SDK selection and supports edits and returning to the original runtime', async () => {
    const service = new ProviderService()
    const added = await service.addProvider(CreateProviderSchema.parse(fixture))
    expect((await service.getProvider(added.id)).runtime).toBe('agent-sdk')
    await service.updateProvider(added.id, { name: 'Renamed SDK provider' })
    expect(await service.getProvider(added.id)).toMatchObject({ runtime: 'agent-sdk', apiKey: fixture.apiKey })
    await service.updateProvider(added.id, { runtime: 'claude-code', baseUrl: 'https://third-party.invalid', authStrategy: 'auth_token' })
    expect(await service.getProvider(added.id)).toMatchObject({ runtime: 'claude-code', baseUrl: 'https://third-party.invalid' })
  })

  test('validates the merged provider before saving partial connection edits', async () => {
    const service = new ProviderService()
    const added = await service.addProvider(CreateProviderSchema.parse(fixture))
    for (const update of [
      { baseUrl: 'https://third-party.invalid' },
      { apiFormat: 'openai_chat' as const },
      { authStrategy: 'auth_token' as const },
      { apiKey: '' },
    ]) {
      await expect(service.updateProvider(added.id, update)).rejects.toThrow('Official Agent SDK requires')
      expect(await service.getProvider(added.id)).toEqual(added)
    }
    await expect(service.importProviders([
      CreateProviderSchema.parse(fixture),
      CreateProviderSchema.parse({ ...fixture, baseUrl: 'https://third-party.invalid' }),
    ])).rejects.toThrow('Official Agent SDK requires')
    expect((await service.listProviders()).providers).toHaveLength(1)
  })

  test('preserves runtime through REST serialization and rejects invalid selections', async () => {
    const request = async (method: string, pathname: string, body: unknown) => {
      const url = new URL(pathname, 'http://localhost:3456')
      return handleProvidersApi(new Request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), url, url.pathname.split('/').filter(Boolean))
    }
    const created = await request('POST', '/api/providers', fixture)
    expect(created.status).toBe(201)
    const { provider } = await created.json() as { provider: { id: string; runtime: string } }
    expect(provider.runtime).toBe('agent-sdk')
    const invalid = await request('PUT', `/api/providers/${provider.id}`, { authStrategy: 'auth_token' })
    expect(invalid.status).toBe(400)
    const switched = await request('PUT', `/api/providers/${provider.id}`, { runtime: 'claude-code' })
    expect(switched.status).toBe(200)
    expect((await switched.json() as { provider: { runtime: string } }).provider.runtime).toBe('claude-code')
    expect(CreateProviderSchema.safeParse({ ...fixture, runtime: 'unrecognized' }).success).toBe(false)
    expect(UpdateProviderSchema.safeParse({ runtime: 'unrecognized' }).success).toBe(false)
  })
})
