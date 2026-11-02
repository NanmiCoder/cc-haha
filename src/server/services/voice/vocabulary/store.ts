/**
 * Personal voice vocabulary: terms the correction model should know, terms it
 * keeps fixing (suggestions), and terms the user said no to.
 *
 * Stored in `<cc-haha>/voice-vocabulary.json`:
 *   { version: 1, terms, suggestions, dismissed: string[] (lowercased), history }
 * Writes are serialized per file and atomic (tmp + rename). Unknown top-level
 * and per-entry fields survive every write. An unparsable file reads as empty
 * and is moved aside to `voice-vocabulary.json.corrupt-<ms>` on the next write
 * rather than overwritten.
 */

import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { ApiError } from '../../../middleware/errorHandler.js'
import { getCcHahaDir } from '../../../../utils/envUtils.js'
import {
  VOICE_VOCABULARY_MAX_TERMS,
  type VoiceVocabulary,
  type VoiceVocabularyAddResult,
  type VoiceVocabularyEntry,
  type VoiceVocabularyHistory,
  type VoiceVocabularyInput,
  type VoiceVocabularySource,
  type VoiceVocabularySuggestion,
} from '../types.js'

export const VOICE_VOCABULARY_FILE_NAME = 'voice-vocabulary.json'
export const VOICE_VOCABULARY_VERSION = 1
export const MAX_TERM_LENGTH = 64
export const MAX_ALIASES = 10
export const MAX_SUGGESTIONS = 100
export const MAX_SUGGESTION_HEARD_AS = 5
/** Oldest dismissals fall off past this; the list only stops re-suggesting. */
export const MAX_DISMISSED = 1000
/** A correction result is suggested only when it reads like a term, not a phrase. */
const MAX_SUGGESTION_LENGTH = 40
const MAX_SUGGESTION_WORDS = 4

const SOURCES: readonly VoiceVocabularySource[] = ['manual', 'history', 'correction']

type Extra = Record<string, unknown>
type StoredEntry = VoiceVocabularyEntry & Extra
type StoredSuggestion = VoiceVocabularySuggestion & Extra
type StoredHistory = VoiceVocabularyHistory & Extra

interface StoredVocabulary {
  /** Top-level fields this version does not know, kept verbatim. */
  extra: Extra
  terms: StoredEntry[]
  suggestions: StoredSuggestion[]
  dismissed: string[]
  history: StoredHistory | null
  /** The file on disk could not be parsed; move it aside before the next write. */
  corrupt: boolean
}

/** What correction and the history scan need: the terms and the keys not to suggest. */
export interface VocabularySnapshot {
  terms: VoiceVocabularyEntry[]
  /** Lowercased keys of every term and every dismissed term. */
  excluded: Set<string>
  /** Lowercased keys of vocabulary terms only. */
  known: Set<string>
}

export interface VoiceVocabularyStore {
  read(): Promise<VoiceVocabulary>
  snapshot(): Promise<VocabularySnapshot>
  add(entries: VoiceVocabularyInput[], options?: { source?: VoiceVocabularySource; dismiss?: string[] }): Promise<VoiceVocabularyAddResult>
  update(from: string, next: { term: string; aliases: string[] }): Promise<VoiceVocabulary>
  remove(term: string): Promise<VoiceVocabulary>
  dismissSuggestion(term: string): Promise<VoiceVocabulary>
  /** Records corrections the vocabulary did not explain; returns how many were kept. */
  recordSuggestions(changes: ReadonlyArray<{ from: string; to: string }>): Promise<number>
  markHistoryRun(): Promise<void>
}

export function isVoiceVocabularySource(value: unknown): value is VoiceVocabularySource {
  return typeof value === 'string' && (SOURCES as readonly string[]).includes(value)
}

/** Trimmed, inner whitespace collapsed, 1–64 characters, single line; null otherwise. */
export function normalizeVocabularyTerm(value: unknown): string | null {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) return null
  const term = value.trim().replace(/\s+/gu, ' ')
  const length = [...term].length
  return length >= 1 && length <= MAX_TERM_LENGTH ? term : null
}

export function vocabularyKey(term: string): string {
  return term.toLowerCase()
}

/** Valid, case-insensitively unique, never the term itself, at most ten. */
export function normalizeAliases(value: unknown, term: string): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set([vocabularyKey(term)])
  const aliases: string[] = []
  for (const item of value) {
    const alias = normalizeVocabularyTerm(item)
    if (!alias || seen.has(vocabularyKey(alias))) continue
    seen.add(vocabularyKey(alias))
    aliases.push(alias)
    if (aliases.length >= MAX_ALIASES) break
  }
  return aliases
}

