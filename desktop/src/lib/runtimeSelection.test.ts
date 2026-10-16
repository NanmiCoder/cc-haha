import { describe, expect, it } from 'vitest'
import { normalizeRuntimeSelection, reconcileRuntimeSelection, resolveDefaultRuntimeSelection, resolveProviderRuntimeModelId, resolveProviderSlotModelId } from './runtimeSelection'
import type { SavedProvider } from '../types/provider'

describe('normalizeRuntimeSelection', () => {
  it('normalizes an old ChatGPT effort against its model without downgrading supported choices', () => {
    expect(normalizeRuntimeSelection({ providerId: 'openai-official', modelId: 'gpt-5.5', effortLevel: 'max' }))
      .toEqual({ providerId: 'openai-official', modelId: 'gpt-5.5', effortLevel: 'medium' })
    const futureModel = { providerId: 'openai-official', modelId: 'future-catalog-model', effortLevel: 'max' as const }
    expect(normalizeRuntimeSelection(futureModel)).toBe(futureModel)
  })
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

  it('keeps xhigh for Grok models that support it', () => {
    expect(normalizeRuntimeSelection({
      providerId: 'grok-official',
      modelId: 'grok-4.7',
      effortLevel: 'xhigh',
    })).toEqual({
      providerId: 'grok-official',
      modelId: 'grok-4.7',
      effortLevel: 'xhigh',
    })
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
    model1mSupport: { main: true, fable: false, haiku: false, sonnet: true, opus: false },
  }

  it.each([true, false, undefined])('resolves Fable 1M support %s for selection and restoration', (enabled) => {
    const relay: SavedProvider = {
      ...provider,
      models: { ...provider.models, fable: 'claude-fable-5-1[1m]' },
      model1mSupport: enabled === undefined ? undefined : { ...provider.model1mSupport!, fable: enabled },
    }
    const modelId = enabled === false ? 'claude-fable-5-1' : 'claude-fable-5-1[1m]'
    expect(resolveProviderSlotModelId(relay, 'fable')).toBe(modelId)
    expect(resolveProviderRuntimeModelId(relay, 'claude-fable-5-1')).toBe(modelId)
    expect(resolveDefaultRuntimeSelection(relay.id, relay.name, [relay], 'claude-fable-5-1'))
      .toEqual({ providerId: relay.id, modelId })
  })

  it('waits for provider hydration before recovering a removed provider and preserves valid session choices', () => {
    const selection = { providerId: 'deleted-provider', modelId: 'old-model', effortLevel: 'max' as const }
    const context = { activeId: provider.id, providers: [provider], hasLoadedProviders: false }
    expect(reconcileRuntimeSelection(selection, context)).toBe(selection)
    expect(reconcileRuntimeSelection(selection, { ...context, hasLoadedProviders: true })).toEqual({
      providerId: provider.id, modelId: 'main-model[1m]',
    })
    const explicit = { providerId: provider.id, modelId: 'balanced-model[1m]', effortLevel: 'high' as const }
    expect(reconcileRuntimeSelection(explicit, { ...context, hasLoadedProviders: true })).toBe(explicit)
    const official = { providerId: null, modelId: 'claude-opus-4-8', effortLevel: 'high' as const }
    expect(reconcileRuntimeSelection(official, { ...context, hasLoadedProviders: true })).toBe(official)
  })

  it('reconciles effort after the provider protocol and preset become available', () => {
    const selection = { providerId: provider.id, modelId: 'glm-5.3', effortLevel: 'medium' as const }
    const context = {
      activeId: provider.id, hasLoadedProviders: true,
      providers: [{ ...provider, presetId: 'zhipuglm', apiFormat: 'anthropic' as const }],
    }
    expect(reconcileRuntimeSelection(selection, context)).toEqual({ ...selection, effortLevel: 'max' })
  })

  it('uses the current default effort rather than a removed provider effort or the new model default', () => {
    const context = {
      activeId: provider.id, hasLoadedProviders: true, defaultEffortLevel: 'high' as const,
      providers: [{ ...provider, presetId: 'zhipuglm', models: { main: 'glm-5.3', haiku: '', sonnet: '', opus: '' } }],
    }
    expect(reconcileRuntimeSelection({ providerId: 'removed', modelId: 'old', effortLevel: 'medium' }, context))
      .toEqual({ providerId: provider.id, modelId: 'glm-5.3[1m]', effortLevel: 'high' })
  })

  it('materializes the active provider main slot by id and by legacy name', () => {
    for (const activeId of [provider.id, null]) {
      expect(resolveDefaultRuntimeSelection(activeId, provider.name, [provider], 'stale')).toEqual({
        providerId: provider.id, modelId: 'main-model[1m]',
      })
    }
  })

  it('restores the model selected in settings even when it is not the provider main slot', () => {
    const context = { providers: [provider], activeId: provider.id, hasLoadedProviders: true, currentModelId: 'balanced-model' }
    const expected = { providerId: provider.id, modelId: 'balanced-model[1m]' }
    expect(resolveDefaultRuntimeSelection(provider.id, provider.name, [provider], 'balanced-model')).toEqual(expected)
    expect(reconcileRuntimeSelection({ providerId: 'removed', modelId: 'old-model' }, context)).toEqual(expected)
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

describe('built-in DeepSeek Account runtime selection', () => {
  const saved: SavedProvider = {
    id: 'saved', name: 'Saved', presetId: 'custom', apiKey: 'fixture',
    baseUrl: 'http://127.0.0.1:9999', apiFormat: 'anthropic',
    models: { main: 'saved-main', haiku: '', sonnet: '', opus: '' },
  }

  it('keeps a restored DeepSeek Account choice although it is not in the saved provider list', () => {
    const selection = { providerId: 'deepseek-account', modelId: 'deepseek-v4-flash', effortLevel: 'high' as const }
    const context = { activeId: saved.id, providers: [saved], hasLoadedProviders: true }

    // Built-ins are never in the saved list; treating this like a deleted
    // provider would silently move the session to the active saved provider.
    expect(reconcileRuntimeSelection(selection, context)).toBe(selection)
  })

  it('falls back to the bundled DeepSeek preset main model when no model is known', () => {
    expect(resolveDefaultRuntimeSelection('deepseek-account', null, [], undefined))
      .toEqual({ providerId: 'deepseek-account', modelId: 'deepseek-v4-pro[1m]' })
  })
})
