/**
 * Reads PCM from the canonical 44-byte-header 16 kHz mono PCM16 WAV the
 * desktop recorder produces. The API layer has already validated the format;
 * this only guards the worker against reading outside the buffer.
 * No project imports, so the worker process can load it in isolation.
 */

const HEADER_BYTES = 44

export class WavError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WavError'
  }
}

function tag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4))
}

/** Returns the samples as floats in [-1, 1). Throws WavError on a malformed container. */
export function readSamples(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength < HEADER_BYTES || tag(bytes, 0) !== 'RIFF' || tag(bytes, 8) !== 'WAVE' || tag(bytes, 36) !== 'data') {
    throw new WavError('Audio is not a canonical 44-byte-header WAV file')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const dataBytes = view.getUint32(40, true)
  if (dataBytes === 0 || dataBytes % 2 !== 0 || dataBytes > bytes.byteLength - HEADER_BYTES) {
    throw new WavError('WAV data length is empty, odd or past the end of the file')
  }
  const samples = new Float32Array(dataBytes / 2)
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(HEADER_BYTES + i * 2, true) / 32768
  return samples
}
