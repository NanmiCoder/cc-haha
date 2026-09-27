/**
 * Usage mapping: OpenAI-compatible → Anthropic Messages semantics.
 * Derived from cc-switch (https://github.com/farion1231/cc-switch)
 * Original work by Jason Young, MIT License
 */

import type { AnthropicResponse, OpenAICompatibleUsage } from './types.js'

function validTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

/**
 * Map an OpenAI-compatible usage object to Anthropic usage.
 *
 * Direct Anthropic-style cache fields use exclusive input semantics. OpenAI
 * nested cache details are included in input/prompt, so only nested cache
 * counts are subtracted to preserve the upstream total.
 */
export function openaiUsageToAnthropic(usage: OpenAICompatibleUsage | undefined): AnthropicResponse['usage'] {
  if (!usage) return { input_tokens: 0, output_tokens: 0 }

  const total = validTokenCount(usage.total_tokens)
  let input = validTokenCount(usage.input_tokens)
    ?? validTokenCount(usage.prompt_tokens)
  let output = validTokenCount(usage.output_tokens)
    ?? validTokenCount(usage.completion_tokens)

  // Some compatibility relays omit one half of usage but still provide the
  // total. Recover the missing half only when the arithmetic is unambiguous.
  // A total-only value cannot distinguish prompt from completion, but it is
  // still a better full-context anchor than a messages-only estimate. Store it
  // on input; downstream adds a conservative visible-output estimate.
  if (total !== undefined && input === undefined && output !== undefined) {
    input = Math.max(0, total - output)
  } else if (
    total !== undefined &&
    output === undefined &&
    input !== undefined
  ) {
    output = Math.max(0, total - input)
  } else if (
    total !== undefined &&
    input === undefined &&
    output === undefined
  ) {
    input = total
    output = 0
  }

  input ??= 0
  output ??= 0

  const directCacheRead = validTokenCount(usage.cache_read_input_tokens)
  const directCacheCreation = validTokenCount(
    usage.cache_creation_input_tokens,
  )
  const hasDirectCacheUsage =
    (directCacheRead ?? 0) > 0 || (directCacheCreation ?? 0) > 0
  const nestedCacheRead = validTokenCount(
    usage.input_tokens_details?.cached_tokens,
  ) ?? validTokenCount(usage.prompt_tokens_details?.cached_tokens) ?? 0

  // Positive direct cache_* fields use Anthropic's exclusive-input semantics.
  // Some Chat gateways include zero placeholders alongside real nested counts;
  // those placeholders must not suppress the nested cache hit accounting. Nested
  // OpenAI details are inclusive in input/prompt and must be subtracted. Cap
  // malformed nested cache counts at the reported input to preserve totals.
  const cacheRead = hasDirectCacheUsage
    ? (directCacheRead ?? 0)
    : Math.min(nestedCacheRead, input)
  const cacheCreation = directCacheCreation ?? 0
  const nonCacheInput = hasDirectCacheUsage
    ? input
    : Math.max(0, input - cacheRead)

  const result: AnthropicResponse['usage'] = {
    input_tokens: nonCacheInput,
    output_tokens: output,
  }
  if (cacheRead > 0) result.cache_read_input_tokens = cacheRead
  if (cacheCreation > 0) result.cache_creation_input_tokens = cacheCreation
  return result
}
