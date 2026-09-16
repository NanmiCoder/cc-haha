import { describe, expect, it } from 'bun:test'
import {
  estimateCostUSD,
  isBillableUsageRecord,
  resolveModelCosts,
} from './usageAccounting.js'

const ONE_MILLION = 1_000_000

function tokens(overrides: Partial<Parameters<typeof estimateCostUSD>[1]> = {}) {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    ...overrides,
  }
}

describe('resolveModelCosts', () => {
  it('prices every Claude family the app can run', () => {
    expect(resolveModelCosts('claude-opus-5')).toMatchObject({
      inputTokens: 5,
      outputTokens: 25,
      promptCacheReadTokens: 0.5,
      promptCacheWriteTokens: 6.25,
    })
    expect(resolveModelCosts('claude-opus-4-8')?.inputTokens).toBe(5)
    expect(resolveModelCosts('claude-opus-4-1')?.inputTokens).toBe(15)
    expect(resolveModelCosts('claude-fable-5')?.outputTokens).toBe(50)
    expect(resolveModelCosts('claude-sonnet-5')?.outputTokens).toBe(15)
    expect(resolveModelCosts('claude-haiku-4-5')?.outputTokens).toBe(5)
  })

  it('sees through the decorations gateways and dated snapshots add', () => {
    const opus = resolveModelCosts('claude-opus-4-8')
    expect(resolveModelCosts('claude-opus-4-8-r')).toEqual(opus!)
    expect(resolveModelCosts('CLAUDE-OPUS-4-8')).toEqual(opus!)
    expect(resolveModelCosts('anthropic/claude-opus-4-8')).toEqual(opus!)
    expect(resolveModelCosts('claude-haiku-4-5-20251001')?.outputTokens).toBe(5)
  })

  it('picks the longest matching prefix rather than the first', () => {
    // `claude-opus-4-1` bills at the old Opus tier; a bare `claude-opus-4` must not swallow it.
    expect(resolveModelCosts('claude-opus-4-1')?.inputTokens).toBe(15)
    expect(resolveModelCosts('claude-opus-4-5')?.inputTokens).toBe(5)
  })

  it('returns null for third-party models instead of guessing Claude rates', () => {
    for (const model of [
      'k3',
      'glm-5.2',
      'MiniMax-M3',
      'deepseek-v4-flash',
      'kimi-k2.7-code',
      'gpt-5.6-sol',
      'grok-4.5',
      'google/gemini-3.6-flash',
      'doubao-seed-2.0-code',
      '<synthetic>',
      '',
      '   ',
    ]) {
      expect(resolveModelCosts(model)).toBeNull()
    }
  })

  it('bills fast mode at its own rate only where fast mode exists', () => {
    expect(resolveModelCosts('claude-opus-5', 'fast')?.inputTokens).toBe(10)
    expect(resolveModelCosts('claude-opus-5', 'standard')?.inputTokens).toBe(5)
    // Sonnet has no fast mode — a stray `speed` must not change what it costs.
    expect(resolveModelCosts('claude-sonnet-5', 'fast')?.inputTokens).toBe(3)
  })
})

describe('isBillableUsageRecord', () => {
  it('rejects usage inherited from the source transcript of a fork', () => {
    expect(isBillableUsageRecord({
      messageId: 'msg_inherited',
      requestId: 'req_inherited',
      forkedFrom: {
        sessionId: 'source-session',
        messageUuid: 'source-assistant',
      },
    })).toBe(false)
  })

  it('does not reject an unrelated or malformed provenance value', () => {
    expect(isBillableUsageRecord({ messageId: 'msg_new' })).toBe(true)
    expect(isBillableUsageRecord({
      messageId: 'msg_new',
      forkedFrom: { sessionId: 'source-session' },
    })).toBe(true)
  })
})

describe('estimateCostUSD', () => {
  it('uses the reduced Fable 5.1 cache-read rate without changing Fable 5', () => {
    const cacheReads = tokens({ cacheReadInputTokens: ONE_MILLION })
    expect(estimateCostUSD('claude-fable-5-1', cacheReads)).toBe(0.25)
    expect(estimateCostUSD('anthropic/claude-fable-5-1-20260825', cacheReads)).toBe(0.25)
    expect(estimateCostUSD('claude-fable-5', cacheReads)).toBe(1)
    expect(estimateCostUSD('claude-fable-5-1', tokens({
      inputTokens: ONE_MILLION,
      outputTokens: ONE_MILLION,
      cacheReadInputTokens: ONE_MILLION,
      cacheCreationInputTokens: ONE_MILLION,
    }))).toBe(72.75)
  })

  it('bills each token bucket at its own rate', () => {
    const cost = estimateCostUSD('claude-opus-5', tokens({
      inputTokens: ONE_MILLION,
      outputTokens: ONE_MILLION,
      cacheReadInputTokens: ONE_MILLION,
      cacheCreationInputTokens: ONE_MILLION,
    }))
    // 5 input + 25 output + 0.50 cache read + 6.25 cache write
    expect(cost).toBeCloseTo(36.75, 10)
  })

  it('prices cache reads at a tenth of input, which is why token totals overstate spend', () => {
    const cacheRead = estimateCostUSD('claude-opus-5', tokens({ cacheReadInputTokens: ONE_MILLION }))
    const input = estimateCostUSD('claude-opus-5', tokens({ inputTokens: ONE_MILLION }))
    expect(cacheRead).toBeCloseTo(input! / 10, 10)
  })

  it('charges per web search request', () => {
    expect(estimateCostUSD('claude-opus-5', { ...tokens(), webSearchRequests: 100 }))
      .toBeCloseTo(1, 10)
  })

  it('returns null — never zero — for an unpriceable model', () => {
    const cost = estimateCostUSD('glm-5.2', tokens({
      inputTokens: ONE_MILLION,
      outputTokens: ONE_MILLION,
    }))
    // A zero here would silently understate spend for anyone on third-party providers; callers
    // must be able to tell "no rates published" apart from "this turn was free".
    expect(cost).toBeNull()
  })

  it('costs nothing for a zeroed usage record on a known model', () => {
    expect(estimateCostUSD('claude-opus-5', tokens())).toBe(0)
  })
})
