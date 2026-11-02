/**
 * Turns a correction model's answer into a minimal, fully explained edit of the
 * recognized text.
 *
 * The model is asked to fix misheard terms only, but in practice it also adds
 * spaces around Latin words, swaps half-width punctuation, or (rarely) answers
 * the dictated question. So the answer is never used as-is: it is diffed
 * against the recognized text, edits that touch only whitespace/punctuation are
 * dropped, and the result is rebuilt from the recognized text with the remaining
 * edits applied. Every difference between input and output is then one entry in
 * `changes`, which is what the composer shows and lets the user revert.
 */

export interface TextChange {
  from: string
  to: string
  /** Offsets into the rebuilt text. */
  start: number
  end: number
}

interface Token {
  text: string
  start: number
}

/**
 * Latin/digit runs (with `. - _ + #` inside, and a trailing `+`/`#` for C++ or
 * C#), whitespace runs, then any single code point (a CJK character or a
 * punctuation mark).
 */
const TOKEN = /[A-Za-z0-9](?:[A-Za-z0-9._+#-]*[A-Za-z0-9+#])?|\s+|[\s\S]/gu
const WHITESPACE = /^\s+$/u
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u

/** Upper bound on the recognized text the server will diff (a 120 s dictation is ~600 characters). */
export const MAX_CORRECTION_TEXT_LENGTH = 2000

/** Identical to the composer's `normalizeDictationText`: one line, trimmed. */
export function normalizeDictationText(raw: string): string {
  return raw.replace(/\s*[\r\n]+\s*/g, ' ').trim()
}

export function tokenize(text: string): Token[] {
  return [...text.matchAll(TOKEN)].map(match => ({ text: match[0], start: match.index ?? 0 }))
}

function isWhitespace(token: string): boolean {
  return WHITESPACE.test(token)
}

/** Whitespace or punctuation/symbols: no letter or digit at all. */
function isFiller(token: string): boolean {
  return !LETTER_OR_DIGIT.test(token)
}

/** Suffix LCS table: `table[i * (m + 1) + j]` = LCS of `a[i:]` and `b[j:]`. */
function lcsTable(a: readonly string[], b: readonly string[]): Uint16Array {
  const n = a.length
  const m = b.length
  const width = m + 1
  const table = new Uint16Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + j + 1]! + 1
        : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
    }
  }
  return table
}

function lcsLength(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  return lcsTable(a, b)[0]!
}

function dice(a: readonly string[], b: readonly string[]): number {
  if (a.length + b.length === 0) return 1
  return (2 * lcsLength(a, b)) / (a.length + b.length)
}

/**
 * How much of the sentence survived, 0–1. Token-level (case-insensitive,
 * whitespace ignored) catches rewrites of CJK text; the character-level score
 * keeps a short answer like `coded` → `Codex` from reading as a rewrite just
 * because its only token changed. The better of the two counts.
 */
export function correctionSimilarity(raw: string, corrected: string): number {
  const words = (text: string) => tokenize(text.toLowerCase()).map(token => token.text).filter(token => !isWhitespace(token))
  const chars = (text: string) => [...text.toLowerCase().replace(/\s+/gu, '')]
  return Math.max(dice(words(raw), words(corrected)), dice(chars(raw), chars(corrected)))
}

export const MIN_CORRECTION_SIMILARITY = 0.5
export const CORRECTION_LENGTH_RATIO = { min: 0.5, max: 2 } as const

/**
 * Whether `corrected` is plausibly the same sentence with a few terms fixed,
 * rather than an answer, a translation or a rewrite.
 */
export function isPlausibleCorrection(raw: string, corrected: string): boolean {
  const rawLength = [...raw.replace(/\s+/gu, '')].length
  const correctedLength = [...corrected.replace(/\s+/gu, '')].length
  if (rawLength === 0 || correctedLength === 0) return false
  const ratio = correctedLength / rawLength
  if (ratio < CORRECTION_LENGTH_RATIO.min || ratio > CORRECTION_LENGTH_RATIO.max) return false
  return correctionSimilarity(raw, corrected) >= MIN_CORRECTION_SIMILARITY
}

const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
]

/**
 * Unwraps what models put around an answer: a code fence or a pair of quotes
 * the recognized text did not have. Then normalizes like the input.
 */
export function cleanCorrectionOutput(output: string, raw: string): string {
  let text = output.trim()
  const fenced = text.match(/^```[^\n]*\n([\s\S]*?)\n?```$/)
  if (fenced) text = fenced[1]!.trim()
  for (const [open, close] of QUOTE_PAIRS) {
    if (
      text.length >= open.length + close.length &&
      text.startsWith(open) && text.endsWith(close) &&
      !raw.startsWith(open)
    ) {
      text = text.slice(open.length, text.length - close.length).trim()
      break
    }
  }
  return normalizeDictationText(text)
}

