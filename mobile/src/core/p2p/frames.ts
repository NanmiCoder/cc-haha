/**
 * 直连数据通道上的帧（服务端见 src/server/p2p/protocol.ts，两边必须一致）。
 * 一帧是一条文本：JSON 头、换行、负载。`ctl` 走会话流和心跳，`bulk` 走 HTTP，
 * 大的历史页或图片不会挡住实时事件。
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

/** 每帧负载上限（UTF-16 单元），远低于各平台 SCTP 消息上限。 */
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

/** 按长度切块，但不拆开代理对：数据通道发的是 UTF-8，半个代理对会变成乱码。 */
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
