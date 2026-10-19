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
 * Direct Anthropic-style cache fields normally use exclusive input semantics.
 * OpenAI nested cache details are included in input/prompt, so only nested
 * cache counts are subtracted to preserve the upstream total.
 *
 * Exception (#1516): some openai_chat relays return OpenAI-shaped usage
 * (`prompt_tokens` already includes cache hits) and also copy the hit count into
 * a top-level `cache_read_input_tokens`. Treating that field as proof of
 * exclusive semantics counts the hit twice (input and cache_read) and pins the
 * cache hit rate near 50%. Such a payload is read as inclusive when ALL of:
 *   - there is no `input_tokens` (an Anthropic-named input is exclusive),
 *   - `prompt_tokens` is present and `cache_read_input_tokens <= prompt_tokens`
 *     (a larger hit count cannot be contained in the prompt),
 *   - `total_tokens`, when present, does not already include the cache count on
 *     top of prompt + completion (that would be exclusive accounting).
 * Then input_tokens = prompt_tokens - cache_read_input_tokens and cache_read is
 * kept as reported. `cache_creation_input_tokens` is NOT deducted from the
 * prompt: there is no evidence about whether relays include it, so it keeps the
 * previous behavior.
 *
 * Limitation: this cannot be proven from the numbers alone. A relay that really
 * reports a `prompt_tokens` excluding cache hits, with a total that also omits
 * them, would have its input_tokens underestimated. No such relay is known, and
 * the effect is limited to usage/cache-hit statistics display.
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

  // OpenAI-shaped prompt_tokens with a redundant direct cache_read (#1516):
  // see the function comment. Only the cache_read count is deducted.
  const promptTokens = validTokenCount(usage.prompt_tokens)
  const directCacheReadIsInclusive =
    validTokenCount(usage.input_tokens) === undefined &&
    promptTokens !== undefined &&
    (directCacheRead ?? 0) > 0 &&
    directCacheRead! <= promptTokens &&
    !(
      total !== undefined &&
      (total === promptTokens + output + directCacheRead! ||
        total ===
          promptTokens + output + directCacheRead! + (directCacheCreation ?? 0))
    )

  // Positive direct cache_* fields otherwise use Anthropic's exclusive-input
  // semantics. Some Chat gateways include zero placeholders alongside real
  // nested counts; those placeholders must not suppress the nested cache hit
  // accounting. Nested OpenAI details are inclusive in input/prompt and must be
  // subtracted. Cap malformed nested cache counts at the reported input to
  // preserve totals.
  const cacheRead = hasDirectCacheUsage
    ? (directCacheRead ?? 0)
    : Math.min(nestedCacheRead, input)
  const cacheCreation = directCacheCreation ?? 0
  const nonCacheInput =
    directCacheReadIsInclusive || !hasDirectCacheUsage
      ? Math.max(0, input - cacheRead)
      : input

  const result: AnthropicResponse['usage'] = {
    input_tokens: nonCacheInput,
    output_tokens: output,
  }
  if (cacheRead > 0) result.cache_read_input_tokens = cacheRead
  if (cacheCreation > 0) result.cache_creation_input_tokens = cacheCreation
  return result
}
