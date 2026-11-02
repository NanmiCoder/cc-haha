/**
 * Provider text completion — one system + user request to a saved provider's
 * model, answered with plain text.
 *
 * This is the transport session titles have always used, shared so other short
 * server-side model calls (voice correction, vocabulary picking) reach a
 * provider exactly the same way:
 * - ChatGPT Official OAuth goes to the Codex Responses endpoint with its tokens.
 * - DeepSeek Account authenticates with the account grant, not an API key.
 * - Providers whose wire format needs local handling go through the in-process
 *   proxy, which owns the per-model protocol choice and the preset's headers.
 * - Everything else is a direct Anthropic Messages call.
 * Thinking is disabled first; a rejected request (400/422) is retried once without it.
 */

import type { SavedProvider, ProviderAuthStrategy } from '../types/provider.js'
import { normalizeAnthropicBaseUrl } from '../../services/api/anthropicBaseUrl.js'
import { normalizeModelStringForAPI } from '../../utils/model/model.js'
import {
  getPresetAuthStrategy,
  providerNeedsProxy,
  resolveProviderApiFormat,
} from './providerRuntimeEnv.js'
import { handleProxyRequest } from '../proxy/handler.js'
import {
  getNetworkProxyFetchOptions,
  loadNetworkSettings,
  type NetworkSettings,
} from './networkSettings.js'
import { hahaOpenAIOAuthService } from './hahaOpenAIOAuthService.js'
import { isOpenAIOfficialProviderId } from './openaiOfficialProvider.js'
import {
  isDeepSeekAccountProviderId,
  resolveDeepSeekAccountRequestHeaders,
} from './deepseekAccountProvider.js'
import { OPENAI_CODEX_API_ENDPOINT } from '../../services/openaiAuth/client.js'
import { deepSeekAccountFetchInit } from '../../services/deepseekAuth/client.js'
import { resolveOpenAICodexModel } from '../../services/openaiAuth/models.js'
import { anthropicToOpenaiResponses } from '../proxy/transform/anthropicToOpenaiResponses.js'
import { openaiResponsesStreamToAnthropicResponse } from '../proxy/streaming/openaiResponsesStreamToAnthropicResponse.js'

/** Per-attempt limit on direct and OpenAI calls; the proxy applies its own. */
export const PROVIDER_TEXT_ATTEMPT_TIMEOUT_MS = 15_000

/**
 * `aborted` means the caller's own signal fired (e.g. the HTTP client went
 * away); it is never a provider problem.
 */
export type ProviderTextCompletionFailureReason = 'auth' | 'rate-limit' | 'timeout' | 'upstream' | 'aborted'

export type ProviderTextCompletionRequest = {
  provider: SavedProvider
  /** Model id as saved; `[1m]`-style suffixes are stripped before sending. */
  modelId: string
  system: string
  user: string
  maxTokens: number
  /**
   * Sent with the first (thinking-disabled) attempt only; the 400/422 retry drops
   * it along with `thinking`, since some models reject a fixed temperature.
   */
  temperature?: number
  /**
   * Asks OpenAI-format upstreams (providers routed through the local proxy, and
   * the ChatGPT login) for this reasoning effort. Their transforms only map
   * `thinking` when it is enabled, so `thinking: disabled` alone leaves a
   * reasoning model at its default effort. Direct Anthropic-format calls ignore
   * it; `thinking: disabled` already covers them. Sent with the first attempt
   * only, like `temperature`.
   */
  reasoningEffort?: 'low'
  /** Caller-owned cancellation. Aborting it ends the call with `aborted`. */
  signal?: AbortSignal
  /** Hard limit for the whole call, thinking retry included; exceeding it ends with `timeout`. */
  timeoutMs?: number
  /** Overrides the per-attempt limit on direct and OpenAI calls. */
  attemptTimeoutMs?: number
  /** Forwarded on the proxy path so gateways can route by conversation. */
  sessionId?: string
  /** Loaded from the user's settings when omitted. */
  networkSettings?: NetworkSettings
}

export type ProviderTextCompletionResult =
  | { ok: true; text: string }
  | { ok: false; reason: ProviderTextCompletionFailureReason; status?: number; message: string }

type Failure = Extract<ProviderTextCompletionResult, { ok: false }>

class CompletionAbort extends Error {
  constructor() {
    super('Provider text completion aborted')
    this.name = 'CompletionAbort'
  }
}

function failure(reason: ProviderTextCompletionFailureReason, message: string, status?: number): Failure {
  return status === undefined ? { ok: false, reason, message } : { ok: false, reason, status, message }
}

