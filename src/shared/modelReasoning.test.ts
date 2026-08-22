import { describe, expect, test } from 'bun:test'

import {
  getClaudeCodeModelCapabilities,
  getModelReasoningCapabilityOverride,
  modelRequiresThinkingParam,
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
      'glm-5.3[1m]',
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

  test('enables the current Claude Code effort capabilities for compatible models', () => {
    expect(getClaudeCodeModelCapabilities('MiniMax-M3', 'anthropic')).toBe(
      'thinking,effort,adaptive_thinking,xhigh_effort,max_effort',
    )
    expect(getClaudeCodeModelCapabilities('gpt-5.6-sol', 'openai_responses')).toBe(
      'thinking,effort,adaptive_thinking,xhigh_effort,max_effort',
    )
  })

  test('marks GLM-5.3 as required-thinking without adaptive thinking', () => {
    expect(getClaudeCodeModelCapabilities('glm-5.3', 'anthropic')).toBe(
      'required_thinking,thinking,effort,max_effort',
    )
    expect(modelRequiresThinkingParam('glm-5.3', 'anthropic')).toBe(true)
    // GLM-5.2 still supports disabled thinking — its probe must stay unchanged.
    expect(modelRequiresThinkingParam('glm-5.2', 'anthropic')).toBe(false)
    // Generic/unmatched models are not forced into required-thinking requests.
    expect(modelRequiresThinkingParam('mimo-v2.5-pro', 'anthropic')).toBe(false)
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
