import { describe, expect, test } from 'bun:test'
import {
  OPENAI_CODEX_FRONTIER_EFFECTIVE_CONTEXT_WINDOW,
  OPENAI_CODEX_MODEL_CATALOG,
  OPENAI_CODEX_LARGE_EFFECTIVE_CONTEXT_WINDOW,
  OPENAI_CODEX_SPARK_EFFECTIVE_CONTEXT_WINDOW,
  OPENAI_CODEX_STANDARD_EFFECTIVE_CONTEXT_WINDOW,
  OPENAI_DEFAULT_HAIKU_MODEL,
  OPENAI_DEFAULT_MAIN_MODEL,
  OPENAI_DEFAULT_OPUS_MODEL,
  OPENAI_DEFAULT_SONNET_MODEL,
  getOpenAICodexContextWindowForModel,
  getOpenAIModelDisplayName,
  isOpenAIResponsesModel,
  resolveOpenAICodexModel,
  resolveOpenAIReasoningEffort,
  resolveOpenAIReasoningEffortWithPriority,
} from './models.js'

describe('openai auth model resolution', () => {
  test('provides Astra fallback metadata and effective Codex OAuth context', () => {
    const astra = OPENAI_CODEX_MODEL_CATALOG.find((model) => model.value === 'gpt-6-astra')
    expect(astra).toMatchObject({
      label: 'GPT-6 Astra',
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      contextWindow: 258_400,
    })
    for (const model of ['gpt-6-astra', 'gpt-6']) {
      expect(getOpenAICodexContextWindowForModel(model)).toBe(258_400)
      expect(getOpenAIModelDisplayName(model)).toBe('GPT-6 Astra')
      expect(resolveOpenAIReasoningEffort(model, 'max')).toBe('max')
    }
    expect(resolveOpenAIReasoningEffort('gpt-6-astra', 'ultra')).toBe('low')
    expect(OPENAI_DEFAULT_MAIN_MODEL).toBe('gpt-6-sol')
    expect(OPENAI_DEFAULT_OPUS_MODEL).toBe('gpt-6-astra')
  })

  test('does not treat opus as an OpenAI Responses model', () => {
    expect(isOpenAIResponsesModel('opus')).toBe(false)
  })

  test('accepts gpt and o-series models', () => {
    expect(isOpenAIResponsesModel('gpt-5.4')).toBe(true)
    expect(isOpenAIResponsesModel('o3-mini')).toBe(true)
    expect(isOpenAIResponsesModel('openai/gpt-5.6-sol[1m]')).toBe(true)
  })

  test('maps Claude aliases to their OpenAI tier defaults', () => {
    expect(resolveOpenAICodexModel('opus')).toBe(OPENAI_DEFAULT_OPUS_MODEL)
    expect(resolveOpenAICodexModel('fable')).toBe(OPENAI_DEFAULT_MAIN_MODEL)
  })

  test('maps Codex OAuth GPT models to effective Codex context windows', () => {
    expect(getOpenAICodexContextWindowForModel('gpt-6-sol')).toBe(
      OPENAI_CODEX_STANDARD_EFFECTIVE_CONTEXT_WINDOW,
    )
    expect(getOpenAICodexContextWindowForModel('gpt-6-luna')).toBe(
      OPENAI_CODEX_STANDARD_EFFECTIVE_CONTEXT_WINDOW,
    )
    expect(getOpenAICodexContextWindowForModel('gpt-5.6-sol')).toBe(
      OPENAI_CODEX_FRONTIER_EFFECTIVE_CONTEXT_WINDOW,
    )
    expect(getOpenAICodexContextWindowForModel('gpt-5.5')).toBe(
      OPENAI_CODEX_STANDARD_EFFECTIVE_CONTEXT_WINDOW,
    )
    expect(getOpenAICodexContextWindowForModel('gpt-5.4')).toBe(
      OPENAI_CODEX_LARGE_EFFECTIVE_CONTEXT_WINDOW,
    )
    expect(getOpenAICodexContextWindowForModel('gpt-5.3-codex')).toBe(
      OPENAI_CODEX_STANDARD_EFFECTIVE_CONTEXT_WINDOW,
    )
    expect(getOpenAICodexContextWindowForModel('gpt-5.4-mini')).toBe(
      OPENAI_CODEX_STANDARD_EFFECTIVE_CONTEXT_WINDOW,
    )
    expect(getOpenAICodexContextWindowForModel('gpt-5.3-codex-spark')).toBe(
      OPENAI_CODEX_SPARK_EFFECTIVE_CONTEXT_WINDOW,
    )
  })

  test('keeps bundled catalog windows aligned with runtime resolution', () => {
    for (const model of OPENAI_CODEX_MODEL_CATALOG) {
      expect(getOpenAICodexContextWindowForModel(model.value)).toBe(
        model.contextWindow,
      )
    }
  })

  test('exposes GPT-6 Sol and Luna ahead of their GPT-5.6 predecessors', () => {
    expect(OPENAI_CODEX_MODEL_CATALOG.slice(0, 6).map((model) => model.value)).toEqual([
      'gpt-6-astra',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ])
    expect(OPENAI_DEFAULT_SONNET_MODEL).toBe('gpt-6-sol')
    expect(OPENAI_DEFAULT_HAIKU_MODEL).toBe('gpt-6-luna')
    expect(getOpenAIModelDisplayName('gpt-6-sol')).toBe('GPT-6-Sol')
    expect(getOpenAIModelDisplayName('gpt-6-luna')).toBe('GPT-6-Luna')
    expect(resolveOpenAIReasoningEffort('gpt-6-sol', undefined)).toBe('medium')
    expect(resolveOpenAIReasoningEffort('gpt-6-luna', 'max')).toBe('max')
    expect(getOpenAIModelDisplayName('gpt-5.6-sol')).toBe('GPT-5.6-Sol')
    expect(resolveOpenAIReasoningEffort('gpt-5.6-sol', undefined)).toBe('low')
    expect(resolveOpenAIReasoningEffort('gpt-5.6-terra', undefined)).toBe('medium')
    expect(resolveOpenAIReasoningEffort('gpt-5.6-luna', 'max')).toBe('max')
    expect(resolveOpenAIReasoningEffort('gpt-5.5', 'max')).toBe('medium')
    expect(resolveOpenAIReasoningEffort('gpt-5.5', 'xhigh')).toBe('xhigh')
  })

  test('uses the first model-supported effort candidate', () => {
    expect(
      resolveOpenAIReasoningEffortWithPriority('gpt-5.6-luna', [
        'low',
        'high',
      ]),
    ).toBe('low')
    expect(
      resolveOpenAIReasoningEffortWithPriority('gpt-5.5', [
        'max',
        'high',
        'xhigh',
      ]),
    ).toBe('high')
    expect(
      resolveOpenAIReasoningEffortWithPriority('gpt-5.5', [
        'max',
        'invalid',
      ]),
    ).toBe('medium')
  })
})
