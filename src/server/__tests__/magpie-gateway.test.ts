import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import { handleProvidersApi } from '../api/providers.js'
import {
  MAGPIE_CLIENT_KEY,
  MAGPIE_DEFAULT_PORT,
  clearMagpieCatalogCache,
  fetchMagpieModels,
  magpieModelLimits,
  openMagpieApp,
  parseMagpieModels,
  probeMagpie,
  readMagpiePort,
} from '../services/magpieGateway.js'
import { ProviderService } from '../services/providerService.js'
import { buildSessionModelCatalog } from '../services/sessionModelCatalog.js'

// The shape Magpie's GET /v1/models serves (internal/gateway/gateway.go modelObject).
const CATALOG = {
  object: 'list',
  data: [
    {
      id: 'kimi/kimi-k3', type: 'model', owned_by: 'kimi', display_name: 'Kimi K3', magpie_label: 'Kimi K3 · Kimi Coding',
      context_window: 262_144, max_output_tokens: 32_768,
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], reasoning_levels: ['low', 'high'],
      modalities: { input: ['text'], output: ['text'] },
    },
    {
      id: 'claude/claude-opus-5-5', owned_by: 'claude', display_name: 'Claude Opus 5.5',
      context_window: 1_000_000, max_output_tokens: 128_000, modalities: { input: ['text', 'image'], output: ['text'] },
    },
    { id: 'ollama/qwen3.6:27b', owned_by: 'ollama', display_name: 'Qwen3.6 27B' },
    { id: 'group/daily-coding', owned_by: 'group', display_name: '日常编码', context_window: 200_000 },
    { id: 'veo/veo-4', kind: 'video', owned_by: 'veo', modalities: { input: ['text', 'image'], output: ['video'] } },
    { id: 'tiny/model', context_window: 4_096, max_output_tokens: 512 },
  ],
}

let tmpDir: string
const saved: Record<string, string | undefined> = {}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-gateway-test-'))
  for (const key of ['CLAUDE_CONFIG_DIR', 'HOME', 'XDG_CONFIG_HOME']) saved[key] = process.env[key]
  process.env.CLAUDE_CONFIG_DIR = path.join(tmpDir, 'claude')
  process.env.HOME = tmpDir
  process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'xdg')
  clearMagpieCatalogCache()
})

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  clearMagpieCatalogCache()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function writeMagpieSettings(settings: Record<string, unknown>) {
  const dir = path.join(tmpDir, 'xdg', 'magpie')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify(settings))
}

describe('Magpie catalog', () => {
  test('keeps chat models with their limits and leaves generators out', () => {
    const models = parseMagpieModels(CATALOG)

    expect(models.map((model) => model.id)).toEqual([
      'kimi/kimi-k3', 'claude/claude-opus-5-5', 'ollama/qwen3.6:27b', 'group/daily-coding', 'tiny/model',
    ])
    expect(models[0]).toMatchObject({
      runtimeId: 'kimi/kimi-k3', displayName: 'Kimi K3', provider: 'kimi', providerName: 'Kimi Coding',
      contextWindow: 262_144, maxOutputTokens: 32_768, reasoningEfforts: ['low', 'high'], images: false,
    })
    // A 1M Claude model runs as [1m] so the 1M beta goes out, as Magpie does for Claude Code.
    expect(models[1]!.runtimeId).toBe('claude/claude-opus-5-5[1m]')
    expect(models[2]).toMatchObject({ runtimeId: 'ollama/qwen3.6:27b', reasoningEfforts: [] })
    expect(models[2]!.contextWindow).toBeUndefined()
    expect(models[3]!.isGroup).toBe(true)
  })

  test('turns the catalog into the per-model maps, dropping values the runtime would reject', () => {
    expect(magpieModelLimits(parseMagpieModels(CATALOG))).toEqual({
      modelContextWindows: {
        'kimi/kimi-k3': 262_144,
        'claude/claude-opus-5-5': 1_000_000,
        'group/daily-coding': 200_000,
      },
      modelMaxOutputTokens: {
        'kimi/kimi-k3': 32_768,
        'claude/claude-opus-5-5': 128_000,
      },
    })
  })
})

