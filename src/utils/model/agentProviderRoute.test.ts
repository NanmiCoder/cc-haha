import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentProviderUnavailableError, resolveAgentProviderRoute } from './agentProviderRoute.js'
import { get3PModelCapabilityOverride } from './modelSupportOverrides.js'
import { getConfiguredModelContextWindow } from './modelContextWindows.js'
import {
  getProviderRouteForModel,
  readProviderEnv,
  withAgentProviderRoute,
  withRequestProviderRoute,
  type ProviderRoute,
} from './providerEnvScope.js'
import { isFirstPartyAnthropicBaseUrl } from './providers.js'
import { getRuntimeMainLoopModel } from './model.js'
import { getConfiguredProviderOutputBudget, getOutputBudgetHeaders } from '../../services/api/outputBudget.js'
import { isOpenAIResponsesModel } from '../../services/openaiAuth/models.js'

const ENV_KEYS = [
  'CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
  'CLAUDE_CODE_PROVIDER_MAX_OUTPUT_TOKENS', 'CC_HAHA_OPENAI_OAUTH_PROVIDER',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'CLAUDE_CODE_MODEL_CONTEXT_WINDOWS', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CC_HAHA_DESKTOP_SERVER_URL',
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'CC_HAHA_SYSTEM_PROXY_URL', 'CC_HAHA_SYSTEM_PROXY_ERROR',
] as const
let savedEnv: Array<string | undefined>
let configDir: string

function writeProviders(providers: unknown[]) {
  mkdirSync(join(configDir, 'cc-haha'), { recursive: true })
  writeFileSync(join(configDir, 'cc-haha', 'providers.json'), JSON.stringify({
    schemaVersion: 4, activeId: null, providers,
  }))
}

const deepSeekDirect = {
  id: 'deepseek-direct', presetId: 'deepseek', name: 'DeepSeek', apiKey: 'fake-deepseek-key',
  baseUrl: 'https://api.deepseek.example/anthropic', apiFormat: 'anthropic',
  models: { main: 'deepseek-v4-pro', haiku: 'deepseek-v4-flash', sonnet: 'deepseek-v4-pro', opus: 'deepseek-v4-pro' },
}
const openAiCompatible = {
  id: 'chat-gateway', presetId: 'custom', name: 'Chat Gateway', apiKey: 'fake-gateway-key',
  baseUrl: 'https://gateway.example/v1', apiFormat: 'openai_chat',
  models: { main: 'gpt-gateway', haiku: 'gpt-gateway-mini', sonnet: 'gpt-gateway', opus: 'gpt-gateway' },
}

