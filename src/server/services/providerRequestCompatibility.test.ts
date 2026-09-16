import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProviderService } from './providerService.js'
import {
  resetPersistentStorageMigrationsForTests,
} from './persistentStorageMigrations.js'
import { buildProviderManagedEnv, mergeActiveProviderManagedEnv } from './providerRuntimeEnv.js'
import { CreateProviderSchema, TestProviderSchema, UpdateProviderSchema } from '../types/provider.js'
import { isProviderManagedEnvVar, SAFE_ENV_VARS } from '../../utils/managedEnvConstants.js'

const budgetEnvKey = 'CLAUDE_CODE_PROVIDER_MAX_OUTPUT_TOKENS'
const fixture = {
  presetId: 'custom',
  name: 'Fixture compatible provider',
  apiKey: 'fake-test-token',
  baseUrl: 'https://provider.example.test/v1',
  apiFormat: 'openai_chat' as const,
  models: { main: 'fixture-model', haiku: '', sonnet: '', opus: '' },
}
const compatibility = {
  maxOutputTokens: 96_000,
  outputTokenLimit: 128_000,
  outputTokenField: 'max_completion_tokens' as const,
  sampling: 'unsupported' as const,
  reasoning: 'supported' as const,
  parallelTools: 'supported' as const,
  structuredOutput: 'auto' as const,
}

describe('provider request compatibility configuration', () => {
  let configDir: string
  let originalConfigDir: string | undefined

  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-request-compat-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configDir
    resetPersistentStorageMigrationsForTests()
  })

  afterEach(async () => {
    resetPersistentStorageMigrationsForTests()
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await fs.rm(configDir, { recursive: true, force: true })
  })

  test('accepts explicit compatibility and rejects invalid budgets and field selections', () => {
    expect(CreateProviderSchema.parse({ ...fixture, requestCompatibility: compatibility }).requestCompatibility)
      .toEqual(compatibility)
    expect(TestProviderSchema.parse({ ...fixture, modelId: 'fixture-model', requestCompatibility: compatibility }).requestCompatibility)
      .toEqual(compatibility)
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      for (const field of ['maxOutputTokens', 'outputTokenLimit']) {
        expect(CreateProviderSchema.safeParse({ ...fixture, requestCompatibility: { [field]: invalid } }).success).toBe(false)
      }
    }
    expect(UpdateProviderSchema.safeParse({ requestCompatibility: { outputTokenField: 'max_output_tokens' } }).success).toBe(false)
    expect(UpdateProviderSchema.parse({ requestCompatibility: null }).requestCompatibility).toBeNull()
  })

  test('persists configuration through create, edit, proxy selection, and clear', async () => {
    const service = new ProviderService()
    const added = await service.addProvider({ ...fixture, requestCompatibility: compatibility })
    expect((await service.getProvider(added.id)).requestCompatibility).toEqual(compatibility)
    expect((await service.getProviderForProxy(added.id))?.requestCompatibility).toEqual(compatibility)
    const edited = { ...compatibility, maxOutputTokens: 64_000 }
    await service.updateProvider(added.id, { requestCompatibility: edited })
    expect((await service.getProviderForProxy(added.id))?.requestCompatibility).toEqual(edited)
    await service.updateProvider(added.id, { requestCompatibility: null })
    expect((await service.getProvider(added.id)).requestCompatibility).toBeUndefined()
    expect((await service.getProviderForProxy(added.id))?.requestCompatibility).toBeUndefined()
  })

  test('clears managed budget after reset and provider switch without changing explicit global budgets', async () => {
    const service = new ProviderService()
    const configured = await service.addProvider({ ...fixture, requestCompatibility: compatibility })
    const automatic = await service.addProvider({ ...fixture, name: 'Automatic fixture' })
    await service.activateProvider(configured.id)
    let env = mergeActiveProviderManagedEnv({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: '120000' }, configDir)
    expect(env[budgetEnvKey]).toBe('96000')
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('120000')
    expect(isProviderManagedEnvVar(budgetEnvKey)).toBe(true)
    expect(SAFE_ENV_VARS.has(budgetEnvKey)).toBe(true)
    await service.updateProvider(configured.id, { requestCompatibility: null })
    env = mergeActiveProviderManagedEnv(env, configDir)
    expect(env[budgetEnvKey]).toBeUndefined()
    expect((await service.getManagedSettings()).env).not.toHaveProperty(budgetEnvKey)
    await service.updateProvider(configured.id, { requestCompatibility: compatibility })
    env = mergeActiveProviderManagedEnv(env, configDir)
    expect(env[budgetEnvKey]).toBe('96000')
    await service.activateProvider(automatic.id)
    env = mergeActiveProviderManagedEnv(env, configDir)
    expect(env[budgetEnvKey]).toBeUndefined()
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('120000')
  })

  test('keeps a known hard limit separate from the default budget and ignores invalid persisted budgets', () => {
    const provider = { ...fixture, id: 'fixture', requestCompatibility: { outputTokenLimit: 128_000 } }
    expect(buildProviderManagedEnv(provider)[budgetEnvKey]).toBeUndefined()
    expect(buildProviderManagedEnv({ ...provider, requestCompatibility: {} })[budgetEnvKey]).toBeUndefined()
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(buildProviderManagedEnv({
        ...provider,
        requestCompatibility: { maxOutputTokens: invalid },
      })[budgetEnvKey]).toBeUndefined()
    }
  })

  test('uses saved compatibility for connectivity and transformed probes without expanding their explicit budgets', async () => {
    const service = new ProviderService()
    const previousFetch = globalThis.fetch
    const requests: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)))
      return Response.json(String(input).endsWith('/responses')
        ? {
            id: 'response-fixture', object: 'response', status: 'completed', model: 'fixture-model',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }
        : {
            id: 'chat-fixture', object: 'chat.completion', model: 'fixture-model',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          })
    }) as typeof fetch
    try {
      for (const apiFormat of ['openai_chat', 'openai_responses'] as const) {
        requests.length = 0
        const provider = await service.addProvider({
          ...fixture,
          apiFormat,
          requestCompatibility: { ...compatibility, outputTokenLimit: 32 },
        })
        const result = await service.testProvider(provider.id)
        expect(result.connectivity.success).toBe(true)
        expect(result.proxy?.success).toBe(true)
        const field = apiFormat === 'openai_chat' ? 'max_completion_tokens' : 'max_output_tokens'
        expect(requests).toHaveLength(2)
        expect(requests.map(request => request[field])).toEqual([16, 32])
        expect(requests.every(request => request.max_tokens === undefined)).toBe(true)
      }
    } finally {
      globalThis.fetch = previousFetch
    }
  })


})
