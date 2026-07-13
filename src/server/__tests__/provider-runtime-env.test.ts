import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import {
  mergeActiveProviderManagedEnv,
  readActiveProviderManagedEnv,
} from '../services/providerRuntimeEnv.js'

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
      ANTHROPIC_MODEL: 'grok-4.5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'grok-4.5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'grok-4.5',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'grok-4.5',
      DISABLE_AUTOUPDATER: '1',
    })
    expect(env.CC_HAHA_OPENAI_OAUTH_PROVIDER).toBeUndefined()
    expect(env.OPENAI_CODEX_OAUTH_FILE).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  test('derives native Anthropic provider env from the active provider index', async () => {
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
      ENABLE_TOOL_SEARCH: 'true',
      ANTHROPIC_MODEL: 'active-main',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'active-main',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'active-sonnet',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'active-main',
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
      ENABLE_TOOL_SEARCH: 'true',
      ANTHROPIC_MODEL: 'gpt-5.5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gpt-5.5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'gpt-5.5',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'gpt-5.5',
      DISABLE_AUTOUPDATER: '1',
    })
    expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBeUndefined()
  })

  test('honors disabled tool search for native Anthropic providers', async () => {
    await writeJson(path.join(tmpDir, 'cc-haha', 'providers.json'), {
      activeId: 'provider-1',
      providers: [
        {
          id: 'provider-1',
          presetId: 'custom',
          name: 'Tool Search Off',
          apiKey: 'sk-active',
          authStrategy: 'auth_token',
          baseUrl: 'https://api.example.com/anthropic',
          apiFormat: 'anthropic',
          toolSearchEnabled: false,
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

    expect(env.ENABLE_TOOL_SEARCH).toBe('false')
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

    const kimiEnv = readActiveProviderManagedEnv(tmpDir)

    expect(kimiEnv).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.moonshot.cn/anthropic',
      ANTHROPIC_MODEL: 'kimi-k2.7-code',
      ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES: 'thinking,required_thinking',
    })
    expect(JSON.parse(kimiEnv!.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS)).toMatchObject({
      'kimi-k2.7-code': 262144,
      'kimi-k2.7-code-highspeed': 262144,
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
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
    })
    expect(JSON.parse(zhipuEnv!.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS)).toMatchObject({
      'glm-5.2[1m]': 1000000,
      'glm-4.7': 200000,
    })
  })
})
