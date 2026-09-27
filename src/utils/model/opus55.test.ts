import { describe, expect, test } from 'bun:test'
import { sanitizeModelName } from '../commitAttribution.js'
import { getContextWindowForModel, getModelMaxOutputTokens } from '../context.js'
import {
  getDefaultEffortForModel,
  modelSupportsMaxEffort,
  modelSupportsXHighEffort,
} from '../effort.js'
import { calculateCostFromTokens, getModelPricingString } from '../modelCost.js'
import {
  modelRequiresThinking,
  modelSupportsAdaptiveThinking,
  modelUsesBoundThinking,
} from '../thinking.js'
import { ALL_MODEL_CONFIGS } from './configs.js'
import {
  firstPartyNameToCanonical,
  getMarketingNameForModel,
  getPublicModelDisplayName,
  isNonCustomOpusModel,
  parseUserSpecifiedModel,
} from './model.js'

describe('Opus 5.5 official runtime contract', () => {
  test('registers a distinct identity without rewriting explicitly pinned models', () => {
    expect(Object.values(ALL_MODEL_CONFIGS).some(config => config.firstParty === 'claude-opus-5-5')).toBe(true)
    for (const model of ['claude-opus-5-5', 'claude-opus-5-5[1m]', 'us.anthropic.claude-opus-5-5']) {
      expect(firstPartyNameToCanonical(model)).toBe('claude-opus-5-5')
      expect(sanitizeModelName(model)).toBe('claude-opus-5-5')
    }
    expect(isNonCustomOpusModel('claude-opus-5-5')).toBe(true)
    expect(parseUserSpecifiedModel('claude-opus-5-5')).toBe('claude-opus-5-5')
    expect(parseUserSpecifiedModel('claude-opus-5')).toBe('claude-opus-5')
    expect(getPublicModelDisplayName('claude-opus-5-5')).toBe('Opus 5.5')
    expect(getPublicModelDisplayName('claude-opus-5-5[1m]')).toBe('Opus 5.5 (1M context)')
    expect(getMarketingNameForModel('claude-opus-5-5[1m]')).toBe('Opus 5.5 (with 1M context)')
  })

  test('matches official token limits and always-on adaptive thinking without Fable history binding', () => {
    expect(getContextWindowForModel('claude-opus-5-5')).toBe(1_000_000)
    expect(getModelMaxOutputTokens('claude-opus-5-5')).toEqual({ default: 128_000, upperLimit: 128_000 })
    expect(getModelMaxOutputTokens('claude-opus-5')).toEqual({ default: 64_000, upperLimit: 128_000 })
    expect(modelRequiresThinking('claude-opus-5-5')).toBe(true)
    expect(modelRequiresThinking('claude-opus-5')).toBe(false)
    expect(modelSupportsAdaptiveThinking('claude-opus-5-5')).toBe(true)
    expect(modelUsesBoundThinking('claude-opus-5-5')).toBe(false)
    expect(getDefaultEffortForModel('claude-opus-5-5')).toBe('medium')
    expect(modelSupportsMaxEffort('claude-opus-5-5')).toBe(true)
    expect(modelSupportsXHighEffort('claude-opus-5-5')).toBe(true)
  })

  test('uses the published $4/$20 pricing and $0.20 cached reads', () => {
    expect(getModelPricingString('claude-opus-5-5')).toBe('$4/$20 per Mtok')
    for (const model of ['claude-opus-5-5', 'claude-opus-5-5[1m]', 'us.anthropic.claude-opus-5-5']) {
      expect(calculateCostFromTokens(model, {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
      })).toBe(29.2)
    }
  })
})
