import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  CLAUDE_OFFICIAL_DEFAULT_MODELS,
  getClaudeOfficialDefaultModelId,
  normalizeExplicitClaudeOfficialModelId,
  resolveClaudeOfficialRuntimeModel,
} from './claudeOfficialRuntime.js'
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

  function useProSubscription() {
    tokenSpy.mockResolvedValue({
      accessToken: 'fake-access-token',
      refreshToken: null,
      expiresAt: null,
      scopes: [],
      subscriptionType: 'pro',
    })
  }

  test('selects Opus 5.5 for Max and Sonnet 5.5 for other subscriptions', () => {
    expect(getClaudeOfficialDefaultModelId('max')).toBe('claude-opus-5-5')
    expect(getClaudeOfficialDefaultModelId('pro')).toBe('claude-sonnet-5-5')
    expect(getClaudeOfficialDefaultModelId(null)).toBe('claude-sonnet-5-5')
  })

  test('resolves Sonnet aliases and the unset default to Sonnet 5.5', async () => {
    useProSubscription()
    for (const model of [undefined, 'sonnet', 'sonnet[1m]', 'SONNET:1m', 'claude-sonnet-5-5[1m]']) {
      expect(await resolveClaudeOfficialRuntimeModel(model)).toBe('claude-sonnet-5-5')
    }
  })

  test('preserves an explicitly selected Sonnet 5 instead of rewriting it to Sonnet 5.5', async () => {
    useProSubscription()
    expect(await resolveClaudeOfficialRuntimeModel('claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(await resolveClaudeOfficialRuntimeModel('claude-sonnet-5[1m]')).toBe('claude-sonnet-5')
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

describe('Claude official runtime Fable identity', () => {
  test('the Fable alias and slot resolve to the latest Fable', () => {
    expect(CLAUDE_OFFICIAL_DEFAULT_MODELS.fable).toBe('claude-fable-5-2')
    expect(normalizeExplicitClaudeOfficialModelId('fable')).toBe('claude-fable-5-2')
    expect(normalizeExplicitClaudeOfficialModelId('fable[1m]')).toBe('claude-fable-5-2')
  })

  test('an explicitly chosen Fable release is never rewritten', () => {
    expect(normalizeExplicitClaudeOfficialModelId('claude-fable-5-2')).toBe('claude-fable-5-2')
    expect(normalizeExplicitClaudeOfficialModelId('claude-fable-5-2[1m]')).toBe('claude-fable-5-2')
    expect(normalizeExplicitClaudeOfficialModelId('claude-fable-5-1')).toBe('claude-fable-5-1')
    expect(normalizeExplicitClaudeOfficialModelId('claude-fable-5')).toBe('claude-fable-5')
  })
})
