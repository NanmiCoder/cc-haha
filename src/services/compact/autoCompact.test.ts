import { describe, expect, test, beforeEach, afterEach } from 'bun:test'

import {
  estimateFallbackFixedContextTokens,
  getAutoCompactThreshold,
  getEffectiveContextWindowSize,
  getPostCompactPromptTokens,
  getRapidRefillDecision,
  shouldAutoCompact,
} from './autoCompact.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { MODEL_CONTEXT_WINDOWS_ENV_KEY } from '../../utils/model/modelContextWindows.js'

let originalAutoCompactWindow: string | undefined
let originalContextWindows: string | undefined
let originalDisableCompact: string | undefined
let originalDisableAutoCompact: string | undefined

beforeEach(() => {
  originalAutoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  originalContextWindows = process.env[MODEL_CONTEXT_WINDOWS_ENV_KEY]
  originalDisableCompact = process.env.DISABLE_COMPACT
  originalDisableAutoCompact = process.env.DISABLE_AUTO_COMPACT
  delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  delete process.env[MODEL_CONTEXT_WINDOWS_ENV_KEY]
  delete process.env.DISABLE_COMPACT
  delete process.env.DISABLE_AUTO_COMPACT
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
  if (originalDisableCompact === undefined) {
    delete process.env.DISABLE_COMPACT
  } else {
    process.env.DISABLE_COMPACT = originalDisableCompact
  }
  if (originalDisableAutoCompact === undefined) {
    delete process.env.DISABLE_AUTO_COMPACT
  } else {
    process.env.DISABLE_AUTO_COMPACT = originalDisableAutoCompact
  }
})

