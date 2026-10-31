type RandomSource = {
  randomUUID?: () => string
  getRandomValues<T extends Uint8Array>(array: T): T
}

/**
 * A v4 UUID for request identities (team plan actions and the like).
 *
 * Browsers only expose `crypto.randomUUID` in secure contexts, and the H5 on a
 * LAN address is plain http; `getRandomValues` is available everywhere.
 */
export function randomRequestId(source: RandomSource): string {
  if (typeof source.randomUUID === 'function') return source.randomUUID()
  const bytes = source.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
