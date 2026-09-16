import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getContextWindowForModel, modelSupports1M } from '../context.js'
import { computeSimpleEnvInfo } from '../../constants/prompts.js'
import { SKILL_MODEL_VARS } from '../../skills/bundled/claudeApiContent.js'
import { sanitizeModelName } from '../commitAttribution.js'
import { getHardcodedTeammateModelFallback } from '../swarm/teammateModel.js'
import { getAgentModel, getAgentModelOptions } from './agent.js'
import { isModelAlias, isModelFamilyAlias } from './aliases.js'
import {
  CLAUDE_FABLE_5_1_CONFIG,
  CLAUDE_FABLE_5_CONFIG,
  CLAUDE_OPUS_4_6_CONFIG,
  CLAUDE_OPUS_4_8_CONFIG,
  CLAUDE_SONNET_5_CONFIG,
} from './configs.js'
import {
  firstPartyNameToCanonical,
  getDefaultFableModel,
  getMarketingNameForModel,
  getPublicModelDisplayName,
  parseUserSpecifiedModel,
  renderDefaultModelSetting,
} from './model.js'
import { getModelStrings } from './modelStrings.js'
import { getModelOptions } from './modelOptions.js'
import { get3PModelCapabilityOverride } from './modelSupportOverrides.js'

const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_SUBAGENT_MODEL',
] as const

let originalEnv: Record<(typeof ENV_KEYS)[number], string | undefined>

beforeEach(() => {
  originalEnv = Object.fromEntries(
    ENV_KEYS.map(key => [key, process.env[key]]),
  ) as typeof originalEnv
  for (const key of ENV_KEYS) delete process.env[key]
  clearCapabilityCache()
})

afterEach(() => {
  for (const key of ENV_KEYS) restoreEnv(key, originalEnv[key])
  clearCapabilityCache()
})