beforeEach(() => {
  savedEnv = ENV_KEYS.map(key => process.env[key])
  for (const key of ENV_KEYS) delete process.env[key]
  configDir = mkdtempSync(join(tmpdir(), 'agent-provider-route-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  // The session runs a different provider with a model the route shares.
  Object.assign(process.env, {
    ANTHROPIC_BASE_URL: 'https://session.example/anthropic',
    ANTHROPIC_API_KEY: 'fake-session-key',
    ANTHROPIC_MODEL: 'session-main',
  })
})

afterEach(() => {
  ENV_KEYS.forEach((key, index) => {
    const value = savedEnv[index]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  })
  get3PModelCapabilityOverride.cache.clear?.()
  rmSync(configDir, { recursive: true, force: true })
})

async function collect<T>(generator: AsyncGenerator<T, void>): Promise<T[]> {
  const values: T[] = []
  for await (const value of generator) values.push(value)
  return values
}

describe('resolveAgentProviderRoute', () => {
  test('sends an Anthropic-format provider directly with its own key and model slots', async () => {
    writeProviders([deepSeekDirect])

    const route = await resolveAgentProviderRoute({ agentType: 'reviewer', providerId: 'deepseek-direct', model: 'haiku' })

    expect(route.model).toBe('deepseek-v4-flash')
    expect(route.env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.example/anthropic')
    expect(route.env.ANTHROPIC_MODEL).toBe('deepseek-v4-flash')
    expect([route.env.ANTHROPIC_API_KEY, route.env.ANTHROPIC_AUTH_TOKEN]).toContain('fake-deepseek-key')
    expect(route.env.CC_HAHA_TRACE_PROVIDER_ID).toBe('deepseek-direct')
    expect((await resolveAgentProviderRoute({ agentType: 'reviewer', providerId: 'deepseek-direct' })).model).toBe('deepseek-v4-pro')
    expect((await resolveAgentProviderRoute({ agentType: 'reviewer', providerId: 'deepseek-direct', model: 'exact-model' })).model).toBe('exact-model')
  })

  test('connects a direct provider through its own network proxy, not the session\'s', async () => {
    // The session's process proxy came from the session provider's override.
    process.env.HTTPS_PROXY = 'http://session-proxy.example:1'
    writeProviders([
      { ...deepSeekDirect, id: 'manual-proxy', proxy: { mode: 'manual', url: 'http://agent-proxy.example:8080' } },
      { ...deepSeekDirect, id: 'direct-only', proxy: { mode: 'direct' } },
      openAiCompatible,
    ])

    const manual = await resolveAgentProviderRoute({ agentType: 'reviewer', providerId: 'manual-proxy' })
    const direct = await resolveAgentProviderRoute({ agentType: 'reviewer', providerId: 'direct-only' })
    const proxied = await resolveAgentProviderRoute({ agentType: 'reviewer', providerId: 'chat-gateway' })

    expect(manual.proxyUrl).toBe('http://agent-proxy.example:8080')
    expect(direct.proxyUrl).toBeNull()
    // The local provider proxy applies the provider's own network settings.
    expect(proxied.proxyUrl).toBeUndefined()
  })

  test('marks attribution by the Agent\'s own model, not the provider\'s main slot', async () => {
    writeProviders([{
      ...deepSeekDirect, id: 'mixed', models: { main: 'claude-sonnet-5', haiku: 'deepseek-v4-flash', sonnet: 'claude-sonnet-5', opus: 'claude-sonnet-5' },
    }])

    const mainRoute = await resolveAgentProviderRoute({ agentType: 'reviewer', providerId: 'mixed' })
    const haikuRoute = await resolveAgentProviderRoute({ agentType: 'reviewer', providerId: 'mixed', model: 'haiku' })

    expect(mainRoute.env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('1')
    expect(haikuRoute.env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0')
  })

  test('reaches a format-translating provider through the desktop proxy for that provider', async () => {
    writeProviders([openAiCompatible])
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    process.env.CC_HAHA_DESKTOP_SERVER_URL = 'http://127.0.0.1:41234'

    const route = await resolveAgentProviderRoute({ agentType: 'reviewer', providerId: 'chat-gateway', model: 'gpt-gateway-mini' })

    expect(route.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:41234/proxy/providers/chat-gateway')
    expect(route.env.ANTHROPIC_API_KEY).toBe('proxy-managed')
    expect(JSON.stringify(route.env)).not.toContain('fake-gateway-key')
  })

  test('reports a deleted provider or an account sign-in instead of falling back to the session', async () => {
    writeProviders([{ ...deepSeekDirect, id: 'openai-account', runtimeKind: 'openai_oauth' }])

    await expect(resolveAgentProviderRoute({ agentType: 'reviewer', providerId: 'missing' }))
      .rejects.toThrow(AgentProviderUnavailableError)
    await expect(resolveAgentProviderRoute({ agentType: 'reviewer', providerId: 'openai-account' }))
      .rejects.toThrow('Agent "reviewer" is configured to use provider "openai-account"')
  })
})

describe('provider route scope', () => {
  const route: ProviderRoute = {
    providerId: 'deepseek-direct',
    providerName: 'DeepSeek',
    model: 'deepseek-v4-pro',
    env: {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.example/anthropic',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
      ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES: 'effort,max_effort',
      CLAUDE_CODE_MODEL_CONTEXT_WINDOWS: JSON.stringify({ 'deepseek-v4-pro': 1_000_000 }),
    },
  }

  test('serves only the Agent model; side requests in the same Agent keep the session provider', async () => {
    async function* agentRun() {
      yield getProviderRouteForModel('deepseek-v4-pro[1m]')?.providerId
      yield getProviderRouteForModel('session-haiku')?.providerId
      yield* withRequestProviderRoute('deepseek-v4-pro', (async function* () {
        await Promise.resolve()
        yield readProviderEnv('ANTHROPIC_BASE_URL')
        yield String(isFirstPartyAnthropicBaseUrl())
      })())
      yield* withRequestProviderRoute('session-haiku', (async function* () {
        await Promise.resolve()
        yield readProviderEnv('ANTHROPIC_BASE_URL')
      })())
    }

    expect(await collect(withAgentProviderRoute(route, agentRun()))).toEqual([
      'deepseek-direct',
      undefined,
      'https://api.deepseek.example/anthropic',
      'false',
      'https://session.example/anthropic',
    ])
    expect(getProviderRouteForModel('deepseek-v4-pro')).toBeUndefined()
    expect(readProviderEnv('ANTHROPIC_BASE_URL')).toBe('https://session.example/anthropic')
  })

  test('reads the routed provider capabilities without changing the session answer for the same model', async () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'deepseek-v4-pro'
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = 'thinking'
    process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS = JSON.stringify({ 'deepseek-v4-pro': 128_000 })

    const routed = await collect(withAgentProviderRoute(route, (async function* () {
      yield [
        get3PModelCapabilityOverride('deepseek-v4-pro', 'effort'),
        getConfiguredModelContextWindow('deepseek-v4-pro'),
      ]
    })()))

    expect(routed).toEqual([[true, 1_000_000]])
    expect(get3PModelCapabilityOverride('deepseek-v4-pro', 'effort')).toBe(false)
    expect(getConfiguredModelContextWindow('deepseek-v4-pro')).toBe(128_000)
  })

  test('shapes the Agent request by its own provider, not by session-wide settings', async () => {
    // Session: a ChatGPT-account runtime with a 128k output cap, connecting directly.
    Object.assign(process.env, {
      CLAUDE_CODE_PROVIDER_MAX_OUTPUT_TOKENS: '128000',
      CC_HAHA_OPENAI_OAUTH_PROVIDER: '1',
      ANTHROPIC_MODEL: 'opusplan',
    })
    const proxied: ProviderRoute = {
      ...route,
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:41234/proxy/providers/deepseek-direct',
        CLAUDE_CODE_PROVIDER_MAX_OUTPUT_TOKENS: '8192',
      },
    }

    // As in claude.ts, the request scope is entered from inside the Agent run.
    async function* request() {
      await Promise.resolve()
      yield {
        budget: getConfiguredProviderOutputBudget(),
        budgetHeader: getOutputBudgetHeaders({}),
        // The account transport claims every model in the session, not here.
        openAITransport: isOpenAIResponsesModel('deepseek-v4-pro'),
        // Plan-mode swaps name the session's slots, never a pinned model.
        planModel: getRuntimeMainLoopModel({ permissionMode: 'plan', mainLoopModel: 'deepseek-v4-pro' }),
      }
    }
    const seen = await collect(withAgentProviderRoute(proxied, (async function* () {
      yield* withRequestProviderRoute('deepseek-v4-pro', request())
    })()))

    expect(seen).toEqual([{
      budget: 8192,
      budgetHeader: { 'x-cc-haha-output-budget-source': 'explicit' },
      openAITransport: false,
      planModel: 'deepseek-v4-pro',
    }])
    expect(getConfiguredProviderOutputBudget()).toBe(128000)
    expect(isOpenAIResponsesModel('deepseek-v4-pro')).toBe(true)
  })

  test('budgets an Agent model by its provider before any request is built', async () => {
    process.env.CLAUDE_CODE_PROVIDER_MAX_OUTPUT_TOKENS = '128000'
    const capped: ProviderRoute = { ...route, env: { ...route.env, CLAUDE_CODE_PROVIDER_MAX_OUTPUT_TOKENS: '8192' } }
    const { getMaxOutputTokensForModel } = await import('../../services/api/claude.js')

    const [inside] = await collect(withAgentProviderRoute(capped, (async function* () {
      yield [getMaxOutputTokensForModel('deepseek-v4-pro'), getMaxOutputTokensForModel('session-main')]
    })()))

    expect(inside).toEqual([8192, 128000])
    expect(getMaxOutputTokensForModel('deepseek-v4-pro')).toBe(128000)
  })

  test('closes the wrapped generator inside the route when the consumer stops early', async () => {
    let cleanupRoute: string | undefined
    const inner = (async function* () {
      try {
        yield 1
        yield 2
      } finally {
        cleanupRoute = getProviderRouteForModel('deepseek-v4-pro')?.providerId
      }
    })()

    for await (const value of withAgentProviderRoute(route, inner)) {
      expect(value).toBe(1)
      break
    }

    expect(cleanupRoute).toBe('deepseek-direct')
  })
})
