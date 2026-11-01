import type { VoiceCorrection, VoiceCorrectionChange } from '@/api/voice'
import { normalizeDictationText } from './insertion'

export type TextRange = { start: number; end: number }

/** What one corrected dictation writes, and how to take it back. */
export type CorrectionOutcome = {
  /** What the recognizer heard, normalized. */
  heard: string
  /** What goes into the draft: the corrected text, or `heard`. */
  text: string
  changes?: VoiceCorrectionChange[]
  model?: string
  seconds?: number
}

/**
 * Turns the server's answer into what gets written. The changes have to
 * explain the whole difference — reverting all of them must give back exactly
 * what was heard — or the corrected text is not used: the notice promises the
 * user they can undo every change, and an unexplained edit could not be.
 */
export function correctedResult(heard: string, correction: VoiceCorrection): CorrectionOutcome {
  const text = normalizeDictationText(correction.text)
  const changes = usableCorrectionChanges(text, correction.changes)
  if (!text || changes.length === 0 || revertAllCorrectionChanges(text, changes) !== heard) {
    return { heard, text: heard }
  }
  return { heard, text, changes, model: correction.target.modelId, seconds: correction.seconds }
}

/**
 * The server's change offsets, kept only where they still point at their own
 * `to` text in `text`, in order and without overlaps. Anything else is a
 * change the client cannot show or undo safely, so it is dropped rather than
 * trusted.
 */
export function usableCorrectionChanges(
  text: string,
  changes: readonly VoiceCorrectionChange[],
): VoiceCorrectionChange[] {
  const sorted = [...changes].sort((a, b) => a.start - b.start || a.end - b.end)
  const kept: VoiceCorrectionChange[] = []
  let cursor = 0
  for (const change of sorted) {
    if (!Number.isInteger(change.start) || !Number.isInteger(change.end)) continue
    if (change.start < cursor || change.end < change.start || change.end > text.length) continue
    if (change.from === change.to) continue
    if (text.slice(change.start, change.end) !== change.to) continue
    kept.push(change)
    cursor = change.end
  }
  return kept
}

/**
 * Puts one change back to what was heard. The other changes keep pointing at
 * their text: the ones after it shift by the length difference.
 */
export function revertCorrectionChange(
  text: string,
  changes: readonly VoiceCorrectionChange[],
  index: number,
): { text: string; changes: VoiceCorrectionChange[] } | null {
  const change = changes[index]
  if (!change || text.slice(change.start, change.end) !== change.to) return null
  const delta = change.from.length - change.to.length
  return {
    text: `${text.slice(0, change.start)}${change.from}${text.slice(change.end)}`,
    changes: changes
      .filter((_, position) => position !== index)
      .map(other => other.start >= change.end
        ? { ...other, start: other.start + delta, end: other.end + delta }
        : other),
  }
}

/** The text with every change put back, i.e. what the recognizer produced. */
export function revertAllCorrectionChanges(text: string, changes: readonly VoiceCorrectionChange[]): string {
  let result = text
  // From the end, so earlier offsets stay valid while later ones are rewritten.
  for (const change of [...changes].sort((a, b) => b.start - a.start)) {
    result = `${result.slice(0, change.start)}${change.from}${result.slice(change.end)}`
  }
  return result
}

/** Where each change's `from` sits in the original (fully reverted) text. */
export function originalRanges(changes: readonly VoiceCorrectionChange[]): TextRange[] {
  let delta = 0
  return [...changes]
    .sort((a, b) => a.start - b.start)
    .map((change) => {
      const start = change.start + delta
      delta += change.from.length - change.to.length
      return { start, end: start + change.from.length }
    })
}

/** Splits `text` into runs, marking the ones inside `ranges` (sorted, non-overlapping). */
export function markRanges(text: string, ranges: readonly TextRange[]): Array<{ text: string; marked: boolean }> {
  const segments: Array<{ text: string; marked: boolean }> = []
  let cursor = 0
  for (const range of ranges) {
    if (range.end <= range.start || range.start < cursor) continue
    if (range.start > cursor) segments.push({ text: text.slice(cursor, range.start), marked: false })
    segments.push({ text: text.slice(range.start, range.end), marked: true })
    cursor = range.end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), marked: false })
  return segments
}

/**
 * Only a term (something with Latin letters, like `Codex` or `cc-haha`) is
 * worth keeping in the vocabulary; a fixed homophone such as 除 → 熟 is not.
 * Same rule the server uses when it records vocabulary suggestions.
 */
export function isVocabularyCandidate(to: string): boolean {
  return /[A-Za-z]/.test(to)
}
