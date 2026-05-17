import { describe, expect, test } from 'bun:test'
import { calculateUSDCost } from '../../utils/modelCost.js'
import { EMPTY_USAGE, normalizeUsage } from './emptyUsage.js'

describe('normalizeUsage', () => {
  test('fills missing provider usage with zero-valued usage', () => {
    expect(normalizeUsage(undefined)).toEqual(EMPTY_USAGE)
  })

  test('preserves reported token fields while defaulting missing nested fields', () => {
    expect(
      normalizeUsage({
        input_tokens: 12,
        output_tokens: 5,
        cache_read_input_tokens: 3,
      }),
    ).toEqual({
      ...EMPTY_USAGE,
      input_tokens: 12,
      output_tokens: 5,
      cache_read_input_tokens: 3,
    })
  })

  test('keeps cost calculation safe for provider responses without usage', () => {
    expect(() =>
      calculateUSDCost('anthropic/claude-opus-4.7', normalizeUsage(undefined)),
    ).not.toThrow()
  })
})
