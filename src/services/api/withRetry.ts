import { feature } from 'bun:bundle'
import type Anthropic from '@anthropic-ai/sdk'
import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk'
import type { QuerySource } from 'src/constants/querySource.js'
import type {
  AssistantMessage,
  SystemAPIErrorMessage,
} from 'src/types/message.js'
import { isAwsCredentialsProviderError } from 'src/utils/aws.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logError } from 'src/utils/log.js'
import { createSystemAPIErrorMessage } from 'src/utils/messages.js'
import { getAPIProviderForStatsig } from 'src/utils/model/providers.js'
import {
  clearApiKeyHelperCache,
  clearAwsCredentialsCache,
  clearGcpCredentialsCache,
  getClaudeAIOAuthTokens,
  handleOAuth401Error,
  isClaudeAISubscriber,
  isEnterpriseSubscriber,
} from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import {
  type CooldownReason,
  handleFastModeOverageRejection,
  handleFastModeRejectedByAPI,
  isFastModeCooldown,
  isFastModeEnabled,
  triggerFastModeCooldown,
} from '../../utils/fastMode.js'
import { isNonCustomOpusModel } from '../../utils/model/model.js'
import { disableKeepAlive } from '../../utils/proxy.js'
import { sleep } from '../../utils/sleep.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  checkMockRateLimitError,
  isMockRateLimitError,
} from '../rateLimitMocking.js'
import {
  isContextOverflowErrorText,
  REPEATED_529_ERROR_MESSAGE,
} from './errors.js'
import { extractConnectionErrorDetails } from './errorUtils.js'
import { StreamEndedEarlyError } from './streamFallback.js'
import { StreamWatchdogTimeoutError } from './streamWatchdog.js'
import { isOpenAIPolicyError } from '../openaiAuth/policyError.js'

const abortError = () => new APIUserAbortError()

const DEFAULT_MAX_RETRIES = 10
const FLOOR_OUTPUT_TOKENS = 3000
const MAX_529_RETRIES = 3
export const BASE_DELAY_MS = 500

// Foreground query sources where the user IS blocking on the result — these
// retry on 529. Everything else (summaries, titles, suggestions, classifiers)
// bails immediately: during a capacity cascade each retry is 3-10× gateway
// amplification, and the user never sees those fail anyway. New sources
// default to no-retry — add here only if the user is waiting on the result.
const FOREGROUND_529_RETRY_SOURCES = new Set<QuerySource>([
  'repl_main_thread',
  'repl_main_thread:outputStyle:custom',
  'repl_main_thread:outputStyle:Explanatory',
  'repl_main_thread:outputStyle:Learning',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
  'compact',
  'hook_agent',
  'hook_prompt',
  'verification_agent',
  'side_question',
  // Security classifiers — must complete for auto-mode correctness.
  // yoloClassifier.ts uses 'auto_mode' (not 'yolo_classifier' — that's
  // type-only). bash_classifier is ant-only; feature-gate so the string
  // tree-shakes out of external builds (excluded-strings.txt).
  'auto_mode',
  ...(feature('BASH_CLASSIFIER') ? (['bash_classifier'] as const) : []),
])

function shouldRetry529(querySource: QuerySource | undefined): boolean {
  // undefined → retry (conservative for untagged call paths)
  return (
    querySource === undefined || FOREGROUND_529_RETRY_SOURCES.has(querySource)
  )
}

// CLAUDE_CODE_UNATTENDED_RETRY: for unattended sessions (ant-only). Retries 429/529
// indefinitely with higher backoff and periodic keep-alive yields so the host
// environment does not mark the session idle mid-wait.
// TODO(ANT-344): the keep-alive via SystemAPIErrorMessage yields is a stopgap
// until there's a dedicated keep-alive channel.
const PERSISTENT_MAX_BACKOFF_MS = 5 * 60 * 1000
const PERSISTENT_RESET_CAP_MS = 6 * 60 * 60 * 1000
const HEARTBEAT_INTERVAL_MS = 30_000

function isPersistentRetryEnabled(): boolean {
  return feature('UNATTENDED_RETRY')
    ? isEnvTruthy(process.env.CLAUDE_CODE_UNATTENDED_RETRY)
    : false
}

function isTransientCapacityError(error: unknown): boolean {
  return (
    is529Error(error) || (error instanceof APIError && error.status === 429)
  )
}

function isStaleConnectionError(error: unknown): boolean {
  if (!(error instanceof APIConnectionError)) {
    return false
  }
  const details = extractConnectionErrorDetails(error)
  return details?.code === 'ECONNRESET' || details?.code === 'EPIPE'
}

