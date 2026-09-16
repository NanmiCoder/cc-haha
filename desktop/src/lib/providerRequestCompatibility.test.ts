import { describe, expect, it } from 'vitest'
import { compatibilityForm, parseCompatibilityForm, readCompatibilityEditorJson, readCompatibilityJson, writeCompatibilityJson, PROVIDER_OUTPUT_BUDGET_ENV_KEY } from './providerRequestCompatibility'

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