describe('Finding Magpie', () => {
  test('reads the port from its settings and falls back to the default', async () => {
    expect(readMagpiePort()).toBe(MAGPIE_DEFAULT_PORT)
    await writeMagpieSettings({ port: 4100, other: true })
    expect(readMagpiePort()).toBe(4100)
    await writeMagpieSettings({ port: 80 })
    expect(readMagpiePort()).toBe(MAGPIE_DEFAULT_PORT)
  })

  test('counts as running only when the gateway says it is Magpie', async () => {
    await writeMagpieSettings({ port: 4100 })
    const hello = (name: string) => async () => Response.json({ name, version: '1.2.3' })

    expect(await probeMagpie({ fetchImpl: hello('magpie') })).toEqual({
      installed: true, running: true, baseUrl: 'http://127.0.0.1:4100', version: '1.2.3',
    })
    expect(await probeMagpie({ fetchImpl: hello('something-else') })).toMatchObject({ running: false })
    expect(await probeMagpie({ fetchImpl: async () => { throw new Error('ECONNREFUSED') } })).toEqual({
      installed: true, running: false, baseUrl: 'http://127.0.0.1:4100',
    })
  })

  test('asks for the catalog under cc-haha\'s own key and reuses it briefly', async () => {
    const seen: Array<string | null> = []
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('authorization'))
      return Response.json(CATALOG)
    }

    await fetchMagpieModels('http://127.0.0.1:4100', { fetchImpl, now: 1_000 })
    await fetchMagpieModels('http://127.0.0.1:4100', { fetchImpl, now: 2_000 })
    expect(seen).toEqual([`Bearer ${MAGPIE_CLIENT_KEY}`])
    // `magpie-cc-haha`, never the bare `magpie` Claude Code is given.
    expect(MAGPIE_CLIENT_KEY).toBe('magpie-cc-haha')

    await fetchMagpieModels('http://127.0.0.1:4100', { fetchImpl, now: 2_000, force: true })
    expect(seen).toHaveLength(2)
  })

  test('opens the app only where there is one launcher for it', async () => {
    const commands: string[][] = []
    const spawn = async (command: string[]) => {
      commands.push(command)
      return 0
    }

    expect(await openMagpieApp({ platform: 'linux', spawn })).toEqual({ ok: false, unsupported: true })
    expect(await openMagpieApp({ platform: 'darwin', spawn })).toEqual({ ok: true })
    expect(commands).toEqual([['open', '-a', 'magpie']])
  })
})

