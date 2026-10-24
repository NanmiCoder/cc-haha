import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  isLikelyClaudeModel,
  isWebSearchEnabledForModel,
  markAnthropicNativeUnsupported,
  resolveWebSearchProvider,
  shouldFallbackFromNativeError,
} from './backend.js'

describe('WebSearch backend resolver', () => {
  const originalBaseUrl = process.env.ANTHROPIC_BASE_URL
  beforeEach(() => { process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic' })
  afterEach(() => {
    if (originalBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = originalBaseUrl
  })

  test('auto mode enables DeepSeek native search without external keys', () => {
    for (const model of ['deepseek-flash', 'deepseek-flash[1m]', 'deepseek-v4-pro', 'DeepSeek-V4.1-Flash-1017']) {
      expect(resolveWebSearchProvider(model, { mode: 'auto' }).provider).toBe('anthropic')
      expect(isWebSearchEnabledForModel(model, { mode: 'auto' })).toBe(true)
    }
    expect(resolveWebSearchProvider('deepseek-flash', { mode: 'disabled' }).provider).toBe('disabled')
    expect(resolveWebSearchProvider('not-deepseek-flash', { mode: 'auto' }).provider).toBe('disabled')
    expect(resolveWebSearchProvider('deepseek-flash', { mode: 'tavily', tavilyApiKey: 'fake' }).provider).toBe('tavily')
    expect(resolveWebSearchProvider('deepseek-flash', { mode: 'anthropic' }).provider).toBe('anthropic')
  })

  test('does not send native schemas to DeepSeek models routed through OpenAI Chat or another endpoint', () => {
    for (const endpoint of ['http://127.0.0.1:3456/proxy/providers/fixture', 'https://opencode.ai/zen/go/v1', 'https://api.deepseek.com/v1', 'https://api.deepseek.com.example.invalid/anthropic']) {
      process.env.ANTHROPIC_BASE_URL = endpoint
      expect(resolveWebSearchProvider('deepseek-flash', { mode: 'auto' }).provider).toBe('disabled')
      expect(resolveWebSearchProvider('deepseek-flash', { mode: 'anthropic' }).provider).toBe('disabled')
      expect(resolveWebSearchProvider('deepseek-flash', { mode: 'auto', tavilyApiKey: 'fake' }).provider).toBe('tavily')
    }
  })

  test('DeepSeek native search retains unsupported-endpoint fallback', () => {
    const model = 'deepseek-fixture-unsupported'
    expect(resolveWebSearchProvider(model, { mode: 'auto' }).provider).toBe('anthropic')
    markAnthropicNativeUnsupported(model)
    expect(resolveWebSearchProvider(model, { mode: 'auto', tavilyApiKey: 'fake' }).provider).toBe('tavily')
    expect(resolveWebSearchProvider(model, { mode: 'auto' }).provider).toBe('disabled')
  })

  test('detects Claude models by model name instead of provider URL', () => {
    expect(isLikelyClaudeModel('claude-sonnet-4-5')).toBe(true)
    expect(isLikelyClaudeModel('anthropic/claude-3-7-sonnet')).toBe(true)
    expect(isLikelyClaudeModel('anthropic.claude-opus-4-1')).toBe(true)
    expect(isLikelyClaudeModel('MiniMax-M2.7-highspeed')).toBe(false)
  })

  test('auto mode prefers native Anthropic web search for Claude model names', () => {
    expect(
      resolveWebSearchProvider('anthropic/claude-3-7-sonnet', {
        mode: 'auto',
        tavilyApiKey: 'tvly-key',
        braveApiKey: 'brave-key',
      }).provider,
    ).toBe('anthropic')
  })

  test('auto mode keeps WebSearch available for non-Claude models with fallback keys', () => {
    expect(
      resolveWebSearchProvider('gpt-5.4', {
        mode: 'auto',
        tavilyApiKey: 'tvly-key',
        braveApiKey: 'brave-key',
      }).provider,
    ).toBe('tavily')

    expect(
      resolveWebSearchProvider('gpt-5.4', {
        mode: 'auto',
        braveApiKey: 'brave-key',
      }).provider,
    ).toBe('brave')
  })

  test('explicit provider modes require their API key', () => {
    expect(resolveWebSearchProvider('gpt-5.4', { mode: 'tavily' }).provider).toBe(
      'disabled',
    )
    expect(
      resolveWebSearchProvider('gpt-5.4', {
        mode: 'brave',
        braveApiKey: 'brave-key',
      }).provider,
    ).toBe('brave')
  })

  test('isEnabled reflects native Claude or external fallback availability', () => {
    expect(isWebSearchEnabledForModel('claude-sonnet-4-5', { mode: 'auto' })).toBe(
      true,
    )
    expect(
      isWebSearchEnabledForModel('qwen3-coder', {
        mode: 'auto',
        tavilyApiKey: 'tvly-key',
      }),
    ).toBe(true)
    expect(isWebSearchEnabledForModel('qwen3-coder', { mode: 'auto' })).toBe(
      false,
    )
  })

  test('falls back on native tool schema/provider mismatch errors', () => {
    expect(
      shouldFallbackFromNativeError(
        new Error('422 Extra inputs are not permitted: web_search_20250305'),
      ),
    ).toBe(true)
    expect(shouldFallbackFromNativeError(new Error('network timeout'))).toBe(
      false,
    )
  })
})
