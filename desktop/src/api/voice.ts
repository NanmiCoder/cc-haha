import { ApiError, api, getApiUrl, getAuthToken } from './client'

/**
 * Wire types mirror `src/server/services/voice/types.ts`. Keep them in sync;
 * the server's `contractParity.test.ts` pins them against each other.
 */
export type VoiceLanguage = 'auto' | 'zh' | 'en' | 'ja' | 'ko' | 'yue'

export type VoiceDownloadSource = 'auto' | 'official' | 'mirror'

export type VoicePreparationPhase = 'unprepared' | 'downloading' | 'verifying' | 'ready' | 'failed' | 'cancelled'
export type VoicePreparationStep = 'runtime' | 'model' | 'vad' | 'verify'
export type VoiceFailureReason =
  | 'network'
  | 'dns'
  | 'timeout'
  | 'certificate'
  | 'http'
  | 'integrity'
  | 'storage'
  | 'unsupported-platform'
  | 'unknown'

export type VoiceFailure = {
  reason: VoiceFailureReason
  source?: string
  status?: number
  resource?: string
  message: string
}

export type VoicePreparationState = {
  phase: VoicePreparationPhase
  step?: VoicePreparationStep
  resource?: string
  completedBytes?: number
  totalBytes?: number
  resumedFromBytes?: number
  source?: string
  error?: VoiceFailure
}

export type VoiceProviderInfo = {
  id: string
  name: string
  location: 'local' | 'cloud'
  languages: VoiceLanguage[]
  downloadBytes?: number
}

export type VoiceProviderStatus = {
  info: VoiceProviderInfo
  preparation: VoicePreparationState
}

export type VoicePreferences = {
  enabled: boolean
  providerId: string
  language: VoiceLanguage
  downloadSource: VoiceDownloadSource
  correctionEnabled: boolean
  correctionProviderId: string | null
  correctionModelId: string | null
}

export type VoiceLimits = {
  maxAudioSeconds: number
  maxAudioBytes: number
}

export type VoiceCorrectionTarget = {
  providerId: string
  providerName: string
  modelId: string
}

export type VoiceCorrectionInfo = {
  defaultTarget: VoiceCorrectionTarget | null
  target: VoiceCorrectionTarget | null
}

export type VoiceCatalog = {
  supported: boolean
  providers: VoiceProviderStatus[]
  preferences: VoicePreferences
  limits: VoiceLimits
  correction: VoiceCorrectionInfo
}

export type VoiceTranscript = {
  text: string
  audioSeconds: number
  inferenceSeconds: number
}

export type VoiceCorrectionChange = {
  from: string
  to: string
  start: number
  end: number
  inVocabulary: boolean
}

export type VoiceCorrection = {
  text: string
  changes: VoiceCorrectionChange[]
  target: VoiceCorrectionTarget
  seconds: number
}

export type VoiceCorrectionFailureReason = 'auth' | 'rate-limit' | 'timeout' | 'upstream' | 'invalid-output'

export type VoiceVocabularySource = 'manual' | 'history' | 'correction'

export type VoiceVocabularyEntry = {
  term: string
  aliases: string[]
  source: VoiceVocabularySource
  addedAt: string
}

export type VoiceVocabularySuggestion = {
  term: string
  heardAs: string[]
  count: number
  lastSeenAt: string
}

export type VoiceVocabularyHistory = {
  lastRunAt: string
  addedCount: number
}

export type VoiceVocabulary = {
  terms: VoiceVocabularyEntry[]
  suggestions: VoiceVocabularySuggestion[]
  history: VoiceVocabularyHistory | null
  maxTerms: number
}

export type VoiceVocabularyInput = {
  term: string
  aliases?: string[]
}

export type VoiceVocabularyAddResult = {
  vocabulary: VoiceVocabulary
  added: number
  merged: number
  skipped: number
}

export type VoiceHistorySourceId = 'claude-code' | 'codex'

export type VoiceHistorySource = {
  id: VoiceHistorySourceId
  available: boolean
  sessions: number
}

export type VoiceHistoryCategory = 'project' | 'model' | 'tool' | 'other'

export type VoiceHistoryTerm = {
  term: string
  sessions: number
  doubtful: boolean
  inVocabulary: boolean
}

export type VoiceHistoryGroup = {
  category: VoiceHistoryCategory
  terms: VoiceHistoryTerm[]
}

export type VoiceHistorySuggestions = {
  groups: VoiceHistoryGroup[]
  sessions: number
  messages: number
  candidates: number
  target: VoiceCorrectionTarget
  seconds: number
}

