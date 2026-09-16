import { describe, expect, test } from 'bun:test'
import { calculateCostFromTokens, getModelPricingString } from './modelCost.js'

describe('Fable 5.1 query costs', () => {
  const cacheReads = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 1_000_000,
    cacheCreationInputTokens: 0,
  }

  test('charges $0.25 per million cached tokens for Fable 5.1', () => {
    for (const model of [
      'claude-fable-5-1',
      'claude-fable-5-1[1m]',
      'us.anthropic.claude-fable-5-1-v1:0',
    ]) {
      expect(calculateCostFromTokens(model, cacheReads)).toBe(0.25)
    }
    expect(calculateCostFromTokens('claude-fable-5', cacheReads)).toBe(1)
  })

  test('keeps input, output and cache-write pricing at the published rates', () => {
    expect(calculateCostFromTokens('claude-fable-5-1', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
    })).toBe(72.75)
    expect(getModelPricingString('claude-fable-5-1')).toBe('$10/$50 per Mtok')
  })
})
