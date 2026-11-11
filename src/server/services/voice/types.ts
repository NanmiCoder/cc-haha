/**
 * Voice input (dictation) shared contract.
 *
 * The desktop renderer records audio, uploads a 16 kHz mono PCM16 WAV, and the
 * server transcribes it through a registered SpeechProvider. `desktop/src/api/voice.ts`
 * mirrors the wire types below; keep the two in sync (a parity test pins them).
 */

/** Language hint codes accepted by providers. `auto` lets the model detect. */
export type VoiceLanguage = 'auto' | 'zh' | 'en' | 'ja' | 'ko' | 'yue'

/** Where local assets are fetched from. `auto` races both; the others pin one. */
export type VoiceDownloadSource = 'auto' | 'official' | 'mirror'

export type VoicePreparationPhase = 'unprepared' | 'downloading' | 'verifying' | 'ready' | 'failed' | 'cancelled'

/** Which resource is currently being fetched or checked. */
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

export interface VoiceFailure {
  reason: VoiceFailureReason
  /** Origin that failed, credentials stripped. */
  source?: string
  /** HTTP status when reason is `http`. */
  status?: number
  /** Resource file name, e.g. `model.int8.onnx`. */
  resource?: string
  message: string
}

export interface VoicePreparationState {
  phase: VoicePreparationPhase
  step?: VoicePreparationStep
  resource?: string
  completedBytes?: number
  totalBytes?: number
  /** Bytes already on disk when this download resumed after an interruption. */
  resumedFromBytes?: number
  /** Which mirror/origin is serving the current download. */
  source?: string
  error?: VoiceFailure
}

export interface VoiceProviderInfo {
  id: string
  name: string
  /** `local` runs on the machine hosting the server; `cloud` uploads audio. */
  location: 'local' | 'cloud'
  languages: VoiceLanguage[]
  /** Total download size in bytes for local providers (runtime + models). */
  downloadBytes?: number
}

export interface VoiceProviderStatus {
  info: VoiceProviderInfo
  preparation: VoicePreparationState
}

export interface VoicePreferences {
  enabled: boolean
  providerId: string
  language: VoiceLanguage
  downloadSource: VoiceDownloadSource
  /** Sends the recognized text (never audio) to a chat model to fix misheard terms. */
  correctionEnabled: boolean
  /** Both null: follow the default provider and use its fast (Haiku-slot) model. */
  correctionProviderId: string | null
  correctionModelId: string | null
}

export interface VoiceLimits {
  maxAudioSeconds: number
  maxAudioBytes: number
}

/** A concrete provider + model the correction request goes to. */
export interface VoiceCorrectionTarget {
  providerId: string
  providerName: string
  modelId: string
}

export interface VoiceCorrectionInfo {
  /** What "follow the default provider" resolves to right now; null when nothing usable is configured. */
  defaultTarget: VoiceCorrectionTarget | null
  /** What the saved preferences resolve to; null when the chosen provider or model no longer exists. */
  target: VoiceCorrectionTarget | null
}

export interface VoiceCatalog {
  /** False on platforms without a local runtime build; UI hides the feature. */
  supported: boolean
  providers: VoiceProviderStatus[]
  preferences: VoicePreferences
  limits: VoiceLimits
  correction: VoiceCorrectionInfo
}

export interface VoiceTranscript {
  text: string
  audioSeconds: number
  inferenceSeconds: number
}

/** One replaced span. Offsets index the corrected `text`; `from` is what recognition produced. */
export interface VoiceCorrectionChange {
  from: string
  to: string
  start: number
  end: number
  inVocabulary: boolean
}

export interface VoiceCorrection {
  /** Corrected text, single line and trimmed, the same normalization the composer applies. */
  text: string
  changes: VoiceCorrectionChange[]
  target: VoiceCorrectionTarget
  seconds: number
}

export type VoiceCorrectionFailureReason = 'auth' | 'rate-limit' | 'timeout' | 'upstream' | 'invalid-output'

