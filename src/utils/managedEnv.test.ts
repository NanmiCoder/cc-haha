import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import { applyConfigEnvironmentVariables, applySafeConfigEnvironmentVariables } from './managedEnv.js'
import { resetSettingsCache } from './settings/settingsCache.js'

let tmpDir: string
const originalEnv = {
  CC_HAHA_AGENT_TEAMS_ENABLED: process.env.CC_HAHA_AGENT_TEAMS_ENABLED,
  CC_HAHA_AGENT_TEAMS_DEFAULT: process.env.CC_HAHA_AGENT_TEAMS_DEFAULT,
  CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST,
  CC_HAHA_LOCAL_ACCESS_TOKEN: process.env.CC_HAHA_LOCAL_ACCESS_TOKEN,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
  ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
  CC_HAHA_OPENAI_OAUTH_PROVIDER: process.env.CC_HAHA_OPENAI_OAUTH_PROVIDER,
  OPENAI_CODEX_OAUTH_FILE: process.env.OPENAI_CODEX_OAUTH_FILE,
  CC_HAHA_GROK_OAUTH_PROVIDER: process.env.CC_HAHA_GROK_OAUTH_PROVIDER,
  CC_HAHA_DEEPSEEK_OAUTH_PROVIDER: process.env.CC_HAHA_DEEPSEEK_OAUTH_PROVIDER,
  CLAUDE_CODE_SUBAGENT_MODEL: process.env.CLAUDE_CODE_SUBAGENT_MODEL,
  CC_HAHA_IMAGE_PROVIDER_KIND: process.env.CC_HAHA_IMAGE_PROVIDER_KIND,
  CC_HAHA_IMAGE_PROVIDER_ID: process.env.CC_HAHA_IMAGE_PROVIDER_ID,
  CC_HAHA_IMAGE_MODEL: process.env.CC_HAHA_IMAGE_MODEL,
  CC_HAHA_IMAGE_PROTOCOL: process.env.CC_HAHA_IMAGE_PROTOCOL,
  CLAUDE_CODE_PROVIDER_MAX_OUTPUT_TOKENS: process.env.CLAUDE_CODE_PROVIDER_MAX_OUTPUT_TOKENS,
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
    resetSettingsCache()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-env-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
    delete process.env.CC_HAHA_AGENT_TEAMS_ENABLED
    delete process.env.CC_HAHA_AGENT_TEAMS_DEFAULT
    process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli'
    delete process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
    delete process.env.ANTHROPIC_BASE_URL
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
    delete process.env.ANTHROPIC_MODEL
    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
    delete process.env.CC_HAHA_OPENAI_OAUTH_PROVIDER
    delete process.env.OPENAI_CODEX_OAUTH_FILE
    delete process.env.CC_HAHA_GROK_OAUTH_PROVIDER
    delete process.env.CC_HAHA_DEEPSEEK_OAUTH_PROVIDER
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
    delete process.env.CC_HAHA_IMAGE_PROVIDER_KIND
    delete process.env.CC_HAHA_IMAGE_PROVIDER_ID
    delete process.env.CC_HAHA_IMAGE_MODEL
    delete process.env.CC_HAHA_IMAGE_PROTOCOL
    delete process.env.CLAUDE_CODE_PROVIDER_MAX_OUTPUT_TOKENS
  })

  afterEach(async () => {
    resetSettingsCache()
    await import('../server/proxy/standaloneProviderProxy.js')
      .then((mod) => mod.stopStandaloneProviderProxyForTests?.())
      .catch(() => {})
    await fs.rm(tmpDir, { recursive: true, force: true })
    restoreEnv('CLAUDE_CONFIG_DIR')
    restoreEnv('CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST')
    restoreEnv('CC_HAHA_LOCAL_ACCESS_TOKEN')
    restoreEnv('CC_HAHA_AGENT_TEAMS_ENABLED')
    restoreEnv('CC_HAHA_AGENT_TEAMS_DEFAULT')
    restoreEnv('CLAUDE_CODE_ENTRYPOINT')
    restoreEnv('ANTHROPIC_BASE_URL')
    restoreEnv('ANTHROPIC_API_KEY')
    restoreEnv('ANTHROPIC_AUTH_TOKEN')
    restoreEnv('ANTHROPIC_MODEL')
    restoreEnv('ANTHROPIC_DEFAULT_OPUS_MODEL')
    restoreEnv('CC_HAHA_OPENAI_OAUTH_PROVIDER')
    restoreEnv('OPENAI_CODEX_OAUTH_FILE')
    restoreEnv('CC_HAHA_GROK_OAUTH_PROVIDER')
    restoreEnv('CC_HAHA_DEEPSEEK_OAUTH_PROVIDER')
    restoreEnv('CLAUDE_CODE_SUBAGENT_MODEL')
    restoreEnv('CC_HAHA_IMAGE_PROVIDER_KIND')
    restoreEnv('CC_HAHA_IMAGE_PROVIDER_ID')
    restoreEnv('CC_HAHA_IMAGE_MODEL')
    restoreEnv('CC_HAHA_IMAGE_PROTOCOL')
    restoreEnv('CLAUDE_CODE_PROVIDER_MAX_OUTPUT_TOKENS')
  })

  test.each(['0', '1', undefined])('protects the General team preference %j through settings application', async (enabled) => {
    await writeJson(path.join(tmpDir, 'cc-haha', 'settings.json'), {
      env: {
        CC_HAHA_AGENT_TEAMS_ENABLED: enabled === '1' ? '0' : '1',
        CC_HAHA_AGENT_TEAMS_DEFAULT: '0',
      },
    })
    if (enabled !== undefined) process.env.CC_HAHA_AGENT_TEAMS_ENABLED = enabled
    process.env.CC_HAHA_AGENT_TEAMS_DEFAULT = '1'

    // OAuth and cron sessions can use sdk-cli without host-owned provider routing.
    // Both the pre-trust and post-trust settings paths must preserve the choice.
    applySafeConfigEnvironmentVariables()
    expect(process.env.CC_HAHA_AGENT_TEAMS_ENABLED).toBe(enabled)
    expect(process.env.CC_HAHA_AGENT_TEAMS_DEFAULT).toBe('1')
    applyConfigEnvironmentVariables()
    expect(process.env.CC_HAHA_AGENT_TEAMS_ENABLED).toBe(enabled)
    expect(process.env.CC_HAHA_AGENT_TEAMS_DEFAULT).toBe('1')
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
        CC_HAHA_IMAGE_PROTOCOL: 'gemini_native',
        CLAUDE_CODE_PROVIDER_MAX_OUTPUT_TOKENS: '32000',
      },
    })
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = 'desktop-local-secret'
    process.env.CC_HAHA_IMAGE_PROVIDER_KIND = 'grok_oauth'
    process.env.CC_HAHA_IMAGE_PROVIDER_ID = 'grok-official'
    process.env.CC_HAHA_IMAGE_MODEL = 'grok-imagine-image-quality'
    process.env.CC_HAHA_IMAGE_PROTOCOL = 'xai_images'
    process.env.CLAUDE_CODE_PROVIDER_MAX_OUTPUT_TOKENS = '96000'

    applySafeConfigEnvironmentVariables()

    expect(process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe('1')
    expect(process.env.CC_HAHA_LOCAL_ACCESS_TOKEN).toBe('desktop-local-secret')
    expect(process.env.CC_HAHA_IMAGE_PROVIDER_KIND).toBe('grok_oauth')
    expect(process.env.CC_HAHA_IMAGE_PROVIDER_ID).toBe('grok-official')
    expect(process.env.CC_HAHA_IMAGE_MODEL).toBe('grok-imagine-image-quality')
    expect(process.env.CC_HAHA_IMAGE_PROTOCOL).toBe('xai_images')
    expect(process.env.CLAUDE_CODE_PROVIDER_MAX_OUTPUT_TOKENS).toBe('96000')
    applyConfigEnvironmentVariables()
    expect(process.env.CC_HAHA_IMAGE_PROTOCOL).toBe('xai_images')
  })

  test.each(['active', 'previous'])('loads the subagent override only from its matching settings owner %s', async (owner) => {
    await writeJson(path.join(tmpDir, 'cc-haha', 'providers.json'), {
      schemaVersion: 10, activeId: 'active', providers: [{
        id: 'active', presetId: 'custom', name: 'Fixture', apiKey: 'fake-key', baseUrl: 'https://fixture.invalid',
        models: { main: 'fixture-main', haiku: 'fixture-small', sonnet: 'fixture-medium', opus: 'fixture-large' },
      }],
    })
    await writeJson(path.join(tmpDir, 'cc-haha', 'settings.json'), {
      providerEnvOwner: owner, env: { CLAUDE_CODE_SUBAGENT_MODEL: 'selected-subagent' },
    })
    const expected = owner === 'active' ? 'selected-subagent' : undefined
    applySafeConfigEnvironmentVariables()
    expect(process.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe(expected)
    applyConfigEnvironmentVariables()
    expect(process.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe(expected)
  })

  test('does not leak active ChatGPT Official or custom provider env into Claude Official desktop sessions (#2054)', async () => {
    await writeJson(path.join(tmpDir, 'settings.json'), {
      env: { CLAUDE_CODE_SUBAGENT_MODEL: 'official-user-subagent' },
    })
    await writeJson(path.join(tmpDir, 'cc-haha', 'providers.json'), {
      schemaVersion: 10,
      activeId: 'openai-official',
      providers: [],
      officialProviderModels: {
        'openai-official': {
          main: 'gpt-6.2-astra',
          fable: 'gpt-6.2-astra',
          haiku: 'gpt-6.2-sol',
          sonnet: 'gpt-6.2-sol',
          opus: 'gpt-6.2-sol',
        },
      },
    })
    await writeJson(path.join(tmpDir, 'cc-haha', 'settings.json'), {
      providerEnvOwner: 'openai-official',
      model: 'gpt-6.2-astra',
      env: {
        CC_HAHA_OPENAI_OAUTH_PROVIDER: '1',
        OPENAI_CODEX_OAUTH_FILE: path.join(tmpDir, 'cc-haha', 'openai-oauth.json'),
        ANTHROPIC_MODEL: 'gpt-6.2-astra',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'gpt-6.2-sol',
      },
    })
    process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop'

    applySafeConfigEnvironmentVariables()
    expect(process.env.CC_HAHA_OPENAI_OAUTH_PROVIDER).toBeUndefined()
    expect(process.env.OPENAI_CODEX_OAUTH_FILE).toBeUndefined()
    expect(process.env.ANTHROPIC_MODEL).toBeUndefined()
    expect(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined()
    expect(process.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('official-user-subagent')

    applyConfigEnvironmentVariables()
    expect(process.env.CC_HAHA_OPENAI_OAUTH_PROVIDER).toBeUndefined()
    expect(process.env.OPENAI_CODEX_OAUTH_FILE).toBeUndefined()
    expect(process.env.ANTHROPIC_MODEL).toBeUndefined()
    expect(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined()
    expect(process.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('official-user-subagent')
  })

  test('does not start standalone proxy or leak custom OpenAI provider env into Claude Official desktop sessions (#2054)', async () => {
    await writeJson(path.join(tmpDir, 'cc-haha', 'providers.json'), {
      schemaVersion: 10,
      activeId: 'custom-openai',
      providers: [
        {
          id: 'custom-openai',
          presetId: 'custom',
          name: 'Custom OpenAI',
          apiKey: 'sk-custom',
          authStrategy: 'api_key',
          baseUrl: 'https://api.custom.invalid',
          apiFormat: 'openai_chat',
          models: {
            main: 'custom-main',
            haiku: 'custom-small',
            sonnet: 'custom-medium',
            opus: 'custom-large',
          },
        },
      ],
    })
    process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop'

    applySafeConfigEnvironmentVariables()
    applyConfigEnvironmentVariables()

    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(process.env.ANTHROPIC_MODEL).toBeUndefined()
    expect(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined()
  })

  test.each([
    { activeId: 'grok-official', flag: 'CC_HAHA_GROK_OAUTH_PROVIDER' },
    { activeId: 'deepseek-account', flag: 'CC_HAHA_DEEPSEEK_OAUTH_PROVIDER' },
  ] as const)('does not leak active $activeId env into Claude Official desktop sessions (#2054)', async ({ activeId, flag }) => {
    await writeJson(path.join(tmpDir, 'cc-haha', 'providers.json'), {
      schemaVersion: 10,
      activeId,
      providers: [],
    })
    await writeJson(path.join(tmpDir, 'cc-haha', 'settings.json'), {
      providerEnvOwner: activeId,
      env: {
        [flag]: '1',
        ANTHROPIC_BASE_URL: 'https://other-account.invalid',
        ANTHROPIC_MODEL: 'other-account-model',
      },
    })
    process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop'

    applySafeConfigEnvironmentVariables()
    applyConfigEnvironmentVariables()

    expect(process.env[flag]).toBeUndefined()
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(process.env.ANTHROPIC_MODEL).toBeUndefined()
  })
})