export interface RetryContext {
  maxTokensOverride?: number
  model: string
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
}

/**
 * API attempts one logical operation may still make, shared by every layer
 * that re-sends it: stream-open retries, mid-stream re-sends and a caller's own
 * fallback request. Each layer has its own retry budget, so without a shared
 * count a failing provider multiplies one large request across nested loops.
 * Mirrors Claude Code's `compactionApiAttemptsLeft`.
 */
export type ApiAttemptBudget = { remaining: number }

export function hasApiAttemptsLeft(budget: ApiAttemptBudget | undefined): boolean {
  return budget === undefined || budget.remaining > 0
}

interface RetryOptions {
  maxRetries?: number
  model: string
  fallbackModel?: string
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
  signal?: AbortSignal
  querySource?: QuerySource
  /** Each attempt takes one; when none are left the last error is final. */
  apiAttemptBudget?: ApiAttemptBudget
  /**
   * Pre-seed the consecutive 529 counter. Used when this retry loop is a
   * non-streaming fallback after a streaming 529 — the streaming 529 should
   * count toward MAX_529_RETRIES so total 529s-before-fallback is consistent
   * regardless of which request mode hit the overload.
   */
  initialConsecutive529Errors?: number
}

export class CannotRetryError extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly retryContext: RetryContext,
  ) {
    const message = errorMessage(originalError)
    super(message)
    this.name = 'RetryError'

    // Preserve the original stack trace if available
    if (originalError instanceof Error && originalError.stack) {
      this.stack = originalError.stack
    }
  }
}

export class FallbackTriggeredError extends Error {
  constructor(
    public readonly originalModel: string,
    public readonly fallbackModel: string,
  ) {
    super(`Model fallback triggered: ${originalModel} -> ${fallbackModel}`)
    this.name = 'FallbackTriggeredError'
  }
}

/**
 * Which budget a mid-stream re-send draws from (see getMaxStreamRetries):
 * - transport: the connection under the stream died or the body ended before
 *   the response did (reset socket, proxy-reported truncation, clean EOF).
 *   Nothing ruled on the request, so it gets the stream-creation budget.
 * - watchdog: an idle stall. The attempt already burned its idle budget.
 * - transient: an error the upstream itself reported inside the stream
 *   (api_error/overloaded_error).
 */
export type StreamRetryKind = 'transport' | 'watchdog' | 'transient'

/**
 * Raised inside the streaming path when a recoverable failure arrives
 * mid-stream (inside the 200 SSE body) and therefore bypasses withRetry — which
 * only wraps stream *creation*, not stream *consumption*. Caught by
 * withStreamRetry() in streamRetry.ts, which re-establishes the stream and
 * retries the whole request. Carries the original SDK error so the
 * retries-exhausted path can surface a faithful API-error message.
 */
export class RetriableStreamError extends Error {
  public readonly bufferedMessages: readonly AssistantMessage[]

  constructor(
    public readonly originalError: unknown,
    bufferedMessages: readonly AssistantMessage[] = [],
    public readonly kind: StreamRetryKind = 'transient',
  ) {
    super(errorMessage(originalError))
    this.name = 'RetriableStreamError'
    this.bufferedMessages = bufferedMessages
    Object.defineProperty(this, 'bufferedMessages', { enumerable: false })
    if (originalError instanceof Error && originalError.stack) {
      this.stack = originalError.stack
    }
  }
}

/**
 * Detect transient, server-side errors that the SDK surfaces *during streaming*
 * without a usable HTTP status. The upstream sends them inside a 200 SSE body as
 *   {"type":"error","error":{"type":"api_error"|"overloaded_error",...}}
 * so `error.status` is undefined and every status-based check in shouldRetry()
 * falls through to `return false`. Per Anthropic semantics both are retryable:
 * `api_error` = "unexpected error internal to the server", `overloaded_error` =
 * capacity. Local/proxy providers (e.g. LM Studio) also wrap transient
 * generation failures — such as a malformed tool_call the runtime rejects
 * mid-stream — as `api_error`, which a fresh attempt almost always clears.
 *
 * Matches the serialized error body embedded in `error.message`, the same
 * technique the overloaded-error check has always used (see shouldRetry).
 */
export function isRetryableStreamError(error: unknown): boolean {
  if (isOpenAIPolicyError(error)) return false
  if (!(error instanceof APIError)) {
    return false
  }
  const message = error.message
  if (!message) {
    return false
  }
  return (
    message.includes('"type":"api_error"') ||
    message.includes('"type":"overloaded_error"')
  )
}

