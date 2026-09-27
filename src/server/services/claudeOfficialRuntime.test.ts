import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { getClaudeOfficialDefaultModelId, resolveClaudeOfficialRuntimeModel } from './claudeOfficialRuntime.js'
import { hahaOAuthService } from './hahaOAuthService.js'

describe('Claude official runtime model selection', () => {
  let tokenSpy: ReturnType<typeof spyOn<typeof hahaOAuthService, 'ensureFreshTokens'>>

  beforeEach(() => {
    tokenSpy = spyOn(hahaOAuthService, 'ensureFreshTokens')
  })

  afterEach(() => {
    tokenSpy.mockRestore()
  })

  function useMaxSubscription() {
    tokenSpy.mockResolvedValue({
      accessToken: 'fake-access-token',
      refreshToken: null,
      expiresAt: null,
      scopes: [],
      subscriptionType: 'max',
    })
  }

  test('selects Opus 5.5 for Max and preserves the Sonnet default for other subscriptions', () => {
    expect(getClaudeOfficialDefaultModelId('max')).toBe('claude-opus-5-5')
    expect(getClaudeOfficialDefaultModelId('pro')).toBe('claude-sonnet-5')
    expect(getClaudeOfficialDefaultModelId(null)).toBe('claude-sonnet-5')
  })

  test('resolves Opus aliases and legacy defaults to Opus 5.5', async () => {
    useMaxSubscription()
    for (const model of [undefined, 'opus', 'opus[1m]', 'OPUS:1m', 'claude-opus-5-5[1m]']) {
      expect(await resolveClaudeOfficialRuntimeModel(model)).toBe('claude-opus-5-5')
    }
  })

  test('preserves explicitly selected older model IDs', async () => {
    useMaxSubscription()
    expect(await resolveClaudeOfficialRuntimeModel('claude-opus-5')).toBe('claude-opus-5')
    expect(await resolveClaudeOfficialRuntimeModel('claude-opus-5[1m]')).toBe('claude-opus-5')
    expect(await resolveClaudeOfficialRuntimeModel('claude-opus-4-8')).toBe('claude-opus-4-8')
    expect(await resolveClaudeOfficialRuntimeModel('claude-opus-4-8[1m]')).toBe('claude-opus-4-8')
  })

  test('leaves provider selection alone without managed OAuth', async () => {
    tokenSpy.mockResolvedValue(null)
    expect(await resolveClaudeOfficialRuntimeModel('opus')).toBeNull()
  })
})
