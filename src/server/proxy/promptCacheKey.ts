/**
 * Stable prompt cache key resolution for OpenAI-compatible upstreams.
 * Derived from cc-switch (https://github.com/farion1231/cc-switch)
 * Original work by Jason Young, MIT License
 */

import type { AnthropicRequest } from './transform/types.js'

const SESSION_MARKER = '_session_'

/**
 * Resolve a stable `prompt_cache_key` for the OpenAI Responses API.
 *
 * OpenAI prompt caching routes on this key, so all requests of one
 * conversation must share it. Sources in order: the `_session_` suffix of
 * `metadata.user_id` (what Claude Code sends), `metadata.session_id`, then
 * the CLI's `x-claude-code-session-id` header. Returns undefined when no
 * client session identity exists — never a generated UUID, and never
 * `previous_response_id`, which is a per-turn response cursor and would
 * rotate the key every request.
 */
export function resolvePromptCacheKey(
  body: AnthropicRequest,
  headerSessionId?: string | null,
): string | undefined {
  const userId = body.metadata?.user_id
  if (typeof userId === 'string') {
    const markerIndex = userId.indexOf(SESSION_MARKER)
    if (markerIndex !== -1) {
      const sessionId = userId.slice(markerIndex + SESSION_MARKER.length)
      if (sessionId) return sessionId
    }
  }

  const metadataSessionId = body.metadata?.session_id
  if (typeof metadataSessionId === 'string' && metadataSessionId) {
    return metadataSessionId
  }

  const trimmedHeader = headerSessionId?.trim()
  if (trimmedHeader) return trimmedHeader

  return undefined
}
