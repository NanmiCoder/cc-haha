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
export const useVoiceVocabularyStore = create<VoiceVocabularyState>((set, get) => {
  let revision = 0
  let loading: Promise<void> | null = null
  let refreshRequested = false
  let mutations = Promise.resolve()

  // Mutation responses are full snapshots. Keep their server writes in order
  // and invalidate any older GET before publishing a confirmed mutation.
  function mutate<T>(action: () => Promise<T>): Promise<T> {
    const pending = mutations.then(action)
    mutations = pending.then(() => {}, () => {})
    return pending
  }

  function applyVocabulary(vocabulary: VoiceVocabulary) {
    revision += 1
    set({ vocabulary, error: null })
  }

  return {
    vocabulary: null,
    loading: false,
    error: null,

    load: async (options) => {
      if (loading) {
        if (options?.force) refreshRequested = true
        return loading
      }
      if (get().vocabulary && !options?.force) return
      set({ loading: true })
      loading = (async () => {
        try {
          do {
            refreshRequested = false
            const startedAt = revision
            try {
              const vocabulary = await voiceApi.vocabulary()
              if (!refreshRequested && startedAt === revision) set({ vocabulary, error: null })
            } catch (error) {
              if (!refreshRequested && startedAt === revision) set({ error: String(error) })
            }
          } while (refreshRequested)
        } finally {
          loading = null
          set({ loading: false })
        }
      })()
      return loading
    },

    add: (entries, options) => mutate(async () => {
      const result = await voiceApi.addVocabulary(entries, options)
      applyVocabulary(result.vocabulary)
      if (entries.length > 0 && result.added === 0 && result.merged === 0) throw new VoiceVocabularySkippedError()
      return result
    }),

    update: (from, next) => mutate(async () => {
      const { vocabulary } = await voiceApi.updateVocabulary(from, next)
      applyVocabulary(vocabulary)
    }),

    remove: (term) => mutate(async () => {
      const { vocabulary } = await voiceApi.removeVocabulary(term)
      applyVocabulary(vocabulary)
    }),

    dismissSuggestion: (term) => mutate(async () => {
      const { vocabulary } = await voiceApi.dismissSuggestion(term)
      applyVocabulary(vocabulary)
    }),
  }
})

/** Vocabulary keys are case-insensitive, matching the server's store. */
export function vocabularyKey(term: string): string {
  return term.trim().replace(/\s+/g, ' ').toLowerCase()
}
