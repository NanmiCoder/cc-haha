import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { NonNullableUsage } from '../../entrypoints/sdk/sdkUtilityTypes.js'

/**
 * Zero-initialized usage object. Extracted from logging.ts so that
 * bridge/replBridge.ts can import it without transitively pulling in
 * api/errors.ts → utils/messages.ts → BashTool.tsx → the world.
 */
export const EMPTY_USAGE: Readonly<NonNullableUsage> = {
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: 'standard',
  cache_creation: {
    ephemeral_1h_input_tokens: 0,
    ephemeral_5m_input_tokens: 0,
  },
  inference_geo: '',
  iterations: [],
  speed: 'standard',
}

/**
 * Some Anthropic-compatible providers omit usage in successful fallback
 * responses. Normalize at the provider boundary so transcript writes and cost
 * tracking can stay total-order safe instead of crashing on missing token fields.
 */
export function normalizeUsage(
  usage: Partial<BetaUsage> | null | undefined,
): NonNullableUsage {
  return {
    input_tokens: usage?.input_tokens ?? EMPTY_USAGE.input_tokens,
    cache_creation_input_tokens:
      usage?.cache_creation_input_tokens ??
      EMPTY_USAGE.cache_creation_input_tokens,
    cache_read_input_tokens:
      usage?.cache_read_input_tokens ?? EMPTY_USAGE.cache_read_input_tokens,
    output_tokens: usage?.output_tokens ?? EMPTY_USAGE.output_tokens,
    server_tool_use: {
      web_search_requests:
        usage?.server_tool_use?.web_search_requests ??
        EMPTY_USAGE.server_tool_use.web_search_requests,
      web_fetch_requests:
        usage?.server_tool_use?.web_fetch_requests ??
        EMPTY_USAGE.server_tool_use.web_fetch_requests,
    },
    service_tier: usage?.service_tier ?? EMPTY_USAGE.service_tier,
    cache_creation: {
      ephemeral_1h_input_tokens:
        usage?.cache_creation?.ephemeral_1h_input_tokens ??
        EMPTY_USAGE.cache_creation.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens:
        usage?.cache_creation?.ephemeral_5m_input_tokens ??
        EMPTY_USAGE.cache_creation.ephemeral_5m_input_tokens,
    },
    inference_geo: usage?.inference_geo ?? EMPTY_USAGE.inference_geo,
    iterations: usage?.iterations ?? EMPTY_USAGE.iterations,
    speed: usage?.speed ?? EMPTY_USAGE.speed,
  }
}
