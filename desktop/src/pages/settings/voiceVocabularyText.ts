import type { VoiceVocabularyEntry, VoiceVocabularyInput } from '@/api/voice'
import { vocabularyKey } from '@/stores/voiceVocabularyStore'

/** Same limits the server enforces, so the preview counts what will actually be kept. */
export const VOCABULARY_TERM_MAX_LENGTH = 64
export const VOCABULARY_ALIAS_MAX = 10

const ALIAS_SEPARATORS = /[,，、]/
const TERM_SEPARATOR = /[=＝]/

/** Trims and collapses inner whitespace; `null` when the result is empty or too long. */
export function cleanVocabularyTerm(raw: string): string | null {
  const term = raw.trim().replace(/\s+/g, ' ')
  if (!term || term.length > VOCABULARY_TERM_MAX_LENGTH) return null
  return term
}

/** "a, b、c" → ["a", "b", "c"]: deduped case-insensitively, never the term itself, at most 10. */
export function parseVocabularyAliases(raw: string, term?: string): string[] {
  const termKey = term ? vocabularyKey(term) : null
  const seen = new Set<string>()
  const aliases: string[] = []
  for (const part of raw.split(ALIAS_SEPARATORS)) {
    const alias = cleanVocabularyTerm(part)
    if (!alias) continue
    const key = vocabularyKey(alias)
    if (key === termKey || seen.has(key)) continue
    seen.add(key)
    aliases.push(alias)
    if (aliases.length === VOCABULARY_ALIAS_MAX) break
  }
  return aliases
}

export type BulkVocabularyPreview = {
  /** One entry per distinct term, aliases of repeated lines merged in. */
  entries: VoiceVocabularyInput[]
  /** Terms not in the vocabulary yet. */
  added: number
  /** Terms already in the vocabulary; their aliases are merged. */
  merged: number
  /** Lines that repeated a term earlier in the paste. */
  duplicates: number
  /** Lines with no term (`= alias`) or a term longer than the limit. */
  invalid: number
}

/**
 * Reads a pasted vocabulary: one term per line, optionally followed by what
 * it is often heard as — `term = alias1, alias2`. Full-width `＝`, `，` and
 * `、` work too, since that is what a Chinese keyboard types.
 */
export function parseBulkVocabulary(text: string, existing: readonly VoiceVocabularyEntry[]): BulkVocabularyPreview {
  const known = new Set(existing.map(entry => vocabularyKey(entry.term)))
  const byKey = new Map<string, VoiceVocabularyInput>()
  let duplicates = 0
  let invalid = 0
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const separator = line.search(TERM_SEPARATOR)
    const term = cleanVocabularyTerm(separator === -1 ? line : line.slice(0, separator))
    if (!term) {
      invalid += 1
      continue
    }
    const aliases = separator === -1 ? [] : parseVocabularyAliases(line.slice(separator + 1), term)
    const key = vocabularyKey(term)
    const earlier = byKey.get(key)
    if (earlier) {
      duplicates += 1
      earlier.aliases = parseVocabularyAliases([...(earlier.aliases ?? []), ...aliases].join(','), earlier.term)
      continue
    }
    byKey.set(key, { term, aliases })
  }
  const entries = [...byKey.values()]
  const merged = entries.filter(entry => known.has(vocabularyKey(entry.term))).length
  return { entries, added: entries.length - merged, merged, duplicates, invalid }
}
