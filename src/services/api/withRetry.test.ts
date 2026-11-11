import { describe, expect, spyOn, test } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import { APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk'
import { clearFastModeCooldown, getFastModeRuntimeState } from '../../utils/fastMode.js'
import { _resetKeepAliveForTesting, getProxyFetchOptions } from '../../utils/proxy.js'
import { withAgentProviderRoute, withRequestProviderRoute } from '../../utils/model/providerEnvScope.js'
import * as auth from '../../utils/auth.js'
import { StreamEndedEarlyError } from './streamFallback.js'
import { createStreamWatchdogState } from './streamWatchdog.js'
import {
  BASE_DELAY_MS,
  getRetryDelay,
  CannotRetryError,
  getMaxStreamRetries,
  getMaxStreamTransientRetries,
  getStreamRetryKind,
  isLocalServiceRefused,
  isProxyStreamTransportError,
  isRetryableStreamError,
  isRetryableStreamTransportError,
  isStreamRequestRejection,
  RetriableStreamError,
  withRetry,
} from './withRetry.js'

describe('withRetry invalid saved provider key', () => {
  test.each(['ordinary', 'remote', 'vertex'])('stops a marked local proxy key error before %s auth refresh', async mode => {
    const keys = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST'] as const
    const previous = keys.map(key => process.env[key])
    Object.assign(process.env, {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4567/proxy/providers/fixture',
      ANTHROPIC_API_KEY: 'proxy-managed',
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      CLAUDE_CODE_REMOTE: mode === 'remote' ? '1' : '',
      CLAUDE_CODE_USE_VERTEX: mode === 'vertex' ? '1' : '',
    })
    const error = new APIError(401, { error: { message: 'Invalid credential' } }, undefined,
      new Headers({ 'x-cc-haha-invalid-provider-key': 'true', 'x-should-retry': 'false' }))
    let attempts = 0
    const generator = withRetry(async () => ({} as Anthropic), async () => { attempts++; throw error },
      { model: 'fixture', thinkingConfig: { type: 'disabled' }, maxRetries: 1 })
    try {
      let caught: unknown
      try { await generator.next() } catch (cause) { caught = cause }
      expect(caught).toBeInstanceOf(CannotRetryError)
      expect((caught as CannotRetryError).originalError).toBe(error)
      expect(attempts).toBe(1)
    } finally {
      await generator.return(undefined as never)
      keys.forEach((key, index) => previous[index] === undefined ? delete process.env[key] : process.env[key] = previous[index])
    }
  })

  test('uses the current Agent route when recognizing a marked proxy error', async () => {
    const error = new APIError(401, { error: { message: 'Invalid credential' } }, undefined,
      new Headers({ 'x-cc-haha-invalid-provider-key': 'true', 'x-should-retry': 'false' }))
    let attempts = 0
    const route = {
      providerId: 'fixture', providerName: 'Fixture', model: 'fixture-model',
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4567/proxy/providers/fixture', ANTHROPIC_API_KEY: 'proxy-managed' },
    }
    const generator = withAgentProviderRoute(route, (async function* () {
      return yield* withRequestProviderRoute('fixture-model', withRetry(
        async () => ({} as Anthropic), async () => { attempts++; throw error },
        { model: 'fixture-model', thinkingConfig: { type: 'disabled' }, maxRetries: 1 },
      ))
    })())
    let caught: unknown
    try { await generator.next() } catch (cause) { caught = cause }
    finally { await generator.return(undefined as never) }
    expect(caught).toBeInstanceOf(CannotRetryError)
    expect(attempts).toBe(1)
  })

  test.each([
    { baseUrl: 'https://api.example.test/proxy', apiKey: 'proxy-managed', managed: '1' },
    { baseUrl: 'https://localhost/proxy/providers/fixture', apiKey: 'proxy-managed', managed: '1' },
    { baseUrl: 'http://127.0.0.1:4567/proxy/unrelated', apiKey: 'proxy-managed', managed: '1' },
    { baseUrl: 'http://127.0.0.1:4567/proxy/providers/fixture?other=1', apiKey: 'proxy-managed', managed: '1' },
    { baseUrl: 'http://127.0.0.1:4567/proxy/providers/fixture', apiKey: 'other-key', managed: '1' },
    { baseUrl: 'http://127.0.0.1:4567/proxy/providers/fixture', apiKey: 'proxy-managed', managed: '' },
  ])('does not trust the marker for an unowned route: $baseUrl', async ({ baseUrl, apiKey, managed }) => {
    const keys = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST'] as const
    const previous = keys.map(key => process.env[key])
    Object.assign(process.env, { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: apiKey, CLAUDE_CODE_REMOTE: '', CLAUDE_CODE_USE_VERTEX: '', CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: managed })
    const generator = withRetry(async () => ({} as Anthropic), async () => {
      throw new APIError(401, { error: { message: 'token expired' } }, undefined, new Headers({ 'x-cc-haha-invalid-provider-key': 'true' }))
    }, { model: 'fixture', thinkingConfig: { type: 'disabled' }, maxRetries: 1 })
    try {
      expect((await generator.next()).done).toBe(false)
    } finally {
      await generator.return(undefined as never)
      keys.forEach((key, index) => previous[index] === undefined ? delete process.env[key] : process.env[key] = previous[index])
    }
  })

  test('keeps a direct OAuth-style 401 eligible for credential refresh', async () => {
    const keys = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST'] as const
    const previous = keys.map(key => process.env[key])
    Object.assign(process.env, { ANTHROPIC_BASE_URL: 'https://api.example.test', ANTHROPIC_API_KEY: '', CLAUDE_CODE_REMOTE: '', CLAUDE_CODE_USE_VERTEX: '', CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '' })
    const token = spyOn(auth, 'getClaudeAIOAuthTokens').mockReturnValue({ accessToken: 'fixture-oauth-token' } as ReturnType<typeof auth.getClaudeAIOAuthTokens>)
    const refresh = spyOn(auth, 'handleOAuth401Error').mockResolvedValue(true)
    let attempts = 0
    let clients = 0
    const generator = withRetry(async () => { clients++; return {} as Anthropic }, async () => {
      if (++attempts === 1) throw new APIError(401, { error: { message: 'token expired' } }, undefined,
        new Headers({ 'x-cc-haha-invalid-provider-key': 'true', 'retry-after': '0' }))
      return 'refreshed'
    }, { model: 'fixture', thinkingConfig: { type: 'disabled' }, maxRetries: 1 })
    try {
      expect((await generator.next()).done).toBe(false)
      expect(await generator.next()).toEqual({ done: true, value: 'refreshed' })
      expect(attempts).toBe(2)
      expect(clients).toBe(2)
      expect(refresh).toHaveBeenCalledWith('fixture-oauth-token')
    } finally {
      await generator.return(undefined as never)
      token.mockRestore()
      refresh.mockRestore()
      keys.forEach((key, index) => previous[index] === undefined ? delete process.env[key] : process.env[key] = previous[index])
    }
  })
})

describe('withRetry provider quota', () => {
  test.each([false, true])('does not retry a monthly quota with fast mode %s, even with a retry header', async fastMode => {
    let attempts = 0
    const upstream = { type: 'error', error: { type: 'GoUsageLimitError', message: 'Go usage limit exceeded' }, metadata: { limitName: 'monthly' } }
    const detail = `Upstream returned HTTP 429: ${JSON.stringify(upstream)}`
    const quota = APIError.generate(429, { type: 'error', error: { type: 'api_error', message: detail } }, undefined, new Headers({ 'x-should-retry': 'true', 'retry-after': '0' }))
    const generator = withRetry(
      async () => ({} as Anthropic),
      async () => { attempts++; throw quota },
      { model: 'fixture', thinkingConfig: { type: 'disabled' }, fastMode, maxRetries: 2 },
    )
    let caught: unknown
    try { await generator.next() } catch (error) { caught = error }
    finally { await generator.return(undefined as never) }
    expect(caught).toBeInstanceOf(CannotRetryError)
    expect((caught as CannotRetryError).originalError).toBe(quota)
    expect(attempts).toBe(1)
  })

  test('retries a temporary 429 and succeeds', async () => {
    let attempts = 0
    const generator = withRetry(
      async () => ({} as Anthropic),
      async () => {
        if (++attempts === 1) throw new APIError(429, { error: { type: 'rate_limit_error', message: 'requests per minute exceeded' } }, undefined, new Headers({ 'retry-after': '0' }))
        return 'recovered'
      },
      { model: 'fixture', thinkingConfig: { type: 'disabled' }, maxRetries: 1 },
    )
    const first = await generator.next()
    expect(first.done).toBe(false)
    expect(await generator.next()).toEqual({ done: true, value: 'recovered' })
    expect(attempts).toBe(2)
  })
})

describe('withRetry stale connections', () => {
  test('disables keep-alive before retrying ECONNRESET connection failures', async () => {
    _resetKeepAliveForTesting()
    let attempts = 0
    const cause = Object.assign(new Error('socket hang up'), {
      code: 'ECONNRESET',
    })
    const staleConnection = new APIConnectionError({
      message: 'Connection error.',
      cause,
    })

    const generator = withRetry(
      async () => ({} as Anthropic),
      async () => {
        attempts += 1
        if (attempts === 1) {
          throw staleConnection
        }
        return 'ok'
      },
      {
        model: 'claude-opus-4-7',
        thinkingConfig: { type: 'disabled' },
        maxRetries: 1,
      },
    )

    let finalValue: string | undefined
    for (;;) {
      const next = await generator.next()
      if (next.done) {
        finalValue = next.value
        break
      }
    }

    expect(finalValue).toBe('ok')
    expect(attempts).toBe(2)
    expect(getProxyFetchOptions().keepalive).toBe(false)
    _resetKeepAliveForTesting()
  })
})

describe('withRetry context overflow recovery', () => {
  test('uses the available context even when the thinking budget is larger', async () => {
    const overrides: Array<number | undefined> = []
    const overflowMessage =
      'input length and `max_tokens` exceed context limit: 190000 + 20000 > 200000'
    const overflow = new APIError(
      400,
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: overflowMessage,
        },
      },
      overflowMessage,
      undefined,
    )

    const generator = withRetry(
      async () => ({} as Anthropic),
      async (_client, attempt, context) => {
        overrides.push(context.maxTokensOverride)
        if (attempt === 1) {
          throw overflow
        }
        return 'ok'
      },
      {
        model: 'claude-opus-4-7',
        thinkingConfig: { type: 'enabled', budgetTokens: 20_000 },
        maxRetries: 1,
      },
    )

    let finalValue: string | undefined
    for (;;) {
      const next = await generator.next()
      if (next.done) {
        finalValue = next.value
        break
      }
    }

    expect(finalValue).toBe('ok')
    expect(overrides).toEqual([undefined, 9_000])
  })

  test('stops when the provider repeats the same overflow after adjustment', async () => {
    let attempts = 0
    const overflowMessage =
      'input length and `max_tokens` exceed context limit: 190000 + 20000 > 200000'
    const overflow = new APIError(
      400,
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: overflowMessage,
        },
      },
      overflowMessage,
      undefined,
    )

    const generator = withRetry(
      async () => ({} as Anthropic),
      async () => {
        attempts += 1
        throw overflow
      },
      {
        model: 'claude-opus-4-7',
        thinkingConfig: { type: 'disabled' },
        maxRetries: 5,
      },
    )

    let thrown: unknown
    try {
      while (!(await generator.next()).done) {
        // Drain retry status messages until the generator terminates.
      }
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(CannotRetryError)
    expect((thrown as CannotRetryError).originalError).toBe(overflow)
    expect((thrown as CannotRetryError).retryContext.maxTokensOverride).toBe(
      9_000,
    )
    expect(attempts).toBe(2)
  })
})

