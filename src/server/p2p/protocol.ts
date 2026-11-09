/**
 * Frames carried over the phone's P2P data channels (and relayed verbatim
 * between the Electron WebRTC endpoint and this server).
 *
 * A frame is one text message: a JSON header, a newline, then the payload.
 * `ctl` carries socket streams, pings and resets; `bulk` carries HTTP. Keeping
 * them on separate channels stops a large history page or image from delaying
 * live session events.
 */

export const P2P_PROTOCOL_VERSION = 1
/** Payload bytes per frame; well under every SCTP message-size limit we meet. */
export const P2P_CHUNK = 16 * 1024
/** A whole frame, header included. */
export const P2P_FRAME_LIMIT = 64 * 1024
/** One WebSocket message from the phone in UTF-8 bytes, the same cap the gateway applies. */
export const P2P_SOCKET_MESSAGE_LIMIT = 1024 * 1024
/** One HTTP request body in bytes, the same cap the gateway applies. */
export const P2P_REQUEST_BODY_LIMIT = 16 * 1024 * 1024

export type P2PChannel = 'ctl' | 'bulk'
type Body = 'none' | 'text' | 'b64'

export type P2PHeader =
  | { t: 'hello'; v: number }
  | { t: 'ping'; n: number }
  | { t: 'pong'; n: number }
  | { t: 'req'; s: number; m: string; p: string; h: Record<string, string>; b: Body; fin: boolean }
  | { t: 'reqb'; s: number; fin: boolean }
  | { t: 'res'; s: number; st: number; h: Record<string, string>; b: Body; fin: boolean }
  | { t: 'resb'; s: number; fin: boolean }
  | { t: 'rst'; s: number; code: string }
  | { t: 'wso'; s: number; p: string; h: Record<string, string> }
  | { t: 'wsa'; s: number }
  | { t: 'wsm'; s: number; fin: boolean }
  | { t: 'wsc'; s: number; code: number; reason: string }

export type P2PFrame = { header: P2PHeader; payload: string }

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])
const BODIES = new Set<Body>(['none', 'text', 'b64'])
const streamId = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0
/** A value `new Request` accepts: printable Latin-1 and tab, never CR, LF or NUL. */
const HEADER_VALUE = /^[\t\x20-\x7e\xa0-\xff]*$/
const headers = (value: unknown): value is Record<string, string> =>
  !!value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length <= 64 &&
  Object.entries(value).every(([key, item]) => /^[A-Za-z0-9-]{1,64}$/.test(key) && typeof item === 'string' && item.length <= 8192 && HEADER_VALUE.test(item))
const path = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && value.length <= 4096 && !/[\s#]/.test(value)

export function encodeFrame(header: P2PHeader, payload = ''): string {
  return `${JSON.stringify(header)}\n${payload}`
}

/** Parses and validates one frame; anything malformed or oversized is rejected. */
export function decodeFrame(text: string): P2PFrame | null {
  if (typeof text !== 'string' || text.length > P2P_FRAME_LIMIT) return null
  const split = text.indexOf('\n')
  if (split < 0 || split > 16 * 1024) return null
  let header: Record<string, unknown>
  try { header = JSON.parse(text.slice(0, split)) } catch { return null }
  if (!header || typeof header !== 'object' || Array.isArray(header)) return null
  const payload = text.slice(split + 1)
  if (payload.length > P2P_CHUNK * 2) return null
  const ok = (() => {
    switch (header.t) {
      case 'hello': return Number.isSafeInteger(header.v)
      case 'ping': case 'pong': return Number.isSafeInteger(header.n)
      case 'req': return streamId(header.s) && METHODS.has(String(header.m)) && path(header.p) && headers(header.h) && BODIES.has(header.b as Body) && typeof header.fin === 'boolean'
      case 'reqb': case 'resb': return streamId(header.s) && typeof header.fin === 'boolean'
      case 'res': return streamId(header.s) && Number.isSafeInteger(header.st) && headers(header.h) && BODIES.has(header.b as Body) && typeof header.fin === 'boolean'
      case 'rst': return streamId(header.s) && typeof header.code === 'string' && header.code.length <= 64
      case 'wso': return streamId(header.s) && path(header.p) && headers(header.h)
      case 'wsa': return streamId(header.s)
      case 'wsm': return streamId(header.s) && typeof header.fin === 'boolean'
      case 'wsc': return streamId(header.s) && Number.isSafeInteger(header.code) && typeof header.reason === 'string' && header.reason.length <= 256
      default: return false
    }
  })()
  return ok ? { header: header as P2PHeader, payload } : null
}

/**
 * The request or socket a rejected frame tried to open, if its header names
 * one, so the receiver can refuse it with a status instead of leaving the
 * phone waiting for an answer that never comes.
 */
export function rejectedOpening(text: string): { t: 'req' | 'wso'; s: number } | null {
  if (typeof text !== 'string') return null
  const split = text.slice(0, 16 * 1024 + 1).indexOf('\n')
  if (split < 0) return null
  let header: Record<string, unknown>
  try { header = JSON.parse(text.slice(0, split)) } catch { return null }
  if (!header || typeof header !== 'object' || (header.t !== 'req' && header.t !== 'wso') || !streamId(header.s)) return null
  return { t: header.t, s: header.s as number }
}

/**
 * Splits text into chunks of at most `size` UTF-16 units without separating a
 * surrogate pair: a data channel sends UTF-8, where half a pair is corrupted.
 */
export function chunkText(text: string, size = P2P_CHUNK): string[] {
  if (!text) return ['']
  const chunks: string[] = []
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + size)
    const last = text.charCodeAt(end - 1)
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks
}