export type VoiceVocabularySource = 'manual' | 'history' | 'correction'

export interface VoiceVocabularyEntry {
  term: string
  /** How recognition tends to mishear the term; optional hints for the correction model. */
  aliases: string[]
  source: VoiceVocabularySource
  addedAt: string
}

/** A term the correction model fixed that is not in the vocabulary yet. */
export interface VoiceVocabularySuggestion {
  term: string
  heardAs: string[]
  count: number
  lastSeenAt: string
}

export interface VoiceVocabularyHistory {
  lastRunAt: string
  addedCount: number
}

export interface VoiceVocabulary {
  terms: VoiceVocabularyEntry[]
  suggestions: VoiceVocabularySuggestion[]
  history: VoiceVocabularyHistory | null
  maxTerms: number
}

export interface VoiceVocabularyInput {
  term: string
  aliases?: string[]
}

export interface VoiceVocabularyAddResult {
  vocabulary: VoiceVocabulary
  added: number
  /** Already present; new aliases were merged into the existing entry. */
  merged: number
  /** Empty, too long, duplicated within the request, or over the size limit. */
  skipped: number
}

export type VoiceHistorySourceId = 'claude-code' | 'codex'

export interface VoiceHistorySource {
  id: VoiceHistorySourceId
  /** Whether it has sessions within the analyzed days. */
  available: boolean
  sessions: number
}

export interface VoiceHistorySourceList {
  sources: VoiceHistorySource[]
  /** How many days back the analysis reads. */
  days: number
}

export type VoiceHistoryCategory = 'project' | 'model' | 'tool' | 'other'

export interface VoiceHistoryTerm {
  term: string
  sessions: number
  /** The model or the local filter thinks it may not be a proper noun; unchecked by default. */
  doubtful: boolean
  inVocabulary: boolean
}

export interface VoiceHistoryGroup {
  category: VoiceHistoryCategory
  terms: VoiceHistoryTerm[]
}

export interface VoiceHistorySuggestions {
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

export interface VoiceErrorBody {
  error: VoiceErrorCode
  message: string
  /** Set with `voice/correction-failed`. */
  reason?: VoiceCorrectionFailureReason
}

export const VOICE_LIMITS: VoiceLimits = {
  maxAudioSeconds: 120,
  // 120 s of 16 kHz mono PCM16 is 3,840,044 bytes.
  maxAudioBytes: 4 * 1024 * 1024,
}

/**
 * `enabled` is on by default: the composer shows the microphone from the start
 * and its first click leads to the model download. This only fills in a value
 * that was never saved — every desktop-ui.json write since voice input shipped
 * stores `enabled` explicitly, and an explicit `false` is kept.
 */
export const DEFAULT_VOICE_PREFERENCES: VoicePreferences = {
  enabled: true,
  providerId: 'sensevoice-local',
  language: 'auto',
  downloadSource: 'auto',
  correctionEnabled: false,
  correctionProviderId: null,
  correctionModelId: null,
}

/** Upper bound on vocabulary entries; every entry is sent with each correction request. */
export const VOICE_VOCABULARY_MAX_TERMS = 500

/** Minimal provider contract. A registry is a plain Map keyed by `info.id`. */
export interface SpeechProvider {
  readonly info: VoiceProviderInfo
  /**
   * Frees whatever the provider keeps warm (a worker process holding a model).
   * Called when the user switches to another provider; the next transcribe starts it again.
   */
  release?(): Promise<void>
  /** Present for providers that need local assets before first use. */
  readonly preparation?: {
    status(): Promise<VoicePreparationState>
    prepare(
      signal: AbortSignal,
      report: (state: VoicePreparationState) => void,
      options?: { downloadSource?: VoiceDownloadSource },
    ): Promise<void>
    remove(): Promise<void>
  }
  transcribe(
    wav: Uint8Array,
    options: { language: VoiceLanguage },
    signal: AbortSignal,
  ): Promise<VoiceTranscript>
}
