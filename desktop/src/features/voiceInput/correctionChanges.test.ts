import { describe, expect, it } from 'vitest'
import type { VoiceCorrection, VoiceCorrectionChange } from '@/api/voice'
import {
  correctedResult,
  markRanges,
  originalRanges,
  revertAllCorrectionChanges,
  revertCorrectionChange,
  usableCorrectionChanges,
} from './correctionChanges'

const HEARD = '开源的这一个 agent brother skills，后来在 coded 里面去用'
const CORRECTED = '开源的这一个 Agent Browser skills，后来在 Codex 里面去用'

function change(from: string, to: string, text = CORRECTED, inVocabulary = false): VoiceCorrectionChange {
  const start = text.indexOf(to)
  return { from, to, start, end: start + to.length, inVocabulary }
}

const CHANGES = [change('agent brother', 'Agent Browser', CORRECTED, true), change('coded', 'Codex')]

function correction(text: string, changes: VoiceCorrectionChange[]): VoiceCorrection {
  return { text, changes, target: { providerId: 'p', providerName: 'P', modelId: 'fast-model' }, seconds: 0.84 }
}

describe('usableCorrectionChanges', () => {
  it('keeps changes whose offsets point at their own text, sorted', () => {
    expect(usableCorrectionChanges(CORRECTED, [CHANGES[1]!, CHANGES[0]!])).toEqual(CHANGES)
  })

  it('drops a change whose offsets do not hold its text, out of range, overlapping, or a no-op', () => {
    const shifted = { ...CHANGES[1]!, start: CHANGES[1]!.start + 1, end: CHANGES[1]!.end + 1 }
    const outside = { ...CHANGES[1]!, start: 500, end: 505 }
    const overlapping = { from: 'x', to: CORRECTED.slice(CHANGES[0]!.start + 2, CHANGES[0]!.end + 2), start: CHANGES[0]!.start + 2, end: CHANGES[0]!.end + 2, inVocabulary: false }
    const same = { ...CHANGES[1]!, from: 'Codex' }
    expect(usableCorrectionChanges(CORRECTED, [CHANGES[0]!, shifted, outside, overlapping, same])).toEqual([CHANGES[0]])
  })
})

describe('revertCorrectionChange', () => {
  it('puts one change back and shifts the offsets of the ones after it', () => {
    const first = revertCorrectionChange(CORRECTED, CHANGES, 0)!
    expect(first.text).toBe('开源的这一个 agent brother skills，后来在 Codex 里面去用')
    expect(first.changes).toHaveLength(1)
    // The remaining change still points at its own text after the length changed.
    const [codex] = first.changes
    expect(first.text.slice(codex!.start, codex!.end)).toBe('Codex')

    const second = revertCorrectionChange(first.text, first.changes, 0)!
    expect(second).toEqual({ text: HEARD, changes: [] })
  })

  it('leaves earlier offsets alone when a later change is reverted', () => {
    const next = revertCorrectionChange(CORRECTED, CHANGES, 1)!
    expect(next.changes).toEqual([CHANGES[0]])
    expect(next.text.slice(CHANGES[0]!.start, CHANGES[0]!.end)).toBe('Agent Browser')
  })

  it('refuses when the text no longer holds the change', () => {
    expect(revertCorrectionChange('something else entirely', CHANGES, 0)).toBeNull()
    expect(revertCorrectionChange(CORRECTED, CHANGES, 5)).toBeNull()
  })
})

describe('revertAllCorrectionChanges and originalRanges', () => {
  it('rebuilds what was heard and locates each change in it', () => {
    expect(revertAllCorrectionChanges(CORRECTED, CHANGES)).toBe(HEARD)
    const ranges = originalRanges(CHANGES)
    expect(ranges.map(range => HEARD.slice(range.start, range.end))).toEqual(['agent brother', 'coded'])
  })

  it('handles insertions and deletions', () => {
    const text = 'run npm test now'
    const inserted: VoiceCorrectionChange = { from: '', to: 'npm ', start: 4, end: 8, inVocabulary: false }
    expect(revertAllCorrectionChanges(text, [inserted])).toBe('run test now')
    expect(originalRanges([inserted])).toEqual([{ start: 4, end: 4 }])
  })
})

describe('markRanges', () => {
  it('splits text into marked and plain runs', () => {
    expect(markRanges('abcdef', [{ start: 1, end: 3 }, { start: 4, end: 5 }])).toEqual([
      { text: 'a', marked: false },
      { text: 'bc', marked: true },
      { text: 'd', marked: false },
      { text: 'e', marked: true },
      { text: 'f', marked: false },
    ])
    // Empty ranges (a deletion's place in the corrected text) mark nothing.
    expect(markRanges('abc', [{ start: 1, end: 1 }])).toEqual([{ text: 'abc', marked: false }])
  })
})

describe('correctedResult', () => {
  it('uses the corrected text when its changes explain every difference', () => {
    expect(correctedResult(HEARD, correction(CORRECTED, CHANGES))).toEqual({
      heard: HEARD,
      text: CORRECTED,
      changes: CHANGES,
      model: 'fast-model',
      seconds: 0.84,
    })
  })

  it('falls back to what was heard when the changes do not add up to the difference', () => {
    // The server changed "coded" too but listed only one change: an edit the
    // user could not undo from the notice, so the corrected text is not used.
    expect(correctedResult(HEARD, correction(CORRECTED, [CHANGES[0]!]))).toEqual({ heard: HEARD, text: HEARD })
  })

  it('falls back when nothing changed, the text is empty, or every offset is broken', () => {
    expect(correctedResult(HEARD, correction(HEARD, []))).toEqual({ heard: HEARD, text: HEARD })
    expect(correctedResult(HEARD, correction('   ', []))).toEqual({ heard: HEARD, text: HEARD })
    const broken = CHANGES.map(item => ({ ...item, start: item.start + 3, end: item.end + 3 }))
    expect(correctedResult(HEARD, correction(CORRECTED, broken))).toEqual({ heard: HEARD, text: HEARD })
  })
})
