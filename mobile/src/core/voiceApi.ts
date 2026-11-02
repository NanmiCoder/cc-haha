import type { ApiClient } from './client'
import type {
  VoiceCatalog,
  VoiceLanguage,
  VoiceTranscript,
} from '../../../src/server/services/voice/types'

// Type-only imports share the wire contract without bundling server code or
// desktop browser APIs into the native app.
export type {
  VoiceCatalog,
  VoiceDownloadSource,
  VoiceErrorCode,
  VoiceFailure,
  VoiceFailureReason,
  VoiceLanguage,
  VoiceLimits,
  VoicePreparationPhase,
  VoicePreparationState,
  VoicePreparationStep,
  VoicePreferences,
  VoiceProviderInfo,
  VoiceProviderStatus,
  VoiceTranscript,
} from '../../../src/server/services/voice/types'

// Local recognition allows 60 s for cold start and 120 s for inference;
// uploads and queued recordings need additional time beyond the JSON timeout.
export const VOICE_TRANSCRIBE_TIMEOUT_MS = 240_000

export type TranscribeVoiceOptions = {
  providerId?: string
  language?: VoiceLanguage
  signal?: AbortSignal
  timeoutMs?: number
}

export function loadVoiceCatalog(
  client: ApiClient,
  signal?: AbortSignal,
): Promise<VoiceCatalog> {
  return client.get<VoiceCatalog>('/api/voice/catalog', { signal })
}

/** Uploads a 16 kHz mono PCM16 WAV; omitted overrides use desktop preferences. */
export function transcribeVoice(
  client: ApiClient,
  bytes: Uint8Array,
  options: TranscribeVoiceOptions = {},
): Promise<VoiceTranscript> {
  const query = new URLSearchParams()
  if (options.providerId !== undefined) query.set('provider', options.providerId)
  if (options.language !== undefined) query.set('language', options.language)
  const suffix = query.toString()
  return client.request<VoiceTranscript>(
    `/api/voice/transcribe${suffix ? `?${suffix}` : ''}`,
    {
      method: 'POST',
      rawBody: bytes,
      contentType: 'audio/wav',
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? VOICE_TRANSCRIBE_TIMEOUT_MS,
    },
  )
}