describe('context overflow wrapped in 401 (#1162)', () => {
  test('does not retry when a gateway reports overflow as a 401', async () => {
    let attempts = 0
    const message = 'k3-256k supports only 256K context.'
    const overflow401 = new APIError(
      401,
      {
        type: 'error',
        error: { type: 'authentication_error', message },
      },
      message,
      undefined,
    )

    const generator = withRetry(
      async () => ({} as Anthropic),
      async () => {
        attempts += 1
        throw overflow401
      },
      {
        model: 'k3-256k',
        thinkingConfig: { type: 'disabled' },
        maxRetries: 5,
      },
    )

    let thrown: unknown
    try {
      while (!(await generator.next()).done) {
        // Drain retry status messages until the generator terminates.
      }
    } catch (error) {
      thrown = error
    }

    // Retrying replays the same oversized prompt — it must fail fast instead
    // of burning through 10 attempts against an unrecoverable rejection.
    expect(thrown).toBeInstanceOf(CannotRetryError)
    expect((thrown as CannotRetryError).originalError).toBe(overflow401)
    expect(attempts).toBe(1)
  })

  test('does not retry a relay 5xx that reports a context overflow', async () => {
    let attempts = 0
    const message = 'Upstream returned HTTP 500: {"error":{"message":"Range of input length should be [1, 60000]"}}'
    const overflow500 = new APIError(
      500,
      { type: 'error', error: { type: 'api_error', message } },
      message,
      undefined,
    )

    const generator = withRetry(
      async () => ({} as Anthropic),
      async () => {
        attempts += 1
        throw overflow500
      },
      {
        model: 'qwen-plus',
        thinkingConfig: { type: 'disabled' },
        maxRetries: 5,
      },
    )

    let thrown: unknown
    try {
      while (!(await generator.next()).done) {
        // Drain retry status messages until the generator terminates.
      }
    } catch (error) {
      thrown = error
    }

    // A relay that wraps the provider's overflow in a 500 would otherwise
    // burn every retry (and the compaction request's retries) on a request
    // that can only be fixed by compacting.
    expect(thrown).toBeInstanceOf(CannotRetryError)
    expect((thrown as CannotRetryError).originalError).toBe(overflow500)
    expect(attempts).toBe(1)
  })
})

