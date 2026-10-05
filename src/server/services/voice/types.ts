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
}

export interface VoiceLimits {
  maxAudioSeconds: number
  maxAudioBytes: number
}

export interface VoiceCatalog {
  /** False on platforms without a local runtime build; UI hides the feature. */
  supported: boolean
  providers: VoiceProviderStatus[]
  preferences: VoicePreferences
  limits: VoiceLimits
}

export interface VoiceTranscript {
  text: string
  audioSeconds: number
  inferenceSeconds: number
}

export type VoiceErrorCode = 'voice/invalid-audio' | 'voice/not-ready' | 'voice/failed' | 'voice/unknown-provider'

export interface VoiceErrorBody {
  error: VoiceErrorCode
  message: string
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
}

/** Minimal provider contract. A registry is a plain Map keyed by `info.id`. */
export interface SpeechProvider {
  readonly info: VoiceProviderInfo
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
