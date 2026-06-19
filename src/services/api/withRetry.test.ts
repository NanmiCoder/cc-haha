import { afterEach, describe, expect, test } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import { APIConnectionError, APIError } from '@anthropic-ai/sdk'
import { _resetKeepAliveForTesting, getProxyFetchOptions } from '../../utils/proxy.js'
import { withRetry } from './withRetry.js'

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