describe('withRetry local service refused', () => {
  const refused = (code = 'ConnectionRefused') =>
    new APIConnectionError({
      message: 'Connection error.',
      cause: Object.assign(new Error('Unable to connect'), { code }),
    })

  async function attemptsUntilGivingUp(error: APIConnectionError, baseUrl: string) {
    const previous = process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_BASE_URL = baseUrl
    // Skip the real backoff; the recorded delays are what a user would wait.
    const delays: number[] = []
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
      delays.push(ms)
      queueMicrotask(() => callback(...args))
      return 0
    }) as typeof setTimeout)
    let attempts = 0
    let thrown: unknown
    try {
      const generator = withRetry(
        async () => ({} as Anthropic),
        async () => {
          attempts += 1
          throw error
        },
        { model: 'kimi/kimi-k3', thinkingConfig: { type: 'disabled' } },
      )
      for (;;) {
        const next = await generator.next()
        if (next.done) break
      }
    } catch (caught) {
      thrown = caught
    } finally {
      timer.mockRestore()
      if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL
      else process.env.ANTHROPIC_BASE_URL = previous
    }
    return { attempts, thrown, waitedMs: delays.reduce((sum, ms) => sum + ms, 0) }
  }

  test('stops after two quick retries when a local gateway is not running', async () => {
    const error = refused()
    const { attempts, thrown, waitedMs } = await attemptsUntilGivingUp(error, 'http://127.0.0.1:3425')

    expect(thrown).toBeInstanceOf(CannotRetryError)
    expect((thrown as CannotRetryError).originalError).toBe(error)
    expect(attempts).toBe(3)
    expect(waitedMs).toBeLessThan(2_000)
  })

  test('keeps the normal retries for remote hosts and our own protocol proxy', async () => {
    for (const baseUrl of ['https://api.example.com', 'http://127.0.0.1:3456/proxy/openai']) {
      const { attempts, waitedMs } = await attemptsUntilGivingUp(refused(), baseUrl)
      expect(attempts).toBe(11)
      expect(waitedMs).toBeGreaterThan(60_000)
    }
  })

  test('only treats a refused connection to a loopback host as a closed local service', () => {
    expect(isLocalServiceRefused(refused('ECONNREFUSED'), 'http://localhost:11434')).toBe(true)
    expect(isLocalServiceRefused(refused(), 'http://[::1]:1234/v1')).toBe(true)
    expect(isLocalServiceRefused(refused('ECONNRESET'), 'http://127.0.0.1:3425')).toBe(false)
    expect(isLocalServiceRefused(refused(), 'http://192.168.1.20:3425')).toBe(false)
    expect(isLocalServiceRefused(refused(), undefined)).toBe(false)
  })
})

