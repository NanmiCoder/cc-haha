import { describe, expect, it } from 'vitest'
import { compatibilityForm, parseAnthropicBudgetForm, parseCompatibilityForm, pickOutputBudget, readCompatibilityEditorJson, readCompatibilityJson, writeCompatibilityJson, PROVIDER_OUTPUT_BUDGET_ENV_KEY } from './providerRequestCompatibility'

describe('provider compatibility editor contract', () => {
  it('preserves unknown config and env values through a form edit', () => {
    const original = { sampling: 'unsupported' as const, futureCapability: { value: 1 } }
    const value = parseCompatibilityForm({ ...compatibilityForm(original), maxOutputTokens: '48000' })
    const settings = writeCompatibilityJson({ env: { UNKNOWN: 'keep' }, futureSetting: true }, value)
    expect(settings).toEqual({ requestCompatibility: { ...original, maxOutputTokens: 48000 }, env: { UNKNOWN: 'keep', [PROVIDER_OUTPUT_BUDGET_ENV_KEY]: '48000' }, futureSetting: true })
  })
  it.each(['0', '-1', '1.5', 'NaN', '1e5', '9007199254740992'])('rejects invalid budget %s', value => {
    expect(() => parseCompatibilityForm({ ...compatibilityForm(), maxOutputTokens: value })).toThrow()
  })
  it('clearing removes the mirrored env while keeping unknown env values', () => {
    expect(writeCompatibilityJson({ requestCompatibility: { maxOutputTokens: 32 }, env: { [PROVIDER_OUTPUT_BUDGET_ENV_KEY]: '32', UNKNOWN: 'keep' } }, undefined)).toEqual({ env: { UNKNOWN: 'keep' } })
  })
  it('allows raw env budget editing while preserving other provider options', () => {
    const settings = writeCompatibilityJson({}, { maxOutputTokens: 32, sampling: 'unsupported' })
    const next = { ...settings, env: { [PROVIDER_OUTPUT_BUDGET_ENV_KEY]: '64' } }
    expect(readCompatibilityEditorJson(next, JSON.stringify(settings))).toEqual({ maxOutputTokens: 64, sampling: 'unsupported' })
    expect(readCompatibilityEditorJson({ ...settings, env: {} }, JSON.stringify(settings))).toEqual({ sampling: 'unsupported' })
  })
  it('explicit provider object deletion overrides a stale mirrored budget', () => {
    const settings = writeCompatibilityJson({}, { maxOutputTokens: 32 })
    expect(readCompatibilityEditorJson({ env: settings.env }, JSON.stringify(settings))).toBeUndefined()
  })
  it('validates known raw options without discarding unknown keys', () => {
    expect(readCompatibilityJson({ outputTokenField: 'omit', future: 1 })).toEqual({ outputTokenField: 'omit', future: 1 })
    for (const value of [{ sampling: false }, { maxOutputTokens: '32' }, { outputTokenField: 'max_output_tokens' }, []]) expect(() => readCompatibilityJson(value)).toThrow()
  })
})

describe('Anthropic budget and thinking reduction', () => {
  it('keeps the reply output budget and drops every advanced compat option', () => {
    const form = compatibilityForm({ maxOutputTokens: 64000, outputTokenLimit: 8000, sampling: 'unsupported', outputTokenField: 'max_tokens', futureOption: { keep: true } })
    expect(parseAnthropicBudgetForm(form)).toEqual({ maxOutputTokens: 64000 })
  })
  it('keeps the reasoning selection alongside the budget', () => {
    expect(parseAnthropicBudgetForm({ ...compatibilityForm({ reasoning: 'supported' }), maxOutputTokens: '64000' }))
      .toEqual({ maxOutputTokens: 64000, reasoning: 'supported' })
    expect(parseAnthropicBudgetForm(compatibilityForm({ reasoning: 'unsupported' })))
      .toEqual({ reasoning: 'unsupported' })
    expect(parseAnthropicBudgetForm(compatibilityForm({ reasoning: 'auto' })))
      .toEqual({ reasoning: 'auto' })
  })
  it('drops other stale capabilities even when reasoning survives', () => {
    const form = compatibilityForm({
      reasoning: 'supported',
      sampling: 'unsupported',
      parallelTools: 'supported',
      structuredOutput: 'unsupported',
      outputTokenField: 'omit',
      outputTokenLimit: 8000,
      futureOption: { keep: true },
    })
    expect(parseAnthropicBudgetForm(form)).toEqual({ reasoning: 'supported' })
  })
  it('returns undefined when the budget is blank even if stale options remain', () => {
    expect(parseAnthropicBudgetForm(compatibilityForm({ sampling: 'unsupported' }))).toBeUndefined()
  })
  it.each(['0', '-3', '1.5', 'NaN', '1e5'])('rejects invalid budget %s', value => {
    expect(() => parseAnthropicBudgetForm({ ...compatibilityForm(), maxOutputTokens: value })).toThrow()
  })
})

describe('pickOutputBudget', () => {
  it('reduces a parsed object to the budget alone', () => {
    expect(pickOutputBudget({ maxOutputTokens: 4096, reasoning: 'unsupported' })).toEqual({ maxOutputTokens: 4096 })
  })
  it('drops objects that carry no budget', () => {
    expect(pickOutputBudget({ reasoning: 'unsupported' })).toBeUndefined()
    expect(pickOutputBudget(undefined)).toBeUndefined()
  })
})
