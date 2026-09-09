import { describe, expect, test } from 'bun:test'
import { isSessionApiFormat, resolveProviderApiFormat } from './sessionProtocol.js'

describe('session upstream protocol', () => {
  test.each([
    [null, 'anthropic'],
    ['claude-official', 'anthropic'],
    ['openai-official', 'openai_responses'],
    ['grok-official', 'openai_responses'],
  ] as const)('resolves the immutable built-in route %s', (id, format) => {
    expect(resolveProviderApiFormat(id)).toBe(format)
  })

  test.each(['anthropic', 'openai_chat', 'openai_responses'] as const)('uses the saved upstream format %s', apiFormat => {
    expect(resolveProviderApiFormat('custom-provider', { apiFormat })).toBe(apiFormat)
  })

  test.each(['openai_oauth', 'grok_oauth'])('uses the actual OAuth transport for %s', runtimeKind => {
    expect(resolveProviderApiFormat('custom-provider', { apiFormat: 'anthropic', runtimeKind })).toBe('openai_responses')
  })

  test('does not guess protocols for missing providers or unsupported formats', () => {
    expect(resolveProviderApiFormat(undefined)).toBeUndefined()
    expect(resolveProviderApiFormat('deleted-provider')).toBeUndefined()
    expect(resolveProviderApiFormat('provider', { apiFormat: 'future-format' })).toBeUndefined()
    expect(resolveProviderApiFormat('legacy-provider', {})).toBe('anthropic')
    expect(isSessionApiFormat('mixed')).toBe(false)
    expect(isSessionApiFormat('unknown')).toBe(false)
  })
})