describe('withRetry shared API attempt budget', () => {
  test('gives up when the shared budget is spent even with retries left', async () => {
    _resetKeepAliveForTesting()
    let attempts = 0
    const budget = { remaining: 2 }
    const connectionError = new APIConnectionError({ message: 'Connection error.' })
    const generator = withRetry(
      async () => ({} as Anthropic),
      async () => {
        attempts += 1
        throw connectionError
      },
      {
        model: 'claude-opus-4-7',
        thinkingConfig: { type: 'disabled' },
        maxRetries: 10,
        apiAttemptBudget: budget,
      },
    )

    let thrown: unknown
    try {
      for (;;) {
        const next = await generator.next()
        if (next.done) break
      }
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(CannotRetryError)
    expect((thrown as CannotRetryError).originalError).toBe(connectionError)
    expect(attempts).toBe(2)
    expect(budget.remaining).toBe(0)
    _resetKeepAliveForTesting()
  })

  test('makes no request when another layer already spent the budget', async () => {
    let attempts = 0
    const generator = withRetry(
      async () => ({} as Anthropic),
      async () => {
        attempts += 1
        return 'ok'
      },
      {
        model: 'claude-opus-4-7',
        thinkingConfig: { type: 'disabled' },
        apiAttemptBudget: { remaining: 0 },
      },
    )

    await expect(generator.next()).rejects.toBeInstanceOf(CannotRetryError)
    expect(attempts).toBe(0)
  })
})

describe('isRetryableStreamError', () => {
  // The SDK embeds the serialized error body in `error.message`; mirror that so
  // the matcher sees the same shape it does in production.
  function apiErrorWithBody(body: object, status?: number): APIError {
    return new APIError(status, body, JSON.stringify(body), undefined)
  }

  test('matches a mid-stream api_error with no HTTP status', () => {
    const err = apiErrorWithBody({
      type: 'error',
      error: {
        type: 'api_error',
        message: 'Failed to generate a valid tool call.',
      },
    })
    expect(isRetryableStreamError(err)).toBe(true)
  })

  test('matches an overloaded_error', () => {
    const err = apiErrorWithBody({
      type: 'error',
      error: { type: 'overloaded_error', message: 'Overloaded' },
    })
    expect(isRetryableStreamError(err)).toBe(true)
  })

  test('does not match a mid-stream api_error that reports a context overflow', () => {
    // The local proxy relays an OpenAI-style `data: {"error":...}` chunk as an
    // api_error; resending the same oversized request cannot succeed.
    const err = apiErrorWithBody({
      type: 'error',
      error: {
        type: 'api_error',
        message: 'Your request exceeded model token limit: 60000 (requested: 64735)',
      },
    })
    expect(isRetryableStreamError(err)).toBe(false)
  })

  test('does not match a client invalid_request_error', () => {
    const err = apiErrorWithBody(
      {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'bad input' },
      },
      400,
    )
    expect(isRetryableStreamError(err)).toBe(false)
  })

  test('does not match a non-APIError', () => {
    expect(
      isRetryableStreamError(new Error('Failed to generate a valid tool call.')),
    ).toBe(false)
  })

  test('does not match an APIError whose message lacks the markers', () => {
    const err = new APIError(
      500,
      { error: { type: 'internal', message: 'x' } },
      'Internal Server Error',
      undefined,
    )
    expect(isRetryableStreamError(err)).toBe(false)
  })
})