describe('model context window resolution', () => {
  test('uses built-in windows for current third-party coding models', () => {
    expect(getContextWindowForModel('deepseek-v4-pro')).toBe(1_000_000)
    expect(getContextWindowForModel('MiniMax-M2.7')).toBe(204_800)
    expect(getContextWindowForModel('k3')).toBe(262_144)
    expect(getContextWindowForModel('k3[1m]')).toBe(1_000_000)
    expect(getContextWindowForModel('kimi-k2.6')).toBe(262_144)
    expect(getContextWindowForModel('zai-org/GLM-5.2')).toBe(1_000_000)
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

  test('per-model configured window wins over the [1m] marker (#1162)', () => {
    process.env[MODEL_CONTEXT_WINDOWS_ENV_KEY] = JSON.stringify({
      k3: 262_144,
    })

    // The [1m] suffix gets appended automatically by provider settings; an
    // explicitly configured window states the model's real limit and must win,
    // otherwise auto-compact aims at 1M and the provider hard-caps first.
    expect(getContextWindowForModel('k3[1m]')).toBe(262_144)
    expect(getAutoCompactThreshold('k3[1m]')).toBe(229_144)
  })

  test('[1m] marker still wins over built-in table entries', () => {
    // claude-sonnet-4-6 is 200K in the built-in table; [1m] is the official
    // extended-context opt-in and must not be capped by that entry.
    expect(getContextWindowForModel('claude-sonnet-4-6[1m]')).toBe(1_000_000)
  })

  test('global auto compact window can only lower models with a known window (#1162)', () => {
    // k3 is 262,144 in the built-in table — a leftover 1M global override
    // (e.g. from another provider preset) must not raise it past the
    // provider's hard cap.
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '1000000'
    expect(getEffectiveContextWindowSize('k3')).toBe(262_144 - 20_000)

    // Lowering still works for known models.
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '100000'
    expect(getEffectiveContextWindowSize('k3')).toBe(100_000 - 20_000)

    // [1m]-marked models count as known and can only be lowered too.
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '500000'
    expect(getEffectiveContextWindowSize('unknown-future-model[1m]')).toBe(
      500_000 - 20_000,
    )

    // Codex-catalog models count as known: a leftover 1M must not raise them.
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '1000000'
    const withOverride = getEffectiveContextWindowSize('gpt-5.5')
    delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
    expect(withOverride).toBe(getEffectiveContextWindowSize('gpt-5.5'))
  })

  test('derives auto-compact thresholds from provider context windows', () => {
    expect(getAutoCompactThreshold('deepseek-v4-pro')).toBe(967_000)
    expect(getAutoCompactThreshold('zai-org/GLM-5.2')).toBe(967_000)
    expect(getAutoCompactThreshold('glm-5.1')).toBe(167_000)
    expect(getAutoCompactThreshold('glm-4.5-air')).toBe(95_000)
    expect(getAutoCompactThreshold('kimi-k2.6')).toBe(229_144)
    expect(getAutoCompactThreshold('MiniMax-M2.7')).toBe(171_800)
    expect(getAutoCompactThreshold('gpt-5.6-terra')).toBe(320_400)
  })

  test('scales compaction headroom for small context windows', async () => {
    process.env[MODEL_CONTEXT_WINDOWS_ENV_KEY] = JSON.stringify({
      'custom-16k': 16_000,
      'custom-32k': 32_000,
      'custom-33k': 33_000,
      'custom-64k': 64_000,
      'custom-80k': 80_000,
    })

    expect(getEffectiveContextWindowSize('custom-16k')).toBe(12_000)
    expect(getEffectiveContextWindowSize('custom-32k')).toBe(24_000)
    expect(getEffectiveContextWindowSize('custom-33k')).toBe(24_750)
    expect(getEffectiveContextWindowSize('custom-64k')).toBe(48_000)

    expect(getAutoCompactThreshold('custom-16k')).toBe(8_000)
    expect(getAutoCompactThreshold('custom-32k')).toBe(16_000)
    expect(getAutoCompactThreshold('custom-33k')).toBe(16_500)
    expect(getAutoCompactThreshold('custom-64k')).toBe(35_000)
    // Once the fixed reserves fit, retain the existing large-window behavior.
    expect(getAutoCompactThreshold('custom-80k')).toBe(47_000)

    for (const model of [
      'custom-16k',
      'custom-32k',
      'custom-33k',
      'custom-64k',
    ]) {
      expect(await shouldAutoCompact([], model)).toBe(false)
    }

    const messagesAt = (tokens: number) => [{
      type: 'assistant',
      message: {
        model: 'custom-16k',
        content: [{ type: 'text', text: 'done' }],
        usage: {
          input_tokens: tokens - 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }] as never
    expect(await shouldAutoCompact(messagesAt(7_999), 'custom-16k'))
      .toBe(false)
    expect(await shouldAutoCompact(messagesAt(8_000), 'custom-16k'))
      .toBe(true)
  })

  test('includes fixed request context when a relay omits usable usage', async () => {
    process.env[MODEL_CONTEXT_WINDOWS_ENV_KEY] = JSON.stringify({
      'custom-16k': 16_000,
    })
    const messages = [{
      type: 'user',
      message: { content: 'm'.repeat(28_000) },
    }] as never
    const fixedTokens = estimateFallbackFixedContextTokens({
      systemPrompt: ['s'.repeat(8_000)],
      systemContext: {},
      userContext: {},
      toolUseContext: { options: { tools: [] } },
    } as never)

    expect(fixedTokens).toBeGreaterThanOrEqual(2_000)
    expect(await shouldAutoCompact(messages, 'custom-16k')).toBe(false)
    expect(await shouldAutoCompact(
      messages,
      'custom-16k',
      undefined,
      0,
      fixedTokens,
    )).toBe(true)
  })

  test('crosses the GPT-5.6 threshold without recounting encrypted siblings', async () => {
    const responseId = 'msg_threshold'
    const messagesAt = (tokens: number) => [
      {
        type: 'assistant',
        message: {
          id: responseId,
          model: 'gpt-5.6-terra',
          content: [{
            type: 'redacted_thinking',
            data: `cc-haha:openai-reasoning:v1:${JSON.stringify({
              summary: [],
              encrypted_content: 'x'.repeat(400_000),
            })}`,
          }],
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      },
      {
        type: 'assistant',
        message: {
          id: responseId,
          model: 'gpt-5.6-terra',
          content: [{ type: 'text', text: 'done' }],
          usage: {
            input_tokens: tokens - 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      },
    ] as never

    expect(await shouldAutoCompact(messagesAt(320_399), 'gpt-5.6-terra'))
      .toBe(false)
    expect(await shouldAutoCompact(messagesAt(320_400), 'gpt-5.6-terra'))
      .toBe(true)
  })
})

describe('rapid-refill breaker (#1544)', () => {
  const THRESHOLD = 67_000
  const afterCompact = (turnCounter: number, consecutiveRapidRefills: number) => ({
    compacted: true,
    turnId: 'turn',
    turnCounter,
    consecutiveRapidRefills,
  })
  const boundary = { type: 'system', subtype: 'compact_boundary', content: 'compacted' }
  const assistantWithPrompt = (promptTokens: number) => ({
    type: 'assistant',
    message: {
      model: 'custom-100k',
      content: [{ type: 'text', text: 'done' }],
      usage: {
        input_tokens: promptTokens - 60_000 > 0 ? promptTokens - 60_000 : promptTokens,
        output_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: promptTokens - 60_000 > 0 ? 60_000 : 0,
      },
    },
  })

  test('counts a refill only when the compaction left most of the threshold in use', () => {
    expect(getRapidRefillDecision(undefined, undefined, THRESHOLD))
      .toEqual({ trip: false, consecutiveRapidRefills: 0 })

    // Compaction freed nothing that matters: 84K of a 67K threshold.
    expect(getRapidRefillDecision(afterCompact(1, 0), 84_000, THRESHOLD))
      .toEqual({ trip: false, consecutiveRapidRefills: 1 })
    expect(getRapidRefillDecision(afterCompact(1, 2), 84_000, THRESHOLD))
      .toEqual({ trip: true, consecutiveRapidRefills: 3 })
    // Right at the 75% line still counts; just below it does not.
    expect(getRapidRefillDecision(afterCompact(1, 0), 50_250, THRESHOLD).consecutiveRapidRefills).toBe(1)
    expect(getRapidRefillDecision(afterCompact(1, 2), 50_249, THRESHOLD))
      .toEqual({ trip: false, consecutiveRapidRefills: 0 })
    // A compaction that held for 3 turns resets the streak.
    expect(getRapidRefillDecision(afterCompact(3, 2), 84_000, THRESHOLD))
      .toEqual({ trip: false, consecutiveRapidRefills: 0 })
    // No usage: keep the loop guard.
    expect(getRapidRefillDecision(afterCompact(1, 2), undefined, THRESHOLD))
      .toEqual({ trip: true, consecutiveRapidRefills: 3 })
  })

  // Schedules recorded from real DeepSeek Flash runs with a 100K compaction
  // window (threshold 67K). Each entry is how many turns passed before the
  // next compaction, and the first post-compact prompt size.
  const replay = (schedule: Array<[turnsSincePrevious: number, postCompactPrompt: number]>) => {
    let tracking: ReturnType<typeof afterCompact> | undefined
    const outcomes: string[] = []
    for (const [turns, postCompactPrompt] of schedule) {
      if (tracking) tracking.turnCounter = turns
      const decision = getRapidRefillDecision(tracking, tracking ? postCompactPrompt : undefined, THRESHOLD)
      outcomes.push(decision.trip ? 'trip' : 'compact')
      if (decision.trip) break
      tracking = afterCompact(0, decision.consecutiveRapidRefills)
    }
    return outcomes
  }

  test('keeps compacting a small window that large reads refill, because each compaction frees most of it', () => {
    // repro-win100k: four 25K-token reads per turn, ~26K left after each compaction.
    expect(replay([[0, 0], [5, 26_000], [2, 26_000], [2, 26_000], [2, 26_000], [2, 26_000], [2, 26_000]]))
      .toEqual(['compact', 'compact', 'compact', 'compact', 'compact', 'compact', 'compact'])
  })

  test('stops when the fixed context alone fills the threshold after every compaction', () => {
    // repro-heavyprefix: ~57K CLAUDE.md, 84-90K in use right after each compaction.
    expect(replay([[0, 0], [1, 84_700], [1, 87_300], [1, 89_600], [1, 92_000]]))
      .toEqual(['compact', 'compact', 'compact', 'trip'])
  })

  test('reads the prompt size of the first request after the latest compaction', () => {
    expect(getPostCompactPromptTokens([assistantWithPrompt(90_000)] as never)).toBeUndefined()
    expect(getPostCompactPromptTokens([
      assistantWithPrompt(150_000),
      boundary,
      { type: 'user', message: { content: 'summary' } },
      { ...assistantWithPrompt(0), message: { ...assistantWithPrompt(0).message, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
      assistantWithPrompt(84_000),
      assistantWithPrompt(95_000),
    ] as never)).toBe(84_000)
  })
})
