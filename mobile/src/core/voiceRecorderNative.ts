import { normalizeRecordedWav, type VoiceResampler } from './voiceWav'
import {
  microphoneLevel,
  voiceAbortError,
  voiceCaptureLimit,
  VoiceRecorderError,
  type StartVoiceRecordingOptions,
  type VoiceRecording,
  type VoiceRecordingResult,
} from './voiceRecorderTypes'

type Result<T> = ({ status: 'success' } & T) | { status: 'error', message: string }
type NativeBuffer = { numberOfChannels: number, sampleRate: number, length: number, getChannelData(channel: number): Float32Array }
type NativeRecorder = {
  enableFileOutput(): Result<unknown>
  start(): Promise<Result<unknown>>
  stop(): Promise<Result<{ paths: string[] }>>
  onAudioReady(callback: (buffer: NativeBuffer, frames: number) => void): Result<unknown>
  clearOnAudioReady(): void
  onError(callback: () => void): void
  clearOnError(): void
}

/** The only mocked seam in native recorder tests: permissions, capture, app audio session and cache files. */
export type NativeVoiceRuntime = {
  requestPermission(): Promise<boolean>
  activate(): Promise<void>
  deactivate(): Promise<void>
  createRecorder(): NativeRecorder
  observeInterruptions(callback: () => void): () => void
  readRecording(path: string): Promise<Uint8Array>
  deleteRecording(path: string): void
  resample: VoiceResampler
}

let nativeCaptureOwned = false
let nativeRetirement = Promise.resolve()

export async function createNativeVoiceRecording(options: StartVoiceRecordingOptions, runtime: NativeVoiceRuntime): Promise<VoiceRecording> {
  const maxSeconds = voiceCaptureLimit(options.maxSeconds)
  await nativeRetirement
  if (options.signal?.aborted) throw voiceAbortError()
  if (nativeCaptureOwned) throw new VoiceRecorderError('device-busy')
  nativeCaptureOwned = true
  let cancelled = false
  let failure: VoiceRecorderError | undefined
  let recorder: NativeRecorder | undefined
  let active = false
  let level = 0
  let recordingSeconds = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let removeInterruptions: (() => void) | undefined
  let preparation = Promise.resolve()
  let retirement: Promise<string[]> | undefined
  let result: Promise<VoiceRecordingResult> | undefined
  const paths = new Set<string>()

  const cleanup = () => {
    retirement ??= (async () => {
      clearTimeout(timer)
      await preparation.catch(() => {})
      clearTimeout(timer)
      try {
        if (recorder) {
          const stopped = await recorder.stop()
          if (stopped.status === 'success') for (const path of stopped.paths) paths.add(path)
          else if (!cancelled && !failure) failure = new VoiceRecorderError('failed', stopped.message)
        }
      } catch {
        failure ??= new VoiceRecorderError('failed')
      } finally {
        for (const dispose of [() => recorder?.clearOnAudioReady(), () => recorder?.clearOnError(), () => removeInterruptions?.()]) {
          try { dispose() } catch { /* Continue releasing the session after a native interruption. */ }
        }
        if (active) {
          try { await runtime.deactivate() } catch { /* An interrupted session may already be inactive. */ }
        }
        level = 0
        nativeCaptureOwned = false
      }
      return [...paths]
    })()
    nativeRetirement = retirement.then(() => {}, () => {})
    return retirement
  }
  const removeFiles = () => {
    for (const path of paths) {
      try { runtime.deleteRecording(path) } catch { /* The OS can also evict cache files. */ }
    }
    paths.clear()
  }
  const cancel = () => {
    if (cancelled) return
    cancelled = true
    options.signal?.removeEventListener('abort', cancel)
    void cleanup().finally(removeFiles)
  }
  const interrupt = () => {
    if (cancelled || failure || retirement) return
    failure = new VoiceRecorderError('interrupted')
    void cleanup().finally(removeFiles)
    options.onInterrupted?.(failure)
  }
  const limit = () => {
    if (cancelled || failure || retirement) return
    void cleanup()
    options.onLimitReached?.()
  }
  const checkCancelled = () => {
    if (cancelled || options.signal?.aborted) throw voiceAbortError()
    if (failure) throw failure
  }
  options.signal?.addEventListener('abort', cancel, { once: true })
  preparation = (async () => {
    const granted = await runtime.requestPermission()
    checkCancelled()
    if (!granted) throw new VoiceRecorderError('permission')
    recorder = runtime.createRecorder()
    const fileOutput = recorder.enableFileOutput()
    if (fileOutput.status === 'error') throw new VoiceRecorderError('failed', fileOutput.message)
    const callback = recorder.onAudioReady((buffer, frames) => {
      if (cancelled || failure || retirement) return
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel))
      const count = Math.max(0, Math.min(frames, buffer.length, ...channels.map(channel => channel.length)))
      level = microphoneLevel(channels, count)
      options.onLevel?.(level)
      recordingSeconds += count / buffer.sampleRate
      if (recordingSeconds >= maxSeconds) limit()
    })
    if (callback.status === 'error') throw new VoiceRecorderError('failed', callback.message)
    recorder.onError(interrupt)
    removeInterruptions = runtime.observeInterruptions(interrupt)
    await runtime.activate()
    active = true
    checkCancelled()
    const started = await recorder.start()
    checkCancelled()
    if (started.status === 'error') throw new VoiceRecorderError('failed', started.message)
    timer = setTimeout(limit, maxSeconds * 1000)
  })()
  try {
    await preparation
  } catch (error) {
    options.signal?.removeEventListener('abort', cancel)
    await cleanup()
    removeFiles()
    if (error instanceof VoiceRecorderError || (error instanceof Error && error.name === 'AbortError')) throw error
    throw new VoiceRecorderError('failed', error instanceof Error ? error.message : undefined)
  }
  return {
    getLevel: () => level,
    cancel,
    stop() {
      result ??= (async () => {
        const recorded = await cleanup()
        try {
          checkCancelled()
          if (failure) throw failure
          if (recorded.length !== 1) throw new VoiceRecorderError('failed', 'Missing recorded audio')
          const bytes = await runtime.readRecording(recorded[0]!)
          checkCancelled()
          const normalized = await normalizeRecordedWav(bytes, maxSeconds, runtime.resample)
          checkCancelled()
          return normalized
        } finally {
          options.signal?.removeEventListener('abort', cancel)
          removeFiles()
        }
      })()
      return result
    },
  }
}