/**
 * Transport failures that mean the TCP/TLS connection under an *already
 * established* stream died: a pooled keep-alive socket the peer had already
 * closed, a proxy/NAT that dropped an idle-then-reused connection, or an
 * upstream edge that reset the response mid-flight. Bun and Node/undici report
 * the same physical failure under different codes.
 */
const STREAM_TRANSPORT_DISCONNECT_CODES = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'UND_ERR_SOCKET',
  'ERR_STREAM_PREMATURE_CLOSE',
])

/**
 * Detect a transport disconnect raised while *consuming* an established stream.
 *
 * These reach neither retry layer on their own: withRetry only guards stream
 * creation, and isRetryableStreamError only matches error payloads the upstream
 * serialized into a 200 SSE body. A dead socket produces neither — under Bun it
 * surfaces as a bare `Error` with `code: 'ECONNRESET'` and the message "The
 * socket connection was closed unexpectedly", which is not an APIError at all.
 * Hence the check walks the cause chain for a code instead of keying on type.
 *
 * Retrying is only safe behind a replay guard; see getStreamRetryKind.
 */
export function isRetryableStreamTransportError(error: unknown): boolean {
  if (isOpenAIPolicyError(error)) return false
  const code = extractConnectionErrorDetails(error)?.code
  return code !== undefined && STREAM_TRANSPORT_DISCONNECT_CODES.has(code)
}

/**
 * Error types the local provider proxy (src/server/proxy) writes into a 200
 * SSE body when it loses the upstream response: `stream_error` when reading or
 * converting the upstream body failed, `stream_truncated` when the upstream
 * closed without a terminal finish_reason. Unlike api_error or
 * invalid_request_error they report the connection, not a provider verdict.
 */
const PROXY_STREAM_TRANSPORT_ERROR_TYPES: ReadonlySet<string> = new Set([
  'stream_error',
  'stream_truncated',
])

export function isProxyStreamTransportError(error: unknown): boolean {
  if (isOpenAIPolicyError(error)) return false
  // The SDK raises an SSE `error` event as a status-less APIError whose
  // `error` is the parsed event: { type: 'error', error: { type, message } }.
  if (!(error instanceof APIError) || error.status !== undefined) return false
  const event = error.error as { error?: { type?: unknown } } | undefined
  const type = event?.error?.type
  return typeof type === 'string' && PROXY_STREAM_TRANSPORT_ERROR_TYPES.has(type)
}

/**
 * Decide whether a failed streaming attempt can be discarded and re-sent as a
 * new stream, and which budget that draws from. null leaves the failure to the
 * non-streaming fallback or the terminal error path.
 *
 * SSE has no resume, so recovery is a full re-send — legitimate only while
 * `canReplay` holds: nothing from the attempt was committed to the consumer and
 * no server-side tool work began. Local tool_use blocks stay in
 * StreamAssistantCommitBuffer until the response completes, so a completed but
 * uncommitted tool call has not run and a re-send cannot duplicate it
 * (#766 / inc-4258).
 *
 * Truncations the non-streaming fallback already recovers keep going there
 * when it is available. A response that ended mid-way never did: the fallback
 * would silently replace output the user already saw, while a stream retry
 * first retracts it.
 */
export function getStreamRetryKind(input: {
  error: unknown
  canReplay: boolean
  streamIdleAborted: boolean
  signalAborted: boolean
  nonStreamingFallbackAvailable: boolean
  /** Whether an upstream-reported error may re-send this attempt. */
  transientRetryAllowed: boolean
}): StreamRetryKind | null {
  const { error } = input
  if (!input.canReplay || input.signalAborted || isOpenAIPolicyError(error)) {
    return null
  }
  if (input.streamIdleAborted) {
    return error instanceof StreamWatchdogTimeoutError &&
      error.safeToRetryStream()
      ? 'watchdog'
      : null
  }
  if (isRetryableStreamTransportError(error)) return 'transport'
  if (
    error instanceof StreamEndedEarlyError ||
    isProxyStreamTransportError(error)
  ) {
    const fallbackRecovers =
      input.nonStreamingFallbackAvailable &&
      !(error instanceof StreamEndedEarlyError && error.reason === 'incomplete')
    return fallbackRecovers ? null : 'transport'
  }
  return input.transientRetryAllowed && isRetryableStreamError(error)
    ? 'transient'
    : null
}

const DEFAULT_MAX_STREAM_TRANSIENT_RETRIES = 2

function getStreamTransientRetryOverride(): number | undefined {
  const raw = parseInt(process.env.CLAUDE_STREAM_TRANSIENT_RETRY_MAX || '', 10)
  return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 5) : undefined
}

