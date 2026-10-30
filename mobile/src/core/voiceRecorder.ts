import { encodeVoiceWav, VOICE_SAMPLE_RATE } from './voiceWav'
import {
  microphoneLevel,
  voiceAbortError,
  voiceCaptureLimit,
  VoiceRecorderError,
  type StartVoiceRecordingOptions,
  type VoiceRecording,
  type VoiceRecordingResult,
} from './voiceRecorderTypes'

export * from './voiceRecorderTypes'

const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']

export function isVoiceCaptureSupported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext
    && typeof navigator.mediaDevices?.getUserMedia === 'function'
    && typeof MediaRecorder !== 'undefined'
    && typeof AudioContext !== 'undefined' && typeof OfflineAudioContext !== 'undefined'
}

function captureError(error: unknown): VoiceRecorderError {
  if (error instanceof VoiceRecorderError) return error
  const name = error instanceof Error ? error.name : ''
  const code = name === 'NotAllowedError' || name === 'SecurityError' ? 'permission'
    : name === 'NotFoundError' ? 'no-device'
      : name === 'NotReadableError' ? 'device-busy' : 'failed'
  return new VoiceRecorderError(code, error instanceof Error ? error.message : undefined)
}

/** Browser/H5 adapter. Native builds resolve voiceRecorder.native.ts instead. */
export async function startVoiceRecording(options: StartVoiceRecordingOptions): Promise<VoiceRecording> {
  const maxSeconds = voiceCaptureLimit(options.maxSeconds)
  if (options.signal?.aborted) throw voiceAbortError()
  if (!isVoiceCaptureSupported()) throw new VoiceRecorderError('unavailable', '当前浏览器无法录音，请使用手机 App 或 HTTPS 连接')
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
  } catch (error) {
    if (options.signal?.aborted) throw voiceAbortError()
    throw captureError(error)
  }
  const tracks = stream.getTracks()
  const stopTracks = () => {
    for (const track of tracks) {
      try { track.stop() } catch { /* Continue releasing the remaining tracks. */ }
    }
  }
  if (options.signal?.aborted) {
    stopTracks()
    throw voiceAbortError()
  }
  let recorder: MediaRecorder
  try {
    const mimeType = MIME_TYPES.find(type => MediaRecorder.isTypeSupported(type))
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  } catch (error) {
    stopTracks()
    throw captureError(error)
  }
  let cancelled = false
  let failure: VoiceRecorderError | undefined
  let released = false
  let stoppingRequested = false
  let limitReached = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let context: AudioContext | undefined
  let analyser: AnalyserNode | undefined
  let levelSamples: Float32Array<ArrayBuffer> | undefined
  let result: Promise<VoiceRecordingResult> | undefined
  let stopped!: () => void
  const stoppedPromise = new Promise<void>(resolve => { stopped = resolve })
  const chunks: Blob[] = []
  const onData = (event: BlobEvent) => { if (!cancelled && event.data.size > 0) chunks.push(event.data) }
  const onStop = () => {
    stopped()
    if (!stoppingRequested) interrupt()
  }
  const stopCapture = () => {
    stoppingRequested = true
    if (recorder.state === 'inactive') return
    try { recorder.stop() } catch { stopped() }
  }
  const release = () => {
    if (released) return
    released = true
    clearTimeout(timer)
    recorder.removeEventListener('dataavailable', onData)
    recorder.removeEventListener('stop', onStop)
    recorder.removeEventListener('error', interrupt)
    for (const track of tracks) track.removeEventListener('ended', interrupt)
    stopTracks()
    try { void context?.close().catch(() => {}) } catch { /* The browser may have already closed the context. */ }
  }
  const cancel = () => {
    if (cancelled) return
    cancelled = true
    options.signal?.removeEventListener('abort', cancel)
    chunks.length = 0
    stopCapture()
    release()
    stopped()
  }
  const interrupt = () => {
    if (released || failure || cancelled) return
    failure = new VoiceRecorderError('interrupted')
    options.signal?.removeEventListener('abort', cancel)
    stopCapture()
    release()
    stopped()
    options.onInterrupted?.(failure)
  }
  recorder.addEventListener('dataavailable', onData)
  recorder.addEventListener('stop', onStop)
  recorder.addEventListener('error', interrupt)
  for (const track of tracks) track.addEventListener('ended', interrupt)
  options.signal?.addEventListener('abort', cancel, { once: true })
  try {
    context = new AudioContext()
    analyser = context.createAnalyser()
    analyser.fftSize = 1024
    context.createMediaStreamSource(stream).connect(analyser)
    levelSamples = new Float32Array(analyser.fftSize)
    void context.resume().catch(() => {})
  } catch {
    analyser = undefined
  }
  const startedAt = Date.now()
  try {
    recorder.start(250)
  } catch (error) {
    options.signal?.removeEventListener('abort', cancel)
    release()
    throw captureError(error)
  }
  timer = setTimeout(() => {
    if (released || cancelled || failure || limitReached) return
    limitReached = true
    stopCapture()
    void stoppedPromise.then(release)
    options.onLimitReached?.()
  }, maxSeconds * 1000)
  return {
    getLevel() {
      if (released || !analyser || !levelSamples) return 0
      analyser.getFloatTimeDomainData(levelSamples)
      const level = microphoneLevel([levelSamples], levelSamples.length)
      options.onLevel?.(level)
      return level
    },
    cancel,
    stop() {
      result ??= (async () => {
        const elapsedMs = Date.now() - startedAt
        stopCapture()
        await stoppedPromise
        release()
        if (cancelled) throw voiceAbortError()
        if (failure) throw failure
        try {
          const encoded = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || '' })
          chunks.length = 0
          const decoded = await new OfflineAudioContext(1, 1, VOICE_SAMPLE_RATE).decodeAudioData(await encoded.arrayBuffer())
          if (cancelled) throw voiceAbortError()
          let mono: Float32Array
          if (decoded.numberOfChannels === 1 && decoded.sampleRate === VOICE_SAMPLE_RATE) mono = decoded.getChannelData(0)
          else {
            const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * VOICE_SAMPLE_RATE)), VOICE_SAMPLE_RATE)
            const source = offline.createBufferSource()
            source.buffer = decoded
            source.connect(offline.destination)
            source.start(0)
            mono = (await offline.startRendering()).getChannelData(0)
          }
          if (cancelled) throw voiceAbortError()
          const bounded = mono.subarray(0, Math.floor(maxSeconds * VOICE_SAMPLE_RATE))
          return { wav: encodeVoiceWav(bounded), seconds: bounded.length / VOICE_SAMPLE_RATE }
        } catch (error) {
          if (cancelled || (error instanceof Error && error.name === 'AbortError')) throw voiceAbortError()
          if (elapsedMs < 500) return { wav: encodeVoiceWav(new Float32Array(0)), seconds: 0 }
          throw captureError(error)
        } finally {
          options.signal?.removeEventListener('abort', cancel)
        }
      })()
      return result
    },
  }
}
