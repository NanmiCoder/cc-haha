import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'

const originalEnv = { ...process.env }
const sandboxHome = mkdtempSync(join(tmpdir(), 'cyber-risk-settings-'))
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(
  process.env,
  createSandboxedTestEnvironment(sandboxHome, {}, originalEnv),
)

const {
  isClaudeOfficialAccountProtected,
  resetCyberRiskInstructionSessionLatch,
  shouldIncludeCyberRiskInstruction,
} = await import('../cyberRiskSettings.js')
const { getClaudeAIOAuthTokens } = await import('../auth.js')
const { runWithAgentProviderRoute } = await import('../model/providerEnvScope.js')
const { resetSettingsCache } = await import('../settings/settingsCache.js')
const { getOriginalCwd, setOriginalCwd } = await import('../../bootstrap/state.js')
const {
  clearOpenAIOAuthTokenCache,
  OPENAI_CODEX_OAUTH_FILE_ENV_KEY,
  saveOpenAIOAuthTokens,
} = await import('../../services/openaiAuth/storage.js')

const initialOriginalCwd = getOriginalCwd()
const configDir = join(sandboxHome, '.claude')
const projectDir = join(sandboxHome, 'project')
const openAIOAuthFile = join(sandboxHome, 'openai-oauth.json')
mkdirSync(configDir, { recursive: true })
mkdirSync(join(projectDir, '.claude'), { recursive: true })
process.env.CLAUDE_CONFIG_DIR = configDir
process.env[OPENAI_CODEX_OAUTH_FILE_ENV_KEY] = openAIOAuthFile
setOriginalCwd(projectDir)

const ENV_NAME = 'CLAUDE_CODE_DISABLE_CYBER_RISK_INSTRUCTION'
const AUTH_ENV_KEYS = [
  ENV_NAME,
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_AZURE_OPENAI',
  'CC_HAHA_OPENAI_OAUTH_PROVIDER',
  'CC_HAHA_GROK_OAUTH_PROVIDER',
  'CC_HAHA_DEEPSEEK_OAUTH_PROVIDER',
] as const

afterAll(() => {
  setOriginalCwd(initialOriginalCwd)
  resetSettingsCache()
  resetCyberRiskInstructionSessionLatch()
  clearOpenAIOAuthTokenCache()
  getClaudeAIOAuthTokens.cache.clear?.()
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  rmSync(sandboxHome, { recursive: true, force: true })
})

function writeJsonSettings(filePath: string, settings: Record<string, unknown> | null, resetLatch = true) {
  if (settings === null) {
    rmSync(filePath, { force: true })
  } else {
    writeFileSync(filePath, JSON.stringify(settings))
  }
  resetSettingsCache()
  if (resetLatch) resetCyberRiskInstructionSessionLatch()
}

function writeUserSettings(settings: Record<string, unknown> | null, resetLatch = true) {
  writeJsonSettings(join(configDir, 'settings.json'), settings, resetLatch)
}

function writeProjectSettings(settings: Record<string, unknown> | null, resetLatch = true) {
  writeJsonSettings(join(projectDir, '.claude', 'settings.json'), settings, resetLatch)
}

function writeLocalSettings(settings: Record<string, unknown> | null, resetLatch = true) {
  writeJsonSettings(join(projectDir, '.claude', 'settings.local.json'), settings, resetLatch)
}

beforeEach(() => {
  for (const key of AUTH_ENV_KEYS) delete process.env[key]
  rmSync(openAIOAuthFile, { force: true })
  clearOpenAIOAuthTokenCache()
  getClaudeAIOAuthTokens.cache.clear?.()
  writeUserSettings(null)
  writeProjectSettings(null)
  writeLocalSettings(null)
})

