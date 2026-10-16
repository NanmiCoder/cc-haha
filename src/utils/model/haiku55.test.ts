import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearOAuthTokenCache } from '../auth.js'
import { sanitizeModelName } from '../commitAttribution.js'
import {
  getContextWindowForModel,
  getModelMaxOutputTokens,
  modelSupports1M,
} from '../context.js'
import {
  getDefaultEffortForModel,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  modelSupportsXHighEffort,
} from '../effort.js'
import { calculateCostFromTokens } from '../modelCost.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import {
  modelRejectsManualThinking,
  modelRequiresThinking,
  modelSupportsAdaptiveThinking,
  modelSupportsThinking,
} from '../thinking.js'
import { estimateCostUSD } from '../usageAccounting.js'
import { ALL_MODEL_CONFIGS } from './configs.js'
import {
  firstPartyNameToCanonical,
  getDefaultHaikuModel,
  getMarketingNameForModel,
  getPublicModelDisplayName,
  parseUserSpecifiedModel,
} from './model.js'
import { get3PModelCapabilityOverride } from './modelSupportOverrides.js'

const envKeys = [
  'HOME',
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
] as const
let savedEnv: (string | undefined)[]
let temporaryHome: string

function clearCapabilityCache() {
  ;(get3PModelCapabilityOverride as typeof get3PModelCapabilityOverride & {
    cache?: { clear?: () => void }
  }).cache?.clear?.()
}

beforeEach(() => {
  savedEnv = envKeys.map(key => process.env[key])
  for (const key of envKeys) delete process.env[key]
  temporaryHome = mkdtempSync(join(tmpdir(), 'haiku55-model-test-'))
  process.env.HOME = temporaryHome
  process.env.CLAUDE_CONFIG_DIR = join(temporaryHome, 'config')
  resetSettingsCache()
  clearOAuthTokenCache()
  clearCapabilityCache()
})

afterEach(() => {
  resetSettingsCache()
  clearOAuthTokenCache()
  clearCapabilityCache()
  rmSync(temporaryHome, { recursive: true, force: true })
  envKeys.forEach((key, index) => {
    const value = savedEnv[index]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  })
})

const HAIKU_55_VARIANTS = [
  'claude-haiku-5-5',
  'claude-haiku-5-5[1m]',
  'us.anthropic.claude-haiku-5-5',
  'anthropic.claude-haiku-5-5',
]

describe('Haiku 5.5 identity', () => {
  test('keeps its own canonical name instead of collapsing to a bare family', () => {
    expect(ALL_MODEL_CONFIGS.haiku55.firstParty).toBe('claude-haiku-5-5')
    for (const model of HAIKU_55_VARIANTS) {
      expect(firstPartyNameToCanonical(model)).toBe('claude-haiku-5-5')
      expect(sanitizeModelName(model)).toBe('claude-haiku-5-5')
    }
    expect(firstPartyNameToCanonical('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5')
  })

  test('renders public and marketing names', () => {
    expect(getPublicModelDisplayName('claude-haiku-5-5')).toBe('Haiku 5.5')
    expect(getPublicModelDisplayName('claude-haiku-5-5[1m]')).toBe('Haiku 5.5 (1M context)')
    expect(getMarketingNameForModel('claude-haiku-5-5')).toBe('Haiku 5.5')
    expect(getMarketingNameForModel('claude-haiku-5-5[1m]')).toBe('Haiku 5.5 (with 1M context)')
  })
})

// https://platform.claude.com/docs/en/models/overview (checked 2026-10-15).
describe('Haiku 5.5 runtime limits, effort and thinking', () => {
  test('exposes the native 1M window and the 128K output limit', () => {
    for (const model of HAIKU_55_VARIANTS) {
      expect(modelSupports1M(model)).toBe(true)
    }
    expect(getContextWindowForModel('claude-haiku-5-5')).toBe(1_000_000)
    expect(getModelMaxOutputTokens('claude-haiku-5-5').upperLimit).toBe(128_000)
    expect(getModelMaxOutputTokens('claude-haiku-4-5').upperLimit).toBe(64_000)
  })

  test('supports every effort level and defaults to medium', () => {
    expect(modelSupportsEffort('claude-haiku-5-5')).toBe(true)
    expect(modelSupportsXHighEffort('claude-haiku-5-5')).toBe(true)
    expect(modelSupportsMaxEffort('claude-haiku-5-5')).toBe(true)
    expect(getDefaultEffortForModel('claude-haiku-5-5')).toBe('medium')
    expect(modelSupportsEffort('claude-haiku-4-5')).toBe(false)
  })

  test('uses adaptive thinking, rejects budgets, but may still be disabled', () => {
    expect(modelSupportsThinking('claude-haiku-5-5')).toBe(true)
    expect(modelSupportsAdaptiveThinking('claude-haiku-5-5')).toBe(true)
    expect(modelRejectsManualThinking('claude-haiku-5-5')).toBe(true)
    expect(modelRequiresThinking('claude-haiku-5-5')).toBe(false)
    expect(modelRejectsManualThinking('claude-haiku-4-5')).toBe(false)
  })
})

// https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-15), $ per MTok.
describe('Haiku 5.5 prompt-length pricing', () => {
  const million = (prompt: { input: number, read?: number, write?: number }) => ({
    inputTokens: prompt.input,
    outputTokens: 1_000_000,
    cacheReadInputTokens: prompt.read ?? 0,
    cacheCreationInputTokens: prompt.write ?? 0,
  })

  test.each([
    ['prompt at the threshold', million({ input: 100_000 }), 0.1 * 0.1 + 0.5],
    ['prompt over the threshold', million({ input: 100_001 }), 0.100001 * 0.5 + 2.5],
    // Cache reads and writes count toward prompt length too.
    [
      'cache pushing the prompt over',
      million({ input: 1, read: 60_000, write: 40_000 }),
      0.000001 * 0.5 + 0.06 * 0.05 + 0.04 * 0.625 + 2.5,
    ],
  ])('prices a %s identically in both cost tables', (_label, tokens, expected) => {
    expect(calculateCostFromTokens('claude-haiku-5-5', tokens)).toBeCloseTo(expected, 10)
    expect(estimateCostUSD('claude-haiku-5-5', tokens)).toBeCloseTo(expected, 10)
  })

  test('keeps flat pricing for other models', () => {
    const tokens = million({ input: 500_000 })
    expect(estimateCostUSD('claude-haiku-4-5', tokens)).toBeCloseTo(0.5 + 5, 10)
  })
})

describe('Haiku alias resolution', () => {
  test('resolves the haiku alias to Haiku 5.5 on first party', () => {
    expect(getDefaultHaikuModel()).toBe('claude-haiku-5-5')
    expect(parseUserSpecifiedModel('haiku')).toBe('claude-haiku-5-5')
    expect(parseUserSpecifiedModel('claude-haiku-4-5')).toBe('claude-haiku-4-5')
  })

  test('keeps the lag-safe Haiku 4.5 default on third-party providers', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://provider.example.invalid'
    process.env.ANTHROPIC_API_KEY = 'fixture-key'
    expect(getDefaultHaikuModel()).toBe('claude-haiku-4-5-20251001')
  })
})
