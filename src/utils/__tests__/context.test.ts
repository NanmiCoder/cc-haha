import { describe, expect, test } from 'bun:test'
import { calculateCurrentContextTokenTotal, getContextWindowForModel, getModelMaxOutputTokens, modelSupports1M } from '../context.js'

describe('calculateCurrentContextTokenTotal', () => {
  test('includes assistant output tokens in the current context total', () => {
    expect(calculateCurrentContextTokenTotal(26_000, {
      input_tokens: 24_000,
      cache_creation_input_tokens: 1_000,
      cache_read_input_tokens: 1_000,
      output_tokens: 3_000,
    })).toBe(29_000)
  })

  test('keeps the local estimate as a lower bound when provider usage is smaller', () => {
    expect(calculateCurrentContextTokenTotal(29_000, {
      input_tokens: 24_000,
      cache_creation_input_tokens: 1_000,
      cache_read_input_tokens: 1_000,
      output_tokens: 0,
    })).toBe(29_000)
  })

  test('clamps to contextWindow when total would exceed it', () => {
    // DeepSeek scenario: input_tokens already near 1M limit, adding output pushes over
    expect(calculateCurrentContextTokenTotal(990_000, {
      input_tokens: 995_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 8_000,
    }, 1_000_000)).toBe(1_000_000)
  })

  test('does not clamp when total is within contextWindow', () => {
    expect(calculateCurrentContextTokenTotal(26_000, {
      input_tokens: 24_000,
      cache_creation_input_tokens: 1_000,
      cache_read_input_tokens: 1_000,
      output_tokens: 3_000,
    }, 200_000)).toBe(29_000)
  })

  test('without contextWindow arg behaves as before — no clamping', () => {
    // Passing no contextWindow should not clamp, preserving backward compatibility
    expect(calculateCurrentContextTokenTotal(990_000, {
      input_tokens: 995_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 8_000,
    })).toBe(1_003_000)
  })

  test('returns estimatedTokens when currentUsage is null', () => {
    expect(calculateCurrentContextTokenTotal(50_000, null)).toBe(50_000)
    expect(calculateCurrentContextTokenTotal(50_000, null, 200_000)).toBe(50_000)
  })

  test('ignores suspicious media usage that appears to count encoded bytes', () => {
    expect(calculateCurrentContextTokenTotal(30_000, {
      input_tokens: 220_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 1_000,
    }, 200_000, { hasMediaInput: true, usageTrust: 'low' })).toBe(30_000)
  })

  test('keeps high provider usage for media when it is close to local estimate', () => {
    expect(calculateCurrentContextTokenTotal(180_000, {
      input_tokens: 195_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 5_000,
    }, 200_000, { hasMediaInput: true, usageTrust: 'high' })).toBe(200_000)
  })

  test('includes canonical messages added after the provider usage anchor', () => {
    expect(calculateCurrentContextTokenTotal(100_000, {
      input_tokens: 290_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 10_000,
      output_tokens: 1_000,
    }, 353_400, { canonicalTokens: 310_000 })).toBe(310_000)
  })

  test('does not restore ignored low-trust media usage through canonical tokens', () => {
    expect(calculateCurrentContextTokenTotal(30_000, {
      input_tokens: 220_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 1_000,
    }, 200_000, {
      hasMediaInput: true,
      usageTrust: 'low',
      canonicalTokens: 221_000,
    })).toBe(30_000)
  })
})

test('Opus 5 uses its native context and output limits', () => {
  expect(modelSupports1M('claude-opus-5')).toBe(true)
  expect(getContextWindowForModel('claude-opus-5')).toBe(1_000_000)
  expect(getContextWindowForModel('anthropic/claude-opus-5')).toBe(1_000_000)
  expect(getModelMaxOutputTokens('claude-opus-5')).toEqual({ default: 64_000, upperLimit: 128_000 })
})
