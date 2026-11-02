import { expect, test } from 'bun:test'
import { firstPartyNameToCanonical, parseUserSpecifiedModel } from './model.js'
import { PROVIDER_PRESETS } from '../../server/config/providerPresets.js'

for (const family of ['haiku', 'sonnet', 'opus'] as const) {
  test(`recognizes OpenRouter ${family} 5.5 without rewriting its outbound ID`, () => {
    const model = PROVIDER_PRESETS.find(preset => preset.id === 'openrouter')!.defaultModels[family]
    expect(firstPartyNameToCanonical(model)).toBe(`claude-${family}-5-5`)
    expect(firstPartyNameToCanonical(`${model}[1m]`)).toBe(`claude-${family}-5-5`)
    expect(parseUserSpecifiedModel(model)).toBe(model)
    expect(firstPartyNameToCanonical(`claude-${family}-5-5`)).toBe(`claude-${family}-5-5`)
  })
}

test('leaves other provider IDs and the prior Claude generation unchanged', () => {
  expect(firstPartyNameToCanonical('z-ai/glm-5.5')).toBe('z-ai/glm-5.5')
  expect(firstPartyNameToCanonical('anthropic/claude-sonnet-5')).toBe('claude-sonnet-5')
  expect(firstPartyNameToCanonical('anthropic/claude-opus-5')).toBe('claude-opus-5')
})
