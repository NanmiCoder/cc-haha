import { describe, expect, it } from 'vitest'
import {
  OPENAI_OFFICIAL_DEFAULT_MODEL_ID,
  OPENAI_OFFICIAL_MODELS,
} from './openaiOfficialProvider'

describe('ChatGPT Official fallback model catalog', () => {
  it('offers GPT-6.1 Sol and Terra with OAuth context and reasoning metadata', () => {
    expect(OPENAI_OFFICIAL_MODELS.find(model => model.id === 'gpt-6.1-sol')).toMatchObject({
      name: 'GPT-6.1-Sol',
      context: '258400',
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    })
    expect(OPENAI_OFFICIAL_MODELS.find(model => model.id === 'gpt-6.1-terra')).toMatchObject({
      name: 'GPT-6.1 Terra',
      context: '475000',
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    })
  })

  it('exposes the current GPT-6 Codex tiers and effective context windows', () => {
    expect(OPENAI_OFFICIAL_DEFAULT_MODEL_ID).toBe('gpt-6-sol')
    expect(OPENAI_OFFICIAL_MODELS.slice(0, 3)).toMatchObject([
      {
        id: 'gpt-6-astra',
        context: '258400',
        defaultReasoningEffort: 'low',
      },
      {
        id: 'gpt-6-sol',
        context: '258400',
        defaultReasoningEffort: 'medium',
      },
      {
        id: 'gpt-6-luna',
        context: '258400',
        defaultReasoningEffort: 'medium',
      },
    ])
  })
})
