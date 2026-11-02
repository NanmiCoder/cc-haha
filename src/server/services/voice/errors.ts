import type { VoiceCorrectionFailureReason, VoiceErrorBody, VoiceErrorCode } from './types.js'

const STATUS_BY_CODE: Record<VoiceErrorCode, number> = {
  'voice/invalid-audio': 400,
  'voice/unknown-provider': 404,
  'voice/not-ready': 409,
  'voice/failed': 500,
  'voice/correction-unavailable': 409,
  'voice/correction-failed': 502,
}

export class VoiceServiceError extends Error {
  readonly code: VoiceErrorCode
  readonly status: number
  /** Set with `voice/correction-failed`. */
  readonly reason?: VoiceCorrectionFailureReason

  constructor(code: VoiceErrorCode, message: string, reason?: VoiceCorrectionFailureReason) {
    super(message)
    this.name = 'VoiceServiceError'
    this.code = code
    this.status = STATUS_BY_CODE[code]
    if (reason) this.reason = reason
  }

  toBody(): VoiceErrorBody {
    return this.reason
      ? { error: this.code, message: this.message, reason: this.reason }
      : { error: this.code, message: this.message }
  }
}
