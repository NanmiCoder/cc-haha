import { describe, expect, test } from 'bun:test'
import { runtimeMatches } from './chatActions'
import { ANTIGRAVITY_DEFAULT_MODEL, ANTIGRAVITY_PROVIDER_ID } from './runtimeCatalog'

describe('runtimeMatches', () => {
  test('matches exact runtime configs and resolves Antigravity agent-default to applied model', () => {
    expect(
      runtimeMatches(
        { providerId: null, modelId: 'claude-sonnet-4-5', effortLevel: 'high' },
        { providerId: null, modelId: 'claude-sonnet-4-5', effortLevel: 'high' }
      )
    ).toBe(true)

    expect(
      runtimeMatches(
        { providerId: ANTIGRAVITY_PROVIDER_ID, modelId: 'gemini-4-neon', effortLevel: 'high' },
        { providerId: ANTIGRAVITY_PROVIDER_ID, modelId: ANTIGRAVITY_DEFAULT_MODEL, effortLevel: 'high' }
      )
    ).toBe(true)

    expect(
      runtimeMatches(
        { providerId: ANTIGRAVITY_PROVIDER_ID, modelId: 'gemini-4-neon', effortLevel: 'low' },
        { providerId: ANTIGRAVITY_PROVIDER_ID, modelId: ANTIGRAVITY_DEFAULT_MODEL, effortLevel: 'high' }
      )
    ).toBe(false)

    expect(
      runtimeMatches(
        { providerId: null, modelId: 'claude-sonnet-4-5' },
        { providerId: ANTIGRAVITY_PROVIDER_ID, modelId: ANTIGRAVITY_DEFAULT_MODEL }
      )
    ).toBe(false)
  })
})