/**
 * Max times withStreamRetry() re-establishes a stream after a watchdog stall
 * or an upstream-reported transient error. Small by default — a malformed
 * tool_call or a one-off blip usually clears on the first retry, and a stalled
 * attempt already burned its idle budget. Override with
 * CLAUDE_STREAM_TRANSIENT_RETRY_MAX; values are capped at 5 so a bad
 * environment value cannot make it unbounded.
 */
export function getMaxStreamTransientRetries(): number {
  return getStreamTransientRetryOverride() ?? DEFAULT_MAX_STREAM_TRANSIENT_RETRIES
}

/**
 * Retry budget for one kind of mid-stream failure. A transport failure is a
 * request that never got an answer, so it gets the same budget as a stream
 * that failed to open (CLAUDE_CODE_MAX_RETRIES, default 10); otherwise an
 * unattended run drops out on the first flaky upstream. An explicit
 * CLAUDE_STREAM_TRANSIENT_RETRY_MAX also caps it, so 0 still disables every
 * mid-stream retry.
 */
export function getMaxStreamRetries(kind: StreamRetryKind): number {
  if (kind !== 'transport') return getMaxStreamTransientRetries()
  const configured = getDefaultMaxRetries()
  const apiRetries =
    Number.isFinite(configured) && configured >= 0
      ? configured
      : DEFAULT_MAX_RETRIES
  const override = getStreamTransientRetryOverride()
  return override === undefined ? apiRetries : Math.min(override, apiRetries)
}

