import { create } from 'zustand'
import {
  voiceApi,
  type VoiceVocabulary,
  type VoiceVocabularyAddResult,
  type VoiceVocabularyInput,
  type VoiceVocabularySource,
} from '@/api/voice'

type VoiceVocabularyState = {
  vocabulary: VoiceVocabulary | null
  loading: boolean
  /** Why the last load failed; mutations throw to their caller instead. */
  error: string | null
  load: (options?: { force?: boolean }) => Promise<void>
  add: (
    entries: VoiceVocabularyInput[],
    options?: { source?: VoiceVocabularySource; dismiss?: string[] },
  ) => Promise<VoiceVocabularyAddResult>
  update: (from: string, next: { term: string; aliases: string[] }) => Promise<void>
  remove: (term: string) => Promise<void>
  dismissSuggestion: (term: string) => Promise<void>
}

/**
 * The server took none of the entries: the vocabulary is full, or the word is
 * longer than a term may be. It answers 200 with `skipped`, so without this the
 * caller would show the word as added.
 */
export class VoiceVocabularySkippedError extends Error {
  constructor() {
    super('The vocabulary did not take the word: it is full or the word is too long')
    this.name = 'VoiceVocabularySkippedError'
  }
}

/**
 * The personal vocabulary, shared by Settings → Voice input and the composer's
 * correction notice ("add to vocabulary"), so a word added from one shows up
 * in the other without a reload.
 */
export const useVoiceVocabularyStore = create<VoiceVocabularyState>((set, get) => ({
  vocabulary: null,
  loading: false,
  error: null,

  load: async (options) => {
    if (get().loading) return
    if (get().vocabulary && !options?.force) return
    set({ loading: true })
    try {
      set({ vocabulary: await voiceApi.vocabulary(), error: null })
    } catch (error) {
      set({ error: String(error) })
    } finally {
      set({ loading: false })
    }
  },

  add: async (entries, options) => {
    const result = await voiceApi.addVocabulary(entries, options)
    set({ vocabulary: result.vocabulary, error: null })
    if (entries.length > 0 && result.added === 0 && result.merged === 0) throw new VoiceVocabularySkippedError()
    return result
  },

  update: async (from, next) => {
    const { vocabulary } = await voiceApi.updateVocabulary(from, next)
    set({ vocabulary, error: null })
  },

  remove: async (term) => {
    const { vocabulary } = await voiceApi.removeVocabulary(term)
    set({ vocabulary, error: null })
  },

  dismissSuggestion: async (term) => {
    const { vocabulary } = await voiceApi.dismissSuggestion(term)
    set({ vocabulary, error: null })
  },
}))

/** Vocabulary keys are case-insensitive, matching the server's store. */
export function vocabularyKey(term: string): string {
  return term.trim().replace(/\s+/g, ' ').toLowerCase()
}
