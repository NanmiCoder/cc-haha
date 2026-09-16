/**
 * M7-B §8.3 — the ONE composition point.
 *
 * The staged model context is turned into the final user text here and nowhere
 * else. `ConversationService.buildUserContent` is the single caller, which is
 * the single place the server assembles the string handed to the SDK; every
 * send path (immediate, first message of a created/replaced session, queued
 * flush) reaches it through `ConversationService.sendMessage`.
 *
 * Invariants:
 * - no staged context (`null` / blank) is a byte-identical no-op: the exact
 *   input string is returned and `composed` is false;
 * - composing an already composed string is a no-op, so a requestId replay, a
 *   queue flush or a retry can never inject the block twice;
 * - the original body is kept verbatim after the block — nothing is rewritten,
 *   summarised or re-ordered.
 */

import {
  MANAGED_CONTEXT_BLOCK_BEGIN,
  MANAGED_CONTEXT_BLOCK_END,
} from '../../../services/managedContext/blockFormat.js'
export { MANAGED_CONTEXT_BLOCK_BEGIN, MANAGED_CONTEXT_BLOCK_END }

export type ComposeUserContentInput = {
  /** The user-visible body exactly as it arrived in the WS frame. */
  userText: string
  /** Reserved model context from the staged ticket; blank means "no selection". */
  contextText?: string | null
}

export type ComposeUserContentResult = {
  content: string
  composed: boolean
}

function blockFor(contextText: string): string {
  return `${MANAGED_CONTEXT_BLOCK_BEGIN}\n${contextText}\n${MANAGED_CONTEXT_BLOCK_END}`
}

/** True when `content` already carries this exact context block. */
export function isComposedUserContent(content: string, contextText: string): boolean {
  if (contextText.trim().length === 0) return false
  return content.includes(blockFor(contextText))
}

/** How many managed-context blocks the string carries (0 for a plain send). */
export function countManagedContextBlocks(content: string): number {
  let count = 0
  let index = content.indexOf(MANAGED_CONTEXT_BLOCK_BEGIN)
  while (index !== -1) {
    count += 1
    index = content.indexOf(MANAGED_CONTEXT_BLOCK_BEGIN, index + MANAGED_CONTEXT_BLOCK_BEGIN.length)
  }
  return count
}

export function composeUserContent(input: ComposeUserContentInput): ComposeUserContentResult {
  const contextText = input.contextText ?? ''
  if (contextText.trim().length === 0) {
    return { content: input.userText, composed: false }
  }
  if (isComposedUserContent(input.userText, contextText)) {
    return { content: input.userText, composed: false }
  }
  return {
    content: `${blockFor(contextText)}\n\n${input.userText}`,
    composed: true,
  }
}
