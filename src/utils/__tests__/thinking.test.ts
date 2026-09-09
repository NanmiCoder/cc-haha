import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { get3PModelCapabilityOverride } from '../model/modelSupportOverrides.js'
import { resolveSideQueryThinkingConfig } from '../sideQuery.js'
import {
  getModelBetas,
  modelSupportsAutoMode,
  modelSupportsContextManagement,
  modelSupportsISP,
  modelSupportsStructuredOutputs,
  shouldIncludeFirstPartyOnlyBetas,
  shouldUseGlobalCacheScope,
} from '../betas.js'
import {
  modelSupportsEffort,
  modelSupportsMaxEffort,
  modelSupportsXHighEffort,
} from '../effort.js'
import {
  modelSupportsAdaptiveThinking,
  modelRequiresThinking,
  modelSupportsThinking,
  resolveModelThinkingEnabled,
  shouldSendExplicitDisabledThinking,
} from '../thinking.js'

describe('provider-aware thinking support', () => {
  let originalApiKey: string | undefined
  let originalBaseUrl: string | undefined
  let originalFableModel: string | undefined
  let originalFableCapabilities: string | undefined
  let originalSonnetModel: string | undefined
  let originalSonnetCapabilities: string | undefined
  let originalBedrock: string | undefined
  let originalVertex: string | undefined
  let originalFoundry: string | undefined
  let originalExplicitDisabledThinking: string | undefined

  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY
    originalBaseUrl = process.env.ANTHROPIC_BASE_URL
    originalFableModel = process.env.ANTHROPIC_DEFAULT_FABLE_MODEL
    originalFableCapabilities = process.env.ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES
    originalSonnetModel = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    originalSonnetCapabilities = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES
    originalBedrock = process.env.CLAUDE_CODE_USE_BEDROCK
    originalVertex = process.env.CLAUDE_CODE_USE_VERTEX
    originalFoundry = process.env.CLAUDE_CODE_USE_FOUNDRY
    originalExplicitDisabledThinking = process.env.CC_HAHA_SEND_DISABLED_THINKING

    delete process.env.ANTHROPIC_API_KEY
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY
  })

  afterEach(() => {
    restoreEnv('ANTHROPIC_API_KEY', originalApiKey)
    restoreEnv('ANTHROPIC_BASE_URL', originalBaseUrl)
    restoreEnv('ANTHROPIC_DEFAULT_FABLE_MODEL', originalFableModel)
    restoreEnv('ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES', originalFableCapabilities)
    restoreEnv('ANTHROPIC_DEFAULT_SONNET_MODEL', originalSonnetModel)
    restoreEnv('ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES', originalSonnetCapabilities)
    restoreEnv('CLAUDE_CODE_USE_BEDROCK', originalBedrock)
    restoreEnv('CLAUDE_CODE_USE_VERTEX', originalVertex)
    restoreEnv('CLAUDE_CODE_USE_FOUNDRY', originalFoundry)
    restoreEnv('CC_HAHA_SEND_DISABLED_THINKING', originalExplicitDisabledThinking)
    clearCapabilityCache()
    clearBetaCache()
  })

  test('does not assume adaptive thinking for Anthropic-compatible third-party base URLs', () => {
    process.env.ANTHROPIC_API_KEY = 'third-party-key'
    process.env.ANTHROPIC_BASE_URL = 'https://api.jiekou.ai/anthropic'
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES
    clearCapabilityCache()

    expect(modelSupportsAdaptiveThinking('claude-sonnet-4-6')).toBe(false)
  })

  test('honors explicit provider capability overrides with no supported capabilities', () => {
    process.env.ANTHROPIC_API_KEY = 'third-party-key'
    process.env.ANTHROPIC_BASE_URL = 'https://api.jiekou.ai/anthropic'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-4-6'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = 'none'
    clearCapabilityCache()

    expect(get3PModelCapabilityOverride('claude-sonnet-4-6', 'thinking')).toBe(false)
    expect(modelSupportsThinking('claude-sonnet-4-6')).toBe(false)
    expect(modelSupportsAdaptiveThinking('claude-sonnet-4-6')).toBe(false)
  })

  test('keeps first-party Anthropic Sonnet adaptive thinking enabled', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES
    clearCapabilityCache()

    expect(modelSupportsThinking('claude-sonnet-4-6')).toBe(true)
    expect(modelSupportsAdaptiveThinking('claude-sonnet-4-6')).toBe(true)
  })

  test('recognizes current first-party flagship model capabilities', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
    clearCapabilityCache()

    for (const model of ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5']) {
      expect(modelSupportsThinking(model)).toBe(true)
      expect(modelSupportsAdaptiveThinking(model)).toBe(true)
      expect(modelSupportsEffort(model)).toBe(true)
      expect(modelSupportsMaxEffort(model)).toBe(true)
      expect(modelSupportsISP(model)).toBe(true)
      expect(modelSupportsContextManagement(model)).toBe(true)
      expect(modelSupportsStructuredOutputs(model)).toBe(true)
    }
    expect(shouldIncludeFirstPartyOnlyBetas()).toBe(true)
    expect(shouldUseGlobalCacheScope()).toBe(true)
  })

  test('normalizes Fable to required adaptive thinking', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
    delete process.env.ANTHROPIC_DEFAULT_FABLE_MODEL
    delete process.env.ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES
    clearCapabilityCache()

    expect(modelSupportsThinking('claude-fable-5')).toBe(true)
    expect(modelSupportsAdaptiveThinking('claude-fable-5')).toBe(true)
    expect(modelRequiresThinking('claude-fable-5')).toBe(true)
    expect(resolveModelThinkingEnabled('claude-fable-5', false)).toBe(true)
  })

  test('lets an explicit third-party capability declaration disable Fable thinking', () => {
    process.env.ANTHROPIC_API_KEY = 'third-party-key'
    process.env.ANTHROPIC_BASE_URL = 'https://provider.example.test/anthropic'
    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL = 'claude-fable-5'
    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES = 'effort'
    clearCapabilityCache()

    expect(modelSupportsThinking('claude-fable-5')).toBe(false)
    expect(modelSupportsAdaptiveThinking('claude-fable-5')).toBe(false)
    expect(modelRequiresThinking('claude-fable-5')).toBe(false)
    expect(resolveModelThinkingEnabled('claude-fable-5', false)).toBe(false)
  })

  test('only sends explicit disabled thinking when the provider opts in', () => {
    delete process.env.CC_HAHA_SEND_DISABLED_THINKING
    expect(shouldSendExplicitDisabledThinking()).toBe(false)

    process.env.CC_HAHA_SEND_DISABLED_THINKING = '1'
    expect(shouldSendExplicitDisabledThinking()).toBe(true)
  })

  test('DeepSeek preset with a 1M marker preserves runtime thinking and effort overrides', () => {
    process.env.ANTHROPIC_API_KEY = 'third-party-key'
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'deepseek-v4-pro[1m]'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES =
      'thinking,effort,adaptive_thinking,xhigh_effort,max_effort'
    delete process.env.CC_HAHA_SEND_DISABLED_THINKING
    clearCapabilityCache()

    expect(modelSupportsThinking('deepseek-v4-pro')).toBe(true)
    expect(modelSupportsAdaptiveThinking('deepseek-v4-pro')).toBe(true)
    expect(modelSupportsEffort('deepseek-v4-pro')).toBe(true)
    expect(modelSupportsXHighEffort('deepseek-v4-pro')).toBe(true)
    expect(modelSupportsMaxEffort('deepseek-v4-pro')).toBe(true)
    expect(shouldSendExplicitDisabledThinking()).toBe(false)
  })

  test('MiniMax preset models declare adaptive thinking without effort passthrough', () => {
    process.env.ANTHROPIC_API_KEY = 'third-party-key'
    process.env.ANTHROPIC_BASE_URL = 'https://api.minimaxi.com/anthropic'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'MiniMax-M3[1m]'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES =
      'thinking,adaptive_thinking'
    clearCapabilityCache()

    for (const model of ['MiniMax-M3[1m]', 'MiniMax-M3', 'MiniMax-M3:1m']) {
      expect(modelSupportsThinking(model)).toBe(true)
      expect(modelSupportsAdaptiveThinking(model)).toBe(true)
      expect(modelSupportsEffort(model)).toBe(false)
      expect(modelSupportsXHighEffort(model)).toBe(false)
      expect(modelSupportsMaxEffort(model)).toBe(false)
    }
  })

  test('Kimi K3 preset requires thinking and supports effort passthrough', () => {
    process.env.ANTHROPIC_API_KEY = 'third-party-key'
    process.env.ANTHROPIC_BASE_URL = 'https://api.kimi.com/coding/'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'k3'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES =
      'thinking,required_thinking,effort,max_effort'
    clearCapabilityCache()

    expect(modelSupportsThinking('k3')).toBe(true)
    expect(modelSupportsAdaptiveThinking('k3')).toBe(false)
    expect(modelRequiresThinking('k3')).toBe(true)
    expect(resolveModelThinkingEnabled('k3', false)).toBe(true)
    expect(modelSupportsEffort('k3')).toBe(true)
    expect(modelSupportsXHighEffort('k3')).toBe(false)
    expect(modelSupportsMaxEffort('k3')).toBe(true)
    expect(modelRequiresThinking('kimi-k2.6')).toBe(false)
    expect(resolveModelThinkingEnabled('kimi-k2.6', false)).toBe(false)
  })

  test('third-party base URLs do not default unknown model names to effort support', () => {
    process.env.ANTHROPIC_API_KEY = 'third-party-key'
    process.env.ANTHROPIC_BASE_URL = 'https://api.kimi.com/coding/'
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES
    clearCapabilityCache()

    expect(modelSupportsEffort('kimi-k2.6')).toBe(false)
    expect(modelSupportsMaxEffort('kimi-k2.6')).toBe(false)
  })

  test('does not infer first-party effort or betas from current model names on third-party URLs', () => {
    process.env.ANTHROPIC_API_KEY = 'third-party-key'
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    delete process.env.ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES
    clearCapabilityCache()
    clearBetaCache()

    for (const model of ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5']) {
      expect(modelSupportsEffort(model)).toBe(false)
      expect(modelSupportsMaxEffort(model)).toBe(false)
      expect(modelSupportsISP(model)).toBe(false)
      expect(modelSupportsContextManagement(model)).toBe(false)
      expect(modelSupportsStructuredOutputs(model)).toBe(false)
      expect(modelSupportsAutoMode(model)).toBe(false)
      expect(getModelBetas(model)).not.toContain('interleaved-thinking-2025-05-14')
    }
    expect(shouldIncludeFirstPartyOnlyBetas()).toBe(false)
    expect(shouldUseGlobalCacheScope()).toBe(false)
  })

  test('side queries inherit explicit disabled thinking for opted-in providers', () => {
    delete process.env.CC_HAHA_SEND_DISABLED_THINKING
    expect(resolveSideQueryThinkingConfig(undefined, 1024)).toBeUndefined()

    process.env.CC_HAHA_SEND_DISABLED_THINKING = '1'
    expect(resolveSideQueryThinkingConfig(undefined, 1024)).toEqual({ type: 'disabled' })
    expect(resolveSideQueryThinkingConfig(false, 1024)).toEqual({ type: 'disabled' })
    expect(resolveSideQueryThinkingConfig(256, 1024)).toEqual({ type: 'enabled', budget_tokens: 256 })
  })
})

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

function clearCapabilityCache() {
  ;(get3PModelCapabilityOverride as typeof get3PModelCapabilityOverride & {
    cache?: { clear?: () => void }
  }).cache?.clear?.()
}

function clearBetaCache() {
  ;(getModelBetas as typeof getModelBetas & {
    cache?: { clear?: () => void }
  }).cache?.clear?.()
}
