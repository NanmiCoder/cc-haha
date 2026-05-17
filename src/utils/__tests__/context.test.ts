import { describe, expect, test } from 'bun:test'
import { calculateCurrentContextTokenTotal } from '../context.js'

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
})
