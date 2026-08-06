import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import { applySafeConfigEnvironmentVariables } from './managedEnv.js'

let tmpDir: string
const originalEnv = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST,
  CC_HAHA_LOCAL_ACCESS_TOKEN: process.env.CC_HAHA_LOCAL_ACCESS_TOKEN,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
  CC_HAHA_IMAGE_PROVIDER_KIND: process.env.CC_HAHA_IMAGE_PROVIDER_KIND,
  CC_HAHA_IMAGE_PROVIDER_ID: process.env.CC_HAHA_IMAGE_PROVIDER_ID,
  CC_HAHA_IMAGE_MODEL: process.env.CC_HAHA_IMAGE_MODEL,
}

function restoreEnv(key: keyof typeof originalEnv): void {
  const value = originalEnv[key]
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8')
}

describe('managedEnv', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-env-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
    delete process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
    delete process.env.ANTHROPIC_BASE_URL
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
    delete process.env.ANTHROPIC_MODEL
    delete process.env.CC_HAHA_IMAGE_PROVIDER_KIND
    delete process.env.CC_HAHA_IMAGE_PROVIDER_ID
    delete process.env.CC_HAHA_IMAGE_MODEL
  })

  afterEach(async () => {
    await import('../server/proxy/standaloneProviderProxy.js')
      .then((mod) => mod.stopStandaloneProviderProxyForTests?.())
      .catch(() => {})
    await fs.rm(tmpDir, { recursive: true, force: true })
    restoreEnv('CLAUDE_CONFIG_DIR')
    restoreEnv('CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST')
    restoreEnv('CC_HAHA_LOCAL_ACCESS_TOKEN')
    restoreEnv('ANTHROPIC_BASE_URL')
    restoreEnv('ANTHROPIC_API_KEY')
    restoreEnv('ANTHROPIC_AUTH_TOKEN')
    restoreEnv('ANTHROPIC_MODEL')
    restoreEnv('CC_HAHA_IMAGE_PROVIDER_KIND')
    restoreEnv('CC_HAHA_IMAGE_PROVIDER_ID')
    restoreEnv('CC_HAHA_IMAGE_MODEL')
  })

  test('starts a standalone provider proxy for CLI-only OpenAI-compatible providers', async () => {
    await writeJson(path.join(tmpDir, 'cc-haha', 'providers.json'), {
      activeId: 'agnes-provider',
      providers: [
        {
          id: 'agnes-provider',
          presetId: 'custom',
          name: 'Agnes',
          apiKey: 'sk-agnes',
          authStrategy: 'api_key',
          baseUrl: 'https://apihub.agnes-ai.com',
          apiFormat: 'openai_chat',
          models: {
            main: 'agnes-2.0-flash',
            haiku: 'agnes-2.0-flash',
            sonnet: 'agnes-2.0-flash',
            opus: 'agnes-2.0-flash',
          },
        },
      ],
    })

    applySafeConfigEnvironmentVariables()

    const baseUrl = new URL(process.env.ANTHROPIC_BASE_URL!)
    expect(baseUrl.hostname).toBe('127.0.0.1')
    expect(baseUrl.port).not.toBe('3456')
    expect(baseUrl.pathname).toBe('/proxy')

    const health = await fetch(new URL('/health', baseUrl.origin))
    expect(health.status).toBe(200)
  })

  test('does not let settings replace host-owned provider routing credentials', async () => {
    await writeJson(path.join(tmpDir, 'cc-haha', 'settings.json'), {
      env: {
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '0',
        CC_HAHA_LOCAL_ACCESS_TOKEN: 'stale-settings-token',
        CC_HAHA_IMAGE_PROVIDER_KIND: 'openai_oauth',
        CC_HAHA_IMAGE_PROVIDER_ID: 'openai-official',
        CC_HAHA_IMAGE_MODEL: 'gpt-image-2',
      },
    })
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = 'desktop-local-secret'
    process.env.CC_HAHA_IMAGE_PROVIDER_KIND = 'grok_oauth'
    process.env.CC_HAHA_IMAGE_PROVIDER_ID = 'grok-official'
    process.env.CC_HAHA_IMAGE_MODEL = 'grok-imagine-image-quality'

    applySafeConfigEnvironmentVariables()

    expect(process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe('1')
    expect(process.env.CC_HAHA_LOCAL_ACCESS_TOKEN).toBe('desktop-local-secret')
    expect(process.env.CC_HAHA_IMAGE_PROVIDER_KIND).toBe('grok_oauth')
    expect(process.env.CC_HAHA_IMAGE_PROVIDER_ID).toBe('grok-official')
    expect(process.env.CC_HAHA_IMAGE_MODEL).toBe('grok-imagine-image-quality')
  })
})
