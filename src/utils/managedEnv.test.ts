import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import { MANAGED_PROVIDER_ENV_KEYS } from '../server/services/providerRuntimeEnv.js'
import { resetModelStringsForTestingOnly } from '../bootstrap/state.js'
import { applySafeConfigEnvironmentVariables } from './managedEnv.js'
import { resetSettingsCache } from './settings/settingsCache.js'

let tmpDir: string
const TEST_ENV_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CC_HAHA_LOCAL_ACCESS_TOKEN',
  ...MANAGED_PROVIDER_ENV_KEYS,
] as const
const originalEnv = Object.fromEntries(
  TEST_ENV_KEYS.map(key => [key, process.env[key]]),
) as Record<(typeof TEST_ENV_KEYS)[number], string | undefined>

function restoreEnv(key: (typeof TEST_ENV_KEYS)[number]): void {
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
    for (const key of TEST_ENV_KEYS) delete process.env[key]
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    resetSettingsCache()
  })

  afterEach(async () => {
    await import('../server/proxy/standaloneProviderProxy.js')
      .then((mod) => mod.stopStandaloneProviderProxyForTests?.())
      .catch(() => {})
    await fs.rm(tmpDir, { recursive: true, force: true })
    for (const key of TEST_ENV_KEYS) restoreEnv(key)
    resetSettingsCache()
    resetModelStringsForTestingOnly()
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
      },
    })
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = 'desktop-local-secret'

    applySafeConfigEnvironmentVariables()

    expect(process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe('1')
    expect(process.env.CC_HAHA_LOCAL_ACCESS_TOKEN).toBe('desktop-local-secret')
  })
})
