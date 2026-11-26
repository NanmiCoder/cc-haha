import { ApiError, type ApiClient } from './client'

/** Matches server PromptOptimizeService timeout (120 s). */
export const PROMPT_OPTIMIZE_TIMEOUT_MS = 120_000
export const PROMPT_OPTIMIZE_CANCEL_TIMEOUT_MS = 10_000
/** Exact 405 message returned by handlePromptOptimizeRoute on v0.8.0+ servers. */
const SUPPORTED_PROBE_MESSAGE = 'Unsupported prompt optimization route'

export type PromptOptimizeRequest = {
  requestId: string
  prompt: string
}

export type PromptOptimizeResponse = {
  requestId: string
  optimizedPrompt: string
}

export type CancelPromptOptimizeResponse = {
  requestId: string
  cancelled: boolean
}

const cancelSupportByClient = new WeakMap<ApiClient, boolean>()

function isLegacyUnsupportedStatus(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false
  if (error.status === 405) return true
  return error.status === 404 && !/^Session not found/i.test(error.message)
}

function isSupportedRouteError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false
  return (
    error.code === 'PROMPT_OPTIMIZE_CANCELLED' ||
    error.code === 'PROMPT_OPTIMIZE_TIMEOUT' ||
    error.code === 'PROMPT_OPTIMIZE_FAILED' ||
    error.code === 'BODY_TOO_LARGE' ||
    error.status === 409 ||
    error.status === 413 ||
    error.status === 499 ||
    error.status === 502 ||
    error.status === 504
  )
}

/**
 * Confirm the host actually routes `/api/sessions/:id/optimize-prompt` before
 * ever issuing a DELETE request. Pre-v0.8.0 servers lacked a sub-resource guard
 * before their item `DELETE` handler, so an unguarded DELETE would delete the
 * session itself. A read-only GET returns 405 ("Unsupported prompt optimization
 * route") on v0.8.0+ and 200 (the session record) on pre-v0.8.0.
 */
async function confirmCancelSupport(
  client: ApiClient,
  sessionId: string,
): Promise<boolean> {
  const cached = cancelSupportByClient.get(client)
  if (cached !== undefined) return cached
  try {
    await client.get<unknown>(
      `/api/sessions/${encodeURIComponent(sessionId)}/optimize-prompt`,
      { timeoutMs: PROMPT_OPTIMIZE_CANCEL_TIMEOUT_MS },
    )
    // HTTP 200 means the server fell through to GET /api/sessions/:id.
    cancelSupportByClient.set(client, false)
    return false
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 405 &&
      error.message === SUPPORTED_PROBE_MESSAGE
    ) {
      cancelSupportByClient.set(client, true)
      return true
    }
    if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
      cancelSupportByClient.set(client, false)
    }
    return false
  }
}

export async function optimizePrompt(
  client: ApiClient,
  sessionId: string,
  body: PromptOptimizeRequest,
  signal?: AbortSignal,
): Promise<PromptOptimizeResponse> {
  try {
    const response = await client.post<PromptOptimizeResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/optimize-prompt`,
      body,
      { signal, timeoutMs: PROMPT_OPTIMIZE_TIMEOUT_MS },
    )
    cancelSupportByClient.set(client, true)
    return response
  } catch (error) {
    if (isSupportedRouteError(error)) {
      cancelSupportByClient.set(client, true)
    } else if (isLegacyUnsupportedStatus(error)) {
      cancelSupportByClient.set(client, false)
    }
    throw error
  }
}

export async function cancelOptimizePrompt(
  client: ApiClient,
  sessionId: string,
  requestId: string,
): Promise<CancelPromptOptimizeResponse> {
  const supported = await confirmCancelSupport(client, sessionId)
  if (!supported) {
    return { requestId, cancelled: false }
  }
  return client.request<CancelPromptOptimizeResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/optimize-prompt/${encodeURIComponent(requestId)}`,
    { method: 'DELETE', timeoutMs: PROMPT_OPTIMIZE_CANCEL_TIMEOUT_MS },
  )
}