describe('isRetryableStreamTransportError', () => {
  /**
   * The exact object Bun's fetch throws when the peer resets a connection whose
   * response body is still being read. Captured from a raw TCP server that sent
   * chunked SSE headers plus one event, then terminated the socket.
   */
  function bunMidStreamReset(): Error {
    return Object.assign(
      new Error(
        'The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
      ),
      { code: 'ECONNRESET' },
    )
  }

  test("matches Bun's bare mid-stream socket reset", () => {
    expect(isRetryableStreamTransportError(bunMidStreamReset())).toBe(true)
  })

  test('matches every transport code, wherever it sits in the cause chain', () => {
    for (const code of [
      'ECONNRESET',
      'ECONNABORTED',
      'EPIPE',
      'UND_ERR_SOCKET',
      'ERR_STREAM_PREMATURE_CLOSE',
    ]) {
      const cause = Object.assign(new Error('socket hang up'), { code })
      expect(isRetryableStreamTransportError(cause)).toBe(true)
      expect(
        isRetryableStreamTransportError(
          new APIConnectionError({ message: 'Connection error.', cause }),
        ),
      ).toBe(true)
    }
  })

  test('does not match faults a re-send cannot clear', () => {
    expect(isRetryableStreamTransportError(new Error('boom'))).toBe(false)
    expect(isRetryableStreamTransportError(undefined)).toBe(false)
    expect(
      isRetryableStreamTransportError(
        Object.assign(new Error('bad certificate'), {
          code: 'CERT_HAS_EXPIRED',
        }),
      ),
    ).toBe(false)
    expect(
      isRetryableStreamTransportError(
        new APIError(
          500,
          { error: { type: 'internal', message: 'x' } },
          'Internal Server Error',
          undefined,
        ),
      ),
    ).toBe(false)
  })
})

/** An SSE `error` event exactly as the SDK raises it mid-stream (no status). */
function sseErrorEvent(type: string, message = 'fixture'): APIError {
  const body = { type: 'error', error: { type, message } }
  return new APIError(undefined, body, undefined, undefined)
}

describe('isProxyStreamTransportError', () => {
  test('matches the truncation and transport errors the provider proxy emits', () => {
    expect(isProxyStreamTransportError(sseErrorEvent(
      'stream_truncated',
      'OpenAI Chat upstream stream ended without finish_reason',
    ))).toBe(true)
    expect(isProxyStreamTransportError(sseErrorEvent('stream_error', 'socket hang up'))).toBe(true)
  })

  test('does not match provider verdicts on the request', () => {
    for (const type of [
      'api_error',
      'overloaded_error',
      'invalid_request_error',
      'authentication_error',
      'permission_error',
      'billing_error',
      'rate_limit_error',
      'not_found_error',
    ]) {
      expect(isProxyStreamTransportError(sseErrorEvent(type))).toBe(false)
    }
  })

  test('only applies to status-less stream events and never to policy rejections', () => {
    const body = { type: 'error', error: { type: 'stream_error', message: 'x' } }
    expect(isProxyStreamTransportError(new APIError(502, body, undefined, undefined))).toBe(false)
    expect(isProxyStreamTransportError(new Error('{"type":"stream_truncated"}'))).toBe(false)
    expect(isProxyStreamTransportError(new APIError(undefined, {
      type: 'error', error: { type: 'stream_error', code: 'cyber_policy', message: 'Rejected' },
    }, undefined, undefined))).toBe(false)
  })
})

describe('isStreamRequestRejection', () => {
  test('treats an overflow inside the stream as a rejection whatever event type carries it', () => {
    // The proxy relays an OpenAI `data: {"error":...}` overflow as api_error;
    // a non-streaming copy of the same request would be refused the same way.
    expect(isStreamRequestRejection(sseErrorEvent(
      'api_error',
      'Your request exceeded model token limit: 60000 (requested: 64735)',
    ))).toBe(true)
    expect(isStreamRequestRejection(sseErrorEvent('invalid_request_error', 'bad input'))).toBe(true)
  })

  test('leaves transient stream failures to the fallback', () => {
    expect(isStreamRequestRejection(sseErrorEvent('api_error', 'Failed to generate a valid tool call.'))).toBe(false)
    expect(isStreamRequestRejection(sseErrorEvent('overloaded_error', 'Overloaded'))).toBe(false)
  })
})

