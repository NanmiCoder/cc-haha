import { describe, expect, it } from 'vitest'

import { en } from '../i18n/locales/en'
import {
  PROVIDER_MODELS_ERROR_KEYS,
  groupProviderModels,
  providerModelsErrorKey,
} from './providerModels'
import type { ProviderModelsErrorCode } from '../types/provider'

describe('groupProviderModels', () => {
  it('sorts groups alphabetically and keeps the provider order inside a group', () => {
    const groups = groupProviderModels(
      [
        { id: 'zeta-1', ownedBy: 'openai' },
        { id: 'alpha-1', ownedBy: 'anthropic' },
        { id: 'zeta-2', ownedBy: 'openai' },
      ],
      'Other',
    )

    expect(groups.map((group) => group.group)).toEqual(['anthropic', 'openai'])
    expect(groups[1]!.models.map((model) => model.id)).toEqual(['zeta-1', 'zeta-2'])
  })

  it('falls back to the caller supplied group when ownedBy is absent or blank', () => {
    const groups = groupProviderModels(
      [
        { id: 'no-owner' },
        { id: 'blank-owner', ownedBy: '   ' },
        { id: 'owned', ownedBy: 'xai' },
      ],
      '其他',
    )

    // Group membership is independent of the host's Chinese/English collation.
    expect(new Set(groups.map((group) => group.group))).toEqual(new Set(['xai', '其他']))
    expect(groups).toHaveLength(2)
    expect(groups.find((group) => group.group === 'xai')?.models.map((m) => m.id)).toEqual(['owned'])
    expect(groups.find((group) => group.group === '其他')?.models.map((m) => m.id))
      .toEqual(['no-owner', 'blank-owner'])
  })

  it('drops repeated ids so the picker cannot render duplicate React keys', () => {
    const groups = groupProviderModels(
      [
        { id: 'gpt-5', ownedBy: 'openai' },
        { id: 'gpt-5', ownedBy: 'openai' },
        { id: ' ', ownedBy: 'openai' },
      ],
      'Other',
    )

    expect(groups).toHaveLength(1)
    expect(groups[0]!.models.map((model) => model.id)).toEqual(['gpt-5'])
  })

  it('groups case variants of the same owner next to each other', () => {
    const groups = groupProviderModels(
      [
        { id: 'b', ownedBy: 'openai' },
        { id: 'a', ownedBy: 'Anthropic' },
        { id: 'c', ownedBy: 'OpenAI' },
      ],
      'Other',
    )

    // `OpenAI` and `openai` stay adjacent instead of landing on opposite ends
    // of a case-sensitive sort.
    expect(groups.map((group) => group.group)).toEqual(['Anthropic', 'openai', 'OpenAI'])
  })

  it('returns nothing for an empty list', () => {
    expect(groupProviderModels([], 'Other')).toEqual([])
  })
})

describe('providerModelsErrorKey', () => {
  const codes: ProviderModelsErrorCode[] = [
    'missing-config',
    'auth-failed',
    'endpoint-not-found',
    'timeout',
    'not-supported',
    'network',
    'unknown',
  ]

  it.each(codes)('maps %s onto a translated message', (code) => {
    const key = providerModelsErrorKey(code)
    expect(en[key]).toBeTruthy()
    expect(en[key]).not.toBe(key)
  })

  it('gives every code a distinct message so the cause stays readable', () => {
    const messages = codes.map((code) => en[providerModelsErrorKey(code)])
    expect(new Set(messages).size).toBe(codes.length)
  })

  // A code the server adds later must not render a raw key to the user.
  it('falls back to the generic message for an unknown code', () => {
    const key = providerModelsErrorKey('rate-limited' as ProviderModelsErrorCode)
    expect(key).toBe(PROVIDER_MODELS_ERROR_KEYS.unknown)
  })
})
