/**
 * Frames on the direct data channel (server side in src/server/p2p/protocol.ts; both must match).
 * A frame is one text: JSON header, newline, payload. `ctl` carries the session stream and heartbeat, `bulk` carries HTTP, 
 * so large history pages or images do not block live events.
 */
export type P2PChannel = 'ctl' | 'bulk'
export type Body = 'none' | 'text' | 'b64'
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

/** Per-frame payload limit (UTF-16 units), well below each platform SCTP message limit. */
export const P2P_CHUNK = 16 * 1024

export function encodeFrame(header: P2PHeader, payload = '') {
  return `${JSON.stringify(header)}\n${payload}`
}

export function decodeFrame(text: unknown): { header: P2PHeader; payload: string } | null {
  if (typeof text !== 'string') return null
  const split = text.indexOf('\n')
  if (split < 0) return null
  try {
    const header = JSON.parse(text.slice(0, split)) as P2PHeader
    if (!header || typeof header !== 'object' || typeof header.t !== 'string') return null
    return { header, payload: text.slice(split + 1) }
  } catch {
    return null
  }
}

/** Chunk by length without splitting surrogate pairs: the data channel sends UTF-8, and half a surrogate pair becomes garbage. */
export function chunkText(text: string, size = P2P_CHUNK): string[] {
  if (!text) return ['']
  const chunks: string[] = []
  for (let start = 0; start < text.length; ) {
    let end = Math.min(text.length, start + size)
    const last = text.charCodeAt(end - 1)
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks
}
