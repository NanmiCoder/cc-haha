import { anthropicToOpenaiResponses } from '../../server/proxy/transform/anthropicToOpenaiResponses.js'
import { openaiResponsesStreamToAnthropic } from '../../server/proxy/streaming/openaiResponsesStreamToAnthropic.js'
import { openaiResponsesStreamToAnthropicResponse } from '../../server/proxy/streaming/openaiResponsesStreamToAnthropicResponse.js'
import type { AnthropicRequest } from '../../server/proxy/transform/types.js'
import { ensureFreshGrokTokens, forceRefreshGrokTokens } from './refresh.js'
import { grokModelRejectsReasoningEffort, resolveGrokModel } from './models.js'
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
    const transformedBody = anthropicToOpenaiResponses({
      ...originalBody,
      model: requestedModel,
    })
    transformedBody.model = requestedModel
    transformedBody.stream = true
    if (grokModelRejectsReasoningEffort(requestedModel)) {
      delete transformedBody.reasoning
    }

    const tokens = await ensureFreshGrokTokens({ fetchOverride: inner })
    if (!tokens) {
      throw new Error(
        'Grok OAuth token is missing or expired. Authorize Grok again in the desktop app.',
      )
    }
    const headers = buildGrokIdentityHeaders(tokens.accessToken)
    headers.set('x-grok-model-override', requestedModel)

    void source
    const requestUpstream = (requestHeaders: Headers) => inner(GROK_CLI_API_ENDPOINT, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(transformedBody),
      signal: init?.signal,
    })
    let upstream = await requestUpstream(headers)
    if (upstream.status === 401) {
      const refreshed = await forceRefreshGrokTokens({ fetchOverride: inner })
      if (refreshed) {
        const refreshedHeaders = buildGrokIdentityHeaders(refreshed.accessToken)
        refreshedHeaders.set('x-grok-model-override', requestedModel)
        upstream = await requestUpstream(refreshedHeaders)
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
