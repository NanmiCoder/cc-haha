import { describe, expect, it } from 'vitest'
import { normalizeRuntimeSelection, resolveDefaultRuntimeSelection, resolveProviderRuntimeModelId, resolveProviderSlotModelId } from './runtimeSelection'
import type { SavedProvider } from '../types/provider'

describe('normalizeRuntimeSelection', () => {
  it.each([
    ['Claude Official', null],
    ['ChatGPT Official', 'openai-official'],
  ])('keeps xhigh for %s', (_name, providerId) => {
    const selection = {
      providerId,
      modelId: providerId ? 'gpt-5.6-sol' : 'claude-opus-4-8',
      effortLevel: 'xhigh' as const,
    }

    expect(normalizeRuntimeSelection(selection)).toBe(selection)
  })

  it('preserves xhigh for a Claude-compatible custom provider', () => {
    expect(normalizeRuntimeSelection({
      providerId: 'kimi-provider',
      modelId: 'k3',
      effortLevel: 'xhigh',
    })).toEqual({
      providerId: 'kimi-provider',
      modelId: 'k3',
      effortLevel: 'xhigh',
    })
  })

  it('does not apply vendor-specific aliases or denies to compatible providers', () => {
    expect(normalizeRuntimeSelection({
      providerId: 'deepseek-provider',
      modelId: 'deepseek-v4-pro',
      effortLevel: 'medium',
    }, 'anthropic')).toEqual({
      providerId: 'deepseek-provider',
      modelId: 'deepseek-v4-pro',
      effortLevel: 'medium',
    })

    expect(normalizeRuntimeSelection({
      providerId: 'minimax-provider',
      modelId: 'MiniMax-M3[1m]',
      effortLevel: 'high',
    }, 'anthropic')).toEqual({
      providerId: 'minimax-provider',
      modelId: 'MiniMax-M3[1m]',
      effortLevel: 'high',
    })

    expect(normalizeRuntimeSelection({
      providerId: 'custom-provider',
      modelId: 'future-model',
      effortLevel: 'high',
    }, 'openai_responses')).toEqual({
      providerId: 'custom-provider',
      modelId: 'future-model',
      effortLevel: 'high',
    })
  })

  it('preserves unknown persisted selections until their provider protocol is available', () => {
    const selection = {
      providerId: 'custom-provider',
      modelId: 'relay-specific-model',
      effortLevel: 'high' as const,
    }

    expect(normalizeRuntimeSelection(selection)).toBe(selection)
  })

  it('uses the GLM 5.3 standard API default for an unsupported global effort', () => {
    expect(normalizeRuntimeSelection({
      providerId: 'zhipu-provider',
      modelId: 'glm-5.3-flash[1m]',
      effortLevel: 'medium',
    }, 'anthropic', 'zhipu_standard_api')).toEqual({
      providerId: 'zhipu-provider',
      modelId: 'glm-5.3-flash[1m]',
      effortLevel: 'max',
    })

    expect(normalizeRuntimeSelection({
      providerId: 'zhipu-plan-provider',
      modelId: 'glm-5.3-flash[1m]',
      effortLevel: 'xhigh',
    }, 'anthropic', 'zhipu_coding_plan')).toEqual({
      providerId: 'zhipu-plan-provider',
      modelId: 'glm-5.3-flash[1m]',
      effortLevel: 'xhigh',
    })
  })

  it('uses the Grok model default when xhigh is unsupported', () => {
    expect(normalizeRuntimeSelection({
      providerId: 'grok-official',
      modelId: 'grok-4.5',
      effortLevel: 'xhigh',
    })).toEqual({
      providerId: 'grok-official',
      modelId: 'grok-4.5',
      effortLevel: 'high',
    })
  })

  it('removes effort from a non-reasoning Grok model', () => {
    expect(normalizeRuntimeSelection({
      providerId: 'grok-official',
      modelId: 'grok-composer-2.5-fast',
      effortLevel: 'xhigh',
    })).toEqual({
      providerId: 'grok-official',
      modelId: 'grok-composer-2.5-fast',
    })
  })

  it('keeps xhigh for grok-4.6 which supports it', () => {
    expect(normalizeRuntimeSelection({
      providerId: 'grok-official',
      modelId: 'grok-4.6',
      effortLevel: 'xhigh',
    })).toEqual({
      providerId: 'grok-official',
      modelId: 'grok-4.6',
      effortLevel: 'xhigh',
    })
  })

  it('keeps effort for Grok models only known from the live catalog', () => {
    expect(normalizeRuntimeSelection({
      providerId: 'grok-official',
      modelId: 'grok-next-preview',
      effortLevel: 'medium',
    })).toEqual({
      providerId: 'grok-official',
      modelId: 'grok-next-preview',
      effortLevel: 'medium',
    })
  })
})


describe('provider 1M runtime selection', () => {
  const provider: SavedProvider = {
    id: 'provider', name: 'Provider', presetId: 'custom', apiKey: 'fixture',
    baseUrl: 'http://127.0.0.1:9999', apiFormat: 'anthropic',
    models: { main: ' main-model ', haiku: 'fast-model', sonnet: 'balanced-model', opus: 'large-model' },
    model1mSupport: { main: true, haiku: false, sonnet: true, opus: false },
  }

  it('materializes the active provider main slot by id and by legacy name', () => {
    for (const activeId of [provider.id, null]) {
      expect(resolveDefaultRuntimeSelection(activeId, provider.name, [provider], 'stale')).toEqual({
        providerId: provider.id, modelId: 'main-model[1m]',
      })
    }
  })

  it('reconciles restored raw and marked IDs without losing a non-main model or effort', () => {
    expect(resolveProviderRuntimeModelId(provider, 'balanced-model')).toBe('balanced-model[1m]')
    expect(resolveProviderRuntimeModelId(provider, 'large-model[1m]')).toBe('large-model')
    expect(resolveProviderRuntimeModelId(provider, 'unmapped[1m]')).toBe('unmapped[1m]')
  })

  it('keeps distinct choices for one raw model mapped to slots with different capabilities', () => {
    const shared = { ...provider, models: { main: 'shared', haiku: 'shared', sonnet: '', opus: '' } }
    expect(resolveProviderSlotModelId(shared, 'main')).toBe('shared[1m]')
    expect(resolveProviderSlotModelId(shared, 'haiku')).toBe('shared')
    expect(resolveProviderRuntimeModelId(shared, 'shared[1m]')).toBe('shared[1m]')
    expect(resolveProviderRuntimeModelId(shared, 'shared')).toBe('shared')
  })

  it('preserves legacy explicit suffixes when flags are absent, but obeys an explicit off', () => {
    const legacy = { ...provider, model1mSupport: undefined, models: { ...provider.models, main: 'old[1m]', haiku: 'old:1m' } }
    expect(resolveProviderSlotModelId(legacy, 'main')).toBe('old[1m]')
    expect(resolveProviderSlotModelId(legacy, 'haiku')).toBe('old:1m')
    expect(resolveProviderSlotModelId({ ...legacy, model1mSupport: provider.model1mSupport }, 'haiku')).toBe('old')
    expect(resolveProviderSlotModelId({ ...legacy, model1mSupport: provider.model1mSupport }, 'main')).toBe('old[1m]')
  })
})
