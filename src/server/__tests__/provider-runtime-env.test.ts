import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import {
  getManagedEnvKeys,
  mergeActiveProviderManagedEnv,
  readActiveProviderManagedEnv,
} from '../services/providerRuntimeEnv.js'
import { PROVIDER_TOOL_SEARCH_OPT_IN_SCHEMA_VERSION } from '../types/provider.js'
import { get3PModelCapabilityOverride } from '../../utils/model/modelSupportOverrides.js'

let tmpDir: string
let originalConfigDir: string | undefined
let originalHome: string | undefined

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8')
}

describe('providerRuntimeEnv', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-runtime-env-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    originalHome = process.env.HOME
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.HOME = tmpDir
  })

  afterEach(async () => {
    if (originalConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    else delete process.env.CLAUDE_CONFIG_DIR
    if (originalHome !== undefined) process.env.HOME = originalHome
    else delete process.env.HOME
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('normalizes and preserves Grok Official as the active runtime provider', async () => {
    await writeJson(path.join(tmpDir, 'cc-haha', 'providers.json'), {
      activeId: 'grok-official',
      providers: [],
      providerOrder: ['claude-official', 'openai-official'],
    })

    const env = mergeActiveProviderManagedEnv(
      {
        CC_HAHA_OPENAI_OAUTH_PROVIDER: '1',
        OPENAI_CODEX_OAUTH_FILE: path.join(tmpDir, 'stale-openai-oauth.json'),
        ANTHROPIC_MODEL: 'stale-openai-model',
        DISABLE_AUTOUPDATER: '1',
      },
      tmpDir,
    )

    expect(env).toMatchObject({
      CC_HAHA_GROK_OAUTH_PROVIDER: '1',
      GROK_OAUTH_FILE: path.join(tmpDir, 'cc-haha', 'grok-oauth.json'),
      CC_HAHA_IMAGE_PROVIDER_KIND: 'grok_oauth',
      CC_HAHA_IMAGE_PROVIDER_ID: 'grok-official',
      CC_HAHA_IMAGE_MODEL: 'grok-imagine-image-quality',
      ANTHROPIC_MODEL: 'grok-4.6',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'grok-4.6',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'grok-4.6',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'grok-4.6',
      DISABLE_AUTOUPDATER: '1',
    })
    expect(env.CC_HAHA_OPENAI_OAUTH_PROVIDER).toBeUndefined()
    expect(env.OPENAI_CODEX_OAUTH_FILE).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  test('routes custom image generation through its own optional credentials', async () => {
    await writeJson(path.join(tmpDir, 'cc-haha', 'providers.json'), {
      activeId: 'provider-images',
      providers: [{
        id: 'provider-images',
        presetId: 'custom',
        name: 'Sub2API',
        apiKey: 'chat-secret',
        baseUrl: 'https://chat.example.test',
        apiFormat: 'anthropic',
        models: {
          main: 'chat-model',
          haiku: 'chat-model',
          sonnet: 'chat-model',
          opus: 'chat-model',
        },
        imageGeneration: {
          model: '  upstream-image-model  ',
          baseUrl: '  https://images.example.test/v1  ',
          apiKey: '  image-secret  ',
        },
      }],
    })

    const env = readActiveProviderManagedEnv(tmpDir)
    expect(env).toMatchObject({
      CC_HAHA_IMAGE_PROVIDER_KIND: 'openai_images',
      CC_HAHA_IMAGE_PROVIDER_ID: 'provider-images',
      CC_HAHA_IMAGE_BASE_URL: 'https://images.example.test/v1',
      CC_HAHA_IMAGE_API_KEY: 'image-secret',
      CC_HAHA_IMAGE_MODEL: 'upstream-image-model',
    })
  })

  test('clears stale image routing when the next active provider has no image capability', async () => {
    await writeJson(path.join(tmpDir, 'cc-haha', 'providers.json'), {
      activeId: 'provider-chat-only',
      providers: [{
        id: 'provider-chat-only',
        presetId: 'custom',
        name: 'Chat only',
        apiKey: 'chat-secret',
        baseUrl: 'https://chat.example.test',
        apiFormat: 'anthropic',
        models: {
          main: 'chat-model',
          haiku: 'chat-model',
          sonnet: 'chat-model',
          opus: 'chat-model',
        },
      }],
    })

    const env = mergeActiveProviderManagedEnv({
      CC_HAHA_IMAGE_PROVIDER_KIND: 'openai_images',
      CC_HAHA_IMAGE_PROVIDER_ID: 'stale-provider',
      CC_HAHA_IMAGE_BASE_URL: 'https://stale.example.test/v1',
      CC_HAHA_IMAGE_API_KEY: 'stale-secret',
      CC_HAHA_IMAGE_MODEL: 'stale-model',
    }, tmpDir)

    expect(env.CC_HAHA_IMAGE_PROVIDER_KIND).toBeUndefined()
    expect(env.CC_HAHA_IMAGE_PROVIDER_ID).toBeUndefined()
    expect(env.CC_HAHA_IMAGE_BASE_URL).toBeUndefined()
    expect(env.CC_HAHA_IMAGE_API_KEY).toBeUndefined()
    expect(env.CC_HAHA_IMAGE_MODEL).toBeUndefined()
  })

  test('keeps Claude Code effort capabilities for an unlisted custom model', async () => {
    await writeJson(path.join(tmpDir, 'cc-haha', 'providers.json'), {
      activeId: 'provider-1',
      providers: [
        {
          id: 'provider-1',
          presetId: 'custom',
          name: 'Active Provider',
          apiKey: 'sk-active',
          authStrategy: 'auth_token',
          baseUrl: 'https://api.example.com/anthropic',
          apiFormat: 'anthropic',
          models: {
            main: 'active-main',
            fable: 'active-fable',
            haiku: '',
            sonnet: 'active-sonnet',
            opus: '',
          },
        },
      ],
    })

    const env = readActiveProviderManagedEnv(tmpDir)

    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.example.com/anthropic',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: 'sk-active',
      ENABLE_TOOL_SEARCH: 'false',
      ANTHROPIC_MODEL: 'active-main',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'active-fable',
      ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES:
        'thinking,effort,adaptive_thinking,xhigh_effort,max_effort',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'active-main',
      ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES:
        'thinking,effort,adaptive_thinking,xhigh_effort,max_effort',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'active-sonnet',
      ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES:
        'thinking,effort,adaptive_thinking,xhigh_effort,max_effort',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'active-main',
      ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES:
        'thinking,effort,adaptive_thinking,xhigh_effort,max_effort',
    })

    const runtimeKeys = [
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
      'CLAUDE_CODE_EFFORT_LEVEL',
    ] as const
    const originalRuntimeEnv = Object.fromEntries(
      runtimeKeys.map(key => [key, process.env[key]]),
    )
    try {
      process.env.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL
      process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL =
        env.ANTHROPIC_DEFAULT_HAIKU_MODEL
      process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES =
        env.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES
      delete process.env.CLAUDE_CODE_EFFORT_LEVEL
      clearCapabilityCache()

      expect(get3PModelCapabilityOverride('active-main', 'effort')).toBe(true)
      expect(get3PModelCapabilityOverride('active-main', 'xhigh_effort')).toBe(true)
      expect(get3PModelCapabilityOverride('active-main', 'max_effort')).toBe(true)
    } finally {
      for (const key of runtimeKeys) {
        const value = originalRuntimeEnv[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      clearCapabilityCache()
    }
  })

  test('does not let legacy preset metadata disable compatible model effort', async () => {
    await writeJson(path.join(tmpDir, 'cc-haha', 'providers.json'), {
      activeId: 'provider-xuanshu',
      providers: [
        {
          id: 'provider-xuanshu',
          presetId: 'xuanshuapi',
          name: 'XuanShu API',
          apiKey: 'sk-xuanshu',
          authStrategy: 'auth_token',
          baseUrl: 'https://www.xuanshuapi.com',
          apiFormat: 'anthropic',
          models: {
            main: 'claude-opus-5',
            haiku: 'claude-haiku-4-5',
            sonnet: 'claude-sonnet-5',
            opus: 'claude-opus-5',
          },
        },
      ],
    })

    const env = readActiveProviderManagedEnv(tmpDir)

    expect(env).toMatchObject({
      ANTHROPIC_MODEL: 'claude-opus-5',
      ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES:
        'thinking,effort,adaptive_thinking,xhigh_effort,max_effort',
      ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES:
        'thinking,effort,adaptive_thinking,xhigh_effort,max_effort',
    })
  })

  test('active provider env overrides stale proxy settings while preserving unrelated env', async () => {
    await writeJson(path.join(tmpDir, 'cc-haha', 'providers.json'), {
      activeId: 'provider-1',
      providers: [
        {
          id: 'provider-1',
          presetId: 'custom',
          name: 'Sub2API',
          apiKey: 'sk-sub2api',
          authStrategy: 'auth_token',
          baseUrl: 'https://sub2api.example.com',
          apiFormat: 'anthropic',
          models: {
            main: 'gpt-5.5',
            haiku: 'gpt-5.5',
            sonnet: 'gpt-5.5',
            opus: 'gpt-5.5',
          },
        },
      ],
    })

    const env = mergeActiveProviderManagedEnv(
      {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456/proxy',
        ANTHROPIC_API_KEY: 'proxy-managed',
        ANTHROPIC_MODEL: 'deepseek-v4-pro',
        CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
        DISABLE_AUTOUPDATER: '1',
      },
      tmpDir,
    )

    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://sub2api.example.com',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: 'sk-sub2api',
      ENABLE_TOOL_SEARCH: 'false',
      ANTHROPIC_MODEL: 'gpt-5.5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gpt-5.5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'gpt-5.5',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'gpt-5.5',
      DISABLE_AUTOUPDATER: '1',
    })
    expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBeUndefined()
  })

  test('honors explicitly enabled tool search for native Anthropic providers', async () => {
    await writeJson(path.join(tmpDir, 'cc-haha', 'providers.json'), {
      schemaVersion: PROVIDER_TOOL_SEARCH_OPT_IN_SCHEMA_VERSION,
      activeId: 'provider-1',
      providers: [
        {
          id: 'provider-1',
          presetId: 'custom',
          name: 'Tool Search On',
          apiKey: 'sk-active',
          authStrategy: 'auth_token',
          baseUrl: 'https://api.example.com/anthropic',
          apiFormat: 'anthropic',
          toolSearchEnabled: true,
          models: {
            main: 'active-main',
            haiku: 'active-main',
            sonnet: 'active-main',
            opus: 'active-main',
          },
        },
      ],
    })

    const env = readActiveProviderManagedEnv(tmpDir)

    expect(env.ENABLE_TOOL_SEARCH).toBe('true')
  })

  test('honors disabled experimental betas for active providers', async () => {
    await writeJson(path.join(tmpDir, 'cc-haha', 'providers.json'), {
      activeId: 'provider-1',
      providers: [
        {
          id: 'provider-1',
          presetId: 'custom',
          name: 'Experimental Betas Off',
          apiKey: 'sk-active',
          authStrategy: 'auth_token',
          baseUrl: 'https://api.example.com/anthropic',
          apiFormat: 'anthropic',
          disableExperimentalBetas: true,
          models: {
            main: 'active-main',
            haiku: 'active-main',
            sonnet: 'active-main',
            opus: 'active-main',
          },
        },
      ],
    })

    const env = readActiveProviderManagedEnv(tmpDir)

    expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('1')
  })

  test('keeps providers readable when stored tool search values are stringly typed', async () => {
    await writeJson(path.join(tmpDir, 'cc-haha', 'providers.json'), {
      activeId: 'provider-1',
      providers: [
        {
          id: 'provider-1',
          presetId: 'custom',
          name: 'String Tool Search',
          apiKey: 'sk-active',
          authStrategy: 'auth_token',
          baseUrl: 'https://api.example.com/anthropic',
          apiFormat: 'anthropic',
          toolSearchEnabled: 'false',
          models: {
            main: 'active-main',
            haiku: 'active-main',
            sonnet: 'active-main',
            opus: 'active-main',
          },
        },
      ],
    })

    const env = readActiveProviderManagedEnv(tmpDir)

    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.example.com/anthropic')
    expect(env.ENABLE_TOOL_SEARCH).toBe('false')
  })

  test('does not write tool search env for OpenAI proxy providers', async () => {
    await writeJson(path.join(tmpDir, 'cc-haha', 'providers.json'), {
      activeId: 'provider-1',
      providers: [
        {
          id: 'provider-1',
          presetId: 'custom',
          name: 'OpenAI Proxy Provider',
          apiKey: 'sk-active',
          authStrategy: 'auth_token',
          baseUrl: 'https://api.example.com/openai',
          apiFormat: 'openai_chat',
          toolSearchEnabled: true,
          models: {
            main: 'active-main',
            haiku: 'active-main',
            sonnet: 'active-main',
            opus: 'active-main',
          },
        },
      ],
    })

    const env = readActiveProviderManagedEnv(tmpDir)

    expect(env.ENABLE_TOOL_SEARCH).toBeUndefined()
  })

  test('applies updated docs-backed preset env for domestic Anthropic-compatible providers', async () => {
    await writeJson(path.join(tmpDir, 'cc-haha', 'providers.json'), {
      activeId: 'provider-kimi',
      providers: [
        {
          id: 'provider-kimi',
          presetId: 'kimi',
          name: 'Kimi',
          apiKey: 'sk-kimi',
          authStrategy: 'api_key',
          baseUrl: 'https://api.kimi.com/coding/',
          apiFormat: 'anthropic',
          models: {
            main: 'k3',
            haiku: 'k3',
            sonnet: 'k3',
            opus: 'k3',
          },
        },
      ],
    })

    const kimiEnv = readActiveProviderManagedEnv(tmpDir)

    expect(kimiEnv).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/',
      ANTHROPIC_API_KEY: 'sk-kimi',
      ANTHROPIC_MODEL: 'k3',
      ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES:
        'thinking,required_thinking,effort,xhigh_effort,max_effort',
    })
    expect(kimiEnv?.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(JSON.parse(kimiEnv!.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS)).toMatchObject({
      k3: 262144,
      'kimi-for-coding': 262144,
      'kimi-for-coding-highspeed': 262144,
    })

    await writeJson(path.join(tmpDir, 'cc-haha', 'providers.json'), {
      activeId: 'provider-kimi-legacy',
      providers: [
        {
          id: 'provider-kimi-legacy',
          presetId: 'kimi',
          name: 'Kimi Open Platform',
          apiKey: 'sk-kimi-legacy',
          authStrategy: 'auth_token',
          baseUrl: 'https://api.moonshot.cn/anthropic',
          apiFormat: 'anthropic',
          models: {
            main: 'kimi-k2.7-code',
            haiku: 'kimi-k2.7-code',
            sonnet: 'kimi-k2.7-code',
            opus: 'kimi-k2.7-code',
          },
        },
      ],
    })

    const legacyKimiEnv = readActiveProviderManagedEnv(tmpDir)

    expect(legacyKimiEnv).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.moonshot.cn/anthropic',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: 'sk-kimi-legacy',
      ANTHROPIC_MODEL: 'kimi-k2.7-code',
      ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES:
        'thinking,required_thinking,effort,xhigh_effort,max_effort',
    })

    await writeJson(path.join(tmpDir, 'cc-haha', 'providers.json'), {
      activeId: 'provider-zhipu',
      providers: [
        {
          id: 'provider-zhipu',
          presetId: 'zhipuglm',
          name: 'Zhipu GLM',
          apiKey: 'sk-zhipu',
          authStrategy: 'auth_token',
          baseUrl: 'https://open.bigmodel.cn/api/anthropic',
          apiFormat: 'anthropic',
          models: {
            main: 'glm-5.2[1m]',
            haiku: 'glm-4.7',
            sonnet: 'glm-5.2[1m]',
            opus: 'glm-5.2[1m]',
          },
        },
      ],
    })

    const zhipuEnv = readActiveProviderManagedEnv(tmpDir)

    expect(zhipuEnv).toMatchObject({
      ANTHROPIC_MODEL: 'glm-5.2[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.7',
      ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES:
        'thinking,effort,xhigh_effort,max_effort',
      ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES:
        'thinking,effort,xhigh_effort,max_effort',
    })
    // No provider-wide auto-compact window: it is model-agnostic and pinned
    // small-context models at 1M so auto-compact never fired (#1162).
    expect(zhipuEnv!.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()
    expect(JSON.parse(zhipuEnv!.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS)).toMatchObject({
      'glm-5.2[1m]': 1000000,
      'glm-4.7': 200000,
    })
  })

  // getManagedEnvKeys() is the erase list used to strip stale provider env out of
  // cc-haha/settings.json. It is built by unioning every preset's defaultEnv keys, so
  // deleting a preset outright would drop keys only that preset declares — they would
  // then never be cleaned and would leak into every provider activated afterwards.
  test('keeps the settings.json erase list covering retired presets env keys', () => {
    const keys = getManagedEnvKeys()

    // Declared only by the retired 胜算云 preset; a stale 50-minute API_TIMEOUT_MS
    // leaking into other providers is exactly what this guards.
    expect(keys).toContain('API_TIMEOUT_MS')
    expect(keys).toContain('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')
  })

  // Retiring a preset must not touch providers already saved against it. defaultEnv is
  // never persisted per provider — it is resolved from the preset on every run, so
  // deleting the entry would silently drop it. Older records may also lack
  // authStrategy / modelContextWindows and fall back to the preset for those too.
  test('keeps resolving preset runtime env for providers saved against a retired preset', async () => {
    await writeJson(path.join(tmpDir, 'cc-haha', 'providers.json'), {
      activeId: 'provider-shengsuanyun',
      providers: [
        {
          id: 'provider-shengsuanyun',
          presetId: 'shengsuanyun',
          name: '胜算云',
          apiKey: 'sk-shengsuanyun',
          baseUrl: 'https://router.shengsuanyun.com/api',
          apiFormat: 'anthropic',
          models: {
            main: 'anthropic/claude-sonnet-4.6',
            haiku: 'anthropic/claude-haiku-4.5:thinking',
            sonnet: 'anthropic/claude-sonnet-4.6',
            opus: 'anthropic/claude-opus-4.7',
          },
        },
      ],
    })

    const env = readActiveProviderManagedEnv(tmpDir)

    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://router.shengsuanyun.com/api',
      ANTHROPIC_MODEL: 'anthropic/claude-sonnet-4.6',
      // preset defaultEnv survives the retirement
      API_TIMEOUT_MS: '3000000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES:
        'thinking,effort,adaptive_thinking,xhigh_effort,max_effort',
    })
    // preset authStrategy (auth_token) survives: bearer token, blanked api key
    expect(env?.ANTHROPIC_AUTH_TOKEN).toBe('sk-shengsuanyun')
    expect(env?.ANTHROPIC_API_KEY).toBe('')
    expect(JSON.parse(env!.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS)).toMatchObject({
      'anthropic/claude-sonnet-4.6': 1000000,
      'anthropic/claude-opus-4.7': 1000000,
    })
  })
})

function clearCapabilityCache() {
  ;(get3PModelCapabilityOverride as typeof get3PModelCapabilityOverride & {
    cache?: { clear?: () => void }
  }).cache?.clear?.()
}