export async function* withRetry<T>(
  getClient: () => Promise<Anthropic>,
  operation: (
    client: Anthropic,
    attempt: number,
    context: RetryContext,
  ) => Promise<T>,
  options: RetryOptions,
): AsyncGenerator<SystemAPIErrorMessage, T> {
  const maxRetries = getMaxRetries(options)
  const retryContext: RetryContext = {
    model: options.model,
    thinkingConfig: options.thinkingConfig,
    ...(isFastModeEnabled() && { fastMode: options.fastMode }),
  }
  let client: Anthropic | null = null
  let consecutive529Errors = options.initialConsecutive529Errors ?? 0
  let lastError: unknown
  let persistentAttempt = 0
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (options.signal?.aborted) {
      throw new APIUserAbortError()
    }
    if (options.apiAttemptBudget) {
      if (options.apiAttemptBudget.remaining <= 0) {
        throw new CannotRetryError(
          lastError ?? new Error('No API attempts left for this request'),
          retryContext,
        )
      }
      options.apiAttemptBudget.remaining--
    }

    // Capture whether fast mode is active before this attempt
    // (fallback may change the state mid-loop)
    const wasFastModeActive = isFastModeEnabled()
      ? retryContext.fastMode && !isFastModeCooldown()
      : false

    try {
      // Check for mock rate limits (used by /mock-limits command for Ant employees)
      if (process.env.USER_TYPE === 'ant') {
        const mockError = checkMockRateLimitError(
          retryContext.model,
          wasFastModeActive,
        )
        if (mockError) {
          throw mockError
        }
      }

      // Get a fresh client instance on first attempt or after authentication errors
      // - 401 for first-party API authentication failures
      // - 403 "OAuth token has been revoked" (another process refreshed the token)
      // - Bedrock-specific auth errors (403 or CredentialsProviderError)
      // - Vertex-specific auth errors (credential refresh failures, 401)
      // - ECONNRESET/EPIPE: stale keep-alive socket; disable pooling and reconnect
      const isStaleConnection = isStaleConnectionError(lastError)
      if (isStaleConnection) {
        logForDebugging(
          'Stale connection (ECONNRESET/EPIPE) — disabling keep-alive for retry',
        )
        disableKeepAlive()
      }

      if (
        client === null ||
        (lastError instanceof APIError && lastError.status === 401) ||
        isOAuthTokenRevokedError(lastError) ||
        isBedrockAuthError(lastError) ||
        isVertexAuthError(lastError) ||
        isStaleConnection
      ) {
        // On 401 "token expired" or 403 "token revoked", force a token refresh
        if (
          (lastError instanceof APIError && lastError.status === 401) ||
          isOAuthTokenRevokedError(lastError)
        ) {
          const failedAccessToken = getClaudeAIOAuthTokens()?.accessToken
          if (failedAccessToken) {
            await handleOAuth401Error(failedAccessToken)
          }
        }
        client = await getClient()
      }

      return await operation(client, attempt, retryContext)
    } catch (error) {
      // Policy rejection is final even when a gateway labels it 401/429/5xx.
      // Stop before auth refresh, fast-mode changes or persistent/model fallback.
      if (isOpenAIPolicyError(error)) {
        throw new CannotRetryError(error, retryContext)
      }
      lastError = error
      logForDebugging(
        `API error (attempt ${attempt}/${maxRetries + 1}): ${error instanceof APIError ? `${error.status} ${error.message}` : errorMessage(error)}`,
        { level: 'error' },
      )

      // Fast mode fallback: on 429/529, either wait and retry (short delays)
      // or fall back to standard speed (long delays) to avoid cache thrashing.
      // Skip in persistent mode: the short-retry path below loops with fast
      // mode still active, so its `continue` never reaches the attempt clamp
      // and the for-loop terminates. Persistent sessions want the chunked
      // keep-alive path instead of fast-mode cache-preservation anyway.
      if (
        wasFastModeActive &&
        !isPersistentRetryEnabled() &&
        error instanceof APIError &&
        (error.status === 429 || is529Error(error))
      ) {
        // If the 429 is specifically because extra usage (overage) is not
        // available, permanently disable fast mode with a specific message.
        const overageReason = error.headers?.get(
          'anthropic-ratelimit-unified-overage-disabled-reason',
        )
        if (overageReason !== null && overageReason !== undefined) {
          handleFastModeOverageRejection(overageReason)
          retryContext.fastMode = false
          continue
        }

        const retryAfterMs = getRetryAfterMs(error)
        if (retryAfterMs !== null && retryAfterMs < SHORT_RETRY_THRESHOLD_MS) {
          // Short retry-after: wait and retry with fast mode still active
          // to preserve prompt cache (same model name on retry).
          await sleep(retryAfterMs, options.signal, { abortError })
          continue
        }
        // Long or unknown retry-after: enter cooldown (switches to standard
        // speed model), with a minimum floor to avoid flip-flopping.
        const cooldownMs = Math.max(
          retryAfterMs ?? DEFAULT_FAST_MODE_FALLBACK_HOLD_MS,
          MIN_COOLDOWN_MS,
        )
        const cooldownReason: CooldownReason = is529Error(error)
          ? 'overloaded'
          : 'rate_limit'
        triggerFastModeCooldown(Date.now() + cooldownMs, cooldownReason)
        if (isFastModeEnabled()) {
          retryContext.fastMode = false
        }
        continue
      }

      // Fast mode fallback: if the API rejects the fast mode parameter
      // (e.g., org doesn't have fast mode enabled), permanently disable fast
      // mode and retry at standard speed.
      if (wasFastModeActive && isFastModeNotEnabledError(error)) {
        handleFastModeRejectedByAPI()
        retryContext.fastMode = false
        continue
      }

      // Non-foreground sources bail immediately on 529 — no retry amplification
      // during capacity cascades. User never sees these fail.
      if (is529Error(error) && !shouldRetry529(options.querySource)) {
        logEvent('tengu_api_529_background_dropped', {
          query_source:
            options.querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw new CannotRetryError(error, retryContext)
      }

      // Track consecutive 529 errors
      if (
        is529Error(error) &&
        // If FALLBACK_FOR_ALL_PRIMARY_MODELS is not set, fall through only if the primary model is a non-custom Opus model.
        // TODO: Revisit if the isNonCustomOpusModel check should still exist, or if isNonCustomOpusModel is a stale artifact of when Claude Code was hardcoded on Opus.
        (process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS ||
          (!isClaudeAISubscriber() && isNonCustomOpusModel(options.model)))
      ) {
        consecutive529Errors++
        if (consecutive529Errors >= MAX_529_RETRIES) {
          // Check if fallback model is specified
          if (options.fallbackModel) {
            logEvent('tengu_api_opus_fallback_triggered', {
              original_model:
                options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              fallback_model:
                options.fallbackModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              provider: getAPIProviderForStatsig(),
            })

            // Throw special error to indicate fallback was triggered
            throw new FallbackTriggeredError(
              options.model,
              options.fallbackModel,
            )
          }

          if (
            process.env.USER_TYPE === 'external' &&
            !process.env.IS_SANDBOX &&
            !isPersistentRetryEnabled()
          ) {
            logEvent('tengu_api_custom_529_overloaded_error', {})
            throw new CannotRetryError(
              new Error(REPEATED_529_ERROR_MESSAGE),
              retryContext,
            )
          }
        }
      }

      // Only retry if the error indicates we should
      const persistent =
        isPersistentRetryEnabled() && isTransientCapacityError(error)
      if (
        (attempt > maxRetries && !persistent) ||
        !hasApiAttemptsLeft(options.apiAttemptBudget)
      ) {
        throw new CannotRetryError(error, retryContext)
      }

      // AWS/GCP errors aren't always APIError, but can be retried
      const handledCloudAuthError =
        handleAwsCredentialError(error) || handleGcpCredentialError(error)
      if (
        !handledCloudAuthError &&
        (!(error instanceof APIError) || !shouldRetry(error))
      ) {
        throw new CannotRetryError(error, retryContext)
      }

      // Handle max tokens context overflow errors by adjusting max_tokens for the next attempt
      // NOTE: With extended-context-window beta, this 400 error should not occur.
      // The API now returns 'model_context_window_exceeded' stop_reason instead.
      // Keeping for backward compatibility.
      if (error instanceof APIError) {
        const overflowData = parseMaxTokensContextOverflowError(error)
        if (overflowData) {
          const { inputTokens, contextLimit } = overflowData

          const safetyBuffer = 1000
          const availableContext = Math.max(
            0,
            contextLimit - inputTokens - safetyBuffer,
          )
          if (availableContext < FLOOR_OUTPUT_TOKENS) {
            logError(
              new Error(
                `availableContext ${availableContext} is less than FLOOR_OUTPUT_TOKENS ${FLOOR_OUTPUT_TOKENS}`,
              ),
            )
            throw error
          }
          const adjustedMaxTokens = availableContext
          if (
            retryContext.maxTokensOverride !== undefined &&
            adjustedMaxTokens >= retryContext.maxTokensOverride
          ) {
            throw new CannotRetryError(error, retryContext)
          }
          retryContext.maxTokensOverride = adjustedMaxTokens

          logEvent('tengu_max_tokens_context_overflow_adjustment', {
            inputTokens,
            contextLimit,
            adjustedMaxTokens,
            attempt,
          })

          continue
        }
      }

      // For other errors, proceed with normal retry logic
      // Get retry-after header if available
      const retryAfter = getRetryAfter(error)
      let delayMs: number
      if (persistent && error instanceof APIError && error.status === 429) {
        persistentAttempt++
        // Window-based limits (e.g. 5hr Max/Pro) include a reset timestamp.
        // Wait until reset rather than polling every 5 min uselessly.
        const resetDelay = getRateLimitResetDelayMs(error)
        delayMs =
          resetDelay ??
          Math.min(
            getRetryDelay(
              persistentAttempt,
              retryAfter,
              PERSISTENT_MAX_BACKOFF_MS,
            ),
            PERSISTENT_RESET_CAP_MS,
          )
      } else if (persistent) {
        persistentAttempt++
        // Retry-After is a server directive and bypasses maxDelayMs inside
        // getRetryDelay (intentional — honoring it is correct). Cap at the
        // 6hr reset-cap here so a pathological header can't wait unbounded.
        delayMs = Math.min(
          getRetryDelay(
            persistentAttempt,
            retryAfter,
            PERSISTENT_MAX_BACKOFF_MS,
          ),
          PERSISTENT_RESET_CAP_MS,
        )
      } else {
        delayMs = getRetryDelay(attempt, retryAfter)
      }

      // In persistent mode the for-loop `attempt` is clamped at maxRetries+1;
      // use persistentAttempt for telemetry/yields so they show the true count.
      const reportedAttempt = persistent ? persistentAttempt : attempt
      logEvent('tengu_api_retry', {
        attempt: reportedAttempt,
        delayMs: delayMs,
        error: (error as APIError)
          .message as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        status: (error as APIError).status,
        provider: getAPIProviderForStatsig(),
      })

      if (persistent) {
        if (delayMs > 60_000) {
          logEvent('tengu_api_persistent_retry_wait', {
            status: (error as APIError).status,
            delayMs,
            attempt: reportedAttempt,
            provider: getAPIProviderForStatsig(),
          })
        }
        // Chunk long sleeps so the host sees periodic stdout activity and
        // does not mark the session idle. Each yield surfaces as
        // {type:'system', subtype:'api_retry'} on stdout via QueryEngine.
        let remaining = delayMs
        while (remaining > 0) {
          if (options.signal?.aborted) throw new APIUserAbortError()
          if (error instanceof APIError) {
            yield createSystemAPIErrorMessage(
              error,
              remaining,
              reportedAttempt,
              maxRetries,
            )
          }
          const chunk = Math.min(remaining, HEARTBEAT_INTERVAL_MS)
          await sleep(chunk, options.signal, { abortError })
          remaining -= chunk
        }
        // Clamp so the for-loop never terminates. Backoff uses the separate
        // persistentAttempt counter which keeps growing to the 5-min cap.
        if (attempt >= maxRetries) attempt = maxRetries
      } else {
        if (error instanceof APIError) {
          yield createSystemAPIErrorMessage(error, delayMs, attempt, maxRetries)
        }
        await sleep(delayMs, options.signal, { abortError })
      }
    }
  }

  throw new CannotRetryError(lastError, retryContext)
}

function getRetryAfter(error: unknown): string | null {
  return (
    ((error as { headers?: { 'retry-after'?: string } }).headers?.[
      'retry-after'
    ] ||
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      ((error as APIError).headers as Headers)?.get?.('retry-after')) ??
    null
  )
}

export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs = 32000,
): number {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10)
    if (Number.isFinite(seconds)) {
      // A zero (or negative) hint must not turn capacity retries into a hot loop.
      return Math.max(BASE_DELAY_MS, seconds * 1000)
    }
  }

  const baseDelay = Math.min(
    BASE_DELAY_MS * Math.pow(2, attempt - 1),
    maxDelayMs,
  )
  const jitter = Math.random() * 0.25 * baseDelay
  return baseDelay + jitter
}

