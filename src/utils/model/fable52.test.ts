import { describe, expect, test } from 'bun:test'
import { sanitizeModelName } from '../commitAttribution.js'
import { getContextWindowForModel, getModelMaxOutputTokens } from '../context.js'
import {
  getDefaultEffortForModel,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  modelSupportsXHighEffort,
} from '../effort.js'
import { calculateCostFromTokens, getModelPricingString } from '../modelCost.js'
import {
  modelRejectsManualThinking,
  modelRequiresThinking,
  modelSupportsAdaptiveThinking,
  modelUsesBoundThinking,
} from '../thinking.js'
import { ALL_MODEL_CONFIGS } from './configs.js'
import { firstPartyNameToCanonical, parseUserSpecifiedModel } from './model.js'

// Values follow https://platform.claude.com/docs/en/models/fable-5-2/overview and the
// official Claude Code model catalog (default effort medium, 128K default output).
describe('Fable 5.2 official runtime contract', () => {
  test('is registered and never rewrites an explicitly pinned Fable', () => {
    expect(Object.values(ALL_MODEL_CONFIGS).some(config => config.firstParty === 'claude-fable-5-2')).toBe(true)
    for (const model of ['claude-fable-5-2', 'claude-fable-5-2[1m]', 'us.anthropic.claude-fable-5-2']) {
      expect(firstPartyNameToCanonical(model)).toBe('claude-fable-5-2')
      expect(sanitizeModelName(model)).toBe('claude-fable-5-2')
    }
    expect(parseUserSpecifiedModel('claude-fable-5-2')).toBe('claude-fable-5-2')
    expect(parseUserSpecifiedModel('claude-fable-5-1')).toBe('claude-fable-5-1')
    expect(parseUserSpecifiedModel('claude-fable-5')).toBe('claude-fable-5')
  })

  test('has a 1M window, 128K output and always-on adaptive thinking', () => {
    expect(getContextWindowForModel('claude-fable-5-2')).toBe(1_000_000)
    expect(getModelMaxOutputTokens('claude-fable-5-2')).toEqual({ default: 128_000, upperLimit: 128_000 })
    // The earlier Fable releases keep their own limits.
    expect(getModelMaxOutputTokens('claude-fable-5-1')).toEqual({ default: 64_000, upperLimit: 128_000 })
    expect(modelRequiresThinking('claude-fable-5-2')).toBe(true)
    expect(modelSupportsAdaptiveThinking('claude-fable-5-2')).toBe(true)
    expect(modelRejectsManualThinking('claude-fable-5-2')).toBe(true)
  })

  test('binds replayed thinking like Fable 5.1, and not like Fable 5 or Opus 5.5', () => {
    // On 5.2 the prefix check applies to every account: a replayed stale block without
    // prefix_mismatch_behavior is a 400, so the drop_block control must be sent.
    expect(modelUsesBoundThinking('claude-fable-5-2')).toBe(true)
    expect(modelUsesBoundThinking('claude-fable-5-2[1m]')).toBe(true)
    expect(modelUsesBoundThinking('us.anthropic.claude-fable-5-2')).toBe(true)
    expect(modelUsesBoundThinking('claude-fable-5-1')).toBe(true)
    expect(modelUsesBoundThinking('claude-fable-5')).toBe(false)
    expect(modelUsesBoundThinking('claude-opus-5-5')).toBe(false)
  })

  test('supports every effort level and defaults Claude Code to medium', () => {
    expect(modelSupportsEffort('claude-fable-5-2')).toBe(true)
    expect(modelSupportsMaxEffort('claude-fable-5-2')).toBe(true)
    expect(modelSupportsXHighEffort('claude-fable-5-2')).toBe(true)
    expect(getDefaultEffortForModel('claude-fable-5-2')).toBe('medium')
    expect(getDefaultEffortForModel('claude-fable-5-2[1m]')).toBe('medium')
    // 5.1 keeps the API default (high), which is not sent explicitly.
    expect(getDefaultEffortForModel('claude-fable-5-1')).toBeUndefined()
  })

  test('uses the published $8/$40 pricing and $0.20 cached reads', () => {
    expect(getModelPricingString('claude-fable-5-2')).toBe('$8/$40 per Mtok')
    for (const model of ['claude-fable-5-2', 'claude-fable-5-2[1m]', 'us.anthropic.claude-fable-5-2']) {
      // 8 input + 40 output + 0.2 cache read + 10 five-minute cache write
      expect(calculateCostFromTokens(model, {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
      })).toBe(58.2)
    }
  })
})
