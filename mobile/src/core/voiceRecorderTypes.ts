export type VoiceRecorderErrorCode = 'permission' | 'unavailable' | 'interrupted' | 'failed' | 'no-device' | 'device-busy'

export class VoiceRecorderError extends Error {
  constructor(readonly code: VoiceRecorderErrorCode, message: string = code) {
    super(message)
    this.name = 'VoiceRecorderError'
  }
}

export type VoiceRecordingResult = { wav: Uint8Array, seconds: number }

export type VoiceRecording = {
  /** Real microphone level in 0..1. */
  getLevel(): number
  /** Repeated stops share the same result, after the native writer has flushed. */
  stop(): Promise<VoiceRecordingResult>
  cancel(): void
}

export type StartVoiceRecordingOptions = {
  maxSeconds: number
  signal?: AbortSignal
  onLevel?(level: number): void
  onLimitReached?(): void
  onInterrupted?(error: VoiceRecorderError): void
  /** Android permission Activities pause the host before capture starts. */
  onPermissionRequest?(pending: boolean): void
}

export function voiceAbortError(): Error {
  const error = new Error('Recording cancelled')
  error.name = 'AbortError'
  return error
}

export function voiceCaptureLimit(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new VoiceRecorderError('failed', 'Invalid recording limit')
  return Math.min(120, seconds)
}

export function microphoneLevel(channels: readonly Float32Array[], frames: number): number {
  if (!channels.length || frames <= 0) return 0
  let power = 0
  for (let index = 0; index < frames; index++) {
    let mixed = 0
    for (const channel of channels) mixed += Number.isFinite(channel[index]) ? channel[index]! : 0
    mixed /= channels.length
    power += mixed * mixed
  }
  return Math.min(1, Math.sqrt(power / frames) * 5)
}
