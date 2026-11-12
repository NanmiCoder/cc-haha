import { bytesToBase64 } from './base64'
import type { FetchAdapter } from './client'
import { normalizeHostUrl } from './connection'

/**
 * How the phone recognizes the new address when a remote computer changes its public address (a Cloudflare quick tunnel changes on every restart): 
 * ask the computer directly on the same LAN, or receive a notification pushed by the computer. On both paths the computer signs with this phone's pairing
 * credential, and the phone trusts it only after verifying the signature. The credential itself is never sent: on the LAN only the ID, hashed twice, is carried.
 *
 * Notation (matching the desktop src/server/publicAccess.ts): T = credential (native_…), 
 * H = sha256hex(T), ID = sha256hex(H); signature = HMAC-SHA256(key is the UTF-8 bytes of H), 
 * Outputs base64url without padding.
 */

/** Maximum wait for one LAN address query: a computer on the same network should reply within tens of milliseconds. */
export const LOCATE_TIMEOUT_MS = 2500
/** Try at most this many LAN addresses reported by the computer. */
const MAX_ADDRESSES = 8

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))

/**
 * SHA-256(FIPS 180-4). Only used to compute hashes and signatures over a few dozen bytes of credential, so a pure JS synchronous implementation is fast enough, 
 * and it does not depend on native modules (expo-crypto only has async digest, no HMAC).
 */
export function sha256(message: Uint8Array): Uint8Array {
  const blocks = (message.length + 9 + 63) >> 6
  const padded = new Uint8Array(blocks * 64)
  padded.set(message)
  padded[message.length] = 0x80
  const view = new DataView(padded.buffer)
  const bits = message.length * 8
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000))
  view.setUint32(padded.length - 4, bits >>> 0)
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!
      const y = w[i - 2]!
      w[i] = w[i - 16]! + (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) + w[i - 7]! + (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10))
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, h7 = h[7]!
    for (let i = 0; i < 64; i++) {
      const t1 = (h7 + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      h7 = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    h[0] = h[0]! + a
    h[1] = h[1]! + b
    h[2] = h[2]! + c
    h[3] = h[3]! + d
    h[4] = h[4]! + e
    h[5] = h[5]! + f
    h[6] = h[6]! + g
    h[7] = h[7]! + h7
  }
  const digest = new Uint8Array(32)
  const out = new DataView(digest.buffer)
  for (let i = 0; i < 8; i++) out.setUint32(i * 4, h[i]!)
  return digest
}

export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const block = new Uint8Array(64)
  block.set(key.length > 64 ? sha256(key) : key)
  const inner = new Uint8Array(64 + message.length)
  const outer = new Uint8Array(64 + 32)
  for (let i = 0; i < 64; i++) {
    inner[i] = block[i]! ^ 0x36
    outer[i] = block[i]! ^ 0x5c
  }
  inner.set(message, 64)
  outer.set(sha256(inner), 64)
  return sha256(outer)
}

const utf8 = (text: string) => new TextEncoder().encode(text)

export function sha256Hex(text: string): string {
  let hex = ''
  for (const byte of sha256(utf8(text))) hex += byte.toString(16).padStart(2, '0')
  return hex
}

export function base64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Device ID reported to the computer on the LAN: the computer only stores the credential hash, which is enough to identify the phone. */
export function locatorId(credential: string): string {
  return sha256Hex(sha256Hex(credential))
}

function signature(credential: string, text: string) {
  return base64Url(hmacSha256(utf8(sha256Hex(credential)), utf8(text)))
}

function sameText(a: string, b: string) {
  if (a.length !== b.length) return false
  let difference = 0
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return difference === 0
}

/** Only accept https origins (no path, query, fragment or account); even with a valid signature other addresses are not used. */
export function trustedOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    return normalizeHostUrl(value, 'remote')
  } catch {
    return null
  }
}

/** LAN address reply `{ url, mac }`: the signature covers this request's nonce so old replies cannot be replayed. */
export function verifyLocate(credential: string, nonce: string, body: unknown): string | null {
  if (!credential || !body || typeof body !== 'object') return null
  const { url, mac } = body as { url?: unknown; mac?: unknown }
  if (typeof url !== 'string' || typeof mac !== 'string') return null
  if (!sameText(mac, signature(credential, `cc-haha-locate\n${nonce}\n${url}`))) return null
  return trustedOrigin(url)
}

/** New address pushed by the computer (`{ url, mac }` in the notification). */
export function verifyHostUrlPush(credential: string, data: { url: unknown; mac: unknown }): string | null {
  if (!credential || typeof data.url !== 'string' || typeof data.mac !== 'string') return null
  if (!sameText(data.mac, signature(credential, `cc-haha-host-url\n${data.url}`))) return null
  return trustedOrigin(data.url)
}

/** The computer's location on the LAN: service port and IPv4 addresses of each interface. */
export type LocatorHints = { port: number; addresses: string[] }

const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const IPV4 = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`)
/** IPv4 usable as a target: exclude 0.x, loopback (that is the phone itself) and multicast/reserved ranges. */
function usableAddress(value: unknown): value is string {
  if (typeof value !== 'string' || !IPV4.test(value)) return false
  const first = Number(value.split('.')[0])
  return first !== 0 && first !== 127 && first < 224
}

/** `GET /api/public-access/locator` reply; returns null on bad format and keeps only usable IPv4 addresses. */
export function parseLocatorHints(value: unknown): LocatorHints | null {
  if (!value || typeof value !== 'object') return null
  const { port, addresses } = value as { port?: unknown; addresses?: unknown }
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null
  if (!Array.isArray(addresses)) return null
  return { port, addresses: [...new Set(addresses.filter(usableAddress))].slice(0, MAX_ADDRESSES) }
}

/**
 * Query every LAN address the computer reported at once and return the first public address whose signature verifies; null if none.
 * Uses plain HTTP without credentials, Authorization or Origin, carrying only the ID and a one-time nonce.
 */
export async function locate(options: {
  hints: LocatorHints
  credential: string
  fetch: FetchAdapter
  random(count: number): Uint8Array
  timeoutMs?: number
}): Promise<string | null> {
  const hints = parseLocatorHints(options.hints)
  if (!hints?.addresses.length || !options.credential) return null
  const id = locatorId(options.credential)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? LOCATE_TIMEOUT_MS)
  const ask = async (address: string) => {
    const nonce = base64Url(options.random(16))
    const response = await options.fetch(
      `http://${address}:${hints.port}/api/public-access/locate?id=${id}&nonce=${nonce}`,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
      }
    )
    if (response.status !== 200 || response.redirected) return null
    const text = await response.text()
    if (text.length > 4096) return null
    return verifyLocate(options.credential, nonce, JSON.parse(text))
  }
  try {
    return await new Promise<string | null>((resolve) => {
      let pending = hints.addresses.length
      for (const address of hints.addresses)
        ask(address)
          .then((url) => {
            if (url) resolve(url)
          }, () => {})
          .finally(() => {
            if (--pending === 0) resolve(null)
          })
    })
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