/** A corrected span worth offering for the vocabulary: Latin script, short, a few words. */
export function isSuggestibleTerm(term: string): boolean {
  return /[A-Za-z]/.test(term) &&
    [...term].length <= MAX_SUGGESTION_LENGTH &&
    term.trim().split(/\s+/u).length <= MAX_SUGGESTION_WORDS
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function errnoCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined
}

function emptyVocabulary(corrupt = false): StoredVocabulary {
  return { extra: {}, terms: [], suggestions: [], dismissed: [], history: null, corrupt }
}

function normalizeStored(record: Record<string, unknown>): StoredVocabulary {
  const { version: _version, terms, suggestions, dismissed, history, ...extra } = record

  const seenTerms = new Set<string>()
  const storedTerms: StoredEntry[] = []
  for (const item of Array.isArray(terms) ? terms : []) {
    if (!isRecord(item)) continue
    const term = normalizeVocabularyTerm(item.term)
    if (!term || seenTerms.has(vocabularyKey(term))) continue
    seenTerms.add(vocabularyKey(term))
    storedTerms.push({
      ...item,
      term,
      aliases: normalizeAliases(item.aliases, term),
      source: isVoiceVocabularySource(item.source) ? item.source : 'manual',
      addedAt: typeof item.addedAt === 'string' ? item.addedAt : '',
    })
  }

  const seenSuggestions = new Set<string>()
  const storedSuggestions: StoredSuggestion[] = []
  for (const item of Array.isArray(suggestions) ? suggestions : []) {
    if (!isRecord(item)) continue
    const term = normalizeVocabularyTerm(item.term)
    if (!term || seenSuggestions.has(vocabularyKey(term))) continue
    seenSuggestions.add(vocabularyKey(term))
    storedSuggestions.push({
      ...item,
      term,
      heardAs: normalizeAliases(item.heardAs, term).slice(0, MAX_SUGGESTION_HEARD_AS),
      count: typeof item.count === 'number' && Number.isFinite(item.count) && item.count >= 1 ? Math.floor(item.count) : 1,
      lastSeenAt: typeof item.lastSeenAt === 'string' ? item.lastSeenAt : '',
    })
  }

  const storedDismissed = [...new Set(
    (Array.isArray(dismissed) ? dismissed : [])
      .map(item => normalizeVocabularyTerm(item))
      .filter((item): item is string => item !== null)
      .map(vocabularyKey),
  )]

  const storedHistory = isRecord(history) && typeof history.lastRunAt === 'string'
    ? {
      ...history,
      lastRunAt: history.lastRunAt,
      addedCount: typeof history.addedCount === 'number' && Number.isFinite(history.addedCount)
        ? Math.max(0, Math.floor(history.addedCount))
        : 0,
    }
    : null

  return {
    extra,
    terms: storedTerms,
    suggestions: storedSuggestions,
    dismissed: storedDismissed,
    history: storedHistory,
    corrupt: false,
  }
}

function toEntry(entry: StoredEntry): VoiceVocabularyEntry {
  return { term: entry.term, aliases: [...entry.aliases], source: entry.source, addedAt: entry.addedAt }
}

function toView(state: StoredVocabulary): VoiceVocabulary {
  const known = new Set(state.terms.map(entry => vocabularyKey(entry.term)))
  const dismissed = new Set(state.dismissed)
  const suggestions = state.suggestions
    .filter(item => !known.has(vocabularyKey(item.term)) && !dismissed.has(vocabularyKey(item.term)))
    .sort((left, right) => right.count - left.count || right.lastSeenAt.localeCompare(left.lastSeenAt))
    .map(item => ({ term: item.term, heardAs: [...item.heardAs], count: item.count, lastSeenAt: item.lastSeenAt }))
  return {
    terms: state.terms.map(toEntry),
    suggestions,
    history: state.history ? { lastRunAt: state.history.lastRunAt, addedCount: state.history.addedCount } : null,
    maxTerms: VOICE_VOCABULARY_MAX_TERMS,
  }
}

function serialize(state: StoredVocabulary): string {
  return JSON.stringify({
    ...state.extra,
    version: VOICE_VOCABULARY_VERSION,
    terms: state.terms,
    suggestions: state.suggestions,
    dismissed: state.dismissed,
    history: state.history,
  }, null, 2) + '\n'
}

