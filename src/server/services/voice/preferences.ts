import {
  DEFAULT_VOICE_PREFERENCES,
  type VoiceDownloadSource,
  type VoiceLanguage,
  type VoicePreferences,
} from './types.js'

export const VOICE_LANGUAGES: readonly VoiceLanguage[] = ['auto', 'zh', 'en', 'ja', 'ko', 'yue']
export const VOICE_DOWNLOAD_SOURCES: readonly VoiceDownloadSource[] = ['auto', 'official', 'mirror']

const MAX_PROVIDER_ID_LENGTH = 80
const MAX_MODEL_ID_LENGTH = 200

/** A saved id, or null when absent, blank or implausibly long. */
function optionalId(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null
}

export function isVoiceLanguage(value: unknown): value is VoiceLanguage {
  return typeof value === 'string' && (VOICE_LANGUAGES as readonly string[]).includes(value)
}

/**
 * Lenient read-side normalization for the `voiceInput` section of
 * desktop-ui.json. Unknown fields are kept so a newer build's data survives a
 * round trip through an older one.
 */
export function isVoiceDownloadSource(value: unknown): value is VoiceDownloadSource {
  return typeof value === 'string' && (VOICE_DOWNLOAD_SOURCES as readonly string[]).includes(value)
}

export function normalizeVoicePreferences(value: unknown): VoicePreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_VOICE_PREFERENCES }
  }
  const record = value as Record<string, unknown>
  const providerId = typeof record.providerId === 'string' ? record.providerId.trim() : ''
  const correctionProviderId = optionalId(record.correctionProviderId, MAX_PROVIDER_ID_LENGTH)
  const correctionModelId = optionalId(record.correctionModelId, MAX_MODEL_ID_LENGTH)
  // A fixed target needs both halves; a lone provider or model reads as "follow the default".
  const fixed = correctionProviderId !== null && correctionModelId !== null
  return {
    ...record,
    enabled: typeof record.enabled === 'boolean' ? record.enabled : DEFAULT_VOICE_PREFERENCES.enabled,
    providerId: providerId.length > 0 && providerId.length <= MAX_PROVIDER_ID_LENGTH
      ? providerId
      : DEFAULT_VOICE_PREFERENCES.providerId,
    language: isVoiceLanguage(record.language) ? record.language : DEFAULT_VOICE_PREFERENCES.language,
    // Absent in files written before the source picker existed: those read as `auto`.
    downloadSource: isVoiceDownloadSource(record.downloadSource)
      ? record.downloadSource
      : DEFAULT_VOICE_PREFERENCES.downloadSource,
    // Absent in files written before AI correction existed: those read as off.
    correctionEnabled: typeof record.correctionEnabled === 'boolean'
      ? record.correctionEnabled
      : DEFAULT_VOICE_PREFERENCES.correctionEnabled,
    correctionProviderId: fixed ? correctionProviderId : null,
    correctionModelId: fixed ? correctionModelId : null,
  }
}
