import { VoiceRecorderError } from './voiceRecorderTypes'

export const VOICE_SAMPLE_RATE = 16_000
export const MAX_CAPTURE_FILE_BYTES = 16 * 1024 * 1024

const invalidWav = () => new VoiceRecorderError('failed', 'Invalid recorded WAV audio')
const tag = (bytes: Uint8Array, offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4))

/** The same canonical PCM16 format as the desktop recorder and voice API. */
export function encodeVoiceWav(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, VOICE_SAMPLE_RATE, true)
  view.setUint32(28, VOICE_SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index++) {
    const value = Number.isFinite(samples[index]) ? Math.max(-1, Math.min(1, samples[index]!)) : 0
    view.setInt16(44 + index * 2, Math.round(value * (value < 0 ? 0x8000 : 0x7fff)), true)
  }
  return bytes
}

/** Native writers may include JUNK/LIST/fact chunks. Parse RIFF, never rename a compressed file. */
export function decodeRecordedWav(bytes: Uint8Array): { mono: Float32Array, sampleRate: number } {
  if (bytes.length < 12 || bytes.length > MAX_CAPTURE_FILE_BYTES || tag(bytes, 0) !== 'RIFF' || tag(bytes, 8) !== 'WAVE') throw invalidWav()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = view.getUint32(4, true) + 8
  if (end > bytes.length || end < 12) throw invalidWav()
  let format: { encoding: number, channels: number, sampleRate: number, align: number, bits: number } | undefined
  let data: { offset: number, size: number } | undefined
  for (let offset = 12; offset + 8 <= end;) {
    const size = view.getUint32(offset + 4, true)
    const start = offset + 8
    if (start + size > end) throw invalidWav()
    if (tag(bytes, offset) === 'fmt ') {
      if (format || size < 16) throw invalidWav()
      format = {
        encoding: view.getUint16(start, true),
        channels: view.getUint16(start + 2, true),
        sampleRate: view.getUint32(start + 4, true),
        align: view.getUint16(start + 12, true),
        bits: view.getUint16(start + 14, true),
      }
    } else if (tag(bytes, offset) === 'data') {
      if (data) throw invalidWav()
      data = { offset: start, size }
    }
    offset = start + size + size % 2
  }
  if (!format || !data || format.encoding !== 1 || format.bits !== 16
    || format.channels < 1 || format.channels > 2 || format.align !== format.channels * 2
    || format.sampleRate < 8000 || format.sampleRate > 96000 || data.size % format.align) throw invalidWav()
  const frames = data.size / format.align
  const mono = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame++) {
    let mixed = 0
    for (let channel = 0; channel < format.channels; channel++) {
      const sample = view.getInt16(data.offset + frame * format.align + channel * 2, true)
      mixed += sample / (sample < 0 ? 0x8000 : 0x7fff)
    }
    mono[frame] = mixed / format.channels
  }
  return { mono, sampleRate: format.sampleRate }
}

export type VoiceResampler = (samples: Float32Array, sourceRate: number, targetRate: number) => Promise<Float32Array>

export async function normalizeRecordedWav(bytes: Uint8Array, maxSeconds: number, resample: VoiceResampler) {
  const decoded = decodeRecordedWav(bytes)
  // Bound both the native source and the final output if a stop crosses the time limit.
  const source = decoded.mono.subarray(0, Math.floor(maxSeconds * decoded.sampleRate))
  const normalized = decoded.sampleRate === VOICE_SAMPLE_RATE || !source.length
    ? source
    : await resample(source, decoded.sampleRate, VOICE_SAMPLE_RATE)
  const samples = normalized.subarray(0, Math.floor(maxSeconds * VOICE_SAMPLE_RATE))
  return { wav: encodeVoiceWav(samples), seconds: samples.length / VOICE_SAMPLE_RATE }
}