describe('getStreamRetryKind', () => {
  const disconnect = Object.assign(new Error('socket closed'), {
    code: 'ECONNRESET',
  })
  const replayable = {
    error: disconnect as unknown,
    canReplay: true,
    streamIdleAborted: false,
    signalAborted: false,
    nonStreamingFallbackAvailable: false,
    transientRetryAllowed: true,
  }

  test('re-sends a dead socket as a transport failure', () => {
    expect(getStreamRetryKind(replayable)).toBe('transport')
    expect(getStreamRetryKind({ ...replayable, nonStreamingFallbackAvailable: true })).toBe('transport')
  })

  test('re-sends proxy truncations, clean EOF and empty streams when no fallback takes them', () => {
    for (const error of [
      sseErrorEvent('stream_truncated'),
      sseErrorEvent('stream_error'),
      new StreamEndedEarlyError('incomplete'),
      new StreamEndedEarlyError('no_events'),
    ]) {
      expect(getStreamRetryKind({ ...replayable, error })).toBe('transport')
    }
  })

  test('leaves truncations the non-streaming fallback recovers to it, except a response cut off mid-way', () => {
    const withFallback = { ...replayable, nonStreamingFallbackAvailable: true }
    expect(getStreamRetryKind({ ...withFallback, error: sseErrorEvent('stream_truncated') })).toBeNull()
    expect(getStreamRetryKind({ ...withFallback, error: sseErrorEvent('stream_error') })).toBeNull()
    expect(getStreamRetryKind({ ...withFallback, error: new StreamEndedEarlyError('no_events') })).toBeNull()
    expect(getStreamRetryKind({ ...withFallback, error: new StreamEndedEarlyError('incomplete') })).toBe('transport')
  })

  test('refuses once the attempt committed output or started server-side work', () => {
    for (const error of [
      disconnect,
      sseErrorEvent('stream_truncated'),
      new StreamEndedEarlyError('incomplete'),
      sseErrorEvent('api_error'),
    ]) {
      expect(getStreamRetryKind({ ...replayable, error, canReplay: false })).toBeNull()
    }
  })

  test('keeps upstream-reported errors on the transient budget, only where allowed', () => {
    expect(getStreamRetryKind({ ...replayable, error: sseErrorEvent('api_error') })).toBe('transient')
    expect(getStreamRetryKind({ ...replayable, error: sseErrorEvent('overloaded_error') })).toBe('transient')
    expect(getStreamRetryKind({
      ...replayable,
      error: sseErrorEvent('api_error'),
      transientRetryAllowed: false,
    })).toBeNull()
  })

  test('keeps provider rejections and unknown faults non-retryable', () => {
    for (const error of [
      sseErrorEvent('invalid_request_error', 'prompt is too long'),
      sseErrorEvent('authentication_error'),
      sseErrorEvent('permission_error'),
      sseErrorEvent('billing_error'),
      new APIError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }, undefined, undefined),
      new RangeError('Content block not found'),
      new Error('boom'),
    ]) {
      expect(getStreamRetryKind({ ...replayable, error })).toBeNull()
    }
  })

  test('retries only an idle watchdog stall, on its own budget', () => {
    const state = createStreamWatchdogState()
    state.recordEvent({ type: 'message_start' })
    state.recordEvent({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use' } })
    state.recordEvent({ type: 'content_block_stop', index: 0 })
    const stalled = { ...replayable, streamIdleAborted: true }
    expect(getStreamRetryKind({ ...stalled, error: state.createTimeoutError('idle', 240_000) })).toBe('watchdog')
    expect(getStreamRetryKind({ ...stalled, error: state.createTimeoutError('max_duration', 600_000) })).toBeNull()
    expect(getStreamRetryKind({ ...stalled, error: state.createTimeoutError('tool_input_duration', 120_000) })).toBeNull()
    // A watchdog abort is never mistaken for the socket fault it causes.
    expect(getStreamRetryKind({ ...stalled, error: disconnect })).toBeNull()
  })

  test('never fights a user abort or a policy rejection', () => {
    expect(getStreamRetryKind({ ...replayable, signalAborted: true })).toBeNull()
    const policy = Object.assign(new Error('Disconnected'), {
      code: 'ECONNRESET',
      cause: { error: { code: 'cyber_policy' } },
    })
    expect(getStreamRetryKind({ ...replayable, error: policy })).toBeNull()
  })
})

