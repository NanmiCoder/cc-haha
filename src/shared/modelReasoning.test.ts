import { describe, expect, test } from 'bun:test'

import {
  getClaudeCodeModelCapabilities,
  getModelReasoningCapabilityOverride,
  isOpenAIReasoningModel,
  normalizeModelReasoningEffort,
  resolveModelReasoningProfile,
} from './modelReasoning.js'

describe('model reasoning capability pass-through', () => {
  test('passes every Claude Code effort through without vendor-specific model rules', () => {
    const modelIds = [
      'deepseek-v4-pro',
      'k3',
      'kimi-k2.7-code',
      'glm-4.7',
      'glm-5.2[1m]',
      'MiniMax-M3[1m]',
      'mimo-v2.5-pro[1m]',
      'future-model',
    ]
    const apiFormats = ['anthropic', 'openai_chat', 'openai_responses'] as const
    const efforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const

    for (const modelId of modelIds) {
      for (const apiFormat of apiFormats) {
        expect(resolveModelReasoningProfile(modelId, apiFormat)).toMatchObject({
          supportedReasoningEfforts: efforts,
        })
        for (const effort of efforts) {
          expect(normalizeModelReasoningEffort(modelId, effort, apiFormat)).toBe(effort)
        }
      }
    }
  })

  test('treats the DeepSeek account route\'s V4.1 Flash id as a DeepSeek V4 model', () => {
    // The account route names V4.1 Flash `deepseek-flash`; without it the
    // model loses thinking, effort and reasoning round-tripping.
    expect(resolveModelReasoningProfile('deepseek-flash', 'anthropic')?.family).toBe('deepseek-v4')
    expect(resolveModelReasoningProfile('deepseek-flash', 'openai_chat')?.family).toBe('deepseek-v4')
    expect(getClaudeCodeModelCapabilities('deepseek-flash', 'anthropic')).toBe(
      getClaudeCodeModelCapabilities('deepseek-v4-flash', 'anthropic'),
    )
  })

  test('enables the current Claude Code effort capabilities for compatible models', () => {
    expect(getClaudeCodeModelCapabilities('MiniMax-M3', 'anthropic')).toBe(
      'thinking,effort,adaptive_thinking,xhigh_effort,max_effort',
    )
    expect(getClaudeCodeModelCapabilities('gpt-5.6-sol', 'openai_responses')).toBe(
      'thinking,effort,adaptive_thinking,xhigh_effort,max_effort',
    )
  })

  test('requires enabled thinking for exact GLM 5.3 model ids', () => {
    for (const modelId of ['glm-5.3', 'glm-5.3-flash', 'zai/glm-5.3-flash[1m]']) {
      expect(resolveModelReasoningProfile(modelId, 'anthropic')).toMatchObject({
        family: 'glm-5.3',
        defaultReasoningEffort: 'max',
      })
      expect(getClaudeCodeModelCapabilities(modelId, 'anthropic')).toBe(
        'thinking,required_thinking,effort,xhigh_effort,max_effort',
      )
    }

    expect(resolveModelReasoningProfile('glm-5.30', 'anthropic')?.family).toBe('generic')
  })

  test('narrows standard API effort without disabling Coding Plan aliases', () => {
    expect(resolveModelReasoningProfile(
      'glm-5.3-flash',
      'anthropic',
      undefined,
      'zhipu_standard_api',
    )).toMatchObject({
      supportedReasoningEfforts: ['low', 'high', 'max'],
      defaultReasoningEffort: 'max',
      claudeCodeCapabilities: 'thinking,required_thinking,effort,max_effort',
    })
    expect(normalizeModelReasoningEffort(
      'glm-5.3-flash',
      'medium',
      'anthropic',
      undefined,
      'zhipu_standard_api',
    )).toBeUndefined()

    expect(resolveModelReasoningProfile(
      'glm-5.3-flash',
      'anthropic',
      undefined,
      'zhipu_coding_plan',
    )?.supportedReasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(normalizeModelReasoningEffort(
      'glm-5.3-flash',
      'xhigh',
      'anthropic',
      undefined,
      'zhipu_coding_plan',
    )).toBe('xhigh')
  })

  test('recognizes GPT and o-series reasoning models behind provider namespaces', () => {
    expect(isOpenAIReasoningModel('gpt-5.6-sol[1m]')).toBe(true)
    expect(isOpenAIReasoningModel('openai/gpt-5.6-sol')).toBe(true)
    expect(isOpenAIReasoningModel('openrouter/o3-mini')).toBe(true)
    expect(isOpenAIReasoningModel('claude-opus-4-8')).toBe(false)
  })

  test('applies explicit slot capabilities before model profiles', () => {
    const models = {
      main: 'claude-opus-5',
      haiku: 'claude-haiku-4-5',
      sonnet: 'claude-sonnet-5',
      opus: 'claude-opus-5',
    }
    const env = {
      ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES: 'none',
    }
    const sonnetOverride = getModelReasoningCapabilityOverride(
      'claude-sonnet-5',
      models,
      env,
    )

    expect(sonnetOverride).toBe('none')
    expect(getModelReasoningCapabilityOverride('claude-opus-5', models, env)).toBeUndefined()
    expect(resolveModelReasoningProfile(
      'claude-sonnet-5',
      'anthropic',
      sonnetOverride,
    )?.supportedReasoningEfforts).toEqual([])
    expect(normalizeModelReasoningEffort(
      'claude-sonnet-5',
      'xhigh',
      'anthropic',
      sonnetOverride,
    )).toBeUndefined()
  })

  test('uses explicit capabilities only to validate, never to remap effort', () => {
    const capabilities = 'thinking,effort,adaptive_thinking'

    expect(normalizeModelReasoningEffort(
      'provider-model',
      'medium',
      'anthropic',
      capabilities,
    )).toBe('medium')
    expect(normalizeModelReasoningEffort(
      'provider-model',
      'xhigh',
      'anthropic',
      capabilities,
    )).toBeUndefined()
  })
})