function dismissKey(state: StoredVocabulary, key: string): void {
  state.dismissed = [...state.dismissed.filter(item => item !== key), key].slice(-MAX_DISMISSED)
  state.suggestions = state.suggestions.filter(item => vocabularyKey(item.term) !== key)
}

function requireTerm(value: unknown, label = 'term'): string {
  const term = normalizeVocabularyTerm(value)
  if (!term) throw ApiError.badRequest(`${label} must be 1–${MAX_TERM_LENGTH} characters on one line`)
  return term
}

/** Every mutation of one file runs after the previous one finished. */
const fileLocks = new Map<string, Promise<unknown>>()

function withFileLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(filePath) ?? Promise.resolve()
  const run = previous.then(task, task)
  const settled = run.then(() => {}, () => {})
  fileLocks.set(filePath, settled)
  void settled.then(() => {
    if (fileLocks.get(filePath) === settled) fileLocks.delete(filePath)
  })
  return run
}

export function defaultVoiceVocabularyPath(): string {
  return path.join(getCcHahaDir(), VOICE_VOCABULARY_FILE_NAME)
}

export class FileVoiceVocabularyStore implements VoiceVocabularyStore {
  private readonly resolvePath: () => string
  private readonly now: () => Date

  constructor(options: { filePath?: string | (() => string); now?: () => Date } = {}) {
    const { filePath } = options
    this.resolvePath = typeof filePath === 'function'
      ? filePath
      : filePath ? () => filePath : defaultVoiceVocabularyPath
    this.now = options.now ?? (() => new Date())
  }

