import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearOAuthTokenCache } from '../auth.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import { sanitizeModelName } from '../commitAttribution.js'
import { ALL_MODEL_CONFIGS } from './configs.js'
import { getOpus46_1MOption, getMaxOpus46_1MOption } from './modelOptions.js'
import {
  firstPartyNameToCanonical,
  getDefaultOpusModel,
  getMarketingNameForModel,
  getPublicModelDisplayName,
  isNonCustomOpusModel,
  parseUserSpecifiedModel,
  renderDefaultModelSetting,
} from './model.js'

const envKeys = [
  'HOME',
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const
let savedEnv: (string | undefined)[]
let temporaryHome: string

beforeEach(() => {
  savedEnv = envKeys.map(key => process.env[key])
  for (const key of envKeys) delete process.env[key]
  temporaryHome = mkdtempSync(join(tmpdir(), 'opus5-model-test-'))
  process.env.HOME = temporaryHome
  process.env.CLAUDE_CONFIG_DIR = join(temporaryHome, 'config')
  resetSettingsCache()
  clearOAuthTokenCache()
})

afterEach(() => {
  resetSettingsCache()
  clearOAuthTokenCache()
  rmSync(temporaryHome, { recursive: true, force: true })
  envKeys.forEach((key, index) => {
    const value = savedEnv[index]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  })
})

describe('Opus 5 runtime model identity', () => {
  test('registers and resolves the latest official Opus without rewriting pinned models', () => {
    expect(Object.values(ALL_MODEL_CONFIGS).some(config => config.firstParty === 'claude-opus-5')).toBe(true)
    expect(getDefaultOpusModel()).toBe('claude-opus-5')
    expect(parseUserSpecifiedModel('opus')).toBe('claude-opus-5')
    expect(parseUserSpecifiedModel('opus[1m]')).toBe('claude-opus-5[1m]')
    expect(parseUserSpecifiedModel('claude-opus-4-8')).toBe('claude-opus-4-8')
    expect(renderDefaultModelSetting('opusplan')).toBe('Opus 5 in plan mode, else Sonnet 5')
  })

  test('preserves explicit provider overrides and third-party defaults', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://provider.example.invalid'
    process.env.ANTHROPIC_API_KEY = 'fixture-key'
    expect(getDefaultOpusModel()).toBe('claude-opus-4-7')
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'provider-custom-opus'
    expect(parseUserSpecifiedModel('opus')).toBe('provider-custom-opus')
  })

  test('describes the Opus alias with its actual resolved generation', () => {
    expect(getOpus46_1MOption().description).toContain('Opus 5')
    expect(getMaxOpus46_1MOption().description).toContain('Opus 5')
    process.env.ANTHROPIC_BASE_URL = 'https://provider.example.invalid'
    process.env.ANTHROPIC_API_KEY = 'fixture-key'
    expect(getOpus46_1MOption().description).toContain('Opus 4.7')
  })

  test('recognizes Opus 5 throughout canonicalization, public display, and attribution', () => {
    expect(firstPartyNameToCanonical('anthropic.claude-opus-5')).toBe('claude-opus-5')
    expect(isNonCustomOpusModel('claude-opus-5')).toBe(true)
    expect(getPublicModelDisplayName('claude-opus-5')).toBe('Opus 5')
    expect(getPublicModelDisplayName('claude-opus-5[1m]')).toBe('Opus 5 (1M context)')
    expect(getMarketingNameForModel('claude-opus-5[1m]')).toBe('Opus 5 (with 1M context)')
    expect(sanitizeModelName('claude-opus-5')).toBe('claude-opus-5')
  })
})
