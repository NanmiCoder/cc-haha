import type { ClientOptions } from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import { getOpenAIPolicyError } from './policyError.js'
import {
  OPENAI_CODEX_API_ENDPOINT,
  OPENAI_CODEX_ORIGINATOR,
  OPENAI_CODEX_TOKEN_USER_AGENT,
} from './client.js'
import { ensureFreshOpenAITokens } from './index.js'
import {
  OPENAI_CODEX_REASONING_EFFORT_ENV_KEY,
  isOpenAIReasoningEffort,
  resolveOpenAICodexModel,
  resolveOpenAIReasoningEffortWithPriority,
} from './models.js'
import { getOpenAIOAuthTokens } from './storage.js'
import { anthropicToOpenaiResponses } from '../../server/proxy/transform/anthropicToOpenaiResponses.js'
import { openaiResponsesToAnthropic } from '../../server/proxy/transform/openaiResponsesToAnthropic.js'
import { openaiResponsesStreamToAnthropic } from '../../server/proxy/streaming/openaiResponsesStreamToAnthropic.js'
import { openaiResponsesStreamToAnthropicResponse } from '../../server/proxy/streaming/openaiResponsesStreamToAnthropicResponse.js'
import type { AnthropicRequest } from '../../server/proxy/transform/types.js'
import { logForDebugging } from '../../utils/debug.js'
import { OPENAI_CODEX_STREAM_MARKER_HEADER } from './streamPolicy.js'

export const OPENAI_OAUTH_DUMMY_KEY = 'openai-oauth-dummy-key'

export function shouldUseOpenAICodexAuth(): boolean {
  const openaiTokens = getOpenAIOAuthTokens()
  return !!openaiTokens?.refreshToken
}

export function buildOpenAICodexFetch(
  fetchOverride: ClientOptions['fetch'],
  source: string | undefined,
): ClientOptions['fetch'] {
  const inner = fetchOverride ?? globalThis.fetch

  return async (input, init) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input))

    if (!url.pathname.endsWith('/v1/messages')) {
      return inner(input, init)
    }

    const originalBody = await readAnthropicBody(input, init)
    const mappedModel = resolveOpenAICodexModel(originalBody.model)
    const transformedBody = anthropicToOpenaiResponses(
      {
        ...originalBody,
        model: mappedModel,
      },
      { preserveOpenAIReasoning: true },
    )
    // Keep a valid native request-scoped value ahead of the transformed value,
    // the session env, and the model default. The generic transformer preserves
    // the current OpenAI effort enum; the catalog below remains authoritative
    // about which subset the selected model accepts.
    const nativeRequestEffort = isOpenAIReasoningEffort(
      originalBody.output_config?.effort,
    )
      ? originalBody.output_config.effort
      : undefined
    const reasoningEffort = resolveOpenAIReasoningEffortWithPriority(
      mappedModel,
      [
        nativeRequestEffort,
        transformedBody.reasoning?.effort,
        process.env[OPENAI_CODEX_REASONING_EFFORT_ENV_KEY],
      ],
    )
    const upstreamBody = {
      ...transformedBody,
      reasoning: {
        ...(transformedBody.reasoning ?? {}),
        effort: reasoningEffort,
      },
      include: ['reasoning.encrypted_content'],
      stream: true,
    }

    const tokens = await ensureFreshOpenAITokens()
    if (!tokens) {
      throw new Error(
        'OpenAI OAuth token is missing or expired. Run claude auth login --openai again.',
      )
    }

    const headers = new Headers()
    headers.set('Content-Type', 'application/json')
    headers.set('Accept', 'text/event-stream')
    headers.set('Authorization', `Bearer ${tokens.accessToken}`)
    headers.set('originator', OPENAI_CODEX_ORIGINATOR)
    headers.set('User-Agent', OPENAI_CODEX_TOKEN_USER_AGENT)
    if (tokens.accountId) {
      headers.set('ChatGPT-Account-Id', tokens.accountId)
    }

    logForDebugging(
      `[API REQUEST] ${url.pathname} remapped_to=OpenAI/Codex model=${mappedModel} source=${source ?? 'unknown'} request_id=${randomUUID()}`,
    )

    const upstreamAbort = transformedBody.stream
      ? createTerminalAwareAbortBridge(init?.signal)
      : null
    let upstream: Response
    try {
      upstream = await inner(OPENAI_CODEX_API_ENDPOINT, {
        ...init,
        method: 'POST',
        headers,
        body: JSON.stringify(upstreamBody),
        signal: upstreamAbort?.signal ?? init?.signal,
      })
    } catch (error) {
      upstreamAbort?.dispose()
      throw error
    }

    if (!upstream.ok) {
      const errorText = await upstream.text().catch(() => '').finally(() => {
        upstreamAbort?.dispose()
      })
      const policyError = getOpenAIPolicyError({ message: errorText })
      if (policyError) {
        return Response.json({
          type: 'error',
          error: { type: 'permission_error', ...policyError },
        }, {
          status: 403,
          headers: {
            'x-should-retry': 'false',
            ...(upstream.headers.get('x-request-id')
              ? { 'x-request-id': upstream.headers.get('x-request-id')! }
              : {}),
          },
        })
      }
      return Response.json(
        {
          type: 'error',
          error: {
            type: 'api_error',
            message: `OpenAI upstream returned HTTP ${upstream.status}: ${errorText.slice(0, 500)}`,
          },
        },
        { status: upstream.status },
      )
    }

    if (transformedBody.stream) {
      if (!upstream.body) {
        upstreamAbort?.dispose()
        return Response.json(
          {
            type: 'error',
            error: {
              type: 'api_error',
              message: 'OpenAI upstream returned no body for stream',
            },
          },
          { status: 502 },
        )
      }

      return new Response(
        openaiResponsesStreamToAnthropic(
          upstream.body,
          mappedModel,
          {
            openAICodexOAuth: true,
            onTerminal: () => upstreamAbort?.markTerminal(),
            onCancel: reason => upstreamAbort?.abort(reason),
            onSettled: () => upstreamAbort?.dispose(),
          },
        ),
        {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            [OPENAI_CODEX_STREAM_MARKER_HEADER]: '1',
            ...(upstream.headers.get('x-request-id')
              ? { 'x-request-id': upstream.headers.get('x-request-id')! }
              : {}),
          },
        },
      )
    }

    if (upstream.body && isEventStreamResponse(upstream)) {
      const responseBody = await openaiResponsesStreamToAnthropicResponse(
        upstream.body,
        mappedModel,
        { openAICodexOAuth: true },
      )
      return Response.json(responseBody)
    }

    const responseBody = await upstream.json()
    return Response.json(
      openaiResponsesToAnthropic(
        responseBody,
        mappedModel,
        { preserveOpenAIReasoning: true },
      ),
    )
  }
}

