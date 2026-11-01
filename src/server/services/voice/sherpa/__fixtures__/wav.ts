/** Builds WAV bytes for tests. */
export function makeWav(
  seconds: number,
  options: { sampleRate?: number; channels?: number; bits?: number; encoding?: number; extraChunk?: boolean; dataSizeOverride?: number } = {},
): Uint8Array {
  const sampleRate = options.sampleRate ?? 16_000
  const channels = options.channels ?? 1
  const bits = options.bits ?? 16
  const bytesPerFrame = channels * (bits / 8)
  const dataBytes = Math.round(seconds * sampleRate) * bytesPerFrame
  const extra = options.extraChunk ? 8 + 4 : 0
  const buffer = new Uint8Array(12 + 24 + extra + 8 + dataBytes)
  const view = new DataView(buffer.buffer)
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) buffer[offset + i] = text.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, buffer.length - 8, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, options.encoding ?? 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerFrame, true)
  view.setUint16(32, bytesPerFrame, true)
  view.setUint16(34, bits, true)
  let offset = 36
  if (options.extraChunk) {
    ascii(offset, 'LIST')
    view.setUint32(offset + 4, 4, true)
    ascii(offset + 8, 'INFO')
    offset += 12
  }
  ascii(offset, 'data')
  view.setUint32(offset + 4, options.dataSizeOverride ?? dataBytes, true)
  for (let i = 0; i < dataBytes / 2; i++) view.setInt16(offset + 8 + i * 2, (i * 37) % 2000 - 1000, true)
  return buffer
}