export type VoiceErrorCode =
  | 'voice/invalid-audio'
  | 'voice/not-ready'
  | 'voice/failed'
  | 'voice/unknown-provider'
  | 'voice/correction-unavailable'
  | 'voice/correction-failed'

/** Picks the correction model: both null follows the default provider's fast model. */
export type VoiceCorrectionModelChoice = {
  providerId: string | null
  modelId: string | null
}

export const voiceApi = {
  catalog: () => api.get<VoiceCatalog>('/api/voice/catalog'),

  updatePreferences: (patch: Partial<VoicePreferences>) =>
    api.put<{ preferences: VoicePreferences }>('/api/voice/preferences', patch),

  /** Starts (or joins) the download for a provider; poll `providerStatus` for progress. */
  prepare: (providerId: string) =>
    api.post<VoiceProviderStatus>(`/api/voice/providers/${encodeURIComponent(providerId)}/prepare`),

  cancelPrepare: (providerId: string) =>
    api.post<VoiceProviderStatus>(`/api/voice/providers/${encodeURIComponent(providerId)}/cancel`),

  providerStatus: (providerId: string) =>
    api.get<VoiceProviderStatus>(`/api/voice/providers/${encodeURIComponent(providerId)}/status`),

  /** Deletes downloaded runtime and models for a provider. */
  removeAssets: (providerId: string) =>
    api.delete<VoiceProviderStatus>(`/api/voice/providers/${encodeURIComponent(providerId)}/assets`),

  /** Uploads a 16 kHz mono PCM16 WAV as the raw request body. */
  async transcribe(
    wav: Blob,
    options: { providerId: string; language: VoiceLanguage; signal?: AbortSignal },
  ): Promise<VoiceTranscript> {
    const headers: Record<string, string> = { 'Content-Type': 'audio/wav' }
    const token = getAuthToken()
    if (token) headers.Authorization = `Bearer ${token}`
    const query = new URLSearchParams({ provider: options.providerId, language: options.language })
    const res = await fetch(getApiUrl(`/api/voice/transcribe?${query}`), {
      method: 'POST',
      headers,
      body: wav,
      signal: options.signal,
    })
    if (!res.ok) {
      // Read the body once: a proxy error page is not JSON, and a second read would throw.
      const text = await res.text().catch(() => '')
      let body: unknown = text
      try {
        body = JSON.parse(text)
      } catch {
        // Keep the raw text.
      }
      throw new ApiError(res.status, body)
    }
    return res.json() as Promise<VoiceTranscript>
  },

  /**
   * Asks the configured correction model to fix misheard terms in a transcript.
   * The caller owns the time budget through `signal`.
   */
  correct: (text: string, options: { signal?: AbortSignal } = {}) =>
    api.post<VoiceCorrection>('/api/voice/correct', { text }, { signal: options.signal }),

  vocabulary: () => api.get<VoiceVocabulary>('/api/voice/vocabulary'),

  /** Adds entries; ones already present get their aliases merged. `dismiss` stops suggesting those terms. */
  addVocabulary: (entries: VoiceVocabularyInput[], options: { source?: VoiceVocabularySource; dismiss?: string[] } = {}) =>
    api.post<VoiceVocabularyAddResult>('/api/voice/vocabulary/terms', { entries, ...options }),

  /** Replaces one entry, found by its current term. */
  updateVocabulary: (from: string, next: { term: string; aliases: string[] }) =>
    api.put<{ vocabulary: VoiceVocabulary }>('/api/voice/vocabulary/terms', { from, ...next }),

  removeVocabulary: (term: string) =>
    api.delete<{ vocabulary: VoiceVocabulary }>(`/api/voice/vocabulary/terms?${new URLSearchParams({ term })}`),

  dismissSuggestion: (term: string) =>
    api.post<{ vocabulary: VoiceVocabulary }>('/api/voice/vocabulary/suggestions/dismiss', { term }),

  /** Which chat histories exist on this computer, with session counts. Local only. */
  historySources: () =>
    api.get<{ sources: VoiceHistorySource[] }>('/api/voice/vocabulary/history/sources'),

  /**
   * Counts terms in the user's own messages locally, then makes one model call
   * with the candidate words and counts (never message text) to pick vocabulary.
   */
  suggestFromHistory: (
    sources: VoiceHistorySourceId[],
    model: VoiceCorrectionModelChoice,
    options: { signal?: AbortSignal } = {},
  ) =>
    api.post<VoiceHistorySuggestions>(
      '/api/voice/vocabulary/history/suggest',
      { sources, ...model },
      { signal: options.signal, timeout: 120_000 },
    ),
}