/** Classifies a non-OK upstream (or proxy) HTTP status. */
export function classifyProviderStatus(status: number): ProviderTextCompletionFailureReason {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate-limit'
  return 'upstream'
}

/**
 * Whether the provider rejected the request's shape, which dropping the first
 * attempt's `thinking: disabled` and extras can fix. Other 4xx answers (rate
 * limit, auth, missing endpoint) are returned as they are: resending without
 * `thinking` would turn a reasoning model's thinking back on, and DeepSeek
 * Flash then spends the whole budget reasoning and answers with no text.
 */
function rejectedRequestShape(response: Response): boolean {
  return response.status === 400 || response.status === 422
}

/** Removes reasoning a model inlined into its text (`<think>…</think>`, or an unclosed tail). */
export function stripThinkBlocks(text: string): string {
  const closed = text.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const open = closed.search(/<think>/i)
  return open >= 0 ? closed.slice(0, open) : closed
}

function buildAnthropicRequestHeaders(
  apiKey: string,
  authStrategy: ProviderAuthStrategy,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  }

  switch (authStrategy) {
    case 'api_key':
      headers['x-api-key'] = apiKey
      break
    case 'auth_token':
    case 'auth_token_empty_api_key':
      headers.Authorization = `Bearer ${apiKey}`
      break
    case 'dual_same_token':
      headers['x-api-key'] = apiKey
      headers.Authorization = `Bearer ${apiKey}`
      break
    case 'dual_dummy':
      headers['x-api-key'] = 'dummy'
      headers.Authorization = 'Bearer dummy'
      break
  }

  return headers
}

function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (present.length === 0) return undefined
  return present.length === 1 ? present[0] : AbortSignal.any(present)
}

/** Settles with `promise`, or rejects as soon as `signal` aborts (the work itself may keep running). */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new CompletionAbort())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new CompletionAbort())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function isTimeoutError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'name' in error && error.name === 'TimeoutError')
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readAnthropicText(response: Response): Promise<string> {
  const body = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>
  }
  return body.content?.find((block) => block.type === 'text')?.text ?? ''
}

export async function providerTextCompletion(
  request: ProviderTextCompletionRequest,
): Promise<ProviderTextCompletionResult> {
  const deadline = request.timeoutMs !== undefined ? AbortSignal.timeout(request.timeoutMs) : undefined
  const overall = combineSignals([request.signal, deadline])
  const attemptTimeoutMs = request.attemptTimeoutMs ?? PROVIDER_TEXT_ATTEMPT_TIMEOUT_MS

  const classifyThrown = (error: unknown): Failure => {
    if (request.signal?.aborted) return failure('aborted', 'The request was cancelled')
    if (deadline?.aborted || isTimeoutError(error)) return failure('timeout', 'The model did not answer in time')
    return failure('upstream', describeError(error))
  }

  try {
    if (overall?.aborted) throw new CompletionAbort()
    const networkSettings = request.networkSettings ?? await loadNetworkSettings()
    const { provider } = request

    if (isOpenAIOfficialProviderId(provider.id)) {
      return await completeWithOpenAIOfficial(request, networkSettings, overall, attemptTimeoutMs)
    }

    // The account route authenticates with its grant, not an API key.
    const accountHeaders = isDeepSeekAccountProviderId(provider.id)
      ? await resolveDeepSeekAccountRequestHeaders()
      : null
    if (!provider.baseUrl) return failure('upstream', 'The provider has no base URL')
    if (!provider.apiKey && !accountHeaders) return failure('auth', 'The provider has no credentials')

    const requestBody = {
      model: normalizeModelStringForAPI(request.modelId),
      max_tokens: request.maxTokens,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
    }
    // Providers that need local request handling answer on their own wire format.
    // Talking to them in Anthropic Messages would ignore the preset's per-model
    // rules and the client headers some gateways require, so these go through the
    // same proxy the CLI uses instead of a second, parallel code path.
    const usesLocalProxy = providerNeedsProxy(
      resolveProviderApiFormat(provider),
      provider.supportsNestedToolResultMedia,
    )
    const firstAttempt = {
      thinking: { type: 'disabled' },
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      // Only the proxy transforms read this; a direct Anthropic endpoint never sees it.
      ...(usesLocalProxy && request.reasoningEffort ? { output_config: { effort: request.reasoningEffort } } : {}),
    }
    const response = usesLocalProxy
      ? await sendThroughProxy(provider.id, request.sessionId, requestBody, firstAttempt, overall)
      : await sendAnthropicDirect(
        `${normalizeAnthropicBaseUrl(provider.baseUrl.replace(/\/+$/, ''))}/v1/messages`,
        accountHeaders ?? buildAnthropicRequestHeaders(
          provider.apiKey,
          provider.authStrategy ?? getPresetAuthStrategy(provider.presetId),
        ),
        requestBody,
        firstAttempt,
        networkSettings,
        overall,
        attemptTimeoutMs,
      )

    if (!response.ok) {
      return failure(
        classifyProviderStatus(response.status),
        `The provider answered HTTP ${response.status}`,
        response.status,
      )
    }
    const text = await raceAbort(readAnthropicText(response), overall)
    return { ok: true, text: stripThinkBlocks(text) }
  } catch (error) {
    return classifyThrown(error)
  }
}