describe('Fable model configuration', () => {
  test('uses the official provider IDs', () => {
    expect(CLAUDE_FABLE_5_1_CONFIG).toEqual({
      firstParty: 'claude-fable-5-1',
      bedrock: 'anthropic.claude-fable-5-1',
      vertex: 'claude-fable-5-1',
      foundry: 'claude-fable-5-1',
      azureOpenAI: 'claude-fable-5-1',
    })
    expect(getModelStrings().fable51).toBe('claude-fable-5-1')
    expect(CLAUDE_FABLE_5_CONFIG).toEqual({
      firstParty: 'claude-fable-5',
      bedrock: 'anthropic.claude-fable-5',
      vertex: 'claude-fable-5',
      foundry: 'claude-fable-5',
      azureOpenAI: 'claude-fable-5',
    })
    expect(CLAUDE_OPUS_4_8_CONFIG).toEqual({
      firstParty: 'claude-opus-4-8',
      bedrock: 'anthropic.claude-opus-4-8',
      vertex: 'claude-opus-4-8',
      foundry: 'claude-opus-4-8',
      azureOpenAI: 'claude-opus-4-8',
    })
    expect(CLAUDE_SONNET_5_CONFIG).toEqual({
      firstParty: 'claude-sonnet-5',
      bedrock: 'anthropic.claude-sonnet-5',
      vertex: 'claude-sonnet-5',
      foundry: 'claude-sonnet-5',
      azureOpenAI: 'claude-sonnet-5',
    })
  })

  test('recognizes fable as an alias and model family', () => {
    expect(isModelAlias('fable')).toBe(true)
    expect(isModelAlias('fable[1m]')).toBe(true)
    expect(isModelFamilyAlias('fable')).toBe(true)
  })

  test('resolves the alias without changing unrelated model defaults', () => {
    expect(getDefaultFableModel()).toBe(getModelStrings().fable5)
    expect(parseUserSpecifiedModel('fable')).toBe(getModelStrings().fable5)

    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL = 'provider-owned-fable'

    expect(getDefaultFableModel()).toBe('provider-owned-fable')
    expect(parseUserSpecifiedModel('fable')).toBe('provider-owned-fable')
    expect(parseUserSpecifiedModel('fable[1m]')).toBe(
      'provider-owned-fable[1m]',
    )
  })

  test('normalizes and renders the public model name', () => {
    expect(
      firstPartyNameToCanonical('us.anthropic.claude-fable-5-v1:0'),
    ).toBe('claude-fable-5')
    expect(getPublicModelDisplayName(getModelStrings().fable5)).toBe('Fable 5')
    expect(getMarketingNameForModel('claude-fable-5[1m]')).toBe(
      'Fable 5 (with 1M context)',
    )
    expect(firstPartyNameToCanonical('anthropic.claude-opus-4-8')).toBe(
      'claude-opus-4-8',
    )
    expect(firstPartyNameToCanonical('claude-sonnet-5')).toBe(
      'claude-sonnet-5',
    )
    expect(getPublicModelDisplayName(getModelStrings().opus48)).toBe('Opus 4.8')
    expect(getPublicModelDisplayName(`${getModelStrings().opus48}[1m]`)).toBe(
      'Opus 4.8 (1M context)',
    )
    expect(getPublicModelDisplayName(getModelStrings().sonnet50)).toBe('Sonnet 5')
    expect(getPublicModelDisplayName(`${getModelStrings().sonnet50}[1m]`)).toBe(
      'Sonnet 5 (1M context)',
    )
    expect(getMarketingNameForModel('claude-opus-4-8')).toBe('Opus 4.8')
    expect(getMarketingNameForModel('claude-sonnet-5')).toBe('Sonnet 5')
    expect(renderDefaultModelSetting('opusplan')).toBe(
      'Opus 4.8 in plan mode, else Sonnet 5',
    )
  })

  test('keeps Fable 5.1 identity distinct from the Fable 5 default', () => {
    expect(firstPartyNameToCanonical('us.anthropic.claude-fable-5-1-v1:0')).toBe(
      'claude-fable-5-1',
    )
    expect(getPublicModelDisplayName('claude-fable-5-1')).toBe('Fable 5.1')
    expect(getPublicModelDisplayName('claude-fable-5-1[1m]')).toBe('Fable 5.1 (1M context)')
    expect(getMarketingNameForModel('claude-fable-5-1[1m]')).toBe(
      'Fable 5.1 (with 1M context)',
    )
    expect(parseUserSpecifiedModel('fable')).toBe('claude-fable-5')
    expect(parseUserSpecifiedModel('claude-fable-5-1')).toBe('claude-fable-5-1')
    expect(modelSupports1M('claude-fable-5-1')).toBe(true)
    expect(getContextWindowForModel('claude-fable-5-1')).toBe(1_000_000)
  })

  test('does not recommend downgrading a pinned Fable 5.1 to the Fable 5 alias', () => {
    process.env.ANTHROPIC_API_KEY = 'test-api-key'
    process.env.ANTHROPIC_MODEL = 'claude-fable-5-1'
    expect(getModelOptions()).toContainEqual({
      value: 'claude-fable-5-1',
      label: 'Fable 5.1',
      description: 'claude-fable-5-1',
    })
  })

  test('publishes current model IDs and knowledge cutoffs in environment context', async () => {
    expect(SKILL_MODEL_VARS).toMatchObject({
      OPUS_ID: 'claude-opus-4-8',
      OPUS_NAME: 'Claude Opus 4.8',
      SONNET_ID: 'claude-sonnet-5',
      SONNET_NAME: 'Claude Sonnet 5',
    })

    for (const model of ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5']) {
      const info = await computeSimpleEnvInfo(model)
      expect(info).toContain('Assistant knowledge cutoff is January 2026.')
      expect(info).toContain("Fable 5: 'claude-fable-5'")
      expect(info).toContain("Opus 4.8: 'claude-opus-4-8'")
      expect(info).toContain("Sonnet 5: 'claude-sonnet-5'")
      expect(info).toContain('same Claude Opus 4.8 model')
    }
  })

  test('sanitizes new model trailers and keeps teammate fallbacks provider-safe', () => {
    expect(sanitizeModelName('claude-fable-5-1-experimental')).toBe('claude-fable-5-1')
    expect(sanitizeModelName('claude-fable-5-experimental')).toBe('claude-fable-5')
    expect(sanitizeModelName('claude-opus-4-8-experimental')).toBe('claude-opus-4-8')
    expect(sanitizeModelName('claude-sonnet-5-experimental')).toBe('claude-sonnet-5')
    expect(getHardcodedTeammateModelFallback()).toBe('claude-opus-4-8')

    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(getHardcodedTeammateModelFallback()).toBe(
      CLAUDE_OPUS_4_6_CONFIG.bedrock,
    )
  })

  test('exposes the native 1M context window', () => {
    expect(modelSupports1M('claude-fable-5')).toBe(true)
    expect(getContextWindowForModel('claude-fable-5')).toBe(1_000_000)
    expect(getContextWindowForModel('anthropic/claude-fable-5')).toBe(1_000_000)
    expect(getContextWindowForModel('claude-opus-4-8')).toBe(1_000_000)
    expect(getContextWindowForModel('claude-sonnet-5')).toBe(1_000_000)
  })
})

describe('Fable agent resolution', () => {
  test('offers and resolves fable for agents', () => {
    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL = 'provider-owned-fable'

    expect(getAgentModelOptions()).toContainEqual({
      value: 'fable',
      label: 'Fable',
      description: 'Most capable for complex agent tasks',
    })
    expect(
      getAgentModel('fable', 'claude-sonnet-4-6', undefined, 'default'),
    ).toBe('provider-owned-fable')
    expect(
      getAgentModel(
        'inherit',
        'claude-fable-5-custom-deployment',
        'fable',
        'default',
      ),
    ).toBe('claude-fable-5-custom-deployment')
  })

  test('reads capability overrides from the fable environment tier', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://provider.example.test'
    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL = 'provider-owned-fable'
    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES =
      'effort, xhigh_effort'
    clearCapabilityCache()

    expect(
      get3PModelCapabilityOverride('provider-owned-fable', 'effort'),
    ).toBe(true)
    expect(
      get3PModelCapabilityOverride('provider-owned-fable', 'xhigh_effort'),
    ).toBe(true)
    expect(
      get3PModelCapabilityOverride('provider-owned-fable', 'max_effort'),
    ).toBe(false)
  })
})

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

function clearCapabilityCache(): void {
  ;(get3PModelCapabilityOverride as typeof get3PModelCapabilityOverride & {
    cache?: { clear?: () => void }
  }).cache?.clear?.()
}
