import { describe, expect, test } from 'bun:test'
import { getAgentSdkProviderError } from './providerRuntime.js'

const provider = {
  runtime: 'agent-sdk' as const,
  baseUrl: 'https://api.anthropic.com',
  apiFormat: 'anthropic',
  authStrategy: 'api_key',
  apiKey: 'fixture-key',
}

describe('official Agent SDK provider boundary', () => {
  test('accepts the official root endpoint and leaves legacy providers unaffected', () => {
    expect(getAgentSdkProviderError(provider)).toBeUndefined()
    expect(getAgentSdkProviderError({ ...provider, baseUrl: 'https://api.anthropic.com/' })).toBeUndefined()
    for (const runtime of [undefined, 'claude-code'] as const) {
      expect(getAgentSdkProviderError({ ...provider, runtime, baseUrl: 'https://third-party.invalid', authStrategy: 'auth_token' })).toBeUndefined()
    }
  })

  test.each([
    { baseUrl: 'http://api.anthropic.com' },
    { baseUrl: 'https://api.anthropic.com/v1' },
    { baseUrl: 'https://api.anthropic.com.evil.invalid' },
    { baseUrl: 'https://api.anthropic.com/?route=proxy' },
    { baseUrl: 'https://user@api.anthropic.com' },
    { baseUrl: 'https://api.anthropic.com/#fragment' },
    { baseUrl: 'invalid' },
    { apiFormat: 'openai_chat' },
    { authStrategy: 'auth_token' },
    { authStrategy: undefined },
    { runtimeKind: 'openai_oauth' },
    { apiKey: ' ' },
  ])('rejects unsupported SDK connection settings: %j', (override) => {
    expect(getAgentSdkProviderError({ ...provider, ...override })).toContain('Official Agent SDK requires')
  })
})
