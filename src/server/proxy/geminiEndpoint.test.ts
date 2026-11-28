import { describe, expect, test } from 'bun:test'

import {
  buildGeminiEndpoint,
  buildVertexAnthropicEndpoint,
  isVertexAnthropicTarget,
  isVertexEndpointUrl,
  normalizeGeminiModelName,
} from './geminiEndpoint.js'

describe('normalizeGeminiModelName', () => {
  test('strips an optional models/ or publishers/{publisher}/models/ prefix and surrounding whitespace', () => {
    expect(normalizeGeminiModelName('models/gemini-2.5-pro')).toBe('gemini-2.5-pro')
    expect(normalizeGeminiModelName('  MODELS/devin/gemini-4-neon  ')).toBe('devin/gemini-4-neon')
    expect(normalizeGeminiModelName('publishers/anthropic/models/claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
    expect(normalizeGeminiModelName('  PUBLISHERS/google/MODELS/gemini-2.5-pro  ')).toBe('gemini-2.5-pro')
    expect(normalizeGeminiModelName('opencode-go/hungerg-free')).toBe('opencode-go/hungerg-free')
  })
})

describe('buildGeminiEndpoint', () => {
  test('appends /v1beta to bare roots and local gateways', () => {
    expect(buildGeminiEndpoint('https://generativelanguage.googleapis.com', 'gemini-2.5-pro', false))
      .toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent')
    expect(buildGeminiEndpoint('http://127.0.0.1:3425/', 'devin/gemini-4-neon', true))
      .toBe('http://127.0.0.1:3425/v1beta/models/devin/gemini-4-neon:streamGenerateContent?alt=sse')
  })

  test('preserves existing versioned paths without doubling /v1beta', () => {
    expect(buildGeminiEndpoint('https://opencode.ai/inference/go/google/v1beta', 'gemini-4-argon-contributor', false))
      .toBe('https://opencode.ai/inference/go/google/v1beta/models/gemini-4-argon-contributor:generateContent')
    expect(buildGeminiEndpoint('https://generativelanguage.googleapis.com/v1', 'gemini-2.5-flash', true))
      .toBe('https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:streamGenerateContent?alt=sse')
    expect(buildGeminiEndpoint('https://gateway.example.test/v1alpha/', 'gemini-3-pro', false))
      .toBe('https://gateway.example.test/v1alpha/models/gemini-3-pro:generateContent')
  })

  test('handles /models roots and full action URLs cleanly', () => {
    expect(buildGeminiEndpoint('https://generativelanguage.googleapis.com/v1beta/models', 'models/gemini-2.5-pro', false))
      .toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent')
    expect(buildGeminiEndpoint('https://generativelanguage.googleapis.com/v1beta/models/old:generateContent', 'gemini-2.5-pro', true))
      .toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse')
  })

  test('encodes special characters per path segment while keeping namespace slashes', () => {
    expect(buildGeminiEndpoint('http://127.0.0.1:3425', 'devin/gemini 4+neon', false))
      .toBe('http://127.0.0.1:3425/v1beta/models/devin/gemini%204%2Bneon:generateContent')
  })

  test('retargets a full action URL and preserves unrelated gateway parameters', () => {
    const base = 'https://gateway.example/v1beta/models/old:streamGenerateContent?route=a&alt=sse#fragment'
    expect(buildGeminiEndpoint(base, 'models/team/new', false))
      .toBe('https://gateway.example/v1beta/models/team/new:generateContent?route=a')
    expect(buildGeminiEndpoint(base, 'team/new', true))
      .toBe('https://gateway.example/v1beta/models/team/new:streamGenerateContent?route=a&alt=sse')
    expect(
      buildGeminiEndpoint('https://gateway.example/v1beta/models/old:streamGenerateContent?route=a&alt=SSE', 'team/new', false),
    ).toBe('https://gateway.example/v1beta/models/team/new:generateContent?route=a')
  })

  test('supports Google Vertex AI publisher, location, and Express Mode base URLs', () => {
    expect(buildGeminiEndpoint('https://aiplatform.googleapis.com/v1/publishers/google', 'gemini-2.5-pro', true))
      .toBe('https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse')
    expect(buildGeminiEndpoint('https://us-central1-aiplatform.googleapis.com/v1/projects/my-proj/locations/us-central1/publishers/google', 'gemini-2.5-pro', false))
      .toBe('https://us-central1-aiplatform.googleapis.com/v1/projects/my-proj/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent')
    expect(buildGeminiEndpoint('https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global', 'gemini-3-pro', true))
      .toBe('https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/publishers/google/models/gemini-3-pro:streamGenerateContent?alt=sse')
    expect(buildGeminiEndpoint('https://aiplatform.googleapis.com', 'gemini-3-pro', true, { isVertex: true }))
      .toBe('https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3-pro:streamGenerateContent?alt=sse')
  })

  test('detects Vertex AI endpoints and builds Vertex Anthropic rawPredict/streamRawPredict URLs', () => {
    expect(isVertexEndpointUrl('https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1')).toBe(true)
    expect(isVertexEndpointUrl('https://us-central1-aiplatform.googleapis.com')).toBe(true)
    expect(isVertexEndpointUrl('https://aiplatform.us.rep.googleapis.com/v1/projects/p/locations/us')).toBe(true)
    expect(isVertexEndpointUrl('https://aiplatform.googleapis.com')).toBe(true)
    expect(isVertexEndpointUrl('https://aiplatform.googleapis.com/v1/publishers/google')).toBe(true)
    expect(isVertexEndpointUrl('https://generativelanguage.googleapis.com')).toBe(false)
    expect(isVertexEndpointUrl('https://aiplatform.googleapis.com.evil.example')).toBe(false)

    expect(isVertexAnthropicTarget('https://us-east5-aiplatform.googleapis.com/v1/projects/p/locations/us-east5', 'claude-sonnet-4-6')).toBe(true)
    expect(isVertexAnthropicTarget('https://us-east5-aiplatform.googleapis.com/v1/projects/p/locations/us-east5/publishers/anthropic', 'custom-model')).toBe(true)
    expect(isVertexAnthropicTarget('https://gateway.example/v1/projects/p/locations/us-east5/publishers/anthropic?route=a', 'custom-model')).toBe(true)
    expect(isVertexAnthropicTarget('https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google', 'gemini-3-pro')).toBe(false)
    expect(isVertexAnthropicTarget('https://gateway.example/v1/projects/p/locations/us-central1/publishers/google?route=a', 'claude-sonnet-4-6')).toBe(false)

    expect(
      buildVertexAnthropicEndpoint('https://us-east5-aiplatform.googleapis.com/v1/projects/p/locations/us-east5', 'claude-sonnet-4-6@default', true),
    ).toBe('https://us-east5-aiplatform.googleapis.com/v1/projects/p/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-6%40default:streamRawPredict')
    expect(
      buildVertexAnthropicEndpoint('https://us-east5-aiplatform.googleapis.com/v1/projects/p/locations/us-east5/publishers/anthropic', 'claude-opus-4-6', false),
    ).toBe('https://us-east5-aiplatform.googleapis.com/v1/projects/p/locations/us-east5/publishers/anthropic/models/claude-opus-4-6:rawPredict')
    expect(
      buildVertexAnthropicEndpoint(
        'https://gateway.example/v1/projects/p/locations/us-east5/publishers/anthropic/models/old:streamRawPredict?route=a#fragment',
        'publishers/anthropic/models/claude-sonnet-4-6',
        false,
      ),
    ).toBe('https://gateway.example/v1/projects/p/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-6:rawPredict?route=a')
    expect(
      buildVertexAnthropicEndpoint(
        'https://gateway.example/v1/projects/p/locations/us-east5/publishers/anthropic/models/old:rawPredict?route=a#fragment',
        'claude-opus-4-6',
        true,
      ),
    ).toBe('https://gateway.example/v1/projects/p/locations/us-east5/publishers/anthropic/models/claude-opus-4-6:streamRawPredict?route=a')
  })
})
