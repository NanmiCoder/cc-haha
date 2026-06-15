/**
 * Usage mapping: OpenAI-compatible → Anthropic Messages semantics.
 * Derived from cc-switch (https://github.com/farion1231/cc-switch)
 * Original work by Jason Young, MIT License
 */

import type { AnthropicResponse, OpenAICompatibleUsage } from './types.js'

/**
 * Map an OpenAI-compatible usage object to Anthropic usage.
 *
 * Cache reads come from Anthropic-style `cache_read_input_tokens` when a
 * compatible server returns it directly (authoritative), else from the
 * Responses API's `input_tokens_details.cached_tokens`, else from Chat
 * Completions' `prompt_tokens_details.cached_tokens`.
 *
 * OpenAI input counts INCLUDE cached tokens while Anthropic `input_tokens`
 * excludes them, so cache reads/creations are subtracted to keep the
 * Anthropic invariant: input + cache_read + cache_creation == upstream input.
 */
export function openaiUsageToAnthropic(usage: OpenAICompatibleUsage | undefined): AnthropicResponse['usage'] {
  if (!usage) return { input_tokens: 0, output_tokens: 0 }

  const input = usage.input_tokens ?? usage.prompt_tokens ?? 0
  const output = usage.output_tokens ?? usage.completion_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens
    ?? usage.input_tokens_details?.cached_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
    ?? 0
  const cacheCreation = usage.cache_creation_input_tokens ?? 0

  const result: AnthropicResponse['usage'] = {
    input_tokens: cacheRead > 0 || cacheCreation > 0
      ? Math.max(0, input - cacheRead - cacheCreation)
      : input,
    output_tokens: output,
  }
  if (cacheRead > 0) result.cache_read_input_tokens = cacheRead
  if (cacheCreation > 0) result.cache_creation_input_tokens = cacheCreation
  return result
}