export function parseMaxTokensContextOverflowError(error: APIError):
  | {
      inputTokens: number
      maxTokens: number
      contextLimit: number
    }
  | undefined {
  if (error.status !== 400 || !error.message) {
    return undefined
  }

  if (
    !error.message.includes(
      'input length and `max_tokens` exceed context limit',
    )
  ) {
    return undefined
  }

  // Example format: "input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000"
  const regex =
    /input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)/
  const match = error.message.match(regex)

  if (!match || match.length !== 4) {
    return undefined
  }

  if (!match[1] || !match[2] || !match[3]) {
    logError(
      new Error(
        'Unable to parse max_tokens from max_tokens exceed context limit error message',
      ),
    )
    return undefined
  }
  const inputTokens = parseInt(match[1], 10)
  const maxTokens = parseInt(match[2], 10)
  const contextLimit = parseInt(match[3], 10)

  if (isNaN(inputTokens) || isNaN(maxTokens) || isNaN(contextLimit)) {
    return undefined
  }

  return { inputTokens, maxTokens, contextLimit }
}

// TODO: Replace with a response header check once the API adds a dedicated
// header for fast-mode rejection (e.g., x-fast-mode-rejected). String-matching
// the error message is fragile and will break if the API wording changes.
function isFastModeNotEnabledError(error: unknown): boolean {
  if (!(error instanceof APIError)) {
    return false
  }
  return (
    error.status === 400 &&
    (error.message?.includes('Fast mode is not enabled') ?? false)
  )
}