  private async load(filePath: string): Promise<StoredVocabulary> {
    let text: string
    try {
      text = await fs.readFile(filePath, 'utf-8')
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return emptyVocabulary()
      throw ApiError.internal(`Failed to read the voice vocabulary: ${error instanceof Error ? error.message : String(error)}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return emptyVocabulary(true)
    }
    return isRecord(parsed) ? normalizeStored(parsed) : emptyVocabulary(true)
  }

  private async save(filePath: string, state: StoredVocabulary): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    if (state.corrupt) {
      try {
        await fs.rename(filePath, `${filePath}.corrupt-${Date.now()}`)
      } catch (error) {
        if (errnoCode(error) !== 'ENOENT') throw error
      }
      state.corrupt = false
    }
    const tmpFile = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
    try {
      await fs.writeFile(tmpFile, serialize(state), 'utf-8')
      await fs.rename(tmpFile, filePath)
    } catch (error) {
      await fs.unlink(tmpFile).catch(() => {})
      throw ApiError.internal(`Failed to write the voice vocabulary: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Load → change → save under the file lock; `shouldWrite` can skip a no-op write. */
  private mutate<T>(
    change: (state: StoredVocabulary) => T,
    shouldWrite: (result: T) => boolean = () => true,
  ): Promise<T> {
    const filePath = this.resolvePath()
    return withFileLock(filePath, async () => {
      const state = await this.load(filePath)
      const result = change(state)
      if (shouldWrite(result)) await this.save(filePath, state)
      return result
    })
  }

  async read(): Promise<VoiceVocabulary> {
    return toView(await this.load(this.resolvePath()))
  }

  async snapshot(): Promise<VocabularySnapshot> {
    const state = await this.load(this.resolvePath())
    const known = new Set(state.terms.map(entry => vocabularyKey(entry.term)))
    return {
      terms: state.terms.map(toEntry),
      known,
      excluded: new Set([...known, ...state.dismissed]),
    }
  }

  add(
    entries: VoiceVocabularyInput[],
    options: { source?: VoiceVocabularySource; dismiss?: string[] } = {},
  ): Promise<VoiceVocabularyAddResult> {
    const source = options.source ?? 'manual'
    const addedAt = this.now().toISOString()
    return this.mutate((state) => {
      const byKey = new Map(state.terms.map(entry => [vocabularyKey(entry.term), entry]))
      const touched = new Set<string>()
      let added = 0
      let merged = 0
      let skipped = 0

      for (const input of entries) {
        const term = isRecord(input) ? normalizeVocabularyTerm(input.term) : null
        const key = term ? vocabularyKey(term) : ''
        if (!term || touched.has(key)) {
          skipped += 1
          continue
        }
        const aliases = normalizeAliases(input.aliases, term)
        const existing = byKey.get(key)
        if (existing) {
          existing.aliases = normalizeAliases([...existing.aliases, ...aliases], existing.term)
          merged += 1
        } else if (state.terms.length >= VOICE_VOCABULARY_MAX_TERMS) {
          skipped += 1
          continue
        } else {
          const entry: StoredEntry = { term, aliases, source, addedAt }
          state.terms.push(entry)
          byKey.set(key, entry)
          added += 1
        }
        touched.add(key)
      }

      state.dismissed = state.dismissed.filter(key => !touched.has(key))
      state.suggestions = state.suggestions.filter(item => !touched.has(vocabularyKey(item.term)))
      for (const value of options.dismiss ?? []) {
        const term = normalizeVocabularyTerm(value)
        if (!term || byKey.has(vocabularyKey(term))) continue
        dismissKey(state, vocabularyKey(term))
      }
      if (source === 'history') {
        state.history = {
          ...state.history,
          lastRunAt: state.history?.lastRunAt ?? addedAt,
          addedCount: (state.history?.addedCount ?? 0) + added,
        }
      }
      return { vocabulary: toView(state), added, merged, skipped }
    })
  }

  async update(from: string, next: { term: string; aliases: string[] }): Promise<VoiceVocabulary> {
    const fromTerm = requireTerm(from, 'from')
    const term = requireTerm(next.term)
    if (!Array.isArray(next.aliases)) throw ApiError.badRequest('aliases must be an array of strings')
    return this.mutate((state) => {
      const fromKey = vocabularyKey(fromTerm)
      const index = state.terms.findIndex(entry => vocabularyKey(entry.term) === fromKey)
      if (index < 0) throw ApiError.notFound(`Not in the vocabulary: ${fromTerm}`)
      const key = vocabularyKey(term)
      if (key !== fromKey && state.terms.some(entry => vocabularyKey(entry.term) === key)) {
        throw ApiError.conflict(`Already in the vocabulary: ${term}`)
      }
      state.terms[index] = { ...state.terms[index]!, term, aliases: normalizeAliases(next.aliases, term) }
      state.dismissed = state.dismissed.filter(item => item !== key)
      state.suggestions = state.suggestions.filter(item => vocabularyKey(item.term) !== key)
      return toView(state)
    })
  }

  async remove(value: string): Promise<VoiceVocabulary> {
    const term = requireTerm(value)
    return this.mutate((state) => {
      const key = vocabularyKey(term)
      state.terms = state.terms.filter(entry => vocabularyKey(entry.term) !== key)
      dismissKey(state, key)
      return toView(state)
    })
  }

  async dismissSuggestion(value: string): Promise<VoiceVocabulary> {
    const term = requireTerm(value)
    return this.mutate((state) => {
      dismissKey(state, vocabularyKey(term))
      return toView(state)
    })
  }

  recordSuggestions(changes: ReadonlyArray<{ from: string; to: string }>): Promise<number> {
    const lastSeenAt = this.now().toISOString()
    return this.mutate((state) => {
      const known = new Set(state.terms.map(entry => vocabularyKey(entry.term)))
      const dismissed = new Set(state.dismissed)
      let recorded = 0
      for (const change of changes) {
        const term = normalizeVocabularyTerm(change.to)
        if (!term || !isSuggestibleTerm(term)) continue
        const key = vocabularyKey(term)
        if (known.has(key) || dismissed.has(key)) continue
        const existing = state.suggestions.find(item => vocabularyKey(item.term) === key)
        if (existing) {
          existing.term = term
          existing.heardAs = normalizeAliases([...existing.heardAs, change.from], term).slice(0, MAX_SUGGESTION_HEARD_AS)
          existing.count += 1
          existing.lastSeenAt = lastSeenAt
        } else {
          state.suggestions.push({ term, heardAs: normalizeAliases([change.from], term), count: 1, lastSeenAt })
        }
        recorded += 1
      }
      if (recorded > 0 && state.suggestions.length > MAX_SUGGESTIONS) {
        state.suggestions = [...state.suggestions]
          .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
          .slice(0, MAX_SUGGESTIONS)
      }
      return recorded
    }, recorded => recorded > 0)
  }

  markHistoryRun(): Promise<void> {
    const lastRunAt = this.now().toISOString()
    return this.mutate((state) => {
      state.history = { ...state.history, lastRunAt, addedCount: state.history?.addedCount ?? 0 }
    })
  }
}