describe('getMaxStreamRetries', () => {
  const TRANSIENT_ENV = 'CLAUDE_STREAM_TRANSIENT_RETRY_MAX'
  const API_ENV = 'CLAUDE_CODE_MAX_RETRIES'

  function withEnv(values: Record<string, string | undefined>, run: () => void) {
    const saved = { [TRANSIENT_ENV]: process.env[TRANSIENT_ENV], [API_ENV]: process.env[API_ENV] }
    try {
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      run()
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }

  test('gives transport and upstream-reported failures the API retry budget, stalls the small one', () => {
    withEnv({ [TRANSIENT_ENV]: undefined, [API_ENV]: undefined }, () => {
      expect(getMaxStreamRetries('transport')).toBe(10)
      expect(getMaxStreamRetries('transient')).toBe(10)
      expect(getMaxStreamRetries('watchdog')).toBe(2)
    })
    withEnv({ [TRANSIENT_ENV]: undefined, [API_ENV]: '4' }, () => {
      expect(getMaxStreamRetries('transport')).toBe(4)
      expect(getMaxStreamRetries('transient')).toBe(4)
    })
    withEnv({ [TRANSIENT_ENV]: undefined, [API_ENV]: 'abc' }, () => {
      expect(getMaxStreamRetries('transport')).toBe(10)
    })
  })

  test('an explicit transient override still caps transport retries, so 0 disables them', () => {
    withEnv({ [TRANSIENT_ENV]: '0', [API_ENV]: undefined }, () => {
      expect(getMaxStreamRetries('transport')).toBe(0)
      expect(getMaxStreamRetries('transient')).toBe(0)
    })
    withEnv({ [TRANSIENT_ENV]: '3', [API_ENV]: '1' }, () => {
      expect(getMaxStreamRetries('transport')).toBe(1)
      expect(getMaxStreamRetries('transient')).toBe(1)
      expect(getMaxStreamRetries('watchdog')).toBe(3)
    })
  })
})

describe('getMaxStreamTransientRetries', () => {
  const ENV = 'CLAUDE_STREAM_TRANSIENT_RETRY_MAX'

  test('defaults to 2 when unset', () => {
    delete process.env[ENV]
    expect(getMaxStreamTransientRetries()).toBe(2)
  })

  test('honors a numeric override (including 0 to disable)', () => {
    process.env[ENV] = '5'
    expect(getMaxStreamTransientRetries()).toBe(5)
    process.env[ENV] = '0'
    expect(getMaxStreamTransientRetries()).toBe(0)
    delete process.env[ENV]
  })

  test('caps overrides so recovery cannot become an unbounded retry loop', () => {
    process.env[ENV] = '1000'
    expect(getMaxStreamTransientRetries()).toBe(5)
    delete process.env[ENV]
  })

  test('falls back to 2 on non-numeric input', () => {
    process.env[ENV] = 'abc'
    expect(getMaxStreamTransientRetries()).toBe(2)
    delete process.env[ENV]
  })
})

describe('RetriableStreamError', () => {
  test('carries the original error and a faithful message', () => {
    const original = new Error('boom')
    const wrapped = new RetriableStreamError(original)
    expect(wrapped.originalError).toBe(original)
    expect(wrapped.name).toBe('RetriableStreamError')
    expect(wrapped.message).toContain('boom')
    expect(wrapped.kind).toBe('transient')
    expect(new RetriableStreamError(original, [], 'transport').kind).toBe('transport')
  })
})

describe('policy rejection retry boundaries', () => {
  test.each([401, 429, 503, 529])('stops HTTP %s policy errors before retry, refresh or model fallback', async status => {
    const body = { error: { type: 'overloaded_error', code: 'cyber_policy', message: 'Rejected' } }
    const rejection = new APIError(status, body, undefined, new Headers({ 'x-should-retry': 'true', 'retry-after': '0' }))
    let clientCalls = 0
    let attempts = 0
    const generator = withRetry(
      async () => { clientCalls++; return {} as Anthropic },
      async () => { attempts++; throw rejection },
      { model: 'gpt-6', fallbackModel: 'fallback', initialConsecutive529Errors: 2, thinkingConfig: { type: 'disabled' }, maxRetries: 3 },
    )
    // The first next must fail; even a retry status yield would mean replay was scheduled.
    let caught: unknown
    try { await generator.next() } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(CannotRetryError)
    expect((caught as CannotRetryError).originalError).toBe(rejection)
    expect(attempts).toBe(1)
    expect(clientCalls).toBe(1)
  })

  test('does not retry policy errors disguised as transient SSE or transport errors', () => {
    for (const type of ['api_error', 'overloaded_error']) {
      const body = { error: { type, code: 'cyber_policy' } }
      expect(isRetryableStreamError(new APIError(undefined, body, undefined, undefined))).toBe(false)
    }
    const error = Object.assign(new Error('Disconnected'), { code: 'ECONNRESET', cause: { error: { code: 'cyber_policy' } } })
    expect(isRetryableStreamTransportError(error)).toBe(false)
  })
})

describe('Retry-After minimum backoff', () => {
  test('zero seconds cannot bypass the ordinary retry backoff floor', () => {
    expect(getRetryDelay(1, '0')).toBeGreaterThanOrEqual(BASE_DELAY_MS)
  })
})


describe('Retry-After compatibility and retry loop boundaries', () => {
  test('preserves positive seconds, missing/invalid/date fallback, jitter and cap', () => {
    const random = spyOn(Math, 'random').mockReturnValue(0.2)
    try {
      expect(getRetryDelay(1, '2')).toBe(2000)
      expect(getRetryDelay(1, '60')).toBe(60000)
      expect(getRetryDelay(1, '-1')).toBe(BASE_DELAY_MS)
      expect(getRetryDelay(1, '0.5')).toBe(BASE_DELAY_MS)
      for (const header of [undefined, null, '', 'invalid', 'Wed, 21 Oct 2037 07:28:00 GMT']) {
        // HTTP dates were not interpreted by this retry layer; retain its backoff.
        expect(getRetryDelay(2, header)).toBe(1050)
      }
      expect(getRetryDelay(20)).toBe(33600)
    } finally {
      random.mockRestore()
    }
  })

  for (const fastMode of [false, true]) {
    for (const status of [429, 529]) {
      test(`${fastMode ? 'fast' : 'ordinary'} HTTP ${status} zero hint sleeps before retry and remains bounded`, async () => {
        const savedDisable = process.env.CLAUDE_CODE_DISABLE_FAST_MODE
        delete process.env.CLAUDE_CODE_DISABLE_FAST_MODE
        clearFastModeCooldown()
        const delays: number[] = []
        const nativeTimeout = globalThis.setTimeout
        const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
          if (ms <= BASE_DELAY_MS) {
            delays.push(ms)
            queueMicrotask(() => callback(...args))
            return 0
          }
          return nativeTimeout(callback, ms, ...args)
        }) as typeof setTimeout)
        let attempts = 0
        const error = new APIError(status, {}, 'capacity', new Headers({ 'retry-after': '0' }))
        const generator = withRetry(
          async () => ({} as Anthropic),
          async () => { attempts++; throw error },
          { model: 'claude-sonnet-4-6', thinkingConfig: { type: 'disabled' }, fastMode, maxRetries: 1 },
        )
        let caught: unknown
        try {
          try { while (!(await generator.next()).done) {} } catch (error) { caught = error }
          expect(caught).toBeInstanceOf(CannotRetryError)
          expect((caught as CannotRetryError).originalError).toBe(error)
          expect(attempts).toBe(2)
          expect(delays.length).toBeGreaterThanOrEqual(1)
          expect(delays.every(delay => delay === BASE_DELAY_MS)).toBe(true)
          expect(getFastModeRuntimeState().status).toBe('active')
        } finally {
          timer.mockRestore()
          if (savedDisable === undefined) delete process.env.CLAUDE_CODE_DISABLE_FAST_MODE
          else process.env.CLAUDE_CODE_DISABLE_FAST_MODE = savedDisable
          clearFastModeCooldown()
        }
      })
    }

    test(`${fastMode ? 'fast' : 'ordinary'} zero-hint backoff is abortable`, async () => {
      const savedDisable = process.env.CLAUDE_CODE_DISABLE_FAST_MODE
      delete process.env.CLAUDE_CODE_DISABLE_FAST_MODE
      clearFastModeCooldown()
      const controller = new AbortController()
      const nativeTimeout = globalThis.setTimeout
      const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
        const handle = nativeTimeout(callback, ms, ...args)
        if (ms <= BASE_DELAY_MS) queueMicrotask(() => controller.abort())
        return handle
      }) as typeof setTimeout)
      let attempts = 0
      const generator = withRetry(
        async () => ({} as Anthropic),
        async () => {
          attempts++
          throw new APIError(429, {}, 'capacity', new Headers({ 'retry-after': '0' }))
        },
        { model: 'claude-sonnet-4-6', thinkingConfig: { type: 'disabled' }, fastMode, maxRetries: 2, signal: controller.signal },
      )
      let caught: unknown
      try {
        try { while (!(await generator.next()).done) {} } catch (error) { caught = error }
        expect(caught).toBeInstanceOf(APIUserAbortError)
        expect(attempts).toBe(1)
      } finally {
        timer.mockRestore()
        if (savedDisable === undefined) delete process.env.CLAUDE_CODE_DISABLE_FAST_MODE
        else process.env.CLAUDE_CODE_DISABLE_FAST_MODE = savedDisable
        clearFastModeCooldown()
      }
    })
  }
})