export function is529Error(error: unknown): boolean {
  if (!(error instanceof APIError)) {
    return false
  }

  // Check for 529 status code or overloaded error in message
  return (
    error.status === 529 ||
    // See below: the SDK sometimes fails to properly pass the 529 status code during streaming
    (error.message?.includes('"type":"overloaded_error"') ?? false)
  )
}

function isOAuthTokenRevokedError(error: unknown): boolean {
  return (
    error instanceof APIError &&
    error.status === 403 &&
    (error.message?.includes('OAuth token has been revoked') ?? false)
  )
}

function isBedrockAuthError(error: unknown): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) {
    // AWS libs reject without an API call if .aws holds a past Expiration value
    // otherwise, API calls that receive expired tokens give generic 403
    // "The security token included in the request is invalid"
    if (
      isAwsCredentialsProviderError(error) ||
      (error instanceof APIError && error.status === 403)
    ) {
      return true
    }
  }
  return false
}

/**
 * Clear AWS auth caches if appropriate.
 * @returns true if action was taken.
 */
function handleAwsCredentialError(error: unknown): boolean {
  if (isBedrockAuthError(error)) {
    clearAwsCredentialsCache()
    return true
  }
  return false
}

// google-auth-library throws plain Error (no typed name like AWS's
// CredentialsProviderError). Match common SDK-level credential-failure messages.
function isGoogleAuthLibraryCredentialError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message
  return (
    msg.includes('Could not load the default credentials') ||
    msg.includes('Could not refresh access token') ||
    msg.includes('invalid_grant')
  )
}

function isVertexAuthError(error: unknown): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) {
    // SDK-level: google-auth-library fails in prepareOptions() before the HTTP call
    if (isGoogleAuthLibraryCredentialError(error)) {
      return true
    }
    // Server-side: Vertex returns 401 for expired/invalid tokens
    if (error instanceof APIError && error.status === 401) {
      return true
    }
  }
  return false
}

/**
 * Clear GCP auth caches if appropriate.
 * @returns true if action was taken.
 */
function handleGcpCredentialError(error: unknown): boolean {
  if (isVertexAuthError(error)) {
    clearGcpCredentialsCache()
    return true
  }
  return false
}

