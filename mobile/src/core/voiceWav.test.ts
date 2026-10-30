import { describe, expect, test } from 'bun:test'
import { validateVoiceWav } from '../../../src/server/services/voice/wav'
import { decodeRecordedWav, encodeVoiceWav, normalizeRecordedWav } from './voiceWav'
import { microphoneLevel, voiceCaptureLimit } from './voiceRecorderTypes'

describe('mobile voice WAV contract', () => {
  test('encodes canonical little-endian PCM16 accepted by the existing desktop service', () => {
    const wav = encodeVoiceWav(new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2, NaN]))
    expect(validateVoiceWav(wav)).toEqual({ audioSeconds: 8 / 16000 })
    const view = new DataView(wav.buffer)
    expect(Array.from({ length: 8 }, (_, index) => view.getInt16(44 + index * 2, true)))
      .toEqual([-32768, -32768, -16384, 0, 16384, 32767, 32767, 0])
  })

  test('normalizes native WAV metadata chunks and typed-array offsets into the strict server format', async () => {
    const original = encodeVoiceWav(new Float32Array([0.5, -0.5]))
    const wav = new Uint8Array(original.length + 12)
    wav.set(original.subarray(0, 12))
    wav.set(new TextEncoder().encode('JUNK'), 12)
    new DataView(wav.buffer).setUint32(16, 3, true)
    wav.set([1, 2, 3, 0], 20)
    wav.set(original.subarray(12), 24)
    new DataView(wav.buffer).setUint32(4, wav.length - 8, true)
    const offset = new Uint8Array(wav.length + 5)
    offset.set(wav, 3)
    const input = offset.subarray(3, 3 + wav.length)
    const converted = await normalizeRecordedWav(input, 120, async () => { throw new Error('16 kHz must not resample') })
    expect(converted.wav).toEqual(original)
    expect(validateVoiceWav(converted.wav).audioSeconds).toBe(2 / 16000)
  })

  test('uses actual file sample rate and channel layout, then caps both source and encoded duration', async () => {
    const stereo = encodeVoiceWav(new Float32Array([1, -1, 0.5, 0.5, 0, 1]))
    const view = new DataView(stereo.buffer)
    view.setUint16(22, 2, true)
    view.setUint32(24, 48000, true)
    view.setUint16(32, 4, true)
    const decoded = decodeRecordedWav(stereo)
    expect(decoded.sampleRate).toBe(48000)
    expect(Array.from(decoded.mono)).toEqual([0, expect.closeTo(0.5, 4), 0.5])
    let observed: { rate: number, target: number, count: number } | undefined
    const normalized = await normalizeRecordedWav(stereo, 2 / 48000, async (samples, rate, target) => {
      observed = { rate, target, count: samples.length }
      return new Float32Array([0, 0.5, 1])
    })
    expect(observed).toEqual({ rate: 48000, target: 16000, count: 2 })
    expect(normalized.seconds).toBe(0)
    expect(normalized.wav.length).toBe(44)
  })

  test('rejects compressed, truncated, ambiguous and inconsistent WAV files', () => {
    const canonical = () => encodeVoiceWav(new Float32Array([0.1, 0.2]))
    const corruptions = [
      (bytes: Uint8Array) => bytes.subarray(0, bytes.length - 1),
      (bytes: Uint8Array) => { bytes[0] = 0; return bytes },
      (bytes: Uint8Array) => { new DataView(bytes.buffer).setUint16(20, 3, true); return bytes },
      (bytes: Uint8Array) => { new DataView(bytes.buffer).setUint16(32, 4, true); return bytes },
      (bytes: Uint8Array) => { new DataView(bytes.buffer).setUint32(40, 0xffffffff, true); return bytes },
    ]
    for (const corrupt of corruptions) expect(() => decodeRecordedWav(corrupt(canonical()))).toThrow('Invalid recorded WAV')
  })

  test('the 120-second limit fits the service byte cap and levels reflect real samples', () => {
    expect(voiceCaptureLimit(500)).toBe(120)
    expect(() => voiceCaptureLimit(NaN)).toThrow('Invalid recording limit')
    expect(validateVoiceWav(encodeVoiceWav(new Float32Array(120 * 16000))).audioSeconds).toBe(120)
    expect(microphoneLevel([new Float32Array([0, 0])], 2)).toBe(0)
    expect(microphoneLevel([new Float32Array([0.1, -0.1])], 2)).toBeCloseTo(0.5)
    expect(microphoneLevel([new Float32Array([1, -1])], 2)).toBe(1)
  })
})