describe('fast Retry-After compatibility', () => {
  test.each([
    ['2', true, 2000],
    ['60', false, null],
    ['invalid', false, null],
    ['Wed, 21 Oct 2037 07:28:00 GMT', false, null],
  ] as const)('preserves fast-mode decision for %s', async (header, expectedFast, expectedDelay) => {
    const savedDisable = process.env.CLAUDE_CODE_DISABLE_FAST_MODE
    delete process.env.CLAUDE_CODE_DISABLE_FAST_MODE
    clearFastModeCooldown()
    const delays: number[] = []
    const nativeTimeout = globalThis.setTimeout
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
      if (ms === 2000) {
        delays.push(ms)
        queueMicrotask(() => callback(...args))
        return 0
      }
      return nativeTimeout(callback, ms, ...args)
    }) as typeof setTimeout)
    const seenFast: Array<boolean | undefined> = []
    const generator = withRetry(
      async () => ({} as Anthropic),
      async (_client, attempt, context) => {
        seenFast.push(context.fastMode)
        if (attempt === 1) throw new APIError(429, {}, 'capacity', new Headers({ 'retry-after': header }))
        return 'ok'
      },
      { model: 'claude-sonnet-4-6', thinkingConfig: { type: 'disabled' }, fastMode: true, maxRetries: 1 },
    )
    try {
      expect(await generator.next()).toEqual({ done: true, value: 'ok' })
      expect(seenFast).toEqual([true, expectedFast])
      expect(delays).toEqual(expectedDelay === null ? [] : [expectedDelay])
    } finally {
      timer.mockRestore()
      if (savedDisable === undefined) delete process.env.CLAUDE_CODE_DISABLE_FAST_MODE
      else process.env.CLAUDE_CODE_DISABLE_FAST_MODE = savedDisable
      clearFastModeCooldown()
    }
  })
})