describe('shouldIncludeCyberRiskInstruction', () => {
  test('defaults to true when nothing is configured', () => {
    expect(shouldIncludeCyberRiskInstruction()).toBe(true)
  })

  test('returns false when the setting is false for a third-party provider', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    process.env.ANTHROPIC_API_KEY = 'fixture-deepseek-key'
    writeUserSettings({ includeCyberRiskInstruction: false })
    expect(isClaudeOfficialAccountProtected()).toBe(false)
    expect(shouldIncludeCyberRiskInstruction()).toBe(false)
  })

  test('returns true when the setting is true', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    writeUserSettings({ includeCyberRiskInstruction: true })
    expect(shouldIncludeCyberRiskInstruction()).toBe(true)
  })

  test('ignores untrusted projectSettings so repositories cannot silently disable safety prompts', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    writeProjectSettings({ includeCyberRiskInstruction: false })
    expect(shouldIncludeCyberRiskInstruction()).toBe(true)

    writeUserSettings({ includeCyberRiskInstruction: true })
    writeProjectSettings({ includeCyberRiskInstruction: false })
    expect(shouldIncludeCyberRiskInstruction()).toBe(true)
  })

  test('honors trusted localSettings over userSettings', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    writeUserSettings({ includeCyberRiskInstruction: true })
    writeLocalSettings({ includeCyberRiskInstruction: false })
    expect(shouldIncludeCyberRiskInstruction()).toBe(false)
  })

  test('latches the setting per session even after settings cache resets on disk changes', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    writeUserSettings({ includeCyberRiskInstruction: true })
    expect(shouldIncludeCyberRiskInstruction()).toBe(true)

    // Simulates Desktop toggling the switch while an older CLI session is still running
    // and settingsChangeDetector calls resetSettingsCache().
    writeUserSettings({ includeCyberRiskInstruction: false }, false)
    expect(shouldIncludeCyberRiskInstruction()).toBe(true)

    // A new session observes the updated setting.
    resetCyberRiskInstructionSessionLatch()
    expect(shouldIncludeCyberRiskInstruction()).toBe(false)
  })

  test('protects Claude official OAuth accounts even when the setting is false', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-claude-oauth-token'
    writeUserSettings({ includeCyberRiskInstruction: false })
    expect(isClaudeOfficialAccountProtected()).toBe(true)
    expect(shouldIncludeCyberRiskInstruction()).toBe(true)
  })

  test('does not protect a SubAgent routed to a third-party provider inside a Claude official session', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-claude-oauth-token'
    writeUserSettings({ includeCyberRiskInstruction: false })

    // Main agent remains protected.
    expect(isClaudeOfficialAccountProtected()).toBe(true)
    expect(shouldIncludeCyberRiskInstruction()).toBe(true)

    // SubAgent routed via withAgentProviderRoute/runWithAgentProviderRoute gets the opt-out.
    const route = {
      providerId: 'deepseek-fixture',
      providerName: 'DeepSeek Fixture',
      model: 'deepseek-chat',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_API_KEY: 'fixture-deepseek-key',
      },
    }
    const subagentResult = runWithAgentProviderRoute(route, () => ({
      protected: isClaudeOfficialAccountProtected(),
      included: shouldIncludeCyberRiskInstruction(),
    }))
    expect(subagentResult).toEqual({ protected: false, included: false })
  })

  test.each([
    ['custom ANTHROPIC_BASE_URL', { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' }],
    ['Bedrock', { CLAUDE_CODE_USE_BEDROCK: '1' }],
    ['Vertex', { CLAUDE_CODE_USE_VERTEX: '1' }],
    ['Foundry', { CLAUDE_CODE_USE_FOUNDRY: '1' }],
    ['Azure OpenAI', { CLAUDE_CODE_USE_AZURE_OPENAI: '1' }],
    ['Grok OAuth', { CC_HAHA_GROK_OAUTH_PROVIDER: '1' }],
    ['DeepSeek OAuth', { CC_HAHA_DEEPSEEK_OAUTH_PROVIDER: '1' }],
  ])('does not treat %s as a protected Claude official account', (_label, extraEnv) => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-claude-oauth-token'
    Object.assign(process.env, extraEnv)
    writeUserSettings({ includeCyberRiskInstruction: false })
    expect(isClaudeOfficialAccountProtected()).toBe(false)
    expect(shouldIncludeCyberRiskInstruction()).toBe(false)
  })

  test('treats OpenAI Codex OAuth as third-party only when OpenAI OAuth tokens are actually present', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-claude-oauth-token'
    process.env.CC_HAHA_OPENAI_OAUTH_PROVIDER = '1'
    writeUserSettings({ includeCyberRiskInstruction: false })

    // Without OpenAI tokens, client.ts falls back to Claude OAuth; keep protection active.
    expect(isClaudeOfficialAccountProtected()).toBe(true)
    expect(shouldIncludeCyberRiskInstruction()).toBe(true)

    // With OpenAI OAuth tokens present, OpenAI Codex transport is active.
    saveOpenAIOAuthTokens({
      accessToken: 'fixture-openai-access',
      refreshToken: 'fixture-openai-refresh',
      expiresAt: Date.now() + 3600_000,
    })
    expect(isClaudeOfficialAccountProtected()).toBe(false)
    expect(shouldIncludeCyberRiskInstruction()).toBe(false)
  })

  test('env=1 disables even when the setting is true or Claude official OAuth is active', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-claude-oauth-token'
    writeUserSettings({ includeCyberRiskInstruction: true })
    process.env[ENV_NAME] = '1'
    expect(shouldIncludeCyberRiskInstruction()).toBe(false)
  })

  test('env=0 enables even when the setting is false', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    writeUserSettings({ includeCyberRiskInstruction: false })
    process.env[ENV_NAME] = '0'
    expect(shouldIncludeCyberRiskInstruction()).toBe(true)
  })

  test('empty env falls through to the setting', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    writeUserSettings({ includeCyberRiskInstruction: false })
    process.env[ENV_NAME] = ''
    expect(shouldIncludeCyberRiskInstruction()).toBe(false)
  })
})
