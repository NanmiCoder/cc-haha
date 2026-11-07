import type { ClientMessage } from '../types/chat'

/**
 * Largest frame the local server accepts from a renderer on `/ws/:sessionId`.
 * Mirrors the renderer input budget in `src/server/ws/handler.ts`, which
 * closes the socket (1009) for anything bigger. Pasted images travel inline as
 * data URLs, so two 4K screenshots pasted as bitmaps already exceed it.
 */
export const USER_MESSAGE_MAX_BYTES = 16 * 1024 * 1024

export type UserMessageBudgetResult =
  | { ok: true }
  | { ok: false; bytes: number; limit: number }

/**
 * Measures the exact frame the socket would send. UTF-8 needs at most three
 * bytes per UTF-16 code unit, so an ordinary message skips the encoder and
 * only a candidate near the budget pays for the byte count.
 */
export function checkUserMessageBudget(message: ClientMessage): UserMessageBudgetResult {
  const serialized = JSON.stringify(message)
  if (serialized.length * 3 <= USER_MESSAGE_MAX_BYTES) return { ok: true }
  const bytes = new TextEncoder().encode(serialized).byteLength
  if (bytes <= USER_MESSAGE_MAX_BYTES) return { ok: true }
  return { ok: false, bytes, limit: USER_MESSAGE_MAX_BYTES }
}