function shouldRetry(error: APIError): boolean {
  if (isOpenAIPolicyError(error)) return false
  // Never retry mock errors - they're from /mock-limits command for testing
  if (isMockRateLimitError(error)) {
    return false
  }

  // Persistent mode: 429/529 always retryable, bypass subscriber gates and
  // x-should-retry header.
  if (isPersistentRetryEnabled() && isTransientCapacityError(error)) {
    return true
  }

  // CCR mode: auth is via infrastructure-provided JWTs, so a 401/403 is a
  // transient blip (auth service flap, network hiccup) rather than bad
  // credentials. Bypass x-should-retry:false — the server assumes we'd retry
  // the same bad key, but our key is fine.
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
    (error.status === 401 || error.status === 403)
  ) {
    return true
  }

  // Check for overloaded errors first by examining the message content
  // The SDK sometimes fails to properly pass the 529 status code during streaming,
  // so we need to check the error message directly
  if (error.message?.includes('"type":"overloaded_error"')) {
    return true
  }

  // Check for max tokens context overflow errors that we can handle
  if (parseMaxTokensContextOverflowError(error)) {
    return true
  }

  // Note this is not a standard header.
  const shouldRetryHeader = error.headers?.get('x-should-retry')

  // If the server explicitly says whether or not to retry, obey.
  // For Max and Pro users, should-retry is true, but in several hours, so we shouldn't.
  // Enterprise users can retry because they typically use PAYG instead of rate limits.
  if (
    shouldRetryHeader === 'true' &&
    (!isClaudeAISubscriber() || isEnterpriseSubscriber())
  ) {
    return true
  }

  // Ants can ignore x-should-retry: false for 5xx server errors only.
  // For other status codes (401, 403, 400, 429, etc.), respect the header.
  if (shouldRetryHeader === 'false') {
    const is5xxError = error.status !== undefined && error.status >= 500
    if (!(process.env.USER_TYPE === 'ant' && is5xxError)) {
      return false
    }
  }

  if (error instanceof APIConnectionError) {
    return true
  }

  if (!error.status) return false

  // Retry on request timeouts.
  if (error.status === 408) return true

  // Retry on lock timeouts.
  if (error.status === 409) return true

  // Retry on rate limits, but not for ClaudeAI Subscription users
  // Enterprise users can retry because they typically use PAYG instead of rate limits
  if (error.status === 429) {
    return !isClaudeAISubscriber() || isEnterpriseSubscriber()
  }

  // Clear API key cache on 401 and allow retry.
  // OAuth token handling is done in the main retry loop via handleOAuth401Error.
  if (error.status === 401) {
    // Some gateways wrap context-overflow rejections in a 401 (#1162).
    // Retrying just replays the same oversized prompt — fail fast so the
    // overflow surfaces and compaction can react instead.
    if (isContextOverflowErrorText(error.message)) {
      return false
    }
    clearApiKeyHelperCache()
    return true
  }

  // Retry on 403 "token revoked" (same refresh logic as 401, see above)
  if (isOAuthTokenRevokedError(error)) {
    return true
  }

  // Retry internal errors.
  if (error.status && error.status >= 500) return true

  return false
}

export function getDefaultMaxRetries(): number {
  if (process.env.CLAUDE_CODE_MAX_RETRIES) {
    return parseInt(process.env.CLAUDE_CODE_MAX_RETRIES, 10)
  }
  return DEFAULT_MAX_RETRIES
}
function getMaxRetries(options: RetryOptions): number {
  return options.maxRetries ?? getDefaultMaxRetries()
}

const DEFAULT_FAST_MODE_FALLBACK_HOLD_MS = 30 * 60 * 1000 // 30 minutes
const SHORT_RETRY_THRESHOLD_MS = 20 * 1000 // 20 seconds
const MIN_COOLDOWN_MS = 10 * 60 * 1000 // 10 minutes

function getRetryAfterMs(error: APIError): number | null {
  const retryAfter = getRetryAfter(error)
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10)
    if (Number.isFinite(seconds)) {
      // A zero (or negative) hint must not turn capacity retries into a hot loop.
      return Math.max(BASE_DELAY_MS, seconds * 1000)
    }
  }
  return null
}

function getRateLimitResetDelayMs(error: APIError): number | null {
  const resetHeader = error.headers?.get?.('anthropic-ratelimit-unified-reset')
  if (!resetHeader) return null
  const resetUnixSec = Number(resetHeader)
  if (!Number.isFinite(resetUnixSec)) return null
  const delayMs = resetUnixSec * 1000 - Date.now()
  if (delayMs <= 0) return null
  return Math.min(delayMs, PERSISTENT_RESET_CAP_MS)
}