type TerminalAwareAbortBridge = {
  signal: AbortSignal | undefined
  markTerminal: () => void
  abort: (reason?: unknown) => void
  dispose: () => void
}

/**
 * The Anthropic SDK aborts its request controller after it consumes
 * message_stop. For a remapped Responses stream that is normal cleanup, but
 * forwarding the late abort to the raw Codex request makes trace capture label
 * a completed HTTP 200 response as failed. Keep cancellation linked until an
 * actual Responses terminal event, then detach it while the trace clone drains.
 */
function createTerminalAwareAbortBridge(
  source: AbortSignal | null | undefined,
): TerminalAwareAbortBridge {
  const controller = new AbortController()
  let terminal = false

  const onAbort = (): void => {
    if (!terminal && !controller.signal.aborted) {
      controller.abort(source?.reason)
    }
  }
  if (source?.aborted) onAbort()
  else source?.addEventListener('abort', onAbort, { once: true })

  const dispose = (): void => {
    source?.removeEventListener('abort', onAbort)
  }

  return {
    signal: source ? controller.signal : undefined,
    markTerminal() {
      terminal = true
      dispose()
    },
    abort(reason) {
      if (!terminal && !controller.signal.aborted) controller.abort(reason)
      dispose()
    },
    dispose,
  }
}

function isEventStreamResponse(response: Response): boolean {
  return (response.headers.get('Content-Type') ?? '')
    .toLowerCase()
    .includes('text/event-stream')
}

async function readAnthropicBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<AnthropicRequest> {
  const directBody = init?.body

  if (typeof directBody === 'string') {
    return JSON.parse(directBody) as AnthropicRequest
  }

  if (directBody instanceof Uint8Array || directBody instanceof ArrayBuffer) {
    return JSON.parse(Buffer.from(directBody).toString('utf8')) as AnthropicRequest
  }

  if (input instanceof Request) {
    return (await input.clone().json()) as AnthropicRequest
  }

  throw new Error('Unable to read Anthropic request body for OpenAI/Codex transformation')
}
