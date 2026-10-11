import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { withStreamRetry } from './streamRetry.js'
import { RetriableStreamError } from './withRetry.js'

const RETRY_ENV = 'CLAUDE_STREAM_TRANSIENT_RETRY_MAX'
const API_RETRY_ENV = 'CLAUDE_CODE_MAX_RETRIES'

// Backoff waits are covered by recordingSleep below; the remaining tests only
// care about which attempts run.
const noSleep = async () => {}

// getAssistantMessageFromError() (invoked when retries are exhausted) consults
// isClaudeAISubscriber(), which throws if no auth is configured. We only assert
// that an assistant error message is produced, so a dummy key suffices. In
// production this path always runs with real auth already in place.
let priorApiKey: string | undefined
beforeAll(() => {
  priorApiKey = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test'
})
afterAll(() => {
  if (priorApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  }
})

/** A RetriableStreamError wrapping a realistic mid-stream api_error (no status). */
function retriableError(): RetriableStreamError {
  const body = {
    type: 'error',
    error: {
      type: 'api_error',
      message: 'Failed to generate a valid tool call.',
    },
  }
  return new RetriableStreamError(
    new APIError(undefined, body, JSON.stringify(body), undefined),
  )
}

// biome-ignore lint/suspicious/noExplicitAny: test harness collects heterogeneous stream messages
async function collect(gen: AsyncGenerator<any, void>): Promise<any[]> {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const out: any[] = []
  for await (const m of gen) out.push(m)
  return out
}

describe('withStreamRetry', () => {
  test('retries after a transient mid-stream error and yields the successful attempt', async () => {
    process.env[RETRY_ENV] = '2'
    let calls = 0
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        if (calls === 1) {
          // A failed attempt may have already emitted partials before throwing.
          yield { type: 'stream_event', event: { type: 'message_start' } }
          throw retriableError()
        }
        yield { type: 'assistant', message: { content: [] }, uuid: 'ok' }
      })()

    const out = await collect(withStreamRetry(attempt, 'test-model', [], { sleep: noSleep }))

    expect(calls).toBe(2)
    expect(out).toContainEqual(expect.objectContaining({
      type: 'system',
      subtype: 'streaming_fallback',
      cause: 'stream_retry',
    }))
    const assistants = out.filter(m => m.type === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].uuid).toBe('ok')
    // The successful retry must NOT be reported as an API error.
    expect(out.some(m => m.isApiErrorMessage)).toBe(false)
    delete process.env[RETRY_ENV]
  })

  test('exhausts retries and surfaces an API-error assistant message', async () => {
    process.env[RETRY_ENV] = '2'
    let calls = 0
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        throw retriableError()
      })()

    const out = await collect(withStreamRetry(attempt, 'test-model', [], { sleep: noSleep }))

    expect(calls).toBe(3) // 1 initial attempt + 2 retries
    expect(out.filter(
      m => m.type === 'system' && m.subtype === 'streaming_fallback' && m.cause === 'stream_retry',
    )).toHaveLength(2)
    const last = out.at(-1)
    expect(last?.type).toBe('assistant')
    expect(last?.isApiErrorMessage).toBe(true)
    delete process.env[RETRY_ENV]
  })

  // Transport disconnects reach this wrapper as a bare Error, not an APIError —
  // the first RetriableStreamError payload that is not an SDK error object. The
  // recovery path must survive one, including the exhaustion branch that asks
  // getAssistantMessageFromError to render it.
  test('recovers from a mid-stream socket reset and reports it if it persists', async () => {
    process.env[RETRY_ENV] = '1'
    const socketReset = () =>
      new RetriableStreamError(
        Object.assign(
          new Error('The socket connection was closed unexpectedly.'),
          { code: 'ECONNRESET' },
        ),
      )

    let calls = 0
    const recovers = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        if (calls === 1) {
          yield { type: 'stream_event', event: { type: 'message_start' } }
          throw socketReset()
        }
        yield { type: 'assistant', message: { content: [] }, uuid: 'recovered' }
      })()

    const recovered = await collect(withStreamRetry(recovers, 'test-model', [], { sleep: noSleep }))
    expect(calls).toBe(2)
    expect(recovered.at(-1)?.uuid).toBe('recovered')
    expect(recovered.some(m => m.isApiErrorMessage)).toBe(false)

    const persists = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        throw socketReset()
      })()

    const failed = await collect(withStreamRetry(persists, 'test-model', [], { sleep: noSleep }))
    const last = failed.at(-1)
    expect(last?.type).toBe('assistant')
    expect(last?.isApiErrorMessage).toBe(true)
    delete process.env[RETRY_ENV]
  })

  test('does not retry a non-RetriableStreamError; rethrows it', async () => {
    let calls = 0
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        throw new Error('fatal')
      })()

    await expect(
      collect(withStreamRetry(attempt, 'test-model', [], { sleep: noSleep })),
    ).rejects.toThrow('fatal')
    expect(calls).toBe(1)
  })

  test('maxRetries=0 makes a single attempt, then surfaces the error', async () => {
    process.env[RETRY_ENV] = '0'
    let calls = 0
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        throw retriableError()
      })()

    const out = await collect(withStreamRetry(attempt, 'test-model', [], { sleep: noSleep }))

    expect(calls).toBe(1)
    expect(out.at(-1)?.type).toBe('assistant')
    expect(out.at(-1)?.isApiErrorMessage).toBe(true)
    delete process.env[RETRY_ENV]
  })

  test('yields completed text from only the final exhausted attempt', async () => {
    process.env[RETRY_ENV] = '1'
    let calls = 0
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        throw new RetriableStreamError(
          new Error('socket reset'),
          [
            {
              type: 'assistant',
              message: {
                id: `response-${calls}`,
                type: 'message',
                role: 'assistant',
                model: 'test-model',
                content: [{ type: 'text', text: `partial-${calls}` }],
                stop_reason: null,
                stop_sequence: null,
                usage: {
                  input_tokens: 0,
                  output_tokens: 0,
                },
              },
              uuid: `partial-${calls}`,
              timestamp: new Date().toISOString(),
            },
          ],
        )
      })()

    const out = await collect(withStreamRetry(attempt, 'test-model', [], { sleep: noSleep }))
    const partials = out.filter(
      message =>
        message.type === 'assistant' &&
        typeof message.uuid === 'string' &&
        message.uuid.startsWith('partial-'),
    )

    expect(calls).toBe(2)
    expect(partials.map(message => message.uuid)).toEqual(['partial-2'])
    expect(out.at(-1)?.isApiErrorMessage).toBe(true)
    delete process.env[RETRY_ENV]
  })

  test('passes through a clean attempt without retrying', async () => {
    let calls = 0
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        yield { type: 'assistant', message: { content: [] }, uuid: 'clean' }
      })()

    const out = await collect(withStreamRetry(attempt, 'test-model', [], { sleep: noSleep }))

    expect(calls).toBe(1)
    expect(out).toHaveLength(1)
    expect(out[0].uuid).toBe('clean')
  })
})

