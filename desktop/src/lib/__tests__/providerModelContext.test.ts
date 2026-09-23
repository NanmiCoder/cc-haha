import { describe, expect, it } from 'vitest'

import {
  apply1mSupportToContextInput,
  apply1mSupportToContextInputs,
  MODEL_1M_CONTEXT_WINDOW,
  shouldFill1mContextWindow,
  type ModelContextInputs,
} from '../providerModelContext'

function inputs(overrides: Partial<ModelContextInputs> = {}): ModelContextInputs {
  return { main: '', fable: '', haiku: '', sonnet: '', opus: '', ...overrides }
}

describe('1M support and the context window field', () => {
  it('fills the field with 1,000,000 when the box is ticked', () => {
    const next = apply1mSupportToContextInput(inputs({ main: '200000' }), 'main', true, '200000')

    expect(next.main).toBe(String(MODEL_1M_CONTEXT_WINDOW))
  })

  it('leaves a window larger than 1M alone when the box is ticked', () => {
    const before = inputs({ main: '2000000' })

    expect(apply1mSupportToContextInput(before, 'main', true, '')).toBe(before)
    expect(shouldFill1mContextWindow('2000000')).toBe(false)
  })

  it('restores the preset window when the box is cleared', () => {
    const next = apply1mSupportToContextInput(
      inputs({ main: String(MODEL_1M_CONTEXT_WINDOW) }),
      'main',
      false,
      '256000',
    )

    expect(next.main).toBe('256000')
  })

  it('clears the field when the box is cleared and the preset has no window', () => {
    const next = apply1mSupportToContextInput(
      inputs({ sonnet: String(MODEL_1M_CONTEXT_WINDOW) }),
      'sonnet',
      false,
      '',
    )

    expect(next.sonnet).toBe('')
  })

  it('keeps a hand-typed window when the box is cleared', () => {
    const before = inputs({ opus: '400000' })

    expect(apply1mSupportToContextInput(before, 'opus', false, '256000')).toBe(before)
  })

  it('reverts only the slot whose box was cleared', () => {
    const before = inputs({
      main: String(MODEL_1M_CONTEXT_WINDOW),
      haiku: String(MODEL_1M_CONTEXT_WINDOW),
    })

    const next = apply1mSupportToContextInput(before, 'main', false, '256000')

    expect(next).toEqual({ ...before, main: '256000' })
  })

  it('reverts a padded 1,000,000 the same as a bare one', () => {
    const next = apply1mSupportToContextInput(
      inputs({ haiku: ' 1000000 ' }),
      'haiku',
      false,
      '200000',
    )

    expect(next.haiku).toBe('200000')
  })

  it('leaves the field untouched when the caller passes no rollback value', () => {
    const before = inputs({ main: String(MODEL_1M_CONTEXT_WINDOW) })

    expect(apply1mSupportToContextInput(before, 'main', false)).toBe(before)
  })

  it('does not revert fields when re-deriving inputs for the saved 1M flags', () => {
    const before = inputs({ main: String(MODEL_1M_CONTEXT_WINDOW), sonnet: '200000' })

    const next = apply1mSupportToContextInputs(before, {
      main: true,
      fable: false,
      haiku: false,
      sonnet: false,
      opus: false,
    })

    expect(next).toEqual(before)
  })
})
