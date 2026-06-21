import { useCallback, useEffect, useRef, useState } from 'react'
import { voiceApi } from '../api/voice'

export type VoiceInputStatus = 'idle' | 'recording' | 'transcribing' | 'error'

type UseVoiceInputOptions = {
  /** 转写完成后的回调（通常是「在光标处插入文字」）。 */
  onTranscript: (text: string) => void
  /** 是否启用右 Alt 监听，默认 true。 */
  enabled?: boolean
}

type UseVoiceInputResult = {
  isRecording: boolean
  status: VoiceInputStatus
  error: string | null
}

// ─── WAV 编码（16-bit PCM mono），智谱 ASR 只收 wav/mp3 ──────────────────────────
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i))
  }

  // RIFF header
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(8, 'WAVE')
  // fmt chunk
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  // data chunk
  writeString(36, 'data')
  view.setUint32(40, samples.length * 2, true)

  let offset = 44
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i] ?? 0
    const s = Math.max(-1, Math.min(1, sample))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

type AudioCtxCtor = typeof AudioContext
function getAudioContextCtor(): AudioCtxCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { AudioContext?: AudioCtxCtor; webkitAudioContext?: AudioCtxCtor }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message?.trim() || err.name
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

// ─── Hook ──────────────────────────────────────────────────────────────────────
// 录音用 ScriptProcessorNode（主线程采集 PCM）。相比 AudioWorklet 更简单、兼容性更好，
// 避免了 worklet 模块加载（Blob URL）这一类失败点；对短语音片段完全够用。
export function useVoiceInput({ onTranscript, enabled = true }: UseVoiceInputOptions): UseVoiceInputResult {
  const [isRecording, setIsRecording] = useState(false)
  const [status, setStatus] = useState<VoiceInputStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  const statusRef = useRef(status)
  statusRef.current = status
  const onTranscriptRef = useRef(onTranscript)
  onTranscriptRef.current = onTranscript

  const audioCtxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const silencerRef = useRef<GainNode | null>(null)
  const chunksRef = useRef<Float32Array[]>([])
  const sampleRateRef = useRef(48000)

  const cleanup = useCallback(() => {
    try { processorRef.current?.disconnect() } catch { /* noop */ }
    try { sourceRef.current?.disconnect() } catch { /* noop */ }
    try { silencerRef.current?.disconnect() } catch { /* noop */ }
    try { streamRef.current?.getTracks().forEach((track) => track.stop()) } catch { /* noop */ }
    try { void audioCtxRef.current?.close() } catch { /* noop */ }
    if (processorRef.current) processorRef.current.onaudioprocess = null
    processorRef.current = null
    sourceRef.current = null
    silencerRef.current = null
    streamRef.current = null
    audioCtxRef.current = null
    chunksRef.current = []
  }, [])

  const handleSamples = useCallback(async (samples: Float32Array, sampleRate: number) => {
    if (samples.length === 0) {
      setStatus('idle')
      setIsRecording(false)
      cleanup()
      return
    }
    try {
      const wav = encodeWav(samples, sampleRate)
      const result = await voiceApi.transcribe(wav)
      const text = result.text.trim()
      if (text) onTranscriptRef.current?.(text)
      setStatus('idle')
      setError(null)
    } catch (err) {
      setError(describeError(err) || '语音识别失败')
      setStatus('error')
    } finally {
      setIsRecording(false)
      cleanup()
    }
  }, [cleanup])

  const start = useCallback(async () => {
    setError(null)

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('当前环境不支持麦克风录音（需要安全上下文：https 或 localhost/127.0.0.1）')
      setStatus('error')
      return
    }
    const Ctor = getAudioContextCtor()
    if (!Ctor) {
      setError('当前环境不支持音频录制（AudioContext 不可用）')
      setStatus('error')
      return
    }

    // 1. 取麦克风（单独捕获错误，给出准确的权限提示）
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      const name = err instanceof DOMException ? err.name : ''
      let hint = ''
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        hint = '权限被拒绝或非安全上下文'
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        hint = '未找到麦克风设备'
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        hint = '麦克风可能被其他程序占用'
      }
      setError(
        `无法访问麦克风${hint ? `（${hint}）` : ''}：${describeError(err)}`,
      )
      setStatus('error')
      return
    }

    // 2. 建图采集
    try {
      streamRef.current = stream
      const ctx = new Ctor()
      audioCtxRef.current = ctx
      sampleRateRef.current = ctx.sampleRate
      if (ctx.state === 'suspended') await ctx.resume()

      const source = ctx.createMediaStreamSource(stream)
      sourceRef.current = source

      const processor = ctx.createScriptProcessor(4096, 1, 1)
      processorRef.current = processor
      const chunks: Float32Array[] = []
      chunksRef.current = chunks
      processor.onaudioprocess = (event: AudioProcessingEvent) => {
        const input = event.inputBuffer.getChannelData(0)
        chunks.push(new Float32Array(input))
      }

      // 保持音频图「被拉取」（onaudioprocess 才会触发），但不发出声音：
      // source → processor → gain(0) → destination
      const muted = ctx.createGain()
      muted.gain.value = 0
      silencerRef.current = muted
      source.connect(processor)
      processor.connect(muted)
      muted.connect(ctx.destination)

      setIsRecording(true)
      setStatus('recording')
    } catch (err) {
      setError(`录音初始化失败：${describeError(err)}`)
      setStatus('error')
      cleanup()
    }
  }, [cleanup])

  const stop = useCallback(() => {
    const chunks = chunksRef.current
    const sampleRate = sampleRateRef.current

    // 立即停掉采集，避免再追加样本
    try { processorRef.current?.disconnect() } catch { /* noop */ }
    try { sourceRef.current?.disconnect() } catch { /* noop */ }
    try { streamRef.current?.getTracks().forEach((track) => track.stop()) } catch { /* noop */ }

    // 合并所有 PCM 片段
    let total = 0
    for (const chunk of chunks) total += chunk.length
    const merged = new Float32Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.length
    }
    chunksRef.current = []

    setStatus('transcribing')
    void handleSamples(merged, sampleRate)
  }, [handleSamples])

  const toggle = useCallback(() => {
    const current = statusRef.current
    if (current === 'recording') {
      stop()
    } else if (current === 'idle' || current === 'error') {
      void start()
    }
    // 'transcribing' 期间忽略
  }, [start, stop])

  // 右 Alt 监听
  useEffect(() => {
    if (!enabled) return
    const handler = (event: KeyboardEvent) => {
      if (event.repeat) return
      if (event.defaultPrevented) return
      const isRightAlt =
        event.code === 'AltRight' || (event.key === 'Alt' && event.location === 2)
      if (!isRightAlt) return
      event.preventDefault()
      toggle()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [enabled, toggle])

  // 卸载时释放资源
  useEffect(() => {
    return () => cleanup()
  }, [cleanup])

  return { isRecording, status, error }
}
