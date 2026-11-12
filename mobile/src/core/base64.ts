/**
 * Base64 to/from bytes (Hermes has no Buffer). Images downloaded over direct connection pass through entirely: 
 * Hermes there is no JIT, and a pure JS char-by-char implementation freezes the UI on multi-MB bodies, so when the platform
 * atob/btoaprovides them (Hermes and browsers both do) use them; pure JS is only a fallback. Checked at call time so tests can remove them to verify the fallback.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const VALUES = new Int16Array(128).fill(-1)
for (let i = 0; i < ALPHABET.length; i++) VALUES[ALPHABET.charCodeAt(i)] = i
/**
 * 3 multiple: except for the last segment, each encoded segment has no padding and can be concatenated directly.
 * is also the argument count for one String.fromCharCode.apply call, kept within each engine's argument limit.
 */
const SLICE = 3 * 4096

type Platform = { atob?: (text: string) => string; btoa?: (text: string) => string }
const platform = () => globalThis as Platform

export function bytesToBase64(bytes: Uint8Array): string {
  const btoa = platform().btoa
  const parts: string[] = []
  for (let start = 0; start < bytes.length; start += SLICE) {
    const slice = bytes.subarray(start, Math.min(bytes.length, start + SLICE))
    parts.push(btoa ? btoa(String.fromCharCode.apply(null, slice as unknown as number[])) : encodeSlice(slice))
  }
  return parts.join('')
}

export function base64ToBytes(text: string): Uint8Array {
  const atob = platform().atob
  if (atob) {
    try {
      const binary = atob(text)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return bytes
    } catch {
      /* Platform implementation rejects this text (e.g. malformed padding): hand off to the lenient decoder below. */
    }
  }
  return decode(text)
}

function encodeSlice(bytes: Uint8Array) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0
    out +=
      ALPHABET[a >> 2]! +
      ALPHABET[((a & 3) << 4) | (b >> 4)]! +
      (i + 1 < bytes.length ? ALPHABET[((b & 15) << 2) | (c >> 6)]! : '=') +
      (i + 2 < bytes.length ? ALPHABET[c & 63]! : '=')
  }
  return out
}

/** Skip characters outside the alphabet (newlines, padding) and rebuild bytes 6 bits at a time. */
function decode(text: string) {
  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4))
  let length = 0
  let bits = 0
  let value = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    const digit = code < 128 ? VALUES[code]! : -1
    if (digit < 0) continue
    value = ((value << 6) | digit) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes[length++] = (value >> bits) & 255
    }
  }
  return bytes.subarray(0, length)
}