describe('Saved Magpie providers follow the running gateway', () => {
  test('a moved port and the catalog limits reach the provider, its settings and its runtime env', async () => {
    const gateway = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const { pathname } = new URL(request.url)
        if (pathname === '/api/hello') return Response.json({ name: 'magpie', version: '9.9.9' })
        if (pathname === '/v1/models') return Response.json(CATALOG)
        return new Response('not found', { status: 404 })
      },
    })
    try {
      await writeMagpieSettings({ port: gateway.port })
      const service = new ProviderService()
      const provider = await service.addProvider({
        presetId: 'magpie',
        name: 'Magpie',
        apiKey: '',
        baseUrl: 'http://127.0.0.1:3425',
        apiFormat: 'anthropic',
        models: { main: 'kimi/kimi-k3', haiku: 'kimi/kimi-k3', sonnet: 'kimi/kimi-k3', opus: 'kimi/kimi-k3' },
      })
      await service.activateProvider(provider.id)

      const response = await handleProvidersApi(
        new Request('http://localhost/api/providers/magpie'),
        new URL('http://localhost/api/providers/magpie'),
        ['api', 'providers', 'magpie'],
      )
      const state = await response.json() as { status: { running: boolean; baseUrl: string }; models: Array<{ id: string }> }
      expect(state.status).toMatchObject({ running: true, baseUrl: `http://127.0.0.1:${gateway.port}` })
      expect(state.models.map((model) => model.id)).toContain('ollama/qwen3.6:27b')

      const updated = await service.getProvider(provider.id)
      expect(updated.baseUrl).toBe(`http://127.0.0.1:${gateway.port}`)
      expect(updated.modelContextWindows).toEqual({
        'kimi/kimi-k3': 262_144, 'claude/claude-opus-5-5': 1_000_000, 'group/daily-coding': 200_000,
      })
      expect(updated.modelMaxOutputTokens).toEqual({ 'kimi/kimi-k3': 32_768, 'claude/claude-opus-5-5': 128_000 })

      const env = await service.getProviderRuntimeEnv(provider.id)
      expect(env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${gateway.port}`)
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe(MAGPIE_CLIENT_KEY)
      expect(JSON.parse(env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS!)).toMatchObject({ 'claude/claude-opus-5-5': 1_000_000 })
      expect(JSON.parse(env.CLAUDE_CODE_MODEL_MAX_OUTPUT_TOKENS!)).toMatchObject({ 'kimi/kimi-k3': 32_768 })

      // The default provider's copy in settings.json is rewritten too.
      const settings = JSON.parse(await fs.readFile(path.join(tmpDir, 'claude', 'cc-haha', 'settings.json'), 'utf8')) as { env: Record<string, string> }
      expect(settings.env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${gateway.port}`)
      expect(JSON.parse(settings.env.CLAUDE_CODE_MODEL_MAX_OUTPUT_TOKENS!)).toMatchObject({ 'claude/claude-opus-5-5': 128_000 })
    } finally {
      gateway.stop(true)
    }
  })

  test('nothing is rewritten while Magpie is not running', async () => {
    await writeMagpieSettings({ port: 1 + 40_000 + Math.floor(Math.random() * 20_000) })
    const service = new ProviderService()
    const provider = await service.addProvider({
      presetId: 'magpie',
      name: 'Magpie',
      apiKey: '',
      baseUrl: 'http://127.0.0.1:3425',
      apiFormat: 'anthropic',
      models: { main: 'kimi/kimi-k3', haiku: 'kimi/kimi-k3', sonnet: 'kimi/kimi-k3', opus: 'kimi/kimi-k3' },
      modelContextWindows: { 'kimi/kimi-k3': 262_144 },
    })

    const state = await service.getMagpieState()

    expect(state).toMatchObject({ status: { running: false }, models: null })
    expect(await service.getProvider(provider.id)).toEqual(provider)
  })
})

describe('Session model catalog', () => {
  test('offers every Magpie model on the Magpie provider and nowhere else', () => {
    const models = parseMagpieModels(CATALOG)
    const magpie = {
      id: 'magpie-1', presetId: 'magpie', name: 'Magpie', apiKey: '', baseUrl: 'http://127.0.0.1:3425',
      apiFormat: 'anthropic' as const, runtimeKind: 'anthropic_compatible' as const,
      models: { main: 'kimi/kimi-k3', haiku: 'kimi/kimi-k3', sonnet: 'kimi/kimi-k3', opus: 'kimi/kimi-k3' },
    }
    const other = { ...magpie, id: 'other-1', presetId: 'custom', name: 'Other', models: { main: 'm', haiku: 'm', sonnet: 'm', opus: 'm' } }

    const catalog = buildSessionModelCatalog([magpie, other], { claude: false, openai: false, grok: false, deepseek: false }, 'magpie-1', models)

    const magpieIds = catalog.filter((item) => item.providerId === 'magpie-1').map((item) => item.modelId)
    expect(magpieIds).toEqual([
      'kimi/kimi-k3', 'claude/claude-opus-5-5[1m]', 'ollama/qwen3.6:27b', 'group/daily-coding', 'tiny/model',
    ])
    expect(catalog.find((item) => item.modelId === 'ollama/qwen3.6:27b')?.modelName).toBe('Qwen3.6 27B')
    expect(catalog.filter((item) => item.providerId === 'other-1').map((item) => item.modelId)).toEqual(['m'])
  })
})
