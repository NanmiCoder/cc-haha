import { describe, expect, test } from 'bun:test'

import { buildOpenAIEndpointUrl } from '../proxy/upstreamUrl.js'

describe('buildOpenAIEndpointUrl', () => {
  test('does not duplicate the v1 path when base URL already includes it', () => {
    expect(buildOpenAIEndpointUrl('https://api.example.com/v1', 'chat/completions'))
      .toBe('https://api.example.com/v1/chat/completions')
    expect(buildOpenAIEndpointUrl('https://api.example.com/v1/', 'responses'))
      .toBe('https://api.example.com/v1/responses')
  })

  test('adds the v1 path when base URL does not include it', () => {
    expect(buildOpenAIEndpointUrl('https://api.example.com', 'chat/completions'))
      .toBe('https://api.example.com/v1/chat/completions')
    expect(buildOpenAIEndpointUrl('https://api.example.com/', 'responses'))
      .toBe('https://api.example.com/v1/responses')
  })

  test('preserves a custom API path', () => {
    expect(buildOpenAIEndpointUrl('https://gateway.example.com/openai/v1', 'chat/completions'))
      .toBe('https://gateway.example.com/openai/v1/chat/completions')
  })
})
