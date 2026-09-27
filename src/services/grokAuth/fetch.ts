import { resolvePromptCacheKey } from '../../server/proxy/promptCacheKey.js'
import { anthropicToOpenaiResponses } from '../../server/proxy/transform/anthropicToOpenaiResponses.js'
import { openaiResponsesStreamToAnthropic } from '../../server/proxy/streaming/openaiResponsesStreamToAnthropic.js'
import { openaiResponsesStreamToAnthropicResponse } from '../../server/proxy/streaming/openaiResponsesStreamToAnthropicResponse.js'
import type { AnthropicRequest } from '../../server/proxy/transform/types.js'
import { ensureFreshGrokTokens, forceRefreshGrokTokens } from './refresh.js'
import {
  getGrokRuntimeModelCatalog,
  resolveGrokModel,
  resolveGrokReasoningEffort,
} from './models.js'
import { getGrokOAuthTokens } from './storage.js'

export const GROK_CLI_BASE_URL = 'https://cli-chat-proxy.grok.com/v1'
export const GROK_CLI_API_ENDPOINT = `${GROK_CLI_BASE_URL}/responses`
export const GROK_CLI_VERSION = '0.2.99'
export const GROK_OAUTH_DUMMY_KEY = 'grok-oauth-dummy-key'

export function shouldUseGrokAuth(): boolean {
  return !!getGrokOAuthTokens()?.refreshToken
}

export function buildGrokIdentityHeaders(accessToken: string): Headers {
  return new Headers({
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'X-XAI-Token-Auth': 'xai-grok-cli',
    'x-grok-client-version': GROK_CLI_VERSION,
    // The CLI gateway distinguishes interactive sessions from batch traffic;
    // the official client always declares one.
    'x-grok-client-mode': 'interactive',
    'User-Agent': `xai-grok-workspace/${GROK_CLI_VERSION}`,
  })
}

export function buildGrokFetch(
  fetchOverride: typeof fetch | undefined,
  source: string | undefined,
): typeof fetch {
  const inner = fetchOverride ?? globalThis.fetch

  return async (input, init) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input))
    if (!url.pathname.endsWith('/v1/messages')) return inner(input, init)

    const originalBody = await readAnthropicBody(input, init)
    const requestedModel = resolveGrokModel(originalBody.model)
    // One conversation must route to one cache entry, or every turn re-bills
    // the whole prefix. xAI reads it from the body; the CLI proxy also keys its
    // conversation state off a header, so both carry the same identity.
    const cacheKey = resolvePromptCacheKey(originalBody, readSessionId(input, init))
    const transformedBody = anthropicToOpenaiResponses(
      { ...originalBody, model: requestedModel },
      cacheKey ? { cacheKey } : {},
    )
    transformedBody.model = requestedModel
    transformedBody.stream = true
    const reasoningEffort = resolveGrokReasoningEffort(
      requestedModel,
      transformedBody.reasoning?.effort,
      getGrokRuntimeModelCatalog(),
    )
    if (reasoningEffort) {
      transformedBody.reasoning = {
        ...(transformedBody.reasoning ?? {}),
        effort: reasoningEffort,
      }
    } else {
      delete transformedBody.reasoning
    }

    const tokens = await ensureFreshGrokTokens({ fetchOverride: inner })
    if (!tokens) {
      throw new Error(
        'Grok OAuth token is missing or expired. Authorize Grok again in the desktop app.',
      )
    }
    const applyRequestIdentity = (requestHeaders: Headers): Headers => {
      requestHeaders.set('x-grok-model-override', requestedModel)
      if (cacheKey) requestHeaders.set('x-grok-conv-id', cacheKey)
      return requestHeaders
    }
    const headers = applyRequestIdentity(
      buildGrokIdentityHeaders(tokens.accessToken),
    )

    void source
    const requestUpstream = (requestHeaders: Headers) => inner(GROK_CLI_API_ENDPOINT, {
      ...init,
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(transformedBody),
      signal: init?.signal,
    })
    let upstream = await requestUpstream(headers)
    if (upstream.status === 401) {
      const refreshed = await forceRefreshGrokTokens({ fetchOverride: inner })
      if (refreshed) {
        upstream = await requestUpstream(
          applyRequestIdentity(buildGrokIdentityHeaders(refreshed.accessToken)),
        )
      }
    }

    if (!upstream.ok) {
      const errorText = await upstream.text().catch(() => '')
      return Response.json(
        {
          type: 'error',
          error: {
            type: 'api_error',
            message: `Grok upstream returned HTTP ${upstream.status}: ${errorText.slice(0, 500)}`,
          },
        },
        { status: upstream.status },
      )
    }
    if (!upstream.body) {
      return Response.json(
        { type: 'error', error: { type: 'api_error', message: 'Grok upstream returned no stream body' } },
        { status: 502 },
      )
    }

    if (originalBody.stream) {
      return new Response(
        openaiResponsesStreamToAnthropic(upstream.body, requestedModel),
        {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        },
      )
    }

    return Response.json(
      await openaiResponsesStreamToAnthropicResponse(
        upstream.body,
        requestedModel,
      ),
    )
  }
}

/**
 * The CLI stamps its session id on every request as a default header, which is
 * the last-resort cache identity when the body carries no session metadata.
 */
function readSessionId(
  input: RequestInfo | URL,
  init?: RequestInit,
): string | null {
  const header = 'x-claude-code-session-id'
  if (init?.headers) {
    const fromInit = new Headers(init.headers).get(header)
    if (fromInit) return fromInit
  }
  return input instanceof Request ? input.headers.get(header) : null
}

async function readAnthropicBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<AnthropicRequest> {
  if (typeof init?.body === 'string') {
    return JSON.parse(init.body) as AnthropicRequest
  }
  if (init?.body instanceof Uint8Array || init?.body instanceof ArrayBuffer) {
    return JSON.parse(Buffer.from(init.body).toString('utf8')) as AnthropicRequest
  }
  if (input instanceof Request) {
    return (await input.clone().json()) as AnthropicRequest
  }
  throw new Error('Unable to read Anthropic request body for Grok transformation')
}
