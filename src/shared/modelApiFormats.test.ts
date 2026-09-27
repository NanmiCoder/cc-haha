import { describe, expect, test } from 'bun:test'

import { resolveModelApiFormat, type ModelApiFormatRule } from './modelApiFormats.js'

type Format = 'anthropic' | 'openai_chat' | 'openai_responses'

/**
 * The rules the OpenCode Go preset ships. Kept in sync with
 * providerPresets.json by provider-presets.test.ts; duplicated here so the
 * matcher is exercised against the shape it is actually used with.
 */
const OPENCODE_GO_RULES: ModelApiFormatRule<Format>[] = [
  { prefixes: ['grok-', 'gpt-', 'muse-spark-'], apiFormat: 'openai_responses' },
  { prefixes: ['minimax-', 'qwen', 'union-alpha'], apiFormat: 'anthropic' },
]

describe('resolveModelApiFormat', () => {
  test('returns undefined without rules so callers fall back to the provider format', () => {
    expect(resolveModelApiFormat(undefined, 'glm-5.3')).toBeUndefined()
    expect(resolveModelApiFormat([], 'glm-5.3')).toBeUndefined()
  })

  test('returns undefined for a model matching no rule', () => {
    expect(resolveModelApiFormat(OPENCODE_GO_RULES, 'glm-5.3')).toBeUndefined()
    expect(resolveModelApiFormat(OPENCODE_GO_RULES, 'kimi-k3')).toBeUndefined()
    expect(resolveModelApiFormat(OPENCODE_GO_RULES, 'deepseek-v4-pro')).toBeUndefined()
  })

  test('returns undefined for a missing or blank model instead of throwing', () => {
    expect(resolveModelApiFormat(OPENCODE_GO_RULES, undefined)).toBeUndefined()
    expect(resolveModelApiFormat(OPENCODE_GO_RULES, null)).toBeUndefined()
    expect(resolveModelApiFormat(OPENCODE_GO_RULES, '   ')).toBeUndefined()
  })

  test('matches case-insensitively and tolerates surrounding whitespace', () => {
    expect(resolveModelApiFormat(OPENCODE_GO_RULES, '  MiniMax-M3 ')).toBe('anthropic')
    expect(resolveModelApiFormat(OPENCODE_GO_RULES, 'GROK-4.6')).toBe('openai_responses')
  })

  test('matches a prefix rather than a whole token', () => {
    // `qwen` must cover the versioned ids, which are the only qwen names that exist.
    expect(resolveModelApiFormat(OPENCODE_GO_RULES, 'qwen3.8-max')).toBe('anthropic')
    expect(resolveModelApiFormat(OPENCODE_GO_RULES, 'qwen3.6-plus')).toBe('anthropic')
    expect(resolveModelApiFormat(OPENCODE_GO_RULES, 'minimax-m2.7')).toBe('anthropic')
  })

  test('the first matching rule wins', () => {
    const rules: ModelApiFormatRule<Format>[] = [
      { prefixes: ['shared-'], apiFormat: 'openai_responses' },
      { prefixes: ['shared-'], apiFormat: 'anthropic' },
    ]
    expect(resolveModelApiFormat(rules, 'shared-model')).toBe('openai_responses')

    const reversed: ModelApiFormatRule<Format>[] = [...rules].reverse()
    expect(resolveModelApiFormat(reversed, 'shared-model')).toBe('anthropic')
  })

  test('ignores blank prefixes instead of matching everything', () => {
    const rules: ModelApiFormatRule<Format>[] = [
      { prefixes: ['', '   '], apiFormat: 'openai_responses' },
      { prefixes: ['glm-'], apiFormat: 'anthropic' },
    ]
    expect(resolveModelApiFormat(rules, 'anything')).toBeUndefined()
    expect(resolveModelApiFormat(rules, 'glm-5.3')).toBe('anthropic')
  })

  /**
   * Every model the live `/zen/go/v1/models` listing returned, mapped to the
   * endpoint it must use. A model is only listed under a non-default endpoint
   * when sending it elsewhere was observed to fail, so this table is the contract
   * the preset has to satisfy — swapping the rule groups turns it red.
   */
  test('maps the live OpenCode Go catalogue to the endpoints it actually serves', () => {
    const chat = [
      'glm-5', 'glm-5.1', 'glm-5.2', 'glm-5.3', 'glm-5.3-flash',
      'kimi-k2.5', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k3',
      'deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash',
      'deepseek-v4.1-flash', 'deepseek-v4-flash-vision-exp',
      'mimo-v2-pro', 'mimo-v2-omni', 'mimo-v2.5', 'mimo-v2.5-pro',
      'longcat-2.0', 'hy3', 'hy3-preview', 'hy4-preview', 'omen-alpha',
    ]
    const anthropic = [
      'minimax-m2.5', 'minimax-m2.7', 'minimax-m3',
      'qwen3.5-plus', 'qwen3.6-plus', 'qwen3.7-max', 'qwen3.7-plus',
      'qwen3.8-flash', 'qwen3.8-max', 'union-alpha',
    ]
    const responses = [
      'grok-4.5', 'grok-4.6', 'gpt-5.6-luna',
      'muse-spark-1.2-contributor', 'muse-spark-1.3-contributor',
    ]

    for (const model of chat) {
      expect(resolveModelApiFormat(OPENCODE_GO_RULES, model), model).toBeUndefined()
    }
    for (const model of anthropic) {
      expect(resolveModelApiFormat(OPENCODE_GO_RULES, model), model).toBe('anthropic')
    }
    for (const model of responses) {
      expect(resolveModelApiFormat(OPENCODE_GO_RULES, model), model).toBe('openai_responses')
    }
  })

  test('still resolves when the model carries a context-suffix marker', () => {
    // The capability env is computed before `[1m]` is stripped, so rules must
    // survive the suffix rather than depending on the bare id.
    expect(resolveModelApiFormat(OPENCODE_GO_RULES, 'minimax-m3[1m]')).toBe('anthropic')
  })
})
