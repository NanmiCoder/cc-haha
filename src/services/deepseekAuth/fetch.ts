import {
  DEEPSEEK_AUTH_HEADER,
  DEEPSEEK_INFERENCE_ORIGIN,
} from './client.js'
import {
  clearRejectedDeepSeekToken,
  getDeepSeekOAuthTokensAsync,
  isInferenceEligibleGrant,
} from './storage.js'

const SIGN_IN_REQUIRED_MESSAGE =
  'DeepSeek account is not signed in. Sign in to DeepSeek again in Settings > Providers.'

// Answered locally, so there is nothing to retry: without the header the CLI
// would back off for minutes before showing the sign-in message.
function authenticationError(message: string): Response {
  return Response.json(
    { type: 'error', error: { type: 'authentication_error', message } },
    { status: 401, headers: { 'x-should-retry': 'false' } },
  )
}

/**
 * Account requests authenticate with `x-dsh-auth-token` instead of the
 * Anthropic key headers. The token is read per request so a sign-out, or a
 * fresh sign-in, applies to a running session without restarting it, and it
 * is attached only for the inference origin: any other destination goes out
 * untouched and never sees the grant. Redirects are refused so the token
 * cannot follow one to another origin.
 */
export function buildDeepSeekFetch(
  fetchOverride: typeof fetch | undefined,
  inferenceOrigin: string = DEEPSEEK_INFERENCE_ORIGIN,
): typeof fetch {
  const inner = fetchOverride ?? globalThis.fetch

  return async (input, init) => {
    const request = input instanceof Request ? input : null
    const url = request ? new URL(request.url) : new URL(String(input))
    if (url.origin !== inferenceOrigin) return inner(input, init)

    const tokens = await getDeepSeekOAuthTokensAsync()
    if (!tokens || !isInferenceEligibleGrant(tokens)) {
      return authenticationError(SIGN_IN_REQUIRED_MESSAGE)
    }

    const headers = new Headers(request?.headers)
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value))
    }
    headers.delete('x-api-key')
    headers.delete('authorization')
    headers.set(DEEPSEEK_AUTH_HEADER, tokens.token)

    const response = await inner(input, { ...init, headers, redirect: 'error' })
    if (response.status === 401) clearRejectedDeepSeekToken(tokens.token)
    return response
  }
}
