import { describe, expect, test } from 'bun:test'

import {
  findModelMaxOutputTokens,
  getConfiguredOrBuiltInModelContextWindow,
  getModelContextWindowFromEnvValue,
} from './modelContextWindows.js'

describe('model context windows', () => {
  test('recognizes updated domestic coding model context windows', () => {
    expect(getConfiguredOrBuiltInModelContextWindow('k3')).toBe(262_144)
    expect(getConfiguredOrBuiltInModelContextWindow('k3[1m]')).toBe(262_144)
    expect(getConfiguredOrBuiltInModelContextWindow('kimi-for-coding')).toBe(262_144)
    expect(getConfiguredOrBuiltInModelContextWindow('kimi-for-coding-highspeed')).toBe(262_144)
    expect(getConfiguredOrBuiltInModelContextWindow('kimi-k2.7-code')).toBe(262_144)
    expect(getConfiguredOrBuiltInModelContextWindow('kimi-k2.7-code-highspeed')).toBe(262_144)
    expect(getConfiguredOrBuiltInModelContextWindow('glm-5.3')).toBe(1_000_000)
    expect(getConfiguredOrBuiltInModelContextWindow('glm-5.3-flash[1m]')).toBe(1_000_000)
    expect(getConfiguredOrBuiltInModelContextWindow('zai-org/glm-5.3-flash')).toBe(1_000_000)
    expect(getConfiguredOrBuiltInModelContextWindow('glm-5.2')).toBe(1_000_000)
    expect(getConfiguredOrBuiltInModelContextWindow('glm-4.7')).toBe(200_000)
    expect(getConfiguredOrBuiltInModelContextWindow('qwen/qwen3.6-27b')).toBe(262_144)
    expect(getConfiguredOrBuiltInModelContextWindow('qwen3.6:27b')).toBe(262_144)
    expect(getConfiguredOrBuiltInModelContextWindow('qwen3.7-plus-2026-02-15')).toBe(1_000_000)
    expect(getConfiguredOrBuiltInModelContextWindow('qwen3-coder-plus')).toBe(1_000_000)
    expect(getConfiguredOrBuiltInModelContextWindow('qwen3-coder-next')).toBe(262_144)
    expect(getConfiguredOrBuiltInModelContextWindow('deepseek-ai/deepseek-v4-pro')).toBe(1_000_000)
  })

  test('matches configured base model windows for Claude Code 1m aliases', () => {
    expect(getModelContextWindowFromEnvValue(
      'MiniMax-M3[1m]',
      JSON.stringify({ 'MiniMax-M3': 1_000_000 }),
    )).toBe(1_000_000)
    expect(getModelContextWindowFromEnvValue(
      'glm-5.2[1m]',
      JSON.stringify({ 'glm-5.2': 1_000_000 }),
    )).toBe(1_000_000)
  })

  test('finds the reply limit saved on a provider the way configured windows are matched', () => {
    const limits = { 'MiniMax-M3': 8_192, 'glm-5.3-flash': 16_384, tiny: 100 }

    expect(findModelMaxOutputTokens('MiniMax-M3[1m]', limits)).toBe(8_192)
    expect(findModelMaxOutputTokens('zai-org/glm-5.3-flash', limits)).toBe(16_384)
    // Below the accepted minimum, or not listed at all: no limit.
    expect(findModelMaxOutputTokens('tiny', limits)).toBeUndefined()
    expect(findModelMaxOutputTokens('deepseek-flash', limits)).toBeUndefined()
    expect(findModelMaxOutputTokens('deepseek-flash', undefined)).toBeUndefined()
  })
})
