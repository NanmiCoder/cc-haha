import { describe, expect, test } from 'bun:test'
import {
  GROK_DEFAULT_MAIN_MODEL,
  GROK_MODEL_CATALOG,
  getGrokContextWindowForModel,
  resolveGrokModel,
} from './models.js'

describe('Grok model catalog', () => {
  test('keeps CLI-only aliases out of the picker fallback and defaults to Grok 4.5', () => {
    expect(GROK_MODEL_CATALOG.map((model) => model.value)).toEqual([
      'grok-4.5',
      'grok-composer-2.5-fast',
    ])
    expect(GROK_DEFAULT_MAIN_MODEL).toBe('grok-4.5')
    expect(resolveGrokModel('claude-opus-4-1')).toBe(GROK_DEFAULT_MAIN_MODEL)
  })

  test('preserves explicit model IDs and resolves supported aliases', () => {
    expect(resolveGrokModel('grok-composer-2.5-fast')).toBe('grok-composer-2.5-fast')
    expect(resolveGrokModel('grok')).toBe(GROK_DEFAULT_MAIN_MODEL)
    expect(resolveGrokModel('unknown-model')).toBe(GROK_DEFAULT_MAIN_MODEL)
    expect(getGrokContextWindowForModel('grok-4.5')).toBe(500_000)
    expect(getGrokContextWindowForModel('unknown-model')).toBe(500_000)
  })
})
