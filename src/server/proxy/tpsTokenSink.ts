/**
 * Where the proxy delivers the real per-chunk token counts it reads off the
 * upstream stream (vLLM `return_token_ids`).
 *
 * The proxy cannot import the WebSocket layer itself: `ws/handler` reaches this
 * module through `titleService`, so a direct import would close a cycle. The
 * server registers its broadcaster here once, at startup, instead.
 */

import type { TokenChunkKind } from './streaming/openaiChatStreamToAnthropic.js'

type TpsTokenSink = (sessionId: string, tokens: number, kind: TokenChunkKind) => void

let sink: TpsTokenSink | null = null

export function setTpsTokenSink(next: TpsTokenSink | null): void {
  sink = next
}

/** No-op until a sink is registered (headless runs, tests). */
export function emitTpsTokens(
  sessionId: string,
  tokens: number,
  kind: TokenChunkKind,
): void {
  if (tokens <= 0) return
  sink?.(sessionId, tokens, kind)
}