/** The SSE error event the provider proxy writes when the upstream is cut off. */
function proxyTruncation(): RetriableStreamError {
  const body = {
    type: 'error',
    error: {
      type: 'stream_truncated',
      message: 'OpenAI Chat upstream stream ended without finish_reason',
    },
  }
  return new RetriableStreamError(
    new APIError(undefined, body, undefined, undefined),
    [],
    'transport',
  )
}

function withEnv(values: Record<string, string | undefined>) {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// biome-ignore lint/suspicious/noExplicitAny: test harness inspects heterogeneous stream messages
function retryStatuses(out: any[]): any[] {
  return out.filter(m => m.type === 'system' && m.subtype === 'api_error')
}

describe('withStreamRetry backoff and budgets', () => {
  test('backs off between re-sends with growing, capped delays and reports each wait', async () => {
    const restore = withEnv({ [RETRY_ENV]: undefined, [API_RETRY_ENV]: undefined })
    const random = spyOn(Math, 'random').mockReturnValue(0)
    try {
      const delays: number[] = []
      let calls = 0
      const attempt = () =>
        // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
        (async function* (): AsyncGenerator<any, void> {
          calls++
          if (calls <= 7) throw proxyTruncation()
          yield { type: 'assistant', message: { content: [] }, uuid: 'recovered' }
        })()

      const out = await collect(withStreamRetry(attempt, 'test-model', [], {
        sleep: async ms => { delays.push(ms) },
      }))

      expect(calls).toBe(8)
      expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 16000, 32000])
      expect(retryStatuses(out).map(m => [m.retryAttempt, m.maxRetries, m.retryInMs])).toEqual(
        delays.map((delay, index) => [index + 1, 10, delay]),
      )
      expect(out.at(-1)?.uuid).toBe('recovered')
      expect(out.some(m => m.isApiErrorMessage)).toBe(false)
    } finally {
      random.mockRestore()
      restore()
    }
  })

  test('jitter stays within a quarter of the base delay', async () => {
    const restore = withEnv({ [RETRY_ENV]: undefined, [API_RETRY_ENV]: '3' })
    try {
      const delays: number[] = []
      const attempt = () =>
        // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
        (async function* (): AsyncGenerator<any, void> {
          throw proxyTruncation()
        })()

      await collect(withStreamRetry(attempt, 'test-model', [], {
        sleep: async ms => { delays.push(ms) },
      }))

      expect(delays).toHaveLength(3)
      delays.forEach((delay, index) => {
        const base = 500 * 2 ** index
        expect(delay).toBeGreaterThanOrEqual(base)
        expect(delay).toBeLessThanOrEqual(base * 1.25)
      })
    } finally {
      restore()
    }
  })

  test('transport failures draw on the API retry budget, then surface the original error', async () => {
    for (const [apiRetries, expectedCalls] of [[undefined, 11], ['3', 4]] as const) {
      const restore = withEnv({ [RETRY_ENV]: undefined, [API_RETRY_ENV]: apiRetries })
      try {
        let calls = 0
        let sleeps = 0
        const attempt = () =>
          // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
          (async function* (): AsyncGenerator<any, void> {
            calls++
            throw proxyTruncation()
          })()

        const out = await collect(withStreamRetry(attempt, 'test-model', [], {
          sleep: async () => { sleeps++ },
        }))

        expect(calls).toBe(expectedCalls)
        expect(sleeps).toBe(expectedCalls - 1)
        const last = out.at(-1)
        expect(last?.type).toBe('assistant')
        expect(last?.isApiErrorMessage).toBe(true)
        expect(JSON.stringify(last?.message.content)).toContain('ended without finish_reason')
      } finally {
        restore()
      }
    }
  })

  test('stalls and upstream-reported errors keep their small budget', async () => {
    const restore = withEnv({ [RETRY_ENV]: undefined, [API_RETRY_ENV]: undefined })
    try {
      let calls = 0
      const attempt = () =>
        // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
        (async function* (): AsyncGenerator<any, void> {
          calls++
          throw retriableError()
        })()

      const out = await collect(withStreamRetry(attempt, 'test-model', [], { sleep: noSleep }))

      expect(calls).toBe(3)
      expect(out.at(-1)?.isApiErrorMessage).toBe(true)
    } finally {
      restore()
    }
  })

  test('discards the failed attempt and reports the retry before waiting', async () => {
    const restore = withEnv({ [RETRY_ENV]: undefined, [API_RETRY_ENV]: undefined })
    try {
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      const out: any[] = []
      let yieldedBeforeWait = -1
      let calls = 0
      const attempt = () =>
        // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
        (async function* (): AsyncGenerator<any, void> {
          calls++
          if (calls === 1) {
            yield { type: 'stream_event', event: { type: 'content_block_delta' } }
            throw proxyTruncation()
          }
          yield { type: 'assistant', message: { content: [] }, uuid: 'second' }
        })()

      for await (const message of withStreamRetry(attempt, 'test-model', [], {
        sleep: async () => { yieldedBeforeWait = out.length },
      })) {
        out.push(message)
      }

      expect(out.map(m => m.subtype ?? m.type)).toEqual([
        'stream_event',
        'streaming_fallback',
        'api_error',
        'assistant',
      ])
      expect(out[1].cause).toBe('stream_retry')
      expect(out[2].retryAttempt).toBe(1)
      expect(yieldedBeforeWait).toBe(3)
    } finally {
      restore()
    }
  })

  test('an interrupt during the backoff stops without another attempt or a provider error', async () => {
    const restore = withEnv({ [RETRY_ENV]: undefined, [API_RETRY_ENV]: undefined })
    try {
      const controller = new AbortController()
      let calls = 0
      const attempt = () =>
        // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
        (async function* (): AsyncGenerator<any, void> {
          calls++
          throw proxyTruncation()
        })()

      const out = await collect(withStreamRetry(attempt, 'test-model', [], {
        signal: controller.signal,
        sleep: async () => { controller.abort() },
      }))

      expect(calls).toBe(1)
      expect(out.some(m => m.type === 'assistant')).toBe(false)
      expect(out.at(-1)?.subtype).toBe('api_error')
    } finally {
      restore()
    }
  })

  test('never replays an attempt that already committed assistant output', async () => {
    const restore = withEnv({ [RETRY_ENV]: undefined, [API_RETRY_ENV]: undefined })
    try {
      let calls = 0
      const toolUse = {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'toolu_committed', name: 'Bash', input: {} }] },
        uuid: 'committed-tool',
      }
      const attempt = () =>
        // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
        (async function* (): AsyncGenerator<any, void> {
          calls++
          // Once a tool_use reaches the consumer it may already be running.
          yield toolUse
          throw proxyTruncation()
        })()

      const out = await collect(withStreamRetry(attempt, 'test-model', [], { sleep: noSleep }))

      expect(calls).toBe(1)
      expect(out.filter(m => m.uuid === 'committed-tool')).toHaveLength(1)
      expect(out.some(m => m.subtype === 'streaming_fallback')).toBe(false)
      expect(out.at(-1)?.isApiErrorMessage).toBe(true)
    } finally {
      restore()
    }
  })

  test('stops re-sending once the shared API attempt budget is spent', async () => {
    const restore = withEnv({ [RETRY_ENV]: undefined, [API_RETRY_ENV]: undefined })
    try {
      const budget = { remaining: 3 }
      let calls = 0
      const attempt = () =>
        // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
        (async function* (): AsyncGenerator<any, void> {
          calls++
          // The attempt's own withRetry takes one attempt from the budget.
          budget.remaining--
          throw proxyTruncation()
        })()

      const out = await collect(withStreamRetry(attempt, 'test-model', [], {
        sleep: noSleep,
        apiAttemptBudget: budget,
      }))

      // A transport failure alone would allow 1 + 10 attempts.
      expect(calls).toBe(3)
      expect(retryStatuses(out)).toHaveLength(2)
      expect(out.at(-1)?.isApiErrorMessage).toBe(true)
    } finally {
      restore()
    }
  })
})
