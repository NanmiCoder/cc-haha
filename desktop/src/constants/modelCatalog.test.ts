import { describe, expect, it } from 'vitest'
import { OFFICIAL_DEFAULT_MODEL_ID, OFFICIAL_MODELS } from './modelCatalog'

describe('Claude official model catalog', () => {
  it('offers Opus 5.5 with its launch effort and context for OAuth selection', () => {
    expect(OFFICIAL_DEFAULT_MODEL_ID).toBe('claude-opus-5-5')
    expect(OFFICIAL_MODELS.find(model => model.id === 'claude-opus-5-5')).toMatchObject({
      name: 'Opus 5.5',
      context: '1m',
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    })
  })

  it('keeps older explicit model selections available', () => {
    expect(OFFICIAL_MODELS.map(model => model.id)).toEqual(expect.arrayContaining([
      'claude-opus-5', 'claude-opus-4-8', 'claude-fable-5-1', 'claude-sonnet-5',
    ]))
  })
})
