import { describe, expect, test } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import { APIConnectionError, APIError } from '@anthropic-ai/sdk'
import { _resetKeepAliveForTesting, getProxyFetchOptions } from '../../utils/proxy.js'
import {
  CannotRetryError,
  getMaxStreamTransientRetries,
  isRetryableStreamError,
  isRetryableStreamTransportError,
  RetriableStreamError,
  shouldRetryStreamAfterTransportDisconnect,
  withRetry,
} from './withRetry.js'

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

describe('shouldRetryStreamAfterTransportDisconnect', () => {
  const disconnect = Object.assign(new Error('socket closed'), {
    code: 'ECONNRESET',
  })
  const clean = {
    error: disconnect,
    hasCrossedSideEffectBoundary: false,
    streamIdleAborted: false,
    signalAborted: false,
  }

  test('recovers a disconnect while the attempt is still side-effect-free', () => {
    expect(shouldRetryStreamAfterTransportDisconnect(clean)).toBe(true)
  })

  test('refuses once a tool block completed — a re-send would run it twice', () => {
    expect(
      shouldRetryStreamAfterTransportDisconnect({
        ...clean,
        hasCrossedSideEffectBoundary: true,
      }),
    ).toBe(false)
  })

  test('leaves watchdog aborts to their own retry path', () => {
    expect(
      shouldRetryStreamAfterTransportDisconnect({
        ...clean,
        streamIdleAborted: true,
      }),
    ).toBe(false)
  })

  test('never fights a user abort', () => {
    expect(
      shouldRetryStreamAfterTransportDisconnect({
        ...clean,
        signalAborted: true,
      }),
    ).toBe(false)
  })

  test('ignores non-transport stream errors', () => {
    expect(
      shouldRetryStreamAfterTransportDisconnect({
        ...clean,
        error: new Error('Stream ended without receiving any events'),
      }),
    ).toBe(false)
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
