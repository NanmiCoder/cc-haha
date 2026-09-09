import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { get3PModelCapabilityOverride } from './modelSupportOverrides.js'

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
] as const

describe('third-party model capability overrides', () => {
  let originalEnv: Record<(typeof ENV_KEYS)[number], string | undefined>

  beforeEach(() => {
    originalEnv = Object.fromEntries(
      ENV_KEYS.map(key => [key, process.env[key]]),
    ) as Record<(typeof ENV_KEYS)[number], string | undefined>
    process.env.ANTHROPIC_API_KEY = 'third-party-key'
    process.env.ANTHROPIC_BASE_URL = 'https://provider.example.test/anthropic'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES =
      'thinking,effort,adaptive_thinking,xhigh_effort,max_effort'
    clearCapabilityCache()
  })

  afterEach(() => {
    for (const key of ENV_KEYS) restoreEnv(key, originalEnv[key])
    clearCapabilityCache()
  })

  test('ignores only 1M context markers when matching pinned provider models', () => {
    const cases = [
      ['deepseek-v4-flash', 'deepseek-v4-flash[1m]'],
      ['k3', 'k3[1m]'],
      ['MiniMax-M3', 'MiniMax-M3[1m]'],
      ['glm-5.2', 'glm-5.2:1m'],
      ['vendor/future-model', 'vendor/future-model[1m]'],
      ['vendor/future-model[1m]', 'vendor/future-model'],
      ['vendor/future-model:1m', 'vendor/future-model'],
      [' VENDOR/FUTURE-MODEL[1M] ', 'vendor/future-model:1m'],
    ] as const

    for (const [runtimeModel, pinnedModel] of cases) {
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = pinnedModel
      clearCapabilityCache()

      expect(get3PModelCapabilityOverride(runtimeModel, 'thinking')).toBe(true)
      expect(get3PModelCapabilityOverride(runtimeModel, 'effort')).toBe(true)
      expect(get3PModelCapabilityOverride(runtimeModel, 'xhigh_effort')).toBe(true)
      expect(get3PModelCapabilityOverride(runtimeModel, 'max_effort')).toBe(true)
    }
  })

  test('does not collapse distinct provider namespaces while removing 1M markers', () => {
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'provider-a/shared-model[1m]'
    clearCapabilityCache()

    expect(get3PModelCapabilityOverride('provider-a/shared-model', 'effort')).toBe(true)
    expect(get3PModelCapabilityOverride('provider-b/shared-model', 'effort')).toBeUndefined()
  })

  test.each([
    'vendor/future-model[2m]',
    'vendor[1m]/future-model',
  ])('keeps capability decisions independent for the distinct model %s', distinctModel => {
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'vendor/future-model[1m]'
    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL = distinctModel
    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES = 'none'

    // Both lookup orders must preserve the provider's explicit opt-out.
    for (const models of [
      ['vendor/future-model', distinctModel],
      [distinctModel, 'vendor/future-model'],
    ]) {
      clearCapabilityCache()
      for (const model of models) {
        expect(get3PModelCapabilityOverride(model, 'thinking')).toBe(model !== distinctModel)
        expect(get3PModelCapabilityOverride(model, 'effort')).toBe(model !== distinctModel)
      }
    }
  })

  test('preserves Fable capability opt-ins and opt-outs across 1M aliases', () => {
    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL = 'vendor/fable-model[1m]'
    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES = 'thinking,effort'

    for (const model of ['vendor/fable-model', 'vendor/fable-model[1m]', 'vendor/fable-model:1m']) {
      expect(get3PModelCapabilityOverride(model, 'thinking')).toBe(true)
      expect(get3PModelCapabilityOverride(model, 'effort')).toBe(true)
      expect(get3PModelCapabilityOverride(model, 'adaptive_thinking')).toBe(false)
      expect(get3PModelCapabilityOverride(model, 'max_effort')).toBe(false)
    }
  })
})

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

function clearCapabilityCache() {
  ;(get3PModelCapabilityOverride as typeof get3PModelCapabilityOverride & {
    cache?: { clear?: () => void }
  }).cache?.clear?.()
}
