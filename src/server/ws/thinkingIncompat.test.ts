import { describe, expect, it } from 'vitest'
import { detectThinkingIncompatMessage } from './handler'

/**
 * The detection regex is what gates whether cc-haha sticky-marks a
 * provider as thinking-incompatible. False positives would permanently
 * disable thinking on the wrong provider until the user edits its
 * config, so we keep the patterns narrow. These tests pin the
 * boundaries so future "let me catch one more case" tweaks don't widen
 * the net unintentionally.
 */
describe('detectThinkingIncompatMessage', () => {
  it('matches Bedrock additionalModelRequestFields rejections', () => {
    const samples = [
      'API error 400: This model does not support `additionalModelRequestFields`',
      'request body malformed; additionalModelRequestFields not allowed for this model',
      '{"type":"invalid_request_error","message":"该模型不支持 additionalModelRequestFields 字段"}',
    ]
    for (const s of samples) {
      expect(detectThinkingIncompatMessage(s)).toBe(true)
    }
  })

  it('matches explicit thinking-rejection phrases', () => {
    const samples = [
      'thinking is not supported by this model',
      'thinking parameter is unsupported',
      'thinking is invalid for this provider',
      'thinking field rejected by upstream',
      'thinking has been disabled by gateway',
      'unknown field "thinking" — please remove it',
    ]
    for (const s of samples) {
      expect(detectThinkingIncompatMessage(s)).toBe(true)
    }
  })

  it('does not match unrelated 4xx errors', () => {
    const samples = [
      'API error 400: invalid api key',
      'rate limit exceeded',
      'context window exceeded',
      'this model does not support tool use',
      'authentication failed',
      'malformed JSON in request body',
    ]
    for (const s of samples) {
      expect(detectThinkingIncompatMessage(s)).toBe(false)
    }
  })

  it('does not match passing mentions of thinking that are not rejections', () => {
    const samples = [
      'Reasoning: thinking through the problem step by step',
      'I am thinking about your request',
      'Step-by-step thinking complete; here is the answer',
      'Adaptive thinking budget reached its cap',
    ]
    for (const s of samples) {
      expect(detectThinkingIncompatMessage(s)).toBe(false)
    }
  })

  it('handles null / undefined / empty defensively', () => {
    expect(detectThinkingIncompatMessage(undefined)).toBe(false)
    expect(detectThinkingIncompatMessage(null)).toBe(false)
    expect(detectThinkingIncompatMessage('')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(detectThinkingIncompatMessage('THINKING IS NOT SUPPORTED')).toBe(true)
    expect(detectThinkingIncompatMessage('AdditionalModelRequestFields rejected')).toBe(true)
  })
})
