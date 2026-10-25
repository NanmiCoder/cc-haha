import '../../../preload.ts'
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderService } from '../../server/services/providerService.js'
import { hahaOAuthService } from '../../server/services/hahaOAuthService.js'
import * as standaloneProxy from '../../server/proxy/standaloneProviderProxy.js'
import { resolveAgentProviderRuntime } from './agentProviderRuntime.js'

let configDir: string
let originalConfigDir: string | undefined
const models = { main: 'agent-main', haiku: 'agent-fast', sonnet: 'agent-standard', opus: 'agent-large' }
const providers = new ProviderService()

async function addProvider(overrides: Record<string, unknown> = {}) {
  return providers.addProvider({
    presetId: 'custom', name: 'Agent provider', apiKey: 'fake-agent-key', authStrategy: 'api_key',
    baseUrl: 'https://agent.example.test', apiFormat: 'anthropic', models,
    ...overrides,
  })
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'agent-provider-runtime-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterEach(async () => {
  standaloneProxy.stopStandaloneProviderProxyForTests()
  mock.restore()
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await rm(configDir, { recursive: true, force: true })
})

describe('agent provider runtime resolution', () => {
  test('loads the full saved runtime without activating it or changing parent credentials', async () => {
    const provider = await addProvider({ model1mSupport: { main: true, haiku: false, sonnet: false, opus: false }, toolSearchEnabled: true })
    const indexPath = join(configDir, 'cc-haha', 'providers.json')
    const beforeIndex = await readFile(indexPath, 'utf8')
    const beforeProcess = { ...process.env }
    const parent = {
      PATH: '/fixture/bin', ANTHROPIC_API_KEY: 'parent-key', ANTHROPIC_AUTH_TOKEN: 'parent-token',
      ANTHROPIC_BASE_URL: 'https://parent.example.test', ANTHROPIC_CUSTOM_HEADERS: 'Authorization: parent-secret',
      CLAUDE_CODE_OAUTH_TOKEN: 'parent-oauth', CLAUDE_CODE_API_KEY_HELPER: 'parent-helper',
      CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '17', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '18',
      CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1',
      CC_HAHA_OPENAI_OAUTH_PROVIDER: '1', OPENAI_CODEX_OAUTH_FILE: '/parent/token.json',
      CC_HAHA_GROK_OAUTH_PROVIDER: '1', GROK_OAUTH_FILE: '/parent/grok.json',
      CC_HAHA_DEEPSEEK_OAUTH_PROVIDER: '1', DEEPSEEK_OAUTH_FILE: '/parent/deepseek.json',
      CLAUDE_CODE_SUBAGENT_MODEL: 'parent-model', CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'parent-session-token',
    }

    const runtime = await resolveAgentProviderRuntime(provider.id, parent)

    expect(runtime.providerId).toBe(provider.id)
    expect(runtime.runtimeKind).toBe('anthropic_compatible')
    expect(runtime.env).toMatchObject({
      PATH: '/fixture/bin', ANTHROPIC_BASE_URL: provider.baseUrl, ANTHROPIC_API_KEY: 'fake-agent-key',
      ANTHROPIC_MODEL: 'agent-main[1m]', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'agent-fast', ENABLE_TOOL_SEARCH: 'true',
    })
    for (const key of Object.keys(parent).filter(key => key !== 'PATH' && !['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'].includes(key))) {
      expect(runtime.env[key]).toBeUndefined()
    }
    expect(await readFile(indexPath, 'utf8')).toBe(beforeIndex)
    expect(process.env).toEqual(beforeProcess)
    expect(parent.ANTHROPIC_API_KEY).toBe('parent-key')
  })

  test('resolves simultaneous different providers without sharing credentials or model mappings', async () => {
    const first = await addProvider()
    const second = await addProvider({ apiKey: 'fake-second-key', baseUrl: 'https://second.example.test', models: { ...models, main: 'second-main' } })
    const [a, b] = await Promise.all([resolveAgentProviderRuntime(first.id, {}), resolveAgentProviderRuntime(second.id, {})])
    expect(a.env.ANTHROPIC_API_KEY).toBe('fake-agent-key')
    expect(a.env.ANTHROPIC_MODEL).toBe('agent-main')
    expect(b.env.ANTHROPIC_API_KEY).toBe('fake-second-key')
    expect(b.env.ANTHROPIC_MODEL).toBe('second-main')
    expect(b.env.ANTHROPIC_BASE_URL).toBe('https://second.example.test')
  })

  test('clears native parent model overrides and identifies the selected provider in traces', async () => {
    const provider = await addProvider()
    const runtime = await resolveAgentProviderRuntime(provider.id, {
      OPENAI_CODEX_MODEL: 'parent-main', OPENAI_CODEX_HAIKU_MODEL: 'parent-fast',
      OPENAI_CODEX_SONNET_MODEL: 'parent-standard', OPENAI_CODEX_OPUS_MODEL: 'parent-large',
      OPENAI_CODEX_REASONING_EFFORT: 'high', CC_HAHA_OPENAI_FAST_MODE: '1',
      CC_HAHA_TRACE_PROVIDER_ID: 'parent-id', CC_HAHA_TRACE_PROVIDER_NAME: 'Parent', CC_HAHA_TRACE_PROVIDER_FORMAT: 'openai_chat',
    })
    expect(runtime.env.OPENAI_CODEX_MODEL).toBeUndefined()
    expect(runtime.env.OPENAI_CODEX_HAIKU_MODEL).toBeUndefined()
    expect(runtime.env.OPENAI_CODEX_SONNET_MODEL).toBeUndefined()
    expect(runtime.env.OPENAI_CODEX_OPUS_MODEL).toBeUndefined()
    expect(runtime.env.OPENAI_CODEX_REASONING_EFFORT).toBeUndefined()
    expect(runtime.env.CC_HAHA_OPENAI_FAST_MODE).toBeUndefined()
    expect(runtime.env.CC_HAHA_TRACE_PROVIDER_ID).toBe(provider.id)
    expect(runtime.env.CC_HAHA_TRACE_PROVIDER_NAME).toBe(provider.name)
    expect(runtime.env.CC_HAHA_TRACE_PROVIDER_FORMAT).toBe(provider.apiFormat)
  })

  test.each([
    ['claude-official', 'claude_oauth', 'CLAUDE_CODE_OAUTH_TOKEN'],
    ['openai-official', 'openai_oauth', 'CC_HAHA_OPENAI_OAUTH_PROVIDER'],
    ['grok-official', 'grok_oauth', 'CC_HAHA_GROK_OAUTH_PROVIDER'],
    ['deepseek-account', 'deepseek_oauth', 'CC_HAHA_DEEPSEEK_OAUTH_PROVIDER'],
  ] as const)('resolves the explicit %s account independently of the parent', async (providerId, runtimeKind, flag) => {
    spyOn(hahaOAuthService, 'ensureFreshAccessToken').mockResolvedValue('fake-selected-claude-token')
    const runtime = await resolveAgentProviderRuntime(providerId, {
      ANTHROPIC_BASE_URL: 'https://parent.example.test', ANTHROPIC_AUTH_TOKEN: 'parent-key',
      CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_OAUTH_TOKEN: 'parent-oauth',
    })
    expect(runtime.runtimeKind).toBe(runtimeKind)
    expect(runtime.env[flag]).toBe(providerId === 'claude-official' ? 'fake-selected-claude-token' : '1')
    expect(runtime.env.ANTHROPIC_MODEL).toBeTruthy()
    expect(runtime.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(runtime.env.CLAUDE_CODE_USE_VERTEX).toBeUndefined()
    if (providerId !== 'deepseek-account') expect(runtime.env.ANTHROPIC_BASE_URL).toBeUndefined()
    if (providerId !== 'claude-official') expect(runtime.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  test('reports a signed-out explicit Claude account instead of borrowing the parent token', async () => {
    spyOn(hahaOAuthService, 'ensureFreshAccessToken').mockResolvedValue(null)
    await expect(resolveAgentProviderRuntime('claude-official', { CLAUDE_CODE_OAUTH_TOKEN: 'parent-oauth' })).rejects.toThrow('sign in')
  })

  test('keeps Claude refresh authority tied to the selected account after resolution', async () => {
    spyOn(hahaOAuthService, 'ensureFreshAccessToken')
      .mockResolvedValueOnce('fake-initial-token')
      .mockResolvedValueOnce('fake-refreshed-token')
      .mockResolvedValue(null)
    const runtime = await resolveAgentProviderRuntime('claude-official', {})
    expect(runtime.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('fake-initial-token')
    expect(await runtime.getClaudeOAuthAccessToken!()).toBe('fake-refreshed-token')
    expect(await runtime.getClaudeOAuthAccessToken!()).toBeNull()
  })

  test('reports a removed provider instead of falling back to the active provider', async () => {
    await expect(resolveAgentProviderRuntime('removed-provider', { ANTHROPIC_API_KEY: 'parent-key' })).rejects.toThrow('Provider not found')
  })

  test('uses the actual desktop host port and retains its local proxy authentication', async () => {
    const provider = await addProvider({ apiFormat: 'openai_chat' })
    const startProxy = spyOn(standaloneProxy, 'ensureStandaloneProviderProxy')
    const runtime = await resolveAgentProviderRuntime(provider.id, {
      CC_HAHA_DESKTOP_SERVER_URL: 'http://127.0.0.1:47219',
      CC_HAHA_LOCAL_ACCESS_TOKEN: 'fake-host-access-token',
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
    })
    expect(runtime.env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:47219/proxy/providers/${provider.id}`)
    expect(runtime.env.ANTHROPIC_API_KEY).toBe('proxy-managed')
    expect(runtime.env.CC_HAHA_LOCAL_ACCESS_TOKEN).toBe('fake-host-access-token')
    expect(runtime.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe('1')
    expect(startProxy).not.toHaveBeenCalled()
  })

  test('uses a hosted SDK proxy origin when the desktop bridge URL is unavailable', async () => {
    const provider = await addProvider({ apiFormat: 'openai_responses' })
    const runtime = await resolveAgentProviderRuntime(provider.id, {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:46823/proxy/providers/parent-provider',
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      CC_HAHA_LOCAL_ACCESS_TOKEN: 'fake-host-access-token',
    })
    expect(runtime.env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:46823/proxy/providers/${provider.id}`)
  })

  test('starts a usable local proxy for standalone CLI providers instead of assuming port 3456', async () => {
    const provider = await addProvider({ apiFormat: 'openai_chat' })
    const runtime = await resolveAgentProviderRuntime(provider.id, {})
    const endpoint = new URL(runtime.env.ANTHROPIC_BASE_URL!)
    expect(endpoint.hostname).toBe('127.0.0.1')
    expect(endpoint.port).not.toBe('3456')
    expect(endpoint.pathname).toBe(`/proxy/providers/${provider.id}`)
    expect((await fetch(new URL('/health', endpoint))).status).toBe(200)
  })

  test('does not start a local proxy for a direct Anthropic provider', async () => {
    const provider = await addProvider()
    const startProxy = spyOn(standaloneProxy, 'ensureStandaloneProviderProxy')
    const runtime = await resolveAgentProviderRuntime(provider.id, {})
    expect(runtime.env.ANTHROPIC_BASE_URL).toBe(provider.baseUrl)
    expect(startProxy).not.toHaveBeenCalled()
  })

  test('standalone requests reach the selected saved provider while the global default stays unchanged', async () => {
    let authorization: string | null = null
    let upstreamModel: string | undefined
    const upstream = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      async fetch(request) {
        authorization = request.headers.get('authorization')
        upstreamModel = (await request.json() as { model: string }).model
        return Response.json({
          id: 'fixture-completion', object: 'chat.completion', created: 0, model: upstreamModel,
          choices: [{ index: 0, message: { role: 'assistant', content: 'agent-only-reply' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      },
    })
    try {
      const provider = await addProvider({ baseUrl: `http://127.0.0.1:${upstream.port}`, apiFormat: 'openai_chat' })
      const runtime = await resolveAgentProviderRuntime(provider.id, {})
      const response = await fetch(`${runtime.env.ANTHROPIC_BASE_URL}/v1/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'agent-main', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }),
      })
      expect(response.status).toBe(200)
      expect((await response.json()).content).toEqual([{ type: 'text', text: 'agent-only-reply' }])
      expect(authorization).toBe('Bearer fake-agent-key')
      expect(upstreamModel).toBe('agent-main')
      expect((await providers.listProviders()).activeId).toBeNull()
    } finally {
      upstream.stop(true)
    }
  })

  test('rejects an invalid desktop proxy destination without exposing parent credentials', async () => {
    const provider = await addProvider({ apiFormat: 'openai_chat' })
    await expect(resolveAgentProviderRuntime(provider.id, {
      CC_HAHA_DESKTOP_SERVER_URL: 'https://remote.example.test', CC_HAHA_LOCAL_ACCESS_TOKEN: 'parent-secret',
    })).rejects.toThrow('loopback')
  })
})
