import { describe, expect, test, beforeEach, afterEach } from 'bun:test'

import {
  getAutoCompactThreshold,
  getEffectiveContextWindowSize,
  isContextExhausted,
  isIneffectiveCompaction,
  shouldThrottleAutoCompact,
  type AutoCompactTrackingState,
} from './autoCompact.js'
import type { CompactionResult } from './compact.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { MODEL_CONTEXT_WINDOWS_ENV_KEY } from '../../utils/model/modelContextWindows.js'

let originalAutoCompactWindow: string | undefined
let originalContextWindows: string | undefined

beforeEach(() => {
  originalAutoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  originalContextWindows = process.env[MODEL_CONTEXT_WINDOWS_ENV_KEY]
  delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  delete process.env[MODEL_CONTEXT_WINDOWS_ENV_KEY]
})

afterEach(() => {
  if (originalAutoCompactWindow === undefined) {
    delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  } else {
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = originalAutoCompactWindow
  }
  if (originalContextWindows === undefined) {
    delete process.env[MODEL_CONTEXT_WINDOWS_ENV_KEY]
  } else {
    process.env[MODEL_CONTEXT_WINDOWS_ENV_KEY] = originalContextWindows
  }
})

describe('model context window resolution', () => {
  test('uses built-in windows for current third-party coding models', () => {
    expect(getContextWindowForModel('deepseek-v4-pro')).toBe(1_000_000)
    expect(getContextWindowForModel('MiniMax-M2.7')).toBe(204_800)
    expect(getContextWindowForModel('kimi-k2.6')).toBe(262_144)
    expect(getContextWindowForModel('glm-5.1')).toBe(200_000)
    expect(getContextWindowForModel('glm-4.5-air')).toBe(128_000)
  })

  test('uses Codex OAuth effective context windows for OpenAI GPT models', () => {
    expect(getContextWindowForModel('gpt-5.5')).toBe(258_400)
    expect(getContextWindowForModel('gpt-5.4')).toBe(950_000)
    expect(getContextWindowForModel('gpt-5.4-mini')).toBe(258_400)
    expect(getContextWindowForModel('gpt-5.3-codex-spark')).toBe(121_600)
  })

  test('uses per-model provider overrides before built-in defaults', () => {
    process.env[MODEL_CONTEXT_WINDOWS_ENV_KEY] = JSON.stringify({
      'deepseek-v4-pro': 500_000,
      'custom-model': 300_000,
    })

    expect(getContextWindowForModel('deepseek-v4-pro')).toBe(500_000)
    expect(getContextWindowForModel('provider/custom-model')).toBe(300_000)
  })

  test('global auto compact window can raise unknown models above the default', () => {
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '1000000'

    expect(getEffectiveContextWindowSize('unknown-future-model')).toBe(980_000)
  })

  test('derives auto-compact thresholds from provider context windows', () => {
    expect(getAutoCompactThreshold('deepseek-v4-pro')).toBe(967_000)
    expect(getAutoCompactThreshold('glm-5.1')).toBe(167_000)
    expect(getAutoCompactThreshold('glm-4.5-air')).toBe(95_000)
    expect(getAutoCompactThreshold('kimi-k2.6')).toBe(229_144)
    expect(getAutoCompactThreshold('MiniMax-M2.7')).toBe(171_800)
  })
})

function makeTracking(
  overrides: Partial<AutoCompactTrackingState> = {},
): AutoCompactTrackingState {
  return {
    compacted: true,
    turnId: 'turn-1',
    turnCounter: 0,
    ...overrides,
  }
}

function makeCompactionResult(
  truePostCompactTokenCount: number | undefined,
): CompactionResult {
  // Only the field the predicate reads matters for these tests.
  return { truePostCompactTokenCount } as unknown as CompactionResult
}

describe('方案2: shouldThrottleAutoCompact (turn throttle)', () => {
  test('throttles for the first few turns after a compaction', () => {
    expect(shouldThrottleAutoCompact(makeTracking({ turnCounter: 0 }), false)).toBe(true)
    expect(shouldThrottleAutoCompact(makeTracking({ turnCounter: 1 }), false)).toBe(true)
    expect(shouldThrottleAutoCompact(makeTracking({ turnCounter: 2 }), false)).toBe(true)
  })

  test('stops throttling once enough turns have elapsed', () => {
    expect(shouldThrottleAutoCompact(makeTracking({ turnCounter: 3 }), false)).toBe(false)
    expect(shouldThrottleAutoCompact(makeTracking({ turnCounter: 9 }), false)).toBe(false)
  })

  test('never throttles at the hard blocking limit, even right after a compaction', () => {
    expect(shouldThrottleAutoCompact(makeTracking({ turnCounter: 0 }), true)).toBe(false)
  })

  test('does not throttle when no compaction has happened yet', () => {
    expect(shouldThrottleAutoCompact(undefined, false)).toBe(false)
    expect(
      shouldThrottleAutoCompact(makeTracking({ compacted: false, turnCounter: 0 }), false),
    ).toBe(false)
  })
})

describe('方案1: isIneffectiveCompaction (recompaction-loop guard)', () => {
  // deepseek-v4-pro: autocompact threshold is 967_000 (see math tests above).
  const model = 'deepseek-v4-pro'
  const threshold = getAutoCompactThreshold(model)

  test('flags a compaction whose result is still at/above the threshold', () => {
    expect(isIneffectiveCompaction(makeCompactionResult(threshold), model)).toBe(true)
    expect(isIneffectiveCompaction(makeCompactionResult(threshold + 50_000), model)).toBe(true)
  })

  test('treats a compaction that got under the threshold as effective', () => {
    expect(isIneffectiveCompaction(makeCompactionResult(threshold - 1), model)).toBe(false)
    expect(isIneffectiveCompaction(makeCompactionResult(10_000), model)).toBe(false)
  })

  test('treats an unknown post-compact size as effective (no false circuit-break)', () => {
    expect(isIneffectiveCompaction(makeCompactionResult(undefined), model)).toBe(false)
  })
})

describe('方案3: isContextExhausted (suggest-new-session signal)', () => {
  const model = 'deepseek-v4-pro'
  const threshold = getAutoCompactThreshold(model)

  test('signals exhaustion only once the circuit breaker has tripped AND context is still over', () => {
    expect(isContextExhausted(makeTracking({ consecutiveFailures: 3 }), threshold + 1, model)).toBe(true)
  })

  test('does not signal while the circuit breaker has headroom', () => {
    expect(isContextExhausted(makeTracking({ consecutiveFailures: 2 }), threshold + 1, model)).toBe(false)
    expect(isContextExhausted(makeTracking({ consecutiveFailures: 0 }), threshold + 1, model)).toBe(false)
    expect(isContextExhausted(undefined, threshold + 1, model)).toBe(false)
  })

  test('does not signal if the context has somehow dropped back under threshold', () => {
    expect(isContextExhausted(makeTracking({ consecutiveFailures: 5 }), threshold - 1, model)).toBe(false)
  })
})
