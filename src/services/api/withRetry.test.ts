import { afterEach, describe, expect, test } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import { APIConnectionError, APIError } from '@anthropic-ai/sdk'
import { _resetKeepAliveForTesting, getProxyFetchOptions } from '../../utils/proxy.js'
import {
  getMaxStreamTransientRetries,
  isRetryableStreamError,
  RetriableStreamError,
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

// --- Same-error suppression ---
//
// Background: every retry used to yield a SystemAPIErrorMessage to the
// chat as long as the error was an APIError. A flaky upstream that
// recovers in 1–2 retries painted the conversation with a wall of
// identical error bubbles. We now suppress consecutive identical errors
// until SAME_ERROR_REPORT_THRESHOLD (default 3) and yield distinct
// errors — and 429s — immediately.

function makeApiError(status: number, message: string): APIError {
  // Bypass the protected-constructor / generate path: the only thing the
  // limiter cares about is `instanceof APIError`, `.status`, `.message`.
  // Build a plain object that satisfies those checks.
  const err = new Error(message) as Error & {
    status?: number
    requestID?: string
  }
  err.name = 'APIError'
  err.status = status
  err.requestID = 'req-test'
  // Re-parent the prototype so `instanceof APIError` matches.
  Object.setPrototypeOf(err, APIError.prototype)
  return err as unknown as APIError
}

async function collectRetryYields(opts: {
  errorsBeforeOk: APIError[]
}): Promise<{ yielded: number; finalValue: string }> {
  let attempt = 0
  const generator = withRetry(
    async () => ({} as Anthropic),
    async () => {
      const err = opts.errorsBeforeOk[attempt]
      attempt += 1
      if (err) throw err
      return 'ok'
    },
    {
      model: 'claude-opus-4-7',
      thinkingConfig: { type: 'disabled' },
      maxRetries: opts.errorsBeforeOk.length,
    },
  )

  let yielded = 0
  let finalValue = ''
  for (;;) {
    const next = await generator.next()
    if (next.done) {
      finalValue = next.value
      break
    }
    yielded += 1
  }
  return { yielded, finalValue }
}

describe('withRetry same-error suppression', () => {
  afterEach(() => {
    delete process.env.CLAUDE_CODE_RETRY_REPORT_AFTER
  })

  test('suppresses the first two identical 500 errors and reports the third', async () => {
    const err = makeApiError(500, 'Internal Server Error')
    // Three identical failures, then succeed on the 4th attempt.
    const result = await collectRetryYields({
      errorsBeforeOk: [err, err, err],
    })

    expect(result.finalValue).toBe('ok')
    // 1st error: new key, reported (1 yield)
    // 2nd identical: suppressed
    // 3rd identical: threshold (3) crossed, reported (1 yield)
    // Total: 2 yields, far less than the 3 the old code produced.
    expect(result.yielded).toBe(2)
  })

  test('a different error after a streak yields immediately on the new key', async () => {
    const e500 = makeApiError(500, 'Internal Server Error')
    const e503 = makeApiError(503, 'Service Unavailable')
    // 500, 500 (suppressed), 503 (NEW key, immediate), then ok.
    const result = await collectRetryYields({
      errorsBeforeOk: [e500, e500, e503],
    })

    expect(result.finalValue).toBe('ok')
    // 1st (500 new): yielded
    // 2nd (500 same): suppressed
    // 3rd (503 new): yielded
    expect(result.yielded).toBe(2)
  })

  test('CLAUDE_CODE_RETRY_REPORT_AFTER env override raises the threshold', async () => {
    process.env.CLAUDE_CODE_RETRY_REPORT_AFTER = '4'
    const err = makeApiError(500, 'Boom')
    // Three identical errors should ALL be suppressed because the
    // threshold is now 4; only the first (new-key bypass) yields.
    const result = await collectRetryYields({
      errorsBeforeOk: [err, err, err],
    })

    expect(result.finalValue).toBe('ok')
    expect(result.yielded).toBe(1) // only the first-sighting yield
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

describe('getMaxStreamTransientRetries', () => {
  const ENV = 'CLAUDE_STREAM_TRANSIENT_RETRY_MAX'

  test('defaults to 1 when unset (one retry is cheap and almost always clears a transient blip)', () => {
    delete process.env[ENV]
    expect(getMaxStreamTransientRetries()).toBe(1)
  })

  test('honors a numeric override (including 0 to disable)', () => {
    process.env[ENV] = '5'
    expect(getMaxStreamTransientRetries()).toBe(5)
    process.env[ENV] = '0'
    expect(getMaxStreamTransientRetries()).toBe(0)
    delete process.env[ENV]
  })

  test('falls back to default 1 on non-numeric input', () => {
    process.env[ENV] = 'abc'
    expect(getMaxStreamTransientRetries()).toBe(1)
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
