/** Wire format shared by the desktop, directory Worker and Android client. */
export const REMOTE_IDENTITY_VERSION = 2 as const
export const REMOTE_ANNOUNCEMENT_TTL_MS = 10 * 60_000
export const REMOTE_CHALLENGE_TTL_MS = 60_000
export const REMOTE_ID_PATTERN = /^[a-f0-9]{64}$/
export const REMOTE_NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/

export type RemoteAnnouncement = {
  version: 2
  hostId: string
  publicKey: string
  origin: string
  sequence: number
  expiresAt: number
  signature: string
}

export function remoteCanonical(purpose: string, fields: readonly string[]): Uint8Array<ArrayBuffer> {
  if (![purpose, ...fields].every(value => typeof value === 'string' && !/[\r\n\u0000]/.test(value))) {
    throw new Error('Invalid remote signature field')
  }
  return new TextEncoder().encode(['cc-haha-remote-v2', purpose, ...fields].join('\n'))
}

export function encodeRemoteBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeRemoteBase64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 4096) throw new Error('Invalid remote key encoding')
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0))
  if (encodeRemoteBase64(bytes) !== value) throw new Error('Non-canonical remote key encoding')
  return bytes
}

export function parseRemoteOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 512) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && value === url.origin ? url.origin : null
  } catch { return null }
}

export async function remotePublicKeyId(publicKey: string): Promise<string> {
  const bytes = decodeRemoteBase64(publicKey)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

/** RSA-2048 / SHA-256 / PKCS#1 v1.5, supported by Android Keystore on API 26+. */
export async function verifyRemoteSignature(publicKey: string, signature: string, message: Uint8Array): Promise<boolean> {
  try {
    if (publicKey.length !== 392 || signature.length !== 342) return false
    const key = await crypto.subtle.importKey('spki', decodeRemoteBase64(publicKey), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    const algorithm = key.algorithm as RsaHashedKeyAlgorithm
    if (algorithm.modulusLength !== 2048 || encodeRemoteBase64(algorithm.publicExponent) !== 'AQAB') return false
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decodeRemoteBase64(signature), new Uint8Array(message))
  } catch { return false }
}

export function announcementBytes(value: Pick<RemoteAnnouncement, 'hostId' | 'origin' | 'sequence' | 'expiresAt'>): Uint8Array<ArrayBuffer> {
  return remoteCanonical('announce', [value.hostId, value.origin, String(value.sequence), String(value.expiresAt)])
}

/** The directory is an untrusted address book. Clients verify again at the endpoint. */
export async function validateRemoteAnnouncement(value: unknown, now = Date.now()): Promise<RemoteAnnouncement | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as RemoteAnnouncement
  if (record.version !== 2 || !REMOTE_ID_PATTERN.test(record.hostId) ||
    typeof record.publicKey !== 'string' || typeof record.signature !== 'string' || !parseRemoteOrigin(record.origin) ||
    !Number.isSafeInteger(record.sequence) || record.sequence < 1 ||
    !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= now || record.expiresAt > now + REMOTE_ANNOUNCEMENT_TTL_MS + 60_000) return null
  if (await remotePublicKeyId(record.publicKey).catch(() => '') !== record.hostId ||
    !await verifyRemoteSignature(record.publicKey, record.signature, announcementBytes(record))) return null
  // Do not reflect arbitrary input fields into stored/public responses.
  return { version: 2, hostId: record.hostId, publicKey: record.publicKey, origin: record.origin, sequence: record.sequence, expiresAt: record.expiresAt, signature: record.signature }
}