async function completeWithOpenAIOfficial(
  request: ProviderTextCompletionRequest,
  networkSettings: NetworkSettings,
  overall: AbortSignal | undefined,
  attemptTimeoutMs: number,
): Promise<ProviderTextCompletionResult> {
  const tokens = await hahaOpenAIOAuthService.ensureFreshTokens()
  if (!tokens?.accessToken) return failure('auth', 'ChatGPT is not signed in')

  const mappedModel = resolveOpenAICodexModel(request.modelId)
  const requestBody = anthropicToOpenaiResponses({
    model: mappedModel,
    max_tokens: request.maxTokens,
    system: request.system,
    messages: [{ role: 'user', content: request.user }],
    stream: true,
    thinking: { type: 'disabled' },
    ...(request.reasoningEffort ? { output_config: { effort: request.reasoningEffort } } : {}),
  })
  requestBody.stream = true
  requestBody.max_output_tokens = request.maxTokens

  const headers = new Headers()
  headers.set('Content-Type', 'application/json')
  headers.set('Authorization', `Bearer ${tokens.accessToken}`)
  if (tokens.accountId) {
    headers.set('ChatGPT-Account-Id', tokens.accountId)
  }

  const response = await fetch(OPENAI_CODEX_API_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
    signal: combineSignals([AbortSignal.timeout(attemptTimeoutMs), overall]),
    ...getNetworkProxyFetchOptions(networkSettings, OPENAI_CODEX_API_ENDPOINT),
  })

  if (!response.ok) {
    return failure(classifyProviderStatus(response.status), `The provider answered HTTP ${response.status}`, response.status)
  }
  if (!response.body) return failure('upstream', 'The provider sent an empty response')

  const body = await raceAbort(openaiResponsesStreamToAnthropicResponse(response.body, mappedModel), overall)
  const text = body.content.find((block) => block.type === 'text')?.text ?? ''
  return { ok: true, text: stripThinkBlocks(text) }
}

/**
 * Sends the request through the in-process proxy, which owns the per-model
 * protocol decision and the preset's upstream headers. Keeps the same
 * disabled-thinking-then-retry shape as the direct path so both behave alike.
 * `firstAttempt` (thinking off, optional temperature) is dropped on the retry.
 */
async function sendThroughProxy(
  providerId: string,
  sessionId: string | undefined,
  requestBody: Record<string, unknown>,
  firstAttempt: Record<string, unknown>,
  overall: AbortSignal | undefined,
): Promise<Response> {
  const url = `http://127.0.0.1/proxy/providers/${encodeURIComponent(providerId)}/v1/messages`
  const send = (body: Record<string, unknown>) => raceAbort(handleProxyRequest(
    new Request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(sessionId ? { 'x-claude-code-session-id': sessionId } : {}),
      },
      body: JSON.stringify(body),
    }),
    new URL(url),
  ), overall)

  const response = await send({ ...requestBody, ...firstAttempt })
  return rejectedRequestShape(response) ? send(requestBody) : response
}

async function sendAnthropicDirect(
  url: string,
  requestHeaders: Record<string, string>,
  requestBody: Record<string, unknown>,
  firstAttempt: Record<string, unknown>,
  networkSettings: NetworkSettings,
  overall: AbortSignal | undefined,
  attemptTimeoutMs: number,
): Promise<Response> {
  const send = (body: Record<string, unknown>) => fetch(url, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(body),
    signal: combineSignals([AbortSignal.timeout(attemptTimeoutMs), overall]),
    ...getNetworkProxyFetchOptions(networkSettings, url),
    ...deepSeekAccountFetchInit(requestHeaders),
  })

  const response = await send({ ...requestBody, ...firstAttempt })
  return rejectedRequestShape(response) ? send(requestBody) : response
}
