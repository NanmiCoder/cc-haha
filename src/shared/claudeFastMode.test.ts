import { describe, expect, test } from 'bun:test'
import {
  CLAUDE_FAST_MODE_SUPPORTED_MODELS_DISPLAY,
  isClaudeFastModeSupportedModel,
  normalizeClaudeFastModeModelId,
} from './claudeFastMode.js'

describe('claudeFastMode', () => {
  test('normalizes suffixes and provider prefixes', () => {
    expect(normalizeClaudeFastModeModelId('claude-opus-5-5[1m]')).toBe('claude-opus-5-5')
    expect(normalizeClaudeFastModeModelId('claude-opus-4-6-20260205')).toBe('claude-opus-4-6')
    expect(normalizeClaudeFastModeModelId('us.anthropic.claude-opus-5-5-v1:0')).toBe('claude-opus-5-5')
    expect(normalizeClaudeFastModeModelId('anthropic.claude-fable-5-2')).toBe('claude-fable-5-2')
    expect(normalizeClaudeFastModeModelId('  OPUS[1m]  ')).toBe('opus')
  })

  test('recognizes fast-mode supported Claude models and aliases', () => {
    for (const model of [
      'claude-opus-5-5',
      'claude-opus-5-5[1m]',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-opus-4-6',
      'claude-opus-4-6-20260205',
      'claude-fable-5-2',
      'claude-fable-5-2[1m]',
      'claude-mythos-5-2',
      'opus',
      'opus[1m]',
      'fable',
      'best',
    ]) {
      expect(isClaudeFastModeSupportedModel(model)).toBe(true)
    }
  })

  test('rejects unsupported Claude and third-party models', () => {
    for (const model of [
      '',
      null,
      undefined,
      'claude-sonnet-5-5',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-haiku-5-5',
      'claude-haiku-4-5',
      'claude-opus-4-5-20251101',
      'claude-opus-4-7',
      'claude-opus-4-1-20250805',
      'claude-fable-5',
      'claude-fable-5-1',
      'sonnet',
      'haiku',
      'gpt-5.4',
      'deepseek-chat',
    ]) {
      expect(isClaudeFastModeSupportedModel(model)).toBe(false)
    }
  })

  test('exports a non-empty supported models display string', () => {
    expect(CLAUDE_FAST_MODE_SUPPORTED_MODELS_DISPLAY).toContain('Opus 5.5')
    expect(CLAUDE_FAST_MODE_SUPPORTED_MODELS_DISPLAY).toContain('Fable 5.2')
  })
})
