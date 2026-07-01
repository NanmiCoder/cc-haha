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
      ANTHROPIC_MODEL: 'gpt-5.5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gpt-5.5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'gpt-5.5',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'gpt-5.5',
      DISABLE_AUTOUPDATER: '1',
    })
  })

  test('injects CLAUDE_CODE_DISABLE_THINKING when the provider is flagged thinkingIncompatible', async () => {
    await writeJson(path.join(tmpDir, 'cc-haha', 'providers.json'), {
      activeId: 'provider-1',
      providers: [
        {
          id: 'provider-1',
          presetId: 'custom',
          name: 'Bedrock Proxy',
          apiKey: 'sk-active',
          authStrategy: 'auth_token',
          baseUrl: 'https://bedrock-proxy.example.com',
          apiFormat: 'anthropic',
          models: {
            main: 'active-main',
            haiku: 'active-haiku',
            sonnet: 'active-sonnet',
            opus: 'active-opus',
          },
          thinkingIncompatible: true,
          thinkingIncompatibleReason: 'additionalModelRequestFields not supported',
        },
      ],
    })

    const env = readActiveProviderManagedEnv(tmpDir)
    expect(env?.CLAUDE_CODE_DISABLE_THINKING).toBe('1')
  })

  test('does NOT inject CLAUDE_CODE_DISABLE_THINKING when the flag is absent (back-compat with v0.5.7 providers.json)', async () => {
    await writeJson(path.join(tmpDir, 'cc-haha', 'providers.json'), {
      activeId: 'provider-1',
      providers: [
        {
          id: 'provider-1',
          presetId: 'custom',
          name: 'Healthy Provider',
          apiKey: 'sk-active',
          authStrategy: 'auth_token',
          baseUrl: 'https://api.example.com',
          apiFormat: 'anthropic',
          models: {
            main: 'active-main',
            haiku: 'active-haiku',
            sonnet: 'active-sonnet',
            opus: 'active-opus',
          },
          // thinkingIncompatible intentionally absent to mirror legacy
          // providers.json files written by older cc-haha versions.
        },
      ],
    })

    const env = readActiveProviderManagedEnv(tmpDir)
    expect(env?.CLAUDE_CODE_DISABLE_THINKING).toBeUndefined()
  })
})