interface Hunk {
  /** Token ranges `[a0, a1)` in the raw text and `[b0, b1)` in the model output. */
  a0: number
  a1: number
  b0: number
  b1: number
}

function diffHunks(a: readonly string[], b: readonly string[]): Hunk[] {
  const n = a.length
  const m = b.length
  const width = m + 1
  const table = lcsTable(a, b)
  const hunks: Hunk[] = []
  let open: Hunk | null = null
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      open = null
      i += 1
      j += 1
      continue
    }
    if (!open) {
      open = { a0: i, a1: i, b0: j, b1: j }
      hunks.push(open)
    }
    if (j >= m || (i < n && table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) {
      i += 1
      open.a1 = i
    } else {
      j += 1
      open.b1 = j
    }
  }

  // A term split by an unchanged space ("agent brother" → "Agent Browser") is one edit.
  const merged: Hunk[] = []
  for (const hunk of hunks) {
    const previous = merged[merged.length - 1]
    if (previous && a.slice(previous.a1, hunk.a0).every(isWhitespace)) {
      previous.a1 = hunk.a1
      previous.b1 = hunk.b1
    } else {
      merged.push({ ...hunk })
    }
  }
  return merged
}

/** Shrinks `[start, end)` past filler tokens on both edges. */
function trimFiller(tokens: readonly string[], start: number, end: number): [number, number] {
  let from = start
  let to = end
  while (from < to && isFiller(tokens[from]!)) from += 1
  while (to > from && isFiller(tokens[to - 1]!)) to -= 1
  return [from, to]
}

const HAN = /\p{Script=Han}/u

/**
 * Shrinks the model's side of an edit past Chinese (and filler) on both edges,
 * for a recognized span that has no Chinese at all. Such characters cannot be
 * a misheard version of anything in that span: the model added them next to
 * the term (`agentbrother` → `用 Agent browser`, `cloud` → `Claude Code 来写代码`).
 * When the recognized span does contain Chinese (`A进的` → `Agent`, `质补GM5.3`
 * → `智谱GLM5.3`), that Chinese is what was misheard and stays replaceable.
 */
function trimAddedHan(raw: readonly string[], a0: number, a1: number, out: readonly string[], b0: number, b1: number): [number, number] {
  if (raw.slice(a0, a1).some(token => HAN.test(token))) return [b0, b1]
  let from = b0
  let to = b1
  while (from < to && (HAN.test(out[from]!) || isFiller(out[from]!))) from += 1
  while (to > from && (HAN.test(out[to - 1]!) || isFiller(out[to - 1]!))) to -= 1
  return [from, to]
}

/**
 * Applies the model's term edits to the recognized text and nothing else.
 *
 * Each edit is trimmed of whitespace/punctuation on both edges: the recognized
 * text keeps its own spacing and punctuation there, and the model's are
 * dropped. An edit that is then empty on either side is dropped too — the model
 * was asked not to add or remove content, so a bare insertion (a completed
 * sentence, a "纠正后：" prefix) or deletion is not a term fix.
 */
export function rebuildCorrection(raw: string, corrected: string): { text: string; changes: TextChange[] } {
  const rawTokens = tokenize(raw)
  const outTokens = tokenize(corrected)
  const a = rawTokens.map(token => token.text)
  const b = outTokens.map(token => token.text)
  const tokenEnd = (tokens: Token[], index: number, text: string) =>
    index < tokens.length ? tokens[index]!.start : text.length

  let text = ''
  let cursor = 0
  const changes: TextChange[] = []
  for (const hunk of diffHunks(a, b)) {
    const [a0, a1] = trimFiller(a, hunk.a0, hunk.a1)
    const [b0, b1] = trimAddedHan(a, a0, a1, b, ...trimFiller(b, hunk.b0, hunk.b1))
    if (a0 === a1 || b0 === b1) continue
    const fromStart = rawTokens[a0]!.start
    const fromEnd = tokenEnd(rawTokens, a1, raw)
    const from = raw.slice(fromStart, fromEnd)
    const to = corrected.slice(outTokens[b0]!.start, tokenEnd(outTokens, b1, corrected))
    if (from === to) continue
    text += raw.slice(cursor, fromStart)
    const start = text.length
    text += to
    changes.push({ from, to, start, end: text.length })
    cursor = fromEnd
  }
  text += raw.slice(cursor)
  return { text, changes }
}
