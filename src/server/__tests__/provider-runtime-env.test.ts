import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import {
  mergeActiveProviderManagedEnv,
  readActiveProviderManagedEnv,
} from '../services/providerRuntimeEnv.js'

let tmpDir: string

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8')
}

describe('providerRuntimeEnv', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-runtime-env-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
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
})
