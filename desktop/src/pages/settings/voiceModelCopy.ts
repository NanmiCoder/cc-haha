import type { TranslationKey } from '@/i18n/locales/en'

/** The model every install starts with, and the one deleting the active model falls back to. */
export const DEFAULT_VOICE_PROVIDER_ID = 'sensevoice-local'

type VoiceModelCopy = {
  vendor: TranslationKey
  description: TranslationKey
  /** Seconds to recognize one sentence, measured on real dictation clips. */
  sentenceSeconds: number
  /** Memory the loaded model holds while recognizing, in GB. */
  memoryGb: number
}

/**
 * What the recognition model list says about each known model. Keyed by the
 * server's provider id; a provider not listed here still shows, with just its
 * name and download size.
 */
export const VOICE_MODEL_COPY: Readonly<Record<string, VoiceModelCopy>> = {
  'sensevoice-local': {
    vendor: 'voice.settings.model.vendor.alibaba',
    description: 'voice.settings.model.description.sensevoice',
    sentenceSeconds: 0.1,
    memoryGb: 1,
  },
  // The two LLM-based models run with 4 threads: about 0.5 / 0.6 s for a 7 s
  // sentence on an M5 Pro, and the worker held ~3 GB (Fun-ASR-Nano measured 3.08 GB).
  'funasr-nano-local': {
    vendor: 'voice.settings.model.vendor.alibaba',
    description: 'voice.settings.model.description.funasrNano',
    sentenceSeconds: 0.5,
    memoryGb: 3,
  },
  'qwen3-asr-local': {
    vendor: 'voice.settings.model.vendor.qwen',
    description: 'voice.settings.model.description.qwen3Asr',
    sentenceSeconds: 0.6,
    memoryGb: 3,
  },
}

export function voiceModelCopy(providerId: string): VoiceModelCopy | undefined {
  return Object.prototype.hasOwnProperty.call(VOICE_MODEL_COPY, providerId) ? VOICE_MODEL_COPY[providerId] : undefined
}
