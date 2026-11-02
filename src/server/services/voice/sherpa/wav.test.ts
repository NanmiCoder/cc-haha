import { describe, expect, it } from 'bun:test'
import { makeWav } from './__fixtures__/wav.js'
import { WavError, readSamples } from './wav.js'

describe('readSamples', () => {
  it('converts the PCM of a canonical WAV to floats in [-1, 1)', () => {
    const samples = readSamples(makeWav(0.01))
    expect(samples).toHaveLength(160)
    expect(samples[1]).toBeCloseTo((37 - 1000) / 32768, 6)
    for (const sample of samples) expect(Math.abs(sample)).toBeLessThan(1)
  })

  it.each([
    ['too short', new Uint8Array(20)],
    ['not a WAV', new Uint8Array(100)],
    ['non-canonical header', makeWav(1, { extraChunk: true })],
    ['empty data', makeWav(0)],
    ['odd data length', makeWav(1, { dataSizeOverride: 31_999 })],
    ['declared size past the end', makeWav(1, { dataSizeOverride: 999_999 })],
  ])('rejects %s instead of reading outside the buffer', (_name, bytes) => {
    expect(() => readSamples(bytes)).toThrow(WavError)
  })
})
